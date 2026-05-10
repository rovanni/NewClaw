import { MemoryManager } from './MemoryManager';
import type { MemoryFacade } from './MemoryFacade';

export class MemoryScoringEngine {
    private memory: MemoryManager;
    private memoryFacade: MemoryFacade;

    constructor(memory: MemoryManager) {
        this.memory = memory;
        this.memoryFacade = memory.getFacade();
    }

    /**
     * Apply decay to all nodes. 
     * Older nodes that haven't been updated lose weight.
     */
    applyDecay(): void {
        this.memoryFacade.applyNodeDecay();
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
        this.memoryFacade.autoScoreNodes();
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
