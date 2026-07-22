import { ILLMProvider, LLMMessage, LLMResponse, ToolDefinition, ChatOptions, OpenAIChatResponse, RawToolCall, ModelInfo } from './providerTypes';
import { taskQueue, TaskPriority } from './providerQueue';
import { createLogger } from '../shared/AppLogger';
import { guessCapabilities } from './modelCapabilityHeuristics';

const log = createLogger('OpenAIProvider');

/**
 * Provider genérico para qualquer endpoint compatível com a API da OpenAI
 * (`/chat/completions`, `/models`) — cobre OpenAI oficial, LM Studio, vLLM e endpoints
 * "custom" apontados pelo usuário. Um único adapter parametrizado por baseUrl/label em vez de
 * uma classe por produto (ver docs/ANALISE_ARQUITETURAL_MODEL_REGISTRY_2026-07-22.md, Fase 3).
 */
export class OpenAIProvider implements ILLMProvider {
    name = 'openai';
    private apiKey: string;
    private model: string;
    protected baseUrl: string;
    private label: string;

    constructor(apiKey: string, model: string = 'gpt-4o', baseUrl: string = 'https://api.openai.com/v1', label?: string) {
        this.apiKey = apiKey;
        this.model = model;
        this.baseUrl = baseUrl;
        this.label = label || this.name;
    }

    setModel(model: string): void { this.model = model; }
    getBaseUrl(): string { return this.baseUrl; }
    getLabel(): string { return this.label; }

    /**
     * Lista os modelos expostos por /models. Funciona para qualquer servidor
     * OpenAI-Compatible (OpenAI oficial, LM Studio, vLLM, custom) — todos implementam
     * esse endpoint com o mesmo formato `{ data: [{ id }, ...] }`.
     */
    async discoverModels(): Promise<ModelInfo[]> {
        const headers: Record<string, string> = {};
        if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
        const resp = await fetch(`${this.baseUrl}/models`, { headers });
        if (!resp.ok) throw new Error(`${this.label} /models error: ${resp.status}`);
        const data = await resp.json() as { data?: Array<{ id: string }> };
        return (data.data || []).map(m => ({
            id: m.id,
            provider: this.label,
            label: m.id,
            capabilities: guessCapabilities(m.id),
            status: 'available' as const,
        }));
    }

    async chat(messages: LLMMessage[], tools?: ToolDefinition[], options?: ChatOptions): Promise<LLMResponse> {
        const queueEntryTime = Date.now();
        return await taskQueue.add(async () => {
            const queueWaitMs = Date.now() - queueEntryTime;
            if (queueWaitMs > 500) log.info(`Queue wait: ${queueWaitMs}ms (budget: ${options?.timeoutMs ?? 'none'}ms)`);
            const response = await fetch(`${this.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
                signal: options?.signal,
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

            const data = await response.json() as OpenAIChatResponse;
            const message = data.choices?.[0]?.message;

            return {
                content: message?.content || '',
                toolCalls: message?.tool_calls?.map((tc: RawToolCall) => ({
                    id: tc.id ?? `call_${Date.now()}`,
                    name: tc.function?.name ?? '',
                    arguments: (() => { try { return JSON.parse(tc.function?.arguments || '{}'); } catch { return {}; } })()
                })),
                usage: data.usage ? {
                    prompt_tokens: data.usage?.prompt_tokens ?? 0,
                    completion_tokens: data.usage?.completion_tokens ?? 0
                } : undefined
            };
        }, { priority: TaskPriority.INTERACTIVE });
    }
}

export class OpenRouterProvider extends OpenAIProvider {
    constructor(apiKey: string, model: string = 'anthropic/claude-3.5-sonnet') {
        super(apiKey, model, 'https://openrouter.ai/api/v1', 'openrouter');
        this.name = 'openrouter';
    }

    async chat(messages: LLMMessage[], tools?: ToolDefinition[], options?: ChatOptions): Promise<LLMResponse> {
        return super.chat(messages, tools, options);
    }
}
