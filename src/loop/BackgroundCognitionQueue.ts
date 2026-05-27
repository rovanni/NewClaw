/**
 * BackgroundCognitionQueue — Pipeline assíncrono pós-turno.
 *
 * Executa tarefas de cognição (reflection, curation, summarization) APÓS
 * a resposta ser entregue ao usuário. Nunca bloqueia AgentLoop.
 *
 * Garantias:
 *   - Falha numa task nunca propaga para o turno do usuário
 *   - Timeout silencioso por task (configurável, default 30s)
 *   - Logs estruturados para todas as execuções
 *   - Sem concorrência: processa uma task por vez (sem competir com planning/execution)
 */

import { createLogger } from '../shared/AppLogger';

const log = createLogger('BackgroundCognitionQueue');

// ── Tipos públicos ──────────────────────────────────────────────────────────

export interface BackgroundTask {
    type: string;
    createdAt: number;
    timeoutMs: number;
    /** Callback de execução. Deve ser idempotente e sem efeitos visíveis ao usuário. */
    run: () => Promise<void>;
}

// ── Queue ───────────────────────────────────────────────────────────────────

export class BackgroundCognitionQueue {
    private queue: BackgroundTask[] = [];
    private running = false;

    /** Adiciona uma task à fila. Retorna imediatamente. */
    enqueue(task: BackgroundTask): void {
        this.queue.push(task);
        if (!this.running) {
            setImmediate(() => this.drain());
        }
    }

    /** Drena a fila uma task por vez, com baixa prioridade (setImmediate entre tasks). */
    private async drain(): Promise<void> {
        if (this.running) return;
        this.running = true;

        while (this.queue.length > 0) {
            const task = this.queue.shift()!;
            await this.runWithTimeout(task);
            // Yield para não bloquear o event loop entre tasks
            await new Promise(resolve => setImmediate(resolve));
        }

        this.running = false;
    }

    private async runWithTimeout(task: BackgroundTask): Promise<void> {
        const start = Date.now();
        try {
            await Promise.race([
                task.run(),
                new Promise<void>((_, reject) =>
                    setTimeout(() => reject(new Error('timeout')), task.timeoutMs)
                ),
            ]);
            const elapsed = Date.now() - start;
            log.info(`[BG] ${task.type} completed in ${elapsed}ms`);
        } catch (err) {
            const elapsed = Date.now() - start;
            const msg = err instanceof Error ? err.message : String(err);
            if (msg === 'timeout') {
                log.warn(`[BG] ${task.type} timed out after ${task.timeoutMs}ms`);
            } else {
                log.warn(`[BG] ${task.type} failed after ${elapsed}ms: ${msg}`);
            }
        }
    }

    get pendingCount(): number { return this.queue.length; }
}

// ── Singleton de baixa prioridade ───────────────────────────────────────────

let _instance: BackgroundCognitionQueue | null = null;

/** Singleton compartilhado — mesmo comportamento em toda a aplicação. */
export function getBackgroundQueue(): BackgroundCognitionQueue {
    if (!_instance) _instance = new BackgroundCognitionQueue();
    return _instance;
}
