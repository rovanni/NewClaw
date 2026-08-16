/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S235
 * O indicador "trabalhando agora" do dashboard mostra um rótulo amigável e traduzido por
 * ferramenta ("Pesquisando na internet...") em vez do nome técnico cru ("web_search").
 *
 * PEDIDO DO USUÁRIO (15/08/2026): "ao inves de mostras web_search mostrar pesquisando na
 * internet" — mesma classe de achado da campanha anterior (status_goal_executing, etc.): chave
 * bruta/nome técnico de mecanismo interno vazando para usuário leigo.
 *
 * DESIGN: `status_tool_<nome-da-tool>` é uma chave de tradução dedicada por ferramenta, nas 3
 * línguas (pt-BR/en-US/es-ES) — mesmo mecanismo de i18n já existente (`TRANSLATIONS`/`t()`),
 * nenhum sistema novo. Para uma ferramenta SEM chave dedicada (não mapeada ainda), o fallback é
 * `status_executing_tool` com o nome técnico cru — nunca inventa um rótulo, só não traduz o que
 * ainda não foi mapeado (consistente com NUNCA_ADIVINHAR).
 *
 * Execução: npx ts-node src/__tests__/regression/S235_ToolStatus_FriendlyLocalizedLabels.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const SHARED_JS_PATH = path.join(process.cwd(), 'src', 'dashboard', 'public', 'shared.js');
const INDEX_HTML_PATH = path.join(process.cwd(), 'src', 'dashboard', 'public', 'index.html');
const source = fs.readFileSync(SHARED_JS_PATH, 'utf-8');
const indexHtml = fs.readFileSync(INDEX_HTML_PATH, 'utf-8');

/** Mesmo sandbox de S199_ChatUpload_LimitAndReadableError.test.ts — roda shared.js de verdade e
 *  extrai TRANSLATIONS real, sem reimplementar o mock. */
