/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S404
 * O indicador do canal diz o que o assistente está fazendo — "digitando…" enquanto trabalha —, nunca o tipo da mensagem
 * que chegou.
 *
 * ORIGEM (Telegram, 15/10/2026): a usuária mandou pedidos por áudio e o bot mostrou "gravando voz" por 34 minutos seguidos,
 * enquanto pesquisava e montava slides. O MessageBus escolhia a ação pelo tipo da ENTRADA (áudio → record_voice, foto →
 * upload_photo, documento → upload_document): para quem está do outro lado, parecia que o bot gravava um áudio sem fim.
 *
 * REGRESSÃO SE: qualquer tipo de mensagem recebida voltar a acender outro indicador que não "digitando…".
 *
 * Execução: npx ts-node src/__tests__/regression/S404_IndicadorSempreDigitando.test.ts
 */
import { MessageBus } from '../../channels/MessageBus';
import type { ChannelAdapter, NormalizedMessage, TypingAction } from '../../channels/ChannelAdapter';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

class AdapterQueRegistraIndicador implements Partial<ChannelAdapter> {
    channelType = 'telegram' as const;
    displayName = 'Telegram (fake)';
    isConnected = true;
    acoes: TypingAction[] = [];
    async start() {}
    async stop() {}
    async healthCheck() { return { ok: true }; }
    async send() {}
    async sendTypingIndicator(_ctx: unknown, acao: TypingAction = 'typing'): Promise<void> { this.acoes.push(acao); }
}

async function main(): Promise<void> {
    console.log('\n=== S404 — áudio, foto, documento, vídeo e texto: o indicador é sempre "digitando…" ===');
    for (const tipo of ['voice', 'audio', 'photo', 'document', 'video', 'text'] as const) {
        const bus = new MessageBus(
            {} as unknown as import('../../loop/AgentLoop').AgentLoop,
            {} as unknown as import('../../session/SessionManager').SessionManager,
        );
        const adapter = new AdapterQueRegistraIndicador();
        // @ts-expect-error — acesso ao Map interno só para registrar o adapter fake (mesmo padrão do S29)
        bus.adapters.set('telegram', adapter);
        // Um comando encerra o atendimento logo depois de o indicador começar — sem LLM, sem sessão.
        bus.registerCommand('/s404', async () => 'ok');
        const msg = { id: `m-${tipo}`, channel: 'telegram', userId: 'u1', type: tipo, text: '/s404', rawContext: {}, timestamp: Date.now() } as unknown as NormalizedMessage;
        // @ts-expect-error — processamento real da mensagem (privado), o mesmo que a fila da conversa chama
        await bus.processMessageCore(msg, `c-${tipo}`).catch(() => {});
        // @ts-expect-error — para o intervalo do indicador (o fim normal do atendimento faz o mesmo)
        bus.stopTypingIndicator('telegram:u1');
        assert(adapter.acoes.length > 0 && adapter.acoes.every(a => a === 'typing'), `mensagem do tipo "${tipo}" → "digitando…"`, adapter.acoes);
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S404 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('S404 erro inesperado:', err); process.exit(1); });
