import { createLogger } from '../shared/AppLogger';
import { errorMessage } from '../shared/errors';
import { ILLMProvider, LLMMessage, LLMResponse, ToolDefinition, ChatOptions, StreamChunk, OpenAIChatResponse, RawApiChunk, RawToolCall } from './providerTypes';
import { taskQueue, TaskPriority } from './providerQueue';

const log = createLogger('Providerfactory');

// Ollama native returns args as object; OpenAI-compat mode returns JSON string.
function parseToolArgs(args: unknown): Record<string, unknown> {
    if (!args) return {};
    if (typeof args === 'string') {
        try { return JSON.parse(args); } catch { return {}; }
    }
    return args as Record<string, unknown>;
}

/**
 * Extract text from any LLM streaming chunk format.
 * Supports: Ollama (content, thinking, reasoning), OpenAI (delta.content),
 * DeepSeek (reasoning_content), Anthropic (thinking blocks), Gemini (parts).
 */
function extractChunkText(chunk: RawApiChunk): { text: string; type: 'content' | 'thinking' | 'reasoning' | 'delta' | 'unknown' } {
    if (chunk.message) {
        if (chunk.message.content && chunk.message.content.trim()) return { text: chunk.message.content, type: 'content' };
        if (chunk.message.thinking && chunk.message.thinking.trim()) return { text: chunk.message.thinking, type: 'thinking' };
        if (chunk.message.reasoning && chunk.message.reasoning.trim()) return { text: chunk.message.reasoning, type: 'reasoning' };
        if (chunk.message.tool_calls) return { text: '', type: 'content' };
    }
    if (chunk.choices?.[0]?.delta) {
        const delta = chunk.choices[0].delta;
        if (delta.content && delta.content.trim()) return { text: delta.content, type: 'delta' };
        if (delta.reasoning_content && delta.reasoning_content.trim()) return { text: delta.reasoning_content, type: 'reasoning' };
        if (delta.thinking && delta.thinking.trim()) return { text: delta.thinking, type: 'thinking' };
    }
    if (chunk.type === 'content_block_delta' && chunk.delta) {
        if (chunk.delta.type === 'thinking_delta' && chunk.delta.thinking) return { text: chunk.delta.thinking, type: 'thinking' };
        if (chunk.delta.type === 'text_delta' && chunk.delta.text) return { text: chunk.delta.text, type: 'content' };
    }
    if (chunk.candidates?.[0]?.content?.parts) {
        for (const part of chunk.candidates[0].content.parts) {
            if (part.text && part.text.trim()) return { text: part.text, type: 'content' };
            if (part.thought && part.thought.trim()) return { text: part.thought, type: 'thinking' };
        }
    }
    return { text: '', type: 'unknown' };
}

/**
 * Check if a chunk represents any kind of activity.
 * Used to reset idle/activity timers — any chunk type counts.
 */
