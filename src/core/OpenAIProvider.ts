import { ILLMProvider, LLMMessage, LLMResponse, ToolDefinition, ChatOptions, OpenAIChatResponse, RawToolCall, ModelInfo, AttemptTelemetry } from './providerTypes';
import { taskQueue, TaskPriority } from './providerQueue';
import { createLogger } from '../shared/AppLogger';
import { guessCapabilities } from './modelCapabilityHeuristics';
import { assertNotSsrfTarget } from './ssrfGuard';
import { consumirStreamSSE, TelemetriaAoVivo, TRANSPORTE_SEM_PRAZO_PROPRIO } from './streamVigiado';

const log = createLogger('OpenAIProvider');

// Transporte: `TRANSPORTE_SEM_PRAZO_PROPRIO` (streamVigiado.ts). Produção, 18/10/2026: as 9 chamadas longas ao modelo local
// falharam entre 302,8 e 304,6 s com `fetch failed` — o `headersTimeout` de 300 s do Node, não o modelo. Com streaming
// (14/11/2026), quem detecta travamento é o vigia de silêncio; o transporte não tem prazo nenhum, sempre.

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
 *
 * 14/11/2026 (ADR-027 em todos os provedores): a requisição passou a ser com streaming. A pergunta ao
 * servidor continua: há servidores que só mandam o cabeçalho com o primeiro pedaço, depois de ler o
 * prompt. Vivo → quem decide travamento é o vigia de silêncio (streamVigiado.ts), não um prazo.
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

    constructor(apiKey: string, model: string, baseUrl: string, label?: string, opts?: { thinking?: 'on' | 'off' }) {   // sem modelo nem endereço padrão: vêm do cadastro do provedor
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

    /**
     * ADR-027: com streaming, este provedor só para por TRAVAMENTO (nenhum primeiro pedaço; silêncio entre pedaços —
     * streamVigiado.ts). O `ProviderFactory` não arma prazo de duração para ele. Vale para os derivados (OpenRouter, Groq,
     * DeepSeek) e para todo servidor compatível cadastrado (modelo local, LM Studio, vLLM, OpenAI oficial).
     */
    readonly vigiaSilencio = true;

    /**
     * Abre a requisição. O teto de 15 s para os CABEÇALHOS não decide sozinho (ver CONNECT_TIMEOUT_MS): ao estourar, pergunta
     * ao servidor (`/models`). Vivo → segue, e quem decide travamento é o vigia de silêncio; sem resposta → aborta como antes,
     * preservando a passagem rápida para o próximo provedor. Alguns servidores com streaming só mandam o cabeçalho junto do
     * primeiro pedaço, depois de ler o prompt inteiro.
     */
    private async abrir(corpo: string, signal: AbortSignal): Promise<Response> {
        const connectAbort = new AbortController();
        const connectTimer = setTimeout(async () => {
            const alive = await this.isResponsive(LIVENESS_PROBE_TIMEOUT_MS);
            if (alive) {
                log.info(`${this.label}: sem cabeçalhos em ${CONNECT_TIMEOUT_MS / 1000}s, mas /models respondeu — o servidor está trabalhando; segue (o vigia de silêncio decide travamento)`);
                return;
            }
            log.warn(`${this.label}: sem resposta em ${CONNECT_TIMEOUT_MS / 1000}s e /models não respondeu — tratando como fora do ar`);
            connectAbort.abort();
        }, CONNECT_TIMEOUT_MS);
        const onAbort = () => connectAbort.abort();
        if (signal.aborted) connectAbort.abort();
        signal.addEventListener('abort', onAbort, { once: true });

        let response: Response;
        try {
            response = await fetch(`${this.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
                signal: connectAbort.signal,
                dispatcher: TRANSPORTE_SEM_PRAZO_PROPRIO,
                body: corpo,
            } as RequestInit);
        } catch (err) {
            // Distingue "servidor fora do ar" de corte pelo vigia ou "Parar" — a primeira é motivo para tentar o próximo
            // provider com a frase de fato; as outras seguem como o erro original.
            if (connectAbort.signal.aborted && !signal.aborted) {
                throw new Error(`${this.label} não respondeu em ${CONNECT_TIMEOUT_MS / 1000}s (${this.baseUrl})`);
            }
            throw err;
        } finally {
            // Só o teto dos cabeçalhos sai daqui. O elo `signal` → `connectAbort` fica: é ele que leva o corte do vigia (e o
            // "Parar") à LEITURA do corpo; desligado aqui, o vigia abortava e o stream seguia aberto para sempre.
            clearTimeout(connectTimer);
        }

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`${this.name} API error (${response.status}): ${error}`);
        }
        return response;
    }

    async chat(messages: LLMMessage[], tools?: ToolDefinition[], options?: ChatOptions): Promise<LLMResponse> {
        assertNotSsrfTarget(this.baseUrl);
        const queueEntryTime = Date.now();
        return await taskQueue.add(async () => {
            const queueWaitMs = Date.now() - queueEntryTime;
            if (queueWaitMs > 500) log.info(`Queue wait: ${queueWaitMs}ms`);
            const id = `oa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
            const corpo = JSON.stringify({
                model: this.model,
                // Imagem viaja dentro de `content` (ver toOpenAIContent) — um campo
                // `images` solto seria ignorado pelo servidor, e a visão responderia
                // sobre uma imagem que nunca chegou.
                messages: normalizeSystemMessages(messages).map(toOpenAIMessage),
                tools: tools ? tools.map(t => ({
                    type: 'function',
                    function: { name: t.name, description: t.description, parameters: t.parameters }
                })) : undefined,
                // ADR-027 (14/11/2026): streaming — é o sinal de progresso que separa "gerando" de "travado". `include_usage`
                // (parâmetro oficial da API) pede os números do servidor no último pedaço (ADR-024: é deles que sai a velocidade).
                stream: true,
                stream_options: { include_usage: true },
                // Issue 054 (D3): só quando o operador declarou `thinking` no provedor. Nunca por
                // padrão — a API oficial da OpenAI pode recusar parâmetro desconhecido.
                // ADR-014 (campanha 09/10/2026): declarado o controle, a chamada que pede raciocínio
                // 'desligado' (descritor de validação) prevalece — mesmo efeito do `think: false` do Ollama.
                ...(options?.saidaJson ? { response_format: { type: 'json_object' } } : {}),
                // ADR-024: limite de tokens de saída declarado por quem chama — o modelo para sozinho, sem relógio.
                ...(options?.limiteDeSaidaTokens && options.limiteDeSaidaTokens > 0 ? { max_tokens: Math.round(options.limiteDeSaidaTokens) } : {}),
                ...(this.thinking ? { chat_template_kwargs: { enable_thinking: options?.raciocinio === 'desligado' ? false : this.thinking === 'on' } } : {}),
            });

            const tele = options?.telemetry;
            const aoVivo = new TelemetriaAoVivo(tele);
            let content = '';
            let thinking = '';
            const ferramentas: Array<{ id?: string; name: string; args: string }> = [];
            let fim: string | undefined;
            let usage: OpenAIChatResponse['usage'] | undefined;
            let timings: Timings | undefined;
            let inteira: OpenAIChatResponse | undefined;
            let cortada = false;

            try {
                await consumirStreamSSE({
                    id, log, modelo: this.model, messages, signal: options?.signal,
                    abrir: (signal) => this.abrir(corpo, signal),
                    // Servidor que ignorou `stream: true` e respondeu o JSON inteiro: lido como antes (sem sinal de progresso).
                    semStreaming: async (resposta) => { inteira = await resposta.json() as OpenAIChatResponse; },
                    aoEvento: ({ dados }) => {
                        const d = dados as OpenAIStreamChunk;
                        if (d.error) throw new Error(`${this.name} API error (stream): ${JSON.stringify(d.error).slice(0, 300)}`);
                        if (d.usage) usage = d.usage;
                        if (d.timings) timings = d.timings;
                        const escolha = d.choices?.[0];
                        if (!escolha) return;
                        const delta = escolha.delta ?? {};
                        if (typeof delta.content === 'string' && delta.content) {
                            aoVivo.pedaco('content', thinking.length, content.length);
                            content += delta.content;
                        }
                        // Raciocínio: `reasoning_content` (DeepSeek, llama-server), `reasoning` (OpenRouter), `thinking`.
                        const raciocinio = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
                        if (typeof raciocinio === 'string' && raciocinio) {
                            aoVivo.pedaco('thinking', thinking.length, content.length);
                            thinking += raciocinio;
                        }
                        for (const tc of delta.tool_calls ?? []) {
                            aoVivo.pedaco('tool_call', thinking.length, content.length);
                            // A chamada chega em pedaços: o 1º traz id e nome; os seguintes, só pedaços dos argumentos (mesmo `index`).
                            let i = typeof tc.index === 'number' ? tc.index : (tc.id ? ferramentas.findIndex(f => f.id === tc.id) : ferramentas.length - 1);
                            if (i < 0) i = ferramentas.length;
                            const f = (ferramentas[i] ??= { name: '', args: '' });
                            if (tc.id) f.id = tc.id;
                            if (tc.function?.name) f.name += tc.function.name;
                            if (tc.function?.arguments) f.args += tc.function.arguments;
                        }
                        if (escolha.finish_reason) fim = escolha.finish_reason;
                    },
                });
            } catch (err) {
                // Issue 060: corte (vigia, erro de rede) com conteúdo já recebido → entregue marcado como interrompido; sem
                // conteúdo → erro, e quem chama decide (retentar). Raciocínio cortado nunca vira resposta (S72).
                if (!content) { this.preencherTelemetria(tele, aoVivo.pedacos, content, thinking, fim, usage, timings); throw err; }
                cortada = true;
                log.warn(`[${id}] stream cortado com ${content.length} chars de conteúdo — entregue marcado como interrompido`);
            }

            if (inteira) return this.respostaInteira(inteira, tele);

            this.preencherTelemetria(tele, aoVivo.pedacos, content, thinking, fim, usage, timings);
            return {
                content,
                toolCalls: ferramentas.length > 0 ? ferramentas.map((f, i) => ({
                    id: f.id ?? `call_${Date.now()}_${i}`,
                    name: f.name,
                    arguments: (() => { try { return JSON.parse(f.args || '{}'); } catch { return {}; } })(),
                })) : undefined,
                usage: usage ? { prompt_tokens: usage.prompt_tokens ?? 0, completion_tokens: usage.completion_tokens ?? 0 } : undefined,
                // Issue 060: fim normal = `finish_reason` recebido e diferente de `length` (limite de tokens).
                interrupted: cortada || !fim || fim === 'length',
            };
        }, { priority: TaskPriority.INTERACTIVE });
    }

    /**
     * ADR-024 (etapa 1): os números que o SERVIDOR mediu vão para a telemetria da tentativa — é deles que sai a velocidade do
     * modelo. Antes eram descartados: na produção (18–21/10/2026), em mais de 100 chamadas ao modelo local, a velocidade nunca
     * foi medida (`geracao=?`). `usage` é do contrato OpenAI; `timings` é do llama-server (llama.cpp) — ausente, os tempos
     * ficam sem medir.
     */
    private preencherTelemetria(tele: AttemptTelemetry | undefined, pedacos: number, content: string, thinking: string, fim: string | undefined, usage: OpenAIChatResponse['usage'] | undefined, timings: Timings | undefined): void {
        if (!tele) return;
        // Com cache de prompt, `prompt_ms` cobre só os `prompt_n` tokens lidos agora (não o prompt inteiro): dividir o
        // total por ele superestimaria a leitura e encurtaria o prazo. Medido no Strata: cache_n/prompt_n em `timings`.
        if (typeof timings?.prompt_n === 'number' && typeof timings?.prompt_ms === 'number') tele.promptTokens = timings.prompt_n;
        else if (typeof usage?.prompt_tokens === 'number') tele.promptTokens = usage.prompt_tokens;
        if (typeof usage?.completion_tokens === 'number') tele.evalTokens = usage.completion_tokens;
        if (typeof timings?.prompt_ms === 'number') tele.promptEvalMs = timings.prompt_ms;
        if (typeof timings?.predicted_ms === 'number') tele.evalMs = timings.predicted_ms;
        tele.chunks = pedacos;
        tele.contentChars = content.length;
        tele.thinkingChars = thinking.length;
        tele.contentText = content;
        tele.thinkingText = thinking;
        if (typeof fim === 'string') tele.doneReason = fim;
    }

    /** Resposta inteira (servidor que não fez streaming): o formato `choices[0].message` de antes. */
    private respostaInteira(data: OpenAIChatResponse, tele: AttemptTelemetry | undefined): LLMResponse {
        const message = data.choices?.[0]?.message;
        const raciocinio = (message as { reasoning_content?: unknown } | undefined)?.reasoning_content;
        const timings = (data as { timings?: Timings }).timings;
        const fim = data.choices?.[0]?.finish_reason;
        this.preencherTelemetria(tele, 0, message?.content ?? '', typeof raciocinio === 'string' ? raciocinio : '', typeof fim === 'string' ? fim : undefined, data.usage, timings);
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
            // Issue 060: a resposta chega inteira; só o corte por limite de tokens (finish_reason=length) a interrompe.
            interrupted: fim === 'length',
        };
    }
}

/** `timings` do llama-server (llama.cpp): tempos que o servidor mediu. */
interface Timings { prompt_n?: number; prompt_ms?: number; predicted_ms?: number }

/** Um pedaço do streaming OpenAI-compatível (`chat.completion.chunk`). */
interface OpenAIStreamChunk {
    choices?: Array<{
        delta?: { content?: string | null; reasoning_content?: string; reasoning?: string; thinking?: string; tool_calls?: RawToolCall[] };
        finish_reason?: string | null;
    }>;
    usage?: OpenAIChatResponse['usage'];
    timings?: Timings;
    error?: unknown;
}

export class OpenRouterProvider extends OpenAIProvider {
    constructor(apiKey: string, model: string = '') {   // modelo escolhido pelo usuário (OPENROUTER_MODEL); vazio = não escolhido
        super(apiKey, model, 'https://openrouter.ai/api/v1', 'openrouter');
        this.name = 'openrouter';
    }

    async chat(messages: LLMMessage[], tools?: ToolDefinition[], options?: ChatOptions): Promise<LLMResponse> {
        return super.chat(messages, tools, options);
    }
}
