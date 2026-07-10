/**
 * computeDynamicTimeout — escala o timeout de uma chamada LLM pelo tamanho do prompt em vez
 * de usar um número fixo. Extraído de AgentLoop.callLLMWithFallback (fonte única) — GoalPlanner
 * usava valores fixos (90s pro plano inicial, 45s pro replan/roadmap) que não escalam com o
 * tamanho do contexto. Isso já tinha causado um bug documentado (comentário "S7" em
 * GoalPlanner.plan(): 45s abortava planos iniciais complexos, caindo num fallbackPlan
 * degradado) e se repetiu no replan — reproduzido ao vivo em 10/07: um replan com contexto de
 * ~73KB (SAFETY-GUARD context_growth ratio_limit=5.22) abortou aos exatos 45021ms, consumindo
 * replanBudget com "replan empty after parse" em vez de terminar a geração. Consolidando aqui
 * em vez de só aumentar os números fixos de novo — a mesma classe de bug reapareceria assim
 * que o contexto crescesse de novo.
 */
import { LLMMessage } from '../core/ProviderFactory';

const MIN_TIMEOUT = 45000;
const MAX_TIMEOUT = 420000;
const BASE_TIMEOUT = 180000;
const SCALE_PER_TOKEN = 60;
const MAX_SCALE = 240000;
const TOKEN_THRESHOLD = 1000;

export interface DynamicTimeoutResult {
    timeoutMs: number;
    approxTokens: number;
    totalChars: number;
    scaleMs: number;
}

export function computeDynamicTimeout(messages: LLMMessage[]): DynamicTimeoutResult {
    const totalChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
    const approxTokens = Math.ceil(totalChars / 4);
    const scaleMs = Math.min(Math.max(0, approxTokens - TOKEN_THRESHOLD) * SCALE_PER_TOKEN, MAX_SCALE);
    const timeoutMs = Math.max(MIN_TIMEOUT, Math.min(BASE_TIMEOUT + scaleMs, MAX_TIMEOUT));
    return { timeoutMs, approxTokens, totalChars, scaleMs };
}
