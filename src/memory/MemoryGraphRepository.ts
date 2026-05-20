/**
 * MemoryGraphRepository — acesso SQL tipado ao grafo cognitivo.
 *
 * Centraliza todas as queries de baixo nível usadas por:
 *   MemoryCurator, GraphAnalytics, memory_admin tool.
 *
 * Exposto via MemoryManager.getGraphRepository() — nunca instanciado diretamente.
 */

import type Database from 'better-sqlite3';

// ── Shared types ──────────────────────────────────────────────────────────────

export interface BasicNode {
    id: string;
    type: string;
    name: string;
    domain?: string | null;
    content?: string;
    weight?: number;
    confidence?: number;
    metadata?: string;
    len?: number;
    degree?: number;
    pagerank?: number;
}

export interface BasicEdge {
    from_node: string;
    to_node: string;
    relation: string;
    weight: number;
}

export interface GraphStats {
    nodeCount: number;
    edgeCount: number;
    embeddingCount: number;
    orphanCount: number;
    ghostCount: number;
    typeBreakdown: Array<{ type: string; c: number }>;
    domainBreakdown: Array<{ domain: string | null; c: number }>;
}

export interface CleanupResult {
    deletedNodes: number;
    deletedEdges: number;
    deletedEmbeddings: number;
    deletedMetrics: number;
    removedIds: string[];
}

export interface NodeCentralityUpdate {
    id: string;
    pagerank: number;
    degree: number;
    betweenness: number;
    closeness: number;
}

export interface InspectResult {
    node: BasicNode;
    outEdges: Array<{ to_node: string; relation: string; weight: number }>;
    inEdges: Array<{ from_node: string; relation: string; weight: number }>;
    embedding: { model: string; updated_at: string } | null;
}

// ── MemoryGraphRepository ─────────────────────────────────────────────────────

export class MemoryGraphRepository {
    constructor(private readonly db: Database.Database) {}

    // ── Node reads ────────────────────────────────────────────────────────────

    getAllNodes(): BasicNode[] {
        return this.db.prepare('SELECT id, type, name, domain FROM memory_nodes').all() as BasicNode[];
    }

    getAllNodeIds(): string[] {
        return (this.db.prepare('SELECT id FROM memory_nodes').all() as Array<{ id: string }>)
            .map(r => r.id);
    }

    getIdentityNodes(): Array<{ id: string; name: string; content: string }> {
        return this.db.prepare(
            `SELECT id, name, content FROM memory_nodes WHERE type = 'identity'`
        ).all() as Array<{ id: string; name: string; content: string }>;
    }

    getUnconnectedIdentityNodes(): Array<{ id: string }> {
        return this.db.prepare(`
            SELECT n.id FROM memory_nodes n
            LEFT JOIN memory_edges e ON n.id = e.to_node AND e.from_node = 'core_user'
            WHERE n.type = 'identity'
              AND n.id NOT IN ('core_user', 'core_agent', 'core_identity')
              AND e.from_node IS NULL
        `).all() as Array<{ id: string }>;
    }

    getNodesForReindex(id?: string): Array<{ id: string; name: string; content: string }> {
        if (id) {
            return this.db.prepare(
                'SELECT id, name, content FROM memory_nodes WHERE id = ?'
            ).all(id) as Array<{ id: string; name: string; content: string }>;
        }
        return this.db.prepare(
            'SELECT id, name, content FROM memory_nodes'
        ).all() as Array<{ id: string; name: string; content: string }>;
    }

    // ── Edge reads ────────────────────────────────────────────────────────────

    getAllEdges(): BasicEdge[] {
        return this.db.prepare(
            'SELECT from_node, to_node, relation, weight FROM memory_edges'
        ).all() as BasicEdge[];
    }

    getAllEdgesWeighted(): Array<{ from_node: string; to_node: string; weight: number }> {
        return this.db.prepare(
            'SELECT from_node, to_node, weight FROM memory_edges'
        ).all() as Array<{ from_node: string; to_node: string; weight: number }>;
    }

    // ── Graph stats ───────────────────────────────────────────────────────────

