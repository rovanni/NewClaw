import { MemoryManager } from './MemoryManager';
import { GraphAnalytics } from './GraphAnalytics';
import { EmbeddingService } from './EmbeddingService';
import type { MemoryGraphRepository } from './MemoryGraphRepository';
import { createLogger } from '../shared/AppLogger';
import { errorMessage } from '../shared/errors';
const log = createLogger('Memorycurator');
import type { DomainSummaryService } from './DomainSummaryService';
import { getDomainById } from './DomainRegistry';

interface CuratorResult {
    orphansFixed: number;
    hubsCreated: number;
    edgesCreated: string[];
    details: string[];
}

interface NodeForConsolidation {
    id: string;
    name: string;
    content: string;
    type: string;
    domain: string;
    weight: number | null;
    confidence: number | null;
    last_accessed: string | null;
    updated_at: string | null;
}

export interface ConsolidationResult {
    clustersFound: number;
    nodesMarkedSummarized: number;
    summariesCreated: number;
}

export class MemoryCurator {
    private mm: MemoryManager;
    private repo: MemoryGraphRepository;
    private analytics: GraphAnalytics;
    private embeddingService?: EmbeddingService;
    private domainSummaryService: DomainSummaryService;
    private intervalId: ReturnType<typeof setInterval> | null = null;

    constructor(memoryManager: MemoryManager, embeddingService?: EmbeddingService) {
        this.mm = memoryManager;
        this.repo = memoryManager.getGraphRepository();
        this.analytics = new GraphAnalytics(memoryManager);
        this.embeddingService = embeddingService;
        this.domainSummaryService = memoryManager.getDomainSummaryService();
    }

    private addEdgeSafe(from: string, to: string, relation: string): boolean {
        try {
            this.mm.addEdge(from, to, relation);
            return true;
        } catch {
            return false;
        }
    }

