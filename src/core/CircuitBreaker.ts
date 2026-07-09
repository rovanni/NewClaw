/**
 * CircuitBreaker — Proteção contra cascata de falhas
 * 
 * Duas APIs complementares:
 * 1. Execute API: cb.execute(fn) — wrapper com try/catch automático
 * 2. Manual API: cb.canExecute() / cb.recordSuccess() / cb.recordFailure()
 * 
 * Estados: CLOSED (normal) → OPEN (bloqueado) → HALF_OPEN (teste)
 * 
 * Integração: ToolExecutor, ProviderFactory, chamadas externas
 * Eventos: circuit:open, circuit:half-open, circuit:closed via EventBus
 */

import { eventBus, EventTypes } from './EventBus';
import { createLogger } from '../shared/AppLogger';
import { errorMessage } from '../shared/errors';

const log = createLogger('CircuitBreaker');

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
// Lowercase variant for compatibility
export type CircuitStateLower = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerConfig {
    /** Número de falhas consecutivas para abrir o circuito (default: 5) */
    failureThreshold: number;
    /** Tempo em ms para tentar half-open (default: 30000 = 30s) */
    resetTimeoutMs: number;
    /** Número de sucessos consecutivos em half-open para fechar (default: 3) */
    successThreshold: number;
    /** Nome identificador do circuito */
    name: string;
}

export interface CircuitBreakerMetrics {
    providerName: string;
    state: CircuitStateLower;
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

const DEFAULT_CONFIG: Omit<CircuitBreakerConfig, 'name'> = {
    failureThreshold: 5,
    resetTimeoutMs: 30_000,
    successThreshold: 3,
};

export class CircuitBreaker {
    private state: CircuitState = 'CLOSED';
    private config: CircuitBreakerConfig;
    private failureCount: number = 0;
    private consecutiveFailures: number = 0;
    private consecutiveSuccesses: number = 0;
    private lastFailureTime: number = 0;
    private lastStateChangeTime: number = Date.now();
    /**
     * Contador de tentativas de teste permitidas no estado HALF_OPEN — precisa ir até
     * successThreshold, NÃO parar em 1. onSuccess() só transiciona HALF_OPEN → CLOSED
     * quando consecutiveSuccesses >= successThreshold (default 3); se este contador
     * permitisse só 1 tentativa (era um boolean antes), o circuito nunca conseguia
     * acumular sucessos suficientes pra fechar de novo — ficava preso em HALF_OPEN
     * para sempre depois do 1º teste bem-sucedido, rejeitando toda chamada futura
     * mesmo com o provider 100% saudável (visto em produção: 'ollama' preso em
     * HALF_OPEN por >2min straight, todo request rejeitado com "failures: 0" porque
     * onSuccess() já tinha zerado consecutiveFailures no único teste permitido).
     * Qualquer falha durante HALF_OPEN ainda transiciona de volta pra OPEN
     * imediatamente (onFailure), então isso não permite avalanche de tentativas
     * num provider realmente quebrado — só dá chances suficientes pra um provider
     * saudável realmente fechar o circuito de novo.
     */
    private halfOpenAttempts: number = 0;
    private nextAttemptAt: number = 0;
    private avgDurationMs: number = 0;

    // Metrics
    private totalExecutions: number = 0;
    private totalSuccesses: number = 0;
    private totalFailures: number = 0;
    private totalTimeouts: number = 0;
    private totalRejected: number = 0;

    constructor(config: Partial<CircuitBreakerConfig> & { name?: string; providerName?: string }) {
        const name = config.name || config.providerName || 'unknown';
        this.config = { ...DEFAULT_CONFIG, ...config, name };
    }

    // ── Execute API (wrapper automático) ───────────────────────────

    /**
     * Execute uma função com proteção do circuit breaker.
     * Se OPEN, rejeita imediatamente. Se HALF_OPEN, permite 1 tentativa.
     */
    async execute<T>(fn: () => Promise<T>): Promise<T> {
        this.totalExecutions++;

        if (this.state === 'OPEN') {
            if (Date.now() < this.nextAttemptAt) {
                this.totalRejected++;
                log.warn(`[${this.config.name}] Circuit OPEN — rejecting call`);
                throw new CircuitBreakerOpenError(
                    this.config.name,
                    this.consecutiveFailures,
                    this.config.failureThreshold,
                    this.nextAttemptAt
                );
            }
            this.transitionTo('HALF_OPEN');
        }

        const startTime = Date.now();
        try {
            const result = await fn();
            const duration = Date.now() - startTime;
            this.onSuccess(duration);
            return result;
        } catch (error) {
            const duration = Date.now() - startTime;
            this.onFailure(error, duration);
            throw error;
        }
    }

