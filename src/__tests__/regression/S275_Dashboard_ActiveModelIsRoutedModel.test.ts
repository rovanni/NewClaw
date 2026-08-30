/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S275
 * O indicador "Modelo ativo" do Dashboard mostra o modelo que o Model Router usa para conversa
 * (modelRouter.chat), não o modelo de fallback do provider Ollama (ollamaModel/currentModel).
 *
 * CONTEXTO (diagnóstico 2026-08-29): o Dashboard exibia "Modelo ativo: glm-5.2:cloud" enquanto a
 * "Configuração Efetiva" da tela Modelos mostrava glm-5.3-flash:cloud em todas as categorias.
 * Duas telas do mesmo app discordando do que "modelo ativo" significa. Causa: DashboardView lia
 * `currentModel || ollamaModel` — e `ollamaModel` só é usado como fallback quando uma chamada ao
 * Ollama não especifica modelo, o que o Model Router (6 categorias + componentes internos)
 * praticamente nunca deixa acontecer. O valor `glm-5.2:cloud` era o default hardcoded de
 * OllamaProvider, nunca alterado pelo operador.
 *
 * CORREÇÃO:
 *   1. DashboardView passa a priorizar `modelRouter.chat`, com a MESMA cadeia de fallback e a
 *      MESMA leitura do espelho do servidor (`salvo`) que ModelosView.updateOverview() já usava
 *      (ver S180) — as duas telas não podem divergir.
 *   2. O campo "Modelo Ollama Principal" foi renomeado para "Modelo de fallback do Ollama" e
 *      ganhou um hint explicando que só vale quando a chamada não informa modelo — para o
 *      operador parar de lê-lo como a configuração primária.
 *
 * REGRESSÃO SE: DashboardView voltar a ler currentModel/ollamaModel sem o modelRouter.chat na
 * frente; se passar a ler o rascunho (get/snap) em vez do espelho (salvo); ou se o rótulo do
 * campo de fallback voltar a se chamar "principal"/"main" sem o hint.
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
const DASHBOARD = fs.readFileSync(P('config', 'views', 'DashboardView.js'), 'utf-8');
const MODELOS = fs.readFileSync(P('config', 'views', 'ModelosView.js'), 'utf-8');
const SHARED = fs.readFileSync(P('shared.js'), 'utf-8');

console.log('S275 — "Modelo ativo" do Dashboard = modelo roteado, não fallback do provider\n');

console.log('=== S275-1 — o chip do herói prioriza modelRouter.chat, lendo o espelho ===');
{
    assert(
        /const r = cs\.salvo\('modelRouter'\) \|\| \{\};/.test(DASHBOARD),
        'updateRuntime lê modelRouter do espelho do servidor (salvo)',
    );
    assert(
        /const model = r\.chat \|\| cs\.salvo\('currentModel'\) \|\| cs\.salvo\('ollamaModel'\) \|\| '—';/.test(DASHBOARD),
        'a cadeia de fallback é a mesma de ModelosView.updateOverview()',
    );
    assert(
        !/const model = cs\.get\('currentModel'\) \|\| cs\.get\('ollamaModel'\)/.test(DASHBOARD),
        'não volta a ler currentModel/ollamaModel do rascunho sem o modelRouter.chat na frente',
    );
}

console.log('\n=== S275-2 — o "Estado Geral" usa a mesma fonte ===');
{
    assert(
        /const rSalvo = cs\.salvo\('modelRouter'\) \|\| \{\};/.test(DASHBOARD)
        && /const model = rSalvo\.chat \|\| cs\.salvo\('currentModel'\) \|\| cs\.salvo\('ollamaModel'\) \|\| '';/.test(DASHBOARD),
        'updateHealthPanels deriva o modelo de modelRouter.chat, do espelho',
    );
    assert(
        !/const model = s\.currentModel \|\| s\.ollamaModel \|\| '';/.test(DASHBOARD),
        'a leitura antiga do snapshot de rascunho foi removida',
    );
}

console.log('\n=== S275-3 — o campo do Ollama é rotulado como fallback, com explicação ===');
{
    for (const [lang, valor] of [['pt-BR', 'Modelo de fallback do Ollama'], ['en-US', 'Ollama Fallback Model'], ['es-ES', 'Modelo de reserva de Ollama']] as const) {
        assert(
            SHARED.includes(`main_ollama_model_label: "${valor}"`),
            `${lang}: rótulo diz "fallback"/"reserva", não "principal"/"main"`,
        );
    }
    const n = (SHARED.match(/main_ollama_model_hint:/g) ?? []).length;
    assert(n === 3, `'main_ollama_model_hint' presente nos 3 idiomas (encontradas: ${n})`);
    assert(
        /<div class="form-hint">\$\{t\('main_ollama_model_hint'\)\}<\/div>/.test(MODELOS),
        'o hint é renderizado logo abaixo do campo #ollamaModel',
    );
    assert(
        /Model Router/.test(SHARED.slice(SHARED.indexOf('main_ollama_model_hint:'), SHARED.indexOf('main_ollama_model_hint:') + 200)),
        'o hint (pt-BR) menciona o Model Router como quem normalmente decide o modelo',
    );
}

console.log(failed === 0 ? `\n✅ S275 passou (${passed} asserções)` : `\n❌ S275: ${failed} falha(s)`);
process.exit(failed === 0 ? 0 : 1);
