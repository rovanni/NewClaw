/**
 * EventBus — Pub/Sub desacoplado para o NewClaw
 * 
 * Duas APIs complementares:
 * 1. Tipada: eventBus.on('tool:executed', data) — type-safe com EventBusEvents
 * 2. Genérica: eventBus.emit({ type: 'scheduler.trigger', payload, source }) — AppEvent flexível
 * 
 * Ambas coexistem. Handlers genéricos recebem AppEvent; handlers tipados recebem dados específicos.
 */

import { EventEmitter } from 'events';
import { createLogger } from '../shared/AppLogger';
import { errorMessage } from '../shared/errors';
const log = createLogger('EventBus');

// ── Tipos de Evento Tipados ──────────────────────────────────────

export interface EventBusEvents {
    'tool:executed': { tool: string; input: Record<string, any>; success: boolean; durationMs: number; error?: string };
    'tool:failed': { tool: string; input: Record<string, any>; error: string; durationMs: number };
    'tool:timeout': { tool: string; input: Record<string, any>; timeoutMs: number };
    'llm:call': { provider: string; model: string; tokens: number; durationMs: number };
    'llm:fallback': { fromProvider: string; toProvider: string; reason: string };
    'llm:timeout': { provider: string; model: string; timeoutMs: number };
    'llm:error': { provider: string; model: string; error: string };
    'agent:thinking': { conversationId: string; step: number };
    'agent:response': { conversationId: string; response: string; stepCount: number; durationMs: number };
    'agent:error': { conversationId: string; error: string };
    'session:created': { sessionId: string; channel: string };
    'session:closed': { sessionId: string };
    'session:compressed': { sessionId: string; messagesCompressed: number; tokensSaved: number };
    'memory:node:created': { id: string; type: string; name: string };
    'memory:node:updated': { id: string; field: string; oldValue: string; newValue: string };
    'memory:edge:created': { from: string; to: string; relation: string };
    'memory:governance': { nodesDecayed: number; conflictsDetected: number; nodesGCd: number };
    'circuit:open': { name: string; failures: number; threshold: number };
    'circuit:half-open': { name: string };
    'circuit:closed': { name: string; successes: number };
    'channel:message': { channel: string; userId: string; type: string; text: string };
    'channel:error': { channel: string; error: string };
    'memory:classified': { contentId: string; confidence: Confidence; score: number };
}

// ── Confidence Types (#11) ─────────────────────────────────────

export type Confidence = 'FACT' | 'INFERENCE' | 'HYPOTHESIS' | 'REASONING' | 'SPECULATION' | 'TOOL_RESULT' | 'USER_INPUT';

export const CONFIDENCE_SCORES: Record<Confidence, number> = {
    FACT: 0.95,
    TOOL_RESULT: 0.9,
    USER_INPUT: 0.85,
    REASONING: 0.7,
    INFERENCE: 0.6,
    HYPOTHESIS: 0.3,
    SPECULATION: 0.1,
};

export const CONFIDENCE_TTL: Record<Confidence, number> = {
    FACT: Infinity,
    TOOL_RESULT: 720,
    USER_INPUT: 720,
    REASONING: 168,
    INFERENCE: 72,
    HYPOTHESIS: 24,
    SPECULATION: 6,
};

export interface ClassifiedContent {
    id: string;
    content: string;
    confidence: Confidence;
    score: number;
    source: string;
    ttl: number;
    createdAt: Date;
    expiresAt?: Date;
}

// ── AppEvent (Generic Event) ─────────────────────────────────────

export type EventPayload = Record<string, unknown>;

export interface AppEvent {
    type: string;
    payload: EventPayload;
    source: string;
    timestamp?: string;
    correlationId?: string;
}

export type EventHandler = (event: AppEvent) => void | Promise<void>;

// ── Well-known event types ────────────────────────────────────────

export const EventTypes = {
    SCHEDULER_TRIGGER: 'scheduler.trigger',
    SCHEDULER_COMPLETED: 'scheduler.completed',
    SCHEDULER_FAILED: 'scheduler.failed',
    TOOL_RESULT: 'tool.result',
    MEMORY_UPDATED: 'memory.updated',
    STATE_CHANGED: 'agent.state_changed',
    LLM_RESPONSE: 'llm.response',
    LLM_ERROR: 'llm.error',
    CIRCUIT_STATE: 'circuit.state',
    SESSION_START: 'session.start',
    SESSION_END: 'session.end',
    AGENT_START: 'agent.start',
    AGENT_STOP: 'agent.stop',
} as const;

export type EventType = typeof EventTypes[keyof typeof EventTypes];

// ── EventBus Class ────────────────────────────────────────────────

type TypedEventHandler<T> = (data: T) => void | Promise<void>;

