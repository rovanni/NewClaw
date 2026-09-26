/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S305 (Sprint 2, issue 048)
 * `response_produced` não é injetado quando o plano JÁ entrega um artefato (send_document/send_audio).
 * Caso real (26/09/2026): "crie o programa e me envie o .py", categoria `creation`, `.py` entregue em
 * 4,4 min; o critério acrescentado mantinha o goal trabalhando por mais 25 min.
 *
 *   1 → creation + send_document no plano: NÃO injeta.
 *   2 → creation + send_audio no plano: NÃO injeta.
 *   3 → creation SEM entrega no plano ("escreva um poema"): injeta, como antes.
 *   4 → information com/sem entrega: mesma regra (estrutural, por categoria só decide o conjunto).
 *   5 → critério declarado pelo Planner é preservado mesmo com entrega no plano.
 *   6 → `steps` omitido: comportamento idêntico ao de antes (compatibilidade).
 *   7 → categoria fora do conjunto / undefined: inalterado.
 *   8 → rede de segurança: entrega prometida e depois abandonada por um replan continua forçando o validador.
 *   9 → GoalExecutionLoop passa o plano inicial à função.
 *
 * Execução: npx ts-node src/__tests__/regression/S305_ResponseContract_SkippedWhenPlanDelivers.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import {
    ensureResponseContractCriterion,
    ensureDeliverySuccessCriteria,
    ensureDeliveryNotAbandonedCriterion,
    trackPromisedDeliveryTools,
    detectAbandonedDeliveryTools,
    AUTO_DELIVERY_CRITERION_IDS,
} from '../../loop/planning/ensureDeliverySuccessCriteria';
import { PlanStep, SuccessCriterion } from '../../loop/GoalTypes';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const step = (toolName?: string, id = 'step_x'): PlanStep => ({ id, description: 'passo', toolName, toolArgs: {}, fallbackSteps: [], status: 'pending' } as PlanStep);
const has = (c: SuccessCriterion[]) => c.some(x => x.check === 'response_produced');
const noCriteria: SuccessCriterion[] = [];

console.log('\n=== S305-1/2 — creation com entrega no plano: não injeta ===');
assert(!has(ensureResponseContractCriterion('creation', noCriteria, [step(), step('exec_command'), step('send_document')])), 'send_document no plano → sem response_produced');
assert(!has(ensureResponseContractCriterion('creation', noCriteria, [step('write'), step('send_audio')])), 'send_audio no plano → sem response_produced');

console.log('\n=== S305-3 — creation sem entrega: injeta como antes ===');
{
    const r = ensureResponseContractCriterion('creation', noCriteria, [step(), step('write')]);
    assert(has(r) && r[0].id === AUTO_DELIVERY_CRITERION_IDS.response_produced, 'poema/texto sem ferramenta de entrega → response_produced injetado', r);
    assert(has(ensureResponseContractCriterion('creation', noCriteria, [])), 'plano vazio → injeta (não há entrega)');
}

console.log('\n=== S305-4 — mesma regra em outra categoria ===');
assert(has(ensureResponseContractCriterion('information', noCriteria, [step('web_search')])), 'information sem entrega → injeta');
assert(!has(ensureResponseContractCriterion('information', noCriteria, [step('web_search'), step('send_document')])), 'information com send_document → não injeta');

console.log('\n=== S305-5 — critério declarado pelo Planner é preservado ===');
{
    const declared: SuccessCriterion[] = [{ id: 'c1', description: 'resposta', check: 'response_produced', status: 'pending' } as SuccessCriterion];
    const r = ensureResponseContractCriterion('creation', declared, [step('send_document')]);
    assert(r.length === 1 && r[0].id === 'c1', 'o critério do Planner continua lá, sem duplicar', r);
}

console.log('\n=== S305-6 — `steps` omitido: comportamento de antes ===');
assert(has(ensureResponseContractCriterion('creation', noCriteria)), 'sem o 3º argumento, creation continua injetando');

console.log('\n=== S305-7 — categoria fora do conjunto / undefined ===');
assert(!has(ensureResponseContractCriterion('system_operation', noCriteria, [step()])), 'system_operation → inalterado');
assert(!has(ensureResponseContractCriterion(undefined, noCriteria, [step()])), 'sem categoria → inalterado');

console.log('\n=== S305-8 — rede de segurança: entrega prometida e abandonada por um replan ===');
{
    const initial = [step(), step('exec_command'), step('send_document')];
    const criteria0 = ensureResponseContractCriterion('creation', ensureDeliverySuccessCriteria(initial, []), initial);
    assert(!has(criteria0), 'geração 0: sem response_produced (o plano entrega)');
    const promised = trackPromisedDeliveryTools(initial, []);
    const replanPlan = [step('write'), step('exec_command')]; // o replan deixa de entregar
    const abandoned = detectAbandonedDeliveryTools(trackPromisedDeliveryTools(replanPlan, promised), replanPlan, []);
    const net = ensureDeliveryNotAbandonedCriterion(abandoned, []);
    assert(abandoned.includes('send_document'), 'o abandono da entrega é detectado como fato estrutural', abandoned);
    assert(net.some(c => c.check === 'delivery_not_silently_abandoned' && c.status !== 'met'), 'o critério de abandono força o validador (nunca met na injeção)', net);
}

console.log('\n=== S305-9 — o chamador passa o plano inicial ===');
{
    const src = fs.readFileSync(path.join(__dirname, '../../loop/GoalExecutionLoop.ts'), 'utf-8');
    assert(/ensureResponseContractCriterion\(\s*intentCategory,\s*ensureDeliverySuccessCriteria\(initialPlan, planResult\.successCriteria \?\? \[\]\),\s*initialPlan,/.test(src), 'GoalExecutionLoop passa initialPlan como 3º argumento');
}

console.log(`\nS305 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
