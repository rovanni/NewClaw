/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S244
 *
 * Campanha "O8 — Contrato de Modalidade" (2026-08-16, continuação de S230/S231).
 *
 * CONTEXTO: S230 fechou o lado RESPOSTA do contrato de entrega — `response_produced`, GATE
 * estrutural injetado por `ensureResponseContractCriterion` a partir de `IntentCategory`,
 * persistente entre replans (nunca recalculado, só herdado via `preservedCriteria`). O lado
 * ARTEFATO (`tool_succeeded(send_document|send_audio)`, injetado por `ensureDeliverySuccessCriteria`)
 * foi deixado deliberadamente RECALCULADO do zero a cada replan, a partir do plano final da
 * geração vigente (`GoalExecutionLoop.ts:597-611`) — para que um replan que legitimamente
 * abandona `send_document` (ex.: pandoc ausente) não deixe o goal preso exigindo uma tool que a
 * estratégia atual nem usa mais.
 *
 * GAP encontrado (investigação O8, matriz de casos + leitura de `validateGoalCompletion`): esse
 * recálculo tem um efeito colateral não coberto por nenhum teste — se uma geração ANTERIOR
 * prometeu `send_document`/`send_audio` e a geração ATUAL não contém mais a tool, e a categoria
 * do goal está FORA de `RESPONSE_CONTRACT_CATEGORIES` (ex.: `system_operation`/`destructive`,
 * ação pura sem pergunta embutida — por isso excluídas de `response_produced`), **nenhum**
 * critério restante força a passagem pelo validador LLM. Se o resto do checklist fecha
 * deterministicamente (`evaluateCriteria` → Caminho 1, `GoalExecutionLoop.ts:3804-3825`),
 * `achieved=true` sai sem que `validateGoalCompletion()` jamais releia `userIntent` para notar
 * a ausência do artefato prometido.
 *
 * CORREÇÃO: `Goal.deliveryToolsEverPromised` (acumulado monotonicamente por
 * `trackPromisedDeliveryTools`, em todo plano inicial e replan) + `detectAbandonedDeliveryTools`
 * (fato estrutural: promessa anterior ausente do plano final E nada entregue em
 * `goal.sentArtifacts`) + `ensureDeliveryNotAbandonedCriterion` (injeta o GATE
 * `delivery_not_silently_abandoned`, nunca `'met'` deterministicamente — mesmo padrão de
 * `response_produced`). Independente de `IntentCategory`: protege justamente os casos que
 * `response_produced` não cobre.
 *
 * REGRESSÃO SE: uma tool de entrega prometida em qualquer geração anterior do plano sumir da
 * geração final sem que `delivery_not_silently_abandoned` seja injetado (quando nada foi
 * entregue); ou se o critério for injetado quando a tool continua no plano, ou já foi entregue,
 * ou nunca foi prometida antes.
 *
 * Execução: npx ts-node src/__tests__/regression/S244_DeliveryContract_NotSilentlyAbandoned.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    trackPromisedDeliveryTools,
    detectAbandonedDeliveryTools,
    ensureDeliveryNotAbandonedCriterion,
    AUTO_DELIVERY_CRITERION_IDS,
} from '../../loop/planning/ensureDeliverySuccessCriteria';
import { PlanStep, SuccessCriterion } from '../../loop/GoalTypes';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

function step(toolName: string | undefined, id = `step_${toolName ?? 'none'}`): PlanStep {
    return { id, description: `step ${toolName}`, toolName, status: 'pending' };
}

console.log('\n=== S244-1 — trackPromisedDeliveryTools: acumula monotonicamente, ignora tools irrelevantes ===');
{
    const gen0 = trackPromisedDeliveryTools([step('write'), step('send_document')], []);
    assert(gen0.length === 1 && gen0[0] === 'send_document', 'geração 0: só send_document entra (write não é tool de entrega)', gen0);

    const gen1 = trackPromisedDeliveryTools([step('web_search'), step('send_audio')], gen0);
    assert(
        gen1.includes('send_document') && gen1.includes('send_audio') && gen1.length === 2,
        'geração 1: acumula com a geração anterior — send_document não some mesmo sem estar no plano desta geração',
        gen1,
    );

    const gen2 = trackPromisedDeliveryTools([step('send_document')], gen1);
    assert(gen2.length === 2, 'geração 2: sem duplicar — send_document repetido não gera segunda entrada', gen2);
}

