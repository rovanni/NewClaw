/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S452 (28/10/2026)
 *
 * Resposta vazia porque o modelo gastou o limite de saída raciocinando (`done_reason: "length"`, nenhum texto) não é
 * falha passageira: a mesma chamada, com a mesma entrada e o mesmo limite, tende a cortar de novo.
 *
 * ORIGEM: instalação Windows, 25/10/2026. Três vezes o juiz (`saida_contra_evidencia`, glm-5.3-flash:cloud) cortou em
 * 32.700 tokens só de raciocínio; o ProviderFactory repetiu (cortou igual) e refez sem streaming (nada): ~6 min por pedido,
 * etapas de 10–15 min que terminaram "entregando COM AVISO".
 *
 * SOMBRA (regra das sprints: sombra antes de mudar comportamento): por padrão o comportamento é o de antes, e o log
 * registra o que a regra nova faria e quanto renderia (`[CORTE-LIMITE-SOMBRA]`). Com CORTE_PELO_LIMITE_SEM_REPETIR=1, o
 * corte não é repetido nem refeito sem streaming. Resposta vazia SEM corte (glitch do provedor) continua sendo repetida.
 *
 * REGRESSÃO SE: a sombra mudar o comportamento; com a regra ligada, o corte ser repetido ou refeito; a vazia sem corte
 * deixar de ser repetida; ou a sombra não registrar o que a repetição rendeu.
 *
 * Execução: npx ts-node src/__tests__/regression/S452_CortePeloLimiteNaoRepete.test.ts
 */
import { ProviderFactory } from '../../core/ProviderFactory';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

/** Roda calado e devolve o que foi escrito no stdout (os logs). */
async function capturando<T>(fn: () => Promise<T>): Promise<{ r: T; saida: string }> {
    const orig = process.stdout.write.bind(process.stdout);
    let saida = '';
    (process.stdout.write as unknown) = (chunk: unknown): boolean => { saida += String(chunk); return true; };
    try { return { r: await fn(), saida }; } finally { process.stdout.write = orig; }
}

type Desfecho = 'corte' | 'vazia' | 'texto';
interface Contagem { streaming: number; naoStreaming: number }

/** Servidor Ollama falso: cada chamada por streaming segue o roteiro (a última se repete); sem streaming, nada de texto. */
function fetchComRoteiro(roteiro: Desfecho[], contagem: Contagem): typeof fetch {
    return (async (url: string, init?: { body?: string }) => {
        if (!String(url).endsWith('/api/chat')) return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (body.stream === false) {
            contagem.naoStreaming++;
            return { ok: true, status: 200, json: async () => ({ message: { content: '', thinking: 'pensando...' }, done: true, done_reason: 'length' }) } as unknown as Response;
        }
        const desfecho = roteiro[Math.min(contagem.streaming, roteiro.length - 1)];
        contagem.streaming++;
        const linhas = desfecho === 'texto'
            ? [{ message: { content: 'veredito' } }, { done: true, done_reason: 'stop', eval_count: 5 }]
            : desfecho === 'corte'
                ? [{ message: { thinking: 'pensando...' } }, { message: { thinking: ' e pensando' } }, { done: true, done_reason: 'length', eval_count: 32700 }]
                : [{ done: true, done_reason: 'stop', eval_count: 0 }];
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                for (const l of linhas) controller.enqueue(new TextEncoder().encode(JSON.stringify(l) + '\n'));
                controller.close();
            },
        });
        return { ok: true, status: 200, body: stream } as unknown as Response;
    }) as unknown as typeof fetch;
}

async function chamar(roteiro: Desfecho[], regraLigada: boolean): Promise<{ r: any; saida: string; contagem: Contagem; ms: number }> {
    const contagem: Contagem = { streaming: 0, naoStreaming: 0 };
    const original = global.fetch;
    const flagAntes = process.env.CORTE_PELO_LIMITE_SEM_REPETIR;
    global.fetch = fetchComRoteiro(roteiro, contagem);
    if (regraLigada) process.env.CORTE_PELO_LIMITE_SEM_REPETIR = '1'; else delete process.env.CORTE_PELO_LIMITE_SEM_REPETIR;
    const t0 = Date.now();
    try {
        const pf = new ProviderFactory({ defaultProvider: 'ollama', ollamaUrl: 'http://fake-ollama.invalid', ollamaModel: 'juiz-que-pensa' } as any);
        const { r, saida } = await capturando(() => pf.chatWithFallback([{ role: 'user', content: 'confira a resposta' }], undefined, 'ollama'));
        return { r, saida, contagem, ms: Date.now() - t0 };
    } finally {
        global.fetch = original;
        if (flagAntes === undefined) delete process.env.CORTE_PELO_LIMITE_SEM_REPETIR; else process.env.CORTE_PELO_LIMITE_SEM_REPETIR = flagAntes;
    }
}

async function main(): Promise<void> {
    console.log('\n=== S452 — corte pelo limite de saída não é repetido (sombra por padrão) ===\n');

    console.log('Sombra (padrão): comportamento de antes, com o registro do que a regra nova pouparia');
    {
        const { r, saida, contagem } = await chamar(['corte'], false);
        assert(contagem.streaming === 2 && contagem.naoStreaming === 1, `repete e refaz como antes (streaming=${contagem.streaming}, sem streaming=${contagem.naoStreaming})`);
        assert(r?.status !== 'success', `termina sem resposta (status=${r?.status})`);
        assert(/\[CORTE-LIMITE-SOMBRA\] vazia: o limite de saída acabou no raciocínio/.test(saida), 'registra o corte na sombra');
        assert(/\[CORTE-LIMITE-SOMBRA\] nada deu resposta depois do corte — a regra nova pouparia \d+ ms/.test(saida), 'registra quanto a regra nova pouparia');
    }

    console.log('\nSombra: quando a repetição depois do corte rende, isso fica registrado');
    {
        const { r, saida, contagem } = await chamar(['corte', 'texto'], false);
        assert(r?.status === 'success' && contagem.streaming === 2, `a repetição deu resposta (status=${r?.status}, streaming=${contagem.streaming})`);
        assert(/\[CORTE-LIMITE-SOMBRA\] a repetição depois do corte DEU resposta/.test(saida), 'registra que a regra nova teria perdido esta');
    }

    console.log('\nRegra ligada (CORTE_PELO_LIMITE_SEM_REPETIR=1): nem repete, nem refaz sem streaming');
    {
        const { r, saida, contagem, ms } = await chamar(['corte'], true);
        assert(contagem.streaming === 1 && contagem.naoStreaming === 0, `uma tentativa só (streaming=${contagem.streaming}, sem streaming=${contagem.naoStreaming})`);
        assert(ms < 5000, `sem a espera da repetição (${ms} ms)`);
        assert(r?.status !== 'success', `termina sem resposta (status=${r?.status})`);
        assert(/\[CORTE-LIMITE\] sem refação sem streaming/.test(saida) && !/CORTE-LIMITE-SOMBRA/.test(saida), 'registra a decisão, sem sombra');
    }

    console.log('\nControle: vazia SEM corte (glitch do provedor) continua sendo repetida, mesmo com a regra ligada');
    {
        const { r, contagem, saida } = await chamar(['vazia', 'texto'], true);
        assert(contagem.streaming === 2 && r?.status === 'success', `repetiu e deu resposta (streaming=${contagem.streaming}, status=${r?.status})`);
        assert(!/CORTE-LIMITE/.test(saida), 'não é tratada como corte');
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S452 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}
main().catch((err) => { console.error('S452 erro inesperado:', err); process.exit(1); });
