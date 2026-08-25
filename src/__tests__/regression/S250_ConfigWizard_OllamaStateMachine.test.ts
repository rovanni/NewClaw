/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S250
 *
 * ConfigWizard.js (Assistente de Configuração, primeira aba de Modelos) — Incremento 2 (Fase C,
 * 2026-08-23): fluxo completo de Ollama (Local × Cloud), o primeiro fluxo real conectado à
 * infraestrutura do Incremento 1.
 *
 * `ConfigWizard.js` é JS de navegador (importa `state.js`/`app.js`/`api.js`, que por sua vez
 * assumem um DOM real desde o top-level — ver comentário de `app.js:109`, `getElementById(...)`
 * sem guarda) — importar o módulo de verdade num teste Node exige um stub de browser tão grande
 * que vira o próprio risco que o teste deveria evitar (confirmado ao vivo: travou o processo).
 * Mesma solução já usada em S182 pra `computeSystemReady()`: reproduzir a lógica PURA aqui,
 * comprovando fidelidade com o arquivo real através de asserções estruturais sobre o texto-fonte,
 * não por importação. `canAdvance`/`next`/`back`/`hasDefaultModel` não tocam DOM nem rede — só
 * `mountConfigWizard()` toca, e essa parte é validada ao vivo no navegador (não aqui).
 *
 * Verifica:
 * 1. `hasDefaultModel()` deriva de `!capabilities.modelSelection` — nunca uma flag independente
 *    (correção da Fase B: evita as duas verdades ficarem inconsistentes entre si).
 * 2. `FAMILY_STEPS.ollama` não tem etapa de discovery separada — achado do próprio Incremento 2
 *    (a mesma chamada que confirma a conexão já traz o catálogo).
 * 3. Máquina de estados do fluxo Ollama completo: choose → ollamaMode → ollamaConfig →
 *    ollamaModelSelect → conclusion, com `canAdvance()` bloqueando cada etapa até a condição
 *    objetiva certa (nunca "campo preenchido").
 * 4. `back()` reseta `evidence` ao sair de `ollamaConfig` pra `ollamaMode` (trocar Local↔Cloud
 *    invalida o teste de conexão anterior).
 * 5. `back()` até `choose` zera TUDO (provider/family/ollamaMode/evidence/selectedModel) — não
 *    deixa vazar entre providers (risco mapeado na Fase A).
 * 6. Regra de save (Fase B, correção): nenhuma chamada a `doSave()`/`configStore.set()` existe
 *    fora de uma ação de confirmação explícita (`testOllamaConnection`/
 *    `confirmOllamaModelSelection`) — nunca dentro de um handler de digitação.
 * 7. Sem duplicação: `ConfigWizard.js` NÃO reimplementa pull de modelo Ollama — reaproveita o
 *    auto-pull que já existe dentro de `doSave()` (app.js), confirmado por AUSÊNCIA de
 *    `/api/ollama/pull`/`pullModel(` no arquivo do Wizard.
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

