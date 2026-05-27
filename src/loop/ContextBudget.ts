/**
 * ContextBudget — Shim de compatibilidade.
 * Conteúdo movido para ContextBuilder.ts (Fase 2.1).
 * @deprecated Importe diretamente de './ContextBuilder'
 */
export type { ContextBlock, ContextBudgetConfig } from './ContextBuilder';
export { DEFAULT_BUDGET, estimateTokens, truncateToTokens, truncateToChars, ContextBudget } from './ContextBuilder';
