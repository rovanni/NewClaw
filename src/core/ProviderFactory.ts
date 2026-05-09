/**
 * ProviderFactory — Troca dinâmica de LLMs
 * Suporta: Gemini, DeepSeek, Groq, Ollama
 */

import PQueue from 'p-queue';
import { createLogger } from '../shared/AppLogger';
const log = createLogger('Providerfactory');

// Separate queues: classification (fast, priority) vs generation (long tasks)
// This prevents classification timeouts when a long generation is in progress
const generationQueue = new PQueue({ concurrency: 1 });
const classificationQueue = new PQueue({ concurrency: 1 });

// ── Streaming types ──
export type StreamChunk =
    | { type: 'content'; value: string }
    | { type: 'thinking'; value: string }
    | { type: 'tool_call'; value: any }
    | { type: 'done'; value: { prompt_tokens: number; completion_tokens: number } };

/**
 * Extract text from any LLM streaming chunk format.
 * Supports: Ollama (content, thinking, reasoning), OpenAI (delta.content),
 * DeepSeek (reasoning_content), Anthropic (thinking blocks), Gemini (parts).
 * Returns { text, type } where type indicates the chunk source.
 */
function extractChunkText(chunk: any): { text: string; type: 'content' | 'thinking' | 'reasoning' | 'delta' | 'unknown' } {
    // Ollama format: message.content, message.thinking, message.reasoning
    if (chunk.message) {
        if (chunk.message.content && chunk.message.content.trim()) {
            return { text: chunk.message.content, type: 'content' };
        }
        if (chunk.message.thinking && chunk.message.thinking.trim()) {
            return { text: chunk.message.thinking, type: 'thinking' };
        }
        if (chunk.message.reasoning && chunk.message.reasoning.trim()) {
            return { text: chunk.message.reasoning, type: 'reasoning' };
        }
        if (chunk.message.tool_calls) {
            return { text: '', type: 'content' }; // tool calls handled separately
        }
    }
    // OpenAI streaming format: choices[0].delta.content
    if (chunk.choices?.[0]?.delta) {
        const delta = chunk.choices[0].delta;
        if (delta.content && delta.content.trim()) {
            return { text: delta.content, type: 'delta' };
        }
        if (delta.reasoning_content && delta.reasoning_content.trim()) {
            return { text: delta.reasoning_content, type: 'reasoning' };
        }
        if (delta.thinking && delta.thinking.trim()) {
            return { text: delta.thinking, type: 'thinking' };
        }
    }
    // Anthropic streaming: content_block with thinking type
    if (chunk.type === 'content_block_delta' && chunk.delta) {
        if (chunk.delta.type === 'thinking_delta' && chunk.delta.thinking) {
            return { text: chunk.delta.thinking, type: 'thinking' };
        }
        if (chunk.delta.type === 'text_delta' && chunk.delta.text) {
            return { text: chunk.delta.text, type: 'content' };
        }
    }
    // Gemini streaming: candidates[0].content.parts
    if (chunk.candidates?.[0]?.content?.parts) {
        for (const part of chunk.candidates[0].content.parts) {
            if (part.text && part.text.trim()) {
                return { text: part.text, type: 'content' };
            }
            if (part.thought && part.thought.trim()) {
                return { text: part.thought, type: 'thinking' };
            }
        }
    }
    return { text: '', type: 'unknown' };
}

/**
 * Check if a chunk represents any kind of activity (not just content).
 * Used to reset idle/activity timers — any chunk type counts.
 */
function isChunkActive(chunk: any): boolean {
    // Explicit done signal
    if (chunk.done) return true;
    // Has message with any field
    if (chunk.message) {
        if (chunk.message.content?.trim()) return true;
        if (chunk.message.thinking?.trim()) return true;
        if (chunk.message.reasoning?.trim()) return true;
        if (chunk.message.tool_calls) return true;
    }
    // OpenAI delta
    if (chunk.choices?.[0]?.delta) {
        const delta = chunk.choices[0].delta;
        if (delta.content?.trim() || delta.reasoning_content?.trim() || delta.thinking?.trim()) return true;
        if (delta.tool_calls) return true;
    }
    // Anthropic
    if (chunk.type === 'content_block_delta' || chunk.type === 'content_block_start' || chunk.type === 'content_block_stop') return true;
    // Gemini
    if (chunk.candidates?.[0]) return true;
    return false;
}

export interface LLMMessage {
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    toolCalls?: ToolCall[];
    tool_call_id?: string;
}

export interface LLMResponse {
    content: string;
    toolCalls?: ToolCall[];
    usage?: { prompt_tokens: number; completion_tokens: number };
}

export interface ToolCall {
    id: string;
    name: string;
    arguments: Record<string, any>;
}

export interface ToolDefinition {
    name: string;
    description: string;
    parameters: Record<string, any>;
}

// ── Structured fallback types ──
export type FallbackReason = 'timeout' | 'error' | 'empty_response' | 'streaming_failed';

export interface AttemptInfo {
    provider: string;
    model: string;
    duration: number;       // ms
    status: 'success' | 'timeout' | 'error' | 'empty';
    errorMessage?: string;
}

