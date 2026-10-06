/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S339 (issue 060)
 *
 * 06/10/2026, goal_1791302526056_qofd0: a etapa do agente (kimi-k2.6:cloud) leu o anexo e respondeu "3" em texto
 * puro, fora do protocolo — geração COMPLETA. `semanticRecovery` decidia pelo tamanho (< MIN_FINAL_ANSWER_LENGTH →
 * "fragmento de timeout" → planning); o AgentLoop girou até cair em "Não consegui completar". Fragmento de timeout é
 * FATO do provedor (stream abortado, sem 'done', corte por limite), não do comprimento: agora o provedor registra
 * `interrupted`, e o parser só usa o tamanho quando o provedor não registra.
 *
 * REGRESSÃO SE: resposta curta de geração completa voltar a ser planning; fragmento de geração interrompida virar
 * final_answer; provedor que não registra mudar de comportamento; os guards de vazamento deixarem de valer.
 *
 * Execução: npx ts-node src/__tests__/regression/S339_ProtocolParser_CompleteShortAnswerIsFinal.test.ts
 */
import { ProtocolParser } from '../../loop/ProtocolParser';
import { extractFinalText, parseLLMResponse } from '../../loop/agentOutputParser';
import { OllamaProvider } from '../../core/OllamaProvider';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const parser = new ProtocolParser();
const parse = (c: string, interrupted?: boolean) => parser.strictParse(c, false, interrupted);

console.log('\n=== S339-1 — geração completa: resposta curta é final_answer ===');
for (const r of ['3', 'sim', 'R$ 42', 'Não.']) {
    const s = parse(r, false);
    assert(s?.type === 'final_answer' && s.isComplete === true && s.content === r, `"${r}" (interrupted=false) → final_answer`, s);
}

console.log('\n=== S339-2 — geração interrompida: fragmento continua planning, de qualquer tamanho ===');
assert(parse('3', true)?.type === 'planning', '"3" (interrupted=true) → planning');
const longo = 'Segue a análise completa do arquivo, item por item, com as observações relevantes. '.repeat(3);
assert(parse(longo, true)?.type === 'planning', `${longo.length} chars (interrupted=true) → planning`);

console.log('\n=== S339-3 — provedor não registra: comportamento anterior (limiar de tamanho) ===');
assert(parse('3')?.type === 'planning', '"3" (undefined) → planning, como antes');
assert(parse('Resposta com mais de dez caracteres.')?.type === 'final_answer', '≥ limiar (undefined) → final_answer, como antes');

console.log('\n=== S339-4 — guards de vazamento valem mesmo com geração completa ===');
assert(parse('Preciso ler o arquivo antes de responder.', false)?.type === 'planning', 'raciocínio auto-dirigido → planning');
assert(parse('{"thought":"x","foo":1}', false)?.type === 'planning', 'JSON interno (thought) → planning');
assert(parse('[{"tool":"web_search","parameters":{"query":"x"}}]', false)?.type === 'planning', 'tool-call vazada → planning');

console.log('\n=== S339-5 — o texto entregue é o "3" ===');
{
    const response = { status: 'success', content: '3', attempts: [], interrupted: false } as any;
    const finalText = extractFinalText(response, parseLLMResponse('3'));
    assert(finalText === '3', 'extractFinalText devolve "3"', finalText);
}

console.log('\n=== S339-6 — OllamaProvider registra o fato de interrupção ===');
async function consume(chunks: Array<Record<string, unknown>>, throwAtEnd = false): Promise<boolean | undefined> {
    const p = new OllamaProvider('http://localhost:11434', 'm', '') as any;
    p.streamChat = async function* () {
        for (const c of chunks) yield c;
        if (throwAtEnd) throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    };
    return (await p._consumeStream([], undefined, 1000)).interrupted;
}
const done = (reason?: string) => ({ type: 'done', value: { prompt_tokens: 1, completion_tokens: 1, done_reason: reason } });

async function main(): Promise<void> {
    assert(await consume([{ type: 'content', value: '3' }, done('stop')]) === false, 'content + done(stop) → interrupted=false');
    assert(await consume([{ type: 'content', value: '3' }]) === true, 'stream sem done → interrupted=true');
    assert(await consume([{ type: 'content', value: 'fragm' }, done('length')]) === true, 'done(length) → interrupted=true');
    assert(await consume([{ type: 'content', value: 'fragm' }], true) === true, 'abort com conteúdo parcial → interrupted=true');

console.log(`\n${'─'.repeat(60)}`);
console.log(`S339 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
}

main().catch((err) => { console.error('S339 erro inesperado:', err); process.exitCode = 1; });
