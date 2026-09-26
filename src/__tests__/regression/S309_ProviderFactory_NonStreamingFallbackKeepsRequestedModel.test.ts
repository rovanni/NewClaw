/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S309 (Sprint 7, issue 048)
 * O fallback SEM streaming do `ProviderFactory.chatWithFallback` respeita o modelo que o chamador pediu.
 *
 * Achado no replay do incidente (26/09/2026): com OBSERVER_MODEL=glm-5.3-flash (leve), o streaming do juiz
 * estourava o orçamento de raciocínio e a refação sem streaming rodava no modelo PADRÃO (pesado), que dava
 * timeout — o modelo configurado era trocado em silêncio. O streaming já criava uma instância com o modelo
 * pedido; o fallback usava a instância compartilhada.
 *
 * Usa o ProviderFactory REAL contra um Ollama falso local que registra o `model` de cada requisição.
 *
 *   1 → modelo pedido (dono = ollama): streaming E fallback usam o modelo pedido.
 *   2 → sem modelo pedido: o fallback usa o padrão (comportamento de sempre).
 *   3 → o modelo pedido não vaza para o padrão de outra chamada (a próxima, sem pedido, volta ao padrão).
 *   4 → o log do fallback diz qual modelo está usando.
 *
 * Execução: npx ts-node src/__tests__/regression/S309_ProviderFactory_NonStreamingFallbackKeepsRequestedModel.test.ts
 */
process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import * as http from 'http';
import type { AddressInfo } from 'net';
import { ProviderFactory } from '../../core/ProviderFactory';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

interface Seen { model: string; stream: boolean }

async function startFakeOllama(): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
    const seen: Seen[] = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            if (req.url === '/api/chat') {
                const j = JSON.parse(body || '{}') as { model?: string; stream?: boolean };
                seen.push({ model: String(j.model), stream: j.stream !== false });
                if (j.stream === false) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ model: j.model, message: { role: 'assistant', content: 'resposta do fallback' }, done: true }));
                } else {
                    // O streaming falha de forma NÃO retentável e rápida, para forçar o fallback sem esperar backoff.
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'streaming indisponível no teste' }));
                }
                return;
            }
            res.writeHead(404); res.end();
        });
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    return {
        url: `http://127.0.0.1:${port}`, seen,
        close: async () => { (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.(); await new Promise<void>(r => server.close(() => r())); },
    };
}

async function captureLogs<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (chunk: string | Uint8Array): boolean => { lines.push(String(chunk)); return true; };
    try { return { value: await fn(), lines }; } finally { process.stdout.write = orig; }
}
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

async function main(): Promise<void> {
    const fake = await startFakeOllama();
    try {
        const factory = new ProviderFactory({ defaultProvider: 'ollama', ollamaUrl: fake.url, ollamaModel: 'modelo-padrao' });
        const messages = [{ role: 'user', content: 'oi' }] as never;

        console.log('\n=== S309-1 — modelo pedido (dono = ollama): streaming E fallback usam o pedido ===');
        {
            fake.seen.length = 0;
            const { value: r, lines } = await captureLogs(() => factory.chatWithFallback(messages, undefined, 'ollama', 20000, undefined, 'modelo-leve'));
            const streaming = fake.seen.filter(s => s.stream).map(s => s.model);
            const fallback = fake.seen.filter(s => !s.stream).map(s => s.model);
            assert(r.status === 'success' && r.content === 'resposta do fallback', 'a chamada termina pelo fallback sem streaming', { status: r.status, content: r.content });
            assert(streaming.length >= 1 && streaming.every(m => m === 'modelo-leve'), 'a tentativa com streaming usou o modelo pedido', streaming);
            assert(fallback.length === 1 && fallback[0] === 'modelo-leve', 'o FALLBACK sem streaming também usou o modelo pedido (antes: modelo-padrao)', fallback);
            const log = lines.map(strip).find(l => l.includes('trying non-streaming fallback')) ?? '';
            assert(log.includes('model=modelo-leve'), 'o log do fallback diz qual modelo está usando', log.slice(0, 200));
        }

        console.log('\n=== S309-2/3 — sem modelo pedido: o fallback usa o padrão; e o pedido anterior não vaza ===');
        {
            fake.seen.length = 0;
            const { value: r, lines } = await captureLogs(() => factory.chatWithFallback(messages, undefined, 'ollama', 20000));
            const fallback = fake.seen.filter(s => !s.stream).map(s => s.model);
            assert(r.status === 'success', 'termina pelo fallback', r.status);
            assert(fallback.length === 1 && fallback[0] === 'modelo-padrao', 'sem modelo pedido, o fallback usa o padrão configurado', fallback);
            const log = lines.map(strip).find(l => l.includes('trying non-streaming fallback')) ?? '';
            assert(log.includes('model=modelo-padrao'), 'o log mostra o modelo padrão', log.slice(0, 200));
        }

        console.log('\n=== S309-4 — a instância compartilhada não foi alterada (concorrência) ===');
        {
            const shared = factory.getProviderWithModel(undefined, 'ollama') as unknown as { getModel(): string };
            assert(shared.getModel() === 'modelo-padrao', 'o modelo padrão do provider continua o configurado', shared.getModel());
        }
    } finally {
        await fake.close();
    }

    console.log(`\nS309 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exitCode = failed > 0 ? 1 : 0;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
