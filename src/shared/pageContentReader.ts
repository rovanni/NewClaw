/**
 * pageContentReader — autoridade única para obtenção/extração de conteúdo de página, compartilhada
 * por web_search.ts e web_navigate.ts.
 *
 * Decisão arquitetural (Sprint 4, campanha "Web Search Coverage & Evidence Quality", 26/08/2026):
 * código só decide DISPONIBILIDADE/ESTRUTURA — a extração produziu algo não-vazio? a resposta HTTP
 * foi válida? o content-type é HTML? — nunca QUALIDADE ("isso é conteúdo bom o bastante?").
 *
 * Antes: dois limiares de caracteres independentes e já divergentes (`>=200` em web_search.ts,
 * `>=300` em web_navigate.ts) decidiam "a extração estática é boa o bastante, ou cai pro Jina" —
 * contagem de caracteres sendo usada como proxy de qualidade semântica, violando "Determinismo
 * valida / LLM interpreta". Agora: Jina só é tentado quando a extração estática é ESTRUTURALMENTE
 * indisponível (vazia após limpeza) — nunca por decisão de "não é longa/boa o bastante". A
 * interpretação de qualidade/relevância do conteúdo entregue pertence às camadas que já têm essa
 * responsabilidade (juiz de grounding, síntese) — nunca aqui (Evidence Provider Pattern).
 *
 * Elimina a duplicação encontrada na Sprint 3: `fetchViaJina()` existia duas vezes (limiares de
 * "conteúdo Jina utilizável" diferentes: `>50` vs `>=100`), `extractReadableContent()`/
 * `extractReadableText()` eram quase idênticas com listas de boilerplate divergentes (8 termos vs
 * 7 — faltava "accept all" numa cópia) e listas de tags diferentes, e `extractTitle()` era
 * literalmente duplicada byte-a-byte.
 *
 * Dois parâmetros ficaram DELIBERADAMENTE fora da unificação — `minLineLength` e `maxLines` — por
 * não terem relação de superconjunto entre os valores das duas cópias originais (30 vs 40 chars;
 * 18 vs 40 linhas): escolher um dos dois seria inventar um número no lugar do antigo, exatamente o
 * que esta sprint proíbe. Cada chamador preserva o valor que já usava.
 */

import { decodeHtmlEntities } from './htmlEntities';

export interface ExtractedPageContent {
    title: string;
    content: string;
}

export interface StaticExtractionOptions {
    maxChars: number;
    /** Linhas mais curtas que isto são descartadas (ruído de navegação/menu) — parâmetro
     *  operacional pré-existente por chamador, não unificado (ver cabeçalho do arquivo). */
    minLineLength: number;
    /** Máximo de linhas mantidas — mesmo motivo do parâmetro acima. */
    maxLines: number;
}

/** Termos de rodapé/interface que não são conteúdo do artigo — lista única (era 8 termos em
 *  web_search.ts, 7 em web_navigate.ts, faltando "accept all"; união das duas, sem invenção de
 *  termo novo). */
const BOILERPLATE_TERMS = [
    'accept all',
    'cookie',
    'privacy policy',
    'subscribe',
    'sign in',
    'all rights reserved',
    'javascript',
    'enable javascript',
];

/** Tags cujo conteúdo interno vira quebra de linha na extração — união das duas listas originais
 *  (web_navigate.ts também tratava h4/tr/td; web_search.ts não). Mais inclusiva nunca perde
 *  conteúdo real que uma das duas versões já capturava. */
const BLOCK_TAGS = 'article|main|section|p|h1|h2|h3|h4|li|br|div|tr|td';

const DEFAULT_MAX_CHARS = 3500;
const DEFAULT_FETCH_TIMEOUT_MS = 15000;
const JINA_TIMEOUT_MS = 20000;

function isBoilerplateLine(text: string): boolean {
    const lower = text.toLowerCase();
    return BOILERPLATE_TERMS.some(term => lower.includes(term));
}

