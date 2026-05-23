/**
 * ProtocolParser — Strict Cognitive Protocol Parser with Semantic Recovery
 *
 * Pipeline:
 *   LLM Response → Strict Parse → [parsed=YES] → StructuredAgentResponse
 *                          ↓
 *                   [parsed=NO] → semanticRecovery → planning (short) | final_answer (long)
 *                                        ↓
 *                              Recovery Prompt → Reparse → [parsed=YES]
 *                                                      ↓
 *                                               [parsed=NO] → ProtocolViolationError
 *
 * Semantic recovery uses content length as a heuristic: substantive responses
 * (≥ MIN_FINAL_ANSWER_LENGTH chars) are treated as final answers; short fragments
 * (typically activity-timeout artifacts) are treated as planning and retried.
 */

import { createLogger } from '../shared/AppLogger';
import type { ParsedLLMResponse } from './ContentExtractor';
import {
    StructuredAgentResponse,
    ConfidenceLevel,
    ProtocolViolationError,
    ProtocolMetrics,
} from './ProtocolTypes';

const log = createLogger('ProtocolParser');

// ── Recovery prompt for re-structuring ──

const RECOVERY_PROMPT = `[ERRO DE PROTOCOLO]
Sua resposta não foi um JSON válido. 
CORRIJA IMEDIATAMENTE seguindo o formato:
{
  "thought": "análise",
  "action": { "type": "tool" | "final_answer", "name": "...", "input": {}, "content": "..." },
  "evaluation": { "is_complete": bool, "confidence": "...", "reason": "..." }
}
Responda APENAS o JSON. Sem texto adicional.`;

const MAX_RECOVERY_ATTEMPTS = 2;
const MIN_FINAL_ANSWER_LENGTH = 500;

export class ProtocolParser {
    private metrics = new ProtocolMetrics();
    private currentProvider = 'unknown';
    private currentModel = 'unknown';

    /** Set the current provider/model context for violation reporting */
    setProviderContext(provider: string, model: string): void {
        this.currentProvider = provider;
        this.currentModel = model;
    }

    /** Get protocol metrics snapshot */
    getMetrics(): ProtocolMetrics {
        return this.metrics;
    }

    /**
     * STRICT PARSE — Primary parsing pipeline.
     * 
     * Parses LLM response into StructuredAgentResponse.
     * Returns null ONLY when the response is genuinely empty.
     * Throws ProtocolViolationError when recovery fails.
     */
    strictParse(content: string, hasNativeToolCalls = false): StructuredAgentResponse | null {
        if (!content || !content.trim()) {
            return null;
        }

        // ── Stage 0: Native tool calls already extracted by caller ──
        // When the model communicates via response.toolCalls[] (e.g. kimi-k2.6, qwen),
        // the content field may contain raw thinking text — not a JSON protocol response.
        // Skip format validation entirely; the caller handles tool execution.
        if (hasNativeToolCalls) {
            this.metrics.recordCompliant();
            log.info(`[PROTOCOL] ✅ Native tool_call format — skipping content parse, delegating to caller`);
            return null;
        }

        // ── Stage 1: Direct JSON parse ──
        const directParsed = this.attemptJsonParse(content);
        if (directParsed) {
            const structured = this.normalizeToStructured(directParsed);
            if (structured) {
                this.metrics.recordCompliant();
                log.info(`[PROTOCOL] ✅ Strict parse success (type=${structured.type}, isComplete=${structured.isComplete})`);
                return structured;
            }
        }

        // ── Stage 2: Native tool calls (Ollama/OpenAI format) ──
        // If content has tool_calls, we don't need JSON — the tool calls ARE the structure.
        // This is handled upstream in AgentLoop, so we return null to let the caller handle it.
        // But we record this as a protocol pass since the model IS following a protocol,
        // just not our custom JSON one.
        if (this.hasNativeToolCallStructure(content)) {
            this.metrics.recordCompliant();
            log.info(`[PROTOCOL] ✅ Native tool_call format detected — delegating to caller`);
            return null; // Caller handles native tool_calls
        }

        // ── Stage 3: Protocol Violation — cannot parse ──
        this.metrics.recordViolation(this.currentModel);
        log.warn(`[PROTOCOL] ⚠️ Strict parse FAILED — content not in structured format. Length=${content.length}`);

        // Build a StructuredAgentResponse from the violation
        // This is the SEMANTIC RECOVERY — we preserve the content but mark it as unverified
        return this.semanticRecovery(content);
    }

