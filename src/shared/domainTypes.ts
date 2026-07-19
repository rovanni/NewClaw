/**
 * domainTypes — Modelo de domínio do Goal-Centered Cognitive Runtime, compartilhado
 * entre `loop/` (orquestração) e `memory/` (aprendizado). Nenhuma das duas camadas
 * "possui" este modelo sozinha — ambas o consomem, então ele mora em um local neutro
 * (ARCH-004 do backlog arquitetural).
 *
 * `loop/GoalTypes.ts` re-exporta tudo daqui para não quebrar os consumidores
 * existentes dentro de `loop/`; os tipos de execução específicos de `loop/`
 * (CycleResult, GoalResult, StepEvaluation, GoalProgressModel etc.) continuam
 * definidos lá, pois não são consumidos por `memory/`.
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
    | 'required_artifact_missing'  // artefato obrigatório existe mas está vazio — goal de modificação não pode prosseguir
    | 'semantic_mismatch'          // tool retornou sucesso mas output não é relevante para a intenção do step
    | 'content_stub';              // step write gravou placeholder em vez de conteúdo real — usar AgentLoop para síntese

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
 * - tool_succeeded            → algum attempt com toolName teve result='success'
 * - output_not_contains       → o output de um attempt bem-sucedido NÃO contém `value`
 * - output_contains           → o output de um attempt bem-sucedido contém `value`
 * - file_exists               → exec_command retornou output não-vazio (arquivo encontrado)
 * - pending_send_verified_on_disk → ARCH-018: todo step `send_document` ainda pendente do plano
 *   atual aponta para um arquivo que já existe no disco, com tamanho e tipo esperados — checagem
 *   DIRETA de disco (`fs.statSync`), sem depender de nenhum `GoalAttempt` como evidência
 *   indireta (diferente de `file_exists`, que checa attempt — não intercambiáveis, ver
 *   `docs/issues/010-arch018-file-exists-checks-attempts-not-disk.md`). Alvo dinâmico por
 *   design (reavalia `goal.currentPlan` a cada chamada, mesmo padrão já usado por
 *   `tool_succeeded` contra `goal.attempts`, que também cresce entre avaliações).
 */
export type CriterionCheck =
    | 'tool_succeeded'
    | 'output_not_contains'
    | 'output_contains'
    | 'file_exists'
    | 'pending_send_verified_on_disk';

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
    /**
     * Resultado real do `GoalAttempt` mais recente associado a este step (ARCH-007).
     * `status: 'completed'` só significa "execução terminou, não está mais pendente de
     * dispatch" — é o eixo de PROGRESSÃO do plano, não de confiança no resultado. Um step
     * pode ficar `completed` (não será redespachado) mesmo quando o attempt real foi
     * `'partial'` (ex: heurística de sucesso de baixa confiança, Sprint 0.8) — isso é
     * intencional (retry automático nesse caminho não é o design), mas antes ficava
     * invisível fora de `goal.attempts`. Este campo torna essa divergência explícita e
     * consultável em vez de acidental — consumidores que precisam da confiança real do
     * resultado (não só "terminou de rodar") devem ler este campo, não `status`.
     */
    lastAttemptOutcome?: AttemptOutcome;
    /**
     * id do `PlanStep` que gerou este step (usado hoje só por sends diferidos do AgentLoop,
     * injetados em GoalExecutionLoop.ts). Permite reconciliar retries: uma nova tentativa do
     * MESMO step de origem supera um send_document ainda pendente de uma tentativa anterior
     * do mesmo step, em vez de acumular os dois (achado real: goal_1784200808912_vw8fu,
     * 16/07/2026 — 3 arquivos .pptx enviados pra 1 pedido de "mudar as cores", um por retry).
     */
    originStepId?: string;
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

/**
 * Resultado de 3 vias de uma tentativa — sucesso, falha, ou parcial (a ferramenta
 * rodou mas não satisfez completamente a intenção). Extraído como tipo nomeado
 * (S1 do roadmap de aprendizado) para que outros consumidores de "o que aconteceu"
 * — a começar pela ReflectionMemory em S2 — reusem o mesmo vocabulário em vez de
 * reinventar um enum paralelo. Nenhuma mudança de valor: os 3 literais já existiam
 * aqui, só ganharam nome.
 */
export type AttemptOutcome = 'success' | 'failure' | 'partial';

export interface GoalAttempt {
    id: string;
    planStepId: string;
    toolName: string;
    args: Record<string, unknown>;
    result: AttemptOutcome;
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
    /**
     * Sprint 0.10 (achado L22): id do `ExecutionTrace` do sub-turno `agentloop` que produziu
     * este attempt (quando `toolName==='agentloop'`) — correlação com `agent_traces`
     * (persistido por `AgentLoop.persistTrace`/`memory.saveTrace`), sem duplicar o conteúdo do
     * trace aqui. Ausente em attempts de tool direta (não passam por `AgentLoop`).
     */
    traceId?: string;
    /**
     * Sprint 0.10 (achado L22): nomes das tools chamadas dentro do sub-turno `agentloop`
     * (ordem de execução, só nomes — sem args/output, para não duplicar dado já coberto pelo
     * trace referenciado em `traceId`). Decompõe minimamente a "caixa-preta" do sub-turno
     * diretamente no histórico do goal, sem custo de armazenamento relevante.
     */
    subToolCalls?: string[];
    /**
     * Sprint R1-R7 (docs/REVISAO_ARQUITETURAL_SPRINT_R7_2026-07-13.md): artefatos que este
     * attempt declarou ter produzido — populado por `write` (o próprio `file_path`) e por
     * `exec_command` (linhas `ARTIFACT: <path>` no stdout, verificadas contra o disco antes
     * de entrar aqui). Fonte de evidência real para `RiskAnalyzer` resolver `file_path` de
     * `send_document` no replan, em vez de inferir por proximidade sintática no JSON do plano.
     */
    producedArtifactPaths?: string[];
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
    sentArtifacts?: string[];         // paths de artefatos já entregues — persiste entre restarts

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

// ── Intent (UnifiedIntentRouter) ────────────────────────────────────────────────

export type IntentCategory = 'greeting' | 'conversation' | 'information' | 'creation' | 'system_operation' | 'data_analysis' | 'memory_operation' | 'audio' | 'vision' | 'destructive' | 'confirmation' | 'rejection';
