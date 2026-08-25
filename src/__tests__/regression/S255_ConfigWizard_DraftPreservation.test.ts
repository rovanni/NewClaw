/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S255
 *
 * Sprint FQ — Preservação de entrada durante falha de validação (2026-08-23), aberta pelo QA
 * FINAL independente (`.gstack/qa-reports/qa-report-configwizard-FINAL-2026-08-23.md`,
 * ISSUE-FQ-001) depois de C1–C7. Achado: em 3 famílias independentes (Modelo Local, Ollama,
 * Custom), depois de uma validação falhar, o campo de texto revertia pro valor salvo antigo ou
 * ficava vazio — nunca preservava o que a pessoa tinha acabado de digitar, mesmo a mensagem de
 * erro citando corretamente o que foi testado.
 *
 * INVESTIGAÇÃO (antes de qualquer correção, como exigido pela diretriz do projeto):
 *
 * Rastreados dois mecanismos DIFERENTES convergindo no mesmo sintoma visível — não eram 3 bugs
 * independentes, mas também não era uma única causa idêntica repetida 3 vezes:
 *
 * 1. Ollama (`testOllamaConnection`, antes da correção): chamava `render()` — que reconstrói
 *    `<input id="ml-cw-ollamaUrl">` do zero a partir de `configStore.get('ollamaUrl')` — ANTES de
 *    ler `document.getElementById('ml-cw-ollamaUrl').value`. A leitura, portanto, lia de volta o
 *    <input> RECÉM-recriado com o valor antigo, não o que a pessoa tinha acabado de digitar. Bug
 *    de ORDEM: render-antes-de-ler.
 * 2. Custom (`testCustomEndpoint`) e Local (`testLocalFolder`): liam o DOM na ordem certa (antes
 *    de `render()`), capturando o valor digitado numa variável local — mas só gravavam esse valor
 *    em `session`/`configStore` no caminho de SUCESSO. No caminho de erro, a variável local era
 *    descartada ao fim da função, e o próximo `render()` não tinha de onde recuperá-la — caía pro
 *    valor persistido antigo (Local) ou para string vazia (Custom, que só grava `session.customLabel`
 *    no sucesso). Bug de FALTA-DE-PERSISTÊNCIA-TRANSITÓRIA, não de ordem.
 *
 * CORREÇÃO ESTRUTURAL (não 3 correções pontuais): `WizardSession` ganhou um campo `draft` —
 * quarta categoria além de `persistido` (configStore) / `confirmado` (evidence) / já existente —
 * representando literalmente "o que está digitado agora, ainda não testado". Populado por
 * `bindDraft(id, key)` a cada tecla (nunca via `render()`), lido por TODO render*()/test*()/
 * confirm*() em vez do DOM ou de configStore. Isso elimina o bug de ordem (a leitura não depende
 * mais de quando `render()` roda) e o bug de falta-de-persistência (o valor já está em `session`
 * antes mesmo do clique em testar, então erro ou sucesso não fazem diferença pra ele sobreviver).
 *
 * Também resolve a aparente contradição entre C7 (S253-4: "campo de pasta local sem <label>,
 * corrigido") e o QA final ("nenhum <label> tem associação for/id"): as duas evidências eram
 * verdadeiras ao mesmo tempo sobre coisas DIFERENTES — C7 verificou "existe <label>?" (7/7 depois
 * da correção), o QA final verificou "esse <label> está associado ao campo via for/id?" (0/7,
 * nenhuma das duas rodadas tinha testado isso antes). Corrigido aqui: os 7 <label> agora têm
 * for="<id-do-input>".
 *
 * Verifica:
 * 1. `createWizardSession()` inicializa `draft: {}`.
 * 2. `back()` no branch de reset pra 'choose' também zera `draft` (mesmo risco de vazamento entre
 *    providers que já motivou zerar evidence/selectedModel).
 * 3. Os 7 campos (ollamaUrl, ollamaKey, customLabel, customUrl, customKey, localDir, nativeKey)
 *    têm seu <input> lendo de `session.draft` no value= E um `bindDraft()` chamado pro mesmo id.
 * 4. Os 4 test*()/confirm*() (testOllamaConnection, testCustomEndpoint, testLocalFolder,
 *    confirmNativeCredential) leem de `session.draft`, nunca de `document.getElementById(...).value`
 *    dentro do próprio corpo da função.
 * 5. O preset de Custom (clique no chip) atualiza `session.draft` além do `.value` do DOM — sem
 *    isto, um preset seguido de uma falha ainda perderia o valor (mesmo bug, caminho diferente).
 * 6. ISSUE-FQ-004: os 7 <label> têm for="" apontando pro id do campo correspondente.
 * 7. Achado ao vivo depois do envio pro ambiente real (mesmo dia): a própria correção acima tinha
 *    um ponto cego — `session.draft` só era escrito pelo evento 'input', então um campo PRÉ-preenchido
 *    pelo sistema (pasta já salva, URL padrão, reconfigurar um Custom já existente) nunca semeava o
 *    draft, ficando undefined mesmo com o campo visualmente preenchido. Um usuário real com a pasta
 *    já certa clicou "Buscar modelos" sem editar nada e o clique não fez nada — "Próximo" travado em
 *    silêncio. Corrigido com `??=` no início de cada render*(), semeando o draft com o valor exibido
 *    sem sobrescrever uma edição já em andamento.
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

console.log('\n=== S255-1 — createWizardSession() inicializa draft: {} ===');
{
    const fn = CW.slice(CW.indexOf('function createWizardSession()'), CW.indexOf('function stepsFor('));
    assert(/draft:\s*\{\},/.test(fn), 'createWizardSession() retorna um objeto com draft: {}', fn);
}

console.log('\n=== S255-2 — back() zera draft ao voltar pra choose (mesmo risco de vazamento entre providers) ===');
{
    const fn = CW.slice(CW.indexOf('function back(session)'), CW.indexOf('function esc('));
    assert(
        /if \(steps\[idx - 1\] === 'choose'\) \{\s*return \{[\s\S]{0,200}?draft: \{\}[\s\S]{0,40}?\};/.test(fn),
        'back() ao branch de reset pra choose inclui draft: {} no objeto retornado',
        fn,
    );
}

console.log('\n=== S255-3 — todos os 7 campos leem de session.draft e têm bindDraft() ===');
{
    const fields: Array<[string, string]> = [
        ['ml-cw-ollamaUrl', 'ollamaUrl'],
        ['ml-cw-ollamaKey', 'ollamaKey'],
        ['ml-cw-customLabel', 'customLabel'],
        ['ml-cw-customUrl', 'customUrl'],
        ['ml-cw-customKey', 'customKey'],
        ['ml-cw-localDir', 'localDir'],
        ['ml-cw-nativeKey', 'nativeKey'],
    ];
    for (const [id, key] of fields) {
        assert(
            new RegExp(`id="${id}"[^>]*value="\\$\\{esc\\(session\\.draft\\.${key}`).test(CW)
            || new RegExp(`value="\\$\\{esc\\(session\\.draft\\.${key}[^"]*"[^>]*id="${id}"`).test(CW),
            `#${id} lê value= de session.draft.${key}`,
        );
        assert(
            new RegExp(`bindDraft\\('${id}', '${key}'\\)`).test(CW),
            `bindDraft('${id}', '${key}') é chamado no render correspondente`,
        );
    }
}

console.log('\n=== S255-4 — os 4 test*()/confirm*() leem de session.draft, nunca do DOM, dentro do próprio corpo ===');
{
    const fns: Array<[string, string, string]> = [
        ['async function testOllamaConnection()', 'function renderCustomEndpoint(', 'testOllamaConnection'],
        ['async function testCustomEndpoint()', 'function renderLocalFolder(', 'testCustomEndpoint'],
        ['async function testLocalFolder()', 'function renderCredential(', 'testLocalFolder'],
        ['async function confirmNativeCredential()', 'function renderStub(', 'confirmNativeCredential'],
    ];
    for (const [startMarker, endMarker, name] of fns) {
        const start = CW.indexOf(startMarker);
        const fn = CW.slice(start, CW.indexOf(endMarker, start));
        assert(
            /session\.draft\./.test(fn),
            `${name}() lê de session.draft`,
        );
        assert(
            !/document\.getElementById\('ml-cw-(ollamaUrl|ollamaKey|customLabel|customUrl|customKey|localDir|nativeKey)'\)\?\.value/.test(fn),
            `${name}() não lê .value de nenhum dos 7 campos via DOM`,
            fn,
        );
    }
}

console.log('\n=== S255-5 — preset de Custom atualiza session.draft, não só o .value do DOM ===');
{
    const fn = CW.slice(CW.indexOf("chip.addEventListener('click'"), CW.indexOf('presetsEl.appendChild(chip)'));
    assert(
        /session\.draft\.customLabel = p\.label;/.test(fn) && /session\.draft\.customUrl = p\.baseUrl;/.test(fn),
        'clique num preset também grava em session.draft.customLabel/customUrl, não só no .value do DOM',
        fn,
    );
}

console.log('\n=== S255-6 — ISSUE-FQ-004: os 7 <label> têm for= associado ao id do campo correspondente ===');
{
    const fields = ['ml-cw-ollamaUrl', 'ml-cw-ollamaKey', 'ml-cw-customLabel', 'ml-cw-customUrl', 'ml-cw-customKey', 'ml-cw-localDir', 'ml-cw-nativeKey'];
    for (const id of fields) {
        assert(
            new RegExp(`<label class="form-label" for="${id}">`).test(CW),
            `<label for="${id}"> existe (associação programática, não só proximidade visual)`,
        );
    }
}

console.log('\n=== S255-7 — achado ao vivo no ambiente real (2026-08-23): draft semeado com o valor pré-preenchido, não só o que foi digitado ===');
{
    // Regressão da própria Sprint FQ: session.draft só era escrito pelo evento 'input' (bindDraft) —
    // um campo pré-preenchido pelo PRÓPRIO SISTEMA (pasta já salva de config anterior, URL padrão,
    // reconfigurar um Custom já existente) nunca dispara 'input', então session.draft.<campo> ficava
    // undefined mesmo com o campo visualmente preenchido. Resultado ao vivo: usuário real com a pasta
    // JÁ CERTA (D:\IA\IA_Offline\models) clicou "Buscar modelos" sem editar o campo — a função lia
    // dir='' (não o que estava na tela) e não fazia nada, travando "Próximo" em silêncio. Corrigido
    // semeando o draft com `??=` no início de cada render*() — só preenche se ainda não houver draft
    // (não sobrescreve o que o usuário já digitou), então tanto o valor pré-preenchido quanto uma
    // edição do usuário sobrevivem igualmente a partir daí.
    const seeds: Array<[string, string, string, RegExp]> = [
        ['renderLocalFolder', 'function renderLocalFolder(', 'async function testLocalFolder(', /session\.draft\.localDir \?\?= currentDir;/],
        ['renderOllamaConfig', 'function renderOllamaConfig(', 'async function testOllamaConnection(', /session\.draft\.ollamaUrl \?\?= currentUrl;/],
        ['renderCustomEndpoint', 'function renderCustomEndpoint(', 'async function testCustomEndpoint(', /session\.draft\.customLabel \?\?= session\.customLabel \?\? '';[\s\S]{0,80}session\.draft\.customUrl \?\?= session\.evidence\.baseUrl \?\? '';/],
    ];
    for (const [name, startMarker, endMarker, re] of seeds) {
        const start = CW.indexOf(startMarker);
        const fn = CW.slice(start, CW.indexOf(endMarker, start));
        assert(re.test(fn), `${name}() semeia session.draft com ??= antes de montar o <input> (não sobrescreve edição já em andamento)`, fn);
    }
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S255 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exit(1);