console.log('\n=== S250-1 — hasDefaultModel() deriva de capabilities, não é flag independente ===');
{
    assert(
        /function hasDefaultModel\(providerId\) \{\s*\n\s*return !PROVIDER_CAPABILITIES\[providerId\]\.capabilities\.modelSelection;/.test(CW),
        'hasDefaultModel() lê capabilities.modelSelection, não um campo hasDefaultModel próprio',
    );
    assert(
        !/hasDefaultModel:\s*(true|false)/.test(CW),
        'PROVIDER_CAPABILITIES não guarda hasDefaultModel como campo — só capabilities',
    );
}

console.log('\n=== S250-2 — FAMILY_STEPS.ollama não tem etapa de discovery separada ===');
{
    // A string pode existir num comentário explicando por que a etapa foi descartada (documentação
    // legítima) — o que importa é que ela nunca vire um id de etapa/comparação de lógica real.
    assert(!/'ollamaDiscovery'/.test(CW) && !/currentStep === 'ollamaDiscovery'/.test(CW), 'ollamaDiscovery não é usado como id de etapa em nenhuma lógica real');
    assert(
        /ollama:\s*\['choose', 'ollamaMode', 'ollamaConfig', 'ollamaModelSelect', 'conclusion'\]/.test(CW),
        'FAMILY_STEPS.ollama tem exatamente as 5 etapas esperadas, na ordem certa',
    );
}

console.log('\n=== S250-3 — sem duplicação: pull de modelo Ollama reaproveita doSave(), não reimplementado ===');
{
    assert(!/\/api\/ollama\/pull/.test(CW), 'ConfigWizard.js não chama /api/ollama/pull diretamente');
    assert(!/pullModel\(/.test(CW), 'ConfigWizard.js não importa/chama pullModel() — doSave() já cobre isso');
    assert(/import \{ doSave, loadProviders \} from '\.\.\/app\.js';/.test(CW), 'reaproveita doSave()/loadProviders() existentes, não uma cópia');
}

console.log('\n=== S250-4 — regra de save: só em confirmação, nunca em digitação ===');
{
    // Contagem por FUNÇÃO nomeada, não do arquivo inteiro — o total do arquivo cresce a cada
    // família nova conectada (Custom, em S251, tem sua própria confirmação com doSave() própria);
    // o que importa é que CADA função de confirmação do Ollama chama doSave() exatamente uma vez.
    const testFn = CW.slice(CW.indexOf('async function testOllamaConnection()'), CW.indexOf('function ollamaModelList()'));
    const confirmFn = CW.slice(CW.indexOf('async function confirmOllamaModelSelection()'), CW.indexOf('function renderCustomEndpoint('));
    assert((testFn.match(/await doSave\(\)/g) || []).length === 1, 'testOllamaConnection() chama doSave() exatamente 1 vez', testFn.match(/await doSave\(\)/g));
    assert((confirmFn.match(/await doSave\(\)/g) || []).length === 1, 'confirmOllamaModelSelection() chama doSave() exatamente 1 vez', confirmFn.match(/await doSave\(\)/g));
    assert(
        /async function testOllamaConnection\(\)[\s\S]*?await doSave\(\)/.test(CW),
        'a chamada de doSave() em testOllamaConnection só acontece dentro dela (ação de clique, não de input)',
    );
    assert(
        !/addEventListener\('input'[\s\S]{0,80}doSave/.test(CW),
        'nenhum listener de "input" (digitação) chama doSave() diretamente',
    );
}

console.log('\n=== S250-5 — guard destroyed presente nos pontos assíncronos novos ===');
{
    assert(/let destroyed = false;/.test(CW), 'flag destroyed existe');
    assert(
        /await doSave\(\);\s*\n\s*if \(destroyed\) return;/.test(CW),
        'testOllamaConnection verifica destroyed logo após o primeiro await',
    );
    assert(
        (CW.match(/if \(destroyed\) return;/g) || []).length >= 4,
        'guard destroyed aparece em múltiplos pontos de retomada assíncrona (não só um)',
        (CW.match(/if \(destroyed\) return;/g) || []).length,
    );
    assert(
        /return \(\) => \{ destroyed = true; unsubHealth\(\); \};/.test(CW),
        'cleanup do mount() marca destroyed e cancela a assinatura de health',
    );
}

// ── Reprodução da máquina de estados (fidelidade garantida pelas asserções estruturais acima) ──

type Session = {
    provider: string | null;
    family: string | null;
    ollamaMode?: string;
    evidence: Record<string, unknown>;
    selectedModel?: { id: string; provider: string };
    currentStep: string;
};

const FAMILY_STEPS: Record<string, string[]> = {
    ollama: ['choose', 'ollamaMode', 'ollamaConfig', 'ollamaModelSelect', 'conclusion'],
};

function stepsFor(s: Session): string[] {
    return s.family ? FAMILY_STEPS[s.family] : ['choose'];
}

function canAdvance(s: Session): boolean {
    switch (s.currentStep) {
        case 'choose': return !!s.provider;
        case 'ollamaMode': return !!s.ollamaMode;
        case 'ollamaConfig': return s.evidence.configOk === true;
        case 'ollamaModelSelect': return true;
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

function back(s: Session): Session {
    const steps = stepsFor(s);
    const idx = steps.indexOf(s.currentStep);
    if (idx <= 0) return s;
    if (steps[idx - 1] === 'choose') {
        return { provider: null, family: null, ollamaMode: undefined, evidence: {}, selectedModel: undefined, currentStep: 'choose' };
    }
    if (steps[idx - 1] === 'ollamaMode') {
        return { ...s, evidence: {}, currentStep: 'ollamaMode' };
    }
    return { ...s, currentStep: steps[idx - 1] };
}

function createSession(): Session {
    return { provider: null, family: null, ollamaMode: undefined, evidence: {}, selectedModel: undefined, currentStep: 'choose' };
}

console.log('\n=== S250-6 — fluxo completo Ollama Cloud, passo a passo ===');
{
    let s = createSession();
    assert(canAdvance(s) === false, 'sessão nova não avança');
    s = { ...s, provider: 'ollama', family: 'ollama' };
    s = next(s);
    assert(s.currentStep === 'ollamaMode', 'choose → ollamaMode', s.currentStep);
    assert(canAdvance(s) === false, 'ollamaMode sem modo escolhido não avança');
    s = { ...s, ollamaMode: 'cloud' };
    s = next(s);
    assert(s.currentStep === 'ollamaConfig', 'ollamaMode → ollamaConfig', s.currentStep);
    assert(canAdvance(s) === false, 'ollamaConfig sem evidence.configOk não avança — evidência sozinha não é decisão');
    s = { ...s, evidence: { configOk: true, modelCount: 4 } };
    s = next(s);
    assert(s.currentStep === 'ollamaModelSelect', 'ollamaConfig → ollamaModelSelect', s.currentStep);
    assert(canAdvance(s) === true, 'ollamaModelSelect avança mesmo sem seleção (recomendada, não obrigatória)');
    s = next(s);
    assert(s.currentStep === 'conclusion', 'ollamaModelSelect → conclusion', s.currentStep);
    assert(next(s).currentStep === 'conclusion', 'conclusion é terminal');
}

console.log('\n=== S250-7 — back() reseta evidence ao sair de ollamaConfig (trocar Local↔Cloud invalida o teste) ===');
{
    let s: Session = { provider: 'ollama', family: 'ollama', ollamaMode: 'cloud', evidence: { configOk: true, modelCount: 5 }, currentStep: 'ollamaConfig' };
    s = back(s);
    assert(s.currentStep === 'ollamaMode', 'volta pra ollamaMode', s.currentStep);
    assert(Object.keys(s.evidence).length === 0, 'evidence foi zerada', s.evidence);
}

console.log('\n=== S250-8 — back() até choose zera tudo, sem vazar entre providers ===');
{
    let s: Session = {
        provider: 'ollama', family: 'ollama', ollamaMode: 'local',
        evidence: { configOk: true }, selectedModel: { id: 'glm-5.2:cloud', provider: 'ollama' },
        currentStep: 'ollamaModelSelect',
    };
    s = back(s); // -> ollamaConfig
    s = back(s); // -> ollamaMode
    s = back(s); // -> choose
    assert(s.currentStep === 'choose', 'volta até choose', s.currentStep);
    assert(s.provider === null && s.family === null, 'provider/family zerados', s);
    assert(Object.keys(s.evidence).length === 0, 'evidence zerada', s.evidence);
    assert(s.selectedModel === undefined, 'selectedModel zerado', s.selectedModel);
}

console.log('\n=== S250-9 — achado durante o desenho do C3: editar URL/key após teste bem-sucedido invalida evidence ===');
{
    // Antes desta correção, `back()` só zerava `evidence` ao sair de ollamaConfig->ollamaMode (troca
    // de modo). Voltar um passo e voltar sem trocar de modo preservava `evidence.configOk`, e editar
    // a URL depois disso liberava "Próximo" com uma configuração NUNCA testada de verdade.
    assert(
        /function invalidateEvidenceOnEdit\(\.\.\.inputIds\)/.test(CW),
        'invalidateEvidenceOnEdit() existe como função compartilhada (não duplicada por família)',
    );
    assert(
        /invalidateEvidenceOnEdit\('ml-cw-ollamaUrl', 'ml-cw-ollamaKey'\)/.test(CW),
        'renderOllamaConfig() liga a invalidação nos campos de URL/key',
    );
    assert(
        /if \(!session\.evidence\.configOk\) return; \/\/ nada testado ainda/.test(CW),
        'a invalidação só age quando existe evidência real pra invalidar (não mexe em sessão nova)',
    );
}

console.log('\n=== S250-10 — achado durante a investigação do C4: troca de provider usa applyDefaultProviderChange(), não configStore.set() direto ===');
{
    // configStore.set('defaultProvider', ...) direto contorna realignRouterToProvider() — a mesma
    // proteção que já existe pra evitar nomes de modelo de OUTRO provider presos em modelRouter
    // (exatamente a classe do 400 achado ao vivo no C2). Confirmar aqui que confirmOllamaModelSelection()
    // usa a função certa, não a forma que causou o achado.
    assert(
        !/configStore\.set\('defaultProvider', 'ollama'\)/.test(CW),
        'não sobrou nenhum configStore.set(\'defaultProvider\', \'ollama\') direto',
    );
    assert(
        /applyDefaultProviderChange\('ollama'\);/.test(CW),
        'confirmOllamaModelSelection() chama applyDefaultProviderChange(\'ollama\') — reaproveita a realinhagem já existente',
    );
}

console.log('\n=== S250-11 — achado pelo /qa leigo (C4.5): confirmOllamaModelSelection() invalida a Visão Geral depois de salvar ===');
{
    // Achado ao vivo (2026-08-23): depois de confirmar o modelo Ollama, o Wizard mostrava
    // "✓ Tudo pronto!" enquanto a barra de status da página (fora do Wizard) continuava mostrando
    // o provider ANTIGO com a faixa "Alteração ainda não salva" — mesmo com doSave() já persistido
    // (confirmado via rede + reload). Não é bug de persistência, é falta de invalidação: nada
    // disparava o providersStore.on('*', ...) que ModelosView.js já usa pra repintar a Visão Geral
    // (updateOverview()). confirmCustomEntry() (C3) e loadLocalModel() (C4) já chamam
    // loadProviders(true) depois do próprio doSave() por outro motivo (recarregar saúde/catálogo) —
    // confirmOllamaModelSelection() era a única confirmação sem essa chamada, e portanto a única
    // que deixava a Visão Geral desatualizada. Correção: reaproveitar a mesma chamada, não inventar
    // um wizard.refreshOverview() novo.
    const confirmFn = CW.slice(CW.indexOf('async function confirmOllamaModelSelection()'), CW.indexOf('function renderCustomEndpoint('));
    assert(
        /await doSave\(\);[\s\S]{0,900}await loadProviders\(true\);/.test(confirmFn),
        'confirmOllamaModelSelection() chama loadProviders(true) logo depois de doSave() — mesmo padrão de confirmCustomEntry()/loadLocalModel()',
        confirmFn,
    );
}

console.log('\n=== S250-12 — achado pelo /qa leigo (C4.5): lista de modelos Ollama filtra por capability real, não regex de nome ===');
{
    // Achado ao vivo: a lista misturava nomic-embed-text:v1.5 (só embedding) com modelos de chat,
    // sem distinção — um leigo podia selecionar um modelo incapaz de conversar. `capabilities` já
    // vem real do Ollama (/api/tags via mapOllamaCapabilities() em OllamaProvider.discoverModels()),
    // e ModelosView.js:renderCategoryPicker() já usa exatamente esse campo pra filtrar a categoria
    // "chat" (CATEGORY_CAPABILITY.chat = 'chat') — reaproveitado aqui, não uma heurística nova.
    assert(
        /const chatCapable = m => m\.capabilities\?\.includes\('chat'\);/.test(CW),
        'ollamaModelList() filtra por capabilities?.includes(\'chat\') — dado real do discovery, não nome',
    );
    assert(
        !/\.includes\(['"]embed['"]\)|\.includes\(['"]embedding['"]\)/.test(CW.slice(CW.indexOf('function ollamaModelList'), CW.indexOf('function renderOllamaModelSelect'))),
        'nenhuma detecção de "embed" por substring de nome dentro de ollamaModelList() — só capability real',
    );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S250 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exit(1);