    getGraphStats(): GraphStats {
        const nodeCount = (this.db.prepare(
            'SELECT COUNT(*) as c FROM memory_nodes'
        ).get() as { c: number }).c;

        const edgeCount = (this.db.prepare(
            'SELECT COUNT(*) as c FROM memory_edges'
        ).get() as { c: number }).c;

        const embeddingCount = (this.db.prepare(
            'SELECT COUNT(*) as c FROM memory_embeddings'
        ).get() as { c: number }).c;

        const orphanCount = (this.db.prepare(`
            SELECT COUNT(*) as c FROM memory_nodes n
            WHERE n.id NOT IN (SELECT from_node FROM memory_edges)
              AND n.id NOT IN (SELECT to_node FROM memory_edges)
        `).get() as { c: number }).c;

        const ghostCount = (this.db.prepare(`
            SELECT COUNT(*) as c FROM memory_nodes
            WHERE (length(content) < 30 AND id NOT LIKE 'memory_%' AND type != 'context')
               OR (content LIKE '%.md' AND length(content) < 50)
        `).get() as { c: number }).c;

        const typeBreakdown = this.db.prepare(
            'SELECT type, COUNT(*) as c FROM memory_nodes GROUP BY type ORDER BY c DESC'
        ).all() as Array<{ type: string; c: number }>;

        const domainBreakdown = this.db.prepare(
            'SELECT domain, COUNT(*) as c FROM memory_nodes GROUP BY domain ORDER BY c DESC'
        ).all() as Array<{ domain: string | null; c: number }>;

        return { nodeCount, edgeCount, embeddingCount, orphanCount, ghostCount, typeBreakdown, domainBreakdown };
    }

    getDomainStats(): { domains: Array<{ domain: string | null; c: number }>; types: Array<{ type: string; c: number }> } {
        const domains = this.db.prepare(
            'SELECT domain, COUNT(*) as c FROM memory_nodes GROUP BY domain ORDER BY c DESC'
        ).all() as Array<{ domain: string | null; c: number }>;
        const types = this.db.prepare(
            'SELECT type, COUNT(*) as c FROM memory_nodes GROUP BY type ORDER BY c DESC'
        ).all() as Array<{ type: string; c: number }>;
        return { domains, types };
    }

    // ── Admin queries ─────────────────────────────────────────────────────────

    listNodesByFilter(filter: string, limit: number): BasicNode[] {
        if (!filter) {
            return this.db.prepare(
                'SELECT id, type, domain, name, length(content) as len FROM memory_nodes ORDER BY domain, id LIMIT ?'
            ).all(limit) as BasicNode[];
        }
        const byType = this.db.prepare(
            'SELECT id, type, domain, name, length(content) as len FROM memory_nodes WHERE type = ? ORDER BY domain, id LIMIT ?'
        ).all(filter, limit) as BasicNode[];
        if (byType.length > 0) return byType;

        const byDomain = this.db.prepare(
            'SELECT id, type, domain, name, length(content) as len FROM memory_nodes WHERE domain = ? ORDER BY id LIMIT ?'
        ).all(filter, limit) as BasicNode[];
        if (byDomain.length > 0) return byDomain;

        return this.db.prepare(
            "SELECT id, type, domain, name, length(content) as len FROM memory_nodes WHERE name LIKE ? OR content LIKE ? ORDER BY id LIMIT ?"
        ).all(`%${filter}%`, `%${filter}%`, limit) as BasicNode[];
    }

    getOrphanNodes(): BasicNode[] {
        return this.db.prepare(`
            SELECT id, type, domain, name, length(content) as len FROM memory_nodes n
            WHERE n.id NOT IN (SELECT from_node FROM memory_edges)
              AND n.id NOT IN (SELECT to_node FROM memory_edges)
        `).all() as BasicNode[];
    }

    getDuplicateNodes(limit: number = 30): Array<{
        id1: string; id2: string; name1: string; name2: string;
        type1: string; type2: string; domain1?: string | null
    }> {
        return this.db.prepare(`
            SELECT a.id as id1, b.id as id2, a.name as name1, b.name as name2,
                   a.type as type1, b.type as type2, a.domain as domain1
            FROM memory_nodes a
            JOIN memory_nodes b ON a.id < b.id
                AND (LOWER(a.name) = LOWER(b.name) OR LOWER(a.name) LIKE '%' || LOWER(b.name) || '%')
            ORDER BY a.domain, a.name
            LIMIT ?
        `).all(limit) as Array<{
            id1: string; id2: string; name1: string; name2: string;
            type1: string; type2: string; domain1?: string | null
        }>;
    }

    getGhostNodes(): BasicNode[] {
        return this.db.prepare(`
            SELECT id, type, domain, name, content FROM memory_nodes
            WHERE (length(content) < 30 AND id NOT LIKE 'memory_%' AND type != 'context')
               OR (content LIKE '%.md' AND length(content) < 50 AND id NOT LIKE 'memory_%')
            ORDER BY domain, id
        `).all() as BasicNode[];
    }