export interface LLMResult {
    status: 'success' | 'timeout' | 'error';
    content: string;
    toolCalls?: ToolCall[];
    usage?: { prompt_tokens: number; completion_tokens: number };
    fallbackReason?: FallbackReason;
    fallbackMessage?: string;
    attempts: AttemptInfo[];
}

export interface MetricsSummary {
    total: number;
    successes: number;
    timeouts: number;
    errors: number;
    avgResponseTimeMs: number;
    p95ResponseTimeMs: number;
}

export interface ILLMProvider {
    name: string;
    chat(messages: LLMMessage[], tools?: ToolDefinition[], options?: ChatOptions): Promise<LLMResponse>;
    setModel(model: string): void;
}

/** Options that can be passed to chat() — extensible */
export interface ChatOptions {
    /** AbortSignal for cancellation — passed by chatWithFallback */
    signal?: AbortSignal;
}

// === Gemini Provider ===
export class GeminiProvider implements ILLMProvider {
    name = 'gemini';
    private apiKey: string;
    private model: string;

    constructor(apiKey: string, model: string = 'gemini-2.0-flash') {
        this.apiKey = apiKey;
        this.model = model;
    }

    setModel(model: string): void { this.model = model; }

    async chat(messages: LLMMessage[], tools?: ToolDefinition[], options?: ChatOptions): Promise<LLMResponse> {
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: options?.signal,
                body: JSON.stringify({
                    contents: messages.map(m => ({
                        role: m.role === 'assistant' ? 'model' : m.role,
                        parts: [{ text: m.content }]
                    })),
                    tools: tools ? [{ functionDeclarations: tools.map(t => ({
                        name: t.name,
                        description: t.description,
                        parameters: t.parameters
                    }))}] : undefined
                })
            }
        );

        if (!response.ok) {
            throw new Error(`Gemini API error: ${response.status}`);
        }

        const data = await response.json() as any;
        const candidate = data.candidates?.[0];
        const content = candidate?.content?.parts?.[0]?.text || '';
        const functionCall = candidate?.content?.parts?.[0]?.functionCall;

        return {
            content,
            toolCalls: functionCall ? [{
                id: `call_${Date.now()}`,
                name: functionCall.name,
                arguments: functionCall.args
            }] : undefined,
            usage: data.usageMetadata ? {
                prompt_tokens: data.usageMetadata.promptTokenCount || 0,
                completion_tokens: data.usageMetadata.candidatesTokenCount || 0
            } : undefined
        };
    }
}

// === DeepSeek Provider ===
export class DeepSeekProvider implements ILLMProvider {
    name = 'deepseek';
    private apiKey: string;
    private model: string;

    constructor(apiKey: string, model: string = 'deepseek-chat') {
        this.apiKey = apiKey;
        this.model = model;
    }

    setModel(model: string): void { this.model = model; }

    async chat(messages: LLMMessage[], tools?: ToolDefinition[], options?: ChatOptions): Promise<LLMResponse> {
        const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
            body: JSON.stringify({
                model: this.model,
                messages,
                tools: tools ? tools.map(t => ({
                    type: 'function',
                    function: { name: t.name, description: t.description, parameters: t.parameters }
                })) : undefined
            })
        });

        if (!response.ok) {
            throw new Error(`DeepSeek API error: ${response.status}`);
        }

        const data = await response.json() as any;
        const message = data.choices?.[0]?.message;

        return {
            content: message?.content || '',
            toolCalls: message?.tool_calls?.map((tc: any) => ({
                id: tc.id,
                name: tc.function.name,
                arguments: (() => { try { return JSON.parse(tc.function.arguments || '{}'); } catch { return {}; } })()
            })),
            usage: data.usage ? {
                prompt_tokens: data.usage.prompt_tokens || 0,
                completion_tokens: data.usage.completion_tokens || 0
            } : undefined
        };
    }
}

// === Groq Provider ===
export class GroqProvider implements ILLMProvider {
    name = 'groq';
    private apiKey: string;
    private model: string;

    constructor(apiKey: string, model: string = 'llama-3.3-70b-versatile') {
        this.apiKey = apiKey;
        this.model = model;
    }

    setModel(model: string): void { this.model = model; }

    async chat(messages: LLMMessage[], tools?: ToolDefinition[], options?: ChatOptions): Promise<LLMResponse> {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
            body: JSON.stringify({
                model: this.model,
                messages,
                tools: tools ? tools.map(t => ({
                    type: 'function',
                    function: { name: t.name, description: t.description, parameters: t.parameters }
                })) : undefined
            })
        });

        if (!response.ok) {
            throw new Error(`Groq API error: ${response.status}`);
        }

        const data = await response.json() as any;
        const message = data.choices?.[0]?.message;

        return {
            content: message?.content || '',
            toolCalls: message?.tool_calls?.map((tc: any) => ({
                id: tc.id,
                name: tc.function.name,
                arguments: (() => { try { return JSON.parse(tc.function.arguments || '{}'); } catch { return {}; } })()
            })),
            usage: data.usage ? {
                prompt_tokens: data.usage.prompt_tokens || 0,
                completion_tokens: data.usage.completion_tokens || 0
            } : undefined
        };
    }
}

// === Ollama Provider (local + cloud) ===
export class OllamaProvider implements ILLMProvider {
    name = 'ollama';
    private baseUrl: string;
    private model: string;
    private apiKey: string;

