import { MemoryManager, MemoryNode } from './MemoryManager';

export class MemoryReconciliationEngine {
    private memory: MemoryManager;

    constructor(memory: MemoryManager) {
        this.memory = memory;
    }

    /**
     * Periodic maintenance: detect similarity and adjust weights.
     * Never deletes, only modulates weight and confidence.
     */
    reconcile(): void {
        const db = this.memory.getDatabase();
        const nodes = db.prepare('SELECT * FROM memory_nodes WHERE type IN ("preference", "fact", "skill")').all() as any[];
        
        const visited = new Set<string>();

        for (const rowA of nodes) {
            const nodeA: MemoryNode = { ...rowA, metadata: JSON.parse(rowA.metadata || "{}") };
            visited.add(nodeA.id);
            
            for (const rowB of nodes) {
                const nodeB: MemoryNode = { ...rowB, metadata: JSON.parse(rowB.metadata || "{}") };
                if (visited.has(nodeB.id)) continue;

                const similarity = this.calculateSimilarity(nodeA, nodeB);
                if (similarity > 0.75) {
                    this.resolveOverlap(nodeA, nodeB);
                }
            }
        }
    }

    private calculateSimilarity(a: MemoryNode, b: MemoryNode): number {
        const textA = (a.name + " " + a.content).toLowerCase();
        const textB = (b.name + " " + b.content).toLowerCase();
        
        const wordsA = new Set(textA.split(/\W+/).filter(w => w.length > 3));
        const wordsB = new Set(textB.split(/\W+/).filter(w => w.length > 3));
        
        if (wordsA.size === 0 || wordsB.size === 0) return 0;
        
        const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
        const union = new Set([...wordsA, ...wordsB]);
        return intersection.size / union.size;
    }

    private resolveOverlap(a: MemoryNode, b: MemoryNode): void {
        // Rule: Favor recency and existing weight.
        const dateA = new Date(a.last_updated || a.created_at || 0).getTime();
        const dateB = new Date(b.last_updated || b.created_at || 0).getTime();

        if (dateA >= dateB) {
            // A is newer or same age. Modulate B.
            this.modulateNode(b.id, -0.05, -0.02);
        } else {
            // B is newer. Modulate A.
            this.modulateNode(a.id, -0.05, -0.02);
        }
    }

    private modulateNode(nodeId: string, weightDelta: number, confidenceDelta: number): void {
        const node = this.memory.getNode(nodeId);
        if (node) {
            this.memory.addNode({
                ...node,
                weight: Math.max(0.1, (node.weight || 1.0) + weightDelta),
                confidence: Math.max(0.1, (node.confidence || 1.0) + confidenceDelta)
            });
        }
    }
}