console.log('\n=== S244-2 — detectAbandonedDeliveryTools: os 6 cenários estruturais ===');
{
    // 1. Tool ainda no plano final → não é abandono.
    const c1 = detectAbandonedDeliveryTools(['send_document'], [step('send_document')], []);
    assert(c1.length === 0, 'tool presente na geração final: não é abandono', c1);

    // 2. Tool ausente do plano final, nada entregue → abandono real.
    const c2 = detectAbandonedDeliveryTools(['send_document'], [step('web_navigate')], []);
    assert(c2.length === 1 && c2[0] === 'send_document', 'tool ausente e nada entregue: abandono detectado', c2);

    // 3. Tool ausente do plano final, MAS já entregue (sentArtifacts tem o path real) → não é abandono.
    const c3 = detectAbandonedDeliveryTools(['send_document'], [step('web_navigate')], ['/workspace/relatorio.pdf']);
    assert(c3.length === 0, 'tool ausente mas já entregue (sentArtifacts com path real): não é abandono — entrega concluída', c3);

    // 4. send_audio ausente, mas sentinela de dedup presente → não é abandono.
    const c4 = detectAbandonedDeliveryTools(['send_audio'], [step('web_navigate')], ['__send_audio_delivered__']);
    assert(c4.length === 0, 'send_audio ausente mas sentinela de entrega presente: não é abandono', c4);

    // 5. Nunca foi prometido → nada a detectar, independente do plano final.
    const c5 = detectAbandonedDeliveryTools([], [step('web_navigate')], []);
    assert(c5.length === 0, 'nada foi prometido antes: nenhuma tool candidata a abandono', c5);

    // 6. Duas tools prometidas, uma abandonada e outra ainda no plano.
    const c6 = detectAbandonedDeliveryTools(['send_document', 'send_audio'], [step('send_audio')], []);
    assert(
        c6.length === 1 && c6[0] === 'send_document',
        'send_document abandonado, send_audio ainda no plano (não entra na lista)',
        c6,
    );
}

console.log('\n=== S244-3 — ensureDeliveryNotAbandonedCriterion: injeta só quando há abandono, recalcula do zero ===');
{
    const semAbandono = ensureDeliveryNotAbandonedCriterion([], []);
    assert(semAbandono.length === 0, 'sem tools abandonadas: nenhum critério injetado', semAbandono);

    const comAbandono = ensureDeliveryNotAbandonedCriterion(['send_document'], []);
    assert(comAbandono.length === 1, 'com tool abandonada: 1 critério injetado', comAbandono);
    assert(comAbandono[0].check === 'delivery_not_silently_abandoned', 'check correto', comAbandono[0]);
    assert(comAbandono[0].id === AUTO_DELIVERY_CRITERION_IDS.delivery_not_abandoned, 'id reservado correto', comAbandono[0]);
    assert(comAbandono[0].status === 'pending', 'nasce pending — nunca met na injeção', comAbandono[0]);

    // Recalculado do zero: uma chamada anterior com abandono não "vaza" para uma chamada seguinte
    // sem abandono (mesmo padrão de ensureResponseContractCriterion/ensureDeliverySuccessCriteria).
    const criteriaComVelho: SuccessCriterion[] = [
        { id: AUTO_DELIVERY_CRITERION_IDS.delivery_not_abandoned, description: 'antigo', check: 'delivery_not_silently_abandoned', status: 'pending' },
        { id: 'outro_criterio', description: 'preservado', check: 'tool_succeeded', tool: 'write', status: 'met' },
    ];
    const semAbandonoAgora = ensureDeliveryNotAbandonedCriterion([], criteriaComVelho);
    assert(
        semAbandonoAgora.length === 1 && semAbandonoAgora[0].id === 'outro_criterio',
        'critério antigo removido quando abandono não existe mais nesta chamada; outros critérios preservados',
        semAbandonoAgora,
    );
}

console.log('\n=== S244-4 — reprodução do incidente: goal em categoria SEM response_produced perde a proteção sem este fix ===');
{
    // "instale X e me gere um relatório em PDF" — categoria system_operation (fora de
    // RESPONSE_CONTRACT_CATEGORIES por design, ver ensureResponseContractCriterion). Geração 0
    // promete send_document; um replan (ex.: pandoc ausente) troca para uma estratégia que só
    // escreve um .txt local, sem enviar nada.
    const promised0 = trackPromisedDeliveryTools([step('exec_command'), step('send_document')], []);
    const finalPlanReplan = [step('write'), step('exec_command')]; // send_document não está mais aqui
    const promisedAfterReplan = trackPromisedDeliveryTools(finalPlanReplan, promised0);
    const abandoned = detectAbandonedDeliveryTools(promisedAfterReplan, finalPlanReplan, []); // nada entregue

    assert(abandoned.length === 1 && abandoned[0] === 'send_document', 'abandono detectado mesmo sem response_produced (categoria não participa desta checagem)', abandoned);

    const criteria = ensureDeliveryNotAbandonedCriterion(abandoned, []); // outros critérios, hipoteticamente, já 'met'
    assert(
        criteria.some(c => c.check === 'delivery_not_silently_abandoned' && c.status !== 'met'),
        'GATE presente e não-met: allMet não pode fechar achieved=true sozinho — força validateGoalCompletion (LLM) a reler userIntent',
        criteria,
    );
}

