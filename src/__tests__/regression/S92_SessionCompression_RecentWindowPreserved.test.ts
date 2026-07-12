/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S92
 * Compressão de sessão apagava a janela de mensagens recentes (maxContextMessages) em vez de
 * preservá-la — não resumida, não visível, simplesmente descartada do contexto do LLM.
 *
 * BUG REAL (auditoria 11/07/2026, sessão telegram:8071707790, log_conversa_newclaw.txt +
 * newclaw-audit.log): usuário perguntou sobre ações da NVIDIA; assistente respondeu apenas
 * "Vou buscar informações atualizadas agora." (web_search rodou mas a resposta não usou o
 * resultado — ver S93). 7 minutos depois o usuário respondeu (via reply do Telegram) "Conseguiu
 * fazer isso?". SessionManager.maybeCompress() disparou exatamente nesse turno (10 mensagens
 * acumuladas, threshold=10). O log mostrou `SessionContext: ... 1 recent msgs` — quando deveria
 * haver ~6 (maxContextMessages). O modelo, sem esse anchor, executou uma tarefa antiga não
 * relacionada (reenviou um .pptx de aula de redes) em vez de responder sobre a NVIDIA.
 *
 * Causa raiz (confirmada por leitura de código, dois bugs coordenados):
 *   1. SessionManager.maybeCompress(): `checkpoint.seq = transcript.getSeq()` usava o seq mais
 *      recente de TODO o transcript (a última mensagem do assistente que acabou de responder),
 *      não o seq da última mensagem efetivamente incluída no resumo (`messagesToCompress`).
 *   2. SessionTranscript.getSinceCheckpoint(): usava o seq da PRÓPRIA entrada de checkpoint
 *      (sempre a mais alta do arquivo, já que só pode ser anexada no fim de um log append-only)
 *      como limite de replay, em vez do `compressed_up_to` gravado no meta da entrada.
 * Combinados: toda a janela de `maxContextMessages` (as mensagens recentes que deveriam
 * continuar visíveis SEM compressão) ficava com seq ≤ limite usado — tratada como "já
 * compactada" mesmo nunca tendo sido passada ao sumarizador.
 *
 * Fix: `checkpoint.seq` passa a ser o seq da última mensagem em `messagesToCompress` (que agora
 * também é fatiado de `userAssistantMessages`, não de `entries` bruto — 2º bug adjacente:
 * entries inclui tool_call/tool_result intercalados, então fatiar por lá não seleciona as N
 * mensagens de conversa mais antigas de forma confiável). getSinceCheckpoint() passa a usar
 * `compressedUpTo` (gravado no índice a partir do meta da entrada) como limite de replay.
 *
 * Escopo tocado: session/SessionManager.ts (maybeCompress), session/SessionTranscript.ts
 * (SessionIndex.checkpoints + appendSync + getSinceCheckpoint + rebuildIndex).
 *
 * Execução: npx ts-node src/__tests__/regression/S92_SessionCompression_RecentWindowPreserved.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';
import { SessionTranscript } from '../../session/SessionTranscript';
import { SessionManager } from '../../session/SessionManager';
import { MemoryManager } from '../../memory/MemoryManager';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function main(): Promise<void> {

// ── Parte 1: SessionTranscript isolado — mecanismo central do fix ──────────────────────────
console.log('\n=== S92-1 — SessionTranscript.getSinceCheckpoint() usa compressed_up_to, não o seq da própria entrada de checkpoint ===');
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s92-transcript-'));
    const t = new SessionTranscript(dir, 'test-session-1');
    await t.init();

    const seqU1 = t.append('user', 'pergunta antiga 1');
    const seqA1 = t.append('assistant', 'resposta antiga 1');
    const seqU2 = t.append('user', 'pergunta recente que deve continuar visível');
    const seqA2 = t.append('assistant', 'Vou buscar informações atualizadas agora.');

    // Simula exatamente o que maybeCompress() faz agora: resume só as 2 mais antigas
    // (seqU1/seqA1), e a entrada de checkpoint é anexada DEPOIS das recentes (seqU2/seqA2) —
    // mas o limite de replay (compressed_up_to) aponta pra seqA1, não pro seq da própria
    // entrada de checkpoint.
    t.append('checkpoint', 'Resumo: pergunta antiga 1 / resposta antiga 1', {
        checkpoint: true,
        compressed_up_to: seqA1,
    });
    // append() só enfileira no write stream (I/O em buffer) — replay()/getSinceCheckpoint()
    // leem o arquivo em disco via fs.createReadStream, então precisam do flush explícito antes
    // de ler o que acabou de ser escrito. Produção convive com isso porque normalmente há
    // trabalho assíncrono real (chamada de LLM) entre gravar e ler; um teste síncrono/rápido
    // como este expõe a corrida se não flusha.
    await t.flush();

    const { entries } = await t.getSinceCheckpoint();
    const contents = entries.map(e => e.content);

    assert(!contents.includes('pergunta antiga 1'), 'mensagem resumida NÃO aparece nas entradas "since checkpoint" (foi pro resumo)', contents);
    assert(contents.includes('pergunta recente que deve continuar visível'), 'mensagem recente (seq > compressed_up_to) continua visível', contents);
    assert(contents.includes('Vou buscar informações atualizadas agora.'), 'segunda mensagem recente também continua visível', contents);
    assert(seqU2 > seqA1 && seqA2 > seqA1, 'sanity: seqs recentes realmente são maiores que compressed_up_to', { seqU1, seqA1, seqU2, seqA2 });
    await t.close(); // fecha o write stream — sem isso o processo do teste nunca encerra sozinho
}