    // ── Manual API (canExecute / recordSuccess / recordFailure) ──

    /**
     * Check if a request can be executed.
     * Returns false if circuit is OPEN (should skip to fallback).
     */
    canExecute(): boolean {
        this.totalExecutions++;

        if (this.state === 'CLOSED') {
            return true;
        }

        if (this.state === 'OPEN') {
            const elapsed = Date.now() - this.lastFailureTime;
            if (elapsed >= this.config.resetTimeoutMs) {
                this.transitionTo('HALF_OPEN');
                return true;
            }
            this.totalRejected++;
            log.warn(`[CIRCUIT-BREAKER] ${this.config.name}: REJECTED (open)`);
            return false;
        }

        // HALF_OPEN: allow up to successThreshold test requests (not just one — see
        // halfOpenAttempts doc comment above for why one is not enough to ever close again).
        if (this.state === 'HALF_OPEN') {
            if (this.halfOpenAttempts < this.config.successThreshold) {
                this.halfOpenAttempts++;
                return true;
            }
            this.totalRejected++;
            return false;
        }

        return false;
    }

    /**
     * Record a successful execution (manual API).
     */
    recordSuccess(): void {
        this.onSuccess(0);
    }

    /**
     * Record a failed execution (manual API).
     */
    recordFailure(error?: string): void {
        this.onFailure(new Error(error || 'unknown'), 0);
    }

    /**
     * Get current circuit state.
     */
    getState(): CircuitState {
        // Auto-transition from open to half_open if enough time has passed
        if (this.state === 'OPEN') {
            const elapsed = Date.now() - this.lastFailureTime;
            if (elapsed >= this.config.resetTimeoutMs) {
                this.transitionTo('HALF_OPEN');
            }
        }
        return this.state;
    }

    /**
     * Get failure count in current closed state cycle.
     */
    getFailureCount(): number {
        return this.consecutiveFailures;
    }

    /**
     * Get comprehensive metrics snapshot (compatible with both APIs).
     */
    getMetrics(): CircuitBreakerMetrics {
        const state = this.getState().toLowerCase() as CircuitStateLower;
        return {
            providerName: this.config.name,
            state,
            failureCount: this.consecutiveFailures,
            successCount: this.consecutiveSuccesses,
            totalExecutions: this.totalExecutions,
            totalSuccesses: this.totalSuccesses,
            totalFailures: this.totalFailures,
            totalRejected: this.totalRejected,
            lastFailureTime: this.lastFailureTime ? new Date(this.lastFailureTime).toISOString() : null,
            lastStateChangeTime: new Date(this.lastStateChangeTime).toISOString(),
            threshold: this.config.failureThreshold,
            resetTimeoutMs: this.config.resetTimeoutMs,
            uptime: this.totalSuccesses > 0 && this.totalExecutions > 0
                ? (this.totalSuccesses / this.totalExecutions * 100).toFixed(1) + '%'
                : '0%',
        };
    }

    /**
     * Force reset the circuit to closed state.
     */
    reset(): void {
        this.consecutiveFailures = 0;
        this.consecutiveSuccesses = 0;
        this.halfOpenAttempted = false;
        this.transitionTo('CLOSED');
        log.info(`[CIRCUIT-BREAKER] ${this.config.name}: MANUAL RESET → CLOSED`);
    }

    /**
     * Force open (for admin commands or manual circuit break).
     */
    forceOpen(): void {
        this.transitionTo('OPEN');
        this.nextAttemptAt = Date.now() + this.config.resetTimeoutMs;
    }

    // ── Internal ────────────────────────────────────────────────────

    private onSuccess(durationMs: number): void {
        this.totalSuccesses++;
        this.consecutiveSuccesses++;
        this.consecutiveFailures = 0;
        this.updateAvgDuration(durationMs);

        if (this.state === 'HALF_OPEN') {
            if (this.consecutiveSuccesses >= this.config.successThreshold) {
                this.transitionTo('CLOSED');
            }
        }

        // In closed state, reset failure count on success
        if (this.state === 'CLOSED') {
            this.failureCount = 0;
        }
    }

