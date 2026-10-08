/** OpenAI/Ollama-compatible tool call shape */
export interface RawToolCall {
    id?: string; index?: number; type?: string;
    function?: { name?: string; arguments?: string };
    [key: string]: unknown;
}

/** Gemini API response shape */
export interface GeminiChatResponse {
    candidates?: Array<{
        content?: { parts?: Array<{ text?: string; functionCall?: { name?: string; args?: unknown }; [key: string]: unknown }> };
        [key: string]: unknown;
    }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    [key: string]: unknown;
}

/** Anthropic Messages API content block (text, tool_use, thinking) */
export interface AnthropicContentBlock {
    type?: string;
    text?: string;
    thinking?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    tool_use_id?: string;
    content?: string;
    [key: string]: unknown;
}

/** Anthropic /v1/messages response shape */
export interface AnthropicChatResponse {
    content?: AnthropicContentBlock[];
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { type?: string; message?: string };
    [key: string]: unknown;
}

/** OpenAI-compatible chat completion response */
export interface OpenAIChatResponse {
    choices?: Array<{
        message?: { content?: string | null; tool_calls?: RawToolCall[]; [key: string]: unknown };
        delta?: { content?: string | null; tool_calls?: RawToolCall[]; [key: string]: unknown };
        finish_reason?: string; [key: string]: unknown;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    message?: { content?: string | null; tool_calls?: RawToolCall[]; [key: string]: unknown };
    [key: string]: unknown;
}

/** Raw streaming chunk from any LLM API (Ollama/OpenAI/Anthropic/Gemini) */
export interface RawApiChunk {
    type?: string; done?: boolean;
    message?: { content?: string; thinking?: string; reasoning?: string; tool_calls?: RawToolCall[]; [key: string]: unknown };
    choices?: Array<{
        delta?: { content?: string | null; reasoning_content?: string; thinking?: string; tool_calls?: RawToolCall[]; [key: string]: unknown };
        finish_reason?: string; [key: string]: unknown;
    }>;
    delta?: { type?: string; text?: string; thinking?: string; [key: string]: unknown };
    candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: string; [key: string]: unknown }> }; [key: string]: unknown }>;
    prompt_eval_count?: number; eval_count?: number;
    [key: string]: unknown;
}

export type StreamChunk =
    | { type: 'content'; value: string }
    | { type: 'thinking'; value: string }
    | { type: 'tool_call'; value: RawToolCall }
    | { type: 'done'; value: { prompt_tokens: number; completion_tokens: number; done_reason?: string } };

export interface LLMMessage {
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    images?: string[];
    toolCalls?: ToolCall[];
    tool_call_id?: string;
}

export interface LLMResponse {
    content: string;
    thinking?: string;
    toolCalls?: ToolCall[];
    usage?: { prompt_tokens: number; completion_tokens: number };
    /**
     * Issue 060 — a geração terminou normalmente? `true`: interrompida (stream abortado ou encerrado sem
     * o sinal de fim, ou cortada por limite de tokens) — o conteúdo pode ser fragmento. `false`: o
     * provedor observou o fim normal. `undefined`: o provedor não registra — NÃO significa "completa"
     * (NUNCA_ADIVINHAR).
     */
    interrupted?: boolean;
}

export interface ToolCall {
    id: string;
    name: string;
    arguments: Record<string, any>;
}

export interface ToolDefinition {
    name: string;
    description: string;
    parameters: Record<string, any>;
}

export type FallbackReason = 'timeout' | 'error' | 'empty_response' | 'streaming_failed' | 'cancelled'
    /** O recurso declarado falhou e a política `estrita` proibiu substituí-lo (`RFC-005` §1.3). */
    | 'policy_strict'
    /** Nenhum provider aceitou a tentativa: circuito aberto após falhas de conexão consecutivas. */
    | 'unavailable';

export interface AttemptInfo {
    provider: string;
    model: string;
    duration: number;
    status: 'success' | 'timeout' | 'error' | 'empty' | 'cancelled';
    errorMessage?: string;
}

