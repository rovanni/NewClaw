/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S444 (ADR-027)
 * A chamada ao modelo com streaming só para por TRAVAMENTO: silêncio (nenhum pedaço por SILENCIO_DO_MODELO_S, padrão 90 s)
 * ou nenhum primeiro pedaço. Nunca por duração com o modelo gerando — nem pelo teto interno do provedor (o antigo
 * MAX_TIMEOUT), nem pelo prazo de quem chamou (o timer de tentativa do ProviderFactory).
 *
 * INCIDENTE REAL (VPS, 23/10/2026 00:15): uma chamada foi cortada aos 32,6 s com 866 pedaços de raciocínio chegando (9.357
 * caracteres descartados). Medido: 58 cortes assim no Windows e 42 na VPS.
 *
 * REGRESSÃO SE: o modelo gerando for cortado por um prazo; o silêncio deixar de cortar; o provedor deixar de declarar que
 * vigia o silêncio; ou um provedor sem streaming passar a ser tratado como se vigiasse.
 *
 * Execução: npx ts-node src/__tests__/regression/S444_ChamadaSoParaPorSilencio.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { ProviderFactory } from '../../core/ProviderFactory';
import { OllamaProvider, silencioDoModeloMs } from '../../core/OllamaProvider';
import { OpenAIProvider } from '../../core/OpenAIProvider';

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
const linha = (o: unknown) => new TextEncoder().encode(JSON.stringify(o) + '\n');

/** Servidor falso: pensa (um pedaço a cada 20 ms) por `pensaMs`, responde "ok" e termina; ou, com `silenciaDepoisDe`, manda um pedaço e cala para sempre. */
function servidor(cfg: { pensaMs?: number; silenciaDepoisDe?: number }): typeof fetch {
    return (async (_url: string, init?: { signal?: AbortSignal }) => {
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                const t0 = Date.now();
                let enviados = 0;
                const t = setInterval(() => {
                    try {
                        if (cfg.silenciaDepoisDe !== undefined) {
                            if (enviados++ < cfg.silenciaDepoisDe) controller.enqueue(linha({ message: { thinking: 'pensando...' } }));
                            return;   // calado: nenhum pedaço mais
                        }
                        if (Date.now() - t0 < (cfg.pensaMs ?? 0)) { controller.enqueue(linha({ message: { thinking: 'pensando...' } })); return; }
                        controller.enqueue(linha({ message: { content: 'ok' } }));
                        controller.enqueue(linha({ done: true, done_reason: 'stop', eval_count: 3 }));
                        clearInterval(t);
                        controller.close();
                    } catch { clearInterval(t); }
                }, 20);
                init?.signal?.addEventListener('abort', () => { clearInterval(t); try { controller.error(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })); } catch { /* já encerrado */ } });
            },
        });
        return { ok: true, status: 200, body: stream } as unknown as Response;
    }) as unknown as typeof fetch;
}

async function main(): Promise<void> {
    const original = global.fetch;
    try {
        console.log('\n=== S444-1 — gerando 2,5 s com prazo pedido de 300 ms: não é cortado, a resposta chega ===');
        global.fetch = servidor({ pensaMs: 2500 });
        let t0 = Date.now();
        const pf = new ProviderFactory({ defaultProvider: 'ollama', ollamaUrl: 'http://fake-ollama.invalid', ollamaModel: 'modelo-que-pensa' } as any);
        const r1: any = await quiet(() => pf.chatWithFallback([{ role: 'user', content: 'pense e responda' }], undefined, 'ollama', 300));
        let ms = Date.now() - t0;
        assert(r1.status === 'success' && r1.content === 'ok', `resposta entregue depois de ${ms} ms (antes: cortada no prazo de 300 ms)`, { status: r1.status, content: r1.content });
        assert(ms >= 2400, 'durou o que o trabalho precisou');

        console.log('\n=== S444-2 — em silêncio: cortado depois da janela de silêncio (SILENCIO_DO_MODELO_S=1) ===');
        process.env.SILENCIO_DO_MODELO_S = '1';
        assert(silencioDoModeloMs() === 1000, 'a janela de silêncio é configurável (lida a cada chamada)');
        global.fetch = servidor({ silenciaDepoisDe: 3 });
        t0 = Date.now();
        let erro = '';
        await quiet(() => new OllamaProvider('http://fake-ollama.invalid', 'modelo-calado').chat([{ role: 'user', content: 'x' }], undefined, { timeoutMs: 600_000 })
            .catch((e) => { erro = String(e); }));
        ms = Date.now() - t0;
        assert(ms >= 900 && ms < 5000, `cortado pelo silêncio em ${ms} ms (o prazo pedido era 10 min)`, erro);
        delete process.env.SILENCIO_DO_MODELO_S;
        assert(silencioDoModeloMs() === 90_000, 'padrão: 90 s');
    } finally {
        global.fetch = original;
        delete process.env.SILENCIO_DO_MODELO_S;
    }

    console.log('\n=== S444-3 — quem vigia o silêncio declara; quem não tem streaming, não ===');
    assert(new OllamaProvider('http://x.invalid', 'm').vigiaSilencio === true, 'OllamaProvider (streaming) vigia o silêncio');
    assert((new OpenAIProvider('', 'm', 'http://x.invalid') as any).vigiaSilencio !== true, 'OpenAIProvider (sem streaming) não vigia — o prazo pelo trabalho continua valendo para ele');

    console.log('\n=== S444-4 — estrutura: nenhum teto de duração no streaming nem relógio do ProviderFactory para quem vigia ===');
    const ollama = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'OllamaProvider.ts'), 'utf-8');
    const pfSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'ProviderFactory.ts'), 'utf-8');
    assert(!/MAX_TIMEOUT\s*=|maxTimer\s*=/.test(ollama), 'streamChat não tem MAX_TIMEOUT');
    assert(/const effectiveTimeoutMs = vigiaSilencio \? undefined/.test(pfSrc) && /const timeoutDaTentativa = vigiaSilencio \? undefined/.test(pfSrc),
        'ProviderFactory não arma timer nem passa prazo para o provedor que vigia o silêncio');

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S444 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}
main().catch((err) => { console.error('S444 erro inesperado:', err); process.exit(1); });
