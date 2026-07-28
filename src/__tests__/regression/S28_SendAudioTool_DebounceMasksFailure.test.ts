/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S28
 * SendAudioTool não deve marcar o debounce de 10s (lastSendTime) numa tentativa que FALHOU —
 * só num envio realmente bem-sucedido.
 *
 * BUG REAL (conversa 04/07/2026, 07:47-07:51, log_conversa_newclaw.txt + newclaw-audit.log em
 * C:\Users\lucia\NewClaw): usuário pediu áudio com previsão do tempo. edge-tts não está
 * instalado nesta instalação Windows ("spawn edge-tts ENOENT") — TODAS as tentativas de gerar
 * o áudio falharam de verdade, nenhum áudio jamais foi produzido. Mas o código setava
 * `this.lastSendTime = now` no TOPO de execute(), antes de qualquer tentativa. Resultado: uma
 * segunda chamada a send_audio dentro da janela de 10s caía no debounce e retornava
 * `{success: true, output: '🔊 Áudio já enviado recentemente.'}` — sucesso FALSO, mascarando a
 * falha real. O bot reportou ao usuário "gerou e enviou um arquivo de áudio"; o usuário nunca
 * recebeu nada.
 *
 * FIX: lastSendTime só é atualizado depois de bus.sendVoice() ter sido chamado com sucesso.
 * Uma tentativa que falha (edge-tts ausente, ffmpeg falhou, upload falhou) nunca marca o
 * debounce — a próxima chamada tenta de novo (e reporta o erro real) em vez de fingir sucesso.
 *
 * Este teste força a falha de TODOS os engines de TTS de forma determinística, sem depender de
 * rede nem de nada estar (ou não) instalado na máquina de teste:
 *   - node-edge-tts (engine primário, npm/WebSocket): DISABLE_NODE_EDGE_TTS=true.
 *   - CLI Python edge-tts (fallback histórico): EDGE_TTS_PATH apontando pra binário inexistente.
 *   - Piper (offline, opcional): já fica de fora naturalmente — PIPER_MODELS_DIR não configurado
 *     no ambiente de teste, então findPiperInstallation() já retorna null sem precisar de flag.
 *
 * REGRESSÃO CORRIGIDA (2026-07-27): antes de DISABLE_NODE_EDGE_TTS existir, este teste só forçava
 * falha no fallback CLI (EDGE_TTS_PATH) — mas generateAudio() tenta node-edge-tts PRIMEIRO, que
 * não lê EDGE_TTS_PATH (não depende de nenhum binário local, só de rede). Numa máquina com rede
 * disponível, node-edge-tts gerava áudio de verdade, ffmpeg convertia de verdade, e o teste via
 * `success: true` onde esperava uma falha forçada — falso negativo do próprio teste, não um bug
 * de produção. DISABLE_NODE_EDGE_TTS (src/tools/send_audio.ts, generateViaNodeEdgeTts()) fecha
 * essa lacuna sem introduzir dependência de mock de módulo nem de timing de rede.
 *
 * Execução: npx ts-node src/__tests__/regression/S28_SendAudioTool_DebounceMasksFailure.test.ts
 */

process.env.EDGE_TTS_PATH = 'newclaw-testes-binario-inexistente-xyz';
process.env.DISABLE_NODE_EDGE_TTS = 'true';

import { SendAudioTool } from '../../tools/send_audio';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

// MessageBus fake — sendVoice nunca deveria ser chamado neste teste, pois o edge-tts falha
// antes de chegar lá. Se for chamado, o teste acusa (prova que a falha não foi simulada certo).
let sendVoiceCalls = 0;
const fakeBus = {
    sendVoice: async () => { sendVoiceCalls++; },
} as unknown as import('../../channels/MessageBus').MessageBus;

async function main() {
    const tool = new SendAudioTool(fakeBus);
    tool.setContext('chat-teste', 'telegram');

    console.log('\n=== S28 — 1ª chamada falha de verdade (edge-tts ausente) ===');
    const first = await tool.execute({ text: 'previsão do tempo de teste' });
    assert(first.success === false, `1ª chamada reporta falha real (obtido: success=${first.success})`, first);
    assert(sendVoiceCalls === 0, 'sendVoice NÃO foi chamado (edge-tts falhou antes)', sendVoiceCalls);

    console.log('\n=== S28 — 2ª chamada imediata (dentro da janela de debounce de 10s) NÃO finge sucesso ===');
    const second = await tool.execute({ text: 'previsão do tempo de teste, segunda tentativa' });
    assert(
        second.output !== '🔊 Áudio já enviado recentemente.',
        `2ª chamada não retorna a mensagem de debounce (obtido: success=${second.success} output="${second.output}")`,
        second,
    );
    assert(second.success === false, `2ª chamada também reporta falha real, não sucesso mascarado (obtido: success=${second.success})`, second);
    assert(sendVoiceCalls === 0, 'sendVoice continua não chamado na 2ª tentativa', sendVoiceCalls);

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S28 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
