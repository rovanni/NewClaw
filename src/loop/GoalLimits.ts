/**
 * GoalLimits — Constantes de safety para o Goal-Centered Runtime.
 *
 * Todos os limites que controlam a autonomia do sistema. Centralizado aqui
 * para que ajustes de comportamento não exijam mudanças espalhadas.
 *
 * Princípio: autonomia limitada ao objetivo, nada mais.
 */

/** Minutos de uma variável de ambiente; valor ausente ou inválido = o padrão. */
function minutosDoAmbiente(nome: string, padrao: number): number {
    const v = Number(process.env[nome]);
    return Number.isFinite(v) && v > 0 ? v : padrao;
}

/**
 * ADR-024 etapa 6 (EXPERIMENTAL, desligado por padrão): com LIMITE_DO_OBJETIVO_COMO_AVISO=1, chegar ao limite do objetivo
 * não corta mais o trabalho — avisa o usuário e continua, até o LIMITE DURO (proteção configurável:
 * LIMITE_DURO_DO_OBJETIVO_MIN, padrão 3× o limite). O cancelamento continua pelo "Parar" e pelo /cancelar.
 */
export function limiteDoObjetivoComoAviso(): boolean { return process.env.LIMITE_DO_OBJETIVO_COMO_AVISO === '1'; }
export function limiteDuroDoObjetivoMs(): number {
    return minutosDoAmbiente('LIMITE_DURO_DO_OBJETIVO_MIN', 3 * GOAL_LIMITS.MAX_GOAL_TTL_MS / 60_000) * 60 * 1000;
}

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
    /**
     * Goal expira após este tempo sem conclusão. Padrão 30 min; configurável (LIMITE_DO_OBJETIVO_MIN) — ADR-024 etapa 6.
     * Lido a cada uso (o .env pode ser carregado depois deste módulo).
     */
    get MAX_GOAL_TTL_MS(): number { return minutosDoAmbiente('LIMITE_DO_OBJETIVO_MIN', 30) * 60 * 1000; },
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
