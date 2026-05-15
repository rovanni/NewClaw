/**
 * CognitiveWorkspace — Governed working memory for internal reasoning
 *
 * This is NOT long-term memory. It's a temporary scratchpad for:
 * - Chain-of-thought continuity across steps
 * - Multi-step planning context
 * - Self-correction intelligence
 * - Retry with context
 *
 * GOVERNANCE (critical — prevents unbounded growth):
 * - Token budget (default: 2000 tokens)
 * - TTL per entry (default: 5 minutes)
 * - Automatic pruning when budget exceeded
 * - Distillation: compress old reasoning into summaries
 * - NEVER persisted to semantic memory graph (prevents self-contamination)
 * - NEVER shown to user (boundary management)
 *
 * Architecture position:
 *   Semantic Memory  → long-term facts (MemoryManager + Graph)
 *   Episodic Memory  → interaction summaries (MemoryCurator)
 *   Working Memory   → THIS — temporary reasoning scratchpad
 *   Procedural Memory → learned strategies (SkillLearner)
 */

import { createLogger } from '../shared/AppLogger';
const log = createLogger('CognitiveWorkspace');

// ── Types ──

export interface WorkspaceEntry {
    /** Step number in the conversation loop */
    step: number;
    /** Timestamp of creation */
    createdAt: number;
    /** TTL in ms — entry is pruned after this */
    ttlMs: number;
    /** Type of reasoning */
    type: 'planning' | 'reasoning' | 'reflection' | 'error_recovery' | 'self_correction';
    /** The reasoning content (NEVER shown to user) */
    content: string;
    /** Estimated token count */
    tokenCount: number;
    /** Whether this has been distilled/summarized */
    distilled: boolean;
}

export interface WorkspaceConfig {
    /** Maximum tokens allowed in workspace before pruning */
    maxTokens: number;
    /** Default TTL for entries (ms) */
    defaultTtlMs: number;
    /** Maximum number of entries before pruning */
    maxEntries: number;
    /** Whether to auto-distill when budget exceeded */
    autoDistill: boolean;
    /** Token estimation: characters per token (rough) */
    charsPerToken: number;
}

export const DEFAULT_WORKSPACE_CONFIG: WorkspaceConfig = {
    maxTokens: 2000,
    defaultTtlMs: 5 * 60 * 1000, // 5 minutes
    maxEntries: 20,
    autoDistill: true,
    charsPerToken: 4,
};

// ── CognitiveWorkspace ──

export class CognitiveWorkspace {
    private entries: WorkspaceEntry[] = [];
    private config: WorkspaceConfig;
    private distilled: string = '';

    constructor(config: Partial<WorkspaceConfig> = {}) {
        this.config = { ...DEFAULT_WORKSPACE_CONFIG, ...config };
    }

    /** Add a reasoning entry to the workspace */
    add(step: number, content: string, type: WorkspaceEntry['type'] = 'reasoning'): void {
        if (!content || !content.trim()) return;

        const tokenCount = Math.ceil(content.length / this.config.charsPerToken);
        const entry: WorkspaceEntry = {
            step,
            createdAt: Date.now(),
            ttlMs: this.config.defaultTtlMs,
            type,
            content: content.trim(),
            tokenCount,
            distilled: false,
        };

        this.entries.push(entry);
        log.info(`[COGNITIVE-WORKSPACE] Added ${type} entry (step=${step}, tokens≈${tokenCount}, total=${this.totalTokens()})`);

        // Auto-prune if budget exceeded
        this.maybePrune();
    }

    /** Get current workspace context for LLM (as system message prefix) */
    getContext(): string {
        this.pruneExpired();
        const activeEntries = this.entries.filter(e => !e.distilled);

        if (activeEntries.length === 0 && !this.distilled) return '';

        const parts: string[] = [];
        if (this.distilled) {
            parts.push(`[RESUMO DO RACIOCÍNIO ANTERIOR]\n${this.distilled}`);
        }
        for (const entry of activeEntries) {
            parts.push(`[PASSO ${entry.step} - ${entry.type.toUpperCase()}]\n${entry.content}`);
        }

        return parts.join('\n\n');
    }