    async curate(): Promise<CuratorResult> {
        const result: CuratorResult = { orphansFixed: 0, hubsCreated: 0, edgesCreated: [], details: [] };

        const nodes = this.repo.getAllNodes();
        const edges = this.repo.getAllEdges();

        const connectedNodes = new Set<string>();
        for (const e of edges) {
            connectedNodes.add(e.from_node);
            connectedNodes.add(e.to_node);
        }

        const DAILY_HUB = 'ctx_daily_memory';
        const SYSTEM_HUB = 'ctx_system_memory';
        const INFRA_HUB = 'ctx_infrastructure';

        const orphans = nodes.filter(n => !connectedNodes.has(n.id));

        // Remove hubs from orphans to prevent self-loops
        const trueOrphans = orphans.filter(o => o.id !== DAILY_HUB && o.id !== SYSTEM_HUB && o.id !== INFRA_HUB);

        if (trueOrphans.length === 0) {
            this.repo.deleteSelfLoops();
            this.repo.deleteDuplicateDailySystemEdges();

            result.details.push('No true orphans found — graph is clean!');
            return result;
        }

        result.details.push(`Found ${trueOrphans.length} true orphan nodes`);

        // Classify orphans STRICTLY
        const dailyOrphans = trueOrphans.filter(o => /^memory_\d{4}-\d{2}-\d{2}/.test(o.id));
        const systemOrphans = trueOrphans.filter(o => !dailyOrphans.includes(o) && (o.id.startsWith('memory_') || o.id.startsWith('service:') || o.id.startsWith('infra_')));
        const otherOrphans = trueOrphans.filter(o => !dailyOrphans.includes(o) && !systemOrphans.includes(o));

        // Create hubs if missing
        const hubDefs = [
            { id: DAILY_HUB, name: 'Diário de Memória' },
            { id: SYSTEM_HUB, name: 'Memória do Sistema' },
            { id: INFRA_HUB, name: 'Infraestrutura' },
        ];

        for (const hub of hubDefs) {
            if (!nodes.some(n => n.id === hub.id)) {
                this.mm.addNode({ id: hub.id, type: 'context', name: hub.name, content: `Hub para nós de ${hub.name}` });
                result.hubsCreated++;
                result.details.push(`Created hub: ${hub.id}`);
            }
        }

        // Connect core_identity → hubs
        if (nodes.some(n => n.id === 'core_identity')) {
            for (const hubId of [DAILY_HUB, SYSTEM_HUB, INFRA_HUB]) {
                if (!edges.some(e => e.from_node === 'core_identity' && e.to_node === hubId)) {
                    if (this.addEdgeSafe('core_identity', hubId, 'manages')) {
                        result.edgesCreated.push(`core_identity --manages--> ${hubId}`);
                    }
                }
            }
        }

        // Connect daily orphans to daily hub
        for (const o of dailyOrphans) {
            this.addEdgeSafe(DAILY_HUB, o.id, 'contains');
            result.orphansFixed++;
            result.edgesCreated.push(`${DAILY_HUB} --contains--> ${o.id}`);
        }

        // Chain daily nodes chronologically
        const sorted = [...dailyOrphans].sort((a, b) => a.id.localeCompare(b.id));
        for (let i = 0; i < sorted.length - 1; i++) {
            if (!edges.some(e => e.from_node === sorted[i].id && e.to_node === sorted[i + 1].id && e.relation === 'next')) {
                this.addEdgeSafe(sorted[i].id, sorted[i + 1].id, 'next');
                result.edgesCreated.push(`${sorted[i].id} --next--> ${sorted[i + 1].id}`);
            }
        }

        // Connect system/infra orphans
        for (const o of systemOrphans) {
            const hub = (o.id.startsWith('service:') || o.id.startsWith('infra_')) ? INFRA_HUB : SYSTEM_HUB;
            this.addEdgeSafe(hub, o.id, 'contains');
            result.orphansFixed++;
            result.edgesCreated.push(`${hub} --contains--> ${o.id}`);
        }

        // Connect other orphans by type
        for (const o of otherOrphans) {
            if (o.type === 'preference' && nodes.some(n => n.id === 'core_user')) {
                this.addEdgeSafe('core_user', o.id, 'prefers');
                result.orphansFixed++;
                result.edgesCreated.push(`core_user --prefers--> ${o.id}`);
            } else if (o.type === 'project' && nodes.some(n => n.id === 'core_user')) {
                this.addEdgeSafe('core_user', o.id, 'works_on');
                result.orphansFixed++;
                result.edgesCreated.push(`core_user --works_on--> ${o.id}`);
            } else if (o.type === 'skill') {
                this.addEdgeSafe(INFRA_HUB, o.id, 'contains');
                result.orphansFixed++;
                result.edgesCreated.push(`${INFRA_HUB} --contains--> ${o.id}`);
            } else {
                this.addEdgeSafe(SYSTEM_HUB, o.id, 'contains');
                result.orphansFixed++;
                result.edgesCreated.push(`${SYSTEM_HUB} --contains--> ${o.id}`);
            }
        }

        // Connect daily hub to first daily node
        const allDaily = nodes.filter(n => /^memory_\d{4}-\d{2}-\d{2}$/.test(n.id)).sort((a, b) => a.id.localeCompare(b.id));
        if (allDaily.length > 0 && !edges.some(e => e.from_node === DAILY_HUB && e.to_node === allDaily[0].id)) {
            this.addEdgeSafe(DAILY_HUB, allDaily[0].id, 'contains');
            result.edgesCreated.push(`${DAILY_HUB} --contains--> ${allDaily[0].id}`);
        }

        result.details.push(`Fixed ${result.orphansFixed} orphans, created ${result.hubsCreated} hubs, ${result.edgesCreated.length} edges`);

        // ── Identity Cleanup ──
        const cleanup = this.cleanupInvalidNodes();
        result.details.push(`Cleaned ${cleanup.invalidCount} invalid identity nodes`);

        // ── Temporal Decay ──
        await this.applyTemporalDecay();

        return result;
    }

    private cleanupInvalidNodes(): { invalidCount: number } {
        let invalidCount = 0;
        const forbiddenPatterns = [/se chama/i, /é o/i, /é a/i, /chamado/i, /meu nome/i, /nome é/i];

        for (const node of this.repo.getIdentityNodes()) {
            const isUnstructured = node.content.length > 80 || forbiddenPatterns.some(p => p.test(node.content));
            if (isUnstructured && node.id !== 'core_user' && node.id !== 'identity' && node.id !== 'core_agent') {
                this.repo.updateNodeWeightAndMeta(node.id, 0.2, 0.2);
                invalidCount++;
            }
        }

        for (const orphan of this.repo.getUnconnectedIdentityNodes()) {
            this.addEdgeSafe('core_user', orphan.id, 'has_identity');
        }

        return { invalidCount };
    }

    private async enforceStorageQuotas(): Promise<{ prunedTraces: number; prunedMessages: number }> {
        try {
            const prunedTraces = this.repo.pruneOldTraces(3);
            let prunedMessages = 0;

            for (const convId of this.repo.getConversationIds()) {
                prunedMessages += this.repo.pruneOldMessagesForConversation(convId, 1000);
            }

            if (prunedTraces > 0 || prunedMessages > 0) {
                log.info(`[StorageQuotas] Pruned ${prunedTraces} traces and ${prunedMessages} old messages.`);
            }

            return { prunedTraces, prunedMessages };
        } catch (error) {
            log.error('[StorageQuotas] Error:', errorMessage(error));
            return { prunedTraces: 0, prunedMessages: 0 };
        }
    }

