/**
 * ContextBuilder — Seleção inteligente de contexto para o LLM
 * 
 * Pipeline: query → search → rank → compact → prompt
 * 
 * Ranking: similarity * 0.6 + connectivity * 0.25 + recency * 0.15
 * Seleção: top-K (5-8 nós) com conteúdo compactado
 */

import { MemoryManager, type MemoryNode } from '../memory/MemoryManager';
import type { MemoryFacade } from '../memory/MemoryFacade';
import { classifyDomain } from '../memory/DomainRegistry';
import type { DomainSummaryService } from '../memory/DomainSummaryService';
import type { EpisodicMemoryService } from '../memory/EpisodicMemoryService';
import type { CognitiveReflectionEngine } from '../memory/CognitiveReflectionEngine';

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
    summary: string;          // max 200 chars
    score: number;            // combined score
    relations: string[];      // max 3 related node names
    epistemicStatus?: string | null; // 'fact' | 'belief' | 'assumption' | null
}

export class ContextBuilder {
    private memory: MemoryManager;
    private memoryFacade: MemoryFacade;
    private domainSummaryService: DomainSummaryService;
    private episodicMemoryService: EpisodicMemoryService;
    private reflectionEngine: CognitiveReflectionEngine;
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
        this.domainSummaryService = memory.getDomainSummaryService();
        this.episodicMemoryService = memory.getEpisodicMemoryService();
        this.reflectionEngine = memory.getCognitiveReflectionEngine();
    }

    /**
     * Build compact context for LLM prompt.
     * Returns a string of ~500-800 chars with the most relevant information.
     *
     * Strategy: domain-first routing (query → detectDomain → subgraph BFS → semantic filter)
     * Fallback: global semantic search when domain confidence is low or subgraph is sparse.
     *
     * Block order in prompt:
     *   1. Episodic block  — recent conversation history (if conversationId provided)
     *   2. Domain summary  — thematic orientation (if domain detected with confidence >= 0.3)
     *   3. Semantic detail — top-K ranked nodes
     *
     * @param conversationId Optional — when provided, episodic memory is recorded and injected.
     */
    async buildContext(query: string, conversationId?: string): Promise<string> {
        if (isSocialOrGreeting(query)) {
            // Still record the interaction so the episode stays alive
            if (conversationId) this.episodicMemoryService.recordInteraction(conversationId);
            return '';
        }

        try {
            // Record interaction in the episode
            if (conversationId) this.episodicMemoryService.recordInteraction(conversationId);

            const domainClass = classifyDomain(query);

            // Block 1: cognitive profile (metacognitive reflection — throttled, updated every 24h)
            const reflectionBlock = this.reflectionEngine.buildReflectionBlock();

            // Block 2: episodic history (exclude current conversation)
            const episodicBlock = conversationId
                ? this.episodicMemoryService.buildEpisodicPromptBlock(conversationId, 3)
                : '';

            // Block 3: domain summary
            let domainBlock = '';
            if (domainClass && domainClass.confidence >= 0.3) {
                domainBlock = this.domainSummaryService.buildPromptBlock(domainClass.domainId);
            }

            const ranked = await this.domainAwareRankAndSelect(query);

            // Record accessed nodes in the episode
            if (conversationId && ranked.length > 0) {
                this.episodicMemoryService.recordNodeAccesses(conversationId, ranked.map(n => n.id));
            }

            if (ranked.length === 0) {
                const fallback = this.memory.getContext(200);
                const header = [reflectionBlock, episodicBlock, domainBlock].filter(Boolean).join('\n---\n');
                return header ? `${header}\n${fallback}` : fallback;
            }

            const parts = ranked.map(n => {
                const epistemicPrefix =
                    n.epistemicStatus === 'belief'     ? '[crença] ' :
                    n.epistemicStatus === 'assumption' ? '[suposição] ' :
                    '';
                let entry = `${n.name}(${n.type}): ${epistemicPrefix}${n.summary}`;
                if (n.relations.length > 0) entry += ` → ${n.relations.join(', ')}`;
                return entry;
            });

            const detailsStr = 'Contexto: ' + parts.join('. ');
            const blocks = [reflectionBlock, episodicBlock, domainBlock].filter(Boolean);
            return blocks.length > 0 ? `${blocks.join('\n---\n')}\n---\n${detailsStr}` : detailsStr;
        } catch {
            return this.memory.getContext(200);
        }
    }

    /**
     * Domain-aware retrieval: tries domain subgraph first, falls back to global search.
     * Threshold: domain confidence >= 0.5 AND subgraph has >= 2 matching nodes.
     */
    private async domainAwareRankAndSelect(query: string): Promise<RankedNode[]> {
        const domainClass = classifyDomain(query);

        if (domainClass && domainClass.confidence >= 0.5) {
            const subgraphNodes = this.memory.getRelatedNodes(domainClass.domainId, 'contains');

            if (subgraphNodes.length >= 2) {
                const subgraphIds = new Set(subgraphNodes.map(n => n.id));
                const allSemantic = await this.semanticSearch(query);
                const domainFiltered = allSemantic.filter(n => subgraphIds.has(n.id));

                if (domainFiltered.length >= 2) {
                    return this.rankNodes(domainFiltered);
                }
            }
        }

        // Fallback: global semantic search
        return this.rankAndSelect(query);
    }

    /**
     * Rank a pre-fetched list of nodes by combined score and select top-K.
     */
    private rankNodes(nodes: Array<MemoryNode & { score: number; attentionScore?: number }>): RankedNode[] {
        const ranked: RankedNode[] = nodes.map((node) => {
            const similarity = node.score || node.attentionScore || 0.5;
            const connectivity = this.getConnectivity(node.id);
            const recency = this.getRecency(node.id);

            let score = (similarity * this.W_SIMILARITY) +
                          (connectivity * this.W_CONNECTIVITY) +
                          (recency * this.W_RECENCY);

            if (node.type === 'preference') score *= 1.5;
            if (node.type === 'identity') score *= 1.3;

            // Epistemic weighting: facts are more reliable, assumptions less so
            const es = (node as MemoryNode & { epistemic_status?: string }).epistemic_status;
            if (es === 'fact')       score *= 1.1;
            if (es === 'assumption') score *= 0.8;

            return {
                id: node.id,
                name: node.name || node.id,
                type: node.type || 'fact',
                summary: this.compactContent(node.content),
                score,
                relations: this.getTopRelations(node.id),
                epistemicStatus: es ?? null,
            };
        });

        ranked.sort((a, b) => b.score - a.score);
        return ranked.slice(0, this.MAX_NODES);
    }

    /**
     * Rank nodes by combined score and select top-K (global search).
     */
    private async rankAndSelect(query: string): Promise<RankedNode[]> {
        const semanticResults = await this.semanticSearch(query);
        return this.rankNodes(semanticResults);
    }

    /**
     * Semantic search with attention — returns top results.
     */
    private async semanticSearch(query: string): Promise<Array<MemoryNode & { score: number; attentionScore?: number }>> {
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
