import { ILLMProvider, LLMMessage, LLMResponse, ToolDefinition, ChatOptions, ToolCall, AnthropicContentBlock, ModelInfo } from './providerTypes';
import { consumirStreamSSE, TelemetriaAoVivo, TRANSPORTE_SEM_PRAZO_PROPRIO } from './streamVigiado';
import { taskQueue, TaskPriority } from './providerQueue';
import { createLogger } from '../shared/AppLogger';
import { guessCapabilities } from './modelCapabilityHeuristics';

const log = createLogger('AnthropicProvider');

// A Messages API exige max_tokens explícito (diferente de Gemini/DeepSeek/Groq/OpenAI, que usam
// um default do servidor quando omitido). 8192 é um teto seguro para respostas de agente sem
// truncar prematuramente em nenhum modelo Claude atual.
const DEFAULT_MAX_TOKENS = 8192;
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

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

    constructor(apiKey: string, model: string = '') {   // modelo escolhido pelo usuário (ANTHROPIC_MODEL); vazio = não escolhido
        this.apiKey = apiKey;
        this.model = model;
    }

    setModel(model: string): void { this.model = model; }

    /** `GET /v1/models` — endpoint real da Anthropic (confirmado contra a documentação oficial,
     *  não é o mesmo formato OpenAI-Compatible: auth por `x-api-key`, não `Authorization: Bearer`,
     *  e o campo de nome é `display_name`). Só lista/valida a chave — não muda `chat()`. */
    async discoverModels(): Promise<ModelInfo[]> {
        const resp = await fetch('https://api.anthropic.com/v1/models', {
            headers: { 'x-api-key': this.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
        });
        if (!resp.ok) {
            const err = new Error(`Anthropic /models error: ${resp.status}`) as Error & { status?: number };
            err.status = resp.status;
            throw err;
        }
        const data = await resp.json() as { data?: Array<{ id: string; display_name?: string }> };
        return (data.data || []).map(m => ({
            id: m.id,
            provider: this.name,
            label: m.display_name || m.id,
            capabilities: guessCapabilities(m.id),
            status: 'available' as const,
        }));
    }

    /**
     * ADR-027: streaming (`stream: true`), e a chamada só para por TRAVAMENTO — nenhum primeiro pedaço ou silêncio entre
     * pedaços (streamVigiado.ts). O `ping` que a API intercala no stream não conta como pedaço: é a conexão viva, não o modelo.
     */
    readonly vigiaSilencio = true;

    async chat(messages: LLMMessage[], tools?: ToolDefinition[], options?: ChatOptions): Promise<LLMResponse> {
        const queueEntryTime = Date.now();
        return await taskQueue.add(async () => {
            const queueWaitMs = Date.now() - queueEntryTime;
            if (queueWaitMs > 500) log.info(`Queue wait: ${queueWaitMs}ms`);

            const { system, anthropicMessages } = convertMessages(messages);
            const body: Record<string, unknown> = {
                model: this.model,
                max_tokens: DEFAULT_MAX_TOKENS,
                messages: anthropicMessages,
                stream: true,
            };
            if (system) body.system = system;
            if (tools && tools.length > 0) {
                body.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
            }
            const corpo = JSON.stringify(body);

            const id = `an-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
            const tele = options?.telemetry;
            const aoVivo = new TelemetriaAoVivo(tele);
            let content = '';
            let thinking = '';
            // Blocos por `index` do stream: `tool_use` chega com id e nome no início e os argumentos em pedaços de JSON.
            const ferramentas = new Map<number, { id?: string; name: string; json: string }>();
            let entrada: number | undefined;
            let saida: number | undefined;
            let motivoDoFim: string | undefined;
            let terminou = false;
            let cortada = false;
            const preencher = (): void => {
                if (!tele) return;
                Object.assign(tele, {
                    chunks: aoVivo.pedacos, contentChars: content.length, thinkingChars: thinking.length, contentText: content, thinkingText: thinking,
                    toolCalls: ferramentas.size, doneReason: motivoDoFim, promptTokens: entrada, evalTokens: saida,
                });
            };

            try {
                await consumirStreamSSE({
                    id, log, modelo: this.model, messages, signal: options?.signal,
                    abrir: async (signal) => {
                        const response = await fetch(ANTHROPIC_MESSAGES_URL, {
                            method: 'POST',
                            headers: {
                                'content-type': 'application/json',
                                'x-api-key': this.apiKey,
                                'anthropic-version': ANTHROPIC_VERSION,
                            },
                            signal,
                            dispatcher: TRANSPORTE_SEM_PRAZO_PROPRIO,
                            body: corpo,
                        } as RequestInit);
                        if (!response.ok) {
                            const error = await response.text();
                            throw new Error(`Anthropic API error (${response.status}): ${error}`);
                        }
                        return response;
                    },
                    aoEvento: ({ dados }) => {
                        const e = dados as AnthropicStreamEvent;
                        switch (e.type) {
                            case 'message_start':
                                entrada = e.message?.usage?.input_tokens ?? entrada;
                                break;
                            case 'content_block_start':
                                if (e.content_block?.type === 'tool_use' && typeof e.index === 'number') {
                                    aoVivo.pedaco('tool_call', thinking.length, content.length);
                                    ferramentas.set(e.index, { id: e.content_block.id, name: e.content_block.name ?? '', json: '' });
                                }
                                break;
                            case 'content_block_delta':
                                if (e.delta?.type === 'text_delta' && e.delta.text) {
                                    aoVivo.pedaco('content', thinking.length, content.length);
                                    content += e.delta.text;
                                } else if (e.delta?.type === 'thinking_delta' && e.delta.thinking) {
                                    aoVivo.pedaco('thinking', thinking.length, content.length);
                                    thinking += e.delta.thinking;
                                } else if (e.delta?.type === 'input_json_delta' && typeof e.index === 'number' && e.delta.partial_json) {
                                    aoVivo.pedaco('tool_call', thinking.length, content.length);
                                    const f = ferramentas.get(e.index);
                                    if (f) f.json += e.delta.partial_json;
                                }
                                break;
                            case 'message_delta':
                                motivoDoFim = e.delta?.stop_reason ?? motivoDoFim;
                                saida = e.usage?.output_tokens ?? saida;
                                break;
                            case 'message_stop':
                                terminou = true;
                                break;
                            case 'error':
                                throw new Error(`Anthropic API error: ${e.error?.message ?? e.error?.type ?? 'erro no stream'}`);
                        }
                    },
                });
            } catch (err) {
                // Issue 060: corte com texto já recebido → entregue marcado como interrompido; sem texto → erro (quem chama decide).
                if (!content) { preencher(); throw err; }
                cortada = true;
                log.warn(`[${id}] stream cortado com ${content.length} chars de conteúdo — entregue marcado como interrompido`);
            }
            preencher();

            const toolCalls: ToolCall[] = [...ferramentas.entries()].sort((x, y) => x[0] - y[0]).map(([, f]) => ({
                id: f.id ?? `call_${Date.now()}`,
                name: f.name,
                arguments: (() => { try { return JSON.parse(f.json || '{}') as Record<string, unknown>; } catch { return {}; } })(),
            }));

            return {
                content,
                thinking: thinking || undefined,
                toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
                usage: entrada !== undefined || saida !== undefined ? { prompt_tokens: entrada ?? 0, completion_tokens: saida ?? 0 } : undefined,
                // Issue 060: fim normal = `message_stop` recebido e o motivo não foi o limite de tokens (`max_tokens`).
                interrupted: cortada || !terminou || motivoDoFim === 'max_tokens',
            };
        }, { priority: TaskPriority.INTERACTIVE });
    }
}

/** Um evento do streaming da Messages API (os que este provedor usa; `ping` e os demais são ignorados). */
interface AnthropicStreamEvent {
    type?: string;
    index?: number;
    message?: { usage?: { input_tokens?: number } };
    content_block?: { type?: string; id?: string; name?: string };
    delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string };
    usage?: { output_tokens?: number };
    error?: { type?: string; message?: string };
}

export { convertMessages as _convertMessagesForTest };
