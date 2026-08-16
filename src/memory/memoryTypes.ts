import { createLogger } from '../shared/AppLogger';
const log = createLogger('GraphRepository');

/**
 * Parseia a coluna `metadata` (TEXT/JSON no SQLite) devolvendo sempre um objeto plano.
 *
 * Ponto único de verdade: todo lugar que lê `memory_nodes.metadata` deve passar por aqui —
 * não reimplementar `JSON.parse` localmente. Existe porque `metadata` já foi encontrado
 * corrompido em produção (uma string JSON reempacotada em `JSON.stringify` múltiplas vezes por
 * um consumidor que não parseava antes de regravar — ver `MemoryFacade.getAllNodes()`), e nesse
 * estado `JSON.parse` devolve uma STRING (não lança exceção) — código que em seguida faz
 * `meta['x'] = y` ou `{...meta}` falha (`Cannot create property on string`) ou produz um objeto
 * decomposto caractere-a-caractere. Aqui a validação é estrutural (tipo do valor parseado, não
 * seu conteúdo) — decide reset determinístico, não interpretação semântica.
 *
 * Fica em memoryTypes.ts (módulo-folha, sem imports) para poder ser usada tanto por
 * graphRepository.ts quanto por memorySchema.ts sem criar dependência circular entre os dois.
 */
/**
 * Detecta a assinatura estrutural de `Object.keys()`/spread aplicado sobre uma STRING em vez de
 * um objeto: chaves numéricas sequenciais começando em "0" (uma por caractere), mais o marcador
 * `_truncated` que o fallback de truncamento de `graphRepository.addNode()` sempre adiciona.
 * Verificação estrutural (forma das chaves), não interpretação de conteúdo.
 *
 * Achado real (16/08/2026, banco de produção): a checagem original exigia que TODAS as chaves
 * fossem sequenciais — mas `MemoryGovernor.archiveNode()` faz `{...rawMetadata, archived: 'true',
 * archived_at: ..., original_type: ...}`, então um objeto já decomposto uma vez ganha 3 chaves
 * literais no fim ("archived", "archived_at", "original_type") na primeira vez que é
 * re-arquivado. Chaves inteiras (mesmo como string) são sempre enumeradas primeiro e em ordem
 * numérica pelo motor JS, então `Object.keys()` desse objeto MISTO ainda devolve "0","1",...,"N"
 * antes das chaves literais — só que agora `keys.every((k,i) => k === String(i))` falha no
 * primeiro k não-numérico e o objeto passa como "válido". Resultado: 23 nós presos, cada
 * ciclo de archiveNode() só reempilha a mesma sujeira com timestamp novo, para sempre — não
 * cresce (não é uma segunda decomposição), mas nunca se autocorrige. Metadata legítimo nunca usa
 * chaves puramente numéricas — basta a presença de "0" E "1" para condenar o objeto inteiro,
 * mesmo com outras chaves reais junto.
 */
export function isCharacterDecomposedMetadata(obj: Record<string, unknown>): boolean {
    if (obj['0'] !== undefined && obj['1'] !== undefined) return true;
    const keys = Object.keys(obj).filter(k => k !== '_truncated');
    if (keys.length === 0) return false;
    return keys.every((k, i) => k === String(i));
}

export function parseNodeMetadata(raw: string | null | undefined, nodeId?: string): Record<string, string> {
    if (!raw) return {};
    try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            if (isCharacterDecomposedMetadata(parsed as Record<string, unknown>)) {
                log.warn(`[GraphRepository] metadata de "${nodeId ?? '?'}" é uma string decomposta em caracteres (Object.keys sobre string) — descartando, dado irrecuperável.`);
                return {};
            }
            return parsed as Record<string, string>;
        }
        log.warn(`[GraphRepository] metadata de "${nodeId ?? '?'}" não é um objeto após parse (tipo: ${typeof parsed}) — descartando, dado irrecuperável.`);
        return {};
    } catch {
        log.warn(`[GraphRepository] metadata de "${nodeId ?? '?'}" não é JSON válido — descartando, dado irrecuperável.`);
        return {};
    }
}

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
 * Identity scope — whose memory is this?
 * - USER_MEMORY:   stated by or about the user (preferences, identity, traits)
 * - AGENT_MEMORY:  inferred or learned by the agent (conclusions, reflections)
 * - SYSTEM_MEMORY: operational state (config, tools, infrastructure, heartbeat)
 * - TASK_MEMORY:   short-lived task context (tool outputs, current task state)
 */
export type IdentityScope = 'USER_MEMORY' | 'AGENT_MEMORY' | 'SYSTEM_MEMORY' | 'TASK_MEMORY';

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
    /**
     * Identity scope — whose memory this belongs to.
     * Inferred automatically at write time from nodeType + source if not explicit.
     * Affects retrieval ranking and context injection strategy.
     */
    identity_scope?: IdentityScope | null;
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
