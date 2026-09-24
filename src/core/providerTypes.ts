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
    | { type: 'done'; value: { prompt_tokens: number; completion_tokens: number } };

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
}

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

export interface CustomProviderConfig {
    label: string;
    baseUrl: string;
    apiKey?: string;
    model?: string;
    /** Política de substituição deste provider. Ausente = o padrão global (`SUBSTITUTION_POLICY`). */
    substitutionPolicy?: SubstitutionPolicy;
}

export interface ChatOptions {
    signal?: AbortSignal;
    /** Budget (ms) measured from when chatWithFallback started the attempt.
     *  Each provider subtracts queue-wait time before applying it internally. */
    timeoutMs?: number;
    /** Ver `ChatFallbackOptions.reasoningIntensive` (issue 038) — repassado pelo ProviderFactory
     *  até o provider real (hoje só OllamaProvider consulta isto). */
    reasoningIntensive?: boolean;
}
