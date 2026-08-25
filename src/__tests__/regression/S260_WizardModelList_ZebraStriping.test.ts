/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S260
 *
 * Origem: screenshot real do usuário (2026-08-24) — a lista "Escolha um modelo pra carregar" (11
 * arquivos .gguf, cada um com um botão "▶ Usar este modelo" ao lado) não tinha nenhuma separação
 * visual entre linhas. Nomes parecidos (`gemma-4-12B-it-Q4_K_M.gguf`, `gemma-4-26B-A4B-it-
 * Q4_K_M.gguf`, `gemma-4-E4B-it-qat.Q4_K_M.gguf`) tornavam fácil clicar no botão errado.
 *
 * Primeira correção (zebra striping via classe CSS `.wizard-model-row`) foi aplicada nos dois
 * lugares que renderizavam a MESMA lista com código quase idêntico — `LocalModelWizard.js`
 * (🧭 Assistente de Configuração Rápida) e `ConfigWizard.js` (🧭 Assistente de Configuração
 * completo, aba local). O usuário apontou (DRY) que manter dois blocos de código sincronizados
 * manualmente reintroduz o mesmo risco (uma mudança futura corrigida só num dos dois).
 *
 * Segunda correção: extraído `components/LocalModelPickList.js` — renderização pura (sem estado de
 * wizard), importado pelos dois. NÃO viola a decisão documentada de manter os wizards
 * arquiteturalmente independentes (ver comentário em ConfigWizard.js sobre `formatBytes` e
 * "acoplamento sem necessidade real entre os dois wizards"): nenhum dos wizards importa o outro,
 * os dois só importam este componente-folha — mesma categoria de `Toast.js`, já importado por
 * ambos antes desta mudança. A diferença de comportamento pós-clique (cronômetro no próprio botão
 * vs. transição pra tela nova) continua inteira em cada `onPick` que o chamador passa — não foi
 * tocada.
 *
 * REGRESSÃO SE: qualquer um dos dois wizards voltar a construir a lista com `createElement`/loop
 * próprio em vez de chamar `renderModelPickList()` (reintroduz a duplicação); ou um wizard passar a
 * importar o outro diretamente (a violação que a extração foi desenhada pra evitar); ou a classe
 * `.wizard-model-row` for removida/renomeada sem o CSS acompanhar.
 *
 * Execução: npx ts-node src/__tests__/regression/S260_WizardModelList_ZebraStriping.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const CSS = fs.readFileSync(
    path.join(process.cwd(), 'src', 'dashboard', 'public', 'config', 'config.css'),
    'utf-8',
);
const PICK_LIST_PATH = path.join(process.cwd(), 'src', 'dashboard', 'public', 'config', 'components', 'LocalModelPickList.js');
const PICK_LIST = fs.readFileSync(PICK_LIST_PATH, 'utf-8');
const LOCAL_WIZARD = fs.readFileSync(
    path.join(process.cwd(), 'src', 'dashboard', 'public', 'config', 'components', 'LocalModelWizard.js'),
    'utf-8',
);
const CONFIG_WIZARD = fs.readFileSync(
    path.join(process.cwd(), 'src', 'dashboard', 'public', 'config', 'components', 'ConfigWizard.js'),
    'utf-8',
);

console.log('\n=== S260-1 — a classe de zebra striping existe e alterna cor a cada linha ===');
{
    assert(/\.wizard-model-row\s*\{/.test(CSS), '.wizard-model-row está definida em config.css');
    assert(/\.wizard-model-row:nth-child\(even\)\s*\{[^}]*background/.test(CSS),
        'linhas pares recebem background diferente das ímpares — é isso que separa visualmente cada modelo');
}

console.log('\n=== S260-2 — componente compartilhado existe, renderiza com a classe, aplica a mesma disciplina de DOM ===');
{
    assert(fs.existsSync(PICK_LIST_PATH), 'LocalModelPickList.js existe');
    assert(/export function renderModelPickList\s*\(/.test(PICK_LIST), 'exporta renderModelPickList()');
    assert(/row\.className\s*=\s*'wizard-model-row'/.test(PICK_LIST), 'as linhas usam a classe com zebra striping');
    assert(/createElement/.test(PICK_LIST) && !/\.innerHTML\s*=\s*`[^`]*\$\{m\.id\}/.test(PICK_LIST),
        'nome de arquivo (m.id) nunca entra via innerHTML de string — mesma disciplina que corrigiu o CodeQL #14');
}

console.log('\n=== S260-3 — os dois wizards CHAMAM o componente — não reconstroem a lista com loop próprio ===');
{
    assert(/import \{ renderModelPickList \} from '\.\/LocalModelPickList\.js';/.test(LOCAL_WIZARD),
        'LocalModelWizard.js importa o componente compartilhado');
    assert(/renderModelPickList\(list, state\.models, loadModel\)/.test(LOCAL_WIZARD),
        'LocalModelWizard.js chama renderModelPickList() em vez de montar a lista na mão');
    assert(!/state\.models\.forEach/.test(LOCAL_WIZARD),
        'não sobrou um loop próprio construindo a lista — a única fonte da lógica de renderização é o componente compartilhado');

    assert(/import \{ renderModelPickList \} from '\.\/LocalModelPickList\.js';/.test(CONFIG_WIZARD),
        'ConfigWizard.js importa o MESMO componente compartilhado');
    assert(/renderModelPickList\(list, models,/.test(CONFIG_WIZARD),
        'ConfigWizard.js chama renderModelPickList() em vez de montar a lista na mão');

    // Escopado a renderLocalModelSelect() especificamente — ConfigWizard.js tem OUTRA lista de
    // modelos (renderOllamaModelSelect, seleção por clique na própria linha, sem botão "usar")
    // que legitimamente continua com createElement próprio; não é a duplicação que este teste cobre.
    const start = CONFIG_WIZARD.indexOf('function renderLocalModelSelect');
    const end = CONFIG_WIZARD.indexOf('\n  function renderLocalLoading');
    const localSelectBody = CONFIG_WIZARD.slice(start, end);
    assert(!/models\.forEach\(m => \{\s*const row = document\.createElement/.test(localSelectBody),
        'não sobrou um loop próprio construindo a lista LOCAL dentro de renderLocalModelSelect especificamente');
}

console.log('\n=== S260-4 — a independência entre os dois wizards continua intacta (achado documentado, não revertido) ===');
{
    assert(!/from '\.\/ConfigWizard\.js'/.test(LOCAL_WIZARD), 'LocalModelWizard.js não importa ConfigWizard.js');
    assert(!/from '\.\/LocalModelWizard\.js'/.test(CONFIG_WIZARD), 'ConfigWizard.js não importa LocalModelWizard.js — os dois só compartilham o componente-folha, nunca um ao outro');
}

console.log('\n=== S260-5 — formatBytes duplicado (aceito antes) não sobrevive como código morto nos dois wizards ===');
{
    // Achado incidental: com a extração, formatBytes só era usado dentro do bloco de renderização
    // agora movido — sobraria como função nunca chamada em cada wizard se não fosse removida junto.
    assert(!/function formatBytes/.test(LOCAL_WIZARD), 'formatBytes não sobra como código morto em LocalModelWizard.js');
    assert(!/function formatBytes/.test(CONFIG_WIZARD), 'formatBytes não sobra como código morto em ConfigWizard.js');
    assert(/function formatBytes/.test(PICK_LIST), 'formatBytes agora vive só no componente compartilhado, que é quem realmente o usa');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S260 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
