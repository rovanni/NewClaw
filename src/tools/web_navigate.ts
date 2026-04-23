/**
 * web_navigate - Navegação web em modo texto com fallback HTML.
 *
 * Objetivo: permitir exploração passo a passo de páginas, como um navegador
 * em terminal. Quando possível usa w3m/lynx/links/elinks; caso contrário,
 * faz leitura legível do HTML e expõe links relevantes para o agente seguir.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { ToolExecutor, ToolResult } from '../loop/AgentLoop';

const execFileAsync = promisify(execFile);

type NavigateAction = 'search' | 'open' | 'follow_link';

interface BrowserCandidate {
    name: string;
    args: string[];
}

interface ExtractedLink {
    text: string;
    url: string;
}

interface BrowserDumpResult {
    mode: 'text-browser' | 'html-fallback';
    browser?: string;
    content: string;
}

export class WebNavigateTool implements ToolExecutor {
    name = 'web_navigate';
    description = 'Navegacao web em modo texto para exploracao passo a passo. Use quando precisar abrir paginas, seguir links e inspecionar sites de forma mais controlada do que web_search.';
    parameters = {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['search', 'open', 'follow_link'], description: 'Acao: buscar, abrir URL ou seguir link a partir de uma pagina.' },
            query: { type: 'string', description: 'Consulta usada em action=search.' },
            url: { type: 'string', description: 'URL a abrir em action=open ou pagina base em action=follow_link.' },
            link_text: { type: 'string', description: 'Texto ou fragmento do link a seguir em action=follow_link.' },
            max_chars: { type: 'number', description: 'Limite aproximado de caracteres retornados (padrao: 4000).' }
        },
        required: ['action']
    };

    async execute(args: Record<string, any>): Promise<ToolResult> {
        const action = String(args.action || '').trim() as NavigateAction;
        const query = String(args.query || '').trim();
        const url = String(args.url || '').trim();
        const linkText = String(args.link_text || '').trim();
        const maxChars = this.clampNumber(args.max_chars, 4000, 1000, 12000);

        try {
            switch (action) {
                case 'search':
                    if (!query) return { success: false, output: '', error: 'query obrigatoria para action=search.' };
                    return { success: true, output: await this.search(query, maxChars) };
                case 'open':
                    if (!url) return { success: false, output: '', error: 'url obrigatoria para action=open.' };
                    return { success: true, output: await this.openUrl(url, maxChars) };
                case 'follow_link':
                    if (!url || !linkText) return { success: false, output: '', error: 'url e link_text obrigatorios para action=follow_link.' };
                    return { success: true, output: await this.followLink(url, linkText, maxChars) };
                default:
                    return { success: false, output: '', error: 'action invalida. Use search, open ou follow_link.' };
            }
        } catch (error: any) {
            return { success: false, output: '', error: error.message || 'falha na navegacao web.' };
        }
    }

    private clampNumber(value: any, fallback: number, min: number, max: number): number {
        const num = Number(value);
        if (!Number.isFinite(num)) return fallback;
        return Math.max(min, Math.min(max, Math.round(num)));
    }

    private async search(query: string, maxChars: number): Promise<string> {
        const searchUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
        const html = await this.fetchHtml(searchUrl);
        const results = this.extractSearchResults(html).slice(0, 6);
        const browserDump = await this.getTextView(searchUrl, html, Math.floor(maxChars * 0.45));

        const lines: string[] = [];
        lines.push(`Busca em navegador texto: ${query}`);
        lines.push(`URL: ${searchUrl}`);
        lines.push(`Modo de navegacao: ${this.describeMode(browserDump)}`);
        lines.push(`Resultados encontrados: ${results.length}`);
        lines.push('');

        if (results.length > 0) {
            lines.push('Resultados principais:');
            results.forEach((result, index) => {
                lines.push(`${index + 1}. ${result.text}`);
                lines.push(`URL: ${result.url}`);
            });
            lines.push('');
        }

        if (browserDump.content) {
            lines.push('Leitura da pagina de resultados:');
            lines.push(browserDump.content);
            lines.push('');
        }

        lines.push('Proxima acao sugerida ao assistente: use web_navigate com action=open para abrir uma URL especifica ou action=follow_link para seguir um link da pagina.');
        return this.limitOutput(lines.join('\n'), maxChars);
    }

    private async openUrl(url: string, maxChars: number): Promise<string> {
        const validatedUrl = this.ensureHttpUrl(url);
        const html = await this.fetchHtml(validatedUrl);
        const title = this.extractTitle(html) || validatedUrl;
        const browserDump = await this.getTextView(validatedUrl, html, Math.floor(maxChars * 0.7));
        const links = this.extractLinks(html, validatedUrl).slice(0, 12);

        const lines: string[] = [];
        lines.push(`Pagina aberta: ${title}`);
        lines.push(`URL: ${validatedUrl}`);
        lines.push(`Modo de navegacao: ${this.describeMode(browserDump)}`);
        lines.push('');
        lines.push('Conteudo em modo texto:');
        lines.push(browserDump.content || '[Sem conteudo textual legivel]');
        lines.push('');

        if (links.length > 0) {
            lines.push('Links detectados na pagina:');
            links.forEach((link, index) => {
                lines.push(`${index + 1}. ${link.text}`);
                lines.push(`URL: ${link.url}`);
            });
            lines.push('');
        }

        lines.push('Proxima acao sugerida ao assistente: use action=follow_link com url desta pagina e link_text de um dos links acima para continuar navegando.');
        return this.limitOutput(lines.join('\n'), maxChars);
    }

    private async followLink(pageUrl: string, linkText: string, maxChars: number): Promise<string> {
        const validatedUrl = this.ensureHttpUrl(pageUrl);
        const html = await this.fetchHtml(validatedUrl);
        const links = this.extractLinks(html, validatedUrl);
        const selected = this.selectLink(links, linkText);

        if (!selected) {
            const available = links.slice(0, 8).map(link => `- ${link.text} -> ${link.url}`).join('\n');
            throw new Error(`Link nao encontrado para "${linkText}". Links disponiveis:\n${available || '- nenhum link detectado'}`);
        }

        const opened = await this.openUrl(selected.url, maxChars);
        return this.limitOutput(`Link seguido: ${selected.text}\nURL de origem: ${validatedUrl}\n\n${opened}`, maxChars);
    }

    private async getTextView(url: string, html: string, maxChars: number): Promise<BrowserDumpResult> {
        const browserDump = await this.dumpUrlWithTextBrowser(url, maxChars);
        if (browserDump) {
            return browserDump;
        }

        return {
            mode: 'html-fallback',
            content: this.extractReadableText(html, maxChars)
        };
    }

    private async dumpUrlWithTextBrowser(url: string, maxChars: number): Promise<BrowserDumpResult | null> {
        const browsers: BrowserCandidate[] = [
            { name: 'w3m', args: ['-dump', url] },
            { name: 'lynx', args: ['-dump', '-nolist', url] },
            { name: 'links', args: ['-dump', url] },
            { name: 'elinks', args: ['-dump', url] }
        ];

        for (const browser of browsers) {
            try {
                const { stdout, stderr } = await execFileAsync(browser.name, browser.args, { timeout: 15000, maxBuffer: 1024 * 1024 });
                const text = this.cleanTextOutput((stdout || '') + '\n' + (stderr || ''));
                if (text) {
                    return {
                        mode: 'text-browser',
                        browser: browser.name,
                        content: this.limitOutput(`[browser:${browser.name}]\n${text}`, maxChars)
                    };
                }
            } catch {
                continue;
            }
        }

        return null;
    }

    private async fetchHtml(url: string): Promise<string> {
        const resp = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            redirect: 'follow',
            signal: AbortSignal.timeout(15000)
        });

        if (!resp.ok) {
            throw new Error(`falha ao abrir URL (${resp.status})`);
        }

        const contentType = resp.headers.get('content-type') || '';
        if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
            throw new Error(`conteudo nao HTML: ${contentType || 'desconhecido'}`);
        }

        return await resp.text();
    }

    private extractSearchResults(html: string): ExtractedLink[] {
        const rows = [...html.matchAll(/<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi)];
        return rows
            .map(row => ({
                url: this.decodeHtmlEntities(row[1] || '').trim(),
                text: this.cleanInlineText(row[2] || '')
            }))
            .filter(item => item.url && item.text);
    }

    private extractTitle(html: string): string {
        const match = html.match(/<title[^>]*>(.*?)<\/title>/is);
        return this.cleanInlineText(match?.[1] || '');
    }

    private extractReadableText(html: string, maxChars: number): string {
        let text = html
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
            .replace(/<\/?(article|main|section|p|h1|h2|h3|h4|li|br|div|tr|td)[^>]*>/gi, '\n')
            .replace(/<[^>]+>/g, ' ');

        text = this.decodeHtmlEntities(text);
        const lines = text
            .split('\n')
            .map(line => this.cleanInlineText(line))
            .filter(line => line.length >= 30)
            .filter(line => !this.isBoilerplate(line));

        return this.limitOutput(lines.slice(0, 40).join('\n'), maxChars);
    }

    private extractLinks(html: string, baseUrl: string): ExtractedLink[] {
        const seen = new Set<string>();
        const links = [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi)];

        return links
            .map(link => {
                const href = this.decodeHtmlEntities(link[1] || '').trim();
                const text = this.cleanInlineText(link[2] || '');
                if (!href || !text) return null;

                try {
                    const absolute = new URL(href, baseUrl).toString();
                    if (!/^https?:\/\//i.test(absolute)) return null;
                    if (seen.has(absolute)) return null;
                    seen.add(absolute);
                    return { text, url: absolute };
                } catch {
                    return null;
                }
            })
            .filter((item): item is ExtractedLink => Boolean(item));
    }

    private selectLink(links: ExtractedLink[], linkText: string): ExtractedLink | null {
        const wanted = linkText.toLowerCase().trim();
        if (!wanted) return null;

        const exact = links.find(link => link.text.toLowerCase() === wanted);
        if (exact) return exact;

        const contains = links.find(link =>
            link.text.toLowerCase().includes(wanted) || link.url.toLowerCase().includes(wanted)
        );
        return contains || null;
    }

    private ensureHttpUrl(url: string): string {
        const trimmed = url.trim();
        if (!trimmed) throw new Error('url vazia');
        if (/^https?:\/\//i.test(trimmed)) return trimmed;
        return `https://${trimmed}`;
    }

    private cleanTextOutput(text: string): string {
        return text
            .replace(/\r/g, '')
            .replace(/\t/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    private cleanInlineText(text: string): string {
        return this.decodeHtmlEntities(text)
            .replace(/<[^>]*>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private isBoilerplate(text: string): boolean {
        const lower = text.toLowerCase();
        return [
            'cookie',
            'privacy policy',
            'all rights reserved',
            'subscribe',
            'sign in',
            'javascript',
            'enable javascript'
        ].some(fragment => lower.includes(fragment));
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

    private limitOutput(text: string, maxChars: number): string {
        if (text.length <= maxChars) return text;
        return `${text.slice(0, maxChars)}\n\n[... conteudo truncado]`;
    }

    private describeMode(result: BrowserDumpResult): string {
        if (result.mode === 'text-browser') {
            return `terminal-browser (${result.browser})`;
        }
        return 'html-fallback';
    }
}
