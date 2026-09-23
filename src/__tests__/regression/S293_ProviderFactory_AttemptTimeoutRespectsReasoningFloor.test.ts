/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S293 (issue 047, campanha "sistema não utilizável", 23/09/2026)
 *
 * Achado ao vivo, mesmo dia da issue 044, testando um cenário real (conversão de investimento em
 * RIVER para reais): o log mostrou `[STREAM] START ... maxTimeout=240000ms` (teto interno do
 * provider, corretamente elevado por `reasoningIntensive` desde a issue 044) seguido, ~65s
 * depois, de `[STREAM] ABORTED ... duration=65619ms` — a chamada foi abortada por FORA do
 * provider, num timer que a issue 044 nunca tocou.
 *
 * Causa raiz: `ProviderFactory.chatWithFallback()` tem sua PRÓPRIA camada de timeout —
 * `attemptTimeout` (`setTimeout(() => currentAbort.abort(), timeoutMs)`) e `safetyTimeoutMs`
 * (`timeoutMs + 15000`, usado num `Promise.race`) — inteiramente independente do teto interno de
 * `OllamaProvider.streamChat()`. A issue 044 elevou só o teto INTERNO; este daqui, por fora,
 * continuava usando o `timeoutMs` original (frequentemente ~30-60s, vindo de
 * `getBudgetAuxiliar('validacao')`), abortando a chamada antes do teto interno elevado (240s) ter
 * qualquer chance de agir. O mesmo padrão se repete em `fallbackNonStreaming()` (chamado quando
 * todas as tentativas de streaming falham).
 *
 * Fix: `REASONING_INTENSIVE_TIMEOUT_FLOOR_MS` (novo, `providerTypes.ts` — valor único,
 * importado nos dois lados, para não divergir de novo como já aconteceu aqui) e
 * `effectiveTimeoutMs = (opts?.reasoningIntensive && timeoutMs) ? Math.max(timeoutMs,
 * REASONING_INTENSIVE_TIMEOUT_FLOOR_MS) : timeoutMs` — usado no lugar do `timeoutMs` bruto nos
 * dois timers de `chatWithFallback` e na chamada a `fallbackNonStreaming`.
 *
 * S293.1 — a fórmula (replicada aqui, mesma expressão do código real) eleva corretamente um
 *   timeoutMs pequeno quando reasoningIntensive=true, preserva um timeoutMs já maior que o piso,
 *   e não inventa um timeout quando o chamador não passou nenhum (undefined).
 * S293.2 — CONTROLE NEGATIVO: sem reasoningIntensive, a fórmula NUNCA eleva — timeoutMs original
 *   preservado sempre, protegendo chamadas rápidas (classificação) que dependem de abortar cedo.
 * S293.3 — auditoria estrutural: o código real usa `effectiveTimeoutMs`/
 *   `effectiveNonStreamingTimeoutMs` (não o `timeoutMs` bruto) nos 3 pontos que antes usavam o
 *   valor sem escala: `attemptTimeout`, `safetyTimeoutMs`, e a chamada a `fallbackNonStreaming`.
 * S293.4 — a constante é importada de `providerTypes.ts` em vez de duplicar o número "240_000"
 *   localmente — a mesma fonte que `OllamaProvider.ts` usaria se precisasse do mesmo piso.
 *
 * Execução: npx ts-node src/__tests__/regression/S293_ProviderFactory_AttemptTimeoutRespectsReasoningFloor.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { REASONING_INTENSIVE_TIMEOUT_FLOOR_MS } from '../../core/providerTypes';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  OK ${msg}`); passed++; }
    else { console.error(`  FALHOU: ${msg}`, detail ?? ''); failed++; }
}

/** Reproduz EXATAMENTE a expressão usada em ProviderFactory.ts (attemptTimeout/safetyTimeoutMs e
 *  a chamada a fallbackNonStreaming) — mesma fórmula, para verificar seu comportamento contra
 *  vários valores de entrada sem precisar esperar timers reais de minutos. */
function effectiveTimeoutMs(timeoutMs: number | undefined, reasoningIntensive: boolean | undefined): number | undefined {
    return (reasoningIntensive && timeoutMs)
        ? Math.max(timeoutMs, REASONING_INTENSIVE_TIMEOUT_FLOOR_MS)
        : timeoutMs;
}

async function main(): Promise<void> {

console.log('\n=== S293.1 — CASO POSITIVO: com reasoningIntensive, timeoutMs pequeno é elevado ao piso ===');
{
    assert(effectiveTimeoutMs(30000, true) === REASONING_INTENSIVE_TIMEOUT_FLOOR_MS, `30000ms (piso real de getBudgetAuxiliar) vira ${REASONING_INTENSIVE_TIMEOUT_FLOOR_MS}ms com reasoningIntensive — obtido ${effectiveTimeoutMs(30000, true)}`);
    assert(effectiveTimeoutMs(65612, true) === REASONING_INTENSIVE_TIMEOUT_FLOOR_MS, `65612ms (valor exato do incidente real) também é elevado — obtido ${effectiveTimeoutMs(65612, true)}`);
    assert(effectiveTimeoutMs(300000, true) === 300000, `um timeoutMs JÁ maior que o piso (300000) é preservado, não reduzido — obtido ${effectiveTimeoutMs(300000, true)}`);
    assert(effectiveTimeoutMs(undefined, true) === undefined, `sem timeoutMs (chamador não pediu nenhum), reasoningIntensive não inventa um — obtido ${effectiveTimeoutMs(undefined, true)}`);
}

console.log('\n=== S293.2 — CONTROLE NEGATIVO: sem reasoningIntensive, timeoutMs nunca é elevado ===');
{
    assert(effectiveTimeoutMs(30000, false) === 30000, `sem reasoningIntensive, 30000ms permanece 30000ms — obtido ${effectiveTimeoutMs(30000, false)}`);
    assert(effectiveTimeoutMs(6000, false) === 6000, `timeout curto de classificação (6000ms) preservado — não pode esperar o piso de reasoning por engano — obtido ${effectiveTimeoutMs(6000, false)}`);
    assert(effectiveTimeoutMs(30000, undefined) === 30000, `reasoningIntensive omitido (undefined) se comporta como false — obtido ${effectiveTimeoutMs(30000, undefined)}`);
}

console.log('\n=== S293.3 — auditoria estrutural: o código real usa o valor efetivo nos 3 pontos certos ===');
{
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'ProviderFactory.ts'), 'utf-8');

    const idx1 = src.indexOf('const effectiveTimeoutMs = (opts?.reasoningIntensive && timeoutMs)');
    assert(idx1 > 0, 'attemptTimeout/safetyTimeoutMs: effectiveTimeoutMs é calculado', idx1);
    const trecho1 = src.slice(idx1, idx1 + 900);
    assert(/Math\.max\(timeoutMs, REASONING_INTENSIVE_TIMEOUT_FLOOR_MS\)/.test(trecho1), 'usa Math.max com o piso compartilhado, não um número novo', trecho1);
    assert(/setTimeout\(\(\) => currentAbort\.abort\(\), effectiveTimeoutMs\)/.test(trecho1), 'attemptTimeout usa effectiveTimeoutMs, não o timeoutMs bruto', trecho1);
    assert(/const safetyTimeoutMs = effectiveTimeoutMs \+ 15000/.test(trecho1), 'safetyTimeoutMs deriva de effectiveTimeoutMs, não do timeoutMs bruto', trecho1);

    const idx2 = src.indexOf('const effectiveNonStreamingTimeoutMs = (opts?.reasoningIntensive && timeoutMs)');
    assert(idx2 > 0, 'chamada a fallbackNonStreaming: effectiveNonStreamingTimeoutMs é calculado', idx2);
    const trecho2 = src.slice(idx2, idx2 + 500);
    assert(/fallbackNonStreaming\(mensagensNaoStreaming, tools, effectiveNonStreamingTimeoutMs\)/.test(trecho2), 'fallbackNonStreaming() recebe o valor efetivo, não o timeoutMs bruto', trecho2);
}

console.log('\n=== S293.4 — a constante vem de providerTypes.ts, não duplicada localmente ===');
{
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'ProviderFactory.ts'), 'utf-8');
    assert(
        /import \{[^}]*REASONING_INTENSIVE_TIMEOUT_FLOOR_MS[^}]*\} from '\.\/providerTypes'/.test(src),
        'ProviderFactory.ts importa REASONING_INTENSIVE_TIMEOUT_FLOOR_MS de providerTypes.ts em vez de declarar seu próprio número',
    );
    assert(REASONING_INTENSIVE_TIMEOUT_FLOOR_MS === 240000, `valor do piso é 240000ms (mesmo valor de MAX_THINKING_DURATION_MS com reasoningIntensive em OllamaProvider.ts) — obtido ${REASONING_INTENSIVE_TIMEOUT_FLOOR_MS}`);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S293 RESULTADO: ${passed} passou | ${failed} falhou`);
process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
