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
import type { MemoryFacade } from '../memory/MemoryFacade';
import { SessionTranscript, TranscriptEntry, TranscriptMeta } from './SessionTranscript';
import { ContextCompressor } from '../loop/ContextCompressor';
import { ProviderFactory } from '../core/ProviderFactory';
import type { CMIEngine } from '../memory/conversational/CMIEngine';
import fs from 'fs';
import { createLogger } from '../shared/AppLogger';
const log = createLogger('Sessionmanager');

/**
 * Estimate token count for a string.
 * Portuguese text uses more tokens than English (accents, longer words).
 * Code/JSON has higher token density due to punctuation.
 * Heuristic: ~3.5 chars/token for pt-BR text, ~3 for code/JSON.
 */
export function estimateTokens(text: string): number {
    if (!text) return 0;
    const codeRatio = (text.match(/[{}()[\]:;,=<>\/]/g) || []).length / text.length;
    // Code-heavy content: ~3 chars/token
    // Pure text (pt-BR): ~3.5 chars/token
    // Mixed: interpolate
    const charsPerToken = 3 + (1 - codeRatio) * 0.5;
    return Math.ceil(text.length / charsPerToken);
}

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
    /** Max chars per message in LLM context (longer messages are truncated) */
    maxMessageChars: number;
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
    maxUncompressedMessages: 10, // reduced from 20 to prevent context overflow
    maxContextMessages: 6,
    maxUncompressedTokens: 2500, // ~2500 tokens ≈ ~10000 chars (reduced from 3000)
    maxMessageChars: 1500, // truncate individual messages longer than this
};

export class SessionManager {
    private config: SessionConfig;
    private memory: MemoryManager;
    private memoryFacade: MemoryFacade;
    private sessions: Map<string, SessionTranscript> = new Map();
    private sessionMutexes: Map<string, Promise<void>> = new Map();
    private compressionCheckpoints: Map<string, CompressionCheckpoint> = new Map();
    private lastActivity: Map<string, number> = new Map();
    private contextCompressor: ContextCompressor | null = null;
    
    // Rastreamento de arquivos ativos por sessão (para manter no contexto mesmo após compressão)
    private activeFiles: Map<string, Set<string>> = new Map();

    // Artefatos entregues via send_document — sobrevivem à compressão de sessão
    private deliveredArtifacts: Map<string, Array<{ path: string; name: string; deliveredAt: string }>> = new Map();

    // Goals ativos por sessão — usado para telemetria de compressão concorrente
    private activeGoals: Map<string, string> = new Map();

    // Contadores de ferramentas por turno de AgentLoop — base para validação estrutural de CR#2
    private turnToolCounts: Map<string, { reads: number; writes: number; edits: number }> = new Map();

    // CMI — injetado opcionalmente após construção
    private cmiEngine: CMIEngine | null = null;

    constructor(config: Partial<SessionConfig>, memory: MemoryManager, providerFactory?: ProviderFactory) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.memory = memory;
        this.memoryFacade = memory.getFacade();

        fs.mkdirSync(this.config.transcriptDir, { recursive: true });
        this.loadCheckpoints();