    /** Get total token count */
    totalTokens(): number {
        return this.entries.reduce((sum, e) => sum + e.tokenCount, 0)
            + Math.ceil(this.distilled.length / this.config.charsPerToken);
    }

    /** Prune expired entries */
    private pruneExpired(): void {
        const now = Date.now();
        const before = this.entries.length;
        this.entries = this.entries.filter(e => (now - e.createdAt) < e.ttlMs);
        const pruned = before - this.entries.length;
        if (pruned > 0) {
            log.debug(`[COGNITIVE-WORKSPACE] Pruned ${pruned} expired entries`);
        }
    }

    /** Auto-prune if budget exceeded — distills old entries into summary */
    private maybePrune(): void {
        const totalTokens = this.totalTokens();

        if (totalTokens <= this.config.maxTokens) return;

        if (this.config.autoDistill && this.entries.length > 3) {
            this.distill();
        }

        // If still over budget after distillation, drop oldest non-distilled entries
        if (this.totalTokens() > this.config.maxTokens) {
            let dropped = 0;
            while (this.entries.length > 0 && this.totalTokens() > this.config.maxTokens) {
                this.entries.shift();
                dropped++;
            }
            if (dropped > 0) {
                log.info(`[COGNITIVE-WORKSPACE] Budget enforced: dropped ${dropped} oldest entries`);
            }
        }

        // If still over max entries, drop oldest
        while (this.entries.length > this.config.maxEntries) {
            this.entries.shift();
        }
    }

    /** Distill old entries into a compressed summary */
    private distill(): void {
        const oldEntries = this.entries.filter(e => !e.distilled);
        if (oldEntries.length < 2) return;

        // Mark entries for distillation
        const toDistill = oldEntries.slice(0, Math.ceil(oldEntries.length / 2));

        // Compress: take key insights from each entry (first 100 chars)
        const summary = `Raciocínio anterior: ${toDistill.map(e => {
            const snippet = e.content.slice(0, 100).replace(/\n/g, ' ');
            return `${e.type}(${e.step}): ${snippet}`;
        }).join(' → ')}`;

        this.distilled = this.distilled
            ? `${this.distilled}\n${summary}`
            : summary;

        // Mark as distilled
        for (const entry of toDistill) {
            entry.distilled = true;
        }

        // Remove distilled entries from active list
        this.entries = this.entries.filter(e => !e.distilled);

        log.info(`[COGNITIVE-WORKSPACE] Distilled ${toDistill.length} entries into summary (${Math.ceil(this.distilled.length / this.config.charsPerToken)} tokens)`);
    }

    /** Reset workspace (called at start of each conversation turn) */
    reset(): void {
        this.entries = [];
        this.distilled = '';
    }

    /** Get stats for observability */
    getStats(): { entries: number; totalTokens: number; distilled: boolean; types: Record<string, number> } {
        this.pruneExpired();
        const types: Record<string, number> = {};
        for (const e of this.entries) {
            types[e.type] = (types[e.type] || 0) + 1;
        }
        return {
            entries: this.entries.length,
            totalTokens: this.totalTokens(),
            distilled: this.distilled.length > 0,
            types,
        };
    }

    /**
     * IMPORTANT: Convert workspace to context for LLM system message.
     * This is the ONLY way workspace content reaches the LLM — as internal context,
     * never as visible output.
     */
    toSystemContext(): string {
        const context = this.getContext();
        if (!context) return '';

        return `[CONTEXTO INTERNO DE RACIOCÍNIO — NÃO mencionar ao usuário]\n${context}\n[FIM DO CONTEXTO INTERNO]`;
    }
}