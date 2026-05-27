/**
 * ContextPlanner — Shim de compatibilidade.
 * Conteúdo movido para ContextBuilder.ts (Fase 2.1).
 * @deprecated Importe diretamente de './ContextBuilder'
 */
export type { TierBudgets, PlannerMetrics, PlannerResult } from './ContextBuilder';
export { DEFAULT_TIER_BUDGETS, extractEntities, isPersonalMemoryQuery, ContextPlanner } from './ContextBuilder';
