/**
 * ContextBuilder — Seleção inteligente de contexto para o LLM
 * 
 * Pipeline: query → search → rank → compact → prompt
 * 
 * Ranking: similarity * 0.6 + connectivity * 0.25 + recency * 0.15
 * Seleção: top-K (5-8 nós) com conteúdo compactado
 */

import { MemoryManager } from '../memory/MemoryManager';

interface RankedNode {
    id: string;
    name: string;
    type: string;
    summary: string;    // max 200 chars
    score: number;      // combined score
    relations: string[]; // max 3 related node names
}

export class ContextBuilder {
    private memory: MemoryManager;
    private readonly MAX_NODES = 6;
    private readonly MAX_SUMMARY = 200;
    private readonly MAX_RELATIONS = 3;

    // Ranking weights
    private readonly W_SIMILARITY = 0.6;
    private readonly W_CONNECTIVITY = 0.25;
    private readonly W_RECENCY = 0.15;

    constructor(memory: MemoryManager) {
        this.memory = memory;
    }

    /**
     * Build compact context for LLM prompt.
     * Returns a string of ~500-800 chars with the most relevant information.
     */
    async buildContext(query: string): Promise<string> {
        try {
            const ranked = await this.rankAndSelect(query);
            if (ranked.length === 0) {
                return this.memory.getContext(200); // fallback
            }

            const parts = ranked.map(n => {
                let entry = `${n.name}(${n.type}): ${n.summary}`;
                if (n.relations.length > 0) {
                    entry += ` → ${n.relations.join(', ')}`;
                }
                return entry;
            });

            return 'Contexto: ' + parts.join('. ');
        } catch {
            return this.memory.getContext(200); // fallback
        }
    }

    /**
     * Rank nodes by combined score and select top-K.
     */
    private async rankAndSelect(query: string): Promise<RankedNode[]> {
        // 1. Semantic search (similarity)
        const semanticResults = await this.semanticSearch(query);

        // 2. Get connectivity for each node
        const db = (this.memory as any).db;

        // 3. Calculate combined scores
        const ranked: RankedNode[] = semanticResults.map((node: any) => {
            const similarity = node.score || node.attentionScore || 0.5;
            const connectivity = this.getConnectivity(node.id, db);
            const recency = this.getRecency(node.id, db);

            const score = (similarity * this.W_SIMILARITY) +
                          (connectivity * this.W_CONNECTIVITY) +
                          (recency * this.W_RECENCY);

            return {
                id: node.id,
                name: node.name || node.id,
                type: node.type || 'fact',
                summary: this.compactContent(node.content),
                score,
                relations: this.getTopRelations(node.id, db)
            };
        });

        // 4. Sort by score, select top-K
        ranked.sort((a, b) => b.score - a.score);
        return ranked.slice(0, this.MAX_NODES);
    }

    /**
     * Semantic search with attention — returns top results.
     */
    private async semanticSearch(query: string): Promise<any[]> {
        try {
            const results = await this.memory.semanticSearchWithAttention(query, 12);
            return results || [];
        } catch {
            try {
                const results = await this.memory.semanticSearch(query, 12);
                return results || [];
            } catch {
                return [];
            }
        }
    }

    /**
     * Compact content to max 200 chars.
     */
    private compactContent(content: string | undefined): string {
        if (!content) return '';
        if (content.length <= this.MAX_SUMMARY) return content;
        // Try to cut at last sentence/period before limit
        const cut = content.slice(0, this.MAX_SUMMARY);
        const lastPeriod = cut.lastIndexOf('.');
        if (lastPeriod > this.MAX_SUMMARY * 0.5) {
            return cut.slice(0, lastPeriod + 1);
        }
        return cut + '...';
    }

    /**
     * Get connectivity score (0-1) based on number of edges.
     */
    private getConnectivity(nodeId: string, db: any): number {
        try {
            const result = db.prepare(
                'SELECT COUNT(*) as cnt FROM memory_edges WHERE from_node = ? OR to_node = ?'
            ).get(nodeId, nodeId) as any;
            const degree = result?.cnt || 0;
            // Normalize: 0 edges = 0, 10+ edges = 1
            return Math.min(degree / 10, 1.0);
        } catch {
            return 0.3; // default medium score
        }
    }

    /**
     * Get recency score (0-1) based on last_accessed time.
     */
    private getRecency(nodeId: string, db: any): number {
        try {
            const result = db.prepare(
                'SELECT last_accessed FROM memory_nodes WHERE id = ?'
            ).get(nodeId) as any;
            if (!result?.last_accessed) return 0.3; // default
            const lastAccess = new Date(result.last_accessed).getTime();
            const now = Date.now();
            const hoursSinceAccess = (now - lastAccess) / (1000 * 60 * 60);
            // Fresh = 1.0, 24h = 0.7, 7d = 0.3, 30d+ = 0.1
            if (hoursSinceAccess < 1) return 1.0;
            if (hoursSinceAccess < 24) return 0.7;
            if (hoursSinceAccess < 168) return 0.3;
            return 0.1;
        } catch {
            return 0.3;
        }
    }

    /**
     * Get top-N relation names for a node.
     */
    private getTopRelations(nodeId: string, db: any): string[] {
        try {
            const edges = db.prepare(
                'SELECT to_node, relation FROM memory_edges WHERE from_node = ? ORDER BY weight DESC LIMIT ?'
            ).all(nodeId, this.MAX_RELATIONS) as any[];
            return edges.map((e: any) => e.to_node);
        } catch {
            return [];
        }
    }
}