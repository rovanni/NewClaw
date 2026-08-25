/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S257
 *
 * Campanha FP — FP.6.3, implementação. Complementa o S256 (lógica pura, testável sem SO
 * específico) cobrindo, por verificação de código-fonte, os pontos que dependem de um SO real pra
 * rodar de ponta a ponta (abrir de fato um diálogo nativo bloqueia esperando clique humano — não
 * reproduzível em CI headless, mesma limitação já registrada na campanha) e a fiação entre backend
 * e frontend.
 *
 * A parte Windows foi validada MANUALMENTE, ao vivo, nesta mesma campanha (FP.6.1): PowerShell
 * 5.1 Desktop presente, `Add-Type -AssemblyName System.Windows.Forms` + construção do
 * `FolderBrowserDialog` confirmados, `[Environment]::UserInteractive` confirmado como sinal real
 * (não heurístico), e o problema de encoding sem `[Console]::OutputEncoding = UTF8` REPRODUZIDO
 * (perda de caracteres Unicode) e a correção CONFIRMADA por inspeção de bytes brutos. Este teste
 * verifica que o código implementado usa exatamente os mecanismos validados manualmente — não
 * revalida o SO em si (isso exigiria interação humana, fora do alcance de um teste automatizado).
 *
 * Verifica:
 * 1. Segurança da execução nativa (FP.6/FP.6.1 §4): comando fixo por plataforma, nunca lido do
 *    request; hint repassado via variável de ambiente do processo filho, nunca interpolado numa
 *    string de comando (`spawn` com array, nunca concatenação tipo `exec`).
 * 2. Windows: `[Console]::OutputEncoding = UTF8` presente (obrigatório, confirmado empiricamente),
 *    sondagem via `[Environment]::UserInteractive` ANTES de instanciar o diálogo.
 * 3. macOS: `choose folder` nunca dentro de um bloco `tell application` (mecanismo documentado,
 *    Scripting OS X, pra evitar o prompt de permissão de Automação).
 * 4. Linux: zenity tentado primeiro, kdialog como segunda tentativa, nenhum instalado
 *    automaticamente.
 * 5. Timeout aplicado à tentativa nativa (nunca uma promessa que pode ficar pendurada pra sempre).
 * 6. Rotas backend (`/local/browse`, `/local/native-picker`) atrás do mesmo rate limit
 *    (`modelsFsRateLimit`) e da mesma autenticação global já existente (`authMiddleware`) — nenhuma
 *    rota nova fora dessas proteções.
 * 7. `/local/native-picker` checa política+preferência ANTES de chamar `runNativeDirectoryPicker`
 *    — nunca decide "devo tentar" dentro do próprio adapter.
 * 8. Config: `GET /api/config` expõe `directoryPicker{policyAllowed,preference}`; `POST
 *    /api/config` persiste `directoryPickerPreference` mesmo sem checar a política (preferência
 *    nunca é apagada por política negada — decisão fechada na FP.6.3).
 * 9. ConfigWizard.js: botão "Procurar..." só existe em `renderLocalFolder` (não vaza pra
 *    Ollama/Custom — só faz sentido pra um caminho de filesystem); `openDirectoryPicker()` nunca
 *    expõe ao usuário se o resultado veio de native ou web (só reage a `session.draft.localDir`).
 * 10. i18n: as 6 chaves novas (`ml_cw_browse_*`) existem nos 3 idiomas.
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${msg}`, detail ?? ''); failed++; }
}

const DPS = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'DirectoryPickerService.ts'), 'utf-8');
const MODELS = fs.readFileSync(path.join(process.cwd(), 'src', 'dashboard', 'routes', 'models.ts'), 'utf-8');
const CONFIG = fs.readFileSync(path.join(process.cwd(), 'src', 'dashboard', 'routes', 'config.ts'), 'utf-8');
const CW = fs.readFileSync(path.join(process.cwd(), 'src', 'dashboard', 'public', 'config', 'components', 'ConfigWizard.js'), 'utf-8');
const SHARED = fs.readFileSync(path.join(process.cwd(), 'src', 'dashboard', 'public', 'shared.js'), 'utf-8');

console.log('\n=== S257-1 — comando fixo, hint via env var, spawn com array (nunca exec de string) ===');
{
    assert(!/\bexec\(/.test(DPS), 'DirectoryPickerService nunca usa exec() — só spawn() com array de argumentos');
    assert(/NEWCLAW_PICKER_HINT/.test(DPS), 'hint é repassado via variável de ambiente do processo filho (NEWCLAW_PICKER_HINT)');
    assert(
        !/spawn\([^)]*\$\{/.test(DPS),
        'nenhuma chamada spawn() interpola hint diretamente na string de comando/args',
    );
}

console.log('\n=== S257-2 — Windows: encoding UTF-8 obrigatório + sondagem de sessão interativa ===');
{
    assert(/\[Console\]::OutputEncoding = \[System\.Text\.Encoding\]::UTF8/.test(DPS), 'script Windows define OutputEncoding=UTF8 (confirmado empiricamente como obrigatório, não cosmético)');
    const winScriptIdx = DPS.indexOf('WINDOWS_PICKER_SCRIPT');
    const winScript = DPS.slice(winScriptIdx, DPS.indexOf('function windowsNativePicker'));
    assert(/\[Environment\]::UserInteractive/.test(winScript), 'sonda [Environment]::UserInteractive (API .NET real, não heurística de variável de ambiente isolada)');
    assert(
        winScript.indexOf('UserInteractive') < winScript.indexOf('FolderBrowserDialog'),
        'a sondagem de sessão interativa acontece ANTES de instanciar o diálogo, não depois',
        winScript,
    );
}

console.log('\n=== S257-3 — macOS: choose folder fora de bloco tell application ===');
{
    const macScriptIdx = DPS.indexOf('MACOS_PICKER_SCRIPT');
    const macScript = DPS.slice(macScriptIdx, DPS.indexOf('function macosNativePicker'));
    assert(/choose folder/.test(macScript), 'usa choose folder (StandardAdditions)');
    assert(!/tell application/i.test(macScript), 'nunca envolve choose folder num bloco "tell application" — mecanismo documentado (Scripting OS X) pra evitar o prompt de permissão de Automação');
    assert(/-128/.test(macScript), 'trata o código -128 (cancelamento padrão do AppleScript) como caso próprio, não como erro genérico');
}

console.log('\n=== S257-4 — Linux: zenity primeiro, kdialog como segunda tentativa, nenhum instalado automaticamente ===');
{
    const linuxFnIdx = DPS.indexOf('function linuxNativePicker');
    const linuxFn = DPS.slice(linuxFnIdx, DPS.indexOf('function runNativeDirectoryPicker'));
    assert(/'zenity'/.test(linuxFn) && /'kdialog'/.test(linuxFn), 'tenta zenity e kdialog');
    assert(linuxFn.indexOf("'zenity'") < linuxFn.indexOf("'kdialog'"), 'zenity é tentado antes de kdialog');
    assert(!/apt-get|apt install|yum install|pacman -S|npm install.*zenity/i.test(DPS), 'nenhum mecanismo de instalação automática de zenity/kdialog (decisão fechada na FP.6.1 — nunca sugere instalação)');
}

console.log('\n=== S257-5 — timeout aplicado à tentativa nativa ===');
{
    assert(/NATIVE_PICKER_TIMEOUT_MS/.test(DPS) && /setTimeout/.test(DPS), 'existe um timeout real (setTimeout) usando NATIVE_PICKER_TIMEOUT_MS — nenhuma tentativa nativa fica pendurada indefinidamente');
    assert(/reason: 'timeout'/.test(DPS), 'timeout vira um DirectoryPickerOutcome próprio (unavailable/timeout), nunca uma promise que nunca resolve');
}

console.log('\n=== S257-6 — rotas atrás do mesmo rate limit e autenticação já existentes ===');
{
    assert(
        /router\.get\('\/local\/browse', modelsFsRateLimit/.test(MODELS),
        '/local/browse usa modelsFsRateLimit — mesma proteção já aplicada a /local, /local/preview, /local/serve',
    );
    assert(
        /router\.post\('\/local\/native-picker', modelsFsRateLimit/.test(MODELS),
        '/local/native-picker usa modelsFsRateLimit',
    );
    // authMiddleware é aplicado globalmente em DashboardServer.ts antes de qualquer router — não
    // há como uma rota individual "escapar" dele, então a verificação aqui é negativa: nenhuma das
    // duas rotas novas declara bypass/pula autenticação.
    assert(!/\/local\/browse[\s\S]{0,200}skipAuth|\/local\/native-picker[\s\S]{0,200}skipAuth/.test(MODELS), 'nenhuma das duas rotas novas contorna a autenticação global');
}

console.log('\n=== S257-7 — /local/native-picker checa política+preferência ANTES de chamar o adapter ===');
{
    const routeIdx = MODELS.indexOf("router.post('/local/native-picker'");
    const routeBody = MODELS.slice(routeIdx, MODELS.indexOf('return router;'));
    assert(/shouldAttemptNative\(/.test(routeBody), 'chama shouldAttemptNative() — a decisão "devo tentar" nunca mora dentro do adapter em si');
    assert(
        routeBody.indexOf('shouldAttemptNative') < routeBody.indexOf('runNativeDirectoryPicker'),
        'shouldAttemptNative() é checado ANTES de runNativeDirectoryPicker() ser chamado',
        routeBody,
    );
    assert(/not-permitted/.test(routeBody), "quando a política/preferência nega, devolve outcome 'unavailable' com reason='not-permitted', nunca chama o adapter nativo de verdade");
}

console.log('\n=== S257-8 — config: GET expõe directoryPicker, POST persiste preferência independente da política ===');
{
    assert(/directoryPicker:\s*\{[\s\S]{0,120}policyAllowed:\s*isNativePickerPolicyAllowed\(\)/.test(CONFIG), 'GET /api/config expõe directoryPicker.policyAllowed lido ao vivo da política (nunca guardado em config)');
    assert(/preference:\s*ctx\.config\.directoryPickerPreference/.test(CONFIG), 'GET /api/config expõe a preferência persistida');
    const postIdx = CONFIG.indexOf("router.post('/'");
    const postBody = CONFIG.slice(postIdx);
    assert(
        /if \(directoryPickerPreference === 'native' \|\| directoryPickerPreference === 'web'\)/.test(postBody),
        'POST /api/config aceita e persiste directoryPickerPreference sem checar a política — preferência sobrevive mesmo com política negada (FP.6.3, "nunca apagada automaticamente")',
    );
}

console.log('\n=== S257-9 — ConfigWizard.js: botão só na etapa local, Wizard nunca sabe se foi native ou web ===');
{
    const localFolderFn = CW.slice(CW.indexOf('function renderLocalFolder('), CW.indexOf('async function testLocalFolder('));
    assert(/ml-cw-localBrowse/.test(localFolderFn), 'botão de Procurar existe em renderLocalFolder');
    const ollamaConfigFn = CW.slice(CW.indexOf('function renderOllamaConfig('), CW.indexOf('/** Mantém `session.draft'));
    const customEndpointFn = CW.slice(CW.indexOf('function renderCustomEndpoint('), CW.indexOf('async function testCustomEndpoint('));
    assert(!/ml-cw-localBrowse|openDirectoryPicker/.test(ollamaConfigFn), 'o botão de Procurar não vaza pra renderOllamaConfig (URL, não caminho de filesystem)');
    assert(!/ml-cw-localBrowse|openDirectoryPicker/.test(customEndpointFn), 'o botão de Procurar não vaza pra renderCustomEndpoint (URL, não caminho de filesystem)');

    const openPickerFn = CW.slice(CW.indexOf('async function openDirectoryPicker('), CW.indexOf('async function openWebBrowsePanel('));
    assert(/outcome\.kind === 'unavailable'/.test(openPickerFn), 'trata unavailable como sinal de fallback silencioso, nunca erro exibido');
    assert(!/configError\s*=\s*.*native|configError\s*=\s*.*web picker/i.test(openPickerFn), 'nunca escreve em configError mencionando "native"/"web picker" — o motivo interno não vaza pro usuário');
}

