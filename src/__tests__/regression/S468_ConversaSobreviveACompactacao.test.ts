/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S468
 * A conversa some do contexto depois que a sessão é compactada.
 *
 * CASO REAL (VPS, Telegram, 02–03/11/2026): o SessionAutoCleaner compactou telegram:8071707790 em 02/11 às 09:43
 * (1.345.565 → 73.042 bytes). `compactSession()` renumerou as entradas a partir de 1, mas gravou o checkpoint com
 * `compressed_up_to` na numeração ANTIGA (1614) — num arquivo que passou a ir até 104. `getSinceCheckpoint()` só
 * repete o que tem seq > 1614: nada. Todos os turnos seguintes rodaram com "0 recent msgs" (log do SessionContext),
 * só com o resumo velho de 30/10. Em 03/11, depois de gerar a aula 01 em HTML, "Gera em PowerPoint editável" virou
 * "Qual tema ou conteúdo você quer…?" e "E me envia" virou "O que você gostaria que eu enviasse?" — o juiz de
 * suficiência decidiu sem a conversa.
 *
 * Junto, dois cortes que escondiam a conversa mesmo sem a compactação:
 *   - o histórico do agente (ContextBudget) ia da mais antiga para a mais nova e parava quando o orçamento acabava,
 *     deixando de fora justamente as mais recentes;
 *   - o recorte para as decisões antes do agente (MessageBus → classificador, roteador, juiz) eram as 4 últimas
 *     cortadas em 400 caracteres sem aviso — o pedido "poderia criar a aula 01 de 4 horas", no fim de uma ementa de
 *     1.584 caracteres, não chegava.
 *
 * Execução: npx ts-node src/__tests__/regression/S468_ConversaSobreviveACompactacao.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';
import { SessionTranscript } from '../../session/SessionTranscript';
import { SessionManager } from '../../session/SessionManager';
import { MemoryManager } from '../../memory/MemoryManager';
import { DEFAULT_BUDGET, historicoNoOrcamento, mensagemNoLimite, ContextBudget } from '../../loop/ContextBuilder';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function main(): Promise<void> {

console.log('\n=== S468-1 — arquivo deixado pela compactação antiga (limite na numeração velha) não devolve conversa vazia ===');
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s468-legado-'));
    const linhas: string[] = [];
    const ts = '2026-11-02T12:43:10.000Z';
    // A forma exata do arquivo da VPS: checkpoint no seq 1 com o limite 1614 da numeração antiga, um checkpoint copiado
    // no meio (seq 4, mesmo limite), e a conversa de 03/11 depois dele.
    linhas.push(JSON.stringify({ ts, seq: 1, role: 'checkpoint', content: 'Resumo de 30/10: CamScanner em Rust+HTML', meta: { checkpoint: true, compressed_up_to: 1614 } }));
    linhas.push(JSON.stringify({ ts, seq: 2, role: 'user', content: 'mensagem antiga mantida pela compactação' }));
    linhas.push(JSON.stringify({ ts, seq: 3, role: 'assistant', content: 'resposta antiga mantida' }));
    linhas.push(JSON.stringify({ ts, seq: 4, role: 'checkpoint', content: 'Resumo de 30/10', meta: { checkpoint: true, compressed_up_to: 1614 } }));
    linhas.push(JSON.stringify({ ts, seq: 5, role: 'user', content: 'Hoje vou iniciar o curso… poderia criar a aula 01 de 4 horas' }));
    linhas.push(JSON.stringify({ ts, seq: 6, role: 'tool_call', content: 'Tool: write', meta: { tool_name: 'write' } }));
    linhas.push(JSON.stringify({ ts, seq: 7, role: 'assistant', content: 'O arquivo tmp/aula_01_informatica_senac.html foi gerado' }));
    fs.writeFileSync(path.join(dir, 'telegram~s468.jsonl'), linhas.join('\n') + '\n', 'utf-8');

    const t = new SessionTranscript(dir, 'telegram:s468');
    await t.init();
    const { entries } = await t.getSinceCheckpoint();
    const conteudos = entries.map(e => e.content);
    assert(entries.length > 0, 'a conversa depois do checkpoint volta (antes: 0 entradas)', conteudos);
    assert(conteudos.some(c => c.includes('poderia criar a aula 01')), 'o pedido da aula está nas entradas recentes', conteudos);
    assert(conteudos.some(c => c.includes('aula_01_informatica_senac.html')), 'a resposta que gerou o arquivo está nas entradas recentes', conteudos);
    assert(!conteudos.some(c => c === 'mensagem antiga mantida pela compactação'), 'o que vem antes do último checkpoint continua fora (está no resumo)', conteudos);
    await t.close();
}

