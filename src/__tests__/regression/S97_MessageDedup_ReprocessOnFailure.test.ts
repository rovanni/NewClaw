/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S97
 * Auditoria adversarial 2026-07-12, achado A3 (Alto): o dedup de mensagens marcava o messageId
 * como "visto" no momento da ADMISSÃO (antes de processar). Se o turno falhasse sem produzir
 * resposta e o Telegram reentregasse a mesma update dentro da janela de TTL, a reentrega era
 * descartada como duplicata — perda silenciosa de mensagem.
 *
 * FIX: dedup por ESTADO. Admissão marca 'in_flight'; conclusão marca 'done'; FALHA inesperada
 * REMOVE a entrada, permitindo reprocessar uma reentrega legítima. Duplicatas reais (in_flight
 * ou done) continuam sendo descartadas.
 *
 * Este teste exercita o código REAL de MessageBus.processMessage (não uma reprodução), com stubs
 * mínimos de AgentLoop/SessionManager/adapter — mesmo padrão de S29.
 *
 * Execução: npx ts-node src/__tests__/regression/S97_MessageDedup_ReprocessOnFailure.test.ts
 */

process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || '/tmp/newclaw-s97';

import { MessageBus } from '../../channels/MessageBus';
import type { NormalizedMessage, ChannelAdapter } from '../../channels/ChannelAdapter';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${msg}`, detail ?? ''); failed++; }
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!pred() && Date.now() - start < timeoutMs) {
        await new Promise(r => setTimeout(r, 10));
    }
}

// ── Stubs mínimos ────────────────────────────────────────────────────────────
let processCalls = 0;
const fakeAgentLoop = {
    process: async (_id: string, _text: string, _uid: string, _ctx: unknown): Promise<string> => {
        processCalls++;
        return 'resposta ok';
    },
} as unknown as import('../../loop/AgentLoop').AgentLoop;

const fakeSessionManager = {
    recordUserMessage: async () => 1,
    buildContext: async () => ({ messages: [] as unknown[] }),
    recordAssistantMessage: async () => 2,
} as unknown as import('../../session/SessionManager').SessionManager;

// Adapter que pode falhar de forma síncrona no indicador de digitação (simula exceção inesperada
// ANTES do try interno de processMessageCore — o único ponto que aciona o branch markFailed).
class ControllableAdapter implements Partial<ChannelAdapter> {
    channelType = 'telegram' as const;
    displayName = 'Telegram (fake S97)';
    isConnected = true;
    failTypingOnce = false;
    sent: string[] = [];
    async start() {}
    async stop() {}
    async healthCheck() { return { ok: true }; }
    async send(resp: { text: string }) { this.sent.push(resp.text); }
    sendTypingIndicator(): Promise<void> {
        if (this.failTypingOnce) {
            this.failTypingOnce = false;
            throw new Error('falha síncrona simulada no typing (exceção inesperada pré-try)');
        }
        return Promise.resolve();
    }
}

function makeMsg(messageId: string, text = 'olá'): NormalizedMessage {
    return {
        messageId, channel: 'telegram', userId: 'u1', userName: 'U1',
        type: 'text', text, rawContext: {}, chatId: 'chat1', metadata: {},
    };
}

async function main() {
    const bus = new MessageBus(fakeAgentLoop, fakeSessionManager);
    const adapter = new ControllableAdapter();
    bus.registerAdapter(adapter as unknown as ChannelAdapter);
    // @ts-expect-error — acesso ao Map interno de dedup só para inspeção no teste (padrão S29)
    const dedup = bus.recentMessageIds as Map<string, { status: string; ts: number }>;

    // ── A. Admissão + conclusão (done) + dedup de reentrega ──────────────────
    console.log('\n=== S97-A — mensagem processada uma vez; reentrega idêntica é descartada ===');
    await bus.processMessage(makeMsg('100'));
    await waitFor(() => processCalls >= 1);
    assert(processCalls === 1, 'AgentLoop.process chamado exatamente 1x', processCalls);
    assert(dedup.get('telegram:100')?.status === 'done', "estado do messageId=100 é 'done'", dedup.get('telegram:100'));

    await bus.processMessage(makeMsg('100')); // reentrega
    await new Promise(r => setTimeout(r, 100));
    assert(processCalls === 1, 'reentrega do mesmo messageId NÃO reprocessa (dropada)', processCalls);

    // ── B. messageId diferente é processado normalmente ──────────────────────
    console.log('\n=== S97-B — messageId distinto não é afetado pelo dedup ===');
    await bus.processMessage(makeMsg('101'));
    await waitFor(() => processCalls >= 2);
    assert(processCalls === 2, 'messageId novo é processado (dedup não vaza entre ids)', processCalls);

    // ── C. Falha inesperada REMOVE a marca → reentrega é reprocessada ─────────
    console.log('\n=== S97-C — falha inesperada permite reprocessar a reentrega (sem perda) ===');
    adapter.failTypingOnce = true;                 // primeira entrega de 200 lança pré-try
    await bus.processMessage(makeMsg('200'));
    await waitFor(() => !dedup.has('telegram:200'));
    assert(!dedup.has('telegram:200'), 'após falha inesperada, a marca de dedup foi REMOVIDA (permite reprocessar)', dedup.get('telegram:200'));
    const callsBeforeRetry = processCalls;

    await bus.processMessage(makeMsg('200'));       // reentrega — agora o typing não falha
    await waitFor(() => processCalls >= callsBeforeRetry + 1);
    assert(processCalls === callsBeforeRetry + 1, 'reentrega após falha é REPROCESSADA (não descartada como duplicata)', processCalls);

    bus['conversationQueues']?.destroy?.();

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S97 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