export interface LLMResult {
    status: 'success' | 'timeout' | 'error' | 'cancelled';
    content: string;
    thinking?: string;
    toolCalls?: ToolCall[];
    usage?: { prompt_tokens: number; completion_tokens: number };
    fallbackReason?: FallbackReason;
    fallbackMessage?: string;
    attempts: AttemptInfo[];
    /** Issue 060 — ver `LLMResponse.interrupted`; o ProviderFactory soma o próprio abort da tentativa. */
    interrupted?: boolean;
    /**
     * Preenchido quando a resposta veio de um recurso diferente do que o usuário declarou.
     *
     * `anunciada: true` significa que o fato foi entregue ao LLM que gerou a resposta, para que ele
     * o verbalize no idioma da conversa (`RFC-005` §1.4) — não que o Core tenha escrito algo.
     * `false` significa que a troca ocorreu sem atravessar fronteira, ou sob política `livre`.
     */
    substitution?: { declared: string; used: string; announced: boolean };
}

export interface MetricsSummary {
    total: number;
    successes: number;
    timeouts: number;
    errors: number;
    avgResponseTimeMs: number;
    p95ResponseTimeMs: number;
}

export interface ILLMProvider {
    name: string;
    chat(messages: LLMMessage[], tools?: ToolDefinition[], options?: ChatOptions): Promise<LLMResponse>;
    setModel(model: string): void;
    /** Lista os modelos disponíveis no endpoint deste provider, quando suportado. */
    discoverModels?(): Promise<ModelInfo[]>;
}

/** Heurísticas de capacidade — inferidas do nome do modelo, não garantidas pelo provider. */
export type ModelCapability = 'chat' | 'vision' | 'tool_calling' | 'reasoning' | 'code' | 'embedding';

/** Modelo normalizado do catálogo, independente de qual provider o descobriu. */
export interface ModelInfo {
    id: string;
    provider: string;
    label: string;
    family?: string;
    contextWindow?: number;
    capabilities: ModelCapability[];
    status: 'available';
}

/** Endpoint OpenAI-Compatible configurado pelo usuário (LM Studio, vLLM, OpenAI oficial, custom,
 *  llamafile local). `model` é opcional — servidores de um modelo só (ex.: llamafile rodando um
 *  único .gguf) ignoram o campo `model` do payload e sempre respondem com o que já está carregado;
 *  fica disponível pra quando o endpoint hospeda múltiplos modelos (ex.: LM Studio, vLLM). */
/**
 * O que fazer quando o recurso que o usuário declarou não estiver disponível.
 *
 * Vocabulário normativo da `RFC-005` e de `docs/ARCHITECTURE/SOBERANIA_DA_CONFIGURACAO.md` §1.3 —
 * os valores são os mesmos do documento e do `.env` de propósito: RFC, configuração e código dizem
 * a mesma palavra, sem camada de tradução onde um desalinhamento possa se esconder.
 *
 * - `estrita`   — nunca substituir; a indisponibilidade é o resultado.
 * - `anunciada` — pode substituir, mas a substituição aparece na resposta, não só no log.
 * - `livre`     — pode substituir em silêncio. Só válida quando a troca não atravessa fronteira
 *                 de localidade nem de custódia (§1.2).
 *
 * ESTADO DE IMPLEMENTAÇÃO (Sprint 021): `estrita` está implementada por inteiro. `anunciada` existe
 * como valor de domínio e **ainda se comporta como `livre`** — o mecanismo de anúncio é a Sprint
 * 022. A limitação é temporária, deliberada e coberta por teste (`S207`), para que a Sprint 022
 * seja puramente aditiva: acrescenta o comportamento deste estado sem mexer em contrato,
 * configuração ou teste estrutural.
 */
export type SubstitutionPolicy = 'estrita' | 'anunciada' | 'livre';

