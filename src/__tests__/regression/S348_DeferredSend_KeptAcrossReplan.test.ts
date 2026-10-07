/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S348 (issue 065f)
 *
 * Produção, 06/10 e 07/10/2026, goals do ENADE: o agente chamou send_document para o .md gerado; no goal o envio é
 * ADIADO e vira etapa pendente do plano. O replan final trocou o plano por [memory_search, memory_write] e a etapa de
 * envio sumiu; a conclusão contou 0 envios pendentes e terminou sem enviar. Em 07/10 o aviso ao validador
 * (delivery_not_silently_abandoned, 065d) chegou a ele — e ele aprovou mesmo assim; a resposta na tela dizia
 * "enviado anexo, verificado e íntegro" e nada chegou. Agora, ao trocar o plano, os envios adiados ainda pendentes
 * seguem no plano novo — fato estrutural: foi o próprio agente que decidiu enviar; só a ordem estava adiada.
 *
 * REGRESSÃO SE: um replan/plano rejeitado voltar a descartar envio adiado pendente; ou passar a duplicar envio que o
 * plano novo já faz; ou reenviar o que já foi entregue.
 *
 * Execução: npx ts-node src/__tests__/regression/S348_DeferredSend_KeptAcrossReplan.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';
import { findResponseContractGap } from '../../loop/planning/ensureDeliverySuccessCriteria';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const st = (id: string, toolName: string, status = 'pending', file_path?: string) =>
    ({ id, description: id, status, toolName, ...(file_path ? { toolArgs: { file_path } } : {}) } as any);
const ARQ = 'questoes_enade_compiladores_teoria_so.md';

console.log('\n=== S348-1 — caso do ENADE: replan sem o envio → o envio adiado segue no plano novo ===');
{
    const anterior = [st('s1', 'memory_search', 'completed'), st('s3', 'agentloop', 'completed'), st('s5', 'memory_write', 'failed'), st('send_x', 'send_document', 'pending', ARQ)];
    const novo = [st('n1', 'memory_search'), st('n2', 'memory_write')];
    const mantidos = GoalExecutionLoop.pendingDeferredSends(anterior, novo, []);
    assert(mantidos.length === 1 && mantidos[0].toolArgs?.file_path === ARQ && mantidos[0].status === 'pending', 'o send_document pendente é mantido', mantidos);
    const contrato = [{ id: 'auto_response_produced', description: 'r', check: 'response_produced', status: 'pending' }] as any;
    assert(findResponseContractGap([...novo, ...mantidos], contrato) === null, 'com o envio mantido, o plano não é mais rejeitado por falta de entrega/resposta');
}

console.log('\n=== S348-2 — sem duplicar nem reenviar ===');
{
    const anterior = [st('send_x', 'send_document', 'pending', ARQ)];
    assert(GoalExecutionLoop.pendingDeferredSends(anterior, [st('n1', 'send_document', 'pending', ARQ)], []).length === 0, 'plano novo já envia o mesmo arquivo → não duplica');
    assert(GoalExecutionLoop.pendingDeferredSends(anterior, [st('n1', 'send_document', 'pending', './' + ARQ)], []).length === 0, 'mesmo arquivo com caminho escrito de outro jeito → não duplica');
    assert(GoalExecutionLoop.pendingDeferredSends(anterior, [], [ARQ]).length === 0, 'arquivo já entregue → não reenvia');
    assert(GoalExecutionLoop.pendingDeferredSends([st('send_x', 'send_document', 'completed', ARQ)], [], []).length === 0, 'envio já executado → não é pendente');
    assert(GoalExecutionLoop.pendingDeferredSends([st('w', 'write', 'pending', ARQ)], [], []).length === 0, 'só send_document conta');
}

console.log('\n=== S348-3 — os três pontos que trocam/zeram o plano usam a regra ===');
{
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalExecutionLoop.ts'), 'utf-8');
    const usos = (src.match(/GoalExecutionLoop\.pendingDeferredSends\(/g) ?? []).length;
    assert(usos === 3, `replan + plano rejeitado pelo Q2 (CR#3) + plano rejeitado sem etapa de resposta (059) — encontrados: ${usos}`);
    assert(/finalPlan = \[\.\.\.finalPlan, \.\.\.enviosMantidos\];[\s\S]{0,400}const preservedCriteria/.test(src), 'no replan, mantido ANTES dos critérios (a promessa não conta como abandonada)');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S348 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
