/**
 * MemoryGovernor — Proactive memory governance engine
 * 
 * Implements the "system that unlearns" principle:
 * 1. Confidence decay (time-based + access-based)
 * 2. Conflict detection between facts
 * 3. Semantic garbage collection
 * 4. Usage feedback (reinforce useful, decay unused)
 * 5. Source classification (explicit vs inferred)
 */

import { MemoryManager, MemoryNode } from './MemoryManager';

export interface GovernorConfig {
    /** Confidence decay factor per day (e.g., 0.98 = 2% decay per day) */
    decayFactor: number;
    /** Minimum confidence before a node is garbage collected */
    minConfidence: number;
    /** Days without access before decay acceleration kicks in */
    staleAfterDays: number;
    /** Confidence boost when a fact is used in context and helps */
    usefulBoost: number;
    /** Confidence penalty when a fact is retrieved but not helpful */
    notUsefulPenalty: number;
    /** Maximum confidence ceiling — prevents runaway reinforcement loops */
    maxConfidence: number;
    /** Diminishing returns: each subsequent reinforcement gives less boost */
    diminishingReturns: boolean;
    /** Source types that are stronger */
    sourceWeights: Record<FactSource, number>;
    /** Node IDs that are protected from decay and GC */
    protectedNodes: string[];
    /** Archive instead of delete */
    archiveEnabled: boolean;
}

export type FactSource = 'explicit' | 'inferred' | 'system';

export type ConflictType = 'replace' | 'coexist' | 'uncertain';

export interface ConflictResult {
    nodeA: MemoryNode;
    nodeB: MemoryNode;
    conflictType: 'contradiction' | 'overlap' | 'duplicate';
    classification: ConflictType;
    resolution: 'replace' | 'reduce_confidence' | 'keep_both' | 'merge' | 'archive_older' | 'flag_uncertain';
    message: string;
}

export interface GovernorStats {
    nodesInspected: number;
    nodesDecayed: number;
    nodesGarbageCollected: number;
    nodesArchived: number;
    conflictsDetected: number;
    conflictsResolved: number;
    factsReinforced: number;
    factsPenalized: number;
}

const DEFAULT_CONFIG: GovernorConfig = {
    decayFactor: 0.98,
    minConfidence: 0.3,
    staleAfterDays: 7,
    usefulBoost: 0.05,
    notUsefulPenalty: 0.02,
    maxConfidence: 0.95,
    diminishingReturns: true,
    sourceWeights: {
        explicit: 1.0,
        inferred: 0.6,
        system: 0.8
    },
    protectedNodes: ['core_user', 'user_identity'],
    archiveEnabled: true
};

export class MemoryGovernor {
    private memory: MemoryManager;
    private config: GovernorConfig;
    private lastRun: Date | null = null;
    private accessLog: Map<string, { count: number; lastAccessed: Date; wasHelpful: boolean }> = new Map();

