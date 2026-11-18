import { ILLMProvider, LLMMessage, LLMResponse, ToolDefinition, ChatOptions, GeminiChatResponse, ModelInfo } from './providerTypes';
import { taskQueue, TaskPriority } from './providerQueue';
import { createLogger } from '../shared/AppLogger';
import { guessCapabilities } from './modelCapabilityHeuristics';
import { consumirStreamSSE, TelemetriaAoVivo, TRANSPORTE_SEM_PRAZO_PROPRIO } from './streamVigiado';

const log = createLogger('GeminiProvider');

type ParteGemini = { text: string } | { functionCall: { name: string; args: unknown } } | { functionResponse: { name: string; response: { content: string } } };

/**
 * ADR-040 — o formato interno (papéis system/user/assistant/tool, estilo OpenAI) no formato do Gemini. A API só aceita os
 * papéis `user` e `model` em `contents`: antes `system` e `tool` iam como estavam (rejeitados), e a chamada de ferramenta do
 * assistente ia só como texto (a ferramenta pedida sumia do histórico). Agora:
 *   - system    → `systemInstruction` (partes de texto, na ordem);
 *   - assistant → `model`, com o texto e uma parte `functionCall` por ferramenta chamada;
 *   - tool      → `user` com `functionResponse` (nome da ferramenta tirado da chamada de mesmo id); resultados seguidos
 *                 do mesmo turno vão juntos numa mensagem só.
 */
export function converterParaGemini(messages: LLMMessage[]): { systemInstruction?: { parts: Array<{ text: string }> }; contents: Array<{ role: 'user' | 'model'; parts: ParteGemini[] }> } {
    const sistema: Array<{ text: string }> = [];
    const contents: Array<{ role: 'user' | 'model'; parts: ParteGemini[] }> = [];
    const nomePorId = new Map<string, string>();
    for (const m of messages) {
        if (m.role === 'system') { if (m.content) sistema.push({ text: m.content }); continue; }
        if (m.role === 'assistant') {
            const parts: ParteGemini[] = [];
            if (m.content && m.content.trim()) parts.push({ text: m.content });
            for (const tc of m.toolCalls ?? []) {
                nomePorId.set(tc.id, tc.name);
                parts.push({ functionCall: { name: tc.name, args: tc.arguments } });
            }
            if (parts.length) contents.push({ role: 'model', parts });
            continue;
        }
        if (m.role === 'tool') {
            const nome = nomePorId.get(m.tool_call_id || '');
            // Sem a chamada correspondente no histórico, o Gemini não aceita `functionResponse` (exige o nome): vai como texto,
            // declarado como resultado de ferramenta — nunca com um nome inventado.
            if (!nome) { contents.push({ role: 'user', parts: [{ text: `[resultado de ferramenta]\n${m.content}` }] }); continue; }
            const parte: ParteGemini = { functionResponse: { name: nome, response: { content: m.content } } };
            const ultima = contents[contents.length - 1];
            if (ultima?.role === 'user' && ultima.parts.every(p => 'functionResponse' in p)) ultima.parts.push(parte);
            else contents.push({ role: 'user', parts: [parte] });
            continue;
        }
        contents.push({ role: 'user', parts: [{ text: m.content }] });
    }
    return { ...(sistema.length ? { systemInstruction: { parts: sistema } } : {}), contents };
}

export class GeminiProvider implements ILLMProvider {
    name = 'gemini';
    private apiKey: string;
    private model: string;

    constructor(apiKey: string, model: string = '') {   // modelo escolhido pelo usuário (GEMINI_MODEL); vazio = não escolhido — nunca um padrão
        this.apiKey = apiKey;
        this.model = model;
    }

    setModel(model: string): void { this.model = model; }

