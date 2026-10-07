/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S346 (issue 065d)
 *
 * Produção, 06/10/2026, goal_1791338195216_r6ppm (questões do ENADE): o agente chamou send_document para o .md gerado;
 * no goal o envio é ADIADO e vira etapa pendente do plano. O replan final trocou o plano por [memory_write] (a etapa de
 * envio saiu junto), a admissão da 059 rejeitou esse plano e o deixou vazio, e a conclusão contou 0 envios pendentes —
 * o goal terminou sem enviar o arquivo. A proteção existente (`delivery_not_silently_abandoned`, campanha O8: avisa o
 * validador de uma entrega prometida que sumiu do plano) não disparou por duas lacunas:
 *   G1 — o envio adiado injetado no plano não era registrado em `deliveryToolsEverPromised`;
 *   G2 — o caminho de rejeição da 059 retornava antes de gravar os critérios da geração.
 *
 * REGRESSÃO SE: a injeção do envio adiado deixar de registrar a promessa; a rejeição deixar de gravar os critérios; ou
 * a cadeia "prometido + fora do plano + não entregue → critério de entrega abandonada" deixar de valer.
 *
 * Execução: npx ts-node src/__tests__/regression/S346_DeferredSend_SurvivesReplanAsPromise.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { trackPromisedDeliveryTools, detectAbandonedDeliveryTools, ensureDeliveryNotAbandonedCriterion } from '../../loop/planning/ensureDeliverySuccessCriteria';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const step = (toolName: string, status = 'pending') => ({ id: `s_${toolName}`, description: 'x', status, toolName } as any);

console.log('\n=== S346-1 — cadeia do caso real: envio injetado → prometido; replan sem ele → entrega abandonada ===');
{
    // Plano depois da injeção do envio adiado (23:06): etapas concluídas + send_document pendente.
    const comEnvio = [step('web_search', 'completed'), step('agentloop', 'completed'), step('send_document')];
    const prometidos = trackPromisedDeliveryTools(comEnvio, []);
    assert(prometidos.includes('send_document'), 'envio adiado no plano conta como promessa');
    // Replan das 23:12: plano novo só com memory_write; nada foi entregue ainda.
    const abandonados = detectAbandonedDeliveryTools(prometidos, [step('memory_write')], []);
    assert(abandonados.includes('send_document'), 'replan sem o envio → send_document abandonado', abandonados);
    const criterios = ensureDeliveryNotAbandonedCriterion(abandonados, []);
    assert(criterios.some(c => c.check === 'delivery_not_silently_abandoned'), 'critério de entrega abandonada vai para o validador');
    // Controle: se o arquivo já tivesse sido entregue, não é abandono.
    assert(detectAbandonedDeliveryTools(prometidos, [step('memory_write')], ['questoes_enade.md']).length === 0, 'já entregue → não é abandono');
}

console.log('\n=== S346-2 — os dois pontos gravam o que a cadeia precisa ===');
{
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalExecutionLoop.ts'), 'utf-8');
    assert(/currentPlan: updatedPlan,\s*deliveryToolsEverPromised: trackPromisedDeliveryTools\(updatedPlan, goal\.deliveryToolsEverPromised \?\? \[\]\)/.test(src),
        'G1: injeção do envio adiado registra a promessa');
    assert(/if \(this\.rejectPlanWithoutAnswerStep\(goal, finalPlan, replanCriteria\)\) \{[\s\S]{0,500}successCriteria: replanCriteria, deliveryToolsEverPromised: promisedDeliveryTools/.test(src),
        'G2: plano rejeitado no replan ainda grava critérios e promessas da geração');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S346 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
