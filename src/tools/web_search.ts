/**
 * web_search - Busca web enriquecida com descoberta multi-fonte,
 * leitura de páginas e síntese pronta para o LLM.
 */

import { ToolExecutor, ToolResult } from '../loop/AgentLoop';

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

    private clampNumber(value: any, fallback: number, min: number, max: number): number {
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
            const rows = [...html.matchAll(/<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>[\s\S]{0,600}?<td[^>]*class="result-snippet"[^>]*>(.*?)<\/td>/gi)];
            const results: SearchCandidate[] = [];

            for (const row of rows.slice(0, maxResults)) {
                const url = this.decodeHtmlEntities(row[1] || '').trim();
                const title = this.cleanText(row[2] || '');
                const snippet = this.cleanText(row[3] || '');
                if (!url || !title) continue;
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

            const data = await resp.json() as any;
            const items = Array.isArray(data?.query?.search) ? data.query.search : [];
            return items.slice(0, maxResults).map((item: any) => ({
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

            const data = await resp.json() as any;
            const items = Array.isArray(data?.items) ? data.items : [];
            return items.slice(0, maxResults).map((item: any) => ({
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

    private async searXNG(query: string, maxResults: number): Promise<SearchCandidate[]> {
        const urls = ['http://localhost:8888/search', 'https://searx.be/search'];

        for (const base of urls) {
            try {
                const resp = await fetch(`${base}?q=${encodeURIComponent(query)}&format=json`, {
                    headers: { 'User-Agent': 'Mozilla/5.0' },
                    signal: AbortSignal.timeout(8000)
                });
                if (!resp.ok) continue;

                const data = await resp.json() as any;
                const results = Array.isArray(data?.results) ? data.results : [];
                return results.slice(0, maxResults).map((item: any) => ({
                    title: this.cleanText(item.title || ''),
                    url: String(item.url || '').trim(),
                    snippet: this.cleanText(item.content || ''),
                    source: 'SearXNG',
                    score: 1.0
                })).filter((item: SearchCandidate) => item.title && item.url);
            } catch {
                continue;
            }
        }

        return [];
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

        return [...candidates]
            .map(candidate => {
                const haystack = `${candidate.title} ${candidate.snippet}`.toLowerCase();
                const tokenHits = tokens.filter(token => haystack.includes(token)).length;
                const domainBoost = /wikipedia|docs|developer|github|gov|org/.test(candidate.url) ? 0.2 : 0;
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

    private async readPage(candidate: SearchCandidate): Promise<ReadablePage | null> {
        try {
            const resp = await fetch(candidate.url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
                redirect: 'follow',
                signal: AbortSignal.timeout(12000)
            });
            const contentType = resp.headers.get('content-type') || '';
            if (!resp.ok || !/text\/html|application\/xhtml\+xml/i.test(contentType)) return null;

            const html = await resp.text();
            const extracted = this.extractReadableContent(html);
            if (!extracted.content) return null;

            return {
                url: candidate.url,
                title: extracted.title || candidate.title,
                content: extracted.content,
                excerpt: extracted.content.slice(0, 700),
                source: candidate.source
            };
        } catch {
            return null;
        }
    }

    private extractReadableContent(html: string): { title: string; content: string } {
        const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
        const title = this.cleanText(titleMatch?.[1] || '');

        let text = html
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
            .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
            .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
            .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
            .replace(/<header[\s\S]*?<\/header>/gi, ' ')
            .replace(/<\/?(article|main|section|p|h1|h2|h3|li|br|div)[^>]*>/gi, '\n')
            .replace(/<[^>]+>/g, ' ');

        text = this.decodeHtmlEntities(text);
        const lines = text
            .split('\n')
            .map(line => this.cleanText(line))
            .filter(line => line.length >= 40);

        const content = lines
            .filter(line => !this.isBoilerplate(line))
            .slice(0, 18)
            .join('\n')
            .slice(0, 3500);

        return { title, content };
    }

    private isBoilerplate(text: string): boolean {
        const lower = text.toLowerCase();
        return [
            'accept all',
            'cookie',
            'privacy policy',
            'subscribe',
            'sign in',
            'all rights reserved',
            'javascript',
            'enable javascript'
        ].some(fragment => lower.includes(fragment));
    }

    private formatOutput(query: string, topResults: SearchCandidate[], pages: ReadablePage[], notes: string[]): string {
        const lines: string[] = [];
        lines.push(`Consulta: ${query}`);
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
        return this.decodeHtmlEntities(input)
            .replace(/<[^>]*>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private decodeHtmlEntities(input: string): string {
        return input
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&apos;/g, "'")
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&nbsp;/g, ' ')
            .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
            .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
    }
}
