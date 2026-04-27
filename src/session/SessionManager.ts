/**
 * SessionManager — Manages isolated sessions per channel + user (v2)
 * 
 * Production-grade session management with:
 * - Mutex per session (prevents concurrent JSONL corruption)
 * - Hybrid compression (message count OR token estimate)
 * - Checkpoint as structured system role (not loose text)
 * - /clear creates new session instead of destroying history
 * - Observability logging
 */

import { MemoryManager } from '../memory/MemoryManager';
import { SessionTranscript, TranscriptEntry, TranscriptMeta, SessionEventType } from './SessionTranscript';
import { ContextCompressor } from '../loop/ContextCompressor';
import { ProviderFactory } from '../core/ProviderFactory';
import fs from 'fs';

export interface SessionKey {
    channel: string;
    userId: string;
}

export interface SessionConfig {
    transcriptDir: string;
    maxUncompressedMessages: number;
    maxContextMessages: number;
    compressionModel?: string;
    /** Token estimate threshold for compression (char count / 4) */
    maxUncompressedTokens: number;
}

export interface CompressionCheckpoint {
    seq: number;
    summary: string;
    originalCount: number;
    compressedAt: string;
    model?: string;
    tokenEstimate: number;
}

const DEFAULT_CONFIG: SessionConfig = {
    transcriptDir: './data/sessions',
    maxUncompressedMessages: 20,
    maxContextMessages: 6,
    maxUncompressedTokens: 3000, // ~3000 tokens ≈ ~12000 chars
};

export class SessionManager {
    private config: SessionConfig;
    private memory: MemoryManager;
    private sessions: Map<string, SessionTranscript> = new Map();
    private sessionMutexes: Map<string, Promise<void>> = new Map();
    private compressionCheckpoints: Map<string, CompressionCheckpoint> = new Map();
    private contextCompressor: ContextCompressor | null = null;

    constructor(config: Partial<SessionConfig>, memory: MemoryManager, providerFactory?: ProviderFactory) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.memory = memory;

        fs.mkdirSync(this.config.transcriptDir, { recursive: true });
        this.loadCheckpoints();

