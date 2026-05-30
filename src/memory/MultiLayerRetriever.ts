/**
 * MultiLayerRetriever — Pipeline de recuperação multi-camada
 *
 * Complementa o `semanticSearchWithAttention` adicionando camadas que o
 * embedding não cobre bem:
 *
 *   Layer 1 (keyword)  — match textual em nome e conteúdo da query
 *   Layer 3 (graph)    — vizinhos de 1-hop dos top candidatos semânticos+keyword
 *   Boost  (episodic)  — nós de episódios recentes ganham +EPISODIC_BOOST
 *
 * Layer 2 (semantic) fica no MemoryManager/AttentionLayer — já bem implementada.
 *
 * Fusão: pool único por nodeId, max-score entre camadas, boost episódico
 * aplicado por último, antes do re-ranking final no ContextBuilder.
 */

import Database from 'better-sqlite3';
import { createLogger } from '../shared/AppLogger';
import type { TemporalLayer } from './TemporalLayer';
import type { ProceduralMemoryService } from './ProceduralMemoryService';

const log = createLogger('MultiLayerRetriever');

// ── Types ──────────────────────────────────────────────────────────────────

export type RetrievalLayer = 'keyword' | 'semantic' | 'graph' | 'temporal' | 'procedural';

export interface LayerCandidate {
    nodeId: string;
    score: number;
    layer: RetrievalLayer;
}

export interface FusedCandidate {
    nodeId: string;
    fusedScore: number;
    layers: RetrievalLayer[];
}

// ── Retriever ──────────────────────────────────────────────────────────────

export class MultiLayerRetriever {
    // Score assigned by each layer when a node is found
    private readonly KEYWORD_NAME_SCORE    = 0.85;
    private readonly KEYWORD_CONTENT_SCORE = 0.60;
    private readonly GRAPH_NEIGHBOR_SCORE  = 0.50;
    private readonly TEMPORAL_SCORE        = 0.55;
    // Boost applied to nodes that appeared in recent episodes
    private readonly EPISODIC_BOOST        = 0.15;
    // Minimum term length to consider meaningful
    private readonly MIN_TERM_LENGTH       = 3;

    constructor(
        private db: Database.Database,
        private temporal?: TemporalLayer,
        private procedural?: ProceduralMemoryService
    ) {}

    // ── Layer 1: Keyword / name search ────────────────────────────────────

    /**
     * Searches memory_nodes by name and content using LIKE per query term.
     * Name matches score higher than content matches.
     *
     * Skips SUMMARIZED / EXPIRED nodes, structural types, and core/domain nodes.
     * Terms shorter than MIN_TERM_LENGTH are ignored.
     */
    keywordSearch(query: string, limit: number = 8): LayerCandidate[] {
        const terms = query
            .toLowerCase()
            .split(/\s+/)
            .filter(t => t.length >= this.MIN_TERM_LENGTH)
            .slice(0, 4); // cap to avoid very broad queries

        if (terms.length === 0) return [];

        const seen = new Set<string>();
        const results: LayerCandidate[] = [];

        const stmt = this.db.prepare(`
            SELECT id, name
            FROM memory_nodes
            WHERE (lifecycle_state IS NULL OR lifecycle_state = 'ACTIVE')
              AND type NOT IN ('identity', 'domain', 'legacy_container')
              AND id NOT LIKE 'core_%'
              AND id NOT LIKE 'domain_%'
              AND id NOT LIKE 'user_identity%'
              AND id NOT LIKE 'time_%'
              AND (LOWER(name) LIKE ? OR LOWER(content) LIKE ?)
            ORDER BY COALESCE(confidence, 0.5) DESC, COALESCE(weight, 1.0) DESC
            LIMIT ?
        `);

        for (const term of terms) {
            const like = `%${term}%`;
            const rows = stmt.all(like, like, limit) as Array<{ id: string; name: string }>;
            for (const row of rows) {
                if (seen.has(row.id)) continue;
                seen.add(row.id);
                const isNameMatch = row.name.toLowerCase().includes(term);
                results.push({
                    nodeId: row.id,
                    score: isNameMatch ? this.KEYWORD_NAME_SCORE : this.KEYWORD_CONTENT_SCORE,
                    layer: 'keyword',
                });
            }
        }

        return results;
    }

    // ── Layer 3: Graph expansion ───────────────────────────────────────────

