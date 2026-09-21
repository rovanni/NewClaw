/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S277 (docs/issues/026, achado nº1)
 *
 * Com a autenticação desligada (instalação padrão, bind em loopback), o servidor confiava no
 * header `Host` como veio: uma requisição com `Host: evil.example` + `Origin` coerente era atendida
 * — inclusive `POST /api/auth/config`, que define a primeira senha e tranca o operador para fora
 * (DNS rebinding; reproduzido em instância real em 21/09/2026).
 *
 * Correção: `createHostGate` (hostSafety.ts), primeiro middleware do DashboardServer — enquanto a
 * auth está DESLIGADA só atende Host loopback; Host ausente/ilegível → 403 (fail-closed); com a
 * auth LIGADA o gate não age.
 *
 * O problema é de PERÍMETRO da API inteira, não de uma rota: por isso o teste sobe um Express real
 * (gate + authMiddleware + router de auth reais + uma rota de API qualquer) e dispara requisições
 * reais com `Host` forjado, cobrindo mais do que `/api/auth/config`.
 *
 * Execução: npx ts-node src/__tests__/regression/S277_DashboardHostGate_AuthOffLoopbackOnly.test.ts
 */

import express from 'express';
import fs from 'fs';
import http from 'http';
import net from 'net';
import path from 'path';
import { AddressInfo } from 'net';
import { isLoopbackHostHeader, createHostGate } from '../../dashboard/hostSafety';
import { authMiddleware, createAuthRouter, dashboardAuth } from '../../dashboard/routes/auth';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

interface Resp { status: number; body: any }
function request(port: number, method: string, urlPath: string, headers: Record<string, string>, body?: unknown): Promise<Resp> {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const req = http.request({
            host: '127.0.0.1', port, method, path: urlPath,
            headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers },
        }, (res) => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => { let parsed: any = data; try { parsed = JSON.parse(data); } catch { /* texto */ } resolve({ status: res.statusCode || 0, body: parsed }); });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

/** HTTP/1.0 SEM header Host — o `http.request` do Node sempre injeta um, então vai por socket cru. */
function requestWithoutHost(port: number, urlPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1', () => sock.write(`GET ${urlPath} HTTP/1.0\r\n\r\n`));
        let data = '';
        sock.on('data', d => data += d);
        sock.on('end', () => resolve(parseInt(/^HTTP\/1\.[01] (\d{3})/.exec(data)?.[1] || '0', 10)));
        sock.on('error', reject);
    });
}

