/**
 * duckduckgoLite — fragmentos de parsing compartilhados por quem faz scraping de
 * `lite.duckduckgo.com/lite/` (web_search.ts e web_navigate.ts).
 *
 * Achado real (26/08/2026, campanha "Web Search Coverage & Evidence Quality"): o regex de ambos
 * os consumidores buscava `class="result-link"` (aspas duplas), mas o HTML real do DuckDuckGo
 * Lite usa `class='result-link'` (aspas simples) — só nesse atributo específico; `href="..."` na
 * MESMA tag continua com aspas duplas. O regex nunca casava, então a fonte devolvia zero
 * resultados sempre, silenciosamente (nenhum erro — só uma lista vazia, indistinguível de "sem
 * resultados para esta busca").
 *
 * Fonte única: os dois consumidores dependiam do MESMO fato (como o DuckDuckGo Lite marca um
 * link de resultado) via duas cópias independentes do mesmo regex — exatamente o tipo de
 * duplicação que diverge em silêncio (aqui, as duas quebraram juntas, mas nada garantia que uma
 * correção futura tocasse as duas). Módulo neutro, sem um consumidor depender do outro.
 */

/** Casa `class="valor"` OU `class='valor'` — tolerante às duas formas válidas de HTML, para não
 *  prender de novo a um caractere de aspas específico que o site pode voltar a trocar. */
function classAttrPattern(value: string): string {
    return `class=["']${value}["']`;
}

export const DDG_RESULT_LINK_CLASS = classAttrPattern('result-link');
export const DDG_RESULT_SNIPPET_CLASS = classAttrPattern('result-snippet');
