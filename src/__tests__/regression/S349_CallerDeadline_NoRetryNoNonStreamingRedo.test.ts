/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S349 (issue 064b; reescrito pela ADR-027)
 *
 * Histórico: produção, 07/10/2026, o RiskAnalyzer pediu 60 s e gastou 192 s — o streaming chegou ao PRAZO de quem chamou
 * (MAX TIMEOUT), o ProviderFactory retentou e refez sem streaming. A issue 064b passou a cortar uma vez só, no prazo.
 *
 * ADR-027 (23/10/2026): o prazo de quem chamou não corta mais um modelo que GERA (VPS, 23/10: cortado aos 32,6 s com 866
 * pedaços chegando). O que encerra uma geração longa é o tamanho, o "Parar" ou o silêncio. Este teste passa a cobrar:
 * gerando além do prazo pedido, a chamada continua; o "Parar" a encerra na hora; e não há retentativa nem refação sem
 * streaming de uma chamada cancelada.
 *
 * REGRESSÃO SE: o prazo de quem chamou voltar a cortar o streaming gerando; ou o cancelamento gerar retentativa/refação.
 *
 * Execução: npx ts-node src/__tests__/regression/S349_CallerDeadline_NoRetryNoNonStreamingRedo.test.ts
 */
import { ProviderFactory } from '../../core/ProviderFactory';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (): boolean => true;
    try { return await fn(); } finally { process.stdout.write = orig; }
};

/** Servidor que só "pensa" e nunca termina — até a requisição ser abortada. */
function fetchQueSoPensa(contagem: { streaming: number; naoStreaming: number }): typeof fetch {
    return (async (_url: string, init?: { body?: string; signal?: AbortSignal }) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (body.stream === false) {
            contagem.naoStreaming++;
            return await new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))));
        }
        contagem.streaming++;
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                const t = setInterval(() => {
                    try { controller.enqueue(new TextEncoder().encode(JSON.stringify({ message: { thinking: 'pensando...' } }) + '\n')); } catch { clearInterval(t); }
                }, 20);
                init?.signal?.addEventListener('abort', () => { clearInterval(t); try { controller.error(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })); } catch { /* já encerrado */ } });
            },
        });
        return { ok: true, status: 200, body: stream } as unknown as Response;
    }) as unknown as typeof fetch;
}

async function main(): Promise<void> {
    console.log('\n=== S349 — gerando além do prazo pedido (400 ms): não é cortado; o "Parar" encerra; sem retentativa ===');
    const contagem = { streaming: 0, naoStreaming: 0 };
    const original = global.fetch;
    global.fetch = fetchQueSoPensa(contagem);
    const parar = new AbortController();
    const PARAR_EM_MS = 1500;
    setTimeout(() => parar.abort(), PARAR_EM_MS);
    const t0 = Date.now();
    let r: any;
    try {
        const pf = new ProviderFactory({ defaultProvider: 'ollama', ollamaUrl: 'http://fake-ollama.invalid', ollamaModel: 'modelo-que-pensa' } as any);
        r = await quiet(() => pf.chatWithFallback([{ role: 'user', content: 'revise o plano' }], undefined, 'ollama', 400, parar.signal));
    } finally {
        global.fetch = original;
    }
    const ms = Date.now() - t0;
    assert(ms >= PARAR_EM_MS - 50, `o prazo pedido (400 ms) não cortou o modelo gerando — durou ${ms} ms, até o "Parar"`);
    assert(ms < PARAR_EM_MS + 2000, `o "Parar" encerra na hora (${ms} ms)`);
    assert(r?.status === 'cancelled', `termina como cancelada pelo usuário (status=${r?.status})`);
    assert(contagem.streaming === 1, `uma única tentativa por streaming — obtido ${contagem.streaming}`);
    assert(contagem.naoStreaming === 0, `nenhuma refação sem streaming — obtido ${contagem.naoStreaming}`);

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S349 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}
main().catch((err) => { console.error('S349 erro inesperado:', err); process.exit(1); });
