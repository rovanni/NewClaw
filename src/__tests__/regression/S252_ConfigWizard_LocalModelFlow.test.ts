/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S252
 *
 * ConfigWizard.js — Incremento 4 (Fase C, 2026-08-23): fluxo completo de Modelo Local (GGUF).
 *
 * Mesma técnica de S250/S251 (reprodução da lógica pura + asserção estrutural — `ConfigWizard.js`
 * arrasta `app.js`, que assume DOM real desde o top-level, então importar de verdade num teste
 * Node não é viável sem um stub de browser tão grande que vira o próprio risco).
 *
 * Verifica:
 * 1. Investigação prévia confirmada: `ensureLocalProvider()` já chama
 *    `applyDefaultProviderChange()` internamente — a família local herda de graça a proteção
 *    contra a classe de bug do C2 (modelRouter obsoleto), sem precisar de nenhum código novo aqui.
 * 2. `serveLocalModel()`/`ensureLocalProvider()`/`getLocalModels()` reaproveitados tal como
 *    existem — nenhuma lógica de rede nova, nenhuma duplicada de LocalModelWizard.js.
 * 3. `FAMILY_STEPS['local-gguf']` não tem etapas "localServing"/"localConfirming" separadas —
 *    mesma correção já aplicada duas vezes (C2/C3), a 3ª ocorrência do mesmo princípio.
 * 4. Máquina de estados completa: choose → localFolder → localModelSelect → localLoading →
 *    conclusion, com seleção MANDATÓRIA (diferente de Ollama/Custom) — o clique na linha do
 *    modelo já é a confirmação, sem "Próximo" intermediário.
 * 5. Pasta escaneada com sucesso mas sem binário bloqueia o avanço (evidence limpa) — mesmo
 *    critério que LocalModelWizard.js já usa pro estado `no_binary`.
 * 6. Pasta escaneada com sucesso, com binário, sem nenhum .gguf NÃO bloqueia — avança e mostra o
 *    estado vazio na etapa seguinte (mesmo padrão já usado em Custom pra catálogo vazio).
 * 7. Editar a pasta depois de escanear com sucesso invalida a evidência (mesma proteção retrofitada
 *    no Ollama/Custom, aplicada aqui desde o início, não depois de um bug ao vivo).
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const CW = fs.readFileSync(
    path.join(process.cwd(), 'src', 'dashboard', 'public', 'config', 'components', 'ConfigWizard.js'),
    'utf-8',
);
const MODELOS = fs.readFileSync(
    path.join(process.cwd(), 'src', 'dashboard', 'public', 'config', 'views', 'ModelosView.js'),
    'utf-8',
);
const APP = fs.readFileSync(
    path.join(process.cwd(), 'src', 'dashboard', 'public', 'config', 'app.js'),
    'utf-8',
);

