/**
 * EventBus — Pub/sub desacoplado para comunicação entre componentes
 *
 * Substitui acoplamentos diretos (ex: Scheduler → TelegramAdapter)
 * por eventos tipados que qualquer adapter pode escutar.
 *
 * Uso:
 *   bus.on('scheduler.trigger', (event) => { ... });
 *   bus.emit({ type: 'scheduler.trigger', payload: { ... }, source: 'scheduler' });
 */

import { createLogger } from '../shared/AppLogger';
const log = createLogger('EventBus');

// ── Types ────────────────────────────────────────────────────────────

export type EventPayload = Record<string, unknown>;

export interface AppEvent {
    /** Event type (e.g. 'scheduler.trigger', 'tool.result', 'memory.updated') */
    type: string;
    /** Event data */
    payload: EventPayload;
    /** Source component */
    source: string;
    /** ISO 8601 timestamp (auto-filled if omitted) */
    timestamp?: string;
    /** Correlation ID for tracing across components */
    correlationId?: string;
}

export type EventHandler = (event: AppEvent) => void | Promise<void>;

export interface EventSubscription {
    eventType: string;
    handler: EventHandler;
    id: number;
}

// ── EventBus ─────────────────────────────────────────────────────────

export class EventBus {
    private handlers: Map<string, Set<EventHandler>> = new Map();
    private wildcardHandlers: Set<EventHandler> = new Set();
    private subscriptionCounter: number = 0;
    private eventLog: AppEvent[] = [];
    private maxLogSize: number = 200;

    /**
     * Subscribe to an event type.
     * Returns a subscription ID for unsubscribing.
     */
    on(eventType: string, handler: EventHandler): number {
        const id = ++this.subscriptionCounter;
        if (!this.handlers.has(eventType)) {
            this.handlers.set(eventType, new Set());
        }
        this.handlers.get(eventType)!.add(handler);
        log.info(`[EVENTBUS] Subscribed to '${eventType}' (sub #${id})`);
        return id;
    }

    /**
     * Subscribe to ALL events (wildcard).
     */
    onAny(handler: EventHandler): number {
        const id = ++this.subscriptionCounter;
        this.wildcardHandlers.add(handler);
        log.info(`[EVENTBUS] Subscribed to '*' (wildcard, sub #${id})`);
        return id;
    }

    /**
     * Unsubscribe by event type and handler reference.
     */
    off(eventType: string, handler: EventHandler): boolean {
        const handlers = this.handlers.get(eventType);
        if (handlers) {
            const deleted = handlers.delete(handler);
            if (handlers.size === 0) {
                this.handlers.delete(eventType);
            }
            return deleted;
        }
        return false;
    }

    /**
     * Unsubscribe wildcard handler.
     */
    offAny(handler: EventHandler): boolean {
        return this.wildcardHandlers.delete(handler);
    }

    /**
     * Emit an event to all subscribers.
     * Handlers are called asynchronously — errors are caught and logged.
     */
    async emit(event: AppEvent): Promise<void> {
        const enriched: AppEvent = {
            ...event,
            timestamp: event.timestamp || new Date().toISOString(),
        };

        // Log event for observability
        this.logEvent(enriched);

        const typeHandlers = this.handlers.get(enriched.type);
        const allHandlers = [...(typeHandlers || []), ...this.wildcardHandlers];

        if (allHandlers.length === 0) {
            log.debug(`[EVENTBUS] No handlers for '${enriched.type}' (source: ${enriched.source})`);
            return;
        }

        log.info(`[EVENTBUS] Emit '${enriched.type}' → ${allHandlers.length} handler(s) (source: ${enriched.source}, correlationId: ${enriched.correlationId || 'none'})`);

        // Execute handlers in parallel, catch errors individually
        const results = await Promise.allSettled(
            allHandlers.map(async (handler) => {
                try {
                    await handler(enriched);
                } catch (error: any) {
                    log.error(`[EVENTBUS] Handler error for '${enriched.type}': ${error.message}`, error);
                }
            })
        );

        // Log any rejected promises
        for (const result of results) {
            if (result.status === 'rejected') {
                log.error(`[EVENTBUS] Handler rejected for '${enriched.type}': ${result.reason}`);
            }
        }
    }

    /**
     * Get recent event log for observability/debugging.
     */
    getEventLog(limit: number = 50): AppEvent[] {
        return this.eventLog.slice(-limit);
    }

    /**
     * Get handler count for an event type.
     */
    handlerCount(eventType: string): number {
        return (this.handlers.get(eventType)?.size || 0) + this.wildcardHandlers.size;
    }

    /**
     * Get all registered event types.
     */
    eventTypes(): string[] {
        return Array.from(this.handlers.keys());
    }

    /**
     * Remove all subscriptions and clear log.
     */
    clear(): void {
        this.handlers.clear();
        this.wildcardHandlers.clear();
        this.eventLog = [];
        log.info('[EVENTBUS] All subscriptions cleared');
    }

    // ── Private ───────────────────────────────────────────────────

    private logEvent(event: AppEvent): void {
        this.eventLog.push(event);
        if (this.eventLog.length > this.maxLogSize) {
            this.eventLog.shift();
        }
    }
}

// ── Singleton ────────────────────────────────────────────────────────

export const eventBus = new EventBus();

// ── Well-known event types ────────────────────────────────────────────

export const EventTypes = {
    /** Scheduler triggers a scheduled task */
    SCHEDULER_TRIGGER: 'scheduler.trigger',
    /** Scheduler task completed */
    SCHEDULER_COMPLETED: 'scheduler.completed',
    /** Scheduler task failed */
    SCHEDULER_FAILED: 'scheduler.failed',
    /** A tool finished execution */
    TOOL_RESULT: 'tool.result',
    /** Memory was updated */
    MEMORY_UPDATED: 'memory.updated',
    /** Agent state changed */
    STATE_CHANGED: 'agent.state_changed',
    /** LLM call completed */
    LLM_RESPONSE: 'llm.response',
    /** LLM call failed */
    LLM_ERROR: 'llm.error',
    /** Circuit breaker state changed */
    CIRCUIT_STATE: 'circuit.state',
    /** Session started */
    SESSION_START: 'session.start',
    /** Session ended */
    SESSION_END: 'session.end',
    /** Agent lifecycle event */
    AGENT_START: 'agent.start',
    AGENT_STOP: 'agent.stop',
} as const;

export type EventType = typeof EventTypes[keyof typeof EventTypes];