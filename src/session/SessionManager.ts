/**
 * SessionManager — Manages isolated sessions per channel + user
 * 
 * Provides:
 * - Session creation/retrieval by channel+userId composite key
 * - Session isolation (each channel/user gets independent context)
 * - Session transcript (JSONL append-only log)
 * - History compression with summarization checkpoints
 * - Linear replay for context reconstruction
 */

import { MemoryManager } from '../memory/MemoryManager';
import { SessionTranscript, TranscriptEntry, SessionEventType } from './SessionTranscript';
import { ContextCompressor } from '../loop/ContextCompressor';
import { ProviderFactory } from '../core/ProviderFactory';
import path from 'path';
import fs from 'fs';

export interface SessionKey {
    channel: string;   // 'telegram', 'discord', 'web', etc.
    userId: string;    // user identifier within the channel
}

export interface SessionConfig {
    transcriptDir: string;          // Directory for JSONL files
    maxUncompressedMessages: number; // Messages before triggering compression
    maxContextMessages: number;       // Messages to keep after compression
    compressionModel?: string;        // Model for summarization
}

export interface CompressionCheckpoint {
    seq: number;                    // Sequence number of the checkpoint
    summary: string;                // Summarized content
    originalCount: number;         // Number of messages compressed
    compressedAt: string;          // ISO8601 timestamp
    model?: string;                 // Model used for compression
}

const DEFAULT_CONFIG: SessionConfig = {
    transcriptDir: './data/sessions',
    maxUncompressedMessages: 20,
    maxContextMessages: 6,
};

export class SessionManager {
    private config: SessionConfig;
    private memory: MemoryManager;
    private sessions: Map<string, SessionTranscript> = new Map();
    private compressionCheckpoints: Map<string, CompressionCheckpoint> = new Map();
    private contextCompressor: ContextCompressor | null = null;

    constructor(config: Partial<SessionConfig>, memory: MemoryManager, providerFactory?: ProviderFactory) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.memory = memory;

        // Ensure transcript directory exists
        fs.mkdirSync(this.config.transcriptDir, { recursive: true });

        // Load existing compression checkpoints from DB
        this.loadCheckpoints();

