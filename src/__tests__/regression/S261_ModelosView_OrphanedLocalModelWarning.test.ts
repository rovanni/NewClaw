/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S261
 *
 * Origem: relato ao vivo do usuário (2026-08-24) — trocou o provedor padrão de "Modelo local"
 * para "Ollama Cloud", e o servidor local (`gpt-oss-20b-Q4_K_M.gguf`) continuou rodando,
 * consumindo GPU/VRAM à toa. Confirmado via API real (`/api/models/local/server` retornando
 * `running:true` com `defaultProvider:"ollama"`) — comportamento intencional (o NewClaw nunca
 * descarrega um modelo local sozinho, mesmo princípio de `checkLocalModelDown()` ao contrário: a
 * GPU pode estar sendo usada por outra coisa, a decisão é do operador). O botão pra descarregar
 * já existia (Dashboard — S259 — e Adicionar Modelo → Meus arquivos), mas nenhum dos dois avisa
 * PROATIVAMENTE — o usuário só descobre se souber ir procurar. Como o usuário estava exatamente na
 * tela de Modelos, trocando de provedor, quando isso aconteceu, o aviso precisa estar ali.
 *
 * Verifica:
 * 1. `checkOrphanedLocalModel()` é o inverso estrutural de `checkLocalModelDown()` — mesma fonte
 *    de dados (`configStore.defaultProvider` + `providersStore.lastKnownLocalModel`), condição
 *    invertida (aqui: NÃO é o provedor em uso E está rodando; lá: É o provedor em uso E não está
 *    rodando).
 * 2. O botão reaproveita `stopLocalModel()` — a MESMA rota que o Dashboard (S259) e a aba "Meus
 *    arquivos" já usam, nenhuma rota nova.
 * 3. Textos reaproveitam `ml_local_unload_btn`/`ml_local_unloaded_toast` (já traduzidos, S259) e
 *    só os dois textos novos (`ml_local_orphaned_title`/`hint`) existem nos 3 idiomas.
 * 4. O elemento HTML placeholder (`ov-orphanedlocal`) existe no template e é chamado dentro de
 *    `updateOverview()`, mesmo padrão de `ov-localdown`.
 *
 * Execução: npx ts-node src/__tests__/regression/S261_ModelosView_OrphanedLocalModelWarning.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const MODELOS = fs.readFileSync(
    path.join(process.cwd(), 'src', 'dashboard', 'public', 'config', 'views', 'ModelosView.js'),
    'utf-8',
);
const SHARED = fs.readFileSync(
    path.join(process.cwd(), 'src', 'dashboard', 'public', 'shared.js'),
    'utf-8',
);

console.log('\n=== S261-1 — placeholder existe no template, mesmo padrão de ov-localdown ===');
{
    assert(/id="ov-orphanedlocal"/.test(MODELOS), 'div#ov-orphanedlocal existe no template');
    assert(/checkOrphanedLocalModel\(\);/.test(MODELOS), 'checkOrphanedLocalModel() é chamada (dentro de updateOverview)');
}

console.log('\n=== S261-2 — condição é o inverso exato de checkLocalModelDown() ===');
{
    const start = MODELOS.indexOf('function checkOrphanedLocalModel');
    const end = MODELOS.indexOf('\n}', start);
    const body = MODELOS.slice(start, end);

    assert(/configStore\.get\|cs\.get\('defaultProvider'\)/.test(body) || /cs\.get\('defaultProvider'\)/.test(body),
        'lê defaultProvider do configStore — mesma fonte que checkLocalModelDown()');
    assert(/providersStore\.get\('lastKnownLocalModel'\)/.test(body),
        'lê lastKnownLocalModel do providersStore — mesma fonte que checkLocalModelDown()');
    assert(/if\s*\(\s*isCustom\s*\|\|\s*!last\?\.running\s*\)/.test(body),
        'condição de ausência é isCustom (é o provedor em uso) OU não está rodando — o inverso de checkLocalModelDown (!isCustom || !last || health.online)');
    assert(/data-unload-orphaned/.test(body), 'o botão usa um data-attribute próprio, não reaproveita data-unload-local (evita colisão com o handler da aba Meus arquivos, que fica em outro container)');
}

console.log('\n=== S261-3 — o clique reaproveita a MESMA rota real, nenhuma nova ===');
{
    const start = MODELOS.indexOf("getElementById('ov-orphanedlocal')?.addEventListener");
    const end = MODELOS.indexOf('\n  });', start);
    const handlerBody = MODELOS.slice(start, end);

    assert(/await stopLocalModel\(\)/.test(handlerBody), 'chama stopLocalModel() — mesma rota /api/models/local/stop que Dashboard (S259) e Meus arquivos já usam');
    assert(/await loadProviders\(true\)/.test(handlerBody), 'força loadProviders(true) — reflete o estado liberado sem esperar o próximo poll');
    assert(/btn\.disabled\s*=\s*false/.test(handlerBody), 'falha reabilita o botão');
}

console.log('\n=== S261-4 — textos: dois novos, reaproveitando o resto (paridade PT/EN/ES) ===');
{
    assert(/t\(['"]ml_local_orphaned_title['"]/.test(MODELOS), 'usa ml_local_orphaned_title');
    assert(/t\(['"]ml_local_orphaned_hint['"]/.test(MODELOS), 'usa ml_local_orphaned_hint');
    assert(/t\(['"]ml_local_unload_btn['"]/.test(MODELOS), 'reaproveita ml_local_unload_btn (já existia, S259)');
    assert(/t\(['"]ml_local_unloaded_toast['"]/.test(MODELOS), 'reaproveita ml_local_unloaded_toast (já existia)');

    for (const marker of [
        "ml_local_orphaned_title: '🖥️ O modelo",
        "ml_local_orphaned_title: '🖥️ Model",
        'ml_local_orphaned_hint:',
    ]) {
        assert(SHARED.includes(marker), `chave presente em shared.js: "${marker}"`, marker);
    }
    // Paridade: título e hint devem aparecer exatamente 3 vezes cada (pt-BR/en-US/es-ES).
    const titleCount = (SHARED.match(/ml_local_orphaned_title:/g) || []).length;
    const hintCount = (SHARED.match(/ml_local_orphaned_hint:/g) || []).length;
    assert(titleCount === 3, `ml_local_orphaned_title presente nos 3 idiomas (achei ${titleCount})`, titleCount);
    assert(hintCount === 3, `ml_local_orphaned_hint presente nos 3 idiomas (achei ${hintCount})`, hintCount);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S261 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
