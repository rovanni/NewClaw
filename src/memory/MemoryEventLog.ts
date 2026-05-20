/**
 * MemoryEventLog — Auditoria de operações do grafo cognitivo
 *
 * Registra o ciclo de vida dos nós, episódios e operações do sistema.
 * Permite responder: "quando exatamente o sistema aprendeu / esqueceu X?"
 *
 * Append-only: eventos nunca são alterados, apenas prunados por idade.
 */

import Database from 'better-sqlite3';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('MemoryEventLog');

// ── Types ──────────────────────────────────────────────────────────────────

export type MemoryEventType =
    | 'node_added'
    | 'node_updated'
    | 'node_expired'
    | 'node_summarized'
    | 'node_superseded'
    | 'node_promoted'
    | 'episode_opened'
    | 'episode_closed'
    | 'reflection_generated'
    | 'distillation_run'
    | 'sparse_graph_pruned'
    | 'dedup_merged'
    | 'skill_executed'
    | 'skill_succeeded'
    | 'skill_failed';

export type MemoryEntityType = 'node' | 'edge' | 'episode' | 'system';

export interface MemoryEvent {
    id: number;
    event_type: MemoryEventType;
    entity_id: string | null;
    entity_type: MemoryEntityType;
    data_json: string | null;
    source: string | null;
    created_at: string;
}

// ── Service ────────────────────────────────────────────────────────────────

export class MemoryEventLog {
    private db: Database.Database;
    private insertStmt!: Database.Statement;

    constructor(db: Database.Database) {
        this.db = db;
        this.initSchema();
    }

    private initSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS memory_events (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                event_type  TEXT NOT NULL,
                entity_id   TEXT,
                entity_type TEXT NOT NULL DEFAULT 'node',
                data_json   TEXT,
                source      TEXT,
                created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        try {
            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_events_type    ON memory_events(event_type)`);
            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_events_entity  ON memory_events(entity_id)`);
            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_events_created ON memory_events(created_at)`);
        } catch { /* ignore duplicate index errors */ }

        this.insertStmt = this.db.prepare(`
            INSERT INTO memory_events (event_type, entity_id, entity_type, data_json, source)
            VALUES (?, ?, ?, ?, ?)
        `);
    }

    // ── Write ──────────────────────────────────────────────────────────────

    log(
        eventType: MemoryEventType,
        entityId: string | null,
        entityType: MemoryEntityType,
        data?: Record<string, unknown>,
        source?: string
    ): void {
        try {
            this.insertStmt.run(
                eventType,
                entityId,
                entityType,
                data ? JSON.stringify(data) : null,
                source ?? null
            );
        } catch (e) {
            log.warn(`[EventLog] Failed to log ${eventType} for ${entityId}:`, String(e));
        }
    }

    /** Log multiple events in a single transaction (batch operations). */
    logBatch(events: Array<{
        eventType: MemoryEventType;
        entityId: string | null;
        entityType: MemoryEntityType;
        data?: Record<string, unknown>;
        source?: string;
    }>): void {
        if (events.length === 0) return;
        const tx = this.db.transaction(() => {
            for (const e of events) {
                this.log(e.eventType, e.entityId, e.entityType, e.data, e.source);
            }
        });
        try { tx(); } catch (e) {
            log.warn('[EventLog] Batch log failed:', String(e));
        }
    }

    // ── Read ───────────────────────────────────────────────────────────────

    getRecent(limit: number = 50): MemoryEvent[] {
        return this.db.prepare(
            'SELECT * FROM memory_events ORDER BY created_at DESC LIMIT ?'
        ).all(limit) as MemoryEvent[];
    }

    getByEntity(entityId: string): MemoryEvent[] {
        return this.db.prepare(
            'SELECT * FROM memory_events WHERE entity_id = ? ORDER BY created_at DESC'
        ).all(entityId) as MemoryEvent[];
    }

    getByType(eventType: MemoryEventType, limit: number = 50): MemoryEvent[] {
        return this.db.prepare(
            'SELECT * FROM memory_events WHERE event_type = ? ORDER BY created_at DESC LIMIT ?'
        ).all(eventType, limit) as MemoryEvent[];
    }

    getSince(isoDate: string, limit: number = 200): MemoryEvent[] {
        return this.db.prepare(
            'SELECT * FROM memory_events WHERE created_at > ? ORDER BY created_at DESC LIMIT ?'
        ).all(isoDate, limit) as MemoryEvent[];
    }

    // ── Maintenance ────────────────────────────────────────────────────────

    /** Remove events older than daysOld. Returns count deleted. */
    pruneOldEvents(daysOld: number = 30): number {
        return this.db.prepare(
            `DELETE FROM memory_events WHERE created_at < datetime('now', '-' || ? || ' days')`
        ).run(daysOld).changes;
    }
}
