/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S291 (issue 045, campanha "sistema não utilizável", 23/09/2026)
 *
 * Achado ao vivo: um deploy (`update.ps1 -Restart`) reiniciou o processo enquanto um goal
 * (geração de PDF) estava em `status='executing'`. Depois do restart, `GET /api/chat/active`
 * continuou reportando esse goal como ativo (`elapsedMs>1.000.000`, >16min) — o frontend
 * (`startTurnPolling`, index.html) ficou preso mostrando "Trabalhando no seu pedido..." pro
 * usuário, sem nenhuma saída possível, até o TTL de 30min expirar via `GoalStore.expireStale()`
 * — que só roda quando uma NOVA mensagem chega (`GoalOrchestrator.ts`), então na prática o
 * usuário ficava preso até enviar outra mensagem OU até 30min passarem, o que viesse depois.
 *
 * Causa raiz: `AgentController`'s construtor já tinha uma detecção de "ITEM6: goals em estado
 * não-terminal deixados por shutdown anterior" — mas o log dizia `recovered=false` de forma
 * LITERAL: nenhuma ação de fato acontecia, só o log. Diferente do TTL geral (que tolera um goal
 * genuinamente lento), aqui não há ambiguidade: o processo que poderia estar executando aquele
 * goal acabou de reiniciar — é IMPOSSÍVEL que ainda esteja em andamento.
 *
 * Fix: no boot, cada goal órfão (`GoalStore.getAllActive()`) é movido para `abandoned` via
 * `markAbandonReason()` + `setStatus()` — os dois métodos públicos que já existem, já usados pelo
 * mesmo padrão em `GoalOrchestrator.cancelActiveGoal()`. `abandoned` é alcançável a partir de
 * TODOS os 4 status não-terminais (`active`, `executing`, `blocked`, `replanning`).
 *
 * S291.1 — CASO POSITIVO: um goal órfão em cada um dos 4 status não-terminais é movido para
 *   `abandoned` pela rotina de boot; `getAllActive()` (a mesma query que alimenta
 *   `/api/chat/active`) não retorna mais nenhum deles depois.
 * S291.2 — o motivo do abandono é registrado e consumível (`consumeAbandonReason`) — não é uma
 *   transição silenciosa sem rastro.
 * S291.3 — CONTROLE NEGATIVO: um goal já `completed` (terminal, concluído normalmente antes do
 *   restart) não aparece em `getAllActive()` e não é tocado pela rotina — a correção não mexe em
 *   goals que já terminaram de verdade.
 * S291.4 — um goal `blocked` com autorização pendente (`pendingTxnId`/`requiresAuth`) tem esses
 *   dois campos limpos ao ser abandonado — garantia que `setStatus()` já dava para qualquer
 *   transição a estado terminal (Sprint 005), confirmada aqui para este caminho novo também.
 *
 * Execução: npx ts-node src/__tests__/regression/S291_GoalStore_OrphanedGoalsAbandonedOnBoot.test.ts
 */

