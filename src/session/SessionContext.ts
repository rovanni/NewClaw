/**
 * SessionContext — Builds LLM context from session transcript + memory (v3)
 * 
 * REFACTORED: Uses ContextBudget for modular context assembly.
 * Each context block is now a separate system message with its own budget.
 * No more monolithic concatenation.
 * 
 * Pipeline (order matters!):
 * 1. System prompt (identity + skills) — separate system message
 * 2. State block (short system info) — separate system message
 * 3. Memory summary (compact top-K) — separate system message
 * 4. Checkpoint summary (structured system role)
 * 5. Recent transcript messages (linear replay, budgeted)
 * 6. Current user message
 */

import { SessionManager, SessionKey, estimateTokens as legacyEstimateTokens } from './SessionManager';
import { ContextBuilder } from '../loop/ContextBuilder';
import { MemoryManager } from '../memory/MemoryManager';
import { ContextBudget, ContextBlock, DEFAULT_BUDGET, truncateToChars } from '../loop/ContextBudget';
import { LLMMessage } from '../core/ProviderFactory';
import { createLogger } from '../shared/AppLogger';
const log = createLogger('SessionContext');

export interface SessionContextResult {
    messages: LLMMessage[];
    stats: {
        fromCheckpoint: boolean;
        checkpointSeq?: number;
        recentMessages: number;
        totalTranscriptEntries: number;
        semanticContextUsed: boolean;
        tokenEstimate: number;
        budgetUsed: number;
        budgetMax: number;
    };
}

export class SessionContext {
    private sessionManager: SessionManager;
    private contextBuilder: ContextBuilder;
    private memory: MemoryManager;
    private budget: ContextBudget;

    constructor(sessionManager: SessionManager, memory: MemoryManager, budgetConfig?: Partial<typeof DEFAULT_BUDGET>) {
        this.sessionManager = sessionManager;
        this.contextBuilder = new ContextBuilder(memory);
        this.memory = memory;
        this.budget = new ContextBudget(budgetConfig);
    }

    /**
     * Build the complete context for an LLM call using ContextBudget.
     * 
     * Each context source is a SEPARATE system message — no concatenation.
     * Budget is enforced per-block to prevent context overflow.
     */
    async buildLLMMessages(
        key: SessionKey,
        systemPrompt: string,
        currentMessage: string,
        skillsBlock?: string
    ): Promise<SessionContextResult> {
        const stats = {
            fromCheckpoint: false,
            checkpointSeq: undefined as number | undefined,
            recentMessages: 0,
            totalTranscriptEntries: 0,
            semanticContextUsed: false,
            tokenEstimate: 0,
            budgetUsed: 0,
            budgetMax: this.budget.maxInputTokens
        };

        // 1. Get session transcript
        const { messages: transcriptMessages } = await this.sessionManager.buildContext(key, systemPrompt);
        const transcript = await this.sessionManager.getOrCreateSession(key);
        const transcriptStats = transcript.getStats();
        stats.totalTranscriptEntries = transcriptStats.totalEntries;

        // 2. Get checkpoint summary (compact)
        const checkpointSummary = this.sessionManager.getCheckpointSummary(key);
        if (checkpointSummary) {
            stats.fromCheckpoint = true;
        }

        // 3. Get semantic memory context (compact, top-K — NOT full graph)
        let memoryContext = '';
        try {
            memoryContext = await this.contextBuilder.buildContext(currentMessage);
            stats.semanticContextUsed = memoryContext.length > 0;
        } catch {
            // Continue without semantic context
        }

        // 4. Build state block (short, essential info)
        const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'full', timeStyle: 'short' });
        const stateBlock = `[ESTADO]\nData: ${now}`;

        // 5. Build context using ContextBudget (modular, budgeted)
        const blocks: ContextBlock[] = this.budget.buildMessages({
            systemPrompt,
            stateBlock,
            memoryBlock: memoryContext ? `[MEMÓRIA]\n${memoryContext}` : undefined,
            skillsBlock: skillsBlock ? `[HABILIDADES]\n${skillsBlock}` : undefined,
            checkpointBlock: checkpointSummary || undefined,
            recentMessages: transcriptMessages
                .filter(e => e.role === 'user' || e.role === 'assistant')
                .map(e => ({ role: e.role, content: e.content })),
            currentUserMessage: currentMessage
        });

        // 6. Convert to LLMMessage format
        const llmMessages: LLMMessage[] = blocks.map(b => ({
            role: b.role as 'system' | 'user' | 'assistant',
            content: b.content
        }));

        // 7. Calculate stats
        stats.recentMessages = transcriptMessages.filter(e => e.role === 'user' || e.role === 'assistant').length;
        stats.tokenEstimate = blocks.reduce((sum, b) => sum + estimateTokens(b.content), 0);
        stats.budgetUsed = stats.tokenEstimate;

        log.info(`SessionContext: ${stats.tokenEstimate} tokens / ${stats.budgetMax} max, ${stats.recentMessages} recent msgs, memory=${stats.semanticContextUsed}, checkpoint=${stats.fromCheckpoint}`);

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

// Re-export for compatibility
function estimateTokens(text: string): number {
    if (!text) return 0;
    const codeRatio = (text.match(/[{}()[\]:;,=<>\/]/g) || []).length / text.length;
    const charsPerToken = 3 + (1 - codeRatio) * 0.5;
    return Math.ceil(text.length / charsPerToken);
}