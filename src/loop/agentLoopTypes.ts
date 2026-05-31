import { ResponseOption } from '../channels/ChannelAdapter';

/** Duck-type para ferramentas que suportam injeção de contexto de canal */
export interface ContextAwareTool {
    setContext(chatId: string, channel?: string): void;
}

export interface ToolResult {
    success: boolean;
    output: string;
    error?: string;
}

export interface ToolExecutor {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute(args: Record<string, unknown>): Promise<ToolResult>;
}

export interface LoopMetrics {
    timestamp: number;
    responseTimeMs: number;
    status: 'success' | 'timeout' | 'error' | 'cancelled';
    provider: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    promptCharCount: number;
    estimatedTokens: number;
    timeoutUsedMs: number;
    didTimeout: boolean;
}

export interface ChannelContext {
    channel: string;
    chatId: string;
    userId?: string;
    metadata?: Record<string, unknown>;
    correlationId?: string;
    /** FIX C: quando presente, send_document no AgentLoop é adiado (não enviado imediatamente) */
    deferSendDocument?: (args: Record<string, unknown>) => void;
}

export interface AgentLoopConfig {
    languageDirective: string;
    systemPrompt: string;
    modelRouter?: {
        chat?: string;
        code?: string;
        vision?: string;
        light?: string;
        analysis?: string;
        execution?: string;
        visionServer?: string;
    };
}

export interface ProcessedResult {
    text: string;
    options?: ResponseOption[];
}