/** Padrão para recurso declarado que não diz a sua própria política (`RFC-005` §1.3). */
export const DEFAULT_SUBSTITUTION_POLICY: SubstitutionPolicy = 'anunciada';

export const SUBSTITUTION_POLICIES: readonly SubstitutionPolicy[] = ['estrita', 'anunciada', 'livre'];

export function isSubstitutionPolicy(valor: unknown): valor is SubstitutionPolicy {
    return typeof valor === 'string' && (SUBSTITUTION_POLICIES as readonly string[]).includes(valor);
}

/**
 * Opções por chamada de `chatWithFallback`.
 *
 * `anunciarSubstituicao` é **opt-in explícito** e existe porque `chatWithFallback` serve tanto o
 * turno de conversa quanto classificador, extrator de goal e validador. Injetar "avise o usuário"
 * numa chamada que produz JSON a corromperia.
 *
 * Hoje, dos sete pontos de chamada, só o turno conversacional do `AgentLoop` declara um provider
 * preferido — os outros seis passam `undefined`. Ou seja: a fronteira da declaração já separaria os
 * casos sozinha. O opt-in existe mesmo assim, para que essa separação não dependa de uma
 * coincidência que a próxima chamada nova pode desfazer em silêncio — a `ADR-005` §5.1 registra o
 * que acontece quando se conta caminhos à mão (contou dois; eram cinco).
 */
/**
 * Rótulo de DIAGNÓSTICO de uma chamada ao LLM (Campanha B2, 24/09/2026). Só alimenta a linha
 * `[LLM-CALL]` de `ProviderFactory.chatWithFallback`; nenhum campo aqui altera o comportamento da
 * chamada. Existe porque o log não dizia QUEM chamava: modelo e papel estavam misturados
 * (`glm-5.3-flash` atende AgentLoop, planejador e validadores) e não dava para separar
 * "modelo ruim" de "tipo de tarefa pesada" — B1 mostrou que trocar o modelo não resolvia.
 */
export interface LlmCallDiag {
    /** Quem chama: "AgentLoop", "GoalPlanner.plan", "GoalPlanner.replan", "StepSemanticValidator"... */
    component: string;
    /** Papel do modelo (categoria do perfil: chat/code/execution...) quando o chamador o conhece. */
    role?: string;
    /** Fase dentro do componente: "loop", "synthesis", "delivery-guard"... */
    phase?: string;
    goalId?: string;
    cycle?: number;
    step?: string;
}

export interface ChatFallbackOptions {
    /** Só observabilidade: ver `LlmCallDiag`. Ignorado por qualquer decisão do ProviderFactory. */
    diag?: LlmCallDiag;
    /** O resultado desta chamada é entregue ao usuário, então uma substituição precisa ser dita. */
    anunciarSubstituicao?: boolean;
    /**
     * Issue 038 (campanha "sistema não utilizável", 22/09/2026): o guard-rail de "thinking"
     * travado (`OllamaProvider.MAX_THINKING_BUDGET_CHARS`/`MAX_THINKING_DURATION_MS`, nascido do
     * S72 — modelo genuinamente travado numa resposta CONVERSACIONAL) usa um único orçamento
     * fixo pra toda chamada. Reproduzido ao vivo: o mesmo guard-rail também aborta o "juiz" de
     * grounding (`ObserverValidator`) e o planejamento (`GoalPlanner`) — que legitimamente
     * raciocinam mais antes de produzir a primeira linha de conteúdo — descartando o raciocínio
     * já feito e mascarando uma resposta correta como "não confirmada" (log real: previsão do
     * tempo com dados certos, bloqueada só porque o juiz nunca terminou de julgar).
     *
     * Opt-in explícito (mesmo padrão de `anunciarSubstituicao` acima): só quem chama sabe se a
     * tarefa é curta/conversacional (padrão, mantém o teto original — protege o caso real do
     * S72) ou pesada o bastante para precisar de mais espaço antes de decidir "modelo travado".
     * Multiplica MAX_THINKING_BUDGET_CHARS/MAX_THINKING_DURATION_MS pelo mesmo fator (4×) já
     * calibrado com evidência real para chamadas de validação em `shared/auxTimeout.ts`
     * (`PERFIS.validacao.fator`) — não um número novo inventado para este achado.
     */
    reasoningIntensive?: boolean;
    /**
     * Gravador de voo (ADR-013): o chamador passa um objeto vazio e o ProviderFactory/provider o preenchem com o
     * que ACONTECEU em cada tentativa. Só observabilidade — nenhuma decisão do ProviderFactory o consulta.
     */
    telemetry?: CallTelemetry;
    /**
     * ADR-014 (modo de raciocínio por tipo de validação): `desligado` pede ao provedor que não raciocine antes de
     * responder (Ollama: `think: false`); `livre` ou ausente = o padrão do modelo (comportamento anterior). Provedor
     * que não suporta ignora — a telemetria registra o que foi pedido.
     */
    raciocinio?: 'desligado' | 'livre';
}

