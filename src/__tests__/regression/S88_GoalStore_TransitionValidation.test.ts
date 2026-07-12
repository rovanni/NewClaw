/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S88 (Sprint 0.10, achado L04 — GoalStore.update() sem validação de transição)
 *
 * Prova que `GoalStore.update()` agora valida `status` contra a mesma `ALLOWED_TRANSITIONS`
 * usada por `setStatus()` (antes, só `setStatus()` validava; `update()` gravava qualquer
 * `status` sem checagem — a maioria dos call sites reais em `GoalExecutionLoop`/
 * `GoalOrchestrator` usa `update()`, não `setStatus()`, então a validação existente nunca
 * disparava na prática).
 *
 * Também prova a correção do bug B descoberto durante a investigação: `update(id,
 * {pendingTxnId: undefined})` agora realmente limpa `pending_txn_id` no banco — ANTES, o guard
 * `patch.pendingTxnId !== undefined` nunca era verdadeiro para um valor literal `undefined`
 * passado no patch, então o campo nunca era limpo (usado por `resumeGoal()`/
 * `abortGoalFromAuth()` após processar uma autorização).
 *
 * E prova que os 2 pares de transição legítimos e recorrentes descobertos na auditoria empírica
 * desta Sprint (`active→replanning`, `replanning→blocked` — exercitados em todo goal real, mas
 * ausentes da tabela original) agora são aceitos, e que self-transições (`X→X`) nunca são
 * bloqueadas.
 *
 * Execução: npx ts-node src/__tests__/regression/S88_GoalStore_TransitionValidation.test.ts
 */

import Database from 'better-sqlite3';
import { GoalStore } from '../../loop/GoalStore';
import { Goal } from '../../loop/GoalTypes';

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
        sessionKey: 'test:s88', conversationId: 'test-conv-s88',
        userIntent: 'objetivo de teste S88', objective: 'Objetivo de teste S88',
        status: 'active', currentPlan: [], attempts: [], blockers: [], toolsTried: [], strategiesTried: [],
        successCriteria: [], sentArtifacts: [], retryBudget: 3, replanBudget: 5, confidence: 0.9,
        requiresAuth: false, authorizationScope: [], expiresAt: Date.now() + 3_600_000,
        ...overrides,
    } as Omit<Goal, 'id' | 'createdAt' | 'updatedAt'>);
}

async function main() {
    console.log('\n=== S88.1 — update() BLOQUEIA transição inválida (completed→executing), preserva o resto do patch ===');
    {
        const store = makeStore();
        const goal = makeGoal(store, { status: 'completed' });
        store.update(goal.id, { status: 'executing', nextAction: 'tentar de novo' });
        const stored = store.getById(goal.id)!;
        assert(
            stored.status === 'completed',
            `status permanece 'completed' (transição completed→executing rejeitada) — obtido: ${stored.status}`,
            stored
        );
        assert(
            stored.nextAction === 'tentar de novo',
            `demais campos do patch (nextAction) continuam aplicados mesmo com status rejeitado — obtido: ${stored.nextAction}`,
            stored
        );
    }

    console.log('\n=== S88.2 — update() ACEITA active→replanning (ANTES: rejeitava — bloqueava todo goal real) ===');
    {
        const store = makeStore();
        const goal = makeGoal(store, { status: 'active' });
        store.update(goal.id, { status: 'replanning' });
        const stored = store.getById(goal.id)!;
        assert(stored.status === 'replanning', `active→replanning aceito — obtido: ${stored.status}`, stored);
    }

    console.log('\n=== S88.3 — update() ACEITA replanning→blocked (ANTES: rejeitava — usado por addBlocker() após bonus replan) ===');
    {
        const store = makeStore();
        const goal = makeGoal(store, { status: 'active' });
        store.update(goal.id, { status: 'replanning' });
        store.update(goal.id, { status: 'blocked' });
        const stored = store.getById(goal.id)!;
        assert(stored.status === 'blocked', `replanning→blocked aceito — obtido: ${stored.status}`, stored);
    }

    console.log('\n=== S88.4 — update() ACEITA self-transição (executing→executing), nunca bloqueada ===');
    {
        const store = makeStore();
        const goal = makeGoal(store, { status: 'active' });
        store.update(goal.id, { status: 'executing' });
        store.update(goal.id, { status: 'executing', nextAction: 'continuar' });
        const stored = store.getById(goal.id)!;
        assert(stored.status === 'executing', 'self-transição executing→executing não é bloqueada', stored);
        assert(stored.nextAction === 'continuar', 'patch acompanhante aplicado normalmente na self-transição', stored);
    }

    console.log('\n=== S88.5 — update({pendingTxnId: undefined}) realmente limpa pending_txn_id (ANTES: nunca limpava — bug B) ===');
    {
        const store = makeStore();
        const goal = makeGoal(store, { status: 'blocked', pendingTxnId: 'txn_abc123' });
        assert(store.getById(goal.id)!.pendingTxnId === 'txn_abc123', 'pré-condição: pendingTxnId setado', goal);
        store.update(goal.id, { status: 'executing', pendingTxnId: undefined });
        const stored = store.getById(goal.id)!;
        assert(
            stored.pendingTxnId === undefined || stored.pendingTxnId === null,
            `pendingTxnId limpo após update com {pendingTxnId: undefined} (ANTES: permanecia 'txn_abc123') — obtido: ${stored.pendingTxnId}`,
            stored
        );
        assert(stored.status === 'executing', 'transição blocked→executing acompanhando a limpeza também foi aplicada', stored);
    }

    console.log('\n=== S88.6 — setStatus() continua validando (regressão — mesmo predicate compartilhado com update()) ===');
    {
        const store = makeStore();
        const goal = makeGoal(store, { status: 'completed' });
        store.setStatus(goal.id, 'executing');
        const stored = store.getById(goal.id)!;
        assert(stored.status === 'completed', 'setStatus() continua rejeitando completed→executing', stored);
    }

    console.log('\n=== S88.7 — update() sem campo status não é afetado pela validação (caminho comum, sem custo extra) ===');
    {
        const store = makeStore();
        const goal = makeGoal(store, { status: 'executing' });
        store.update(goal.id, { retryBudget: 2 });
        const stored = store.getById(goal.id)!;
        assert(stored.status === 'executing' && stored.retryBudget === 2, 'update() sem status aplica o patch normalmente', stored);
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S88 RESULTADO: ${passed} passou | ${failed} falhou`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
