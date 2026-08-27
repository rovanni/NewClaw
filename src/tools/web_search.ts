/**
 * web_search - Busca web enriquecida com descoberta multi-fonte,
 * leitura de páginas e síntese pronta para o LLM.
 */

import { ToolExecutor, ToolResult } from '../loop/agentLoopTypes';
import { decodeHtmlEntities } from '../shared/htmlEntities';
import { DDG_RESULT_LINK_CLASS, DDG_RESULT_SNIPPET_CLASS } from '../shared/duckduckgoLite';
import { readPageContent } from '../shared/pageContentReader';


interface SearchCandidate {
    title: string;
    url: string;
    snippet: string;
    source: string;
    score: number;
}

interface SearchOptions {
    maxResults: number;
    maxSources: number;
    navigationRounds: number;
    readPages: boolean;
}

interface SearchRoundResult {
    candidates: SearchCandidate[];
    notes: string[];
}

interface ReadablePage {
    url: string;
    title: string;
    content: string;
    excerpt: string;
    source: string;
}

export class WebSearchTool implements ToolExecutor {
    name = 'web_search';
    description = 'Pesquisa na web com navegacao iterativa, leitura de paginas e sintese multi-fonte. Use para noticias, fatos recentes, documentacao, explicacoes e pesquisa geral. Nao use para analise aprofundada de criptomoedas, use crypto_analysis.';
    parameters = {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Termo da pesquisa' },
            max_results: { type: 'number', description: 'Maximo de resultados finais (padrao: 5)' },
            max_sources: { type: 'number', description: 'Quantidade de paginas para leitura (padrao: 3)' },
            navigation_rounds: { type: 'number', description: 'Rodadas de navegacao/refinamento da busca (padrao: 2)' },
            read_pages: { type: 'boolean', description: 'Se verdadeiro, le o conteudo das paginas para enriquecer a resposta (padrao: true)' }
        },
        required: ['query']
    };

    async execute(args: Record<string, any>): Promise<ToolResult> {
        const query = String(args.query || '').trim();
        const options = this.normalizeOptions(args);
        if (!query) return { success: false, output: '', error: 'Query nao fornecida.' };

        const rounds = this.buildQueryPlan(query, options.navigationRounds);
        const allCandidates: SearchCandidate[] = [];
        const notes: string[] = [];

        for (const roundQuery of rounds) {
            const round = await this.searchRound(roundQuery, options.maxResults);
            allCandidates.push(...round.candidates);
            notes.push(...round.notes);

            const uniqueCount = this.deduplicateCandidates(allCandidates).length;
            if (uniqueCount >= Math.max(options.maxResults, options.maxSources + 1)) break;
        }

        const deduped = this.rankCandidates(this.deduplicateCandidates(allCandidates), query).slice(0, Math.max(options.maxResults * 2, options.maxSources + 2));
        if (deduped.length === 0) {
            return {
                success: false,
                output: '',
                error: `Nenhum resultado encontrado para "${query}". Tente simplificar ou especificar melhor a busca.`
            };
        }

        const pages = options.readPages
            ? await this.readTopPages(deduped, options.maxSources)
            : [];

        const output = this.formatOutput(query, deduped.slice(0, options.maxResults), pages, notes);
        return { success: true, output };
    }

    private normalizeOptions(args: Record<string, any>): SearchOptions {
        return {
            maxResults: this.clampNumber(args.max_results, 5, 1, 8),
            maxSources: this.clampNumber(args.max_sources, 3, 1, 5),
            navigationRounds: this.clampNumber(args.navigation_rounds, 2, 1, 3),
            readPages: args.read_pages !== false
        };
    }

    private clampNumber(value: unknown, fallback: number, min: number, max: number): number {
        const num = Number(value);
        if (!Number.isFinite(num)) return fallback;
        return Math.max(min, Math.min(max, Math.round(num)));
    }

    private buildQueryPlan(query: string, rounds: number): string[] {
        const normalized = query.replace(/\s+/g, ' ').trim();
        const compact = normalized
            .split(' ')
            .filter(token => token.length > 2)
            .slice(0, 8)
            .join(' ');

        const plan = [normalized];
        if (rounds >= 2 && compact && compact.toLowerCase() !== normalized.toLowerCase()) {
            plan.push(compact);
        }
        if (rounds >= 3 && !/\b(guia|overview|documentacao|docs|latest|news|noticias?)\b/i.test(normalized)) {
            plan.push(`${compact || normalized} overview`);
        }
        return [...new Set(plan)];
    }

    private async searchRound(query: string, maxResults: number): Promise<SearchRoundResult> {
        const notes: string[] = [];
        const providers = await Promise.allSettled([
            this.bingNewsRss(query, maxResults),
            this.duckDuckGo(query, maxResults),
            this.wikipediaSearch(query, maxResults),
            this.googleSearch(query, maxResults),
            this.searXNG(query, maxResults)
        ]);

        const candidates: SearchCandidate[] = [];
        for (const result of providers) {
            if (result.status === 'fulfilled') {
                candidates.push(...result.value);
            } else {
                notes.push(`Fonte falhou: ${result.reason instanceof Error ? result.reason.message : 'erro desconhecido'}`);
            }
        }

        return { candidates, notes };
    }


    private async bingNewsRss(query: string, maxResults: number): Promise<SearchCandidate[]> {
        try {
            const searchUrl = "https://www.bing.com/news/search?q=" + encodeURIComponent(query) + "&format=rss";
            const resp = await fetch(searchUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (!resp.ok) return [];
            
            const xml = await resp.text();
            const results: SearchCandidate[] = [];
            const items = xml.split('<item>');
            
            for (let i = 1; i < items.length && results.length < maxResults; i++) {
                const item = items[i];
                const titleMatch = item.match(/<title>(.*?)<\/title>/i);
                const linkMatch = item.match(/<link>(.*?)<\/link>/i);
                const descMatch = item.match(/<description>(.*?)<\/description>/i);
                
                if (titleMatch && linkMatch) {
                    results.push({
                        title: this.cleanText(titleMatch[1]),
                        url: this.resolveBingRedirectUrl(linkMatch[1]),
                        snippet: descMatch ? this.cleanText(descMatch[1]) : '',
                        source: 'Bing News',
                        score: 1.0
                    });
                }
            }
            return results;
        } catch {
            return [];
        }
    }

    /**
     * O `<link>` do RSS da Bing News não é a URL do artigo — é um redirect de rastreamento
     * (`bing.com/news/apiclick.aspx?...&url=<destino real, percent-encoded>&...`). Sem isto, todo
     * `readPage()` posterior busca essa página de interstício da própria Bing ("Redirect Alert...")
     * em vez do artigo, e o conteúdo lido nunca é o da fonte.
     *
     * Achado real (26/08/2026, campanha "Web Search Coverage & Evidence Quality"): confirmado
     * reproduzindo o pipeline real, sem mock, para "deepseek harness" — as 3 páginas lidas via
     * Bing News RSS trouxeram chrome/interstício da Bing, nunca o artigo de destino.
     *
     * Extração estrutural, não interpretação: lê o parâmetro `url` da própria query string —
     * propriedade objetiva de uma URL bem formada, não julgamento sobre o conteúdo. Sem esse
     * parâmetro ou com URL malformada, devolve o link original (NUNCA_ADIVINHAR — nunca inventa
     * um destino que a URL não declarou).
     *
     * Decodifica entidades HTML ANTES de interpretar como URL — o `<link>` do RSS vem com `&`
     * escapado como `&amp;` (é um nó de texto XML). Sem decodificar primeiro, `&amp;` nunca é
     * reconhecido como separador de query string e `URLSearchParams` lê a query inteira como uma
     * chave só, nunca achando `url` (bug próprio encontrado ao verificar esta mesma correção).
     */
    private resolveBingRedirectUrl(link: string): string {
        try {
            const parsed = new URL(decodeHtmlEntities(link));
            const destino = parsed.searchParams.get('url');
            return destino || link;
        } catch {
            return link;
        }
    }

    private async duckDuckGo(query: string, maxResults: number): Promise<SearchCandidate[]> {
        try {
            const resp = await fetch('https://lite.duckduckgo.com/lite/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
                },
                body: `q=${encodeURIComponent(query)}`,
                signal: AbortSignal.timeout(10000)
            });
            if (!resp.ok) return [];

            const html = await resp.text();
            // Casa cada tag <a ...>texto</a> e inspeciona os atributos capturados
            // independentemente da ORDEM em que aparecem — achado real (26/08/2026): o regex
            // antigo exigia `class` ANTES de `href` na tag, mas o HTML real do DuckDuckGo Lite
            // traz `href` primeiro e `class` depois (`<a rel="nofollow" href="..." class='...'>`).
            // Exigir uma ordem específica de atributos é tão frágil quanto exigir um caractere de
            // aspas específico — os dois são detalhes de serialização do HTML, não uma garantia
            // de formato.
            const resultLinkClassRe = new RegExp(DDG_RESULT_LINK_CLASS);
            const nextResultLinkRe = new RegExp(`<a\\s+[^>]*${DDG_RESULT_LINK_CLASS}`, 'i');
            // [\s\S]*?, não .*? — o HTML real do DuckDuckGo Lite quebra linha logo após
            // `<td class='result-snippet'>`, antes do texto começar; "." não casa `\n` em JS sem
            // a flag `s`, então o snippet nunca era capturado mesmo depois de corrigir aspas e
            // ordem dos atributos (achado encontrado ao verificar esta própria correção contra
            // HTML real, não sintético).
            const snippetRe = new RegExp(`<td[^>]*${DDG_RESULT_SNIPPET_CLASS}[^>]*>([\\s\\S]*?)<\\/td>`, 'i');
            const anchorRe = /<a\s+([^>]*)>(.*?)<\/a>/gi;
            const results: SearchCandidate[] = [];
            let anchor: RegExpExecArray | null;

            while ((anchor = anchorRe.exec(html)) !== null && results.length < maxResults) {
                const attrs = anchor[1];
                if (!resultLinkClassRe.test(attrs)) continue;

                const hrefMatch = attrs.match(/href="([^"]+)"/);
                const url = hrefMatch ? decodeHtmlEntities(hrefMatch[1]).trim() : '';
                const title = this.cleanText(anchor[2] || '');
                if (!url || !title) continue;

                // Limite estrutural, não um número chutado: a janela de busca do snippet vai até
                // o INÍCIO do próximo resultado real (ou fim do documento) — nunca invade o
                // snippet de outro resultado, e nunca corta o snippet do resultado atual pela
                // metade. Achado ao verificar esta correção contra HTML real: uma janela fixa de
                // 600 chars (herdada do regex original quebrado, nunca validada de verdade) já
                // cortava snippets legítimos mais longos, silenciosamente devolvendo vazio.
                const restante = html.slice(anchorRe.lastIndex);
                const proximoResultado = restante.search(nextResultLinkRe);
                const windowAfter = proximoResultado >= 0 ? restante.slice(0, proximoResultado) : restante;
                const snippetMatch = windowAfter.match(snippetRe);
                const snippet = snippetMatch ? this.cleanText(snippetMatch[1]) : '';

                results.push({ title, url, snippet, source: 'DuckDuckGo', score: 1.0 });
            }

            return results;
        } catch {
            return [];
        }
    }

    private async wikipediaSearch(query: string, maxResults: number): Promise<SearchCandidate[]> {
        try {
            const url = `https://pt.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&utf8=&format=json`;
            const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
            if (!resp.ok) return [];

            const data = await resp.json() as { query?: { search?: Array<{ title?: string; snippet?: string; [key: string]: unknown }> } };
            const items = Array.isArray(data?.query?.search) ? data.query.search : [];
            return items.slice(0, maxResults).map((item) => ({
                title: this.cleanText(item.title || ''),
                url: `https://pt.wikipedia.org/wiki/${encodeURIComponent(String(item.title || '').replace(/\s+/g, '_'))}`,
                snippet: this.cleanText(item.snippet || ''),
                source: 'Wikipedia',
                score: 0.9
            })).filter((item: SearchCandidate) => item.title && item.url);
        } catch {
            return [];
        }
    }

    private async googleSearch(query: string, maxResults: number): Promise<SearchCandidate[]> {
        const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
        const cx = process.env.GOOGLE_SEARCH_CX;
        if (!apiKey || !cx) return [];

        try {
            const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(query)}&num=${maxResults}`;
            const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
            if (!resp.ok) return [];

            const data = await resp.json() as { items?: Array<{ title?: string; link?: string; snippet?: string; [key: string]: unknown }> };
            const items = Array.isArray(data?.items) ? data.items : [];
            return items.slice(0, maxResults).map((item: { title?: string; link?: string; snippet?: string; [key: string]: unknown }) => ({
                title: this.cleanText(item.title || ''),
                url: String(item.link || '').trim(),
                snippet: this.cleanText(item.snippet || ''),
                source: 'Google Custom Search',
                score: 1.1
            })).filter((item: SearchCandidate) => item.title && item.url);
        } catch {
            return [];
        }
    }

    /**
     * Endpoint de busca a partir do que o usuário declarou em `SEARXNG_URL`.
     *
     * Aceita tanto a origem (`http://meu-host:8888`) quanto o endpoint completo
     * (`http://meu-host:8888/search`): `/search` é o caminho fixo da API do SearXNG, não um palpite
     * sobre a instalação de ninguém. String vazia quando o valor não é uma URL — melhor não buscar
     * do que buscar em lugar nenhum.
     */
    private searxngEndpoint(configurado: string): string {
        try {
            const url = new URL(configurado);
            if (url.pathname === '/' || url.pathname === '') url.pathname = '/search';
            return url.toString();
        } catch {
            return '';
        }
    }

    /**
     * SearXNG — **somente** a instância que o usuário declarou em `SEARXNG_URL`.
     *
     * Até 06/08/2026 esta função tentava `http://localhost:8888/search` e, falhando, caía em
     * `https://searx.be/search` — um servidor público de terceiros. Quem sobe uma instância local
     * faz isso justamente para que suas buscas não saiam da máquina; encontrá-la fora do ar e
     * mandar a mesma consulta para a Internet inverte a intenção inteira, e em silêncio. Era o
     * achado mais grave do levantamento da `RFC-005`, e o único cuja implicação é privacidade em
     * vez de disponibilidade.
     *
     * Sem `SEARXNG_URL`, esta fonte simplesmente não é consultada — mesma regra que
     * `WHISPER_API_URL` já segue desde 05/08/2026 e que o provider do Google segue neste mesmo
     * arquivo (sem chave, devolve vazio). Ausência de configuração não é declaração
     * (`SOBERANIA_DA_CONFIGURACAO.md` §1.1); é dado ausente (`NUNCA_ADIVINHAR.md`).
     *
     * Consequência assumida: para quem nunca configurou nada, o SearXNG deixa de devolver
     * resultados — antes devolvia, via `searx.be`. É a correção, não um efeito colateral.
     */
    private async searXNG(query: string, maxResults: number): Promise<SearchCandidate[]> {
        const configurado = (process.env.SEARXNG_URL || '').trim();
        if (!configurado) return [];

        const endpoint = this.searxngEndpoint(configurado);
        if (!endpoint) return [];

        try {
            const resp = await fetch(`${endpoint}?q=${encodeURIComponent(query)}&format=json`, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
                signal: AbortSignal.timeout(8000)
            });
            if (!resp.ok) return [];

            const data = await resp.json() as { results?: Array<{ title?: string; url?: string; content?: string; [key: string]: unknown }> };
            const results = Array.isArray(data?.results) ? data.results : [];
            return results.slice(0, maxResults).map((item: { title?: string; url?: string; content?: string; [key: string]: unknown }) => ({
                title: this.cleanText(item.title || ''),
                url: String(item.url || '').trim(),
                snippet: this.cleanText(item.content || ''),
                source: 'SearXNG',
                score: 1.0
            })).filter((item: SearchCandidate) => item.title && item.url);
        } catch {
            return [];
        }
    }

    private deduplicateCandidates(candidates: SearchCandidate[]): SearchCandidate[] {
        const seen = new Map<string, SearchCandidate>();

        for (const candidate of candidates) {
            const normalizedUrl = this.normalizeUrl(candidate.url);
            const key = normalizedUrl || candidate.title.toLowerCase();
            if (!key) continue;

            const existing = seen.get(key);
            if (!existing || candidate.score > existing.score || candidate.snippet.length > existing.snippet.length) {
                seen.set(key, { ...candidate, url: normalizedUrl || candidate.url });
            }
        }

        return Array.from(seen.values());
    }

    private rankCandidates(candidates: SearchCandidate[], query: string): SearchCandidate[] {
        const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
        // Queries de dados em tempo real — preço, cotação, agora, hoje
        const isRealTime = /price|preço|preco|cotaç|cotac|valor|hoje|today|agora|now|current|market cap/i.test(query);

        return [...candidates]
            .map(candidate => {
                const haystack = `${candidate.title} ${candidate.snippet}`.toLowerCase();
                const tokenHits = tokens.filter(token => haystack.includes(token)).length;

                let domainBoost = 0;
                if (/docs\.|developer\.|github\.com|\.gov|stackoverflow/.test(candidate.url)) {
                    domainBoost = 0.2;  // fontes técnicas/docs
                } else if (/wikipedia\.org/.test(candidate.url)) {
                    // Wikipedia é útil para conceitos mas péssima para dados em tempo real
                    domainBoost = isRealTime ? -0.5 : 0.1;
                } else if (/coingecko\.com|coinmarketcap\.com|binance\.com|coinbase\.com|cryptonews|cointelegraph|theblock|decrypt\.co/.test(candidate.url)) {
                    domainBoost = isRealTime ? 0.4 : 0.2;  // fontes de cripto preferidas para dados de mercado
                }

                return {
                    ...candidate,
                    score: candidate.score + tokenHits * 0.15 + domainBoost
                };
            })
            .sort((a, b) => b.score - a.score);
    }

    private async readTopPages(candidates: SearchCandidate[], maxSources: number): Promise<ReadablePage[]> {
        const selected = candidates.filter(candidate => /^https?:\/\//i.test(candidate.url)).slice(0, maxSources);
        const pages = await Promise.all(selected.map(candidate => this.readPage(candidate)));
        return pages.filter((page): page is ReadablePage => Boolean(page));
    }

    /**
     * Sprint 4 (campanha "Web Search Coverage & Evidence Quality", 26/08/2026): antes decidia
     * "estático é bom o bastante (>=200 chars) ou cai pro Jina (>=100 chars)" — contagem de
     * caracteres como proxy de qualidade, a mesma violação que a Sprint 3 encontrou no
     * `web_navigate.ts` (limiares diferentes, já divergentes: 300/nenhum). Agora delega para
     * `readPageContent()` (shared/pageContentReader.ts, autoridade única), que só decide
     * disponibilidade ESTRUTURAL (vazio ou não) — nunca qualidade. `minLineLength`/`maxLines`
     * preservam exatamente os valores que este arquivo já usava (40 chars, 18 linhas) — não foram
     * unificados com os de web_navigate.ts por não terem relação de superconjunto entre si.
     */
    private async readPage(candidate: SearchCandidate): Promise<ReadablePage | null> {
        const page = await readPageContent(candidate.url, { maxChars: 3500, minLineLength: 40, maxLines: 18 });
        if (!page) return null;
        return {
            url: candidate.url,
            title: page.title || candidate.title,
            content: page.content,
            excerpt: page.content.slice(0, 700),
            source: candidate.source
        };
    }

    private formatOutput(query: string, topResults: SearchCandidate[], pages: ReadablePage[], notes: string[]): string {
        const lines: string[] = [];
        lines.push(`Consulta: ${query}`);
        // Achado real (16/08/2026, campanha de tool-routing/latência): sem isto, a síntese não
        // tinha como afirmar se um valor era "de agora" ou de dias atrás — o juiz de grounding
        // rejeitou repetidas vezes afirmações como "a cotação mais recente é da sessão de
        // sexta-feira" (NOT_EVALUABLE: nenhuma evidência determinava a data dos dados). Isto NÃO
        // é a data de publicação de cada página (frequentemente indisponível nos snippets) — é o
        // instante em que ESTA busca foi executada, sempre conhecido com certeza (Date.now()),
        // suficiente para o LLM afirmar "consultado agora" sem inventar a data de cada fonte.
        lines.push(`Consultado em: ${new Date().toISOString()}`);
        lines.push(`Resultados agregados: ${topResults.length}`);

        if (pages.length > 0) {
            lines.push('');
            lines.push('Sintese multi-fonte:');
            pages.forEach((page, index) => {
                lines.push(`${index + 1}. ${page.title} (${page.source})`);
                lines.push(`URL: ${page.url}`);
                lines.push(`Leitura: ${page.excerpt}`);
                lines.push('');
            });
        }

        lines.push('Principais resultados:');
        topResults.forEach((result, index) => {
            lines.push(`${index + 1}. ${result.title} [${result.source}]`);
            lines.push(`URL: ${result.url}`);
            if (result.snippet) lines.push(`Snippet: ${result.snippet}`);
            lines.push('');
        });

        if (notes.length > 0) {
            const uniqueNotes = [...new Set(notes)].slice(0, 3);
            lines.push(`Observacoes tecnicas: ${uniqueNotes.join(' | ')}`);
        }

        lines.push('Instrucao ao assistente: sintetize os pontos convergentes entre as fontes, destaque divergencias se houver e cite os links mais relevantes na resposta final.');
        return lines.join('\n').trim();
    }

    private normalizeUrl(url: string): string {
        try {
            const parsed = new URL(url);
            parsed.hash = '';
            if ((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443')) {
                parsed.port = '';
            }
            if (parsed.pathname.endsWith('/')) {
                parsed.pathname = parsed.pathname.slice(0, -1);
            }
            return parsed.toString();
        } catch {
            return url.trim();
        }
    }

    private cleanText(input: string): string {
        return decodeHtmlEntities(input)
            .replace(/<[^>]*>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

}
