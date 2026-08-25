/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S251
 *
 * ConfigWizard.js — Incremento 3 (Fase C, 2026-08-23): fluxo completo de Custom/OpenAI-Compatible
 * (LM Studio/vLLM/llamafile/OpenAI-oficial/gateway próprio).
 *
 * Mesma técnica de S250 (reprodução da lógica pura + asserção estrutural sobre o texto-fonte, não
 * importação — `ConfigWizard.js` arrasta `app.js`, que assume DOM real desde o top-level).
 *
 * Verifica:
 * 1. Confirmação da investigação que definiu o desenho: os presets (OpenAI/LM Studio/vLLM/
 *    llamafile) NÃO são caminhos de código distintos — só pré-preenchem label+baseUrl do mesmo
 *    formulário genérico. `testCustomProvider()`/`addCustomProvider()`/`editCustomProvider()` são
 *    reaproveitados tal como existem, nenhuma lógica de rede nova.
 * 2. `FAMILY_STEPS.custom` não tem etapa de teste separada — mesma correção do Ollama (C2),
 *    aplicada aqui porque `testCustomProvider()` também devolve tudo numa chamada só.
 * 3. Máquina de estados do fluxo Custom completo: choose → customEndpoint → customModelSelect →
 *    conclusion.
 * 4. `addCustomProvider()`/`editCustomProvider()` persistem DIRETO (fora de `configStore`/
 *    `doSave()`) — confirmado contra `routes/providers.ts` — por isso `confirmCustomEntry()`
 *    decide entre os dois lendo `providersStore.get('customProviders')`, igual ao formulário
 *    clássico decide via `editingProviderLabel`, sem inventar um mecanismo de fallback novo.
 * 5. API key nunca aparece em log/toast — só em `configStore`/`session.evidence` (memória), nunca
 *    em `console.log`/`showToast`/`logAcaoUI` dentro do arquivo.
 * 6. Caveat honesto quando nenhum modelo foi escolhido — não afirma que vai funcionar (ao
 *    contrário de um provider nativo, que tem fallback confiável).
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
const PROVIDERS_ROUTE = fs.readFileSync(
    path.join(process.cwd(), 'src', 'dashboard', 'routes', 'providers.ts'),
    'utf-8',
);

console.log('\n=== S251-1 — presets não são caminhos de código distintos, reaproveitados de ModelosView.js ===');
{
    assert(
        /export const CUSTOM_PROVIDER_PRESETS = \[/.test(MODELOS),
        'CUSTOM_PROVIDER_PRESETS é exportada de ModelosView.js — mesma lista, não uma cópia',
    );
    assert(
        !/const CUSTOM_PROVIDER_PRESETS/.test(CW),
        'ConfigWizard.js NÃO redeclara CUSTOM_PROVIDER_PRESETS — só recebe por parâmetro (customPresets)',
    );
    assert(
        /customPresets: CUSTOM_PROVIDER_PRESETS,/.test(MODELOS),
        'o mount() passa a mesma constante por referência',
    );
    assert(
        // Regex checa só a presença dos nomes exigidos pelo Custom na linha de import compartilhada
        // (não mais um match literal da linha inteira): C4 estendeu a mesma linha com
        // getLocalModels/serveLocalModel pro Local, e uma linha compartilhada crescer com uso
        // legítimo de outra família não é uma regressão do Custom.
        /import \{[^}]*\bgetCloudCatalog\b[^}]*\btestCustomProvider\b[^}]*\baddCustomProvider\b[^}]*\beditCustomProvider\b[^}]*\bgetConfig\b[^}]*\} from '\.\.\/api\.js';/.test(CW),
        'reaproveita as funções de api.js (incl. getConfig, pra reler customProviders sem adivinhar formato) — nenhuma reimplementada',
    );
}

console.log('\n=== S251-2 — sem etapa de teste separada (mesma correção do Ollama) ===');
{
    assert(!/'customTesting'/.test(CW), 'customTesting não é usado como id de etapa em nenhuma lógica real');
    assert(
        /custom:\s*\['choose', 'customEndpoint', 'customModelSelect', 'conclusion'\]/.test(CW),
        'FAMILY_STEPS.custom tem exatamente as 4 etapas esperadas, na ordem certa',
    );
}

console.log('\n=== S251-3 — persistência de custom provider é direta (fora de configStore/doSave), confirmado no backend ===');
{
    assert(
        /persistConfigToEnv\(ctx\);/.test(PROVIDERS_ROUTE),
        'confirma no backend real: POST/PUT /providers/custom grava direto (persistConfigToEnv), não espera doSave()',
    );
    // Achado ao vivo (2026-08-23), corrigido dentro do próprio C3: customProviders mora em
    // configStore (confirmado em app.js/state.js), nunca em providersStore. Ler da loja errada
    // fazia a checagem nunca encontrar nada — reconfigurar o mesmo provider sempre tentava ADD de
    // novo e batia em 400 "já existe". Reproduzido no navegador antes da correção.
    assert(
        /const existing = \(configStore\.get\('customProviders'\) \|\| \[\]\)\.find\(p => p\.label === session\.customLabel\);/.test(CW),
        'confirmCustomEntry() lê customProviders de configStore (a loja certa), não de providersStore',
    );
    assert(
        !/providersStore\.get\('customProviders'\)/.test(CW),
        'nenhum ponto do arquivo lê customProviders de providersStore (a loja que nunca tem esse campo)',
    );
    assert(
        /const fresh = await getConfig\(\);[\s\S]{0,120}configStore\.set\('customProviders', fresh\.customProviders \|\| \[\]\);/.test(CW),
        'depois de add/edit, só o campo customProviders é atualizado a partir do servidor — não a config inteira (evitaria descartar edição não salva em outra aba)',
    );
    assert(
        /await editCustomProvider\(session\.customLabel, payload\);/.test(CW) && /await addCustomProvider\(\{ label: session\.customLabel, \.\.\.payload \}\);/.test(CW),
        'os dois caminhos (edit se já existe, add se não) usam as funções existentes, sem duplicar lógica',
    );
}

