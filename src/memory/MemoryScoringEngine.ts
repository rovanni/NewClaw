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
     * Increase weight/confidence for a node due to interaction.
     * Implements diminishing returns: growth slows down as it approaches 1.0.
     */
    boostNode(nodeId: string, importance: number = 0.05): void {
        const node = this.memory.getNode(nodeId);
        if (!node) return;

        // Diminishing returns formula
        const weightDelta = importance * (1 - (node.weight || 0.5));
        const confidenceDelta = 0.02 * (1 - (node.confidence || 0.5));

        const newWeight = Math.min(1.0, (node.weight || 0.5) + weightDelta);
        const newConfidence = Math.min(1.0, (node.confidence || 0.5) + confidenceDelta);

        this.memory.addNode({
            ...node,
            weight: Number(newWeight.toFixed(4)),
            confidence: Number(newConfidence.toFixed(4)),
            last_updated: new Date().toISOString()
        });
    }

    /**
     * Set explicit confidence for a node (e.g. from onboarding or user correction).
     * This is "validated" confidence.
     */
    setConfidence(nodeId: string, confidence: number): void {
        const node = this.memory.getNode(nodeId);
        if (!node) return;

        this.memory.addNode({
            ...node,
            confidence: Math.max(0, Math.min(1.0, confidence)),
            last_updated: new Date().toISOString()
        });
    }

    /**
     * Auto-score nodes based on their type and content.
     */
    autoScoreNodes(): void {
        const db = this.memory.getDatabase();
        
        // Identity nodes have full confidence
        db.prepare("UPDATE memory_nodes SET weight = 1.0, confidence = 1.0 WHERE type = 'identity'").run();
        
        // Preferences start with high but not absolute confidence
        db.prepare("UPDATE memory_nodes SET confidence = 0.85 WHERE type = 'preference' AND confidence < 0.85").run();
    }

    /**
     * Calibrate confidence based on interaction success or consistency signal.
     * Implements controlled growth and conflict penalties.
     */
    calibrate(nodeId: string, signal: 'consistent' | 'contradictory' | 'neutral'): void {
        const node = this.memory.getNode(nodeId);
        if (!node) return;

        const baseDelta = 0.03;
        let currentConfidence = node.confidence ?? 0.5;

        switch (signal) {
            case 'consistent':
                // Growth with diminishing returns
                currentConfidence += baseDelta * (1 - currentConfidence);
                break;
            case 'contradictory':
                // Linear penalty for contradiction (more aggressive than growth)
                currentConfidence -= baseDelta * 1.5;
                break;
            case 'neutral':
                break;
        }

        this.memory.addNode({
            ...node,
            confidence: Math.max(0.1, Math.min(1.0, currentConfidence)),
            last_updated: new Date().toISOString()
        });
    }
}