    private async applyTemporalDecay(): Promise<{ decayed: number }> {
        try {
            this.repo.ensureEdgeLastAccessed();
            const decayed = this.repo.decayOldEdges(30, 0.98, 0.1);
            if (decayed > 0) log.info(`[TemporalDecay] ${decayed} edges decayed (×0.98)`);
            return { decayed };
        } catch (error) {
            log.error('[TemporalDecay] Error:', errorMessage(error));
            return { decayed: 0 };
        }
    }

    // ── Semantic Consolidation (non-destructive) ─────────────────────────────
    //
    // Philosophy: "lossy semantic compression with structural reversibility"
    //   - Original nodes are PRESERVED, only marked lifecycle_state = SUMMARIZED
    //   - Summary node tracks full lineage via `summarizes` edges
    //   - SUMMARIZED nodes are excluded from default retrieval but fully recoverable
    //   - Supports future: deep recall, replay cognitivo, explainability, re-summarization

    private readonly CONSOLIDATION_MIN_CONFIDENCE = 0.5;
    private readonly CONSOLIDATION_MAX_WEIGHT = 0.7;         // protect high-weight (important) nodes
    private readonly CONSOLIDATION_MIN_STALENESS_DAYS = 14;
    private readonly CONSOLIDATION_MIN_CLUSTER_SIZE = 3;
    private readonly CONSOLIDATION_SIMILARITY_THRESHOLD = 0.35;

    // Never consolidate: core identity, infra, main projects, preferences, governance
    private readonly CONSOLIDATION_PROTECTED_DOMAINS = new Set([
        'core_identity', 'user_modeling', 'governance_safety',
        'domain_infra', 'domain_projetos', 'domain_preferencias',
    ]);

    // Preferred targets: ephemeral, repetitive, operational data — looser threshold
    private readonly CONSOLIDATION_PRIORITY_DOMAINS = new Set([
        'domain_clima', 'domain_agenda',
    ]);

