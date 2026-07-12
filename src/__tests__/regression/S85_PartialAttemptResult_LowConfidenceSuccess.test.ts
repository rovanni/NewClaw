/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S85 (Sprint 0.8, achados L10/L11/L14/L15 do ledger)
 *
 * Prova que `GoalExecutionLoop.executeStep()` (caminho 'agentloop', sem toolName) grava
 * `GoalAttempt.result: 'success'` mesmo quando a determinação de sucesso NÃO veio de um sinal
 * confiável — só da heurística conservadora "resposta longa sem sinal de falha, assume
 * sucesso" (`substantial_response`, confidence=0.70) ou do fail-safe de `escalateStepEvalToLLM`
 * (que assume `success=true` quando a chamada ao LLM falha/expira). Em ambos os casos o sinal
 * de baixa confiança já é computado e gravado em `attempt.evaluation.confidence`, mas nunca
 * chega a influenciar `attempt.result` — um consumidor que só olha `result` (ex:
 * `checkClaimsAgainstEvidence`, `validateGoalCompletion`) trata esses casos como prova
 * confirmada de conclusão, igual a um sucesso de alta confiança.
 *
 * Também prova o achado irmão: quando `StepSemanticValidator` já detectou (depois do
 * attempt persistido) que o output não endereça a intenção do step
 * (`shouldDowngradeToPartial`), o `GoalAttempt` já gravado continua com `result: 'success'` —
 * só `ReflectionMemory.record({outcome:'partial', ...})` refletia isso, nunca o attempt real.
 *
 * Evidência de suporte já existente no código (não introduzida por este teste):
 * `GoalEvaluator.ts` já trata `'partial'` como valor vivo equivalente a `'success'` para
 * evidência de progresso (`hasPositive = recent.some(a => a.result === 'success' || a.result
 * === 'partial')`) — tornar `'partial'` um valor real gravado é consistente com essa intenção
 * pré-existente, não uma mudança estranha ao design.
 *
 * Execução: npx ts-node src/__tests__/regression/S85_PartialAttemptResult_LowConfidenceSuccess.test.ts
 */

import Database from 'better-sqlite3';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';
import { GoalStore } from '../../loop/GoalStore';
import { ToolRegistry } from '../../core/ToolRegistry';
import { Goal, PlanStep, GoalAttempt } from '../../loop/GoalTypes';
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

// Palavras-chave deliberadamente compartilhadas entre step.description e o texto de resposta
// do agentloop, para que StepSemanticValidator (fast path, sem LLM) sempre classifique como
// 'relevant' (confidence >= 0.72) nos cenários a-d — o que está sob teste ali é o resultado do
// attempt, não a validação semântica (isolada no cenário S85.5).
const SHARED_TERMS = 'relatório processar';

// Sinal de sucesso explícito, alta confiança (evaluateAgentStepSuccess: successPattern) — não
// deve escalar para LLM.
const TEXT_EXPLICIT_SUCCESS = `${SHARED_TERMS} — enviado com sucesso, tarefa concluída.`;

// >=200 chars, sem sinal de falha/sucesso — cai no fallback conservador "resposta longa,
// assume sucesso" (substantial_response, confidence=0.70), sem escalar para LLM.
const FILLER = 'dados registrados no sistema para análise posterior, aguardando revisão da equipe responsável pelo acompanhamento do cronograma estabelecido pela coordenação técnica envolvida. ';
const TEXT_LONG_FALLBACK = `${SHARED_TERMS} — ${FILLER}${FILLER}`;
if (TEXT_LONG_FALLBACK.length < 200) throw new Error('TEXT_LONG_FALLBACK curto demais para o cenário S85.2 — ajuste o filler');

// 15-200 chars, sem sinal de falha/sucesso — zona ambígua, dispara escalation para LLM.
const TEXT_AMBIGUOUS = `${SHARED_TERMS} — ${FILLER}`.slice(0, 140);
if (!(TEXT_AMBIGUOUS.trim().length >= 15 && TEXT_AMBIGUOUS.trim().length < 200)) {
    throw new Error('TEXT_AMBIGUOUS fora da faixa 15-200 esperada pelo cenário S85.3/S85.4 — ajuste o slice');
}

