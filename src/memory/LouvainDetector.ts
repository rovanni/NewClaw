/**
 * Louvain Community Detection — Pure TypeScript implementation
 *
 * Detects communities in the memory graph using the Louvain algorithm.
 * No external dependencies required.
 */

interface Graph {
    nodes: Set<string>;
    adj: Map<string, Map<string, number>>; // node -> { neighbor -> weight }
}

export class LouvainDetector {
    private graph: Graph;

    constructor(nodes: string[], edges: Array<{ from: string; to: string; weight: number }>) {
        this.graph = { nodes: new Set(nodes), adj: new Map() };
        for (const node of nodes) {
            this.graph.adj.set(node, new Map());
        }
        for (const edge of edges) {
            // Undirected: add both directions
            const existing = this.graph.adj.get(edge.from);
            if (existing) existing.set(edge.to, (existing.get(edge.to) || 0) + edge.weight);
            const existing2 = this.graph.adj.get(edge.to);
            if (existing2) existing2.set(edge.from, (existing2.get(edge.from) || 0) + edge.weight);
        }
    }

    /**
     * Run Louvain algorithm and return community assignments
     */
    detect(maxIterations: number = 20): Map<string, number> {
        const community = new Map<string, number>();
        let id = 0;
        for (const node of this.graph.nodes) {
            community.set(node, id++);
        }

        // Total edge weight
        let m = 0;
        for (const [, neighbors] of this.graph.adj) {
            for (const [, w] of neighbors) m += w;
        }
        m /= 2;
        if (m === 0) return community;

        // Node degrees
        const degree = new Map<string, number>();
        for (const [node, neighbors] of this.graph.adj) {
            let sum = 0;
            for (const [, w] of neighbors) sum += w;
            degree.set(node, sum);
        }

        let improved = true;
        let iteration = 0;

        while (improved && iteration < maxIterations) {
            improved = false;
            iteration++;

            for (const node of this.graph.nodes) {
                const currentCommunity = community.get(node)!;
                const neighbors = this.graph.adj.get(node);
                if (!neighbors || neighbors.size === 0) continue;

                // Sum of weights to each neighboring community
                const communityWeights = new Map<number, number>();
                for (const [neighbor, weight] of neighbors) {
                    const nc = community.get(neighbor)!;
                    communityWeights.set(nc, (communityWeights.get(nc) || 0) + weight);
                }

                // Best community = max modularity gain
                let bestCommunity = currentCommunity;
                let bestGain = 0;
                const ki = degree.get(node)!;

                for (const [c, sigmaIn] of communityWeights) {
                    if (c === currentCommunity) continue;
                    // Sum of degrees in community c
                    let sigmaTot = 0;
                    for (const [n, comm] of community) {
                        if (comm === c) sigmaTot += degree.get(n)!;
                    }
                    const delta = sigmaIn / m - (sigmaTot * ki) / (2 * m * m);
                    if (delta > bestGain) {
                        bestGain = delta;
                        bestCommunity = c;
                    }
                }

                if (bestCommunity !== currentCommunity) {
                    community.set(node, bestCommunity);
                    improved = true;
                }
            }
        }

        // Renumber communities sequentially
        const mapping = new Map<number, number>();
        let nextId = 0;
        const result = new Map<string, number>();
        for (const [node, c] of community) {
            if (!mapping.has(c)) mapping.set(c, nextId++);
            result.set(node, mapping.get(c)!);
        }

        return result;
    }

    /**
     * Get community summary
     */
    summarize(communities: Map<string, number>): { communityCount: number; communities: Map<number, string[]> } {
        const groups = new Map<number, string[]>();
        for (const [node, c] of communities) {
            if (!groups.has(c)) groups.set(c, []);
            groups.get(c)!.push(node);
        }
        return { communityCount: groups.size, communities: groups };
    }
}