    /**
     * Non-destructive semantic compression.
     *
     * For each cluster of stale, low-confidence, similar nodes:
     *   1. Creates a summary node with rich lineage metadata
     *   2. Creates `summarizes` edges: summary → each original
     *   3. Sets lifecycle_state = SUMMARIZED on originals (data fully preserved)
     *
     * Safety guards:
     *   - confidence < 0.5  AND  weight < 0.7  AND  not accessed in 14+ days
     *   - never touches identity, domain, core_*, domain_*, user_identity*, protected domains
     *   - requires >= 3 similar nodes to justify consolidation
     */
    async consolidateStaleClusters(): Promise<ConsolidationResult> {
        const result: ConsolidationResult = { clustersFound: 0, nodesMarkedSummarized: 0, summariesCreated: 0 };
        const db = this.mm.getDatabase();
        const staleness = this.CONSOLIDATION_MIN_STALENESS_DAYS;

        const staleNodes = db.prepare(`
            SELECT id, name, content, type, domain, weight, confidence, last_accessed, updated_at
            FROM memory_nodes
            WHERE confidence < ?
              AND (weight IS NULL OR weight < ?)
              AND type NOT IN ('identity', 'domain', 'legacy_container')
              AND (lifecycle_state IS NULL OR lifecycle_state = 'ACTIVE')
              AND id NOT LIKE 'core_%'
              AND id NOT LIKE 'domain_%'
              AND id NOT LIKE 'user_identity%'
              AND (last_accessed IS NULL OR last_accessed < datetime('now', '-' || ? || ' days'))
              AND (updated_at IS NULL OR updated_at < datetime('now', '-' || ? || ' days'))
              AND domain IS NOT NULL AND domain != ''
              AND content IS NOT NULL AND content != ''
            ORDER BY domain, type
        `).all(
            this.CONSOLIDATION_MIN_CONFIDENCE,
            this.CONSOLIDATION_MAX_WEIGHT,
            staleness,
            staleness
        ) as NodeForConsolidation[];

        if (staleNodes.length < this.CONSOLIDATION_MIN_CLUSTER_SIZE) return result;

        // Group by (domain, type) — skip protected domains
        const groups = new Map<string, NodeForConsolidation[]>();
        for (const node of staleNodes) {
            if (this.CONSOLIDATION_PROTECTED_DOMAINS.has(node.domain)) continue;
            const key = `${node.domain}::${node.type}`;
            const group = groups.get(key) ?? [];
            group.push(node);
            groups.set(key, group);
        }

        for (const [key, nodes] of groups) {
            if (nodes.length < this.CONSOLIDATION_MIN_CLUSTER_SIZE) continue;

            const [domainId, type] = key.split('::');

            // Priority domains get looser threshold → more aggressive compression
            const threshold = this.CONSOLIDATION_PRIORITY_DOMAINS.has(domainId)
                ? this.CONSOLIDATION_SIMILARITY_THRESHOLD * 0.8
                : this.CONSOLIDATION_SIMILARITY_THRESHOLD;

            const clusters = this.findSimilarityClusters(nodes, threshold);

            for (const cluster of clusters) {
                if (cluster.length < this.CONSOLIDATION_MIN_CLUSTER_SIZE) continue;

                result.clustersFound++;

                // 1. Create summary node with lineage metadata
                const summaryNode = this.buildSummaryNode(cluster, domainId, type);
                try {
                    this.mm.addNode(summaryNode, 'consolidation');
                    this.mm.getFacade().setNodeDomain(summaryNode.id, domainId);
                    this.addEdgeSafe(domainId, summaryNode.id, 'contains');
                    result.summariesCreated++;
                } catch (e) {
                    log.warn(`[Consolidation] Failed to create summary node: ${errorMessage(e)}`);
                    continue;
                }

                // 2. Explicit lineage: summary --summarizes--> each original
                for (const node of cluster) {
                    this.addEdgeSafe(summaryNode.id, node.id, 'summarizes');
                }

                // 3. Mark originals as SUMMARIZED — data preserved, excluded from default retrieval
                for (const node of cluster) {
                    try {
                        const metaRaw = db.prepare(
                            'SELECT metadata FROM memory_nodes WHERE id = ?'
                        ).get(node.id) as { metadata: string | null } | undefined;

                        const meta: Record<string, string> = JSON.parse(metaRaw?.metadata ?? '{}');
                        meta['summarized_into'] = summaryNode.id;
                        meta['summarized_at'] = new Date().toISOString();

                        db.prepare(`
                            UPDATE memory_nodes SET lifecycle_state = 'SUMMARIZED', metadata = ? WHERE id = ?
                        `).run(JSON.stringify(meta), node.id);

                        result.nodesMarkedSummarized++;
                    } catch (e) {
                        log.warn(`[Consolidation] Failed to mark node ${node.id}: ${errorMessage(e)}`);
                    }
                }

                log.info(`[Consolidation] ${cluster.length} nodes → ${summaryNode.id} [${domainId}/${type}]`);
            }
        }

        return result;
    }

