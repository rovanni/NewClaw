/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S129 (GHSA-jpx8-29mp-v4hw)
 *
 * Advisory reportou: quando a senha do dashboard é configurada via UI (sem DASHBOARD_PASSWORD
 * definido no ambiente), getTokenSecret() usava `process.env.DASHBOARD_PASSWORD || ''` — uma
 * chave HMAC vazia. Qualquer cliente conseguia calcular localmente HMAC-SHA256('', raw) e forjar
 * um token de sessão válido, contornando o login inteiro.
 *
 * Esse caso específico (senha configurada via UI) já estava corrigido antes deste teste
 * (getTokenSecret/getEffectiveSecret cai para dashboardAuth.passwordHash, não '' — commit
 * 7d30363). Mapeando o entorno (auth.ts, DashboardServer.ts, integrations.ts) encontrei uma
 * variante residual da mesma classe de bug: `POST /api/auth/config` aceitava `{enabled: true}`
 * sem nunca ter existido uma senha (passwordHash ainda vazio), deixando getEffectiveSecret() cair
 * num fallback previsível (`'newclaw-no-auth'`, string pública no código-fonte) — reintroduzindo
 * o mesmo ataque de HMAC forjável, e usado em dois lugares (auth.ts e integrations.ts).
 *
 * Este teste cobre os 3 pontos pedidos pela advisory:
 *  1. Nunca usar chave vazia/previsível pra assinar token — mesmo no caso residual acima.
 *  2. Rejeitar explicitamente enabled=true sem senha (raiz do problema, não só o sintoma).
 *  3. Regressão do fluxo legítimo: senha via UI sem DASHBOARD_PASSWORD no ambiente continua
 *     funcionando com uma chave real (não previsível).
 *
 * Execução: npx ts-node src/__tests__/regression/S129_DashboardAuth_GHSA_jpx8_29mp_v4hw.test.ts
 */

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function main() {
    delete process.env.DASHBOARD_PASSWORD;

    console.log('\n=== S129.1 — POST /api/auth/config recusa enabled=true sem senha nunca configurada ===');
    {
        // Reset de módulo: cada cenário precisa de um dashboardAuth em estado limpo.
        jestLikeResetModule();
        const { createAuthRouter, dashboardAuth } = require('../../dashboard/routes/auth');
        const router = createAuthRouter();
        const { req, res } = fakeReqRes('POST', '/config', { enabled: true });
        await invokeRoute(router, req, res);
        assert(res.statusCode === 400, 'responde 400 ao tentar ativar sem senha', res.statusCode);
        assert(dashboardAuth.enabled === false, 'dashboardAuth.enabled permanece false', dashboardAuth.enabled);
        assert(dashboardAuth.passwordHash === '', 'passwordHash permanece vazio', dashboardAuth.passwordHash);
    }

    console.log('\n=== S129.2 — mesmo se o estado enabled=true/passwordHash="" for forçado, o secret efetivo nunca é a string pública "newclaw-no-auth" ===');
    {
        jestLikeResetModule();
        const authMod = require('../../dashboard/routes/auth');
        // Simula o estado que a advisory descreve (chave previsível) — antes do fix de rota,
        // esse era o único jeito de chegar aqui; agora só é alcançável via mutação direta,
        // o que prova que o secret nunca degrada para uma constante pública mesmo assim.
        authMod.dashboardAuth.enabled = true;
        authMod.dashboardAuth.passwordHash = '';
        const secret = authMod.getEffectiveSecret();
        assert(secret !== '', 'secret efetivo nunca é string vazia', secret);
        assert(secret !== 'newclaw-no-auth', 'secret efetivo nunca é a constante pública antiga', secret);
        assert(secret.length >= 32, 'secret efetivo é um valor aleatório de tamanho substancial', secret.length);
    }

    console.log('\n=== S129.3 — fluxo legítimo: senha via UI sem DASHBOARD_PASSWORD no ambiente usa chave real e sobrevive a "restart" ===');
    {
        jestLikeResetModule();
        const { createAuthRouter, dashboardAuth, getEffectiveSecret } = require('../../dashboard/routes/auth');
        const router = createAuthRouter();

        const setPw = fakeReqRes('POST', '/config', { password: 'senha-forte-123' });
        await invokeRoute(router, setPw.req, setPw.res);
        assert(setPw.res.statusCode === 200, 'define senha via UI com sucesso', setPw.res.statusCode);
        assert(dashboardAuth.enabled === true, 'auth fica habilitado após definir senha', dashboardAuth.enabled);

        const secret = getEffectiveSecret();
        assert(secret === dashboardAuth.passwordHash, 'secret efetivo deriva do hash persistido (não do env, que está ausente)', secret);
        assert(!!secret && secret !== 'newclaw-no-auth', 'secret real não é a constante pública', secret);

        const login = fakeReqRes('POST', '/login', { password: 'senha-forte-123' });
        await invokeRoute(router, login.req, login.res);
        assert(login.res.statusCode === 200 && login.res.body?.success === true, 'login com a senha correta funciona', login.res.body);
    }

    console.log('\n=== S129.4 — attacker não consegue forjar token calculando HMAC("", raw) nem HMAC("newclaw-no-auth", raw) ===');
    {
        jestLikeResetModule();
        const crypto = require('crypto');
        const { createAuthRouter, dashboardAuth, authMiddleware } = require('../../dashboard/routes/auth');
        createAuthRouter();
        // Habilita auth pelo caminho legítimo (senha real) pra popular passwordHash.
        dashboardAuth.enabled = true;
        dashboardAuth.passwordHash = 'salt-fake:' + crypto.createHash('sha256').update('salt-fakesenha').digest('hex');

        for (const guessedSecret of ['', 'newclaw-no-auth']) {
            const raw = crypto.randomBytes(32).toString('hex');
            const forgedSig = crypto.createHmac('sha256', guessedSecret).update(raw).digest('hex');
            const forgedToken = `${raw}.${forgedSig}`;

            const req: any = { headers: { authorization: `Bearer ${forgedToken}` }, query: {}, cookies: {}, path: '/api/skills' };
            let blocked = false;
            const res: any = {
                status(code: number) { blocked = code === 401; return res; },
                json() { return res; },
            };
            authMiddleware(req, res, () => { /* next() chamado = bypass */ });
            assert(blocked, `token forjado com secret adivinhado "${guessedSecret}" é rejeitado (401)`, guessedSecret);
        }
    }

    console.log(`\n=== RESULTADO: ${passed} passou, ${failed} falhou ===`);
    if (failed > 0) process.exit(1);
}

// ── Helpers mínimos (sem framework de teste no projeto para rotas Express) ──

function jestLikeResetModule(): void {
    // Limpa o cache do require pros módulos de auth/integrations relevantes, já que ambos
    // guardam estado de módulo (dashboardAuth, processRandomSecret) que precisa reiniciar
    // por cenário para o teste ser determinístico e isolado.
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
    // express.Router é um middleware chamável: router(req, res, next)
    await new Promise<void>((resolve) => {
        router(req, res, () => resolve());
        // Rotas síncronas neste arquivo chamam res.json()/res.status() antes de retornar;
        // resolve no próximo tick garante que a call stack síncrona já terminou.
        setImmediate(resolve);
    });
}

main().catch(err => { console.error(err); process.exit(1); });
