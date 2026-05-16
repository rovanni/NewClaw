import { ILLMProvider, LLMMessage, LLMResponse, ToolDefinition, ChatOptions, OpenAIChatResponse, RawToolCall } from './providerTypes';
import { taskQueue, TaskPriority } from './providerQueue';

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
        return await taskQueue.add(async () => {
            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
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

            if (!response.ok) throw new Error(`Groq API error: ${response.status}`);

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
