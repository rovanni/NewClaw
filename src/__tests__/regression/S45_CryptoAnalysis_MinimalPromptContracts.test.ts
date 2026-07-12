/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S45
 * Investigação de log real (05/07/2026, 13:30-13:31, Telegram, goal_1783269002590_inaml —
 * mesmo goal do incidente investigado em [[project_session_bugs_jul2026_y]] / S44): o gatilho
 * de TODA a cascata de replans que terminou em 4 áudios duplicados foi `crypto_analysis`
 * devolvendo dados de moedas completamente diferentes das pedidas (Bitcoin/Ethereum/Dogecoin →
 * "WLD, PEPE, ADA, VVV").
 *
 * Rastreamento revelou dois bugs sistêmicos independentes:
 *
 *   BUG 1 — GoalPlanner.buildMinimalPrompt() (fallback usado quando o prompt completo de
 *   planejamento estoura o orçamento de "thinking" do modelo — confirmado no log: "THINKING
 *   BUDGET exceeded (1682 chars, 60461ms) — aborting" seguido de "plan empty after parse")
 *   listava APENAS os nomes das ferramentas disponíveis, sem NENHUM schema/contrato. O prompt
 *   completo (buildPlanPrompt) já documenta explicitamente via buildToolContracts() que
 *   crypto_analysis com type="detail" exige um único "symbol" e que múltiplas moedas exigem
 *   chamadas separadas — mas essa seção nunca era incluída no prompt reduzido. Sem ela, o LLM
 *   (nesse retry) inventou uma estratégia de "3 moedas em 1 chamada", algo que a tool não
 *   suporta.
 *
 *   BUG 2 — detectMissingRequiredArgs() (GoalPlanner.ts) já valida read/write/edit/
 *   send_document/send_audio/weather/read_document/web_navigate — mas nunca teve entrada para
 *   crypto_analysis, apesar do comentário no prompt já documentar a exigência há tempos. Sem
 *   essa checagem determinística, um plano com type ausente/inválido ou symbol batendo várias
 *   moedas passava direto pra execução: a tool (crypto_analysis.ts) cai num fallback SILENCIOSO
 *   (type inválido → "sangrando", relatório de moedas em queda sem relação com o pedido) em vez
 *   de retornar erro — nada no pipeline detectava que o plano era inválido.
 *
 * Correção: (1) buildMinimalPrompt() agora injeta buildToolContracts() — mesma função usada
 * pelo prompt completo, sem duplicar a lista de schemas; (2) detectMissingRequiredArgs() ganhou
 * uma entrada para crypto_analysis (type deve ser um dos 5 valores válidos; type="detail" exige
 * um único symbol, não uma lista). RiskAnalyzer.ts importa a MESMA função de GoalPlanner.ts —
 * o fix cobre automaticamente tanto o plano inicial quanto a revisão Q2/replan, sem duplicação.
 *
 * Escopo tocado: loop/GoalPlanner.ts (nenhuma tool alterada — crypto_analysis.ts já documentava
 * corretamente seu próprio schema; o gap era só na validação de plano).
 *
 * Execução: npx ts-node src/__tests__/regression/S45_CryptoAnalysis_MinimalPromptContracts.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { detectMissingRequiredArgs } from '../../loop/GoalPlanner';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function main(): Promise<void> {

console.log('\n=== S45-1 — detectMissingRequiredArgs valida crypto_analysis (ausente até este fix) ===');
{
    assert(
        detectMissingRequiredArgs('crypto_analysis', {}) !== null,
        'type ausente é rejeitado (a tool cairia silenciosamente em "sangrando" sem isso)',
    );
    assert(
        detectMissingRequiredArgs('crypto_analysis', { type: 'batch' }) !== null,
        'type fora do enum válido (ex: "batch", inventado por um LLM sem contrato) é rejeitado',
    );
    assert(
        detectMissingRequiredArgs('crypto_analysis', { type: 'detail' }) !== null,
        'type=detail sem symbol é rejeitado',
    );
}

console.log('\n=== S45-2 — reproduz o cenário exato do incidente: symbol com múltiplas moedas ===');
{
    const variants = [
        { type: 'detail', symbol: 'btc,eth,doge' },
        { type: 'detail', symbol: 'btc, eth, doge' },
        { type: 'detail', symbol: 'btc eth doge' },
    ];
    for (const args of variants) {
        const result = detectMissingRequiredArgs('crypto_analysis', args);
        assert(
            result !== null,
            `symbol="${args.symbol}" (batch de moedas, causa raiz do incidente real) é rejeitado — força conversão pra AgentLoop em vez de chegar na tool`,
            result,
        );
    }
}

console.log('\n=== S45-3 — uso legítimo continua passando, sem falso positivo ===');
{
    assert(
        detectMissingRequiredArgs('crypto_analysis', { type: 'detail', symbol: 'btc' }) === null,
        'type=detail com um único symbol (uso correto) não é rejeitado',
    );
    for (const type of ['sangrando', 'gainers', 'losers', 'top100']) {
        assert(
            detectMissingRequiredArgs('crypto_analysis', { type }) === null,
            `type="${type}" (sem symbol, não exigido para este type) não é rejeitado`,
        );
    }
    assert(
        detectMissingRequiredArgs('crypto_analysis', { type: 'DETAIL', symbol: 'BTC' }) === null,
        'case-insensitive: type/symbol em maiúsculas (a tool também normaliza para lowercase) não é rejeitado',
    );
}

console.log('\n=== S45-4 — buildMinimalPrompt() (fallback de thinking-timeout) agora inclui os contratos de tools ===');
{
    const plannerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalPlanner.ts'), 'utf-8');
    const minimalPromptMatch = plannerSource.match(/private buildMinimalPrompt\(goal: Goal\): string \{[\s\S]*?\n    \}/);
    assert(minimalPromptMatch !== null, 'função buildMinimalPrompt encontrada no source');
    const minimalPromptBody = minimalPromptMatch?.[0] ?? '';
    assert(
        /buildToolContracts\(toolNames\)/.test(minimalPromptBody),
        'buildMinimalPrompt chama buildToolContracts() — mesma função do prompt completo, sem duplicar schemas',
        minimalPromptBody,
    );
}

console.log('\n=== S45-5 — RiskAnalyzer.ts importa a MESMA função (fix cobre plano inicial + replan/Q2, sem duplicação) ===');
{
    const riskAnalyzerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'RiskAnalyzer.ts'), 'utf-8');
    // Sem exigir vírgula/outros nomes no mesmo import: o que importa é a origem
    // (GoalPlanner.ts, não uma cópia local), não quais outros símbolos vêm junto — isso mudou
    // em 09/07/2026 quando WRITE_CONTENT_STUB_PATTERNS saiu deste import (substituído por
    // classifyContentStub via shared/contentStubClassifier.ts).
    assert(
        /import \{[^}]*\bdetectMissingRequiredArgs\b[^}]*\} from '\.\/GoalPlanner'/.test(riskAnalyzerSource),
        'RiskAnalyzer importa detectMissingRequiredArgs de GoalPlanner.ts — single source of truth',
    );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S45 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S45 erro inesperado:', err);
    process.exitCode = 1;
});
