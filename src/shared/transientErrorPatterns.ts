/**
 * transientErrorPatterns — Padrões de erro transitório (conectividade, timeout,
 * rate-limit) duplicados de forma independente em dois módulos antes deste card:
 *
 *   - `GoalEvaluator.ERROR_PATTERNS` (retry a nível de goal — consome `goal.retryBudget`)
 *   - `ProactiveRecovery.RECOVERY[tool].retryablePatterns` (retry imediato a nível de
 *     tool, com backoff, antes mesmo do erro chegar ao GoalEvaluator)
 *
 * ARCH-014 (docs/ARCHITECTURAL_BACKLOG.md). Cada padrão realmente compartilhado (mesmo
 * texto de regex usado em 2+ lugares) tem uma única definição aqui, referenciada por
 * identidade nos dois módulos. Padrões usados em um único lugar continuam definidos
 * localmente — não pertencem a este núcleo compartilhado, e forçá-los para cá mudaria
 * o comportamento de retry de tools que não os tinham antes (ex.: `memory_recall`/`edit`
 * não retriam em NADA, de propósito — "quota exceeded" ou "ECONNREFUSED" não fariam
 * sentido para esses dois, e não devem ser adicionados via uma lista universal).
 */

export const ECONNRESET_PATTERN = /ECONNRESET/i;
export const ETIMEDOUT_PATTERN = /ETIMEDOUT/i;
export const TIMEOUT_PATTERN = /timeout/i;
export const NETWORK_PATTERN = /network/i;
export const RATE_LIMIT_PATTERN = /rate.?limit/i;
export const HTTP_429_PATTERN = /429/;

/**
 * Núcleo de conectividade/timeout — os 3 padrões literalmente repetidos nos 3 tools de
 * `ProactiveRecovery` que retriam em erro de rede (`weather`, `web_search`, `web_navigate`)
 * e também presentes em `GoalEvaluator` (nas entradas "Sem conexão/rede" e "Timeout").
 */
export const CORE_TRANSIENT_PATTERNS: readonly RegExp[] = [ECONNRESET_PATTERN, ETIMEDOUT_PATTERN, TIMEOUT_PATTERN];

/**
 * Combina uma lista de regexes em uma única regex (OR de todas as fontes, flag 'i') —
 * usado por `GoalEvaluator`, cujo `ErrorPattern.pattern` é uma regex única por entrada,
 * não um array testado com `.some()` como em `ProactiveRecovery`.
 */
export function combineRegExp(patterns: readonly RegExp[]): RegExp {
    return new RegExp(patterns.map(p => p.source).join('|'), 'i');
}
