/**
 * AttentionLayer — Camada de Atenção e Priorização Cognitiva
 *
 * Transforma a recuperação de informação em um processo contextual,
 * dinâmico e orientado por relevância.
 *
 * attention_score =
 *   (embedding_similarity * w1) +
 *   (context_relevance   * w2) +
 *   (recency             * w3) +
 *   (relation_strength   * w4) +
 *   (domain_priority     * w5)
 */

import { getDomainPriority } from './CognitiveDomains';
import Database from 'better-sqlite3';

// ── Types ──────────────────────────────────────────────────

export interface AttentionWeights {
    w1_embedding: number;
    w2_context: number;
    w3_recency: number;
    w4_relation: number;
    w5_domain: number;
}

export interface AttentionCandidate {
    nodeId: string;
    type: string;
    name: string;
    content: string;
    embeddingScore: number;
    contextRelevance: number;
    recency: number;
    relationStrength: number;
    domainPriority: number;
    attentionScore: number;
}

export interface ContextState {
    id: string;
    activeGoal: string | null;
    currentTask: string | null;
    recentNodeIds: string[];
    recentInteraction: string | null;
    updatedAt: string;
}

// ── Domain Priority Map ────────────────────────────────────

// Type-based fallback when domain column is not set
const TYPE_PRIORITY: Record<string, number> = {
    context_state: 1.0, active_goal: 1.0, current_task: 1.0,
    trait: 0.9, rule: 0.8, strategy: 0.7,
    identity: 0.7, preference: 0.7, knowledge: 0.6,
    project: 0.5, infrastructure: 0.5, skill: 0.5,
    context: 0.4, fact: 0.3, legacy_container: 0.05,
};

// ── Relation Strength Map ──────────────────────────────────

const RELATION_STRENGTH: Record<string, number> = {
    depends_on:       1.0,
    causes:          1.0,
    has_trait:       0.9,
    follows_rule:    0.9,
    enables:         0.8,
    uses_strategy:   0.8,
    owns:            0.8,
    prefers:         0.8,
    works_on:        0.8,
    manages:         0.8,
    refines:         0.6,
    supports:        0.6,
    contains:        0.6,
    belongs_to:      0.6,
    runs_on:         0.6,
    references:      0.4,
    reads:           0.4,
    writes:          0.4,
    related_to:      0.3,
    next:            0.2,
};

// ── AttentionLayer Class ───────────────────────────────────

export class AttentionLayer {
    private db: Database.Database;
    private weights: AttentionWeights;
    private contextState: ContextState | null = null;

    // Max nodes in context window
    private static readonly MAX_CONTEXT_WINDOW = 20;
    // Max hops for context relevance
    private static readonly MAX_HOPS = 2;
    // Context relevance decay per hop
    private static readonly HOP_DECAY: Record<number, number> = {
        0: 1.0,  // directly connected
        1: 0.7,  // 1 hop
        2: 0.4,  // 2 hops
    };

    constructor(db: Database.Database, weights?: Partial<AttentionWeights>) {
        this.db = db;
        this.weights = {
            w1_embedding: 1.0,
            w2_context:   2.0,   // High priority for active context
            w3_recency:   1.5,
            w4_relation:  1.0,
            w5_domain:    0.5,
            ...weights,
        };
        this.initSchema();
        this.loadContextState();
    }

    // ── Schema Initialization ──────────────────────────────

