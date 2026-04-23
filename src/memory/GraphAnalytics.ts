import { MemoryManager } from './MemoryManager';
import { LouvainDetector } from './LouvainDetector';

export class GraphAnalytics {
    private mm: MemoryManager;

    constructor(memoryManager: MemoryManager) {
        this.mm = memoryManager;
    }

    async updateMetrics(): Promise<void> {
        try {
            const db = (this.mm as any).db;
            if (!db) throw new Error('Database not initialized');

            // 1. Fetch current snapshot of Nodes and Edges
            const nodes: Array<{ id: string }> = db.prepare('SELECT id FROM memory_nodes').all();
            const edges: Array<{ from_node: string; to_node: string; weight: number }> = db.prepare('SELECT from_node, to_node, weight FROM memory_edges').all();

            if (nodes.length === 0) return;

            // 2. Compute Degree Centrality
            const degreeTotal: Record<string, number> = {};
            nodes.forEach(n => degreeTotal[n.id] = 0);
            edges.forEach(e => {
                degreeTotal[e.from_node] = (degreeTotal[e.from_node] || 0) + 1;
                degreeTotal[e.to_node] = (degreeTotal[e.to_node] || 0) + 1;
            });

            // Adjacency representations for centralities
            const adjacency: Record<string, string[]> = {};
            nodes.forEach(n => adjacency[n.id] = []);
            edges.forEach(e => {
                adjacency[e.from_node]?.push(e.to_node);
                adjacency[e.to_node]?.push(e.from_node); // treat as undirected for traditional betweenness/closeness scaling
            });

            // 3. Compute Betweenness Centrality (BFS Approximation)
            const betweenness: Record<string, number> = {};
            nodes.forEach(n => betweenness[n.id] = 0);

            for (const source of nodes.map(n => n.id)) {
                const dist: Record<string, number> = {};
                const pred: Record<string, string[]> = {};
                nodes.forEach(n => { dist[n.id] = -1; pred[n.id] = []; });
                dist[source] = 0;
                const queue = [source];
                while (queue.length > 0) {
                    const v = queue.shift()!;
                    for (const w of (adjacency[v] || [])) {
                        if (dist[w] === -1) { dist[w] = dist[v] + 1; queue.push(w); }
                        if (dist[w] === dist[v] + 1) pred[w].push(v);
                    }
                }
                for (const n of nodes.map(n => n.id)) {
                    if (n !== source && pred[n].length > 0) {
                        for (const p of pred[n]) {
                            betweenness[p] = (betweenness[p] || 0) + 1 / pred[n].length;
                        }
                    }
                }
            }

            // 4. Compute Closeness Centrality
            const closeness: Record<string, number> = {};
            for (const source of nodes.map(n => n.id)) {
                const dist: Record<string, number> = {};
                nodes.forEach(n => dist[n.id] = -1);
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
            const pagerank = this.computePageRank(nodes.map(n => n.id), edges, 0.85, 30);

            // 6. DB Bulk Update using a Transaction
            const updateStmt = db.prepare(`
                UPDATE memory_nodes
                SET pagerank = ?, degree = ?, betweenness = ?, closeness = ?
                WHERE id = ?
            `);

            const transaction = db.transaction((nodesList: string[]) => {
                for (const id of nodesList) {
                    const p = pagerank[id] || 0.0;
                    const d = degreeTotal[id] || 0;
                    const b = betweenness[id] || 0.0;
                    const c = closeness[id] || 0.0;
                    
                    // Normalize float bounds to handle UI constraints
                    updateStmt.run(
                        Number(p.toFixed(6)),
                        d,
                        Number(b.toFixed(6)),
                        Number(c.toFixed(6)),
                        id
                    );
                }
            });

            transaction(nodes.map(n => n.id));
            console.log(`[GraphAnalytics] Successfully updated centralities for ${nodes.length} nodes.`);

        } catch (error: any) {
            console.error(`[GraphAnalytics] Failed to update metrics:`, error.message);
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
            const db = (this.mm as any).db;
            if (!db) throw new Error('Database not initialized');

            // Add community_id column if not exists
            try { db.exec('ALTER TABLE memory_nodes ADD COLUMN community_id INTEGER DEFAULT 0'); } catch { /* exists */ }

            const nodes: Array<{ id: string }> = db.prepare('SELECT id FROM memory_nodes').all();
            const edges: Array<{ from_node: string; to_node: string; weight: number }> = db.prepare('SELECT from_node, to_node, weight FROM memory_edges').all();

            if (nodes.length === 0) return { communityCount: 0, updated: 0 };

            const detector = new LouvainDetector(
                nodes.map(n => n.id),
                edges.map(e => ({ from: e.from_node, to: e.to_node, weight: e.weight }))
            );

            const communities = detector.detect();
            const summary = detector.summarize(communities);

            // Persist community_id
            const updateStmt = db.prepare('UPDATE memory_nodes SET community_id = ? WHERE id = ?');
            const transaction = db.transaction((assignments: Map<string, number>) => {
                for (const [nodeId, cId] of assignments) {
                    updateStmt.run(cId, nodeId);
                }
            });
            transaction(communities);

            console.log(`[Louvain] ${summary.communityCount} communities detected across ${nodes.length} nodes`);
            return { communityCount: summary.communityCount, updated: nodes.length };
        } catch (error: any) {
            console.error(`[Louvain] Failed:`, error.message);
            return { communityCount: 0, updated: 0 };
        }
    }
}
