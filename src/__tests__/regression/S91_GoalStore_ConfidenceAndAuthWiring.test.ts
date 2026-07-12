/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S91 (Sprint 0.11, achados do Laboratório Cognitivo — newclaw-cortex/C1.5)
 *
 * O Cortex (newclaw-cortex), rodando seu Observatory contra 442 goals reais de produção,
 * encontrou dois campos do schema `goals` que nunca variavam:
 *
 * 1. `confidence` tinha desvio padrão = 0 em 442/442 registros — sempre 0.85
 *    (GOAL_LIMITS.INITIAL_CONFIDENCE, gravado só em create()). Investigação confirmou: nenhum
 *    dos ~35 call sites de `update()`/`setStatus()` em GoalExecutionLoop/GoalOrchestrator jamais
 *    tocava este campo, apesar de `attempt.evaluation.confidence` ser um sinal de confiança real
 *    e já calculado por tentativa. Corrigido em `GoalStore.addAttempt()`: propaga
 *    `attempt.evaluation.confidence` para `goal.confidence` quando presente.
 *
 * 2. `requires_auth` era sempre 0, mesmo em goals com `pending_txn_id` presente (achado: 40/442
 *    goals com pendingTxnId e requires_auth=0). Investigação confirmou: `requiresAuth` era setado
 *    `false` em create() e NUNCA setado `true` em nenhum outro ponto do runtime — dead field.
 *    Corrigido: `requiresAuth: true` no branch 'needs_auth' de GoalExecutionLoop.executeStep()
 *    (o mesmo ponto que já grava `pendingTxnId`), e `requiresAuth: false` nos dois pontos que já
 *    limpam `pendingTxnId` (resumeGoal(), abortGoalFromAuth()).
 *
 * Execução: npx ts-node src/__tests__/regression/S91_GoalStore_ConfidenceAndAuthWiring.test.ts
 */

import Database from 'better-sqlite3';
import { GoalStore } from '../../loop/GoalStore';
import { Goal, GoalAttempt } from '../../loop/GoalTypes';

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
        sessionKey: 'test:s91', conversationId: 'test-conv-s91',
        userIntent: 'objetivo de teste S91', objective: 'Objetivo de teste S91',
        status: 'active', currentPlan: [], attempts: [], blockers: [], toolsTried: [], strategiesTried: [],
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
        result: 'success',
        durationMs: 10,
        executedAt: Date.now(),
        ...overrides,
    };
}

async function main() {
    console.log('\n=== S91.1 — addAttempt() propaga attempt.evaluation.confidence para goal.confidence ===');
    {
        const store = makeStore();
        const goal = makeGoal(store, { confidence: 0.85 });
        store.addAttempt(goal.id, makeAttempt({ evaluation: { confidence: 0.5, reason: 'ambiguous_output' } }));
        const stored = store.getById(goal.id)!;
        assert(stored.confidence === 0.5, 'confidence atualizado para o valor do evaluation', stored.confidence);
    }

    console.log('\n=== S91.2 — addAttempt() sem evaluation preserva confidence anterior (não força default) ===');
    {
        const store = makeStore();
        const goal = makeGoal(store, { confidence: 0.72 });
        store.addAttempt(goal.id, makeAttempt({ toolName: 'write', evaluation: undefined }));
        const stored = store.getById(goal.id)!;
        assert(stored.confidence === 0.72, 'confidence inalterado quando attempt não tem evaluation', stored.confidence);
    }

    console.log('\n=== S91.3 — addAttempt() sucessivos refletem a confiança da tentativa mais recente ===');
    {
        const store = makeStore();
        const goal = makeGoal(store, { confidence: 0.85 });
        store.addAttempt(goal.id, makeAttempt({ evaluation: { confidence: 0.9, reason: 'success_signal_detected' } }));
        store.addAttempt(goal.id, makeAttempt({ evaluation: { confidence: 0.5, reason: 'ambiguous_output' } }));
        const stored = store.getById(goal.id)!;
        assert(stored.confidence === 0.5, 'confidence reflete a última tentativa, não a primeira', stored.confidence);
        assert(stored.attempts.length === 2, 'ambos os attempts foram persistidos', stored.attempts.length);
    }

    console.log('\n=== S91.4 — update() com requiresAuth:true grava requires_auth=1 junto com pendingTxnId ===');
    {
        const store = makeStore();
        const goal = makeGoal(store, { status: 'executing' });
        store.update(goal.id, { status: 'blocked', pendingTxnId: 'txn-abc', requiresAuth: true });
        const stored = store.getById(goal.id)!;
        assert(stored.requiresAuth === true, 'requiresAuth=true persistido', stored.requiresAuth);
        assert(stored.pendingTxnId === 'txn-abc', 'pendingTxnId persistido junto', stored.pendingTxnId);
    }

    console.log('\n=== S91.5 — resume (status executing, pendingTxnId undefined) limpa requiresAuth ===');
    {
        const store = makeStore();
        const goal = makeGoal(store, { status: 'blocked', requiresAuth: true, pendingTxnId: 'txn-abc' });
        store.update(goal.id, { status: 'executing', pendingTxnId: undefined, requiresAuth: false });
        const stored = store.getById(goal.id)!;
        assert(stored.requiresAuth === false, 'requiresAuth voltou a false após resume', stored.requiresAuth);
        assert(stored.pendingTxnId === undefined, 'pendingTxnId limpo após resume', stored.pendingTxnId);
    }

    console.log('\n=== S91.6 — abort (status failed, pendingTxnId undefined) também limpa requiresAuth ===');
    {
        const store = makeStore();
        const goal = makeGoal(store, { status: 'blocked', requiresAuth: true, pendingTxnId: 'txn-xyz' });
        store.update(goal.id, { status: 'failed', pendingTxnId: undefined, requiresAuth: false });
        const stored = store.getById(goal.id)!;
        assert(stored.requiresAuth === false, 'requiresAuth voltou a false após abort', stored.requiresAuth);
        assert(stored.status === 'failed', 'status=failed persistido', stored.status);
    }

    console.log(`\n=== RESULTADO: ${passed} passou, ${failed} falhou ===`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
