/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S286 (issue 038, campanha "sistema não utilizável", 22/09/2026)
 *
 * Reproduzido AO VIVO duas vezes na mesma investigação: (1) gerando um PPTX real via goal —
 * `GoalPlanner` abortou repetidamente com "THINKING BUDGET exceeded (8003 chars)" antes de emitir
 * o plano; (2) pedindo a previsão do tempo no navegador REAL do usuário — a ferramenta trouxe
 * dados corretos, mas o juiz de grounding (`ObserverValidator`) abortou pelo mesmo motivo,
 * cascateou pro fallback `llamafile` morto (4 tentativas, ~85s) e a resposta CORRETA foi
 * bloqueada como "não consegui confirmar".
 *
 * Causa raiz: `MAX_THINKING_BUDGET_CHARS=8_000`/`MAX_THINKING_DURATION_MS=60_000`
 * (`OllamaProvider.ts`, nascido do S72 — modelo genuinamente travado numa resposta
 * CONVERSACIONAL) é um teto único aplicado também a chamadas de raciocínio pesado
 * (planejamento, julgamento de grounding/conclusão de goal) que legitimamente precisam de mais
 * espaço antes da primeira linha de conteúdo — descartando raciocínio real, não travado.
 *
 * Fix: `ChatFallbackOptions.reasoningIntensive` (opt-in explícito, mesmo padrão de
 * `anunciarSubstituicao`) — quando true, multiplica os dois tetos por 4× (mesmo fator já
 * calibrado com evidência real para chamadas de validação em `shared/auxTimeout.ts`,
 * `PERFIS.validacao.fator` — não um número novo inventado). Sem o opt-in, nada muda — protege o
 * caso original do S72 (chat conversacional).
 *
 * S286.1 — CONTROLE NEGATIVO: sem reasoningIntensive, o cenário exato do S72 continua abortando
 *   (o fix não afeta nenhuma chamada existente que não opte por ele).
 * S286.2 — CASO POSITIVO: com reasoningIntensive=true, um raciocínio de 20.000 chars (> teto
 *   antigo de 8.000, < novo teto de 32.000) NÃO aborta — o modelo termina de pensar e entrega
 *   conteúdo real normalmente.
 * S286.3 — o novo teto (32.000/240s) ainda existe: um modelo genuinamente travado além dele
 *   continua sendo abortado — reasoningIntensive amplia a rede de segurança, não a remove.
 * S286.4 — AUDITORIA DE CÓDIGO: os 4 call sites reais que motivaram este fix (ObserverValidator
 *   ×2, GoalPlanner, GoalExecutionLoop.validateGoalCompletion) passam reasoningIntensive=true;
 *   o turno conversacional do AgentLoop (onde o incidente do S72 aconteceu) continua SEM o
 *   opt-in — nunca deve herdá-lo por acidente numa edição futura.
 *
 * Execução: npx ts-node src/__tests__/regression/S286_ReasoningIntensive_ThinkingBudgetScaling.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { OllamaProvider, AbortReason } from '../../core/OllamaProvider';
import { LLMMessage } from '../../core/providerTypes';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

function readSrc(relPath: string): string {
    return fs.readFileSync(path.join(process.cwd(), 'src', relPath), 'utf-8');
}

function ndjson(obj: Record<string, unknown>): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(obj) + '\n');
}

/** Mesmo fixture do S72 — nunca converge, sempre estoura qualquer teto de chars. */
function makeInfiniteThinkingFetch(totalChunks: number, chunkChars: number): typeof fetch {
    return (async () => {
        const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
                try {
                    for (let i = 0; i < totalChunks; i++) {
                        controller.enqueue(ndjson({ message: { thinking: 'x'.repeat(chunkChars) } }));
                        await new Promise(r => setTimeout(r, 1));
                    }
                    await new Promise(r => setTimeout(r, 200));
                    controller.close();
                } catch { controller.close(); }
            }
        });
        return { ok: true, status: 200, body: stream } as unknown as Response;
    }) as unknown as typeof fetch;
}

/** Pensa bastante (thinkingChars no total), depois CONVERGE para conteúdo real + done. */
function makeConvergingThinkingFetch(thinkingChunks: number, chunkChars: number, finalContent: string): typeof fetch {
    return (async () => {
        const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
                for (let i = 0; i < thinkingChunks; i++) {
                    controller.enqueue(ndjson({ message: { thinking: 'x'.repeat(chunkChars) } }));
                    await new Promise(r => setTimeout(r, 1));
                }
                controller.enqueue(ndjson({ message: { content: finalContent } }));
                controller.enqueue(ndjson({ done: true, prompt_eval_count: 10, eval_count: 5 }));
                controller.close();
            }
        });
        return { ok: true, status: 200, body: stream } as unknown as Response;
    }) as unknown as typeof fetch;
}

