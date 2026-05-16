import { ILLMProvider, LLMMessage, LLMResponse, ToolDefinition, ChatOptions, GeminiChatResponse } from './providerTypes';
import { taskQueue, TaskPriority } from './providerQueue';

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
        return await taskQueue.add(async () => {
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