function cleanLine(text: string): string {
    return decodeHtmlEntities(text).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Título de uma página a partir do HTML bruto — extração idêntica que existia, literalmente
 *  duplicada, em web_search.ts (`extractReadableContent`) e web_navigate.ts (`extractTitle`). */
export function extractTitle(html: string): string {
    const match = html.match(/<title[^>]*>(.*?)<\/title>/is);
    return match ? cleanLine(match[1]) : '';
}

/**
 * Extração estrutural de texto legível a partir de HTML bruto. Remove ruído estrutural conhecido
 * (script/style/noscript/svg/nav/footer/header, linhas de boilerplate por palavra-chave conhecida)
 * — nunca julga se o RESULTADO final é "bom o bastante"; devolve string vazia quando não sobra
 * nada, e cabe ao chamador decidir estruturalmente (vazio → tentar Jina; não-vazio → usar).
 *
 * `<\/tag\b[^>]*>` (não `<\/tag\s*>`): tag de fechamento com qualquer conteúdo entre o nome da tag
 * e o ">" (ex: "</script foo>") é válida em HTML real mas não casava com `\s*>` — o conteúdo de
 * script/style sobrevivia à remoção (CodeQL js/bad-tag-filter; achado original em web_search.ts,
 * preservado aqui).
 */
export function extractStaticContent(html: string, options: StaticExtractionOptions): string {
    let text = html
        .replace(/<script[\s\S]*?<\/script\b[^>]*>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style\b[^>]*>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript\b[^>]*>/gi, ' ')
        .replace(/<svg[\s\S]*?<\/svg\b[^>]*>/gi, ' ')
        .replace(/<nav[\s\S]*?<\/nav\b[^>]*>/gi, ' ')
        .replace(/<footer[\s\S]*?<\/footer\b[^>]*>/gi, ' ')
        .replace(/<header[\s\S]*?<\/header\b[^>]*>/gi, ' ')
        .replace(new RegExp(`<\\/?(${BLOCK_TAGS})[^>]*>`, 'gi'), '\n')
        .replace(/<[^>]+>/g, ' ');

    text = decodeHtmlEntities(text);
    const lines = text
        .split('\n')
        .map(cleanLine)
        .filter(line => line.length >= options.minLineLength)
        .filter(line => !isBoilerplateLine(line));

    return lines.slice(0, options.maxLines).join('\n').slice(0, options.maxChars);
}

/** Busca a URL e devolve o HTML bruto — `null` para qualquer falha estrutural (rede, status não-OK,
 *  content-type não-HTML). Nunca lança: ausência de conteúdo é uma saída válida (NUNCA_ADIVINHAR). */
export async function fetchPageHtml(url: string, timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS): Promise<string | null> {
    try {
        const resp = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            redirect: 'follow',
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!resp.ok) return null;
        const contentType = resp.headers.get('content-type') || '';
        if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) return null;
        return await resp.text();
    } catch {
        return null;
    }
}

/**
 * Jina AI Reader — mecanismo de AQUISIÇÃO alternativo (renderiza JS), não uma "opção melhor" que
 * a estática. Só deve ser chamado quando a extração estática já foi tentada e é estruturalmente
 * indisponível (vazia). Devolve o texto bruto (com as linhas de metadado "Title:"/"URL:"/
 * "Published Time:" que o chamador pode querer separar do corpo) ou `null` se também vazio.
 */
export async function fetchViaJina(url: string, maxChars: number = DEFAULT_MAX_CHARS): Promise<string | null> {
    try {
        const resp = await fetch(`https://r.jina.ai/${url}`, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/plain, text/markdown' },
            signal: AbortSignal.timeout(JINA_TIMEOUT_MS),
        });
        if (!resp.ok) return null;
        const text = (await resp.text()).trim();
        return text.length > 0 ? text.slice(0, maxChars) : null;
    } catch {
        return null;
    }
}

/**
 * Caminho completo (fetch → estático → Jina), para quando o chamador ainda não tem o HTML em mãos
 * (web_search.ts: cada candidato de busca é uma URL nova, nunca pré-buscada). Quem já tem o HTML
 * (web_navigate.ts, que o busca uma vez para extrair título/links/conteúdo) usa as peças
 * (`extractStaticContent`/`fetchViaJina`) diretamente, para não buscar a mesma URL duas vezes.
 */
export async function readPageContent(
    url: string,
    options: Pick<StaticExtractionOptions, 'minLineLength' | 'maxLines'> & { maxChars?: number } = { minLineLength: 40, maxLines: 18 },
): Promise<ExtractedPageContent | null> {
    const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    const html = await fetchPageHtml(url);
    if (html) {
        const content = extractStaticContent(html, { maxChars, minLineLength: options.minLineLength, maxLines: options.maxLines });
        if (content.trim().length > 0) {
            return { title: extractTitle(html), content };
        }
    }

    const jina = await fetchViaJina(url, maxChars);
    if (jina) {
        const titleMatch = jina.match(/^Title:\s*(.+)$/m);
        const content = jina.replace(/^(Title|URL|Published Time):.*$/gm, '').trim().slice(0, maxChars);
        if (content.length > 0) {
            return { title: titleMatch?.[1]?.trim() || '', content };
        }
    }

    return null;
}
