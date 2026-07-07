/**
 * CMIIngestionPipeline — Converte um buffer de TranscriptEntry em um ConversationChunk.
 *
 * Pipeline:
 *   entries → filter trivial → extract metadata → summarize → embed → quality score → chunk
 *
 * Reutiliza:
 *   - ProviderFactory (para sumarização via LLM e classificação de domínio via LLM)
 *   - createDomainClassifierLLM (DomainRegistry — julgamento semântico, não keyword-scoring)
 *   - Ollama nomic-embed-text (mesmo modelo do EmbeddingService)
 */

import { ProviderFactory } from '../../core/ProviderFactory';
import { TranscriptEntry } from '../../session/SessionTranscript';
import { BufferState, ChunkCutTrigger, ChunkMessage, ConversationChunk } from './cmiTypes';
import { createDomainClassifierLLM, type DomainClassifierLLM } from '../DomainRegistry';
import { createLogger } from '../../shared/AppLogger';
import { extractText } from '../../loop/ResponseAdapter';

const log = createLogger('CMIIngestionPipeline');

/** Máximo de chars por mensagem no snapshot do chunk */
const MAX_MSG_CHARS = 400;
/** Dimensão do embedding nomic-embed-text */
const EMBED_DIM = 768;
/** Timeout para chamada Ollama (ms) */
const EMBED_TIMEOUT_MS = 10_000;

export class CMIIngestionPipeline {
    private providerFactory: ProviderFactory;
    private ollamaUrl: string;
    // Classificação de domínio via LLM (substitui o keyword-scoring de classifyDomain() por
    // julgamento semântico real — ver DomainRegistry.createDomainClassifierLLM). Já tem
    // ProviderFactory injetado aqui, então não precisa do padrão de setter opcional usado em
    // ContextBuilder.ts/memory_write.ts (que não tinham essa dependência disponível).
    private domainClassifierLLM: DomainClassifierLLM;

    constructor(providerFactory: ProviderFactory, ollamaUrl = 'http://localhost:11434') {
        this.providerFactory = providerFactory;
        this.ollamaUrl = ollamaUrl;
        this.domainClassifierLLM = createDomainClassifierLLM(providerFactory);
    }

