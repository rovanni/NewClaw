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

export type FallbackReason = 'timeout' | 'error' | 'empty_response' | 'streaming_failed' | 'cancelled';

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

/** Endpoint OpenAI-Compatible configurado pelo usuário (LM Studio, vLLM, OpenAI oficial, custom). */
export interface CustomProviderConfig {
    label: string;
    baseUrl: string;
    apiKey?: string;
}

export interface ChatOptions {
    signal?: AbortSignal;
    /** Budget (ms) measured from when chatWithFallback started the attempt.
     *  Each provider subtracts queue-wait time before applying it internally. */
    timeoutMs?: number;
}
