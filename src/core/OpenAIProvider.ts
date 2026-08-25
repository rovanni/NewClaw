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
 * Hosts sem nenhum uso legítimo como servidor OpenAI-Compatible — só existem para expor metadado
 * de instância de nuvem (credenciais temporárias da AWS/GCP/Azure). `baseUrl` é 100% controlado
 * por quem cadastra um provider custom (`/api/providers/add`, `/api/providers/test`), e o recurso
 * em si EXIGE aceitar host arbitrário: é assim que um servidor local (llamafile, LM Studio, vLLM)
 * ou de outra máquina na rede do usuário é configurado. Por isso a defesa aqui não é allowlist de
 * host (quebraria o recurso) — é este bloqueio pontual, o único caso em que "endpoint arbitrário"
 * nunca é uma configuração legítima (CWE-918 / CodeQL js/request-forgery).
 *
 * Checagem por string do hostname, não por resolução de DNS: cobre o caso real (alguém cola o
 * endereço de metadado direto no campo, o mesmo padrão dos exploits SSRF→metadado documentados) —
 * não cobre DNS rebinding (um hostname próprio que resolve para 169.254.169.254 só depois desta
 * checagem). Aceito conscientemente: mitigar rebinding exigiria resolver e fixar o IP antes de
 * cada fetch, mudança maior e fora do escopo desta correção pontual.
 */
const SSRF_BLOCKED_HOSTS = new Set([
    '169.254.169.254',       // AWS/GCP/Azure/OpenStack — endpoint de metadado padrão
    'metadata.google.internal', // GCP — alias DNS do mesmo endpoint
    'fd00:ec2::254',          // AWS — endpoint de metadado IMDSv2 em IPv6
]);

/** CWE-918 — ver `SSRF_BLOCKED_HOSTS`. Lança se `baseUrl` aponta para um host de metadado de
 *  nuvem; chamado no início de todo método que faz `fetch(this.baseUrl + ...)`. */
function assertNotSsrfTarget(baseUrl: string): void {
    let hostname: string;
    try {
        hostname = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    } catch {
        return; // URL inválida — quem chama já trata o fetch subsequente falhando
    }
    if (SSRF_BLOCKED_HOSTS.has(hostname)) {
        throw new Error(`Endpoint bloqueado: "${hostname}" é um endereço de metadado de nuvem, nunca um servidor de modelo legítimo.`);
    }
}

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
                        messages: messages.map(m => ({ ...m, images: undefined, content: toOpenAIContent(m) })),
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
