/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S275
 * "Modelo ativo" (Dashboard e Modelos) = o modelo da conversa, resolvido por UMA autoridade só.
 *
 * CONTEXTO (diagnóstico 2026-08-29): o Dashboard exibia "Modelo ativo: glm-5.2:cloud" enquanto a
 * "Configuração Efetiva" da tela Modelos mostrava glm-5.3-flash:cloud em todas as categorias.
 * Duas telas do mesmo app discordando do que "modelo ativo" significa. Causa: a regra de
 * precedência `modelRouter.chat → currentModel → ollamaModel` (lida do espelho do servidor)
 * estava COPIADA em quatro funções — duas em ModelosView (updateOverview, computeSystemReady) e,
 * depois do primeiro fix, mais duas em DashboardView (updateRuntime, updateHealthPanels). A cópia
 * do Dashboard nasceu divergente: lia só `currentModel || ollamaModel`, sem o `modelRouter.chat`
 * na frente, e `ollamaModel` é apenas o fallback do provider Ollama (default hardcoded
 * `glm-5.2:cloud` em OllamaProvider), que o Model Router praticamente nunca deixa entrar em uso.
 *
 * CORREÇÃO (ARCH — Single Authoritative Knowledge): a regra virou `activeChatModel(store)` em
 * `config/state.js` — o módulo que já é dono do `configStore` e da semântica de `salvo()`
 * ("o que está valendo agora no servidor"). Nenhum arquivo novo. As quatro funções passam a
 * chamar `activeChatModel(cs)`; cada tela continua dona da própria apresentação (o placeholder
 * '—' fica no chamador). ConfigWizard fica de fora de propósito: `session.selectedModel` é
 * seleção EM ANDAMENTO, não estado efetivo.
 *
 * REGRESSÃO SE: qualquer view reinlinar a cadeia `modelRouter.chat || currentModel || ollamaModel`
 * em vez de chamar activeChatModel; se activeChatModel passar a ler o rascunho (get/snap) em vez
 * do espelho (salvo); se a precedência mudar; ou se o rótulo do campo de fallback do Ollama
 * voltar a se chamar "principal"/"main" sem o hint que explica que é fallback.
 *
 * Execução: npx ts-node src/__tests__/regression/S275_Dashboard_ActiveModelIsRoutedModel.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const P = (...p: string[]) => path.join(process.cwd(), 'src', 'dashboard', 'public', ...p);
const STATE = fs.readFileSync(P('config', 'state.js'), 'utf-8');
const DASHBOARD = fs.readFileSync(P('config', 'views', 'DashboardView.js'), 'utf-8');
const MODELOS = fs.readFileSync(P('config', 'views', 'ModelosView.js'), 'utf-8');
const WIZARD = fs.readFileSync(P('config', 'components', 'ConfigWizard.js'), 'utf-8');
const SHARED = fs.readFileSync(P('shared.js'), 'utf-8');

console.log('S275 — "Modelo ativo" resolvido por uma autoridade única (activeChatModel)\n');

/** Extrai o corpo de activeChatModel() de state.js e o transforma numa função executável. */
function carregarActiveChatModel(): (store: unknown) => string {
    const marca = 'export function activeChatModel(store) {';
    const i = STATE.indexOf(marca);
    if (i < 0) throw new Error('activeChatModel não encontrada em state.js');
    let d = 0, j = i + marca.length - 1;
    for (; j < STATE.length; j++) {
        if (STATE[j] === '{') d++;
        else if (STATE[j] === '}') { d--; if (d === 0) break; }
    }
    const corpo = STATE.slice(i + marca.length, j);
    // eslint-disable-next-line no-new-func
    return new Function('store', corpo) as (store: unknown) => string;
}

