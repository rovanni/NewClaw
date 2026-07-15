/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S120
 * Persistência de uploads de arquivos no activeFiles da sessão.
 * 
 * Execução: npx ts-node src/__tests__/regression/S120_SessionUploadActiveFiles.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';
import { SessionManager } from '../../session/SessionManager';
import { SessionContext } from '../../session/SessionContext';
import { MemoryManager } from '../../memory/MemoryManager';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ OK ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function main(): Promise<void> {
    console.log('=== S120 — Teste de Regressão: Registro de Uploads em activeFiles ===');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s120-activefiles-'));
    const db = new Database(':memory:');
    const memoryManager = new MemoryManager(db);
    const sessionManager = new SessionManager(
        {
            transcriptDir: dir,
            maxUncompressedMessages: 10,
            maxContextMessages: 6,
            maxUncompressedTokens: 10000,
            maxMessageChars: 1500,
        },
        memoryManager
    );
    const sessionContext = new SessionContext(sessionManager, memoryManager);

    const key = { channel: 'telegram' as const, userId: 'test-user-s120' };

    // Caso 1: Upload Inicial
    console.log('\n--- Caso 1: Upload Inicial ---');
    const uploadPath = 'workspace/seguranca_redes_senac_final.pptx';
    sessionManager.registerActiveFile(key, uploadPath);

    let activeFilesBlock = sessionManager.getActiveFilesBlock(key);
    assert(activeFilesBlock !== null, 'activeFilesBlock não deve ser nulo após upload');
    assert(!!activeFilesBlock?.includes('workspace/seguranca_redes_senac_final.pptx'), 'Deve incluir o caminho do arquivo de upload', activeFilesBlock);
    assert(!!activeFilesBlock?.includes('ARQUIVOS DISPONÍVEIS NESTA SESSÃO'), 'Deve conter o cabeçalho correto', activeFilesBlock);

    // Caso 2: Prevenção de Duplicados (Upload -> Read)
    console.log('\n--- Caso 2: Prevenção de Duplicados ---');
    // Simula tool call 'read' atuando no mesmo arquivo
    await sessionManager.recordToolCall(key, 'read', JSON.stringify({ path: 'workspace/seguranca_redes_senac_final.pptx' }));
    
    activeFilesBlock = sessionManager.getActiveFilesBlock(key);
    const matches = activeFilesBlock?.match(/seguranca_redes_senac_final\.pptx/g);
    assert(!!(matches && matches.length === 1), 'Não deve haver duplicações de caminho em activeFiles', matches);

    // Caso 3: Consistência de Múltiplos Arquivos
    console.log('\n--- Caso 3: Consistência de Múltiplos Arquivos ---');
    sessionManager.registerActiveFile(key, 'workspace/outro_arquivo.txt');
    sessionManager.registerActiveFile(key, 'workspace/imagem.png');

    activeFilesBlock = sessionManager.getActiveFilesBlock(key);
    assert(!!activeFilesBlock?.includes('workspace/outro_arquivo.txt'), 'Deve incluir o segundo arquivo');
    assert(!!activeFilesBlock?.includes('workspace/imagem.png'), 'Deve incluir o terceiro arquivo');

    // Caso 4: Sessão Comprimida
    console.log('\n--- Caso 4: Sessão Comprimida ---');
    const sysPrompt = 'Você é um assistente cognitivo.';
    const currentMsg = 'Quero mudar o fundo para branco.';
    
    // Simula a construção de mensagens para o LLM
    const contextResult = await sessionContext.buildLLMMessages(key, sysPrompt, currentMsg);
    const stateMsg = contextResult.messages.find(m => m.role === 'system' && m.content.includes('ARQUIVOS DISPONÍVEIS NESTA SESSÃO'));
    assert(stateMsg !== undefined, 'O stateBlock construído deve conter a lista de arquivos disponíveis');
    assert(!!stateMsg?.content.includes('workspace/seguranca_redes_senac_final.pptx'), 'O stateBlock deve conter o arquivo PPTX');

    // Caso 5: Ordem Estável e Normalização
    console.log('\n--- Caso 5: Ordem Estável e Normalização ---');
    sessionManager.registerActiveFile(key, 'workspace\\windows_path.pptx');
    activeFilesBlock = sessionManager.getActiveFilesBlock(key);
    assert(!!activeFilesBlock?.includes('workspace/windows_path.pptx'), 'O path deve ser normalizado com barras ordinárias');
    assert(!activeFilesBlock?.includes('workspace\\windows_path.pptx'), 'O path com barra invertida não deve aparecer');

    // Finalizar sessões, parar timers em background e limpar diretório
    const transcript = await sessionManager.getOrCreateSession(key);
    await transcript.close();
    memoryManager.getAttentionFeedback()?.stopBackgroundJobs();
    fs.rmSync(dir, { recursive: true, force: true });

    console.log(`\n=== Resultado de S120: ${passed} passaram, ${failed} falharam ===`);
    if (failed > 0) {
        process.exit(1);
    } else {
        process.exit(0);
    }
}

main().catch(err => {
    console.error('Erro durante o teste:', err);
    process.exit(1);
});
