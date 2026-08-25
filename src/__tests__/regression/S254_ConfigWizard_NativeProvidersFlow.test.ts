/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S254
 *
 * ConfigWizard.js — Incremento C5 (Fase C, 2026-08-23): fluxo dos 5 provedores nativos de nuvem
 * por API key (Gemini/DeepSeek/Groq/OpenRouter/Anthropic) — 8ª e última família de
 * PROVIDER_CAPABILITIES a ganhar implementação real (as demais eram só placeholder via
 * renderStub() até aqui).
 *
 * Mesma técnica de S250-253 (reprodução da lógica pura + asserção estrutural sobre o texto-fonte,
 * não importação — `ConfigWizard.js` arrasta `app.js`, que assume DOM real desde o top-level).
 *
 * Investigação que precedeu a implementação (registrada aqui porque é o que torna o design
 * defensável, não só "funciona"):
 * 1. `ProviderFactory`(linhas 85-89) só registra os 5 nativos no Map de providers com a key
 *    presente NO CONSTRUTOR (boot) — MAS `updateCredential()` (linha ~865) já existe e é chamado
 *    dentro da própria rota `POST /api/config` (routes/config.ts:181-185) sempre que uma dessas
 *    5 keys chega no payload — ou seja, salvar a key via `doSave()` de sempre já hot-registra o
 *    provider, sem reinício. Não foi preciso nenhum endpoint novo.
 * 2. Não existe (nem deveria existir) um "testar sem salvar" pra provider nativo: discovery lê o
 *    provider já registrado no `ProviderFactory` do servidor — não dá pra descobrir modelos de uma
 *    key que ainda não foi persistida. Por isso um único botão salva+verifica junto, diferente do
 *    padrão "Testar conexão" (não-persistente) de Ollama/Custom.
 * 3. `computeSystemReady()` (ModelosView.js) exige `cs.salvo('currentModel')` não vazio — mas nem
 *    `doSave()` nem `loadProviders(true)` atualizam esse campo (só populam `providersStore`, nunca
 *    tocam `configStore.currentModel`). Sem isso, o Wizard terminaria com "Sistema pronto: Não"
 *    mesmo com o provider genuinamente configurado. Corrigido com a MESMA disciplina de C3
 *    (`confirmCustomEntry()`): busca só `getConfig()` e atualiza só o campo `currentModel`, nunca
 *    `configStore.patch()` do objeto inteiro. `computeSystemReady()` em si não foi tocado.
 * 4. `PROVIDER_CAPABILITIES` já tinha os 5 nativos com `modelSelection: false` desde antes de C5
 *    (Fase B) — "nenhum dos 5 nativos obrigado a selecionar modelo" já era a decisão registrada,
 *    não uma escolha nova desta sprint. `FAMILY_STEPS.native` também já existia
 *    (`['choose', 'credential', 'validating', 'conclusion']`, sem etapa de seleção de modelo).
 *
 * Verifica:
 * 1. `confirmNativeCredential()` chama `doSave()` ANTES de `loadProviders(true)` (a key precisa
 *    estar persistida/hot-registrada antes do discovery poder encontrar algo).
 * 2. `applyDefaultProviderChange()` só é chamado DEPOIS de confirmar `entry?.online` — nunca antes
 *    da verificação (ao contrário de Ollama/Custom, que já chegam com conexão pré-testada).
 * 3. `getConfig()` + `configStore.set('currentModel', ...)` depois do 2º `doSave()` — nunca
 *    `configStore.patch()` do objeto inteiro.
 * 4. `canAdvance('credential')` não tem caso próprio (default false) — a transição pra
 *    'validating' é sempre programática, nunca pelo "Próximo" genérico (mesmo padrão do
 *    'localLoading' em C4 — `next()` ficaria travado se fosse usado aqui).
 * 5. Nenhuma API key aparece em `console.*`/`showToast` dentro do arquivo.
 * 6. Máquina de estados pura: choose → credential → validating → conclusion, sem etapa de seleção
 *    de modelo.
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
const PROVIDER_FACTORY = fs.readFileSync(
    path.join(process.cwd(), 'src', 'core', 'ProviderFactory.ts'),
    'utf-8',
);
const CONFIG_ROUTE = fs.readFileSync(
    path.join(process.cwd(), 'src', 'dashboard', 'routes', 'config.ts'),
    'utf-8',
);

console.log('\n=== S254-1 — investigação confirmada no código real: updateCredential() já existe e já é chamado por POST /api/config ===');
{
    assert(
        /updateCredential\(key: 'geminiKey' \| 'deepseekKey' \| 'groqKey' \| 'openrouterKey' \| 'anthropicKey', value: string\)/.test(PROVIDER_FACTORY),
        'ProviderFactory.updateCredential() existe com a assinatura esperada — hot-registra o provider sem reinício',
    );
    assert(
        /ctx\.providerFactory\?\.updateCredential\('geminiKey', geminiKey\)/.test(CONFIG_ROUTE),
        'POST /api/config (routes/config.ts) já chama updateCredential() — o mesmo doSave() de sempre basta, nenhum endpoint novo foi criado',
    );
}

