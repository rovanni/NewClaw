/** Shape of raw finding parsed from LLM JSON output */
export interface LLMFinding {
    severity?: string; line?: number; title?: string; description?: string;
    suggestion?: string; autoFixable?: boolean; riskLevel?: string;
    [key: string]: unknown;
}

/** Ollama models list response */
export interface OllamaModelsResponse { models?: Array<{ name: string; [key: string]: unknown }> }

export interface AuditFinding {
    severity: 'critical' | 'warning' | 'info';
    category: 'code' | 'runtime' | 'data' | 'integration' | 'security';
    file?: string;
    line?: number;
    title: string;
    description: string;
    suggestion?: string;
    autoFixable: boolean;
    fixed?: boolean;
    riskLevel?: 'low' | 'medium' | 'high';
}

export interface AuditReport {
    timestamp: string;
    totalFindings: number;
    critical: number;
    warnings: number;
    info: number;
    findings: AuditFinding[];
    durationMs: number;
    summary: string;
}

export interface AuditConfig {
    ollamaUrl: string;
    model: string;
    dbPath: string;
    srcPath: string;
    logsPath: string;
    ownerChatId: string;
    maxFindingsPerCategory: number;
    enableAutoFix: boolean;
}

/** Audit finding row as stored in SQLite (snake_case columns) */
export interface DbFinding {
    id?: number; severity?: string; category?: string;
    file_path?: string; line_number?: number;
    title?: string; description?: string; suggestion?: string;
    auto_fixable?: number; fixed?: number; risk_level?: string;
    [key: string]: unknown;
}

/** Audit report row as stored in SQLite (snake_case columns) */
export interface DbAuditReport {
    id?: number; timestamp?: string; total_findings?: number;
    critical?: number; warnings?: number; info_count?: number;
    summary?: string; duration_ms?: number;
    [key: string]: unknown;
}

export interface GeneratedPatch {
    file: string;
    before: string;
    after: string;
    confidence: number;
    summary: string;
}

export interface AgentOpinion {
    agent: string;
    approve: boolean;
    confidence: number;
    reason: string;
}

export interface PatchValidation {
    opinions: AgentOpinion[];
}

export interface ConsensusResult {
    agreement: number;
    confidence: number;
    approved: boolean;
}

export interface PatchSafetyResult {
    validSyntax: boolean;
    fileExists: boolean;
    changeSizeOk: boolean;
    riskyChange: boolean;
    safe: boolean;
    reasons: string[];
}

export interface FixResult {
    findingId: number;
    title: string;
    status: 'applied' | 'rejected' | 'error';
    reason?: string;
    patchSummary?: string;
}

export interface FixReport {
    timestamp: string;
    totalAnalyzed: number;
    applied: number;
    rejected: number;
    errors: number;
    results: FixResult[];
    durationMs: number;
}
