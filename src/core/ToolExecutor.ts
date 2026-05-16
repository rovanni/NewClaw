/**
 * ToolExecutor — Execução segura de ferramentas com timeout, retry e cancelamento
 * 
 * Substitui chamadas diretas tool.execute() no AgentLoop por:
 * - Timeout configurável por ferramenta
 * - Retry automático com backoff exponencial
 * - Cancelamento via AbortSignal
 * - Integração com CircuitBreaker
 * - Métricas de execução
 * - Eventos via EventBus
 */

import { CircuitBreaker, circuitRegistry, CircuitBreakerOpenError, type CircuitBreakerMetrics } from './CircuitBreaker';
import { eventBus } from './EventBus';
import { createLogger } from '../shared/AppLogger';
import { errorMessage } from '../shared/errors';

const log = createLogger('ToolExecutor');

export interface ToolExecutionOptions {
    /** Timeout em ms (default: 30000) */
    timeout?: number;
    /** Número de retentativas (default: 1) */
    retry?: number;
    /** Delay base para backoff exponencial em ms (default: 1000) */
    retryDelayMs?: number;
    /** Signal para cancelamento */
    cancelToken?: AbortSignal;
    /** Se true, não emite eventos (para chamadas internas) */
    silent?: boolean;
}

export interface ToolExecutionResult {
    success: boolean;
    output: string;
    error?: string;
    durationMs: number;
    attempts: number;
    timedOut: boolean;
    cancelled: boolean;
    fromCircuitBreaker: boolean;
}

export interface ToolExecutorLike {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute(args: Record<string, unknown>): Promise<{ success: boolean; output: string; error?: string }>;
}

// ── Default timeouts por categoria de tool ───────────────────────

const TOOL_TIMEOUTS: Record<string, number> = {
    // Ferramentas rápidas (leitura, memória)
    read: 10_000,
    memory_search: 10_000,
    memory_write: 10_000,
    memory_admin: 10_000,
    manage_memory: 10_000,
    schedule: 10_000,

    // Ferramentas médias (escrita, edição)
    write: 20_000,
    edit: 20_000,

    // Ferramentas lentas (rede, execução)
    web_search: 45_000,
    web_navigate: 60_000,
    exec_command: 60_000,
    ssh_exec: 60_000,
    crypto_analysis: 45_000,
    weather: 30_000,
    send_audio: 60_000,
    send_document: 30_000,
    api_request: 30_000,

    // Ferramentas de IA (LLM-dependent)
    server_config: 10_000,
};

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_RETRY = 1;
const DEFAULT_RETRY_DELAY = 1_000;
const MAX_BACKOFF = 15_000;

export class ToolExecutorService {
    private circuitBreakers: Map<string, CircuitBreaker> = new Map();

