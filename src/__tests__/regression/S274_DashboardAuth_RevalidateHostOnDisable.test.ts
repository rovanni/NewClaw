/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S274 (T09, Campanha de Segurança, alerta CodeQL #104)
 *
 * `isUnsafeExposedBoot()` (host não-loopback + auth desabilitada) só rodava uma vez, no boot
 * (`DashboardServer.start()`). Uma instância já bootada com `DASHBOARD_HOST` não-loopback e auth
 * ligada (boot-guard satisfeito) podia ter a autenticação desligada em runtime via
 * `POST /api/auth/config {enabled:false}` sem nenhuma revalidação — deixando toda a API exposta
 * sem senha até o próximo restart. Esse era o único caminho realista para um atacante não-
 * autenticado alcançar o sink SSRF do alerta #104 (ver `S233`).
 *
 * Correção: `routes/auth.ts` reusa `isUnsafeExposedBoot()` (extraída para
 * `src/dashboard/hostSafety.ts` — mesma autoridade do boot, não uma heurística nova) no momento
 * exato de `enabled:false`, ANTES de qualquer mutação de estado.
 *
 * Mesmo padrão de teste de `S129` (sem framework de rota no projeto — router Express invocado
 * diretamente via `fakeReqRes`/`invokeRoute`).
 *
 * Execução: npx ts-node src/__tests__/regression/S274_DashboardAuth_RevalidateHostOnDisable.test.ts
 */

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function main() {

console.log('\n=== S274.1 — DASHBOARD_HOST=0.0.0.0 (exposto): desativar auth é RECUSADO ===');
{
    jestLikeResetModule();
    process.env.DASHBOARD_HOST = '0.0.0.0';
    const { createAuthRouter, dashboardAuth } = require('../../dashboard/routes/auth');
    const router = createAuthRouter();

    // Estabelece auth ligada com senha real (caminho legítimo) antes de tentar desligar.
    const setPw = fakeReqRes('POST', '/config', { password: 'senha-forte-123' });
    await invokeRoute(router, setPw.req, setPw.res);
    assert(dashboardAuth.enabled === true, 'pré-condição: auth ligada antes do teste', dashboardAuth.enabled);

    const disable = fakeReqRes('POST', '/config', { enabled: false });
    await invokeRoute(router, disable.req, disable.res);
    assert(disable.res.statusCode === 400, 'responde 400 ao tentar desativar com host exposto', disable.res.statusCode);
    assert(dashboardAuth.enabled === true, 'dashboardAuth.enabled permanece true — a desativação não aconteceu', dashboardAuth.enabled);
    assert(!!dashboardAuth.passwordHash, 'passwordHash NÃO foi apagado — a checagem roda antes de qualquer mutação', dashboardAuth.passwordHash.length);
    assert(String(disable.res.body?.error || '').includes('0.0.0.0'), 'mensagem de erro cita o host exposto', disable.res.body);
    delete process.env.DASHBOARD_HOST;
}

console.log('\n=== S274.2 — DASHBOARD_HOST ausente (default 127.0.0.1): desativar auth continua funcionando (sem regressão) ===');
{
    jestLikeResetModule();
    delete process.env.DASHBOARD_HOST;
    const { createAuthRouter, dashboardAuth } = require('../../dashboard/routes/auth');
    const router = createAuthRouter();

    const setPw = fakeReqRes('POST', '/config', { password: 'senha-forte-123' });
    await invokeRoute(router, setPw.req, setPw.res);

    const disable = fakeReqRes('POST', '/config', { enabled: false });
    await invokeRoute(router, disable.req, disable.res);
    assert(disable.res.statusCode === 200, 'responde 200 — host padrão (loopback) nunca é bloqueado', disable.res.statusCode);
    assert(dashboardAuth.enabled === false, 'dashboardAuth.enabled foi desativado normalmente', dashboardAuth.enabled);
}

console.log('\n=== S274.3 — DASHBOARD_HOST=localhost (variante loopback): desativar auth continua funcionando ===');
{
    jestLikeResetModule();
    process.env.DASHBOARD_HOST = 'localhost';
    const { createAuthRouter, dashboardAuth } = require('../../dashboard/routes/auth');
    const router = createAuthRouter();

    const setPw = fakeReqRes('POST', '/config', { password: 'senha-forte-123' });
    await invokeRoute(router, setPw.req, setPw.res);

    const disable = fakeReqRes('POST', '/config', { enabled: false });
    await invokeRoute(router, disable.req, disable.res);
    assert(disable.res.statusCode === 200, 'responde 200 — "localhost" é reconhecido como loopback, mesma autoridade do boot', disable.res.statusCode);
    assert(dashboardAuth.enabled === false, 'dashboardAuth.enabled foi desativado normalmente', dashboardAuth.enabled);
    delete process.env.DASHBOARD_HOST;
}

console.log('\n=== S274.4 — DASHBOARD_HOST=0.0.0.0: ATIVAR auth (enabled:true) não é afetado pela nova checagem ===');
{
    jestLikeResetModule();
    process.env.DASHBOARD_HOST = '0.0.0.0';
    const { createAuthRouter, dashboardAuth } = require('../../dashboard/routes/auth');
    const router = createAuthRouter();

    const setPw = fakeReqRes('POST', '/config', { password: 'senha-forte-123' });
    await invokeRoute(router, setPw.req, setPw.res);
    assert(setPw.res.statusCode === 200, 'ativar auth (com senha) continua funcionando com host exposto — é a combinação SEGURA', setPw.res.statusCode);
    assert(dashboardAuth.enabled === true, 'auth fica ligada', dashboardAuth.enabled);
    delete process.env.DASHBOARD_HOST;
}

console.log('\n=== S274.5 — mesma autoridade do boot: isUnsafeExposedBoot() importado de hostSafety.ts, não duplicado ===');
{
    const fs = require('fs');
    const path = require('path');
    const authSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'dashboard', 'routes', 'auth.ts'), 'utf-8');
    const dashboardSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'dashboard', 'DashboardServer.ts'), 'utf-8');
    const hostSafetySrc = fs.readFileSync(path.join(process.cwd(), 'src', 'dashboard', 'hostSafety.ts'), 'utf-8');
    assert(/import \{ isUnsafeExposedBoot \} from '\.\.\/hostSafety';/.test(authSrc),
        'auth.ts importa isUnsafeExposedBoot de hostSafety.ts');
    assert(/import \{ isUnsafeExposedBoot \} from '\.\/hostSafety';/.test(dashboardSrc),
        'DashboardServer.ts importa isUnsafeExposedBoot de hostSafety.ts (não define mais localmente)');
    assert(/export function isUnsafeExposedBoot/.test(hostSafetySrc), 'hostSafety.ts é a autoridade única');
    assert(!/function isUnsafeExposedBoot/.test(dashboardSrc.replace(/import.*isUnsafeExposedBoot.*\n/, '').replace(/export \{ isUnsafeExposedBoot \};?\n?/, '')),
        'DashboardServer.ts não redefine isUnsafeExposedBoot — só reexporta pra não quebrar S267');
}

console.log(`\n=== RESULTADO: ${passed} passou, ${failed} falhou ===`);
if (failed > 0) process.exit(1);

}

// ── Helpers mínimos (mesmo padrão de S129 — sem framework de teste pra rotas Express) ──

function jestLikeResetModule(): void {
    const resolved = require.resolve('../../dashboard/routes/auth');
    delete require.cache[resolved];
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

main().catch(err => { console.error(err); process.exit(1); });