function makeFakeProviderFactory(escalation: 'fail' | { success: boolean }) {
    const chatWithFallback = async (messages: Array<{ role: string; content: string }>) => {
        const isEscalationPrompt = messages[0]?.content.includes('SUCESSO ou FALHA');
        if (isEscalationPrompt) {
            if (escalation === 'fail') {
                return { status: 'error', content: '' } as any;
            }
            return { status: 'success', content: JSON.stringify({ success: escalation.success }) } as any;
        }
        // Validação de conclusão do goal (achieved/summary) — sempre confirma, não é o foco deste teste.
        return { status: 'success', content: JSON.stringify({ achieved: true, summary: 'teste S85' }) } as any;
    };
    return {
        chatWithFallback,
        getProvider: () => undefined,
        getProviderWithModel: () => ({ chat: async () => ({ status: 'success', content: '{}' }) }),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
}

function makeMismatchProviderFactory() {
    return {
        chatWithFallback: async () => ({ status: 'success', content: JSON.stringify({ achieved: true, summary: 'teste S85' }) }),
        getProvider: () => undefined,
        // Usado só pelo StepSemanticValidator (slow path) no cenário S85.5.
        getProviderWithModel: () => ({
            chat: async () => ({ status: 'success', content: JSON.stringify({ result: 'mismatch', confidence: 0.9, reason: 'teste S85 — output não endereça a intenção do step' }) }),
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
        { record: () => {}, buildContextHint: () => '', findHardConstraints: () => [] } as any,
        ToolRegistry, providerFactory, fakeMemory,
        { findApplicableCasesShadow: async () => [], backfillMissingEmbeddings: async () => {}, captureIfEligible: () => {}, findSimilarShadow: () => [] } as any,
    );
    return { loop, goalStore };
}

function makeGoal(store: GoalStore, overrides: Partial<Goal> & { currentPlan: PlanStep[] }): Goal {
    return store.create({
        sessionKey: 'test:s85', conversationId: 'test-conv-s85',
        userIntent: 'objetivo de teste S85', objective: 'Objetivo de teste S85',
        status: 'executing', attempts: [], blockers: [], toolsTried: [], strategiesTried: [],
        successCriteria: [], sentArtifacts: [], retryBudget: 3, replanBudget: 5, confidence: 0.9,
        requiresAuth: false, authorizationScope: [], expiresAt: Date.now() + 3_600_000,
        ...overrides,
    } as Omit<Goal, 'id' | 'createdAt' | 'updatedAt'>);
}

function agentloopStep(id: string, description = `Gerar ${SHARED_TERMS} de teste`): PlanStep {
    return { id, description, status: 'pending', fallbackSteps: [] };
}

const channelContext: ChannelContext = { channel: 'test', chatId: 'test-user' };

function findAttempt(goal: Goal, planStepId: string): GoalAttempt | undefined {
    return [...goal.attempts].reverse().find(a => a.planStepId === planStepId);
}

async function main() {
    console.log('\n=== S85.1 — sinal de sucesso explícito: result="success" ===');
    {
        const { loop, goalStore } = makeLoop(makeFakeProviderFactory({ success: true }), TEXT_EXPLICIT_SUCCESS);
        const goal = makeGoal(goalStore, { currentPlan: [agentloopStep('a1')] });
        const state = emptyState(goal.id) as any;
        await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, state);
        const attempt = findAttempt(goalStore.getById(goal.id)!, 'a1');
        assert(attempt?.result === 'success', `attempt.result === 'success' (sinal explícito, alta confiança) — obtido: ${attempt?.result}`, attempt);
    }

    console.log('\n=== S85.2 — fallback "resposta longa": result="partial" (não "success") ===');
    {
        const { loop, goalStore } = makeLoop(makeFakeProviderFactory({ success: true }), TEXT_LONG_FALLBACK);
        const goal = makeGoal(goalStore, { currentPlan: [agentloopStep('b1')] });
        const state = emptyState(goal.id) as any;
        await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, state);
        const attempt = findAttempt(goalStore.getById(goal.id)!, 'b1');
        assert(
            attempt?.result === 'partial',
            `attempt.result === 'partial' (ANTES da correção: 'success' — só o fallback conservador 'substantial_response' decidiu, sem confirmação) — obtido: ${attempt?.result}`,
            attempt
        );
    }

    console.log('\n=== S85.3 — escalation LLM fail-safe (erro/timeout): result="partial" ===');
    {
        const { loop, goalStore } = makeLoop(makeFakeProviderFactory('fail'), TEXT_AMBIGUOUS);
        const goal = makeGoal(goalStore, { currentPlan: [agentloopStep('c1')] });
        const state = emptyState(goal.id) as any;
        await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, state);
        const attempt = findAttempt(goalStore.getById(goal.id)!, 'c1');
        assert(
            attempt?.result === 'partial',
            `attempt.result === 'partial' (ANTES da correção: 'success' — fail-safe conservador do escalonamento assumiu sucesso sem confirmação real) — obtido: ${attempt?.result}`,
            attempt
        );
    }

    console.log('\n=== S85.4 — escalation LLM confirma genuinamente: result="success" ===');
    {
        const { loop, goalStore } = makeLoop(makeFakeProviderFactory({ success: true }), TEXT_AMBIGUOUS);
        const goal = makeGoal(goalStore, { currentPlan: [agentloopStep('d1')] });
        const state = emptyState(goal.id) as any;
        await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, state);
        const attempt = findAttempt(goalStore.getById(goal.id)!, 'd1');
        assert(attempt?.result === 'success', `attempt.result === 'success' (LLM de escalonamento confirmou genuinamente) — obtido: ${attempt?.result}`, attempt);
    }

    console.log('\n=== S85.5 — downgrade semântico (shouldDowngradeToPartial): attempt já persistido corrigido para "partial" ===');
    {
        const TOOL = '__s85_mismatch_tool__';
        ToolRegistry.register({
            name: TOOL,
            description: 'test',
            parameters: {},
            // Sem overlap de termos-chave com a description do step (força o fast path do
            // StepSemanticValidator a ser inconclusivo e escalar para o LLM mockado abaixo).
            execute: async () => ({ success: true, output: 'Operação finalizada normalmente.' }),
        });
        const { loop, goalStore } = makeLoop(makeMismatchProviderFactory());
        const goal = makeGoal(goalStore, {
            currentPlan: [{ id: 'e1', description: 'Buscar cotação específica de determinada criptomoeda rara', toolName: TOOL, toolArgs: {}, status: 'pending', fallbackSteps: [] }],
            retryBudget: 0,
        });
        const state = emptyState(goal.id) as any;
        await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, state);
        const attempt = findAttempt(goalStore.getById(goal.id)!, 'e1');
        assert(
            attempt?.result === 'partial',
            `attempt.result === 'partial' (ANTES da correção: 'success' — o attempt já persistido nunca é corrigido quando o mismatch semântico é detectado DEPOIS, só a ReflectionMemory refletia isso) — obtido: ${attempt?.result}`,
            attempt
        );
    }

    console.log('\n=== S85.6 — resolveStepRefs continua resolvendo {{step_N.output}} de um attempt "partial" ===');
    {
        const { loop } = makeLoop(makeFakeProviderFactory({ success: true }));
        const goal: Goal = {
            id: 'goal_s85_refs', sessionKey: 'test:s85', conversationId: 'test-conv-s85',
            userIntent: 'teste', objective: 'teste', status: 'executing',
            attempts: [{
                id: 'att_partial_1', planStepId: 'step_1', toolName: 'agentloop', args: {},
                result: 'partial', output: 'conteúdo produzido pelo step anterior (baixa confiança)',
                durationMs: 1, executedAt: Date.now(), cycle: 1,
            }],
            blockers: [], toolsTried: [], strategiesTried: [], successCriteria: [], sentArtifacts: [],
            currentPlan: [], retryBudget: 3, replanBudget: 5, confidence: 0.9,
            requiresAuth: false, authorizationScope: [], expiresAt: Date.now() + 3_600_000,
            createdAt: Date.now(), updatedAt: Date.now(),
        } as Goal;
        const resolved = (loop as any).resolveStepRefs({ content: '{{step_1.output}}' }, goal);
        assert(
            resolved.content === 'conteúdo produzido pelo step anterior (baixa confiança)',
            `resolveStepRefs resolve {{step_1.output}} mesmo vindo de um attempt 'partial' (ANTES da correção: só aceitava 'success', placeholder ficaria literal) — obtido: "${resolved.content}"`,
            resolved
        );
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S85 RESULTADO: ${passed} passou | ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
