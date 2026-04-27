/**
 * SessionContext — Builds LLM context from session transcript + memory
 * 
 * Replaces the naive "keep last N messages" approach with:
 * 1. Compression checkpoint (summary of older messages)
 * 2. Recent transcript messages (linear replay)
 * 3. Semantic memory context (from MemoryManager graph)
 * 4. System prompt with identity + skills
 * 
 * This ensures:
 * - No conversation is ever lost (JSONL = full replay)
 * - Context window is used efficiently (summary + recent)
 * - Semantic memory enriches context beyond just transcript
 */

import { SessionManager, SessionKey } from './SessionManager';
import { ContextBuilder } from '../loop/ContextBuilder';
import { MemoryManager } from '../memory/MemoryManager';
import { LLMMessage } from '../core/ProviderFactory';

export interface SessionContextResult {
    messages: LLMMessage[];
    stats: {
        fromCheckpoint: boolean;
        checkpointSeq?: number;
        recentMessages: number;
        totalTranscriptEntries: number;
        semanticContextUsed: boolean;
    };
}

export class SessionContext {
    private sessionManager: SessionManager;
    private contextBuilder: ContextBuilder;
    private memory: MemoryManager;

    constructor(sessionManager: SessionManager, memory: MemoryManager) {
        this.sessionManager = sessionManager;
        this.contextBuilder = new ContextBuilder(memory);
        this.memory = memory;
    }

    /**
     * Build the complete context for an LLM call.
     * 
     * Pipeline:
     * 1. Get session transcript + checkpoint
     * 2. Get semantic memory context
     * 3. Compose final messages array
     */
    async buildLLMMessages(
        key: SessionKey,
        systemPrompt: string,
        currentMessage: string
    ): Promise<SessionContextResult> {
        const sessionKey = `${key.channel}:${key.userId}`;
        const stats = {
            fromCheckpoint: false,
            checkpointSeq: undefined as number | undefined,
            recentMessages: 0,
            totalTranscriptEntries: 0,
            semanticContextUsed: false
        };

        // 1. Get session context (checkpoint summary + recent messages)
        const { messages: transcriptMessages, contextString } = await this.sessionManager.buildContext(key, systemPrompt);
        const transcript = await this.sessionManager.getOrCreateSession(key);
        const transcriptStats = transcript.getStats();
        stats.totalTranscriptEntries = transcriptStats.totalEntries;

        // Check if context came from a checkpoint
        const checkpoint = this.sessionManager.getSessionStats(key);
        if (checkpoint?.hasCheckpoint) {
            stats.fromCheckpoint = true;
            stats.checkpointSeq = checkpoint.lastActivity ? undefined : undefined; // will be set by checkpoint data
        }

        // 2. Get semantic memory context
        let semanticContext = '';
        try {
            semanticContext = await this.contextBuilder.buildContext(currentMessage);
            stats.semanticContextUsed = semanticContext.length > 0;
        } catch {
            // Semantic search may fail, continue without it
        }

        // 3. Build LLM messages array
        const llmMessages: LLMMessage[] = [];

        // System message with checkpoint summary + semantic context
        let systemContent = contextString;
        if (semanticContext) {
            systemContent += `\n\n[Memória Semântica]\n${semanticContext}`;
        }
        llmMessages.push({ role: 'system', content: systemContent });

        // Recent transcript messages (after checkpoint)
        for (const entry of transcriptMessages) {
            if (entry.role === 'user' || entry.role === 'assistant') {
                llmMessages.push({
                    role: entry.role as 'user' | 'assistant',
                    content: entry.content
                });
                stats.recentMessages++;
            }
        }

        // Current user message (if not already in transcript)
        const lastUserMsg = transcriptMessages
            .filter(e => e.role === 'user')
            .pop();
        if (!lastUserMsg || lastUserMsg.content !== currentMessage) {
            llmMessages.push({ role: 'user', content: currentMessage });
            stats.recentMessages++;
        }

        return { messages: llmMessages, stats };
    }

    /**
     * Record a complete interaction cycle in the transcript.
     * Call this after each user-assistant exchange.
     */
    async recordExchange(
        key: SessionKey,
        userMessage: string,
        assistantMessage: string,
        meta?: {
            model?: string;
            tokens?: number;
            tools_used?: string[];
            duration_ms?: number;
        }
    ): Promise<void> {
        await this.sessionManager.recordUserMessage(key, userMessage, meta ? { model: meta.model } : undefined);
        await this.sessionManager.recordAssistantMessage(key, assistantMessage, meta ? {
            model: meta.model,
            tokens: meta.tokens,
            tools_used: meta.tools_used,
            duration_ms: meta.duration_ms
        } : undefined);
    }
}