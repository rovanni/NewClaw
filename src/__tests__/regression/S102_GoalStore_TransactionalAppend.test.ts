/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S102
 * 
 * Verifica que os métodos de leitura-modificação-escrita do GoalStore rodam
 * sob uma transação do SQLite (better-sqlite3) e revertem (rollback)
 * corretamente se ocorrer uma falha durante o processo.
 */

import Database from 'better-sqlite3';
import { GoalStore } from '../../loop/GoalStore';
import { Goal } from '../../loop/GoalTypes';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${msg}`, detail ?? ''); failed++; }
}

async function main() {
    console.log('\n=== S102 — Atomicidade e Transações no GoalStore ===');

    const db = new Database(':memory:');
    const goalStore = new GoalStore(db as any);

    const goal = goalStore.create({
        sessionKey: 'user-s102',
        conversationId: 'conv-s102',
        userIntent: 'Fazer bolo',
        objective: 'Comprar ingredientes e assar bolo',
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
        expiresAt: Date.now() + 10000,
        completedAt: null,
        isConstruction: false,
        roadmap: [],
        currentMilestoneIndex: 0,
        allowRoadmapAdjustment: true,
        successCriteria: [],
        sentArtifacts: []
    } as any);

    // Mock do update para falhar forçadamente
    const originalUpdate = goalStore.update;
    let updateAttemptsCount = 0;
    
    goalStore.update = (id: string, patch: Partial<Goal>) => {
        updateAttemptsCount++;
        // Faz a modificação real no banco antes de lançar o erro
        originalUpdate.call(goalStore, id, patch);
        throw new Error('Erro forçado após a escrita no banco (dentro da transação)');
    };

    let errorThrown: boolean = false;
    try {
        goalStore.addAttempt(goal.id, {
            id: 'attempt-1',
            planStepId: 'step-1',
            toolName: 'bake',
            result: 'success',
            durationMs: 120,
            args: {},
            executedAt: Date.now(),
            evaluation: {
                confidence: 0.9,
                reason: 'Funcionou'
            }
        });
    } catch (err) {
        errorThrown = true;
    }

    assert(errorThrown, 'O erro forçado no update subiu e interrompeu addAttempt');
    assert(updateAttemptsCount === 1, 'update() foi de fato chamado 1 vez');

    // Recupera o goal do banco de dados para checar se sofreu rollback
    const dbGoal = goalStore.getById(goal.id);
    assert(dbGoal !== null, 'Goal ainda existe no banco');
    if (dbGoal) {
        assert(dbGoal.attempts.length === 0, 'As tentativas não foram salvas (transação sofreu rollback)', dbGoal.attempts);
        assert(dbGoal.retryBudget === 5, 'retryBudget não foi decrementado (transação sofreu rollback)', dbGoal.retryBudget);
    }

    db.close();

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S102 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(err => {
    console.error('Erro no teste S102:', err);
    process.exit(1);
});
