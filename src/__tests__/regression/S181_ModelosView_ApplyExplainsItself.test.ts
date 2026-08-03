/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S181 (Sprint 3)
 * O Aplicar responde: quando não faz nada, diz por quê — e uma verificação de rede não pode
 * pendurar o salvamento.
 *
 * CONTEXTO (relato do operador, 02/08/2026): "os botões não respondem".
 *
 * O QUE ERA, DE FATO: `rt-applyBtn` nasce `disabled` e só é habilitado quando existe uma seleção
 * pendente DIFERENTE do modelo já aplicado (`showPending`). Duas situações distintas levavam ao
 * mesmo botão cinza, e nenhuma delas era explicada:
 *   (a) nada selecionado;
 *   (b) a linha clicada JÁ é o modelo aplicado naquela categoria — então clicar parecia não
 *       surtir efeito nenhum.
 * Um botão desabilitado sem explicação é indistinguível de um botão quebrado.
 *
 * `rt-applyAllBtn`, por outro lado, NÃO é desabilitado (aplicar a todos o modelo já vigente é
 * ação legítima) e saía por um `return` mudo quando não havia modelo algum — silêncio total.
 *
 * ENDURECIMENTO NO MESMO SPRINT: `doSave()` chama `modelExists()` uma vez por modelo
 * configurado, em série, e a chamada não tinha teto de espera. Com um provedor fora do ar
 * (llamafile, `fetch failed` de minuto em minuto no audit log), essa é uma classe real de
 * travamento do salvamento. E o `catch` devolvia `false` — afirmava "o modelo não existe" a
 * partir de uma falha em VERIFICAR, o que fazia a interface oferecer baixar um modelo que podia
 * já estar instalado. Falha de verificação não é evidência de ausência.
 *
 * REGRESSÃO SE: o botão voltar a ficar cinza sem explicação; se o "usar para tudo" voltar a sair
 * calado; se `modelExists` perder o timeout; ou se voltar a tratar erro de rede como "não
 * existe".
 *
 * Execução: npx ts-node src/__tests__/regression/S181_ModelosView_ApplyExplainsItself.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const P = (...p: string[]) => path.join(process.cwd(), 'src', 'dashboard', 'public', 'config', ...p);
const API = fs.readFileSync(P('api.js'), 'utf-8');
const APP = fs.readFileSync(P('app.js'), 'utf-8');
const MODELOS = fs.readFileSync(P('views', 'ModelosView.js'), 'utf-8');
const SHARED = fs.readFileSync(path.join(process.cwd(), 'src', 'dashboard', 'public', 'shared.js'), 'utf-8');

console.log('\n=== S181-1 — o botão cinza explica a si mesmo, nas DUAS razões ===');
{
    assert(
        /applyBtn\.title = showPending\s*\?\s*''\s*:\s*\(routingPendingModel/.test(MODELOS),
        'o motivo depende de haver ou não seleção — as duas situações são distinguidas',
    );
    assert(
        /t\('ml_routing_apply_why_same', \{ model: routingPendingModel \}\)/.test(MODELOS),
        'caso (b): diz que o modelo escolhido já é o aplicado, nomeando-o',
    );
    assert(
        /t\('ml_routing_apply_why_nosel'\)/.test(MODELOS),
        'caso (a): diz que falta selecionar',
    );
    assert(
        /<div class="form-hint" id="rt-applyHint"/.test(MODELOS),
        'a explicação tem lugar VISÍVEL, não só no title — a maioria não passa o mouse',
    );
    assert(
        /applyHint\.textContent = applyBtn && applyBtn\.disabled \? applyBtn\.title : ''/.test(MODELOS),
        'a linha visível some quando o botão está habilitado',
    );
}

console.log('\n=== S181-2 — "usar para tudo" não sai mais calado ===');
{
    const bloco = MODELOS.slice(MODELOS.indexOf("logAcaoUI('usar-para-tudo', 'NADA FEITO"), MODELOS.indexOf("logAcaoUI('usar-para-tudo', 'NADA FEITO") + 500);
    assert(
        /showToast\(t\('ml_routing_apply_why_nosel'\), 'warn'\)/.test(bloco),
        'avisa na tela, não só no console — console não serve para o operador',
    );
}

console.log('\n=== S181-3 — verificação de rede tem teto de espera ===');
{
    assert(
        /const TIMEOUT_VERIFICACAO_MS = \d+;/.test(API),
        'o teto é uma constante nomeada, não um número solto',
    );
    assert(
        /new AbortController\(\)/.test(API) && /signal: ctrl\.signal/.test(API),
        'a requisição é abortável e o sinal é de fato passado',
    );
    assert(
        /\} finally \{\s*clearTimeout\(timer\);\s*\}/.test(API),
        'o timer é limpo em qualquer desfecho — sucesso, erro ou abort',
    );
}

