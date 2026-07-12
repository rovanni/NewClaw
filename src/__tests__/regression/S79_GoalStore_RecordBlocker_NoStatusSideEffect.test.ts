/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S79 (Sprint 0.6, Front B — Preservação correta de blockers)
 *
 * Prova duas coisas sobre o código ATUAL:
 *
 * 1. `GoalEvaluator.evaluate()` computa um `blocker: GoalBlocker` tipado nos branches
 *    `'partial'` e `'failed'` do switch principal de `GoalExecutionLoop.runLoopInternal`,
 *    mas esses dois branches NUNCA chamam `GoalStore.addBlocker()` — o blocker é
 *    silenciosamente descartado. `goal.blockers` fica vazio mesmo quando a causa real da
 *    falha já foi classificada.
 * 2. Se a correção fosse feita ingenuamente reusando `GoalStore.addBlocker()` (que sempre
 *    força `status='blocked'` como efeito colateral, mesmo em `update()`, que não valida
 *    transição de estado), um branch `'partial'` — que é RETRYÁVEL, não deveria nunca virar
 *    `blocked` — ficaria com `status='blocked'` incorreto. Este teste também comprova que a
 *    correção real (`GoalStore.recordBlocker`, sem efeito colateral de status) não introduz
 *    esse bug novo.
 *
 * Execução: npx ts-node src/__tests__/regression/S79_GoalStore_RecordBlocker_NoStatusSideEffect.test.ts
 */

import Database from 'better-sqlite3';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';
import { GoalStore } from '../../loop/GoalStore';
import { ToolRegistry } from '../../core/ToolRegistry';
import { Goal, PlanStep } from '../../loop/GoalTypes';
import { ChannelContext } from '../../loop/agentLoopTypes';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

function emptyState(goalId: string): { cognitiveContext: unknown; progressModel: unknown } {
    return {
        cognitiveContext: { discoveries: [], failedStrategies: [], filesRead: [], filesModified: [], generatedArtifacts: [], executedCommands: [], importantOutputs: [] },
        progressModel: { goalId, components: [], overallPercent: 0, updatedAt: Date.now() },
    };
}

// Tool que falha com um erro de REDE (retryável, kind=environment_limit — ver
// GoalEvaluator.ts ERROR_PATTERNS) na primeira chamada de cada "família" de args, e sucede
// para args diferentes — simula uma recovery real (retry com args mutados), sem tropeçar no
// dedup de `alreadyFailed` do GoalEvaluator (que bloqueia retry com os MESMOS args).
const RETRYABLE_TOOL = '__s79_retryable_tool__';
const FAIL_ALWAYS_TOOL = '__s79_fail_always_tool__';
ToolRegistry.register({
    name: RETRYABLE_TOOL,
    description: 'test',
    parameters: {},
    execute: async (args: Record<string, unknown>) => {
        if (args['variant'] === 'v1') {
            return { success: false, output: '', error: 'ECONNREFUSED: falha de rede simulada' };
        }
        return { success: true, output: 'segunda tentativa args diferentes concluída com sucesso' };
    },
});
ToolRegistry.register({
    name: FAIL_ALWAYS_TOOL,
    description: 'test',
    parameters: {},
    execute: async () => ({ success: false, output: '', error: 'erro de teste sem padrão reconhecido em ERROR_PATTERNS' }),
});

