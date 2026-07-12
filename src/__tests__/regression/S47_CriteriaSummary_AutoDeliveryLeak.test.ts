/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S47
 * Investigação de log real (05/07/2026, 14:31, Telegram, goal_1783272571191_4y62y): usuário
 * pediu análise de cripto com áudio e a resposta final do bot foi literalmente
 * "Entrega confirmada via send_audio" — um rótulo interno de auditoria, não uma frase para o
 * usuário.
 *
 * Rastreamento no audit log mostrou a causa exata:
 *   1. `ensureDeliverySuccessCriteria()` injeta automaticamente um SuccessCriterion com
 *      description="Entrega confirmada via ${tool}" (AUTO_DELIVERY_CRITERION_IDS) sempre que o
 *      plano final contém send_document/send_audio — um rótulo de auditoria interno.
 *   2. `GoalExecutionLoop.evaluateCriteria()` monta o "summary" do resultado juntando a
 *      `.description` de TODOS os critérios satisfeitos com "; " — sem excluir os
 *      auto-injetados.
 *   3. `validateGoalCompletion()` (caminho determinístico, "achieved=true sem LLM" — confirmado
 *      no log) usa esse summary como resultado final.
 *   4. `buildResult()` recebe esse summary como `overrideOutput`, que tem PRIORIDADE ABSOLUTA
 *      sobre `lastSuccess.output` (a saída real da tool, ex: "🔊 Áudio enviado com sucesso!" —
 *      já formatada em português natural). Quando o ÚNICO critério satisfeito é o de entrega
 *      automática (como no incidente — nenhum outro critério foi definido), o rótulo interno
 *      vaza verbatim como resposta final ao usuário.
 *
 * Correção: `evaluateCriteria()` agora exclui os IDs de AUTO_DELIVERY_CRITERION_IDS ao montar o
 * summary — mesma constante já usada em outro filtro no mesmo arquivo (linha ~458-459), sem
 * duplicar lógica. Quando isso deixa o summary vazio (== nosso incidente, onde só havia o
 * critério de entrega automática), o fallback pré-existente
 * ('Todos os critérios do checklist foram satisfeitos.') assume — nenhum nome de tool/rótulo
 * interno chega ao usuário.
 *
 * Escopo tocado: loop/GoalExecutionLoop.ts (nenhuma tool alterada — o bug era só na montagem do
 * summary, ensureDeliverySuccessCriteria.ts já documentava a intenção correta do campo).
 *
 * Execução: npx ts-node src/__tests__/regression/S47_CriteriaSummary_AutoDeliveryLeak.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { AUTO_DELIVERY_CRITERION_IDS } from '../../loop/planning/ensureDeliverySuccessCriteria';
import { SuccessCriterion } from '../../loop/GoalTypes';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

// Reproduz o algoritmo EXATO de evaluateCriteria() em GoalExecutionLoop.ts após o fix —
// a classe real tem dependências pesadas de DI (goalStore, planner, riskAnalyzer, etc.) que
// tornam instanciação direta impraticável neste teste; mesma abordagem já usada em S10 para o
// mesmo arquivo (verificação estrutural + reprodução do algoritmo isolado).
function buildSummary(criteria: SuccessCriterion[]): string {
    const AUTO_DELIVERY_IDS = new Set(Object.values(AUTO_DELIVERY_CRITERION_IDS) as string[]);
    return criteria
        .filter(c => c.status === 'met' && !AUTO_DELIVERY_IDS.has(c.id))
        .map(c => c.description)
        .join('; ');
}

async function main(): Promise<void> {

console.log('\n=== S47-1 — reproduz o incidente exato: único critério satisfeito é auto-delivery ===');
{
    const criteria: SuccessCriterion[] = [
        { id: AUTO_DELIVERY_CRITERION_IDS.send_audio, description: 'Entrega confirmada via send_audio', check: 'tool_succeeded', tool: 'send_audio', status: 'met' },
    ];
    const summary = buildSummary(criteria);
    assert(summary === '', 'summary fica vazio (não "Entrega confirmada via send_audio") — o fallback genérico assume, sem vazar nome de tool interno', summary);
}

console.log('\n=== S47-2 — mesmo com send_document, o rótulo interno não vaza ===');
{
    const criteria: SuccessCriterion[] = [
        { id: AUTO_DELIVERY_CRITERION_IDS.send_document, description: 'Entrega confirmada via send_document', check: 'tool_succeeded', tool: 'send_document', status: 'met' },
    ];
    const summary = buildSummary(criteria);
    assert(!summary.includes('send_document'), 'nome da tool "send_document" não aparece no summary', summary);
    assert(summary === '', 'summary vazio força o fallback genérico em português natural', summary);
}

console.log('\n=== S47-3 — critérios REAIS (não auto-injetados) continuam aparecendo no summary — sem regressão ===');
{
    const criteria: SuccessCriterion[] = [
        { id: 'user_criterion_1', description: 'Preço do Bitcoin coletado com sucesso', check: 'tool_succeeded', tool: 'crypto_analysis', status: 'met' },
        { id: AUTO_DELIVERY_CRITERION_IDS.send_audio, description: 'Entrega confirmada via send_audio', check: 'tool_succeeded', tool: 'send_audio', status: 'met' },
    ];
    const summary = buildSummary(criteria);
    assert(summary === 'Preço do Bitcoin coletado com sucesso', 'critério real (não auto-delivery) continua no summary; só o rótulo interno é excluído', summary);
}

console.log('\n=== S47-4 — critério não satisfeito (status != met) continua excluído — sem regressão ===');
{
    const criteria: SuccessCriterion[] = [
        { id: 'user_criterion_1', description: 'Critério pendente', check: 'tool_succeeded', tool: 'crypto_analysis', status: 'pending' },
        { id: AUTO_DELIVERY_CRITERION_IDS.send_audio, description: 'Entrega confirmada via send_audio', check: 'tool_succeeded', tool: 'send_audio', status: 'met' },
    ];
    const summary = buildSummary(criteria);
    assert(summary === '', 'critério pending não entra no summary, e o auto-delivery met é filtrado — resultado vazio', summary);
}

console.log('\n=== S47-5 — fix presente estruturalmente em GoalExecutionLoop.ts ===');
{
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalExecutionLoop.ts'), 'utf-8');
    assert(
        /AUTO_DELIVERY_IDS = new Set\(Object\.values\(AUTO_DELIVERY_CRITERION_IDS\)/.test(source),
        'evaluateCriteria() constrói o Set de exclusão a partir de AUTO_DELIVERY_CRITERION_IDS',
    );
    assert(
        /filter\(c => c\.status === 'met' && !AUTO_DELIVERY_IDS\.has\(c\.id\)\)/.test(source),
        'o filtro do summary exclui explicitamente os IDs de auto-delivery',
    );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S47 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S47 erro inesperado:', err);
    process.exitCode = 1;
});
