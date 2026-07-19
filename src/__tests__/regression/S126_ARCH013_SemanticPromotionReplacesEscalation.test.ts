/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S126 (ARCH-013, Sprint S21/reabertura, 2026-07-18)
 *
 * ARCH-013 removeu `GoalExecutionLoop.escalateStepEvalToLLM()` — a 2ª chamada de LLM que rodava
 * incondicionalmente pra todo step 'agentloop' na zona ambígua (15-200 chars sem sinal claro),
 * decidindo isoladamente se o `GoalAttempt` deveria ser 'success' confiante ou 'partial'.
 *
 * `StepSemanticValidator` já rodava, de qualquer forma, para todo step com `outcome==='success'`
 * (pergunta correlata: "o output endereça a intenção do step?") — a correção consolida as duas
 * perguntas numa só chamada: `StepSemanticValidator.shouldPromoteToConfidentSuccess` (novo campo,
 * espelhando o `shouldDowngradeToPartial` já existente) e `GoalStore.promoteLastAttemptToSuccess()`
 * (novo método, espelhando `downgradeLastAttemptToPartial()`/`finalizeLastAttemptAsSuccess()` já
 * existentes — mesmo padrão read-modify-write sobre o attempt mais recente).
 *
 * Este teste cobre os dois novos métodos em nível unitário (sem subir `GoalExecutionLoop`/
 * `runLoopInternal` inteiro) — a cobertura de integração end-to-end (fast path, slow path,
 * fail-safe) já vive em `S85_PartialAttemptResult_LowConfidenceSuccess.test.ts` (85.2-85.4,
 * atualizados nesta mesma Sprint). O que este teste pina que S85 não pinava: o valor exato do
 * threshold de promoção (`PROMOTE_CONFIDENCE_THRESHOLD = FAST_PATH_CONFIDENCE_THRESHOLD = 0.72`,
 * deliberadamente mais baixo que `LLM_MISMATCH_CONFIDENCE_THRESHOLD` de 0.80 usado só para
 * downgrade — ver comentário em `StepSemanticValidator.ts`).
 *
 * Execução: npx ts-node src/__tests__/regression/S126_ARCH013_SemanticPromotionReplacesEscalation.test.ts
 */

import Database from 'better-sqlite3';
import { GoalStore } from '../../loop/GoalStore';
import { Goal, GoalAttempt } from '../../loop/GoalTypes';
import { StepSemanticValidator } from '../../loop/StepSemanticValidator';
import { PlanStep } from '../../loop/GoalTypes';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

function makeStore(): GoalStore {
    const db = new (Database as any)(':memory:');
    return new GoalStore(db);
}

function makeGoal(store: GoalStore, overrides: Partial<Goal> = {}): Goal {
    return store.create({
        sessionKey: 'test:s126', conversationId: 'test-conv-s126',
        userIntent: 'objetivo de teste S126', objective: 'Objetivo de teste S126',
        status: 'executing', currentPlan: [], attempts: [], blockers: [], toolsTried: [], strategiesTried: [],
        successCriteria: [], sentArtifacts: [], retryBudget: 3, replanBudget: 5, confidence: 0.85,
        requiresAuth: false, authorizationScope: [], expiresAt: Date.now() + 3_600_000,
        ...overrides,
    } as Omit<Goal, 'id' | 'createdAt' | 'updatedAt'>);
}

function makeAttempt(overrides: Partial<GoalAttempt> = {}): GoalAttempt {
    return {
        id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
        planStepId: 'step-1',
        toolName: 'agentloop',
        args: {},
        result: 'partial',
        durationMs: 10,
        executedAt: Date.now(),
        ...overrides,
    };
}

