/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S89 (Sprint 0.10, achado L22 — sub-turno agentloop não decomposto)
 *
 * Prova que `GoalExecutionLoop.executeStep()` (caminho sem `toolName`, que chama
 * `AgentLoop.process()`) agora correlaciona o `GoalAttempt` resultante com o `ExecutionTrace`
 * real do sub-turno via `traceManager` (mesmo singleton que `AgentLoop` já usa para persistir/
 * emitir traces — `src/core/ExecutionTrace.ts`), preenchendo `attempt.traceId` e
 * `attempt.subToolCalls` (nomes das tools chamadas dentro do sub-turno, em ordem).
 *
 * ANTES desta correção: `GoalExecutionLoop.ts` nunca referenciava `ExecutionTraceManager` —
 * as tool calls internas de um sub-turno `agentloop` (ex: read→exec_command→write dentro de um
 * único step sem toolName) ficavam completamente invisíveis em `goal.attempts`, só
 * reconstruíveis via o dashboard (RAM/`agent_traces`, sem nenhuma referência de volta ao goal).
 *
 * Não duplica o conteúdo do trace (args/outputs de cada tool call) em `GoalAttempt` — só a
 * referência (`traceId`, para pivotar em `agent_traces`/dashboard) e a sequência de nomes
 * (`subToolCalls`), decomposição mínima sem custo de armazenamento relevante.
 *
 * Execução: npx ts-node src/__tests__/regression/S89_AgentloopSubTurn_TraceCorrelation.test.ts
 */

import Database from 'better-sqlite3';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';
import { GoalStore } from '../../loop/GoalStore';
import { ToolRegistry } from '../../core/ToolRegistry';
import { Goal, PlanStep } from '../../loop/GoalTypes';
import { ChannelContext } from '../../loop/agentLoopTypes';
import { traceManager } from '../../core/ExecutionTrace';

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
        chatWithFallback: async () => ({ status: 'success', content: JSON.stringify({ achieved: true, summary: 'teste S89' }) }),
        getProvider: () => undefined,
        getProviderWithModel: () => ({ chat: async () => ({ status: 'success', content: JSON.stringify({ achieved: true, summary: 'teste S89' }) }) }),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
}

/**
 * Simula o que o AgentLoop real faz durante um sub-turno: abre um trace, registra os tool_call
 * que "rodaram" dentro do turno, fecha o trace, e só então retorna o texto final — mesma ordem
 * de eventos que `GoalExecutionLoop.executeStep()` observa de um `AgentLoop.process()` real.
 */
function makeFakeAgentLoopWithTrace(toolsUsed: string[], finalText: string) {
    return {
        process: async (conversationId: string) => {
            const trace = traceManager.startTrace(conversationId, 'prompt de teste S89');
            for (const tool of toolsUsed) {
                traceManager.addStep(trace, 'tool_call', { tool, input: {} });
                traceManager.addStep(trace, 'tool_result', { tool, success: true });
            }
            traceManager.completeTrace(trace, 'completed', finalText);
            return finalText;
        },
    } as any;
}

function makeLoop(fakeAgentLoop: any) {
    const db = new (Database as any)(':memory:');
    const goalStore = new GoalStore(db);
    const fakeMemory = { getDatabase: () => db } as any;
    const fakePlanner = { getAvailableSkills: () => [], setSkillContext: () => {}, setModel: () => {}, replan: async () => ({ steps: [], strategy: 'n/a' }) } as any;
    const loop = new GoalExecutionLoop(
        fakeAgentLoop, goalStore, fakePlanner,
        { record: () => {}, buildContextHint: () => '', findHardConstraints: () => [] } as any,
        ToolRegistry, makeFakeProviderFactory(), fakeMemory,
        { findApplicableCasesShadow: async () => [], backfillMissingEmbeddings: async () => {}, captureIfEligible: () => {}, findSimilarShadow: () => [] } as any,
    );
    return { loop, goalStore };
}

