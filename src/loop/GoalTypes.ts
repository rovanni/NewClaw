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
    | 'missing_tool'         // tool não encontrada no sistema (ex: pdftotext) — veja needs_dependency para deps instaláveis
    | 'dependency_missing'   // dependência do sistema não instalada (pandoc, ffmpeg, etc.)
    | 'missing_permission'   // tool requer autorização explícita do usuário
    | 'tool_error'           // tool existe mas falhou repetidamente
    | 'context_insufficient' // informação insuficiente para prosseguir
    | 'goal_ambiguous'       // intenção do usuário está ambígua
    | 'environment_limit'    // limitação do sistema (sem internet, sem disco)
    | 'goal_incomplete'      // todos os steps rodaram mas LLM validou que o objetivo não foi atingido
    | 'repeated_tool_call'   // mesma tool chamada com mesmos args múltiplas vezes — loop sem progresso
    | 'placeholder_path'     // step contém path placeholder (ex: "caminho_do_arquivo_identificado")
    | 'hallucinated_tool'    // tool gerada pelo LLM não existe no ToolRegistry
    | 'partial_success'      // entregável existe mas pode não ser o formato ideal
    | 'workspace_missing';   // step precisa de contexto do workspace que não foi coletado

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

export type CycleOutcome = 'success' | 'partial' | 'blocked' | 'failed' | 'needs_auth' | 'needs_dependency';

export interface DependencyInfo {
    /** Nome do pacote/ferramenta (ex: "pandoc", "ffmpeg") */
    name: string;
    /** Comando de instalação automática (ex: "sudo apt install pandoc -y") */
    installCmd: string;
    /** Instrução legível para o usuário instalar manualmente */
    manualInstructions: string;
    type: 'system' | 'python' | 'node';
}

export interface CycleResult {
    outcome: CycleOutcome;
    confidence: number;
    output?: string;
    blocker?: GoalBlocker;
    authTxnId?: string;
    /** Inline keyboard options when outcome=needs_auth (preserves Telegram buttons) */
    authOptions?: { label: string; value: string }[];
    /** Populated when outcome=needs_dependency — informações da dependência ausente */
    depInfo?: DependencyInfo;
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
    /** true quando o objetivo é identificado como goal mas a intenção é ambígua — pedir clarificação */
    isAmbiguous?: boolean;
    /** Pergunta de clarificação sugerida quando isAmbiguous=true */
    clarificationQuestion?: string;
}

// ── Capabilities do ambiente ──────────────────────────────────────────────────

export interface EnvironmentCapabilities {
    tools: Record<string, boolean>;
    pythonPkgs: Record<string, boolean>;
    probeTimestamp: number;
    /** Bloco de texto pronto para injeção em prompts de planejamento. */
    summary: string;
}