export class EventBusClass {
    private emitter: EventEmitter;
    private metrics: Map<string, { emitCount: number; lastEmitAt: number }> = new Map();
    private eventLog: AppEvent[] = [];
    private maxLogSize: number = 200;

    constructor() {
        this.emitter = new EventEmitter();
    }

    // ── Typed API ────────────────────────────────────────────────

    emit<T extends keyof EventBusEvents>(event: T, data: EventBusEvents[T]): boolean {
        this.recordMetric(event as string);
        try {
            return this.emitter.emit(event, data);
        } catch (err) {
            console.error(`[EventBus] Error emitting ${String(event)}:`, err);
            return false;
        }
    }

    async emitAsync<T extends keyof EventBusEvents>(event: T, data: EventBusEvents[T]): Promise<boolean> {
        this.recordMetric(event as string);
        const listeners = this.emitter.listeners(event);
        if (listeners.length === 0) return true;

        const results = await Promise.allSettled(
            listeners.map(async (listener) => {
                try {
                    await (listener as TypedEventHandler<EventBusEvents[T]>)(data);
                } catch (err) {
                    console.error(`[EventBus] Async handler error for ${String(event)}:`, err);
                    throw err;
                }
            })
        );
        return results.every(r => r.status === 'fulfilled');
    }

    on<T extends keyof EventBusEvents>(event: T, handler: TypedEventHandler<EventBusEvents[T]>): () => void {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Node.js EventEmitter usa (...args: any[]) => void, incompatível com handlers tipados
        this.emitter.on(event, handler as any);
        return () => this.emitter.off(event, handler as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    }

    once<T extends keyof EventBusEvents>(event: T, handler: TypedEventHandler<EventBusEvents[T]>): () => void {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- interop obrigatório com EventEmitter
        this.emitter.once(event, handler as any);
        return () => this.emitter.off(event, handler as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    }

    off<T extends keyof EventBusEvents>(event: T, handler: TypedEventHandler<EventBusEvents[T]>): void {
        this.emitter.off(event, handler as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    }

    handlerCount(event: keyof EventBusEvents): number {
        return this.emitter.listenerCount(event);
    }

    // ── Generic AppEvent API ──────────────────────────────────────

    /**
     * Emit a generic AppEvent (for scheduler, lifecycle, etc).
     * Routes to the typed emitter under the hood.
     */
    async emitAppEvent(event: AppEvent): Promise<void> {
        const enriched: AppEvent = {
            ...event,
            timestamp: event.timestamp || new Date().toISOString(),
        };
        this.logEvent(enriched);

        // Also emit on the typed bus if the type matches
        const handlers = this.emitter.listeners(enriched.type);
        if (handlers.length === 0) {
            log.debug(`[EventBus] No handlers for '${enriched.type}' (source: ${enriched.source})`);
        } else {
            log.info(`[EventBus] Emit '${enriched.type}' → ${handlers.length} handler(s)`);
            await Promise.allSettled(
                handlers.map(async (handler) => {
                    try { await handler(enriched); } catch (e) { log.error(`[EventBus] Handler error: ${errorMessage(e)}`); }
                })
            );
        }
    }

    /**
     * Subscribe to generic AppEvent type.
     */
    onAny(handler: EventHandler): number {
        // Wildcard via EventEmitter's special wildcard handling
        const id = Date.now();
        for (const eventType of Object.values(EventTypes)) {
            this.emitter.on(eventType, handler as any); // eslint-disable-line @typescript-eslint/no-explicit-any -- interop com EventEmitter
        }
        log.info(`[EventBus] Subscribed to all event types (sub #${id})`);
        return id;
    }

    /**
     * Get recent event log for observability.
     */
    getEventLog(limit: number = 50): AppEvent[] {
        return this.eventLog.slice(-limit);
    }

    /**
     * Get all registered event types.
     */
    eventTypes(): string[] {
        return this.emitter.eventNames().map(String);
    }

    /**
     * Clear all subscriptions.
     */
    clear(): void {
        this.emitter.removeAllListeners();
        this.eventLog = [];
        log.info('[EventBus] All subscriptions cleared');
    }

    // ── Metrics ───────────────────────────────────────────────────

    getMetrics(): Map<string, { emitCount: number; lastEmitAt: number }> {
        return new Map(this.metrics);
    }

    // ── Private ──────────────────────────────────────────────────

    private recordMetric(event: string): void {
        const existing = this.metrics.get(event) || { emitCount: 0, lastEmitAt: 0 };
        existing.emitCount++;
        existing.lastEmitAt = Date.now();
        this.metrics.set(event, existing);
    }

    private logEvent(event: AppEvent): void {
        this.eventLog.push(event);
        if (this.eventLog.length > this.maxLogSize) {
            this.eventLog.shift();
        }
    }
}

// ── Singleton ────────────────────────────────────────────────────
export const eventBus = new EventBusClass();
export default eventBus;