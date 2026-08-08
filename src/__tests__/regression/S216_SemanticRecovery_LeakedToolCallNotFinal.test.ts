/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S216
 *
 * Origem: incidente "River" (08/08/2026, validação em execução real, Ollama local com
 * gemma4:e4b-it-qat). O sistema OBTEVE o dado correto e o descartou:
 *
 *   14:01:29  crypto_analysis ✓  → "River (RIVER) | Preço: $2,93 | MCap: $57.42M"
 *   14:01:41  o modelo respondeu, como `content`, 104 chars:
 *             ```json[{"tool": "web_search","parameters": {"query": "..."}}]```
 *             → strictParse falhou → semanticRecovery promoveu a final_answer
 *             → FSM THINKING --FINAL_READY--> DONE, turno encerrado
 *   14:09:27  goal falhou; a resposta ao usuário foi "Não consegui completar"
 *
 * O preço nunca chegou a `goal.attempts`: o `output` gravado foi o próprio JSON.
 *
 * CAUSA: nenhum dos quatro reconhecedores de tool-call do sistema cobre o par de chaves
 * `tool`+`parameters` —
 *   - `action.type='tool'` + `name` + `input`  (ProtocolParser.normalizeToStructured)
 *   - `"function_call"` + `"name"`, e DSML     (ProtocolParser.hasNativeToolCallStructure)
 *   - `name` + `arguments`                      (ProviderFactory.extractLeakedToolCalls)
 * — então o conteúdo caiu no ramo de `final_answer`.
 *
 * CORREÇÃO: quarta guarda em semanticRecovery, via looksLikeLeakedToolCall(), sobre o JSON
 * já parseado por attemptJsonParse(). O nome da função é deliberado: ela detecta
 * **estruturas que parecem tool-call vazada e que não devem ser promovidas a resposta
 * final** — NÃO é um parser de tool-call, não valida protocolo e não habilita execução.
 * O formato `tool`+`parameters` continua NÃO sendo protocolo NewClaw.
 *
 * PRECEDENTE: S43 (05/07/2026) cobriu a mesma FAMÍLIA de falha para outro formato
 * (`action.type='tool'`), e corrigiu na camada certa — lá o strictParse já classificava
 * corretamente e o defeito estava em extractFinalText. Aqui o defeito é do próprio parser,
 * numa camada anterior. São irmãos, não recorrência de um fix incompleto.
 *
 * Escopo tocado: loop/ProtocolParser.ts (uma guarda + um predicado privado). Nada mais.
 *
 * Execução: npx ts-node src/__tests__/regression/S216_SemanticRecovery_LeakedToolCallNotFinal.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { ProtocolParser } from '../../loop/ProtocolParser';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

function novoParser(): ProtocolParser {
    const p = new ProtocolParser();
    p.setProviderContext('ollama', 'gemma4:e4b-it-qat');
    return p;
}

/** Conteúdo LITERAL do incidente, recuperado do attempt gravado em data/newclaw.db. */
const CONTEUDO_RIVER = '```json[{"tool": "web_search","parameters": {"query": "ticker valor criptomoeda River preço atual"}}]```';

console.log('\n=== S216-1 — o JSON de 104 chars do incidente não vira mais final_answer ===');
{
    const r = novoParser().strictParse(CONTEUDO_RIVER, false);
    assert(CONTEUDO_RIVER.length === 104, 'pré-condição: é o conteúdo de 104 chars do incidente', CONTEUDO_RIVER.length);
    assert(r?.type === 'planning', 'classificado como planning (era final_answer)', r?.type);
    assert(r?.isComplete === false, 'isComplete=false — o turno NÃO pode encerrar aqui', r?.isComplete);
    assert(r?.metadata?.recoveryNeeded === true, 'recoveryNeeded=true — usa o mecanismo de recovery já existente', r?.metadata);
    assert(r?.metadata?.protocolViolation === true, 'protocolViolation=true — AgentLoop:3406 não polui lastBestContent', r?.metadata);
    // A propriedade que de fato importa: FINAL_READY/commitResponse exige final_answer OU
    // isComplete===true, e ambos estão negados acima (AgentLoop.ts:3454-3461).
    const dispararia = (r?.type === 'final_answer' || r?.isComplete === true) && r?.isComplete !== false;
    assert(!dispararia, 'não satisfaz mais a condição de FINAL_READY/commitResponse do AgentLoop', dispararia);
}