    private onFailure(error: unknown, durationMs: number): void {
        this.totalFailures++;
        this.consecutiveFailures++;
        this.consecutiveSuccesses = 0;
        this.failureCount++;
        this.lastFailureTime = Date.now();
        this.updateAvgDuration(durationMs);

        if (errorMessage(error)?.includes('timeout') || errorMessage(error)?.includes('abort')) {
            this.totalTimeouts++;
        }

        if (this.state === 'HALF_OPEN') {
            this.transitionTo('OPEN');
            this.nextAttemptAt = Date.now() + this.config.resetTimeoutMs;
        } else if (this.state === 'CLOSED') {
            if (this.consecutiveFailures >= this.config.failureThreshold) {
                this.transitionTo('OPEN');
                this.nextAttemptAt = Date.now() + this.config.resetTimeoutMs;
            }
        }
    }

    private transitionTo(newState: CircuitState): void {
        const oldState = this.state;
        this.state = newState;
        this.lastStateChangeTime = Date.now();

        if (newState === 'HALF_OPEN') {
            this.halfOpenAttempted = false;
        }

        if (oldState !== newState) {
            log.info(`[${this.config.name}] Circuit ${oldState} → ${newState}`);

            // Emit typed event
            switch (newState) {
                case 'OPEN':
                    eventBus.emit('circuit:open', {
                        name: this.config.name,
                        failures: this.consecutiveFailures,
                        threshold: this.config.failureThreshold,
                    });
                    break;
                case 'HALF_OPEN':
                    eventBus.emit('circuit:half-open', { name: this.config.name });
                    break;
                case 'CLOSED':
                    eventBus.emit('circuit:closed', {
                        name: this.config.name,
                        successes: this.consecutiveSuccesses,
                    });
                    break;
            }

            // Also emit generic AppEvent for compatibility
            eventBus.emitAppEvent({
                type: EventTypes.CIRCUIT_STATE,
                payload: {
                    provider: this.config.name,
                    from: oldState.toLowerCase(),
                    to: newState.toLowerCase(),
                    failureCount: this.consecutiveFailures,
                    threshold: this.config.failureThreshold,
                },
                source: 'CircuitBreaker',
                correlationId: `cb-${this.config.name}`,
            }).catch(err => log.warn(`[${this.config.name}] emitAppEvent failed (non-fatal): ${err}`));
        }
    }

    private updateAvgDuration(durationMs: number): void {
        if (this.avgDurationMs === 0) {
            this.avgDurationMs = durationMs;
        } else {
            this.avgDurationMs = Math.round(this.avgDurationMs * 0.8 + durationMs * 0.2);
        }
    }
}

// ── Custom Error ─────────────────────────────────────────────────────

export class CircuitBreakerOpenError extends Error {
    public readonly circuitName: string;
    public readonly failures: number;
    public readonly threshold: number;
    public readonly retryAt: number;

    constructor(name: string, failures: number, threshold: number, retryAt: number) {
        super(`Circuit "${name}" is OPEN — ${failures}/${threshold} failures. Retry after ${new Date(retryAt).toISOString()}`);
        this.name = 'CircuitBreakerOpenError';
        this.circuitName = name;
        this.failures = failures;
        this.threshold = threshold;
        this.retryAt = retryAt;
    }
}

// ── Circuit Breaker Registry ─────────────────────────────────────────

export class CircuitBreakerRegistry {
    private breakers: Map<string, CircuitBreaker> = new Map();
    private defaultConfig: Omit<CircuitBreakerConfig, 'name'>;

    constructor(defaultConfig?: Omit<CircuitBreakerConfig, 'name'>) {
        this.defaultConfig = defaultConfig || DEFAULT_CONFIG;
    }

    /** Get or create a circuit breaker by name */
    getOrCreate(config: Partial<CircuitBreakerConfig> & { name: string }): CircuitBreaker {
        const existing = this.breakers.get(config.name);
        if (existing) return existing;

        const breaker = new CircuitBreaker({ ...this.defaultConfig, ...config });
        this.breakers.set(config.name, breaker);
        return breaker;
    }

    /** Get all circuit breakers */
    getAll(): CircuitBreaker[] {
        return Array.from(this.breakers.values());
    }

    /** Get metrics for all circuit breakers */
    getAllMetrics(): CircuitBreakerMetrics[] {
        return Array.from(this.breakers.values()).map(b => b.getMetrics());
    }

    /** Reset all circuit breakers */
    resetAll(): void {
        for (const breaker of this.breakers.values()) {
            breaker.reset();
        }
    }

    /** Get count of active breakers */
    size(): number {
        return this.breakers.size;
    }
}

export const circuitRegistry = new CircuitBreakerRegistry();

// ── Backward compatibility aliases ──────────────────────────────────

export { circuitRegistry as CircuitBreakerManager };
export { CircuitBreakerConfig as CircuitBreakerManagerConfig };
export default circuitRegistry;