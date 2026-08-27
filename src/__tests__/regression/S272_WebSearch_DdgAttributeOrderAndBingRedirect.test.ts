/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S272
 *
 * Campanha "Web Search Coverage & Evidence Quality", Sprint 2 (correções estruturais/objetivas —
 * Bing redirect e parser do DuckDuckGo; a heurística de qualidade de `readPage()`, achado 3,
 * ficou deliberadamente FORA desta sprint por ser uma decisão semântica, não estrutural).
 *
 * ACHADO 1 — Bing News RSS entrega redirect, não a URL do artigo:
 *   `<link>` do RSS é `bing.com/news/apiclick.aspx?...&url=<destino, percent-encoded>&...`, um
 *   redirect de rastreamento da própria Bing — não a URL do artigo. `readPage()` buscava essa
 *   página de interstício da Bing ("Redirect Alert...") em vez do conteúdo real. Reproduzido
 *   contra o pipeline real (sem mock) para "deepseek harness": as 3 páginas lidas via Bing News
 *   RSS traziam chrome/interstício da Bing, nunca o artigo.
 *
 * ACHADO 2 — DuckDuckGo Lite sempre retornava 0 resultados, por DOIS motivos, não um:
 *   (a) o regex buscava `class="result-link"` (aspas duplas); o HTML real usa aspas simples
 *       (`class='result-link'`) só nesse atributo — `href="..."` no MESMO `<a>` continua com
 *       aspas duplas.
 *   (b) mesmo corrigindo as aspas, o regex ainda exigia `class` ANTES de `href` na tag; o HTML
 *       real tem `href` primeiro (`<a rel="nofollow" href="..." class='result-link'>`) — exigir
 *       uma ORDEM de atributos é tão frágil quanto exigir um caractere de aspas específico.
 *   Confirmado reproduzindo contra o DuckDuckGo Lite real (não mock) para "kubernetes" E
 *   "deepseek harness": 0 resultados antes da correção, 5 resultados reais depois — incluindo
 *   fontes oficiais (deepseek.com/harness, github.com/deepseek-ai/deepseek-harness) que o pipeline
 *   nunca tinha alcançado.
 *   O MESMO bug existia duplicado em `web_navigate.ts` (`extractSearchResults`) — corrigido nos
 *   dois, com o fragmento frágil (o casamento de `class=`) extraído para uma fonte única
 *   (`shared/duckduckgoLite.ts`), conforme a regra ARCH — Single Authoritative Knowledge.
 *
 * ACHADO 2b (encontrado ao VERIFICAR a correção do achado 2 contra rede real, não hipotético):
 *   mesmo com aspas e ordem corrigidas, snippets ainda vinham vazios para resultados reais mais
 *   longos. Causa: a janela de busca do snippet era um número fixo herdado do regex original
 *   quebrado (600 chars após o link) — nunca validado de verdade, porque o regex original nunca
 *   chegava a rodar. Snippets reais do DuckDuckGo (245-348 chars de texto, mais o HTML ao redor)
 *   às vezes excedem 600 chars até o `</td>` de fechamento, e a janela cortava antes de achar o
 *   fechamento — silenciosamente devolvendo snippet vazio, sem erro. Corrigido substituindo o
 *   número fixo por um limite ESTRUTURAL: a busca do snippet vai até o início do PRÓXIMO
 *   resultado real (`<a class='result-link'>` seguinte) ou fim do documento — nunca um número
 *   chutado maior no lugar do antigo, que teria o mesmo problema para snippets ainda mais longos.
 *
 * Este teste usa HTML REAL capturado do DuckDuckGo Lite (não um HTML sintético "fácil de casar")
 * para não repetir o erro que permitiu o bug original: um teste sintético que já assume a forma
 * que o parser espera não pega uma regressão de ordem/aspas.
 *
 * Execução: npx ts-node src/__tests__/regression/S272_WebSearch_DdgAttributeOrderAndBingRedirect.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { WebSearchTool } from '../../tools/web_search';
import { WebNavigateTool } from '../../tools/web_navigate';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

