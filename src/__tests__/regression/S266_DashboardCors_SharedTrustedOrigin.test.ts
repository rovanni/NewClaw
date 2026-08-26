/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S266 (campanha de Security: CORS + `.env` + `DASHBOARD_HOST`, item B)
 *
 * `DashboardServer.ts` chamava `cors()` sem nenhuma opção — `Access-Control-Allow-Origin: *`
 * pra qualquer origem, enquanto `csrfOriginCheck` (security.ts) já tinha sua própria regra de
 * "esta origem é o próprio Dashboard" (comparar host do Origin contra o Host da requisição). Duas
 * definições de "origem confiável" que coincidiam por acaso, não por serem a mesma fonte.
 *
 * Correção: `isTrustedOrigin(originHeader, requestHost)` extraída pra `security.ts` — usada tanto
 * por `csrfOriginCheck` quanto pela config de `cors()` em `DashboardServer.ts`. Fonte única.
 *
 * REGRESSÃO SE: `csrfOriginCheck` e a config de `cors()` voltarem a ter regras de origem
 * independentes; ou se `isTrustedOrigin` deixar de tratar corretamente os casos base (origem
 * batendo o host, origem de outro site, ausência de Origin, URL inválida).
 *
 * Execução: npx ts-node src/__tests__/regression/S266_DashboardCors_SharedTrustedOrigin.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { isTrustedOrigin } from '../../dashboard/security';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

function readSrc(relPath: string): string {
    return fs.readFileSync(path.join(process.cwd(), 'src', relPath), 'utf-8');
}

async function main(): Promise<void> {

console.log('\n=== S266-1 [estrutural] — csrfOriginCheck e a config de cors() usam a MESMA função ===');
{
    const securitySrc = readSrc('dashboard/security.ts');
    const serverSrc = readSrc('dashboard/DashboardServer.ts');
    assert(/export function isTrustedOrigin/.test(securitySrc), 'isTrustedOrigin é exportada de security.ts (fonte única)', null);
    assert(/isTrustedOrigin\(/.test(securitySrc) && securitySrc.indexOf('function csrfOriginCheck') < securitySrc.lastIndexOf('isTrustedOrigin('), 'csrfOriginCheck chama isTrustedOrigin (não reimplementa a comparação)', null);
    assert(serverSrc.includes("isTrustedOrigin") && serverSrc.includes("from './security'"), 'DashboardServer.ts importa isTrustedOrigin de security.ts (não uma cópia local)', null);
    assert(!/cors\(\)\s*;?\s*$/m.test(serverSrc.replace(/\/\/.*$/gm, '')), 'cors() não é mais chamado sem opções (política de origem própria, não *)', null);
}

console.log('\n=== S266-2 [funcional] — origem batendo o host é confiável ===');
{
    assert(isTrustedOrigin('https://dashboard.local:3090', 'dashboard.local:3090') === true, 'Origin com o mesmo host:porta do Host é confiável', null);
    assert(isTrustedOrigin('http://127.0.0.1:3090', '127.0.0.1:3090') === true, 'caso comum: acesso local direto', null);
}

console.log('\n=== S266-3 [funcional] — origem de outro site NUNCA é confiável ===');
{
    assert(isTrustedOrigin('https://attacker.evil', 'dashboard.local:3090') === false, 'origem de domínio diferente é rejeitada', null);
    assert(isTrustedOrigin('https://dashboard.local.attacker.evil', 'dashboard.local:3090') === false, 'subdomínio-armadilha (host contém o nome, mas não é igual) é rejeitado — comparação é igualdade exata, não includes/startsWith', null);
}

console.log('\n=== S266-4 [funcional] — casos de borda: sem Origin, sem Host, URL inválida ===');
{
    assert(isTrustedOrigin(undefined, 'dashboard.local:3090') === false, 'sem Origin → não confiável (quem decide se isso bloqueia ou libera é o CHAMADOR — CORS libera, CSRF bloqueia; a função só responde a pergunta objetiva)', null);
    assert(isTrustedOrigin('https://dashboard.local:3090', undefined) === false, 'sem Host na requisição → não confiável', null);
    assert(isTrustedOrigin('not a valid url', 'dashboard.local:3090') === false, 'Origin malformado não lança exceção — devolve false', null);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S266 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S266 erro inesperado:', err);
    process.exitCode = 1;
});
