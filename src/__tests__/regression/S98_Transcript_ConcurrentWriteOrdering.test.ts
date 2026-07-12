/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S98
 * 
 * Verifica que escritas simultâneas na mesma sessão são serializadas pelo mutex
 * e gravadas sem corromper o arquivo de transcript.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { MemoryManager } from '../../memory/MemoryManager';
import { SessionManager } from '../../session/SessionManager';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${msg}`, detail ?? ''); failed++; }
}

async function main() {
    console.log('\n=== S98 — Ordenação e integridade de escritas concorrentes no Transcript ===');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s98-'));
    const db = new Database(':memory:');
    const memoryManager = new MemoryManager(db);
    const sessionManager = new SessionManager(
        {
            transcriptDir: dir,
            maxUncompressedMessages: 10,
            maxContextMessages: 5,
            maxUncompressedTokens: 10000,
            maxMessageChars: 1500,
        },
        memoryManager
    );

    const key = { channel: 'telegram', userId: 'user-s98' };
    const transcript = await sessionManager.getOrCreateSession(key);

    // Dispara múltiplas gravações simultâneas para simular concorrência
    const promises = [
        sessionManager.recordUserMessage(key, 'Mensagem do Usuário 1'),
        sessionManager.recordSystemMessage(key, 'Mensagem do Sistema 1'),
        sessionManager.recordToolCall(key, 'read', JSON.stringify({ path: 'test.txt' })),
        sessionManager.recordToolResult(key, 'read', 'Conteúdo do arquivo', true, 10),
        sessionManager.recordAssistantMessage(key, 'Mensagem do Assistente 1'),
        sessionManager.recordSystemMessage(key, 'Mensagem do Sistema 2'),
    ];

    const seqs = await Promise.all(promises);
    await transcript.flush();

    // Verifica que todas as escritas receberam um seq único e contíguo
    assert(seqs.length === 6, 'Todas as 6 gravações retornaram seqs');
    
    // Ordena os seqs e valida a sequência
    const sortedSeqs = [...seqs].sort((a, b) => a - b);
    assert(sortedSeqs[0] === 1, 'Primeiro seq é 1');
    assert(sortedSeqs[5] === 6, 'Último seq é 6');
    for (let i = 0; i < 5; i++) {
        assert(sortedSeqs[i + 1] === sortedSeqs[i] + 1, `seq contíguo: ${sortedSeqs[i]} -> ${sortedSeqs[i+1]}`);
    }

    // Replay para validar o conteúdo
    const entries = await transcript.replay();
    assert(entries.length === 6, 'Transcript contém exatamente 6 entradas registradas');
    
    // Verifica que todas as entradas pretendidas estão no log, independentemente da ordem exata de chegada
    const roles = entries.map(e => e.role).sort();
    const expectedRoles = ['assistant', 'system', 'system', 'tool_call', 'tool_result', 'user'].sort();
    assert(
        JSON.stringify(roles) === JSON.stringify(expectedRoles),
        'Todas as roles de mensagens concorrentes foram gravadas com sucesso',
        { roles, expectedRoles }
    );

    await transcript.close();
    fs.rmSync(dir, { recursive: true, force: true });
    db.close();

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S98 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(err => {
    console.error('Erro no teste S98:', err);
    process.exit(1);
});
