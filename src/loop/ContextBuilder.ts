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
import { MultiLayerRetriever } from '../memory/MultiLayerRetriever';
import { estimateTokens, truncateToChars } from './ContextBudget';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('ContextBuilder');

// ── Context Tiers ────────────────────────────────────────────
// Controls which memory blocks are assembled based on query complexity.
//   minimal — conversation/simple queries: no reflection, no episodic, ≤3 nodes (~800 chars)
//   normal  — information/lookup queries: no reflection, episodic yes, ≤5 nodes (~1600 chars)
//   full    — creation/analysis/system: all blocks, ≤8 nodes (~3200 chars)  [default]
export type ContextTier = 'minimal' | 'normal' | 'full';

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
    epistemicStatus?: string | null;  // 'fact' | 'belief' | 'assumption' | null
    identityScope?: string | null;    // 'USER_MEMORY' | 'AGENT_MEMORY' | 'SYSTEM_MEMORY' | 'TASK_MEMORY'
}

export class ContextBuilder {
    private memory: MemoryManager;
    private memoryFacade: MemoryFacade;
    private domainSummaryService: DomainSummaryService;
    private episodicMemoryService: EpisodicMemoryService;
    private reflectionEngine: CognitiveReflectionEngine;
    private retriever: MultiLayerRetriever | null = null;

    // ── Attention Budget ──────────────────────────────────────
    // Total memory block char cap (~900 tokens, within ContextBudget.memoryMaxTokens=1000).
    // Per-sub-block allocations ensure no single block starves the others.
    private readonly MAX_MEMORY_CHARS  = 3200;
    private readonly BUDGET_REFLECTION = 500;   // meta-cognitive profile block
    private readonly BUDGET_EPISODIC   = 400;   // recent episodes block
    private readonly BUDGET_DOMAIN     = 250;   // domain summary block
    private readonly MIN_NODES_CHARS   = 600;   // minimum chars always reserved for detail nodes
    private readonly MAX_NODES         = 8;     // absolute upper limit (budget may shrink this)
    private readonly MAX_SUMMARY       = 200;   // chars per node content
    private readonly MAX_RELATIONS     = 3;

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
    async buildContext(query: string, conversationId?: string, tier: ContextTier = 'full'): Promise<string> {
        if (isSocialOrGreeting(query)) {
            // Still record the interaction so the episode stays alive
            if (conversationId) this.episodicMemoryService.recordInteraction(conversationId);
            return '';
        }

        // Tier-based caps: minimal keeps only a few nodes, no heavy blocks
        const maxNodes    = tier === 'minimal' ? 3 : tier === 'normal' ? 5 : this.MAX_NODES;
        const maxMemChars = tier === 'minimal' ? 800 : tier === 'normal' ? 1600 : this.MAX_MEMORY_CHARS;
        const useReflection = tier === 'full';
        const useEpisodic   = tier !== 'minimal';

        log.info(`[CONTEXT-TIER] tier=${tier} maxNodes=${maxNodes} maxChars=${maxMemChars} reflection=${useReflection} episodic=${useEpisodic}`);

        try {
            // Record interaction in the episode
            if (conversationId) this.episodicMemoryService.recordInteraction(conversationId);

            const domainClass = classifyDomain(query);

            // ── Block 1: cognitive profile (full tier only) ──
            const reflectionBlock = useReflection
                ? truncateToChars(this.reflectionEngine.buildReflectionBlock(), this.BUDGET_REFLECTION)
                : '';

            // ── Block 2: episodic history (normal + full) ──
            const episodicBlock = (useEpisodic && conversationId)
                ? truncateToChars(
                    this.episodicMemoryService.buildEpisodicPromptBlock(conversationId, 3),
                    this.BUDGET_EPISODIC
                )
                : '';

            // ── Block 3: domain summary ──
            let domainBlock = '';
            if (domainClass && domainClass.confidence >= 0.3) {
                domainBlock = truncateToChars(
                    this.domainSummaryService.buildPromptBlock(domainClass.domainId),
                    this.BUDGET_DOMAIN
                );
            }

            // ── Compute remaining budget for detail nodes ──
            const headerChars = [reflectionBlock, episodicBlock, domainBlock]
                .filter(Boolean)
                .reduce((sum, b) => sum + b.length + 5 /* separator */, 0);
            const nodesBudget = Math.max(this.MIN_NODES_CHARS, maxMemChars - headerChars);

            // ── Block 4: semantic detail nodes (budget-aware, tier-capped) ──
            const ranked = (await this.domainAwareRankAndSelect(query, nodesBudget)).slice(0, maxNodes);

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
            const result = blocks.length > 0
                ? `${blocks.join('\n---\n')}\n---\n${detailsStr}`
                : detailsStr;

            log.info(`[BUDGET] memory block: ${estimateTokens(result)} tokens | blocks=${blocks.length} nodes=${ranked.length} chars=${result.length}/${this.MAX_MEMORY_CHARS}`);
            return result;
        } catch {
            return this.memory.getContext(200);
        }
    }

    /**
     * Domain-aware retrieval: tries domain subgraph first, falls back to global search.
     * Threshold: domain confidence >= 0.5 AND subgraph has >= 2 matching nodes.
     * charBudget caps total chars of formatted node entries.
     */
    private async domainAwareRankAndSelect(query: string, charBudget: number): Promise<RankedNode[]> {
        const domainClass = classifyDomain(query);

        if (domainClass && domainClass.confidence >= 0.5) {
            const subgraphNodes = this.memory.getRelatedNodes(domainClass.domainId, 'contains');

            if (subgraphNodes.length >= 2) {
                const subgraphIds = new Set(subgraphNodes.map(n => n.id));
                const allSemantic = await this.semanticSearch(query);
                const domainFiltered = allSemantic.filter(n => subgraphIds.has(n.id));

                if (domainFiltered.length >= 2) {
                    return this.rankNodes(domainFiltered, charBudget);
                }
            }
        }

        // Fallback: global semantic search
        return this.rankAndSelect(query, charBudget);
    }

