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
    /** P3-DEDUP: verifica se um artefato já foi registrado para deferral nesta execução */
    isDeferredArtifact?: (filePath: string) => boolean;
    /** CORREÇÃO 1: callback acionado pelo DELIVERY-GUARD do AgentLoop quando entrega um artefato
     *  diretamente (sem passar pelo deferSendDocument). Permite que GoalExecutionLoop atualize
     *  sentArtifacts antes que o ciclo seja avaliado pelo SemanticValidator, evitando reentregas
     *  redundantes mesmo quando outcome é downgraded para 'partial'. */
    onArtifactDelivered?: (filePath: string) => void;
    /** Verifica se send_audio já entregou áudio nesta execução de goal. send_audio não tem
     *  file_path estável (cada chamada gera um mp3/ogg temporário com timestamp único), então
     *  não pode reusar o dedup por path de onArtifactDelivered/isDeferredArtifact — precisa de
     *  checagem própria. Sem isso, um replan por mismatch semântico que re-executa um step
     *  "agentloop" já bem-sucedido reexecuta send_audio de novo, gerando e enviando áudio
     *  duplicado ao usuário a cada tentativa (evidência: 2026-07-05, goal_1783269002590_inaml —
     *  4 áudios enviados em sequência pelo mesmo pedido). */
    isAudioAlreadySent?: () => boolean;
    /**
     * Janela pequena e recente de turnos REAIS (role user/assistant, sem tool_call/tool_result/
     * checkpoint) da MESMA sessão, sem incluir a mensagem atual — usada por
     * UnifiedIntentRouter.route() para classificar mensagens curtas/elípticas ("continue",
     * "isso", "faça") considerando o que o assistente acabou de perguntar/propor, em vez de
     * classificar a mensagem isolada. Ver SessionKeyFactory/MessageBus para a origem do dado —
     * não é uma infraestrutura nova, reusa o mesmo slice já computado pra GoalExtractor
     * (microauditoria de continuidade conversacional, 08/07/2026).
     */
    recentMessages?: Array<{ role: string; content: string }>;
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