console.log('\n=== S244-5 — Fix presente estruturalmente: domainTypes.ts ===');
{
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'shared', 'domainTypes.ts'), 'utf-8');
    assert(/'delivery_not_silently_abandoned'/.test(source), "CriterionCheck inclui 'delivery_not_silently_abandoned'");
    assert(/deliveryToolsEverPromised\?: string\[\];/.test(source), 'Goal.deliveryToolsEverPromised declarado como opcional (compatível com dados legados)');
}

console.log('\n=== S244-6 — Fix presente estruturalmente: GoalStore.ts (schema + patch + leitura) ===');
{
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalStore.ts'), 'utf-8');
    assert(/ALTER TABLE goals ADD COLUMN delivery_tools_ever_promised TEXT/.test(source), 'migração ALTER TABLE presente, mesmo padrão retrocompatível de sent_artifacts');
    assert(/patch\.deliveryToolsEverPromised !== undefined.*delivery_tools_ever_promised = \?/.test(source), 'update() grava a coluna a partir do patch');
    assert(/deliveryToolsEverPromised: this\.parseJson<string\[\]>\(row\.delivery_tools_ever_promised, \[\]\)/.test(source), 'rowToGoal() lê a coluna de volta, default [] para goals legados');
}

console.log('\n=== S244-7 — Fix presente estruturalmente: GoalExecutionLoop.ts (wiring nos 2 pontos que recalculam successCriteria) ===');
{
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalExecutionLoop.ts'), 'utf-8');
    assert(
        (source.match(/trackPromisedDeliveryTools\(/g) ?? []).length === 2,
        'trackPromisedDeliveryTools chamado exatamente nos 2 pontos que recalculam successCriteria (plano inicial + replan)',
    );
    assert(
        (source.match(/ensureDeliveryNotAbandonedCriterion\(/g) ?? []).length === 2,
        'ensureDeliveryNotAbandonedCriterion chamado nos mesmos 2 pontos',
    );
    assert(
        /deliveryToolsEverPromised: promisedDeliveryTools,/.test(source),
        'o resultado acumulado é persistido no goalStore.update()',
    );
    assert(
        /case 'delivery_not_silently_abandoned': \{/.test(source),
        "evaluateCriteria() tem um case dedicado, nunca marca 'met' deterministicamente (GATE)",
    );
    assert(
        /hasAbandonedDeliveryContract = \(goal\.successCriteria \?\? \[\]\)\.some\(c => c\.check === 'delivery_not_silently_abandoned'\)/.test(source),
        'validateGoalCompletion() detecta a presença do GATE e injeta o fato estrutural no prompt (Evidence Provider Pattern)',
    );
    assert(
        /\$\{responseContractBlock\}\$\{abandonedDeliveryBlock\}/.test(source),
        'o novo bloco de fato está encadeado no prompt, ao lado do bloco irmão já existente',
    );
    // Não-regressão: preservedCriteria (replan) continua filtrando o critério de abandono, para
    // que ensureDeliveryNotAbandonedCriterion recalcule do zero a cada replan (mesmo padrão de
    // send_document/send_audio) — sem isso, um GATE de uma geração abandonada ficaria "preso".
    assert(
        /c\.id !== AUTO_DELIVERY_CRITERION_IDS\.delivery_not_abandoned/.test(source),
        'preservedCriteria filtra o critério de abandono antes do merge — recalculado, não acumulado',
    );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S244 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
console.log(`\nCOBERTURA:`);
console.log(`  trackPromisedDeliveryTools: acumulação monotônica entre gerações: testado`);
console.log(`  detectAbandonedDeliveryTools: 6 cenários estruturais (presente/ausente/entregue/sentinela/nunca-prometido/misto): testado`);
console.log(`  ensureDeliveryNotAbandonedCriterion: injeção condicional + recálculo do zero: testado`);
console.log(`  Reprodução do gap (categoria fora de RESPONSE_CONTRACT_CATEGORIES): testado`);
console.log(`  Fix presente estruturalmente nos 3 arquivos tocados: testado`);
if (failed > 0) process.exit(1);
