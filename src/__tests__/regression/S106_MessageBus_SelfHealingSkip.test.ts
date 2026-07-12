/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S106
 *
 * Achado B1 (auditoria adversarial 2026-07-12): quando um adapter com supervisor interno
 * (ex.: TelegramAdapter + TelegramPollingSupervisor) falha em start(), o MessageBus não deve
 * agendar seu próprio reconnect via scheduleAdapterReconnect — o adapter já gerencia isso
 * internamente (backoff/cooldown/circuit-breaker). Dois mecanismos de reconexão concorrentes
 * sobre a mesma conexão são redundantes e descoordenados.
 *
 * Verifica:
 * 1. Adapter com `selfHealing = true` que falha no start(): bus NÃO chama scheduleAdapterReconnect.
 * 2. Adapter sem `selfHealing` (undefined) que falha no start(): bus CONTINUA agendando reconnect
 *    (comportamento pré-existente preservado para adapters sem supervisor próprio).
 */

import { MessageBus } from '../../channels/MessageBus';
import type { ChannelAdapter, ChannelType } from '../../channels/ChannelAdapter';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${msg}`, detail ?? ''); failed++; }
}

const fakeAgentLoop = {} as any;
const fakeSessionManager = {} as any;

function makeFailingAdapter(channelType: ChannelType, selfHealing?: boolean): ChannelAdapter {
    return {
        channelType,
        displayName: `Fake-${channelType}`,
        isConnected: false,
        selfHealing,
        start: async () => { throw new Error('simulated start failure'); },
        stop: async () => {},
        send: async () => {},
        healthCheck: async () => ({ ok: false }),
    };
}

async function main() {
    console.log('\n=== S106 — MessageBus não duplica reconexão de adapters self-healing ===');

    // Caso 1: adapter self-healing — bus NÃO deve agendar reconnect próprio
    {
        const bus = new MessageBus(fakeAgentLoop, fakeSessionManager);
        const adapter = makeFailingAdapter('telegram', true);
        (bus as any).adapters.set('telegram', adapter);

        let scheduleCalled = false;
        (bus as any).scheduleAdapterReconnect = () => { scheduleCalled = true; };

        await bus.startAll();

        assert(!scheduleCalled, 'Adapter selfHealing=true: bus NÃO chamou scheduleAdapterReconnect');
    }

    // Caso 2: adapter sem selfHealing — bus DEVE continuar agendando reconnect (comportamento legado)
    {
        const bus = new MessageBus(fakeAgentLoop, fakeSessionManager);
        const adapter = makeFailingAdapter('discord', undefined);
        (bus as any).adapters.set('discord', adapter);

        let scheduleCalled = false;
        (bus as any).scheduleAdapterReconnect = () => { scheduleCalled = true; };

        await bus.startAll();

        assert(scheduleCalled, 'Adapter sem selfHealing: bus continuou chamando scheduleAdapterReconnect (comportamento preservado)');
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S106 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(err => {
    console.error('Erro no teste S106:', err);
    process.exit(1);
});
