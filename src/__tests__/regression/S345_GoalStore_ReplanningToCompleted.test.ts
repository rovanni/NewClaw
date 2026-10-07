/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S345 (issue 065c)
 *
 * 06/10/2026, produção, goal_1791338195216_r6ppm (questões do ENADE): no fim do goal, um replan propôs só
 * `memory_write`; a admissão (issue 059) rejeitou o plano e deixou o goal em 'replanning' com plano vazio; a validação
 * seguinte concluiu que o objetivo JÁ estava atingido — e o GoalStore recusou `replanning → completed`. O goal ficou
 * preso em 'replanning'; o painel, que pergunta "há goal ativo?" a cada 1,5 s, mostrou "Ajustando o plano..." para
 * sempre e nunca buscou a resposta, pronta no servidor desde 23:12.
 *
 * REGRESSÃO SE: `replanning → completed` voltar a ser recusado; ou um estado terminal passar a aceitar saída.
 *
 * Execução: npx ts-node src/__tests__/regression/S345_GoalStore_ReplanningToCompleted.test.ts
 */
import Database from 'better-sqlite3';
import { GoalStore } from '../../loop/GoalStore';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const quiet = <T>(fn: () => T): T => {
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (): boolean => true;
    try { return fn(); } finally { process.stdout.write = orig; }
};

const db = new Database(':memory:');
const store = quiet(() => new GoalStore(db as any));
const novoGoal = () => quiet(() => store.create({
    sessionKey: 'web:s345', conversationId: 'conv-s345', userIntent: 'Crie questões no padrão do ENADE', objective: 'Criar questões',
    status: 'active', currentPlan: [], attempts: [], blockers: [], toolsTried: [], strategiesTried: [], nextAction: null,
    cycleFocus: null, retryBudget: 5, replanBudget: 3, confidence: 0.8, requiresAuth: false, authorizationScope: [],
    pendingTxnId: null, expiresAt: Date.now() + 60_000, completedAt: null,
} as any));

console.log('\n=== S345-1 — caso do ENADE: plano rejeitado na admissão, objetivo já atingido → completed ===');
{
    const g = novoGoal();
    quiet(() => store.update(g.id, { status: 'replanning' }));
    quiet(() => store.update(g.id, { status: 'executing' }));
    const loop = Object.create(GoalExecutionLoop.prototype) as any;
    loop.goalStore = store;
    const contrato = [{ id: 'auto_response_produced', description: 'resposta', check: 'response_produced', status: 'pending' }];
    const rejeitou = quiet(() => loop.rejectPlanWithoutAnswerStep(store.getById(g.id), [{ id: 's1', description: 'salvar', status: 'pending', toolName: 'memory_write' }], contrato));
    assert(rejeitou === true && store.getById(g.id)!.status === 'replanning', 'admissão rejeitou o plano só com memory_write → replanning', store.getById(g.id)!.status);
    quiet(() => store.setStatus(g.id, 'completed'));
    assert(store.getById(g.id)!.status === 'completed', 'validação "objetivo atingido" leva a completed (antes: ficava preso em replanning)', store.getById(g.id)!.status);
}

console.log('\n=== S345-2 — estados terminais continuam sem saída ===');
{
    const g = novoGoal();
    quiet(() => store.update(g.id, { status: 'replanning' }));
    quiet(() => store.setStatus(g.id, 'completed'));
    quiet(() => store.update(g.id, { status: 'replanning' }));
    assert(store.getById(g.id)!.status === 'completed', 'completed → replanning continua recusado');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S345 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