/** Gravador de voo (ADR-013): o que aconteceu numa chamada ao LLM, tentativa por tentativa. */
export interface CallTelemetry {
    attempts: AttemptTelemetry[];
}

export interface AttemptTelemetry {
    provider: string;
    model: string;
    startedAt: string;
    /** Modo de raciocínio pedido nesta tentativa (ADR-014); ausente = padrão do modelo. */
    raciocinio?: 'desligado' | 'livre';
    status?: 'success' | 'timeout' | 'error' | 'empty' | 'cancelled';
    errorMessage?: string;
    durationMs?: number;
    /** Preenchidos por quem consome o streaming (hoje: OllamaProvider). Ausentes = não observado. */
    chunks?: number;
    firstChunkMs?: number;
    firstChunkType?: string;
    firstContentMs?: number;
    thinkingChars?: number;
    contentChars?: number;
    toolCalls?: number;
    doneReason?: string;
    promptTokens?: number;
    evalTokens?: number;
    /** Amostras a cada TELEMETRY_SAMPLE_MS: quanto já tinha de raciocínio e de conteúdo. */
    timeline?: Array<{ ms: number; thinkingChars: number; contentChars: number }>;
    /** Texto bruto — inclusive o raciocínio de uma geração abortada. Quem grava decide se persiste (TRACE_CONTENT). */
    thinkingText?: string;
    contentText?: string;
}

/** Intervalo das amostras da linha do tempo do streaming (gravador de voo). */
export const TELEMETRY_SAMPLE_MS = 15_000;

/**
 * Piso de timeout (ms) para chamadas `reasoningIntensive` — usado em MAIS de uma camada que
 * decide "quando desistir" de uma chamada de LLM: o teto duro interno de cada provider
 * (`OllamaProvider.streamChat`'s `MAX_TIMEOUT`) E o timeout de tentativa em
 * `ProviderFactory.chatWithFallback` (`attemptTimeout`/`safetyTimeoutMs`).
 *
 * Issue 047 (23/09/2026, achado ao vivo, mesmo dia da issue 044): a issue 044 corrigiu só a
 * primeira camada — `ProviderFactory` mantinha seu PRÓPRIO `setTimeout(timeoutMs)` sem saber de
 * `reasoningIntensive`, abortando a chamada por fora aos ~65s enquanto o teto interno do
 * provider (corretamente elevado a 240s) nunca chegava a ser testado. Reproduzido ao vivo:
 * `[STREAM] START ... maxTimeout=240000ms` (teto interno correto) seguido de
 * `[STREAM] ABORTED ... duration=65619ms` (abortado por fora, pelo timer desta constante fora de
 * sincronia). Extraído aqui — em vez de duplicar "240_000" ou "60_000 × 4" em cada lugar — porque
 * as duas camadas já divergiram uma vez; um valor só, importado dos dois lados, fecha essa classe
 * de bug em vez de só este caso.
 *
 * Numericamente igual a `MAX_THINKING_DURATION_MS` com o multiplicador de `reasoningIntensive`
 * (`OllamaProvider.ts`: `60_000 × 4`) — mantidos como constantes separadas (não uma reexportando
 * a outra) porque representam conceitos distintos (teto de tempo em "thinking" vs. piso de
 * timeout de tentativa), que hoje coincidem em valor mas não são a mesma coisa por definição.
 */
