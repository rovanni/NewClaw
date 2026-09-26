/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S304 (issue 048, achado em execução real)
 * Apagar a conversa (`DELETE /api/conversations` → `deleteAllWebConversations`) deixava a sessão em
 * cache no `SessionManager`; a próxima mensagem na MESMA conversa pulava `ensureConversation` (que só
 * rodava na criação da sessão) e falhava com `FOREIGN KEY constraint failed` — "Erro ao processar
 * mensagem" para o usuário.
 *
 *   1 → premissa: apagar a conversa remove a linha do banco e a sessão continua em cache.
 *   2 → a mensagem seguinte do usuário NÃO falha e a conversa é recriada.
 *   3 → a resposta do assistente também (ambos os caminhos de gravação).
 *   4 → o caminho normal (sem exclusão) segue idêntico: uma conversa, sem duplicar.
 *
 * Execução: npx ts-node src/__tests__/regression/S304_SessionManager_RecreatesDeletedConversation.test.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { MemoryManager } from '../../memory/MemoryManager';
import { SessionManager } from '../../session/SessionManager';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

async function main(): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s304-'));
    const db = new Database(':memory:');
    const memoryManager = new MemoryManager(db);
    const sm = new SessionManager({ transcriptDir: dir, maxUncompressedMessages: 10, maxContextMessages: 5, maxUncompressedTokens: 10000, maxMessageChars: 1500 }, memoryManager);
    const key = { channel: 'web', userId: 'conv_s304' };
    const convId = 'web:conv_s304';
    const rows = () => (db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE id = ?').get(convId) as { n: number }).n;
    const msgs = () => (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(convId) as { n: number }).n;

    console.log('\n=== S304-4 — caminho normal: uma conversa, sem duplicar ===');
    await sm.recordUserMessage(key, 'primeira');
    await sm.recordAssistantMessage(key, 'resposta 1');
    assert(rows() === 1 && msgs() === 2, 'uma linha de conversa, duas mensagens', { rows: rows(), msgs: msgs() });

    console.log('\n=== S304-1 — premissa: exclusão remove a linha, a sessão fica em cache ===');
    memoryManager.getDashboardRepository().deleteAllWebConversations();
    assert(rows() === 0, 'a linha da conversa foi apagada do banco', rows());

    console.log('\n=== S304-2 — a mensagem seguinte do usuário não falha e recria a conversa ===');
    let threw: unknown = null;
    try { await sm.recordUserMessage(key, 'depois de apagar'); } catch (e) { threw = e; }
    assert(threw === null, 'recordUserMessage não lança (antes: FOREIGN KEY constraint failed)', String(threw));
    assert(rows() === 1, 'a conversa foi recriada', rows());
    assert(msgs() === 1, 'a mensagem nova foi gravada', msgs());

    console.log('\n=== S304-3 — a resposta do assistente também ===');
    memoryManager.getDashboardRepository().deleteAllWebConversations();
    threw = null;
    try { await sm.recordAssistantMessage(key, 'resposta depois de apagar'); } catch (e) { threw = e; }
    assert(threw === null, 'recordAssistantMessage não lança', String(threw));
    assert(rows() === 1 && msgs() === 1, 'conversa recriada e resposta gravada', { rows: rows(), msgs: msgs() });

    console.log(`\nS304 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    // O SessionManager mantém timers de limpeza abertos: sem isto o processo não encerra.
    process.exit(failed > 0 ? 1 : 0);
}
main().catch(e => { console.error(e); process.exitCode = 1; });
