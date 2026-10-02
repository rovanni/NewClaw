/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S316 (CORS do suplemento do PowerPoint)
 * A restrição de CORS de 26/08/2026 (`96088de`, S266) aceitava só a mesma origem e quebrou o add-in ("Failed to fetch"): ele roda em
 * `https://localhost:3000` e chama `http://127.0.0.1:3090`. A correção é ESTREITA: só a origem exata do add-in e só nas 2 rotas que ele chama.
 *
 *   1  → `isAddinRequest`: a origem exata + as 2 rotas liberam; todo o resto não (rotas sensíveis, outras origens/portas/esquemas, subdomínio-armadilha).
 *   2  → HTTP REAL (express + cors com a MESMA expressão do DashboardServer): cabeçalhos e preflight para o add-in; controles negativos.
 *   3  → estrutura: DashboardServer usa isAddinRequest; as invariantes do S266 seguem de pé (isTrustedOrigin continua, cors() com opções).
 *
 * Execução: npx ts-node src/__tests__/regression/S316_DashboardCors_PowerPointAddinOrigin.test.ts
 */
import fs from 'fs';
import path from 'path';
import express from 'express';
import cors from 'cors';
import { isAddinRequest, isTrustedOrigin, ADDIN_ORIGIN } from '../../dashboard/security';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