    /**
     * Rank a pre-fetched list of nodes by combined score and select top-K.
     * Stops adding nodes when charBudget is exhausted (budget-aware MAX_NODES).
     */
    private rankNodes(nodes: Array<MemoryNode & { score: number; attentionScore?: number }>, charBudget: number): RankedNode[] {
        // Score all candidates
        const scored: RankedNode[] = nodes.map((node) => {
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

            // Identity scope weighting: USER and TASK memory are most contextually relevant
            const scope = (node as MemoryNode & { identity_scope?: string }).identity_scope;
            if (scope === 'USER_MEMORY')   score *= 1.2;
            if (scope === 'TASK_MEMORY')   score *= 1.1;
            if (scope === 'SYSTEM_MEMORY') score *= 0.9;
            // AGENT_MEMORY: neutral (1.0)

            return {
                id: node.id,
                name: node.name || node.id,
                type: node.type || 'fact',
                summary: this.compactContent(node.content),
                score,
                relations: this.getTopRelations(node.id),
                epistemicStatus: es ?? null,
                identityScope: scope ?? null,
            };
        });

        scored.sort((a, b) => b.score - a.score);

        // Budget-aware selection: stop when char budget is exhausted
        const result: RankedNode[] = [];
        let usedChars = 'Contexto: '.length;
        for (const n of scored) {
            if (result.length >= this.MAX_NODES) break;
            const epistemicPrefix = n.epistemicStatus === 'belief' ? '[crença] '
                : n.epistemicStatus === 'assumption' ? '[suposição] ' : '';
            const entryLen = n.name.length + n.type.length + epistemicPrefix.length + n.summary.length
                + (n.relations.length > 0 ? n.relations.join(', ').length + 4 : 0) + 4; // separators
            if (result.length >= 2 && usedChars + entryLen > charBudget) break;
            result.push(n);
            usedChars += entryLen;
        }
        return result;
    }

    /**
     * Rank nodes by combined score and select top-K (global search).
     */
    private async rankAndSelect(query: string, charBudget: number): Promise<RankedNode[]> {
        const semanticResults = await this.semanticSearch(query);
        return this.rankNodes(semanticResults, charBudget);
    }

    private getRetriever(): MultiLayerRetriever {
        if (!this.retriever) this.retriever = new MultiLayerRetriever(
            this.memory.getDatabase(),
            this.memory.getTemporalLayer(),
            this.memory.getProceduralMemory()
        );
        return this.retriever;
    }

    /**
     * Multi-layer semantic search:
     *   Layer 1 (keyword)  — exact/fuzzy name+content match, no embedding needed
     *   Layer 2 (semantic) — embedding + attention (existing pipeline)
     *   Layer 3 (graph)    — 1-hop expansion from top-K query candidates
     *   Boost  (episodic)  — nodes from recent episodes get +0.15 score
     *
     * Results from all layers are fused into a single pool ranked by fusedScore
     * before the ContextBuilder's own rankNodes() applies the final re-ranking.
     */
    private async semanticSearch(query: string): Promise<Array<MemoryNode & { score: number; attentionScore?: number }>> {
        // Layer 2: semantic search (async, embedding-based)
        const rawSemantic: Array<MemoryNode & { score: number; attentionScore?: number }> = [];
        try {
            const results = await this.memory.semanticSearchWithAttention(query, 12);
            rawSemantic.push(...(results || []));
        } catch {
            try {
                const results = await this.memory.semanticSearch(query, 12);
                rawSemantic.push(...(results || []));
            } catch { /* ignore — will rely on keyword+graph */ }
        }

        // Build semantic candidates for the multi-layer retriever
        const semanticCandidates = rawSemantic.map(n => ({
            nodeId: n.id,
            score: n.score || (n as MemoryNode & { attentionScore?: number }).attentionScore || 0.5,
        }));

        // Layers 1 + 3 + episodic boost via MultiLayerRetriever
        const fused = this.getRetriever().retrieve(query, semanticCandidates);

        // Build node lookup map from semantic results already in memory
        const nodeById = new Map<string, MemoryNode & { score: number; attentionScore?: number }>(
            rawSemantic.map(n => [n.id, n])
        );

        // Fetch full node data for keyword/graph candidates not in semantic results
        const missingIds = fused.map(c => c.nodeId).filter(id => !nodeById.has(id));
        if (missingIds.length > 0) {
            const ph = missingIds.map(() => '?').join(',');
            const rows = this.memory.getDatabase().prepare(`
                SELECT * FROM memory_nodes
                WHERE id IN (${ph})
                  AND (lifecycle_state IS NULL OR lifecycle_state = 'ACTIVE')
            `).all(...missingIds) as MemoryNode[];
            for (const row of rows) nodeById.set(row.id, { ...row, score: 0 });
        }

        // Apply fused scores and return in fused rank order
        return fused
            .map(c => {
                const node = nodeById.get(c.nodeId);
                if (!node) return null;
                return { ...node, score: c.fusedScore };
            })
            .filter((n): n is MemoryNode & { score: number } => n !== null);
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