import Database from 'better-sqlite3';
import { GoalStore } from '../../loop/GoalStore';
import { GoalStatus } from '../../loop/GoalTypes';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  OK ${msg}`); passed++; }
    else { console.error(`  FALHOU: ${msg}`, detail ?? ''); failed++; }
}

function baseGoalInput(status: GoalStatus, overrides: Record<string, unknown> = {}) {
    return {
        sessionKey: 'user-s291',
        conversationId: `conv-s291-${status}`,
        userIntent: 'Gerar um PDF',
        objective: 'Gerar um PDF curto com dicas',
        status,
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
        expiresAt: Date.now() + 1_800_000,
        completedAt: null,
        isConstruction: false,
        roadmap: [],
        currentMilestoneIndex: 0,
        allowRoadmapAdjustment: true,
        successCriteria: [],
        sentArtifacts: [],
        ...overrides,
    } as any;
}

/** Reproduz EXATAMENTE a rotina de boot adicionada em AgentController.ts (ITEM6/issue 045) —
 *  chama só a API pública de GoalStore, mesma sequência do fix real. */
function runBootRecovery(goalStore: GoalStore): { count: number; ids: string[] } {
    const orphaned = goalStore.getAllActive();
    for (const g of orphaned) {
        goalStore.markAbandonReason(g.id, 'Goal interrompido: processo reiniciado (deploy ou queda) antes da conclusão.');
        goalStore.setStatus(g.id, 'abandoned');
    }
    return { count: orphaned.length, ids: orphaned.map(g => g.id) };
}

async function main() {

console.log('\n=== S291.1 — CASO POSITIVO: goal órfão em cada status não-terminal vira abandoned no boot ===');
{
    const db = new Database(':memory:');
    const goalStore = new GoalStore(db as any);

    const statuses: GoalStatus[] = ['active', 'executing', 'blocked', 'replanning'];
    const created = statuses.map(s => goalStore.create(baseGoalInput(s)));

    assert(goalStore.getAllActive().length === 4, 'pré-condição: os 4 goals aparecem como ativos antes do boot', goalStore.getAllActive().length);

    const result = runBootRecovery(goalStore);
    assert(result.count === 4, `rotina de boot processou os 4 goals órfãos — obtido ${result.count}`, result);

    for (const g of created) {
        const reloaded = goalStore.getById(g.id)!;
        assert(reloaded.status === 'abandoned', `goal ${g.id} (era '${g.status}') virou 'abandoned' — obtido '${reloaded.status}'`, reloaded);
    }

    assert(goalStore.getAllActive().length === 0, 'getAllActive() (mesma query de /api/chat/active) não retorna mais nenhum deles', goalStore.getAllActive());

    db.close();
}

console.log('\n=== S291.2 — motivo do abandono é registrado e consumível ===');
{
    const db = new Database(':memory:');
    const goalStore = new GoalStore(db as any);
    const g = goalStore.create(baseGoalInput('executing'));

    runBootRecovery(goalStore);

    const reason = goalStore.consumeAbandonReason(g.id);
    assert(!!reason && reason.includes('reiniciado'), `motivo do abandono foi registrado e é consumível — obtido: "${reason}"`, reason);
    assert(goalStore.consumeAbandonReason(g.id) === undefined, 'motivo não "vaza" numa segunda leitura (consumido uma única vez)', goalStore.consumeAbandonReason(g.id));

    db.close();
}

console.log('\n=== S291.3 — CONTROLE NEGATIVO: goal já completed não é tocado ===');
{
    const db = new Database(':memory:');
    const goalStore = new GoalStore(db as any);
    const g = goalStore.create(baseGoalInput('active'));
    goalStore.setStatus(g.id, 'executing');
    goalStore.setStatus(g.id, 'completed');

    assert(goalStore.getAllActive().length === 0, 'goal completed não aparece em getAllActive() antes do boot', goalStore.getAllActive());

    const result = runBootRecovery(goalStore);
    assert(result.count === 0, 'rotina de boot não processa nenhum goal (nada órfão)', result);

    const reloaded = goalStore.getById(g.id)!;
    assert(reloaded.status === 'completed', 'status permanece completed — não foi rebaixado nem alterado', reloaded.status);

    db.close();
}

console.log('\n=== S291.4 — goal blocked com autorização pendente tem pendingTxnId/requiresAuth limpos ao abandonar ===');
{
    const db = new Database(':memory:');
    const goalStore = new GoalStore(db as any);
    const g = goalStore.create(baseGoalInput('blocked', { pendingTxnId: 'txn-s291', requiresAuth: true }));

    const before = goalStore.getById(g.id)!;
    assert(before.pendingTxnId === 'txn-s291' && before.requiresAuth === true, 'pré-condição: goal criado com autorização pendente', before);

    runBootRecovery(goalStore);

    const after = goalStore.getById(g.id)!;
    assert(after.status === 'abandoned', 'goal blocked com auth pendente também vira abandoned', after.status);
    assert(after.pendingTxnId == null, `pendingTxnId foi limpo — obtido: ${after.pendingTxnId}`, after);
    assert(after.requiresAuth === false, `requiresAuth foi limpo — obtido: ${after.requiresAuth}`, after);

    db.close();
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S291 RESULTADO: ${passed} passou | ${failed} falhou`);
process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
