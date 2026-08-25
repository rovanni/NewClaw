/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S259
 *
 * Origem: relato ao vivo do usuário (2026-08-24) — "não tem opção de finalizar um modelo iniciado
 * pelo NewClaw! Ele fica indefinidamente [ocupando a VRAM]". Investigação confirmou que a ação de
 * descarregar (`stopLocalModel()` / `POST /api/models/local/stop`) já existia e já funcionava —
 * mas só aparecia dentro de Modelos → Adicionar Modelo → Meus arquivos (`registryMode==='local'`
 * em ModelosView.js), uma aba que quem usa só o Assistente de Configuração nunca visita. O usuário
 * foi explícito: "não quero timer para desativar, quero ter opção de desativar no dashboard".
 *
 * Correção: um botão "descarregar" no próprio Dashboard (📡, a tela inicial), condicionado a
 * `lastKnownLocalModel.running` — o mesmo dado que já alimenta `ModelosView.checkLocalModelDown()`,
 * já buscado por `loadProviders()` a cada 120s (`app.js`), sem rota nem estado novo. `.running`
 * distingue "processo que o NewClaw gerencia" (`persistServerState`/`readServerState`, ver
 * localRuntimeState.ts e S171) de "sei que alguém carregou isso antes, mas não é meu pra encerrar"
 * — só o primeiro caso ganha o botão.
 *
 * REGRESSÃO SE: o botão deixar de ser condicionado a `.running` (ofereceria "descarregar" um
 * processo que o NewClaw não gerencia — o mesmo erro que o comentário de `buildModelRows` já evita
 * na aba local: "está sendo servido por fora → só informa; não é nosso processo para encerrar");
 * ou o handler parar de chamar `stopLocalModel()` (a rota real) ou `loadProviders(true)` (refletir
 * o estado liberado sem esperar o próximo poll de 120s); ou a UI inventar um texto novo em vez de
 * reaproveitar `ml_local_running_title`/`ml_local_unload_btn`/`ml_local_unloaded_toast` (já
 * traduzidos nos 3 idiomas — inventar um novo quebraria a paridade PT/EN/ES sem motivo).
 *
 * Execução: npx ts-node src/__tests__/regression/S259_Dashboard_UnloadLocalModel.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const DASH = fs.readFileSync(
    path.join(process.cwd(), 'src', 'dashboard', 'public', 'config', 'views', 'DashboardView.js'),
    'utf-8',
);
const SHARED = fs.readFileSync(
    path.join(process.cwd(), 'src', 'dashboard', 'public', 'shared.js'),
    'utf-8',
);
const CSS = fs.readFileSync(
    path.join(process.cwd(), 'src', 'dashboard', 'public', 'config', 'config.css'),
    'utf-8',
);

console.log('\n=== S259-1 — o botão só aparece quando o NewClaw de fato gerencia o processo ===');
{
    const declIdx = DASH.indexOf('const lastLocal = providersStore.get');
    const renderIdx = DASH.indexOf('svcEl.innerHTML', declIdx);
    const block = DASH.slice(declIdx, renderIdx);

    assert(declIdx !== -1, 'lastLocal é lido do providersStore antes de renderizar os serviços');
    assert(/if\s*\(\s*lastLocal\?\.running\s*\)\s*\{/.test(block),
        'o botão só entra no bloco condicionado a lastLocal?.running');
    assert(block.includes('data-dash-unload-local'), 'o data-attribute do botão está dentro desse bloco condicional');

    const beforeIf = block.slice(0, block.indexOf('if ('));
    assert(!beforeIf.includes('data-dash-unload-local'),
        'nenhuma outra ocorrência do botão fora do if — não existe caminho que o ofereça sem checar .running');
}

console.log('\n=== S259-2 — dado reaproveitado, nenhuma rota/estado novo ===');
{
    assert(/providersStore\.get\(['"]lastKnownLocalModel['"]\)/.test(DASH),
        'lê do providersStore — o mesmo dado que loadProviders() já busca a cada 120s (app.js)');
    assert(!/fetch\(|getLocalServerStatus|\/api\/models\/local\/server/.test(DASH),
        'não introduz uma chamada de rede nova só para saber se o modelo local está no ar');
}

console.log('\n=== S259-3 — o clique chama a rota real e atualiza o estado sem esperar o poll ===');
{
    const start = DASH.indexOf('data-dash-unload-local');
    const handlerStart = DASH.lastIndexOf('addEventListener', start);
    const handlerEnd = DASH.indexOf('\n  });', handlerStart);
    const handlerBody = DASH.slice(handlerStart, handlerEnd);

    assert(/await stopLocalModel\(\)/.test(handlerBody), 'chama stopLocalModel() — a MESMA rota (/api/models/local/stop) que o botão da aba local já usa, nenhuma rota nova');
    assert(/await loadProviders\(true\)/.test(handlerBody), 'força loadProviders(true) após o sucesso — o dashboard reflete o modelo liberado sem esperar até 120s');
    assert(/catch/.test(handlerBody) && /btn\.disabled\s*=\s*false/.test(handlerBody), 'falha reabilita o botão — usuário pode tentar de novo sem recarregar a página');
}

console.log('\n=== S259-4 — textos reaproveitados dos já existentes (paridade PT/EN/ES preservada) ===');
{
    assert(/t\(['"]ml_local_running_title['"]/.test(DASH), 'reaproveita ml_local_running_title (já usado em ModelosView, já traduzido)');
    assert(/t\(['"]ml_local_unload_btn['"]/.test(DASH), 'reaproveita ml_local_unload_btn (já usado em ModelosView, já traduzido)');
    assert(/t\(['"]ml_local_unloaded_toast['"]/.test(DASH), 'reaproveita ml_local_unloaded_toast no toast de sucesso');

    for (const [lang, marker] of [['pt-BR', 'ml_local_unload_btn: "⏹ Descarregar"'], ['en-US', 'ml_local_unload_btn: "⏹ Unload"'], ['es-ES', 'ml_local_unload_btn: "⏹ Descargar"']] as const) {
        assert(SHARED.includes(marker), `chave já existe traduzida em ${lang} — nenhuma string nova adicionada`, marker);
    }
}

console.log('\n=== S259-5 — nome de arquivo longo não fica preso na largura fixa de 80px do .channel-name ===');
{
    // Achado ao vivo (2026-08-24, screenshot da própria validação): ".channel-name { width:80px }"
    // é dimensionado pra rótulos curtos ("Ollama", "Telegram") — um nome de .gguf real quebrava em
    // 3 linhas malformadas ao lado do botão. Corrigido com uma classe modificadora que NÃO altera
    // .channel-name (as outras linhas do painel dependem do alinhamento fixo dele).
    assert(/class="channel-name channel-name-wide"/.test(DASH), 'a linha do modelo local usa a variante de largura flexível');
    assert(/\.channel-name-wide\s*\{[^}]*flex\s*:\s*1/.test(CSS), 'a variante usa flex:1 em vez da largura fixa de 80px');
    assert(/\.channel-name\s*\{[^}]*width\s*:\s*80px/.test(CSS), '.channel-name original permanece intocado — as outras linhas do painel não mudam');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S259 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
