export interface Message {
    id?: number;
    conversation_id: string;
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    created_at?: string;
}

export interface Conversation {
    id: string;
    user_id: string;
    provider: string;
    created_at?: string;
    updated_at?: string;
}

/** Lifecycle states for semantic compression pipeline */
export type LifecycleState = 'ACTIVE' | 'SUMMARIZED' | 'ARCHIVED' | 'EXPIRED' | 'SUPERSEDED';

/**
 * Epistemic status — certainty level of a memory node.
 * - fact:       explicitly stated by user or confirmed by tool (confident, slow decay)
 * - belief:     inferred by the agent with moderate confidence (normal decay)
 * - assumption: speculative or low-confidence inference (fast decay, labeled in context)
 */
export type EpistemicStatus = 'fact' | 'belief' | 'assumption';

export interface MemoryNode {
    id: string;
    type: 'identity' | 'preference' | 'project' | 'context' | 'fact' | 'skill' | 'infrastructure' | 'trait' | 'rule' | 'strategy' | 'knowledge' | 'domain';
    name: string;
    content: string;
    metadata?: Record<string, string>;
    pagerank?: number;
    degree?: number;
    community_id?: number;
    weight?: number;
    confidence?: number;
    last_updated?: string;
    created_at?: string;
    updated_at?: string;
    /** Lifecycle state for non-destructive compression. NULL/undefined = ACTIVE. */
    lifecycle_state?: LifecycleState | null;
    /** Expiration timestamp for TTL-based working memory. NULL = no TTL. Set by MemoryGovernor. */
    expires_at?: string | null;
    /**
     * Epistemic status — certainty level of this memory.
     * Inferred automatically at write time from confidence + source if not explicit.
     * Affects decay rate and how the node is labeled in LLM context.
     */
    epistemic_status?: EpistemicStatus | null;
}

export interface MemoryEdge {
    from: string;
    to: string;
    relation: string;
    weight?: number;
}

// ── SQLite Row Types ────────────────────────────────────────
export interface PragmaColumnRow { name: string; [key: string]: unknown }
export interface CountRow        { count: number }
export interface SnapshotRow {
    id: string;
    label: string;
    node_count: number;
    edge_count: number;
    created_at: string;
    snapshot_data: string;
}
export interface MemoryNodeRow extends Omit<MemoryNode, 'metadata'> { metadata: string }
