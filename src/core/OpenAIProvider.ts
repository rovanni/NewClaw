import { ILLMProvider, LLMMessage, LLMResponse, ToolDefinition, ChatOptions, OpenAIChatResponse, RawToolCall, ModelInfo } from './providerTypes';
import { taskQueue, TaskPriority } from './providerQueue';
import { createLogger } from '../shared/AppLogger';
import { guessCapabilities } from './modelCapabilityHeuristics';
import { assertNotSsrfTarget } from './ssrfGuard';

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
 * Lista os modelos expostos por `{baseUrl}/models` — extraída de `OpenAIProvider.discoverModels()`
 * pra ser reaproveitada por qualquer provider que fale o mesmo formato `{ data: [{ id }, ...] }`
 * (confirmado contra a documentação oficial de cada um: DeepSeek e Groq devolvem exatamente esse
 * envelope). `OpenAIProvider.discoverModels()` chama esta função com seus próprios campos; não é
 * um comportamento novo, só reorganização — evita duplicar a mesma lógica de fetch/parse em
 * `DeepSeekProvider`/`GroqProvider` em vez de copiar o método inteiro (o "adapter explosion" que
 * `ANALISE_ARQUITETURAL_MODEL_REGISTRY_2026-07-22.md`, Fase 2, já identificou como risco).
 */
export async function discoverOpenAICompatibleModels(baseUrl: string, apiKey: string | undefined, label: string): Promise<ModelInfo[]> {
    assertNotSsrfTarget(baseUrl);
    const headers: Record<string, string> = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const resp = await fetch(`${baseUrl}/models`, { headers });
    if (!resp.ok) {
        // O status vai anexado ao erro para quem chama poder distinguir estados que não são
        // "fora do ar". O caso concreto é o llamafile: ele ABRE a porta assim que sobe e
        // responde 503 {"message":"Loading model"} durante toda a carga — que pode levar mais
        // de dois minutos. Tratar isso como offline faz o painel dizer que o provedor caiu
        // exatamente enquanto ele está subindo (observado em 02/08/2026). Detectar por texto
        // da mensagem seria frágil; o status é o dado.
        const err = new Error(`${label} /models error: ${resp.status}`) as Error & { status?: number };
        err.status = resp.status;
        throw err;
    }
    const data = await resp.json() as { data?: Array<{ id: string }> };
    return (data.data || []).map(m => ({
        id: m.id,
        provider: label,
        label: m.id,
        capabilities: guessCapabilities(m.id),
        status: 'available' as const,
    }));
}

/**
 * Converte mensagens que carregam imagem para o formato multimodal da API da OpenAI.
 *
 * `LLMMessage.images` é o formato interno do projeto (base64 puro), desenhado sobre o campo
 * `images` do Ollama. A API da OpenAI — e todo servidor compatível com ela (llamafile, LM Studio,
 * vLLM, OpenAI oficial) — espera as imagens DENTRO de `content`, como partes tipadas. Um campo
 * `images` solto no corpo é simplesmente ignorado.
 *
 * Sem esta conversão, visão/OCR ficava silenciosamente quebrado em todos esses providers: o
 * modelo recebia só o texto "Descreva esta imagem..." sem imagem nenhuma e respondia o que
 * conseguisse inventar — que o NewClaw então entregava ao usuário rotulado como "extraído via
 * vision". Observado ao vivo em 04/08/2026 com uma imagem de nota fiscal: valores, número e datas
 * completamente fabricados (cobertura: S192).
 *
 * O tipo MIME sai da assinatura dos próprios bytes, não do nome do arquivo (que o provider nem
 * recebe) — mesma decisão de "ler o dado, não adivinhar pelo rótulo" usada no resto do projeto.
 */
function toOpenAIContent(m: LLMMessage): unknown {
    if (!m.images?.length) return m.content;
    return [
        ...(m.content ? [{ type: 'text', text: m.content }] : []),
        ...m.images.map(b64 => ({
            type: 'image_url',
            image_url: { url: `data:${sniffImageMime(b64)};base64,${b64}` },
        })),
    ];
}

/**
 * Issue 054 — mensagens `system` fora do início da conversa.
 *
 * O AgentLoop insere avisos `system` no meio do turno (falha de ferramenta, trava de segurança,
 * dicas — 33 pontos). A nuvem do Ollama aceita; templates de chat estritos de servidores
 * OpenAI-compatíveis rejeitam. Observado em 05/10/2026 com um modelo local (Bonsai 27B, família Qwen,
 * `llama-server`): HTTP 500 "Jinja Exception: System message must be at the beginning" — com isso,
 * nenhum turno com ferramenta funcionava offline. O mesmo template rejeita DUAS mensagens `system`
 * seguidas no início (a segunda não é `loop.first`).
 *
 * Tradução de formato, não de conteúdo (ARCHITECTURE.md, princípio 7): as `system` iniciais viram uma
 * só; uma `system` depois que a conversa começou vai como `user` marcada como instrução do sistema, NA
 * MESMA POSIÇÃO — a ordem dos fatos do turno não muda. O Ollama (OllamaProvider) não passa por aqui.
 */
