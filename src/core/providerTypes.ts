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
    | 'policy_strict';

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
}
