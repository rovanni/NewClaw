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

// ── Protocol Types (inlined from ProtocolTypes.ts) ────────────────────────────

export type AgentActionType =
    | 'final_answer'    // Task complete, delivering answer
    | 'tool_call'       // Requesting tool execution
    | 'planning'        // Reasoning about next steps (no action yet)
    | 'clarification'  // Asking user for more info
    | 'error';          // Explicit error state

export type ConfidenceLevel = 'low' | 'medium' | 'high';

export interface StructuredAgentResponse {
    type: AgentActionType;
    content?: string;
    thought?: string;
    toolCalls?: ToolCallRequest[];
    isComplete: boolean;
    confidence: ConfidenceLevel;
    reasoningRequired?: boolean;
    evaluation?: {
        is_complete: boolean;
        confidence: ConfidenceLevel;
        reason?: string;
    };
    metadata?: Record<string, unknown>;
}

export interface ToolCallRequest {
    name: string;
    input: Record<string, unknown>;
}

export type ViolationSeverity = 'recoverable' | 'critical';

export interface ProtocolViolationDetails {
    rawResponse: string;
    provider: string;
    model: string;
    parsingStage: 'strict_parse' | 'recovery_parse' | 'recovery_prompt';
    recoveryAttempts: number;
    correlationId: string;
    timestamp: number;
}

export class ProtocolViolationError extends Error {
    public readonly severity: ViolationSeverity;
    public readonly details: ProtocolViolationDetails;

    constructor(severity: ViolationSeverity, details: ProtocolViolationDetails) {
        const msg = severity === 'critical'
            ? `[PROTOCOL-VIOLATION] Critical: LLM failed structured protocol after ${details.recoveryAttempts} recovery attempts (provider=${details.provider}, model=${details.model}, stage=${details.parsingStage})`
            : `[PROTOCOL-VIOLATION] Recoverable: LLM response did not follow structured protocol (provider=${details.provider}, model=${details.model}, stage=${details.parsingStage})`;

        super(msg);
        this.name = 'ProtocolViolationError';
        this.severity = severity;
        this.details = details;
    }

    toTraceData(): Record<string, unknown> {
        return {
            error_type: 'ProtocolViolationError',
            severity: this.severity,
            raw_response_preview: this.details.rawResponse.slice(0, 200),
            provider: this.details.provider,
            model: this.details.model,
            parsing_stage: this.details.parsingStage,
            recovery_attempts: this.details.recoveryAttempts,
            correlation_id: this.details.correlationId,
            timestamp: this.details.timestamp,
        };
    }
}

export interface ProtocolMetricsSnapshot {
    compliantCount: number;
    violationCount: number;
    recoverySuccessCount: number;
    recoveryFailureCount: number;
    complianceRate: number;
    recoverySuccessRate: number;
    violationsByModel: Record<string, number>;
    timestamp: number;
}

export class ProtocolMetrics {
    private compliantCount = 0;
    private violationCount = 0;
    private recoverySuccessCount = 0;
    private recoveryFailureCount = 0;
    private violationsByModel: Record<string, number> = {};

    recordCompliant(): void { this.compliantCount++; }
    recordViolation(model: string): void {
        this.violationCount++;
        this.violationsByModel[model] = (this.violationsByModel[model] || 0) + 1;
    }
    recordRecoverySuccess(): void { this.recoverySuccessCount++; }
    recordRecoveryFailure(): void { this.recoveryFailureCount++; }

    snapshot(): ProtocolMetricsSnapshot {
        const total = this.compliantCount + this.violationCount;
        const recoveryTotal = this.recoverySuccessCount + this.recoveryFailureCount;
        return {
            compliantCount: this.compliantCount,
            violationCount: this.violationCount,
            recoverySuccessCount: this.recoverySuccessCount,
            recoveryFailureCount: this.recoveryFailureCount,
            complianceRate: total > 0 ? this.compliantCount / total : 1,
            recoverySuccessRate: recoveryTotal > 0 ? this.recoverySuccessCount / recoveryTotal : 1,
            violationsByModel: { ...this.violationsByModel },
            timestamp: Date.now(),
        };
    }
}

// ── End of inlined types ───────────────────────────────────────────────────────

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
const MIN_FINAL_ANSWER_LENGTH = 10;

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
        const recovered = this.semanticRecovery(content);
        // Obs #10: log estruturado de recovery para rastrear frequência e tipo de falha
        log.info(
            `[PROTOCOL-RECOVERY] reason="strict_parse_failed" response_length=${content.length} ` +
            `recovered=${recovered !== null} recovered_as=${recovered?.type ?? 'null'} ` +
            `model=${this.currentModel ?? 'unknown'}`
        );
        return recovered;
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
     *
     * NOTE: [TOOL_CALL] is intentionally NOT checked here. Models like kimi-k2.6 write
     * "[TOOL_CALL]" as plain text inside their thinking/reasoning field when planning which
     * tool to call next. That text ends up as content when the provider falls back to the
     * thinking field (no actual content was emitted). Treating it as a native tool call
     * would cause semanticRecovery to always return 'planning', creating unnecessary retry
     * cycles. Real native tool calls arrive via response.toolCalls[] and never reach here.
     */
    private hasNativeToolCallStructure(content: string): boolean {
        // Deepseek DSML format leaked into content (｜ = U+FF5C full-width pipe)
        if (content.includes('<｜DSML｜') || content.includes('<|DSML|')) {
            log.warn('[PROTOCOL] ⚠️ Deepseek DSML tool call leaked into content — stripping');
            return true;
        }
        // Actual JSON function_call structure (OpenAI/Ollama format in content field)
        if (content.includes('"function_call"') && content.includes('"name"')) {
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