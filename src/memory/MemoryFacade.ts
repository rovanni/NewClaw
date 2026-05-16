import type Database from 'better-sqlite3';
import type { AttentionFeedback } from './AttentionFeedback';
import type { MemoryManager, MemoryNode } from './MemoryManager';

export type AutoSkillStatus = 'proposed' | 'active' | 'rejected';

export interface AutoSkillSummary {
    id: string;
    name: string;
    status: AutoSkillStatus;
    priority: number;
    source_pattern?: string | null;
    source_tool?: string | null;
    updated_at?: string;
}

export interface SessionCheckpointRecord {
    session_id: string;
    seq: number;
    summary: string;
    original_count: number;
    compressed_at: string;
    model?: string | null;
    token_estimate: number;
}

export interface MemoryFacade {
    listAutoSkills(limit?: number): AutoSkillSummary[];
    findAutoSkillIdBySuffix(suffix: string): string | null;
    setAutoSkillStatus(id: string, status: AutoSkillStatus): boolean;
    ensureConversation(id: string, userId: string, provider: string): boolean;
    ensureSessionCheckpointSchema(): void;
    loadSessionCheckpoints(): SessionCheckpointRecord[];
    saveSessionCheckpoint(record: SessionCheckpointRecord): void;
    getAllNodes(): MemoryNode[];
    addNode(node: MemoryNode, source?: string): void;
    removeNode(nodeId: string): void;
    applyNodeDecay(): void;
    autoScoreNodes(): void;
    listNodesForReconciliation(): MemoryNode[];
    getNodeConnectivity(nodeId: string): number;
    getNodeRecency(nodeId: string): number;
    getTopRelations(nodeId: string, limit: number): string[];
    getAttentionFeedback(): AttentionFeedback | null;
}

export class SqliteMemoryFacade implements MemoryFacade {
    constructor(
        private readonly db: Database.Database,
        private readonly memory: MemoryManager
    ) {}

    listAutoSkills(limit: number = 10): AutoSkillSummary[] {
        return this.db.prepare(
            `SELECT id, name, status, priority, source_pattern, source_tool, updated_at
             FROM auto_skills
             ORDER BY
                CASE status WHEN 'proposed' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
                priority DESC,
                updated_at DESC
             LIMIT ?`
        ).all(limit) as AutoSkillSummary[];
    }

    findAutoSkillIdBySuffix(suffix: string): string | null {
        const rows = this.db.prepare('SELECT id FROM auto_skills').all() as Array<{ id: string }>;
        return rows.find(row => row.id.endsWith(suffix))?.id || null;
    }

    setAutoSkillStatus(id: string, status: AutoSkillStatus): boolean {
        const result = this.db.prepare('UPDATE auto_skills SET status = ? WHERE id = ?').run(status, id);
        return result.changes > 0;
    }

    ensureConversation(id: string, userId: string, provider: string): boolean {
        const existing = this.db.prepare('SELECT id FROM conversations WHERE id = ?').get(id);
        if (existing) return false;
        this.db.prepare('INSERT INTO conversations (id, user_id, provider) VALUES (?, ?, ?)').run(id, userId, provider);
        return true;
    }

    ensureSessionCheckpointSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS session_checkpoints (
                session_id TEXT NOT NULL,
                seq INTEGER NOT NULL,
                summary TEXT NOT NULL,
                original_count INTEGER NOT NULL,
                compressed_at TEXT NOT NULL,
                model TEXT,
                token_estimate REAL,
                PRIMARY KEY (session_id)
            )
        `);

        const columns = this.db.prepare('PRAGMA table_info(session_checkpoints)').all() as Array<{ name: string }>;
        const hasTokenEstimate = columns.some(column => column.name === 'token_estimate');
        if (!hasTokenEstimate) {
            this.db.exec('ALTER TABLE session_checkpoints ADD COLUMN token_estimate INTEGER DEFAULT 0');
        }
    }

    loadSessionCheckpoints(): SessionCheckpointRecord[] {
        this.ensureSessionCheckpointSchema();
        return this.db.prepare('SELECT * FROM session_checkpoints').all() as SessionCheckpointRecord[];
    }

    saveSessionCheckpoint(record: SessionCheckpointRecord): void {
        this.ensureSessionCheckpointSchema();
        this.db.prepare(`
            INSERT OR REPLACE INTO session_checkpoints
            (session_id, seq, summary, original_count, compressed_at, model, token_estimate)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
            record.session_id,
            record.seq,
            record.summary,
            record.original_count,
            record.compressed_at,
            record.model || null,
            record.token_estimate
        );
    }

    getAllNodes(): MemoryNode[] {
        return this.db.prepare('SELECT * FROM memory_nodes').all() as MemoryNode[];
    }

    addNode(node: MemoryNode, source: string = 'unknown'): void {
        this.memory.addNode(node, source);
    }

    removeNode(nodeId: string): void {
        this.db.prepare('DELETE FROM memory_edges WHERE from_node = ? OR to_node = ?').run(nodeId, nodeId);
        this.db.prepare('DELETE FROM memory_nodes WHERE id = ?').run(nodeId);
    }

    applyNodeDecay(): void {
        this.db.prepare(`
            UPDATE memory_nodes
            SET weight = weight * 0.99
            WHERE last_updated < datetime('now', '-1 day')
            AND id NOT LIKE 'core_%'
            AND id NOT IN ('identity', 'agent_state', 'core_user', 'system_reflection')
        `).run();
    }

    autoScoreNodes(): void {
        this.db.prepare("UPDATE memory_nodes SET weight = 1.0, confidence = 1.0 WHERE type = 'identity'").run();
        this.db.prepare("UPDATE memory_nodes SET confidence = 0.85 WHERE type = 'preference' AND confidence < 0.85").run();
    }

    listNodesForReconciliation(): MemoryNode[] {
        const rows = this.db.prepare('SELECT * FROM memory_nodes WHERE type IN ("preference", "fact", "skill")').all() as Array<MemoryNode & { metadata: string }>;
        return rows.map(row => ({
            ...row,
            metadata: JSON.parse(row.metadata || '{}')
        }));
    }

    getNodeConnectivity(nodeId: string): number {
        const result = this.db.prepare(
            'SELECT COUNT(*) as cnt FROM memory_edges WHERE from_node = ? OR to_node = ?'
        ).get(nodeId, nodeId) as { cnt?: number } | undefined;
        return result?.cnt || 0;
    }

    getNodeRecency(nodeId: string): number {
        const result = this.db.prepare(
            'SELECT last_accessed FROM memory_nodes WHERE id = ?'
        ).get(nodeId) as { last_accessed?: string | null } | undefined;

        if (!result?.last_accessed) return 0.3;

        const lastAccess = new Date(result.last_accessed).getTime();
        const hoursSinceAccess = (Date.now() - lastAccess) / (1000 * 60 * 60);
        if (hoursSinceAccess < 1) return 1.0;
        if (hoursSinceAccess < 24) return 0.7;
        if (hoursSinceAccess < 168) return 0.3;
        return 0.1;
    }

    getTopRelations(nodeId: string, limit: number): string[] {
        const edges = this.db.prepare(
            'SELECT to_node, relation FROM memory_edges WHERE from_node = ? ORDER BY weight DESC LIMIT ?'
        ).all(nodeId, limit) as Array<{ to_node: string }>;
        return edges.map(edge => edge.to_node);
    }

    getAttentionFeedback(): AttentionFeedback | null {
        return this.memory.getAttentionFeedback();
    }
}
