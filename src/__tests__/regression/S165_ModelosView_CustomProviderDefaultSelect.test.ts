/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S165
 * Dashboard (ModelosView.js): <select> de "provider padrão" nunca listava providers custom
 * (LM Studio/vLLM/llamafile local) como opção — só os 6 nativos, hardcoded no HTML.
 *
 * CONTEXTO: S164 conectou customProviders ao fallback automático de verdade (ProviderFactory).
 * Mas pra escolher um provider custom como PRIMÁRIO (não só fallback de última instância) via
 * dashboard, o usuário precisa do <select id="ml-defaultProvider"> — que tinha as opções
 * ollama/gemini/openrouter/deepseek/groq/anthropic craftadas direto no template HTML, sem
 * nenhuma linha para os providers custom já cadastrados. `setDefaultProvider()` no
 * ProviderFactory já aceitava qualquer label registrada — só faltava a opção aparecer no
 * dropdown pra ser selecionável.
 *
 * FIX: populateDefaultProviderOptions() injeta uma <option data-custom-provider> por
 * customProvider, chamada ANTES de setar `.value` (senão o browser ignora silenciosamente uma
 * atribuição pra uma option que ainda não existe) e de novo sempre que customProviders mudar
 * (assinatura de configStore) — idempotente, remove as options antigas antes de reinserir.
 *
 * REGRESSÃO SE: a função for removida, deixar de rodar antes do `.value =`, ou parar de ser
 * re-chamada quando customProviders mudar (o select ficaria dessincronizado depois de
 * adicionar/remover um provider sem recarregar a página).
 *
 * EXTENSÃO (mesma investigação, pedido explícito do usuário — "liberdade de escolha" entre
 * usar o provider custom como principal ou como fallback): o <select> global já dava essa
 * liberdade arquiteturalmente, mas exigia navegar até uma seção separada da página. Cada card
 * de provider custom ganhou um botão direto ("Usar como Principal"/"Usar como Fallback") —
 * atalho de UI pro MESMO mecanismo (applyDefaultProviderChange), sem introduzir nenhum conceito
 * novo de "papel" no modelo de dados (nenhuma duplicação de fonte de verdade).
 *
 * Execução: npx ts-node src/__tests__/regression/S165_ModelosView_CustomProviderDefaultSelect.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`); failed++; }
}

const src = fs.readFileSync(
    path.join(process.cwd(), 'src', 'dashboard', 'public', 'config', 'views', 'ModelosView.js'),
    'utf-8'
);

console.log('\n=== S165 — populateDefaultProviderOptions() existe e é idempotente ===');
assert(/function populateDefaultProviderOptions\(/.test(src), 'função populateDefaultProviderOptions definida');
assert(
    /querySelectorAll\('option\[data-custom-provider\]'\)\.forEach\(opt => opt\.remove\(\)\)/.test(src),
    'remove options custom antigas antes de reinserir (idempotente — não acumula)'
);
assert(/opt\.dataset\.customProvider = 'true'/.test(src), 'marca cada option injetada com data-custom-provider (permite remover só as dele depois)');

console.log('\n=== S165 — chamada ANTES de setar .value no render inicial ===');
{
    const populateIdx = src.indexOf('populateDefaultProviderOptions(s.customProviders');
    const setValueIdx = src.indexOf("el('ml-defaultProvider').value  = s.defaultProvider");
    assert(populateIdx !== -1, 'populateDefaultProviderOptions chamada no render inicial com s.customProviders');
    assert(setValueIdx !== -1, 'atribuição de .value presente');
    assert(populateIdx !== -1 && setValueIdx !== -1 && populateIdx < setValueIdx, 'populate roda ANTES de setar .value (senão o browser ignora um valor custom ainda não presente como option)');
}

console.log('\n=== S165 — re-populada quando customProviders mudar (fica sincronizado sem reload) ===');
assert(
    /cs\.on\('customProviders', custom => \{[\s\S]{0,120}populateDefaultProviderOptions\(custom/.test(src),
    'assinatura de customProviders chama populateDefaultProviderOptions de novo'
);

console.log('\n=== S165 — botão "Usar como Principal/Fallback" nos cards de provider custom ===');
assert(/data-use-as-primary="\$\{esc\(p\.label\)\}"/.test(src), 'botão "usar como principal" presente em cada card, com o label correto');
assert(/data-use-as-fallback="\$\{esc\(p\.label\)\}"/.test(src), 'botão "usar como fallback" presente quando já é o principal');
assert(/function applyDefaultProviderChange\(prov\)/.test(src), 'applyDefaultProviderChange() existe — ponto único que muda o provider padrão');
assert(
    /el\('ml-defaultProvider'\)\.addEventListener\('change', e => \{\s*applyDefaultProviderChange\(e\.target\.value\);/.test(src),
    'o <select> "Provider padrão" usa a MESMA função applyDefaultProviderChange (não duplica lógica)'
);
// O que importa é que o clique passe pela MESMA função (sem lógica duplicada), não a linha exata
// em que ela aparece dentro do bloco: em 02/08/2026 um showToast passou a vir antes da chamada
// (para que o aviso de "modelos reajustados" não fosse sobrescrito na tela) e o padrão anterior,
// que exigia a chamada colada ao `if`, quebrou sem que nada do comportamento tivesse mudado.
assert(
    /dataset\.useAsPrimary;\s*if \(useAsPrimary\) \{[\s\S]{0,700}applyDefaultProviderChange\(useAsPrimary\)/.test(src),
    'clique em "usar como principal" chama applyDefaultProviderChange com o label do card'
);
// S179 (Sprint 1): a janela deixou de exigir a chamada COLADA ao `{` — instrumentação
// (`logAcaoUI`) passou a preceder a ação. O que este teste garante é que o clique chama
// `applyDefaultProviderChange` com o argumento certo, não a distância entre as duas linhas;
// fixar a distância já tinha quebrado antes por uma mudança que não alterou comportamento algum
// (ver o comentário logo acima).
assert(
    /dataset\.useAsFallback;\s*if \(useAsFallback\) \{[\s\S]{0,300}applyDefaultProviderChange\('ollama'\)/.test(src),
    "clique em \"usar como fallback\" volta o principal pro Ollama (não existe estado \"sem principal\")"
);
// Idempotência/sincronia: applyDefaultProviderChange precisa re-renderizar os cards depois de
// mudar o provider padrão, senão os badges "Principal"/botões ficam desatualizados até reload.
assert(
    // Janela ampliada: a função ganhou o realinhamento dos modelos por categoria ao trocar de
    // provider (02/08/2026) e passou dos 400 chars. Continua sendo a mesma garantia — a
    // re-renderização acontece dentro desta função, não em cada call site.
    /function applyDefaultProviderChange\(prov\) \{[\s\S]{0,1200}renderProviderGrid\(\)/.test(src),
    'applyDefaultProviderChange() chama renderProviderGrid() — badges/botões ficam sincronizados sem reload'
);

console.log(`\n${'─'.repeat(60)}`);
console.log(`S165 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exit(1);
