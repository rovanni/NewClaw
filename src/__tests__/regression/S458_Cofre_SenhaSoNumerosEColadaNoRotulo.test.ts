/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S458 (29/10/2026, ADR-019)
 *
 * ORIGEM: 22/10/2026, VPS — a senha de uma VM digitada como "senha 123456789" ficou em claro no log, no banco e num arquivo do
 * workspace. Duas regras a deixavam passar: o valor rotulado exigia ":"/"="/verbo entre o rótulo e o valor, e `temCaraDeSenha`
 * exigia duas classes de caractere (só dígitos nunca contava).
 *
 * REGRESSÃO SE: "senha 123456789" / "password Xy9!q2w3e" / "o PIN é 482913" deixarem de ser reconhecidos; ou se prosa passar a
 * ser senha — "a senha nova", "a senha do servidor fica com o João", "a senha tem 8 dígitos", número curto depois de senha.
 *
 * Execução: npx ts-node src/__tests__/regression/S458_Cofre_SenhaSoNumerosEColadaNoRotulo.test.ts
 */
import { detectarSegredos } from '../../shared/segredos';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

console.log('\n=== S458 — senha só de números e senha colada no rótulo ===\n');

// Valores sintéticos — nenhum é credencial real.
assert(detectarSegredos('senha 123456789').includes('123456789'), '"senha 123456789" (o caso real)');
assert(detectarSegredos('acessa a vm17, usuario root senha 987654321.').includes('987654321'), 'no meio da frase, sem a pontuação final');
assert(detectarSegredos('password Xy9!q2w3e').includes('Xy9!q2w3e'), 'en: rótulo e valor com cara de senha');
assert(detectarSegredos('contraseña 55512399').includes('55512399'), 'es: só dígitos');
assert(detectarSegredos('a senha é 482913').includes('482913'), 'rótulo + verbo + 6 dígitos (PIN)');
assert(detectarSegredos('token: 99887766').includes('99887766'), 'rótulo + dois-pontos + dígitos');

assert(detectarSegredos('a senha nova ficou pronta').length === 0, 'palavra comum colada no rótulo não é senha');
assert(detectarSegredos('a senha tem 8 dígitos').length === 0, 'número curto não é senha');
assert(detectarSegredos('senha 12345').length === 0, 'menos de 6 dígitos não conta');
assert(detectarSegredos('a senha do servidor 2026 fica com o João').length === 0, 'palavras entre o rótulo e o número continuam exigindo sinal ou verbo');
assert(detectarSegredos('o pedido 123456789 chegou').length === 0, 'número sem rótulo de credencial não é senha');

console.log(`\n${'─'.repeat(60)}`);
console.log(`S458 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
process.exit(failed > 0 ? 1 : 0);