console.log('\n=== S216-2 — DEVE disparar recovery (estruturas de tool-call vazada) ===');
{
    const casos: Array<[string, string]> = [
        ['array (forma do incidente)', '[{"tool":"web_search","parameters":{"query":"River price"}}]'],
        ['objeto único',               '{"tool":"web_search","parameters":{"query":"River price"}}'],
        // Já reconhecida por ProviderFactory.extractLeakedToolCalls noutro caminho — aqui
        // garante que a guarda cobre a família, não só o par de chaves do incidente.
        ['name + arguments',           '{"name":"web_search","arguments":{"query":"River price"}}'],
    ];
    for (const [rotulo, c] of casos) {
        const r = novoParser().strictParse(c, false);
        assert(r?.type === 'planning' && r?.metadata?.recoveryNeeded === true,
            `${rotulo}: vai para recovery`, { type: r?.type, meta: r?.metadata });
    }
}

console.log('\n=== S216-3 — NÃO deve disparar recovery (JSON legítimo e prosa) ===');
{
    // Sem estes casos a guarda seria "qualquer JSON fora do protocolo é violação", que
    // transformaria resposta legítima em recovery. A conjunção nome+args é o que separa.
    const casos: Array<[string, string]> = [
        ['preço puro',                   '{"price":2.93,"currency":"USD"}'],
        ['lista de moedas',              '[{"name":"River","price":2.93}]'],
        ['tool sem parameters',          '{"tool":"web_search"}'],
        ['parameters sem tool',          '{"parameters":{"query":"River"}}'],
        ['mensagem citando as palavras', '{"message":"The tool parameters were incorrect."}'],
        ['prosa citando as palavras',    'Uma tool-call tem os campos tool e parameters, mas isto aqui é apenas prosa explicativa sobre o assunto.'],
    ];
    for (const [rotulo, c] of casos) {
        const r = novoParser().strictParse(c, false);
        assert(r?.type === 'final_answer',
            `${rotulo}: preserva o comportamento atual (final_answer)`, r?.type);
    }
}

console.log('\n=== S216-4 — protocolo NewClaw legítimo segue pelo caminho normal ===');
{
    const valido = JSON.stringify({
        thought: 'preciso do preço',
        action: { type: 'tool', name: 'web_search', input: { query: 'River price' } },
    });
    const r = novoParser().strictParse(valido, false);
    assert(r?.type === 'tool_call', 'classificado por normalizeToStructured, não pela recuperação semântica', r?.type);
    assert(r?.metadata?.protocolViolation !== true, 'não é marcado como violação de protocolo', r?.metadata);
}

console.log('\n=== S216-5 — a correção NÃO transforma o formato em protocolo executável ===');
{
    const r = novoParser().strictParse(CONTEUDO_RIVER, false);
    assert(r?.type !== 'tool_call', 'não é convertido para tool_call', r?.type);
    assert(!('toolCalls' in (r ?? {})) || (r as { toolCalls?: unknown[] }).toolCalls === undefined,
        'nenhuma toolCall é extraída — a estrutura não vira algo executável', (r as { toolCalls?: unknown[] })?.toolCalls);

    const src = fs.readFileSync(path.join(__dirname, '../../loop/ProtocolParser.ts'), 'utf-8');
    assert(/private looksLikeLeakedToolCall\(/.test(src),
        'o predicado tem nome próprio que declara ser detecção de VAZAMENTO, não parsing');
    // Guarda contra reintrodução de heurística por substring (a que a S43 já provou não escalar).
    const corpo = src.slice(src.indexOf('private looksLikeLeakedToolCall('), src.indexOf('SEMANTIC RECOVERY —'));
    assert(!/includes\(|indexOf\(|test\(/.test(corpo),
        'o predicado opera sobre o JSON parseado — nenhuma checagem por substring/regex');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S216 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
