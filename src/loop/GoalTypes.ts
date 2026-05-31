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
    | 'placeholder_path'         // step contém path placeholder (ex: "caminho_do_arquivo_identificado")
    | 'hallucinated_tool'        // tool gerada pelo LLM não existe no ToolRegistry
    | 'partial_success'          // entregável existe mas pode não ser o formato ideal
    | 'workspace_missing'        // step precisa de contexto do workspace que não foi coletado
    | 'required_artifact_missing'; // artefato obrigatório existe mas está vazio — goal de modificação não pode prosseguir

export interface GoalBlocker {
    kind: BlockerKind;
    toolName?: string;
    description: string;
    /** Ações sugeridas — GoalPlanner usa isso como input para replan */
    suggestedActions: string[];
    detectedAt: number;
}

// ── Success Criteria (checklist de conclusão) ─────────────────────────────────

/**
 * Tipo de verificação determinística que prova que um critério foi cumprido.
 *
 * - tool_succeeded      → algum attempt com toolName teve result='success'
 * - output_not_contains → o output de um attempt bem-sucedido NÃO contém `value`
 * - output_contains     → o output de um attempt bem-sucedido contém `value`
 * - file_exists         → exec_command retornou output não-vazio (arquivo encontrado)
 */
export type CriterionCheck =
    | 'tool_succeeded'
    | 'output_not_contains'
    | 'output_contains'
    | 'file_exists';

export interface SuccessCriterion {
    id: string;
    description: string;
    check: CriterionCheck;
    /** Tool cujo attempt deve ser analisado */
    tool?: string;
    /** Texto a verificar para output_contains / output_not_contains */
    value?: string;
    /** Resultado da última avaliação determinística */
    status: 'pending' | 'met' | 'unverifiable';
    metAt?: number;
    /** Trecho de evidence que provou o critério */
    evidence?: string;
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

/** Auditoria de uma mutação feita pelo ProactiveRecovery (arg mutation ou fallback tool). */
export interface ToolMutation {
    originalTool: string;
    finalTool: string;
    originalArgs: Record<string, unknown>;
    finalArgs: Record<string, unknown>;
    kind: 'arg_mutation' | 'fallback_tool';
}

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
    /** Ciclo de execução do GoalExecutionLoop em que este attempt ocorreu */
    cycle?: number;
    /** Descobertas feitas durante este attempt (ex: conteúdo de arquivo, estrutura detectada) */
    discoveries?: string[];
    /** Mutações aplicadas pelo ProactiveRecovery antes do resultado final */
    mutations?: ToolMutation[];
    /** Avaliação heurística do resultado */
    evaluation?: { confidence: number; reason?: string };
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
    cycleFocus?: string;               // foco do ciclo atual (estratégia do planner, ex: "converter via pandoc")
    isConstruction?: boolean;          // true se o objetivo é classificado como construção incremental
    roadmap?: string[];                // lista de marcos (milestones) do projeto
    currentMilestoneIndex?: number;    // índice do marco atualmente ativo
    allowRoadmapAdjustment?: boolean;  // true se o planner puder ajustar dinamicamente o roadmap em caso de blockers/dependências

    /** Checklist de critérios para validar conclusão do goal sem LLM. Gerado no plan inicial e preservado entre replans. */
    successCriteria: SuccessCriterion[];

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
    isConstruction?: boolean;
    /** true quando o objetivo foi explicitamente solicitado; false quando inferido dos dados sem pedido explícito */
    hasExplicitEvidence?: boolean;
}

// ── Avaliação de step (heurística + escalation) ───────────────────────────────

/**
 * Resultado da avaliação determinística de um step.
 * confidence < 0.6 dispara escalation para LLM (casos ambíguos).
 */
export interface StepEvaluation {
    success: boolean;
    /** 0.0 – 1.0 — determinado pela heurística; < 0.6 = ambíguo */
    confidence: number;
    reason?: string;
    /** Quando true, o caller deve chamar o LLM para desempate */
    shouldEscalateToLLM?: boolean;
}

// ── Contexto cognitivo persistente entre steps ────────────────────────────────

/**
 * Acumula descobertas entre steps de um mesmo goal.
 * Permite que cada AgentLoop comece com conhecimento do que já foi feito,
 * eliminando releituras redundantes e rediscoverys desnecessários.
 */
export interface StepCognitiveContext {
    /** Arquivos lidos por steps anteriores (caminho + hash opcional) */
    filesRead: Array<{ path: string; summary?: string }>;
    /** Arquivos criados ou modificados */
    filesModified: string[];
    /** Artefatos gerados (relatórios, imagens, documentos) com caminho no workspace */
    generatedArtifacts: string[];
    /** Descobertas relevantes (ex: "a pasta /workspace/src tem 3 arquivos .ts") */
    discoveries: string[];
    /** Estratégias que falharam — evita repetição */
    failedStrategies: string[];
    /** Outputs importantes dos steps anteriores (max 200 chars cada) */
    importantOutputs: string[];
    /** Comandos executados com sucesso */
    executedCommands: string[];
}

export function createEmptyStepCognitiveContext(): StepCognitiveContext {
    return {
        filesRead: [],
        filesModified: [],
        generatedArtifacts: [],
        discoveries: [],
        failedStrategies: [],
        importantOutputs: [],
        executedCommands: [],
    };
}

// ── Capabilities do ambiente ──────────────────────────────────────────────────

export interface EnvironmentCapabilities {
    tools: Record<string, boolean>;
    pythonPkgs: Record<string, boolean>;
    probeTimestamp: number;
    /** Bloco de texto pronto para injeção em prompts de planejamento. */
    summary: string;
}