function makeGoal(store: GoalStore, currentPlan: PlanStep[]) {
    return store.create({
        sessionKey: 'test:s89', conversationId: `test-conv-s89-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        userIntent: 'objetivo de teste S89', objective: 'Objetivo de teste S89',
        status: 'executing', attempts: [], blockers: [], toolsTried: [], strategiesTried: [],
        successCriteria: [], sentArtifacts: [], retryBudget: 3, replanBudget: 5, confidence: 0.9,
        requiresAuth: false, authorizationScope: [], expiresAt: Date.now() + 3_600_000,
        currentPlan,
    } as Omit<Goal, 'id' | 'createdAt' | 'updatedAt'>);
}

const channelContext: ChannelContext = { channel: 'test', chatId: 'test-user' };

async function main() {
    console.log('\n=== S89.1 — sub-turno agentloop com 3 tool calls: attempt.traceId e subToolCalls preenchidos ===');
    {
        const fakeAgentLoop = makeFakeAgentLoopWithTrace(['read', 'exec_command', 'write'], 'Tarefa concluída com sucesso.');
        const { loop, goalStore } = makeLoop(fakeAgentLoop);
        const goal = makeGoal(goalStore, [
            { id: 'a1', description: 'Gerar relatório de teste', status: 'pending', fallbackSteps: [] },
        ]);
        const state = emptyState(goal.id) as any;
        await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, state);
        const stored = goalStore.getById(goal.id)!;
        const attempt = [...stored.attempts].reverse().find(a => a.planStepId === 'a1');

        assert(!!attempt?.traceId, `attempt.traceId preenchido (ANTES: sempre undefined) — obtido: ${attempt?.traceId}`, attempt);
        assert(
            JSON.stringify(attempt?.subToolCalls) === JSON.stringify(['read', 'exec_command', 'write']),
            `attempt.subToolCalls reflete a ordem real das tools chamadas no sub-turno — obtido: ${JSON.stringify(attempt?.subToolCalls)}`,
            attempt
        );

        // traceId deve realmente resolver para um trace real e recente em traceManager —
        // prova que é uma correlação genuína, não um id inventado.
        const resolvedTrace = traceManager.getRecentTraces(20).find(t => t.id === attempt?.traceId);
        assert(!!resolvedTrace, 'traceId corresponde a um ExecutionTrace real em traceManager (correlação genuína, não duplicação)', resolvedTrace);
        assert(resolvedTrace?.status === 'completed', 'trace correlacionado está com status completed', resolvedTrace);
    }

    console.log('\n=== S89.2 — sub-turno sem nenhuma tool call: subToolCalls é array vazio, traceId ainda preenchido ===');
    {
        const fakeAgentLoop = makeFakeAgentLoopWithTrace([], 'Resposta direta, sem ferramentas.');
        const { loop, goalStore } = makeLoop(fakeAgentLoop);
        const goal = makeGoal(goalStore, [
            { id: 'b1', description: 'Responder pergunta direta', status: 'pending', fallbackSteps: [] },
        ]);
        const state = emptyState(goal.id) as any;
        await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, state);
        const stored = goalStore.getById(goal.id)!;
        const attempt = [...stored.attempts].reverse().find(a => a.planStepId === 'b1');

        assert(!!attempt?.traceId, 'traceId preenchido mesmo sem tool calls', attempt);
        assert(Array.isArray(attempt?.subToolCalls) && attempt.subToolCalls.length === 0, 'subToolCalls é array vazio (não undefined) quando nenhuma tool rodou', attempt);
    }

    console.log('\n=== S89.3 — step de tool DIRETA (com toolName): traceId/subToolCalls ausentes (não passa por AgentLoop) ===');
    {
        ToolRegistry.register({
            name: 'direct_tool_s89',
            description: 'test',
            parameters: {},
            execute: async () => ({ success: true, output: 'ok' }),
        });
        const { loop, goalStore } = makeLoop({ process: async () => 'não deveria ser chamado' } as any);
        const goal = makeGoal(goalStore, [
            { id: 'c1', description: 'Executar tool direta', toolName: 'direct_tool_s89', toolArgs: {}, status: 'pending', fallbackSteps: [] },
        ]);
        const state = emptyState(goal.id) as any;
        await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, state);
        const stored = goalStore.getById(goal.id)!;
        const attempt = [...stored.attempts].reverse().find(a => a.planStepId === 'c1');

        assert(attempt?.traceId === undefined, 'traceId ausente para tool direta (nunca passou por AgentLoop)', attempt);
        assert(attempt?.subToolCalls === undefined, 'subToolCalls ausente para tool direta', attempt);
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S89 RESULTADO: ${passed} passou | ${failed} falhou`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
