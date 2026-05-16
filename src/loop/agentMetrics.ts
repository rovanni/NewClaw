import type { LLMResult, MetricsSummary } from '../core/ProviderFactory';
import type { LoopMetrics } from './agentLoopTypes';

export function buildLoopMetric(
    result: LLMResult,
    timeoutMs: number,
    promptCharCount: number,
    estimatedTokens: number,
    model: string
): LoopMetrics {
    const lastAttempt = result.attempts[result.attempts.length - 1];
    return {
        timestamp: Date.now(),
        responseTimeMs: result.attempts.reduce((sum, a) => sum + a.duration, 0),
        status: result.status,
        provider: lastAttempt?.provider || 'unknown',
        model: model || lastAttempt?.model || 'unknown',
        promptTokens: result.usage?.prompt_tokens || 0,
        completionTokens: result.usage?.completion_tokens || 0,
        promptCharCount,
        estimatedTokens,
        timeoutUsedMs: timeoutMs,
        didTimeout: result.status === 'timeout'
    };
}

export function summarizeMetrics(metrics: LoopMetrics[]): { recent: LoopMetrics[]; summary: MetricsSummary } {
    const timeouts = metrics.filter(m => m.status === 'timeout').length;
    const errors = metrics.filter(m => m.status === 'error').length;
    const avgResponseTime = metrics.length > 0
        ? Math.round(metrics.reduce((s, m) => s + m.responseTimeMs, 0) / metrics.length)
        : 0;

    return {
        recent: metrics.slice(-20),
        summary: {
            total: metrics.length,
            successes: metrics.length - timeouts - errors,
            timeouts,
            errors,
            avgResponseTimeMs: avgResponseTime,
            p95ResponseTimeMs: percentile(metrics, 95)
        }
    };
}

function percentile(metrics: LoopMetrics[], p: number): number {
    if (metrics.length === 0) return 0;
    const sorted = metrics.map(m => m.responseTimeMs).sort((a, b) => a - b);
    const idx = Math.ceil(sorted.length * p / 100) - 1;
    return sorted[Math.max(0, idx)];
}