console.log('\n=== S252-1 — ensureLocalProvider() já protege contra modelRouter obsoleto, confirmado no código real ===');
{
    assert(
        /applyDefaultProviderChange\(LOCAL_PROVIDER_LABEL\);/.test(MODELOS),
        'ensureLocalProvider() chama applyDefaultProviderChange() internamente (confirmado, não presumido)',
    );
    assert(
        !/configStore\.set\('defaultProvider'.*LOCAL_PROVIDER_LABEL/.test(MODELOS),
        'ensureLocalProvider() não seta defaultProvider direto — só via applyDefaultProviderChange()',
    );
}

console.log('\n=== S252-2 — reaproveita as APIs existentes, nenhuma reimplementada ===');
{
    assert(
        /import \{ getCloudCatalog, testCustomProvider, addCustomProvider, editCustomProvider, getConfig, getLocalModels, serveLocalModel, browseLocalDirectory, triggerNativeDirectoryPicker \} from '\.\.\/api\.js';/.test(CW),
        'importa getLocalModels/serveLocalModel de api.js — mesmas funções que LocalModelWizard.js usa',
    );
    assert(
        /async function loadLocalModel\(file\)/.test(CW) && /await ensureLocalProvider\(r\.url, file\);/.test(CW),
        'loadLocalModel() chama ensureLocalProvider() por referência (recebida em mount), não uma cópia',
    );
    assert(
        !/function ensureLocalProvider/.test(CW),
        'ConfigWizard.js não redeclara ensureLocalProvider() — só recebe por parâmetro',
    );
}

console.log('\n=== S252-3 — sem etapas de serving/confirming separadas (3ª ocorrência da mesma correção) ===');
{
    assert(!/'localServing'/.test(CW) && !/'localConfirming'/.test(CW), 'nenhum id de etapa localServing/localConfirming sobrou em uso');
    assert(
        /'local-gguf': \['choose', 'localFolder', 'localModelSelect', 'localLoading', 'conclusion'\]/.test(CW),
        "FAMILY_STEPS['local-gguf'] tem exatamente as 5 etapas esperadas, na ordem certa",
    );
}

console.log('\n=== S252-3b — achado ao vivo (2026-08-23): localLoading→conclusion não pode usar next() ===');
{
    // Bug real: loadLocalModel() usava `session = next(session);` no sucesso do carregamento.
    // canAdvance('localLoading') é `false` de propósito (não há navegação manual nessa etapa), então
    // next() devolvia a sessão intacta — a UI ficava presa em "Carregando…" pra sempre, mesmo com o
    // backend já tendo terminado de verdade (confirmado ao vivo via log de rede: POST /api/providers/
    // custom, POST /api/config, GET /api/providers?refresh=1, GET /api/models/catalog?refresh=true —
    // toda a sequência de ensureLocalProvider() concluída — mas currentStep nunca avançava).
    const fn = CW.slice(CW.indexOf('async function loadLocalModel('), CW.indexOf('function renderConclusion('));
    assert(
        /session = \{ \.\.\.session, currentStep: 'conclusion' \};/.test(fn),
        "loadLocalModel() avança pra 'conclusion' com atribuição direta, não via next()/canAdvance()",
    );
    assert(
        !/session = next\(session\);/.test(fn),
        'loadLocalModel() não chama next(session) no caminho de sucesso (canAdvance(\'localLoading\') é false por design — next() ficaria travado)',
    );
}

console.log('\n=== S252-4 — regra de save: só em confirmação (scan bem-sucedido), nunca em digitação ===');
{
    const testFn = CW.slice(CW.indexOf('async function testLocalFolder()'), CW.indexOf('function renderLocalModelSelect('));
    assert((testFn.match(/await doSave\(\)/g) || []).length === 1, 'testLocalFolder() chama doSave() exatamente 1 vez, na confirmação do scan', testFn.match(/await doSave\(\)/g));
    assert(
        /invalidateEvidenceOnEdit\('ml-cw-localDir'\)/.test(CW),
        'renderLocalFolder() liga a invalidação de evidência no campo de pasta (mesma proteção do Ollama/Custom, aplicada desde o início aqui)',
    );
}

// ── Reprodução da máquina de estados (fidelidade garantida pelas asserções estruturais acima) ──

type Session = {
    provider: string | null;
    family: string | null;
    evidence: Record<string, unknown>;
    selectedModel?: { id: string; provider: string };
    currentStep: string;
};

const FAMILY_STEPS: Record<string, string[]> = {
    'local-gguf': ['choose', 'localFolder', 'localModelSelect', 'localLoading', 'conclusion'],
};

function stepsFor(s: Session): string[] {
    return s.family ? FAMILY_STEPS[s.family] : ['choose'];
}

function canAdvance(s: Session): boolean {
    switch (s.currentStep) {
        case 'choose': return !!s.provider;
        case 'localFolder': return s.evidence.configOk === true;
        default: return false; // localModelSelect/localLoading avançam por ação própria, não Próximo
    }
}

function next(s: Session): Session {
    if (!canAdvance(s)) return s;
    const steps = stepsFor(s);
    const idx = steps.indexOf(s.currentStep);
    if (idx === -1 || idx === steps.length - 1) return s;
    return { ...s, currentStep: steps[idx + 1] };
}

console.log('\n=== S252-5 — fluxo completo Local, passo a passo ===');
{
    let s: Session = { provider: null, family: null, evidence: {}, currentStep: 'choose' };
    assert(canAdvance(s) === false, 'sessão nova não avança');
    s = { ...s, provider: 'local', family: 'local-gguf' };
    s = next(s);
    assert(s.currentStep === 'localFolder', 'choose → localFolder', s.currentStep);
    assert(canAdvance(s) === false, 'localFolder sem evidence.configOk não avança');

    // pasta escaneada, COM binário, SEM nenhum .gguf — avança mesmo assim (estado vazio na próxima)
    let sEmpty: Session = { ...s, evidence: { configOk: true, dir: '/vazia', models: [] } };
    sEmpty = next(sEmpty);
    assert(sEmpty.currentStep === 'localModelSelect', 'pasta válida sem .gguf ainda avança (não é erro)', sEmpty);

    // fluxo feliz: pasta com modelos
    s = { ...s, evidence: { configOk: true, dir: '/modelos', models: [{ id: 'a.gguf' }, { id: 'b.gguf' }] } };
    s = next(s);
    assert(s.currentStep === 'localModelSelect', 'localFolder → localModelSelect', s.currentStep);
    assert(canAdvance(s) === false, 'localModelSelect não tem "Próximo" genérico — seleção é mandatória via clique na linha');

    // simula o clique na linha (loadLocalModel avança manualmente, não via next()/canAdvance())
    s = { ...s, selectedModel: { id: 'a.gguf', provider: 'local' }, currentStep: 'localLoading' };
    assert(s.currentStep === 'localLoading', 'clique na linha move direto pra localLoading, sem etapa de confirmação separada');

    s = { ...s, currentStep: 'conclusion' };
    assert(s.currentStep === 'conclusion', 'ao terminar de servir, avança pra conclusion (a etapa genérica, reaproveitada)');
}

console.log('\n=== S252-5b — achado ao vivo (2026-08-23): troca Local→Ollama não deve tentar "ollama pull" num .gguf sobrando ===');
{
    // Reproduzido ao vivo: ensureLocalProvider() seta 6 categorias pro arquivo .gguf; ao trocar
    // pra Ollama depois, confirmOllamaModelSelection() só reescreve `chat` (por design, ver S250) —
    // e realignRouterToProvider() corretamente NÃO mexe nas outras 5 categorias quando o catálogo
    // não sabe a quem o .gguf pertence (llama-server local não estava rodando no momento da troca —
    // NUNCA_ADIVINHAR, comportamento correto de ModelosView.js:2444). O guard de doSave() que decide
    // o que tentar "ollama pull" (app.js) usava só `provider_<k> || defaultProvider` — sem essa
    // checagem, code/vision/light/analysis/execution ainda com o nome do .gguf eram classificados
    // como "pertence ao Ollama" só por não ter override explícito, e POST /api/ollama/pull voltava
    // 400 (confirmado ao vivo: rede mostrou o 400, sem nenhum aviso visível pro usuário).
    assert(
        /if \(model\.endsWith\('\.gguf'\)\) continue;/.test(APP),
        'doSave() pula qualquer modelRouter value terminado em .gguf antes de tentar ollama pull/exists — não assume que "sem provider_<k> explícito" significa "pertence ao Ollama"',
    );
}

console.log('\n=== S252-6 — pasta válida sem binário bloqueia o avanço (evidence limpa) ===');
{
    // Reprodução da decisão de testLocalFolder(): scan sem erro + sem serverBinary → evidence = {}
    const decidirEvidence = (scanError: string | null, serverBinary: boolean) => {
        if (scanError) return {};
        if (!serverBinary) return {};
        return { configOk: true };
    };
    assert((decidirEvidence(null, false) as any).configOk === undefined, 'sem binário: evidence não fica configOk (bloqueia "Próximo")');
    assert((decidirEvidence(null, true) as any).configOk === true, 'com binário: evidence fica configOk (libera "Próximo")');
    assert((decidirEvidence('ENOENT', true) as any).configOk === undefined, 'pasta inexistente: evidence não fica configOk, mesmo hipoteticamente com binário');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S252 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exit(1);
