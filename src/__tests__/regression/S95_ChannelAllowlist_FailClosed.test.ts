/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S95
 * Auditoria adversarial 2026-07-12, achado C2 (Crítico): allowlist de canal com semântica
 * DIVERGENTE entre canais. WhatsApp/Signal/Discord usavam a guarda `allowlist.length > 0 &&`,
 * o que fazia allowlist VAZIA = "aceita QUALQUER remetente". O Telegram tinha a semântica oposta
 * (vazio = bloqueia todos). Uma instalação com um canal habilitado mas sem allowlist configurada
 * aceitava comandos de terceiros — incluindo goals que executam exec_command/ssh_exec.
 *
 * FIX (holístico): channels/accessControl.ts é o ponto ÚNICO da regra. `isSenderAllowed` é
 * FAIL-CLOSED — allowlist ausente/vazia nega tudo, uniforme entre todos os canais. `isWithinScope`
 * cobre o filtro secundário de guild do Discord (fail-open, pois DM não tem guild).
 *
 * Execução: npx ts-node src/__tests__/regression/S95_ChannelAllowlist_FailClosed.test.ts
 */

import { isSenderAllowed, isWithinScope } from '../../channels/accessControl';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${msg}`, detail ?? ''); failed++; }
}

console.log('\n=== S95-A — isSenderAllowed FAIL-CLOSED: vazio/ausente nega tudo ===');
assert(isSenderAllowed(undefined, 'user1') === false, 'allowlist undefined nega');
assert(isSenderAllowed([], 'user1') === false, 'allowlist vazia [] nega');
assert(isSenderAllowed(['   ', ''], 'user1') === false, 'allowlist só com entradas em branco nega (trim)');

console.log('\n=== S95-B — isSenderAllowed permite apenas remetentes listados ===');
assert(isSenderAllowed(['user1', 'user2'], 'user1') === true, 'remetente listado é permitido');
assert(isSenderAllowed(['user1'], 'intruso') === false, 'remetente NÃO listado é negado');

console.log('\n=== S95-C — múltiplas identidades do mesmo remetente (WhatsApp: jid OU número) ===');
assert(
    isSenderAllowed(['5511999999999@s.whatsapp.net'], '5511999999999@s.whatsapp.net', '5511999999999') === true,
    'casa pelo jid completo',
);
assert(
    isSenderAllowed(['5511999999999'], '5511999999999@s.whatsapp.net', '5511999999999') === true,
    'casa pelo número quando a allowlist tem só o número',
);
assert(
    isSenderAllowed(['5511000000000'], '5511999999999@s.whatsapp.net', '5511999999999') === false,
    'número diferente é negado',
);

console.log('\n=== S95-D — identidade ausente (ex.: Signal sem sourceNumber) é negada (fail-closed) ===');
assert(isSenderAllowed(['+5511999999999'], undefined) === false, 'sem identidade → negado');
assert(isSenderAllowed(['+5511999999999'], null) === false, 'identidade null → negada');
assert(isSenderAllowed(['+5511999999999'], '') === false, 'identidade string vazia → negada');

console.log('\n=== S95-E — isWithinScope (guild Discord) FAIL-OPEN quando não configurado ===');
assert(isWithinScope(undefined, 'guild1') === true, 'sem lista de guild → não restringe');
assert(isWithinScope([], 'guild1') === true, 'lista de guild vazia → não restringe');
assert(isWithinScope(['guild1'], 'guild1') === true, 'guild listada passa');
assert(isWithinScope(['guild1'], 'guild2') === false, 'guild NÃO listada é barrada');
assert(isWithinScope(['guild1'], undefined) === true, 'DM (sem guild) não é filtrada por guild');

console.log('\n=== S95-F — paridade entre canais: mesma allowlist vazia → mesma decisão (nega) ===');
// Antes do fix, WhatsApp/Signal/Discord diziam "aceita" e Telegram "nega" para este mesmo input.
const decisions = [
    isSenderAllowed([], 'qualquer_um'), // whatsapp
    isSenderAllowed([], 'qualquer_um'), // signal
    isSenderAllowed([], 'qualquer_um'), // discord
    isSenderAllowed([], 'qualquer_um'), // telegram
];
assert(decisions.every(d => d === false), 'os 4 canais negam uniformemente com allowlist vazia', decisions);

console.log(`\n${'─'.repeat(60)}`);
console.log(`S95 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exit(1);