export const REASONING_INTENSIVE_TIMEOUT_FLOOR_MS = 240_000;

/**
 * Teto de caracteres do prompt de uma DECISÃO do LLM (juiz, validadores). Não é limite de estilo nem economia de
 * tokens: é a fronteira a partir da qual deixa de ser possível afirmar que o LLM recebeu o objeto da decisão inteiro.
 * Acima dele, a decisão é "não avaliável" — nunca um veredito sobre um pedaço (princípio "Informação Completa para
 * Decidir", §4.5).
 *
 * Derivação: o menor contexto que o projeto assume em runtime é o padrão de `OLLAMA_NUM_CTX` (32768 tokens —
 * `OllamaProvider`), e num_ctx cobre entrada + saída. A ~3 chars/token em pt-BR são ~98k chars no total; reservando a
 * saída e margem para a instrução, o teto de ENTRADA fica em 60k. Fonte única: antes vivia só no juiz de grounding
 * (`GROUNDING_MAX_PROMPT_CHARS`); o validador do passo passou a precisar do mesmo número (Sprint V5).
 */
export const DECISION_PROMPT_MAX_CHARS = 60_000;

/**
 * O modelo pedido ao Ollama é processado na NUVEM? Convenção de nomes do próprio Ollama: modelos de nuvem terminam em
 * `:cloud` (ex.: `glm-5.2:cloud`) ou têm a tag `-cloud` (ex.: `gemma4:31b-cloud`). Fato estrutural do nome, não
 * interpretação. Issue 071: o Ollama no endereço local com um modelo `:cloud` NÃO fica na máquina do usuário — antes o
 * NewClaw o tratava como local só pelo endereço. (O painel tem a mesma regra em `ModelosView.js`, que não importa TS.)
 */
export function ehModeloDaNuvemDoOllama(modelo?: string): boolean {
    return !!modelo && /(:|-)cloud$/i.test(modelo.trim());
}

export interface CustomProviderConfig {
    label: string;
    baseUrl: string;
    apiKey?: string;
    model?: string;
    /** Política de substituição deste provider. Ausente = o padrão global (`SUBSTITUTION_POLICY`). */
    substitutionPolicy?: SubstitutionPolicy;
    /**
     * Issue 054 (D3) — raciocínio ("thinking") do modelo servido por este endpoint. `'off'` pede ao
     * servidor para não gerar raciocínio (`chat_template_kwargs.enable_thinking=false`, o parâmetro dos
     * templates Qwen no llama-server). Ausente = comportamento padrão do modelo. Escolha DO OPERADOR
     * (Soberania da Configuração): troca qualidade possível por velocidade — num 27B local, o plano
     * levou 23 s sem raciocínio e 218 s com, sem chegar a responder.
     */
    thinking?: 'on' | 'off';
}

export interface ChatOptions {
    signal?: AbortSignal;
    /** Budget (ms) measured from when chatWithFallback started the attempt.
     *  Each provider subtracts queue-wait time before applying it internally. */
    timeoutMs?: number;
    /** Ver `ChatFallbackOptions.reasoningIntensive` (issue 038) — repassado pelo ProviderFactory
     *  até o provider real (hoje só OllamaProvider consulta isto). */
    reasoningIntensive?: boolean;
    /** Ver `ChatFallbackOptions.telemetry` — a tentativa corrente, preenchida pelo provider. */
    telemetry?: AttemptTelemetry;
    /** Ver `ChatFallbackOptions.raciocinio` (ADR-014). */
    raciocinio?: 'desligado' | 'livre';
}
