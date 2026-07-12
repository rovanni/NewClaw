/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S75
 *
 * Investigação (09/07/2026, newclaw-audit.log): usuário reportou
 * "ALL_PROVIDERS_CIRCUIT_OPEN — no provider available" pela manhã. Rastreamento:
 *
 *   07:45:42 [CircuitBreaker] [ollama] Circuit CLOSED → OPEN          (6 falhas reais)
 *   07:45:54 [CIRCUIT-BREAKER] ollama: REJECTED (open)                (esperado, dentro do cooldown)
 *   08:01:16 [CircuitBreaker] [ollama] Circuit OPEN → HALF_OPEN       (resetTimeoutMs passou)
 *   08:01:23 [...] CIRCUIT-OPEN: Skipping 'ollama' (failures: 0)      (!)
 *   08:01:47, 08:01:50 (×2), 08:01:55, 08:01:58, 08:01:59, 08:02:46,
 *   08:02:47 (×2), 08:02:56, 08:02:57, 08:03:18, 08:03:19             — todos idênticos,
 *   sempre "(failures: 0)", NUNCA mais nenhuma transição de estado logada depois de
 *   08:01:16. O circuito ficou preso rejeitando 100% das chamadas por >2min straight
 *   (e continuaria preso indefinidamente, até restart do processo).
 *
 * Causa raiz: CircuitBreaker.canExecute() no estado HALF_OPEN usava um boolean
 * (halfOpenAttempted) que permite exatamente UMA tentativa de teste, nunca mais,
 * até a próxima transição PARA half-open. Mas onSuccess() só fecha o circuito
 * (HALF_OPEN → CLOSED) quando consecutiveSuccesses >= successThreshold (default 3).
 * Com o gate de 1 tentativa, é estruturalmente impossível acumular 3 sucessos
 * consecutivos: a 1ª tentativa bem-sucedida zera consecutiveFailures (por isso os
 * logs mostravam "failures: 0") mas NÃO fecha o circuito (só 1 de 3 sucessos) — e
 * nenhuma tentativa seguinte é permitida, então o circuito fica PRESO em HALF_OPEN
 * pra sempre, rejeitando tudo, mesmo com o provider 100% saudável.
 *
 * Fix: halfOpenAttempted (boolean) → halfOpenAttempts (number), permitindo até
 * successThreshold tentativas de teste durante HALF_OPEN — mesmo número de sucessos
 * que onSuccess() já exige pra fechar. Qualquer falha durante esse período ainda
 * reabre o circuito imediatamente (onFailure já fazia isso, não foi alterado) — não
 * há risco de inundar um provider genuinamente quebrado.
 *
 * Escopo tocado: core/CircuitBreaker.ts (1 campo + 2 pontos de uso).
 *
 * Execução: npx ts-node src/__tests__/regression/S75_CircuitBreaker_HalfOpenStuck.test.ts
 */