console.log('\n=== S92-2 — compatibilidade retroativa: checkpoint antigo sem compressed_up_to cai no fallback (seq da própria entrada) ===');
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s92-legacy-'));
    const t = new SessionTranscript(dir, 'test-session-legacy');
    await t.init();

    t.append('user', 'msg 1');
    t.append('assistant', 'msg 2');
    // Checkpoint SEM compressed_up_to (formato antigo, pré-fix) — não deve quebrar.
    t.append('checkpoint', 'resumo antigo', { checkpoint: true });
    t.append('user', 'msg 3 pós-checkpoint');
    await t.flush();

    const { entries } = await t.getSinceCheckpoint();
    assert(entries.some(e => e.content === 'msg 3 pós-checkpoint'), 'checkpoint sem compressed_up_to ainda funciona (usa o próprio seq como limite)', entries.map(e => e.content));
    await t.close();
}

// ── Parte 2: SessionManager end-to-end — reprodução fiel do incidente real ─────────────────
console.log('\n=== S92-3 — SessionManager.maybeCompress(): janela recente sobrevive à compressão (reprodução do incidente real, escala reduzida) ===');
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s92-sm-'));
    const db = new (Database as any)(':memory:');
    const memoryManager = new MemoryManager(db);
    const sessionManager = new SessionManager(
        {
            transcriptDir: dir,
            maxUncompressedMessages: 6, // dispara compressão com 6 msgs user/assistant
            maxContextMessages: 4,      // mantém as 4 mais recentes sem compressão
            maxUncompressedTokens: 1_000_000, // alto o suficiente pra só o gatilho de contagem importar
            maxMessageChars: 1500,
        },
        memoryManager,
        // sem providerFactory → contextCompressor=null → usa fallbackSummary() determinístico,
        // sem chamada de LLM (mesmo padrão de teste rápido/determinístico do resto da suíte).
    );

    const key = { channel: 'telegram', userId: 'test-user-s92' };

    // Mesmo motivo do flush em S92-1/S92-2: leituras (inclusive as que maybeCompress() faz
    // internamente pra decidir se compacta) vão ao arquivo em disco, escritas ficam em buffer
    // no write stream. Produção sobrevive sem flush explícito aqui porque há segundos/minutos
    // de trabalho real (chamada de LLM) entre gravar e ler; este teste roda tudo em sequência
    // apertada, então precisa flushar após CADA gravação pra não confundir a corrida com o bug
    // real que este teste quer provar.
    const rawTranscript = await sessionManager.getOrCreateSession(key);
    async function recordUser(text: string) { await sessionManager.recordUserMessage(key, text); await rawTranscript.flush(); }
    async function recordAssistant(text: string) { await sessionManager.recordAssistantMessage(key, text); await rawTranscript.flush(); }

    // 3 trocas completas (6 mensagens) — u1/a1 são as "antigas" que devem ser resumidas.
    await recordUser('u1: pergunta sobre NVIDIA');
    await recordAssistant('a1: resposta genérica sem dados recentes');
    await recordUser('u2: pergunta se a resposta é recente');
    await recordAssistant('a2: Vou buscar informações atualizadas agora.');
    await recordUser('u3: outro assunto qualquer');
    await recordAssistant('a3: resposta sobre outro assunto');

    // 4ª pergunta do usuário — dispara maybeCompress() ANTES de ser anexada (mesma ordem real,
    // ver comentário em recordUserMessage). Equivalente a "Conseguiu fazer isso?" no incidente.
    await recordUser('u4: Conseguiu fazer isso?');

    const { messages } = await sessionManager.buildContext(key, 'system prompt');
    const contents = messages.filter(m => m.role === 'user' || m.role === 'assistant').map(m => m.content);

    assert(
        contents.length >= 5,
        `janela recente preservada: pelo menos 5 mensagens visíveis (u2,a2,u3,a3,u4), obtido ${contents.length}`,
        contents,
    );
    assert(
        contents.some(c => c.includes('Vou buscar informações atualizadas agora')),
        'a resposta-âncora ("vou buscar agora") que o usuário está perguntando sobre CONTINUA no contexto — este é o anchor que faltava no incidente real',
        contents,
    );
    assert(
        contents.some(c => c.includes('u4: Conseguiu fazer isso')),
        'a mensagem atual do usuário está presente',
        contents,
    );
    assert(
        !contents.some(c => c.includes('u1: pergunta sobre NVIDIA')),
        'a mensagem realmente antiga (u1) foi corretamente resumida, não vazou pro replay bruto',
        contents,
    );

    const summary = sessionManager.getCheckpointSummary(key);
    assert(!!summary && summary.includes('u1'), 'o resumo do checkpoint cobre a mensagem antiga (u1)', summary);

    await sessionManager.closeSession(key); // fecha o write stream do transcript real
    db.close();
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S92 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);

}

main()
    .catch((err) => {
        console.error('S92 erro inesperado:', err);
        failed++;
    })
    .finally(() => {
        // Garante encerramento do processo mesmo se algum handle (timer/stream) escapou dos
        // closes explícitos acima — spawnSync (runner da suíte) espera o processo TERMINAR, não
        // só parar de imprimir, então qualquer handle aberto trava a suíte inteira em silêncio.
        process.exit(failed > 0 ? 1 : 0);
    });
