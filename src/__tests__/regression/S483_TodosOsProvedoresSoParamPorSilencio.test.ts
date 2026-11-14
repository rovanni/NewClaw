/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S483 (ADR-027 em todos os provedores, 14/11/2026)
 * Todo provedor com streaming só para por TRAVAMENTO: nenhum primeiro pedaço, ou silêncio (nenhum pedaço com CONTEÚDO por
 * SILENCIO_DO_MODELO_S). Nunca por duração com o modelo gerando. Keepalive (comentário SSE, `ping` da Anthropic) e delta vazio
 * não reiniciam o relógio do silêncio.
 *
 * ORIGEM: até 14/11/2026 só o OllamaProvider fazia streaming e vigiava o silêncio. OpenAI-compatível (OpenRouter, Groq,
 * DeepSeek, modelo local), Anthropic e Gemini eram chamadas inteiras: o ProviderFactory as cortava pelo prazo de quem chamou,
 * gerando ou não. E `isChunkActive` contava `candidates[0]` vazio (Gemini) e toda moldura de bloco (Anthropic) como atividade.
 *
 * Mede comportamento real: servidor HTTP de verdade na máquina, `fetch` e undici de verdade; as URLs fixas dos provedores
 * nativos são redirecionadas para ele.
 *
 * REGRESSÃO SE: o silêncio deixar de cortar; keepalive ou delta vazio reiniciar o relógio; uma geração longa e ativa for
 * cortada por prazo; um provedor com streaming deixar de declarar `vigiaSilencio`; a montagem do stream (texto, chamada de
 * ferramenta em pedaços, fim) ou a telemetria ao vivo se perder.
 *
 * Execução: npx ts-node src/__tests__/regression/S483_TodosOsProvedoresSoParamPorSilencio.test.ts
 */
import * as http from 'http';
import { AddressInfo } from 'net';
import { OpenAIProvider, OpenRouterProvider } from '../../core/OpenAIProvider';
import { AnthropicProvider } from '../../core/AnthropicProvider';
import { GeminiProvider } from '../../core/GeminiProvider';
import { GroqProvider } from '../../core/GroqProvider';
import { DeepSeekProvider } from '../../core/DeepSeekProvider';
import { OllamaProvider } from '../../core/OllamaProvider';
import { ProviderFactory } from '../../core/ProviderFactory';
import { isChunkActive, lerEventosSSE, prazoDoPrimeiroPedaco, VigiaDeSilencio } from '../../core/streamVigiado';
import { medidorDoProcesso } from '../../core/medidorDeTrabalho';
import type { CallTelemetry, LLMResponse, RawApiChunk } from '../../core/providerTypes';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (process.env.S483_LOGS) return fn();   // depuração: mostra os logs dos provedores
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (): boolean => true;
    try { return await fn(); } finally { process.stdout.write = orig; }
};

type Formato = 'openai' | 'anthropic' | 'gemini';
type Cenario = 'longa' | 'silencio' | 'keepalive' | 'ferramenta' | 'ferramenta-cortada';
let cenario: Cenario = 'longa';
const PEDACOS_DA_LONGA = 25;   // um a cada 100 ms: 2,5 s gerando, com a janela de silêncio de 1 s

