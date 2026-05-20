/**
 * DashboardMemoryRepository — acesso SQL tipado para rotas do dashboard.
 *
 * Centraliza todas as queries do dashboard que antes chamavam getDatabase()
 * diretamente (Boundary Leak L1). As rotas usam esta classe; nunca o DB raw.
 */

import type Database from 'better-sqlite3';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface NodePreview {
    id: string;
    type: string;
    name: string;
    content: string;
    updated_at: string;
    [key: string]: unknown;
}

export interface EdgeRow {
    from_node: string;
    to_node: string;
    relation: string;
    weight: number;
    confidence?: number;
    [key: string]: unknown;
}

export interface ConvRow {
    id: string;
    user_id: string;
    provider?: string;
    created_at: string;
    updated_at: string;
}

export interface MsgRow {
    role: string;
    content: string;
    created_at: string;
    conversation_id?: string;
}

export interface MemoryStats {
    totalNodes: number;
    totalEdges: number;
    totalMessages: number;
    totalConversations: number;
    nodesByType: Record<string, number>;
}

export interface NodeAnalytics {
    id: string;
    type: string;
    name: string;
    pagerank: number;
    degree: number;
    betweenness: number;
    closeness: number;
}

export interface ConfigHistoryRow {
    id: string;
    config: Record<string, unknown>;
    created_at: string;
    is_active: number;
}

// ── Repository ─────────────────────────────────────────────────────────────────

export class DashboardMemoryRepository {
    constructor(private readonly db: Database.Database) {}

    // ── Conversations ────────────────────────────────────────────────────────

    listConversationsByUser(userId: string): ConvRow[] {
        return this.db.prepare(
            'SELECT id, user_id, provider, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC'
        ).all(userId) as ConvRow[];
    }

    exportAllConversations(): { conversations: unknown[]; messages: unknown[] } {
        const conversations = this.db.prepare('SELECT * FROM conversations').all();
        const messages = this.db.prepare('SELECT * FROM messages').all();
        return { conversations, messages };
    }

    getMessagesByConversation(convId: string, limit: number): MsgRow[] {
        const rows = this.db.prepare(
            'SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?'
        ).all(convId, limit) as MsgRow[];
        return rows.reverse();
    }

    // ── Nodes ────────────────────────────────────────────────────────────────

    listNodes(type?: string, limit: number = 50): NodePreview[] {
        const cap = Math.min(limit, 200);
        if (type) {
            return this.db.prepare(
                'SELECT id, type, name, substr(content, 1, 200) as content, updated_at FROM memory_nodes WHERE type = ? ORDER BY updated_at DESC LIMIT ?'
            ).all(type, cap) as NodePreview[];
        }
        return this.db.prepare(
            'SELECT id, type, name, substr(content, 1, 200) as content, updated_at FROM memory_nodes ORDER BY updated_at DESC LIMIT ?'
        ).all(cap) as NodePreview[];
    }

