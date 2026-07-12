/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S86 (Sprint 0.8.3, correção do Achado Residual 2 — Sprint 0.8.2)
 *
 * Prova que `markStepDone()`, quando chamado num call site que JÁ passou por `executeStep()`
 * para o mesmo `planStepId` na mesma execução do goal, não grava mais um SEGUNDO `GoalAttempt`
 * para a mesma execução lógica de step — e que `retryBudget` (decrementado a cada
 * `GoalStore.addAttempt()`, `GoalStore.ts:300`) deixa de ser consumido em dobro nesses casos.
 *
 *   S86.1 — envio diferido bem-sucedido (`GoalExecutionLoop.ts` ~751): `executeStep()` grava o
 *           attempt real (`result:'success'`); `markStepDone(..., 'skip')` não grava um segundo.
 *
 *   S86.2 — `needs_auth` auto-aprovado em modo DEVELOPER/GOD (`GoalExecutionLoop.ts` ~1299-1309):
 *           `executeStep()` grava um attempt `result:'failure'` (bloqueio de permissão);
 *           `markStepDone(..., 'finalize')` corrige esse MESMO attempt para `'success'` em vez
 *           de acrescentar um segundo, contraditório (`GoalStore.finalizeLastAttemptAsSuccess`).
 *
 *   S86.3 — `resumeGoal()` (resume pós-autorização, cross-turn): CONTINUA gravando 2 attempts
 *           para o mesmo `planStepId` — e isso é correto, não um bug. `authStepOutput` vem de
 *           uma execução real e distinta via WorkflowEngine (`GoalOrchestrator.resumeFromAuth`),
 *           não de um `executeStep()` já rodado nesta mesma passagem. O primeiro attempt
 *           (`'failure'`, bloqueio de permissão) e o segundo (`'success'`, pós-aprovação)
 *           representam duas execuções genuinamente distintas do step — histórico correto do
 *           Goal, preservado deliberadamente sem alteração nesta Sprint.
 *
 * O call site de dedup de envio diferido (`GoalExecutionLoop.ts` ~738) também não é afetado:
 * o step é pulado (nunca passa por `executeStep()`), então o modo default `'add'` continua
 * correto e já gravava exatamente 1 attempt antes e depois desta correção.
 *
 * Execução: npx ts-node src/__tests__/regression/S86_DuplicateGoalAttempt_MarkStepDoneNoSkip.test.ts
 */

import Database from 'better-sqlite3';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';
import { GoalStore } from '../../loop/GoalStore';
import { ToolRegistry } from '../../core/ToolRegistry';
import { PlanStep } from '../../loop/GoalTypes';
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

