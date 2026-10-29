/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S461 (29/10/2026, achados do review do PR #18 / ADR-029)
 *
 * A ADR-029 fez o objetivo nascer do pedido entendido pela conversa ("Pode fazer?" → "Pode criar uma versão do CamScanner
 * em Rust e HTML?"). O review do PR #18 achou três lugares que ainda usavam o texto literal ou apagavam informação:
 *   1. o contexto de follow-up dizia `goal concluído: "Pode fazer?"` — o literal (`recentGoal.intent`), não o objetivo;
 *   2. quando o juiz só COPIAVA o pedido (já se entendia sozinho), a cópia apagava o objetivo escrito pelo classificador;
 *   3. a mensagem de falha dizia `Não consegui completar: "Pode fazer?"`.
 *
 * REGRESSÃO SE: algum dos três voltar a usar o literal quando há pedido entendido; a cópia igual do juiz voltar a vencer o
 * objetivo do classificador; ou o literal deixar de ser o último recurso (objetivo ausente).
 *
 * Execução: npx ts-node src/__tests__/regression/S461_PedidoEntendidoNosTresUsos.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { GracefulDeliveryOrchestrator } from '../../loop/GracefulDeliveryOrchestrator';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

console.log('\n=== S461 — o pedido entendido nos três usos ===\n');

console.log('Mensagem de falha');
{
    const gd = new GracefulDeliveryOrchestrator();
    const base = { id: 'g1', toolsTried: [], attempts: [], blockers: [], sentArtifacts: [] };
    const msg = gd.buildFailureMessage({ ...base, userIntent: 'Pode fazer?', objective: 'Criar uma versão do CamScanner em Rust e HTML' } as any);
    assert(msg.startsWith('Não consegui completar: "Pode fazer?" (entendido como: "Criar uma versão do CamScanner em Rust e HTML").'),
        'cita as palavras do usuário E o pedido entendido', msg);
    const semObj = gd.buildFailureMessage({ ...base, userIntent: 'gere o relatório', objective: '' } as any);
    assert(semObj.startsWith('Não consegui completar: "gere o relatório".'), 'sem objetivo, só o literal', semObj);
    const igual = gd.buildFailureMessage({ ...base, userIntent: 'gere o relatório', objective: 'Gere o relatório' } as any);
    assert(igual.startsWith('Não consegui completar: "gere o relatório".'), 'objetivo igual ao literal não se repete', igual);
}

console.log('\nGoalOrchestrator');
{
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'loop', 'GoalOrchestrator.ts'), 'utf-8');
    assert(/const pedidoAnterior = recentGoal\.objective \|\| recentGoal\.intent;/.test(src) && !/recentGoal\.intent\.slice/.test(src),
        'o contexto de follow-up usa o objetivo do goal anterior');
    assert(/pedidoCompleto\.trim\(\)\.toLowerCase\(\) !== message\.trim\(\)\.toLowerCase\(\)/.test(src),
        'o pedido completo só conta quando difere do literal');
    assert(/const objetivo = pedidoEntendido \|\| classification\.objective \|\| message;/.test(src), 'goal: entendido → classificador → literal');
    assert(/objective: \(pedidoEntendido \|\| message\)\.slice\(0, 200\)/.test(src), 'caminho do agente registra o pedido entendido');
    assert(/objective: pedidoEntendido \|\| classification\.objective \|\| message,/.test(src), 'caminho inline registra o pedido entendido');
    const iDecl = src.indexOf('const pedidoEntendido =');
    const usos = [src.indexOf('objective: (pedidoEntendido'), src.indexOf('objective: pedidoEntendido'), src.indexOf('const objetivo = pedidoEntendido')];
    assert(iDecl > 0 && usos.every(u => u > iDecl), 'declarado antes dos três usos');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S461 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
process.exit(failed > 0 ? 1 : 0);
