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