console.log('\n=== S181-4 — falha em verificar não vira "não existe" ===');
{
    const fn = API.slice(API.indexOf('export async function modelExists'), API.indexOf('export async function addModel'));
    assert(/return null;/.test(fn), 'o catch devolve null = "não foi possível verificar"');
    assert(!/catch \{ return false; \}/.test(fn), 'não volta a afirmar ausência a partir de um erro');
    assert(
        /if \(exists === false\) \{/.test(APP),
        'quem consome só age no `false` explícito — null (desconhecido) não dispara download',
    );
    assert(
        !/const exists = await modelExists\(model\);\s*if \(!exists\) \{/.test(APP),
        'o teste frouxo `!exists` (que trata null como ausência) não voltou',
    );
}

console.log('\n=== S181-5 — todo módulo do painel PARSEIA como módulo ES ===');
{
    // Achado ao validar este próprio sprint: um comentário HTML dentro de um template literal
    // continha crases (`title`), que fecharam a string e quebraram o arquivo. A tela inteira caiu
    // com "Erro ao carregar view: Unexpected identifier 'title'" — e `node --check` NÃO pegou,
    // porque parseia .js como script, não como módulo. A suíte passou 179/181 com o painel
    // quebrado. Esta guarda fecha esse ponto cego para todos os módulos da pasta pública.
    const { execFileSync } = require('child_process') as typeof import('child_process');
    const os = require('os') as typeof import('os');
    const raiz = path.join(process.cwd(), 'src', 'dashboard', 'public');

    const arquivos: string[] = [];
    (function varrer(dir: string) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) varrer(full);
            else if (e.name.endsWith('.js')) arquivos.push(full);
        }
    })(raiz);

    assert(arquivos.length > 0, `encontrou módulos para checar (${arquivos.length})`);

    const quebrados: string[] = [];
    for (const arq of arquivos) {
        // .mjs força o parser de módulo — é a diferença que deixou o bug passar.
        const tmp = path.join(os.tmpdir(), `s181-${path.basename(arq)}.mjs`);
        fs.copyFileSync(arq, tmp);
        try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); }
        catch { quebrados.push(path.relative(raiz, arq)); }
        finally { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
    }
    assert(quebrados.length === 0, `todos os ${arquivos.length} módulos parseiam`, quebrados);
}

console.log('\n=== S181-6 — textos nos 3 idiomas ===');
{
    for (const chave of ['ml_routing_apply_why_nosel', 'ml_routing_apply_why_same']) {
        const n = (SHARED.match(new RegExp(`${chave}:`, 'g')) ?? []).length;
        assert(n === 3, `'${chave}' presente nos 3 idiomas (encontradas: ${n})`);
    }
    assert(
        /\{model\}/.test(SHARED.slice(SHARED.indexOf('ml_routing_apply_why_same'), SHARED.indexOf('ml_routing_apply_why_same') + 200)),
        'a mensagem interpola o nome do modelo em vez de falar em abstrato',
    );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S181 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
console.log(`\nCOBERTURA:`);
console.log(`  Botão desabilitado explica as 2 razões: testado`);
console.log(`  Explicação visível, não só no title: testado`);
console.log(`  "Usar para tudo" avisa na tela: testado`);
console.log(`  Timeout na verificação de rede: testado`);
console.log(`  Erro de rede não vira "não existe": testado`);
if (failed > 0) process.exit(1);
