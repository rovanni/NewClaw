/**
 * ContextBuilder — Seleção inteligente de contexto para o LLM
 * 
 * Pipeline: query → search → rank → compact → prompt
 * 
 * Ranking: similarity * 0.6 + connectivity * 0.25 + recency * 0.15
 * Seleção: top-K (5-8 nós) com conteúdo compactado
 */

import { MemoryManager } from '../memory/MemoryManager';
import type { MemoryFacade } from '../memory/MemoryFacade';

// ── Relevance Gate ───────────────────────────────────────────
// Short greetings and social messages should NOT trigger semantic context injection.
// This prevents the LLM from responding with stale context (e.g. crypto prices)
// when the user just says "Oi", "Olá", "Bom dia", etc.

const GREETING_PATTERNS: RegExp[] = [
    /^(oi|olá|ola|eai|eae|fala|opa|hey|hello|hi|bom dia|boa tarde|boa noite|salve|coé|coe)[\s!.?]*$/i,
    /^(tchau|bye|até|ate|flw|falou)[\s!.?]*$/i,
    /^(valeu|obrigad[oa]?|vlw)[\s!.?]*$/i,
    /^(kk+|haha+|rsrs?|👍|🤣|😂)[\s!.?]*$/i,
];

const MIN_QUERY_LENGTH = 4; // queries shorter than this are likely social

function isSocialOrGreeting(query: string): boolean {
    const trimmed = query.trim().toLowerCase();
    if (trimmed.length < MIN_QUERY_LENGTH) return true;
    return GREETING_PATTERNS.some(p => p.test(trimmed));
}

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
    private memoryFacade: MemoryFacade;
    private readonly MAX_NODES = 6;
    private readonly MAX_SUMMARY = 200;
    private readonly MAX_RELATIONS = 3;

    // Ranking weights
    private readonly W_SIMILARITY = 0.6;
    private readonly W_CONNECTIVITY = 0.25;
    private readonly W_RECENCY = 0.15;

    constructor(memory: MemoryManager) {
        this.memory = memory;
        this.memoryFacade = memory.getFacade();
    }

    /**
     * Build compact context for LLM prompt.
     * Returns a string of ~500-800 chars with the most relevant information.
     */
    async buildContext(query: string): Promise<string> {
        // ── Relevance Gate ──
        // Skip semantic context for social messages/greetings.
        // Prevents stale context (e.g. crypto prices) from hijacking simple interactions.
        if (isSocialOrGreeting(query)) {
            return ''; // No context injection for greetings
        }

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

        // 2. Calculate combined scores
        const ranked: RankedNode[] = semanticResults.map((node: any) => {
            const similarity = node.score || node.attentionScore || 0.5;
            const connectivity = this.getConnectivity(node.id);
            const recency = this.getRecency(node.id);

            let score = (similarity * this.W_SIMILARITY) +
                          (connectivity * this.W_CONNECTIVITY) +
                          (recency * this.W_RECENCY);

            // BÔNUS DE TIPO: Preferências e Identidade são "âncoras" de contexto
            if (node.type === 'preference') score *= 1.5; // +50% de peso
            if (node.type === 'identity') score *= 1.3;   // +30% de peso

            return {
                id: node.id,
                name: node.name || node.id,
                type: node.type || 'fact',
                summary: this.compactContent(node.content),
                score,
                relations: this.getTopRelations(node.id)
            };
        });

        // 3. Sort by score, select top-K
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
    private getConnectivity(nodeId: string): number {
        try {
            const degree = this.memoryFacade.getNodeConnectivity(nodeId);
            // Normalize: 0 edges = 0, 10+ edges = 1
            return Math.min(degree / 10, 1.0);
        } catch {
            return 0.3; // default medium score
        }
    }

    /**
     * Get recency score (0-1) based on last_accessed time.
     */
    private getRecency(nodeId: string): number {
        try {
            return this.memoryFacade.getNodeRecency(nodeId);
        } catch {
            return 0.3;
        }
    }

    /**
     * Get top-N relation names for a node.
     */
    private getTopRelations(nodeId: string): string[] {
        try {
            return this.memoryFacade.getTopRelations(nodeId, this.MAX_RELATIONS);
        } catch {
            return [];
        }
    }
}
