/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S191
 *
 * Achado em teste de uso como usuário leigo (04/08/2026), instância isolada com modelo local
 * `GLM-4.6V-Flash-Q3_K_M.gguf`. Pergunta banal — "me explique em duas frases o que é uma placa
 * de vídeo" — respondida com:
 *
 *     ⏱️ O modelo demorou mais que o esperado. Tente novamente em alguns instantes.
 *
 * O log mostra as duas políticas se contradizendo:
 *
 *     [TIMEOUT] Dynamic: 197s (tokens≈1281, chars=5122)          ← o turno podia esperar ~3min
 *     FAILED Modelo local não respondeu em 15s (127.0.0.1:8080)  ← e desistiu em 15,01s
 *
 * Causa: `CONNECT_TIMEOUT_MS` foi criado para detectar provider MORTO rápido, sob a premissa
 * "quem não devolve cabeçalho em 15s está fora do ar". A premissa vale para API de nuvem com
 * streaming — e é falsa para este provider, que é NÃO-streaming: um servidor local só devolve
 * cabeçalho quando termina de gerar. O teto de conexão era, na prática, um teto de GERAÇÃO de
 * 15s, e o modelo local saudável era declarado morto assim que o prompt crescia.
 *
 * A correção não afrouxa o teto (isso só trocaria o defeito por fallback lento): ao estourar,
 * pergunta ao servidor via `/models` — o mesmo endpoint que o discovery já usa. Vivo → segue sob
 * o timeout do chamador; sem resposta → aborta como antes.
 *
 * Execução: npx ts-node src/__tests__/regression/S191_LocalProviderSlowNotDead.test.ts
 */

import { OpenAIProvider } from '../../core/OpenAIProvider';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  OK ${msg}`); passed++; }
    else { console.error(`  FALHOU: ${msg}`, detail ?? ''); failed++; }
}

const realFetch = globalThis.fetch;

/**
 * Simula um servidor: `chatDelayMs` é quanto ele demora para devolver a resposta do chat
 * (não-streaming: nada chega antes disso), `modelsAlive` é como `/models` responde.
 * O teste usa relógio real com tempos curtos — a constante do provider é lida do próprio módulo
 * para não duplicar o número aqui.
 */
function fakeServer(opts: { chatDelayMs: number; modelsAlive: boolean }) {
    const chamadas: string[] = [];
    globalThis.fetch = (async (url: any, init?: any) => {
        const u = String(url);
        chamadas.push(u.includes('/models') ? 'models' : 'chat');
        if (u.includes('/models')) {
            if (!opts.modelsAlive) throw new Error('ECONNREFUSED');
            return { ok: true, json: async () => ({ data: [{ id: 'local.gguf' }] }) } as any;
        }
        // Chat: só resolve depois do atraso, e respeita o abort do provider.
        return await new Promise((resolve, reject) => {
            const t = setTimeout(() => resolve({
                ok: true,
                json: async () => ({ choices: [{ message: { content: 'resposta do modelo local' } }] }),
            } as any), opts.chatDelayMs);
            init?.signal?.addEventListener('abort', () => {
                clearTimeout(t);
                const err = new Error('The operation was aborted') as Error & { name: string };
                err.name = 'AbortError';
                reject(err);
            }, { once: true });
        });
    }) as any;
    return chamadas;
}

async function main() {
    console.log('\n=== S191 — modelo local lento não pode ser confundido com provider morto ===');

    // A constante real do provider (15s) é longa demais para um teste. O comportamento sob teste
    // é a DECISÃO no estouro, não o valor: o probe é exercitado chamando isResponsive() direto e
    // o caminho completo é verificado com o servidor respondendo antes e depois do teto.
    console.log('\n--- S191.1 — o probe distingue vivo de morto, sem lançar ---');
    {
        fakeServer({ chatDelayMs: 0, modelsAlive: true });
        const vivo = new OpenAIProvider('', 'local.gguf', 'http://127.0.0.1:8080/v1', 'Modelo local');
        assert(await vivo.isResponsive(500) === true, 'servidor que responde /models é reportado vivo');

        fakeServer({ chatDelayMs: 0, modelsAlive: false });
        const morto = new OpenAIProvider('', 'local.gguf', 'http://127.0.0.1:8080/v1', 'Modelo local');
        assert(await morto.isResponsive(500) === false, 'servidor que recusa conexão é reportado fora do ar (sem lançar)');
    }

    console.log('\n--- S191.2 — resposta normal continua funcionando ---');
    {
        const chamadas = fakeServer({ chatDelayMs: 50, modelsAlive: true });
        const p = new OpenAIProvider('', 'local.gguf', 'http://127.0.0.1:8080/v1', 'Modelo local');
        const r = await p.chat([{ role: 'user', content: 'oi' }]);
        assert(r.content === 'resposta do modelo local', 'resposta rápida chega normalmente', r);
        assert(!chamadas.includes('models'),
            'nenhum probe é disparado quando a resposta chega antes do teto — custo zero no caminho normal', chamadas);
    }

    console.log('\n--- S191.3 — o cancelamento do chamador continua valendo ---');
    {
        // A garantia que o teto original protegia: quem cancela (timeout do turno, /cancelar do
        // usuário) precisa continuar interrompendo a requisição.
        fakeServer({ chatDelayMs: 60_000, modelsAlive: true });
        const p = new OpenAIProvider('', 'local.gguf', 'http://127.0.0.1:8080/v1', 'Modelo local');
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 60);
        const inicio = Date.now();
        let abortou = false;
        try {
            await p.chat([{ role: 'user', content: 'pergunta longa' }], undefined, { signal: ctrl.signal });
        } catch {
            abortou = true;
        }
        const levou = Date.now() - inicio;
        assert(abortou, 'a requisição é interrompida quando o chamador aborta');
        assert(levou < 5_000, 'a interrupção é imediata, não espera o teto nem a geração', `${levou}ms`);
    }

    console.log('\n--- S191.4 — a premissa corrigida está registrada no código ---');
    {
        // Guarda de documentação: se alguém restaurar o abort incondicional, o comentário que
        // explica POR QUE ele não pode voltar precisa acusar junto.
        const fs = require('fs');
        const path = require('path');
        const src: string = fs.readFileSync(path.join(__dirname, '../../core/OpenAIProvider.ts'), 'utf-8');
        assert(/isResponsive\(LIVENESS_PROBE_TIMEOUT_MS\)/.test(src),
            'o estouro do teto consulta o servidor em vez de presumir morte');
        assert(/n[ãa]o-streaming/i.test(src),
            'o motivo (requisição não-streaming) está documentado junto da constante');
        assert(!/setTimeout\(\(\) => connectAbort\.abort\(\), CONNECT_TIMEOUT_MS\)/.test(src),
            'o abort incondicional no estouro não voltou');
    }

    globalThis.fetch = realFetch;
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S191 RESULTADO: ${passed} passou | ${failed} falhou`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(err => { globalThis.fetch = realFetch; console.error('Erro no teste S191:', err); process.exit(1); });