function makeProviderFactory(response: { result: string; confidence: number }) {
    return {
        getProviderWithModel: () => ({
            chat: async () => ({ status: 'success', content: JSON.stringify(response) }),
        }),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
}

const step: PlanStep = {
    id: 'step-1',
    description: 'Gerar relatório processar de teste',
    status: 'pending',
    fallbackSteps: [],
};

async function main() {
    console.log('\n=== S126.1 — GoalStore.promoteLastAttemptToSuccess() corrige "partial" → "success" ===');
    {
        const store = makeStore();
        const goal = makeGoal(store);
        store.addAttempt(goal.id, makeAttempt({ planStepId: 'step-1', result: 'partial', output: 'output original' }));
        store.promoteLastAttemptToSuccess(goal.id, 'step-1');
        const stored = store.getById(goal.id)!;
        const attempt = stored.attempts.find(a => a.planStepId === 'step-1');
        assert(attempt?.result === 'success', `result promovido para 'success' — obtido: ${attempt?.result}`, attempt);
        assert(attempt?.output === 'output original', `output preservado sem alteração (só o result muda) — obtido: ${attempt?.output}`, attempt);
    }

    console.log('\n=== S126.2 — promoteLastAttemptToSuccess() é no-op quando o attempt mais recente não é "partial" ===');
    {
        const store = makeStore();
        const goal = makeGoal(store);
        store.addAttempt(goal.id, makeAttempt({ planStepId: 'step-1', result: 'success', output: 'já confiante' }));
        store.promoteLastAttemptToSuccess(goal.id, 'step-1');
        const stored = store.getById(goal.id)!;
        const attempt = stored.attempts.find(a => a.planStepId === 'step-1');
        assert(attempt?.result === 'success', `attempt já 'success' permanece inalterado (predicate não casa) — obtido: ${attempt?.result}`, attempt);

        store.addAttempt(goal.id, makeAttempt({ planStepId: 'step-2', result: 'failure', output: '' }));
        store.promoteLastAttemptToSuccess(goal.id, 'step-2');
        const stored2 = store.getById(goal.id)!;
        const attempt2 = stored2.attempts.find(a => a.planStepId === 'step-2');
        assert(attempt2?.result === 'failure', `attempt 'failure' NÃO é promovido (só 'partial' é elegível) — obtido: ${attempt2?.result}`, attempt2);
    }

    console.log('\n=== S126.3 — StepSemanticValidator: fast path "relevant" com confidence >= 0.72 → shouldPromoteToConfidentSuccess=true ===');
    {
        // 3 de 4 termos-chave da description ("gerar","relatório","processar","teste") presentes
        // literalmente no output → hitRate=0.75 → confidence = min(0.95, 0.50+0.75*0.55) = 0.9125
        // >= 0.72 (PROMOTE_CONFIDENCE_THRESHOLD).
        const validator = new StepSemanticValidator(makeProviderFactory({ result: 'unverifiable', confidence: 0 }));
        const output = 'Relatório processar gerar registrado no sistema, dados novos disponíveis para revisão completa.';
        const result = await validator.validate(step, output, 'objetivo de teste');
        assert(result.usedFastPath === true, `resolvido pelo fast path (sem LLM) — obtido usedFastPath=${result.usedFastPath}`, result);
        assert(
            result.shouldPromoteToConfidentSuccess === true,
            `shouldPromoteToConfidentSuccess === true (confidence=${result.confidence.toFixed(2)} >= 0.72) — obtido: ${result.shouldPromoteToConfidentSuccess}`,
            result
        );
    }

    console.log('\n=== S126.4 — StepSemanticValidator: slow path LLM confirma "relevant" com confidence alta → promove ===');
    {
        // Sem overlap de termos-chave — fast path fica 'unverifiable' (confidence baixa), escala
        // pro LLM mockado abaixo, que confirma relevância genuína com confidence alta.
        const validator = new StepSemanticValidator(makeProviderFactory({ result: 'relevant', confidence: 0.9 }));
        const output = 'Conteúdo totalmente genérico sem nenhuma palavra em comum com a tarefa pedida originalmente.';
        const result = await validator.validate(step, output, 'objetivo de teste');
        assert(result.usedFastPath === false, `resolvido pelo slow path (LLM) — obtido usedFastPath=${result.usedFastPath}`, result);
        assert(
            result.shouldPromoteToConfidentSuccess === true,
            `shouldPromoteToConfidentSuccess === true via LLM (confidence=0.9 >= 0.72) — obtido: ${result.shouldPromoteToConfidentSuccess}`,
            result
        );
    }

    console.log('\n=== S126.5 — StepSemanticValidator: slow path LLM diz "relevant" mas com BAIXA confidence → NÃO promove (pina o threshold) ===');
    {
        const validator = new StepSemanticValidator(makeProviderFactory({ result: 'relevant', confidence: 0.5 }));
        const output = 'Conteúdo totalmente genérico sem nenhuma palavra em comum com a tarefa pedida originalmente.';
        const result = await validator.validate(step, output, 'objetivo de teste');
        assert(
            result.shouldPromoteToConfidentSuccess === false,
            `shouldPromoteToConfidentSuccess === false (confidence=0.5 < 0.72, mesmo com result='relevant') — obtido: ${result.shouldPromoteToConfidentSuccess}`,
            result
        );
    }

    console.log('\n=== S126.6 — StepSemanticValidator: "mismatch" nunca promove, mesmo com confidence alta ===');
    {
        const validator = new StepSemanticValidator(makeProviderFactory({ result: 'mismatch', confidence: 0.95 }));
        const output = 'Conteúdo totalmente genérico sem nenhuma palavra em comum com a tarefa pedida originalmente.';
        const result = await validator.validate(step, output, 'objetivo de teste');
        assert(result.shouldDowngradeToPartial === true, `shouldDowngradeToPartial === true (comportamento pré-existente, não regredido)`, result);
        assert(
            result.shouldPromoteToConfidentSuccess === false,
            `shouldPromoteToConfidentSuccess === false ('mismatch' nunca promove, mutuamente exclusivo com downgrade) — obtido: ${result.shouldPromoteToConfidentSuccess}`,
            result
        );
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S126 RESULTADO: ${passed} passou | ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