    /**
     * 1-hop expansion from seed node IDs.
     *
     * Returns nodes connected via any edge EXCEPT structural relations
     * (contains, next) which are too generic to add query signal.
     *
     * Edges are ordered by weight descending so the strongest connections
     * are preferred when the limit is reached.
     *
     * This is distinct from AttentionLayer's neighborhood expansion, which
     * seeds from the conversation context window. This expansion seeds from
     * the query's own top-K matches, pulling in related context the user
     * didn't mention explicitly.
     */
    graphExpand(seedIds: string[], limit: number = 8): LayerCandidate[] {
        if (seedIds.length === 0) return [];

        const ph = seedIds.map(() => '?').join(',');
        const rows = this.db.prepare(`
            SELECT DISTINCT n.id
            FROM memory_edges e
            JOIN memory_nodes n ON (n.id = e.to_node OR n.id = e.from_node)
            WHERE (e.from_node IN (${ph}) OR e.to_node IN (${ph}))
              AND n.id NOT IN (${ph})
              AND (n.lifecycle_state IS NULL OR n.lifecycle_state = 'ACTIVE')
              AND n.type NOT IN ('identity', 'domain', 'legacy_container')
              AND n.id NOT LIKE 'core_%'
              AND n.id NOT LIKE 'domain_%'
              AND n.id NOT LIKE 'user_identity%'
              AND n.id NOT LIKE 'time_%'
              AND e.relation NOT IN ('next', 'contains', 'occurred_in')
            ORDER BY COALESCE(e.weight, 1.0) DESC
            LIMIT ?
        `).all(...seedIds, ...seedIds, ...seedIds, limit) as Array<{ id: string }>;

        return rows.map(row => ({
            nodeId: row.id,
            score: this.GRAPH_NEIGHBOR_SCORE,
            layer: 'graph' as const,
        }));
    }

    // ── Episodic boost ─────────────────────────────────────────────────────

    /**
     * Returns node IDs that appeared in any active episode or in episodes
     * closed within the last 7 days.
     *
     * These nodes get a score boost during fusion — they're "top of mind"
     * for the user regardless of embedding similarity.
     */
    getEpisodicBoostSet(): Set<string> {
        try {
            const rows = this.db.prepare(`
                SELECT DISTINCT en.node_id
                FROM episode_nodes en
                JOIN memory_episodes ep ON ep.conversation_id = en.conversation_id
                WHERE ep.is_active = 1
                   OR ep.ended_at > datetime('now', '-7 days')
            `).all() as Array<{ node_id: string }>;
            return new Set(rows.map(r => r.node_id));
        } catch {
            return new Set();
        }
    }

    // ── Fusion ─────────────────────────────────────────────────────────────

    /**
     * Merge candidates from multiple layers into a single ranked pool.
     *
     * Rules:
     * - De-duplicate: if a node appears in multiple layers, keep max score
     *   and accumulate layer provenance.
     * - Episodic boost: nodes in the boost set gain +EPISODIC_BOOST (capped 1.0).
     * - Sort by fusedScore descending.
     */
    fuse(candidates: LayerCandidate[], episodicBoost: Set<string>): FusedCandidate[] {
        const byNode = new Map<string, FusedCandidate>();

        for (const c of candidates) {
            const existing = byNode.get(c.nodeId);
            if (!existing) {
                byNode.set(c.nodeId, {
                    nodeId: c.nodeId,
                    fusedScore: c.score,
                    layers: [c.layer],
                });
            } else {
                if (c.score > existing.fusedScore) existing.fusedScore = c.score;
                if (!existing.layers.includes(c.layer)) existing.layers.push(c.layer);
            }
        }

        // Apply episodic boost after max-score fusion
        for (const candidate of byNode.values()) {
            if (episodicBoost.has(candidate.nodeId)) {
                candidate.fusedScore = Math.min(1.0, candidate.fusedScore + this.EPISODIC_BOOST);
            }
        }

        const sorted = Array.from(byNode.values()).sort((a, b) => b.fusedScore - a.fusedScore);

        // [MLR-POOL] — log TODOS os nós fundidos com breakdown por camada
        sorted.forEach(n => {
            const semantic = candidates.find(c => c.nodeId === n.nodeId && c.layer === 'semantic')?.score ?? 0;
            const keyword  = candidates.find(c => c.nodeId === n.nodeId && c.layer === 'keyword')?.score ?? 0;
            const graph    = candidates.find(c => c.nodeId === n.nodeId && c.layer === 'graph')?.score ?? 0;
            const temporal = candidates.find(c => c.nodeId === n.nodeId && c.layer === 'temporal')?.score ?? 0;
            const boosted  = episodicBoost.has(n.nodeId);
            log.info(
                `[MLR-POOL] nodeId=${n.nodeId} fusedScore=${n.fusedScore.toFixed(3)} ` +
                `source=semantic:${semantic.toFixed(3)},keyword:${keyword.toFixed(3)},` +
                `graph:${graph.toFixed(3)},temporal:${temporal.toFixed(3)} ` +
                `layers=[${n.layers.join(',')}]${boosted ? ' +episodic' : ''}`
            );
        });

        // Source distribution dos nós no pool
        const sourceCount = { semantic: 0, keyword: 0, graph: 0, temporal: 0, multi: 0 };
        for (const n of sorted) {
            if (n.layers.length > 1) sourceCount.multi++;
            else if (n.layers[0] === 'semantic')  sourceCount.semantic++;
            else if (n.layers[0] === 'keyword')   sourceCount.keyword++;
            else if (n.layers[0] === 'graph')     sourceCount.graph++;
            else if (n.layers[0] === 'temporal')  sourceCount.temporal++;
        }
        log.info(
            `[MLR-DIST] pool=${sorted.length} ` +
            `semantic_only=${sourceCount.semantic} keyword_only=${sourceCount.keyword} ` +
            `graph_only=${sourceCount.graph} temporal_only=${sourceCount.temporal} multi_layer=${sourceCount.multi}`
        );

        return sorted;
    }

