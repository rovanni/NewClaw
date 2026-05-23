/**
 * ConversationQueueManager — Serialização de mensagens por conversa
 *
 * Garante que mensagens do mesmo usuário/conversa sejam processadas
 * exatamente em ordem, sem descarte, com ACK amigável ao usuário.
 *
 * Cada conversa tem sua própria PQueue com concurrency=1.
 * Filas ociosas são removidas automaticamente após IDLE_CLEANUP_MS.
 */

import PQueue from 'p-queue';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('ConvQueue');

export interface EnqueueResult {
    /** true = tarefa ficou na fila atrás de outra */
    queued: boolean;
    /** Profundidade da fila no momento do enqueue (0 = executou imediatamente) */
    position: number;
    /** true = caller deve enviar ACK de "estou processando, aguarde" */
    sendAck: boolean;
}

export interface BackpressureResult {
    rejected: true;
    reason: 'backpressure';
}

interface ConversationEntry {
    queue: PQueue;
    lastActivityAt: number;
    /** Impede spam de ACK: só envia um por burst (resetado quando a fila esvazia) */
    ackSentForCurrentBurst: boolean;
}

export class ConversationQueueManager {
    private readonly queues = new Map<string, ConversationEntry>();

    /** Limite de mensagens aguardando por conversa (backpressure) */
    readonly MAX_PENDING = parseInt(process.env.CONV_QUEUE_MAX_PENDING || '20', 10);

    /** Tempo de inatividade para remover a fila da memória */
    readonly IDLE_CLEANUP_MS = parseInt(process.env.CONV_QUEUE_IDLE_MS || String(5 * 60 * 1000), 10);

    private cleanupTimer: NodeJS.Timeout | null = null;

    constructor() {
        this.cleanupTimer = setInterval(() => this.cleanupIdleQueues(), this.IDLE_CLEANUP_MS);
        this.cleanupTimer.unref();
    }

    /**
     * Adiciona uma tarefa à fila da conversa.
     *
     * Retorna BackpressureResult se a fila estiver cheia.
     * Retorna EnqueueResult informando se o caller deve enviar ACK.
     *
     * IMPORTANTE: a tarefa só é executada quando a fila chega à sua vez.
     * O caller NÃO precisa awaitar — processMessage pode retornar imediatamente
     * após o enqueue (o task roda em background via PQueue).
     */
    enqueue(
        conversationId: string,
        task: () => Promise<void>
    ): EnqueueResult | BackpressureResult {
        const entry = this.getOrCreate(conversationId);
        const { queue } = entry;

        // queue.size = tarefas esperando (não iniciadas)
        // queue.pending = tarefas atualmente em execução (0 ou 1 com concurrency=1)
        const waiting = queue.size;
        const running = queue.pending;

        if (waiting >= this.MAX_PENDING) {
            log.warn('backpressure', `Queue full for ${conversationId}: ${waiting} waiting, ${running} running`);
            return { rejected: true, reason: 'backpressure' };
        }

        const isBusy = running > 0 || waiting > 0;

        // Envia ACK somente no PRIMEIRO enqueue extra por burst
        const sendAck = isBusy && !entry.ackSentForCurrentBurst;
        if (sendAck) {
            entry.ackSentForCurrentBurst = true;
        }

        entry.lastActivityAt = Date.now();

        // Adiciona à fila — executa quando for a vez (concurrency=1)
        queue.add(async () => {
            entry.lastActivityAt = Date.now();
            try {
                await task();
            } finally {
                entry.lastActivityAt = Date.now();
            }
        });

        log.debug('enqueued', conversationId, {
            waiting: queue.size,
            running: queue.pending,
            isBusy,
            sendAck
        });

        return { queued: isBusy, position: waiting + running, sendAck };
    }

    /** Métricas pontuais de uma conversa (para logging e healthcheck) */
    getMetrics(conversationId: string): { size: number; pending: number } | null {
        const entry = this.queues.get(conversationId);
        if (!entry) return null;
        return { size: entry.queue.size, pending: entry.queue.pending };
    }

    /** Número total de conversas com fila ativa em memória */
    getActiveCount(): number {
        return this.queues.size;
    }

    /**
     * Remove tarefas pendentes (ainda não iniciadas) de uma conversa.
     * Tarefas já em execução não são afetadas — use AgentLoop.cancel() para isso.
     * Retorna o número de tarefas descartadas.
     */
    clearQueue(conversationId: string): number {
        const entry = this.queues.get(conversationId);
        if (!entry) return 0;
        const pending = entry.queue.size;
        entry.queue.clear();
        entry.ackSentForCurrentBurst = false;
        return pending;
    }

    /** Libera todos os recursos (chame em stopAll) */
    destroy(): void {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
        for (const entry of this.queues.values()) {
            entry.queue.clear();
        }
        this.queues.clear();
        log.info('destroyed', 'ConversationQueueManager destroyed');
    }

    // ── Internals ───────────────────────────────────────────────────────────────

    private getOrCreate(conversationId: string): ConversationEntry {
        let entry = this.queues.get(conversationId);
        if (!entry) {
            const queue = new PQueue({ concurrency: 1 });
            entry = {
                queue,
                lastActivityAt: Date.now(),
                ackSentForCurrentBurst: false,
            };

            // Quando a fila esvazia completamente, reseta o flag de ACK
            // para que o próximo burst receba notificação novamente
            queue.on('idle', () => {
                if (entry) {
                    entry.ackSentForCurrentBurst = false;
                }
            });

            this.queues.set(conversationId, entry);
            log.debug('queue_created', `New queue for ${conversationId}`);
        }
        return entry;
    }

    private cleanupIdleQueues(): void {
        const now = Date.now();
        let removed = 0;
        for (const [id, entry] of this.queues) {
            if (
                entry.queue.size === 0 &&
                entry.queue.pending === 0 &&
                now - entry.lastActivityAt > this.IDLE_CLEANUP_MS
            ) {
                this.queues.delete(id);
                removed++;
            }
        }
        if (removed > 0) {
            log.info('cleanup', `Removed ${removed} idle queues, ${this.queues.size} remaining`);
        }
    }
}