    constructor(memory: MemoryManager, config?: Partial<GovernorConfig>) {
        this.memory = memory;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    // ========================================================================
    // 1. CONFIDENCE DECAY
    // ========================================================================

    /**
     * Apply time-based confidence decay to all nodes.
     * Should run periodically (e.g., daily or on boot).
     * 
     * Rules:
     * - confidence *= decayFactor for each day since last update
     * - Extra decay if not accessed in staleAfterDays
     * - source type affects decay rate (inferred decays faster)
     */
    decayAllConfidences(): { decayed: number; total: number } {
        const now = new Date();
        let decayed = 0;
        const allNodes = this.getAllNodes();
        const total = allNodes.length;

        for (const node of allNodes) {
            // Skip protected nodes
            if (node.type === 'identity' || this.config.protectedNodes.includes(node.id)) continue;

            const lastUpdated = node.last_updated ? new Date(node.last_updated) : (node.created_at ? new Date(node.created_at) : now);
            const daysSinceUpdate = Math.max(0, (now.getTime() - lastUpdated.getTime()) / (1000 * 60 * 60 * 24));

            if (daysSinceUpdate < 1) continue; // Don't decay very recent nodes

            // Get source classification from metadata
            const source: FactSource = (node.metadata?.source as FactSource) || 'inferred';
            const sourceWeight = this.config.sourceWeights[source] || 0.6;

            // Base decay: confidence * decayFactor^days * sourceWeight
            let newConfidence = (node.confidence || 1.0) * Math.pow(this.config.decayFactor, daysSinceUpdate);

            // Accelerated decay for stale nodes (not accessed recently)
            const accessInfo = this.accessLog.get(node.id);
            if (!accessInfo && daysSinceUpdate > this.config.staleAfterDays) {
                // Not accessed at all — extra 50% decay
                newConfidence *= 0.5;
            } else if (accessInfo) {
                const daysSinceAccess = (now.getTime() - accessInfo.lastAccessed.getTime()) / (1000 * 60 * 60 * 24);
                if (daysSinceAccess > this.config.staleAfterDays) {
                    newConfidence *= 0.7;
                }
            }

            // Inferred facts decay faster
            if (source === 'inferred') {
                newConfidence *= 0.95;
            }

            // Clamp to [0, 1]
            newConfidence = Math.max(0, Math.min(1, newConfidence));

            // Only update if significant change
            if (Math.abs(newConfidence - (node.confidence || 1.0)) > 0.01) {
                this.memory.addNode({
                    ...node,
                    confidence: newConfidence,
                    weight: node.weight || 1.0,
                    last_updated: now.toISOString()
                });
                decayed++;
            }
        }

        this.lastRun = now;
        console.log(`[GOVERNOR] Confidence decay: ${decayed}/${total} nodes affected`);
        return { decayed, total };
    }

    // ========================================================================
    // 2. CONFLICT DETECTION
    // ========================================================================

    /**
     * Detect conflicts between facts in the graph.
     * 
     * Types:
     * - contradiction: same domain, opposite values (e.g., "prefiro Python" vs "prefiro C#")
     * - overlap: same domain, similar but different values
     * - duplicate: near-identical content
     */
    detectConflicts(): ConflictResult[] {
        const conflicts: ConflictResult[] = [];
        const allNodes = this.getAllNodes();

        // Group by type for comparison
        const byType = new Map<string, MemoryNode[]>();
        for (const node of allNodes) {
            const group = byType.get(node.type) || [];
            group.push(node);
            byType.set(node.type, group);
        }

        // Check for conflicts within each type
        for (const [type, nodes] of byType) {
            if (type === 'identity') continue; // Identity conflicts are special

            for (let i = 0; i < nodes.length; i++) {
                for (let j = i + 1; j < nodes.length; j++) {
                    const a = nodes[i];
                    const b = nodes[j];
                    const conflict = this.analyzeConflict(a, b);
                    if (conflict) {
                        conflicts.push(conflict);
                    }
                }
            }
        }

        console.log(`[GOVERNOR] Conflict detection: ${conflicts.length} conflicts found`);
        return conflicts;
    }

    private analyzeConflict(a: MemoryNode, b: MemoryNode): ConflictResult | null {
        // Check for same-domain preferences (contradiction)
        if (a.type === 'preference' && b.type === 'preference') {
            const domainA = this.extractDomain(a.name, a.content);
            const domainB = this.extractDomain(b.name, b.content);
            if (domainA && domainB && domainA === domainB) {
                // Same domain — check if values differ
                const valueA = this.extractValue(a.content);
                const valueB = this.extractValue(b.content);
                if (valueA && valueB && valueA !== valueB) {
                    // Classify conflict
                    const sourceA = (a.metadata?.source as FactSource) || 'inferred';
                    const sourceB = (b.metadata?.source as FactSource) || 'inferred';
                    const confA = a.confidence || 0.5;
                    const confB = b.confidence || 0.5;
                    const timeA = a.last_updated || a.created_at || '';
                    const timeB = b.last_updated || b.created_at || '';

                    let classification: ConflictType;
                    let resolution: ConflictResult['resolution'];

                    // Both explicit = genuine preference change → coexist
                    if (sourceA === 'explicit' && sourceB === 'explicit') {
                        classification = 'coexist';
                        resolution = 'keep_both';
                    }
                    // One explicit, one inferred = replace the inferred
                    else if (sourceA === 'explicit' || sourceB === 'explicit') {
                        classification = 'replace';
                        resolution = 'replace';
                    }
                    // Both inferred, similar confidence = uncertain
                    else if (Math.abs(confA - confB) < 0.2) {
                        classification = 'uncertain';
                        resolution = 'reduce_confidence';
                    }
                    // One clearly stronger = replace
                    else {
                        classification = 'replace';
                        resolution = 'replace';
                    }

                    return {
                        nodeA: a,
                        nodeB: b,
                        conflictType: 'contradiction',
                        classification,
                        resolution,
                        message: `Conflito de preferência: "${a.content}" vs "${b.content}" (${domainA}) [${classification}]`
                    };
                }
            }
        }

        // Check for duplicates (near-identical content)
        if (a.type === b.type && this.similarity(a.content, b.content) > 0.85) {
            return {
                nodeA: a,
                nodeB: b,
                conflictType: 'duplicate',
                classification: 'replace',
                resolution: 'merge',
                message: `Duplicata: "${a.name}" ≈ "${b.name}"`
            };
        }

        return null;
    }

    private extractDomain(name: string, content: string): string | null {
        // Extract preference domain: pref_python → python, "Prefiro Python" → language
        const nameMatch = name.match(/^pref_(\w+)/);
        if (nameMatch) return nameMatch[1];
        const contentMatch = content.toLowerCase();
        if (contentMatch.includes('linguagem') || contentMatch.includes('language')) return 'language';
        if (contentMatch.includes('framework') || contentMatch.includes('biblioteca')) return 'framework';
        if (contentMatch.includes('editor') || contentMatch.includes('ide')) return 'editor';
        if (contentMatch.includes('sistema') || contentMatch.includes('os')) return 'os';
        return name.replace(/^pref_/, '').split('_')[0] || null;
    }

    private extractValue(content: string): string | null {
        const match = content.match(/:\s*(.+)/);
        return match ? match[1].trim().toLowerCase() : null;
    }

    private similarity(a: string, b: string): number {
        // Simple Jaccard similarity on words
        const wordsA = new Set(a.toLowerCase().split(/\s+/));
        const wordsB = new Set(b.toLowerCase().split(/\s+/));
        const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
        const union = new Set([...wordsA, ...wordsB]);
        return union.size === 0 ? 0 : intersection.size / union.size;
    }

    /**
     * Resolve detected conflicts automatically.
     */
    resolveConflicts(conflicts: ConflictResult[]): { resolved: number; unresolved: number; archived: number } {
        let resolved = 0;
        let unresolved = 0;
        let archived = 0;

        for (const conflict of conflicts) {
            switch (conflict.resolution) {
                case 'replace': {
                    // Keep the higher-confidence one, archive the other
                    const [keep, remove] = (conflict.nodeA.confidence || 0) >= (conflict.nodeB.confidence || 0)
                        ? [conflict.nodeA, conflict.nodeB]
                        : [conflict.nodeB, conflict.nodeA];
                    
                    if (this.config.archiveEnabled) {
                        // Archive instead of delete
                        this.archiveNode(remove);
                        archived++;
                    } else {
                        // Just reduce confidence
                        this.memory.addNode({
                            ...remove,
                            confidence: Math.max(this.config.minConfidence, (remove.confidence || 0.5) * 0.5),
                            weight: (remove.weight || 1.0) * 0.5,
                            last_updated: new Date().toISOString(),
                            metadata: { ...remove.metadata, conflict_reduced: 'true' }
                        });
                    }
                    // Boost the kept one
                    this.memory.addNode({
                        ...keep,
                        confidence: Math.min(this.config.maxConfidence, (keep.confidence || 0.5) + 0.05),
                        last_updated: new Date().toISOString()
                    });
                    resolved++;
                    break;
                }
                case 'reduce_confidence': {
                    // Reduce confidence of both
                    for (const node of [conflict.nodeA, conflict.nodeB]) {
                        this.memory.addNode({
                            ...node,
                            confidence: Math.max(this.config.minConfidence, (node.confidence || 0.5) * 0.8),
                            weight: (node.weight || 1.0) * 0.8,
                            last_updated: new Date().toISOString(),
                            metadata: { ...node.metadata, conflict_detected: 'true' }
                        });
                    }
                    resolved++;
                    break;
                }
                case 'merge': {
                    // Keep the one with higher confidence, archive the other
                    const [keep, remove] = (conflict.nodeA.confidence || 0) >= (conflict.nodeB.confidence || 0)
                        ? [conflict.nodeA, conflict.nodeB]
                        : [conflict.nodeB, conflict.nodeA];
                    // Boost the kept one
                    this.memory.addNode({
                        ...keep,
                        confidence: Math.min(this.config.maxConfidence, (keep.confidence || 0.5) + 0.1),
                        weight: (keep.weight || 1.0) + 0.1,
                        last_updated: new Date().toISOString()
                    });
                    // Archive the duplicate
                    this.archiveNode(remove);
                    archived++;
                    resolved++;
                    break;
                }
                case 'keep_both':
                    // Both explicit — genuine preference change, coexist
                    // Slightly reduce both to signal uncertainty
                    for (const node of [conflict.nodeA, conflict.nodeB]) {
                        this.memory.addNode({
                            ...node,
                            confidence: Math.max(this.config.minConfidence, (node.confidence || 0.5) * 0.95),
                            metadata: { ...node.metadata, conflict_flag: 'explicit_both', coexists_with: conflict.nodeA.id === node.id ? conflict.nodeB.id : conflict.nodeA.id }
                        });
                    }
                    unresolved++;
                    break;
                case 'flag_uncertain':
                    // Both inferred with similar confidence — flag for review
                    for (const node of [conflict.nodeA, conflict.nodeB]) {
                        this.memory.addNode({
                            ...node,
                            metadata: { ...node.metadata, conflict_flag: 'uncertain', needs_review: 'true' }
                        });
                    }
                    unresolved++;
                    break;
                case 'archive_older':
                    // Archive the older one
                    const [newer, older] = (conflict.nodeA.last_updated || '') >= (conflict.nodeB.last_updated || '')
                        ? [conflict.nodeA, conflict.nodeB]
                        : [conflict.nodeB, conflict.nodeA];
                    this.archiveNode(older);
                    archived++;
                    resolved++;
                    break;
            }
        }

        console.log(`[GOVERNOR] Conflict resolution: ${resolved} resolved, ${unresolved} unresolved, ${archived} archived`);
        return { resolved, unresolved, archived };
    }

    // ========================================================================
    // 3. SEMANTIC GARBAGE COLLECTION
    // ========================================================================

    /**
     * Remove nodes below minimum confidence, never accessed, or redundant.
     */
    garbageCollect(): { removed: number; archived: number; inspected: number } {
        const allNodes = this.getAllNodes();
        let removed = 0;
        let archived = 0;
        const now = new Date();

        for (const node of allNodes) {
            // Never garbage collect protected nodes
            if (node.type === 'identity' || this.config.protectedNodes.includes(node.id)) continue;

            const confidence = node.confidence ?? 1.0;
            const weight = node.weight ?? 1.0;
            const lastUpdated = node.last_updated ? new Date(node.last_updated) : new Date(node.created_at || now);

            // Rule 1: Below minimum confidence
            if (confidence < this.config.minConfidence) {
                if (this.config.archiveEnabled) {
                    this.archiveNode(node);
                    archived++;
                } else {
                    this.removeNode(node.id);
                    removed++;
                }
                continue;
            }

            // Rule 2: Weight below 0.1 and stale
            const daysSinceUpdate = (now.getTime() - lastUpdated.getTime()) / (1000 * 60 * 60 * 24);
            if (weight < 0.1 && daysSinceUpdate > 30) {
                if (this.config.archiveEnabled) {
                    this.archiveNode(node);
                    archived++;
                } else {
                    this.removeNode(node.id);
                    removed++;
                }
                continue;
            }

            // Rule 3: Confidence below 0.5 AND never accessed AND old
            const accessInfo = this.accessLog.get(node.id);
            if (confidence < 0.5 && !accessInfo && daysSinceUpdate > 14) {
                if (this.config.archiveEnabled) {
                    this.archiveNode(node);
                    archived++;
                } else {
                    this.removeNode(node.id);
                    removed++;
                }
                continue;
            }
        }

        console.log(`[GOVERNOR] Garbage collection: ${removed} removed, ${archived} archived, ${allNodes.length} inspected`);
        return { removed, archived, inspected: allNodes.length };
    }

    // ========================================================================
    // 4. USAGE FEEDBACK
    // ========================================================================

    /**
     * Record that a fact was used in context (and whether it was helpful).
     * This implements utility-based memory reinforcement.
     */
    recordUsage(nodeId: string, wasHelpful: boolean): void {
        const existing = this.accessLog.get(nodeId) || { count: 0, lastAccessed: new Date(), wasHelpful: false };
        existing.count++;
        existing.lastAccessed = new Date();
        existing.wasHelpful = wasHelpful;
        this.accessLog.set(nodeId, existing);

        // Apply feedback immediately
        const node = this.memory.getNode(nodeId);
        if (!node) return;

        // Skip protected nodes — they stay at max
        if (this.config.protectedNodes.includes(node.id)) return;

        if (wasHelpful) {
            // Anti-loop: diminishing returns on reinforcement
            // 1st boost: 100%, 2nd: 75%, 3rd: 56%, 4th: 42%, etc.
            const boostMultiplier = this.config.diminishingReturns
                ? Math.pow(0.75, Math.min(existing.count - 1, 10))
                : 1.0;
            const boost = this.config.usefulBoost * boostMultiplier;

            // Anti-loop: cap at maxConfidence ceiling
            const newConfidence = Math.min(this.config.maxConfidence, (node.confidence || 0.5) + boost);
            const newWeight = Math.min(3.0, (node.weight || 1.0) + 0.1 * boostMultiplier);
            this.memory.addNode({
                ...node,
                confidence: newConfidence,
                weight: newWeight,
                last_updated: new Date().toISOString()
            });
        } else {
            // Small penalty for unhelpful facts
            const newConfidence = Math.max(this.config.minConfidence, (node.confidence || 0.5) - this.config.notUsefulPenalty);
            this.memory.addNode({
                ...node,
                confidence: newConfidence,
                last_updated: new Date().toISOString()
            });
        }
    }

    /**
     * Mark a fact's source as explicit (user stated it directly).
     * Explicit facts decay slower and have higher initial confidence.
     */
    markAsExplicit(nodeId: string): void {
        const node = this.memory.getNode(nodeId);
        if (!node) return;

        this.memory.addNode({
            ...node,
            confidence: Math.min(1.0, (node.confidence || 0.5) + 0.2),
            metadata: { ...node.metadata, source: 'explicit' },
            last_updated: new Date().toISOString()
        });
    }

    /**
     * Mark a fact's source as inferred (derived from context).
     * Inferred facts decay faster and start with lower confidence.
     */
    markAsInferred(nodeId: string): void {
        const node = this.memory.getNode(nodeId);
        if (!node) return;

        this.memory.addNode({
            ...node,
            metadata: { ...node.metadata, source: 'inferred' },
            last_updated: new Date().toISOString()
        });
    }

    // ========================================================================
    // 5. FULL GOVERNANCE CYCLE
    // ========================================================================

    /**
     * Run the full governance cycle: decay → conflict → GC → stats.
     * Should be called periodically (e.g., on boot or every 24h).
     */
    runGovernanceCycle(): GovernorStats {
        console.log('[GOVERNOR] Starting governance cycle...');

        // Step 1: Decay all confidences
        const decayResult = this.decayAllConfidences();

        // Step 2: Detect and resolve conflicts
        const conflicts = this.detectConflicts();
        const resolution = this.resolveConflicts(conflicts);

        // Step 3: Garbage collect
        const gcResult = this.garbageCollect();

        const stats: GovernorStats = {
            nodesInspected: decayResult.total,
            nodesDecayed: decayResult.decayed,
            nodesGarbageCollected: gcResult.removed,
            nodesArchived: gcResult.archived,
            conflictsDetected: conflicts.length,
            conflictsResolved: resolution.resolved,
            factsReinforced: Array.from(this.accessLog.values()).filter(a => a.wasHelpful).length,
            factsPenalized: Array.from(this.accessLog.values()).filter(a => !a.wasHelpful).length
        };

        console.log(`[GOVERNOR] Cycle complete: ${JSON.stringify(stats)}`);
        return stats;
    }

    /**
     * Get stats about memory health.
     */
    getHealthReport(): { totalNodes: number; avgConfidence: number; lowConfidence: number; bySource: Record<string, number>; staleNodes: number } {
        const allNodes = this.getAllNodes();
        const now = new Date();
        const staleThreshold = this.config.staleAfterDays * 24 * 60 * 60 * 1000;

        let totalConfidence = 0;
        let lowConfidence = 0;
        let staleNodes = 0;
        const bySource: Record<string, number> = { explicit: 0, inferred: 0, system: 0, unknown: 0 };

        for (const node of allNodes) {
            const conf = node.confidence ?? 1.0;
            totalConfidence += conf;
            if (conf < this.config.minConfidence) lowConfidence++;

            const source = node.metadata?.source || 'unknown';
            bySource[source] = (bySource[source] || 0) + 1;

            const lastUpdated = node.last_updated ? new Date(node.last_updated) : new Date(node.created_at || now);
            if (now.getTime() - lastUpdated.getTime() > staleThreshold) staleNodes++;
        }

        return {
            totalNodes: allNodes.length,
            avgConfidence: allNodes.length > 0 ? Math.round(totalConfidence / allNodes.length * 100) / 100 : 0,
            lowConfidence,
            bySource,
            staleNodes
        };
    }

    // ========================================================================
    // HELPERS
    // ========================================================================

    private getAllNodes(): MemoryNode[] {
        try {
            return this.memory.getNodesByType('identity')
                .concat(this.memory.getNodesByType('preference'))
                .concat(this.memory.getNodesByType('project'))
                .concat(this.memory.getNodesByType('context'))
                .concat(this.memory.getNodesByType('fact'))
                .concat(this.memory.getNodesByType('skill'))
                .concat(this.memory.getNodesByType('infrastructure'));
        } catch {
            return [];
        }
    }

    private removeNode(nodeId: string): void {
        try {
            const db = (this.memory as any).db;
            // Remove edges pointing to/from this node
            db.prepare('DELETE FROM memory_edges WHERE from_node = ? OR to_node = ?').run(nodeId, nodeId);
            // Remove the node
            db.prepare('DELETE FROM memory_nodes WHERE id = ?').run(nodeId);
        } catch (err) {
            console.warn(`[GOVERNOR] Failed to remove node ${nodeId}:`, (err as Error).message);
        }
    }

    /**
     * Archive a node instead of deleting it.
     * Moves to memory_nodes with type='archived' and very low confidence.
     * Preserves the data for potential future recovery.
     */    private archiveNode(node: MemoryNode): void {
        try {
            this.memory.addNode({
                ...node,
                type: 'context', // Keep as context type (archived)
                confidence: 0.1, // Minimum confidence
                weight: 0.1, // Minimum weight
                metadata: { ...node.metadata, archived: 'true', archived_at: new Date().toISOString(), original_type: node.type },
                last_updated: new Date().toISOString()
            });
            console.log(`[GOVERNOR] Archived node: ${node.id} (was ${node.type}, confidence was ${node.confidence})`);
        } catch (err) {
            console.warn(`[GOVERNOR] Failed to archive node ${node.id}:`, (err as Error).message);
        }
    }
}