    /** `GET /v1beta/models` — endpoint real do Gemini (confirmado contra a documentação oficial):
     *  auth pelo cabeçalho `x-goog-api-key` (ADR-040; antes ia na URL, `?key=`); cada item vem como `name: "models/xxx"`, não
     *  `id` puro — o prefixo é removido aqui porque é assim que `this.model` já é usado na URL de
     *  `generateContent` (sem o prefixo). Só lista/valida a chave — não muda `chat()`. */
    async discoverModels(): Promise<ModelInfo[]> {
        // ADR-040: a chave vai no cabeçalho `x-goog-api-key`, nunca na URL (URL vai para log, histórico e mensagem de erro).
        const resp = await fetch(
            'https://generativelanguage.googleapis.com/v1beta/models',
            { headers: { 'x-goog-api-key': this.apiKey } },
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

    /**
     * ADR-027: streaming (`:streamGenerateContent?alt=sse`), e a chamada só para por TRAVAMENTO — nenhum primeiro pedaço ou
     * silêncio entre pedaços (streamVigiado.ts). Pedaço sem texto nem chamada de ferramenta não conta (antes da correção de
     * 14/11/2026, `candidates[0]` vazio contava como atividade).
     */
    readonly vigiaSilencio = true;

    async chat(messages: LLMMessage[], tools?: ToolDefinition[], options?: ChatOptions): Promise<LLMResponse> {
        const queueEntryTime = Date.now();
        return await taskQueue.add(async () => {
            const queueWaitMs = Date.now() - queueEntryTime;
            if (queueWaitMs > 500) log.info(`Queue wait: ${queueWaitMs}ms`);
            const { systemInstruction, contents } = converterParaGemini(messages);
            const corpo = JSON.stringify({
                ...(systemInstruction ? { systemInstruction } : {}),
                contents,
                tools: tools ? [{ functionDeclarations: tools.map(t => ({
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters
                }))}] : undefined
            });

            const id = `ge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
            const tele = options?.telemetry;
            const aoVivo = new TelemetriaAoVivo(tele);
            let content = '';
            let thinking = '';
            const chamadas: Array<{ name?: string; args?: unknown }> = [];
            let motivoDoFim: string | undefined;
            let uso: GeminiChatResponse['usageMetadata'];
            let cortada = false;
            const preencher = (): void => {
                if (!tele) return;
                Object.assign(tele, {
                    chunks: aoVivo.pedacos, contentChars: content.length, thinkingChars: thinking.length, contentText: content, thinkingText: thinking,
                    // `doneReason` no vocabulário comum da telemetria: o limite de tokens é `length` (como no Ollama e na OpenAI).
                    toolCalls: chamadas.length, doneReason: motivoDoFim === 'MAX_TOKENS' ? 'length' : motivoDoFim, promptTokens: uso?.promptTokenCount, evalTokens: uso?.candidatesTokenCount,
                });
            };

            try {
                await consumirStreamSSE({
                    id, log, modelo: this.model, messages, signal: options?.signal,
                    abrir: async (signal) => {
                        const response = await fetch(
                            `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:streamGenerateContent?alt=sse`,
                            { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey }, signal, dispatcher: TRANSPORTE_SEM_PRAZO_PROPRIO, body: corpo } as RequestInit,
                        );
                        if (!response.ok) throw new Error(`Gemini API error: ${response.status}`);
                        return response;
                    },
                    aoEvento: ({ dados }) => {
                        const d = dados as GeminiStreamChunk;
                        if (d.error) throw new Error(`Gemini API error: ${d.error.message ?? d.error.status ?? 'erro no stream'}`);
                        if (d.usageMetadata) uso = d.usageMetadata;   // o último traz o total
                        const candidato = d.candidates?.[0];
                        if (!candidato) return;
                        for (const parte of candidato.content?.parts ?? []) {
                            if (parte.functionCall) {
                                aoVivo.pedaco('tool_call', thinking.length, content.length);
                                chamadas.push(parte.functionCall);   // o Gemini manda a chamada inteira num pedaço só
                            } else if (typeof parte.text === 'string' && parte.text) {
                                // `thought: true` marca o resumo do raciocínio — nunca é resposta.
                                if (parte.thought === true) { aoVivo.pedaco('thinking', thinking.length, content.length); thinking += parte.text; }
                                else { aoVivo.pedaco('content', thinking.length, content.length); content += parte.text; }
                            }
                        }
                        if (candidato.finishReason) motivoDoFim = candidato.finishReason;
                    },
                });
            } catch (err) {
                // Issue 060: corte com texto já recebido → entregue marcado como interrompido; sem texto → erro (quem chama decide).
                if (!content) { preencher(); throw err; }
                cortada = true;
                log.warn(`[${id}] stream cortado com ${content.length} chars de conteúdo — entregue marcado como interrompido`);
            }
            preencher();

            return {
                content,
                thinking: thinking || undefined,
                toolCalls: chamadas.length > 0 ? chamadas.map((fc, i) => ({
                    id: `call_${Date.now()}_${i}`,
                    name: fc.name ?? '',
                    arguments: (fc.args ?? {}) as Record<string, unknown>
                })) : undefined,
                usage: uso ? {
                    prompt_tokens: uso.promptTokenCount ?? 0,
                    completion_tokens: uso.candidatesTokenCount ?? 0
                } : undefined,
                // Issue 060: fim normal = `finishReason` STOP. Sem ele (stream cortado) ou com outro (MAX_TOKENS, SAFETY…), a
                // resposta pode ser fragmento.
                interrupted: cortada || motivoDoFim !== 'STOP',
            };
        }, { priority: TaskPriority.INTERACTIVE });
    }
}

/** Um pedaço do `streamGenerateContent` (SSE): um `GenerateContentResponse` parcial. */
interface GeminiStreamChunk {
    candidates?: Array<{
        content?: { parts?: Array<{ text?: string; thought?: boolean; functionCall?: { name?: string; args?: unknown } }> };
        finishReason?: string;
    }>;
    usageMetadata?: GeminiChatResponse['usageMetadata'];
    error?: { message?: string; status?: string };
}