    inspectNode(id: string): InspectResult | null {
        const node = this.db.prepare('SELECT * FROM memory_nodes WHERE id = ?').get(id) as BasicNode | undefined;
        if (!node) return null;
        const outEdges = this.db.prepare(
            'SELECT to_node, relation, weight FROM memory_edges WHERE from_node = ?'
        ).all(id) as Array<{ to_node: string; relation: string; weight: number }>;
        const inEdges = this.db.prepare(
            'SELECT from_node, relation, weight FROM memory_edges WHERE to_node = ?'
        ).all(id) as Array<{ from_node: string; relation: string; weight: number }>;
        const embedding = this.db.prepare(
            'SELECT model, updated_at FROM memory_embeddings WHERE node_id = ?'
        ).get(id) as { model: string; updated_at: string } | null;
        return { node, outEdges, inEdges, embedding: embedding ?? null };
    }

    // ── Write / cleanup ───────────────────────────────────────────────────────

    updateNodeWeightAndMeta(id: string, weight: number, confidence: number): void {
        this.db.prepare(`
            UPDATE memory_nodes
            SET weight = ?,
                confidence = ?,
                metadata = json_insert(COALESCE(metadata, '{}'), '$.invalid', true, '$.reason', 'unstructured_identity')
            WHERE id = ?
        `).run(weight, confidence, id);
    }

    cleanupGhostsAndOrphans(): CleanupResult {
        const ghosts = this.db.prepare(`
            SELECT id FROM memory_nodes
            WHERE length(content) < 10
               OR (content LIKE '%.md' AND length(content) < 50 AND id NOT LIKE 'memory_%')
        `).all() as Array<{ id: string }>;

        const orphanGhosts = this.db.prepare(`
            SELECT n.id FROM memory_nodes n
            WHERE n.id NOT IN (SELECT from_node FROM memory_edges)
              AND n.id NOT IN (SELECT to_node FROM memory_edges)
              AND (length(n.content) < 30 OR (n.content LIKE '%.md' AND length(n.content) < 50))
        `).all() as Array<{ id: string }>;

        const toRemove = [...new Set([...ghosts.map(g => g.id), ...orphanGhosts.map(o => o.id)])];
        const safeToRemove = toRemove.filter(nodeId => {
            const node = this.db.prepare(
                'SELECT type FROM memory_nodes WHERE id = ?'
            ).get(nodeId) as { type: string } | undefined;
            return node &&
                node.type !== 'identity' &&
                !nodeId.startsWith('core:') &&
                !nodeId.startsWith('core_') &&
                !nodeId.startsWith('pref_');
        });

        if (safeToRemove.length === 0) {
            return { deletedNodes: 0, deletedEdges: 0, deletedEmbeddings: 0, deletedMetrics: 0, removedIds: [] };
        }

        const ph = safeToRemove.map(() => '?').join(',');
        const deletedEdges = this.db.prepare(
            `DELETE FROM memory_edges WHERE from_node IN (${ph}) OR to_node IN (${ph})`
        ).run(...safeToRemove, ...safeToRemove).changes;
        const deletedEmbeddings = this.db.prepare(
            `DELETE FROM memory_embeddings WHERE node_id IN (${ph})`
        ).run(...safeToRemove).changes;
        const deletedMetrics = this.db.prepare(
            `DELETE FROM node_metrics WHERE node_id IN (${ph})`
        ).run(...safeToRemove).changes;
        const deletedNodes = this.db.prepare(
            `DELETE FROM memory_nodes WHERE id IN (${ph})`
        ).run(...safeToRemove).changes;

        return { deletedNodes, deletedEdges, deletedEmbeddings, deletedMetrics, removedIds: safeToRemove };
    }

    recalcDegreeAndPagerank(): number {
        const { c: nodeCount } = this.db.prepare(
            'SELECT COUNT(*) as c FROM memory_nodes'
        ).get() as { c: number };

        const degrees = this.db.prepare(`
            SELECT n.id, COUNT(DISTINCT e.from_node) + COUNT(DISTINCT e2.to_node) as degree
            FROM memory_nodes n
            LEFT JOIN memory_edges e ON n.id = e.from_node
            LEFT JOIN memory_edges e2 ON n.id = e2.to_node
            GROUP BY n.id
        `).all() as Array<{ id: string; degree: number }>;

        const stmt = this.db.prepare(
            'UPDATE memory_nodes SET degree = ?, pagerank = ? WHERE id = ?'
        );
        const tx = this.db.transaction((rows: Array<{ id: string; degree: number }>) => {
            for (const row of rows) {
                stmt.run(row.degree, Math.min(row.degree / nodeCount, 1.0), row.id);
            }
        });
        tx(degrees);
        return degrees.length;
    }

