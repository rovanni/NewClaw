/**
 * CircuitBreaker — Protege contra cascading failures em providers
 *
 * States:
 *   CLOSED   → Normal operation. Failures increment counter.
 *   OPEN     → Provider considerado DOWN. Pula direto para fallback.
 *   HALF_OPEN → Testando recovery. Permite 1 request; se sucesso → CLOSED, se falha → OPEN.
 *
 * Uso:
 *   const cb = new CircuitBreaker('ollama', { threshold: 5, resetTimeoutMs: 60000 });
 *   if (cb.canExecute()) {
 *     try { result = await provider.call(); cb.recordSuccess(); }
 *     catch { cb.recordFailure(); }
 *   }
 */

import { createLogger } from '../shared/AppLogger';
import { eventBus, EventTypes } from './EventBus';

const log = createLogger('CircuitBreaker');

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerConfig {
    /** Provider name for logging */
    providerName: string;
    /** Number of failures before opening circuit (default: 5) */
    threshold?: number;
    /** Time in ms before attempting half-open (default: 60000 = 1 min) */
    resetTimeoutMs?: number;
    /** Time in ms for half-open test window (default: 30000 = 30s) */
    halfOpenWindowMs?: number;
}

export class CircuitBreaker {
    private state: CircuitState = 'closed';
    private failureCount: number = 0;
    private successCount: number = 0;
    private lastFailureTime: number = 0;
    private lastStateChangeTime: number = Date.now();
    private halfOpenAttempted: boolean = false;

    private readonly providerName: string;
    private readonly threshold: number;
    private readonly resetTimeoutMs: number;
    private readonly halfOpenWindowMs: number;

    // ── Metrics ──
    private totalExecutions: number = 0;
    private totalSuccesses: number = 0;
    private totalFailures: number = 0;
    private totalRejected: number = 0;

    constructor(config: CircuitBreakerConfig) {
        this.providerName = config.providerName;
        this.threshold = config.threshold ?? 5;
        this.resetTimeoutMs = config.resetTimeoutMs ?? 60_000;
        this.halfOpenWindowMs = config.halfOpenWindowMs ?? 30_000;
    }

    /**
     * Check if a request can be executed.
     * Returns false if circuit is OPEN (should skip to fallback).
     */
    canExecute(): boolean {
        this.totalExecutions++;

        if (this.state === 'closed') {
            return true;
        }

        if (this.state === 'open') {
            const elapsed = Date.now() - this.lastFailureTime;
            if (elapsed >= this.resetTimeoutMs) {
                // Transition to half-open
                this.transitionTo('half_open');
                this.halfOpenAttempted = false;
                return true; // Allow one test request
            }
            this.totalRejected++;
            log.warn(`[CIRCUIT-BREAKER] ${this.providerName}: REJECTED (open, ${elapsed}ms < ${this.resetTimeoutMs}ms)`);
            return false;
        }

        // half_open: allow only one test request
        if (this.state === 'half_open') {
            if (!this.halfOpenAttempted) {
                this.halfOpenAttempted = true;
                return true;
            }
            this.totalRejected++;
            log.warn(`[CIRCUIT-BREAKER] ${this.providerName}: REJECTED (half_open, already testing)`);
            return false;
        }

        return false;
    }

    /**
     * Record a successful execution.
     */
    recordSuccess(): void {
        this.totalSuccesses++;
        this.successCount++;

        if (this.state === 'half_open') {
            log.info(`[CIRCUIT-BREAKER] ${this.providerName}: half_open → closed (success confirmed)`);
            this.transitionTo('closed');
        }

        // In closed state, reset failure count on success
        if (this.state === 'closed') {
            this.failureCount = 0;
        }
    }

    /**
     * Record a failed execution.
     */
    recordFailure(error?: string): void {
        this.totalFailures++;
        this.failureCount++;
        this.lastFailureTime = Date.now();

        if (this.state === 'half_open') {
            log.warn(`[CIRCUIT-BREAKER] ${this.providerName}: half_open → open (test failed: ${error || 'unknown'})`);
            this.transitionTo('open');
            return;
        }

        if (this.state === 'closed' && this.failureCount >= this.threshold) {
            log.error(`[CIRCUIT-BREAKER] ${this.providerName}: closed → open (${this.failureCount} failures >= threshold ${this.threshold})`);
            this.transitionTo('open');
        }
    }

