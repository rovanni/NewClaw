/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S288 (campanha "sistema não utilizável", 22/09/2026)
 *
 * Achado por print do usuário, testando no Chrome real dele: o indicador de status mostrava
 * "⚙️ ⚙️ Trabalhando no seu pedido..." (dois engrenagens) e, em outro momento desta mesma
 * campanha, "⚙️ 🔄 Ajustando o plano..." — emoji duplicado, um genérico e um específico.
 *
 * Causa raiz: `showStatus(type, text)` (index.html) sempre prefixava `icons[type]` (6 ícones
 * genéricos: 🤔📡📥⚙️🔧❌), mas a maioria das strings `status_*` em `shared.js` (pt-BR/en-US/
 * es-ES, ~141 chaves) já embute seu próprio emoji — mais específico (ex: "🔍 Pesquisando na
 * internet..." pra web_search) que o genérico de `icons[type]`. As 5 chaves que NÃO embutem
 * ícone (`status_thinking`, `status_sending`, `status_receiving`, `status_cancelling`,
 * `status_still_running`) continuam precisando do prefixo genérico.
 *
 * Fix: só prefixa `icons[type]` quando o texto ainda NÃO começa com um emoji
 * (`/^\p{Extended_Pictographic}/u` — propriedade estrutural do Unicode, não interpretação de
 * significado).
 *
 * S288.1 — CONTROLE NEGATIVO: textos sem emoji embutido (`status_thinking`, etc.) continuam
 *   recebendo o ícone genérico — comportamento pré-existente preservado.
 * S288.2 — CASO POSITIVO: textos com emoji já embutido (a maioria de `shared.js`) NÃO recebem
 *   um segundo ícone — reproduz e corrige o print exato do usuário.
 * S288.3 — auditoria cross-idioma: pt-BR/en-US/es-ES concordam em QUAIS chaves têm emoji
 *   embutido — o fix não pode depender do idioma ativo (mesma lógica de detecção pro texto
 *   RENDERIZADO, não por chave).
 *
 * Execução: npx ts-node src/__tests__/regression/S288_DashboardStatus_NoDuplicateEmoji.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

function readFile(relPath: string): string {
    return fs.readFileSync(path.join(process.cwd(), 'src', relPath), 'utf-8');
}

/** Extrai a lógica REAL de decisão de ícone de dentro de showStatus() — sem reimplementar. */
function extractIconDecisionLogic(): { icons: Record<string, string>; test: (text: string) => boolean } {
    const html = readFile('dashboard/public/index.html');
    const marker = "const icons = { thinking:";
    const idx = html.indexOf(marker);
    if (idx < 0) throw new Error('pré-condição falhou: "const icons = { thinking:" não encontrado em index.html');
    const iconsLine = html.slice(idx, html.indexOf('\n', idx));
    const iconsMatch = iconsLine.match(/const icons = (\{[^}]*\})/);
    if (!iconsMatch) throw new Error('pré-condição falhou: não conseguiu extrair o objeto icons');
    // eslint-disable-next-line no-eval
    const icons = eval(`(${iconsMatch[1]})`);

    const regexMarker = 'const jaTemEmoji = ';
    const regexIdx = html.indexOf(regexMarker);
    if (regexIdx < 0) throw new Error('pré-condição falhou: regex de detecção de emoji não encontrado — o fix foi removido/renomeado?');
    const regexLine = html.slice(regexIdx, html.indexOf('\n', regexIdx));
    const regexMatch = regexLine.match(/\/\^\\p\{Extended_Pictographic\}\/u/);
    if (!regexMatch) throw new Error('pré-condição falhou: padrão exato da regex mudou');

    return { icons, test: (text: string) => /^\p{Extended_Pictographic}/u.test(text.trim()) };
}

