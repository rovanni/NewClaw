/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S119 (Sprint 2026-08-S13, ARCH-007)
 *
 * Prova que `markStepDone()` não deixa mais `PlanStep.status: 'completed'` como a ÚNICA
 * informação disponível sobre o resultado de um step — `PlanStep.lastAttemptOutcome` agora
 * carrega o `AttemptOutcome` REAL do `GoalAttempt` mais recente daquele step, mesmo quando
 * `status` permanece `'completed'` (eixo de progressão do plano — "não será redespachado" —
 * que continua correto e não muda: um attempt 'partial' de baixa confiança não força retry,
 * por design, ver S85).
 *
 * Antes desta correção, `reflectionOutcome` já era calculado corretamente dentro de
 * `markStepDone()` (inclusive no modo 'skip', lendo o attempt real gravado por `executeStep()`)
 * mas só alimentava `ReflectionMemory.record()` — descartado depois disso. Um `PlanStep`
 * podia ficar `status: 'completed'` com um `GoalAttempt` correspondente `'partial'` sem
 * nenhum jeito de um consumidor futuro (progressModel, UI, um validador de conclusão mais
 * rigoroso) descobrir isso sem duplicar a lógica de busca em `goal.attempts`.
 *
 * Execução: npx ts-node src/__tests__/regression/S119_PlanStepLastAttemptOutcome_ARCH007.test.ts
 */

import Database from 'better-sqlite3';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';
import { GoalStore } from '../../loop/GoalStore';
import { ToolRegistry } from '../../core/ToolRegistry';
import { Goal, PlanStep } from '../../loop/GoalTypes';
import { ChannelContext } from '../../loop/agentLoopTypes';
import { permissionRegistry } from '../../core/PermissionRegistry';
import { OperationalMode } from '../../core/CapabilityMode';

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

const SHARED_TERMS = 'relatório processar';
const TEXT_EXPLICIT_SUCCESS = `${SHARED_TERMS} — enviado com sucesso, tarefa concluída.`;
// >=200 chars, sem sinal de falha/sucesso — cai no fallback conservador "resposta longa,
// assume sucesso" (substantial_response, confidence=0.70) — mesmo cenário do S85.2.
// ARCH-013 (S21/reabertura): SEM overlap de termos-chave com a description do step
// (`agentloopStep()`, que usa SHARED_TERMS) — de propósito, para que StepSemanticValidator não
// encontre relevância e NÃO promova o attempt a 'success' (antes desta correção, o prefixo
// SHARED_TERMS ficava aqui só para não disparar um downgrade falso-positivo; agora precisa
// ficar de fora, porque overlap também dispararia promoção).
const FILLER = 'dados registrados no sistema para análise posterior, aguardando revisão da equipe responsável pelo acompanhamento do cronograma estabelecido pela coordenação técnica envolvida. ';
const TEXT_LONG_FALLBACK = `${FILLER}${FILLER}`;
if (TEXT_LONG_FALLBACK.length < 200) throw new Error('TEXT_LONG_FALLBACK curto demais — ajuste o filler');

