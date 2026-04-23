import { MemoryManager, MemoryNode } from './MemoryManager';

export class MemoryScoringEngine {
    private memory: MemoryManager;

    constructor(memory: MemoryManager) {
        this.memory = memory;
    }

    /**
     * Apply decay to all nodes. 
     * Older nodes that haven't been updated lose weight.
     */
    applyDecay(): void {
        const db = this.memory.getDatabase();
        // Decay formula: weight = weight * 0.99 for nodes not updated in the last 24h
        // Using SQLite datetime function
        db.prepare(`
            UPDATE memory_nodes 
            SET weight = weight * 0.99 
            WHERE last_updated < datetime('now', '-1 day')
            AND id NOT LIKE 'core_%' 
            AND id NOT IN ('identity', 'agent_state', 'core_user', 'system_reflection')
        `).run();
    }

    /**
     * Increase weight/confidence for a node due to interaction
     */
    boostNode(nodeId: string, importance: number = 0.1): void {
        const node = this.memory.getNode(nodeId);
        if (!node) return;

        const newWeight = Math.min(1.0, (node.weight || 1.0) + importance);
        const newConfidence = Math.min(1.0, (node.confidence || 1.0) + 0.05);

        this.memory.addNode({
            ...node,
            weight: newWeight,
            confidence: newConfidence,
            last_updated: new Date().toISOString()
        });
    }

    /**
     * Set explicit confidence for a node (e.g. from onboarding or user correction)
     */
    setConfidence(nodeId: string, confidence: number): void {
        const node = this.memory.getNode(nodeId);
        if (!node) return;

        this.memory.addNode({
            ...node,
            confidence: confidence,
            last_updated: new Date().toISOString()
        });
    }

    /**
     * Auto-score nodes based on their type and content
     */
    autoScoreNodes(): void {
        const db = this.memory.getDatabase();
        
        // Identity nodes usually have high importance
        db.prepare("UPDATE memory_nodes SET weight = 1.0, confidence = 1.0 WHERE type = 'identity'").run();
        
        // Preferences from user profile should have high confidence
        db.prepare("UPDATE memory_nodes SET confidence = 0.9 WHERE type = 'preference'").run();
    }
}
