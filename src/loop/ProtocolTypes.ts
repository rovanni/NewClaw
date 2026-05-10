/**
 * ProtocolTypes — Strict Cognitive Protocol Type Definitions
 * 
 * Defines the structured contract between LLM responses and the runtime.
 * The runtime operates ONLY on these types — never on raw text interpretation.
 * 
 * Architecture:
 * - StructuredAgentResponse: canonical response type
 * - ProtocolViolationError: explicit failure when protocol is broken
 * - ProtocolMetrics: observability for protocol compliance
 */

// ── Structured Response Types ──

export type AgentActionType =
    | 'final_answer'    // Task complete, delivering answer
    | 'tool_call'       // Requesting tool execution
    | 'planning'        // Reasoning about next steps (no action yet)
    | 'clarification'  // Asking user for more info
    | 'error';          // Explicit error state

export type ConfidenceLevel = 'low' | 'medium' | 'high';

export interface StructuredAgentResponse {
    /** Canonical type — the runtime decides loop behavior based on this */
    type: AgentActionType;

    /** Text content for the user (final_answer, clarification, error) */
    content?: string;

    /** Internal reasoning — never shown to user */
    thought?: string;

    /** Tool calls requested (when type=tool_call) */
    toolCalls?: ToolCallRequest[];

    /** Is the task complete? Runtime MUST NOT exit early when false */
    isComplete: boolean;

    /** Confidence in the response/decision */
    confidence: ConfidenceLevel;

    /** Does this step require more reasoning/tool calls? */
    reasoningRequired?: boolean;

    /** Structured evaluation metadata */
    evaluation?: {
        is_complete: boolean;
        confidence: ConfidenceLevel;
        reason?: string;
    };

    /** Opaque metadata for diagnostics */
    metadata?: Record<string, unknown>;
}

export interface ToolCallRequest {
    name: string;
    input: Record<string, unknown>;
}

// ── Protocol Violation Error ──

export type ViolationSeverity = 'recoverable' | 'critical';

export interface ProtocolViolationDetails {
    /** Raw LLM response that failed parsing */
    rawResponse: string;

    /** Which LLM provider generated this response */
    provider: string;

    /** Which model generated this response */
    model: string;

    /** Which parsing stage failed */
    parsingStage: 'strict_parse' | 'recovery_parse' | 'recovery_prompt';

    /** How many recovery attempts were made */
    recoveryAttempts: number;

    /** Correlation ID for trace linking */
    correlationId: string;

    /** Timestamp */
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

    /** Serialize for ExecutionTrace integration */
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

// ── Protocol Metrics ──

export interface ProtocolMetricsSnapshot {
    /** Total protocol-compliant responses */
    compliantCount: number;

    /** Total protocol violations (parsed=NO) */
    violationCount: number;

    /** Successful recoveries from violations */
    recoverySuccessCount: number;

    /** Failed recoveries (exhausted attempts) */
    recoveryFailureCount: number;

    /** Compliance rate: compliant / total */
    complianceRate: number;

    /** Recovery success rate: success / (success + failure) */
    recoverySuccessRate: number;

    /** Violations per provider/model */
    violationsByModel: Record<string, number>;

    /** Timestamp of this snapshot */
    timestamp: number;
}

export class ProtocolMetrics {
    private compliantCount = 0;
    private violationCount = 0;
    private recoverySuccessCount = 0;
    private recoveryFailureCount = 0;
    private violationsByModel: Record<string, number> = {};

    recordCompliant(): void {
        this.compliantCount++;
    }

    recordViolation(model: string): void {
        this.violationCount++;
        this.violationsByModel[model] = (this.violationsByModel[model] || 0) + 1;
    }

    recordRecoverySuccess(): void {
        this.recoverySuccessCount++;
    }

    recordRecoveryFailure(): void {
        this.recoveryFailureCount++;
    }

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