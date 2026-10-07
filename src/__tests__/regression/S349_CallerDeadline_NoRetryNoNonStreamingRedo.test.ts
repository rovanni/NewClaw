/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S349 (issue 064b)
 *
 * Produção, 07/10/2026: o RiskAnalyzer pediu 60 s e gastou 192 s — o streaming chegou ao PRAZO de quem chamou
 * (MAX TIMEOUT), o ProviderFactory tratou o "aborted" como falha transitória e retentou (mais 60 s + 12 s de espera) e
 * depois refez sem streaming (mais 60 s). Antes da issue 064 o orçamento de raciocínio abortava aos ~10 s e o custo era
 * ~70 s; sem ele, o prazo virou o limite — e a refação com o mesmo prazo triplicava a espera.
 *
 * REGRESSÃO SE: uma chamada que esgota o prazo de quem chamou voltar a ser retentada ou refeita sem streaming.
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
    console.log('\n=== S349 — prazo de quem chamou esgotado: uma tentativa só, sem refação sem streaming ===');
    const contagem = { streaming: 0, naoStreaming: 0 };
    const original = global.fetch;
    global.fetch = fetchQueSoPensa(contagem);
    const t0 = Date.now();
    let r: any;
    try {
        const pf = new ProviderFactory({ defaultProvider: 'ollama', ollamaUrl: 'http://fake-ollama.invalid', ollamaModel: 'modelo-que-pensa' } as any);
        r = await quiet(() => pf.chatWithFallback([{ role: 'user', content: 'revise o plano' }], undefined, 'ollama', 400));
    } finally {
        global.fetch = original;
    }
    const ms = Date.now() - t0;
    assert(r?.status !== 'success', `a chamada não termina em sucesso (status=${r?.status})`);
    assert(contagem.streaming === 1, `uma única tentativa por streaming (antes: 2) — obtido ${contagem.streaming}`);
    assert(contagem.naoStreaming === 0, `nenhuma refação sem streaming (antes: 1) — obtido ${contagem.naoStreaming}`);
    assert(ms < 3000, `desiste perto do prazo pedido (400 ms), não 3× ele — levou ${ms} ms`);

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S349 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}
main().catch((err) => { console.error('S349 erro inesperado:', err); process.exitCode = 1; });