console.log('\n=== S468-2 — compactSession() preserva a numeração e grava um limite que existe no arquivo ===');
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s468-compacta-'));
    const db = new (Database as any)(':memory:');
    const memoryManager = new MemoryManager(db);
    const sm = new SessionManager(
        { transcriptDir: dir, maxUncompressedMessages: 6, maxContextMessages: 4, maxUncompressedTokens: 1_000_000, maxMessageChars: 1500 },
        memoryManager,
    );
    const key = { channel: 'telegram', userId: 's468-compacta' };
    const transcript = await sm.getOrCreateSession(key);
    const gravar = async (papel: 'user' | 'assistant', texto: string) => {
        if (papel === 'user') await sm.recordUserMessage(key, texto); else await sm.recordAssistantMessage(key, texto);
        await transcript.flush();
    };
    // Histórico longo o bastante para os seqs ficarem bem acima do que a renumeração produziria.
    for (let i = 1; i <= 12; i++) {
        await gravar('user', `u${i}`);
        await gravar('assistant', `a${i}`);
    }
    await gravar('user', 'Gera em PowerPoint editável');

    const antes = (await sm.buildContext(key, '')).messages.filter(m => m.role === 'user' || m.role === 'assistant');
    const seqDaUltima = antes[antes.length - 1]?.seq;

    await sm.compactSession(key);

    const depois = (await sm.buildContext(key, '')).messages.filter(m => m.role === 'user' || m.role === 'assistant');
    assert(depois.length === antes.length && depois.length > 0, `as mesmas mensagens recentes antes e depois da compactação (${antes.length} → ${depois.length})`, depois.map(m => m.content));
    assert(depois[depois.length - 1]?.seq === seqDaUltima, `a numeração original é mantida (seq ${seqDaUltima} → ${depois[depois.length - 1]?.seq})`);

    const novo = await sm.getOrCreateSession(key);
    await sm.recordAssistantMessage(key, 'Qual apresentação?');
    await novo.flush();
    await sm.recordUserMessage(key, 'E me envia');
    await novo.flush();
    const aposNova = (await sm.buildContext(key, '')).messages.map(m => m.content);
    assert(aposNova.includes('Gera em PowerPoint editável') && aposNova.includes('E me envia'), 'a conversa continua visível nas mensagens gravadas depois da compactação', aposNova);

    const idx = JSON.parse(fs.readFileSync(path.join(dir, 'telegram~s468-compacta.idx.json'), 'utf-8')) as { checkpoints: Array<{ seq: number; compressedUpTo?: number }> };
    const ultimo = idx.checkpoints[idx.checkpoints.length - 1];
    assert(!!ultimo && (ultimo.compressedUpTo ?? 0) <= ultimo.seq, 'o limite gravado não passa do seq do próprio checkpoint (invariante)', ultimo);
    await sm.closeSession(key);
    db.close();
}

console.log('\n=== S468-3 — o histórico no orçamento fica com as MAIS NOVAS, em ordem cronológica ===');
{
    const longas = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i + 1} ` + 'x'.repeat(1400) }));
    const escolhidas = historicoNoOrcamento(longas, DEFAULT_BUDGET);
    const ids = escolhidas.map(m => m.content.slice(0, 3).trim());
    assert(ids[ids.length - 1] === 'm6', 'a mais recente (m6) sempre entra', ids);
    assert(!ids.includes('m1') || ids.length === 6, 'quando falta orçamento, quem sai é a mais antiga', ids);
    assert(ids.join(',') === [...ids].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))).join(','), 'ordem cronológica preservada', ids);

    const blocos = new ContextBudget().buildMessages({ systemPrompt: 'sistema', recentMessages: longas, currentUserMessage: 'atual' });
    assert(blocos.some(b => b.content.startsWith('m6 ')), 'o ContextBudget do agente usa a mesma regra (m6 presente)', blocos.map(b => b.content.slice(0, 4)));
}

console.log('\n=== S468-4 — mensagem longa: corte declarado e o fim (onde estava o pedido) preservado ===');
{
    const ementa = 'Hoje vou iniciar o curso!\n' + 'Conteúdo programático: Windows, Word, Excel, Internet. '.repeat(28) + '\npoderia criar a aula 01 de 4 horas';
    const r = mensagemNoLimite(ementa, DEFAULT_BUDGET.maxMessageChars);
    assert(ementa.length > DEFAULT_BUDGET.maxMessageChars, `sanity: a mensagem passa do limite (${ementa.length} > ${DEFAULT_BUDGET.maxMessageChars})`);
    assert(r.length <= DEFAULT_BUDGET.maxMessageChars, `o resultado cabe no limite (${r.length})`);
    assert(r.startsWith('Hoje vou iniciar o curso!'), 'o começo é mantido');
    assert(r.endsWith('poderia criar a aula 01 de 4 horas'), 'o fim — o pedido — é mantido');
    assert(/\[corte do sistema: trecho do meio omitido — \d+ de \d+ caracteres mostrados\]/.test(r), 'o corte vem declarado no texto', r.slice(0, 200));
    assert(mensagemNoLimite('curta', 1500) === 'curta', 'mensagem dentro do limite passa intacta');
}

console.log('\n=== S468-5 — MessageBus manda às decisões a conversa pela mesma regra do agente, não 4 × 400 caracteres ===');
{
    const src = fs.readFileSync(path.join(__dirname, '../../channels/MessageBus.ts'), 'utf-8');
    assert(!src.includes('m.content.slice(0, 400)'), 'o corte silencioso de 400 caracteres saiu');
    assert(/historicoNoOrcamento\(/.test(src), 'o recorte usa historicoNoOrcamento (fonte única com o ContextBudget)');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S468 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
}

main()
    .catch((err) => { console.error('S468 erro inesperado:', err); failed++; })
    .finally(() => { process.exit(failed > 0 ? 1 : 0); });