async function main(): Promise<void> {

console.log('\n=== S286.1 — CONTROLE NEGATIVO: sem reasoningIntensive, cenário do S72 (10.000 chars) continua abortando ===');
{
    const provider = new OllamaProvider('http://fake-ollama.invalid', 'glm-5.2:cloud', '');
    const originalFetch = global.fetch;
    global.fetch = makeInfiniteThinkingFetch(20, 500); // 10_000 chars total
    const messages: LLMMessage[] = [{ role: 'user', content: 'oi' }];
    let threw = false;
    let abortReason: string | undefined;
    try {
        // abortReason só é marcado em _consumeStream (chat()), não em streamChat() isolado —
        // mesma camada que o S72 original testa.
        await provider.chat(messages);
    } catch (err) {
        threw = true;
        abortReason = (err as Error & { abortReason?: string }).abortReason;
    } finally {
        global.fetch = originalFetch;
    }
    assert(threw, 'sem reasoningIntensive, o stream de 10.000 chars ainda lança exceção (comportamento do S72 preservado)');
    assert(abortReason === AbortReason.REASONING_BUDGET, `abortReason continua REASONING_BUDGET — obtido: ${abortReason}`, abortReason);
}

console.log('\n=== S286.2 — CASO POSITIVO: com reasoningIntensive=true, 20.000 chars de raciocínio NÃO aborta — converge pra conteúdo real ===');
{
    const provider = new OllamaProvider('http://fake-ollama.invalid', 'glm-5.2:cloud', '');
    const originalFetch = global.fetch;
    // 20.000 chars > teto antigo (8.000), < novo teto com reasoningIntensive (8.000*4=32.000).
    global.fetch = makeConvergingThinkingFetch(20, 1000, 'O plano tem 3 steps: write, exec_command, send_document.');
    const messages: LLMMessage[] = [{ role: 'user', content: 'gere um plano complexo' }];
    let content = '';
    let threw = false;
    try {
        for await (const chunk of provider.streamChat(messages, undefined, undefined, undefined, true)) {
            if (chunk.type === 'content') content += chunk.value;
        }
    } catch (err) {
        threw = true;
        console.error('  (erro inesperado)', err);
    } finally {
        global.fetch = originalFetch;
    }
    assert(!threw, 'com reasoningIntensive=true, 20.000 chars de thinking NÃO lança exceção (ANTES do fix: abortava aos 8.000)');
    assert(content === 'O plano tem 3 steps: write, exec_command, send_document.', `o conteúdo real (pós-raciocínio) é entregue — obtido: "${content}"`, content);
}

console.log('\n=== S286.3 — o novo teto ainda existe: raciocínio genuinamente travado além de 32.000 chars continua abortando mesmo com reasoningIntensive ===');
{
    const provider = new OllamaProvider('http://fake-ollama.invalid', 'glm-5.2:cloud', '');
    const originalFetch = global.fetch;
    // 40 chunks x 1000 chars = 40_000 chars > 32_000 (novo teto com reasoningIntensive).
    global.fetch = makeInfiniteThinkingFetch(40, 1000);
    const messages: LLMMessage[] = [{ role: 'user', content: 'nunca converge' }];
    let threw = false;
    let abortReason: string | undefined;
    try {
        await provider.chat(messages, undefined, { reasoningIntensive: true });
    } catch (err) {
        threw = true;
        abortReason = (err as Error & { abortReason?: string }).abortReason;
    } finally {
        global.fetch = originalFetch;
    }
    assert(threw, 'mesmo com reasoningIntensive=true, um raciocínio que nunca converge além do novo teto (32.000) ainda aborta — rede de segurança do S72 não foi removida, só ampliada');
    assert(abortReason === AbortReason.REASONING_BUDGET, `abortReason continua REASONING_BUDGET — obtido: ${abortReason}`, abortReason);
}

console.log('\n=== S286.4 — AUDITORIA DE CÓDIGO: só os call sites com evidência real de bug recebem reasoningIntensive; o turno conversacional (origem do S72) não recebe ===');
{
    const observerSrc = readSrc('loop/ObserverValidator.ts');
    const plannerSrc = readSrc('loop/GoalPlanner.ts');
    const goalExecSrc = readSrc('loop/GoalExecutionLoop.ts');
    const agentLoopSrc = readSrc('loop/AgentLoop.ts');

    const observerOccurrences = (observerSrc.match(/reasoningIntensive:\s*true/g) || []).length;
    assert(observerOccurrences === 2, `ObserverValidator.ts tem exatamente 2 call sites com reasoningIntensive=true (os dois juízes de grounding) — obtido: ${observerOccurrences}`, observerOccurrences);

    assert(/callPlannerLLM[\s\S]{0,2000}reasoningIntensive:\s*true/.test(plannerSrc), 'GoalPlanner.callPlannerLLM() passa reasoningIntensive=true dentro de uma janela razoável de código', plannerSrc.length);

    // Janela ampla (a função é longa — monta um prompt grande antes da chamada real) — o que
    // importa é que a ocorrência fique DEPOIS da declaração do método, não antes.
    const methodIdx = goalExecSrc.indexOf('private async validateGoalCompletion(');
    const reasoningIdx = goalExecSrc.indexOf('reasoningIntensive: true', methodIdx);
    assert(methodIdx !== -1, 'validateGoalCompletion() encontrado em GoalExecutionLoop.ts', methodIdx);
    assert(
        methodIdx !== -1 && reasoningIdx !== -1 && reasoningIdx - methodIdx < 20000,
        `GoalExecutionLoop.validateGoalCompletion() passa reasoningIntensive=true a ${reasoningIdx - methodIdx} chars da declaração`,
        { methodIdx, reasoningIdx }
    );

    assert(
        !agentLoopSrc.includes('reasoningIntensive: true'),
        'AgentLoop.ts (turno conversacional, origem real do incidente S72) NÃO usa reasoningIntensive — nunca deve herdar o teto ampliado por acidente',
        agentLoopSrc.includes('reasoningIntensive')
    );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S286 RESULTADO: ${passed} passou | ${failed} falhou`);
process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
