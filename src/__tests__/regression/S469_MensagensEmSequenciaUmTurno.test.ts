/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S469
 * Mensagens de texto que chegam em sequência, enquanto o turno anterior ainda roda, viram UM turno — padrão `collect`
 * do OpenClaw (`messages.queue`), sem janela de tempo: só se junta o que já esperava a vez na fila.
 *
 * CASO REAL (VPS, Telegram, 03/11/2026 13:18): "Gera em PowerPoint editável" e "E me envia" chegaram juntas enquanto o
 * turno da aula terminava. Viraram dois pedidos; o segundo, sozinho, não tinha objeto ("O que você gostaria que eu
 * enviasse?").
 *
 * Exercita o código REAL de MessageBus.processMessage com stubs mínimos (mesmo padrão de S97).
 *
 * Execução: npx ts-node src/__tests__/regression/S469_MensagensEmSequenciaUmTurno.test.ts
 */

process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || '/tmp/newclaw-s469';

import { MessageBus } from '../../channels/MessageBus';
import type { NormalizedMessage, ChannelAdapter } from '../../channels/ChannelAdapter';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  OK ${msg}`); passed++; }
    else { console.error(`  FALHOU: ${msg}`, detail ?? ''); failed++; }
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (!pred() && Date.now() - start < timeoutMs) await new Promise(r => setTimeout(r, 10));
}

// O AgentLoop falso segura o turno até o teste liberar — é o "turno anterior ainda rodando".
const turnos: string[] = [];
let liberar: (() => void) | null = null;
let segurar = false;
const fakeAgentLoop = {
    process: async (_id: string, text: string): Promise<string> => {
        turnos.push(text);
        if (segurar) await new Promise<void>(r => { liberar = r; });
        return 'ok';
    },
} as unknown as import('../../loop/AgentLoop').AgentLoop;

const gravadas: string[] = [];
const fakeSessionManager = {
    recordUserMessage: async (_k: unknown, t: string) => { gravadas.push(t); return 1; },
    buildContext: async () => ({ messages: [] as unknown[] }),
    recordAssistantMessage: async () => 2,
} as unknown as import('../../session/SessionManager').SessionManager;

class FakeAdapter implements Partial<ChannelAdapter> {
    channelType = 'telegram' as const;
    displayName = 'Telegram (fake S469)';
    isConnected = true;
    enviados: string[] = [];
    async start() {}
    async stop() {}
    async healthCheck() { return { ok: true }; }
    async send(resp: { text: string }) { this.enviados.push(resp.text); }
    sendTypingIndicator(): Promise<void> { return Promise.resolve(); }
}

let seq = 0;
function msg(text: string): NormalizedMessage {
    seq++;
    return { messageId: String(seq), channel: 'telegram', userId: 'u469', userName: 'U', type: 'text', text, rawContext: {}, chatId: 'c469', metadata: {} };
}

async function main() {
    const bus = new MessageBus(fakeAgentLoop, fakeSessionManager);
    const adapter = new FakeAdapter();
    bus.registerAdapter(adapter as unknown as ChannelAdapter);

    console.log('\n=== S469-A — fila livre: a mensagem roda na hora, sozinha ===');
    await bus.processMessage(msg('oi'));
    await waitFor(() => turnos.length >= 1);
    assert(turnos[0] === 'oi', 'mensagem com a fila livre não espera nem se junta', turnos);

    console.log('\n=== S469-B — o caso real: duas mensagens durante o turno anterior viram um turno ===');
    segurar = true;
    await bus.processMessage(msg('poderia criar a aula 01 de 4 horas'));
    await waitFor(() => turnos.length >= 2);
    await bus.processMessage(msg('Gera em PowerPoint editável'));
    await bus.processMessage(msg('E me envia'));
    segurar = false;
    liberar?.();
    await waitFor(() => turnos.length >= 3);
    await new Promise(r => setTimeout(r, 100));
    assert(turnos.length === 3, `um turno para as duas (turnos=${turnos.length})`, turnos);
    assert(turnos[2] === 'Gera em PowerPoint editável\nE me envia', 'o turno leva as duas, na ordem', turnos[2]);
    assert(gravadas[gravadas.length - 1] === 'Gera em PowerPoint editável\nE me envia', 'a sessão grava uma mensagem do usuário com as duas', gravadas);
    assert(adapter.enviados.some(t => t.includes('vai junto com a mensagem anterior')), 'a mensagem juntada recebe o aviso de que foi junto', adapter.enviados);

    console.log('\n=== S469-C — anexo/comando no meio encerra o agrupamento (a ordem da conversa não se inverte) ===');
    segurar = true;
    const antes = turnos.length;
    await bus.processMessage(msg('turno longo'));
    await waitFor(() => turnos.length >= antes + 1);
    await bus.processMessage(msg('primeira'));
    await bus.processMessage(msg('/comando-sem-handler'));
    await bus.processMessage(msg('depois do comando'));
    segurar = false;
    liberar?.();
    await waitFor(() => turnos.length >= antes + 4);
    await new Promise(r => setTimeout(r, 100));
    const depois = turnos.slice(antes + 1);
    assert(depois.join(' | ') === 'primeira | /comando-sem-handler | depois do comando', 'cada uma no seu turno, na ordem em que chegou', depois);

    bus['conversationQueues']?.destroy?.();
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S469 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
}

main()
    .catch((err) => { console.error('S469 erro inesperado:', err); failed++; })
    .finally(() => { process.exit(failed > 0 ? 1 : 0); });
