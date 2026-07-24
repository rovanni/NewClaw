/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S85 (Sprint 0.8, achados L10/L11/L14/L15 do ledger)
 *
 * Prova que `GoalExecutionLoop.executeStep()` (caminho 'agentloop', sem toolName) grava
 * `GoalAttempt.result: 'success'` mesmo quando a determinação de sucesso NÃO veio de um sinal
 * confiável — só da heurística conservadora "resposta longa/ambígua sem sinal claro, assume
 * progresso" (`substantial_response`, confidence=0.70). O sinal de baixa confiança já é
 * computado e gravado em `attempt.evaluation.confidence`, mas nunca chega a influenciar
 * `attempt.result` — um consumidor que só olha `result` (ex: `checkClaimsAgainstEvidence`,
 * `validateGoalCompletion`) trata esses casos como prova confirmada de conclusão, igual a um
 * sucesso de alta confiança.
 *
 * Também prova os 2 achados irmãos:
 * - Downgrade (S85.5): quando `StepSemanticValidator` detecta (depois do attempt persistido)
 *   que o output não endereça a intenção do step (`shouldDowngradeToPartial`), o `GoalAttempt`
 *   já gravado é corrigido para 'partial' — não só `ReflectionMemory.record()`.
 * - Promoção (S85.3/S85.4, ARCH-013 — S21/reabertura, 2026-07-18): a contraparte positiva.
 *   `escalateStepEvalToLLM` (2ª chamada de LLM, disparada só na zona 15-200 chars) foi removida
 *   — `StepSemanticValidator` (que já rodava incondicionalmente para todo step 'success', com
 *   um propósito correlato: "o output endereça a intenção?") passa a ser a ÚNICA fonte de
 *   confirmação de confiança para o caso não-confiante, via `shouldPromoteToConfidentSuccess`
 *   → `GoalStore.promoteLastAttemptToSuccess()`. Efeito colateral desejado, não escondido: um
 *   `substantial_response` de >=200 chars (que antes NUNCA podia ser promovido, só a zona
 *   ambígua 15-200 tinha esse direito via escalação) agora tem a mesma chance — as duas zonas
 *   representavam a mesma incerteza e foram fundidas em `evaluateAgentStepSuccess()`.
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
// 'relevant' (confidence >= 0.72) — usado nos cenários que testam PROMOÇÃO. Os cenários que
// testam "sem relevância" usam texto SEM overlap (`FILLER` puro), de propósito.
const SHARED_TERMS = 'relatório processar';

// Sinal de sucesso explícito, alta confiança (evaluateAgentStepSuccess: successPattern).
const TEXT_EXPLICIT_SUCCESS = `${SHARED_TERMS} — enviado com sucesso, tarefa concluída.`;

// >=200 chars, sem sinal de falha/sucesso, SEM overlap de termos-chave com a description padrão
// do step (`agentloopStep()`, que usa SHARED_TERMS) — cai no fallback conservador "resposta
// longa/ambígua sem sinal claro" (substantial_response, confidence=0.70) e StepSemanticValidator
// não encontra relevância suficiente para promover.
const FILLER = 'dados registrados no sistema para análise posterior, aguardando revisão da equipe responsável pelo acompanhamento do cronograma estabelecido pela coordenação técnica envolvida. ';
const TEXT_LONG_NO_OVERLAP = `${FILLER}${FILLER}`;
if (TEXT_LONG_NO_OVERLAP.length < 200) throw new Error('TEXT_LONG_NO_OVERLAP curto demais para o cenário S85.2/S85.4 — ajuste o filler');

// Mesmo texto longo/sem sinal claro, mas COM overlap de termos-chave (prefixo SHARED_TERMS) —
// StepSemanticValidator confirma 'relevant' com confidence >= FAST_PATH_CONFIDENCE_THRESHOLD
// (0.72) só pelo fast path, sem nenhuma chamada de LLM.
const TEXT_LONG_RELEVANT = `${SHARED_TERMS} — ${FILLER}${FILLER}`;
if (TEXT_LONG_RELEVANT.length < 200) throw new Error('TEXT_LONG_RELEVANT curto demais para o cenário S85.3 — ajuste o filler');

