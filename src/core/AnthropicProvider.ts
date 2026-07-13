import { ILLMProvider, LLMMessage, LLMResponse, ToolDefinition, ChatOptions, ToolCall, AnthropicChatResponse, AnthropicContentBlock } from './providerTypes';
import { taskQueue, TaskPriority } from './providerQueue';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('AnthropicProvider');

// A Messages API exige max_tokens explícito (diferente de Gemini/DeepSeek/Groq/OpenAI, que usam
// um default do servidor quando omitido). 8192 é um teto seguro para respostas de agente sem
// truncar prematuramente em nenhum modelo Claude atual.
const DEFAULT_MAX_TOKENS = 8192;
const ANTHROPIC_VERSION = '2023-06-01';

interface AnthropicMessage {
    role: 'user' | 'assistant';
    content: string | AnthropicContentBlock[];
}

/**
 * Converte o formato interno (LLMMessage[], estilo OpenAI: role system/user/assistant/tool +
 * toolCalls/tool_call_id) para o formato de blocos da Anthropic Messages API:
 *   - role 'system'    → extraído para o parâmetro `system` de topo (não entra em `messages`).
 *   - role 'assistant' com toolCalls → bloco(s) `tool_use` (+ bloco `text` se houver conteúdo).
 *   - role 'tool'       → bloco `tool_result` referenciando `tool_use_id`; mensagens 'tool'
 *     consecutivas (múltiplas tool calls no mesmo turno) são agrupadas em UMA mensagem 'user',
 *     porque a API rejeita tool_result fora de uma única mensagem de usuário subsequente ao
 *     turno com tool_use.
 */
function convertMessages(messages: LLMMessage[]): { system: string; anthropicMessages: AnthropicMessage[] } {
    const systemParts: string[] = [];
    const anthropicMessages: AnthropicMessage[] = [];
    let i = 0;

    while (i < messages.length) {
        const m = messages[i];

        if (m.role === 'system') {
            if (m.content) systemParts.push(m.content);
            i++;
            continue;
        }

        if (m.role === 'tool') {
            const blocks: AnthropicContentBlock[] = [];
            while (i < messages.length && messages[i].role === 'tool') {
                const tm = messages[i];
                blocks.push({ type: 'tool_result', tool_use_id: tm.tool_call_id || '', content: tm.content });
                i++;
            }
            anthropicMessages.push({ role: 'user', content: blocks });
            continue;
        }

        if (m.role === 'assistant') {
            const blocks: AnthropicContentBlock[] = [];
            if (m.content && m.content.trim()) blocks.push({ type: 'text', text: m.content });
            for (const tc of m.toolCalls ?? []) {
                blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
            }
            // Mensagem sem texto nem tool_use (raro) — Anthropic rejeita content vazio.
            anthropicMessages.push({ role: 'assistant', content: blocks.length > 0 ? blocks : (m.content || ' ') });
            i++;
            continue;
        }

        // user
        anthropicMessages.push({ role: 'user', content: m.content || ' ' });
        i++;
    }

    return { system: systemParts.join('\n\n'), anthropicMessages };
}

export class AnthropicProvider implements ILLMProvider {
    name = 'anthropic';
    private apiKey: string;
    private model: string;

    constructor(apiKey: string, model: string = 'claude-sonnet-5') {
        this.apiKey = apiKey;
        this.model = model;
    }

    setModel(model: string): void { this.model = model; }

    async chat(messages: LLMMessage[], tools?: ToolDefinition[], options?: ChatOptions): Promise<LLMResponse> {
        const queueEntryTime = Date.now();
        return await taskQueue.add(async () => {
            const queueWaitMs = Date.now() - queueEntryTime;
            if (queueWaitMs > 500) log.info(`Queue wait: ${queueWaitMs}ms (budget: ${options?.timeoutMs ?? 'none'}ms)`);

            const { system, anthropicMessages } = convertMessages(messages);
            const body: Record<string, unknown> = {
                model: this.model,
                max_tokens: DEFAULT_MAX_TOKENS,
                messages: anthropicMessages,
            };
            if (system) body.system = system;
            if (tools && tools.length > 0) {
                body.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
            }

            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-api-key': this.apiKey,
                    'anthropic-version': ANTHROPIC_VERSION,
                },
                signal: options?.signal,
                body: JSON.stringify(body),
            });

            if (!response.ok) {
                const error = await response.text();
                throw new Error(`Anthropic API error (${response.status}): ${error}`);
            }

            const data = await response.json() as AnthropicChatResponse;
            if (data.error) throw new Error(`Anthropic API error: ${data.error.message ?? data.error.type}`);

            let content = '';
            let thinking = '';
            const toolCalls: ToolCall[] = [];
            for (const block of data.content ?? []) {
                if (block.type === 'text' && block.text) content += block.text;
                else if (block.type === 'thinking' && block.thinking) thinking += block.thinking;
                else if (block.type === 'tool_use' && block.name) {
                    toolCalls.push({ id: block.id ?? `call_${Date.now()}`, name: block.name, arguments: (block.input ?? {}) as Record<string, unknown> });
                }
            }

            return {
                content,
                thinking: thinking || undefined,
                toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
                usage: data.usage ? {
                    prompt_tokens: data.usage.input_tokens ?? 0,
                    completion_tokens: data.usage.output_tokens ?? 0,
                } : undefined,
            };
        }, { priority: TaskPriority.INTERACTIVE });
    }
}

export { convertMessages as _convertMessagesForTest };
