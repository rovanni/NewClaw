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

import { SessionManager, SessionKey } from './SessionManager';
import { ContextBuilder } from '../loop/ContextBuilder';
import { MemoryManager } from '../memory/MemoryManager';
import { ContextBudget, ContextBlock, DEFAULT_BUDGET } from '../loop/ContextBudget';
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
    private budget: ContextBudget;

    constructor(sessionManager: SessionManager, memory: MemoryManager, budgetConfig?: Partial<typeof DEFAULT_BUDGET>) {
        this.sessionManager = sessionManager;
        this.contextBuilder = new ContextBuilder(memory);
        this.budget = new ContextBudget(budgetConfig);
    }

    /** Expose the ContextBuilder so callers (e.g. AgentLoop) can read post-build metadata. */
    getContextBuilder(): ContextBuilder { return this.contextBuilder; }

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
        skillsBlock?: string,
        contextTier?: import('../loop/ContextBuilder').ContextTier,
        channelMetadata?: Record<string, unknown>
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
        } else if (stats.totalTranscriptEntries > 50) {
            log.warn(`SessionContext: no checkpoint for session with ${stats.totalTranscriptEntries} entries — historical context may be missing`);
        }

        // 3. Get semantic memory context (compact, top-K — NOT full graph)
        let memoryContext = '';
        try {
            memoryContext = await this.contextBuilder.buildContext(currentMessage, undefined, contextTier);
            stats.semanticContextUsed = memoryContext.length > 0;
        } catch (err) {
            log.warn(`SessionContext: semantic context build failed (non-fatal): ${err}`);
        }

        // 4. Build state block (short, essential info)
        const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'full', timeStyle: 'short' });
        let stateBlock = `[ESTADO]\nData: ${now}`;

        // Injeta contexto do aplicativo hospedeiro quando presente.
        // Atualmente apenas o suplemento PowerPoint define hostApp='powerpoint'.
        // Canais como Telegram, Discord, dashboard web NAO possuem hostApp.
        const HOST_APP_HINTS: Record<string, string> = {
            powerpoint: 'Suplemento Microsoft PowerPoint — o usuario esta interagindo de dentro do PowerPoint. '
                + 'Quando o usuario mencionar "tema", "slide", "apresentacao", "design" ou termos similares, '
                + 'presuma que se refere ao contexto do PowerPoint aberto. '
                + 'Voce pode gerar e inserir slides .pptx diretamente na apresentacao ativa via send_document.',
        };
        const hostApp = channelMetadata?.hostApp as string | undefined;
        if (hostApp && HOST_APP_HINTS[hostApp]) {
            stateBlock += `\nCanal: ${HOST_APP_HINTS[hostApp]}`;
            
            // Injeta as informacoes detalhadas do slideContext se existirem
            const slideContext = channelMetadata?.slideContext as { currentSlide?: number, totalSlides?: number, slideTexts?: string[] } | undefined;
            if (slideContext) {
                stateBlock += `\n\n[CONTEXTO DO POWERPOINT ABERTO]`;
                if (slideContext.currentSlide && slideContext.totalSlides) {
                    stateBlock += `\nSlide ativo: ${slideContext.currentSlide} de ${slideContext.totalSlides}`;
                }
                if (slideContext.slideTexts && slideContext.slideTexts.length > 0) {
                    stateBlock += `\nTextos no slide ativo:\n- ${slideContext.slideTexts.join('\n- ')}`;
                } else {
                    stateBlock += `\nTextos no slide ativo: (Nenhum texto legivel encontrado)`;
                }
            }
        }

        const activeFiles = this.sessionManager.getActiveFilesBlock(key);
        if (activeFiles) {
            stateBlock += `\n\n${activeFiles}`;
        }

        const deliveredArtifacts = this.sessionManager.getDeliveredArtifactsBlock(key);
        if (deliveredArtifacts) {
            stateBlock += `\n\n${deliveredArtifacts}`;
        }

        // 5. Build context using ContextBudget (modular, budgeted)
        const blocks: ContextBlock[] = this.budget.buildMessages({
            systemPrompt,
            stateBlock,
            memoryBlock: memoryContext
                ? `[MEMÓRIA — CONTEXTO PESSOAL DO USUÁRIO]\nCRÍTICO: Se o bloco abaixo contiver [INSTRUCOES PERSONALIZADAS], leia-as ANTES de qualquer outra coisa e aplique-as à resposta. Preferências do usuário SOBRESCREVEM o conhecimento geral do modelo sem exceção.\n${memoryContext}`
                : undefined,
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

        // [FINAL-CONTEXT] — auditoria do contexto final enviado ao LLM
        const memBlock = blocks.find(b => b.content.includes('[MEMÓRIA'));
        if (memBlock) {
            const memChars = memBlock.content.length;
            // Verificar se termos de alto risco aparecem no bloco de memória — mesma feature de
            // diagnóstico/auditoria de ContextBuilder.ts, mesma env var (configurável por
            // instalação em vez de hardcoded: projeto open source, termos pessoais sensíveis
            // não pertencem ao repositório público).
            const RISK_TERMS = (process.env.CONTAMINATION_WATCH_TERMS || '')
                .toLowerCase().split(',').map(t => t.trim()).filter(Boolean);
            const found = RISK_TERMS.filter(t => memBlock.content.toLowerCase().includes(t));
            log.info(
                `[FINAL-CONTEXT] memBlock_chars=${memChars} riskTerms=[${found.join(',') || 'none'}] ` +
                `total_blocks=${blocks.length} total_tokens=${stats.tokenEstimate}`
            );
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

// Re-export for compatibility
function estimateTokens(text: string): number {
    if (!text) return 0;
    const codeRatio = (text.match(/[{}()[\]:;,=<>\/]/g) || []).length / text.length;
    const charsPerToken = 3 + (1 - codeRatio) * 0.5;
    return Math.ceil(text.length / charsPerToken);
}