const sse = (dados: unknown, evento?: string) => `${evento ? `event: ${evento}\n` : ''}data: ${JSON.stringify(dados)}\n\n`;
const texto: Record<Formato, (t: string) => string> = {
    openai: t => sse({ choices: [{ delta: { content: t }, finish_reason: null }] }),
    anthropic: t => sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }, 'content_block_delta'),
    gemini: t => sse({ candidates: [{ content: { parts: [{ text: t }], role: 'model' } }] }),
};
const inicio: Record<Formato, string> = {
    openai: '',
    anthropic: sse({ type: 'message_start', message: { usage: { input_tokens: 7 } } }, 'message_start')
        + sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'content_block_start'),
    gemini: '',
};
const fim: Record<Formato, string> = {
    openai: sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + sse({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 25 } }) + 'data: [DONE]\n\n',
    anthropic: sse({ type: 'content_block_stop', index: 0 }, 'content_block_stop')
        + sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 25 } }, 'message_delta')
        + sse({ type: 'message_stop' }, 'message_stop'),
    gemini: sse({ candidates: [{ content: { parts: [{ text: '' }], role: 'model' }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 25 } }),
};
/** O que um servidor manda para manter a conexão viva — nenhum é pedaço do modelo. */
const keepalive: Record<Formato, string[]> = {
    openai: [': OPENROUTER PROCESSING\n\n', sse({ choices: [{ delta: { content: '' }, finish_reason: null }] }), sse({ choices: [{ delta: { tool_calls: [] }, finish_reason: null }] })],
    anthropic: [sse({ type: 'ping' }, 'ping'), sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '' } }, 'content_block_delta'), sse({ type: 'content_block_stop', index: 0 }, 'content_block_stop')],
    gemini: [sse({ candidates: [{}] }), sse({ candidates: [{ content: { parts: [{ text: '' }] } }] }), ': keepalive\n\n'],
};
const ferramenta: Record<Formato, string[]> = {
    openai: [
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'buscar', arguments: '' } }] } }] }),
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] } }] }),
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }] }),
        sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }), 'data: [DONE]\n\n',
    ],
    anthropic: [
        sse({ type: 'message_start', message: { usage: { input_tokens: 7 } } }, 'message_start'),
        sse({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'buscar', input: {} } }, 'content_block_start'),
        sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":' } }, 'content_block_delta'),
        sse({ type: 'ping' }, 'ping'),
        sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"x"}' } }, 'content_block_delta'),
        sse({ type: 'content_block_stop', index: 0 }, 'content_block_stop'),
        sse({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }, 'message_delta'),
        sse({ type: 'message_stop' }, 'message_stop'),
    ],
    gemini: [sse({ candidates: [{ content: { parts: [{ functionCall: { name: 'buscar', args: { q: 'x' } } }], role: 'model' }, finishReason: 'STOP' }] })],
};

function formatoDa(url: string): Formato {
    if (url.includes('/messages')) return 'anthropic';
    if (url.includes(':streamGenerateContent')) return 'gemini';
    return 'openai';
}

