/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S290 (issue 044, campanha "sistema não utilizável", 23/09/2026)
 *
 * Achado ao vivo, testando o dashboard real logo após o deploy da issue 043: pedido simples de
 * previsão do tempo. A tool `weather` executou com sucesso (dado real, correto). O juiz de
 * grounding (`ObserverValidator`) abortou aos EXATOS 30000ms com 8119 chars de thinking
 * acumulado — bem abaixo do teto suave de 32000 chars que a issue 038 já havia estabelecido para
 * `reasoningIntensive=true`. Resultado: "Não consegui confirmar se a resposta é sustentada pelos
 * dados obtidos" — resposta correta bloqueada de novo, mesmo defeito da issue 038, taxa de
 * recorrência real confirmada em produção no mesmo dia.
 *
 * Causa raiz: `OllamaProvider.streamChat()` tem DOIS tetos independentes — `MAX_TIMEOUT` (duro,
 * aborta a chamada inteira) e `MAX_THINKING_DURATION_MS` (suave, só mede tempo em "thinking").
 * A issue 038 elevou o teto SUAVE 4× quando `reasoningIntensive=true` (60s→240s), mas nunca tocou
 * o teto DURO — que continuava sendo só `customTimeoutMs || 300_000`. `ObserverValidator` passa
 * `getBudgetAuxiliar('validacao').timeoutMs` como `customTimeoutMs`, e esse orçamento, por um
 * problema já documentado em `shared/auxTimeout.ts` (média de latência por provedor contaminada
 * por chamadas rápidas), fica preso no piso de 30_000ms na prática. Resultado: o teto DURO
 * (30s) sempre disparava antes do teto SUAVE elevado (240s) ter qualquer chance de agir — a
 * correção da issue 038 nunca tinha efeito real no call site que mais precisava dela.
 *
 * Fix: `MAX_TIMEOUT` passa a ser `Math.max(customTimeoutMs || 300_000, MAX_THINKING_DURATION_MS)`
 * — MAS só quando `reasoningIntensive=true`. Sem o opt-in, `MAX_TIMEOUT` continua sendo
 * exatamente `customTimeoutMs || 300_000`, sem alteração nenhuma — protege chamadas rápidas
 * (`GoalExtractor`, `UnifiedIntentRouter`) que passam `customTimeoutMs` propositalmente curto
 * (6s, perfil `classificacao`) para desistir cedo e cair em heurística de fallback.
 *
 * S290.1 — CASO POSITIVO: `reasoningIntensive=true` com `customTimeoutMs` pequeno (bem menor que
 *   `MAX_THINKING_DURATION_MS`, reproduzindo o piso de 30s do orçamento real) NÃO aborta antes de
 *   um conteúdo real chegar depois desse `customTimeoutMs` — o teto duro foi elevado.
 * S290.2 — CONTROLE NEGATIVO: sem `reasoningIntensive`, o mesmo `customTimeoutMs` pequeno
 *   continua abortando no prazo original — comportamento de chamada rápida (classificação)
 *   preservado, não pode esperar o teto de 60s/240s por engano.
 * S290.3 — auditoria de código: a elevação do teto duro só existe dentro do ramo
 *   `reasoningIntensive ? ... : ...` — não pode vazar para o caso base.
 *
 * Execução: npx ts-node src/__tests__/regression/S290_ReasoningIntensive_HardTimeoutRespectsThinkingBudget.test.ts
 */

import { OllamaProvider } from '../../core/OllamaProvider';
import { LLMMessage } from '../../core/providerTypes';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

function ndjson(obj: Record<string, unknown>): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(obj) + '\n');
}

/** Emite thinking imediatamente, depois conteúdo real + done após `contentDelayMs` — simula o
 *  juiz de grounding que precisa de mais tempo do que um `customTimeoutMs` apertado antes de
 *  produzir a resposta. Se o teto duro disparar antes de `contentDelayMs`, o fetch é abortado
 *  (init.signal) e o conteúdo real nunca é emitido — é exatamente o que queremos detectar. */
function makeDelayedContentFetch(contentDelayMs: number): typeof fetch {
    return (async (_url: string, init?: RequestInit) => {
        const signal = init?.signal as AbortSignal | undefined;
        let aborted = false;
        signal?.addEventListener('abort', () => { aborted = true; });
        const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
                controller.enqueue(ndjson({ message: { thinking: 'raciocinando sobre os dados obtidos...' } }));
                await new Promise<void>((resolve) => setTimeout(resolve, contentDelayMs));
                if (aborted || signal?.aborted) {
                    try { controller.error(new Error('The operation was aborted')); } catch { /* já finalizado */ }
                    return;
                }
                controller.enqueue(ndjson({ message: { content: 'resposta real com os dados confirmados' } }));
                controller.enqueue(ndjson({ done: true, done_reason: 'stop', prompt_eval_count: 50, eval_count: 12 }));
                controller.close();
            }
        });
        return { ok: true, status: 200, body: stream } as unknown as Response;
    }) as unknown as typeof fetch;
}

