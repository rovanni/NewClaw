/**
 * ContextBudget — Modular context builder with token budget control
 * 
 * Prevents context overflow by enforcing strict token limits per block.
 * Replaces the old "concatenate everything" approach.
 * 
 * Budget distribution (within num_ctx):
 *   MAX_CTX          = 32768 (or env OLLAMA_NUM_CTX)
 *   RESERVED_RESPONSE = 4000
 *   MAX_INPUT         = MAX_CTX - RESERVED_RESPONSE
 *   
 *   system  → 1500 tokens max
 *   state   →  500 tokens max
 *   memory  → 1000 tokens max
 *   history → 2000 tokens max (recent 6 messages, 1500 chars each)
 *   skills  →  500 tokens max
 */

import { createLogger } from '../shared/AppLogger';
const log = createLogger('ContextBudget');

// ── Types ────────────────────────────────────────────────────

export interface ContextBlock {
    role: 'system' | 'user' | 'assistant';
    content: string;
    priority: number; // higher = more important (kept first when truncating)
}

export interface ContextBudgetConfig {
    maxCtx: number;
    reservedForResponse: number;
    systemMaxTokens: number;
    stateMaxTokens: number;
    memoryMaxTokens: number;
    historyMaxTokens: number;
    skillsMaxTokens: number;
    maxHistoryMessages: number;
    maxMessageChars: number;
}

export const DEFAULT_BUDGET: ContextBudgetConfig = {
    maxCtx: parseInt(process.env.OLLAMA_NUM_CTX || '32768', 10),
    reservedForResponse: 4000,
    systemMaxTokens: 1500,
    stateMaxTokens: 500,
    memoryMaxTokens: 1000,
    historyMaxTokens: 2000,
    skillsMaxTokens: 500,
    maxHistoryMessages: 6,
    maxMessageChars: 1500,
};

// ── Token Estimation ──────────────────────────────────────────

export function estimateTokens(text: string): number {
    if (!text) return 0;
    const codeRatio = (text.match(/[{}()[\]:;,=<>\/]/g) || []).length / text.length;
    const charsPerToken = 3 + (1 - codeRatio) * 0.5;
    return Math.ceil(text.length / charsPerToken);
}

export function truncateToTokens(text: string, maxTokens: number): string {
    if (!text) return '';
    const estimated = estimateTokens(text);
    if (estimated <= maxTokens) return text;
    // Approximate: maxTokens * charsPerToken ≈ maxChars
    const maxChars = Math.floor(maxTokens * 3.5);
    const truncated = text.slice(0, maxChars);
    const lastPeriod = truncated.lastIndexOf('.');
    const lastNewline = truncated.lastIndexOf('\n');
    const cutPoint = Math.max(lastPeriod, lastNewline, maxChars - 100);
    return truncated.slice(0, cutPoint > 0 ? cutPoint : maxChars) + '\n[...truncated]';
}

export function truncateToChars(text: string, maxChars: number): string {
    if (!text || text.length <= maxChars) return text || '';
    const truncated = text.slice(0, maxChars);
    const lastPeriod = truncated.lastIndexOf('.');
    const lastNewline = truncated.lastIndexOf('\n');
    const cutPoint = Math.max(lastPeriod, lastNewline, maxChars - 100);
    return truncated.slice(0, cutPoint > 0 ? cutPoint : maxChars) + '\n[...truncated]';
}

// ── ContextBudget Class ──────────────────────────────────────

export class ContextBudget {
    private config: ContextBudgetConfig;

    constructor(config?: Partial<ContextBudgetConfig>) {
        this.config = { ...DEFAULT_BUDGET, ...config };
    }

    get maxInputTokens(): number {
        return this.config.maxCtx - this.config.reservedForResponse;
    }

