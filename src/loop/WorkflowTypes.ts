/**
 * WorkflowTypes — Tipos para o sistema de workflows com autorização estruturada.
 *
 * Substitui o modelo conversacional de auth ("sim"/"não" como texto) por
 * eventos tipados com IDs rastreáveis, eliminando a dependência de replay
 * episódico para continuação pós-autorização.
 */

export type WorkflowStatus =
    | 'pending_auth'
    | 'executing'
    | 'completed'
    | 'rejected'
    | 'failed'
    | 'timeout';

export type AuthDecision = 'approved' | 'rejected';

/**
 * Contexto compacto passado ao LLM pós-execução.
 * Design goal: < 300 tokens. Independente do histórico episódico.
 */
export interface ContinuationContext {
    /** Nome do workflow (ex: "pdf_summary", "file_edit") */
    workflow: string;
    /** Step atual do workflow (ex: "extract_text") */
    step: string;
    /** Objetivo original do usuário (truncado em 200 chars) */
    userGoal: string;
    /** Recursos ativos relevantes (ex: nomes de arquivos) */
    activeResources?: string[];
    /** Ferramentas alternativas disponíveis sem autorização */
    alternativeTools?: string[];
    /** Dados extras pequenos e serializáveis */
    metadata?: Record<string, string>;
}

/**
 * Transação de autorização — unidade atômica de um passo de workflow que
 * requer confirmação humana antes de ser executado.
 */
export interface AuthTransaction {
    /** ID único, incluído nos callbacks de botão como "auth:approve:<id>" */
    id: string;
    conversationId: string;
    tool: string;
    params: Record<string, unknown>;
    continuationCtx: ContinuationContext;
    status: WorkflowStatus;
    createdAt: number;
    /** Transação expira após TTL — evita acúmulo de estado zumbi */
    expiresAt: number;
}

/** Resultado de um passo de workflow após execução ou rejeição */
export interface WorkflowStepResult {
    success: boolean;
    output: string;
    decision: AuthDecision;
    continuationCtx: ContinuationContext;
    error?: string;
    /**
     * Artefatos que a tool executada declarou ter produzido (ToolResult.artifactPaths),
     * repassado sem alteração. Sprint F3 (revisão de código pós-piloto R1-R7): antes,
     * WorkflowEngine.resume() descartava esse campo do resultado real de tool.execute() ao
     * repassar só {success,output,decision,error,continuationCtx} — um step write/exec_command
     * que precisou de aprovação de auth e produziu um arquivo real perdia essa evidência antes
     * mesmo de chegar em GoalExecutionLoop, que também não a registrava em GoalAttempt.
     */
    artifactPaths?: string[];
}

/** Callback registrado pelo AgentController nos adapters de canal */
export type WorkflowCallbackFn = (
    userId: string,
    txnId: string,
    decision: AuthDecision,
    rawCtx: unknown
) => Promise<void>;