        // Initialize context compressor if provider available
        if (providerFactory) {
            this.contextCompressor = new ContextCompressor(providerFactory);
        }
    }

    /**
     * Generate a composite session key from channel + userId.
     * Format: channel:userId (e.g., "telegram:8071707790")
     */
    private sessionKey(key: SessionKey): string {
        return `${key.channel}:${key.userId}`;
    }

    /**
     * Generate a conversation_id compatible with MemoryManager.
     */
    private conversationId(key: SessionKey): string {
        return this.sessionKey(key);
    }

    /**
     * Get or create a session transcript for a channel+user.
     */
    async getOrCreateSession(key: SessionKey): Promise<SessionTranscript> {
        const sid = this.sessionKey(key);

        if (this.sessions.has(sid)) {
            return this.sessions.get(sid)!;
        }

        const transcript = new SessionTranscript(this.config.transcriptDir, sid);
        await transcript.init();
        this.sessions.set(sid, transcript);

        // Ensure conversation exists in DB
        this.ensureConversation(key);

        return transcript;
    }

    /**
     * Record a user message in both transcript and DB.
     */
    async recordUserMessage(key: SessionKey, content: string, meta?: TranscriptEntry['meta']): Promise<number> {
        const transcript = await this.getOrCreateSession(key);
        const seq = transcript.append('user', content, meta);

        // Also record in MemoryManager for persistence
        const convId = this.conversationId(key);
        this.memory.addMessage(convId, 'user', content);

        // Check if compression is needed
        await this.maybeCompress(key);

        return seq;
    }

    /**
     * Record an assistant message in both transcript and DB.
     */
    async recordAssistantMessage(key: SessionKey, content: string, meta?: TranscriptEntry['meta']): Promise<number> {
        const transcript = await this.getOrCreateSession(key);
        const seq = transcript.append('assistant', content, meta);

        // Also record in MemoryManager
        const convId = this.conversationId(key);
        this.memory.addMessage(convId, 'assistant', content);

        return seq;
    }

    /**
     * Record a system message.
     */
    async recordSystemMessage(key: SessionKey, content: string, meta?: TranscriptEntry['meta']): Promise<number> {
        const transcript = await this.getOrCreateSession(key);
        const seq = transcript.append('system', content, meta);

        // System messages are NOT recorded in DB (they're transient)
        return seq;
    }

    /**
     * Record a tool call/result.
     */
    async recordToolMessage(key: SessionKey, content: string, meta?: TranscriptEntry['meta']): Promise<number> {
        const transcript = await this.getOrCreateSession(key);
        const seq = transcript.append('tool_result', content, meta);
        return seq;
    }

    /**
     * Build context for LLM: system prompt + checkpoint summary + recent messages.
     * 
     * This is the key method that replaces the naive "keep last N" approach.
     * Pipeline:
     * 1. Check for compression checkpoint
     * 2. If checkpoint exists, use its summary as context prefix
     * 3. Append messages since checkpoint as recent context
     * 4. If no checkpoint, use all messages (up to limit)
     */
    async buildContext(key: SessionKey, systemPrompt: string): Promise<{ messages: TranscriptEntry[]; contextString: string }> {
        const transcript = await this.getOrCreateSession(key);
        const sid = this.sessionKey(key);

        // Get checkpoint for this session
        const checkpoint = this.compressionCheckpoints.get(sid);

        let contextString = systemPrompt;
        let messages: TranscriptEntry[];

        if (checkpoint) {
            // Reconstruct from checkpoint summary + recent messages
            const recentEntries = transcript.getSinceCheckpoint();
            messages = recentEntries.entries;

            // Prepend checkpoint summary
            contextString = `${systemPrompt}\n\n[Resumo da conversa anterior]\n${checkpoint.summary}`;
        } else {
            // No checkpoint: use all messages
            const stats = transcript.getStats();
            messages = transcript.replayMessages(
                Math.max(1, stats.totalEntries - this.config.maxUncompressedMessages)
            );
        }

        return { messages, contextString };
    }

    /**
     * Compress history if the number of uncompressed messages exceeds the threshold.
     * Creates a summarization checkpoint and marks it in the transcript.
     */
    private async maybeCompress(key: SessionKey): Promise<void> {
        const transcript = await this.getOrCreateSession(key);
        const sid = this.sessionKey(key);

        // Check message count since last checkpoint
        const { entries, lastCheckpointSeq } = transcript.getSinceCheckpoint();
        const uncompressedCount = entries.filter(e => e.role === 'user' || e.role === 'assistant').length;

        if (uncompressedCount < this.config.maxUncompressedMessages) {
            return; // Not enough messages to compress
        }

        console.log(`[SESSION] Compressing ${uncompressedCount} messages for session ${sid}`);

        // Get messages to compress (everything except last maxContextMessages)
        const messagesToCompress = entries.slice(0, -this.config.maxContextMessages);
        const keepMessages = entries.slice(-this.config.maxContextMessages);

        if (messagesToCompress.length === 0) return;

        // Create summary using ContextCompressor or fallback
        let summary: string;
        if (this.contextCompressor) {
            try {
                const llmMessages = messagesToCompress.map(e => ({
                    role: e.role as 'user' | 'assistant' | 'system',
                    content: e.content
                }));
                const compressed = await this.contextCompressor.compress(llmMessages);
                // Extract summary from compressed messages
                const summaryMsg = compressed.find(m => m.role === 'system' && m.content?.includes('[Resumo'));
                summary = summaryMsg?.content || this.fallbackSummary(messagesToCompress);
            } catch (err) {
                console.warn('[SESSION] Compression failed, using fallback:', err);
                summary = this.fallbackSummary(messagesToCompress);
            }
        } else {
            summary = this.fallbackSummary(messagesToCompress);
        }

        // Create checkpoint
        const checkpoint: CompressionCheckpoint = {
            seq: transcript.getSeq(),
            summary,
            originalCount: messagesToCompress.length,
            compressedAt: new Date().toISOString(),
            model: this.config.compressionModel
        };

        // Store checkpoint in memory and local cache
        this.compressionCheckpoints.set(sid, checkpoint);
        this.saveCheckpoint(sid, checkpoint);

        // Mark checkpoint in transcript
        transcript.append('system', `[CHECKPOINT] Compressão: ${messagesToCompress.length} mensagens → resumo. Contexto preservado.`, {
            checkpoint: true,
            compressed_up_to: checkpoint.seq
        });

        console.log(`[SESSION] Checkpoint created: ${checkpoint.seq} (${messagesToCompress.length} messages compressed)`);
    }

    /**
     * Fallback summary when LLM is unavailable.
     * Extracts key points from user messages.
     */
    private fallbackSummary(messages: TranscriptEntry[]): string {
        const userMessages = messages
            .filter(m => m.role === 'user')
            .slice(-8) // Keep last 8 user messages as key points
            .map(m => `- ${m.content.slice(0, 150)}`)
            .join('\n');

        const assistantMessages = messages
            .filter(m => m.role === 'assistant')
            .length;

        return `Conversa anterior (${messages.length} mensações, ${assistantMessages} respostas):\n${userMessages}`;
    }

    /**
     * Save checkpoint to SQLite for persistence.
     */
    private saveCheckpoint(sid: string, checkpoint: CompressionCheckpoint): void {
        try {
            const db = (this.memory as any).db;
            db.prepare(`
                INSERT OR REPLACE INTO session_checkpoints 
                (session_id, seq, summary, original_count, compressed_at, model)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(sid, checkpoint.seq, checkpoint.summary, checkpoint.originalCount, checkpoint.compressedAt, checkpoint.model || null);
        } catch (err) {
            // Table might not exist yet — create it
            try {
                const db = (this.memory as any).db;
                db.exec(`
                    CREATE TABLE IF NOT EXISTS session_checkpoints (
                        session_id TEXT NOT NULL,
                        seq INTEGER NOT NULL,
                        summary TEXT NOT NULL,
                        original_count INTEGER NOT NULL,
                        compressed_at TEXT NOT NULL,
                        model TEXT,
                        PRIMARY KEY (session_id)
                    )
                `);
                db.prepare(`
                    INSERT OR REPLACE INTO session_checkpoints 
                    (session_id, seq, summary, original_count, compressed_at, model)
                    VALUES (?, ?, ?, ?, ?, ?)
                `).run(sid, checkpoint.seq, checkpoint.summary, checkpoint.originalCount, checkpoint.compressedAt, checkpoint.model || null);
            } catch (err2) {
                console.warn('[SESSION] Failed to save checkpoint:', err2);
            }
        }
    }

    /**
     * Load existing checkpoints from SQLite.
     */
    private loadCheckpoints(): void {
        try {
            const db = (this.memory as any).db;
            // Ensure table exists
            db.exec(`
                CREATE TABLE IF NOT EXISTS session_checkpoints (
                    session_id TEXT NOT NULL,
                    seq INTEGER NOT NULL,
                    summary TEXT NOT NULL,
                    original_count INTEGER NOT NULL,
                    compressed_at TEXT NOT NULL,
                    model TEXT,
                    PRIMARY KEY (session_id)
                )
            `);
            const rows = db.prepare('SELECT * FROM session_checkpoints').all() as any[];
            for (const row of rows) {
                this.compressionCheckpoints.set(row.session_id, {
                    seq: row.seq,
                    summary: row.summary,
                    originalCount: row.original_count,
                    compressedAt: row.compressed_at,
                    model: row.model
                });
            }
            console.log(`[SESSION] Loaded ${rows.length} compression checkpoints`);
        } catch (err) {
            console.warn('[SESSION] Failed to load checkpoints (will create on first compress):', err);
        }
    }

    /**
     * Ensure a conversation exists in MemoryManager.
     */
    private ensureConversation(key: SessionKey): void {
        const convId = this.conversationId(key);
        try {
            const existing = this.memory.getRecentMessages(convId, 1);
            // Conversation is created implicitly by addMessage
            // No explicit creation needed
        } catch {
            // Conversation may already exist
        }
    }

    /**
     * Get all active sessions.
     */
    getActiveSessions(): string[] {
        return Array.from(this.sessions.keys());
    }

    /**
     * Close a session and flush its transcript.
     */
    async closeSession(key: SessionKey): Promise<void> {
        const sid = this.sessionKey(key);
        const transcript = this.sessions.get(sid);
        if (transcript) {
            await transcript.close();
            this.sessions.delete(sid);
        }
    }

    /**
     * Close all sessions.
     */
    async closeAll(): Promise<void> {
        for (const transcript of this.sessions.values()) {
            await transcript.close();
        }
        this.sessions.clear();
    }

    /**
     * Get session statistics.
     */
    getSessionStats(key: SessionKey): { transcriptEntries: number; transcriptBytes: number; hasCheckpoint: boolean; lastActivity: string | null } | null {
        const sid = this.sessionKey(key);
        const transcript = this.sessions.get(sid);
        if (!transcript) return null;

        const stats = transcript.getStats();
        const checkpoint = this.compressionCheckpoints.get(sid);

        return {
            transcriptEntries: stats.totalEntries,
            transcriptBytes: stats.totalBytes,
            hasCheckpoint: !!checkpoint,
            lastActivity: stats.lastTs
        };
    }

    /**
     * Record a tool call in the transcript.
     */    async recordToolCall(key: SessionKey, toolName: string, input: string, meta?: TranscriptEntry['meta']): Promise<number> {
        const transcript = await this.getOrCreateSession(key);
        const seq = transcript.append('tool_call', `Tool: ${toolName}`, { ...meta, tool_name: toolName, tool_input: input });
        return seq;
    }

    /**
     * Record a tool result in the transcript.
     */    async recordToolResult(key: SessionKey, toolName: string, result: string, success: boolean, meta?: TranscriptEntry['meta']): Promise<number> {
        const transcript = await this.getOrCreateSession(key);
        const seq = transcript.append('tool_result', result, { ...meta, tool_name: toolName, tool_success: success });
        return seq;
    }
    /**
     * Get the MemoryManager instance (for AgentLoop compatibility).
     */    getMemory(): MemoryManager {
        return this.memory;
    }

    /**
     * Get the configuration.
     */
    getConfig(): SessionConfig {
        return { ...this.config };
    }
}