/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S267 (campanha de Security: CORS + `.env` + `DASHBOARD_HOST`, item C)
 *
 * Fase 3.5 desta campanha investigou o próprio repositório (`.env.example`, instaladores,
 * auditoria arquitetural) em vez de assumir uma política — achado: `.env.example` já documenta
 * `DASHBOARD_HOST=0.0.0.0` como exigindo `DASHBOARD_PASSWORD` "OBRIGATORIAMENTE"; o código só
 * emitia um `log.warn` (fácil de não ver rodando via pm2) e deixava o processo subir mesmo assim
 * — com `authMiddleware` liberando TODA a API sem autenticação (`if (!dashboardAuth.enabled) {
 * next(); return; }`) pra qualquer um que alcance a porta.
 *
 * Correção: `DashboardServer.start()` interrompe o boot (`process.exit(1)`) nesta combinação
 * específica, em vez de só avisar. Aplica o contrato já documentado, não uma política nova —
 * `DASHBOARD_HOST=127.0.0.1` (padrão) nunca é afetado, com ou sem senha.
 *
 * REGRESSÃO SE: a combinação host≠127.0.0.1 + sem senha voltar a só gerar aviso; ou se o bind
 * padrão (127.0.0.1) passar a ser bloqueado por engano quando não deveria.
 *
 * Execução: npx ts-node src/__tests__/regression/S267_DashboardBoot_BlocksUnsafeExposure.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { isUnsafeExposedBoot } from '../../dashboard/DashboardServer';

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

console.log('\n=== S267-1 [funcional] — matriz completa host × senha ===');
{
    assert(isUnsafeExposedBoot('127.0.0.1', false) === false, 'bind padrão (127.0.0.1) SEM senha — nunca bloqueado (é o caso comum, auth OFF é intencional pra localhost)', null);
    assert(isUnsafeExposedBoot('127.0.0.1', true) === false, 'bind padrão (127.0.0.1) COM senha — nunca bloqueado', null);
    assert(isUnsafeExposedBoot('0.0.0.0', true) === false, 'exposto (0.0.0.0) COM senha — segue o contrato documentado, não bloqueado', null);
    assert(isUnsafeExposedBoot('0.0.0.0', false) === true, 'exposto (0.0.0.0) SEM senha — bloqueado (a combinação que o .env.example já proíbe)', null);
    assert(isUnsafeExposedBoot('lan-host.example', false) === true, 'qualquer host que não seja 127.0.0.1, sem senha — bloqueado (não é só literal "0.0.0.0")', null);
    // Achado na revisão de código: escalar de log.warn pra process.exit(1) sem cobrir as OUTRAS
    // formas de loopback derrubaria o boot de quem usa DASHBOARD_HOST=localhost ou ::1 — antes
    // isso só gerava aviso. Mesmo conjunto que ProviderFactory.rodaNaMaquinaDoUsuario() já usa.
    assert(isUnsafeExposedBoot('localhost', false) === false, 'DASHBOARD_HOST=localhost sem senha — NÃO bloqueado (é loopback, mesma segurança que 127.0.0.1)', null);
    assert(isUnsafeExposedBoot('::1', false) === false, 'DASHBOARD_HOST=::1 (loopback IPv6) sem senha — NÃO bloqueado', null);
}

console.log('\n=== S267-2 [estrutural] — start() realmente chama process.exit(1) nessa condição, não só loga ===');
{
    const src = readSrc('dashboard/DashboardServer.ts');
    const startFn = src.slice(src.indexOf('public start('), src.indexOf('public async stop('));
    const guardIdx = startFn.search(/isUnsafeExposedBoot\(host,\s*dashboardAuth\.enabled\)/);
    const exitIdx = startFn.indexOf('process.exit(1)');
    assert(guardIdx !== -1, 'start() usa isUnsafeExposedBoot() com o host resolvido e o estado real de auth', startFn);
    assert(exitIdx !== -1 && guardIdx !== -1 && exitIdx > guardIdx && (exitIdx - guardIdx) < 800, 'process.exit(1) aparece logo depois da checagem — não é mais só log.warn', { guardIdx, exitIdx });
}

console.log('\n=== S267-3 [contrato] — .env.example já documenta esta exigência (a correção aplica, não inventa) ===');
{
    const envExample = readSrc('../.env.example');
    assert(/OBRIGATORIAMENTE.*DASHBOARD_PASSWORD|DASHBOARD_PASSWORD.*OBRIGAT/i.test(envExample), '.env.example já afirma que DASHBOARD_PASSWORD é obrigatória ao expor além de localhost', null);
}

console.log('\n=== S267-4 [achado da revisão de segurança independente] — ordem start()/setMemoryManager() é vigiada, não silenciosa ===');
{
    const src = readSrc('dashboard/DashboardServer.ts');
    assert(/authPersistenceLoaded\s*=\s*true/.test(src), 'setMemoryManager() marca authPersistenceLoaded=true depois de initAuthPersistence()', null);
    assert(/if\s*\(\s*!this\.authPersistenceLoaded\s*\)/.test(src), 'start() checa a flag antes de confiar em dashboardAuth.enabled', null);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S267 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S267 erro inesperado:', err);
    process.exitCode = 1;
});