export function normalizeSystemMessages(messages: LLMMessage[]): LLMMessage[] {
    let i = 0;
    const leading: string[] = [];
    while (i < messages.length && messages[i].role === 'system') {
        if (messages[i].content) leading.push(messages[i].content);
        i++;
    }
    const out: LLMMessage[] = leading.length > 0 ? [{ role: 'system', content: leading.join('\n\n') }] : [];
    for (; i < messages.length; i++) {
        const m = messages[i];
        out.push(m.role === 'system' ? { ...m, role: 'user', content: `[Instrução do sistema] ${m.content}` } : m);
    }
    return out;
}

/**
 * Tradução de uma mensagem do formato interno para o corpo da API OpenAI-compatível.
 *
 * O formato interno guarda as chamadas de ferramenta de uma volta do assistente em `toolCalls`; a API só
 * entende `tool_calls` (`{ id, type: 'function', function: { name, arguments: <JSON em texto> } }`). Com o
 * `toolCalls` seguindo adiante cru, o servidor o ignora: a volta do assistente chega sem nenhuma chamada,
 * só com o texto que o modelo escreveu junto, e a mensagem `tool` seguinte fica órfã (sem a chamada a que
 * responde). Achado real (09/10/2026, passo 3 de "salve essas informações na memória"): no passo 2 o modelo
 * devolveu a chamada de `memory_admin` MAIS o texto "[Tool call: memory_admin]"; o histórico reenviado só
 * trazia esse texto como volta do assistente, e no passo 3 o modelo o repetiu sem chamar nada — o loop
 * entregou "[Tool call: memory_admin]" ao usuário e nada foi salvo.
 *
 * Tradução de formato, não de conteúdo (ARCHITECTURE.md, princípio 7). O Ollama não passa por aqui.
 */
export function toOpenAIMessage(m: LLMMessage): Record<string, unknown> {
    const { toolCalls, images: _images, ...resto } = m;
    const corpo: Record<string, unknown> = { ...resto, content: toOpenAIContent(m) };
    if (m.role === 'assistant' && toolCalls && toolCalls.length > 0) {
        corpo.tool_calls = toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
        }));
    }
    return corpo;
}

/** Assinatura dos primeiros bytes em base64. Sem dependência externa e sem chute por extensão. */
function sniffImageMime(b64: string): string {
    if (b64.startsWith('/9j/')) return 'image/jpeg';
    if (b64.startsWith('iVBORw0KGgo')) return 'image/png';
    if (b64.startsWith('R0lGOD')) return 'image/gif';
    if (b64.startsWith('UklGR')) return 'image/webp';
    return 'image/png';   // padrão do formato mais comum em captura de tela
}

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
    /** Issue 054 (D3): só provedores customizados recebem isto (ver CustomProviderConfig.thinking). */
    private readonly thinking?: 'on' | 'off';

    constructor(apiKey: string, model: string = 'gpt-4o', baseUrl: string = 'https://api.openai.com/v1', label?: string, opts?: { thinking?: 'on' | 'off' }) {
        this.apiKey = apiKey;
        this.model = model;
        this.baseUrl = baseUrl;
        this.label = label || this.name;
        this.thinking = opts?.thinking;
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
            assertNotSsrfTarget(this.baseUrl);
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
        return discoverOpenAICompatibleModels(this.baseUrl, this.apiKey, this.label);
    }

    async chat(messages: LLMMessage[], tools?: ToolDefinition[], options?: ChatOptions): Promise<LLMResponse> {
        assertNotSsrfTarget(this.baseUrl);
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
                        // Imagem viaja dentro de `content` (ver toOpenAIContent) — um campo
                        // `images` solto seria ignorado pelo servidor, e a visão responderia
                        // sobre uma imagem que nunca chegou.
                        messages: normalizeSystemMessages(messages).map(toOpenAIMessage),
                        tools: tools ? tools.map(t => ({
                            type: 'function',
                            function: { name: t.name, description: t.description, parameters: t.parameters }
                        })) : undefined,
                        // Issue 054 (D3): só quando o operador declarou `thinking` no provedor. Nunca por
                        // padrão — a API oficial da OpenAI pode recusar parâmetro desconhecido.
                        // ADR-014 (campanha 09/10/2026): declarado o controle, a chamada que pede raciocínio
                        // 'desligado' (descritor de validação) prevalece — mesmo efeito do `think: false` do Ollama.
                        ...(options?.saidaJson ? { response_format: { type: 'json_object' } } : {}),
                        ...(this.thinking ? { chat_template_kwargs: { enable_thinking: options?.raciocinio === 'desligado' ? false : this.thinking === 'on' } } : {}),
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
                } : undefined,
                // Issue 060: requisição não-streaming — a resposta chega inteira; só o corte por limite de
                // tokens (finish_reason=length) a interrompe.
                interrupted: data.choices?.[0]?.finish_reason === 'length',
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
