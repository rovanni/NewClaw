/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S122 (ARCH-022, Sprint 2026-09-S22)
 *
 * `GoalExecutionLoop.executeStep()` (~375 linhas) foi decomposto num orquestrador enxuto +
 * 4 métodos privados (`recordFailedAttempt`, `dispatchToolStep`, `dispatchAgentloopStep`,
 * `finalizeStepAttempt`) — sem mudar nenhuma lógica. O card original descrevia "4 blocos quase
 * idênticos de construir GoalAttempt de falha" (guarda de step-name-as-path, botões de auth,
 * catch, e o próprio fluxo principal) que deveriam virar um helper único
 * (`recordFailedAttempt(goal, step, {error, output, cycle})`).
 *
 * Reverificação de premissa (Fase 1/2, antes de implementar): os 4 blocos são PARECIDOS mas não
 * intercambiáveis — o guard de auth (`needs_auth`) nunca chamava `evaluator.evaluate()` (retorna
 * o outcome direto, sem classificação de erro/retry), os outros 3 sempre chamavam; o catch usa
 * `step.toolName`/`step.toolArgs` reais (o erro pode vir de QUALQUER caminho), os guards do
 * agentloop hardcodeiam `toolName: 'agentloop', args: {}` (só existem dentro do dispatch
 * agentloop); o bloco do fluxo principal tem 5 campos extras (mutations, evaluation, traceId,
 * subToolCalls, producedArtifactPaths) que os outros 3 não têm E não é exclusivamente um bloco
 * de falha (cobre success/partial/failure). `recordFailedAttempt()` foi implementado cobrindo só
 * os 3 blocos genuinamente equivalentes (step-name-as-path, catch, e o attempt-build do guard de
 * auth — sem a chamada a evaluator.evaluate, que o guard de auth nunca fazia); o bloco do fluxo
 * principal continua com sua própria construção de attempt (mais rica), dentro de
 * `finalizeStepAttempt()`.
 *
 * Este teste cobre os 4 cenários pedidos pelo card ("Unitário: os 4 cenários de falha"),
 * chamando `executeStep()` diretamente (método privado, mesmo padrão já usado em S79/S86/S113
 * para testar o código real via `(loop as any)`).
 *
 * Execução: npx ts-node src/__tests__/regression/S122_ExecuteStep_Decomposition_FourFailureScenarios.test.ts
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

function emptyState(goalId: string) {
    return {
        cognitiveContext: { discoveries: [], failedStrategies: [], filesRead: [], filesModified: [], generatedArtifacts: [], executedCommands: [], importantOutputs: [] },
        progressModel: { goalId, components: [], overallPercent: 0, updatedAt: Date.now() },
    } as any;
}

