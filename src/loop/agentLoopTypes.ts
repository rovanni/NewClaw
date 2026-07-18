import { ResponseOption } from '../channels/ChannelAdapter';

/** Duck-type para ferramentas que suportam injeção de contexto de canal */
export interface ContextAwareTool {
    setContext(chatId: string, channel?: string): void;
}

export interface ToolResult {
    success: boolean;
    output: string;
    error?: string;
    /**
     * Artefatos que a tool declarou/confirmou ter produzido (write: o próprio path escrito;
     * exec_command: linhas ARTIFACT: verificadas contra o disco — ver planning/artifactContract.ts).
     * Propagado para GoalAttempt.producedArtifactPaths pelo GoalExecutionLoop.
     */
    artifactPaths?: string[];
}

export interface ToolExecutor {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    /** ARCH-015 (RFC S20, Impl S26): texto curto explicando args obrigatórios/condicionais para
     *  a seção "REFERÊNCIA DE ARGS OBRIGATÓRIOS" do prompt do Planner (GoalPlanner.ts,
     *  buildRequiredArgsReference()). Ausente = tool não aparece nessa seção (schema
     *  autoexplicativo). Co-localizado no arquivo da tool em vez de um bloco solto em
     *  GoalPlanner.ts — um maintainer adicionando/mudando um arg obrigatório está com o código
     *  na tela e é mais provável de lembrar de atualizar. Escopo deliberadamente reduzido:
     *  só texto de prompt, não valida nada — ver RFC_ARCH-015_SchemaGeneratedRequiredArgs.md
     *  para por que a metade de validação (detectMissingRequiredArgs) não foi aprovada. */
    requiredArgsHint?: string;
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

/**
 * ARCH-024: bus privado de callbacks de rastreamento de entrega entre GoalExecutionLoop e
 * AgentLoop, isolado do restante de ChannelContext (identidade real do canal). Ver
 * docs/refatoracao-arquitetural-2026/RFC_ARCH-024_DeliveryTrackingContext.md — RFC aprovada em
 * S19/S23 depois de constatar que os 4 campos abaixo eram construídos/consumidos por um único
 * par de sites (GoalExecutionLoop produz, AgentLoop consome), sem relação com a identidade de
 * canal representada pelos demais campos de ChannelContext.
 */
export interface DeliveryTrackingContext {
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
}

export interface ChannelContext {
    channel: string;
    chatId: string;
    userId?: string;
    metadata?: Record<string, unknown>;
    correlationId?: string;
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
    /** ARCH-024: bus de callbacks de rastreamento de entrega — ver DeliveryTrackingContext acima. */
    deliveryTracking?: DeliveryTrackingContext;
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
