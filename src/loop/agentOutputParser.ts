import { normalizeFromRaw } from './ResponseAdapter';
/**
 * Dados atômicos que o LLM emite no protocolo estruturado (action/thought/evaluation).
 *
 * Morava em `ContentExtractor.ts` junto com uma segunda implementação de `parseLLMResponse`/
 * `sanitizeContent`/`extractText` que ninguém mais consumia (issue 004: duas `extractText` com
 * o mesmo nome e assinaturas diferentes, uma delas com docstring apontando consumidores que já
 * tinham migrado). O módulo inteiro foi removido; o tipo mora aqui, no parser que de fato o
 * produz.
 */
export interface ParsedLLMResponse {
    action?: { type?: string; name?: string; content?: string; input?: Record<string, unknown> };
    thought?: string;
    evaluation?: { is_complete?: boolean; confidence?: 'low' | 'medium' | 'high'; reason?: string };
    content?: string;
}

import type { LLMResult } from '../core/ProviderFactory';
import { stripHtmlTags } from '../shared/stripHtmlTags';

// Strip only real model artifacts: think/reasoning tags that leak into output.
// Everything else is the LLM's responsibility — don't second-guess its formatting.
export function sanitizeContent(content: string): string {
    if (!content) return '';
    return content
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
        .replace(/<\/?think>/gi, '')
        .trim();
}

/**
 * Fonte única de "ler o JSON do protocolo" (issue 065b, 06/10/2026). Antes havia duas leituras que divergiam:
 * `ProtocolParser.attemptJsonParse` (decide o rumo do turno) e `parseLLMResponse` (de onde sai o texto entregue).
 * Teste pelo painel, glm-5.3: o modelo devolveu `{"thought":…,"action":{"type":"final_answer","content":"…"}}` com
 * QUEBRAS DE LINHA CRUAS dentro das strings (JSON inválido: "Bad control character in string literal"). O
 * ProtocolParser caiu na extração parcial e encerrou como final_answer; `parseLLMResponse` devolveu null e o usuário
 * recebeu o JSON interno inteiro na tela. Produção: 4 respostas assim entregues (maio–julho).
 *
 * Só SINTAXE, nenhuma interpretação: (1) o texto inteiro; (2) o bloco `{…}` mais externo, achado respeitando
 * strings (chave dentro de string não conta); para cada um, tenta como está e, se falhar, com caracteres de
 * controle crus escapados DENTRO de strings (\n, \r, \t — o que o modelo quis dizer é inequívoco); por último,
 * sem vírgula sobrando antes de `}`/`]`.
 */
export function parseProtocolJson(text: string): ParsedLLMResponse | null {
    if (!text) return null;
    const candidatos = [text.trim()];
    const bloco = outermostJsonBlock(text);
    if (bloco && bloco !== candidatos[0]) candidatos.push(bloco);
    for (const c of candidatos) {
        const leniente = escapeControlCharsInStrings(c, true);
        for (const tentativa of [c, escapeControlCharsInStrings(c), leniente, leniente.replace(/,\s*([}\]])/g, '$1')]) {
            try { return JSON.parse(tentativa); } catch { /* próxima */ }
        }
    }
    return null;
}

/** O bloco `{…}` mais externo a partir do primeiro `{`, contando chaves só FORA de strings JSON. */
function outermostJsonBlock(text: string): string | null {
    const start = text.indexOf('{');
    if (start === -1) return null;
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') inString = true;
        else if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
    }
    return null;
}

/**
 * Escapa \n, \r e \t crus que aparecem DENTRO de strings JSON (fora delas são espaço em branco válido).
 * Com `aspasLenientes` (última tentativa): uma `"` dentro de string só a FECHA se o próximo caractere significativo
 * for `,`, `}`, `]` ou `:` — senão é aspa literal do texto (ex.: `a sensação de "frio" é maior`) e é escapada. Mesma
 * regra sintática de reparadores de JSON; nada de interpretação de conteúdo.
 */
function escapeControlCharsInStrings(text: string, aspasLenientes = false): string {
    const chars = [...text];
    let out = '', inString = false, escaped = false;
    for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        if (inString) {
            if (escaped) { escaped = false; out += ch; continue; }
            if (ch === '\\') { escaped = true; out += ch; continue; }
            if (ch === '"') {
                if (aspasLenientes) {
                    let j = i + 1;
                    while (j < chars.length && /\s/.test(chars[j])) j++;
                    if (j < chars.length && !',}]:'.includes(chars[j])) { out += '\\"'; continue; }
                }
                inString = false; out += ch; continue;
            }
            out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t' : ch;
            continue;
        }
        if (ch === '"') inString = true;
        out += ch;
    }
    return out;
}

export function parseLLMResponse(content: string): ParsedLLMResponse | null {
    if (!content) return null;
    return parseProtocolJson(sanitizeContent(content));
}

export function extractFinalText(response: LLMResult, _atomicData: unknown): string {
    const normalized = normalizeFromRaw(response.content || '', parseLLMResponse);

    if (normalized.type !== 'empty' && normalized.content?.trim()) {
        return normalized.content;
    }

    // A successfully-parsed tool call with no accompanying content is not an extraction
    // failure — it's an internal control message ({thought, action, evaluation}) meant to
    // drive the next tool step, not to be shown to the user. Falling through to
    // sanitizeContent() below would return that raw JSON as "final text" (sanitizeContent
    // only strips <think> tags), which then satisfies length-based "good content" checks
    // upstream and can get committed as the user-facing response verbatim.
    // Evidence: 2026-07-05 audit log — SAFETY-GUARD aborted a tool_loop and committed this
    // exact JSON blob as the reply because lastBestContent looked "long enough" to skip
    // post-loop synthesis. Mirrors the same tool-vs-text check already in extractText()
    // (ResponseBuilder.ts).
    if (normalized.type === 'tool') {
        return '';
    }

    const sanitized = sanitizeContent(response.content || '');
    if (sanitized) return sanitized;

    // Last resort: the model returned only thinking-tag content.
    // Extract the last meaningful sentence from inside the tags rather than silencing it completely.
    const raw = response.content || '';
    const thinkMatch = raw.match(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi);
    if (thinkMatch) {
        const lastThink = stripHtmlTags(thinkMatch[thinkMatch.length - 1]).trim();
        const sentences = lastThink.split(/[.!?]\s+/).filter(s => s.trim().length > 20);
        if (sentences.length > 0) {
            const candidate = sentences[sentences.length - 1].trim();
            if (candidate.length > 20) return candidate;
        }
    }

    return '';
}
