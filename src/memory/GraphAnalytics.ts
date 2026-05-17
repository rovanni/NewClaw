import { MemoryManager } from './MemoryManager';
import type { MemoryGraphRepository, NodeCentralityUpdate } from './MemoryGraphRepository';
import { LouvainDetector } from './LouvainDetector';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('GraphAnalytics');

export class GraphAnalytics {
    private repo: MemoryGraphRepository;

    constructor(memoryManager: MemoryManager) {
        this.repo = memoryManager.getGraphRepository();
    }

    async updateMetrics(): Promise<void> {
        try {
            // 1. Fetch current snapshot of Nodes and Edges
            const nodeIds = await this.repo.withRetry(() => this.repo.getAllNodeIds());
            const edges = await this.repo.withRetry(() => this.repo.getAllEdgesWeighted());

            if (nodeIds.length === 0) return;

            // 2. Compute Degree Centrality
            const degreeTotal: Record<string, number> = {};
            nodeIds.forEach(id => { degreeTotal[id] = 0; });
            edges.forEach(e => {
                degreeTotal[e.from_node] = (degreeTotal[e.from_node] || 0) + 1;
                degreeTotal[e.to_node] = (degreeTotal[e.to_node] || 0) + 1;
            });

            // Adjacency representations for centralities
            const adjacency: Record<string, string[]> = {};
            nodeIds.forEach(id => { adjacency[id] = []; });
            edges.forEach(e => {
                adjacency[e.from_node]?.push(e.to_node);
                adjacency[e.to_node]?.push(e.from_node);
            });

            // 3. Compute Betweenness Centrality (BFS Approximation)
            const betweenness: Record<string, number> = {};
            nodeIds.forEach(id => { betweenness[id] = 0; });

            for (const source of nodeIds) {
                const dist: Record<string, number> = {};
                const pred: Record<string, string[]> = {};
                nodeIds.forEach(id => { dist[id] = -1; pred[id] = []; });
                dist[source] = 0;
                const queue = [source];
                while (queue.length > 0) {
                    const v = queue.shift()!;
                    for (const w of (adjacency[v] || [])) {
                        if (dist[w] === -1) { dist[w] = dist[v] + 1; queue.push(w); }
                        if (dist[w] === dist[v] + 1) pred[w].push(v);
                    }
                }
                for (const n of nodeIds) {
                    if (n !== source && pred[n].length > 0) {
                        for (const p of pred[n]) {
                            betweenness[p] = (betweenness[p] || 0) + 1 / pred[n].length;
                        }
                    }
                }
            }

            // 4. Compute Closeness Centrality
            const closeness: Record<string, number> = {};
            for (const source of nodeIds) {
                const dist: Record<string, number> = {};
                nodeIds.forEach(id => { dist[id] = -1; });
                dist[source] = 0;
                const queue = [source];
                while (queue.length > 0) {
                    const v = queue.shift()!;
                    for (const w of (adjacency[v] || [])) {
                        if (dist[w] === -1) { dist[w] = dist[v] + 1; queue.push(w); }
                    }
                }
                const reachable = Object.values(dist).filter(d => d > 0);
                closeness[source] = reachable.length > 0 ? reachable.length / reachable.reduce((a, b) => a + b, 0) : 0;
            }

            // 5. Compute PageRank (Directed)
            const pagerank = this.computePageRank(nodeIds, edges, 0.85, 30);

            // 6. Bulk update centrality metrics
            const centralityUpdates: NodeCentralityUpdate[] = nodeIds.map(id => ({
                id,
                pagerank: pagerank[id] || 0.0,
                degree: degreeTotal[id] || 0,
                betweenness: betweenness[id] || 0.0,
                closeness: closeness[id] || 0.0,
            }));
            await this.repo.withRetry(() => this.repo.bulkUpdateNodeCentrality(centralityUpdates));

            // 7. Ensure node_metrics table and backfill
            this.repo.ensureNodeMetricsTable();
            this.repo.backfillNodeMetrics();
            await this.repo.withRetry(() => this.repo.bulkUpdateNodeMetricsClass(nodeIds, degreeTotal));

            log.info('metrics_updated', undefined, { nodeCount: nodeIds.length });

        } catch (error) {
            log.error('metrics_update_failed', error);
        }
    }

    private computePageRank(
        nodes: string[],
        edges: Array<{ from_node: string; to_node: string; weight: number }>,
        damping: number = 0.85,
        iterations: number = 50
    ): Record<string, number> {
        const N = nodes.length;
        if (N === 0) return {};
        
        let pr: Record<string, number> = {};
        nodes.forEach(n => pr[n] = 1 / N);

        const outgoing: Record<string, string[]> = {};
        nodes.forEach(n => outgoing[n] = []);
        edges.forEach(e => {
            if (outgoing[e.from_node]) {
                outgoing[e.from_node].push(e.to_node);
            }
        });

        for (let i = 0; i < iterations; i++) {
            const newPr: Record<string, number> = {};
            nodes.forEach(n => newPr[n] = (1 - damping) / N);

            nodes.forEach(node => {
                const outEdges = outgoing[node] || [];
                const share = pr[node] / (outEdges.length || N);

                if (outEdges.length === 0) {
                    // Node is a sink; distribute its rank to everyone
                    nodes.forEach(n => newPr[n] += damping * share);
                } else {
                    outEdges.forEach(dest => {
                        if (newPr[dest] !== undefined) {
                            newPr[dest] += damping * share;
                        }
                    });
                }
            });

            pr = newPr;
        }

        return pr;
    }

    /**
     * Detect communities using Louvain algorithm and persist community_id
     */
    async detectCommunities(): Promise<{ communityCount: number; updated: number }> {
        try {
            this.repo.addColumnIfNotExists('memory_nodes', 'community_id', 'INTEGER DEFAULT 0');

            const nodeIds = this.repo.getAllNodeIds();
            const edges = this.repo.getAllEdgesWeighted();

            if (nodeIds.length === 0) return { communityCount: 0, updated: 0 };

            const detector = new LouvainDetector(
                nodeIds,
                edges.map(e => ({ from: e.from_node, to: e.to_node, weight: e.weight }))
            );

            const communities = detector.detect();
            const summary = detector.summarize(communities);

            await this.repo.withRetry(() => this.repo.updateNodeCommunityIds(communities));

            log.info('communities_detected', undefined, { communityCount: summary.communityCount, nodeCount: nodeIds.length });
            return { communityCount: summary.communityCount, updated: nodeIds.length };
        } catch (error) {
            log.error('community_detection_failed', error);
            return { communityCount: 0, updated: 0 };
        }
    }
}