async function main(): Promise<void> {
    console.log('\n[1] isAddinRequest: liberação estreita');
    assert(ADDIN_ORIGIN === 'https://localhost:3000', 'a origem do add-in é a fixada no manifest.xml (https://localhost:3000)');
    const ok = (o: string | undefined, p: string | undefined) => isAddinRequest(o, p);
    assert(ok('https://localhost:3000', '/api/chat') === true, 'add-in + POST /api/chat → libera');
    assert(ok('https://localhost:3000', '/api/integrations/powerpoint/commands') === true, 'add-in + fila de comandos → libera');
    assert(ok('https://localhost:3000', '/api/integrations/powerpoint/commands/abc-123/result') === true, 'add-in + resultado de comando → libera');
    for (const p of ['/api/chat/auth-decision', '/api/chat/active', '/api/config', '/api/memory/nodes', '/api/system/capability-mode', '/api/auth/login',
                     '/api/integrations/install/powerpoint', '/api/integrations/powerpoint', '/api/integrations/powerpoint/commandsX', '/', '/api/chatty']) {
        assert(ok('https://localhost:3000', p) === false, `add-in em rota que ele NÃO usa NÃO libera: ${p}`);
    }
    for (const o of ['https://localhost:3001', 'http://localhost:3000', 'https://127.0.0.1:3000', 'https://localhost:3000.attacker.evil', 'https://attacker.evil',
                     'https://sub.localhost:3000', 'null', 'not a url', '']) {
        assert(ok(o, '/api/chat') === false, `outra origem NÃO libera: ${JSON.stringify(o)}`);
    }
    assert(ok(undefined, '/api/chat') === false && ok('https://localhost:3000', undefined) === false, 'sem Origin ou sem rota → não libera (quem decide a ausência de Origin é o chamador)');
    assert(ok('https://localhost:3000/', '/api/chat') === true, 'a barra final da origem não importa (compara URL.origin)');

    console.log('\n[2] HTTP real: cabeçalhos e preflight (mesma expressão do DashboardServer)');
    const app = express();
    app.use(cors((req, callback) => {
        const origin = req.headers.origin as string | undefined;
        const allowed = !origin || isTrustedOrigin(origin, req.headers.host as string | undefined) || isAddinRequest(origin, req.path);
        callback(null, { origin: allowed });
    }));
    app.use((_req, res) => { res.json({ ok: true }); });
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const acao = async (method: string, urlPath: string, origin: string | undefined, preflight = false): Promise<string | null> => {
        const headers: Record<string, string> = {};
        if (origin) headers.Origin = origin;
        if (preflight) { headers['Access-Control-Request-Method'] = 'POST'; headers['Access-Control-Request-Headers'] = 'content-type,authorization'; }
        const r = await fetch(`${base}${urlPath}`, { method: preflight ? 'OPTIONS' : method, headers });
        return r.headers.get('access-control-allow-origin');
    };
    try {
        assert(await acao('GET', '/api/integrations/powerpoint/commands?sessionId=x', ADDIN_ORIGIN) === ADDIN_ORIGIN, 'polling do add-in recebe Access-Control-Allow-Origin = origem do add-in');
        assert(await acao('POST', '/api/chat', ADDIN_ORIGIN, true) === ADDIN_ORIGIN, 'preflight de POST /api/chat do add-in é liberado');
        assert(await acao('POST', '/api/integrations/powerpoint/commands/id/result', ADDIN_ORIGIN, true) === ADDIN_ORIGIN, 'preflight do POST de resultado do add-in é liberado');
        assert(await acao('POST', '/api/chat/auth-decision', ADDIN_ORIGIN, true) === null, 'CONTROLE: preflight de /api/chat/auth-decision (aprova ação perigosa) NÃO é liberado ao add-in');
        assert(await acao('GET', '/api/config', ADDIN_ORIGIN) === null, 'CONTROLE: /api/config NÃO recebe ACAO para a origem do add-in');
        assert(await acao('POST', '/api/chat', 'https://attacker.evil', true) === null, 'CONTROLE: origem estranha em /api/chat NÃO é liberada');
        assert(await acao('GET', '/api/memory/x', 'https://attacker.evil') === null, 'CONTROLE: origem estranha em outra rota NÃO é liberada');
        const sameOrigin = await acao('GET', '/api/config', base);
        assert(sameOrigin === base, 'a regra original (mesma origem) continua valendo', sameOrigin);
        const noOrigin = await fetch(`${base}/api/config`);
        assert(noOrigin.status === 200 && noOrigin.headers.get('access-control-allow-origin') === null, 'sem Origin: a requisição segue (200) e não ganha cabeçalho CORS (CORS não se aplica)');
    } finally {
        // Encerramento limpo: o `fetch` deixa conexões keep-alive abertas; chamar process.exit() com elas fechando derrubava o processo no
        // Windows (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c`, exit 0xC0000409) — visto na regressão completa.
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    console.log('\n[3] estrutura: as invariantes do S266 seguem de pé');
    const root = path.resolve(__dirname, '..', '..', 'dashboard');
    const serverSrc = fs.readFileSync(path.join(root, 'DashboardServer.ts'), 'utf8');
    const code = serverSrc.replace(/\/\/.*$/gm, '');
    assert(/isAddinRequest\(origin,\s*req\.path\)/.test(code), 'DashboardServer.cors usa isAddinRequest(origin, req.path)');
    assert(/isTrustedOrigin\(origin,\s*req\.headers\.host as string \| undefined\)\s*\|\|\s*isAddinRequest/.test(code), 'a regra de mesma origem (isTrustedOrigin) continua, e o add-in é ACRÉSCIMO');
    assert(serverSrc.includes('isTrustedOrigin') && serverSrc.includes("from './security'"), 'S266: DashboardServer importa isTrustedOrigin de security.ts');
    // Regex mais forte que a do S266 original (`/cors\(\)\s*;?\s*$/m`), que só casa `cors();` sozinho na linha e NÃO casa a forma comum
    // `app.use(cors());` (sobra um `)`): provado por mutação — voltar a `app.use(cors())` passava despercebido.
    assert(!/\bcors\(\s*\)/.test(code), 'S266: cors() nunca é chamado sem opções, em nenhuma forma (nada de Access-Control-Allow-Origin: *)');
    const sec = fs.readFileSync(path.join(root, 'security.ts'), 'utf8');
    assert(!/Access-Control-Allow-Origin['"]?\s*,\s*['"]\*/.test(sec + serverSrc), 'nenhum "*" fixo de CORS foi introduzido');
    const manifest = fs.readFileSync(path.resolve(root, '..', '..', 'addins', 'powerpoint-addin', 'manifest.xml'), 'utf8');
    assert(manifest.includes(`DefaultValue="${ADDIN_ORIGIN}/taskpane.html"`), 'o manifest.xml do add-in fixa exatamente a origem liberada (deriva detectada se mudar)');

    console.log(`\n${passed} passou, ${failed} falhou`);
    process.exitCode = failed === 0 ? 0 : 1;   // sem process.exit(): deixa os handles terminarem de fechar sozinhos
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exitCode = 1; });