        if (providerFactory) {
            this.contextCompressor = new ContextCompressor(providerFactory);
        }
    }

    /**
     * Mutex-protected operation per session key.
     * Prevents concurrent writes to the same JSONL.
     * Includes timeout protection against deadlocks (30s).
     */
    private async withMutex<T>(sid: string, fn: () => Promise<T>): Promise<T> {
        const current = this.sessionMutexes.get(sid) || Promise.resolve();
        let resolve: () => void;
        const next = new Promise<void>(r => { resolve = r; });
        this.sessionMutexes.set(sid, next);

        // Update last activity for TTL cleanup
        this.lastActivity.set(sid, Date.now());

        // Timeout protection: if mutex takes > 10s, log warning and proceed
        const mutexTimeout = new Promise<void>((_, reject) => {
            setTimeout(() => reject(new Error(`Mutex timeout for ${sid} after 10s`)), 10_000);
        });

        try {
            await Promise.race([current, mutexTimeout]);
        } catch (err) {
            log.warn(`[MUTEX] Timeout waiting for ${sid} — previous operation took >10s, proceeding anyway. This may indicate a deadlock.`);
        }

        try {
            return await fn();
        } finally {
            resolve!();
            // Clean up stale mutexes after 60s
            setTimeout(() => {
                if (this.sessionMutexes.get(sid) === next) {
                    this.sessionMutexes.delete(sid);
                }
            }, 60_000);
        }
    }

    /**
     * Cleanup inactive sessions from memory.
     * Prevents memory leak in multi-user environments.
     */
    public async cleanupInactiveSessions(maxAgeMs: number = 900_000): Promise<number> {
        const now = Date.now();
        const toDelete: string[] = [];

        for (const [sid, lastSeen] of this.lastActivity.entries()) {
            if (now - lastSeen > maxAgeMs) {
                toDelete.push(sid);
            }
        }

        let count = 0;
        for (const sid of toDelete) {
            const transcript = this.sessions.get(sid);
            if (transcript) {
                await transcript.close();
                this.sessions.delete(sid);
                this.sessionMutexes.delete(sid);
                this.compressionCheckpoints.delete(sid);
                this.lastActivity.delete(sid);
                this.activeFiles.delete(sid);
                this.deliveredArtifacts.delete(sid);
                this.activeGoals.delete(sid);
                this.turnToolCounts.delete(sid);
                count++;
            }
        }
        if (count > 0) log.info(`Cleaned up ${count} inactive sessions from memory.`);
        return count;
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
        // Ensure conversation exists in DB before any addMessage calls
        this.ensureConversation(key);
        return transcript;
    }

    async recordUserMessage(key: SessionKey, content: string, meta?: TranscriptMeta): Promise<number> {
        const sid = this.sessionKey(key);
        return this.withMutex(sid, async () => {
            const transcript = await this.getOrCreateSession(key);
            const seq = transcript.append('user', content, meta);
            this.memory.addMessage(this.conversationId(key), 'user', content);
            await this.maybeCompress(key);
            log.info(`${sid} user seq=${seq} len=${content.length}`);
            // CMI: fire-and-forget, nunca bloqueia o response
            const entry: TranscriptEntry = { ts: new Date().toISOString(), seq, role: 'user', content, meta };
            this.cmiEngine?.feedEntry(sid, entry).catch(() => {});
            return seq;
        });
    }

    async recordAssistantMessage(key: SessionKey, content: string, meta?: TranscriptMeta): Promise<number> {
        const sid = this.sessionKey(key);
        return this.withMutex(sid, async () => {
            const transcript = await this.getOrCreateSession(key);
            const seq = transcript.append('assistant', content, meta);
            this.memory.addMessage(this.conversationId(key), 'assistant', content);
            log.info(`${sid} assistant seq=${seq} len=${content.length} tokens≈${Math.round(estimateTokens(content))}`);
            // CMI: fire-and-forget
            const entry: TranscriptEntry = { ts: new Date().toISOString(), seq, role: 'assistant', content, meta };
            this.cmiEngine?.feedEntry(sid, entry).catch(() => {});
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
        const sid = this.sessionKey(key);

        // Contadores por turno de AgentLoop (para validação estrutural de steps de modificação)
        if (toolName === 'read' || toolName === 'write' || toolName === 'edit') {
            if (!this.turnToolCounts.has(sid)) {
                this.turnToolCounts.set(sid, { reads: 0, writes: 0, edits: 0 });
            }
            const counts = this.turnToolCounts.get(sid)!;
            if (toolName === 'read')  counts.reads++;
            if (toolName === 'write') counts.writes++;
            if (toolName === 'edit')  counts.edits++;
        }

        // Track active files
        if (toolName === 'read' || toolName === 'write' || toolName === 'edit') {
            try {
                const parsedArgs = JSON.parse(input);
                if (parsedArgs.path) {
                    if (!this.activeFiles.has(sid)) {
                        this.activeFiles.set(sid, new Set());
                    }
                    this.activeFiles.get(sid)!.add(parsedArgs.path);

                    // Keep maximum of 10 recent files to avoid context bloat
                    if (this.activeFiles.get(sid)!.size > 10) {
                        const arr = Array.from(this.activeFiles.get(sid)!);
                        arr.shift(); // Remove oldest
                        this.activeFiles.set(sid, new Set(arr));
                    }
                }
            } catch (e) {
                // Ignore parse errors
            }
        }

        // Track delivered artifacts — sobrevivem à compressão de sessão
        if (toolName === 'send_document') {
            try {
                const parsedArgs = JSON.parse(input);
                const filePath = parsedArgs.file_path ?? parsedArgs.path;
                if (filePath) {
                    if (!this.deliveredArtifacts.has(sid)) {
                        this.deliveredArtifacts.set(sid, []);
                    }
                    this.deliveredArtifacts.get(sid)!.push({
                        path: String(filePath),
                        name: String(filePath).split('/').pop() ?? String(filePath),
                        deliveredAt: new Date().toISOString(),
                    });
                }
            } catch {
                // Ignore parse errors
            }
        }
        
        const seq = transcript.append('tool_call', `Tool: ${toolName}`, { ...meta, tool_name: toolName, tool_input: input });
        // CMI: registrar tool call (extrai tools_used e entity paths)
        const toolEntry: TranscriptEntry = {
            ts: new Date().toISOString(), seq, role: 'tool_call',
            content: `Tool: ${toolName}`, meta: { ...meta, tool_name: toolName, tool_input: input }
        };
        this.cmiEngine?.feedEntry(sid, toolEntry).catch(() => {});
        return seq;
    }

    /**
     * Helper para injetar a lista de arquivos trabalhados recentemente no prompt.
     * Sobrevive à compressão do contexto.
     */
    getActiveFilesBlock(key: SessionKey): string | null {
        const sid = this.sessionKey(key);
        const files = this.activeFiles.get(sid);
        if (!files || files.size === 0) return null;

        const fileList = Array.from(files).map(f => `- ${f}`).join('\n');
        return `ARQUIVOS ATIVOS NESTA SESSÃO (que você manipulou recentemente):\n${fileList}`;
    }

    /**
     * Helper para injetar artefatos entregues via send_document no prompt.
     * Sobrevive à compressão do contexto — evita amnésia pós-compressão.
     */
    getDeliveredArtifactsBlock(key: SessionKey): string | null {
        const sid = this.sessionKey(key);
        const artifacts = this.deliveredArtifacts.get(sid);
        if (!artifacts || artifacts.length === 0) return null;

        const list = artifacts.map(a => `- ${a.name} (enviado em ${a.deliveredAt})`).join('\n');
        return `ARQUIVOS ENVIADOS AO USUÁRIO NESTA SESSÃO:\n${list}`;
    }

    /**
     * Registra goal ativo para telemetria de compressão concorrente.
     * Chamado pelo GoalExecutionLoop no início de runLoop().
     */
    setActiveGoal(key: SessionKey, goalId: string): void {
        const sid = this.sessionKey(key);
        this.activeGoals.set(sid, goalId);
    }

    /**
     * Remove goal ativo ao final de runLoop().
     */
    clearActiveGoal(key: SessionKey): void {
        const sid = this.sessionKey(key);
        this.activeGoals.delete(sid);
    }

    /**
     * Reinicia os contadores de ferramentas para o turno atual.
     * Deve ser chamado pelo AgentLoop no início de cada turno (process()).
     */
    resetTurnToolCounts(key: SessionKey): void {
        const sid = this.sessionKey(key);
        this.turnToolCounts.set(sid, { reads: 0, writes: 0, edits: 0 });
    }

    /**
     * Retorna os contadores de ferramentas acumulados no turno atual.
     * Usado pelo GoalExecutionLoop para validar se um step de modificação
     * realmente executou write/edit (CR#2 — Sprint 3).
     */
    getTurnToolCounts(key: SessionKey): { reads: number; writes: number; edits: number } {
        const sid = this.sessionKey(key);
        return this.turnToolCounts.get(sid) ?? { reads: 0, writes: 0, edits: 0 };
    }

    async recordToolResult(key: SessionKey, toolName: string, result: string, success: boolean, durationMs?: number, meta?: TranscriptMeta): Promise<number> {
        const transcript = await this.getOrCreateSession(key);
        const sid = this.sessionKey(key);
        const resultMeta = { ...meta, tool_name: toolName, tool_success: success, tool_duration_ms: durationMs, status: success ? 'success' as const : 'error' as const };
        const seq = transcript.append('tool_result', result, resultMeta);
        // CMI: sinaliza conclusão de workflow para terminal tools
        const resultEntry: TranscriptEntry = {
            ts: new Date().toISOString(), seq, role: 'tool_result',
            content: result.slice(0, 200), meta: resultMeta
        };
        this.cmiEngine?.feedEntry(sid, resultEntry).catch(() => {});
        return seq;
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
            const { entries } = await transcript.getSinceCheckpoint();
            messages = entries;
            // Checkpoint as STRUCTURED system role — not loose text
            contextString = systemPrompt;
            // Checkpoint summary will be injected as a system message in SessionContext
        } else {
            const stats = transcript.getStats();
            messages = await transcript.replayMessages(
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

        const { entries } = await transcript.getSinceCheckpoint();
        const userAssistantMessages = entries.filter(e => e.role === 'user' || e.role === 'assistant');

        // Hybrid trigger: message count OR token estimate
        const messageThreshold = userAssistantMessages.length >= this.config.maxUncompressedMessages;
        const tokenEstimate = userAssistantMessages.reduce((sum, e) => sum + estimateTokens(e.content), 0);
        const tokenThreshold = tokenEstimate >= this.config.maxUncompressedTokens;

        if (!messageThreshold && !tokenThreshold) return;

        const compressCount = userAssistantMessages.length - this.config.maxContextMessages;
        if (compressCount <= 0) return;

        // Telemetria: compressão durante execução de goal pode causar perda de contexto
        const activeGoalId = this.activeGoals.get(sid);
        if (activeGoalId) {
            log.warn(`[SESSION] compressDuringGoal=true sid=${sid} goalId=${activeGoalId} msgs=${userAssistantMessages.length} tokens≈${tokenEstimate}`);
        }

        log.info(`Compressing ${userAssistantMessages.length} messages (${tokenEstimate} tokens) for ${sid}`);

        const messagesToCompress = entries.slice(0, compressCount);

        let summary: string;
        if (this.contextCompressor) {
            try {
                const llmMessages = messagesToCompress
                    .filter(e => e.role === 'user' || e.role === 'assistant')
                    .map(e => ({ role: e.role as 'user' | 'assistant', content: e.content }));
                const compressed = await this.contextCompressor.compress(llmMessages);
                const summaryMsg = compressed.find(m => m.role === 'system');
                summary = summaryMsg?.content || this.fallbackSummary(messagesToCompress, sid);
            } catch (err) {
                log.warn('compression_failed', 'Compression failed, using fallback', { error: String(err) });
                summary = this.fallbackSummary(messagesToCompress, sid);
            }
        } else {
            summary = this.fallbackSummary(messagesToCompress, sid);
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

        // CMI: fronteira semântica natural — flush imediato do buffer
        this.cmiEngine?.onCheckpointCreated(sid).catch(() => {});

        log.info(`Checkpoint: seq=${checkpoint.seq} compressed=${messagesToCompress.length} tokens≈${tokenEstimate}`);
    }

    private fallbackSummary(messages: TranscriptEntry[], sid: string): string {
        const userMsgs = messages.filter(m => m.role === 'user').slice(-8)
            .map(m => `- ${m.content.slice(0, 150)}`).join('\n');
        const assistantCount = messages.filter(m => m.role === 'assistant').length;

        const artifacts = this.deliveredArtifacts.get(sid) ?? [];
        const artifactBlock = artifacts.length > 0
            ? `\nARTEFATOS ENVIADOS NESTA SESSÃO:\n${artifacts.map(a => `- ${a.name} (${a.deliveredAt})`).join('\n')}`
            : '';

        return `Conversa anterior (${messages.length} msgs, ${assistantCount} respostas):\n${userMsgs}${artifactBlock}`;
    }

    private ensureCheckpointSchema(): void {
        try {
            this.memoryFacade.ensureSessionCheckpointSchema();
        } catch (err) {
            log.warn('migration', 'Schema check failed', { error: String(err) });
        }
    }

    private saveCheckpoint(sid: string, checkpoint: CompressionCheckpoint): void {
        try {
            this.memoryFacade.saveSessionCheckpoint({
                session_id: sid,
                seq: checkpoint.seq,
                summary: checkpoint.summary,
                original_count: checkpoint.originalCount,
                compressed_at: checkpoint.compressedAt,
                model: checkpoint.model || null,
                token_estimate: checkpoint.tokenEstimate
            });
        } catch (err1) {
            try {
                this.ensureCheckpointSchema();
                this.memoryFacade.saveSessionCheckpoint({
                    session_id: sid,
                    seq: checkpoint.seq,
                    summary: checkpoint.summary,
                    original_count: checkpoint.originalCount,
                    compressed_at: checkpoint.compressedAt,
                    model: checkpoint.model || null,
                    token_estimate: checkpoint.tokenEstimate
                });
            } catch (err2) {
                log.warn('checkpoint_save_failed', 'Failed to save checkpoint', { error: String(err2) });
            }
        }
    }

    private loadCheckpoints(): void {
        try {
            const rows = this.memoryFacade.loadSessionCheckpoints();
            for (const row of rows) {
                this.compressionCheckpoints.set(row.session_id, {
                    seq: row.seq,
                    summary: row.summary,
                    originalCount: row.original_count,
                    compressedAt: row.compressed_at,
                    model: row.model || undefined,
                    tokenEstimate: row.token_estimate || 0
                });
            }
            log.info(`Loaded ${rows.length} checkpoints, ${this.sessions.size} active sessions`);
        } catch (err) {
            log.warn('Checkpoints will be created on first compress:', (err as Error).message);
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
        this.deliveredArtifacts.delete(sid);
        this.activeGoals.delete(sid);
        this.turnToolCounts.delete(sid);
    }

    async closeAll(): Promise<void> {
        for (const transcript of this.sessions.values()) {
            await transcript.close();
        }
        this.sessions.clear();
        this.sessionMutexes.clear();
        this.lastActivity.clear();
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

    /** Injeta o CMIEngine. Chamado após construção para evitar dependência circular. */
    setCMIEngine(engine: CMIEngine): void {
        this.cmiEngine = engine;
        log.info('setCMIEngine', 'CMIEngine conectado ao SessionManager');
    }

    /**
     * Compact a session's JSONL by keeping only checkpoint + recent messages.
     * Writes a new .jsonl file and replaces the old one.
     * The old file is backed up as .jsonl.bak before compaction.
     * 
     * This prevents unbounded JSONL growth over time.
     */    async compactSession(key: SessionKey): Promise<{ before: number; after: number; saved: number }> {
        const sid = this.sessionKey(key);
        return this.withMutex(sid, async () => {
            const transcript = await this.getOrCreateSession(key);
            const stats = transcript.getStats();
            const before = stats.totalBytes;

            // Get checkpoint and recent messages to preserve
            const checkpoint = this.compressionCheckpoints.get(sid);
            const { entries } = await transcript.getSinceCheckpoint();

            if (!checkpoint && entries.length === 0) {
                return { before, after: before, saved: 0 };
            }

            // Build compact entries: checkpoint summary + recent messages
            const compactEntries: TranscriptEntry[] = [];
            if (checkpoint) {
                compactEntries.push({
                    ts: checkpoint.compressedAt,
                    seq: 1,
                    role: 'checkpoint',
                    content: checkpoint.summary,
                    meta: { checkpoint: true, compressed_up_to: checkpoint.seq }
                });
            }
            for (const entry of entries) {
                compactEntries.push({ ...entry, seq: compactEntries.length + 1 });
            }

            // Close current transcript, write compact, reinit
            await transcript.close();

            // Backup old file
            const fs = await import('fs');
            const oldPath = transcript.getFilePath();
            const bakPath = oldPath + '.bak';
            if (fs.existsSync(oldPath)) {
                fs.copyFileSync(oldPath, bakPath);
            }

            // Write compact JSONL
            const lines = compactEntries.map(e => JSON.stringify(e)).join('\n') + '\n';
            fs.writeFileSync(oldPath, lines, 'utf-8');

            // Delete index (will rebuild on next init)
            const idxPath = oldPath.replace('.jsonl', '.idx.json');
            if (fs.existsSync(idxPath)) {
                fs.unlinkSync(idxPath);
            }

            // Reinit transcript
            const newTranscript = new SessionTranscript(this.config.transcriptDir, sid);
            await newTranscript.init();
            this.sessions.set(sid, newTranscript);

            const afterStats = newTranscript.getStats();
            log.info(`Compacted ${sid}: ${before} -> ${afterStats.totalBytes} bytes (saved ${before - afterStats.totalBytes})`);

            return { before, after: afterStats.totalBytes, saved: before - afterStats.totalBytes };
        });
    }

    /**
     * Ensure conversation exists in MemoryManager DB.
     * addMessage has a FOREIGN KEY constraint — conversation_id must exist first.
     */
    private ensureConversation(key: SessionKey): void {
        const convId = this.conversationId(key);
        try {
            const created = this.memoryFacade.ensureConversation(convId, key.userId, key.channel);
            if (created) {
                log.info(`Created conversation: ${convId}`);
            }
        } catch (err) {
            // Conversation may already exist or table has different schema
            log.warn(`ensureConversation failed for ${convId}:`, (err as Error).message);
        }
    }
}
