/**
 * GoalLimits — Constantes de safety para o Goal-Centered Runtime.
 *
 * Todos os limites que controlam a autonomia do sistema. Centralizado aqui
 * para que ajustes de comportamento não exijam mudanças espalhadas.
 *
 * Princípio: autonomia limitada ao objetivo, nada mais.
 */

export const GOAL_LIMITS = {
    // ── Orçamentos por goal ──────────────────────────────────────────────────
    /** Tentativas por step antes de considerar bloqueado */
    MAX_RETRY_BUDGET: 5,
    /** Replans totais por goal antes de declarar falha */
    MAX_REPLAN_BUDGET: 5,
    /** Ciclos totais (plan+execute+evaluate) antes de encerrar */
    MAX_CYCLES: 12,
    /** Tools únicas diferentes que podem ser tentadas */
    MAX_TOOLS_PER_GOAL: 10,

    // ── TTL ──────────────────────────────────────────────────────────────────
    /** Goal expira após 30 minutos sem conclusão */
    MAX_GOAL_TTL_MS: 30 * 60 * 1000,
    /** Auth pendente expira em 5 minutos (alinhado com WorkflowEngine) */
    MAX_GOAL_AUTH_TTL_MS: 5 * 60 * 1000,

    // ── Token budget por ciclo ───────────────────────────────────────────────
    MAX_TOKENS_PER_PLAN: 2000,
    MAX_TOKENS_PER_REPLAN: 1500,
    MAX_TOKENS_PER_CYCLE: 4000,

    // ── Thresholds de confiança ───────────────────────────────────────────────
    /** Abaixo disso → falha automática */
    MIN_CONFIDENCE_TO_CONTINUE: 0.25,
    /** Abaixo disso → tenta replan antes de retry */
    MIN_CONFIDENCE_TO_REPLAN: 0.5,
    /** Confiança inicial de um goal novo */
    INITIAL_CONFIDENCE: 0.85,

    // ── Heurística de classificação de goal ──────────────────────────────────
    /** Tamanho mínimo de mensagem para considerar goal (< isso = conversa) */
    MIN_GOAL_MESSAGE_LENGTH: 15,
    /** Confiança mínima para criar goal sem consultar LLM */
    QUICK_CLASSIFY_THRESHOLD: 0.9,

    // ── Proteções de ambiente ────────────────────────────────────────────────
    /**
     * Padrões de install perigosos — qualquer comando que os contenha
     * exige autorização explícita antes de ser incluído em um plan.
     */
    DANGEROUS_INSTALL_PATTERNS: [
        /curl[^|]*\|\s*bash/i,
        /wget[^|]*\|\s*bash/i,
        /npm\s+install\s+-g/i,
        /pip\s+install\s+--system/i,
        /apt(-get)?\s+install/i,
        /brew\s+install/i,
        /yum\s+install/i,
        /pacman\s+-S/i,
    ] as RegExp[],

    /** Paths autorizados para operações de arquivo sem auth adicional */
    SAFE_FILE_PATH_PREFIXES: [
        process.cwd(),
        '/tmp',
        process.env['TMPDIR'] || '/tmp',
    ] as string[],

    // ── Stall detection ──────────────────────────────────────────────────────
    /** Ciclos consecutivos sem progresso antes de declarar stall */
    STALL_DETECTION_WINDOW: 2,
    /** Queda de confiança por ciclo considerada "regressão" */
    REGRESSION_CONFIDENCE_DELTA: -0.15,
} as const;
