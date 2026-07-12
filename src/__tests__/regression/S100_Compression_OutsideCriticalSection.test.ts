/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S100
 * 
 * 1. Verifica que a compressão LLM ocorre FORA do mutex da sessão (o mutex não é
 *    mantido ocupado durante o processamento do LLM).
 * 2. Verifica que o timeout do mutex rejeita/lança um erro (fail-closed) em vez
 *    de prosseguir de forma concorrente.
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
    console.log('\n=== S100-A — Compressão LLM executada FORA do Lock do Mutex ===');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s100-'));
    const db = new Database(':memory:');
    const memoryManager = new MemoryManager(db);
    
    // Compressor de contexto mockado com delay de 200ms
    let compressCalled = false;
    let compressActive = false;
    let compressFinished = false;
    let lockAcquiredDuringCompress = false;

    const sessionManager = new SessionManager(
        {
            transcriptDir: dir,
            maxUncompressedMessages: 2, // atinge o limite com 2 mensagens
            maxContextMessages: 1,
            maxUncompressedTokens: 10000,
        },
        memoryManager,
        undefined
    );

    // Sobrescreve o contextCompressor mockado
    (sessionManager as any).contextCompressor = {
        compress: async (_messages: any[]) => {
            compressCalled = true;
            compressActive = true;
            // Delay simulando chamada de LLM
            await new Promise(r => setTimeout(r, 200));
            compressActive = false;
            compressFinished = true;
            return [{ role: 'system', content: 'Resumo mockado' }];
        }
    };

    const key = { channel: 'telegram', userId: 'user-s100' };
    const sid = (sessionManager as any).sessionKey(key);
    
    // Inicializa a sessão
    const transcript = await sessionManager.getOrCreateSession(key);

    // Mensagem 1
    await sessionManager.recordUserMessage(key, 'Mensagem 1');
    await transcript.flush();

    // Mensagem 2
    await sessionManager.recordUserMessage(key, 'Mensagem 2');
    await transcript.flush();

    // Mensagem 3 (irá disparar compressão)
    const recordPromise = sessionManager.recordUserMessage(key, 'Mensagem 3');

    // Espera um pouco para a compressão iniciar
    await new Promise(r => setTimeout(r, 50));
    assert(compressCalled, 'A chamada de compressão foi feita');
    assert(compressActive, 'A compressão LLM foi iniciada e está ativa');

    // Tenta adquirir o lock da sessão ENQUANTO a compressão está rodando
    await sessionManager.withMutex(sid, async () => {
        lockAcquiredDuringCompress = true;
        assert(compressActive, 'Conseguiu adquirir o lock da sessão enquanto a compressão LLM ainda está em execução!');
    });

    await recordPromise;
    await transcript.flush();

    assert(compressFinished, 'A compressão foi finalizada');
    assert(lockAcquiredDuringCompress, 'O lock da sessão pôde ser obtido de forma independente durante a chamada de compressão');


    console.log('\n=== S100-B — Timeout do Mutex lança erro (Fail-Closed) ===');

    const originalSetTimeout = global.setTimeout;
    // Intercepta setTimeout de 45s e transforma em 50ms para testar timeout rapidamente
    (global as any).setTimeout = (cb: any, ms: number, ...args: any[]) => {
        if (ms === 45_000) {
            return originalSetTimeout(cb, 50, ...args);
        }
        return originalSetTimeout(cb, ms, ...args);
    };

    let lockReleased = false;
    let timeoutThrew = false;

    try {
        // Bloqueia o mutex com uma tarefa que demora 500ms
        const blockPromise = sessionManager.withMutex(sid, async () => {
            await new Promise(r => setTimeout(r, 500));
            lockReleased = true;
        });

        // Tenta obter o mutex concorrentemente (vai dar timeout em 50ms devido ao mock)
        await sessionManager.withMutex(sid, async () => {
            console.log('Não deveria entrar aqui antes do timeout');
        });

        await blockPromise;
    } catch (err) {
        timeoutThrew = true;
        assert(err instanceof Error && err.message.includes('Mutex timeout'), 'Disparou erro de timeout esperado', err);
    } finally {
        // Restaura setTimeout original
        global.setTimeout = originalSetTimeout;
    }

    assert(timeoutThrew, 'Timeout do mutex lançou exceção (fail-closed)');
    assert(!lockReleased, 'O timeout estourou antes do lock original ser liberado');

    await transcript.close();
    fs.rmSync(dir, { recursive: true, force: true });
    db.close();

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S100 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(err => {
    console.error('Erro no teste S100:', err);
    process.exit(1);
});
