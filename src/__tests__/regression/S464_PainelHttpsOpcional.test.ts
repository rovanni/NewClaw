/// <reference types="node" />
/**
 * S464 — HTTPS opcional no painel (29/10/2026).
 *
 * Problema: o navegador só libera o microfone em página segura (HTTPS ou localhost). Aberto pela rede em
 * http://<ip>:3090, o ditado do painel recebia `not-allowed`. O NewClaw não sabia servir HTTPS.
 *
 * Correção: com DASHBOARD_TLS_CERT + DASHBOARD_TLS_KEY, o painel atende DASHBOARD_HOST em HTTPS
 * (DASHBOARD_HTTPS_PORT) e o HTTP fica só em 127.0.0.1 — as ferramentas locais (`newclaw update`, `doctor`, troca de
 * senha), que chamam http://127.0.0.1:<DASHBOARD_PORT>, não quebram; pela rede só existe HTTPS. Sem as variáveis, nada
 * muda. O cookie de sessão ganha `Secure` quando o pedido veio pelo HTTPS.
 *
 * Cobre:
 *   1 → `planejarEscuta`: sem TLS igual a antes; com TLS, HTTPS no host configurado e HTTP preso a 127.0.0.1;
 *       configuração pela metade, porta inválida ou igual à do HTTP param o boot com motivo.
 *   2 → estrutura: `DashboardServer` usa `planejarEscuta`, sobe `https.createServer` e fecha os dois servidores; o
 *       cookie usa `secure: req.secure`; a regra de boot exposto sem senha continua valendo para o host exposto.
 */

import * as fs from 'fs';
import * as path from 'path';
import { planejarEscuta, DASHBOARD_HTTPS_PORT_PADRAO } from '../../dashboard/hostSafety';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function main() {

console.log('\n── 1. planejarEscuta ──');
{
    const semTls = planejarEscuta({ DASHBOARD_HOST: '0.0.0.0' }, 3090);
    assert(semTls.http.host === '0.0.0.0' && semTls.http.port === 3090 && !semTls.https && !semTls.erro,
        'sem DASHBOARD_TLS_*: comportamento de antes (HTTP no DASHBOARD_HOST)', semTls);

    const padrao = planejarEscuta({}, 3090);
    assert(padrao.http.host === '127.0.0.1' && !padrao.https, 'sem DASHBOARD_HOST: 127.0.0.1, como antes', padrao);

    const comTls = planejarEscuta({ DASHBOARD_HOST: '0.0.0.0', DASHBOARD_TLS_CERT: 'c.pem', DASHBOARD_TLS_KEY: 'k.pem' }, 3090);
    assert(comTls.http.host === '127.0.0.1' && comTls.http.port === 3090,
        'com TLS: o HTTP fica só em 127.0.0.1 (ferramentas locais seguem funcionando)', comTls);
    assert(comTls.https?.host === '0.0.0.0' && comTls.https?.port === DASHBOARD_HTTPS_PORT_PADRAO
        && comTls.https?.certFile === 'c.pem' && comTls.https?.keyFile === 'k.pem',
        'com TLS: o HTTPS atende o DASHBOARD_HOST, na porta padrão declarada', comTls);

    const portaPropria = planejarEscuta({ DASHBOARD_TLS_CERT: 'c', DASHBOARD_TLS_KEY: 'k', DASHBOARD_HTTPS_PORT: '8443' }, 3090);
    assert(portaPropria.https?.port === 8443 && portaPropria.https?.host === '127.0.0.1', 'DASHBOARD_HTTPS_PORT vale; host padrão 127.0.0.1', portaPropria);

    for (const [nome, env] of [
        ['só o certificado', { DASHBOARD_TLS_CERT: 'c' }],
        ['só a chave', { DASHBOARD_TLS_KEY: 'k' }],
        ['porta inválida', { DASHBOARD_TLS_CERT: 'c', DASHBOARD_TLS_KEY: 'k', DASHBOARD_HTTPS_PORT: 'abc' }],
        ['porta fora da faixa', { DASHBOARD_TLS_CERT: 'c', DASHBOARD_TLS_KEY: 'k', DASHBOARD_HTTPS_PORT: '70000' }],
        ['porta igual à do HTTP', { DASHBOARD_TLS_CERT: 'c', DASHBOARD_TLS_KEY: 'k', DASHBOARD_HTTPS_PORT: '3090' }],
    ] as const) {
        const p = planejarEscuta(env as Record<string, string>, 3090);
        assert(typeof p.erro === 'string' && p.erro.length > 0 && !p.https, `configuração inconsistente para o boot com motivo: ${nome}`, p);
    }
    assert(!planejarEscuta({ DASHBOARD_TLS_CERT: '  ', DASHBOARD_TLS_KEY: '' }, 3090).erro, 'variáveis vazias (como o instalador grava) = sem TLS, sem erro');
}

console.log('\n── 2. Estrutura ──');
{
    const raiz = path.resolve(__dirname, '../../..');
    const servidor = fs.readFileSync(path.join(raiz, 'src/dashboard/DashboardServer.ts'), 'utf-8');
    const auth = fs.readFileSync(path.join(raiz, 'src/dashboard/routes/auth.ts'), 'utf-8');
    assert(/planejarEscuta\(process\.env, port\)/.test(servidor), 'DashboardServer decide as portas por planejarEscuta (fonte única)');
    assert(/https\.createServer\(tls, this\.app\)/.test(servidor), 'o HTTPS serve o MESMO app (mesmas rotas, auth, CSRF e CORS)');
    assert(/for \(const servidor of \[this\.server, this\.httpsServer\]\)/.test(servidor), 'stop() fecha os dois servidores');
    assert(/isUnsafeExposedBoot\(host, dashboardAuth\.enabled\)/.test(servidor) && /const host = plano\.https\?\.host \?\? plano\.http\.host/.test(servidor),
        'a regra de boot exposto sem senha julga o host que fica exposto (o do HTTPS, quando há)');
    assert(/secure: req\.secure/.test(auth), 'cookie de sessão com Secure quando o login veio pelo HTTPS');
    const exemplo = fs.readFileSync(path.join(raiz, '.env.example'), 'utf-8');
    assert(['DASHBOARD_TLS_CERT=', 'DASHBOARD_TLS_KEY=', 'DASHBOARD_HTTPS_PORT='].every(v => exemplo.includes(v)), '.env.example documenta as três variáveis');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S464 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S464 erro inesperado:', err);
    process.exitCode = 1;
});