    /**
     * Union-find clustering with path compression.
     * Groups nodes where pairwise Jaccard similarity >= threshold.
     */
    private findSimilarityClusters(
        nodes: NodeForConsolidation[],
        threshold: number = this.CONSOLIDATION_SIMILARITY_THRESHOLD
    ): NodeForConsolidation[][] {
        const parent = new Map<string, string>(nodes.map(n => [n.id, n.id]));

        const find = (id: string): string => {
            if (parent.get(id) !== id) parent.set(id, find(parent.get(id)!));
            return parent.get(id)!;
        };

        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                if (this.jaccardSimilarity(nodes[i].content, nodes[j].content) >= threshold) {
                    parent.set(find(nodes[i].id), find(nodes[j].id));
                }
            }
        }

        const clusterMap = new Map<string, NodeForConsolidation[]>();
        for (const node of nodes) {
            const root = find(node.id);
            const cluster = clusterMap.get(root) ?? [];
            cluster.push(node);
            clusterMap.set(root, cluster);
        }

        return Array.from(clusterMap.values());
    }

    private buildSummaryNode(
        nodes: NodeForConsolidation[],
        domainId: string,
        type: string
    ): { id: string; type: 'fact' | 'preference' | 'skill' | 'knowledge'; name: string; content: string; confidence: number; weight: number; metadata: Record<string, string>; last_updated: string } {
        const sorted = [...nodes].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
        const domainName = getDomainById(domainId)?.name ?? domainId.replace('domain_', '').toUpperCase();

        const topContent = sorted
            .slice(0, 3)
            .map(n => (n.content || n.name || '').trim().slice(0, 120))
            .filter(Boolean)
            .join('. ');

        const avgConfidence = nodes.reduce((s, n) => s + (n.confidence ?? 0.3), 0) / nodes.length;
        const maxWeight = Math.max(...nodes.map(n => n.weight ?? 0.3));
        const semanticCoherence = this.computeSemanticCoherence(nodes);

        return {
            id: `summary_${domainId}_${type}_${Date.now()}`,
            type: (['preference', 'skill', 'knowledge'].includes(type) ? type : 'fact') as 'fact' | 'preference' | 'skill' | 'knowledge',
            name: `[Summary] ${domainName} — ${nodes.length} nós (${type})`,
            content: topContent || `Resumo semântico de ${nodes.length} registros de ${domainName}`,
            confidence: Math.round(avgConfidence * 100) / 100,
            weight: Math.round(maxWeight * 100) / 100,
            metadata: {
                summary_type: 'semantic_compression',
                source_count: String(nodes.length),
                compression_confidence: String(Math.round(avgConfidence * 100) / 100),
                semantic_coherence: String(semanticCoherence),
                generated_at: new Date().toISOString(),
                source_domain: domainId,
                source_type: type,
                source_ids: nodes.slice(0, 8).map(n => n.id).join(','),
            },
            last_updated: new Date().toISOString(),
        };
    }

    /** Average pairwise Jaccard similarity across all cluster members. */
    private computeSemanticCoherence(nodes: NodeForConsolidation[]): number {
        if (nodes.length < 2) return 1.0;
        let total = 0;
        let pairs = 0;
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                total += this.jaccardSimilarity(nodes[i].content, nodes[j].content);
                pairs++;
            }
        }
        return pairs > 0 ? Math.round((total / pairs) * 100) / 100 : 1.0;
    }

    private jaccardSimilarity(a: string, b: string): number {
        const wordsA = new Set((a ?? '').toLowerCase().split(/\s+/).filter(w => w.length > 3));
        const wordsB = new Set((b ?? '').toLowerCase().split(/\s+/).filter(w => w.length > 3));
        if (wordsA.size === 0 || wordsB.size === 0) return 0;
        const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
        const union = new Set([...wordsA, ...wordsB]).size;
        return union === 0 ? 0 : intersection / union;
    }

    startAutoCurate(intervalMs: number = 30 * 60 * 1000): void {
        if (this.intervalId) return;
        this.intervalId = setInterval(async () => {
            try {
                const result = await this.curate();
                await this.enforceStorageQuotas();
                await this.analytics.updateMetrics();
                await this.analytics.detectCommunities();

                if (Math.random() < 0.1) {
                    log.info('[MemoryCurator] Running VACUUM to reclaim disk space...');
                    this.repo.vacuum();
                }

                // Embed missing nodes (if embedding service available)
                if (this.embeddingService) {
                    const available = await this.embeddingService.isAvailable();
                    if (available) {
                        const embedded = await this.embeddingService.embedMissing(10);
                        if (embedded > 0) log.info(`[MemoryCurator] Embedded ${embedded} new nodes`);
                    }
                }

                // Non-destructive semantic consolidation
                try {
                    const consolidation = await this.consolidateStaleClusters();
                    if (consolidation.summariesCreated > 0) {
                        log.info(`[Consolidation] ${consolidation.summariesCreated} summaries, ${consolidation.nodesMarkedSummarized} nodes marked SUMMARIZED`);
                    }
                } catch (e) {
                    log.warn('[MemoryCurator] Consolidation failed:', errorMessage(e));
                }

                // Refresh domain summaries after curation
                try {
                    const refreshed = this.domainSummaryService.refreshAll();
                    if (refreshed > 0) log.info(`[MemoryCurator] Domain summaries refreshed: ${refreshed} domains`);
                } catch (e) {
                    log.warn('[MemoryCurator] Domain summary refresh failed:', errorMessage(e));
                }

                if (result.orphansFixed > 0) {
                    log.info(`[MemoryCurator] Auto-curated: ${result.details.join('; ')}`);
                }
            } catch (err) {
                log.error('[MemoryCurator] Auto-curation error:', err);
            }
        }, intervalMs);

        // Initial run (with 2s delay to let DB stabilize after startup)
        setTimeout(async () => {
            try {
                const r = await this.curate();
                await this.analytics.updateMetrics();
                this.domainSummaryService.refreshAll();
                if (r.orphansFixed > 0) log.info(`[MemoryCurator] Initial: ${r.details.join('; ')}`);
                else log.info('[MemoryCurator] Initial: graph clean, metrics updated.');
            } catch (e) {
                log.error('[MemoryCurator] Initial error:', e);
            }
        }, 2000);
    }

    stopAutoCurate(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }
}