console.log('=== S275-1 — a autoridade existe em state.js, lendo o espelho (salvo) ===');
{
    assert(/export function activeChatModel\(store\)/.test(STATE), 'state.js exporta activeChatModel(store)');
    const corpo = STATE.slice(STATE.indexOf('export function activeChatModel('));
    const ate = corpo.slice(0, corpo.indexOf('\n}') + 2);
    assert(
        /store\.salvo\('modelRouter'\)/.test(ate)
        && /store\.salvo\('currentModel'\)/.test(ate)
        && /store\.salvo\('ollamaModel'\)/.test(ate),
        'resolve os três campos pelo espelho do servidor (salvo)',
    );
    assert(!/\bstore\.(get|snap)\(/.test(ate), 'nunca lê o rascunho da tela (get/snap) — invariante de S180');
}

console.log('\n=== S275-2 — comportamento: precedência chat → currentModel → ollamaModel ===');
{
    const acm = carregarActiveChatModel();
    const store = (m: Record<string, unknown>) => ({ salvo: (k: string) => m[k] });
    assert(
        acm(store({ modelRouter: { chat: 'glm-5.3-flash:cloud' }, currentModel: 'x', ollamaModel: 'glm-5.2:cloud' })) === 'glm-5.3-flash:cloud',
        'modelRouter.chat vence quando presente',
    );
    assert(
        acm(store({ modelRouter: {}, currentModel: 'glm-air:cloud', ollamaModel: 'glm-5.2:cloud' })) === 'glm-air:cloud',
        'cai para currentModel quando não há chat roteado',
    );
    assert(
        acm(store({ modelRouter: {}, currentModel: '', ollamaModel: 'glm-5.2:cloud' })) === 'glm-5.2:cloud',
        'cai para ollamaModel (fallback do provider) só em último caso',
    );
    assert(acm(store({})) === '', 'devolve string vazia quando nada está configurado (quem exibe decide o placeholder)');
}

console.log('\n=== S275-3 — os consumidores chamam a autoridade, não reinlinam a regra ===');
{
    assert(/from '\.\.\/state\.js';/.test(DASHBOARD) && /activeChatModel/.test(DASHBOARD), 'DashboardView importa activeChatModel de state.js');
    assert((DASHBOARD.match(/activeChatModel\(cs\)/g) ?? []).length >= 2, 'DashboardView usa activeChatModel no herói E no Estado Geral');
    assert(/from '\.\.\/state\.js';/.test(MODELOS) && /activeChatModel/.test(MODELOS), 'ModelosView importa activeChatModel de state.js');
    assert((MODELOS.match(/activeChatModel\(cs\)/g) ?? []).length >= 2, 'ModelosView usa activeChatModel em updateOverview E computeSystemReady');

    // Nenhuma view pode reconstruir a cadeia por conta própria.
    const cadeiaInline = /\.chat\s*\|\|\s*(cs|store|configStore)\.salvo\('currentModel'\)\s*\|\|\s*\1\.salvo\('ollamaModel'\)/;
    assert(!cadeiaInline.test(DASHBOARD), 'DashboardView não reinlina modelRouter.chat || currentModel || ollamaModel');
    assert(!cadeiaInline.test(MODELOS), 'ModelosView não reinlina a cadeia');
}

console.log('\n=== S275-4 — ConfigWizard fica fora: seleção em andamento ≠ estado efetivo ===');
{
    assert(
        /session\.selectedModel/.test(WIZARD),
        'o wizard continua com sua própria regra baseada em session.selectedModel',
    );
    assert(
        !/activeChatModel/.test(WIZARD),
        'o wizard NÃO consome activeChatModel — não misturar estado de edição com estado vigente',
    );
}

console.log('\n=== S275-5 — o campo do Ollama é rotulado como fallback, com explicação ===');
{
    for (const [lang, valor] of [['pt-BR', 'Modelo de fallback do Ollama'], ['en-US', 'Ollama Fallback Model'], ['es-ES', 'Modelo de reserva de Ollama']] as const) {
        assert(SHARED.includes(`main_ollama_model_label: "${valor}"`), `${lang}: rótulo diz "fallback"/"reserva", não "principal"/"main"`);
    }
    const n = (SHARED.match(/main_ollama_model_hint:/g) ?? []).length;
    assert(n === 3, `'main_ollama_model_hint' presente nos 3 idiomas (encontradas: ${n})`);
    assert(
        /<div class="form-hint">\$\{t\('main_ollama_model_hint'\)\}<\/div>/.test(MODELOS),
        'o hint é renderizado logo abaixo do campo #ollamaModel',
    );
    const hintPt = SHARED.slice(SHARED.indexOf('main_ollama_model_hint:'), SHARED.indexOf('main_ollama_model_hint:') + 200);
    assert(/Model Router/.test(hintPt), 'o hint (pt-BR) menciona o Model Router como quem normalmente decide o modelo');
}

console.log(failed === 0 ? `\n✅ S275 passou (${passed} asserções)` : `\n❌ S275: ${failed} falha(s)`);
process.exit(failed === 0 ? 0 : 1);
