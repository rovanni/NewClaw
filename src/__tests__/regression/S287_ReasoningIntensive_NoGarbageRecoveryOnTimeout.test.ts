/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S287 (issue 042, campanha "sistema não utilizável", 22/09/2026)
 *
 * Achado reproduzindo ao vivo o RETESTE da issue 038 (mesma sessão): com `reasoningIntensive`
 * já corrigindo o teto de CHARS, o teto de TEMPO da chamada (30s, `getBudgetAuxiliar('validacao')`
 * no piso) estourou primeiro — o modelo tinha só 11.805 chars de "thinking" (bem abaixo do novo
 * teto de 32.000). O mecanismo de recovery existente (`OllamaProvider.ts`, "models like
 * deepseek-v4-flash:cloud route their entire response through the thinking field") promoveu esse
 * CoT bruto e incompleto a `content`. O `ObserverValidator` tentou parsear como JSON estruturado
 * (veredito de grounding) e falhou: "saída do juiz sem estrutura válida — UNVALIDATED".
 *
 * O recovery É legítimo para um turno conversacional (prosa livre — um CoT incompleto ainda pode
 * ser uma resposta aproveitável). NUNCA é legítimo para um chamador que pediu
 * `reasoningIntensive` — os 4 call sites reais (grounding ×2, planejamento, validação de goal)
 * esperam JSON estruturado, e um CoT truncado nunca vira JSON válido por acidente. Fix: o mesmo
 * sinal (`reasoningIntensive`) desliga esse recovery — timeout vira erro limpo (propagado pro
 * ProviderFactory tratar via fallback/retry normal), não um "sucesso" com conteúdo inútil.
 *
 * S287.1 — CONTROLE NEGATIVO: sem reasoningIntensive, o recovery de thinking-como-content
 *   continua funcionando exatamente como antes (turno conversacional não perde a proteção).
 * S287.2 — CASO POSITIVO: com reasoningIntensive=true, o mesmo cenário (abort com thinking, sem
 *   content, sem tool_calls) propaga o erro original em vez de "recuperar" o CoT como resposta.
 * S287.3 — com reasoningIntensive=true E tool_calls presentes, comportamento inalterado (thinking
 *   nunca era promovido nesse caso, com ou sem a flag — controle de não-regressão).
 *
 * Execução: npx ts-node src/__tests__/regression/S287_ReasoningIntensive_NoGarbageRecoveryOnTimeout.test.ts
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

/** Simula o cenário real: emite thinking, nunca chega a 'done', o fetch nunca fecha por conta
 *  própria — o abort precisa vir de fora. `chat()` público tem um piso de 30s pro timeout
 *  interno (`Math.max(30_000, ...)`), impraticável num teste — por isso o abort aqui vem de um
 *  `externalSignal` (AbortController do próprio teste), disparado logo após o 1º chunk, mesmo
 *  mecanismo que uma requisição HTTP cancelada/timeout do chamador real usaria. Sem tool_calls. */
function makeTimeoutBeforeContentFetch(thinkingChars: number): typeof fetch {
    return (async (_url: string, init?: RequestInit) => {
        const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
                controller.enqueue(ndjson({ message: { thinking: 'x'.repeat(thinkingChars) } }));
                const signal = init?.signal as AbortSignal | undefined;
                // Um abort real (fetch/undici) faz reader.read() REJEITAR, não terminar limpo —
                // controller.error() (não .close()) é o que reproduz isso de verdade; um
                // .close() aqui simularia fim normal de stream, mascarando o ramo de catch que
                // este teste precisa exercitar.
                await new Promise<void>((resolve) => {
                    if (signal?.aborted) return resolve();
                    signal?.addEventListener('abort', () => resolve());
                    setTimeout(resolve, 4000); // salvaguarda do próprio teste, nunca deveria disparar
                });
                try { controller.error(new Error('The operation was aborted')); } catch { /* já finalizado */ }
            }
        });
        return { ok: true, status: 200, body: stream } as unknown as Response;
    }) as unknown as typeof fetch;
}

async function main(): Promise<void> {

console.log('\n=== S287.1 — CONTROLE NEGATIVO: sem reasoningIntensive, recovery de thinking-como-content continua funcionando ===');
{
    const provider = new OllamaProvider('http://fake-ollama.invalid', 'glm-5.2:cloud', '');
    const originalFetch = global.fetch;
    global.fetch = makeTimeoutBeforeContentFetch(500);
    const messages: LLMMessage[] = [{ role: 'user', content: 'oi, como você está?' }];
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 30);
    let content = '';
    let threw = false;
    try {
        const result = await provider.chat(messages, undefined, { signal: abort.signal });
        content = result.content;
    } catch {
        threw = true;
    } finally {
        global.fetch = originalFetch;
    }
    assert(!threw, 'sem reasoningIntensive, o timeout com thinking acumulado NÃO lança — recupera como content (comportamento pré-existente preservado)', { threw, content });
    assert(content.length > 0, `content recuperado do thinking (turno conversacional aceita prosa aproximada) — obtido ${content.length} chars`, content.length);
}

console.log('\n=== S287.2 — CASO POSITIVO: com reasoningIntensive=true, o mesmo timeout propaga erro em vez de "recuperar" CoT como resposta ===');
{
    const provider = new OllamaProvider('http://fake-ollama.invalid', 'glm-5.2:cloud', '');
    const originalFetch = global.fetch;
    global.fetch = makeTimeoutBeforeContentFetch(500);
    const messages: LLMMessage[] = [{ role: 'user', content: 'julgue esta afirmação' }];
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 30);
    let threw = false;
    let leakedContent: string | undefined;
    try {
        const result = await provider.chat(messages, undefined, { signal: abort.signal, reasoningIntensive: true });
        leakedContent = result.content;
    } catch {
        threw = true;
    } finally {
        global.fetch = originalFetch;
    }
    assert(
        threw,
        `com reasoningIntensive=true, o timeout propaga como erro real (ANTES do fix: "sucesso" com content="${(leakedContent || '').slice(0, 30)}..." que o chamador tentaria parsear como JSON e falharia com "saída sem estrutura válida")`,
        leakedContent
    );
}

console.log('\n=== S287.3 — controle de não-regressão: thinking + tool_calls nunca é promovido, com ou sem reasoningIntensive ===');
{
    // Cenário: thinking presente, MAS também há tool_calls — o código já não promovia isso a
    // content antes desta issue (linha "else if (!content && thinking && toolCalls.length > 0)").
    // Confirma que o fix não alterou esse ramo independente.
    const src = require('fs').readFileSync(require('path').join(process.cwd(), 'src', 'core', 'OllamaProvider.ts'), 'utf-8') as string;
    assert(
        src.includes('} else if (!content && thinking && toolCalls.length > 0) {'),
        'ramo de thinking+tool_calls (nunca promovido) continua intacto, independente da flag nova',
    );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S287 RESULTADO: ${passed} passou | ${failed} falhou`);
process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
