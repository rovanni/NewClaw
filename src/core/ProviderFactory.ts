/**
 * ProviderFactory — Troca dinâmica de LLMs
 * Suporta: Gemini, DeepSeek, Groq, OpenAI, OpenRouter, Ollama
 */

import { createLogger } from '../shared/AppLogger';
import { errorMessage } from '../shared/errors';
import { circuitRegistry } from './CircuitBreaker';
import { LLMMessage, LLMResponse, ToolDefinition, LLMResult, AttemptInfo, FallbackReason, ToolCall, ILLMProvider, ChatOptions } from './providerTypes';
import { GeminiProvider } from './GeminiProvider';
import { DeepSeekProvider } from './DeepSeekProvider';
import { GroqProvider } from './GroqProvider';
import { OpenRouterProvider } from './OpenAIProvider';
import { OllamaProvider } from './OllamaProvider';

// Re-export everything so all existing imports continue to work unchanged
export type { LLMMessage, LLMResponse, ToolCall, ToolDefinition, FallbackReason, AttemptInfo, LLMResult, MetricsSummary, ILLMProvider, ChatOptions, StreamChunk } from './providerTypes';
export { TaskPriority } from './providerQueue';
export { GeminiProvider } from './GeminiProvider';
export { DeepSeekProvider } from './DeepSeekProvider';
export { GroqProvider } from './GroqProvider';
export { OpenAIProvider, OpenRouterProvider } from './OpenAIProvider';
export { OllamaProvider } from './OllamaProvider';

const log = createLogger('Providerfactory');

export class ProviderFactory {
    private providers: Map<string, ILLMProvider> = new Map();
    private defaultProvider: string;
    public readonly circuitBreakers: typeof circuitRegistry;

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
        this.circuitBreakers = circuitRegistry;

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

    getProviderWithModel(model: string): ILLMProvider {
        const ollamaProvider = this.providers.get('ollama') as OllamaProvider;
        if (!ollamaProvider) return this.getProvider();
        return new OllamaProvider(ollamaProvider.getBaseUrl(), model);
    }

    getAvailableProviders(): string[] { return Array.from(this.providers.keys()); }
    getDefaultProvider(): string { return this.defaultProvider; }

    setDefaultProvider(name: string): void {
        if (this.providers.has(name)) {
            this.defaultProvider = name;
        } else {
            throw new Error(`Provider "${name}" not available. Available: ${this.getAvailableProviders().join(', ')}`);
        }
    }

