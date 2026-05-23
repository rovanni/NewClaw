/**
 * CMIEngine — Orquestrador principal da camada Conversational Memory Index.
 *
 * Fase 1: Storage + Ingestion apenas.
 * Nenhum retrieval, nenhuma injeção no AgentLoop ainda.
 *
 * Responsabilidades:
 *   - Receber entradas do SessionManager (fire-and-forget)
 *   - Coordenar CMIBuffer (decisão de corte) + CMIIngestionPipeline (processamento)
 *   - Persistir chunks via CMIRepository
 *   - Executar GC periódico via MemoryGovernor hook
 *   - Varredura de timeout de sessões inativas
 */

import type Database from 'better-sqlite3';
import { ProviderFactory } from '../../core/ProviderFactory';
import { TranscriptEntry } from '../../session/SessionTranscript';
import { ChunkCutTrigger, ConversationChunk } from './cmiTypes';
import { CMIBuffer } from './CMIBuffer';
import { CMIRepository } from './CMIRepository';
import { CMIIngestionPipeline } from './CMIIngestionPipeline';
import { createLogger } from '../../shared/AppLogger';

const log = createLogger('CMIEngine');

/** Intervalo de verificação de sessões com timeout (ms) */
const TIME_WINDOW_SWEEP_INTERVAL_MS = 5 * 60_000; // 5 minutos

/** Intervalo de GC de chunks expirados (ms) */
const GC_INTERVAL_MS = 60 * 60_000; // 1 hora

export class CMIEngine {
    private buffer: CMIBuffer;
    private repo: CMIRepository;
    private pipeline: CMIIngestionPipeline;

    private sweepTimer: ReturnType<typeof setInterval> | null = null;
    private gcTimer: ReturnType<typeof setInterval> | null = null;

    /** Contadores para observabilidade */
    private stats = {
        entriesFed: 0,
        chunksCreated: 0,
        chunksDiscarded: 0,
        embeddings: 0,
        gcRuns: 0
    };

    constructor(db: Database.Database, providerFactory: ProviderFactory, ollamaUrl?: string) {
        this.repo = new CMIRepository(db);
        this.repo.ensureSchema();

        this.buffer = new CMIBuffer();
        this.pipeline = new CMIIngestionPipeline(providerFactory, ollamaUrl);

        this.startTimers();
        log.info('init', 'CMIEngine inicializado (Fase 1: ingestion-only)');
    }

    // ── API PÚBLICA ────────────────────────────────────────────────────────────

    /**
     * Alimenta o CMI com uma nova entrada do transcript.
     * Chamado pelo SessionManager em fire-and-forget.
     * Nunca lança exceção — erros são logados silenciosamente.
     */
    async feedEntry(sessionKey: string, entry: TranscriptEntry): Promise<void> {
        try {
            this.stats.entriesFed++;
            const cutTrigger = this.buffer.push(sessionKey, entry);
            if (cutTrigger !== null) {
                await this.flushSession(sessionKey, cutTrigger);
            }
        } catch (err) {
            log.warn('feedEntry', `${sessionKey}: ${String(err)}`);
        }
    }

    /**
     * Força flush imediato de uma sessão.
     * Chamado pelo SessionManager quando um checkpoint é criado.
     */
    async onCheckpointCreated(sessionKey: string): Promise<void> {
        try {
            await this.flushSession(sessionKey, 'checkpoint_written');
        } catch (err) {
            log.warn('onCheckpointCreated', `${sessionKey}: ${String(err)}`);
        }
    }

    // ── ACESSO AO REPOSITÓRIO (para a tool de inspeção) ───────────────────────

    getRepository(): CMIRepository {
        return this.repo;
    }

    getStats(): typeof this.stats & { bufferedSessions: number } {
        return {
            ...this.stats,
            bufferedSessions: 0 // aproximado — sem expor o buffer interno
        };
    }

    // ── LIFECYCLE ──────────────────────────────────────────────────────────────

    /**
     * Drena todos os buffers ativos e para os timers.
     * Chamar no shutdown do sistema.
     */
    async shutdown(): Promise<void> {
        this.stopTimers();
        const timedOut = this.buffer.getTimedOutSessions();
        for (const key of timedOut) {
            await this.flushSession(key, 'time_window').catch(() => {});
        }
        log.info('shutdown', `CMIEngine encerrado. Stats: ${JSON.stringify(this.stats)}`);
    }

    // ── PRIVADO ────────────────────────────────────────────────────────────────

    private async flushSession(
        sessionKey: string,
        trigger: ChunkCutTrigger
    ): Promise<void> {
        const state = trigger === 'checkpoint_written'
            ? this.buffer.forceFlush(sessionKey, trigger)
            : this.buffer.flush(sessionKey);

        if (!state) return;

        // conversationId = sessionKey (padrão "canal:userId")
        const conversationId = sessionKey;

        const chunk = await this.pipeline.process(
            sessionKey, conversationId, state, trigger
        );

        if (!chunk) {
            this.stats.chunksDiscarded++;
            return;
        }

        this.repo.save(chunk);
        this.stats.chunksCreated++;
        if (chunk.embedding) this.stats.embeddings++;

        this.logChunkCreated(chunk);
    }

    private logChunkCreated(chunk: ConversationChunk): void {
        const age = Math.round((Date.now() - chunk.startTimestamp) / 1000);
        log.info('chunkCreated', [
            `[CMI] Novo chunk: ${chunk.id}`,
            `  session: ${chunk.sessionKey}`,
            `  trigger: ${chunk.cutTrigger}`,
            `  quality: ${chunk.chunkQuality.toFixed(2)}`,
            `  msgs: ${chunk.messages.length}`,
            `  topics: ${chunk.topics.join(', ') || '(nenhum)'}`,
            `  entities: ${chunk.entities.slice(0, 3).join(', ') || '(nenhuma)'}`,
            `  tools: ${chunk.toolsUsed.join(', ') || '(nenhuma)'}`,
            `  embed: ${!!chunk.embedding}`,
            `  duration: ${age}s`
        ].join('\n'));
    }

    private startTimers(): void {
        // Sweep de sessões com inatividade > MAX_TIME_WINDOW
        this.sweepTimer = setInterval(async () => {
            const timedOut = this.buffer.getTimedOutSessions();
            for (const key of timedOut) {
                log.info('timeSweep', `Flushing session por inatividade: ${key}`);
                await this.flushSession(key, 'time_window').catch(() => {});
            }
        }, TIME_WINDOW_SWEEP_INTERVAL_MS);

        // GC periódico de chunks expirados
        this.gcTimer = setInterval(() => {
            this.stats.gcRuns++;
            const removed = this.repo.deleteExpired();
            // Chunks de baixíssima qualidade com mais de 30 dias
            const removed2 = this.repo.deleteLowQualityOld(30 * 24 * 3600_000, 0.3);
            if (removed + removed2 > 0) {
                log.info('gc', `GC: ${removed + removed2} chunks removidos`);
            }
        }, GC_INTERVAL_MS);

        // Não impede o processo de terminar
        if (this.sweepTimer.unref) this.sweepTimer.unref();
        if (this.gcTimer.unref) this.gcTimer.unref();
    }

    private stopTimers(): void {
        if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
        if (this.gcTimer)    { clearInterval(this.gcTimer);    this.gcTimer = null; }
    }
}