function isChunkActive(chunk: RawApiChunk): boolean {
    if (chunk.done) return true;
    if (chunk.message) {
        if (chunk.message.content?.trim()) return true;
        if (chunk.message.thinking?.trim()) return true;
        if (chunk.message.reasoning?.trim()) return true;
        if (chunk.message.tool_calls) return true;
    }
    if (chunk.choices?.[0]?.delta) {
        const delta = chunk.choices[0].delta;
        if (delta.content?.trim() || delta.reasoning_content?.trim() || delta.thinking?.trim()) return true;
        if (delta.tool_calls) return true;
    }
    if (chunk.type === 'content_block_delta' || chunk.type === 'content_block_start' || chunk.type === 'content_block_stop') return true;
    if (chunk.candidates?.[0]) return true;
    return false;
}

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
        const priority = this.model.includes(':cloud') ? TaskPriority.INTERACTIVE : TaskPriority.BACKGROUND;
        const queueEntryTime = Date.now();
        return await taskQueue.add(
            () => {
                const queueWaitMs = Date.now() - queueEntryTime;
                // Subtract queue wait from the timeout budget so the stream's MAX_TIMEOUT
                // reflects time actually available from this point, not from when the
                // attempt timer started in chatWithFallback. Floor at 30s to avoid
                // immediately timing out tasks that waited a very long time in the queue.
                const remainingMs = options?.timeoutMs
                    ? Math.max(30_000, options.timeoutMs - queueWaitMs)
                    : undefined;
                if (queueWaitMs > 500) {
                    log.info(`[STREAM] Queue wait: ${queueWaitMs}ms — remaining budget: ${remainingMs ?? 'default'}ms`);
                }
                return this._consumeStream(messages, tools, remainingMs, options?.signal);
            },
            { priority }
        );
    }

    /** Classification call — high priority to avoid blocking the cognitive loop */
    async classify(messages: LLMMessage[], timeoutMs: number = 120000): Promise<LLMResponse> {
        return await taskQueue.add(
            () => this._consumeStream(messages, undefined, timeoutMs),
            { priority: TaskPriority.CLASSIFICATION }
        );
    }

    /**
     * Streaming generator — yields content/thinking/tool_call tokens as they arrive from Ollama SSE.
     *
     * Timeout architecture:
     *   - CONNECTION_TIMEOUT (120s): Time to first byte / first chunk
     *   - ACTIVITY_TIMEOUT (120s): Time since last activity of ANY type
     *   - MAX_TIMEOUT (default 300s): Hard ceiling safety net
     *
     * Handles partial buffers (lines broken between chunks).
     */
    async *streamChat(messages: LLMMessage[], tools?: ToolDefinition[], customTimeoutMs?: number, externalSignal?: AbortSignal): AsyncGenerator<StreamChunk> {
        const streamId = `str-${Date.now().toString(36)}`;
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

        const numCtx = parseInt(process.env.OLLAMA_NUM_CTX || '32768', 10);
        const controller = new AbortController();

        const CONNECTION_TIMEOUT = 120_000;
        const ACTIVITY_TIMEOUT = 120_000;
        const MAX_TIMEOUT = customTimeoutMs || 300_000;

        // Validate signal BEFORE creating timers to avoid leaking them on early abort
        if (externalSignal?.aborted) {
            throw new Error('Aborted by external signal before fetch');
        }

        const startTime = Date.now();
        let firstChunkReceived = false;
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

        connectionTimer = setTimeout(() => {
            if (!firstChunkReceived) {
                log.error(`[${streamId}] [STREAM] CONNECTION TIMEOUT: No first chunk in ${CONNECTION_TIMEOUT}ms`);
                controller.abort();
            }
        }, CONNECTION_TIMEOUT);

        maxTimer = setTimeout(() => {
            log.warn(`[${streamId}] [STREAM] MAX TIMEOUT reached after ${MAX_TIMEOUT}ms`);
            controller.abort();
        }, MAX_TIMEOUT);

        resetActivityTimer();

        if (externalSignal) {
            externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
        }

        const requestBody: Record<string, unknown> = {
            model: this.model,
            messages: messages.map(m => ({ role: m.role, content: m.content, images: m.images })),
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
        } catch (fetchErr) {
            if (connectionTimer) clearTimeout(connectionTimer);
            if (activityTimer) clearTimeout(activityTimer);
            if (maxTimer) clearTimeout(maxTimer);
            log.error(`[${streamId}] [STREAM] FETCH FAILED: ${errorMessage(fetchErr)}`);
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
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;

                    let chunk: RawApiChunk;
                    try {
                        chunk = JSON.parse(trimmed);
                    } catch {
                        log.warn(`[${streamId}] [STREAM] Malformed JSON (${trimmed.length} chars): ${trimmed.slice(0, 80)}...`);
                        continue;
                    }

                    const { text, type } = extractChunkText(chunk);
                    stats.total++;
                    if (type !== 'unknown' && type !== 'content') stats[type]++;
                    else if (type === 'content') stats.content++;

                    if (isChunkActive(chunk) || text) {
                        resetActivityTimer();
                        if (!firstChunkReceived) {
                            firstChunkReceived = true;
                            if (connectionTimer) { clearTimeout(connectionTimer); connectionTimer = null; }
                            log.info(`[${streamId}] [STREAM] First chunk received after ${Date.now() - startTime}ms type=${type}`);
                        }
                    }

                    if (text) {
                        const yieldType = (type === 'thinking' || type === 'reasoning') ? 'thinking' : 'content';
                        if (yieldType === 'thinking') log.debug(`[${streamId}] [STREAM] Thinking chunk: ${text.length} chars`);
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
                            value: { prompt_tokens: chunk.prompt_eval_count || 0, completion_tokens: chunk.eval_count || 0 }
                        } as StreamChunk;
                        return;
                    }
                }
            }

            // Flush remaining buffer
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

            log.warn(`[${streamId}] [STREAM] Stream ended WITHOUT explicit 'done' chunk. stats=${JSON.stringify(stats)}, elapsed=${Date.now() - startTime}ms`);
        } catch (streamErr) {
            const isAbort = streamErr instanceof Error && (streamErr.name === 'AbortError' || streamErr.message.includes('aborted'));
            if (isAbort) {
                log.warn(`[${streamId}] [STREAM] ABORTED: ${errorMessage(streamErr)}. stats=${JSON.stringify(stats)}`);
            } else {
                log.error(`[${streamId}] [STREAM] ERROR: ${errorMessage(streamErr)}. stats=${JSON.stringify(stats)}`);
            }
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
     * On stream failure, throws — caller handles retries and fallback.
     */
    private async _consumeStream(messages: LLMMessage[], tools?: ToolDefinition[], customTimeoutMs?: number, externalSignal?: AbortSignal): Promise<LLMResponse> {
        let content = '';
        let thinking = '';
        const toolCalls: RawToolCall[] = [];
        let usage: OpenAIChatResponse['usage'] | undefined = undefined;
        let chunkCount = 0;
        const startTime = Date.now();
        const consumeId = `sc-${Date.now().toString(36)}`;

        log.info(`[${consumeId}] [STREAM-CONSUME] START timeout=${customTimeoutMs || 'default'}ms`);

        try {
            for await (const chunk of this.streamChat(messages, tools, customTimeoutMs, externalSignal)) {
                chunkCount++;
                switch (chunk.type) {
                    case 'content': content += chunk.value; break;
                    case 'thinking': thinking += chunk.value; break;
                    case 'tool_call': toolCalls.push(chunk.value); break;
                    case 'done': usage = chunk.value; break;
                }
            }
        } catch (streamErr) {
            const elapsed = Date.now() - startTime;
            // Models like deepseek-v4-flash:cloud route their entire response through the thinking
            // field. When the stream is aborted (timeout, not user cancel) with thinking but no
            // content, recover the thinking as content — the same heuristic applied on normal
            // completion at line ~352. User-cancel discarding is handled by the caller (chatWithFallback
            // checks externalSignal after we return, so no thinking leaks to a cancelled user).
            if (!content && thinking && thinking.length > 50) {
                log.info(`[${consumeId}] [STREAM-CONSUME] Aborted with ${thinking.length} chars of thinking, no content — recovering thinking as content`);
                content = thinking;
                thinking = '';
            }
            if (!content) {
                log.error(`[${consumeId}] [STREAM-CONSUME] FAILED after ${chunkCount} chunks, ${elapsed}ms: ${errorMessage(streamErr)}`);
                throw streamErr;
            }
            log.warn(`[${consumeId}] [STREAM-CONSUME] Recovered from stream abort: ${content.length} chars content after ${chunkCount} chunks, ${elapsed}ms`);
        }

        const elapsed = Date.now() - startTime;

        // Some models (e.g. deepseek-v4-flash:cloud via Ollama) return their full response
        // in message.thinking instead of message.content. When content is empty but thinking
        // is available, use thinking as the actual response content.
        if (!content && thinking) {
            log.info(`[${consumeId}] [STREAM-CONSUME] No content but ${thinking.length} chars of thinking — using as content (model returned response in thinking field)`);
            content = thinking;
            thinking = '';
        } else if (thinking) {
            log.debug(`[${consumeId}] [STREAM-CONSUME] Discarded ${thinking.length} chars of internal thinking from response`);
        }

        if (!content && toolCalls.length === 0) {
            log.warn(`[${consumeId}] [STREAM-CONSUME] EMPTY after ${chunkCount} chunks, ${elapsed}ms`);
            throw new Error('Empty response from stream');
        }

        log.info(`[${consumeId}] [STREAM-CONSUME] COMPLETE chunks=${chunkCount} content=${content.length}chars thinking=${thinking.length}chars toolCalls=${toolCalls.length} duration=${elapsed}ms`);

        return {
            content,
            thinking: thinking || undefined,
            toolCalls: toolCalls.length > 0 ? toolCalls.map((tc: RawToolCall, i: number) => ({
                id: tc.id || `call_${Date.now()}_${i}`,
                name: tc.function?.name || '',
                arguments: parseToolArgs(tc.function?.arguments)
            })) : undefined,
            usage: usage ? { prompt_tokens: usage.prompt_tokens ?? 0, completion_tokens: usage.completion_tokens ?? 0 } : undefined
        };
    }

    /**
     * Fallback: non-streaming request when streaming fails.
     * Only safe to call as last resort from chatWithFallback.
     */
    public async _fallbackNonStreaming(messages: LLMMessage[], tools?: ToolDefinition[], customTimeoutMs?: number, externalSignal?: AbortSignal): Promise<LLMResponse> {
        const numCtx = parseInt(process.env.OLLAMA_NUM_CTX || '32768', 10);
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

        const controller = new AbortController();
        if (externalSignal?.aborted) throw new Error('Aborted by external signal');
        externalSignal?.addEventListener('abort', () => controller.abort(), { once: true });

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
            const data = await response.json() as OpenAIChatResponse;
            const message = data.message;
            // Same fallback as streaming: some models return response in thinking field
            const content = message?.content || (message as unknown as { thinking?: string })?.thinking || '';
            return {
                content,
                toolCalls: message?.tool_calls?.map((tc: RawToolCall, i: number) => ({
                    id: tc.id || `call_${Date.now()}_${i}`,
                    name: tc.function?.name || '',
                    arguments: parseToolArgs(tc.function?.arguments)
                })),
                usage: data.usage ? {
                    prompt_tokens: data.usage?.prompt_tokens ?? 0,
                    completion_tokens: data.usage?.completion_tokens ?? 0
                } : undefined
            };
        } finally {
            clearTimeout(timeout);
        }
    }
}
