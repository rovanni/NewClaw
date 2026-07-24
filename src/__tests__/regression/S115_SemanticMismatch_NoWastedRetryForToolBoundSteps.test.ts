/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S115
 *
 * Achado ao vivo (auditoria, 17/07/2026): um goal de inventário de host rodou `exec_command`
 * duas vezes IDÊNTICAS para o mesmo step (mesma pergunta — hostname/OS/uptime/CPU/memória —,
 * mesma saída irrelevante — só vulnerabilidades de CPU — nas duas vezes) e, no mesmo goal,
 * `memory_search` também duas vezes IDÊNTICAS (mesma query, mesmo resultado irrelevante).
 *
 * Causa raiz: quando `StepSemanticValidator` marca `shouldDowngradeToPartial`,
 * `GoalExecutionLoop` (ver bloco em torno de `retryCanHelp` em `executeStep`'s caller) dá UM
 * retry "com hint" antes de escalar para `blocked`/replan — mas o hint só é escrito em
 * `step.description`. Para um step com `toolName` fixo (exec_command, memory_search,
 * ssh_exec, weather, crypto_analysis, ...), `executeStep()` despacha via
 * `resolveStepRefs(step.toolArgs, goal)` — que só resolve `{{step_N.output}}`, nunca
 * regenera `toolArgs` a partir da description. Ou seja: o retry chama a MESMA tool com os
 * MESMOS argumentos e reproduz o MESMO mismatch, sempre — só é útil para steps sem toolName
 * (caminho 'agentloop', que gera uma resposta nova do LLM a cada chamada). O retry inútil
 * queima um ciclo (dispatch da tool + uma chamada LLM ao StepSemanticValidator) antes de
 * chegar no replan — o único caminho que de fato muda alguma coisa.
 *
 * Este teste prova que, para um step COM toolName, o mismatch semântico escala direto para
 * 'blocked' na PRIMEIRA ocorrência (sem o retry inútil) — a tool é invocada uma única vez.
 * Um step sem toolName (caminho 'agentloop') continua tendo direito ao retry com hint, como
 * antes (comportamento não alterado por este fix).
 *
 * Execução: npx ts-node src/__tests__/regression/S115_SemanticMismatch_NoWastedRetryForToolBoundSteps.test.ts
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

// LLM sempre confirma mismatch (baixa relevância) para o StepSemanticValidator (slow path).
function makeMismatchProviderFactory() {
    return {
        chatWithFallback: async () => ({ status: 'success', content: JSON.stringify({ achieved: true, summary: 'teste S115' }) }),
        getProvider: () => undefined,
        getProviderWithModel: () => ({
            chat: async () => ({ status: 'success', content: JSON.stringify({ result: 'mismatch', confidence: 0.95, reason: 'teste S115 — output não endereça a intenção do step' }) }),
        }),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
}

function makeLoop(providerFactory: import('../../core/ProviderFactory').ProviderFactory, agentLoopResponse?: string) {
    const db = new (Database as any)(':memory:');
    const goalStore = new GoalStore(db);
    const fakeMemory = { getDatabase: () => db } as any;
    const fakePlanner = { getAvailableSkills: () => [], setSkillContext: () => {}, setModel: () => {}, replan: async () => ({ steps: [], strategy: 'n/a' }) } as any;
    const fakeAgentLoop = { process: async () => agentLoopResponse ?? '' } as any;
    const loop = new GoalExecutionLoop(
        fakeAgentLoop, goalStore, fakePlanner,
        { record: () => {}, findToolFailures: () => '', findHardConstraints: () => [] } as any,
        ToolRegistry, providerFactory, fakeMemory,
        { findApplicableCasesShadow: async () => [], backfillMissingEmbeddings: async () => {}, captureIfEligible: () => {}, findSimilarShadow: () => [] } as any,
    );
    return { loop, goalStore };
}

function makeGoal(store: GoalStore, overrides: Partial<Goal> & { currentPlan: PlanStep[] }): Goal {
    return store.create({
        sessionKey: 'test:s115', conversationId: 'test-conv-s115',
        userIntent: 'objetivo de teste S115', objective: 'Objetivo de teste S115',
        status: 'executing', attempts: [], blockers: [], toolsTried: [], strategiesTried: [],
        successCriteria: [], sentArtifacts: [], retryBudget: 3, replanBudget: 5, confidence: 0.9,
        requiresAuth: false, authorizationScope: [], expiresAt: Date.now() + 3_600_000,
        ...overrides,
    } as Omit<Goal, 'id' | 'createdAt' | 'updatedAt'>);
}

const channelContext: ChannelContext = { channel: 'test', chatId: 'test-user' };

async function main() {
    console.log('\n=== S115.1 — step COM toolName: mismatch escala direto pra "blocked", tool chamada 1x só ===');
    {
        let callCount = 0;
        const TOOL = '__s115_toolbound_mismatch__';
        ToolRegistry.register({
            name: TOOL,
            description: 'test',
            parameters: {},
            // Sem overlap de termos-chave com a description do step, força o fast path do
            // StepSemanticValidator a ser inconclusivo e escalar pro LLM mockado (sempre mismatch).
            execute: async () => { callCount++; return { success: true, output: 'Saída fixa e sempre igual, não relacionada ao pedido.' }; },
        });
        const { loop, goalStore } = makeLoop(makeMismatchProviderFactory());
        const goal = makeGoal(goalStore, {
            currentPlan: [{ id: 'tb1', description: 'Coletar hostname, sistema operacional e uptime do host remoto', toolName: TOOL, toolArgs: { command: 'echo fixo' }, status: 'pending', fallbackSteps: [] }],
            retryBudget: 3,
        });
        const state = emptyState(goal.id) as any;
        await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, state);

        assert(callCount === 1, `tool com toolName fixo é invocada exatamente 1x (ANTES da correção: 2x — retry reusava os mesmos toolArgs e reproduzia o mesmo mismatch) — obtido: ${callCount}`, callCount);

        const finalGoal = goalStore.getById(goal.id)!;
        const attemptsForStep = finalGoal.attempts.filter(a => a.planStepId === 'tb1');
        assert(attemptsForStep.length === 1, `exatamente 1 attempt gravado para o step (ANTES: 2, um por retry inútil) — obtido: ${attemptsForStep.length}`, attemptsForStep);

        const blocker = [...finalGoal.blockers].reverse().find(b => b.kind === 'semantic_mismatch');
        assert(
            !!blocker && /sem chance de retry ajudar/.test(blocker.description),
            'blocker de semantic_mismatch documenta que o retry não teria ajudado (ferramenta fixa)',
            blocker
        );
    }

    console.log('\n=== S115.2 — step SEM toolName (agentloop): comportamento de retry com hint preservado ===');
    {
        let callCount = 0;
        // >=200 chars, sem termos da description e sem sinal explícito de sucesso/falha —
        // mesmo filler usado em S85 (fallback 'substantial_response', confidence=0.70, sucesso
        // heurístico) — necessário para que o step chegue a 'success' e ative a validação
        // semântica, em vez de escalar para o mecanismo de avaliação de sucesso do agentloop
        // (evaluateAgentStepSuccess), que é um caminho distinto do StepSemanticValidator.
        const FILLER = 'dados registrados no sistema para análise posterior, aguardando revisão da equipe responsável pelo acompanhamento do cronograma estabelecido pela coordenação técnica envolvida. ';
        const agentloopResponse = FILLER + FILLER;
        const fakeAgentLoop = { process: async () => { callCount++; return agentloopResponse; } };
        const db = new (Database as any)(':memory:');
        const goalStore = new GoalStore(db);
        const fakeMemory = { getDatabase: () => db } as any;
        const fakePlanner = { getAvailableSkills: () => [], setSkillContext: () => {}, setModel: () => {}, replan: async () => ({ steps: [], strategy: 'n/a' }) } as any;
        const loop = new GoalExecutionLoop(
            fakeAgentLoop as any, goalStore, fakePlanner,
            { record: () => {}, findToolFailures: () => '', findHardConstraints: () => [] } as any,
            ToolRegistry, makeMismatchProviderFactory(), fakeMemory,
            { findApplicableCasesShadow: async () => [], backfillMissingEmbeddings: async () => {}, captureIfEligible: () => {}, findSimilarShadow: () => [] } as any,
        );
        const goal = makeGoal(goalStore, {
            currentPlan: [{ id: 'al1', description: 'Gerar relatório detalhado sobre determinado assunto raro', status: 'pending', fallbackSteps: [] }],
            retryBudget: 3,
        });
        const state = emptyState(goal.id) as any;
        await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, state);

        assert(callCount === 2, `step sem toolName (agentloop) continua tendo direito a 1 retry com hint (2 chamadas ao todo) — obtido: ${callCount}`, callCount);
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S115 RESULTADO: ${passed} passou | ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