    constructor(baseUrl: string = 'http://localhost:11434', model: string = 'glm-5.1:cloud', apiKey: string = '') {
        this.baseUrl = baseUrl;
        this.model = model;
        this.apiKey = apiKey;
    }

    getBaseUrl(): string { return this.baseUrl; }
    getModel(): string { return this.model; }
    setModel(model: string): void { this.model = model; }
    setBaseUrl(url: string): void { this.baseUrl = url; }

    async chat(messages: LLMMessage[], tools?: ToolDefinition[], options?: ChatOptions): Promise<LLMResponse> {
        // Single attempt via generationQueue. Retries are handled by chatWithFallback.
        // DO NOT retry here — duplicate retries cause duplicate LLM requests.
        // Signal is passed through to streamChat for cancellation support.
        return await generationQueue.add(() => this._consumeStream(messages, tools, undefined, options?.signal));
    }

    /** Classification call — uses a separate queue to avoid blocking on long generations */
    async classify(messages: LLMMessage[], timeoutMs: number = 30000): Promise<LLMResponse> {
        return await classificationQueue.add(() => this._consumeStream(messages, undefined, timeoutMs));
    }

    /**
     * Streaming generator — yields content/thinking/tool_call tokens as they arrive from Ollama SSE.
     * This is the core streaming method. Other methods consume it.
     * 
     * Supports reasoning/thinking streams from modern LLMs:
     *   Ollama:    message.content, message.thinking, message.reasoning
     *   OpenAI:    choices[0].delta.content, delta.reasoning_content, delta.thinking
     *   DeepSeek:  choices[0].delta.reasoning_content
     *   Anthropic: content_block_delta with thinking_delta/text_delta
     *   Gemini:    candidates[0].content.parts with text/thought
     * 
     * Timeout architecture:
     *   - CONNECTION_TIMEOUT (30s): Time to first byte / first chunk
     *   - ACTIVITY_TIMEOUT (120s): Time since last activity of ANY type
     *   - MAX_TIMEOUT (default 300s): Hard ceiling safety net
     * 
     * Handles partial buffers (lines broken between chunks).
     */
    async *streamChat(messages: LLMMessage[], tools?: ToolDefinition[], customTimeoutMs?: number, externalSignal?: AbortSignal): AsyncGenerator<StreamChunk> {
        const streamId = `str-${Date.now().toString(36)}`;
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (this.apiKey) {
            headers['Authorization'] = `Bearer ${this.apiKey}`;
        }

        const numCtx = parseInt(process.env.OLLAMA_NUM_CTX || '32768', 10);
        const controller = new AbortController();

        // Timeout architecture: 3 separate timers
        const CONNECTION_TIMEOUT = 30_000;  // Time to first byte
        const ACTIVITY_TIMEOUT = 120_000;   // Time since last activity of ANY type
        const MAX_TIMEOUT = customTimeoutMs || 300_000;  // Hard ceiling

        const startTime = Date.now();
        let lastActivityTime = startTime;
        let firstChunkReceived = false;

        // Track chunk types for diagnostics
        let stats = { content: 0, thinking: 0, reasoning: 0, delta: 0, unknown: 0, total: 0 };

        let activityTimer: NodeJS.Timeout | null = null;
        let maxTimer: NodeJS.Timeout | null = null;
        let connectionTimer: NodeJS.Timeout | null = null;

        const resetActivityTimer = () => {
            if (activityTimer) clearTimeout(activityTimer);
            activityTimer = setTimeout(() => {
                log.warn(`[${streamId}] [STREAM] ACTIVITY TIMEOUT: No activity for ${ACTIVITY_TIMEOUT}ms`);
                controller.abort();
            }, ACTIVITY_TIMEOUT);
        };

        // Connection timer: abort if no first chunk received
        connectionTimer = setTimeout(() => {
            if (!firstChunkReceived) {
                log.error(`[${streamId}] [STREAM] CONNECTION TIMEOUT: No first chunk in ${CONNECTION_TIMEOUT}ms`);
                controller.abort();
            }
        }, CONNECTION_TIMEOUT);

        // Max timeout: hard ceiling
        maxTimer = setTimeout(() => {
            log.warn(`[${streamId}] [STREAM] MAX TIMEOUT reached after ${MAX_TIMEOUT}ms`);
            controller.abort();
        }, MAX_TIMEOUT);

        // Start activity timer
        resetActivityTimer();

        // Link external signal — if chatWithFallback aborts, we abort too
        if (externalSignal) {
            if (externalSignal.aborted) {
                if (connectionTimer) clearTimeout(connectionTimer);
                if (activityTimer) clearTimeout(activityTimer);
                if (maxTimer) clearTimeout(maxTimer);
                throw new Error('Aborted by external signal before fetch');
            }
            externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
        }

        const requestBody: any = {
            model: this.model,
            messages,
            stream: true,
            options: { num_ctx: numCtx },
            tools: tools ? tools.map(t => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.parameters }
            })) : undefined
        };

        log.info(`[${streamId}] [STREAM] START model=${this.model} connectionTimeout=${CONNECTION_TIMEOUT}ms activityTimeout=${ACTIVITY_TIMEOUT}ms maxTimeout=${MAX_TIMEOUT}ms`);

        let response: Response;
        try {
            response = await fetch(`${this.baseUrl}/api/chat`, {
                method: 'POST',
                headers,
                signal: controller.signal,
                body: JSON.stringify(requestBody)
            });
        } catch (fetchErr: any) {
            if (connectionTimer) clearTimeout(connectionTimer);
            if (activityTimer) clearTimeout(activityTimer);
            if (maxTimer) clearTimeout(maxTimer);
            log.error(`[${streamId}] [STREAM] FETCH FAILED: ${fetchErr.message}`);
            throw fetchErr;
        }

        if (!response.ok) {
            if (connectionTimer) clearTimeout(connectionTimer);
            if (activityTimer) clearTimeout(activityTimer);
            if (maxTimer) clearTimeout(maxTimer);
            log.error(`[${streamId}] [STREAM] HTTP ${response.status}`);
            throw new Error(`Ollama API error: ${response.status}`);
        }

        const body = response.body;
        if (!body) {
            if (connectionTimer) clearTimeout(connectionTimer);
            if (activityTimer) clearTimeout(activityTimer);
            if (maxTimer) clearTimeout(maxTimer);
            throw new Error('No response body from Ollama');
        }

        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    log.info(`[${streamId}] [STREAM] reader.read() done=true (stream ended by server). stats=${JSON.stringify(stats)} elapsed=${Date.now() - startTime}ms`);
                    break;
                }

                buffer += decoder.decode(value, { stream: true });

                // Split by newline, keep incomplete last line in buffer
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;

                    let chunk: any;
                    try {
                        chunk = JSON.parse(trimmed);
                    } catch {
                        log.warn(`[${streamId}] [STREAM] Malformed JSON (${trimmed.length} chars): ${trimmed.slice(0, 80)}...`);
                        continue;
                    }

                    // Extract text using universal chunk handler
                    const { text, type } = extractChunkText(chunk);
                    stats.total++;
                    if (type !== 'unknown' && type !== 'content') stats[type]++;
                    else if (type === 'content') stats.content++;

                    // ANY activity resets the timer
                    if (isChunkActive(chunk) || text) {
                        lastActivityTime = Date.now();
                        resetActivityTimer();
                        if (!firstChunkReceived) {
                            firstChunkReceived = true;
                            if (connectionTimer) { clearTimeout(connectionTimer); connectionTimer = null; }
                            log.info(`[${streamId}] [STREAM] First chunk received after ${Date.now() - startTime}ms type=${type}`);
                        }
                    }

                    // Yield based on extracted type
                    if (text) {
                        const yieldType = (type === 'thinking' || type === 'reasoning') ? 'thinking' : 'content';
                        if (yieldType === 'thinking') {
                            log.debug(`[${streamId}] [STREAM] Thinking chunk: ${text.length} chars`);
                        }
                        yield { type: yieldType, value: text } as StreamChunk;
                    }

                    if (chunk.message?.tool_calls) {
                        for (const tc of chunk.message.tool_calls) {
                            log.info(`[${streamId}] [STREAM] Tool call: ${tc.function?.name || 'unknown'}`);
                            yield { type: 'tool_call', value: tc } as StreamChunk;
                        }
                    }

                    if (chunk.done) {
                        const doneReason = chunk.done_reason || '(not provided)';
                        log.info(`[${streamId}] [STREAM] DONE done_reason="${doneReason}" prompt_eval=${chunk.prompt_eval_count || 0} eval=${chunk.eval_count || 0} stats=${JSON.stringify(stats)} elapsed=${Date.now() - startTime}ms`);
                        yield {
                            type: 'done',
                            value: {
                                prompt_tokens: chunk.prompt_eval_count || 0,
                                completion_tokens: chunk.eval_count || 0
                            }
                        } as StreamChunk;
                        return; // Stream complete
                    }
                }
            }

            // Flush remaining buffer (incomplete last line)
            if (buffer.trim()) {
                log.info(`[${streamId}] [STREAM] Flushing remaining buffer (${buffer.trim().length} chars)`);
                try {
                    const chunk = JSON.parse(buffer.trim());
                    const { text, type } = extractChunkText(chunk);
                    stats.total++;

                    if (text) {
                        const yieldType = (type === 'thinking' || type === 'reasoning') ? 'thinking' : 'content';
                        yield { type: yieldType, value: text } as StreamChunk;
                    }
                    if (chunk.done) {
                        const doneReason = chunk.done_reason || '(not provided)';
                        log.info(`[${streamId}] [STREAM] DONE in buffer flush. done_reason="${doneReason}" stats=${JSON.stringify(stats)}`);
                        yield { type: 'done', value: { prompt_tokens: chunk.prompt_eval_count || 0, completion_tokens: chunk.eval_count || 0 } } as StreamChunk;
                    }
                } catch {
                    log.warn(`[${streamId}] [STREAM] Failed to parse remaining buffer: ${buffer.trim().slice(0, 80)}...`);
                }
            }

            // If we reached here without yielding 'done', log it
            log.warn(`[${streamId}] [STREAM] Stream ended WITHOUT explicit 'done' chunk. stats=${JSON.stringify(stats)}, elapsed=${Date.now() - startTime}ms`);
        } catch (streamErr: any) {
            log.error(`[${streamId}] [STREAM] ERROR: ${streamErr.message}. stats=${JSON.stringify(stats)}`);
            throw streamErr;
        } finally {
            if (connectionTimer) clearTimeout(connectionTimer);
            if (activityTimer) clearTimeout(activityTimer);
            if (maxTimer) clearTimeout(maxTimer);
            reader.releaseLock();
            log.info(`[${streamId}] [STREAM] END (reader released, all timers cleared)`);
        }
    }


    /**
     * Consume the streaming generator and collect full response.
     * This is the wrapper that chat() and classify() use.
     * 
     * IMPORTANT: On stream failure, we THROW (don't fallback to non-streaming).
     * The caller (chat() or chatWithFallback) handles retries and provider fallback.
     * Doing non-streaming fallback here causes duplicate LLM requests.
     */
    private async _consumeStream(messages: LLMMessage[], tools?: ToolDefinition[], customTimeoutMs?: number, externalSignal?: AbortSignal): Promise<LLMResponse> {
        // ISOLATED buffer — each call gets its own. No shared state.
        let content = '';
        let thinking = '';  // Collect thinking separately
        const toolCalls: any[] = [];
        let usage: any = undefined;
        let chunkCount = 0;
        const startTime = Date.now();
        const consumeId = `sc-${Date.now().toString(36)}`;

        log.info(`[${consumeId}] [STREAM-CONSUME] START timeout=${customTimeoutMs || 'default'}ms`);

        try {
            for await (const chunk of this.streamChat(messages, tools, customTimeoutMs, externalSignal)) {
                chunkCount++;
                switch (chunk.type) {
                    case 'content':
                        content += chunk.value;
                        break;
                    case 'thinking':
                        thinking += chunk.value;
                        break;
                    case 'tool_call':
                        toolCalls.push(chunk.value);
                        break;
                    case 'done':
                        usage = chunk.value;
                        break;
                }
            }
        } catch (streamErr: any) {
            const elapsed = Date.now() - startTime;
            // If we have thinking content but no final content, include thinking as content
            // This handles models that think but never produce content before timeout
            if (!content && thinking) {
                log.warn(`[${consumeId}] [STREAM-CONSUME] Stream failed but have ${thinking.length} chars of thinking — using as content`);
                content = thinking;
            }
            if (!content && !thinking) {
                log.error(`[${consumeId}] [STREAM-CONSUME] FAILED after ${chunkCount} chunks, ${elapsed}ms: ${streamErr.message}`);
                throw streamErr;
            }
            // If we have partial content, return it instead of throwing
            log.warn(`[${consumeId}] [STREAM-CONSUME] Partial content after stream error: ${content.length} chars content, ${thinking.length} chars thinking`);
        }

        // If no content but have thinking, use thinking as content
        if (!content && thinking) {
            log.info(`[${consumeId}] [STREAM-CONSUME] No content but ${thinking.length} chars of thinking — using as content`);
            content = thinking;
        }

        const elapsed = Date.now() - startTime;

        if (!content && toolCalls.length === 0) {
            log.warn(`[${consumeId}] [STREAM-CONSUME] EMPTY after ${chunkCount} chunks, ${elapsed}ms`);
            throw new Error('Empty response from stream');
        }

        log.info(`[${consumeId}] [STREAM-CONSUME] COMPLETE chunks=${chunkCount} content=${content.length}chars thinking=${thinking.length}chars toolCalls=${toolCalls.length} duration=${elapsed}ms`);

        return {
            content,
            toolCalls: toolCalls.length > 0 ? toolCalls.map((tc: any) => ({
                id: tc.function?.name || `call_${Date.now()}`,
                name: tc.function?.name || '',
                arguments: tc.function?.arguments || {}
            })) : undefined,
            usage
        };
    }

    /**
     * Fallback: non-streaming request when streaming fails.
     * WARNING: Not currently called — kept for potential future use.
     * DO NOT call from _consumeStream (causes duplicate LLM requests).
     * Only safe to call as last resort from chatWithFallback if all providers fail streaming.
     */
    public async _fallbackNonStreaming(messages: LLMMessage[], tools?: ToolDefinition[], customTimeoutMs?: number): Promise<LLMResponse> {
        const numCtx = parseInt(process.env.OLLAMA_NUM_CTX || '32768', 10);
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

        const controller = new AbortController();
        const timeoutMs = (customTimeoutMs || 240000);
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await fetch(`${this.baseUrl}/api/chat`, {
                method: 'POST',
                headers,
                signal: controller.signal,
                body: JSON.stringify({
                    model: this.model,
                    messages,
                    stream: false,
                    options: { num_ctx: numCtx },
                    tools: tools ? tools.map(t => ({
                        type: 'function',
                        function: { name: t.name, description: t.description, parameters: t.parameters }
                    })) : undefined
                })
            });

            if (!response.ok) throw new Error(`Ollama fallback error: ${response.status}`);
            const data = await response.json() as any;
            const message = data.message;
            return {
                content: message?.content || '',
                toolCalls: message?.tool_calls?.map((tc: any) => ({
                    id: tc.function?.name || `call_${Date.now()}`,
                    name: tc.function?.name || '',
                    arguments: tc.function?.arguments || {}
                })),
                usage: data.usage ? {
                    prompt_tokens: data.usage.prompt_tokens || 0,
                    completion_tokens: data.usage.completion_tokens || 0
                } : undefined
            };
        } finally {
            clearTimeout(timeout);
        }
    }
}

