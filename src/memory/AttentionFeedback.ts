/**
 * AttentionFeedback — Feedback Cognitivo com Estabilidade
 *
 * Transforma o grafo em memória viva, adaptativa e auto-organizável.
 *
 * v2: Controle de saturação, validação de co-usage, anti-dominância,
 *     diversidade cognitiva, decaimento estrutural e monitoramento.
 *
 * Mecanismos:
 * 1. Registro de uso com saturação logarítmica
 * 2. Validação de co-usage (similaridade semântica mínima)
 * 3. Decaimento estrutural de arestas (preserva relações críticas)
 * 4. Anti-dominância (limite de impacto no attention_score)
 * 5. Diversidade cognitiva nos resultados
 * 6. Monitoramento com métricas e detecção de anomalias
 * 7. Reforço cognitivo de co-uso validado
 * 8. Classificação dinâmica (ativa/longo prazo/latente)
 * 9. Normalização periódica
 * 10. Execução em background
 */

import Database from 'better-sqlite3';
import { createLogger } from '../shared/AppLogger';
const log = createLogger('Attentionfeedback');

// ── Constants ──────────────────────────────────────────────

// Reinforcement
const REINFORCEMENT_BASE = 0.1;      // Base increment
const MAX_REINFORCEMENT = 5.0;         // Hard cap
const SATURATION_K = 0.3;              // Saturation factor (logarithmic)
const MIN_REINFORCEMENT = 0.0;

// Edge reinforcement
const EDGE_REINFORCEMENT = 0.05;       // Base edge increment
const MAX_EDGE_WEIGHT = 3.0;           // Edge weight cap
const MIN_EDGE_WEIGHT = 0.1;           // Below this, edge is removed
const CO_USAGE_SIMILARITY_THRESHOLD = 0.3; // Min similarity for co-usage

// Decay
const DECAY_RATE = 0.02;              // Per day without use
const EDGE_DECAY_RATE = 0.03;          // Per 7 days without access
const CRITICAL_RELATIONS = ['depends_on', 'causes', 'has_trait', 'follows_rule']; // Never decay

// Anti-dominance
const MAX_REINFORCEMENT_IMPACT = 2.5;  // Max contribution to attention_score
const DIVERSITY_MIN_DIFFERENT_DOMAINS = 2; // At least N domains in results

// Classification
const ACTIVE_THRESHOLD = 2.0;
const LONGTERM_THRESHOLD = 0.5;

// Anomaly detection
const CONCENTRATION_THRESHOLD = 0.4;   // If top 3 nodes > 40% of all usage
const MIN_EDGE_DENSITY = 0.01;         // Min edges per node ratio

// Background jobs
const NORMALIZATION_INTERVAL = 30 * 60 * 1000;  // 30 minutes
const DECAY_INTERVAL = 60 * 60 * 1000;           // 1 hour
const MONITORING_INTERVAL = 5 * 60 * 1000;       // 5 minutes

// ── Types ──────────────────────────────────────────────────

export type MemoryClass = 'active' | 'longterm' | 'latent';

export interface NodeMetrics {
    node_id: string;
    usage_count: number;
    last_accessed_at: string | null;
    reinforcement_score: number;
    memory_class: MemoryClass;
}

export interface FeedbackStats {
    totalNodes: number;
    activeNodes: number;
    longtermNodes: number;
    latentNodes: number;
    avgReinforcement: number;
    maxReinforcement: number;
    edgesReinforced: number;
    lastDecay: string | null;
    lastNormalization: string | null;
    concentrationIndex: number;
    edgeDensity: number;
    anomaliesDetected: number;
}

export interface AnomalyReport {
    type: 'concentration' | 'orphan' | 'sparse_edge' | 'reinforcement_burst';
    details: string;
    severity: 'low' | 'medium' | 'high';
    timestamp: string;
}

// ── AttentionFeedback Class ─────────────────────────────────

