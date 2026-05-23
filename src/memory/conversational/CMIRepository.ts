/**
 * CMIRepository — CRUD SQLite para conversation_chunks.
 *
 * Responsabilidade única: persistência e consultas.
 * Nenhuma lógica de negócio aqui.
 */

import type Database from 'better-sqlite3';
import { ConversationChunk, ChunkRow, CMIStats } from './cmiTypes';
import { createLogger } from '../../shared/AppLogger';

const log = createLogger('CMIRepository');

export class CMIRepository {
    private db: Database.Database;

    constructor(db: Database.Database) {
        this.db = db;
    }

    // ── SCHEMA ─────────────────────────────────────────────────────────────────

    ensureSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS conversation_chunks (
                id TEXT PRIMARY KEY,
                session_key TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                start_seq INTEGER NOT NULL,
                end_seq INTEGER NOT NULL,
                start_timestamp INTEGER NOT NULL,
                end_timestamp INTEGER NOT NULL,
                summary TEXT NOT NULL,
                topics TEXT NOT NULL DEFAULT '[]',
                entities TEXT NOT NULL DEFAULT '[]',
                intent TEXT NOT NULL DEFAULT '',
                messages TEXT NOT NULL DEFAULT '[]',
                embedding BLOB,
                workflow_id TEXT,
                tools_used TEXT NOT NULL DEFAULT '[]',
                chunk_quality REAL NOT NULL DEFAULT 0.5,
                cut_trigger TEXT NOT NULL DEFAULT 'window_size',
                created_at INTEGER NOT NULL,
                last_accessed_at INTEGER,
                access_count INTEGER NOT NULL DEFAULT 0,
                expires_at INTEGER
            )
        `);

        const tryIndex = (sql: string) => {
            try { this.db.exec(sql); } catch { /* ignora duplicata */ }
        };
        tryIndex('CREATE INDEX IF NOT EXISTS idx_cmi_session_time ON conversation_chunks(session_key, start_timestamp DESC)');
        tryIndex('CREATE INDEX IF NOT EXISTS idx_cmi_quality ON conversation_chunks(chunk_quality DESC)');
        tryIndex('CREATE INDEX IF NOT EXISTS idx_cmi_expires ON conversation_chunks(expires_at)');
        tryIndex('CREATE INDEX IF NOT EXISTS idx_cmi_created ON conversation_chunks(created_at DESC)');

        log.info('ensureSchema', 'conversation_chunks schema OK');
    }

    // ── WRITE ──────────────────────────────────────────────────────────────────

    save(chunk: ConversationChunk): void {
        this.db.prepare(`
            INSERT OR REPLACE INTO conversation_chunks (
                id, session_key, conversation_id,
                start_seq, end_seq, start_timestamp, end_timestamp,
                summary, topics, entities, intent, messages,
                embedding, workflow_id, tools_used,
                chunk_quality, cut_trigger,
                created_at, last_accessed_at, access_count, expires_at
            ) VALUES (
                ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?, ?,
                ?, ?,
                ?, ?, ?, ?
            )
        `).run(
            chunk.id, chunk.sessionKey, chunk.conversationId,
            chunk.startSeq, chunk.endSeq, chunk.startTimestamp, chunk.endTimestamp,
            chunk.summary,
            JSON.stringify(chunk.topics),
            JSON.stringify(chunk.entities),
            chunk.intent,
            JSON.stringify(chunk.messages),
            chunk.embedding,
            chunk.workflowId,
            JSON.stringify(chunk.toolsUsed),
            chunk.chunkQuality,
            chunk.cutTrigger,
            chunk.createdAt,
            chunk.lastAccessedAt,
            chunk.accessCount,
            chunk.expiresAt
        );
    }

    // ── READ ───────────────────────────────────────────────────────────────────

    findById(id: string): ConversationChunk | null {
        const row = this.db.prepare(
            'SELECT * FROM conversation_chunks WHERE id = ?'
        ).get(id) as ChunkRow | undefined;
        return row ? this.rowToChunk(row) : null;
    }

    /** Chunks recentes de uma sessão, ordenados por timestamp desc */
    findBySession(sessionKey: string, limit = 20): ConversationChunk[] {
        const rows = this.db.prepare(`
            SELECT * FROM conversation_chunks
            WHERE session_key = ?
            ORDER BY start_timestamp DESC
            LIMIT ?
        `).all(sessionKey, limit) as ChunkRow[];
        return rows.map(r => this.rowToChunk(r));
    }

    /** Chunks recentes globais (todas as sessões), para inspeção */
    findRecent(limit = 10): ConversationChunk[] {
        const rows = this.db.prepare(`
            SELECT * FROM conversation_chunks
            ORDER BY created_at DESC
            LIMIT ?
        `).all(limit) as ChunkRow[];
        return rows.map(r => this.rowToChunk(r));
    }

    /** Chunks com embedding para retrieval semântico */
    findWithEmbedding(sessionKey: string): Array<{ id: string; embedding: Buffer }> {
        return this.db.prepare(`
            SELECT id, embedding FROM conversation_chunks
            WHERE session_key = ? AND embedding IS NOT NULL
            ORDER BY start_timestamp DESC
        `).all(sessionKey) as Array<{ id: string; embedding: Buffer }>;
    }

    /** Busca textual simples (para inspeção/debug na Fase 2) */
    searchByText(query: string, limit = 10): ConversationChunk[] {
        const term = `%${query.toLowerCase()}%`;
        const rows = this.db.prepare(`
            SELECT * FROM conversation_chunks
            WHERE lower(summary) LIKE ?
               OR lower(topics) LIKE ?
               OR lower(entities) LIKE ?
               OR lower(intent) LIKE ?
            ORDER BY chunk_quality DESC, created_at DESC
            LIMIT ?
        `).all(term, term, term, term, limit) as ChunkRow[];
        return rows.map(r => this.rowToChunk(r));
    }

    // ── LIFECYCLE ──────────────────────────────────────────────────────────────

    /** Incrementa access_count e atualiza last_accessed_at */
    recordAccess(id: string): void {
        this.db.prepare(`
            UPDATE conversation_chunks
            SET access_count = access_count + 1,
                last_accessed_at = ?
            WHERE id = ?
        `).run(Date.now(), id);
    }

    /** Remove chunks expirados (expires_at < now AND access_count < threshold) */
    deleteExpired(accessThreshold = 3): number {
        const now = Date.now();
        const result = this.db.prepare(`
            DELETE FROM conversation_chunks
            WHERE expires_at IS NOT NULL
              AND expires_at < ?
              AND access_count < ?
        `).run(now, accessThreshold) as { changes: number };
        if (result.changes > 0) {
            log.info('deleteExpired', `Removidos ${result.changes} chunks expirados`);
        }
        return result.changes;
    }

    /** Remove chunks de baixa qualidade muito antigos */
    deleteLowQualityOld(maxAgeMs: number, qualityThreshold = 0.3): number {
        const cutoff = Date.now() - maxAgeMs;
        const result = this.db.prepare(`
            DELETE FROM conversation_chunks
            WHERE created_at < ?
              AND chunk_quality < ?
              AND access_count = 0
        `).run(cutoff, qualityThreshold) as { changes: number };
        if (result.changes > 0) {
            log.info('deleteLowQuality', `Removidos ${result.changes} chunks baixa qualidade`);
        }
        return result.changes;
    }

    // ── STATS ──────────────────────────────────────────────────────────────────

    getStats(): CMIStats {
        const total = (this.db.prepare(
            'SELECT COUNT(*) as c FROM conversation_chunks'
        ).get() as { c: number }).c;

        if (total === 0) {
            return {
                totalChunks: 0, totalSessions: 0,
                avgQuality: 0, avgMessagesPerChunk: 0,
                chunksWithEmbedding: 0, storageEstimateKb: 0,
                topTopics: [], topEntities: [],
                qualityDistribution: { high: 0, medium: 0, low: 0 },
                recentChunks: 0
            };
        }

        const agg = this.db.prepare(`
            SELECT
                COUNT(DISTINCT session_key) as sessions,
                AVG(chunk_quality) as avg_quality,
                SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) as with_emb,
                SUM(length(summary) + length(messages)) as storage_approx,
                SUM(CASE WHEN chunk_quality >= 0.7 THEN 1 ELSE 0 END) as high_q,
                SUM(CASE WHEN chunk_quality >= 0.4 AND chunk_quality < 0.7 THEN 1 ELSE 0 END) as mid_q,
                SUM(CASE WHEN chunk_quality < 0.4 THEN 1 ELSE 0 END) as low_q
            FROM conversation_chunks
        `).get() as {
            sessions: number; avg_quality: number; with_emb: number;
            storage_approx: number; high_q: number; mid_q: number; low_q: number;
        };

        const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000;
        const recent = (this.db.prepare(
            'SELECT COUNT(*) as c FROM conversation_chunks WHERE created_at > ?'
        ).get(sevenDaysAgo) as { c: number }).c;

        // Extrair top topics e entities dos JSON armazenados
        const topTopics = this.aggregateJsonArrayField('topics', 10);
        const topEntities = this.aggregateJsonArrayField('entities', 10);

        // Avg messages per chunk
        const rows = this.db.prepare(
            'SELECT messages FROM conversation_chunks LIMIT 100'
        ).all() as Array<{ messages: string }>;
        const avgMsgs = rows.length > 0
            ? rows.reduce((sum, r) => {
                try { return sum + (JSON.parse(r.messages) as unknown[]).length; } catch { return sum; }
            }, 0) / rows.length
            : 0;

        return {
            totalChunks: total,
            totalSessions: agg.sessions,
            avgQuality: Math.round((agg.avg_quality || 0) * 100) / 100,
            avgMessagesPerChunk: Math.round(avgMsgs * 10) / 10,
            chunksWithEmbedding: agg.with_emb,
            storageEstimateKb: Math.round((agg.storage_approx || 0) / 1024),
            topTopics,
            topEntities,
            qualityDistribution: { high: agg.high_q, medium: agg.mid_q, low: agg.low_q },
            recentChunks: recent
        };
    }

    // ── HELPERS ────────────────────────────────────────────────────────────────

    private rowToChunk(row: ChunkRow): ConversationChunk {
        const parse = <T>(json: string, fallback: T): T => {
            try { return JSON.parse(json) as T; } catch { return fallback; }
        };
        return {
            id: row.id,
            sessionKey: row.session_key,
            conversationId: row.conversation_id,
            startSeq: row.start_seq,
            endSeq: row.end_seq,
            startTimestamp: row.start_timestamp,
            endTimestamp: row.end_timestamp,
            summary: row.summary,
            topics: parse<string[]>(row.topics, []),
            entities: parse<string[]>(row.entities, []),
            intent: row.intent,
            messages: parse(row.messages, []),
            embedding: row.embedding,
            workflowId: row.workflow_id,
            toolsUsed: parse<string[]>(row.tools_used, []),
            chunkQuality: row.chunk_quality,
            cutTrigger: row.cut_trigger as ConversationChunk['cutTrigger'],
            createdAt: row.created_at,
            lastAccessedAt: row.last_accessed_at,
            accessCount: row.access_count,
            expiresAt: row.expires_at
        };
    }

    private aggregateJsonArrayField(
        field: string, limit: number
    ): Array<{ name: string; count: number }> {
        const rows = this.db.prepare(
            `SELECT ${field} FROM conversation_chunks WHERE ${field} != '[]'`
        ).all() as Array<{ [k: string]: string }>;

        const counts = new Map<string, number>();
        for (const row of rows) {
            try {
                const items = JSON.parse(row[field]) as string[];
                for (const item of items) {
                    counts.set(item, (counts.get(item) || 0) + 1);
                }
            } catch { /* skip malformed */ }
        }

        return [...counts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit)
            .map(([name, count]) => ({ name, count }));
    }
}
