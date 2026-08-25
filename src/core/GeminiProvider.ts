import { ILLMProvider, LLMMessage, LLMResponse, ToolDefinition, ChatOptions, GeminiChatResponse, ModelInfo } from './providerTypes';
import { taskQueue, TaskPriority } from './providerQueue';
import { createLogger } from '../shared/AppLogger';
import { guessCapabilities } from './modelCapabilityHeuristics';

const log = createLogger('GeminiProvider');

export class GeminiProvider implements ILLMProvider {
    name = 'gemini';
    private apiKey: string;
    private model: string;

    constructor(apiKey: string, model: string = 'gemini-2.0-flash') {
        this.apiKey = apiKey;
        this.model = model;
    }

    setModel(model: string): void { this.model = model; }

    /** `GET /v1beta/models` — endpoint real do Gemini (confirmado contra a documentação oficial):
     *  auth por query param `key=`, não header; cada item vem como `name: "models/xxx"`, não
     *  `id` puro — o prefixo é removido aqui porque é assim que `this.model` já é usado na URL de
     *  `generateContent` (sem o prefixo). Só lista/valida a chave — não muda `chat()`. */
    async discoverModels(): Promise<ModelInfo[]> {
        const resp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${this.apiKey}`,
        );
        if (!resp.ok) {
            const err = new Error(`Gemini /models error: ${resp.status}`) as Error & { status?: number };
            err.status = resp.status;
            throw err;
        }
        const data = await resp.json() as { models?: Array<{ name: string; displayName?: string }> };
        return (data.models || []).map(m => {
            const id = m.name.startsWith('models/') ? m.name.slice('models/'.length) : m.name;
            return {
                id,
                provider: this.name,
                label: m.displayName || id,
                capabilities: guessCapabilities(id),
                status: 'available' as const,
            };
        });
    }

    async chat(messages: LLMMessage[], tools?: ToolDefinition[], options?: ChatOptions): Promise<LLMResponse> {
        const queueEntryTime = Date.now();
        return await taskQueue.add(async () => {
            const queueWaitMs = Date.now() - queueEntryTime;
            if (queueWaitMs > 500) log.info(`Queue wait: ${queueWaitMs}ms (budget: ${options?.timeoutMs ?? 'none'}ms)`);
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

            if (!response.ok) throw new Error(`Gemini API error: ${response.status}`);

            const data = await response.json() as GeminiChatResponse;
            const candidate = data.candidates?.[0];
            const content = candidate?.content?.parts?.[0]?.text || '';
            const functionCall = candidate?.content?.parts?.[0]?.functionCall;

            return {
                content,
                toolCalls: functionCall ? [{
                    id: `call_${Date.now()}`,
                    name: functionCall?.name ?? '',
                    arguments: (functionCall?.args ?? {}) as Record<string, unknown>
                }] : undefined,
                usage: data.usageMetadata ? {
                    prompt_tokens: data.usageMetadata?.promptTokenCount ?? 0,
                    completion_tokens: data.usageMetadata?.candidatesTokenCount ?? 0
                } : undefined
            };
        }, { priority: TaskPriority.INTERACTIVE });
    }
}