function makeFakeProviderFactory() {
    return {
        chatWithFallback: async () => ({ status: 'success', content: JSON.stringify({ achieved: true, summary: 'teste S119' }) }),
        getProvider: () => undefined,
        getProviderWithModel: () => ({ chat: async () => ({ status: 'success', content: JSON.stringify({ achieved: true, summary: 'teste S119' }) }) }),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
}

function makeLoop(agentLoopResponse?: string) {
    const db = new (Database as any)(':memory:');
    const goalStore = new GoalStore(db);
    const fakeMemory = { getDatabase: () => db } as any;
    const fakePlanner = { getAvailableSkills: () => [], setSkillContext: () => {}, setModel: () => {}, replan: async () => ({ steps: [], strategy: 'n/a' }) } as any;
    const fakeAgentLoop = { process: async () => agentLoopResponse ?? '' } as any;
    const loop = new GoalExecutionLoop(
        fakeAgentLoop, goalStore, fakePlanner,
        { record: () => {}, findToolFailures: () => '', findHardConstraints: () => [] } as any,
        ToolRegistry, makeFakeProviderFactory(), fakeMemory,
        { findApplicableCasesShadow: async () => [], backfillMissingEmbeddings: async () => {}, captureIfEligible: () => {}, findSimilarShadow: () => [] } as any,
    );
    return { loop, goalStore };
}

function makeGoal(store: GoalStore, currentPlan: PlanStep[]): Goal {
    return store.create({
        sessionKey: 'test:s119', conversationId: 'test-conv-s119',
        userIntent: 'objetivo de teste S119', objective: 'Objetivo de teste S119',
        status: 'executing', attempts: [], blockers: [], toolsTried: [], strategiesTried: [],
        successCriteria: [], sentArtifacts: [], retryBudget: 3, replanBudget: 5, confidence: 0.9,
        requiresAuth: false, authorizationScope: [], expiresAt: Date.now() + 3_600_000,
        currentPlan,
    } as Omit<Goal, 'id' | 'createdAt' | 'updatedAt'>);
}

function agentloopStep(id: string, description = `Gerar ${SHARED_TERMS} de teste`): PlanStep {
    return { id, description, status: 'pending', fallbackSteps: [] };
}

const channelContext: ChannelContext = { channel: 'test', chatId: 'test-user' };

function findStep(goal: Goal, id: string): PlanStep | undefined {
    return goal.currentPlan.find(s => s.id === id);
}

async function main() {
    console.log('\n=== S119.1 — attempt success de alta confiança: status=completed, lastAttemptOutcome=success ===');
    {
        const { loop, goalStore } = makeLoop(TEXT_EXPLICIT_SUCCESS);
        const goal = makeGoal(goalStore, [agentloopStep('a1')]);
        const state = emptyState(goal.id) as any;
        await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, state);
        const step = findStep(goalStore.getById(goal.id)!, 'a1');
        assert(step?.status === 'completed', `PlanStep.status === 'completed' — obtido: ${step?.status}`, step);
        assert(
            step?.lastAttemptOutcome === 'success',
            `PlanStep.lastAttemptOutcome === 'success' (sinal explícito, alta confiança) — obtido: ${step?.lastAttemptOutcome}`,
            step
        );
    }

    console.log('\n=== S119.2 — attempt success de BAIXA confiança (fallback substantial_response): status=completed MAS lastAttemptOutcome=partial ===');
    {
        const { loop, goalStore } = makeLoop(TEXT_LONG_FALLBACK);
        const goal = makeGoal(goalStore, [agentloopStep('b1')]);
        const state = emptyState(goal.id) as any;
        await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, state);
        const stored = goalStore.getById(goal.id)!;
        const step = findStep(stored, 'b1');
        const attempt = [...stored.attempts].reverse().find(a => a.planStepId === 'b1');
        assert(
            step?.status === 'completed',
            `PlanStep.status === 'completed' (design intencional — S85: 'partial' de baixa confiança não força retry automático) — obtido: ${step?.status}`,
            step
        );
        assert(
            attempt?.result === 'partial',
            `pré-condição do cenário: GoalAttempt.result === 'partial' — obtido: ${attempt?.result}`,
            attempt
        );
        assert(
            step?.lastAttemptOutcome === 'partial',
            `PlanStep.lastAttemptOutcome === 'partial' (ARCH-007: ANTES da correção esta informação existia só em goal.attempts, invisível a partir do PlanStep) — obtido: ${step?.lastAttemptOutcome}`,
            step
        );
    }

    console.log('\n=== S119.3 — downgrade semântico pós-persistência (S85.5): lastAttemptOutcome reflete a correção, não o "success" heurístico original ===');
    {
        const TOOL = '__s119_mismatch_tool__';
        ToolRegistry.register({
            name: TOOL,
            description: 'test',
            parameters: {},
            execute: async () => ({ success: true, output: 'Operação finalizada normalmente.' }),
        });
        const mismatchProviderFactory = {
            chatWithFallback: async () => ({ status: 'success', content: JSON.stringify({ achieved: true, summary: 'teste S119' }) }),
            getProvider: () => undefined,
            getProviderWithModel: () => ({
                chat: async () => ({ status: 'success', content: JSON.stringify({ result: 'mismatch', confidence: 0.9, reason: 'teste S119 — output não endereça a intenção do step' }) }),
            }),
        } as unknown as import('../../core/ProviderFactory').ProviderFactory;

        const db = new (Database as any)(':memory:');
        const goalStore = new GoalStore(db);
        const fakeMemory = { getDatabase: () => db } as any;
        const fakePlanner = { getAvailableSkills: () => [], setSkillContext: () => {}, setModel: () => {}, replan: async () => ({ steps: [], strategy: 'n/a' }) } as any;
        const loop = new GoalExecutionLoop(
            {} as any, goalStore, fakePlanner,
            { record: () => {}, findToolFailures: () => '', findHardConstraints: () => [] } as any,
            ToolRegistry, mismatchProviderFactory, fakeMemory,
            { findApplicableCasesShadow: async () => [], backfillMissingEmbeddings: async () => {}, captureIfEligible: () => {}, findSimilarShadow: () => [] } as any,
        );
        const goal = makeGoal(goalStore, [
            { id: 'e1', description: 'Buscar cotação específica de determinada criptomoeda rara', toolName: TOOL, toolArgs: {}, status: 'pending', fallbackSteps: [] },
        ]);
        goalStore.update(goal.id, { retryBudget: 0 });
        const state = emptyState(goal.id) as any;
        await (loop as any).runLoopInternal(goalStore.getById(goal.id)!, channelContext, undefined, 0, 0, undefined, state);
        const stored = goalStore.getById(goal.id)!;
        const step = findStep(stored, 'e1');
        // Sem retryBudget e já sem hint anterior, o caminho de mismatch escala para 'blocked'
        // (replan) em vez de 'success' — markStepDone() nem chega a rodar para este step neste
        // ciclo. Confirma que o step NÃO fica 'completed' silenciosamente com o attempt corrigido
        // para 'partial' escondido — o outcome errado nunca chega a virar 'completed' aqui.
        assert(
            step?.status !== 'completed',
            `PlanStep.status !== 'completed' quando o mismatch semântico escala para 'blocked' (retryBudget=0) — obtido: ${step?.status}`,
            step
        );
    }

    console.log('\n=== S119.4 — modo "add" (ex: step de auth aprovado) e "finalize" (needs_auth auto-aprovado): lastAttemptOutcome=success, sem regressão ===');
    {
        const modeBefore = permissionRegistry.getMode();
        permissionRegistry.setMode(OperationalMode.DEVELOPER, 'test-s119', true);
        try {
            ToolRegistry.register({
                name: 'exec_command_s119',
                description: 'test',
                parameters: {},
                execute: async () => ({ success: false, output: '', error: 'permission denied: needs authorization' }),
            });
            const { loop, goalStore } = makeLoop();
            const goal = makeGoal(goalStore, [
                { id: 's1', description: 'Executar comando', toolName: 'exec_command_s119', toolArgs: {}, status: 'pending', fallbackSteps: [] },
            ]);
            const state = emptyState(goal.id) as any;
            await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, state);
            const stored = goalStore.getById(goal.id)!;
            const step = findStep(stored, 's1');
            assert(step?.status === 'completed', `PlanStep.status === 'completed' (auto-aprovado) — obtido: ${step?.status}`, step);
            assert(
                step?.lastAttemptOutcome === 'success',
                `PlanStep.lastAttemptOutcome === 'success' (modo 'finalize', attempt corrigido de failure→success) — obtido: ${step?.lastAttemptOutcome}`,
                step
            );
        } finally {
            permissionRegistry.setMode(modeBefore, 'test-s119-restore', true);
        }
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S119 RESULTADO: ${passed} passou | ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