    // ── Edge operations ───────────────────────────────────────────────────────

    deleteSelfLoops(): void {
        this.db.prepare('DELETE FROM memory_edges WHERE from_node = to_node').run();
    }

    deleteDuplicateDailySystemEdges(): void {
        this.db.prepare(
            `DELETE FROM memory_edges WHERE from_node = 'ctx_system_memory' AND to_node GLOB 'memory_[0-9][0-9][0-9][0-9]-*'`
        ).run();
    }

    ensureEdgeLastAccessed(): void {
        try { this.db.exec('ALTER TABLE memory_edges ADD COLUMN last_accessed TEXT'); } catch { /* exists */ }
        this.db.prepare(
            `UPDATE memory_edges SET last_accessed = CURRENT_TIMESTAMP WHERE last_accessed IS NULL`
        ).run();
    }

    decayOldEdges(daysOld: number = 30, factor: number = 0.98, minWeight: number = 0.1): number {
        return this.db.prepare(`
            UPDATE memory_edges
            SET weight = MAX(weight * ?, ?)
            WHERE last_accessed < datetime('now', '-' || ? || ' days')
              AND weight > ?
        `).run(factor, minWeight, daysOld, minWeight).changes;
    }

    /**
     * Sparse Graph Strategy — remove arestas fracas que adicionam ruído ao retrieval.
     *
     * Dois passos:
     *   1. Deletar arestas com weight < minWeight E confidence < minConfidence E inativas há daysInactive+ dias
     *   2. Limitar grau de saída por nó a maxDegreePerNode — preserva as mais fortes
     *
     * Relações estruturais NUNCA são podadas (contains, next, summarizes, has_identity, has_domain, groups).
     */
    pruneWeakEdges(opts?: {
        minWeight?: number;
        minConfidence?: number;
        daysInactive?: number;
        maxDegreePerNode?: number;
    }): { prunedWeak: number; prunedOverflow: number } {
        const minWeight       = opts?.minWeight       ?? 0.15;
        const minConfidence   = opts?.minConfidence   ?? 0.30;
        const daysInactive    = opts?.daysInactive    ?? 30;
        const maxDegreePerNode = opts?.maxDegreePerNode ?? 25;

        // These relations are load-bearing — never prune them regardless of weight.
        const protected_ = `('contains','next','summarizes','has_identity','has_domain','groups','occurred_in')`;

        // Step 1: weak + stale edges — both weight AND confidence must be below threshold
        const prunedWeak = this.db.prepare(`
            DELETE FROM memory_edges
            WHERE weight < ?
              AND (confidence IS NULL OR confidence < ?)
              AND last_accessed < datetime('now', '-' || ? || ' days')
              AND relation NOT IN ${protected_}
        `).run(minWeight, minConfidence, daysInactive).changes;

        // Step 2: max-degree enforcement — keep top N outgoing edges by weight per node
        const highDegreeNodes = this.db.prepare(`
            SELECT from_node
            FROM memory_edges
            WHERE relation NOT IN ${protected_}
            GROUP BY from_node
            HAVING COUNT(*) > ?
        `).all(maxDegreePerNode) as Array<{ from_node: string }>;

        let prunedOverflow = 0;
        if (highDegreeNodes.length > 0) {
            const edgesStmt = this.db.prepare(`
                SELECT from_node, to_node, relation
                FROM memory_edges
                WHERE from_node = ? AND relation NOT IN ${protected_}
                ORDER BY weight ASC
            `);
            const deleteStmt = this.db.prepare(
                'DELETE FROM memory_edges WHERE from_node = ? AND to_node = ? AND relation = ?'
            );
            const pruneTx = this.db.transaction((nodes: Array<{ from_node: string }>) => {
                for (const { from_node } of nodes) {
                    const edges = edgesStmt.all(from_node) as Array<{ from_node: string; to_node: string; relation: string }>;
                    const toDelete = edges.length - maxDegreePerNode;
                    for (let i = 0; i < toDelete; i++) {
                        deleteStmt.run(edges[i].from_node, edges[i].to_node, edges[i].relation);
                        prunedOverflow++;
                    }
                }
            });
            pruneTx(highDegreeNodes);
        }

        return { prunedWeak, prunedOverflow };
    }

    // ── Storage quotas ────────────────────────────────────────────────────────