    /**
     * RECOVERY PROMPT — Returns the system message to send back to the LLM
     * when strict parse fails, asking it to restructure in valid JSON.
     */
    getRecoveryPrompt(): string {
        return RECOVERY_PROMPT;
    }

    /**
     * RECOVERY PARSE — Attempt to parse a recovery response.
     * Called after the LLM is given the recovery prompt.
     */
    recoveryParse(content: string, attempt: number): StructuredAgentResponse | ProtocolViolationError {
        const parsed = this.attemptJsonParse(content);
        if (parsed) {
            const structured = this.normalizeToStructured(parsed);
            if (structured) {
                this.metrics.recordRecoverySuccess();
                log.info(`[PROTOCOL] ✅ Recovery parse success on attempt ${attempt}`);
                return structured;
            }
        }

        if (attempt >= MAX_RECOVERY_ATTEMPTS) {
            this.metrics.recordRecoveryFailure();
            log.error(`[PROTOCOL] ❌ Recovery FAILED after ${attempt} attempts`);
            return new ProtocolViolationError('critical', {
                rawResponse: content.slice(0, 500),
                provider: this.currentProvider,
                model: this.currentModel,
                parsingStage: 'recovery_prompt',
                recoveryAttempts: attempt,
                correlationId: `pv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                timestamp: Date.now(),
            });
        }

        // More attempts remaining
        return this.semanticRecovery(content);
    }

    // ── Private Methods ──

    /**
     * Attempt JSON parse with multiple strategies.
     */
    private attemptJsonParse(content: string): ParsedLLMResponse | null {
        // Strategy 1: Direct parse
        try {
            return JSON.parse(content.trim());
        } catch {
            /* Strategy 1 failed: Not a direct JSON string, moving to block extraction */
        }

        // Strategy 2: Extract JSON block from mixed content.
        // Walks the string char-by-char to find the outermost balanced {} block,
        // avoiding the greedy-regex pitfall of matching from the first '{' to the
        // last '}' across multiple disjoint JSON objects or trailing punctuation.
        try {
            const start = content.indexOf('{');
            if (start !== -1) {
                let depth = 0;
                let end = -1;
                for (let i = start; i < content.length; i++) {
                    if (content[i] === '{') depth++;
                    else if (content[i] === '}') {
                        depth--;
                        if (depth === 0) { end = i; break; }
                    }
                }
                if (end !== -1) {
                    let jsonStr = content.slice(start, end + 1);
                    jsonStr = jsonStr.replace(/```json/g, '').replace(/```/g, '');
                    jsonStr = jsonStr.replace(/,\s*([\}\]])/g, '$1');
                    return JSON.parse(jsonStr);
                }
            }
        } catch {
            /* Strategy 2 failed: Block found but not valid JSON, moving to partial extraction */
        }

        // Strategy 3: Extract partial content from malformed JSON
        // Guard: if content looks like a tool call, don't misidentify action.input.content
        // as a final_answer. This happens when a model embeds large file content (HTML/code)
        // in a JSON tool call and JSON.parse fails — the "content" key found belongs to the
        // tool input, not to a final_answer action.
        try {
            if (!/"type"\s*:\s*"tool"/.test(content)) {
                const contentMatch = content.match(/"content"\s*:\s*"([^"]*(?:""[^"]*)*)"/);
                if (contentMatch?.[1]) {
                    return {
                        action: {
                            type: 'final_answer',
                            content: contentMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"'),
                        },
                        evaluation: {
                            is_complete: true,
                            confidence: 'low' as ConfidenceLevel,
                            reason: 'Extracted from partial JSON',
                        },
                    };
                }
            }
            } catch {
                /* Strategy 3 failed: Could not even extract partial content */
            }

        return null;
    }

    /**
     * Normalize parsed JSON into StructuredAgentResponse.
     * 
     * Maps the model's JSON format into the canonical protocol type.
     * Returns null if the parsed object doesn't match any known structure.
     */
    private normalizeToStructured(parsed: ParsedLLMResponse): StructuredAgentResponse | null {
        if (!parsed || typeof parsed !== 'object') return null;

        const action = parsed.action || {};
        const evaluation = parsed.evaluation;
        const thought = parsed.thought || undefined;

        // ── Tool call ──
        if (action.type === 'tool' && action.name) {
            return {
                type: 'tool_call',
                content: action.content || '',
                thought,
                toolCalls: [{ name: action.name, input: action.input || {} }],
                isComplete: false, // Tool calls are NEVER complete — loop must continue
                confidence: evaluation?.confidence || 'medium',
                reasoningRequired: true,
                evaluation: evaluation ? {
                    is_complete: !!evaluation.is_complete,
                    confidence: evaluation.confidence || 'medium',
                    reason: evaluation.reason,
                } : { is_complete: false, confidence: 'medium', reason: 'Tool call pending execution' },
            };
        }

        // ── Final answer ──
        if (action.type === 'final_answer') {
            return {
                type: 'final_answer',
                content: action.content || '',
                thought,
                isComplete: evaluation?.is_complete !== false, // Default true unless explicitly false
                confidence: evaluation?.confidence || 'medium',
                evaluation: evaluation ? {
                    is_complete: !!evaluation.is_complete,
                    confidence: evaluation.confidence || 'medium',
                    reason: evaluation.reason,
                } : { is_complete: true, confidence: 'medium', reason: 'Implicit final answer' },
            };
        }

        // ── Planning (model is reasoning, no action yet) ──
        if (parsed.thought && !action.type && !action.content) {
            return {
                type: 'planning',
                content: '',
                thought: parsed.thought,
                isComplete: false,
                confidence: 'low',
                reasoningRequired: true,
                evaluation: { is_complete: false, confidence: 'low', reason: 'Planning — no action taken yet' },
            };
        }

        return null;
    }

    /**
     * Detect if content contains native tool_call structure (Ollama/OpenAI format).
     * This is a STRUCTURAL check, not a heuristic — we look for JSON with "function" keys.
     */
    private hasNativeToolCallStructure(content: string): boolean {
        // Native tool calls arrive via response.toolCalls, not in content.
        // If we're here, the content itself might contain tool call markers.
        if (content.includes('[TOOL_CALL]') || content.includes('"function_call"')) {
            return true;
        }
        // Deepseek DSML format leaked into content (｜ = U+FF5C full-width pipe)
        if (content.includes('<｜DSML｜') || content.includes('<|DSML|')) {
            log.warn('[PROTOCOL] ⚠️ Deepseek DSML tool call leaked into content — stripping');
            return true;
        }
        return false;
    }

    /**
     * SEMANTIC RECOVERY — Convert unstructured content into a StructuredAgentResponse.
     *
     * Uses content length as the primary heuristic:
     * - ≥ MIN_FINAL_ANSWER_LENGTH chars → final_answer (isComplete=true): model likely finished
     * - < MIN_FINAL_ANSWER_LENGTH chars → planning (isComplete=false): likely a timeout fragment
     *
     * The runtime should then for planning:
     * 1. Inject a recovery prompt
     * 2. Let the LLM restructure its response
     * 3. Retry the strict parse
     */
    private semanticRecovery(content: string): StructuredAgentResponse {
        const trimmed = content.trim();

        // Substantive plain-text responses (≥500 chars, no tool-call markers) are treated
        // as final answers. Short fragments (<500 chars) are typically activity-timeout
        // artifacts — keep them as planning so the loop retries.
        if (trimmed.length >= MIN_FINAL_ANSWER_LENGTH && !this.hasNativeToolCallStructure(trimmed)) {
            log.warn(`[PROTOCOL] 🔄 Semantic recovery — substantive plain-text (${trimmed.length} chars) treated as final_answer`);
            return {
                type: 'final_answer',
                content: trimmed,
                isComplete: true,
                confidence: 'low',
                evaluation: {
                    is_complete: true,
                    confidence: 'low',
                    reason: 'Protocol violation: long unstructured content recovered as final answer.',
                },
                metadata: {
                    protocolViolation: true,
                    rawContentLength: trimmed.length,
                    recoveryNeeded: false,
                },
            };
        }

        log.warn(`[PROTOCOL] 🔄 Semantic recovery — wrapping unstructured content as 'planning' with isComplete=false`);
        return {
            type: 'planning',
            content: trimmed,
            isComplete: false,
            confidence: 'low',
            reasoningRequired: true,
            evaluation: {
                is_complete: false,
                confidence: 'low',
                reason: 'Protocol violation: response not in structured format. Recovery required.',
            },
            metadata: {
                protocolViolation: true,
                rawContentLength: trimmed.length,
                recoveryNeeded: true,
            },
        };
    }
}