import { normalizeFromRaw } from './ResponseAdapter';
import type { ParsedLLMResponse } from './ContentExtractor';
import type { LLMResult } from '../core/ProviderFactory';

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
    const sanitized = sanitizeContent(response.content || '');
    return sanitized || 'Desculpe, não consegui gerar uma resposta adequada.';
}
