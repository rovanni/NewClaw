/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S336 (issue 035, Sprint H1)
 *
 * `GoalStore.create()` aceitava `sentArtifacts` (e `deliveryToolsEverPromised`) no objeto de entrada, mas o INSERT não
 * listava as colunas: o objeto em memória devolvido tinha o valor, uma leitura seguinte via getById() devolvia [].
 * Achado no S283 (issue 028); a auditoria "campos aceitos × campos gravados" pedida pela issue achou a segunda coluna.
 *
 * REGRESSÃO SE: algum campo aceito por create() voltar a não ser gravado — o teste compara o objeto devolvido por
 * create() com o relido do banco, campo a campo.
 *
 * Execução: npx ts-node src/__tests__/regression/S336_GoalStore_CreatePersistsAllAcceptedFields.test.ts
 */
import Database from 'better-sqlite3';
import { GoalStore } from '../../loop/GoalStore';

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
const base = {
    sessionKey: 'web:s336', conversationId: 'conv-s336', userIntent: 'Gere um PDF', objective: 'Gerar e enviar um PDF',
    status: 'active', currentPlan: [], attempts: [], blockers: [], toolsTried: [], strategiesTried: [],
    nextAction: null, cycleFocus: null, retryBudget: 5, replanBudget: 3, confidence: 0.8, requiresAuth: false,
    authorizationScope: [], pendingTxnId: null, expiresAt: Date.now() + 60000, completedAt: null,
} as any;

console.log('\n=== S336-1 — os dois campos que ficavam fora do INSERT ===');
{
    const created = quiet(() => store.create({ ...base, sentArtifacts: ['relatorio.pdf'], deliveryToolsEverPromised: ['send_document'] }));
    const reread = store.getById(created.id)!;
    assert(JSON.stringify(reread.sentArtifacts) === '["relatorio.pdf"]', 'sentArtifacts gravado na criação', reread.sentArtifacts);
    assert(JSON.stringify(reread.deliveryToolsEverPromised) === '["send_document"]', 'deliveryToolsEverPromised gravado na criação', reread.deliveryToolsEverPromised);
}

console.log('\n=== S336-2 — sem os campos: leitura continua [] ===');
{
    const created = quiet(() => store.create({ ...base }));
    const reread = store.getById(created.id)!;
    assert(Array.isArray(reread.sentArtifacts) && reread.sentArtifacts.length === 0, 'sentArtifacts = []');
    assert(Array.isArray(reread.deliveryToolsEverPromised) && reread.deliveryToolsEverPromised!.length === 0, 'deliveryToolsEverPromised = []');
}

console.log('\n=== S336-3 — auditoria: todo campo devolvido por create() é o mesmo relido do banco ===');
{
    const full = {
        ...base, nextAction: 'proximo', cycleFocus: 'foco', isConstruction: true, roadmap: [{ id: 'm1', title: 'Marco' }],
        currentMilestoneIndex: 1, allowRoadmapAdjustment: false, successCriteria: [{ id: 'c1', description: 'd', check: 'response_produced', status: 'pending' }],
        planGeneration: 2, sentArtifacts: ['a.pdf'], deliveryToolsEverPromised: ['send_audio'], authorizationScope: ['exec_command'],
    };
    const created = quiet(() => store.create(full)) as unknown as Record<string, unknown>;
    const reread = store.getById(String(created.id)) as unknown as Record<string, unknown>;
    // objective é cortado em 500 no INSERT por decisão registrada (issue 048) — aqui é curto, então igual.
    // null (entrada) e undefined (rowToGoal lê NULL como ausente) são a mesma ausência — não é perda de dado.
    const norm = (v: unknown) => JSON.stringify(v ?? null);
    const divergentes = Object.keys(full).filter(k => norm(created[k]) !== norm(reread[k]));
    assert(divergentes.length === 0, 'nenhum campo aceito diverge entre create() e getById()', divergentes.map(k => ({ k, criado: created[k], relido: reread[k] })));
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S336 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