// === OpenAI Provider (Generic) ===
export class OpenAIProvider implements ILLMProvider {
    name = 'openai';
    private apiKey: string;
    private model: string;
    private baseUrl: string;

    constructor(apiKey: string, model: string = 'gpt-4o', baseUrl: string = 'https://api.openai.com/v1') {
        this.apiKey = apiKey;
        this.model = model;
        this.baseUrl = baseUrl;
    }

    setModel(model: string): void { this.model = model; }

    async chat(messages: LLMMessage[], tools?: ToolDefinition[], options?: ChatOptions): Promise<LLMResponse> {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
            body: JSON.stringify({
                model: this.model,
                messages,
                tools: tools ? tools.map(t => ({
                    type: 'function',
                    function: { name: t.name, description: t.description, parameters: t.parameters }
                })) : undefined
            })
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`${this.name} API error (${response.status}): ${error}`);
        }

        const data = await response.json() as any;
        const message = data.choices?.[0]?.message;

        return {
            content: message?.content || '',
            toolCalls: message?.tool_calls?.map((tc: any) => ({
                id: tc.id,
                name: tc.function.name,
                arguments: (() => { try { return JSON.parse(tc.function.arguments || '{}'); } catch { return {}; } })()
            })),
            usage: data.usage ? {
                prompt_tokens: data.usage.prompt_tokens || 0,
                completion_tokens: data.usage.completion_tokens || 0
            } : undefined
        };
    }
}