    pruneOldTraces(daysOld: number = 3): number {
        try {
            return this.db.prepare(
                `DELETE FROM agent_traces WHERE created_at < datetime('now', '-' || ? || ' days')`
            ).run(daysOld).changes;
        } catch { return 0; }
    }

    getConversationIds(): string[] {
        try {
            return (this.db.prepare(
                'SELECT DISTINCT conversation_id FROM messages'
            ).all() as Array<{ conversation_id: string }>).map(r => r.conversation_id);
        } catch { return []; }
    }

    pruneOldMessagesForConversation(conversationId: string, keepLast: number = 1000): number {
        try {
            return this.db.prepare(`
                DELETE FROM messages
                WHERE conversation_id = ?
                AND id NOT IN (
                    SELECT id FROM messages
                    WHERE conversation_id = ?
                    ORDER BY created_at DESC
                    LIMIT ?
                )
            `).run(conversationId, conversationId, keepLast).changes;
        } catch { return 0; }
    }

    // ── Analytics ─────────────────────────────────────────────────────────────

    bulkUpdateNodeCentrality(updates: NodeCentralityUpdate[]): void {
        const stmt = this.db.prepare(`
            UPDATE memory_nodes
            SET pagerank = ?, degree = ?, betweenness = ?, closeness = ?
            WHERE id = ?
        `);
        const tx = this.db.transaction((rows: NodeCentralityUpdate[]) => {
            for (const u of rows) {
                stmt.run(
                    Number(u.pagerank.toFixed(6)),
                    u.degree,
                    Number(u.betweenness.toFixed(6)),
                    Number(u.closeness.toFixed(6)),
                    u.id
                );
            }
        });
        tx(updates);
    }

    ensureNodeMetricsTable(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS node_metrics (
                node_id TEXT PRIMARY KEY,
                usage_count INTEGER DEFAULT 0,
                last_accessed_at DATETIME,
                reinforcement_score REAL DEFAULT 0.0,
                memory_class TEXT DEFAULT 'latent',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
    }

    backfillNodeMetrics(): void {
        try {
            this.db.prepare(`
                INSERT OR IGNORE INTO node_metrics (node_id, usage_count, last_accessed_at, reinforcement_score, memory_class)
                SELECT id, 0, CURRENT_TIMESTAMP, 0.0, 'latent' FROM memory_nodes
            `).run();
        } catch { /* table might not exist */ }
    }

    bulkUpdateNodeMetricsClass(nodeIds: string[], degreeMap: Record<string, number>): void {
        const stmt = this.db.prepare(`
            UPDATE node_metrics
            SET memory_class = CASE
                WHEN ? >= 5 THEN 'core'
                WHEN ? >= 2 THEN 'active'
                ELSE 'latent'
                END,
                updated_at = CURRENT_TIMESTAMP
            WHERE node_id = ?
        `);
        const tx = this.db.transaction((ids: string[]) => {
            for (const id of ids) {
                const d = degreeMap[id] || 0;
                stmt.run(d, d, id);
            }
        });
        tx(nodeIds);
    }

    addColumnIfNotExists(table: string, column: string, definition: string): void {
        try { this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`); } catch { /* exists */ }
    }

    updateNodeCommunityIds(assignments: Map<string, number>): void {
        const stmt = this.db.prepare('UPDATE memory_nodes SET community_id = ? WHERE id = ?');
        const tx = this.db.transaction((map: Map<string, number>) => {
            for (const [nodeId, cId] of map) {
                stmt.run(cId, nodeId);
            }
        });
        tx(assignments);
    }

    // ── Embedding ─────────────────────────────────────────────────────────────

    upsertEmbedding(nodeId: string, embedding: Buffer, model: string): void {
        this.db.prepare(
            'INSERT OR REPLACE INTO memory_embeddings (node_id, embedding, model, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)'
        ).run(nodeId, embedding, model);
    }

    // ── Maintenance ───────────────────────────────────────────────────────────

    vacuum(): void {
        this.db.exec('VACUUM');
    }

    // ── Retry wrapper (usado por GraphAnalytics) ──────────────────────────────

    async withRetry<T>(fn: () => T, maxRetries: number = 3, baseDelayMs: number = 500): Promise<T> {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return fn();
            } catch (error) {
                if (attempt === maxRetries) throw error;
                const msg = error instanceof Error ? error.message : String(error);
                if (msg.includes('malformed') || msg.includes('SQLITE_CORRUPT') || msg.includes('locked')) {
                    await new Promise(resolve => setTimeout(resolve, baseDelayMs * attempt));
                } else {
                    throw error;
                }
            }
        }
        throw new Error('withRetry: unreachable');
    }
}