import { CircuitBreaker } from '../../core/CircuitBreaker';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main(): Promise<void> {

console.log('\n=== S75-1 [runtime — reprodução exata do incidente] — 1 sucesso em HALF_OPEN NÃO fecha nem trava o circuito, permite novas tentativas ===');
{
    // Mesmo config default de produção (successThreshold=3), só com timeouts curtos pra teste rápido.
    const breaker = new CircuitBreaker({ name: 'ollama-test-1', failureThreshold: 5, resetTimeoutMs: 20, successThreshold: 3 });

    for (let i = 0; i < 5; i++) breaker.recordFailure('provider down');
    assert(breaker.getState() === 'OPEN', 'após 5 falhas consecutivas (= failureThreshold), circuito abre', breaker.getState());
    assert(breaker.canExecute() === false, 'dentro do cooldown, canExecute() rejeita', null);

    await sleep(25); // > resetTimeoutMs

    const firstTestAllowed = breaker.canExecute();
    assert(firstTestAllowed === true, 'após resetTimeoutMs, a 1ª chamada de teste é permitida (transição OPEN → HALF_OPEN)', null);
    assert(breaker.getState() === 'HALF_OPEN', 'estado é HALF_OPEN após a transição', breaker.getState());

    breaker.recordSuccess(); // 1º de 3 sucessos necessários
    assert(breaker.getState() === 'HALF_OPEN', 'com apenas 1/3 sucessos, o circuito AINDA NÃO fecha (comportamento correto)', breaker.getState());

    // Este é o ponto exato do bug real: antes do fix, esta chamada retornava false pra sempre.
    const secondTestAllowed = breaker.canExecute();
    assert(secondTestAllowed === true,
        'CRÍTICO: uma 2ª tentativa de teste É permitida em HALF_OPEN (antes do fix: sempre false depois da 1ª — circuito preso pra sempre, reproduzindo "CIRCUIT-OPEN: Skipping (failures: 0)" infinito do incidente real)',
        null);
}

console.log('\n=== S75-2 [runtime] — successThreshold sucessos consecutivos em HALF_OPEN fecham o circuito normalmente ===');
{
    const breaker = new CircuitBreaker({ name: 'ollama-test-2', failureThreshold: 5, resetTimeoutMs: 20, successThreshold: 3 });
    for (let i = 0; i < 5; i++) breaker.recordFailure('provider down');
    await sleep(25);

    assert(breaker.canExecute() === true, 'tentativa 1/3 permitida', null);
    breaker.recordSuccess();
    assert(breaker.canExecute() === true, 'tentativa 2/3 permitida', null);
    breaker.recordSuccess();
    assert(breaker.getState() === 'HALF_OPEN', 'ainda HALF_OPEN com 2/3 sucessos', breaker.getState());
    assert(breaker.canExecute() === true, 'tentativa 3/3 permitida', null);
    breaker.recordSuccess();
    assert(breaker.getState() === 'CLOSED', 'com 3/3 sucessos consecutivos (successThreshold atingido), o circuito FECHA', breaker.getState());
    assert(breaker.canExecute() === true, 'circuito fechado aceita chamadas normalmente', null);
}

console.log('\n=== S75-3 [runtime] — falha durante HALF_OPEN reabre o circuito imediatamente (sem regressão: não flooda provider quebrado) ===');
{
    const breaker = new CircuitBreaker({ name: 'ollama-test-3', failureThreshold: 5, resetTimeoutMs: 20, successThreshold: 3 });
    for (let i = 0; i < 5; i++) breaker.recordFailure('provider down');
    await sleep(25);

    assert(breaker.canExecute() === true, 'tentativa de teste permitida', null);
    breaker.recordFailure('still down'); // teste de half-open falha
    assert(breaker.getState() === 'OPEN', 'falha durante HALF_OPEN reabre o circuito imediatamente (não fica testando indefinidamente)', breaker.getState());
    assert(breaker.canExecute() === false, 'circuito recém-reaberto rejeita chamadas até o próximo cooldown', null);
}

console.log('\n=== S75-4 [runtime] — reset() manual limpa o contador de tentativas de HALF_OPEN corretamente ===');
{
    const breaker = new CircuitBreaker({ name: 'ollama-test-4', failureThreshold: 5, resetTimeoutMs: 20, successThreshold: 3 });
    for (let i = 0; i < 5; i++) breaker.recordFailure('provider down');
    await sleep(25);
    breaker.canExecute(); // consome 1 tentativa half-open
    breaker.reset();
    assert(breaker.getState() === 'CLOSED', 'reset() força o circuito a CLOSED', breaker.getState());

    // Depois de um reset, um novo ciclo completo de open→half-open precisa voltar a
    // permitir successThreshold tentativas do zero, não continuar de onde parou.
    for (let i = 0; i < 5; i++) breaker.recordFailure('provider down again');
    await sleep(25);
    assert(breaker.canExecute() === true, 'novo ciclo half-open após reset() permite tentativa 1 normalmente (contador não vazou do ciclo anterior)', null);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S75 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S75 erro inesperado:', err);
    process.exitCode = 1;
});