// === OpenRouter Provider ===
export class OpenRouterProvider extends OpenAIProvider {
    constructor(apiKey: string, model: string = 'anthropic/claude-3.5-sonnet') {
        super(apiKey, model, 'https://openrouter.ai/api/v1');
        this.name = 'openrouter';
    }

    async chat(messages: LLMMessage[], tools?: ToolDefinition[], options?: ChatOptions): Promise<LLMResponse> {
        // OpenRouter specific headers can be added here if needed (e.g., HTTP-Referer)
        return super.chat(messages, tools);
    }
}

// === Factory ===
export class ProviderFactory {
    private providers: Map<string, ILLMProvider> = new Map();
    private defaultProvider: string;

    constructor(config: {
        geminiKey?: string;
        deepseekKey?: string;
        groqKey?: string;
        openrouterKey?: string;
        ollamaUrl?: string;
        ollamaModel?: string;
        ollamaApiKey?: string;
        defaultProvider: string;
    }) {
        this.defaultProvider = config.defaultProvider || 'gemini';

        if (config.geminiKey) this.providers.set('gemini', new GeminiProvider(config.geminiKey));
        if (config.deepseekKey) this.providers.set('deepseek', new DeepSeekProvider(config.deepseekKey));
        if (config.groqKey) this.providers.set('groq', new GroqProvider(config.groqKey));
        if (config.openrouterKey) this.providers.set('openrouter', new OpenRouterProvider(config.openrouterKey));
        
        this.providers.set('ollama', new OllamaProvider(
            config.ollamaUrl || 'http://localhost:11434',
            config.ollamaModel || 'glm-5.1:cloud',
            config.ollamaApiKey || ''
        ));
    }

