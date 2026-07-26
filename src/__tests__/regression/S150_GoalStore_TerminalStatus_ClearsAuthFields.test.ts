/// <reference types="node" />
/**
 * S150 — setStatus()/expireStale() limpam pendingTxnId/requiresAuth ao entrar em estado terminal.
 *
 * Contexto: Sprint 0.11 já corrigiu resumeGoal() e abortGoalFromAuth() para limpar
 * pending_txn_id/requires_auth juntos (achado do Laboratório Cognitivo, newclaw-cortex/C1.5).
 * Mas esses são só 2 dos muitos caminhos que levam um goal a estado terminal: 'blocked' permite
 * transição direta para 'failed'/'abandoned' (GoalStore.ts ALLOWED_TRANSITIONS) através de 14
 * call sites de setStatus() (GoalExecutionLoop.ts/GoalOrchestrator.ts) e da varredura de TTL
 * (expireStale()) — nenhum deles passava por resumeGoal()/abortGoalFromAuth(). Um goal 'blocked'
 * com pendingTxnId+requiresAuth=true virava 'failed'/'abandoned' por qualquer um desses caminhos
 * e ficava com os dois campos travados para sempre num goal que já não pode mais transicionar.
 *
 * Este teste comprova: (1) qualquer entrada em estado terminal via setStatus() limpa os dois
 * campos; (2) transições não-terminais NÃO tocam os campos (comportamento preservado);
 * (3) expireStale() também limpa; (4) a validação de transição inválida continua bloqueando como
 * antes (invariante preservado).
 */
import Database from 'better-sqlite3';
import { GoalStore } from '../../loop/GoalStore';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${msg}`, detail ?? ''); failed++; }
}

function makeStore(): GoalStore {
    const db = new Database(':memory:');
    return new GoalStore(db as any);
}

function createBlockedGoalWithAuth(store: GoalStore, id: string, expiresAt = Date.now() + 60_000) {
    const goal = store.create({
        sessionKey: `sess-${id}`,
        conversationId: `conv-${id}`,
        userIntent: 'fazer algo perigoso',
        objective: 'fazer algo perigoso',
        status: 'active',
        currentPlan: [],
        attempts: [],
        blockers: [],
        toolsTried: [],
        strategiesTried: [],
        nextAction: null,
        cycleFocus: null,
        retryBudget: 5,
        replanBudget: 3,
        confidence: 0.85,
        requiresAuth: false,
        authorizationScope: [],
        pendingTxnId: null,
        expiresAt,
        completedAt: null,
        isConstruction: false,
        roadmap: [],
        currentMilestoneIndex: 0,
        allowRoadmapAdjustment: true,
        successCriteria: [],
        sentArtifacts: [],
    } as any);
    // active → executing → blocked: mesma cadeia real do Runtime (todo goal passa por
    // 'executing' antes de 'blocked' — active→blocked direto não é uma transição permitida).
    store.setStatus(goal.id, 'executing');
    // Simula o branch 'needs_auth' (GoalExecutionLoop.ts): blocked + pendingTxnId + requiresAuth=true.
    store.update(goal.id, { status: 'blocked', pendingTxnId: 'txn-abc123', requiresAuth: true });
    return goal.id;
}

async function main(): Promise<void> {
    console.log('\n=== S150-1 — setStatus() para estado terminal limpa pendingTxnId/requiresAuth ===');
    for (const terminal of ['failed', 'abandoned'] as const) {
        const store = makeStore();
        const goalId = createBlockedGoalWithAuth(store, `term-${terminal}`);
        const before = store.getById(goalId)!;
        assert(before.status === 'blocked' && before.pendingTxnId === 'txn-abc123' && before.requiresAuth === true,
            `pré-condição: goal está blocked/pendingTxnId/requiresAuth=true antes de setStatus('${terminal}')`);

        store.setStatus(goalId, terminal);
        const after = store.getById(goalId)!;
        assert(after.status === terminal, `status virou '${terminal}'`);
        assert(after.pendingTxnId == null, `pendingTxnId limpo após virar '${terminal}'`, after.pendingTxnId);
        assert(after.requiresAuth === false, `requiresAuth limpo após virar '${terminal}'`, after.requiresAuth);
    }

    console.log('\n=== S150-2 — transição NÃO-terminal não toca pendingTxnId/requiresAuth (comportamento preservado) ===');
    {
        const store = makeStore();
        const goalId = createBlockedGoalWithAuth(store, 'nonterminal');
        store.setStatus(goalId, 'executing'); // blocked → executing é transição válida e não-terminal
        const after = store.getById(goalId)!;
        assert(after.status === 'executing', 'status virou executing');
        assert(after.pendingTxnId === 'txn-abc123', 'pendingTxnId preservado em transição não-terminal (setStatus não deve limpar aqui — quem limpa é resumeGoal() explicitamente)', after.pendingTxnId);
        assert(after.requiresAuth === true, 'requiresAuth preservado em transição não-terminal', after.requiresAuth);
    }

    console.log('\n=== S150-3 — expireStale() também limpa pendingTxnId/requiresAuth ===');
    {
        const store = makeStore();
        const goalId = createBlockedGoalWithAuth(store, 'expired', Date.now() - 1000); // já expirado
        const count = store.expireStale();
        assert(count === 1, 'expireStale() reporta 1 goal expirado', count);
        const after = store.getById(goalId)!;
        assert(after.status === 'abandoned', 'status virou abandoned via TTL');
        assert(after.pendingTxnId == null, 'pendingTxnId limpo via expireStale()', after.pendingTxnId);
        assert(after.requiresAuth === false, 'requiresAuth limpo via expireStale()', after.requiresAuth);
    }

    console.log('\n=== S150-4 — validação de transição inválida continua bloqueando (invariante preservado) ===');
    {
        const store = makeStore();
        const goalId = createBlockedGoalWithAuth(store, 'invalid-transition');
        store.setStatus(goalId, 'failed'); // agora terminal
        const beforeRetry = store.getById(goalId)!;
        store.setStatus(goalId, 'active'); // terminal → active não é permitido
        const after = store.getById(goalId)!;
        assert(after.status === beforeRetry.status, 'transição inválida a partir de estado terminal foi bloqueada (status não mudou)', after.status);
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(failed === 0 ? `✅ S150 passou (${passed} verificações)` : `❌ S150: ${failed} falha(s) de ${passed + failed}`);
    process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
    console.error('S150 erro inesperado:', err);
    process.exitCode = 1;
});
