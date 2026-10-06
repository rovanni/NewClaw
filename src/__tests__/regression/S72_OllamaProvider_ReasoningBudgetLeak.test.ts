/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S72
 *
 * Investigação (08/07/2026, log real): usuário reportou receber no Telegram uma mensagem de
 * ~8000 caracteres, texto solto e incoerente ("Falha ao verificar status: variável de ambiente
 * X não definida", com X mudando de nome a cada repetição, incluindo um fragmento de caracteres
 * chineses corrompidos). A string não existe em NENHUM lugar do código-fonte, nem em
 * newclaw-audit.log, nem nos logs do PM2 (stdout/stderr) — descartando hipótese de template
 * fixo ou segunda instância (VPS) respondendo pelo mesmo bot.
 *
 * Rastreamento real via newclaw-audit.log (correlationId=2238ef36, 22:10:18–22:10:51):
 *   1. Usuário pediu áudio sobre cotação de criptomoedas. O agente buscou os preços reais
 *      (exec_command com sucesso, dados de bitcoin/ethereum/solana/zcash).
 *   2. No passo seguinte (síntese da resposta final), o modelo (glm-5.2:cloud) entrou em um
 *      "thinking" (chain-of-thought) que nunca terminou.
 *   3. Log: "[STREAM] THINKING BUDGET exceeded (8001 chars, 16423ms, reason=chars) — aborting"
 *      — o guard-rail MAX_THINKING_BUDGET_CHARS (existente, projetado exatamente pra isso) disparou.
 *   4. Log seguinte: "Stream ended WITHOUT explicit 'done' chunk" e depois "No content but 7997
 *      chars of thinking — using as content (model returned response in thinking field)".
 *   5. response_len=7997 no MessageBus bate exatamente com o "content=7997chars" do passo 4 —
 *      prova que o texto entregue ao usuário no Telegram era o CoT bruto e truncado do modelo,
 *      não uma resposta real.
 *
 * Causa raiz (OllamaProvider.ts): quando o thinking-budget dispara, o código chamava
 * `controller.abort()` e então fazia `break` manualmente nos dois loops — SEM lançar exceção.
 * `streamChat()` (async generator) terminava normalmente (sem `throw`, sem chunk 'done').
 * `_consumeStream()`'s `for await` sobre esse generator também terminava normalmente — então o
 * bloco `catch` que JÁ EXISTIA e JÁ TRATAVA corretamente esse caso (`if (this._reasoningBudgetAborted)
 * { descarta thinking, lança erro REASONING_BUDGET }`) nunca executava, porque catch só roda se o
 * generator lança. O fluxo caía no fallback seguinte (linha ~469, "No content but N chars of
 * thinking — using as content"), pensado para um caso LEGÍTIMO diferente (modelos como
 * deepseek-v4-flash:cloud que roteiam a resposta INTEIRA, já completa, pelo campo thinking) — e
 * promovia o CoT truncado/incompleto como resposta final.
 *
 * Comparação com os outros três timers do mesmo arquivo (ACTIVITY_TIMEOUT, CONNECTION_TIMEOUT,
 * MAX_TIMEOUT, linhas ~189-207): todos chamam `controller.abort()` e DEIXAM o próximo
 * `reader.read()` rejeitar naturalmente (sem break manual) — o reject vira uma exceção real,
 * pega pelo catch de streamChat, repropagada pro catch de _consumeStream. O thinking-budget era o
 * ÚNICO dos quatro timers que quebrava esse padrão fazendo break manual antes do reject natural.
 *
 * Fix: no ponto em que `thinkingBudgetAbort` é observado após os loops (antes do "flush do
 * buffer restante"), lança uma exceção em vez de só `break`. Isso reusa o catch já existente e
 * corretamente testado — sem duplicar lógica, sem criar um novo caminho especial.
 *
 * Escopo tocado: core/OllamaProvider.ts (streamChat, ~15 linhas).
 *
 * Execução: npx ts-node src/__tests__/regression/S72_OllamaProvider_ReasoningBudgetLeak.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { OllamaProvider } from '../../core/OllamaProvider';
import { LLMMessage } from '../../core/providerTypes';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`); failed++; }
}

function readSrc(relPath: string): string {
    return fs.readFileSync(path.join(process.cwd(), 'src', relPath), 'utf-8');
}

/** NDJSON encoder for one Ollama-style streaming chunk (native /api/chat format). */
function ndjson(obj: Record<string, unknown>): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(obj) + '\n');
}

/**
 * Builds a fake fetch() that returns an infinite "thinking" stream (never yields content,
 * never yields a 'done' chunk) — reproduces the real model behaviour observed in the incident
 * (glm-5.2:cloud stuck reasoning about a tool result, never converging to a final answer).
 */
function makeInfiniteThinkingFetch(): typeof fetch {
    return (async () => {
        const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
                try {
                    // 20 chunks x 500 chars = 10_000 chars > MAX_THINKING_BUDGET_CHARS (8_000).
                    for (let i = 0; i < 20; i++) {
                        controller.enqueue(ndjson({ message: { thinking: 'x'.repeat(500) } }));
                        await new Promise(r => setTimeout(r, 1));
                    }
                    // Real incident stream never reaches a 'done' chunk before the abort fires;
                    // simulate that by holding the stream open a bit longer than the budget check.
                    await new Promise(r => setTimeout(r, 500));
                    controller.close();
                } catch {
                    // AbortController.abort() on the request signal does not automatically stop
                    // this producer; in the real fetch/undici implementation it does. For this
                    // fixture, closing on error is enough — the consumer side is what's under test.
                    controller.close();
                }
            }
        });
        return {
            ok: true,
            status: 200,
            body: stream,
        } as unknown as Response;
    }) as unknown as typeof fetch;
}

async function main(): Promise<void> {

// Issue 064 (06/10/2026): o orçamento de raciocínio por caracteres saiu (em produção, abortava modelos que não estavam
// travados e a chamada era refeita sem limite). A garantia deste teste continua — o CoT truncado do incidente nunca
// vira resposta —, agora sustentada pela ESTRUTURA do stream: raciocínio só é promovido a conteúdo quando a geração
// terminou normalmente (chunk 'done', sem corte por limite).
console.log('\n=== S72-1 [estrutural] — raciocínio só vira conteúdo quando a geração terminou normalmente ===');
{
    const src = readSrc('core/OllamaProvider.ts');
    assert(src.includes("const interrupted = streamFailed || !sawDone || doneReason === 'length';"), 'o fato "geração interrompida" é calculado num ponto só');
    assert(
        /if \(!content && thinking && toolCalls\.length === 0 && interrupted\) \{[\s\S]{0,400}thinking = '';/.test(src),
        'geração interrompida com só raciocínio: o raciocínio é descartado (não promovido)',
    );
    assert(!/recovering thinking as content/.test(src), 'o caminho de erro não promove mais raciocínio a conteúdo (vazamento da issue 042 fechado)');
}

console.log('\n=== S72-2 [runtime] — stream só de thinking que termina sem "done" REJEITA a Promise (não resolve com o CoT como conteúdo) ===');
{
    const provider = new OllamaProvider('http://fake-ollama.invalid', 'glm-5.2:cloud', '');
    const originalFetch = global.fetch;
    global.fetch = makeInfiniteThinkingFetch();

    const messages: LLMMessage[] = [
        { role: 'system', content: 'você é um assistente' },
        { role: 'user', content: 'poderia enviar um áudio sobre o mercado de criptomoedas hoje?' },
    ];

    let threw = false;
    let leakedContent: string | undefined;
    try {
        const result = await provider.chat(messages);
        // Se chegou aqui, o bug está de volta: o CoT truncado virou "resposta" normal.
        leakedContent = result.content;
    } catch {
        threw = true;
    } finally {
        global.fetch = originalFetch;
    }

    assert(threw, `chat() deve REJEITAR quando a geração termina sem "done" e sem content (incidente: resolvia com content="${(leakedContent || '').slice(0, 40)}..." de ${leakedContent?.length ?? 0} chars)`);
}

console.log('\n=== S72-3 [runtime] — modelo que entrega a resposta INTEIRA no campo thinking (geração completa) continua funcionando ===');
{
    // Caso legítimo que o fallback "thinking como conteúdo" existe para atender (ex.: deepseek-v4-flash:cloud).
    const provider = new OllamaProvider('http://fake-ollama.invalid', 'deepseek-v4-flash:cloud', '');
    const originalFetch = global.fetch;
    global.fetch = (async () => ({
        ok: true, status: 200,
        body: new ReadableStream<Uint8Array>({
            start(c) {
                c.enqueue(ndjson({ message: { thinking: 'Bitcoin está em US$ 61.200 hoje.' } }));
                c.enqueue(ndjson({ done: true, done_reason: 'stop', prompt_eval_count: 5, eval_count: 9 }));
                c.close();
            },
        }),
    })) as unknown as typeof fetch;
    let content = '';
    try { content = (await provider.chat([{ role: 'user', content: 'cotação do bitcoin?' }])).content; } catch { /* falha registrada abaixo */ }
    finally { global.fetch = originalFetch; }
    assert(content === 'Bitcoin está em US$ 61.200 hoje.', `resposta completa no campo thinking é entregue — obtido "${content}"`);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S72 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S72 erro inesperado:', err);
    process.exitCode = 1;
});