async function collectChunks(gen: AsyncGenerator<{ type: string; value: unknown }>, timeoutMs: number): Promise<{ chunks: Array<{ type: string; value: unknown }>; threw: boolean }> {
    const chunks: Array<{ type: string; value: unknown }> = [];
    let threw = false;
    const consume = (async () => {
        try {
            for await (const chunk of gen) chunks.push(chunk);
        } catch {
            threw = true;
        }
    })();
    await Promise.race([consume, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
    return { chunks, threw };
}

async function main(): Promise<void> {

const originalFetch = global.fetch;

console.log('\n=== S290.1 — CASO POSITIVO: reasoningIntensive=true não aborta antes do teto suave elevado ===');
{
    // customTimeoutMs=300ms (proporcionalmente pequeno, reproduz o piso de 30s do orçamento real
    // sendo bem menor que o teto suave de 240s) — conteúdo chega em 600ms, depois do
    // customTimeoutMs original mas MUITO antes do teto suave (60s base, 240s com o multiplicador).
    global.fetch = makeDelayedContentFetch(600);
    const provider = new OllamaProvider('http://fake-ollama.invalid', 'glm-5.3-flash:cloud', '');
    const messages: LLMMessage[] = [{ role: 'user', content: 'a resposta é sustentada pelos dados?' }];

    const { chunks, threw } = await collectChunks(
        provider.streamChat(messages, undefined, 300, undefined, true),
        3000,
    );

    assert(!threw, 'não lançou exceção — o teto duro não abortou antes do conteúdo real chegar', { threw, chunks });
    const content = chunks.find(c => c.type === 'content');
    assert(!!content, `conteúdo real foi entregue mesmo chegando depois do customTimeoutMs original (300ms) — chunks: ${JSON.stringify(chunks)}`, chunks);
    const done = chunks.find(c => c.type === 'done');
    assert(!!done, 'stream completou normalmente (chunk "done" recebido)', chunks);
}

console.log('\n=== S290.2 — CONTROLE NEGATIVO: sem reasoningIntensive, customTimeoutMs curto continua abortando no prazo original ===');
{
    // Mesmo cenário, MAS sem reasoningIntensive — reproduz uma chamada rápida de classificação
    // (GoalExtractor/UnifiedIntentRouter) que passa customTimeoutMs propositalmente curto para
    // desistir cedo. O conteúdo NUNCA deve chegar (aborta antes dos 600ms).
    global.fetch = makeDelayedContentFetch(600);
    const provider = new OllamaProvider('http://fake-ollama.invalid', 'glm-5.3-flash:cloud', '');
    const messages: LLMMessage[] = [{ role: 'user', content: 'classifique esta mensagem' }];

    const { chunks } = await collectChunks(
        provider.streamChat(messages, undefined, 300, undefined, false),
        3000,
    );

    const content = chunks.find(c => c.type === 'content');
    assert(!content, `SEM reasoningIntensive, customTimeoutMs=300ms continua sendo o teto real — conteúdo (chegaria só aos 600ms) NÃO foi entregue — chunks: ${JSON.stringify(chunks)}`, chunks);
}

console.log('\n=== S290.3 — auditoria de código: elevação do teto duro só dentro do ramo reasoningIntensive ===');
{
    const src = require('fs').readFileSync(require('path').join(process.cwd(), 'src', 'core', 'OllamaProvider.ts'), 'utf-8') as string;
    const trecho = src.slice(src.indexOf('const MAX_TIMEOUT = reasoningIntensive'), src.indexOf('const ACTIVITY_TIMEOUT'));
    assert(
        /reasoningIntensive\s*\n?\s*\?\s*Math\.max\(customTimeoutMs \|\| 300_000, MAX_THINKING_DURATION_MS\)\s*\n?\s*:\s*\(customTimeoutMs \|\| 300_000\)/.test(trecho),
        'MAX_TIMEOUT só eleva o teto quando reasoningIntensive é true; caso contrário é customTimeoutMs || 300_000, sem alteração',
        trecho,
    );
}

global.fetch = originalFetch;

console.log(`\n${'─'.repeat(60)}`);
console.log(`S290 RESULTADO: ${passed} passou | ${failed} falhou`);
process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