function servidor(): Promise<{ base: string; fechar: () => void }> {
    const srv = http.createServer((req, res) => {
        const url = req.url ?? '';
        if (url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
        req.resume();
        req.on('end', () => {
            const f = formatoDa(url);
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
            const timers: NodeJS.Timeout[] = [];
            res.on('close', () => timers.forEach(t => clearInterval(t)));
            if (cenario === 'ferramenta') { ferramenta[f].forEach(e => res.write(e)); res.end(); return; }
            if (cenario === 'ferramenta-cortada') {
                // Texto, depois a chamada de ferramenta só até a metade dos argumentos — e silêncio (conexão aberta).
                res.write(inicio[f]);
                res.write(texto[f]('vou buscar'));
                if (f === 'anthropic') res.write(sse({ type: 'content_block_stop', index: 0 }, 'content_block_stop'));
                const parcial = f === 'anthropic' ? ferramenta.anthropic.slice(1, 3).map(e => e.replace(/"index":0/g, '"index":1')) : ferramenta.openai.slice(0, 2);
                parcial.forEach(e => res.write(e));
                return;
            }
            res.write(inicio[f]);
            if (cenario === 'longa') {
                let n = 0;
                timers.push(setInterval(() => {
                    if (n++ < PEDACOS_DA_LONGA) { res.write(texto[f]('a')); return; }
                    res.end(fim[f]);
                    timers.forEach(t => clearInterval(t));
                }, 100));
                return;
            }
            res.write(texto[f]('par'));
            if (cenario === 'keepalive') {
                let i = 0;
                timers.push(setInterval(() => res.write(keepalive[f][i++ % keepalive[f].length]), 150));
            }
            // 'silencio': calado, com a conexão aberta
        });
    });
    return new Promise(ok => srv.listen(0, '127.0.0.1', () => ok({
        base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
        fechar: () => { srv.closeAllConnections(); srv.close(); },
    })));
}

/** Corre a chamada com um teto de segurança do TESTE (o keepalive que reiniciasse o relógio faria a chamada nunca acabar). */
async function comTeto(fn: (signal: AbortSignal) => Promise<LLMResponse>, tetoMs = 8000): Promise<{ r?: LLMResponse; erro?: string; ms: number; estourou: boolean }> {
    const ctrl = new AbortController();
    let estourou = false;
    const t = setTimeout(() => { estourou = true; ctrl.abort(); }, tetoMs);
    const t0 = Date.now();
    // Provedor que nem obedece ao sinal ficaria pendurado para sempre: 2 s depois do teto, o teste segue e reprova.
    let largar: NodeJS.Timeout | undefined;
    const pendurado = new Promise<{ erro: string; ms: number; estourou: boolean }>(ok => {
        largar = setTimeout(() => ok({ erro: 'pendurado: não obedeceu nem ao sinal de cancelamento', ms: Date.now() - t0, estourou: true }), tetoMs + 2000);
    });
    try {
        return await Promise.race([
            quiet(() => fn(ctrl.signal)).then(r => ({ r, ms: Date.now() - t0, estourou }), e => ({ erro: String(e), ms: Date.now() - t0, estourou })),
            pendurado,
        ]);
    } finally { clearTimeout(t); clearTimeout(largar); }
}

async function main(): Promise<void> {
    console.log('\n=== S483-1 — isChunkActive: só conteúdo do modelo é atividade ===');
    {
        const nao: Array<[string, RawApiChunk]> = [
            ['Gemini: candidates[0] vazio', { candidates: [{}] }],
            ['Gemini: parte com texto vazio', { candidates: [{ content: { parts: [{ text: '' }] } }] }],
            ['Anthropic: ping', { type: 'ping' }],
            ['Anthropic: início de bloco de texto (moldura)', { type: 'content_block_start', content_block: { type: 'text' } } as RawApiChunk],
            ['Anthropic: fim de bloco', { type: 'content_block_stop' }],
            ['Anthropic: delta de texto vazio', { type: 'content_block_delta', delta: { type: 'text_delta', text: '' } }],
            ['OpenAI: delta vazio', { choices: [{ delta: { content: '' } }] }],
            ['OpenAI: tool_calls vazio', { choices: [{ delta: { tool_calls: [] } }] }],
            ['Ollama: mensagem vazia', { message: { content: '' } }],
        ];
        for (const [nome, c] of nao) assert(!isChunkActive(c), `não é atividade: ${nome}`);
        const sim: Array<[string, RawApiChunk]> = [
            ['Gemini: texto', { candidates: [{ content: { parts: [{ text: 'oi' }] } }] }],
            ['Gemini: chamada de ferramenta', { candidates: [{ content: { parts: [{ functionCall: { name: 'f' } }] } }] }],
            ['Anthropic: texto', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'oi' } }],
            ['Anthropic: pedaço do JSON da ferramenta', { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"a"' } }],
            ['Anthropic: início de chamada de ferramenta', { type: 'content_block_start', content_block: { type: 'tool_use', name: 'f' } } as RawApiChunk],
            ['OpenAI: texto', { choices: [{ delta: { content: 'oi' } }] }],
            ['OpenRouter: raciocínio (`reasoning`)', { choices: [{ delta: { reasoning: 'hm' } as never }] }],
            ['OpenAI: pedaço de chamada de ferramenta', { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{' } }] } }] }],
            ['Ollama: raciocínio', { message: { thinking: 'hm' } }],
            ['Ollama: fim', { done: true }],
        ];
        for (const [nome, c] of sim) assert(isChunkActive(c), `é atividade: ${nome}`);
    }

    console.log('\n=== S483-2 — leitor SSE: comentário ignorado, [DONE] encerra, linha partida remontada ===');
    {
        const partes = [': OPENROUTER PROCESSING\r', '\n\r\nevent: x\r\ndata: {"a":', '1}\r', '\n\r\ndata: {"b":\ndata: 2}\n\n', 'data: [DONE]\n\ndata: {"c":3}\n\n'];
        const corpo = new ReadableStream<Uint8Array>({ start(c) { partes.forEach(p => c.enqueue(new TextEncoder().encode(p))); c.close(); } });
        const lidos: unknown[] = [];
        for await (const e of lerEventosSSE(corpo)) lidos.push({ evento: e.evento, dados: e.dados });
        assert(JSON.stringify(lidos) === JSON.stringify([{ evento: 'x', dados: { a: 1 } }, { dados: { b: 2 } }]),
            'dois eventos (nome preservado, data multilinha unida); nada depois do [DONE]', lidos);
    }

    console.log('\n=== S483-3 — relógio do primeiro pedaço corta; prazo pela leitura MEDIDA do modelo ===');
    {
        const ctrl = new AbortController();
        const vigia = new VigiaDeSilencio({ controller: ctrl, primeiroPedacoMs: 200, silencioMs: 60_000, id: 's483', log: { info() {}, warn() {}, error() {} } });
        vigia.iniciar();
        await new Promise(r => setTimeout(r, 350));
        assert(ctrl.signal.aborted && vigia.motivo === 'sem_primeiro_pedaco', 'sem primeiro pedaço no prazo: corta, com o motivo', vigia.motivo);
        vigia.encerrar();

        const prompt = [{ role: 'user' as const, content: 'x'.repeat(40_000) }];   // ~10 mil tokens
        const semMedida = prazoDoPrimeiroPedaco(prompt, 's483-sem-medida');
        assert(semMedida.ms === 300_000, `sem medição: a base pelo tamanho (${semMedida.ms} ms, teto 300 s)`);
        const original = medidorDoProcesso.velocidade.bind(medidorDoProcesso);
        (medidorDoProcesso as any).velocidade = (modelo: string, modo: string) => modelo === 's483-local' ? { leitura: modo === 'livre' ? 21 : 40, amostras: 5 } : original(modelo, modo as never);
        try {
            const medido = prazoDoPrimeiroPedaco(prompt, 's483-local');
            const esperado = Math.ceil(Math.ceil(40_000 / 3.55) / 21 * 1.5 * 1000);
            assert(medido.ms === esperado && medido.ms > 300_000, `modelo local medido a 21 tok/s: ${Math.round(medido.ms / 1000)} s, acima dos 300 s da base (a mais lenta entre os modos)`, medido);
        } finally { (medidorDoProcesso as any).velocidade = original; }
    }

    console.log('\n=== S483-4 — todo provedor com streaming declara que vigia o silêncio ===');
    for (const p of [new OllamaProvider('http://x.invalid', 'm'), new OpenAIProvider('', 'm', 'http://x.invalid', 'local'), new OpenRouterProvider('k', 'm'),
        new GroqProvider('k', 'm'), new DeepSeekProvider('k', 'm'), new AnthropicProvider('k', 'm'), new GeminiProvider('k', 'm')]) {
        assert(p.vigiaSilencio === true, `${p.name}: vigiaSilencio`);
    }

    const s = await servidor();
    const fetchOriginal = globalThis.fetch;
    // As URLs fixas dos provedores nativos vão para o servidor local (o caminho é mantido).
    globalThis.fetch = ((url: any, init?: any) => fetchOriginal(String(url)
        .replace('https://api.anthropic.com', s.base)
        .replace('https://generativelanguage.googleapis.com', s.base)
        .replace('https://openrouter.ai', s.base), init)) as typeof fetch;
    process.env.SILENCIO_DO_MODELO_S = '1';
    const provedores: Array<{ nome: string; criar: () => { chat: OpenAIProvider['chat'] } }> = [
        { nome: 'OpenAI-compatível (modelo local)', criar: () => new OpenAIProvider('', 'local.gguf', `${s.base}/v1`, 'Modelo local') },
        { nome: 'OpenRouter', criar: () => new OpenRouterProvider('k', 'm') },
        { nome: 'Anthropic', criar: () => new AnthropicProvider('k', 'm') },
        { nome: 'Gemini', criar: () => new GeminiProvider('k', 'm') },
    ];
    try {
        console.log('\n=== S483-5 — em silêncio depois de um pedaço: cortado pela janela (1 s), o pedaço vai marcado interrompido ===');
        cenario = 'silencio';
        for (const p of provedores) {
            const r = await comTeto(sig => p.criar().chat([{ role: 'user', content: 'x' }], undefined, { signal: sig, timeoutMs: 600_000 }));
            assert(!r.estourou && r.ms >= 900 && r.ms < 5000 && r.r?.content === 'par' && r.r?.interrupted === true,
                `${p.nome}: cortado em ${r.ms} ms (prazo pedido: 10 min), "par" interrompido`, r);
        }

        console.log('\n=== S483-6 — keepalive e delta vazio NÃO reiniciam o relógio do silêncio ===');
        cenario = 'keepalive';
        for (const p of provedores) {
            const r = await comTeto(sig => p.criar().chat([{ role: 'user', content: 'x' }], undefined, { signal: sig }));
            assert(!r.estourou && r.ms >= 900 && r.ms < 5000 && r.r?.interrupted === true,
                `${p.nome}: keepalive a cada 150 ms e mesmo assim cortado em ${r.ms} ms`, r);
        }

        console.log('\n=== S483-7 — geração longa e ativa (2,5 s) com prazo de 300 ms pedido ao ProviderFactory: não é cortada ===');
        cenario = 'longa';
        const fabricas: Array<{ nome: string; pf: () => ProviderFactory; provedor: string }> = [
            { nome: 'OpenAI-compatível (modelo local)', provedor: 'Modelo local', pf: () => new ProviderFactory({ defaultProvider: 'Modelo local', ollamaUrl: 'http://x.invalid', customProviders: [{ label: 'Modelo local', baseUrl: `${s.base}/v1`, model: 'local.gguf' }] } as any) },
            { nome: 'OpenRouter', provedor: 'openrouter', pf: () => new ProviderFactory({ defaultProvider: 'openrouter', ollamaUrl: 'http://x.invalid', openrouterKey: 'k', modelosNativos: { openrouter: 'm' } } as any) },
            { nome: 'Anthropic', provedor: 'anthropic', pf: () => new ProviderFactory({ defaultProvider: 'anthropic', ollamaUrl: 'http://x.invalid', anthropicKey: 'k', modelosNativos: { anthropic: 'm' } } as any) },
            { nome: 'Gemini', provedor: 'gemini', pf: () => new ProviderFactory({ defaultProvider: 'gemini', ollamaUrl: 'http://x.invalid', geminiKey: 'k', modelosNativos: { gemini: 'm' } } as any) },
        ];
        for (const f of fabricas) {
            const telemetria: CallTelemetry = { attempts: [] };
            let aoVivoNoMeio = 0;
            const espiao = setTimeout(() => { aoVivoNoMeio = telemetria.attempts[0]?.pedacosAteAgora ?? 0; }, 1500);
            const t0 = Date.now();
            const r: any = await quiet(() => f.pf().chatWithFallback([{ role: 'user', content: 'gere' }], undefined, f.provedor, 300, undefined, undefined, { telemetry: telemetria }));
            clearTimeout(espiao);
            const ms = Date.now() - t0;
            assert(r.status === 'success' && r.content === 'a'.repeat(PEDACOS_DA_LONGA) && r.interrupted === false && ms >= 2400,
                `${f.nome}: resposta inteira em ${ms} ms, não interrompida`, { status: r.status, content: r.content, interrupted: r.interrupted, ms });
            const t = telemetria.attempts[0];
            assert(aoVivoNoMeio >= 5 && (t?.pedacosAteAgora ?? 0) >= PEDACOS_DA_LONGA && !!t?.ultimoPedacoEm,
                `${f.nome}: telemetria AO VIVO (${aoVivoNoMeio} pedaços aos 1,5 s; o juiz vê que ainda gera)`, t);
        }

        console.log('\n=== S483-8 — montagem do stream: chamada de ferramenta em pedaços, fim normal ===');
        cenario = 'ferramenta';
        for (const p of provedores) {
            const r = await comTeto(sig => p.criar().chat([{ role: 'user', content: 'x' }], [{ name: 'buscar', description: 'd', parameters: {} }], { signal: sig }));
            const tc = r.r?.toolCalls?.[0];
            assert(r.r?.toolCalls?.length === 1 && tc?.name === 'buscar' && tc?.arguments?.q === 'x' && r.r?.interrupted === false,
                `${p.nome}: uma chamada "buscar" com { q: "x" }, não interrompida`, r);
        }

        console.log('\n=== S483-9 — chamada de ferramenta cortada no meio dos argumentos: descartada, nunca executada pela metade ===');
        cenario = 'ferramenta-cortada';
        for (const p of provedores.filter(x => x.nome !== 'Gemini')) {   // o Gemini manda a chamada inteira num pedaço só
            const r = await comTeto(sig => p.criar().chat([{ role: 'user', content: 'x' }], [{ name: 'buscar', description: 'd', parameters: {} }], { signal: sig }));
            assert(!r.estourou && r.r?.content === 'vou buscar' && r.r?.interrupted === true && r.r?.toolCalls === undefined,
                `${p.nome}: o texto vem interrompido e a chamada incompleta não vem`, r);
        }
    } finally {
        globalThis.fetch = fetchOriginal;
        delete process.env.SILENCIO_DO_MODELO_S;
        s.fechar();
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S483 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}
main().catch((err) => { console.error('S483 erro inesperado:', err); process.exit(1); });
