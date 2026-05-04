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
    | { type: 'tool_call'; value: any }
    | { type: 'done'; value: { prompt_tokens: number; completion_tokens: number } };

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

export interface ILLMProvider {
    name: string;
    chat(messages: LLMMessage[], tools?: ToolDefinition[]): Promise<LLMResponse>;
    setModel(model: string): void;
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

    async chat(messages: LLMMessage[], tools?: ToolDefinition[]): Promise<LLMResponse> {
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
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

    async chat(messages: LLMMessage[], tools?: ToolDefinition[]): Promise<LLMResponse> {
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
                arguments: JSON.parse(tc.function.arguments || '{}')
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

    async chat(messages: LLMMessage[], tools?: ToolDefinition[]): Promise<LLMResponse> {
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
                arguments: JSON.parse(tc.function.arguments || '{}')
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

    async chat(messages: LLMMessage[], tools?: ToolDefinition[]): Promise<LLMResponse> {
        try {
            return await generationQueue.add(() => this._consumeStream(messages, tools));
        } catch (error: any) {
            // 1 retry after 10s on timeout/abort/network errors
            if (error.message?.includes('abort') || error.message?.includes('timeout') || error.message?.includes('ECONNRESET') || error.message?.includes('fetch failed')) {
                log.info(`Retry after: ${error.message}, waiting 10s...`);
                await new Promise(r => setTimeout(r, 10000));
                return await generationQueue.add(() => this._consumeStream(messages, tools));
            }
            throw error;
        }
    }

    /** Classification call — uses a separate queue to avoid blocking on long generations */
    async classify(messages: LLMMessage[], timeoutMs: number = 30000): Promise<LLMResponse> {
        return await classificationQueue.add(() => this._consumeStream(messages, undefined, timeoutMs));
    }

    /**
     * Streaming generator — yields content tokens as they arrive from Ollama SSE.
     * This is the core streaming method. Other methods consume it.
     * 
     * SSE format from Ollama:
     *   {"message":{"role":"assistant","content":"Hel"},"done":false}
     *   {"message":{"role":"assistant","content":"lo"},"done":false}
     *   {"done":true,"prompt_eval_count":N,"eval_count":M}
     * 
     * Handles partial buffers (lines broken between chunks).
     */
    async *streamChat(messages: LLMMessage[], tools?: ToolDefinition[], customTimeoutMs?: number): AsyncGenerator<StreamChunk> {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (this.apiKey) {
            headers['Authorization'] = `Bearer ${this.apiKey}`;
        }

        const numCtx = parseInt(process.env.OLLAMA_NUM_CTX || '32768', 10);
        const controller = new AbortController();
        const timeoutMs = customTimeoutMs || 300000;
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

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

        let response: Response;
        try {
            response = await fetch(`${this.baseUrl}/api/chat`, {
                method: 'POST',
                headers,
                signal: controller.signal,
                body: JSON.stringify(requestBody)
            });
        } finally {
            clearTimeout(timeout);
        }

        if (!response.ok) {
            throw new Error(`Ollama API error: ${response.status}`);
        }

        const body = response.body;
        if (!body) throw new Error('No response body from Ollama');

        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let totalContentChunks = 0;
        let totalContentChars = 0;
        const streamStartTime = Date.now();

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    log.info(`[STREAM] reader.read() done=true (stream ended by server). Chunks: ${totalContentChunks}, Chars: ${totalContentChars}, Elapsed: ${Date.now() - streamStartTime}ms`);
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
                        log.warn(`[STREAM] Malformed JSON (${trimmed.length} chars): ${trimmed.slice(0, 80)}...`);
                        continue;
                    }

                    // ── Diagnostic logging ──
                    if (chunk.message?.content) {
                        totalContentChunks++;
                        totalContentChars += chunk.message.content.length;
                    }

                    if (chunk.done) {
                        const doneReason = chunk.done_reason || '(not provided)';
                        log.info(`[STREAM] DONE received. done_reason="${doneReason}" prompt_eval_count=${chunk.prompt_eval_count || 0} eval_count=${chunk.eval_count || 0} total_content_chunks=${totalContentChunks} total_content_chars=${totalContentChars} elapsed=${Date.now() - streamStartTime}ms`);
                    }

                    if (chunk.message?.content) {
                        yield { type: 'content', value: chunk.message.content };
                    }

                    if (chunk.message?.tool_calls) {
                        for (const tc of chunk.message.tool_calls) {
                            log.info(`[STREAM] Tool call: ${tc.function?.name || 'unknown'}`);
                            yield { type: 'tool_call', value: tc };
                        }
                    }

                    if (chunk.done) {
                        yield {
                            type: 'done',
                            value: {
                                prompt_tokens: chunk.prompt_eval_count || 0,
                                completion_tokens: chunk.eval_count || 0
                            }
                        };
                        return; // Stream complete
                    }
                }
            }

            // Flush remaining buffer (incomplete last line)
            if (buffer.trim()) {
                log.info(`[STREAM] Flushing remaining buffer (${buffer.trim().length} chars)`);
                try {
                    const chunk = JSON.parse(buffer.trim());
                    if (chunk.message?.content) {
                        totalContentChars += chunk.message.content.length;
                        yield { type: 'content', value: chunk.message.content };
                    }
                    if (chunk.done) {
                        const doneReason = chunk.done_reason || '(not provided)';
                        log.info(`[STREAM] DONE in buffer flush. done_reason="${doneReason}" eval_count=${chunk.eval_count || 0}`);
                        yield { type: 'done', value: { prompt_tokens: chunk.prompt_eval_count || 0, completion_tokens: chunk.eval_count || 0 } };
                    }
                } catch {
                    log.warn(`[STREAM] Failed to parse remaining buffer: ${buffer.trim().slice(0, 80)}...`);
                }
            }

            // If we reached here without yielding 'done', log it
            log.warn(`[STREAM] Stream ended WITHOUT explicit 'done' chunk. Total chunks: ${totalContentChunks}, Total chars: ${totalContentChars}, Elapsed: ${Date.now() - streamStartTime}ms`);
        } catch (streamErr: any) {
            log.error(`[STREAM] Error: ${streamErr.message}. Chunks: ${totalContentChunks}, Chars: ${totalContentChars}`);
            throw streamErr;
        } finally {
            reader.releaseLock();
        }
    }


    /**
     * Consume the streaming generator and collect full response.
     * This is the wrapper that chat() and classify() use.
     */
    private async _consumeStream(messages: LLMMessage[], tools?: ToolDefinition[], customTimeoutMs?: number): Promise<LLMResponse> {
        let content = '';
        const toolCalls: any[] = [];
        let usage: any = undefined;

        try {
            for await (const chunk of this.streamChat(messages, tools, customTimeoutMs)) {
                switch (chunk.type) {
                    case 'content':
                        content += chunk.value;
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
            // Fallback: non-streaming request
            log.warn(`Stream failed, falling back to non-streaming: ${streamErr.message}`);
            return this._fallbackNonStreaming(messages, tools, customTimeoutMs);
        }

        // Empty response check
        if (!content && toolCalls.length === 0) {
            log.warn('Stream completed with no content and no tool calls — falling back');
            return this._fallbackNonStreaming(messages, tools, customTimeoutMs);
        }

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
     */
    private async _fallbackNonStreaming(messages: LLMMessage[], tools?: ToolDefinition[], customTimeoutMs?: number): Promise<LLMResponse> {
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

    async chat(messages: LLMMessage[], tools?: ToolDefinition[]): Promise<LLMResponse> {
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
                arguments: JSON.parse(tc.function.arguments || '{}')
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

    async chat(messages: LLMMessage[], tools?: ToolDefinition[]): Promise<LLMResponse> {
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

    /** Chat with automatic fallback — tries next provider if current fails */
    async chatWithFallback(messages: LLMMessage[], tools?: ToolDefinition[], preferredProvider?: string, timeoutMs?: number): Promise<LLMResponse> {
        const providerOrder = this.getFallbackOrder(preferredProvider);
        const errors: string[] = [];

        for (const providerName of providerOrder) {
            try {
                const provider = this.providers.get(providerName);
                if (!provider) continue;
                log.info(`Trying ${providerName}...${timeoutMs ? ` (timeout: ${timeoutMs}ms)` : ''}`);
                
                // Wrap chat call with optional timeout
                const chatPromise = provider.chat(messages, tools);
                let result: LLMResponse;

                if (timeoutMs) {
                    result = await Promise.race([
                        chatPromise,
                        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeoutMs))
                    ]);
                } else {
                    result = await chatPromise;
                }

                // Check for leaked tool calls
                if (!result.toolCalls || result.toolCalls.length === 0) {
                    const extractedCalls = this.extractLeakedToolCalls(result.content);
                    if (extractedCalls) {
                        log.info(`Extracted leaked tool call: ${extractedCalls[0].name}`);
                        result.toolCalls = extractedCalls;
                    }
                }

                // Return if has content OR tool_calls (native function calling)
                if ((result.content && result.content.trim().length > 0) || (result.toolCalls && result.toolCalls.length > 0)) {
                    return result;
                }
                // Empty response — try next
                errors.push(`${providerName}: empty response`);
            } catch (error: any) {
                log.warn(`${providerName} failed or timed out: ${error.message}`);
                errors.push(`${providerName}: ${error.message}`);
                continue;
            }
        }

        throw new Error(`All providers failed: ${errors.join('; ')}`);
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