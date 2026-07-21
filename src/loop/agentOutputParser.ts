import { normalizeFromRaw } from './ResponseAdapter';
import type { ParsedLLMResponse } from './ContentExtractor';
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

export function parseLLMResponse(content: string): ParsedLLMResponse | null {
    if (!content) return null;

    const cleaned = sanitizeContent(content);

    // Fast path: the whole string is JSON
    try {
        return JSON.parse(cleaned);
    } catch { /* fall through */ }

    // Locate the outermost JSON object without regex
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) {
        try {
            return JSON.parse(cleaned.slice(start, end + 1));
        } catch { /* fall through */ }
    }

    return null;
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