async function main(): Promise<void> {

console.log('\n=== S277.1 — isLoopbackHostHeader: aceita só destino loopback, parse estrito ===');
{
    for (const h of ['127.0.0.1', '127.0.0.1:3090', 'localhost', 'localhost:3090', 'LOCALHOST:3090', '[::1]', '[::1]:3090']) {
        assert(isLoopbackHostHeader(h) === true, `aceita "${h}"`);
    }
    for (const h of ['evil.example', 'evil.example:3090', 'localhost.evil.com', '127.0.0.1.evil.com',
                     'evil.com/127.0.0.1', 'user@127.0.0.1', '127.0.0.1:abc', '127.0.0.1:', '0.0.0.0',
                     '192.0.2.10:3090', '::1', '127.0.0.1 evil', '', '   ']) {
        assert(isLoopbackHostHeader(h) === false, `rejeita "${h}"`);
    }
    assert(isLoopbackHostHeader(undefined) === false, 'rejeita Host ausente (fail-closed)');
}

// App com o perímetro na MESMA ordem do DashboardServer: gate → json → auth → routers → API.
const app = express();
app.use(createHostGate(() => dashboardAuth.enabled));
app.use(express.json());
app.use(authMiddleware);
app.use('/api/auth', createAuthRouter());
app.use('/api', (_req, res) => { res.json({ reached: true }); }); // qualquer outra rota de API
const server: http.Server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const port = (server.address() as AddressInfo).port;
const local = `127.0.0.1:${port}`;

try {
    console.log('\n=== S277.2 — auth OFF + Host local: permitido ===');
    for (const h of [local, `localhost:${port}`, `[::1]:${port}`]) {
        const r = await request(port, 'GET', '/api/auth/status', { Host: h });
        assert(r.status === 200 && r.body.auth?.enabled === false, `Host ${h} → 200`, r);
    }
    const anyApi = await request(port, 'GET', '/api/qualquer-coisa', { Host: local });
    assert(anyApi.status === 200 && anyApi.body.reached === true, 'outra rota de API com Host local → alcançada', anyApi);

    console.log('\n=== S277.3 — auth OFF + Host externo: 403 na API inteira, estado intacto ===');
    const evil = 'evil.example:' + port;
    const st = await request(port, 'GET', '/api/auth/status', { Host: evil });
    assert(st.status === 403, 'GET /api/auth/status com Host externo → 403', st);
    assert(/DASHBOARD_PASSWORD/.test(st.body?.error || '') && /desativada/.test(st.body?.error || ''),
        '403 é operacional: cita autenticação desativada e DASHBOARD_PASSWORD', st.body);
    const other = await request(port, 'GET', '/api/qualquer-coisa', { Host: evil });
    assert(other.status === 403 && other.body.reached !== true, 'outra rota de API com Host externo → 403 (não alcançada)', other);
    const hijack = await request(port, 'POST', '/api/auth/config', { Host: evil, Origin: `http://${evil}` }, { password: 'senha-do-atacante-1' });
    assert(hijack.status === 403, 'POST /api/auth/config com Host externo + Origin coerente (o ataque real) → 403', hijack);
    const after = await request(port, 'GET', '/api/auth/status', { Host: local });
    assert(after.body.auth?.enabled === false && after.body.auth?.hasPassword === false, 'senha NÃO foi alterada — auth continua desligada e sem senha', after.body);
    const foreignOrigin = await request(port, 'POST', '/api/auth/config', { Host: evil, Origin: 'http://outro.example' }, { password: 'x-y-z-12345' });
    assert(foreignOrigin.status === 403, 'Origin externo não contorna o gate', foreignOrigin);
    const noHost = await requestWithoutHost(port, '/api/auth/status');
    assert(noHost === 403, 'Host ausente (HTTP/1.0) → 403, fail-closed', noHost);

    console.log('\n=== S277.4 — auth OFF + Host local: o bootstrap legítimo (UI/CLI) continua funcionando ===');
    const boot = await request(port, 'POST', '/api/auth/config', { Host: local }, { password: 'senha-legitima-123' });
    assert(boot.status === 200 && boot.body.auth?.enabled === true, 'definir a primeira senha por Host local → 200 e auth ligada', boot);

    console.log('\n=== S277.5 — auth ON + Host externo: o gate não interfere, a autenticação normal decide ===');
    const unauth = await request(port, 'GET', '/api/qualquer-coisa', { Host: evil });
    assert(unauth.status === 401, 'sem token → 401 do authMiddleware (não 403 do gate)', unauth);
    const login = await request(port, 'POST', '/api/auth/login', { Host: evil, Origin: `http://${evil}` }, { password: 'senha-legitima-123' });
    assert(login.status === 200 && login.body.success === true, 'login legítimo por Host externo funciona (com senha, proxy reverso é suportado)', login);
    const authed = await request(port, 'GET', '/api/qualquer-coisa', { Host: evil, Authorization: `Bearer ${login.body.token}` });
    assert(authed.status === 200 && authed.body.reached === true, 'com token válido a API é alcançada por Host externo', authed);

    console.log('\n=== S277.6 — o gate é reativado ao desligar a auth em runtime (estado lido a cada requisição) ===');
    const off = await request(port, 'POST', '/api/auth/config', { Host: local, Authorization: `Bearer ${login.body.token}` }, { enabled: false });
    assert(off.status === 200, 'desligar auth por Host local → 200', off);
    const backToBlocked = await request(port, 'GET', '/api/qualquer-coisa', { Host: evil });
    assert(backToBlocked.status === 403, 'Host externo volta a receber 403 imediatamente', backToBlocked);
} finally {
    server.close();
}

console.log('\n=== S277.7 — DashboardServer registra o gate ANTES de qualquer outro middleware ===');
{
    const src = fs.readFileSync(path.resolve(__dirname, '../../dashboard/DashboardServer.ts'), 'utf8');
    const gate = src.indexOf('this.app.use(createHostGate(');
    const firstOther = Math.min(...['this.app.use(cors(', 'this.app.use(express.json()', 'this.app.use(authMiddleware)', "this.app.use('/api"]
        .map(t => src.indexOf(t)).filter(i => i !== -1));
    assert(gate !== -1, 'DashboardServer registra createHostGate');
    assert(gate !== -1 && gate < firstOther, 'o gate vem antes de cors/json/auth/routers — perímetro, não rota', { gate, firstOther });
    assert(/createHostGate\(\(\) => dashboardAuth\.enabled\)/.test(src), 'lê dashboardAuth.enabled a cada requisição (função, não valor copiado)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
