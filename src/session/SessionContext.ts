/**
 * SessionContext — Builds LLM context from session transcript + memory (v2)
 * 
 * Pipeline (order matters!):
 * 1. System prompt (identity + skills)
 * 2. Checkpoint summary (STRUCTURED system role — not loose text)
 * 3. Recent transcript messages (linear replay)
 * 4. Semantic memory context (from MemoryManager graph)
 * 5. Current user message
 * 
 * If sessionContext is not set, AgentLoop throws (no silent fallback).
 */

import { SessionManager, SessionKey, estimateTokens } from './SessionManager';
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
        tokenEstimate: number;
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
     * Checkpoint is ALWAYS injected as a structured system role message,
     * never as loose text mixed with other context.
     */
    async buildLLMMessages(
        key: SessionKey,
        systemPrompt: string,
        currentMessage: string
    ): Promise<SessionContextResult> {
        const stats = {
            fromCheckpoint: false,
            checkpointSeq: undefined as number | undefined,
            recentMessages: 0,
            totalTranscriptEntries: 0,
            semanticContextUsed: false,
            tokenEstimate: 0
        };

        // 1. Get session transcript + checkpoint
        const { messages: transcriptMessages } = await this.sessionManager.buildContext(key, systemPrompt);
        const transcript = await this.sessionManager.getOrCreateSession(key);
        const transcriptStats = transcript.getStats();
        stats.totalTranscriptEntries = transcriptStats.totalEntries;

        // 2. Get checkpoint summary (structured, not loose)
        const checkpointSummary = this.sessionManager.getCheckpointSummary(key);
        if (checkpointSummary) {
            stats.fromCheckpoint = true;
        }

        // 3. Get semantic memory context
        let semanticContext = '';
        try {
            semanticContext = await this.contextBuilder.buildContext(currentMessage);
            stats.semanticContextUsed = semanticContext.length > 0;
        } catch {
            // Continue without semantic context
        }

        // 4. Build LLM messages array
        const llmMessages: LLMMessage[] = [];

        // System prompt (identity + skills)
        let systemContent = systemPrompt;
        if (semanticContext) {
            systemContent += `\n\n[Memória Semântica]\n${semanticContext}`;
        }
        llmMessages.push({ role: 'system', content: systemContent });

        // Checkpoint as STRUCTURED system role (always separate, never mixed)
        if (checkpointSummary) {
            llmMessages.push({
                role: 'system',
                content: `[RESUMO DA CONVERSA ANTERIOR]\n${checkpointSummary}\n[Use este resumo como contexto para continuar a conversa. Os detalhes foram comprimidos mas as informações essenciais estão preservadas.]`
            });
        }

        // Recent transcript messages
        for (const entry of transcriptMessages) {
            if (entry.role === 'user' || entry.role === 'assistant') {
                llmMessages.push({
                    role: entry.role as 'user' | 'assistant',
                    content: entry.content
                });
                stats.recentMessages++;
                stats.tokenEstimate += estimateTokens(entry.content);
            }
        }

        // Current user message (if not already in transcript)
        const lastUserMsg = transcriptMessages
            .filter(e => e.role === 'user')
            .pop();
        if (!lastUserMsg || lastUserMsg.content !== currentMessage) {
            llmMessages.push({ role: 'user', content: currentMessage });
            stats.recentMessages++;
            stats.tokenEstimate += estimateTokens(currentMessage);
        }

        return { messages: llmMessages, stats };
    }

    /**
     * Record a complete interaction cycle in the transcript.
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