    getNodeWithEdges(id: string): { node: NodePreview; edges: EdgeRow[] } | null {
        const node = this.db.prepare('SELECT * FROM memory_nodes WHERE id = ?').get(id) as NodePreview | undefined;
        if (!node) return null;

        this.db.prepare('UPDATE memory_edges SET weight = weight + 0.1 WHERE from_node = ? OR to_node = ?').run(id, id);
        this.db.prepare('UPDATE memory_nodes SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);

        const edges = this.db.prepare(
            'SELECT from_node, to_node, relation, weight FROM memory_edges WHERE from_node = ? OR to_node = ?'
        ).all(id, id) as EdgeRow[];

        return { node, edges };
    }

    createNode(id: string, type: string, name: string, content: string): void {
        this.db.prepare(
            'INSERT OR REPLACE INTO memory_nodes (id, type, name, content, metadata, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)'
        ).run(id, type, name, content, '{}');
    }

    updateNode(id: string, fields: { type?: string; name?: string; content?: string }): boolean {
        const exists = this.db.prepare('SELECT id FROM memory_nodes WHERE id = ?').get(id);
        if (!exists) return false;
        if (fields.type) this.db.prepare('UPDATE memory_nodes SET type = ? WHERE id = ?').run(fields.type, id);
        if (fields.name) this.db.prepare('UPDATE memory_nodes SET name = ? WHERE id = ?').run(fields.name, id);
        if (fields.content !== undefined) this.db.prepare('UPDATE memory_nodes SET content = ? WHERE id = ?').run(fields.content, id);
        this.db.prepare('UPDATE memory_nodes SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
        return true;
    }

    deleteNode(id: string): void {
        try { this.db.prepare('DELETE FROM memory_metrics_history WHERE node_id = ?').run(id); } catch { /* optional table */ }
        try { this.db.prepare('DELETE FROM memory_embeddings WHERE node_id = ?').run(id); } catch { /* optional table */ }
        this.db.prepare('DELETE FROM memory_edges WHERE from_node = ? OR to_node = ?').run(id, id);
        this.db.prepare('DELETE FROM memory_nodes WHERE id = ?').run(id);
    }

    /** FTS or LIKE search on memory_nodes */
    searchNodes(q: string, ids?: string[]): NodePreview[] {
        if (ids && ids.length > 0) {
            const placeholders = ids.map(() => '?').join(',');
            return this.db.prepare(
                `SELECT id, type, name, substr(content, 1, 200) as content, updated_at FROM memory_nodes WHERE id IN (${placeholders})`
            ).all(...ids) as NodePreview[];
        }
        try {
            const ftsResults = this.db.prepare(`
                SELECT n.id, n.type, n.name, substr(n.content, 1, 200) as content, n.updated_at
                FROM memory_nodes_fts f
                JOIN memory_nodes n ON f.rowid = n.rowid
                WHERE memory_nodes_fts MATCH ?
                ORDER BY rank LIMIT 50
            `).all(`${q}*`) as NodePreview[];
            if (ftsResults.length > 0) return ftsResults;
        } catch { /* fall through to LIKE */ }
        return this.db.prepare(
            'SELECT id, type, name, substr(content, 1, 200) as content, updated_at FROM memory_nodes WHERE name LIKE ? OR content LIKE ? ORDER BY updated_at DESC LIMIT 50'
        ).all(`%${q}%`, `%${q}%`) as NodePreview[];
    }

    // ── Edges ────────────────────────────────────────────────────────────────

    createEdge(from: string, to: string, relation: string, weight: number = 1.0): void {
        this.db.prepare(
            'INSERT OR REPLACE INTO memory_edges (from_node, to_node, relation, weight) VALUES (?, ?, ?, ?)'
        ).run(from, to, relation, weight);
    }

    deleteEdge(from: string, to: string, relation: string): void {
        this.db.prepare('DELETE FROM memory_edges WHERE from_node = ? AND to_node = ? AND relation = ?')
            .run(from, to, relation);
    }

    // ── Graph ────────────────────────────────────────────────────────────────

    getGraph(type?: string, limit: number = 200): { nodes: NodePreview[]; edges: EdgeRow[] } {
        const cap = Math.min(limit, 500);
        const nodes: NodePreview[] = type
            ? this.db.prepare('SELECT id, type, name FROM memory_nodes WHERE type = ? ORDER BY updated_at DESC LIMIT ?').all(type, cap) as NodePreview[]
            : this.db.prepare('SELECT id, type, name FROM memory_nodes ORDER BY updated_at DESC LIMIT ?').all(cap) as NodePreview[];

        if (nodes.length === 0) return { nodes: [], edges: [] };

        const nodeIds = nodes.map(n => n.id);
        const ph = nodeIds.map(() => '?').join(',');
        const edges = this.db.prepare(
            `SELECT from_node, to_node, relation, weight FROM memory_edges WHERE from_node IN (${ph}) AND to_node IN (${ph})`
        ).all(...nodeIds, ...nodeIds) as EdgeRow[];

        return { nodes, edges };
    }

    getNodeNeighborhood(nodeId: string, depth: number): { nodes: NodePreview[]; edges: EdgeRow[] } {
        const collected = new Set<string>([nodeId]);
        let frontier = new Set<string>([nodeId]);

        for (let i = 0; i < depth; i++) {
            const fps = Array.from(frontier);
            if (fps.length === 0) break;
            const ph = fps.map(() => '?').join(',');
            const connectedEdges = this.db.prepare(
                `SELECT from_node, to_node FROM memory_edges WHERE from_node IN (${ph}) OR to_node IN (${ph})`
            ).all(...fps, ...fps) as Array<{ from_node: string; to_node: string }>;

            frontier = new Set();
            for (const e of connectedEdges) {
                if (!collected.has(e.from_node)) { collected.add(e.from_node); frontier.add(e.from_node); }
                if (!collected.has(e.to_node)) { collected.add(e.to_node); frontier.add(e.to_node); }
            }
        }

        const ids = Array.from(collected);
        const ph = ids.map(() => '?').join(',');
        const nodes = this.db.prepare(`SELECT id, type, name FROM memory_nodes WHERE id IN (${ph})`).all(...ids) as NodePreview[];
        const edges = this.db.prepare(
            `SELECT from_node, to_node, relation, weight FROM memory_edges WHERE from_node IN (${ph}) AND to_node IN (${ph})`
        ).all(...ids, ...ids) as EdgeRow[];

        return { nodes, edges };
    }

    // ── Stats ────────────────────────────────────────────────────────────────

    getStats(): MemoryStats & { allNodesForCentrality: Array<{ id: string }>; allEdgesForCentrality: Array<{ from_node: string; to_node: string }> } {
        const totalNodes = (this.db.prepare('SELECT COUNT(*) as c FROM memory_nodes').get() as { c: number }).c;
        const totalEdges = (this.db.prepare('SELECT COUNT(*) as c FROM memory_edges').get() as { c: number }).c;
        const totalMessages = (this.db.prepare('SELECT COUNT(*) as c FROM messages').get() as { c: number }).c;
        const totalConversations = (this.db.prepare('SELECT COUNT(*) as c FROM conversations').get() as { c: number }).c;
        const nodesByTypeRows = this.db.prepare('SELECT type, COUNT(*) as c FROM memory_nodes GROUP BY type').all() as Array<{ type: string; c: number }>;
        const nodesByType = Object.fromEntries(nodesByTypeRows.map(r => [r.type, r.c]));

        const allNodesForCentrality = this.db.prepare('SELECT id FROM memory_nodes').all() as Array<{ id: string }>;
        const allEdgesForCentrality = this.db.prepare('SELECT from_node, to_node FROM memory_edges').all() as Array<{ from_node: string; to_node: string }>;

        return { totalNodes, totalEdges, totalMessages, totalConversations, nodesByType, allNodesForCentrality, allEdgesForCentrality };
    }

    /** Fetch all nodes + edges for the memory review computation (done in-route) */
    getReviewData(): { nodes: NodePreview[]; edges: EdgeRow[] } {
        const nodes = this.db.prepare('SELECT id, type, name, content, updated_at FROM memory_nodes ORDER BY updated_at DESC').all() as NodePreview[];
        const edges = this.db.prepare('SELECT from_node, to_node, relation FROM memory_edges').all() as EdgeRow[];
        return { nodes, edges };
    }

    // ── Merge ────────────────────────────────────────────────────────────────

    mergeNodes(keepId: string, mergeId: string): { keepNode: NodePreview; mergeNode: NodePreview } | null {
        const keepNode = this.db.prepare('SELECT * FROM memory_nodes WHERE id = ?').get(keepId) as NodePreview | undefined;
        const mergeNode = this.db.prepare('SELECT * FROM memory_nodes WHERE id = ?').get(mergeId) as NodePreview | undefined;
        if (!keepNode || !mergeNode) return null;

        const lines1 = String(keepNode.content || '').split('\n').map((l: string) => l.trim()).filter(Boolean);
        const lines2 = String(mergeNode.content || '').split('\n').map((l: string) => l.trim()).filter(Boolean);
        const mergedContent = Array.from(new Set([...lines1, ...lines2])).join('\n');
        const mergedName = String(keepNode.name || '').trim() || String(mergeNode.name || '').trim();
        const mergedType = keepNode.type || mergeNode.type;

        this.db.prepare('UPDATE memory_nodes SET name = ?, type = ?, content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(mergedName, mergedType, mergedContent, keepId);

        const relatedEdges = this.db.prepare(
            'SELECT from_node, to_node, relation, weight, confidence FROM memory_edges WHERE from_node = ? OR to_node = ?'
        ).all(mergeId, mergeId) as EdgeRow[];

        for (const edge of relatedEdges) {
            const nextFrom = edge.from_node === mergeId ? keepId : edge.from_node;
            const nextTo = edge.to_node === mergeId ? keepId : edge.to_node;
            if (nextFrom === nextTo) continue;
            this.db.prepare(
                'INSERT OR REPLACE INTO memory_edges (from_node, to_node, relation, weight, confidence) VALUES (?, ?, ?, ?, ?)'
            ).run(nextFrom, nextTo, edge.relation, edge.weight || 1.0, edge.confidence || 1.0);
        }

        try { this.db.prepare('DELETE FROM memory_metrics_history WHERE node_id = ?').run(mergeId); } catch { /* optional */ }
        try { this.db.prepare('DELETE FROM memory_embeddings WHERE node_id = ?').run(mergeId); } catch { /* optional */ }
        this.db.prepare('DELETE FROM memory_edges WHERE from_node = ? OR to_node = ?').run(mergeId, mergeId);
        this.db.prepare('DELETE FROM memory_nodes WHERE id = ?').run(mergeId);

        return { keepNode, mergeNode };
    }

    // ── Analytics ────────────────────────────────────────────────────────────

    getAnalytics(): { nodes: NodeAnalytics[]; totalEdges: number } {
        let nodes: NodeAnalytics[];
        try {
            nodes = this.db.prepare('SELECT id, type, name, pagerank, degree, betweenness, closeness FROM memory_nodes').all() as NodeAnalytics[];
        } catch {
            nodes = this.db.prepare('SELECT id, type, name, 0 as pagerank, 0 as degree, 0 as betweenness, 0 as closeness FROM memory_nodes').all() as NodeAnalytics[];
        }
        const totalEdges = (this.db.prepare('SELECT COUNT(*) as c FROM memory_edges').get() as { c: number }).c;
        return { nodes, totalEdges };
    }

    // ── Config History ───────────────────────────────────────────────────────

    getConfigHistory(): ConfigHistoryRow[] {
        type RawRow = { id: string; config_json: string; created_at: string; is_active: number };
        const rows = this.db.prepare(
            'SELECT id, config_json, created_at, is_active FROM agent_config ORDER BY created_at DESC LIMIT 20'
        ).all() as RawRow[];
        return rows.map(h => ({ id: h.id, config: JSON.parse(h.config_json), created_at: h.created_at, is_active: h.is_active }));
    }

    // ── Skills ───────────────────────────────────────────────────────────────

    listAutoSkills(): unknown[] {
        return this.db.prepare(`
            SELECT id, name, trigger, description, tool_sequence, priority, hits, status,
                   source_pattern, source_tool, reviewed_at, created_at, updated_at
            FROM auto_skills
            ORDER BY
                CASE status WHEN 'active' THEN 0 WHEN 'proposed' THEN 1 ELSE 2 END,
                priority DESC, hits DESC, updated_at DESC
        `).all();
    }

    listSkillPatterns(): unknown[] {
        return this.db.prepare(`
            SELECT pattern, tool_name, success_count, fail_count, avg_latency_ms, last_seen, created_at
            FROM skill_patterns
            ORDER BY success_count DESC, fail_count ASC, avg_latency_ms ASC, last_seen DESC
        `).all();
    }

    approveAutoSkill(id: string): boolean {
        const result = this.db.prepare(`
            UPDATE auto_skills SET status = 'active', reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `).run(id);
        return result.changes > 0;
    }

    rejectAutoSkill(id: string): boolean {
        const result = this.db.prepare(`
            UPDATE auto_skills SET status = 'rejected', reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `).run(id);
        return result.changes > 0;
    }
}
