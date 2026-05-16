import { normalizeFromRaw } from './ResponseAdapter';
import type { ParsedLLMResponse } from './ContentExtractor';
import type { LLMResult } from '../core/ProviderFactory';

export function sanitizeContent(content: string): string {
    if (!content) return '';
    let result = content;
    result = result.replace(/<think>[\s\S]*?<\/think>/gi, '');
    result = result.replace(/<\/?think>/gi, '');
    result = result.replace(/\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]/gi, '');
    result = result.replace(/\*\*/g, '');

    const trimmed = result.trim();

    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed.action?.content && typeof parsed.action.content === 'string') {
                result = parsed.action.content;
            } else if (parsed.content && typeof parsed.content === 'string') {
                result = parsed.content;
            }
        } catch {
            // Not valid JSON, leave as-is
        }
    }

    const codeFenceMatch = result.match(/^```[\s\S]*?```\s*$/);
    if (codeFenceMatch) {
        const inner = result.replace(/^```\w*\n?/, '').replace(/\n?```\s*$/, '');
        if (inner.length > 0) result = inner;
    }

    result = result.replace(/```json\s*\n?[\s\S]*?```/g, (match) => {
        try {
            const jsonStr = match.replace(/^```json\s*\n?/, '').replace(/\n?```\s*$/, '');
            const parsed = JSON.parse(jsonStr);
            if (parsed.action?.content && typeof parsed.action.content === 'string') {
                return parsed.action.content;
            }
            if (parsed.content && typeof parsed.content === 'string') {
                return parsed.content;
            }
        } catch {
            // Not valid JSON inside the code fence — strip to prevent protocol leakage
        }
        return '';
    });

    result = result.replace(/```(?:json)?\s*\n?\{[\s\S]*?"(?:thought|action|evaluation)"[\s\S]*?\}\s*```/g, '');

    result = result.replace(/^Você é o núcleo cognitivo[\s\S]*?(?=\n\n|\n[A-Z])/i, '');
    result = result.replace(/^##\s*(PRINCÍPIO|ARQUITETURA|REGRA|FORMATO|PROTOCOLO)[\s\S]*?(?=\n\n[A-Z])/im, '');

    result = result.replace(/"action"\s*:\s*\{[^}]*"type"\s*:\s*"tool"[^}]*\}/g, '');
    result = result.replace(/"evaluation"\s*:\s*\{[^}]*\}/g, '');
    result = result.replace(/"thought"\s*:\s*"[^"]*"[,\s]*/g, '');

    result = result.replace(/<think>[\s\S]*?<\/think>/gi, '');
    result = result.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
    result = result.replace(/^[🤔💭]\s*.*$/gm, '');
    result = result.replace(/^(?:Let me|I'll|I should|I need to|Vou|Preciso|Devo|Vou\s+analisar)\s+[^.!\n]*[.!]\s*/gi, '');
    result = result.replace(/"thought"\s*:\s*"[\s\S]*?"[,\s}]*$/gm, '');

    return result.trim();
}

export function parseLLMResponse(content: string): ParsedLLMResponse | null {
    if (!content) return null;

    const clean = sanitizeContent(content);
    try {
        return JSON.parse(clean);
    } catch {
        try {
            const match = content.match(/\{[\s\S]*\}/);
            if (match) {
                let jsonStr = match[0];
                jsonStr = jsonStr.replace(/```json/g, '').replace(/```/g, '');
                jsonStr = jsonStr.replace(/,\s*([\}\]])/g, '$1');
                return JSON.parse(jsonStr);
            }
        } catch {
            try {
                const contentMatch = content.match(/"content"\s*:\s*"([^"]*(?:""[^"]*)*)"/);
                if (contentMatch && contentMatch[1]) {
                    return {
                        action: { type: 'final_answer', content: contentMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') },
                        evaluation: { is_complete: true, confidence: 'low', reason: 'Extracted from partial JSON' }
                    };
                }
            } catch {
                /* fallback de parse: retorna null abaixo */
            }
            return null;
        }
    }
    return null;
}

export function extractFinalText(response: LLMResult, _atomicData: unknown): string {
    const normalized = normalizeFromRaw(response.content || '', parseLLMResponse);

    if (normalized.type !== 'empty' && normalized.content && normalized.content.trim().length > 0) {
        return normalized.content;
    }
    const sanitized = sanitizeContent(response.content || '');
    if (sanitized.length > 0) {
        return sanitized;
    }
    return 'Desculpe, não consegui gerar uma resposta adequada.';
}