function makeLoop(agentLoopStub: unknown) {
    const db = new (Database as any)(':memory:');
    const goalStore = new GoalStore(db);
    const fakeMemory = { getDatabase: () => db } as any;
    const fakePlanner = {
        getAvailableSkills: () => [],
        setSkillContext: () => {},
        setModel: () => {},
        replan: async () => ({ steps: [], strategy: 'n/a' }),
    } as any;
    const providerFactory = { chatWithFallback: async () => ({ status: 'success', content: '{"success":true}' }) } as any;
    const loop = new GoalExecutionLoop(
        agentLoopStub as any,
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

function makeGoal(store: GoalStore, plan: PlanStep[]): Goal {
    return store.create({
        sessionKey: 'test:s122',
        conversationId: 'test-conv-s122',
        userIntent: 'objetivo de teste S122',
        objective: 'objetivo de teste S122',
        status: 'executing',
        currentPlan: plan,
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
    } as Omit<Goal, 'id' | 'createdAt' | 'updatedAt'>);
}

function makeAgentlooStep(): PlanStep {
    return { id: 'step1', description: 'step de teste sem toolName', status: 'pending', fallbackSteps: [] };
}

const channelContext: ChannelContext = { channel: 'test', chatId: 'test-user' };

async function main(): Promise<void> {

console.log('\n=== S122-1 [cenário 1/4] — guarda de step-name-as-path: attempt de falha + evaluator.evaluate ===');
{
    const agentLoopStub = { process: async () => 'Arquivo não encontrado: /workspace/identificar_algo' };
    const { loop, goalStore } = makeLoop(agentLoopStub);
    const step = makeAgentlooStep();
    const goal = makeGoal(goalStore, [step]);

    const cycleResult = await (loop as any).executeStep(goal, step, channelContext, 1, emptyState(goal.id));

    const stored = goalStore.getById(goal.id)!;
    assert(stored.attempts.length === 1, `1 GoalAttempt persistido (obtido: ${stored.attempts.length})`, stored.attempts);
    assert(stored.attempts[0]?.result === 'failure', `attempt.result === 'failure' (obtido: ${stored.attempts[0]?.result})`);
    assert(!!stored.attempts[0]?.error?.includes('Path inválido'), 'attempt.error menciona "Path inválido"', stored.attempts[0]?.error);
    assert(cycleResult.outcome !== 'success', `cycleResult passou por evaluator.evaluate (outcome não é 'success' direto) — obtido: ${cycleResult.outcome}`);
}

console.log('\n=== S122-2 [cenário 2/4] — botões de auth: attempt de falha SEM error, outcome=needs_auth SEM passar por evaluator.evaluate ===');
{
    const agentLoopStub = {
        process: async () => ({ text: 'Preciso de autorização', options: [{ label: 'Aprovar', value: 'auth:approve:txn123' }] }),
    };
    const { loop, goalStore } = makeLoop(agentLoopStub);
    const step = makeAgentlooStep();
    const goal = makeGoal(goalStore, [step]);

    const cycleResult = await (loop as any).executeStep(goal, step, channelContext, 1, emptyState(goal.id));

    const stored = goalStore.getById(goal.id)!;
    assert(stored.attempts.length === 1, `1 GoalAttempt persistido (obtido: ${stored.attempts.length})`, stored.attempts);
    assert(stored.attempts[0]?.result === 'failure', `attempt.result === 'failure' (obtido: ${stored.attempts[0]?.result})`);
    assert(stored.attempts[0]?.error === undefined, 'attempt.error NÃO é setado (diferente do cenário 1 — recordFailedAttempt aceita error opcional)', stored.attempts[0]?.error);
    assert(cycleResult.outcome === 'needs_auth', `cycleResult.outcome === 'needs_auth' direto, sem classificação do evaluator (obtido: ${cycleResult.outcome})`);
    assert(cycleResult.confidence === 0.9, `confidence hardcoded 0.9 preservada (obtido: ${cycleResult.confidence})`);
}

console.log('\n=== S122-3 [cenário 3/4] — catch de exceção: usa step.toolName/step.toolArgs reais, não hardcode agentloop ===');
{
    const agentLoopStub = { process: async () => { throw new Error('falha simulada no AgentLoop.process'); } };
    const { loop, goalStore } = makeLoop(agentLoopStub);
    const step = makeAgentlooStep(); // toolName undefined → catch usa 'unknown'
    const goal = makeGoal(goalStore, [step]);

    const cycleResult = await (loop as any).executeStep(goal, step, channelContext, 1, emptyState(goal.id));

    const stored = goalStore.getById(goal.id)!;
    assert(stored.attempts.length === 1, `1 GoalAttempt persistido (obtido: ${stored.attempts.length})`, stored.attempts);
    assert(stored.attempts[0]?.result === 'failure', `attempt.result === 'failure' (obtido: ${stored.attempts[0]?.result})`);
    assert(stored.attempts[0]?.toolName === 'unknown', `attempt.toolName === 'unknown' (step sem toolName, catch usa fallback correto) — obtido: ${stored.attempts[0]?.toolName}`);
    assert(!!stored.attempts[0]?.error?.includes('falha simulada'), 'attempt.error contém a mensagem da exceção real', stored.attempts[0]?.error);
    assert(cycleResult.outcome !== undefined, 'cycleResult veio de evaluator.evaluate (outcome definido)', cycleResult);
}

console.log('\n=== S122-4 [cenário 4/4] — fluxo principal (dispatch de tool direta) com falha: finalizeStepAttempt, não recordFailedAttempt ===');
{
    const FAILING_TOOL = '__s122_failing_tool__';
    ToolRegistry.register({
        name: FAILING_TOOL,
        description: 'test',
        parameters: {},
        execute: async () => ({ success: false, output: '', error: 'erro determinístico de teste' }),
    });
    const { loop, goalStore } = makeLoop({ process: async () => 'não deveria ser chamado' });
    const step: PlanStep = { id: 'step1', description: 'step com tool que falha', toolName: FAILING_TOOL, toolArgs: {}, status: 'pending', fallbackSteps: [] };
    const goal = makeGoal(goalStore, [step]);

    const cycleResult = await (loop as any).executeStep(goal, step, channelContext, 1, emptyState(goal.id));

    const stored = goalStore.getById(goal.id)!;
    assert(stored.attempts.length === 1, `1 GoalAttempt persistido via finalizeStepAttempt (obtido: ${stored.attempts.length})`, stored.attempts);
    assert(stored.attempts[0]?.result === 'failure', `attempt.result === 'failure' (obtido: ${stored.attempts[0]?.result})`);
    assert(stored.attempts[0]?.toolName === FAILING_TOOL, `attempt.toolName === '${FAILING_TOOL}' (dispatch de tool direta, não 'agentloop') — obtido: ${stored.attempts[0]?.toolName}`);
    assert(!!stored.attempts[0]?.error?.includes('erro determinístico'), 'attempt.error contém o erro real da tool', stored.attempts[0]?.error);
    assert(cycleResult.outcome !== undefined, 'cycleResult veio de evaluator.evaluate, mesmo caminho dos outros 3 (exceto needs_auth)', cycleResult);
}

console.log('\n=== S122-5 [controle — caminho feliz] — dispatch de tool direta com sucesso não regride ===');
{
    const OK_TOOL = '__s122_ok_tool__';
    ToolRegistry.register({
        name: OK_TOOL,
        description: 'test',
        parameters: {},
        execute: async () => ({ success: true, output: 'tudo certo' }),
    });
    const { loop, goalStore } = makeLoop({ process: async () => 'não deveria ser chamado' });
    const step: PlanStep = { id: 'step1', description: 'step com tool que funciona', toolName: OK_TOOL, toolArgs: {}, status: 'pending', fallbackSteps: [] };
    const goal = makeGoal(goalStore, [step]);

    const cycleResult = await (loop as any).executeStep(goal, step, channelContext, 1, emptyState(goal.id));

    const stored = goalStore.getById(goal.id)!;
    assert(stored.attempts[0]?.result === 'success', `attempt.result === 'success' (dispatch de tool direta é sempre confiante, stepSuccessConfident=true) — obtido: ${stored.attempts[0]?.result}`, stored.attempts[0]);
    assert(cycleResult.outcome === 'success', `cycleResult.outcome === 'success' (obtido: ${cycleResult.outcome})`, cycleResult);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S122 RESULTADO: ${passed} passou | ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S122 erro inesperado:', err);
    process.exitCode = 1;
});
