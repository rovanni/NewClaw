/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S43
 * Investigação de log real (05/07/2026, 12:36-12:47, Telegram): usuário pediu análise
 * de cripto (BTC, ETH, RIVER, PI) e recebeu como resposta final o JSON de controle
 * interno do modelo, verbatim:
 *
 *   {
 *     "thought": "Já tenho os dados de BTC. Agora preciso de ETH, River e a situação
 *                 do Pi Network para montar o relatório final e gerar o áudio.",
 *     "action": { "type": "tool", "name": "crypto_analysis", "input": {...} },
 *     "evaluation": { "is_complete": false, "confidence": "high", "reason": "..." }
 *   }
 *
 * Rastreamento no audit log (newclaw-audit.log linhas 36757-36819) mostrou a causa exata:
 *   1. Step 3 do turno: o modelo respondeu com esse JSON como `content` (não como
 *      toolCalls[] nativo). ProtocolParser.strictParse corretamente classificou como
 *      type=tool_call, isComplete=false (linha 36763).
 *   2. Mas AgentLoop.ts também chama extractFinalText(response, atomicData) para
 *      popular `lastBestContent` (linha 1502-1509). extractFinalText via
 *      normalizeFromRaw → normalizeResponse reconhece action.type==='tool' e retorna
 *      { type: 'tool', content: action.content || '' } — content vazio, porque chamadas
 *      de tool têm `input`, não `content`. Como normalized.content é vazio, o primeiro
 *      "if" de extractFinalText não bate, e o código caía direto no fallback
 *      `sanitizeContent(response.content)`, que só remove tags <think> — devolvendo o
 *      JSON bruto como se fosse "texto final extraído com sucesso".
 *   3. Esse JSON (451 chars) virou lastBestContent. No 4º tool call idêntico
 *      (crypto_analysis), o SAFETY-GUARD abortou o loop por tool_loop (linha 36780).
 *      O post-loop deveria gerar uma síntese em linguagem natural, mas
 *      `hasGoodContent = lastBestContent.length > 100` já era TRUE (o JSON tem 451
 *      chars) — então o bloco de SYNTHESIS foi pulado (AgentLoop.ts linha 2392) e o
 *      JSON bruto foi commitado direto como resposta ao usuário (linha 2504-2508).
 *
 * Correção: extractFinalText agora reconhece normalized.type === 'tool' explicitamente
 * e retorna '' antes de cair no fallback de sanitizeContent — mesma checagem que já
 * existia em extractText() (ResponseBuilder.ts, linha ~101) para o mesmo cenário, agora
 * espelhada na função irmã. Correção em ponto único (agentOutputParser.ts) que se propaga
 * para os 4 call-sites de extractFinalText em AgentLoop.ts (fast-path linha 459, loop
 * principal linha 1502, synthesis linha 2484, fallback linha 2544) — sem duplicar lógica.
 *
 * Escopo tocado: loop/agentOutputParser.ts.
 *
 * Execução: npx ts-node src/__tests__/regression/S43_ExtractFinalText_ToolCallJsonLeak.test.ts
 */

process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import { extractFinalText } from '../../loop/agentOutputParser';
import { parseLLMResponse } from '../../loop/agentOutputParser';
import type { LLMResult } from '../../core/ProviderFactory';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

function fakeResult(content: string): LLMResult {
    return { content, status: 'success' } as unknown as LLMResult;
}

async function main(): Promise<void> {

console.log('\n=== S43-1 — JSON real do incidente (thought+action tool+evaluation) não vaza mais como texto final ===');
{
    const realIncidentJson = JSON.stringify({
        thought: 'Já tenho os dados de BTC. Agora preciso de ETH, River e a situação do Pi Network para montar o relatório final e gerar o áudio.',
        action: { type: 'tool', name: 'crypto_analysis', input: { type: 'detail', symbol: 'eth' } },
        evaluation: { is_complete: false, confidence: 'high', reason: 'Coletando dados de Ethereum antes de prosseguir para River e Pi.' },
    }, null, 2);

    const response = fakeResult(realIncidentJson);
    const atomicData = parseLLMResponse(realIncidentJson);
    const text = extractFinalText(response, atomicData);

    assert(text === '', 'extractFinalText retorna string vazia para tool_call — não o JSON bruto', text);
    assert(!text.includes('"thought"'), 'texto extraído não contém o campo "thought" do JSON de controle', text);
    assert(!text.includes('"action"'), 'texto extraído não contém o campo "action" do JSON de controle', text);
}

console.log('\n=== S43-2 — tool_call sem "evaluation" (formato mínimo) também não vaza ===');
{
    const minimalToolCall = JSON.stringify({
        action: { type: 'tool', name: 'web_search', input: { query: 'bitcoin price' } },
    });
    const response = fakeResult(minimalToolCall);
    const text = extractFinalText(response, parseLLMResponse(minimalToolCall));
    assert(text === '', 'tool_call minimalista (sem thought/evaluation) também retorna vazio', text);
}

console.log('\n=== S43-3 — final_answer real (action.type=final_answer) continua passando normalmente — sem regressão ===');
{
    const finalAnswerJson = JSON.stringify({
        thought: 'Tenho todos os dados necessários.',
        action: { type: 'final_answer', content: 'Bitcoin está cotado a $65.000, alta de 2% em 24h.' },
        evaluation: { is_complete: true, confidence: 'high' },
    });
    const response = fakeResult(finalAnswerJson);
    const text = extractFinalText(response, parseLLMResponse(finalAnswerJson));
    assert(text === 'Bitcoin está cotado a $65.000, alta de 2% em 24h.', 'final_answer legítimo continua extraindo o content correto', text);
}

console.log('\n=== S43-4 — texto puro (modelo que não usa o protocolo JSON) continua passando direto — sem regressão ===');
{
    const plainText = 'A previsão do tempo para amanhã é de céu limpo, com máxima de 28 graus.';
    const response = fakeResult(plainText);
    const text = extractFinalText(response, parseLLMResponse(plainText));
    assert(text === plainText, 'texto puro (sem JSON) não é afetado pela checagem de tool_call', text);
}

console.log('\n=== S43-5 — content vazio (resposta com apenas toolCalls[] nativos) continua retornando vazio — sem regressão ===');
{
    const response = fakeResult('');
    const text = extractFinalText(response, null);
    assert(text === '', 'content vazio continua extraindo string vazia (fallback de <think>-only não é acionado à toa)', text);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S43 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S43 erro inesperado:', err);
    process.exitCode = 1;
});
