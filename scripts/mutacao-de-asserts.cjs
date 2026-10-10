/**
 * Operador de mutação da suíte de regressão: no helper de asserção do arquivo (`function assert(c…)` / `function check(c…)`), a
 * condição passa a ser SEMPRE falsa — toda asserção do arquivo reprova. Um teste que consegue falhar tem de terminar com exit != 0
 * sob esta mutação; um que sai com 0 está terminando antes de chegar às asserções ou não propaga o contador de falhas.
 *
 * Fonte única: usada pelo S381 (negativo controlado de P1_1/P1_2) e por scripts/auditoria-sinalizacao-de-falha.cjs (todos os arquivos).
 */
'use strict';

/**
 * Devolve a fonte mutada, ou null quando o arquivo não tem o formato `function assert|check(<params…>) { if (<param>) …` conhecido.
 * A condição pode ser QUALQUER parâmetro (ex.: `assert(c, msg)` ou `check(desc, cond, detail)`): vale o primeiro que o helper testa
 * em `if (<param>)` nas primeiras linhas do corpo.
 */
function mutarHelper(origem) {
    const m = origem.match(/(?:^|\n)(?:export\s+)?(?:async\s+)?function\s+(?:assert\w*|check)\s*\(([^)]*)\)/);
    if (!m) return null;
    const nomes = m[1].split(',').map((p) => (p.trim().match(/^(\w+)/) || [])[1]).filter(Boolean);
    const antes = origem.indexOf(m[0]);
    const corpo = origem.slice(antes);
    for (const nome of nomes) {
        const alvo = new RegExp(`if\\s*\\(\\s*${nome}\\s*\\)`);
        const achou = alvo.exec(corpo);
        if (!achou || achou.index > 700) continue;
        const pos = antes + achou.index;
        return origem.slice(0, pos) + origem.slice(pos).replace(alvo, 'if (false)');
    }
    return null;
}

module.exports = { mutarHelper };
