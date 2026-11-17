/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S487 (uma chave só para "esta chamada já foi feita neste turno")
 *
 * Origem: VPS, 16/11/2026 23:28 — o mesmo áudio (send_audio, texto de 1639 caracteres) chegou duas vezes ao usuário no mesmo
 * turno. O 1º veio na mesma leva que um memory_search, o turno seguiu para uma síntese e o modelo pediu o mesmo áudio de novo,
 * 41 s depois. O bloqueio de chamada repetida do AgentLoop (TOOL-DEDUP) deveria ter barrado a 2ª chamada, mas:
 *  - quem GRAVA a chamada no Set do turno (ProactiveRecovery.makeKey) resumia a chave acima de 256 caracteres (sha1);
 *  - quem PROCURA (AgentLoop, caminhos nativo e JSON) usava computeToolInputKey, com a chave inteira.
 * Acima de 256 caracteres as duas nunca batiam: o bloqueio não funcionava para nenhuma ferramenta com argumento longo (áudio,
 * write, exec_command, memory_write). O S194 já tinha unificado o formato base, mas o resumo ficou só de um lado.
 * Correção: o resumo vive em computeToolInputKey; makeKey só delega.
 *
 * O que é real aqui: o ProactiveRecovery real gravando a chamada, e o `dispatchSingleNativeToolCall` real do AgentLoop
 * recebendo a 2ª chamada idêntica com o mesmo Set.
 * Controle: com o código antigo, o S487-1 dá "AgentLoop acha? false" para 1639 caracteres (medido em 17/11/2026 antes da
 * correção: gravada=send_audio:h:8155fc696eea64e7, procurada=send_audio:{"text":"aaa…).
 *
 * Execução: npx ts-node src/__tests__/regression/S487_ChaveUnicaDeChamadaRepetida.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { AgentLoop } from '../../loop/AgentLoop';
import { ProactiveRecovery } from '../../loop/ProactiveRecovery';
import { MemoryManager } from '../../memory/MemoryManager';
import { computeToolInputKey } from '../../loop/planning/computeToolInputKey';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

/** Ferramenta falsa com o mesmo esquema do send_audio: conta as execuções reais. */
function ferramentaDeAudio() {
    let execucoes = 0;
    return {
        tool: {
            parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
            execute: async (args: Record<string, unknown>) => { execucoes++; return { success: true, output: String(args.text) }; },
        },
        execucoes: () => execucoes,
    };
}

function makeAgentLoop(): AgentLoop {
    const providerFactory = {
        chatWithFallback: async () => ({ status: 'success', content: 'x', attempts: [] }),
        getProvider: () => ({ name: 'fake' }),
        getProviderWithModel: () => ({ chat: async () => ({ status: 'success', content: '{}' }) }),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
    const db = new (Database as any)(':memory:');
    const memory = { semanticSearch: async () => [], addMessage: async () => {}, getDatabase: () => db } as unknown as MemoryManager;
    return new AgentLoop(
        providerFactory, memory, { languageDirective: 'pt-BR', systemPrompt: 'teste S487' } as any,
        { recordPattern: () => {}, getPatterns: () => [] } as any,
        { getSkillContextForQuery: async () => '', getAllSkills: () => [], loadAll: () => [] } as any,
        { store: () => {} } as any, { store: () => {}, getStats: () => ({}) } as any,
    );
}

async function main(): Promise<void> {
    console.log('\n=== S487-1 — o que o ProactiveRecovery grava é o que o AgentLoop procura (curto e longo) ===');
    for (const n of [100, 1639]) {
        const args = { text: 'ó'.repeat(n) };
        const usados = new Set<string>();
        const audio = ferramentaDeAudio();
        await new ProactiveRecovery().execute('send_audio', args, () => audio.tool as any, usados);
        assert(usados.has(computeToolInputKey('send_audio', args)), `${n} caracteres: a chave gravada é a mesma que o AgentLoop procura`, [...usados]);
    }
    const longa = computeToolInputKey('exec_command', { command: 'x'.repeat(500) });
    assert(longa.startsWith('exec_command:h:') && longa.length < 64, 'argumento longo vira resumo na própria chave canônica', longa);
    assert(computeToolInputKey('exec_command', { command: 'x'.repeat(500) }) === longa && computeToolInputKey('exec_command', { command: 'y'.repeat(500) }) !== longa,
        'resumo estável para os mesmos argumentos e diferente para outros');
    assert(computeToolInputKey('send_document', { file_path: 'a.pptx', caption: 'z'.repeat(400) }) === 'send_document:a.pptx', 'send_document continua chaveado pelo arquivo (S90)');

    console.log('\n=== S487-2 — AgentLoop real: a 2ª chamada idêntica de send_audio (texto longo) no mesmo turno é barrada ===');
    {
        const texto = 'Luciano, sobre o consumo de óleo do seu Peugeot 208: '.padEnd(1639, ' e mais um trecho');
        const audio = ferramentaDeAudio();
        const usados = new Set<string>();
        await new ProactiveRecovery().execute('send_audio', { text: texto }, () => audio.tool as any, usados);   // a 1ª, como no turno real
        const loop = makeAgentLoop();
        // Espião: se a 2ª chamada passasse pelo bloqueio, o AgentLoop buscaria a ferramenta para executá-la.
        const buscadas: string[] = [];
        (loop as any).tools = { get: (nome: string) => { buscadas.push(nome); return undefined; } };
        const mensagens: Array<{ role: string; content: string }> = [];
        const r = await (loop as any).dispatchSingleNativeToolCall(
            { id: 'call-2', name: 'send_audio', arguments: { text: texto } }, 2, { channel: 'telegram', chatId: 'c1' }, 'conv-s487', 'pedido',
            { intent: 'x', category: 'information' }, { id: 't', steps: [] }, new AbortController().signal,
            usados, new Map(), new Map(), new Set(), new Set(), new Map(), new Map(), {} as any, new Map(), [], mensagens, {} as any,
            false, '', 10, 1, 0, 0, 0, 5, 5, 3, () => {},
        );
        assert(audio.execucoes() === 1 && buscadas.length === 0, 'a 2ª chamada nem chega a buscar a ferramenta: o áudio sai UMA vez só', { execucoes: audio.execucoes(), buscadas });
        assert(mensagens.some(m => m.role === 'tool' && m.content.startsWith('[BLOQUEADO] "send_audio" já foi executado')), 'o modelo recebe o fato: chamada repetida bloqueada', mensagens);
        assert(r.action === 'continueFor', 'o turno segue (o modelo pode responder com o que já tem)', r.action);
    }

    console.log('\n=== S487-3 — estrutural: uma função de chave só ===');
    const raiz = path.join(__dirname, '../..');
    const recuperacao = fs.readFileSync(path.join(raiz, 'loop/ProactiveRecovery.ts'), 'utf-8');
    assert(!/createHash/.test(recuperacao), 'ProactiveRecovery não resume chave por conta própria');
    assert(/return computeToolInputKey\(toolName, args\);/.test(recuperacao), 'makeKey só delega a computeToolInputKey');

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S487 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
    console.error('S487 erro inesperado:', err);
    process.exitCode = 1;
});