        if (providerFactory) {
            this.contextCompressor = new ContextCompressor(providerFactory);
        }
    }

    /**
     * Mutex-protected operation per session key.
     * Prevents concurrent writes to the same JSONL.
     */
    private async withMutex<T>(sid: string, fn: () => Promise<T>): Promise<T> {
        const current = this.sessionMutexes.get(sid) || Promise.resolve();
        let resolve: () => void;
        const next = new Promise<void>(r => { resolve = r; });
        this.sessionMutexes.set(sid, next);

        await current;
        try {
            return await fn();
        } finally {
            resolve!();
        }
    }

    private sessionKey(key: SessionKey): string {
        return `${key.channel}:${key.userId}`;
    }

    private conversationId(key: SessionKey): string {
        return this.sessionKey(key);
    }

    async getOrCreateSession(key: SessionKey): Promise<SessionTranscript> {
        const sid = this.sessionKey(key);
        if (this.sessions.has(sid)) return this.sessions.get(sid)!;

        const transcript = new SessionTranscript(this.config.transcriptDir, sid);
        await transcript.init();
        this.sessions.set(sid, transcript);
        return transcript;
    }

    async recordUserMessage(key: SessionKey, content: string, meta?: TranscriptMeta): Promise<number> {
        const sid = this.sessionKey(key);
        return this.withMutex(sid, async () => {
            const transcript = await this.getOrCreateSession(key);
            const seq = transcript.append('user', content, meta);
            this.memory.addMessage(this.conversationId(key), 'user', content);
            await this.maybeCompress(key);
            console.log(`[SESSION] ${sid} user seq=${seq} len=${content.length}`);
            return seq;
        });
    }

    async recordAssistantMessage(key: SessionKey, content: string, meta?: TranscriptMeta): Promise<number> {
        const sid = this.sessionKey(key);
        return this.withMutex(sid, async () => {
            const transcript = await this.getOrCreateSession(key);
            const seq = transcript.append('assistant', content, meta);
            this.memory.addMessage(this.conversationId(key), 'assistant', content);
            console.log(`[SESSION] ${sid} assistant seq=${seq} len=${content.length} tokens≈${Math.round(content.length / 4)}`);
            return seq;
        });
    }

    async recordSystemMessage(key: SessionKey, content: string, meta?: TranscriptMeta): Promise<number> {
        const transcript = await this.getOrCreateSession(key);
        return transcript.append('system', content, meta);
    }

    async recordToolMessage(key: SessionKey, content: string, meta?: TranscriptMeta): Promise<number> {
        const transcript = await this.getOrCreateSession(key);
        return transcript.append('tool_result', content, meta);
    }

    async recordToolCall(key: SessionKey, toolName: string, input: string, meta?: TranscriptMeta): Promise<number> {
        const transcript = await this.getOrCreateSession(key);
        return transcript.append('tool_call', `Tool: ${toolName}`, { ...meta, tool_name: toolName, tool_input: input });
    }

    async recordToolResult(key: SessionKey, toolName: string, result: string, success: boolean, durationMs?: number, meta?: TranscriptMeta): Promise<number> {
        const transcript = await this.getOrCreateSession(key);
        return transcript.append('tool_result', result, {
            ...meta,
            tool_name: toolName,
            tool_success: success,
            tool_duration_ms: durationMs,
            status: success ? 'success' : 'error'
        });
    }

    /**
     * Build context for LLM: checkpoint (structured) + recent messages.
     * Checkpoint is always injected as a system role message.
     */
    async buildContext(key: SessionKey, systemPrompt: string): Promise<{ messages: TranscriptEntry[]; contextString: string }> {
        const transcript = await this.getOrCreateSession(key);
        const sid = this.sessionKey(key);
        const checkpoint = this.compressionCheckpoints.get(sid);

        let contextString = systemPrompt;
        let messages: TranscriptEntry[];

        if (checkpoint) {
            const { entries } = transcript.getSinceCheckpoint();
            messages = entries;
            // Checkpoint as STRUCTURED system role — not loose text
            contextString = systemPrompt;
            // Checkpoint summary will be injected as a system message in SessionContext
        } else {
            const stats = transcript.getStats();
            messages = transcript.replayMessages(
                Math.max(1, stats.totalEntries - this.config.maxUncompressedMessages)
            );
        }

        return { messages, contextString };
    }

    /**
     * Hybrid compression: triggers on message count OR token estimate.
     */
    private async maybeCompress(key: SessionKey): Promise<void> {
        const transcript = await this.getOrCreateSession(key);
        const sid = this.sessionKey(key);

        const { entries } = transcript.getSinceCheckpoint();
        const userAssistantMessages = entries.filter(e => e.role === 'user' || e.role === 'assistant');

        // Hybrid trigger: message count OR token estimate
        const messageThreshold = userAssistantMessages.length >= this.config.maxUncompressedMessages;
        const tokenEstimate = userAssistantMessages.reduce((sum, e) => sum + Math.ceil(e.content.length / 4), 0);
        const tokenThreshold = tokenEstimate >= this.config.maxUncompressedTokens;

        if (!messageThreshold && !tokenThreshold) return;

        const compressCount = userAssistantMessages.length - this.config.maxContextMessages;
        if (compressCount <= 0) return;

        console.log(`[SESSION] Compressing ${userAssistantMessages.length} messages (${tokenEstimate} tokens) for ${sid}`);

        const messagesToCompress = entries.slice(0, compressCount);

        let summary: string;
        if (this.contextCompressor) {
            try {
                const llmMessages = messagesToCompress
                    .filter(e => e.role === 'user' || e.role === 'assistant')
                    .map(e => ({ role: e.role as 'user' | 'assistant', content: e.content }));
                const compressed = await this.contextCompressor.compress(llmMessages);
                const summaryMsg = compressed.find(m => m.role === 'system');
                summary = summaryMsg?.content || this.fallbackSummary(messagesToCompress);
            } catch (err) {
                console.warn('[SESSION] Compression failed, using fallback:', err);
                summary = this.fallbackSummary(messagesToCompress);
            }
        } else {
            summary = this.fallbackSummary(messagesToCompress);
        }

        const checkpoint: CompressionCheckpoint = {
            seq: transcript.getSeq(),
            summary,
            originalCount: messagesToCompress.length,
            compressedAt: new Date().toISOString(),
            model: this.config.compressionModel,
            tokenEstimate
        };

        this.compressionCheckpoints.set(sid, checkpoint);
        this.saveCheckpoint(sid, checkpoint);

        // Mark checkpoint in transcript as STRUCTURED system event
        transcript.append('checkpoint', summary, {
            checkpoint: true,
            compressed_up_to: checkpoint.seq
        });

        console.log(`[SESSION] Checkpoint: seq=${checkpoint.seq} compressed=${messagesToCompress.length} tokens≈${tokenEstimate}`);
    }

    private fallbackSummary(messages: TranscriptEntry[]): string {
        const userMsgs = messages.filter(m => m.role === 'user').slice(-8)
            .map(m => `- ${m.content.slice(0, 150)}`).join('\n');
        const assistantCount = messages.filter(m => m.role === 'assistant').length;
        return `Conversa anterior (${messages.length} msgs, ${assistantCount} respostas):\n${userMsgs}`;
    }

    private saveCheckpoint(sid: string, checkpoint: CompressionCheckpoint): void {
        try {
            const db = (this.memory as any).db;
            db.prepare(`
                INSERT OR REPLACE INTO session_checkpoints 
                (session_id, seq, summary, original_count, compressed_at, model, token_estimate)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(sid, checkpoint.seq, checkpoint.summary, checkpoint.originalCount, checkpoint.compressedAt, checkpoint.model || null, checkpoint.tokenEstimate);
        } catch {
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
                        token_estimate REAL,
                        PRIMARY KEY (session_id)
                    )
                `);
                db.prepare(`
                    INSERT OR REPLACE INTO session_checkpoints 
                    (session_id, seq, summary, original_count, compressed_at, model, token_estimate)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `).run(sid, checkpoint.seq, checkpoint.summary, checkpoint.originalCount, checkpoint.compressedAt, checkpoint.model || null, checkpoint.tokenEstimate);
            } catch (err2) {
                console.warn('[SESSION] Failed to save checkpoint:', err2);
            }
        }
    }

    private loadCheckpoints(): void {
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
                    token_estimate REAL,
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
                    model: row.model,
                    tokenEstimate: row.token_estimate || 0
                });
            }
            console.log(`[SESSION] Loaded ${rows.length} checkpoints, ${this.sessions.size} active sessions`);
        } catch (err) {
            console.warn('[SESSION] Checkpoints will be created on first compress:', (err as Error).message);
        }
    }

    getActiveSessions(): string[] { return Array.from(this.sessions.keys()); }

    /**
     * Close session — creates new session on next message (preserves history).
     * /clear now creates a new session file instead of destroying history.
     */
    async closeSession(key: SessionKey): Promise<void> {
        const sid = this.sessionKey(key);
        const transcript = this.sessions.get(sid);
        if (transcript) {
            await transcript.close();
            this.sessions.delete(sid);
        }
        this.compressionCheckpoints.delete(sid);
    }

    async closeAll(): Promise<void> {
        for (const transcript of this.sessions.values()) {
            await transcript.close();
        }
        this.sessions.clear();
    }

    getSessionStats(key: SessionKey): { transcriptEntries: number; transcriptBytes: number; hasCheckpoint: boolean; lastActivity: string | null; checkpointCount: number } | null {
        const sid = this.sessionKey(key);
        const transcript = this.sessions.get(sid);
        if (!transcript) return null;

        const stats = transcript.getStats();
        const checkpoint = this.compressionCheckpoints.get(sid);

        return {
            transcriptEntries: stats.totalEntries,
            transcriptBytes: stats.totalBytes,
            hasCheckpoint: !!checkpoint,
            lastActivity: stats.lastTs,
            checkpointCount: stats.checkpointCount
        };
    }

    /**
     * Get checkpoint summary for a session (used by SessionContext to inject as system role).
     */
    getCheckpointSummary(key: SessionKey): string | null {
        const sid = this.sessionKey(key);
        return this.compressionCheckpoints.get(sid)?.summary || null;
    }

    getMemory(): MemoryManager { return this.memory; }
    getConfig(): SessionConfig { return { ...this.config }; }
}