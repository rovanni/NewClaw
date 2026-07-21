/**
 * decodeHtmlEntities — decodifica entidades HTML numa string de texto extraído de página web.
 *
 * Consolidado de duas implementações idênticas (web_navigate.ts, web_search.ts). A ordem dos
 * replaces importa: `&amp;` tem que ser o ÚLTIMO a decodificar, não o primeiro (CodeQL
 * js/double-escaping). Um input duplamente escapado como `&amp;lt;script&amp;gt;` é o que um
 * navegador mostra como texto literal `&lt;script&gt;` (decodifica &amp;→& uma vez só). Se
 * `&amp;` decodifica PRIMEIRO, `&amp;lt;` vira `&lt;` a meio da mesma passada de replaces, e o
 * replace de `&lt;` (que roda DEPOIS, na mesma cadeia) processa esse `&lt;` recém-criado de novo,
 * produzindo `<` — reconstruindo uma tag real a partir de um texto que deveria permanecer
 * literal. Decodificar `&amp;` por último elimina essa classe de bug: as entidades específicas
 * (`&lt;`, `&gt;`, ...) já não têm mais `&amp;` sequences pra confundir a passada final.
 */
export function decodeHtmlEntities(input: string): string {
    return input
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
        .replace(/&amp;/g, '&');
}