    getProvider(name?: string): ILLMProvider {
        const providerName = name || this.defaultProvider;
        const provider = this.providers.get(providerName);
        if (!provider) {
            const first = this.providers.values().next().value;
            if (first) return first;
            throw new Error('Nenhum provider disponível. Configure ao menos uma API key.');
        }
        return provider;
    }

    /** Get a provider with a specific model (for observer/validator) */
    getProviderWithModel(model: string): ILLMProvider {
        // Find Ollama provider and create new instance with different model
        const ollamaProvider = this.providers.get('ollama') as OllamaProvider;
        if (!ollamaProvider) {
            return this.getProvider(); // Fallback to default
        }
        return new OllamaProvider(ollamaProvider.getBaseUrl(), model);
    }

    getAvailableProviders(): string[] {
        return Array.from(this.providers.keys());
    }

    getDefaultProvider(): string {
        return this.defaultProvider;
    }

    setDefaultProvider(name: string): void {
        if (this.providers.has(name)) {
            this.defaultProvider = name;
        } else {
            throw new Error(`Provider "${name}" not available. Available: ${this.getAvailableProviders().join(', ')}`);
        }
    }

    /** Chat with automatic fallback — tries next provider if current fails
     * 
     * ATOMICITY GUARANTEE:
     * - Each attempt gets its own AbortController and isolated buffers.
     * - Previous attempts are ALWAYS aborted before starting a new one.
     * - Only ONE response is returned — the LAST successful attempt.
     * - No partial content from failed attempts is ever included.
     * - Each attempt is fully sequential (generationQueue concurrency=1 ensures this).
     */
    async chatWithFallback(messages: LLMMessage[], tools?: ToolDefinition[], preferredProvider?: string, timeoutMs?: number): Promise<LLMResult> {
        const providerOrder = this.getFallbackOrder(preferredProvider);
        const attemptLog: AttemptInfo[] = [];
        const MAX_RETRIES = 1;
        const RETRY_BACKOFF_MS = 10000;
        const requestId = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const startTime = Date.now();
        
        // Track active abort controller so we can cancel any in-flight request
        let activeAbortController: AbortController | null = null;
        
        log.info(`[${requestId}] chatWithFallback START providers=[${providerOrder.join(',')}] timeout=${timeoutMs || 'none'}ms`);

        for (const providerName of providerOrder) {
            for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
                const attemptId = `${requestId}-${providerName}-${attempt}`;
                const attemptStart = Date.now();
                
                // ABORT any previous in-flight request before starting new attempt
                if (activeAbortController) {
                    log.info(`[${requestId}] Aborting previous in-flight request before attempt ${attempt}`);
                    activeAbortController.abort();
                    activeAbortController = null;
                }
                
                const currentAbort = new AbortController();
                activeAbortController = currentAbort;

                try {
                    const provider = this.providers.get(providerName);
                    if (!provider) break;
                    const modelUsed = (provider instanceof OllamaProvider) ? provider.getModel() : (provider as any).model || provider.name;
                    
                    if (attempt > 0) {
                        log.info(`[${attemptId}] Retry ${attempt}/${MAX_RETRIES} after ${RETRY_BACKOFF_MS}ms backoff`);
                        await new Promise(r => setTimeout(r, RETRY_BACKOFF_MS));
                    }
                    
                    log.info(`[${attemptId}] START provider=${providerName}/${modelUsed} timeout=${timeoutMs || 'none'}ms`);
                    
                    // Pass abort signal via ChatOptions (parameter, not state)
                    const chatOptions: ChatOptions = { signal: currentAbort.signal };
                    
                    // Chat call with timeout — isolate this attempt completely
                    const chatPromise = provider.chat(messages, tools, chatOptions);
                    let result: LLMResponse;

                    if (timeoutMs) {
                        // Create a SEPARATE timeout for this attempt only
                        const attemptTimeout = setTimeout(() => {
                            currentAbort.abort();
                        }, timeoutMs);
                        
                        try {
                            result = await Promise.race([
                                chatPromise,
                                new Promise<never>((_, reject) => 
                                    setTimeout(() => reject(new Error('Timeout')), timeoutMs)
                                )
                            ]);
                        } finally {
                            clearTimeout(attemptTimeout);
                        }
                    } else {
                        result = await chatPromise;
                    }

                    // CRITICAL: Validate that this attempt was NOT aborted before accepting result
                    // Prevents late responses from a previous/aborted request from being used
                    if (currentAbort.signal.aborted) {
                        log.warn(`[${attemptId}] ABORTED after completion — discarding result (content=${(result.content || '').length}chars)`);
                        attemptLog.push({ provider: providerName, model: modelUsed, duration: Date.now() - attemptStart, status: 'error', errorMessage: 'Aborted — late response discarded' });
                        activeAbortController = null;
                        continue;
                    }

                    // Clear active abort — this attempt completed on its own
                    activeAbortController = null;

                    // Check for leaked tool calls
                    if (!result.toolCalls || result.toolCalls.length === 0) {
                        const extractedCalls = this.extractLeakedToolCalls(result.content);
                        if (extractedCalls) {
                            log.info(`[${attemptId}] Extracted leaked tool call: ${extractedCalls[0].name}`);
                            result.toolCalls = extractedCalls;
                        }
                    }

                    const duration = Date.now() - attemptStart;

                    // Only ONE response per request — return immediately on first success
                    if ((result.content && result.content.trim().length > 0) || (result.toolCalls && result.toolCalls.length > 0)) {
                        attemptLog.push({ provider: providerName, model: modelUsed, duration, status: 'success' });
                        log.info(`[${attemptId}] SUCCESS content=${result.content.length}chars toolCalls=${result.toolCalls?.length || 0} duration=${duration}ms`);
                        return {
                            status: 'success',
                            content: result.content,
                            toolCalls: result.toolCalls,
                            usage: result.usage,
                            attempts: attemptLog
                        };
                    }
                    
                    // Empty response
                    attemptLog.push({ provider: providerName, model: modelUsed, duration, status: 'empty' });
                    log.warn(`[${attemptId}] Empty response, moving to next`);
                    break;
                } catch (error: any) {
                    const duration = Date.now() - attemptStart;
                    activeAbortController = null;
                    const prov = this.providers.get(providerName);
                    const modelUsed = (prov instanceof OllamaProvider) ? prov.getModel() : (prov as any)?.model || providerName;
                    const isTimeout = error.message?.includes('Timeout');
                    const isRetryable = isTimeout || 
                                       error.message?.includes('abort') || 
                                       error.message?.includes('ECONNRESET') ||
                                       error.message?.includes('fetch failed') ||
                                       error.message?.includes('network');
                    
                    log.warn(`[${attemptId}] FAILED ${error.message} duration=${duration}ms retryable=${isRetryable && attempt < MAX_RETRIES}`);
                    attemptLog.push({ 
                        provider: providerName, 
                        model: modelUsed, 
                        duration, 
                        status: isTimeout ? 'timeout' : 'error', 
                        errorMessage: error.message 
                    });
                    
                    if (isRetryable && attempt < MAX_RETRIES) {
                        continue;
                    }
                    break;
                }
            }
        }

