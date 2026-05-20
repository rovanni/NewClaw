/**
 * ResponseAdapter — Unified response normalization with two strategies:
 * 
 * 1. normalizeResponse — FULL structure (obrigatório para AgentLoop, tools, ObserverValidator)
 *    Returns: { type, content, thought?, evaluation? }
 * 
 * 2. extractText — LIGHTWEIGHT extraction (para compressor, validator, onboarding)
 *    Returns: string (just the text content, no structure)
 * 
 * Rule: parseLLMResponse stays BEFORE normalizeResponse (complements, not replaces).
 * parseLLMResponse handles JSON parsing from raw LLM output.
 * normalizeResponse wraps the result into a standard structure.
 * extractText just pulls readable text from any LLM output.
 */

import type { ParsedLLMResponse } from './ContentExtractor';
import { sanitizeContent } from './agentOutputParser';


// ── Full structured response (AgentLoop, tools, ObserverValidator) ──

export interface NormalizedResponse {
    type: 'final_answer' | 'tool' | 'error' | 'empty';
    content: string;
    thought?: string;
    evaluation?: {
        is_complete: boolean;
        confidence: 'low' | 'medium' | 'high';
        reason?: string;
    };
    toolName?: string;
    toolInput?: Record<string, unknown>;
}

// ── Lightweight extraction result (compressor, validator, onboarding) ──

export type ExtractedText = string;

/**
 * normalizeResponse — Full structure normalization.
 * 
 * USE IN: AgentLoop, ObserverValidator, any service that needs to route
 * based on action type or inspect evaluation/confidence.
 * 
 * Always receives the result of parseLLMResponse first, then wraps it.
 * Pipeline: raw LLM → sanitizeContent → parseLLMResponse → normalizeResponse
 */
export function normalizeResponse(parsed: ParsedLLMResponse | null, rawContent: string): NormalizedResponse {
    // ── Case 1: parsed JSON from parseLLMResponse ──
    if (parsed && typeof parsed === 'object') {
        const action = parsed.action || {};
        const evaluation = parsed.evaluation;

        // Tool action
        if (action.type === 'tool' && action.name) {
            return {
                type: 'tool',
                content: action.content || '',
                thought: parsed.thought || undefined,
                evaluation: evaluation ? {
                    is_complete: !!evaluation.is_complete,
                    confidence: evaluation.confidence || 'medium',
                    reason: evaluation.reason
                } : undefined,
                toolName: action.name,
                toolInput: action.input || {}
            };
        }

        // Final answer
        if (action.type === 'final_answer' || action.content) {
            return {
                type: 'final_answer',
                content: action.content || '',
                thought: parsed.thought || undefined,
                evaluation: evaluation ? {
                    is_complete: !!evaluation.is_complete,
                    confidence: evaluation.confidence || 'medium',
                    reason: evaluation.reason
                } : undefined
            };
        }
    }

    // ── Case 2: fallback from raw content ──
    if (rawContent && rawContent.trim().length > 0) {
        return {
            type: 'final_answer',
            content: rawContent.trim()
        };
    }

    // ── Case 3: empty ──
    return {
        type: 'empty',
        content: ''
    };
}

/**
 * extractText — Lightweight text extraction.
 * 
 * USE IN: ContextCompressor, ContextValidator, OnboardingService,
 * and any service that only needs the readable text content.
 * 
 * No structure, no evaluation, no routing — just the text.
 */
export function extractText(content: string): ExtractedText {
    if (!content || !content.trim()) return '';

    // Try JSON parse (LLM may have returned structured JSON)
    try {
        const parsed = JSON.parse(content);
        if (parsed?.action?.content) return parsed.action.content;
        if (parsed?.content) return parsed.content;
        if (typeof parsed === 'string') return parsed;
    } catch {
        // Not JSON — continue
    }

    // Try extracting JSON block from mixed content
    try {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed?.action?.content) return parsed.action.content;
            if (parsed?.content) return parsed.content;
        }
    } catch {
        // Not JSON — continue
    }

    // Remove common LLM artifacts (thinking tags, tool call blocks)
    let text = content;
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
    text = text.replace(/<\/?think>/gi, '');
    text = text.replace(/\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]/gi, '');
    
    // Remove code fences wrapping entire response
    const codeFenceMatch = text.match(/^```[\s\S]*?```\s*$/);
    if (codeFenceMatch) {
        text = text.replace(/^```\w*\n?/, '').replace(/\n?```\s*$/, '');
    }

    return text.trim();
}

/**
 * Convenience: normalize from raw content (includes parsing step).
 * Pipeline: raw → sanitizeContent → parseLLMResponse → normalizeResponse
 * 
 * This is the recommended entry point for AgentLoop.
 */
export function normalizeFromRaw(rawContent: string, parseFn: (content: string) => ParsedLLMResponse | null): NormalizedResponse {
    const parsed = parseFn(rawContent);
    // Use sanitized content for Case 2 fallback so <think>/<thinking> tags never reach the user
    const sanitized = sanitizeContent(rawContent);
    return normalizeResponse(parsed, sanitized);
}