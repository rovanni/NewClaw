/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S177
 * Desativar a autenticação pelo painel sobrevive ao restart, mesmo com DASHBOARD_PASSWORD
 * definida no ambiente.
 *
 * CONTEXTO (relato reproduzido em 02/08/2026, instância real): o operador desativava a senha do
 * dashboard pelo painel, clicava em salvar, reiniciava — e a senha voltava. Repetidas vezes,
 * sempre com o mesmo resultado. O log de boot mostrava `(auth ON)` em TODOS os starts do dia.
 *
 * CAUSA — duas fontes de verdade sem precedência declarada:
 *   1. `POST /api/auth/config {enabled:false}` zerava `dashboardAuth` e o hash persistido. Isso
 *      funcionava: em runtime, `/api/status` passava a responder 200 sem token.
 *   2. Mas o bloco de boot `if (process.env.DASHBOARD_PASSWORD) { enabled = true; ... }` rodava
 *      de novo no start seguinte e reativava tudo.
 *   3. E o "Salvar" da tela de config nunca escreveu `DASHBOARD_PASSWORD` no .env — 37 chaves
 *      eram persistidas ali, essa não estava entre elas.
 * O botão, portanto, era um no-op silencioso a partir do primeiro restart. A UI ainda afirmava
 * que a variável de ambiente "tem prioridade", sem dizer que isso tornava o botão inútil.
 *
 * CORREÇÃO: a desativação explícita do operador vira estado persistido (`dashboard_auth_disabled`)
 * e vence o ambiente no boot. Nenhum arquivo é reescrito — a variável pode vir de `docker -e` ou
 * de uma unit do systemd, onde apagar o .env não teria efeito algum.
 *
 * REGRESSÃO SE: a desativação voltar a ser esquecida no restart; ou — o lado oposto, mais grave —
 * se uma instalação que apenas define DASHBOARD_PASSWORD (container/systemd, sem ninguém tocar no
 * painel) deixar de subir com autenticação ativa.
 *
 * Execução: npx ts-node src/__tests__/regression/S177_DashboardAuth_OperatorDisableSurvivesRestart.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

/** Banco em memória com a superfície mínima que auth.ts usa (prepare/get/run). */
function fakeDb() {
    const store = new Map<string, string>();
    return {
        store,
        prepare(sql: string) {
            return {
                get: (...p: unknown[]) => {
                    if (/dashboard_auth_disabled/.test(sql) || p[0] === 'dashboard_auth_disabled') {
                        const v = store.get('dashboard_auth_disabled');
                        return v === undefined ? undefined : { value: v };
                    }
                    if (/dashboard_password_hash/.test(sql)) {
                        const v = store.get('dashboard_password_hash');
                        return v === undefined ? undefined : { value: v };
                    }
                    return undefined;
                },
                run: (...p: unknown[]) => {
                    if (/DELETE/i.test(sql)) {
                        store.delete(String(p[0] ?? 'dashboard_password_hash'));
                        return;
                    }
                    if (/dashboard_auth_disabled/.test(sql) || p[0] === 'dashboard_auth_disabled') {
                        store.set('dashboard_auth_disabled', '1');
                        return;
                    }
                    store.set('dashboard_password_hash', String(p[0]));
                },
            };
        },
    };
}

/** Simula um restart do processo: limpa o cache do módulo, que guarda estado de módulo. */
function reiniciarProcesso() {
    delete require.cache[require.resolve('../../dashboard/routes/auth')];
    return require('../../dashboard/routes/auth');
}

function fakeReqRes(method: string, routePath: string, body: Record<string, unknown>) {
    const req: any = { method, path: routePath, url: routePath, originalUrl: routePath, body, headers: {}, query: {}, cookies: {} };
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
        router.handle(req, res, () => resolve());
        setTimeout(resolve, 40);
    });
}

