/**
 * ContentExtractor — Content extraction and sanitization utilities.
 *
 * TWO consumption paths:
 *
 *   1. SIMPLE flows (compressor, validator, onboarding, model router):
 *      → Use extractText(response) — lightweight, returns string only.
 *
 *   2. STRUCTURED flows (AgentLoop, tools):
 *      → Use ResponseAdapter.normalizeResponse(response) — returns NormalizedResponse.
 *
 * This module has NO dependency on ResponseAdapter (no circular imports).
 * ResponseAdapter imports from here (sanitizeContent).
 */

// ── sanitizeContent ────────────────────────────────────────────────────────────

/**
 * Remove technical artifacts from LLM output (think tags, tool call leaks, etc.).
 */
export function sanitizeContent(content: string): string {
    if (!content) return '';
    let result = content;

    // Remove tags técnicas disruptivas
    result = result.replace(/<tool_call>[\s\S]*?<\/think>/gi, '');
    result = result.replace(/<\/?think>/gi, '');
    result = result.replace(/\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]/gi, '');

    // Remove negritos residuais (**)
    result = result.replace(/\*\*/g, '');

    // ── Anti-leak: Remove JSON/code blocks that the LLM sometimes outputs raw ──
    const trimmed = result.trim();

    // Pattern: entire response is JSON with action/thought/evaluation
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

    // Remove code fences wrapping the entire response
    const codeFenceMatch = result.match(/^```[\s\S]*?```\s*$/);
    if (codeFenceMatch) {
        const inner = result.replace(/^```\w*\n?/, '').replace(/\n?```\s*$/, '');
        if (inner.length > 0) result = inner;
    }

    // Remove leaked system prompt fragments
    result = result.replace(/^Você é o núcleo cognitivo[\s\S]*?(?=\n\n|\n[A-Z])/i, '');
    result = result.replace(/^##\s*(PRINCÍPIO|ARQUITETURA|REGRA|FORMATO|PROTOCOLO)[\s\S]*?(?=\n\n[A-Z])/im, '');

    // Remove leftover JSON action blocks that leaked
    result = result.replace(/"action"\s*:\s*\{[^}]*"type"\s*:\s*"tool"[^}]*\}/g, '');
    result = result.replace(/"evaluation"\s*:\s*\{[^}]*\}/g, '');
    // Clean up "thought" leaks
    result = result.replace(/"thought"\s*:\s*"[^"]*"[,\s]*/g, '');

    return result.trim();
}

// ── parseLLMResponse ─────────────────────────────────────────────────────────

/**
 * Parse a raw LLM response string and extract the structured atomic data
 * (action, thought, evaluation) if present.
 *
 * This COMPLEMENTS normalizeResponse — it does NOT replace it.
 * Use parseLLMResponse for flow control (is_complete, action.type, tool dispatch).
 * Use normalizeResponse for content extraction (text, toolCalls, raw).
 */
export function parseLLMResponse(raw: string): { action: any; thought: any; evaluation: any } | null {
    if (!raw || !raw.trim()) return null;

    const trimmed = raw.trim();

    // Direct JSON
    if (trimmed.startsWith('{')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed.action || parsed.thought || parsed.evaluation) return parsed;
        } catch { /* not JSON */ }
    }

    // JSON inside code fence
    const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) {
        try {
            const parsed = JSON.parse(fenceMatch[1]);
            if (parsed.action || parsed.thought || parsed.evaluation) return parsed;
        } catch { /* not JSON */ }
    }

    // JSON embedded in text
    const jsonMatch = trimmed.match(/\{[\s\S]*"action"[\s\S]*\}/);
    if (jsonMatch) {
        try {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed.action) return parsed;
        } catch { /* not JSON */ }
    }

    return null;
}

// ── extractText (lightweight) ─────────────────────────────────────────────────

/**
 * Lightweight text extraction for SIMPLE flows.
 *
 * Use this in: ContextCompressor, ObserverValidator, ModelRouter, OnboardingService
 * — places that only need the text and don't care about toolCalls or raw.
 *
 * For STRUCTURED flows (AgentLoop), use ResponseAdapter.normalizeResponse() instead.
 *
 * Priority: action.content > response.content > sanitized > fallback
 * Never returns empty string.
 */
export function extractText(response: any): string {
    if (!response) return '';

    // If it's already a string, sanitize and return
    if (typeof response === 'string') {
        return sanitizeContent(response) || '';
    }

    // Priority 1: action.content (atomic JSON)
    if (response.action?.content && typeof response.action.content === 'string' && response.action.content.trim().length > 0) {
        return response.action.content;
    }

    // Priority 2: response.content (generic/Ollama)
    if (response.content && typeof response.content === 'string') {
        const sanitized = sanitizeContent(response.content);
        if (sanitized.length > 0) return sanitized;
    }

    // Priority 3: OpenAI-like
    if (response.choices?.[0]?.message?.content) {
        return response.choices[0].message.content;
    }

    return '';
}