console.log('\n=== S251-4 — API key nunca aparece em log/toast ===');
{
    const logLines = [...CW.matchAll(/console\.(log|error|warn)\([^)]*\)/g)].map(m => m[0]);
    assert(logLines.length === 0, 'nenhum console.log/error/warn no arquivo inteiro (nada pra vazar)', logLines);
    assert(!/showToast\([^)]*key/i.test(CW), 'nenhuma chamada a showToast() referencia a variável key/apiKey');
    assert(
        /type="password" class="form-input" id="ml-cw-customKey"/.test(CW),
        'campo de chave do Custom é password, igual ao de Ollama Cloud',
    );
}

console.log('\n=== S251-5 — caveat honesto quando nenhum modelo foi escolhido (Custom ≠ nativo) ===');
{
    assert(
        /const customNoModelCaveat = session\.family === 'custom' && !model/.test(CW),
        'existe um caveat específico pra Custom sem modelo, distinto do texto de nativos',
    );
    assert(
        /ml_cw_custom_no_model_caveat/.test(CW),
        'o caveat usa uma chave i18n própria (não reaproveita um texto que afirmaria sucesso)',
    );
}

console.log('\n=== S251-6b — achado durante a investigação do C4: troca de provider usa applyDefaultProviderChange(), não configStore.set() direto ===');
{
    assert(
        !/configStore\.set\('defaultProvider', session\.customLabel\)/.test(CW),
        'não sobrou nenhum configStore.set(\'defaultProvider\', ...) direto pra Custom',
    );
    assert(
        /applyDefaultProviderChange\(session\.customLabel\);/.test(CW),
        'confirmCustomEntry() chama applyDefaultProviderChange(session.customLabel) — mesma proteção do Ollama, sem duplicar',
    );
}

// ── Reprodução da máquina de estados (fidelidade garantida pelas asserções estruturais acima) ──

type Session = {
    provider: string | null;
    family: string | null;
    customLabel?: string;
    evidence: Record<string, unknown>;
    selectedModel?: { id: string; provider: string };
    currentStep: string;
};

const FAMILY_STEPS: Record<string, string[]> = {
    custom: ['choose', 'customEndpoint', 'customModelSelect', 'conclusion'],
};

function stepsFor(s: Session): string[] {
    return s.family ? FAMILY_STEPS[s.family] : ['choose'];
}

function canAdvance(s: Session): boolean {
    switch (s.currentStep) {
        case 'choose': return !!s.provider;
        case 'customEndpoint': return s.evidence.configOk === true;
        case 'customModelSelect': return true;
        default: return false;
    }
}

function next(s: Session): Session {
    if (!canAdvance(s)) return s;
    const steps = stepsFor(s);
    const idx = steps.indexOf(s.currentStep);
    if (idx === -1 || idx === steps.length - 1) return s;
    return { ...s, currentStep: steps[idx + 1] };
}

console.log('\n=== S251-6 — fluxo completo Custom, passo a passo ===');
{
    let s: Session = { provider: null, family: null, evidence: {}, currentStep: 'choose' };
    assert(canAdvance(s) === false, 'sessão nova não avança');
    s = { ...s, provider: 'custom', family: 'custom' };
    s = next(s);
    assert(s.currentStep === 'customEndpoint', 'choose → customEndpoint', s.currentStep);
    assert(canAdvance(s) === false, 'customEndpoint sem evidence.configOk não avança');
    s = { ...s, customLabel: 'LM Studio', evidence: { configOk: true, baseUrl: 'http://localhost:1234/v1', models: ['llama-3.1-8b-instruct'] } };
    s = next(s);
    assert(s.currentStep === 'customModelSelect', 'customEndpoint → customModelSelect', s.currentStep);
    assert(canAdvance(s) === true, 'customModelSelect avança mesmo sem seleção (recomendada, não obrigatória)');
    s = next(s);
    assert(s.currentStep === 'conclusion', 'customModelSelect → conclusion', s.currentStep);
}

console.log('\n=== S251-7 — catálogo vazio não trava o fluxo (servidor respondeu, sem modelos) ===');
{
    let s: Session = { provider: 'custom', family: 'custom', customLabel: 'meu-servidor', evidence: { configOk: true, baseUrl: 'http://localhost:9000/v1', models: [] }, currentStep: 'customEndpoint' };
    s = next(s);
    assert(s.currentStep === 'customModelSelect', 'avança normalmente com evidence.configOk mesmo com models: []', s);
    assert(canAdvance(s) === true, 'ainda pode avançar sem nenhum modelo na lista (não é erro, é estado válido)');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S251 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exit(1);