    /**
     * Build the final message array for the LLM.
     * Each block is applied separately with its own budget.
     * Returns messages in the correct order.
     */
    buildMessages(params: {
        systemPrompt: string;
        stateBlock?: string;
        memoryBlock?: string;
        skillsBlock?: string;
        checkpointBlock?: string;
        recentMessages: Array<{ role: string; content: string }>;
        currentUserMessage: string;
    }): ContextBlock[] {
        const blocks: ContextBlock[] = [];
        let totalTokens = 0;

        // 1. System prompt (priority 10 — highest)
        const system = truncateToTokens(params.systemPrompt, this.config.systemMaxTokens);
        blocks.push({ role: 'system', content: system, priority: 10 });
        totalTokens += estimateTokens(system);

        // 2. State block (priority 8)
        if (params.stateBlock) {
            const state = truncateToTokens(params.stateBlock, this.config.stateMaxTokens);
            blocks.push({ role: 'system', content: state, priority: 8 });
            totalTokens += estimateTokens(state);
        }

        // 3. Memory summary (priority 6) — compact, never full graph
        if (params.memoryBlock) {
            const memory = truncateToTokens(params.memoryBlock, this.config.memoryMaxTokens);
            blocks.push({ role: 'system', content: memory, priority: 6 });
            totalTokens += estimateTokens(memory);
        }

        // 4. Skills (priority 5)
        if (params.skillsBlock) {
            const skills = truncateToTokens(params.skillsBlock, this.config.skillsMaxTokens);
            blocks.push({ role: 'system', content: skills, priority: 5 });
            totalTokens += estimateTokens(skills);
        }

        // 5. Checkpoint (priority 7)
        if (params.checkpointBlock) {
            const checkpoint = truncateToTokens(params.checkpointBlock, this.config.historyMaxTokens);
            blocks.push({ role: 'system', content: `[RESUMO DA CONVERSA]\n${checkpoint}\n[Use este resumo como contexto.]`, priority: 7 });
            totalTokens += estimateTokens(checkpoint);
        }

        // 6. Recent messages (priority 3-4)
        const recentLimited = params.recentMessages
            .slice(-this.config.maxHistoryMessages)
            .map(m => ({
                ...m,
                content: truncateToChars(m.content, this.config.maxMessageChars)
            }));

        let historyTokenBudget = this.config.historyMaxTokens;
        for (const msg of recentLimited) {
            const msgTokens = estimateTokens(msg.content);
            if (msgTokens > historyTokenBudget) {
                // Truncate further to fit
                const remaining = truncateToTokens(msg.content, historyTokenBudget);
                blocks.push({ role: msg.role as any, content: remaining, priority: 3 });
                totalTokens += estimateTokens(remaining);
                historyTokenBudget -= estimateTokens(remaining);
            } else {
                blocks.push({ role: msg.role as any, content: msg.content, priority: 3 });
                totalTokens += msgTokens;
                historyTokenBudget -= msgTokens;
            }
            if (historyTokenBudget <= 0) break;
        }

        // 7. Current user message (priority 9 — always included)
        blocks.push({ role: 'user', content: params.currentUserMessage, priority: 9 });
        totalTokens += estimateTokens(params.currentUserMessage);

        // 8. Final safety check: if we exceed max input, truncate lowest priority blocks
        if (totalTokens > this.maxInputTokens) {
            log.warn(`Context overflow: ${totalTokens} tokens > ${this.maxInputTokens} max. Truncating low-priority blocks.`);
            // Sort by priority descending, keep highest priority blocks
            blocks.sort((a, b) => b.priority - a.priority);
            let kept = 0;
            for (const block of blocks) {
                if (kept + estimateTokens(block.content) <= this.maxInputTokens) {
                    kept += estimateTokens(block.content);
                } else {
                    // Truncate this block to fit
                    const remaining = this.maxInputTokens - kept;
                    block.content = truncateToTokens(block.content, remaining);
                    break;
                }
            }
            // Re-sort to correct order (system first, then history, then user)
            blocks.sort((a, b) => {
                const roleOrder: Record<string, number> = { system: 0, user: 1, assistant: 2 };
                return (roleOrder[a.role] || 0) - (roleOrder[b.role] || 0);
            });
        }

        log.info(`ContextBudget: ${totalTokens} tokens across ${blocks.length} blocks (max: ${this.maxInputTokens})`);
        return blocks;
    }

    /**
     * Convert ContextBlocks to LLMMessage format.
     */
    toLLMMessages(blocks: ContextBlock[]): Array<{ role: string; content: string }> {
        return blocks.map(b => ({ role: b.role, content: b.content }));
    }
}