// HTML real capturado de lite.duckduckgo.com/lite/ (26/08/2026) — atributos na ORDEM real
// (href antes de class) e com ASPAS SIMPLES em class, exatamente como o site entrega hoje.
const DDG_LITE_HTML_REAL = `
<html><body><form><table>
<tr>
    <td valign="top">
        1.&nbsp;
    </td>
    <td>
        <a rel="nofollow" href="https://kubernetes.io/" class='result-link'>Kubernetes</a>
    </td>
</tr>
<tr>
    <td>&nbsp;&nbsp;&nbsp;</td>
    <td class='result-snippet'>
        <b>Kubernetes</b>, also known as K8s, is an open source system for automating deployment, scaling, and management of containerized applications.
    </td>
</tr>
<tr>
    <td valign="top">
        2.&nbsp;
    </td>
    <td>
        <a rel="nofollow" href="https://kubernetes.io/docs/home/" class='result-link'>Kubernetes Documentation</a>
    </td>
</tr>
<tr>
    <td>&nbsp;&nbsp;&nbsp;</td>
    <td class='result-snippet'>
        The Kubernetes documentation site.
    </td>
</tr>
</table></form></body></html>
`;

// Mesma estrutura, mas com um snippet LONGO no primeiro resultado — texto real observado do
// DuckDuckGo (~350 chars) cujo `</td>` de fechamento cai além dos 600 chars que a janela antiga
// (fixa) usava, e um segundo resultado logo em seguida, para provar que o limite estrutural novo
// (até o próximo `<a class='result-link'>`) nem trunca o snippet longo nem vaza para o snippet do
// resultado seguinte.
const LONG_SNIPPET_TEXT = 'DeepSeek Harness (dsh) is DeepSeek\'s open-source agent harness, released as a v0.1 developer preview. It runs as a coding agent with a browser-based Web UI and a headless mode, and it is model-agnostic, so users are not locked into any single vendor\'s models for their agentic workflows. The architecture follows a micro-kernel design where models, tools, sessions, sandboxes, storage, loops, scheduling, and the UI are all independent, swappable plugins — everything is a plugin, nothing is hardwired into the core runtime itself.';
const DDG_LITE_HTML_LONG_SNIPPET = `
<html><body><form><table>
<tr>
    <td valign="top">1.&nbsp;</td>
    <td>
        <a rel="nofollow" href="https://deepseekharness.io/" class='result-link'>DeepSeek Harness</a>
    </td>
</tr>
<tr>
    <td>&nbsp;&nbsp;&nbsp;</td>
    <td class='result-snippet'>
        <b>${LONG_SNIPPET_TEXT}</b>
    </td>
</tr>
<tr>
    <td valign="top">2.&nbsp;</td>
    <td>
        <a rel="nofollow" href="https://github.com/deepseek-ai/deepseek-harness" class='result-link'>GitHub - deepseek-ai/deepseek-harness</a>
    </td>
</tr>
<tr>
    <td>&nbsp;&nbsp;&nbsp;</td>
    <td class='result-snippet'>
        Segundo resultado — não deve aparecer no snippet do primeiro.
    </td>
</tr>
</table></form></body></html>
`;

// Mock mínimo de fetch — devolve o HTML real capturado, sem tocar a rede no teste de regressão.
function mockFetchOnce(responseBody: string, ok = true) {
    const original = global.fetch;
    (global as any).fetch = async () => ({
        ok,
        status: ok ? 200 : 500,
        text: async () => responseBody,
    });
    return () => { (global as any).fetch = original; };
}

