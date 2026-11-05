/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S478 (a inicialização não espera o polling do Telegram)
 *
 * Achado na validação da produção Windows em 05/11/2026: o último "NewClaw running" do log era de 06/08/2026, e o
 * SessionAutoCleaner, a curadoria de memória e a purga de workflows não rodavam desde 06–08/08. Causa:
 * `TelegramPollingSupervisor.start()` aguardava `pollingLoop()`, e o `bot.start()` do grammY só resolve quando o bot
 * para. Com o Telegram conectado, `MessageBus.startAll()` nunca voltava, e tudo o que o `AgentController.start()` faz
 * depois dele (limpezas, curadoria, intervalos, Sync Agent) nunca rodava. Na VPS, onde o Telegram não conectava, a
 * inicialização terminava: por isso só a produção Windows tinha o defeito.
 *
 * Real: o `TelegramPollingSupervisor` e o `MessageBus.startAll()`. Imitado: o bot (grammY), com o mesmo contrato de
 * `bot.start()`: resolve só depois de `bot.stop()`.
 *
 * Execução: npx ts-node src/__tests__/regression/S478_InicioNaoEsperaOPollingDoTelegram.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

process.env.TELEGRAM_START_GRACE_MS = '0';

/* eslint-disable @typescript-eslint/no-var-requires */
const { TelegramPollingSupervisor } = require('../../channels/TelegramPollingSupervisor') as typeof import('../../channels/TelegramPollingSupervisor');
const { MessageBus } = require('../../channels/MessageBus') as typeof import('../../channels/MessageBus');
/* eslint-enable @typescript-eslint/no-var-requires */

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

/** Bot falso com o contrato do grammY: `start()` chama `onStart` e só resolve quando `stop()` é chamado. */
function botFalso() {
    let parar: (() => void) | null = null;
    return {
        api: { deleteWebhook: async () => true, getMe: async () => ({ id: 1, username: 'teste_s478' }), sendMessage: async () => ({}) },
        start: (o?: { onStart?: () => void }) => new Promise<void>((resolve) => { parar = resolve; o?.onStart?.(); }),
        stop: () => { parar?.(); },
    };
}

const comPrazo = <T>(p: Promise<T>, ms: number) => Promise.race([p.then(() => 'resolveu'), new Promise<string>(r => setTimeout(() => r('preso'), ms))]);

async function main(): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's478-'));
    try {
        console.log('\n=== S478-1 — o start() do supervisor volta com o polling ligado ===');
        const bot = botFalso();
        const sup = new TelegramPollingSupervisor(bot as never, [], path.join(dir, 'telegram.lock'));
        const r = await comPrazo(sup.start(), 2000);
        assert(r === 'resolveu', 'start() resolve mesmo com o bot.start() ainda rodando (antes: preso para sempre)', r);
        await new Promise(res => setTimeout(res, 50));
        assert(sup.getStatus().state === 'connected', 'o polling está conectado, em segundo plano', sup.getStatus().state);
        await sup.stop();
        assert(await comPrazo(sup.aguardarLaco(), 2000) === 'resolveu', 'stop() encerra o laço de polling');

        console.log('\n=== S478-2 — MessageBus.startAll() termina com um adaptador que usa o supervisor ===');
        const bot2 = botFalso();
        const sup2 = new TelegramPollingSupervisor(bot2 as never, [], path.join(dir, 'telegram2.lock'));
        const adaptador = {
            channelType: 'telegram', displayName: 'Telegram (S478)', isConnected: true,
            start: () => sup2.start(), stop: () => sup2.stop(), healthCheck: async () => ({ ok: true }), send: async () => {},
        };
        const bus = new MessageBus({ process: async () => 'ok' } as never, { recordUserMessage: async () => 1, buildContext: async () => ({ messages: [] }), recordAssistantMessage: async () => 2 } as never);
        bus.registerAdapter(adaptador as never);
        assert(await comPrazo(bus.startAll(), 2000) === 'resolveu', 'startAll() volta: o que o AgentController.start() faz depois dele roda');
        await sup2.stop();

        console.log('\n=== S478-3 — o AgentController registra o fim da inicialização depois do startAll ===');
        const fonte = fs.readFileSync(path.join(__dirname, '../../core/AgentController.ts'), 'utf8');
        const iStart = fonte.indexOf('await this.messageBus.startAll();');
        const iRunning = fonte.indexOf('NewClaw running');
        assert(iStart > 0 && iRunning > iStart, 'a linha "NewClaw running" vem depois do startAll (sinal no log de que a inicialização terminou)');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S478 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exitCode = failed > 0 ? 1 : 0;
    // O supervisor registra SIGTERM/SIGINT; nada mais segura o processo depois do stop().
    setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
}

main().catch((e) => { console.error('S478 erro inesperado:', e); process.exit(1); });
