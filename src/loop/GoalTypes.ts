/**
 * GoalTypes — Tipos centrais do Goal-Centered Cognitive Runtime.
 *
 * Um Goal representa um objetivo persistente do usuário que pode sobreviver
 * múltiplos ciclos de execução, falhas de tool e replanning, até ser concluído
 * ou atingir os limites de safety.
 *
 * Filosofia: falha de tool não encerra o goal — vira um GoalBlocker que dispara
 * replanning. O goal só morre quando: completado, TTL expirado, budget esgotado
 * ou abandonado explicitamente pelo usuário.
 */

// ── Status ────────────────────────────────────────────────────────────────────

export type GoalStatus =
    | 'active'       // objetivo vivo, aguardando próxima ação
    | 'executing'    // ciclo de execução em andamento
    | 'blocked'      // blocker detectado, aguardando replan ou auth
    | 'replanning'   // GoalPlanner calculando nova estratégia
    | 'completed'    // objetivo atingido com sucesso
    | 'failed'       // budget esgotado, sem progresso possível
    | 'abandoned';   // cancelado pelo usuário ou TTL expirado

// ── Blockers ──────────────────────────────────────────────────────────────────

export type BlockerKind =
    | 'missing_tool'         // tool não encontrada no sistema (ex: pdftotext)
    | 'missing_permission'   // tool requer autorização explícita do usuário
    | 'tool_error'           // tool existe mas falhou repetidamente
    | 'context_insufficient' // informação insuficiente para prosseguir
    | 'goal_ambiguous'       // intenção do usuário está ambígua
    | 'environment_limit'    // limitação do sistema (sem internet, sem disco)
    | 'goal_incomplete';     // todos os steps rodaram mas LLM validou que o objetivo não foi atingido

export interface GoalBlocker {
    kind: BlockerKind;
    toolName?: string;
    description: string;
    /** Ações sugeridas — GoalPlanner usa isso como input para replan */
    suggestedActions: string[];
    detectedAt: number;
}

// ── Plan ──────────────────────────────────────────────────────────────────────

export interface PlanStep {
    id: string;
    description: string;
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    /** Alternativas se este step falhar */
    fallbackSteps?: PlanStep[];
    status: 'pending' | 'executing' | 'completed' | 'skipped' | 'failed';
    executedAt?: number;
    result?: string;
}

// ── Attempts ─────────────────────────────────────────────────────────────────

export interface GoalAttempt {
    id: string;
    planStepId: string;
    toolName: string;
    args: Record<string, unknown>;
    result: 'success' | 'failure' | 'partial';
    output?: string;
    error?: string;
    durationMs: number;
    executedAt: number;
}

// ── Goal ──────────────────────────────────────────────────────────────────────

export interface Goal {
    id: string;                        // "goal_<timestamp>_<rand5>"
    sessionKey: string;                // "telegram:userId"
    conversationId: string;

    userIntent: string;                // texto original do usuário (≤300 chars)
    objective: string;                 // interpretação estruturada (≤500 chars)

    status: GoalStatus;
    currentPlan: PlanStep[];
    attempts: GoalAttempt[];
    blockers: GoalBlocker[];

    toolsTried: string[];              // set de tool names já tentados
    strategiesTried: string[];        // descrições de estratégias tentadas

    nextAction?: string;               // próxima ação calculada pelo GoalPlanner

    retryBudget: number;               // tentativas restantes por step
    replanBudget: number;              // replans restantes

    confidence: number;                // 0-1: confiança de que o objetivo é alcançável

    requiresAuth: boolean;
    authorizationScope: string[];      // tools autorizadas para este goal
    pendingTxnId?: string;            // ID de AuthTransaction pendente

    createdAt: number;
    updatedAt: number;
    expiresAt: number;                 // TTL: unix ms
    completedAt?: number;
}

// ── Resultados ────────────────────────────────────────────────────────────────

export type CycleOutcome = 'success' | 'partial' | 'blocked' | 'failed' | 'needs_auth';

export interface CycleResult {
    outcome: CycleOutcome;
    confidence: number;
    output?: string;
    blocker?: GoalBlocker;
    authTxnId?: string;
    /** Inline keyboard options when outcome=needs_auth (preserves Telegram buttons) */
    authOptions?: { label: string; value: string }[];
}

export interface GoalResult {
    goal: Goal;
    success: boolean;
    finalOutput: string;
    totalCycles: number;
    totalAttempts: number;
    totalReplans: number;
    /** Preserved from CycleResult when goal was blocked by auth */
    authOptions?: { label: string; value: string }[];
}

export interface GoalProgressUpdate {
    goalId: string;
    cycle: number;
    event:
        | 'cycle_start'
        | 'tool_executing'
        | 'tool_completed'
        | 'tool_failed'
        | 'replanning'
        | 'blocked'
        | 'completed'
        | 'failed';
    message?: string;
}

// ── Classificação de goal ─────────────────────────────────────────────────────

export interface GoalClassification {
    isGoal: boolean;
    confidence: number;
    objective?: string;
    requiredTools?: string[];
    estimatedSteps?: number;
    reason?: string;
}