    /**
     * Chat with automatic fallback — tries next provider if current fails.
     *
     * ATOMICITY GUARANTEE:
     * - Each attempt gets its own AbortController and isolated buffers.
     * - Previous attempts are ALWAYS aborted before starting a new one.
     * - Only ONE response is returned — the LAST successful attempt.
     * - No partial content from failed attempts is ever included.
     */
    async chatWithFallback(messages: LLMMessage[], tools?: ToolDefinition[], preferredProvider?: string, timeoutMs?: number, externalSignal?: AbortSignal): Promise<LLMResult> {
        if (externalSignal?.aborted) {
            return { status: 'cancelled', content: '', fallbackReason: 'cancelled', fallbackMessage: 'Operação cancelada.', attempts: [] };
        }

        const providerOrder = this.getFallbackOrder(preferredProvider);
        const attemptLog: AttemptInfo[] = [];
        const MAX_RETRIES = 1;
        const RETRY_BACKOFF_MS = 10000;
        const requestId = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const startTime = Date.now();

        let activeAbortController: AbortController | null = null;

        log.info(`[${requestId}] chatWithFallback START providers=[${providerOrder.join(',')}] timeout=${timeoutMs || 'none'}ms`);

        const activeProviders = providerOrder.filter(name => {
            const breaker = this.circuitBreakers.getOrCreate({ name });
            if (!breaker.canExecute()) {
                log.info(`[${requestId}] CIRCUIT-OPEN: Skipping '${name}' (failures: ${breaker.getFailureCount()})`);
                return false;
            }
            return true;
        });

        if (activeProviders.length === 0) {
            log.error(`[${requestId}] ALL_PROVIDERS_CIRCUIT_OPEN — no provider available`);
            return {
                status: 'error' as const,
                content: 'Todos os providers estão temporariamente indisponíveis. Tente novamente em alguns segundos.',
                attempts: attemptLog,
            };
        }

        log.info(`[${requestId}] Active providers after circuit check: [${activeProviders.join(',')}]`);

        for (const providerName of activeProviders) {
            for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
                const attemptId = `${requestId}-${providerName}-${attempt}`;
                const attemptStart = Date.now();

                if (externalSignal?.aborted) {
                    if (activeAbortController) { activeAbortController.abort(); activeAbortController = null; }
                    log.info(`[${requestId}] External cancellation before attempt ${providerName}-${attempt}`);
                    return { status: 'cancelled', content: '', fallbackReason: 'cancelled', fallbackMessage: 'Operação cancelada.', attempts: attemptLog };
                }

                if (activeAbortController) {
                    log.info(`[${requestId}] Aborting previous in-flight request before attempt ${attempt}`);
                    activeAbortController.abort();
                    activeAbortController = null;
                }

                const currentAbort = new AbortController();
                activeAbortController = currentAbort;

                // Link external signal so a cancel() from AgentLoop propagates into the provider HTTP call
                let onExternalAbort: (() => void) | null = null;
                if (externalSignal) {
                    onExternalAbort = () => currentAbort.abort();
                    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
                }

                try {
                    const provider = this.providers.get(providerName);
                    if (!provider) break;
                    const modelUsed = (provider instanceof OllamaProvider) ? provider.getModel() : (provider as { model?: string }).model || provider.name;

                    if (attempt > 0) {
                        log.info(`[${attemptId}] Retry ${attempt}/${MAX_RETRIES} after ${RETRY_BACKOFF_MS}ms backoff`);
                        await new Promise(r => setTimeout(r, RETRY_BACKOFF_MS));
                        if (externalSignal?.aborted) {
                            activeAbortController = null;
                            if (onExternalAbort) externalSignal.removeEventListener('abort', onExternalAbort);
                            return { status: 'cancelled', content: '', fallbackReason: 'cancelled', fallbackMessage: 'Operação cancelada.', attempts: attemptLog };
                        }
                    }

                    log.info(`[${attemptId}] START provider=${providerName}/${modelUsed} timeout=${timeoutMs || 'none'}ms`);

                    const chatOptions: ChatOptions = { signal: currentAbort.signal };
                    const chatPromise = provider.chat(messages, tools, chatOptions);
                    let result: LLMResponse;

                    if (timeoutMs) {
                        const attemptTimeout = setTimeout(() => currentAbort.abort(), timeoutMs);
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

                    if (onExternalAbort) externalSignal!.removeEventListener('abort', onExternalAbort);

                    const hasContent = (result.content && result.content.trim().length > 0) || (result.toolCalls && result.toolCalls.length > 0);
                    if (externalSignal?.aborted) {
                        log.info(`[${attemptId}] External cancellation after response — discarding`);
                        activeAbortController = null;
                        return { status: 'cancelled', content: '', fallbackReason: 'cancelled', fallbackMessage: 'Operação cancelada.', attempts: attemptLog };
                    }
                    if (currentAbort.signal.aborted && !hasContent) {
                        log.warn(`[${attemptId}] ABORTED with no content — moving to next attempt`);
                        attemptLog.push({ provider: providerName, model: modelUsed, duration: Date.now() - attemptStart, status: 'error', errorMessage: 'Aborted — no content' });
                        activeAbortController = null;
                        continue;
                    }

                    activeAbortController = null;

                    if (!result.toolCalls || result.toolCalls.length === 0) {
                        const extractedCalls = this.extractLeakedToolCalls(result.content);
                        if (extractedCalls) {
                            log.info(`[${attemptId}] Extracted leaked tool call: ${extractedCalls[0].name}`);
                            result.toolCalls = extractedCalls;
                        }
                    }

                    const duration = Date.now() - attemptStart;

                    if ((result.content && result.content.trim().length > 0) || (result.toolCalls && result.toolCalls.length > 0)) {
                        attemptLog.push({ provider: providerName, model: modelUsed, duration, status: 'success' });
                        this.circuitBreakers.getOrCreate({ name: providerName }).recordSuccess();
                        log.info(`[${attemptId}] SUCCESS content=${result.content.length}chars thinking=${(result.thinking || '').length}chars toolCalls=${result.toolCalls?.length || 0} duration=${duration}ms`);
                        return {
                            status: 'success',
                            content: result.content,
                            thinking: result.thinking || undefined,
                            toolCalls: result.toolCalls,
                            usage: result.usage,
                            attempts: attemptLog
                        };
                    }

                    attemptLog.push({ provider: providerName, model: modelUsed, duration, status: 'empty' });
                    log.warn(`[${attemptId}] Empty response, moving to next`);
                    break;
                } catch (error) {
                    const duration = Date.now() - attemptStart;
                    activeAbortController = null;
                    if (onExternalAbort) externalSignal!.removeEventListener('abort', onExternalAbort);

                    // External cancel trumps all other error classification
                    if (externalSignal?.aborted) {
                        log.info(`[${attemptId}] Cancelled by external signal`);
                        attemptLog.push({ provider: providerName, model: providerName, duration, status: 'cancelled', errorMessage: 'Cancelled' });
                        return { status: 'cancelled', content: '', fallbackReason: 'cancelled', fallbackMessage: 'Operação cancelada.', attempts: attemptLog };
                    }

                    const prov = this.providers.get(providerName);
                    const modelUsed = (prov instanceof OllamaProvider) ? prov.getModel() : (prov as { model?: string })?.model || providerName;
                    const isTimeout = errorMessage(error)?.includes('Timeout');
                    const isRetryable = isTimeout ||
                        errorMessage(error)?.includes('abort') ||
                        errorMessage(error)?.includes('ECONNRESET') ||
                        errorMessage(error)?.includes('fetch failed') ||
                        errorMessage(error)?.includes('network');

                    log.warn(`[${attemptId}] FAILED ${errorMessage(error)} duration=${duration}ms retryable=${isRetryable && attempt < MAX_RETRIES}`);
                    attemptLog.push({
                        provider: providerName,
                        model: modelUsed,
                        duration,
                        status: isTimeout ? 'timeout' : 'error',
                        errorMessage: errorMessage(error)
                    });

                    this.circuitBreakers.getOrCreate({ name: providerName }).recordFailure(errorMessage(error));

                    if (isRetryable && attempt < MAX_RETRIES) continue;
                    break;
                }
            }
        }

        // All streaming providers exhausted — try non-streaming fallback
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
                } catch (fallbackErr) {
                    attemptLog.push({ provider: 'ollama', model: 'non-streaming-fallback', duration: Date.now() - startTime, status: 'error', errorMessage: errorMessage(fallbackErr) });
                }
            }
        }

        const lastError = (attemptLog.length > 0 && attemptLog[attemptLog.length - 1]?.errorMessage)
            ? attemptLog[attemptLog.length - 1].errorMessage : '';
        const isTimeoutError = lastError?.includes('Timeout') || lastError?.includes('abort');
        log.error(`[${requestId}] EXHAUSTED attempts=${attemptLog.length}`);

        return {
            status: isTimeoutError ? 'timeout' : 'error',
            content: '',
            toolCalls: undefined,
            fallbackReason: isTimeoutError ? 'timeout' : 'error' as FallbackReason,
            fallbackMessage: 'O modelo demorou mais que o esperado. Tente novamente em alguns instantes.',
            attempts: attemptLog
        };
    }

    private extractLeakedToolCalls(content: string): ToolCall[] | undefined {
        if (!content) return undefined;
        try {
            const toolCallMatch = content.match(/\[TOOL_CALL\]([\s\S]*?)\[\/TOOL_CALL\]/i);
            if (toolCallMatch?.[1]) {
                const parsed = JSON.parse(toolCallMatch[1].trim());
                if (parsed.name && parsed.arguments) return [{ id: `call_${Date.now()}`, name: parsed.name, arguments: parsed.arguments }];
            }
            const xmlMatch = content.match(/<tool_call>([\s\S]*?)<\/tool_call>/i);
            if (xmlMatch?.[1]) {
                const parsed = JSON.parse(xmlMatch[1].trim());
                if (parsed.name && parsed.arguments) return [{ id: `call_${Date.now()}`, name: parsed.name, arguments: parsed.arguments }];
            }
            const jsonBlockMatch = content.match(/```json\s*([\s\S]*?)\s*```/i);
            if (jsonBlockMatch?.[1]) {
                const parsed = JSON.parse(jsonBlockMatch[1].trim());
                if (parsed.name && parsed.arguments) return [{ id: `call_${Date.now()}`, name: parsed.name, arguments: parsed.arguments }];
            }
        } catch (e) {
            log.info(`Failed to parse leaked tool call: ${e}`);
        }
        return undefined;
    }

    async classifyWithFallback(messages: LLMMessage[], timeoutMs: number = 30000): Promise<LLMResponse> {
        const providerOrder = this.getFallbackOrder();
        const errors: string[] = [];

        for (const providerName of providerOrder) {
            try {
                const provider = this.providers.get(providerName);
                if (!provider) continue;

                let result: LLMResponse;
                if (providerName === 'ollama' && provider instanceof OllamaProvider) {
                    result = await provider.classify(messages, timeoutMs);
                } else {
                    result = await Promise.race([
                        provider.chat(messages),
                        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeoutMs))
                    ]);
                }

                if (result.content && result.content.trim().length > 0) return result;
                errors.push(`${providerName}: empty response`);
            } catch (error) {
                errors.push(`${providerName}: ${errorMessage(error)}`);
            }
        }

        throw new Error(`Classification failed: ${errors.join('; ')}`);
    }

    private getFallbackOrder(preferred?: string): string[] {
        const all = Array.from(this.providers.keys());
        if (preferred && this.providers.has(preferred)) {
            return [preferred, ...all.filter(p => p !== preferred)];
        }
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