    /**
     * Execute a tool with timeout, retry and circuit breaker.
     */
    async execute(
        tool: ToolExecutorLike,
        args: Record<string, any>,
        options: ToolExecutionOptions = {}
    ): Promise<ToolExecutionResult> {
        const {
            timeout = TOOL_TIMEOUTS[tool.name] || DEFAULT_TIMEOUT,
            retry = DEFAULT_RETRY,
            retryDelayMs = DEFAULT_RETRY_DELAY,
            cancelToken,
            silent = false,
        } = options;

        const circuitBreaker = this.getCircuitBreaker(tool.name);
        let lastError: string | undefined;
        let attempts = 0;
        const startTime = Date.now();

        // Check cancellation before starting
        if (cancelToken?.aborted) {
            return {
                success: false,
                output: 'Operação cancelada antes de iniciar.',
                durationMs: 0,
                attempts: 0,
                timedOut: false,
                cancelled: true,
                fromCircuitBreaker: false,
            };
        }

        for (let attempt = 0; attempt <= retry; attempt++) {
            attempts++;

            // Check cancellation
            if (cancelToken?.aborted) {
                return {
                    success: false,
                    output: 'Operação cancelada pelo usuário.',
                    durationMs: Date.now() - startTime,
                    attempts,
                    timedOut: false,
                    cancelled: true,
                    fromCircuitBreaker: false,
                };
            }

            try {
                const result = await circuitBreaker.execute(async () => {
                    // Create abort controller for timeout
                    const abortController = new AbortController();
                    let timeoutId: NodeJS.Timeout | undefined;

                    // Set up timeout
                    const timeoutPromise = new Promise<never>((_, reject) => {
                        timeoutId = setTimeout(() => {
                            abortController.abort();
                            reject(new Error(`Tool "${tool.name}" timed out after ${timeout}ms`));
                        }, timeout);
                    });

                    // Set up cancellation
                    if (cancelToken) {
                        cancelToken.addEventListener('abort', () => {
                            abortController.abort();
                        }, { once: true });
                    }

                    try {
                        const executePromise = tool.execute(args);
                        const raceResult = await Promise.race([executePromise, timeoutPromise]);
                        return raceResult;
                    } finally {
                        if (timeoutId) clearTimeout(timeoutId);
                    }
                });

                const durationMs = Date.now() - startTime;

                // Emit success event
                if (!silent) {
                    eventBus.emit('tool:executed', {
                        tool: tool.name,
                        input: args,
                        success: result.success,
                        durationMs,
                    });
                }

                return {
                    success: result.success,
                    output: result.output,
                    error: result.error,
                    durationMs,
                    attempts,
                    timedOut: false,
                    cancelled: false,
                    fromCircuitBreaker: false,
                };

            } catch (error) {
                const durationMs = Date.now() - startTime;
                lastError = errorMessage(error);

                // CircuitBreaker open — don't retry
                if (error instanceof CircuitBreakerOpenError) {
                    log.warn(`[${tool.name}] Circuit breaker OPEN — skipping execution`);

                    if (!silent) {
                        eventBus.emit('tool:timeout', {
                            tool: tool.name,
                            input: args,
                            timeoutMs: timeout,
                        });
                    }

                    return {
                        success: false,
                        output: `Circuito aberto para "${tool.name}". ${errorMessage(error)}`,
                        error: errorMessage(error),
                        durationMs,
                        attempts,
                        timedOut: false,
                        cancelled: false,
                        fromCircuitBreaker: true,
                    };
                }

                // Timeout — emit event
                if (errorMessage(error)?.includes('timed out')) {
                    if (!silent) {
                        eventBus.emit('tool:timeout', {
                            tool: tool.name,
                            input: args,
                            timeoutMs: timeout,
                        });
                    }

                    // Don't retry timeouts by default
                    return {
                        success: false,
                        output: `Ferramenta "${tool.name}" excedeu o tempo limite de ${Math.round(timeout / 1000)}s.`,
                        error: errorMessage(error),
                        durationMs,
                        attempts,
                        timedOut: true,
                        cancelled: false,
                        fromCircuitBreaker: false,
                    };
                }

                // Retry with exponential backoff (only if attempts remaining)
                if (attempt < retry) {
                    const delay = Math.min(retryDelayMs * Math.pow(2, attempt), MAX_BACKOFF);
                    log.info(`[${tool.name}] Attempt ${attempt + 1} failed, retrying in ${delay}ms...`);

                    // Wait for backoff, but check cancellation
                    await new Promise<void>((resolve) => {
                        const timeout = setTimeout(resolve, delay);
                        cancelToken?.addEventListener('abort', () => {
                            clearTimeout(timeout);
                            resolve();
                        }, { once: true });
                    });

                    if (cancelToken?.aborted) {
                        return {
                            success: false,
                            output: 'Operação cancelada durante retry.',
                            durationMs: Date.now() - startTime,
                            attempts,
                            timedOut: false,
                            cancelled: true,
                            fromCircuitBreaker: false,
                        };
                    }

                    continue;
                }

                // All retries exhausted
                if (!silent) {
                    eventBus.emit('tool:failed', {
                        tool: tool.name,
                        input: args,
                        error: errorMessage(error),
                        durationMs,
                    });
                }

                return {
                    success: false,
                    output: `Falha na execução de "${tool.name}" após ${attempts} tentativa(s).`,
                    error: errorMessage(error),
                    durationMs,
                    attempts,
                    timedOut: false,
                    cancelled: false,
                    fromCircuitBreaker: false,
                };
            }
        }

        // Should not reach here, but safety fallback
        return {
            success: false,
            output: `Falha na execução de "${tool.name}".`,
            error: lastError,
            durationMs: Date.now() - startTime,
            attempts,
            timedOut: false,
            cancelled: false,
            fromCircuitBreaker: false,
        };
    }

    /**
     * Get or create circuit breaker for a tool.
     */
    private getCircuitBreaker(toolName: string): CircuitBreaker {
        if (!this.circuitBreakers.has(toolName)) {
            const breaker = circuitRegistry.getOrCreate({
                name: `tool:${toolName}`,
                failureThreshold: 3,
                resetTimeoutMs: 60_000,  // 1 minuto para retry
                successThreshold: 2,
            });
            this.circuitBreakers.set(toolName, breaker);
        }
        return this.circuitBreakers.get(toolName)!;
    }

    /**
     * Get timeout recommendation for a tool.
     */
    getTimeout(toolName: string): number {
        return TOOL_TIMEOUTS[toolName] || DEFAULT_TIMEOUT;
    }

    /**
     * Get all circuit breaker states.
     */
    getCircuitBreakerStates(): Array<{ name: string; state: string; metrics: CircuitBreakerMetrics }> {
        return Array.from(this.circuitBreakers.entries()).map(([name, breaker]) => ({
            name,
            state: breaker.getState(),
            metrics: breaker.getMetrics(),
        }));
    }
}

// ── Singleton ────────────────────────────────────────────────────
export const toolExecutor = new ToolExecutorService();
export default toolExecutor;