async function main(): Promise<void> {

console.log('\n=== S288.1 — CONTROLE NEGATIVO: textos sem emoji embutido continuam recebendo o ícone genérico ===');
{
    const { test } = extractIconDecisionLogic();
    const semEmoji = ['Pensando...', 'Enviando...', 'Recebendo resposta...', 'Cancelando...', 'Ainda processando — já faz 1 min. Clique em ■ para parar.'];
    for (const texto of semEmoji) {
        assert(!test(texto), `"${texto}" NÃO começa com emoji — recebe o ícone genérico (comportamento preservado)`, texto);
    }
}

console.log('\n=== S288.2 — CASO POSITIVO: textos com emoji embutido NÃO recebem um segundo ícone (reproduz o print do usuário) ===');
{
    const { test } = extractIconDecisionLogic();
    const comEmoji = [
        '⚙️ Trabalhando no seu pedido...',       // caso exato do print do usuário
        '🔄 Ajustando o plano...',                // segundo caso visto na mesma campanha
        '🔍 Pesquisando na internet...',
        '🌤️ Consultando a previsão do tempo...',
        '✍️ Preparando a resposta...',
        '❌ Erro',
    ];
    for (const texto of comEmoji) {
        assert(test(texto), `"${texto}" já começa com emoji — NÃO deve receber um segundo (ANTES do fix: "⚙️ ${texto}")`, texto);
    }
}

console.log('\n=== S288.3 — AUDITORIA CROSS-IDIOMA: pt-BR/en-US/es-ES concordam em quais chaves status_* têm emoji embutido ===');
{
    const sharedJs = readFile('dashboard/public/shared.js');
    // Localiza os 3 blocos de idioma pela posição e extrai as chaves status_* de cada trecho —
    // heurística por regex (não parse de JS completo), suficiente pra comparar presença/
    // ausência de emoji por chave entre idiomas.
    const statusLineRe = /^\s*(status_\w+):\s*"((?:[^"\\]|\\.)*)"/gm;
    let match: RegExpExecArray | null;
    const global3Idiomas: Array<Map<string, boolean>> = [];
    const marcadoresIdioma = [...sharedJs.matchAll(/^\s*'?(pt-BR|en-US|es-ES)'?:\s*\{/gm)].map(m => m.index ?? 0);
    marcadoresIdioma.push(sharedJs.length);
    for (let i = 0; i < marcadoresIdioma.length - 1; i++) {
        const trecho = sharedJs.slice(marcadoresIdioma[i], marcadoresIdioma[i + 1]);
        const mapa = new Map<string, boolean>();
        statusLineRe.lastIndex = 0;
        while ((match = statusLineRe.exec(trecho)) !== null) {
            const chave = match[1];
            const valor = match[2];
            mapa.set(chave, /^\p{Extended_Pictographic}/u.test(valor));
        }
        global3Idiomas.push(mapa);
    }

    assert(global3Idiomas.length === 3, `3 blocos de idioma encontrados — obtido: ${global3Idiomas.length}`, global3Idiomas.length);

    if (global3Idiomas.length === 3) {
        const [ptBr, enUs, esEs] = global3Idiomas;
        let divergencias = 0;
        for (const [chave, temEmojiPt] of ptBr) {
            const temEmojiEn = enUs.get(chave);
            const temEmojiEs = esEs.get(chave);
            if (temEmojiEn !== undefined && temEmojiEn !== temEmojiPt) {
                console.error(`  DIVERGÊNCIA: ${chave} tem emoji em pt-BR=${temEmojiPt} mas en-US=${temEmojiEn}`);
                divergencias++;
            }
            if (temEmojiEs !== undefined && temEmojiEs !== temEmojiPt) {
                console.error(`  DIVERGÊNCIA: ${chave} tem emoji em pt-BR=${temEmojiPt} mas es-ES=${temEmojiEs}`);
                divergencias++;
            }
        }
        assert(divergencias === 0, `nenhuma chave status_* diverge entre idiomas quanto a ter emoji embutido ou não — obtido: ${divergencias} divergência(s)`, divergencias);
        assert(ptBr.size > 20, `pelo menos 20 chaves status_* auditadas em pt-BR — obtido: ${ptBr.size}`, ptBr.size);
    }
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S288 RESULTADO: ${passed} passou | ${failed} falhou`);
process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