    /**
     * Processa um buffer drenado em um ConversationChunk pronto para persistência.
     * Retorna null se o buffer não tem conteúdo suficiente para um chunk válido.
     */
    async process(
        sessionKey: string,
        conversationId: string,
        state: BufferState,
        cutTrigger: ChunkCutTrigger
    ): Promise<ConversationChunk | null> {
        const startMs = Date.now();

        // 1. Filtrar entradas triviais
        const relevant = this.filterTrivial(state.entries);
        if (relevant.length < 2) {
            log.info('process', `${sessionKey} — buffer insuficiente após filtro (${relevant.length} entradas), descartando`);
            return null;
        }

        // 2. Extrair metadados
        const metadata = await this.extractMetadata(relevant, state);

        // 3. Construir snapshot de mensagens para o chunk
        const messages = this.buildMessages(relevant);

        // 4. Sumarizar via LLM (assíncrono — pode falhar, tem fallback)
        const summary = await this.summarize(messages, metadata.topics);

        // 5. Gerar embedding do summary
        const embedding = await this.embedText(summary);

        // 6. Calcular chunk quality
        const quality = this.calculateQuality({
            messages,
            toolsUsed: metadata.toolsUsed,
            topics: metadata.topics,
            entities: metadata.entities,
            workflowCompleted: state.workflowCompleted,
            cutTrigger
        });

        // 7. TTL baseado na qualidade
        const ttlMs = this.computeTTL(quality);

        const firstEntry = relevant[0];
        const lastEntry = relevant[relevant.length - 1];

        const chunk: ConversationChunk = {
            id: `cmi_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
            sessionKey,
            conversationId,
            startSeq: firstEntry.seq,
            endSeq: lastEntry.seq,
            startTimestamp: new Date(firstEntry.ts).getTime(),
            endTimestamp: new Date(lastEntry.ts).getTime(),
            summary,
            topics: metadata.topics,
            entities: metadata.entities,
            intent: metadata.intent,
            messages,
            embedding,
            workflowId: null, // futuramente: WorkflowEngine.getActiveId()
            toolsUsed: metadata.toolsUsed,
            chunkQuality: quality,
            cutTrigger,
            createdAt: Date.now(),
            lastAccessedAt: null,
            accessCount: 0,
            expiresAt: ttlMs ? Date.now() + ttlMs : null
        };

        const durationMs = Date.now() - startMs;
        log.info('process', `chunk criado: ${chunk.id} quality=${quality.toFixed(2)} trigger=${cutTrigger} entries=${relevant.length} embed=${!!embedding} t=${durationMs}ms`);

        return chunk;
    }

    // ── 1. FILTRO DE TRIVIALIDADE ──────────────────────────────────────────────

    /**
     * Remove entradas sem valor episódico.
     * Critérios estruturais (sem regex semântico):
     * - Conteúdo muito curto (< 20 chars)
     * - tool_call sem resultado de sucesso
     * - tool_result com erro
     * - checkpoint entries (são triggers, não conteúdo)
     * - system entries
     */
    private filterTrivial(entries: TranscriptEntry[]): TranscriptEntry[] {
        return entries.filter(entry => {
            if (entry.role === 'checkpoint' || entry.role === 'system') return false;
            if (entry.role === 'tool_result' && entry.meta?.tool_success === false) return false;
            if (entry.role === 'user' || entry.role === 'assistant') {
                if (entry.content.trim().length < 20) return false;
            }
            return true;
        });
    }

    // ── 2. EXTRAÇÃO DE METADADOS ───────────────────────────────────────────────

    private async extractMetadata(
        entries: TranscriptEntry[],
        state: BufferState
    ): Promise<{ topics: string[]; entities: string[]; intent: string; toolsUsed: string[] }> {
        // Tópicos: classificar domínios das mensagens de usuário via LLM (mais preciso que
        // keyword-scoring — ver DomainRegistry.createDomainClassifierLLM). Chamado em série
        // (não Promise.all) deliberadamente: chunk fecha só ocasionalmente (fim de conversa),
        // não é um caminho de latência crítica por mensagem.
        const topicSet = new Set<string>();
        if (state.currentDomain) topicSet.add(state.currentDomain);
        for (const entry of entries) {
            if (entry.role === 'user') {
                const d = await this.domainClassifierLLM(entry.content);
                if (d) topicSet.add(d.domainId);
            }
        }

        // Entidades: nomes de arquivos e tools usadas
        const entitySet = new Set<string>();
        for (const entry of entries) {
            if (entry.role === 'tool_call' && entry.meta?.tool_name) {
                entitySet.add(entry.meta.tool_name);
                // Extrair path de arquivos do input JSON
                if (entry.meta.tool_input) {
                    try {
                        const parsed = JSON.parse(entry.meta.tool_input) as Record<string, unknown>;
                        if (typeof parsed.path === 'string') entitySet.add(parsed.path);
                        if (typeof parsed.file === 'string') entitySet.add(parsed.file);
                        if (typeof parsed.filename === 'string') entitySet.add(parsed.filename);
                    } catch { /* ignore */ }
                }
            }
        }

        // Intent: vem do meta da primeira mensagem de usuário (salvo pelo AgentLoop)
        const firstUserEntry = entries.find(e => e.role === 'user');
        const intent = (firstUserEntry?.meta as Record<string, unknown> | undefined)?.['intent'] as string || '';

        return {
            topics: [...topicSet],
            entities: [...entitySet],
            intent,
            toolsUsed: state.toolsDetected
        };
    }

    // ── 3. SNAPSHOT DE MENSAGENS ───────────────────────────────────────────────

    private buildMessages(entries: TranscriptEntry[]): ChunkMessage[] {
        return entries
            .filter(e => e.role === 'user' || e.role === 'assistant')
            .map(e => ({
                role: e.role as 'user' | 'assistant',
                content: e.content.slice(0, MAX_MSG_CHARS)
            }));
    }

    // ── 4. SUMARIZAÇÃO LLM ─────────────────────────────────────────────────────

    /**
     * Gera um resumo episódico focado em: O QUE aconteceu, QUAIS ferramentas
     * foram usadas, QUAL foi o resultado. Máximo 150 palavras.
     *
     * Usa ProviderFactory (provider padrão configurado no sistema).
     */
    private async summarize(messages: ChunkMessage[], topics: string[]): Promise<string> {
        if (messages.length === 0) return 'Conversa sem conteúdo relevante.';

        const conversationText = messages
            .map(m => `${m.role === 'user' ? 'Usuário' : 'Assistente'}: ${m.content}`)
            .join('\n');

        const topicHint = topics.length > 0 ? ` Domínios: ${topics.join(', ')}.` : '';

        const prompt = [
            {
                role: 'system' as const,
                content: 'Você é um assistente especializado em criar resumos episódicos de conversas. Resuma em 80-150 palavras o QUE foi discutido, QUAIS ações foram tomadas e QUAL foi o resultado. Seja factual e específico. Preserve nomes de arquivos, ferramentas e resultados importantes.'
            },
            {
                role: 'user' as const,
                content: `Resuma este episódio conversacional:${topicHint}\n\n${conversationText}`
            }
        ];

        try {
            const response = await this.providerFactory.getProvider().chat(prompt);
            const text = extractText(response.content || '');
            return text.trim() || this.fallbackSummary(messages);
        } catch (err) {
            log.warn('summarize', `LLM falhou: ${String(err)}`);
            return this.fallbackSummary(messages);
        }
    }

    private fallbackSummary(messages: ChunkMessage[]): string {
        const userMsgs = messages
            .filter(m => m.role === 'user')
            .slice(0, 4)
            .map(m => m.content.slice(0, 120))
            .join(' | ');
        return `Conversa com ${messages.length} mensagens. Tópicos: ${userMsgs || '(sem conteúdo)'}`;
    }

    // ── 5. EMBEDDING ───────────────────────────────────────────────────────────

    /**
     * Gera embedding do summary via Ollama nomic-embed-text.
     * Mesma abordagem do EmbeddingService: Float64Array → Buffer.
     * Retorna null se Ollama não disponível (não bloqueia o pipeline).
     */
    private async embedText(text: string): Promise<Buffer | null> {
        try {
            const res = await fetch(`${this.ollamaUrl}/api/embeddings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'nomic-embed-text', prompt: text }),
                signal: AbortSignal.timeout(EMBED_TIMEOUT_MS)
            });
            if (!res.ok) return null;
            const data = await res.json() as { embedding?: number[] };
            if (!data.embedding || data.embedding.length !== EMBED_DIM) return null;
            return Buffer.from(new Float64Array(data.embedding).buffer);
        } catch {
            // Ollama offline ou timeout — chunk ainda é criado, sem embedding
            return null;
        }
    }

    // ── 6. CHUNK QUALITY SCORE ─────────────────────────────────────────────────

    /**
     * Score determinístico 0-1 baseado em sinais estruturais.
     *
     * Escala de contribuições:
     *   base           +0.10  (todo chunk com conteúdo válido)
     *   msgs >= 2      +0.10
     *   msgs >= 4      +0.10
     *   msgs >= 6      +0.05
     *   tools > 0      +0.15
     *   tools > 2      +0.05
     *   workflow_comp  +0.20  (unidade semântica completa)
     *   entities >= 2  +0.10
     *   entities >= 4  +0.05
     *   topics > 0     +0.05
     *   user_content   +0.05 (> 100 chars) ou +0.10 (> 300)
     *   trigger bonus  +0.05 (workflow_completed) ou +0.02 (checkpoint)
     *
     * Total máximo: 1.0
     */
    calculateQuality(params: {
        messages: ChunkMessage[];
        toolsUsed: string[];
        topics: string[];
        entities: string[];
        workflowCompleted: boolean;
        cutTrigger: ChunkCutTrigger;
    }): number {
        const { messages, toolsUsed, topics, entities, workflowCompleted, cutTrigger } = params;

        let score = 0.10; // base

        const msgCount = messages.length;
        if (msgCount >= 2) score += 0.10;
        if (msgCount >= 4) score += 0.10;
        if (msgCount >= 6) score += 0.05;

        if (toolsUsed.length > 0) score += 0.15;
        if (toolsUsed.length > 2) score += 0.05;

        if (workflowCompleted) score += 0.20;

        if (entities.length >= 2) score += 0.10;
        if (entities.length >= 4) score += 0.05;

        if (topics.length > 0) score += 0.05;

        const userContentLen = messages
            .filter(m => m.role === 'user')
            .reduce((sum, m) => sum + m.content.length, 0);
        if (userContentLen > 300) score += 0.10;
        else if (userContentLen > 100) score += 0.05;

        if (cutTrigger === 'workflow_completed') score += 0.05;
        else if (cutTrigger === 'checkpoint_written') score += 0.02;

        return Math.min(score, 1.0);
    }

    // ── 7. TTL ─────────────────────────────────────────────────────────────────

    /**
     * Chunks de alta qualidade vivem mais.
     *   quality >= 0.7 → 90 dias
     *   quality >= 0.5 → 30 dias
     *   quality >= 0.3 → 14 dias
     *   quality < 0.3  → 7 dias
     */
    private computeTTL(quality: number): number | null {
        if (quality >= 0.7) return 90 * 24 * 3600_000;
        if (quality >= 0.5) return 30 * 24 * 3600_000;
        if (quality >= 0.3) return 14 * 24 * 3600_000;
        return 7 * 24 * 3600_000;
    }
}
