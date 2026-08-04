import { ILLMProvider, LLMMessage, LLMResponse, ToolDefinition, ChatOptions, OpenAIChatResponse, RawToolCall, ModelInfo } from './providerTypes';
import { taskQueue, TaskPriority } from './providerQueue';
import { createLogger } from '../shared/AppLogger';
import { guessCapabilities } from './modelCapabilityHeuristics';

const log = createLogger('OpenAIProvider');

/**
 * Teto para ESTABELECER a conexão — não para a resposta inteira.
 *
 * Motivo original (02/08/2026): um provider morto consumia o timeout completo da requisição
 * antes de o próximo da fila ser tentado — com um servidor local desligado e timeout dinâmico de
 * 5,8 min, cada mensagem levava minutos para chegar a um provider saudável, e o dobro com retry.
 *
 * CORREÇÃO (04/08/2026): a premissa original — "quem não devolve os cabeçalhos em 15s está fora
 * do ar" — vale para API de nuvem com streaming, e é FALSA aqui. Esta requisição é não-streaming
 * (não há `stream: true` no corpo), então um servidor local só devolve cabeçalho quando termina
 * de gerar: o teto virava, na prática, um limite de GERAÇÃO de 15s. Um modelo local saudável era
 * declarado morto assim que o prompt crescia — observado ao vivo com timeout dinâmico de 197s e
 * requisição abortada aos 15,01s, com o servidor gerando normalmente (cobertura: S191).
 *
 * Agora o teto não decide sozinho: ao estourar, pergunta ao servidor via `isResponsive()`. Vivo
 * → segue até o timeout do chamador (gerar texto pode levar minutos, e isso é legítimo). Sem
 * resposta → aborta como antes, preservando o fallback rápido que motivou o teto.
 */
const CONNECT_TIMEOUT_MS = 15_000;

/** Teto do probe de vida (`/models`). Curto de propósito: um servidor saudável responde em
 *  milissegundos; se nem isso ele faz, esperar mais não muda o veredito. */
const LIVENESS_PROBE_TIMEOUT_MS = 3_000;

/**
 * Provider genérico para qualquer endpoint compatível com a API da OpenAI
 * (`/chat/completions`, `/models`) — cobre OpenAI oficial, LM Studio, vLLM e endpoints
 * "custom" apontados pelo usuário. Um único adapter parametrizado por baseUrl/label em vez de
 * uma classe por produto (ver docs/analises-arquiteturais/ANALISE_ARQUITETURAL_MODEL_REGISTRY_2026-07-22.md, Fase 3).
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
     * O servidor está atendendo AGORA? Pergunta objetiva a `/models` — o mesmo endpoint que o
     * discovery usa, aqui só pelo veredito, sem ler o corpo.
     *
     * Existe para separar duas coisas que a requisição de chat não distingue sozinha:
     * "servidor morto/travado" e "modelo local ainda gerando". Sem essa separação, o teto de
     * 15s virava um teto de GERAÇÃO de 15s para qualquer endpoint não-streaming — um modelo
     * local saudável era declarado fora do ar assim que o prompt crescia (observado ao vivo em
     * 04/08/2026: timeout dinâmico de 197s, requisição abortada aos 15,01s, servidor gerando
     * normalmente).
     *
     * Nunca lança: qualquer falha é resposta "não está respondendo".
     */
    async isResponsive(timeoutMs: number = LIVENESS_PROBE_TIMEOUT_MS): Promise<boolean> {
        try {
            const headers: Record<string, string> = {};
            if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
            const resp = await fetch(`${this.baseUrl}/models`, {
                headers,
                signal: AbortSignal.timeout(timeoutMs),
            });
            return resp.ok;
        } catch {
            return false;
        }
    }

    /**
     * Lista os modelos expostos por /models. Funciona para qualquer servidor
     * OpenAI-Compatible (OpenAI oficial, LM Studio, vLLM, custom) — todos implementam
     * esse endpoint com o mesmo formato `{ data: [{ id }, ...] }`.
     */
    async discoverModels(): Promise<ModelInfo[]> {
        const headers: Record<string, string> = {};
        if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
        const resp = await fetch(`${this.baseUrl}/models`, { headers });
        if (!resp.ok) {
            // O status vai anexado ao erro para quem chama poder distinguir estados que não são
            // "fora do ar". O caso concreto é o llamafile: ele ABRE a porta assim que sobe e
            // responde 503 {"message":"Loading model"} durante toda a carga — que pode levar mais
            // de dois minutos. Tratar isso como offline faz o painel dizer que o provedor caiu
            // exatamente enquanto ele está subindo (observado em 02/08/2026). Detectar por texto
            // da mensagem seria frágil; o status é o dado.
            const err = new Error(`${this.label} /models error: ${resp.status}`) as Error & { status?: number };
            err.status = resp.status;
            throw err;
        }
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
            // Aborta se a conexão não se estabelecer a tempo, mas encadeia o signal externo para
            // que um cancelamento do usuário continue valendo depois disso.
            const connectAbort = new AbortController();
            // Ao estourar o teto, NÃO presume morte — pergunta ao servidor. Ver nota do
            // CONNECT_TIMEOUT_MS: esta requisição é não-streaming, então os cabeçalhos de um
            // servidor local só chegam quando a geração termina, e "demorou 15s" é
            // indistinguível de "está gerando" sem perguntar. `/models` responde na hora num
            // servidor saudável (é o mesmo endpoint que o discovery já usa) e falha rápido num
            // morto/travado — que é exatamente a distinção que faltava.
            const connectTimer = setTimeout(async () => {
                const alive = await this.isResponsive(LIVENESS_PROBE_TIMEOUT_MS);
                if (alive) {
                    log.info(`${this.label}: sem resposta em ${CONNECT_TIMEOUT_MS / 1000}s, mas /models respondeu — modelo está gerando, seguindo até o timeout do chamador`);
                    return;
                }
                log.warn(`${this.label}: sem resposta em ${CONNECT_TIMEOUT_MS / 1000}s e /models não respondeu — tratando como fora do ar`);
                connectAbort.abort();
            }, CONNECT_TIMEOUT_MS);
            const onExternalAbort = () => connectAbort.abort();
            options?.signal?.addEventListener('abort', onExternalAbort, { once: true });

            let response: Response;
            try {
                response = await fetch(`${this.baseUrl}/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
                    signal: connectAbort.signal,
                    body: JSON.stringify({
                        model: this.model,
                        messages,
                        tools: tools ? tools.map(t => ({
                            type: 'function',
                            function: { name: t.name, description: t.description, parameters: t.parameters }
                        })) : undefined
                    })
                });
            } catch (err) {
                // Distingue "servidor fora do ar" de "usuário cancelou" — a primeira é um motivo
                // para tentar o próximo provider, a segunda não.
                if (connectAbort.signal.aborted && !options?.signal?.aborted) {
                    throw new Error(`${this.label} não respondeu em ${CONNECT_TIMEOUT_MS / 1000}s (${this.baseUrl})`);
                }
                throw err;
            } finally {
                clearTimeout(connectTimer);  // conectou (ou falhou): daqui em diante vale o timeout normal
                options?.signal?.removeEventListener('abort', onExternalAbort);
            }

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
