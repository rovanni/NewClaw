/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S459 (29/10/2026, ADR-019, achado A3 da issue 066)
 *
 * ORIGEM: 17–19/10/2026, nas duas instalações — o link privado de uma agenda (`.../private-<token>/basic.ics`) ficou no log, na
 * memória e num arquivo do workspace. Quem tem o link lê a agenda: o token é credencial.
 *
 * REGRESSÃO SE: o token de `private-…` ou de um parâmetro de credencial (`?token=`, `&key=`, `access_token=`, `sig=`) deixar de ir
 * ao cofre; o resto do link deixar de ficar legível; a ferramenta deixar de receber o link inteiro pelo marcador; ou link comum
 * (`?lang=pt`, `?key=en`, `/private-docs/`) virar segredo.
 *
 * Execução: npx ts-node src/__tests__/regression/S459_Cofre_TokenDentroDeLink.test.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectarSegredos, protegerEntrada, resolverMarcadores } from '../../shared/segredos';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

console.log('\n=== S459 — token dentro de link vai ao cofre ===\n');

// Tokens sintéticos.
const TOKEN_ICS = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const LINK_ICS = `https://calendar.example/calendar/ical/fulano%40example/private-${TOKEN_ICS}/basic.ics`;
const TOKEN_Q = 'Zx8Qw7Er6Ty5Ui4Op3';

assert(detectarSegredos(`assina esta agenda: ${LINK_ICS}`).includes(TOKEN_ICS), 'segmento private-<token> (agenda ICS)');
assert(detectarSegredos(`https://api.example/v1/dados?formato=json&token=${TOKEN_Q}`).includes(TOKEN_Q), 'parâmetro token=');
assert(detectarSegredos(`https://files.example/x.pdf?access_token=${TOKEN_Q}&dl=1`).includes(TOKEN_Q), 'parâmetro access_token=');
assert(detectarSegredos(`https://maps.example/api?KEY=${TOKEN_Q}`).includes(TOKEN_Q), 'nome do parâmetro em maiúsculas');

assert(detectarSegredos('veja https://site.example/busca?q=newclaw&lang=pt').length === 0, 'parâmetros comuns não são segredo');
assert(detectarSegredos('https://site.example/doc?key=en').length === 0, 'valor curto (key=en) não é acesso');
assert(detectarSegredos('https://site.example/private-docs/manual.pdf').length === 0, 'private-<palavra curta> não é token');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s459-'));
const envPath = path.join(dir, '.env');
fs.writeFileSync(envPath, 'APP_LANG=pt-BR\n');
const envAntes = { ...process.env };
try {
    const p = protegerEntrada(`adiciona minha agenda ${LINK_ICS}`, envPath);
    assert(p.guardados.length === 1, 'um segredo guardado', p);
    assert(!p.texto.includes(TOKEN_ICS), 'o token não segue em claro', p.texto);
    assert(p.texto.includes('/basic.ics') && p.texto.includes('calendar.example'), 'o resto do link continua legível', p.texto);
    assert(resolverMarcadores(p.texto.split(' ').pop()!) === LINK_ICS, 'a ferramenta recebe o link inteiro pelo marcador');
} finally {
    for (const k of Object.keys(process.env)) if (!(k in envAntes)) delete process.env[k];
    fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S459 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
process.exit(failed > 0 ? 1 : 0);
