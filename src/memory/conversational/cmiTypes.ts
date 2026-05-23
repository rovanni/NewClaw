/**
 * CMI Types — Conversational Memory Index
 *
 * Camada episódica entre SessionTranscript (log bruto) e MemoryGraph (fatos duráveis).
 * Armazena chunks semânticos de conversas para recuperação futura.
 */

export type ChunkCutTrigger =
    | 'workflow_completed'   // workflow/tool chain concluído
    | 'domain_shift'         // mudança de domínio detectada pelo DomainRegistry
    | 'checkpoint_written'   // compressão linear disparou — fronteira natural
    | 'window_size'          // buffer atingiu MAX_CHUNK_MESSAGES
    | 'time_window';         // inatividade >= MAX_TIME_WINDOW_MS

/** Mensagem comprimida dentro de um chunk — sem conteúdo longo ou ruído */
export interface ChunkMessage {
    role: 'user' | 'assistant';
    content: string; // truncado a MAX_MSG_CHARS
}

/** Episódio conversacional indexado e armazenado */
export interface ConversationChunk {
    id: string;                   // "cmi_{timestamp}_{rand8}"
    sessionKey: string;           // "telegram:12345"
    conversationId: string;       // canal:userId

    // Posição no transcript
    startSeq: number;
    endSeq: number;
    startTimestamp: number;       // unix ms
    endTimestamp: number;         // unix ms

    // Conteúdo semântico
    summary: string;              // resumo LLM do episódio (100-200 palavras)
    topics: string[];             // domínios detectados pelo DomainRegistry
    entities: string[];           // arquivos, tool names, termos salientes
    intent: string;               // intent primária do chunk

    // Snapshot comprimido (para exibição em inspeção)
    messages: ChunkMessage[];

    // Vector (Float64Array → Buffer, igual ao EmbeddingService)
    embedding: Buffer | null;

    // Metadados operacionais
    workflowId: string | null;
    toolsUsed: string[];
    chunkQuality: number;         // 0-1 (determina GC e ranking)
    cutTrigger: ChunkCutTrigger;

    // Lifecycle
    createdAt: number;            // unix ms
    lastAccessedAt: number | null;
    accessCount: number;
    expiresAt: number | null;     // unix ms (null = não expira automaticamente)
}

/** Estado interno do buffer por sessão */
export interface BufferState {
    entries: import('../../session/SessionTranscript').TranscriptEntry[];
    currentDomain: string | null; // domínio classificado das primeiras msgs
    startTimestamp: number;
    toolsDetected: string[];
    workflowCompleted: boolean;
    lastEntryTimestamp: number;
}

/** Resultado de uma consulta de inspeção */
export interface CMIStats {
    totalChunks: number;
    totalSessions: number;
    avgQuality: number;
    avgMessagesPerChunk: number;
    chunksWithEmbedding: number;
    storageEstimateKb: number;
    topTopics: Array<{ name: string; count: number }>;
    topEntities: Array<{ name: string; count: number }>;
    qualityDistribution: { high: number; medium: number; low: number };
    recentChunks: number; // últimos 7 dias
}

/** Linha raw retornada pelo SQLite (snake_case) */
export interface ChunkRow {
    id: string;
    session_key: string;
    conversation_id: string;
    start_seq: number;
    end_seq: number;
    start_timestamp: number;
    end_timestamp: number;
    summary: string;
    topics: string;       // JSON
    entities: string;     // JSON
    intent: string;
    messages: string;     // JSON
    embedding: Buffer | null;
    workflow_id: string | null;
    tools_used: string;   // JSON
    chunk_quality: number;
    cut_trigger: string;
    created_at: number;
    last_accessed_at: number | null;
    access_count: number;
    expires_at: number | null;
}