console.log('\n=== S257-10 — i18n: as 6 chaves novas existem nos 3 idiomas ===');
{
    const keys = ['ml_cw_browse_btn', 'ml_cw_browse_hint', 'ml_cw_browse_title', 'ml_cw_browse_empty', 'ml_cw_browse_up', 'ml_cw_browse_use'];
    for (const key of keys) {
        const count = (SHARED.match(new RegExp(`\\b${key}:`, 'g')) || []).length;
        assert(count === 3, `${key}: aparece exatamente 3 vezes em shared.js (pt-BR + en-US + es-ES)`, count);
    }
}

console.log('\n=== S257-11 — achado ao vivo no QA (UX-01, 2026-08-24): rodapé do Wizard some enquanto o painel web está aberto ===');
{
    // Antes da correção, o rodapé do Wizard (Cancelar/Voltar/Próximo) continuava visível ao lado
    // do rodapé do próprio painel (Cancelar/Subir/Usar esta pasta) — dois botões chamados
    // "Cancelar" ao mesmo tempo, um fechando só o painel, o outro reiniciando o Wizard inteiro.
    const renderFn = CW.slice(CW.indexOf('function render() {'), CW.indexOf('function renderProgress('));
    assert(/\$\{browseState \? '' : `/.test(renderFn), 'o bloco do rodapé do Wizard (ml-cw-cancel/back/next) é condicionado a browseState — omitido, não só desabilitado, enquanto o painel está aberto', renderFn);
    // Confirma que o botão do rodapé do Wizard e o botão do painel continuam sendo IDs distintos
    // (a correção precisa ser "não renderizar os dois ao mesmo tempo", nunca "fundir os dois
    // controles em um só" — que mudaria o comportamento, não só a ambiguidade visual).
    assert(/id="ml-cw-cancel"/.test(CW) && /id="ml-cw-browseCancel"/.test(CW), 'os dois botões continuam existindo como controles distintos — a correção é sobre QUANDO cada um aparece, não sobre remover um dos dois');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S257 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exit(1);