        // All streaming providers exhausted — try non-streaming fallback as last resort
        if (attemptLog.every(a => a.status === 'timeout' || a.status === 'error')) {
            const ollamaProvider = this.providers.get('ollama');
            if (ollamaProvider instanceof OllamaProvider) {
                log.info(`[${requestId}] All streaming attempts failed — trying non-streaming fallback`);
                try {
                    const result = await ollamaProvider._fallbackNonStreaming(messages, tools, timeoutMs);
                    if (result.content && result.content.trim()) {
                        attemptLog.push({ provider: 'ollama', model: 'non-streaming-fallback', duration: Date.now() - startTime, status: 'success' });
                        return {
                            status: 'success',
                            content: result.content,
                            toolCalls: result.toolCalls,
                            usage: result.usage,
                            fallbackReason: 'streaming_failed',
                            attempts: attemptLog
                        };
                    }
                } catch (fallbackErr: any) {
                    attemptLog.push({ provider: 'ollama', model: 'non-streaming-fallback', duration: Date.now() - startTime, status: 'error', errorMessage: fallbackErr.message });
                }
            }
        }

        // All providers exhausted (including fallback)
        const lastError = (attemptLog.length > 0 && attemptLog[attemptLog.length - 1]?.errorMessage) 
            ? attemptLog[attemptLog.length - 1].errorMessage : '';
        const isTimeoutError = lastError?.includes('Timeout') || lastError?.includes('abort');
        log.error(`[${requestId}] EXHAUSTED attempts=${attemptLog.length}`);
        