function makeFakeProviderFactory(chatImpl: (...args: unknown[]) => Promise<unknown>) {
    return {
        chatWithFallback: chatImpl,
        getProvider: () => undefined,
        getProviderWithModel: () => ({ chat: chatImpl }),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
}

function makeLoop(providerFactory: import('../../core/ProviderFactory').ProviderFactory) {
    const db = new (Database as any)(':memory:');
    const goalStore = new GoalStore(db);
    const fakeMemory = { getDatabase: () => db } as any;
    const fakePlanner = {
        getAvailableSkills: () => [],
        setSkillContext: () => {},
        setModel: () => {},
        replan: async () => ({ steps: [], strategy: 'n/a' }),
    } as any;
    const loop = new GoalExecutionLoop(
        {} as any,
        goalStore,
        fakePlanner,
        { record: () => {}, buildContextHint: () => '', findHardConstraints: () => [] } as any,
        ToolRegistry,
        providerFactory,
        fakeMemory,
        { findApplicableCasesShadow: async () => [], backfillMissingEmbeddings: async () => {}, captureIfEligible: () => {}, findSimilarShadow: () => [] } as any,
    );
    return { loop, goalStore };
}

function makeGoal(store: GoalStore, overrides: Partial<Goal> & { currentPlan: PlanStep[] }): Goal {
    return store.create({
        sessionKey: 'test:s79',
        conversationId: 'test-conv-s79',
        userIntent: 'objetivo de teste S79',
        objective: 'Objetivo de teste S79',
        status: 'executing',
        attempts: [],
        blockers: [],
        toolsTried: [],
        strategiesTried: [],
        successCriteria: [],
        sentArtifacts: [],
        retryBudget: 3,
        replanBudget: 5,
        confidence: 0.9,
        requiresAuth: false,
        authorizationScope: [],
        expiresAt: Date.now() + 3_600_000,
        ...overrides,
    } as Omit<Goal, 'id' | 'createdAt' | 'updatedAt'>);
}

const channelContext: ChannelContext = { channel: 'test', chatId: 'test-user' };

async function main() {
    const { loop, goalStore } = makeLoop(makeFakeProviderFactory(async () => ({
        status: 'success',
        content: JSON.stringify({ achieved: false, summary: 'não usado neste teste' }),
    })));

    console.log('\n=== S79.1 — partial (erro retryável): blocker registrado, status NÃO vira "blocked" ===');
    {
        const goal = makeGoal(goalStore, {
            currentPlan: [{
                id: 'stepP1',
                description: 'Step com erro de rede retryável',
                toolName: RETRYABLE_TOOL,
                toolArgs: { variant: 'v1' },
                status: 'pending',
                fallbackSteps: [],
            }],
        });
        const state = emptyState(goal.id) as any;
        // runLoopInternal é privado — mesmo padrão já usado em S21/S78 (acesso via (loop as any)
        // para testar o código real, não uma reimplementação paralela).
        await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, state);

        const stored = goalStore.getById(goal.id)!;
        assert(
            stored.blockers.some(b => b.kind === 'environment_limit'),
            'goal.blockers contém o blocker do erro retryável (ANTES da correção: sempre vazio nesse branch)',
            stored.blockers
        );
        assert(
            stored.status !== 'blocked',
            'goal.status NÃO deve virar "blocked" por causa de uma falha retryável (partial) — status esperado: executing',
            stored.status
        );
    }

    console.log('\n=== S79.2 — partial (cycle 1) escalando para blocked+replan (cycle 2, dedup) até sucesso: blocker do partial sobrevive junto do blocker do blocked ===');
    {
        // Mesmo step+args nos 2 primeiros ciclos: cycle 1 -> 'partial' (retryable, budget>0);
        // cycle 2 -> dedup de "alreadyFailed" força 'blocked' (já existia antes da correção,
        // branch 'blocked' sempre chamou addBlocker corretamente) -> replan real (via
        // fakePlanner.replan) troca de step -> sucesso. Prova que o blocker do ciclo 'partial'
        // (que a correção adiciona) sobrevive lado a lado com o blocker do ciclo 'blocked' (que
        // já funcionava), sem um sobrescrever o outro.
        const replanningPlanner = {
            getAvailableSkills: () => [],
            setSkillContext: () => {},
            setModel: () => {},
            replan: async () => ({
                steps: [{
                    id: 'stepP2_replanned',
                    description: 'segunda tentativa args diferentes concluída com sucesso',
                    toolName: RETRYABLE_TOOL,
                    toolArgs: { variant: 'v2' },
                    status: 'pending' as const,
                    fallbackSteps: [],
                }],
                strategy: 'replanned',
            }),
        } as any;
        const { loop: loop2, goalStore: goalStore2 } = (() => {
            const db = new (Database as any)(':memory:');
            const gs = new GoalStore(db);
            const fakeMemory = { getDatabase: () => db } as any;
            const l = new GoalExecutionLoop(
                {} as any, gs, replanningPlanner,
                { record: () => {}, buildContextHint: () => '', findHardConstraints: () => [] } as any,
                ToolRegistry, makeFakeProviderFactory(async () => ({ status: 'success', content: JSON.stringify({ achieved: false, summary: 'n/a' }) })),
                fakeMemory,
                { findApplicableCasesShadow: async () => [], backfillMissingEmbeddings: async () => {}, captureIfEligible: () => {}, findSimilarShadow: () => [] } as any,
            );
            return { loop: l, goalStore: gs };
        })();
        const goal2 = makeGoal(goalStore2, {
            currentPlan: [{
                id: 'stepP2',
                description: 'Step com erro de rede que dispara partial e depois blocked por dedup',
                toolName: RETRYABLE_TOOL,
                toolArgs: { variant: 'v1' },
                status: 'pending',
                fallbackSteps: [],
            }],
            retryBudget: 10,
            replanBudget: 3,
        });
        const state = emptyState(goal2.id) as any;
        await (loop2 as any).runLoopInternal(goal2, channelContext, undefined, 0, 0, undefined, state);

        const stored = goalStore2.getById(goal2.id)!;
        const partialBlockers = stored.blockers.filter(b => b.kind === 'environment_limit');
        const dedupBlockers = stored.blockers.filter(b => b.kind === 'repeated_tool_call');
        assert(
            partialBlockers.length >= 1,
            'blocker do ciclo "partial" (retryable) está presente (ANTES da correção: ausente)',
            stored.blockers
        );
        assert(dedupBlockers.length >= 1, 'blocker do ciclo "blocked" (dedup) também está presente — não foi sobrescrito', stored.blockers);
    }

    console.log('\n=== S79.3 — failed terminal (erro não-retryável, replanBudget=0): blocker registrado E status="failed" (não "blocked") ===');
    {
        const goal = makeGoal(goalStore, {
            currentPlan: [{
                id: 'stepF1',
                description: 'Step com erro não reconhecido, sem budget de replan',
                toolName: FAIL_ALWAYS_TOOL,
                toolArgs: {},
                status: 'pending',
                fallbackSteps: [],
            }],
            replanBudget: 0,
        });
        const state = emptyState(goal.id) as any;
        const result = await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, state);

        const stored = goalStore.getById(goal.id)!;
        assert(result.success === false, 'goal terminou como falha (esperado)', result);
        assert(
            stored.blockers.some(b => b.kind === 'tool_error'),
            'goal.blockers contém o blocker da falha terminal (ANTES da correção: vazio — este é exatamente o padrão real do goal "ykpko" da Sprint 0.5)',
            stored.blockers
        );
        assert(
            stored.status === 'failed',
            'goal.status === "failed" (não "blocked") — a correção não deve substituir o status final por um efeito colateral de recordBlocker',
            stored.status
        );
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S79 RESULTADO: ${passed} passou | ${failed} falhou`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
