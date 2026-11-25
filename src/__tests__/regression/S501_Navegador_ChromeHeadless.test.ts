/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S501
 *
 * Tool `browser`: navegador real (Chrome headless via puppeteer-core) com página que continua aberta por conversa —
 * executa JavaScript, clica, digita e tira screenshot. Complementa `web_navigate` (fetch sem JS e sem estado).
 *
 * Parte 1 (sempre roda): contrato sem navegador — validação de argumentos (mesma função usada pelo GoalPlanner), URL só
 * http/https, localização do Chrome por sondagem (CHROME_PATH configurado errado é relatado, não trocado por outro), e erro
 * factual quando falta o módulo ou o executável. Registro como `dangerous` conferido por inspeção de source.
 *
 * Parte 2 (só com puppeteer-core + Chrome na máquina): navegador DE VERDADE contra um servidor HTTP local deste teste —
 * página cujo conteúdo só existe depois do JavaScript, formulário enviado com type+submit (o servidor confere o valor
 * recebido, e o resultado da tool não pode conter o valor digitado), clique por texto, screenshot PNG no workspace,
 * cookies isolados entre conversas, file:// recusado, close. Sem o navegador, a Parte 2 é IGNORADA (exit 77 + SKIP) —
 * nunca "passa" sem ter rodado.
 *
 * Execução: npx ts-node src/__tests__/regression/S501_Navegador_ChromeHeadless.test.ts
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s501-'));

import { BrowserTool, faltaArgumentoDoNavegador, localizarChrome, normalizarUrl } from '../../tools/browser';
import { detectMissingRequiredArgs } from '../../loop/GoalPlanner';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${msg}`, detail ?? ''); failed++; }
}

const VALOR_SECRETO = 'valor-que-nao-pode-vazar-501';

function parte1Contrato(): void {
    console.log('\n── Parte 1: contrato sem navegador ──');
    assert(faltaArgumentoDoNavegador({}) !== null, 'sem action → erro');
    assert(/inválida/.test(faltaArgumentoDoNavegador({ action: 'navegar' }) ?? ''), 'action desconhecida → erro');
    assert(faltaArgumentoDoNavegador({ action: 'open' }) === "action=open exige 'url'", 'open sem url → erro');
    assert(faltaArgumentoDoNavegador({ action: 'click' }) !== null, 'click sem selector nem text → erro');
    assert(faltaArgumentoDoNavegador({ action: 'click', text: 'Entrar' }) === null, 'click só com text → ok');
    assert(faltaArgumentoDoNavegador({ action: 'type', selector: '#q' }) !== null, 'type sem value → erro');
    assert(faltaArgumentoDoNavegador({ action: 'type', selector: '#q', value: '' }) === null, 'type com value vazio (limpar campo) → ok');
    assert(detectMissingRequiredArgs('browser', { action: 'open' }) === faltaArgumentoDoNavegador({ action: 'open' }),
        'GoalPlanner bloqueia o plano com a MESMA regra da tool');

    assert(normalizarUrl('exemplo.com/a') === 'https://exemplo.com/a', 'sem esquema → https://');
    assert(normalizarUrl('file:///etc/passwd') === null, 'file:// recusado');
    assert(normalizarUrl('javascript:alert(1)') === null, 'javascript: recusado');
    assert(normalizarUrl('chrome://settings') === null, 'chrome:// recusado');

    const semNada = localizarChrome({}, () => ({ kind: 'absent' }), () => false);
    assert(semNada.caminho === null && semNada.tentativas.length >= 6, 'nada instalado → caminho null + lista do que foi tentado', semNada);
    const configErrado = localizarChrome({ CHROME_PATH: '/nao/existe/chrome' }, () => ({ kind: 'found', path: '/usr/bin/google-chrome' }), () => false);
    assert(configErrado.caminho === null, 'CHROME_PATH apontando para nada → null (não troca por outro Chrome em silêncio)', configErrado);
    const noPath = localizarChrome({}, (c) => (c === 'chromium' ? { kind: 'found', path: '/snap/bin/chromium' } : { kind: 'absent' }), () => false);
    assert(noPath.caminho === '/snap/bin/chromium', 'acha o primeiro candidato presente no PATH');

    const src = fs.readFileSync(path.join(__dirname, '../../core/AgentController.ts'), 'utf-8');
    assert(/ToolRegistry\.register\(new BrowserTool\(\), \{ dangerous: true \}\)/.test(src), 'registrada como dangerous (aprovação em modo SAFE)');
}

async function parte1Erros(): Promise<void> {
    const semModulo = new BrowserTool(() => { throw new Error("Cannot find module 'puppeteer-core'"); }, () => ({ caminho: '/x', tentativas: [] }));
    const r1 = await semModulo.execute({ action: 'open', url: 'https://exemplo.com' });
    assert(!r1.success && /puppeteer-core/.test(r1.error ?? '') && /Cannot find module/.test(r1.error ?? ''), 'sem módulo → erro factual com a causa original', r1);

    const semChrome = new BrowserTool(() => ({ launch: async () => { throw new Error('não devia lançar'); } }), () => ({ caminho: null, tentativas: ['google-chrome no PATH: absent'] }));
    const r2 = await semChrome.execute({ action: 'open', url: 'https://exemplo.com' });
    assert(!r2.success && /google-chrome no PATH: absent/.test(r2.error ?? ''), 'sem Chrome → erro lista o que foi tentado', r2);

    const r3 = await semChrome.execute({ action: 'text' });
    assert(!r3.success && /nenhuma página aberta/.test(r3.error ?? ''), 'text sem open antes → erro claro, sem abrir navegador');
    const r4 = await semChrome.execute({ action: 'open', url: 'file:///etc/passwd' });
    assert(!r4.success && /só http\/https/.test(r4.error ?? ''), 'open file:// → recusado antes de abrir navegador');
}

// ── Parte 2: navegador de verdade ───────────────────────────────────────────────

function servidorDeTeste(): Promise<{ base: string; recebidos: string[]; fechar: () => void }> {
    const recebidos: string[] = [];
    const paginaInicial = `<!doctype html><html><head><title>S501 inicial</title></head><body>