    /**
     * Get current circuit state.
     */
    getState(): CircuitState {
        // Auto-transition from open to half_open if enough time has passed
        if (this.state === 'open') {
            const elapsed = Date.now() - this.lastFailureTime;
            if (elapsed >= this.resetTimeoutMs) {
                this.transitionTo('half_open');
                this.halfOpenAttempted = false;
            }
        }
        return this.state;
    }

    /**
     * Get failure count in current closed state cycle.
     */
    getFailureCount(): number {
        return this.failureCount;
    }

    /**
     * Get comprehensive metrics snapshot.
     */
    getMetrics(): CircuitBreakerMetrics {
        return {
            providerName: this.providerName,
            state: this.getState(),
            failureCount: this.failureCount,
            successCount: this.successCount,
            totalExecutions: this.totalExecutions,
            totalSuccesses: this.totalSuccesses,
            totalFailures: this.totalFailures,
            totalRejected: this.totalRejected,
            lastFailureTime: this.lastFailureTime ? new Date(this.lastFailureTime).toISOString() : null,
            lastStateChangeTime: new Date(this.lastStateChangeTime).toISOString(),
            threshold: this.threshold,
            resetTimeoutMs: this.resetTimeoutMs,
            uptime: this.totalSuccesses > 0
                ? (this.totalSuccesses / this.totalExecutions * 100).toFixed(1) + '%'
                : '0%',
        };
    }

    /**
     * Force reset the circuit to closed state.
     */
    reset(): void {
        this.failureCount = 0;
        this.successCount = 0;
        this.halfOpenAttempted = false;
        this.transitionTo('closed');
        log.info(`[CIRCUIT-BREAKER] ${this.providerName}: MANUAL RESET → closed`);
    }

    // ── Private ───────────────────────────────────────────────────

    private transitionTo(newState: CircuitState): void {
        const oldState = this.state;
        this.state = newState;
        this.lastStateChangeTime = Date.now();

        if (oldState !== newState) {
            log.info(`[CIRCUIT-BREAKER] ${this.providerName}: ${oldState} → ${newState}`);
            eventBus.emit({
                type: EventTypes.CIRCUIT_STATE,
                payload: {
                    provider: this.providerName,
                    from: oldState,
                    to: newState,
                    failureCount: this.failureCount,
                    threshold: this.threshold,
                },
                source: 'CircuitBreaker',
                correlationId: `cb-${this.providerName}`,
            });
        }
    }
}

export interface CircuitBreakerMetrics {
    providerName: string;
    state: CircuitState;
    failureCount: number;
    successCount: number;
    totalExecutions: number;
    totalSuccesses: number;
    totalFailures: number;
    totalRejected: number;
    lastFailureTime: string | null;
    lastStateChangeTime: string;
    threshold: number;
    resetTimeoutMs: number;
    uptime: string;
}

// ── CircuitBreakerManager — Manages breakers per provider ────────────

export class CircuitBreakerManager {
    private breakers: Map<string, CircuitBreaker> = new Map();
    private defaultConfig: Omit<CircuitBreakerConfig, 'providerName'>;

    constructor(defaultConfig?: Omit<CircuitBreakerConfig, 'providerName'>) {
        this.defaultConfig = defaultConfig ?? { threshold: 5, resetTimeoutMs: 60_000 };
    }

    /**
     * Get or create a circuit breaker for a provider.
     */
    getBreaker(providerName: string): CircuitBreaker {
        if (!this.breakers.has(providerName)) {
            this.breakers.set(providerName, new CircuitBreaker({
                ...this.defaultConfig,
                providerName,
            }));
            log.info(`[CIRCUIT-BREAKER] Created breaker for '${providerName}' (threshold: ${this.defaultConfig.threshold}, reset: ${this.defaultConfig.resetTimeoutMs}ms)`);
        }
        return this.breakers.get(providerName)!;
    }

    /**
     * Get all breaker metrics.
     */
    getAllMetrics(): CircuitBreakerMetrics[] {
        return Array.from(this.breakers.values()).map(b => b.getMetrics());
    }

    /**
     * Reset all breakers.
     */
    resetAll(): void {
        for (const breaker of this.breakers.values()) {
            breaker.reset();
        }
    }

    /**
     * Get count of active breakers.
     */
    size(): number {
        return this.breakers.size;
    }
}