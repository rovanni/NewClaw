import { AgentFSMTransition } from './AgentFSM';
import type { MemoryManager } from '../memory/MemoryManager';
import { createLogger } from '../shared/AppLogger';
import { errorMessage } from '../shared/errors';

const log = createLogger('FSMHistoryStore');
const MAX_ROWS = 200;

export class FSMHistoryStore {
    private db: ReturnType<MemoryManager['getDatabase']>;

    constructor(memory: MemoryManager) {
        this.db = memory.getDatabase();
        this.initSchema();
    }

    private initSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS fsm_history (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                trace_id        TEXT,
                conversation_id TEXT,
                from_state      TEXT NOT NULL,
                to_state        TEXT NOT NULL,
                event           TEXT NOT NULL,
                meta            TEXT,
                at              TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_fsm_history_trace ON fsm_history(trace_id);
            CREATE INDEX IF NOT EXISTS idx_fsm_history_conv  ON fsm_history(conversation_id);
        `);
    }

    record(t: AgentFSMTransition, traceId?: string, conversationId?: string): void {
        try {
            this.db.prepare(`
                INSERT INTO fsm_history (trace_id, conversation_id, from_state, to_state, event, meta, at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(
                traceId ?? null,
                conversationId ?? null,
                t.from,
                t.to,
                t.event,
                t.meta ? JSON.stringify(t.meta) : null,
                t.at
            );
            // Keep only the last MAX_ROWS rows globally
            this.db.prepare(
                `DELETE FROM fsm_history WHERE id <= (SELECT MAX(id) - ${MAX_ROWS} FROM fsm_history)`
            ).run();
        } catch (err) {
            log.warn('SQLITE_WRITE_DROPPED',
                `[FSM] table=fsm_history operation=INSERT` +
                ` from_state=${t.from} to_state=${t.to} event=${t.event}` +
                ` trace_id=${traceId ?? 'none'} conv_id=${conversationId ?? 'none'}` +
                ` error=${errorMessage(err)}`
            );
        }
    }

    getRecent(limit = 50, conversationId?: string): AgentFSMTransition[] {
        const rows = (conversationId
            ? this.db.prepare(
                `SELECT * FROM fsm_history WHERE conversation_id = ? ORDER BY id DESC LIMIT ?`
              ).all(conversationId, limit)
            : this.db.prepare(
                `SELECT * FROM fsm_history ORDER BY id DESC LIMIT ?`
              ).all(limit)) as Array<{
                from_state: string; to_state: string; event: string; at: string; meta: string | null;
              }>;

        return rows.reverse().map(r => ({
            from: r.from_state as AgentFSMTransition['from'],
            to: r.to_state as AgentFSMTransition['to'],
            event: r.event as AgentFSMTransition['event'],
            at: r.at,
            meta: r.meta ? JSON.parse(r.meta) : undefined
        }));
    }
}