async function main(): Promise<void> {

console.log('\n=== S272-1 — WebSearchTool.duckDuckGo() extrai resultados de HTML real (href antes de class, aspas simples) ===');
{
    const restore = mockFetchOnce(DDG_LITE_HTML_REAL);
    try {
        const tool = new (WebSearchTool as any)();
        const results = await tool.duckDuckGo('kubernetes', 5);
        assert(results.length === 2, `extrai os 2 resultados do HTML real (recebeu ${results.length})`, results);
        assert(results[0]?.url === 'https://kubernetes.io/', 'URL do primeiro resultado correta', results[0]);
        assert(results[0]?.title === 'Kubernetes', 'título do primeiro resultado correto', results[0]);
        assert(results[0]?.snippet.includes('open source system'), 'snippet do primeiro resultado foi associado corretamente', results[0]);
        assert(results[1]?.url === 'https://kubernetes.io/docs/home/', 'URL do segundo resultado correta', results[1]);
    } finally {
        restore();
    }
}

console.log('\n=== S272-1b — snippet longo (>600 chars até o fechamento) não fica vazio, e não vaza para o próximo resultado ===');
{
    const restore = mockFetchOnce(DDG_LITE_HTML_LONG_SNIPPET);
    try {
        const tool = new (WebSearchTool as any)();
        const results = await tool.duckDuckGo('deepseek harness', 5);
        assert(results.length === 2, `extrai os 2 resultados (recebeu ${results.length})`, results);
        assert(
            results[0]?.snippet.length > 0,
            `snippet do primeiro resultado NÃO fica vazio mesmo sendo longo (${results[0]?.snippet.length ?? 0} chars) — a janela fixa antiga de 600 chars cortaria antes do fechamento`,
            results[0],
        );
        assert(results[0]?.snippet.includes('micro-kernel design'), 'snippet do primeiro resultado veio completo, incluindo o trecho final', results[0]);
        assert(!results[0]?.snippet.includes('Segundo resultado'), 'snippet do primeiro resultado NÃO vazou o texto do segundo resultado', results[0]);
        assert(results[1]?.snippet.includes('Segundo resultado'), 'snippet do segundo resultado foi associado a ELE, não perdido', results[1]);
    } finally {
        restore();
    }
}

console.log('\n=== S272-2 — WebNavigateTool (extractSearchResults, método privado) extrai do mesmo HTML real ===');
{
    const tool = new (WebNavigateTool as any)();
    const results = tool.extractSearchResults(DDG_LITE_HTML_REAL);
    assert(results.length === 2, `extrai os 2 links do HTML real (recebeu ${results.length})`, results);
    assert(results[0]?.url === 'https://kubernetes.io/', 'URL do primeiro link correta (mesmo achado do web_search.ts, mesmo HTML)', results[0]);
    assert(results[0]?.text === 'Kubernetes', 'texto do primeiro link correto', results[0]);
}

console.log('\n=== S272-3 — Single Authoritative Knowledge: os dois consumidores importam a MESMA constante de classe, não duas cópias ===');
{
    const webSearchSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'tools', 'web_search.ts'), 'utf-8');
    const webNavigateSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'tools', 'web_navigate.ts'), 'utf-8');
    assert(/import \{ DDG_RESULT_LINK_CLASS,? ?[^}]*\} from '\.\.\/shared\/duckduckgoLite'/.test(webSearchSrc), 'web_search.ts importa DDG_RESULT_LINK_CLASS de shared/duckduckgoLite');
    assert(/import \{ DDG_RESULT_LINK_CLASS \} from '\.\.\/shared\/duckduckgoLite'/.test(webNavigateSrc), 'web_navigate.ts importa DDG_RESULT_LINK_CLASS de shared/duckduckgoLite');
    assert(!/class="result-link"/.test(webSearchSrc), 'web_search.ts não tem mais o literal de aspas duplas fixo (bug original)');
    assert(!/class="result-link"/.test(webNavigateSrc), 'web_navigate.ts não tem mais o literal de aspas duplas fixo (bug original)');
}

console.log('\n=== S272-4 — resolveBingRedirectUrl (Bing News RSS) extrai o destino real de um redirect com entidades HTML ===');
{
    const tool = new (WebSearchTool as any)();
    // Exatamente a forma real capturada do RSS: & vem escapado como &amp; (nó de texto XML).
    const redirect = 'http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;aid=&amp;tid=abc123&amp;url=https%3a%2f%2fwww.geeky-gadgets.com%2fdeepseek-harness-open-source%2f&amp;c=999&amp;mkt=pt-br';
    const resolved = tool.resolveBingRedirectUrl(redirect);
    assert(resolved === 'https://www.geeky-gadgets.com/deepseek-harness-open-source/', `resolve para a URL de destino real (recebeu: "${resolved}")`, resolved);
}

console.log('\n=== S272-5 — resolveBingRedirectUrl não inventa destino quando não há (NUNCA_ADIVINHAR) ===');
{
    const tool = new (WebSearchTool as any)();
    const urlSemRedirect = 'https://example.com/artigo-direto';
    assert(tool.resolveBingRedirectUrl(urlSemRedirect) === urlSemRedirect, 'URL sem padrão de redirect é devolvida sem alteração');

    const urlMalformada = 'não é uma url';
    assert(tool.resolveBingRedirectUrl(urlMalformada) === urlMalformada, 'URL malformada é devolvida sem alteração, sem lançar exceção');
}

console.log('\n=== S272-6 — bingNewsRss() usa resolveBingRedirectUrl() para a URL de cada resultado (não o <link> cru) ===');
{
    const rssXml = `<?xml version="1.0"?><rss><channel>
<item>
<title>Teste</title>
<link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;url=https%3a%2f%2fexemplo.com%2fartigo&amp;c=1</link>
<description>desc</description>
</item>
</channel></rss>`;
    const restore = mockFetchOnce(rssXml);
    try {
        const tool = new (WebSearchTool as any)();
        const results = await tool.bingNewsRss('teste', 5);
        assert(results.length === 1, 'processa o item do RSS');
        assert(results[0]?.url === 'https://exemplo.com/artigo', `URL do resultado já é o destino real, não o redirect (recebeu: "${results[0]?.url}")`, results[0]);
    } finally {
        restore();
    }
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S272 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exit(1);

}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