function makeFakeProviderFactory() {
    return {
        chatWithFallback: async () => ({ status: 'success', content: JSON.stringify({ achieved: true, summary: 'teste S85' }) } as any),
        getProvider: () => undefined,
        // ARCH-013: não existe mais uma 2ª chamada de LLM dedicada a "sucesso ou falha" — só o
        // fast path do StepSemanticValidator entra em jogo nos cenários que usam esta factory
        // (SHARED_TERMS/TEXT_EXPLICIT_SUCCESS sempre batem o hitRate mínimo), então este mock
        // nunca deveria ser invocado; resposta genérica aqui é só para não quebrar se for.
        getProviderWithModel: () => ({ chat: async () => ({ status: 'success', content: '{}' }) }),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
}

/** Simula erro/timeout do LLM de StepSemanticValidator (slow path) — fail-safe conservador. */
function makeSemanticValidatorErrorProviderFactory() {
    return {
        chatWithFallback: async () => ({ status: 'success', content: JSON.stringify({ achieved: true, summary: 'teste S85' }) }),
        getProvider: () => undefined,
        getProviderWithModel: () => ({ chat: async () => { throw new Error('timeout simulado do validador semântico'); } }),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
}

/** LLM do StepSemanticValidator (slow path) confirma relevância genuína, alta confiança. */
function makeSemanticValidatorRelevantProviderFactory() {
    return {
        chatWithFallback: async () => ({ status: 'success', content: JSON.stringify({ achieved: true, summary: 'teste S85' }) }),
        getProvider: () => undefined,
        getProviderWithModel: () => ({
            chat: async () => ({ status: 'success', content: JSON.stringify({ result: 'relevant', confidence: 0.85, reason: 'teste S85 — LLM confirma relevância genuína' }) }),
        }),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
}

/** Conta chamadas ao LLM do StepSemanticValidator — usado para provar 0 chamadas via fast path. */
function makeCountingProviderFactory(counter: { calls: number }) {
    return {
        chatWithFallback: async () => ({ status: 'success', content: JSON.stringify({ achieved: true, summary: 'teste S85' }) }),
        getProvider: () => undefined,
        getProviderWithModel: () => ({
            chat: async () => {
                counter.calls++;
                return { status: 'success', content: JSON.stringify({ result: 'relevant', confidence: 0.85 }) };
            },
        }),
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
        { record: () => {}, findToolFailures: () => '', findHardConstraints: () => [] } as any,
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
        const { loop, goalStore } = makeLoop(makeFakeProviderFactory(), TEXT_EXPLICIT_SUCCESS);
        const goal = makeGoal(goalStore, { currentPlan: [agentloopStep('a1')] });
        const state = emptyState(goal.id) as any;
        await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, state);
        const attempt = findAttempt(goalStore.getById(goal.id)!, 'a1');
        assert(attempt?.result === 'success', `attempt.result === 'success' (sinal explícito, alta confiança) — obtido: ${attempt?.result}`, attempt);
    }

    console.log('\n=== S85.2 — fallback sem relevância semântica + LLM do validador falha: result="partial" (fail-safe conservador) ===');
    {
        const { loop, goalStore } = makeLoop(makeSemanticValidatorErrorProviderFactory(), TEXT_LONG_NO_OVERLAP);
        const goal = makeGoal(goalStore, { currentPlan: [agentloopStep('b1')] });
        const state = emptyState(goal.id) as any;
        await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, state);
        const attempt = findAttempt(goalStore.getById(goal.id)!, 'b1');
        assert(
            attempt?.result === 'partial',
            `attempt.result === 'partial' (fallback 'substantial_response' + StepSemanticValidator sem relevância/erro de LLM — nenhuma promoção) — obtido: ${attempt?.result}`,
            attempt
        );
    }

    console.log('\n=== S85.3 — ARCH-013: fallback COM relevância (fast path): promove pra "success" SEM chamar LLM (0 chamadas) ===');
    {
        const counter = { calls: 0 };
        const { loop, goalStore } = makeLoop(makeCountingProviderFactory(counter), TEXT_LONG_RELEVANT);
        const goal = makeGoal(goalStore, { currentPlan: [agentloopStep('c1')] });
        const state = emptyState(goal.id) as any;
        await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, state);
        const attempt = findAttempt(goalStore.getById(goal.id)!, 'c1');
        assert(
            attempt?.result === 'success',
            `attempt.result === 'success' (StepSemanticValidator promoveu via fast path — substitui a antiga escalação de LLM) — obtido: ${attempt?.result}`,
            attempt
        );
        assert(
            counter.calls === 0,
            `0 chamadas de LLM ao modelo do validador semântico (fast path por keyword-overlap decidiu sozinho — prova a redução de latência/custo do ARCH-013) — obtido: ${counter.calls}`,
            counter
        );
    }

    console.log('\n=== S85.4 — ARCH-013: fallback sem overlap, mas LLM do validador confirma relevância (slow path): promove pra "success" ===');
    {
        const { loop, goalStore } = makeLoop(makeSemanticValidatorRelevantProviderFactory(), TEXT_LONG_NO_OVERLAP);
        const goal = makeGoal(goalStore, { currentPlan: [agentloopStep('d1')] });
        const state = emptyState(goal.id) as any;
        await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, state);
        const attempt = findAttempt(goalStore.getById(goal.id)!, 'd1');
        assert(
            attempt?.result === 'success',
            `attempt.result === 'success' (StepSemanticValidator promoveu via slow path — LLM confirmou relevância genuína) — obtido: ${attempt?.result}`,
            attempt
        );
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
        const { loop } = makeLoop(makeFakeProviderFactory());
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