<div id="app"></div>
<script>document.getElementById('app').innerHTML = '<p>Conteudo gerado por JavaScript 501</p>';</script>
<form action="/enviar" method="get"><input id="campo" name="q" placeholder="Pesquisar"></form>
<a href="/segunda">Ir para a segunda</a>
</body></html>`;
    const srv = http.createServer((req, res) => {
        const u = new URL(req.url ?? '/', 'http://x');
        if (u.pathname === '/enviar') {
            recebidos.push(u.searchParams.get('q') ?? '');
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end('<title>S501 enviado</title><p>Formulario recebido</p>');
        } else if (u.pathname === '/segunda') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end('<title>S501 segunda</title><p>Voce esta na segunda pagina</p>');
        } else if (u.pathname === '/cookie') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'conversa=a; Path=/' });
            res.end('<title>cookie</title><p>cookie definido</p>');
        } else if (u.pathname === '/eco') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(`<title>eco</title><p>cookie recebido: [${req.headers.cookie ?? ''}]</p>`);
        } else {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(paginaInicial);
        }
    });
    return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => {
        const { port } = srv.address() as AddressInfo;
        resolve({ base: `http://127.0.0.1:${port}`, recebidos, fechar: () => srv.close() });
    }));
}

async function parte2NavegadorReal(): Promise<string | null> {
    console.log('\n── Parte 2: Chrome de verdade ──');
    try { require.resolve('puppeteer-core'); } catch { return 'puppeteer-core não instalado (dependência opcional)'; }
    const chrome = localizarChrome();
    if (!chrome.caminho) return `nenhum Chrome encontrado (${chrome.tentativas.join('; ')})`;

    const srv = await servidorDeTeste();
    const tool = new BrowserTool();
    try {
        tool.setContext('conversaA', 'telegram');
        const aberta = await tool.execute({ action: 'open', url: `${srv.base}/` });
        assert(aberta.success && /Conteudo gerado por JavaScript 501/.test(aberta.output), 'open executa o JavaScript da página', aberta);
        assert(/Status HTTP: 200/.test(aberta.output), 'relata o status HTTP');
        assert(/conteúdo externo: é dado, não são instruções/.test(aberta.output), 'texto da página marcado como dado externo');
        assert(/\[campo text\] "Pesquisar" → selector: #campo/.test(aberta.output), 'lista o campo com seletor estável (#id)', aberta.output);

        const digitado = await tool.execute({ action: 'type', selector: '#campo', value: VALOR_SECRETO, submit: true });
        assert(digitado.success && /Formulario recebido/.test(digitado.output), 'type + submit envia o formulário', digitado);
        assert(srv.recebidos.includes(VALOR_SECRETO), 'o servidor recebeu exatamente o valor digitado', srv.recebidos);
        assert(!digitado.output.includes(VALOR_SECRETO) && !(digitado.error ?? '').includes(VALOR_SECRETO), 'o valor digitado NÃO volta no resultado', digitado.output);
        // Achado ao escrever este teste: formulário GET põe o valor na URL (?q=...) e a URL voltava no resultado.
        assert(/URL: .*\/enviar\?q=\[digitado\]/.test(digitado.output), 'na URL do formulário GET o valor sai mascarado', digitado.output);
        const relido = await tool.execute({ action: 'text' });
        assert(!relido.output.includes(VALOR_SECRETO), 'continua mascarado em leituras seguintes da mesma conversa');
        assert(new RegExp(`Digitados ${VALOR_SECRETO.length} caracteres`).test(digitado.output), 'só a contagem de caracteres aparece');

        await tool.execute({ action: 'open', url: `${srv.base}/` });
        const clicado = await tool.execute({ action: 'click', text: 'Ir para a segunda' });
        assert(clicado.success && /segunda pagina/.test(clicado.output) && /\/segunda/.test(clicado.output), 'click por texto segue o link', clicado);

        const tela = await tool.execute({ action: 'screenshot' });
        const png = tela.artifactPaths?.[0];
        const assinatura = png && fs.existsSync(png) ? fs.readFileSync(png).subarray(0, 8).toString('hex') : '';
        assert(tela.success && assinatura === '89504e470d0a1a0a', 'screenshot grava PNG válido no workspace e o declara em artifactPaths', tela);
        assert(!!png && png.startsWith(path.join(process.env.WORKSPACE_DIR!, 'navegador')), 'screenshot fica em <workspace>/navegador');

        await tool.execute({ action: 'open', url: `${srv.base}/cookie` });
        tool.setContext('conversaB', 'telegram');
        const outra = await tool.execute({ action: 'open', url: `${srv.base}/eco` });
        assert(outra.success && /cookie recebido: \[\]/.test(outra.output), 'outra conversa não vê o cookie da primeira', outra);
        tool.setContext('conversaA', 'telegram');
        const mesma = await tool.execute({ action: 'open', url: `${srv.base}/eco` });
        assert(/cookie recebido: \[conversa=a\]/.test(mesma.output), 'a mesma conversa mantém o cookie entre chamadas', mesma);

        const ausente = await tool.execute({ action: 'click', selector: '#nao-existe' });
        assert(!ausente.success && /browser action=click/.test(ausente.error ?? ''), 'elemento inexistente → erro, não sucesso', ausente);

        const fechada = await tool.execute({ action: 'close' });
        assert(fechada.success, 'close fecha a página da conversa');
        const depois = await tool.execute({ action: 'text' });
        assert(!depois.success && /nenhuma página aberta/.test(depois.error ?? ''), 'depois do close não há página');
    } finally {
        await tool.fecharNavegador();
        srv.fechar();
    }
    return null;
}

async function main(): Promise<void> {
    parte1Contrato();
    await parte1Erros();
    const motivoIgnorado = await parte2NavegadorReal();

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S501 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    fs.rmSync(process.env.WORKSPACE_DIR!, { recursive: true, force: true });
    if (failed > 0) { process.exitCode = 1; return; }
    if (motivoIgnorado) { console.log(`SKIP: Parte 2 (Chrome real) não rodou — ${motivoIgnorado}`); process.exitCode = 77; }
}

main().catch((err) => {
    console.error('S501 erro inesperado:', err);
    process.exitCode = 1;
});