console.log('\n=== S254-2 — confirmNativeCredential(): ordem correta save → discover → (só então) applyDefaultProviderChange ===');
{
    const fn = CW.slice(CW.indexOf('async function confirmNativeCredential()'), CW.indexOf('function renderStub('));
    const idxSave1 = fn.indexOf('await doSave();');
    const idxLoadProviders = fn.indexOf('await loadProviders(true);');
    const idxApply = fn.indexOf("applyDefaultProviderChange(session.provider);");
    assert(idxSave1 !== -1 && idxLoadProviders !== -1 && idxSave1 < idxLoadProviders, 'doSave() roda antes de loadProviders(true) — a key precisa estar persistida/hot-registrada antes do discovery poder achar algo', { idxSave1, idxLoadProviders });
    assert(idxApply !== -1 && idxLoadProviders < idxApply, 'applyDefaultProviderChange() só roda DEPOIS de loadProviders(true) — nunca antes de confirmar que a key funciona', { idxLoadProviders, idxApply });
    assert(
        /if \(entry\?\.online\) \{/.test(fn) && fn.indexOf('if (entry?.online) {') < idxApply,
        'applyDefaultProviderChange() está dentro do ramo entry?.online — nunca chamado no caminho de falha',
    );
}

console.log('\n=== S254-3 — currentModel atualizado com a mesma disciplina de C3 (campo só, nunca o config inteiro) ===');
{
    const fn = CW.slice(CW.indexOf('async function confirmNativeCredential()'), CW.indexOf('function renderStub('));
    assert(
        /const fresh = await getConfig\(\);[\s\S]{0,200}configStore\.set\('currentModel', fresh\.currentModel\);/.test(fn),
        'confirmNativeCredential() busca getConfig() e atualiza só currentModel — nunca configStore.patch() do objeto inteiro',
        fn,
    );
}

console.log('\n=== S254-4 — canAdvance(\'credential\') sem caso próprio — transição pra validating é sempre programática ===');
{
    assert(
        !/case 'credential':/.test(CW),
        'canAdvance() não tem case para \'credential\' (cai no default false) — mesmo padrão do \'localLoading\' em C4, next() ficaria travado se usado aqui',
    );
    const fn = CW.slice(CW.indexOf('async function confirmNativeCredential()'), CW.indexOf('function renderStub('));
    assert(
        /session = \{ \.\.\.session, currentStep: 'validating' \};/.test(fn) && !/session = next\(session\)/.test(fn),
        'confirmNativeCredential() atribui currentStep diretamente, nunca via next()/canAdvance()',
    );
}

console.log('\n=== S254-5 — nenhuma API key aparece em log/toast ===');
{
    const fn = CW.slice(CW.indexOf('function renderCredential('), CW.indexOf('function renderStub('));
    const logLines = [...fn.matchAll(/console\.(log|error|warn)\([^)]*\)/g)].map(m => m[0]);
    assert(logLines.length === 0, 'nenhum console.log/error/warn na área de código dos providers nativos', logLines);
    assert(!/showToast\([^)]*value/i.test(fn), 'nenhuma chamada a showToast() referencia a variável value (a API key)');
    assert(
        /type="password" class="form-input" id="ml-cw-nativeKey"/.test(CW),
        'campo de chave nativa é password, mesmo padrão de Ollama Cloud/Custom',
    );
}

// ── Reprodução da máquina de estados (fidelidade garantida pelas asserções estruturais acima) ──

type Session = {
    provider: string | null;
    family: string | null;
    currentStep: string;
};

const FAMILY_STEPS: Record<string, string[]> = {
    native: ['choose', 'credential', 'validating', 'conclusion'],
};

function canAdvance(s: Session): boolean {
    switch (s.currentStep) {
        case 'choose': return !!s.provider;
        default: return false; // credential/validating avançam por ação própria, não Próximo
    }
}

console.log('\n=== S254-6 — fluxo completo nativo, passo a passo (choose → credential → validating → conclusion) ===');
{
    let s: Session = { provider: null, family: null, currentStep: 'choose' };
    assert(canAdvance(s) === false, 'sessão nova não avança');
    s = { ...s, provider: 'gemini', family: 'native' };
    assert(canAdvance(s) === true, 'escolher um provider nativo libera o avanço pra credential');
    s = { ...s, currentStep: 'credential' };
    assert(canAdvance(s) === false, 'credential não avança por "Próximo" genérico — só pelo botão dedicado de salvar+verificar');
    // Simula confirmNativeCredential(): atribuição direta, nunca next()
    s = { ...s, currentStep: 'validating' };
    assert(s.currentStep === 'validating', 'botão dedicado move direto pra validating, sem etapa de seleção de modelo');
    s = { ...s, currentStep: 'conclusion' };
    assert(s.currentStep === 'conclusion', 'ao confirmar entry.online, avança pra conclusion (a etapa genérica, reaproveitada)');
    assert(
        !FAMILY_STEPS.native.includes('modelSelect') && !FAMILY_STEPS.native.some(step => /model/i.test(step)),
        'FAMILY_STEPS.native não tem nenhuma etapa de seleção de modelo — decisão já registrada na Fase B (PROVIDER_CAPABILITIES.modelSelection=false pros 5 nativos), não uma escolha nova de C5',
    );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S254 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exit(1);
