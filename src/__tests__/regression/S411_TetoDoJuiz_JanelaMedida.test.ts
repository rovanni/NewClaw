/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S411
 * O teto do prompt de um juiz vem da janela REAL do modelo (medida no /api/tags do Ollama), não de um número fixo.
 *
 * ORIGEM (Windows, 15/10/2026): nos dois testes reais do dia (aula e calendário) o juiz de grounding ficou "não avaliável" várias
 * vezes — "prompt de 93–119 mil chars excede 60000" — e as respostas passaram sem conferência. O teto fixo de 60 mil vinha de supor
 * um modelo local de 32.768 tokens; o juiz era o glm-5.3-flash:cloud, janela de 1.048.576 tokens. Experimento (aprovado pela
 * usuária): com num_ctx=32768, glm-5.3-flash:cloud e glm-5.3:cloud processaram 108.294 tokens e acharam o código do início —
 * o Ollama Cloud ignora o num_ctx. O Ollama local corta nele.
 *
 * REGRESSÃO SE: o teto voltar a ser fixo para modelos de nuvem; o modelo local passar do num_ctx; ou, sem medição, o motor deixar de
 * usar o padrão conservador.
 *
 * Execução: npx ts-node src/__tests__/regression/S411_TetoDoJuiz_JanelaMedida.test.ts
 */
import * as http from 'http';
import { OllamaProvider } from '../../core/OllamaProvider';
import { caracteresQueCabem, DECISION_PROMPT_MAX_CHARS } from '../../core/providerTypes';
import { obterMotor } from '../../validation/motorPadrao';
import { vereditoRisco } from './_fixtures/veredito';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

/** Ollama falso: o /api/tags real informa remote_host e context_length (formato visto em 15/10/2026). */
function ollamaFalso(): Promise<{ url: string; fechar: () => void }> {
    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/api/tags') {
            return res.end(JSON.stringify({ models: [
                { name: 'glm-5.3-flash:cloud', remote_host: 'https://ollama.com', remote_model: 'glm-5.3-flash', details: { context_length: 1048576 } },
                { name: 'gemma4:e2b-it-q4_K_M', details: { context_length: 131072 } },
                { name: 'sem-janela:latest', details: {} },
            ] }));
        }
        res.statusCode = 404; res.end('{}');
    });
    return new Promise(r => server.listen(0, '127.0.0.1', () =>
        r({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, fechar: () => server.close() })));
}

async function main(): Promise<void> {
    const original = process.env.OLLAMA_NUM_CTX;
    process.env.OLLAMA_NUM_CTX = '32768';
    const ollama = await ollamaFalso();
    try {
        console.log('\n=== S411-1 — a janela efetiva é medida: nuvem = janela informada; local = menor entre janela e num_ctx ===');
        {
            const p = new OllamaProvider(ollama.url, 'glm-5.3-flash:cloud');
            const nuvem = await p.janelaEfetiva('glm-5.3-flash:cloud');
            assert(nuvem?.tokens === 1048576 && /nuvem/.test(nuvem.origem), 'modelo de nuvem (remote_host): 1.048.576 tokens — o num_ctx não limita', nuvem);
            const local = await p.janelaEfetiva('gemma4:e2b-it-q4_K_M');
            assert(local?.tokens === 32768 && /num_ctx/.test(local.origem), 'modelo local: o num_ctx enviado (32.768) é o limite real', local);
            assert(await p.janelaEfetiva('sem-janela') === undefined && await p.janelaEfetiva('nao-existe') === undefined, 'sem a informação: undefined (nada inventado)');
            assert(caracteresQueCabem(1048576) > 2_000_000 && caracteresQueCabem(32768) === 73728, 'conversão: 3 chars/token, 25% da janela para a resposta');
        }

        console.log('\n=== S411-2 — o motor usa o teto medido: o prompt de 93 mil chars do teste real agora é julgado ===');
        {
            const prompt93k = 'x'.repeat(93_000);
            const chamadas: number[] = [];
            const fabrica = (teto?: { chars: number; origem: string }) => ({
                chatWithFallback: async (msgs: Array<{ content: string }>) => { chamadas.push(msgs[0].content.length); return { status: 'success', content: vereditoRisco([]), attempts: [] }; },
                getBudgetAuxiliar: () => ({ timeoutMs: 1000, origem: 'padrao', latenciaTipicaMs: null }),
                ...(teto ? { tetoDeEntrada: async () => teto } : {}),
            }) as never;
            const medido = await obterMotor(fabrica({ chars: caracteresQueCabem(1048576), origem: 'janela do modelo de nuvem' }))
                .validar('risco_do_plano', { pedido: 'feriados do calendário', plano: prompt93k });
            assert(!medido.semVeredito && chamadas.length === 1 && chamadas[0] > 93_000, 'janela de nuvem medida: o juiz é chamado com o prompt inteiro', medido.veredito);
            chamadas.length = 0;
            const local = await obterMotor(fabrica({ chars: 73_728, origem: 'modelo local: num_ctx 32768' }))
                .validar('risco_do_plano', { pedido: 'feriados do calendário', plano: prompt93k });
            assert(local.semVeredito && chamadas.length === 0 && /73728 \(modelo local: num_ctx 32768\)/.test(local.veredito.naoAvaliavelPorque ?? ''), 'modelo local: não cabe → não avaliável, dizendo de onde veio o teto', local.veredito.naoAvaliavelPorque);
            const semMedida = await obterMotor(fabrica()).validar('risco_do_plano', { pedido: 'x', plano: 'y'.repeat(DECISION_PROMPT_MAX_CHARS) });
            assert(semMedida.semVeredito && new RegExp(`teto de ${DECISION_PROMPT_MAX_CHARS} \\(padrão\\)`).test(semMedida.veredito.naoAvaliavelPorque ?? ''), 'provedor que não mede: o padrão conservador de sempre, declarado', semMedida.veredito.naoAvaliavelPorque);
        }
    } finally {
        ollama.fechar();
        if (original === undefined) delete process.env.OLLAMA_NUM_CTX; else process.env.OLLAMA_NUM_CTX = original;
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S411 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}
main().catch(err => { console.error('S411 erro inesperado:', err); process.exit(1); });