    private initSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS attention_context (
                id TEXT PRIMARY KEY DEFAULT 'active',
                active_goal TEXT,
                current_task TEXT,
                recent_node_ids TEXT DEFAULT '[]',
                recent_interaction TEXT,
                updated_at TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS attention_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                query TEXT NOT NULL,
                context_state TEXT,
                top_node_ids TEXT,
                attention_scores TEXT,
                created_at TEXT DEFAULT (datetime('now'))
            );
        `);
    }

    // ── Context State Management ────────────────────────────

    private loadContextState(): void {
        const row = this.db.prepare(
            'SELECT * FROM attention_context WHERE id = ?'
        ).get('active') as any;

        if (row) {
            this.contextState = {
                id: row.id,
                activeGoal: row.active_goal,
                currentTask: row.current_task,
                recentNodeIds: JSON.parse(row.recent_node_ids || '[]'),
                recentInteraction: row.recent_interaction,
                updatedAt: row.updated_at,
            };
        } else {
            // Create initial context state
            this.db.prepare(`
                INSERT INTO attention_context (id, recent_node_ids) VALUES ('active', '[]')
            `).run();
            this.contextState = {
                id: 'active',
                activeGoal: null,
                currentTask: null,
                recentNodeIds: [],
                recentInteraction: null,
                updatedAt: new Date().toISOString(),
            };
        }
    }

    getContextState(): ContextState | null {
        return this.contextState;
    }

    /**
     * Update the active context state after each interaction.
     * - Add newly relevant nodes
     * - Remove old nodes beyond window limit
     * - Set active goal/task if detected
     */
    updateContext(params: {
        activeGoal?: string | null;
        currentTask?: string | null;
        recentNodeId?: string;
        recentInteraction?: string;
    }): void {
        if (!this.contextState) return;

        // Update goal/task if provided
        if (params.activeGoal !== undefined) {
            this.contextState.activeGoal = params.activeGoal;
        }
        if (params.currentTask !== undefined) {
            this.contextState.currentTask = params.currentTask;
        }
        if (params.recentInteraction !== undefined) {
            this.contextState.recentInteraction = params.recentInteraction;
        }

        // Add recent node and maintain window
        if (params.recentNodeId) {
            // Remove if already exists (move to front)
            this.contextState.recentNodeIds = this.contextState.recentNodeIds.filter(
                id => id !== params.recentNodeId
            );
            this.contextState.recentNodeIds.unshift(params.recentNodeId);

            // Trim to window size
            if (this.contextState.recentNodeIds.length > AttentionLayer.MAX_CONTEXT_WINDOW) {
                this.contextState.recentNodeIds = this.contextState.recentNodeIds.slice(
                    0, AttentionLayer.MAX_CONTEXT_WINDOW
                );
            }
        }

        this.contextState.updatedAt = new Date().toISOString();

        // Persist
        this.db.prepare(`
            UPDATE attention_context SET
                active_goal = ?,
                current_task = ?,
                recent_node_ids = ?,
                recent_interaction = ?,
                updated_at = ?
            WHERE id = 'active'
        `).run(
            this.contextState.activeGoal,
            this.contextState.currentTask,
            JSON.stringify(this.contextState.recentNodeIds),
            this.contextState.recentInteraction,
            this.contextState.updatedAt,
        );
    }

    // ── Attention Score Calculation ─────────────────────────

    /**
     * Calculate context_relevance for a node based on hops from active context.
     *
     * 1.0 → directly in recentNodeIds
     * 0.7 → connected to a recent node (1 hop)
     * 0.4 → connected indirectly (2 hops)
     * 0.0 → no relation to context
     */
    calculateContextRelevance(nodeId: string): number {
        if (!this.contextState) return 0;

        const recentIds = this.contextState.recentNodeIds;

        // Direct hit
        if (recentIds.includes(nodeId)) return 1.0;

        // 1-hop: node connected to any recent node
        for (const recentId of recentIds) {
            const connected = this.db.prepare(`
                SELECT 1 FROM memory_edges
                WHERE (from_node = ? AND to_node = ?)
                   OR (from_node = ? AND to_node = ?)
                LIMIT 1
            `).get(recentId, nodeId, nodeId, recentId);
            if (connected) return 0.7;
        }

        // 2-hop: node connected to a node that's connected to a recent node
        for (const recentId of recentIds) {
            const hop2 = this.db.prepare(`
                SELECT 1 FROM memory_edges e1
                JOIN memory_edges e2 ON (
                    (e1.to_node = e2.from_node AND e2.to_node = ?)
                    OR (e1.to_node = e2.to_node AND e2.from_node = ?)
                )
                WHERE e1.from_node = ?
                LIMIT 1
            `).get(nodeId, nodeId, recentId);
            if (hop2) return 0.4;
        }

        // Also check goal/task connections
        if (this.contextState.activeGoal) {
            const goalNodes = this.db.prepare(`
                SELECT id FROM memory_nodes WHERE name LIKE ? OR content LIKE ? LIMIT 5
            `).all(
                `%${this.contextState.activeGoal}%`,
                `%${this.contextState.activeGoal}%`
            ) as Array<{ id: string }>;

            for (const gn of goalNodes) {
                if (gn.id === nodeId) return 0.8; // Node IS the goal
                const connected = this.db.prepare(`
                    SELECT 1 FROM memory_edges
                    WHERE (from_node = ? AND to_node = ?)
                       OR (from_node = ? AND to_node = ?)
                    LIMIT 1
                `).get(gn.id, nodeId, nodeId, gn.id);
                if (connected) return 0.6;
            }
        }

        return 0.0;
    }

    /**
     * Calculate recency score based on last_accessed timestamp.
     *
     * 1.0 → last 30 minutes
     * 0.8 → last 2 hours
     * 0.5 → last 24 hours
     * 0.2 → last 7 days
     * 0.1 → older
     */
    calculateRecency(nodeId: string): number {
        const node = this.db.prepare(
            'SELECT last_accessed, updated_at FROM memory_nodes WHERE id = ?'
        ).get(nodeId) as any;

        if (!node) return 0.1;

        const timestamp = node.last_accessed || node.updated_at;
        if (!timestamp) return 0.1;

        const now = Date.now();
        const then = new Date(timestamp).getTime();
        const ageMinutes = (now - then) / 60000;

        if (ageMinutes <= 30) return 1.0;
        if (ageMinutes <= 120) return 0.8;
        if (ageMinutes <= 1440) return 0.5;
        if (ageMinutes <= 10080) return 0.2;
        return 0.1;
    }

    /**
     * Calculate average relation strength from context nodes to candidate.
     * Uses the strongest relation found.
     */
    calculateRelationStrength(nodeId: string): number {
        if (!this.contextState) return 0.3;

        let maxStrength = 0;

        // Check relations FROM context nodes TO candidate
        for (const recentId of this.contextState.recentNodeIds) {
            const edges = this.db.prepare(`
                SELECT relation, weight FROM memory_edges
                WHERE from_node = ? AND to_node = ?
                UNION ALL
                SELECT relation, weight FROM memory_edges
                WHERE from_node = ? AND to_node = ?
            `).all(recentId, nodeId, nodeId, recentId) as Array<{ relation: string; weight: number }>;

            for (const edge of edges) {
                const typeStrength = RELATION_STRENGTH[edge.relation] || 0.3;
                const weightFactor = edge.weight || 1.0;
                const combined = typeStrength * weightFactor;
                if (combined > maxStrength) maxStrength = combined;
            }
        }

        return maxStrength || 0.3; // Default weak if no relation
    }

    /**
     * Get domain priority based on node type.
     */
    calculateDomainPriority(nodeId: string): number {
        const node = this.db.prepare('SELECT domain, type FROM memory_nodes WHERE id = ?').get(nodeId) as any;
        if (!node) return 0.3;
        if (node.domain) return getDomainPriority(node.domain);
        return TYPE_PRIORITY[node.type] || 0.3;
    }

    /**
     * Calculate full attention score for a candidate node.
     */
    calculateAttentionScore(params: {
        nodeId: string;
        nodeType: string;
        embeddingScore: number;
    }): AttentionCandidate {
        const node = this.db.prepare(
            'SELECT id, type, name, content FROM memory_nodes WHERE id = ?'
        ).get(params.nodeId) as any;

        const contextRelevance = this.calculateContextRelevance(params.nodeId);
        const recency = this.calculateRecency(params.nodeId);
        const relationStrength = this.calculateRelationStrength(params.nodeId);
        const domainPriority = this.calculateDomainPriority(params.nodeId);

        const attentionScore =
            (params.embeddingScore * this.weights.w1_embedding) +
            (contextRelevance * this.weights.w2_context) +
            (recency * this.weights.w3_recency) +
            (relationStrength * this.weights.w4_relation) +
            (domainPriority * this.weights.w5_domain);

        return {
            nodeId: params.nodeId,
            type: params.nodeType,
            name: node?.name || '',
            content: node?.content || '',
            embeddingScore: params.embeddingScore,
            contextRelevance,
            recency,
            relationStrength,
            domainPriority,
            attentionScore,
        };
    }

    // ── Main Search with Attention ───────────────────────────

    /**
     * Enhanced search using attention layer.
     *
     * Pipeline:
     * 1. Get candidates from embedding search (top-K, wider pool)
     * 2. Expand neighborhood (1-2 hops from context)
     * 3. Calculate attention_score for each candidate
     * 4. Re-rank by attention score
     * 5. Return top results
     */
    searchWithAttention(
        embeddingResults: Array<{ nodeId: string; score: number }>,
        limit: number = 5
    ): AttentionCandidate[] {
        const candidateMap = new Map<string, AttentionCandidate>();

        // Step 1: Process embedding candidates
        for (const result of embeddingResults) {
            const node = this.db.prepare(
                'SELECT type FROM memory_nodes WHERE id = ?'
            ).get(result.nodeId) as any;

            if (!node) continue;

            // Skip legacy containers
            if (node.type === 'legacy_container') continue;

            const candidate = this.calculateAttentionScore({
                nodeId: result.nodeId,
                nodeType: node.type,
                embeddingScore: result.score,
            });
            candidateMap.set(result.nodeId, candidate);
        }

        // Step 2: Expand neighborhood from context
        if (this.contextState) {
            for (const recentId of this.contextState.recentNodeIds) {
                // 1-hop neighbors
                const neighbors = this.db.prepare(`
                    SELECT to_node AS node_id, relation FROM memory_edges WHERE from_node = ?
                    UNION ALL
                    SELECT from_node AS node_id, relation FROM memory_edges WHERE to_node = ?
                `).all(recentId, recentId) as Array<{ node_id: string; relation: string }>;

                for (const neighbor of neighbors) {
                    if (candidateMap.has(neighbor.node_id)) continue;

                    const node = this.db.prepare(
                        'SELECT type FROM memory_nodes WHERE id = ?'
                    ).get(neighbor.node_id) as any;

                    if (!node || node.type === 'legacy_container') continue;

                    // These nodes have no embedding score, but they're contextually relevant
                    const candidate = this.calculateAttentionScore({
                        nodeId: neighbor.node_id,
                        nodeType: node.type,
                        embeddingScore: 0.3, // Low embedding, but may rank high via context
                    });
                    candidateMap.set(neighbor.node_id, candidate);
                }
            }
        }

        // Step 3: Sort by attention score
        const candidates = Array.from(candidateMap.values());
        candidates.sort((a, b) => b.attentionScore - a.attentionScore);

        // Step 4: Return top results
        const results = candidates.slice(0, limit);

        // Step 5: Log search for analytics
        this.logSearch(embeddingResults, results);

        return results;
    }

    // ── Context Node Touch ──────────────────────────────────

    /**
     * Mark a node as recently accessed. Called after every interaction.
     * Updates last_accessed and adds to context window.
     */
    touchNode(nodeId: string): void {
        // Update last_accessed
        this.db.prepare(
            "UPDATE memory_nodes SET last_accessed = datetime('now') WHERE id = ?"
        ).run(nodeId);

        // Add to context window
        this.updateContext({ recentNodeId: nodeId });
    }

    /**
     * Touch multiple nodes at once (after an interaction).
     */
    touchNodes(nodeIds: string[]): void {
        for (const id of nodeIds) {
            this.touchNode(id);
        }
    }

    // ── Logging ─────────────────────────────────────────────

    private logSearch(
        embeddingResults: Array<{ nodeId: string; score: number }>,
        attentionResults: AttentionCandidate[]
    ): void {
        try {
            this.db.prepare(`
                INSERT INTO attention_history (query, context_state, top_node_ids, attention_scores)
                VALUES (?, ?, ?, ?)
            `).run(
                JSON.stringify(embeddingResults.slice(0, 3).map(r => r.nodeId)),
                JSON.stringify(this.contextState?.recentNodeIds.slice(0, 5) || []),
                JSON.stringify(attentionResults.map(r => r.nodeId)),
                JSON.stringify(attentionResults.map(r => ({
                    id: r.nodeId,
                    score: Math.round(r.attentionScore * 100) / 100,
                    emb: Math.round(r.embeddingScore * 100) / 100,
                    ctx: Math.round(r.contextRelevance * 100) / 100,
                    rec: Math.round(r.recency * 100) / 100,
                    rel: Math.round(r.relationStrength * 100) / 100,
                    dom: Math.round(r.domainPriority * 100) / 100,
                }))),
            );
        } catch {
            // Don't fail search if logging fails
        }
    }

    // ── Analytics ───────────────────────────────────────────

    /**
     * Get attention statistics for monitoring.
     */
    getStats(): {
        contextWindowSize: number;
        activeGoal: string | null;
        currentTask: string | null;
        recentInteraction: string | null;
        searchCount: number;
    } {
        let searchCount = 0;
        try {
            searchCount = (this.db.prepare(
                'SELECT COUNT(*) as cnt FROM attention_history'
            ).get() as any)?.cnt || 0;
        } catch { /* table might not exist yet */ }

        return {
            contextWindowSize: this.contextState?.recentNodeIds.length || 0,
            activeGoal: this.contextState?.activeGoal || null,
            currentTask: this.contextState?.currentTask || null,
            recentInteraction: this.contextState?.recentInteraction || null,
            searchCount,
        };
    }

    /**
     * Clear attention history (maintenance).
     */
    clearHistory(): void {
        this.db.prepare('DELETE FROM attention_history').run();
    }
}