async function main(): Promise<void> {

console.log('\n=== S177-1 — reproduz o relato: desativar pelo painel + restart com a variável no ambiente ===');
{
    process.env.DASHBOARD_PASSWORD = 'senha-de-deploy-123';
    const db = fakeDb();

    // Boot 1 — a variável ativa a autenticação, como sempre fez.
    let mod = reiniciarProcesso();
    mod.initAuthPersistence(db);
    assert(mod.dashboardAuth.enabled === true, 'boot 1: variável de ambiente ativa a autenticação');
    assert(mod.getAuthSource() === 'environment', 'boot 1: origem reportada como "environment"', mod.getAuthSource());

    // O operador desativa pelo painel.
    const router = mod.createAuthRouter();
    const { req, res } = fakeReqRes('POST', '/config', { enabled: false });
    await invokeRoute(router, req, res);
    assert(mod.dashboardAuth.enabled === false, 'desativação tem efeito imediato em runtime');
    assert(db.store.get('dashboard_auth_disabled') === '1', 'a decisão do operador foi persistida');

    // Boot 2 — o restart que antes trazia a senha de volta.
    mod = reiniciarProcesso();
    mod.initAuthPersistence(db);
    assert(
        mod.dashboardAuth.enabled === false,
        'boot 2: a autenticação CONTINUA desativada — era exatamente aqui que ela voltava',
        mod.dashboardAuth.enabled,
    );
    assert(mod.getAuthSource() === 'operator_disabled', 'boot 2: origem reportada como "operator_disabled"', mod.getAuthSource());
    assert(mod.isEnvManaged() === true, 'boot 2: a variável continua visível — está sendo ignorada, não apagada');

    // Boot 3 — não é um efeito de uma vez só.
    mod = reiniciarProcesso();
    mod.initAuthPersistence(db);
    assert(mod.dashboardAuth.enabled === false, 'boot 3: continua desativada em restarts sucessivos');
}

console.log('\n=== S177-2 — instalação container/systemd (só a variável, painel intocado) NÃO regride ===');
{
    process.env.DASHBOARD_PASSWORD = 'senha-de-deploy-123';
    const db = fakeDb(); // banco limpo: ninguém nunca clicou em nada

    const mod = reiniciarProcesso();
    mod.initAuthPersistence(db);
    assert(mod.dashboardAuth.enabled === true, 'sobe COM autenticação — comportamento de deploy preservado');
    assert(!!mod.dashboardAuth.passwordHash, 'hash derivado da variável de ambiente presente');
    assert(mod.getAuthSource() === 'environment', 'origem "environment"', mod.getAuthSource());
}

console.log('\n=== S177-3 — reativar limpa a desativação (não fica preso desligado) ===');
{
    process.env.DASHBOARD_PASSWORD = 'senha-de-deploy-123';
    const db = fakeDb();
    db.store.set('dashboard_auth_disabled', '1');

    let mod = reiniciarProcesso();
    mod.initAuthPersistence(db);
    assert(mod.dashboardAuth.enabled === false, 'parte do estado desativado');

    // Definir uma senha pelo painel é reativar.
    const router = mod.createAuthRouter();
    const { req, res } = fakeReqRes('POST', '/config', { password: 'nova-senha-forte' });
    await invokeRoute(router, req, res);
    assert(mod.dashboardAuth.enabled === true, 'definir senha reativa a autenticação');
    assert(db.store.get('dashboard_auth_disabled') === undefined, 'a marca de desativação foi removida');

    mod = reiniciarProcesso();
    mod.initAuthPersistence(db);
    assert(mod.dashboardAuth.enabled === true, 'e continua ativa após reiniciar — sem ficar preso desligado');
}

console.log('\n=== S177-4 — falha FECHADA: banco ilegível nunca desliga a autenticação ===');
{
    process.env.DASHBOARD_PASSWORD = 'senha-de-deploy-123';
    const dbQuebrado = { prepare() { throw new Error('tabela inexistente'); } };

    const mod = reiniciarProcesso();
    mod.initAuthPersistence(dbQuebrado);
    assert(
        mod.dashboardAuth.enabled === true,
        'sem conseguir ler o estado persistido, a autenticação permanece ATIVA',
        mod.dashboardAuth.enabled,
    );
}

console.log('\n=== S177-5 — /status reporta a origem em vez de deixar a UI adivinhar ===');
{
    process.env.DASHBOARD_PASSWORD = 'senha-de-deploy-123';
    const db = fakeDb();
    const mod = reiniciarProcesso();
    mod.initAuthPersistence(db);

    const router = mod.createAuthRouter();
    const { req, res } = fakeReqRes('GET', '/status', {});
    await invokeRoute(router, req, res);
    const auth = (res.body as any)?.auth;
    assert(auth?.source === 'environment', '/status expõe o campo source', auth?.source);
    assert(auth?.envManaged === true, '/status expõe envManaged', auth?.envManaged);
}

console.log('\n=== S177-6 — a UI não afirma mais que o ambiente "tem prioridade", e fala 3 idiomas ===');
{
    const view = fs.readFileSync(
        path.join(process.cwd(), 'src', 'dashboard', 'public', 'config', 'views', 'SegurancaView.js'), 'utf-8'
    );
    assert(
        !/ela tem prioridade/.test(view),
        'texto antigo removido — ele descrevia uma precedência que tornava o botão inútil sem dizer isso',
    );
    assert(
        /t\('auth_operator_disabled_note'\)/.test(view) && /t\('auth_env_managed_note'\)/.test(view),
        'a nota de origem passa por t() — nada de string fixa em pt-BR numa tela servida em 3 idiomas',
    );

    const shared = fs.readFileSync(
        path.join(process.cwd(), 'src', 'dashboard', 'public', 'shared.js'), 'utf-8'
    );
    for (const chave of ['auth_env_managed_note', 'auth_operator_disabled_note', 'dashboard_password_hint']) {
        const ocorrencias = (shared.match(new RegExp(`${chave}:`, 'g')) ?? []).length;
        assert(ocorrencias === 3, `'${chave}' presente nos 3 idiomas (encontradas: ${ocorrencias})`);
    }
}

delete process.env.DASHBOARD_PASSWORD;

console.log(`\n${'─'.repeat(60)}`);
console.log(`S177 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
console.log(`\nCOBERTURA:`);
console.log(`  Desativação sobrevive a restarts sucessivos: testado`);
console.log(`  Deploy só com variável de ambiente preservado: testado`);
console.log(`  Reativação limpa o estado: testado`);
console.log(`  Falha fechada com banco ilegível: testado`);
console.log(`  Origem reportada no /status e na UI, em 3 idiomas: testado`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S177 erro inesperado:', err);
    process.exitCode = 1;
});