        return {
            status: isTimeoutError ? 'timeout' : 'error',
            content: '',
            toolCalls: undefined,
            fallbackReason: isTimeoutError ? 'timeout' : 'error',
            fallbackMessage: 'O modelo demorou mais que o esperado. Tente novamente em alguns instantes.',
            attempts: attemptLog
        };
    }

    private extractLeakedToolCalls(content: string): ToolCall[] | undefined {
        if (!content) return undefined;
        try {
            const toolCallMatch = content.match(/\[TOOL_CALL\]([\s\S]*?)\[\/TOOL_CALL\]/i);
            if (toolCallMatch && toolCallMatch[1]) {
                const parsed = JSON.parse(toolCallMatch[1].trim());
                if (parsed.name && parsed.arguments) {
                    return [{ id: `call_${Date.now()}`, name: parsed.name, arguments: parsed.arguments }];
                }
            }
            const xmlMatch = content.match(/<tool_call>([\s\S]*?)<\/tool_call>/i);
            if (xmlMatch && xmlMatch[1]) {
                const parsed = JSON.parse(xmlMatch[1].trim());
                if (parsed.name && parsed.arguments) {
                    return [{ id: `call_${Date.now()}`, name: parsed.name, arguments: parsed.arguments }];
                }
            }
            const jsonBlockMatch = content.match(/```json\s*([\s\S]*?)\s*```/i);
            if (jsonBlockMatch && jsonBlockMatch[1]) {
                const parsed = JSON.parse(jsonBlockMatch[1].trim());
                if (parsed.name && parsed.arguments) {
                    return [{ id: `call_${Date.now()}`, name: parsed.name, arguments: parsed.arguments }];
                }
            }
        } catch (e) {
            log.info(`Failed to parse leaked tool call: ${e}`);
        }
        return undefined;
    }

    /** Classification with fallback — uses separate queue to avoid blocking on long generations */
    async classifyWithFallback(messages: LLMMessage[], timeoutMs: number = 30000): Promise<LLMResponse> {
        const providerOrder = this.getFallbackOrder();
        const errors: string[] = [];

        for (const providerName of providerOrder) {
            try {
                const provider = this.providers.get(providerName);
                if (!provider) continue;

                let result: LLMResponse;
                // Use separate classification queue for Ollama, direct call for others
                if (providerName === 'ollama' && provider instanceof OllamaProvider) {
                    result = await provider.classify(messages, timeoutMs);
                } else {
                    result = await Promise.race([
                        provider.chat(messages),
                        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeoutMs))
                    ]);
                }

                if (result.content && result.content.trim().length > 0) {
                    return result;
                }
                errors.push(`${providerName}: empty response`);
            } catch (error: any) {
                errors.push(`${providerName}: ${error.message}`);
                continue;
            }
        }

        throw new Error(`Classification failed: ${errors.join('; ')}`);
    }

    /** Get ordered list of providers for fallback chain */
    private getFallbackOrder(preferred?: string): string[] {
        const all = Array.from(this.providers.keys());
        if (preferred && this.providers.has(preferred)) {
            const rest = all.filter(p => p !== preferred);
            return [preferred, ...rest];
        }
        // Default order: ollama first (local), then cloud providers
        const order = ['ollama', 'openrouter', 'gemini', 'deepseek', 'groq'];
        const sorted = order.filter(p => this.providers.has(p));
        const remaining = all.filter(p => !sorted.includes(p));
        return [...sorted, ...remaining];
    }

    getOllamaProvider(): OllamaProvider | undefined {
        const p = this.providers.get('ollama');
        return p instanceof OllamaProvider ? p : undefined;
    }

    getCurrentModel(): string {
        const provider = this.getProvider();
        if (provider instanceof OllamaProvider) return provider.getModel();
        return provider.name;
    }
}