export class AttentionFeedback {
    private db: Database.Database;
    private decayTimer: ReturnType<typeof setInterval> | null = null;
    private normTimer: ReturnType<typeof setInterval> | null = null;
    private monitorTimer: ReturnType<typeof setInterval> | null = null;
    private embeddingCache: Map<string, Float64Array> = new Map();

    constructor(db: Database.Database) {
        this.db = db;
        this.initSchema();
        this.startBackgroundJobs();
    }

    // ── Schema ─────────────────────────────────────────────

    private initSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS node_metrics (
                node_id TEXT PRIMARY KEY,
                usage_count INTEGER DEFAULT 0,
                last_accessed_at DATETIME,
                reinforcement_score REAL DEFAULT 0.0,
                memory_class TEXT DEFAULT 'latent',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_node_metrics_class ON node_metrics(memory_class);
            CREATE INDEX IF NOT EXISTS idx_node_metrics_score ON node_metrics(reinforcement_score);

            CREATE TABLE IF NOT EXISTS co_usage_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                node_a TEXT NOT NULL,
                node_b TEXT NOT NULL,
                similarity REAL,
                validated INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_co_usage_validated ON co_usage_log(validated);

            CREATE TABLE IF NOT EXISTS feedback_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                node_id TEXT NOT NULL,
                action TEXT NOT NULL,
                details TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS feedback_state (
                id TEXT PRIMARY KEY DEFAULT 'main',
                last_decay_at DATETIME,
                last_normalization_at DATETIME,
                last_monitoring_at DATETIME,
                total_reinforcements INTEGER DEFAULT 0,
                total_decays INTEGER DEFAULT 0,
                anomalies_detected INTEGER DEFAULT 0,
                edge_removals INTEGER DEFAULT 0
            );

            INSERT OR IGNORE INTO feedback_state (id) VALUES ('main');
        `);
    }

    // ── 1. Registro de Uso com Saturação Logarítmica ────────

    /**
     * Record node usage with logarithmic saturation.
     * The more a node is used, the smaller the increment.
     * Formula: increment = base / (1 + saturation_k * ln(1 + usage_count))
     */
    recordUsage(nodeId: string): void {
        this.db.prepare(`
            INSERT OR IGNORE INTO node_metrics (node_id, usage_count, last_accessed_at, reinforcement_score)
            VALUES (?, 0, datetime('now'), 0.0)
        `).run(nodeId);

        // Saturating increment: logarithmic decay of gain
        const current = this.db.prepare(
            'SELECT usage_count, reinforcement_score FROM node_metrics WHERE node_id = ?'
        ).get(nodeId) as any;

        if (!current) return;

        const usageCount = current.usage_count || 0;
        const saturatedIncrement = REINFORCEMENT_BASE / (1 + SATURATION_K * Math.log(1 + usageCount));
        const newScore = Math.min(MAX_REINFORCEMENT, current.reinforcement_score + saturatedIncrement);

        this.db.prepare(`
            UPDATE node_metrics SET
                usage_count = usage_count + 1,
                last_accessed_at = datetime('now'),
                reinforcement_score = ?,
                updated_at = datetime('now')
            WHERE node_id = ?
        `).run(newScore, nodeId);

        this.classifyNode(nodeId);

        // Also update last_accessed in memory_nodes
        this.db.prepare(`
            UPDATE memory_nodes SET last_accessed = datetime('now') WHERE id = ?
        `).run(nodeId);

        // Update state
        this.db.prepare(`
            UPDATE feedback_state SET total_reinforcements = total_reinforcements + 1
            WHERE id = 'main'
        `).run();
    }

    // ── 2. Validação de Co-Usage ────────────────────────────

    /**
     * Validate that two nodes should be connected.
     * Only reinforce if:
     * 1. There's a pre-existing edge between them, OR
     * 2. Their semantic similarity is above threshold
     */
    private validateCoUsage(nodeA: string, nodeB: string): boolean {
        // Check pre-existing edge
        const existingEdge = this.db.prepare(`
            SELECT 1 FROM memory_edges
            WHERE (from_node = ? AND to_node = ?) OR (from_node = ? AND to_node = ?)
            LIMIT 1
        `).get(nodeA, nodeB, nodeB, nodeA);

        if (existingEdge) return true; // Pre-existing edge = always valid

        // Check semantic similarity via embeddings
        const similarity = this.getEmbeddingSimilarity(nodeA, nodeB);
        if (similarity >= CO_USAGE_SIMILARITY_THRESHOLD) return true;

        // Check if they share a common neighbor (2-hop)
        const common = this.db.prepare(`
            SELECT COUNT(*) as cnt FROM memory_edges e1
            JOIN memory_edges e2 ON e1.to_node = e2.from_node
            WHERE e1.from_node = ? AND e2.to_node = ?
               OR (e1.from_node = ? AND e2.to_node = ?)
            LIMIT 1
        `).get(nodeA, nodeB, nodeB, nodeA) as any;

        return common && common.cnt > 0;
    }

    /**
     * Get embedding similarity between two nodes.
     * Uses cached embeddings for efficiency.
     */
    private getEmbeddingSimilarity(nodeA: string, nodeB: string): number {
        const embA = this.getEmbedding(nodeA);
        const embB = this.getEmbedding(nodeB);

        if (!embA || !embB) return 0;

        let dot = 0, normA = 0, normB = 0;
        const len = Math.min(embA.length, embB.length);
        for (let i = 0; i < len; i++) {
            dot += embA[i] * embB[i];
            normA += embA[i] * embA[i];
            normB += embB[i] * embB[i];
        }

        const denom = Math.sqrt(normA) * Math.sqrt(normB);
        return denom > 0 ? dot / denom : 0;
    }

    private getEmbedding(nodeId: string): Float64Array | null {
        // Check cache first
        if (this.embeddingCache.has(nodeId)) {
            return this.embeddingCache.get(nodeId)!;
        }

        const row = this.db.prepare(
            'SELECT embedding FROM memory_embeddings WHERE node_id = ?'
        ).get(nodeId) as any;

        if (!row || !row.embedding) return null;

        const emb = new Float64Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 8);

        // Cache it (limit cache size)
        if (this.embeddingCache.size > 500) {
            // Evict oldest entries
            const keys = Array.from(this.embeddingCache.keys());
            for (let i = 0; i < 100; i++) {
                this.embeddingCache.delete(keys[i]);
            }
        }
        this.embeddingCache.set(nodeId, emb);

        return emb;
    }

    /**
     * Record co-usage with validation.
     * Only reinforces connections between semantically related nodes.
     */
    recordCoUsage(nodeIds: string[]): void {
        // Record individual usage
        for (const id of nodeIds) {
            this.recordUsage(id);
        }

        // Validate and reinforce edges
        for (let i = 0; i < nodeIds.length; i++) {
            for (let j = i + 1; j < nodeIds.length; j++) {
                const isValid = this.validateCoUsage(nodeIds[i], nodeIds[j]);
                const similarity = this.getEmbeddingSimilarity(nodeIds[i], nodeIds[j]);

                // Log co-usage attempt
                this.db.prepare(`
                    INSERT INTO co_usage_log (node_a, node_b, similarity, validated)
                    VALUES (?, ?, ?, ?)
                `).run(nodeIds[i], nodeIds[j], Math.round(similarity * 100) / 100, isValid ? 1 : 0);

                // Only reinforce if validated
                if (isValid) {
                    this.reinforceEdge(nodeIds[i], nodeIds[j]);
                }
            }
        }
    }

    // ── 3. Reforço Cognitivo ───────────────────────────────

    private reinforceEdge(nodeA: string, nodeB: string): void {
        const existing = this.db.prepare(`
            SELECT from_node, to_node, relation, weight FROM memory_edges
            WHERE (from_node = ? AND to_node = ?) OR (from_node = ? AND to_node = ?)
            LIMIT 1
        `).get(nodeA, nodeB, nodeB, nodeA) as any;

        if (existing) {
            this.db.prepare(`
                UPDATE memory_edges SET
                    weight = MIN(weight + ?, ?),
                    last_accessed = datetime('now')
                WHERE (from_node = ? AND to_node = ?) OR (from_node = ? AND to_node = ?)
            `).run(EDGE_REINFORCEMENT, MAX_EDGE_WEIGHT, nodeA, nodeB, nodeB, nodeA);
        } else {
            // Create new edge only if co-usage was validated
            this.db.prepare(`
                INSERT OR IGNORE INTO memory_edges (from_node, to_node, relation, weight, confidence)
                VALUES (?, ?, 'co_used', ?, 0.5)
            `).run(nodeA, nodeB, 1.0 + EDGE_REINFORCEMENT);
        }
    }

    // ── 4. Anti-Dominância ───────────────────────────────────

    /**
     * Get the maximum contribution of reinforcement to attention score.
     * Uses square root to prevent dominance: sqrt(score) instead of linear.
     */
    getReinforcementContribution(nodeId: string): number {
        const metrics = this.db.prepare(
            'SELECT reinforcement_score FROM node_metrics WHERE node_id = ?'
        ).get(nodeId) as any;

        if (!metrics) return 0;

        // Square root prevents linear dominance
        // A node with score 4.0 only gets 2.0 contribution, not 4.0
        const contribution = Math.sqrt(metrics.reinforcement_score || 0);

        // Cap at MAX_REINFORCEMENT_IMPACT
        return Math.min(contribution, MAX_REINFORCEMENT_IMPACT);
    }

    /**
     * Ensure diversity in results by domain.
     * If top results are all from the same domain, promote others.
     */
    promoteDiversity(
        candidates: Array<{ nodeId: string; attentionScore: number; domain?: string }>,
        limit: number = 5
    ): Array<{ nodeId: string; attentionScore: number; domain?: string }> {
        if (candidates.length <= limit) return candidates;

        const selected: Array<{ nodeId: string; attentionScore: number; domain?: string }> = [];
        const domainCount: Record<string, number> = {};

        for (const candidate of candidates) {
            if (selected.length >= limit) break;

            const domain = candidate.domain || 'unknown';
            const currentDomainCount = domainCount[domain] || 0;

            // Allow max 2 nodes from same domain in first pass
            if (currentDomainCount >= 2 && selected.length < limit - 1) continue;

            selected.push(candidate);
            domainCount[domain] = currentDomainCount + 1;
        }

        return selected;
    }

    // ── 5. Decaimento Estrutural ─────────────────────────────

    /**
     * Apply time-based decay to reinforcement scores.
     * Uses saturating decay: nodes with high usage resist decay.
     */
    applyDecay(): number {
        let decayed = 0;

        const nodes = this.db.prepare(`
            SELECT nm.node_id, nm.reinforcement_score, nm.last_accessed_at,
                   mn.domain, mn.type
            FROM node_metrics nm
            JOIN memory_nodes mn ON nm.node_id = mn.id
            WHERE nm.reinforcement_score > ?
        `).all(MIN_REINFORCEMENT) as any[];

        for (const node of nodes) {
            // Active context nodes don't decay
            if (node.domain === 'active_context') continue;

            // Recently accessed (< 1 hour) don't decay
            if (node.last_accessed_at) {
                const hours = this.hoursSince(node.last_accessed_at);
                if (hours < 1) continue;
            }

            // Saturating decay: high reinforcement resists more
            const resistanceFactor = 1 + (node.reinforcement_score / MAX_REINFORCEMENT);
            const daysSinceAccess = node.last_accessed_at
                ? this.daysSince(node.last_accessed_at) : 30;

            const decay = (DECAY_RATE * daysSinceAccess) / resistanceFactor;
            const newScore = Math.max(MIN_REINFORCEMENT, node.reinforcement_score - decay);

            if (newScore !== node.reinforcement_score) {
                this.db.prepare(`
                    UPDATE node_metrics SET reinforcement_score = ?, updated_at = datetime('now')
                    WHERE node_id = ?
                `).run(newScore, node.node_id);

                this.classifyNode(node.node_id);
                decayed++;
            }
        }

        // Decay weak edges
        this.decayEdges();

        // Update state
        this.db.prepare(`
            UPDATE feedback_state SET
                last_decay_at = datetime('now'),
                total_decays = total_decays + ?
            WHERE id = 'main'
        `).run(decayed);

        return decayed;
    }

    /**
     * Decay edge weights for unused edges.
     * Preserves critical relations (depends_on, causes, has_trait, follows_rule).
     * Removes edges below minimum weight.
     */
    private decayEdges(): number {
        let decayed = 0;
        let removed = 0;

        const edges = this.db.prepare(`
            SELECT from_node, to_node, relation, weight, last_accessed
            FROM memory_edges
            WHERE weight > ?
        `).all(MIN_EDGE_WEIGHT) as any[];

        for (const edge of edges) {
            // Never decay critical relations
            if (CRITICAL_RELATIONS.includes(edge.relation)) continue;

            const daysSince = edge.last_accessed
                ? this.daysSince(edge.last_accessed)
                : 30;

            if (daysSince > 7) {
                const newWeight = edge.weight * (1 - EDGE_DECAY_RATE);

                if (newWeight < MIN_EDGE_WEIGHT) {
                    // Remove weak edge
                    this.db.prepare(`
                        DELETE FROM memory_edges
                        WHERE from_node = ? AND to_node = ? AND relation = ?
                    `).run(edge.from_node, edge.to_node, edge.relation);
                    removed++;
                } else {
                    this.db.prepare(`
                        UPDATE memory_edges SET weight = ?,
                        last_accessed = datetime('now')
                        WHERE from_node = ? AND to_node = ? AND relation = ?
                    `).run(newWeight, edge.from_node, edge.to_node, edge.relation);
                    decayed++;
                }
            }
        }

        // Update edge removal count
        if (removed > 0) {
            this.db.prepare(`
                UPDATE feedback_state SET edge_removals = edge_removals + ?
                WHERE id = 'main'
            `).run(removed);
        }

        return decayed + removed;
    }

    // ── 6. Monitoramento ────────────────────────────────────

    /**
     * Run monitoring checks and detect anomalies.
     */
    monitor(): AnomalyReport[] {
        const anomalies: AnomalyReport[] = [];
        const now = new Date().toISOString();

        // 1. Check concentration: top 3 nodes shouldn't have >40% of all usage
        const concentration = this.db.prepare(`
            SELECT SUM(usage_count) as total_usage FROM node_metrics
        `).get() as any;

        const top3 = this.db.prepare(`
            SELECT node_id, usage_count FROM node_metrics
            ORDER BY usage_count DESC LIMIT 3
        `).all() as any[];

        if (concentration?.total_usage > 0 && top3.length >= 3) {
            const top3Usage = top3.reduce((sum: number, n: any) => sum + n.usage_count, 0);
            const concentrationRatio = top3Usage / concentration.total_usage;

            if (concentrationRatio > CONCENTRATION_THRESHOLD) {
                anomalies.push({
                    type: 'concentration',
                    details: `Top 3 nodes have ${(concentrationRatio * 100).toFixed(1)}% of usage (threshold: ${CONCENTRATION_THRESHOLD * 100}%)`,
                    severity: concentrationRatio > 0.6 ? 'high' : 'medium',
                    timestamp: now,
                });
            }
        }

        // 2. Check edge density
        const nodeCount = (this.db.prepare('SELECT COUNT(*) as cnt FROM memory_nodes').get() as any)?.cnt || 0;
        const edgeCount = (this.db.prepare('SELECT COUNT(*) as cnt FROM memory_edges').get() as any)?.cnt || 0;
        const edgeDensity = nodeCount > 0 ? edgeCount / nodeCount : 0;

        if (edgeDensity < MIN_EDGE_DENSITY) {
            anomalies.push({
                type: 'sparse_edge',
                details: `Edge density ${edgeDensity.toFixed(2)} below threshold ${MIN_EDGE_DENSITY}`,
                severity: 'low',
                timestamp: now,
            });
        }

        // 3. Check for reinforcement bursts (node gaining too fast)
        const recentBursts = this.db.prepare(`
            SELECT node_id, reinforcement_score FROM node_metrics
            WHERE reinforcement_score > 4.8
        `).all() as any[];

        if (recentBursts.length > 15) {
            anomalies.push({
                type: 'reinforcement_burst',
                details: `${recentBursts.length} nodes near max reinforcement`,
                severity: 'medium',
                timestamp: now,
            });
        }

        // 4. Orphan nodes (no edges)
        const orphans = this.db.prepare(`
            SELECT COUNT(*) as cnt FROM memory_nodes n
            WHERE n.id NOT IN (SELECT from_node FROM memory_edges)
            AND n.id NOT IN (SELECT to_node FROM memory_edges)
            AND n.type != 'legacy_container'
        `).get() as any;

        if (orphans?.cnt > 10) {
            anomalies.push({
                type: 'orphan',
                details: `${orphans.cnt} orphan nodes (no edges)`,
                severity: 'low',
                timestamp: now,
            });
        }

        // Update monitoring state
        this.db.prepare(`
            UPDATE feedback_state SET
                last_monitoring_at = datetime('now'),
                anomalies_detected = anomalies_detected + ?
            WHERE id = 'main'
        `).run(anomalies.length);

        // Log anomalies
        for (const anomaly of anomalies) {
            this.db.prepare(`
                INSERT INTO feedback_log (node_id, action, details)
                VALUES ('_system', ?, ?)
            `).run(anomaly.type, `${anomaly.severity}: ${anomaly.details}`);
        }

        return anomalies;
    }

    // ── Classification ──────────────────────────────────────

    private classifyNode(nodeId: string): MemoryClass {
        const metrics = this.db.prepare(
            'SELECT reinforcement_score, last_accessed_at FROM node_metrics WHERE node_id = ?'
        ).get(nodeId) as any;

        if (!metrics) return 'latent';

        let memoryClass: MemoryClass;

        if (metrics.reinforcement_score >= ACTIVE_THRESHOLD) {
            memoryClass = 'active';
        } else if (metrics.last_accessed_at && this.hoursSince(metrics.last_accessed_at) < 1) {
            memoryClass = 'active';
        } else if (metrics.reinforcement_score >= LONGTERM_THRESHOLD) {
            memoryClass = 'longterm';
        } else {
            memoryClass = 'latent';
        }

        this.db.prepare(`
            UPDATE node_metrics SET memory_class = ?, updated_at = datetime('now')
            WHERE node_id = ?
        `).run(memoryClass, nodeId);

        return memoryClass;
    }

    reclassifyAll(): { active: number; longterm: number; latent: number } {
        const nodes = this.db.prepare('SELECT node_id FROM node_metrics').all() as any[];
        let active = 0, longterm = 0, latent = 0;
        for (const node of nodes) {
            const cls = this.classifyNode(node.node_id);
            if (cls === 'active') active++;
            else if (cls === 'longterm') longterm++;
            else latent++;
        }
        return { active, longterm, latent };
    }

    // ── Normalização ────────────────────────────────────────

    normalize(): void {
        const max = this.db.prepare(
            'SELECT MAX(reinforcement_score) as max FROM node_metrics'
        ).get() as any;

        if (max && max.max > MAX_REINFORCEMENT * 0.9) {
            this.db.prepare(`
                UPDATE node_metrics SET
                    reinforcement_score = (reinforcement_score / ?) * ?,
                    updated_at = datetime('now')
            `).run(max.max, MAX_REINFORCEMENT);
        }

        const maxWeight = this.db.prepare(
            'SELECT MAX(weight) as max FROM memory_edges'
        ).get() as any;

        if (maxWeight && maxWeight.max > MAX_EDGE_WEIGHT * 0.9) {
            this.db.prepare(`
                UPDATE memory_edges SET weight = (weight / ?) * ?
            `).run(maxWeight.max, MAX_EDGE_WEIGHT);
        }

        this.db.prepare(`
            UPDATE feedback_state SET last_normalization_at = datetime('now')
            WHERE id = 'main'
        `).run();
    }

    // ── Connection Suggestions ───────────────────────────────

    suggestConnections(): Array<{ from: string; to: string; reason: string }> {
        const topNodes = this.db.prepare(`
            SELECT nm.node_id, nm.reinforcement_score, mn.name, mn.domain
            FROM node_metrics nm
            JOIN memory_nodes mn ON nm.node_id = mn.id
            WHERE nm.reinforcement_score > 1.0
            AND mn.type != 'legacy_container'
            ORDER BY nm.reinforcement_score DESC
            LIMIT 20
        `).all() as any[];

        const suggestions: Array<{ from: string; to: string; reason: string }> = [];

        for (let i = 0; i < topNodes.length; i++) {
            for (let j = i + 1; j < topNodes.length; j++) {
                const a = topNodes[i];
                const b = topNodes[j];

                const edge = this.db.prepare(`
                    SELECT 1 FROM memory_edges
                    WHERE (from_node = ? AND to_node = ?) OR (from_node = ? AND to_node = ?)
                `).get(a.node_id, b.node_id, b.node_id, a.node_id);

                if (!edge) {
                    const common = this.db.prepare(`
                        SELECT COUNT(*) as cnt FROM memory_edges e1
                        JOIN memory_edges e2 ON e1.to_node = e2.from_node
                        WHERE e1.from_node = ? AND e2.to_node = ?
                    `).get(a.node_id, b.node_id) as any;

                    if (common && common.cnt > 0) {
                        suggestions.push({
                            from: a.node_id,
                            to: b.node_id,
                            reason: `Co-relevant (${common.cnt} shared neighbors, ${a.domain}↔${b.domain})`
                        });
                    }
                }
            }
        }

        return suggestions;
    }

    // ── Background Jobs ─────────────────────────────────────

    startBackgroundJobs(): void {
        this.decayTimer = setInterval(() => {
            try {
                const decayed = this.applyDecay();
                if (decayed > 0) {
                    log.info(`[AttentionFeedback] Decay: ${decayed} nodes`);
                }
            } catch (e) {
                log.error('[AttentionFeedback] Decay error:', e);
            }
        }, DECAY_INTERVAL);

        this.normTimer = setInterval(() => {
            try { this.normalize(); } catch (e) { log.error('[AttentionFeedback] Norm error:', e); }
        }, NORMALIZATION_INTERVAL);

        this.monitorTimer = setInterval(() => {
            try {
                const anomalies = this.monitor();
                if (anomalies.length > 0) {
                    if (anomalies.length > 0) {
                        const types = anomalies.map((a: any) => a.type).join(', ');
                        log.info(`[AttentionFeedback] Monitor: ${anomalies.length} anomalies — ${types}`);
                    }
                }
            } catch (e) { log.error('[AttentionFeedback] Monitor error:', e); }
        }, MONITORING_INTERVAL);

        log.info('[AttentionFeedback] Background jobs started (decay=1h, norm=30min, monitor=5min)');
    }

    stopBackgroundJobs(): void {
        if (this.decayTimer) { clearInterval(this.decayTimer); this.decayTimer = null; }
        if (this.normTimer) { clearInterval(this.normTimer); this.normTimer = null; }
        if (this.monitorTimer) { clearInterval(this.monitorTimer); this.monitorTimer = null; }
        log.info('[AttentionFeedback] Background jobs stopped');
    }

    // ── Stats ───────────────────────────────────────────────

    getStats(): FeedbackStats {
        const total = this.db.prepare('SELECT COUNT(*) as cnt FROM node_metrics').get() as any;
        const byClass = this.db.prepare(
            'SELECT memory_class, COUNT(*) as cnt FROM node_metrics GROUP BY memory_class'
        ).all() as any[];
        const avg = this.db.prepare(
            'SELECT AVG(reinforcement_score) as avg, MAX(reinforcement_score) as max FROM node_metrics'
        ).get() as any;
        const edges = this.db.prepare(
            'SELECT COUNT(*) as cnt FROM memory_edges WHERE weight > 1.0'
        ).get() as any;
        const state = this.db.prepare(
            "SELECT * FROM feedback_state WHERE id = 'main'"
        ).get() as any;

        const classMap: Record<string, number> = {};
        for (const row of byClass) { classMap[row.memory_class] = row.cnt; }

        // Concentration index
        const top3 = this.db.prepare(
            'SELECT usage_count FROM node_metrics ORDER BY usage_count DESC LIMIT 3'
        ).all() as any[];
        const totalUsage = total?.cnt > 0
            ? (this.db.prepare('SELECT SUM(usage_count) as s FROM node_metrics').get() as any)?.s || 0
            : 0;
        const top3Usage = top3.reduce((s: number, r: any) => s + (r.usage_count || 0), 0);
        const concentrationIndex = totalUsage > 0 ? top3Usage / totalUsage : 0;

        // Edge density
        const nodeCount = (this.db.prepare('SELECT COUNT(*) as cnt FROM memory_nodes WHERE type != "legacy_container"').get() as any)?.cnt || 0;
        const edgeCount = (this.db.prepare('SELECT COUNT(*) as cnt FROM memory_edges').get() as any)?.cnt || 0;
        const edgeDensity = nodeCount > 0 ? edgeCount / nodeCount : 0;

        return {
            totalNodes: total?.cnt || 0,
            activeNodes: classMap['active'] || 0,
            longtermNodes: classMap['longterm'] || 0,
            latentNodes: classMap['latent'] || 0,
            avgReinforcement: Math.round((avg?.avg || 0) * 100) / 100,
            maxReinforcement: Math.round((avg?.max || 0) * 100) / 100,
            edgesReinforced: edges?.cnt || 0,
            lastDecay: state?.last_decay_at || null,
            lastNormalization: state?.last_normalization_at || null,
            concentrationIndex: Math.round(concentrationIndex * 100) / 100,
            edgeDensity: Math.round(edgeDensity * 100) / 100,
            anomaliesDetected: state?.anomalies_detected || 0,
        };
    }

    getTopNodes(limit: number = 10): Array<NodeMetrics & { name: string }> {
        return this.db.prepare(`
            SELECT nm.*, mn.name
            FROM node_metrics nm
            JOIN memory_nodes mn ON nm.node_id = mn.id
            WHERE mn.type != 'legacy_container'
            ORDER BY nm.reinforcement_score DESC
            LIMIT ?
        `).all(limit) as any[];
    }

    getNodeMetrics(nodeId: string): NodeMetrics | null {
        return this.db.prepare('SELECT * FROM node_metrics WHERE node_id = ?').get(nodeId) as any;
    }

    // ── Time Helpers ────────────────────────────────────────

    private hoursSince(isoDate: string): number {
        try {
            const then = new Date(isoDate + (isoDate.includes('Z') ? '' : 'Z')).getTime();
            return (Date.now() - then) / 3600000;
        } catch { return 24; }
    }

    private daysSince(isoDate: string): number {
        return this.hoursSince(isoDate) / 24;
    }

    destroy(): void {
        this.stopBackgroundJobs();
    }
}