function makeFakeProviderFactory() {
    return {
        chatWithFallback: async () => ({ status: 'success', content: JSON.stringify({ achieved: true, summary: 'teste S86' }) }),
        getProvider: () => undefined,
        getProviderWithModel: () => ({ chat: async () => ({ status: 'success', content: JSON.stringify({ achieved: true, summary: 'teste S86' }) }) }),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
}

function makeLoop() {
    const db = new (Database as any)(':memory:');
    const goalStore = new GoalStore(db);
    const fakeMemory = { getDatabase: () => db } as any;
    const fakePlanner = { getAvailableSkills: () => [], setSkillContext: () => {}, setModel: () => {}, replan: async () => ({ steps: [], strategy: 'n/a' }) } as any;
    const loop = new GoalExecutionLoop(
        {} as any, goalStore, fakePlanner,
        { record: () => {}, buildContextHint: () => '', findHardConstraints: () => [] } as any,
        ToolRegistry, makeFakeProviderFactory(), fakeMemory,
        { findApplicableCasesShadow: async () => [], backfillMissingEmbeddings: async () => {}, captureIfEligible: () => {}, findSimilarShadow: () => [] } as any,
    );
    return { loop, goalStore };
}

function makeGoal(store: GoalStore, currentPlan: PlanStep[]) {
    return store.create({
        sessionKey: 'test:s86', conversationId: 'test-conv-s86',
        userIntent: 'objetivo de teste S86', objective: 'Objetivo de teste S86',
        status: 'executing', attempts: [], blockers: [], toolsTried: [], strategiesTried: [],
        successCriteria: [], sentArtifacts: [], retryBudget: 3, replanBudget: 5, confidence: 0.9,
        requiresAuth: false, authorizationScope: [], expiresAt: Date.now() + 3_600_000,
        currentPlan,
    } as Omit<import('../../loop/GoalTypes').Goal, 'id' | 'createdAt' | 'updatedAt'>);
}

const channelContext: ChannelContext = { channel: 'test', chatId: 'test-user' };

async function main() {
    console.log('\n=== S86.1 — envio diferido bem-sucedido: 1 GoalAttempt para 1 step, retryBudget -1 ===');
    {
        ToolRegistry.register({
            name: 'send_document',
            description: 'test',
            parameters: {},
            execute: async () => ({ success: true, output: 'Documento enviado.' }),
        });
        const { loop, goalStore } = makeLoop();
        const goal = makeGoal(goalStore, [
            { id: 's1', description: 'Enviar arquivo', toolName: 'send_document', toolArgs: { file_path: 'arquivo.pptx' }, status: 'pending', fallbackSteps: [] },
        ]);
        const retryBudgetBefore = goal.retryBudget;
        const state = emptyState(goal.id) as any;
        await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, state);
        const stored = goalStore.getById(goal.id)!;
        const attemptsForStep = stored.attempts.filter(a => a.planStepId === 's1');

        assert(
            attemptsForStep.length === 1,
            `exatamente 1 GoalAttempt gravado para o mesmo planStepId='s1' (ANTES da correção: 2 — executeStep() + markStepDone() sem skip) — obtido: ${attemptsForStep.length}`,
            attemptsForStep
        );
        assert(
            attemptsForStep[0]?.result === 'success',
            `o attempt único tem result='success' — obtido: ${attemptsForStep[0]?.result}`,
            attemptsForStep
        );
        assert(
            stored.retryBudget === retryBudgetBefore - 1,
            `retryBudget decrementado em 1 (ANTES da correção: 2) para 1 execução lógica de step — antes=${retryBudgetBefore}, depois=${stored.retryBudget}`,
            { retryBudgetBefore, retryBudgetAfter: stored.retryBudget }
        );
    }

    console.log('\n=== S86.2 — needs_auth auto-aprovado (DEVELOPER/GOD): 1 GoalAttempt, corrigido para success ===');
    {
        const modeBefore = permissionRegistry.getMode();
        permissionRegistry.setMode(OperationalMode.DEVELOPER, 'test-s86', true);
        try {
            ToolRegistry.register({
                name: 'exec_command_s86',
                description: 'test',
                parameters: {},
                execute: async () => ({ success: false, output: '', error: 'permission denied: needs authorization' }),
            });
            const { loop, goalStore } = makeLoop();
            const goal = makeGoal(goalStore, [
                { id: 's1', description: 'Executar comando', toolName: 'exec_command_s86', toolArgs: {}, status: 'pending', fallbackSteps: [] },
            ]);
            const retryBudgetBefore = goal.retryBudget;
            const state = emptyState(goal.id) as any;
            await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, state);
            const stored = goalStore.getById(goal.id)!;
            const attemptsForStep = stored.attempts.filter(a => a.planStepId === 's1');

            assert(
                attemptsForStep.length === 1,
                `exatamente 1 GoalAttempt gravado para o mesmo planStepId='s1' (ANTES da correção: 2, divergentes 'failure'+'success') — obtido: ${attemptsForStep.length}`,
                attemptsForStep
            );
            assert(
                attemptsForStep[0]?.result === 'success',
                `o attempt único foi corrigido (finalizeLastAttemptAsSuccess) de 'failure' para 'success' — obtido: ${attemptsForStep[0]?.result}`,
                attemptsForStep
            );
            assert(
                attemptsForStep[0]?.error === undefined,
                `o texto de erro do bloqueio original (permission denied) foi limpo junto com a correção — obtido: ${attemptsForStep[0]?.error}`,
                attemptsForStep
            );
            assert(
                stored.retryBudget === retryBudgetBefore - 1,
                `retryBudget decrementado em 1 (ANTES da correção: 2) para 1 execução lógica de step — antes=${retryBudgetBefore}, depois=${stored.retryBudget}`,
                { retryBudgetBefore, retryBudgetAfter: stored.retryBudget }
            );
        } finally {
            permissionRegistry.setMode(modeBefore, 'test-s86-restore', true);
        }
    }

    console.log('\n=== S86.3 — resumeGoal() (cross-turn): 2 GoalAttempt preservados DELIBERADAMENTE (não é o mesmo bug) ===');
    {
        const { loop, goalStore } = makeLoop();
        const goal = goalStore.create({
            sessionKey: 'test:s86-resume', conversationId: 'test-conv-s86-resume',
            userIntent: 'objetivo', objective: 'Objetivo',
            status: 'blocked', attempts: [{
                id: 'att_prior_failure', planStepId: 's1', toolName: 'exec_command', args: {},
                result: 'failure', error: 'permission denied: needs authorization',
                durationMs: 1, executedAt: Date.now(), cycle: 1,
            }],
            blockers: [], toolsTried: [], strategiesTried: [],
            successCriteria: [], sentArtifacts: [], retryBudget: 3, replanBudget: 5, confidence: 0.9,
            requiresAuth: false, authorizationScope: [], expiresAt: Date.now() + 3_600_000,
            currentPlan: [{ id: 's1', description: 'Executar comando', toolName: 'exec_command', toolArgs: {}, status: 'pending', fallbackSteps: [] }],
        } as Omit<import('../../loop/GoalTypes').Goal, 'id' | 'createdAt' | 'updatedAt'>);
        const retryBudgetBefore = goal.retryBudget;

        await (loop as any).resumeGoal(goal, channelContext, 'comando executado com sucesso via WorkflowEngine');

        const stored = goalStore.getById(goal.id)!;
        const attemptsForStep = stored.attempts.filter(a => a.planStepId === 's1');

        assert(
            attemptsForStep.length === 2,
            `2 GoalAttempt preservados (1 execução real bloqueada + 1 execução real pós-aprovação via WorkflowEngine) — obtido: ${attemptsForStep.length}`,
            attemptsForStep
        );
        assert(
            attemptsForStep[0]?.result === 'failure' && attemptsForStep[1]?.result === 'success',
            `primeiro attempt permanece 'failure' (execução real bloqueada), segundo é 'success' (execução real pós-aprovação) — obtido: ${JSON.stringify(attemptsForStep.map(a => a.result))}`,
            attemptsForStep
        );
        assert(
            stored.retryBudget === retryBudgetBefore - 1,
            `retryBudget decrementado em 1 nesta chamada de resumeGoal() (só 1 addAttempt novo — o attempt 'failure' já existia antes) — antes=${retryBudgetBefore}, depois=${stored.retryBudget}`,
            { retryBudgetBefore, retryBudgetAfter: stored.retryBudget }
        );
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S86 RESULTADO: ${passed} passou | ${failed} falhou`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
