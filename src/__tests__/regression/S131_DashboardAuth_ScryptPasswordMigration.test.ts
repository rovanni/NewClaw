/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S131 (CodeQL alerts #3, #4, js/insufficient-password-hash)
 *
 * `hashPassword()`/`verifyPassword()` em `src/dashboard/routes/auth.ts` usavam
 * `sha256(salt + password)` — rápido demais pra hash de senha (bilhões de tentativas/segundo em
 * GPU), diferente de um KDF lento de propósito (scrypt/bcrypt/argon2). Fix: `crypto.scryptSync`
 * (nativo do Node, sem dependência nova), com formato versionado (`scrypt:salt:hash`) pra migrar
 * hashes já persistidos no formato antigo (`salt:sha256hash`, sem prefixo) sem forçar reset de
 * senha — a migração acontece de forma transparente no primeiro login bem-sucedido.
 *
 * Execução: npx ts-node src/__tests__/regression/S131_DashboardAuth_ScryptPasswordMigration.test.ts
 */

import crypto from 'crypto';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

function legacyHash(password: string): string {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.createHash('sha256').update(salt + password).digest('hex');
    return `${salt}:${hash}`;
}

function resetAuthModule() {
    const resolved = require.resolve('../../dashboard/routes/auth');
    delete require.cache[resolved];
    delete process.env.DASHBOARD_PASSWORD;
    return require('../../dashboard/routes/auth');
}

function fakeReqRes(method: string, path: string, body: Record<string, unknown>) {
    const req: any = { method, path, url: path, originalUrl: path, body, headers: {}, query: {}, cookies: {} };
    const res: any = {
        statusCode: 200,
        body: undefined as unknown,
        status(code: number) { this.statusCode = code; return this; },
        json(payload: unknown) { this.body = payload; return this; },
        cookie() { return this; },
        clearCookie() { return this; },
    };
    return { req, res };
}

async function invokeRoute(router: any, req: any, res: any): Promise<void> {
    await new Promise<void>((resolve) => {
        router(req, res, () => resolve());
        setImmediate(resolve);
    });
}

async function main() {
    console.log('\n=== S131.1 — hashPassword() produz formato novo (prefixo "scrypt:"), não mais sha256 puro ===');
    {
        const { createAuthRouter, dashboardAuth } = resetAuthModule();
        const router = createAuthRouter();
        const { req, res } = fakeReqRes('POST', '/config', { password: 'senha-nova-123' });
        await invokeRoute(router, req, res);
        assert(res.statusCode === 200, 'POST /config com senha nova retorna 200', res.statusCode);
        assert(dashboardAuth.passwordHash.startsWith('scrypt:'), 'hash persistido usa o formato scrypt novo', dashboardAuth.passwordHash);
        assert(dashboardAuth.passwordHash.split(':').length === 3, 'formato scrypt:salt:hash tem 3 partes', dashboardAuth.passwordHash);
    }

    console.log('\n=== S131.2 — login com hash LEGADO (sha256, formato antigo) ainda funciona e migra pro formato novo ===');
    {
        const { createAuthRouter, dashboardAuth } = resetAuthModule();
        const router = createAuthRouter();
        // Simula o estado de um operador que configurou senha antes desta correção existir.
        dashboardAuth.enabled = true;
        dashboardAuth.passwordHash = legacyHash('senha-legada-456');
        const hashBeforeLogin = dashboardAuth.passwordHash;
        assert(!hashBeforeLogin.startsWith('scrypt:'), 'setup: hash legado não tem prefixo scrypt', hashBeforeLogin);

        const { req, res } = fakeReqRes('POST', '/login', { password: 'senha-legada-456' });
        await invokeRoute(router, req, res);
        assert(res.statusCode === 200 && res.body?.success === true, 'login com senha correta contra hash legado funciona', res.body);
        assert(dashboardAuth.passwordHash.startsWith('scrypt:'), 'hash foi migrado pra scrypt após o login bem-sucedido', dashboardAuth.passwordHash);
        assert(dashboardAuth.passwordHash !== hashBeforeLogin, 'hash persistido mudou de valor (não é mais o sha256 antigo)', dashboardAuth.passwordHash);

        console.log('  -- login novamente, agora contra o hash já migrado --');
        const { req: req2, res: res2 } = fakeReqRes('POST', '/login', { password: 'senha-legada-456' });
        await invokeRoute(router, req2, res2);
        assert(res2.statusCode === 200 && res2.body?.success === true, 'segundo login (já com hash scrypt) continua funcionando', res2.body);
    }

    console.log('\n=== S131.3 — senha errada contra hash legado falha e NÃO migra (evita persistir hash de tentativa inválida) ===');
    {
        const { createAuthRouter, dashboardAuth } = resetAuthModule();
        const router = createAuthRouter();
        dashboardAuth.enabled = true;
        dashboardAuth.passwordHash = legacyHash('senha-correta-789');
        const hashBefore = dashboardAuth.passwordHash;

        const { req, res } = fakeReqRes('POST', '/login', { password: 'senha-errada' });
        await invokeRoute(router, req, res);
        assert(res.statusCode === 401, 'senha errada contra hash legado retorna 401', res.statusCode);
        assert(dashboardAuth.passwordHash === hashBefore, 'hash legado permanece intocado após tentativa falha', dashboardAuth.passwordHash);
    }

    console.log(`\n=== RESULTADO: ${passed} passou, ${failed} falhou ===`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
