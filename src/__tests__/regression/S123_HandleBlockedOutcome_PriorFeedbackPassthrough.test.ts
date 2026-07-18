/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S123 (Sprint 2026-10-S24, ARCH-020, achado durante a própria extração)
 *
 * `runLoopInternal()` foi decomposto: cada `case` do switch(cycleResult.outcome) virou um
 * método `handle*Outcome()` nomeado, devolvendo `{goal, totalReplans, priorFeedback}` (ou um
 * early return), que o loop usa para atualizar suas 3 variáveis locais depois do switch.
 *
 * `handleBlockedOutcome()` tem um guard defensivo no topo — `if (!cycleResult.blocker) break;`
 * no código original — para o caso (hoje inalcançável pelos 3 produtores reais de
 * outcome='blocked' no código, mas permitido pelo tipo `GoalBlocker | undefined`) de o outcome
 * vir sem blocker. Ao extrair esse `break` para um `return { earlyReturn: false, ... }`, a
 * primeira versão escrita aqui devolvia `priorFeedback: undefined` incondicionalmente —
 * diferente do `break` original, que preservava o `priorFeedback` que já existia ANTES do
 * ciclo (só reatribuído mais abaixo no mesmo case, depois do guard). Corrigido antes de rodar
 * a suíte, adicionando `priorFeedback` como parâmetro de entrada do handler. Este teste chama
 * `handleBlockedOutcome()` diretamente (não via `runLoopInternal()`, já que o cenário — outcome
 * 'blocked' sem blocker — não é produzido por nenhum caminho real hoje) para travar
 * especificamente esse achado.
 *
 * Execução: npx ts-node src/__tests__/regression/S123_HandleBlockedOutcome_PriorFeedbackPassthrough.test.ts
 */

import Database from 'better-sqlite3';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';
import { GoalStore } from '../../loop/GoalStore';
import { ToolRegistry } from '../../core/ToolRegistry';
import { Goal, PlanStep, CycleResult } from '../../loop/GoalTypes';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

function makeLoop() {
    const db = new (Database as any)(':memory:');
    const goalStore = new GoalStore(db);
    const fakeMemory = { getDatabase: () => db } as any;
    const fakePlanner = { getAvailableSkills: () => [], setSkillContext: () => {}, setModel: () => {}, replan: async () => ({ steps: [], strategy: 'n/a' }) } as any;
    const fakeAgentLoop = { process: async () => 'n/a' } as any;
    const loop = new GoalExecutionLoop(
        fakeAgentLoop, goalStore, fakePlanner,
        { record: () => {}, buildContextHint: () => '', findHardConstraints: () => [] } as any,
        ToolRegistry, {
            chatWithFallback: async () => ({ status: 'success', content: '{}' }),
            getProvider: () => undefined,
            getProviderWithModel: () => ({ chat: async () => ({ status: 'success', content: '{}' }) }),
        } as any, fakeMemory,
        { findApplicableCasesShadow: async () => [], backfillMissingEmbeddings: async () => {}, captureIfEligible: () => {}, findSimilarShadow: () => [] } as any,
    );
    return { loop, goalStore };
}

function makeGoal(store: GoalStore, plan: PlanStep[]): Goal {
    return store.create({
        sessionKey: 'test:s123', conversationId: 'test-conv-s123',
        userIntent: 'objetivo de teste S123', objective: 'Objetivo de teste S123',
        status: 'executing', attempts: [], blockers: [], toolsTried: [], strategiesTried: [],
        successCriteria: [], sentArtifacts: [], retryBudget: 3, replanBudget: 5, confidence: 0.9,
        requiresAuth: false, authorizationScope: [], expiresAt: Date.now() + 3_600_000,
        currentPlan: plan,
    } as Omit<Goal, 'id' | 'createdAt' | 'updatedAt'>);
}

const emptyState = { cognitiveContext: { discoveries: [], failedStrategies: [], filesRead: [], filesModified: [], generatedArtifacts: [], executedCommands: [], importantOutputs: [] }, progressModel: null } as any;

async function main() {
    console.log('\n=== S123.1 — outcome=blocked SEM blocker: priorFeedback do chamador é preservado, não zerado ===');
    {
        const { loop, goalStore } = makeLoop();
        const step: PlanStep = { id: 'step1', description: 'step de teste', toolName: 'exec_command', toolArgs: {}, status: 'pending', fallbackSteps: [] };
        const goal = makeGoal(goalStore, [step]);
        const cycleResult: CycleResult = { outcome: 'blocked', confidence: 0.5 }; // sem `blocker` — cenário do guard defensivo

        const existingPriorFeedback = 'feedback de um ciclo anterior — não deve ser apagado';
        const result = await (loop as any).handleBlockedOutcome(
            goal, step, cycleResult, /* totalCycles */ 1, /* totalReplans */ 0,
            existingPriorFeedback, emptyState, undefined,
        );

        assert(result.earlyReturn === false, 'earlyReturn === false (guard sem blocker faz "break", não "return")', result);
        assert(
            result.priorFeedback === existingPriorFeedback,
            'priorFeedback devolvido é o MESMO recebido como parâmetro (não undefined) — bug pego e corrigido durante a extração ARCH-020/S24, antes de rodar a suíte',
            result.priorFeedback,
        );
        assert(result.totalReplans === 0, 'totalReplans não muda quando o guard sem blocker dispara', result.totalReplans);
        assert(result.goal.id === goal.id, 'goal devolvido é o mesmo goal recebido (sem mutação nesse branch)', result.goal.id);
    }

    console.log('\n=== S123.2 — outcome=blocked COM blocker: priorFeedback é substituído pela descrição do blocker (comportamento inalterado) ===');
    {
        const { loop, goalStore } = makeLoop();
        const step: PlanStep = { id: 'step2', description: 'step de teste 2', toolName: 'exec_command', toolArgs: {}, status: 'pending', fallbackSteps: [] };
        const goal = makeGoal(goalStore, [step]);
        const cycleResult: CycleResult = {
            outcome: 'blocked', confidence: 0.3,
            blocker: {
                kind: 'repeated_tool_call', toolName: 'exec_command',
                description: 'blocker de teste S123', suggestedActions: [], detectedAt: Date.now(),
            },
        };

        const result = await (loop as any).handleBlockedOutcome(
            goal, step, cycleResult, /* totalCycles */ 1, /* totalReplans */ 0,
            'feedback anterior, deve ser substituído', emptyState, undefined,
        );

        assert(result.earlyReturn === false, 'earlyReturn === false (replanBudget > 0, progress não regressing)', result);
        assert(
            result.priorFeedback === 'blocker de teste S123',
            'priorFeedback é substituído pela description do blocker deste ciclo (comportamento original preservado)',
            result.priorFeedback,
        );
        assert(result.totalReplans === 1, 'totalReplans incrementado (replan via planWithSpiral)', result.totalReplans);
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S123 RESULTADO: ${passed} passou | ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