function loadTranslations(): Record<string, Record<string, string>> {
    const sandbox: Record<string, unknown> = {
        localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        document: { addEventListener: () => {}, documentElement: {}, querySelectorAll: () => [], getElementById: () => null },
        window: {},
        console: { log: () => {}, warn: () => {}, error: () => {} },
        fetch: () => Promise.reject(new Error('no network in test')),
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    return vm.runInContext(source + '\n;TRANSLATIONS;', sandbox, { timeout: 5000 });
}

const TRANSLATIONS = loadTranslations();
const LANGS = ['pt-BR', 'en-US', 'es-ES'];

// Lista de tools registradas (src/tools/*.ts, `name = '...'`) no momento desta sprint —
// verificada por asserção estrutural em S235-3, não hardcoded sem checagem.
const REGISTERED_TOOLS = [
    'web_search', 'web_navigate', 'weather', 'crypto_analysis', 'crypto_report',
    'memory_search', 'memory_write', 'memory_admin', 'manage_memory',
    'write', 'edit', 'read', 'read_document',
    'list_workspace', 'refresh_workspace', 'organize_workspace', 'analyze_workspace_groups',
    'exec_command', 'ssh_exec', 'api_request', 'cmi_inspect',
    'send_document', 'send_audio', 'powerpoint_control', 'schedule',
];

console.log('\n=== S235-1 — cada tool registrada tem status_tool_<nome> nos 3 idiomas ===');
{
    for (const tool of REGISTERED_TOOLS) {
        const key = `status_tool_${tool}`;
        for (const lang of LANGS) {
            assert(
                typeof TRANSLATIONS[lang]?.[key] === 'string' && TRANSLATIONS[lang][key].length > 0,
                `${key} existe em ${lang}`,
            );
        }
    }
}

console.log('\n=== S235-2 — reprodução do pedido exato: web_search vira "pesquisando na internet" ===');
{
    assert(/Pesquisando na internet/.test(TRANSLATIONS['pt-BR']['status_tool_web_search']),
        'pt-BR: web_search → "Pesquisando na internet..."', TRANSLATIONS['pt-BR']['status_tool_web_search']);
    assert(/[Ss]earching the internet/.test(TRANSLATIONS['en-US']['status_tool_web_search']),
        'en-US: web_search → "Searching the internet..."', TRANSLATIONS['en-US']['status_tool_web_search']);
    assert(/[Bb]uscando en internet/.test(TRANSLATIONS['es-ES']['status_tool_web_search']),
        'es-ES: web_search → "Buscando en internet..."', TRANSLATIONS['es-ES']['status_tool_web_search']);
    // Nenhuma das 3 traduções deve conter o nome técnico cru "web_search"
    for (const lang of LANGS) {
        assert(!/web_search/.test(TRANSLATIONS[lang]['status_tool_web_search']),
            `${lang}: o rótulo amigável não contém o nome técnico cru "web_search"`);
    }
}

console.log('\n=== S235-3 — REGISTERED_TOOLS reflete o registro real de tools (sem lista desatualizada) ===');
{
    const toolsDir = path.join(process.cwd(), 'src', 'tools');
    const registeredInSource = new Set<string>();
    for (const file of fs.readdirSync(toolsDir)) {
        if (!file.endsWith('.ts')) continue;
        const content = fs.readFileSync(path.join(toolsDir, file), 'utf-8');
        const m = content.match(/^\s+name = '([a-z_]+)';/m);
        if (m) registeredInSource.add(m[1]);
    }
    const missingFromList = [...registeredInSource].filter(t => !REGISTERED_TOOLS.includes(t));
    const missingFromSource = REGISTERED_TOOLS.filter(t => !registeredInSource.has(t));
    assert(missingFromList.length === 0,
        'toda tool com `name = \'...\'` em src/tools/*.ts está em REGISTERED_TOOLS (senão, sem tradução)',
        missingFromList);
    assert(missingFromSource.length === 0,
        'REGISTERED_TOOLS não lista tool que não existe mais em src/tools/*.ts',
        missingFromSource);
}

console.log('\n=== S235-4 — index.html consulta a chave por tool, com fallback honesto (não inventa rótulo) ===');
{
    assert(/const toolKey = 'status_tool_' \+ se\.tool;/.test(indexHtml),
        'a chave é construída dinamicamente a partir do nome real da tool');
    assert(/const friendly = t\(toolKey\);/.test(indexHtml),
        'busca a tradução amigável antes de decidir o texto');
    assert(
        /friendly !== toolKey \? friendly : t\('status_executing_tool', \{ tool: se\.tool \}\)/.test(indexHtml),
        'fallback para o nome técnico cru quando não há tradução dedicada — nunca inventa um rótulo',
    );
}

console.log('\n=== S235-5 — fallback funcional: tool sem chave dedicada usa o nome técnico, não quebra ===');
{
    function t(lang: string, key: string, data: Record<string, string> = {}): string {
        let text = TRANSLATIONS[lang]?.[key] ?? TRANSLATIONS['en-US']?.[key] ?? key;
        for (const k of Object.keys(data)) text = text.replace(`{${k}}`, data[k]);
        return text;
    }
    function statusFor(lang: string, tool: string): string {
        const toolKey = 'status_tool_' + tool;
        const friendly = t(lang, toolKey);
        return friendly !== toolKey ? friendly : t(lang, 'status_executing_tool', { tool });
    }
    assert(statusFor('pt-BR', 'web_search') === '🔍 Pesquisando na internet...', 'tool mapeada usa o rótulo amigável', statusFor('pt-BR', 'web_search'));
    assert(statusFor('pt-BR', 'ferramenta_futura_inexistente') === '🔧 Usando ferramenta_futura_inexistente...',
        'tool NÃO mapeada cai no fallback com o nome técnico — continua funcionando, sem inventar rótulo',
        statusFor('pt-BR', 'ferramenta_futura_inexistente'));
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S235 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