    // ── Main entry point ───────────────────────────────────────────────────

    /**
     * Full multi-layer retrieval pipeline.
     *
     * Accepts pre-computed semantic candidates (layer 2, async) and adds
     * keyword + graph layers synchronously.
     *
     * @param query          Raw user query string
     * @param semanticCandidates Layer-2 results already computed by MemoryManager
     * @param opts.keywordLimit  Max nodes per keyword term (default 8)
     * @param opts.graphLimit    Max nodes from graph expansion (default 8)
     * @param opts.graphSeeds    Number of top candidates used as graph seeds (default 4)
     */
    retrieve(
        query: string,
        semanticCandidates: Array<{ nodeId: string; score: number }>,
        opts?: { keywordLimit?: number; graphLimit?: number; graphSeeds?: number }
    ): FusedCandidate[] {
        const t0 = Date.now();
        const keywordLimit = opts?.keywordLimit ?? 8;
        const graphLimit   = opts?.graphLimit   ?? 8;
        const graphSeeds   = opts?.graphSeeds   ?? 4;

        // Layer 1: keyword
        const t_kw0 = Date.now();
        const keywordCandidates = this.keywordSearch(query, keywordLimit);
        const keyword_ms = Date.now() - t_kw0;

        // Layer 2: semantic (pre-computed — tempo medido externamente)
        const t_sem0 = Date.now();
        const semanticLayer: LayerCandidate[] = semanticCandidates.map(c => ({
            nodeId: c.nodeId,
            score: c.score,
            layer: 'semantic' as const,
        }));
        const semantic_ms = Date.now() - t_sem0; // só custo de mapeamento; embedding já feito antes

        // Layer 3: graph expansion from top semantic+keyword seeds
        const t_graph0 = Date.now();
        const topSeeds = [...semanticLayer, ...keywordCandidates]
            .sort((a, b) => b.score - a.score)
            .slice(0, graphSeeds)
            .map(c => c.nodeId);
        const graphCandidates = this.graphExpand(topSeeds, graphLimit);
        const graph_ms = Date.now() - t_graph0;

        // Layer 5: procedural — specialized retrieval for "how to" intent
        const proceduralCandidates: LayerCandidate[] = [];
        if (this.procedural?.detectIntent(query)) {
            const hits = this.procedural.retrieve(query, opts?.keywordLimit ?? 8);
            for (const { nodeId, score } of hits) {
                proceduralCandidates.push({ nodeId, score, layer: 'procedural' });
            }
        }

        // Layer 4: temporal — surface nodes from the queried year
        const temporalCandidates: LayerCandidate[] = [];
        if (this.temporal) {
            const year = this.temporal.extractYear(query);
            if (year !== null) {
                const nodeIds = this.temporal.getNodesForYear(year, 12);
                for (const nodeId of nodeIds) {
                    temporalCandidates.push({ nodeId, score: this.TEMPORAL_SCORE, layer: 'temporal' });
                }
            }
        }

        // Episodic boost set (synchronous DB read)
        const t_ep0 = Date.now();
        const episodicBoost = this.getEpisodicBoostSet();
        const db_ms = Date.now() - t_ep0;

        // Fuse all layers
        const t_fuse0 = Date.now();
        const fused = this.fuse(
            [...semanticLayer, ...keywordCandidates, ...graphCandidates, ...temporalCandidates, ...proceduralCandidates],
            episodicBoost
        );
        const fusion_ms = Date.now() - t_fuse0;

        const total_ms = Date.now() - t0;
        log.info(
            `[MLR] keyword=${keywordCandidates.length} semantic=${semanticLayer.length} ` +
            `graph=${graphCandidates.length} temporal=${temporalCandidates.length} ` +
            `procedural=${proceduralCandidates.length} episodicBoost=${episodicBoost.size} → fused=${fused.length}`
        );
        log.info(
            `[MLR-TIMING] semantic_ms=${semantic_ms} keyword_ms=${keyword_ms} graph_ms=${graph_ms} ` +
            `fusion_ms=${fusion_ms} db_ms=${db_ms} total_ms=${total_ms}`
        );

        return fused;
    }
}
