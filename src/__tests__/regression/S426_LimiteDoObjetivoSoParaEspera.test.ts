/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S426 (reescrito pela ADR-027)
 * O "limite do objetivo" (LIMITE_DO_OBJETIVO_MIN, padrão 30 min) deixou de limitar TRABALHO: é só quanto tempo um goal
 * PARADO à espera (autorização, esclarecimento, resto de execução interrompida) fica aberto. Um goal que um laço deste
 * processo está executando nunca vence. O modo aviso e o limite duro da ADR-024 etapa 6 saíram.
 *
 * ORIGEM: operadora, 23/10/2026 — "não quero nenhum limite fixo; os limites são para verificar parada (travamento) do
 * sistema, não parar por tempo se o sistema está trabalhando corretamente". Caso real: VPS, 22–23/10, o goal do Nether
 * instalou o mod em ~10 min, seguiu verificando e foi encerrado aos 30 min como "não finalizei".
 *
 * REGRESSÃO SE: a limpeza de vencidos abandonar um goal em execução; deixar de abandonar o que está parado à espera; o
 * tempo de trabalho vencer a espera pelo usuário (a janela precisa contar da saída do laço); o modo aviso voltar.
 *
 * Execução: npx ts-node src/__tests__/regression/S426_LimiteDoObjetivoSoParaEspera.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import * as limites from '../../loop/GoalLimits';
import { GOAL_LIMITS } from '../../loop/GoalLimits';
import { GoalStore } from '../../loop/GoalStore';
import { makeGoal } from './_fixtures/goalLoopHarness';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const MIN = 60_000;

async function main(): Promise<void> {
    delete process.env.LIMITE_DO_OBJETIVO_MIN;

    console.log('\n=== S426-1 — a janela de espera é configurável ===');
    assert(GOAL_LIMITS.MAX_GOAL_TTL_MS === 30 * MIN, 'padrão: 30 min');
    process.env.LIMITE_DO_OBJETIVO_MIN = '45';
    assert(GOAL_LIMITS.MAX_GOAL_TTL_MS === 45 * MIN, 'LIMITE_DO_OBJETIVO_MIN=45 → 45 min (lido a cada uso)');
    process.env.LIMITE_DO_OBJETIVO_MIN = 'lixo';
    assert(GOAL_LIMITS.MAX_GOAL_TTL_MS === 30 * MIN, 'valor inválido → o padrão');
    delete process.env.LIMITE_DO_OBJETIVO_MIN;

    console.log('\n=== S426-2 — o modo aviso e o limite duro saíram ===');
    assert(!('limiteDoObjetivoComoAviso' in limites) && !('limiteDuroDoObjetivoMs' in limites), 'GoalLimits não oferece mais prorrogação nem limite duro');

    console.log('\n=== S426-3 — vencido em EXECUÇÃO não é abandonado; vencido PARADO à espera é ===');
    const store = new GoalStore(new (Database as any)(':memory:'));
    const vencido = Date.now() - 1000;
    const rodando = makeGoal(store, [], { expiresAt: vencido, status: 'executing' });
    const esperando = makeGoal(store, [], { expiresAt: vencido, status: 'blocked' });
    const emDia = makeGoal(store, [], { status: 'blocked' });
    const n = store.expireStale(id => id === rodando.id);
    assert(store.getById(rodando.id)!.status === 'executing', 'o goal em execução segue executando, mesmo com o prazo vencido');
    assert(store.getById(esperando.id)!.status === 'abandoned', 'o goal parado à espera, vencido, é encerrado');
    assert(store.getById(emDia.id)!.status === 'blocked', 'o goal parado, dentro da janela, continua aberto');
    assert(n === 1, `uma limpeza só (${n})`);
    assert(/parado à espera/.test(store.consumeAbandonReason(esperando.id) ?? ''), 'o motivo registrado diz que ficou parado à espera (não "expirou por tempo")');

    console.log('\n=== S426-4 — fiação: o orquestrador informa quem está executando; a espera conta da saída do laço ===');
    const orq = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalOrchestrator.ts'), 'utf-8');
    const loop = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalExecutionLoop.ts'), 'utf-8');
    assert(/this\.goalStore\.expireStale\(id => this\.executionLoop\.estaExecutando\(id\)\)/.test(orq), 'GoalOrchestrator passa o registro de execução para a limpeza');
    assert(/this\.emExecucao\.add\(goal\.id\)/.test(loop) && /this\.emExecucao\.delete\(goal\.id\)/.test(loop), 'runLoop entra e sai do registro de execução');
    assert(/expiresAt: Date\.now\(\) \+ GOAL_LIMITS\.MAX_GOAL_TTL_MS/.test(loop.slice(loop.indexOf('private async runLoop('), loop.indexOf('private async runLoopDoObjetivo('))),
        'ao sair do laço sem terminar, a janela de espera recomeça agora');
    assert(!/prorrogarPorAviso|OBJETIVO-AVISO/.test(loop), 'nenhum vestígio do modo aviso no laço');

    console.log(`\n=== S426: ${passed} passaram, ${failed} falharam ===`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
