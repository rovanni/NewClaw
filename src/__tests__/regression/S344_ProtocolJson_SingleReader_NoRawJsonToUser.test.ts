/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S344 (issue 065b)
 *
 * 06/10/2026, teste pelo painel (glm-5.3): o modelo devolveu o protocolo `{"thought":…,"action":{"type":"final_answer",
 * "content":"…"}}` com QUEBRAS DE LINHA CRUAS e ASPAS CRUAS ("frio penetrating") dentro das strings — JSON inválido. Duas
 * leituras divergiam: o ProtocolParser (decide o rumo do turno) caiu na extração parcial e encerrou como final_answer; o
 * `parseLLMResponse` (de onde sai o texto entregue) devolveu null — e o usuário viu o JSON interno inteiro na tela.
 * Produção: 4 respostas assim entregues (maio–julho). Agora há UMA leitura (`parseProtocolJson`), usada pelas duas.
 *
 * REGRESSÃO SE: as duas leituras voltarem a divergir; o JSON do protocolo voltar a ser entregue como texto; um JSON
 * válido mudar de leitura; uma tool-call virar resposta final.
 *
 * Execução: npx ts-node src/__tests__/regression/S344_ProtocolJson_SingleReader_NoRawJsonToUser.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseProtocolJson, parseLLMResponse, extractFinalText } from '../../loop/agentOutputParser';
import { ProtocolParser } from '../../loop/ProtocolParser';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const entregue = (raw: string) => extractFinalText({ status: 'success', content: raw, attempts: [] } as any, parseLLMResponse(raw));

// Forma exata do caso real (texto sintético): quebras de linha e aspas cruas dentro do "content".
const CONTEUDO = '**Tempo agora em Curitiba** 🌧️\n\n- Chuvisco leve, com 13.3°C\n- Umidade relativa em 99%\n\nEm dias frios e úmidos, a sensação de "frio penetrante" é maior. 🌡️';
const REAL = '{\n  "thought": "A ferramenta weather já retornou os dados.",\n  "action": {\n    "type": "final_answer",\n    "content": "' + CONTEUDO + '"\n  },\n  "evaluation": {\n    "is_complete": true,\n    "confidence": "high",\n    "reason": "Dados obtidos."\n  }\n}';

console.log('\n=== S344-1 — caso real: JSON com quebras de linha e aspas cruas ===');
{
    let invalido = false; try { JSON.parse(REAL); } catch { invalido = true; }
    assert(invalido, 'pré-condição: o texto é JSON inválido');
    const p = parseProtocolJson(REAL);
    assert(p?.action?.type === 'final_answer' && p.action.content === CONTEUDO, 'parseProtocolJson lê o content inteiro, com aspas e quebras de linha', p?.action?.content);
    const s = new ProtocolParser().strictParse(REAL, false, false);
    const texto = entregue(REAL);
    assert(s?.type === 'final_answer', 'ProtocolParser decide final_answer');
    assert(texto === CONTEUDO, 'o texto entregue é o content — não o JSON do protocolo', texto.slice(0, 80));
    assert(!texto.includes('"thought"') && !texto.includes('"action"'), 'nada do protocolo chega ao usuário');
}

console.log('\n=== S344-2 — JSON válido: leitura inalterada ===');
{
    const v = '{"thought":"ok","action":{"type":"final_answer","content":"Linha 1\\nLinha \\"2\\""}}';
    assert(JSON.stringify(parseProtocolJson(v)) === JSON.stringify(JSON.parse(v)), 'mesmo objeto de JSON.parse');
    assert(entregue(v) === 'Linha 1\nLinha "2"', 'texto entregue com escapes já corretos');
    const cercado = 'Aqui está:\n```json\n{"action":{"type":"final_answer","content":"Chaves {dentro} da string"}}\n```';
    assert(parseProtocolJson(cercado)?.action?.content === 'Chaves {dentro} da string', 'bloco cercado por ```json, com chaves dentro de string');
}

console.log('\n=== S344-3 — tool-call com quebras de linha cruas não vira resposta final ===');
{
    const tool = '{\n  "thought": "Vou ler o arquivo.",\n  "action": {"type": "tool", "name": "read", "input": {"path": "notas.txt"}}\n}';
    assert(parseProtocolJson(tool)?.action?.type === 'tool', 'lida como tool');
    assert(entregue(tool) === '', 'nenhum texto entregue para uma tool-call');
}

console.log('\n=== S344-4 — fonte única: o ProtocolParser usa o mesmo leitor ===');
{
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'ProtocolParser.ts'), 'utf-8');
    const metodo = src.slice(src.indexOf('private attemptJsonParse('), src.indexOf('private attemptJsonParse(') + 900);
    assert(/parseProtocolJson\(content\)/.test(metodo), 'attemptJsonParse delega ao parseProtocolJson');
    assert(!/JSON\.parse\(content\.trim\(\)\)/.test(metodo), 'sem leitura própria duplicada');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S344 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
