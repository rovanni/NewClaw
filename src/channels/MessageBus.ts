/**
 * MessageBus — Central de roteamento de mensagens entre canais e o AgentLoop
 * 
 * Recebe mensagens normalizadas de qualquer ChannelAdapter,
 * roteia para o AgentLoop, e devolve a resposta ao canal de origem.
 * 
 * Suporta: text, photo, voice, audio, document, command
 * 
 * Funciona como o Gateway do OpenClaw, mas integrado ao NewClaw.
 */

import crypto from 'crypto';
import { AgentLoop } from '../loop/AgentLoop';
import { SessionManager, type SessionKey } from '../session/SessionManager';
import type { OnboardingService } from '../services/OnboardingService';
import {
    ChannelAdapter,
    ChannelType,
    TypingAction,
    NormalizedMessage,
    NormalizedResponse,
    ChannelAttachment
} from './ChannelAdapter';
import { createLogger } from '../shared/AppLogger';
import { errorMessage } from '../shared/errors';
import { ConversationQueueManager } from '../core/ConversationQueueManager';
import type { GoalOrchestrator } from '../loop/GoalOrchestrator';

const log = createLogger('MessageBus');

export class MessageBus {
    private adapters: Map<ChannelType, ChannelAdapter> = new Map();
    private agentLoop: AgentLoop;
    private sessionManager: SessionManager;
    private started: boolean = false;
    /** GoalOrchestrator — quando definido, intercepta mensagens de goal antes do AgentLoop */
    private goalOrchestrator?: GoalOrchestrator;
    /** OnboardingService — intercepta mensagens do primeiro uso para coletar perfil */
    private onboardingService?: OnboardingService;
    /** Custom command handlers (e.g., /clear, /skills) */
    private commandHandlers: Map<string, (msg: NormalizedMessage) => Promise<string | null>> = new Map();
    /** Priority command handlers — executam imediatamente, bypassam a fila (e.g., /cancelar) */
    private priorityCommandHandlers: Map<string, (msg: NormalizedMessage) => Promise<string | null>> = new Map();
    /** Custom media handlers */
    private mediaHandlers: Map<string, (msg: NormalizedMessage, attachment: ChannelAttachment) => Promise<string | null>> = new Map();
    /** Recently processed message IDs to prevent Telegram duplicate delivery */
    private recentMessageIds: Map<string, number> = new Map();
    private readonly MESSAGE_ID_TTL_MS = 5 * 60 * 1000; // 5 minutes
    private cleanupTimer: NodeJS.Timeout | null = null;
    /** Fila serial por conversa — garante processamento em ordem */
    private readonly conversationQueues = new ConversationQueueManager();

    constructor(agentLoop: AgentLoop, sessionManager: SessionManager) {
        this.agentLoop = agentLoop;
        this.sessionManager = sessionManager;
    }

    private startCleanupTimer(): void {
        if (this.cleanupTimer) return;
        this.cleanupTimer = setInterval(() => {
            const now = Date.now();
            for (const [key, ts] of this.recentMessageIds) {
                if (now - ts > this.MESSAGE_ID_TTL_MS) this.recentMessageIds.delete(key);
            }
        }, this.MESSAGE_ID_TTL_MS);
        this.cleanupTimer.unref(); // don't keep the process alive just for cleanup
    }

    /** Registrar um canal */
    registerAdapter(adapter: ChannelAdapter): void {
        this.adapters.set(adapter.channelType, adapter);
        log.info('adapter_registered', `${adapter.displayName} adapter registered`, { channel: adapter.channelType });
    }

    /** Remover um canal */
    unregisterAdapter(channelType: ChannelType): void {
        this.adapters.delete(channelType);
    }

    /** Injetar OnboardingService após construção */
    setOnboardingService(svc: OnboardingService): void {
        this.onboardingService = svc;
        log.info('onboarding_service_registered', 'OnboardingService registered');
    }

    /** Injetar GoalOrchestrator após construção (evita dependência circular) */
    setGoalOrchestrator(orchestrator: GoalOrchestrator): void {
        this.goalOrchestrator = orchestrator;
        log.info('goal_orchestrator_registered', 'GoalOrchestrator registered');
    }

    /** Registrar handler de comando (ex: /clear, /skills) */
    registerCommand(command: string, handler: (msg: NormalizedMessage) => Promise<string | null>): void {
        this.commandHandlers.set(command, handler);
    }

    /**
     * Registrar comando de prioridade máxima (ex: /cancelar).
     * Esses comandos bypassam completamente a fila — executam imediatamente mesmo
     * com uma tarefa longa em andamento e descartam tarefas pendentes na fila.
     */
    registerPriorityCommand(command: string, handler: (msg: NormalizedMessage) => Promise<string | null>): void {
        this.priorityCommandHandlers.set(command, handler);
    }

    /** Registrar handler de mídia (ex: photo → vision, voice → whisper) */
    registerMediaHandler(type: string, handler: (msg: NormalizedMessage, attachment: ChannelAttachment) => Promise<string | null>): void {
        this.mediaHandlers.set(type, handler);
    }

    /** Obter um adapter pelo tipo */
    getAdapter(type: ChannelType): ChannelAdapter | undefined {
        return this.adapters.get(type);
    }

    /** Enviar mensagem diretamente para um chatId no canal especificado (usado pelo Scheduler) */
    async sendToChat(channel: ChannelType, chatId: string, response: NormalizedResponse): Promise<void> {
        const adapter = this.adapters.get(channel);
        if (!adapter) {
            log.warn('send_to_chat_no_adapter', `No adapter registered for channel "${channel}"`);
            return;
        }
        if (!adapter.sendToChat) {
            log.warn('send_to_chat_unsupported', `Adapter "${channel}" does not support sendToChat`);
            return;
        }
        await adapter.sendToChat(chatId, response);
    }

    /** Iniciar todos os canais com auto-reconexão */
    async startAll(): Promise<void> {
        if (this.started) return;

        for (const [type, adapter] of this.adapters) {
            try {
                await adapter.start();
                log.info('adapter_started', `${adapter.displayName} started`);
            } catch (error) {
                // Don't crash — schedule background reconnect
                // Each adapter handles its own reconnect via scheduleReconnect
                log.error('adapter_start_failed', error, `${type} failed to start — will retry in background`);
                this.scheduleAdapterReconnect(type, adapter, error);
            }
        }

        this.started = true;
        this.startCleanupTimer();
        log.info('bus_started', `MessageBus started with ${this.adapters.size} adapters`);
    }

    /** Agendar reconexão para um adapter que falhou */
    private reconnectTimers: Map<ChannelType, NodeJS.Timeout> = new Map();
    private reconnectAttempts: Map<ChannelType, number> = new Map();

    private scheduleAdapterReconnect(type: ChannelType, adapter: ChannelAdapter, error: unknown): void {
        const attempts = (this.reconnectAttempts.get(type) || 0) + 1;
        this.reconnectAttempts.set(type, attempts);

        // Backoff exponencial: 10s, 20s, 40s, 80s... max 5min
        const delay = Math.min(10 * Math.pow(2, attempts - 1), 300) * 1000;

        log.info('adapter_reconnect_scheduled', `${adapter.displayName} reconnect attempt ${attempts} in ${delay/1000}s`, {
            channel: type,
            attempt: attempts,
            delayMs: delay,
            error: errorMessage(error) || String(error)
        });

        // Limpar timer anterior se existir
        const existing = this.reconnectTimers.get(type);
        if (existing) clearTimeout(existing);

        const timer = setTimeout(async () => {
            log.info('adapter_reconnect_attempt', `Reconnecting ${adapter.displayName} (attempt ${attempts})...`);
            try {
                await adapter.start();
                log.info('adapter_reconnected', `✅ ${adapter.displayName} reconnected successfully after ${attempts} attempts`);
                this.reconnectAttempts.delete(type);
                this.reconnectTimers.delete(type);
            } catch (reconnectError) {
                log.error('adapter_reconnect_failed', `${adapter.displayName} reconnect failed`, errorMessage(reconnectError) || String(reconnectError));
                this.scheduleAdapterReconnect(type, adapter, reconnectError);
            }
        }, delay);

        this.reconnectTimers.set(type, timer);
    }

    /** Parar todos os canais e cancelar reconexões */
    async stopAll(): Promise<void> {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }

        // Cancelar todos os timers de reconexão
        for (const [type, timer] of this.reconnectTimers) {
            clearTimeout(timer);
            log.info('reconnect_cancelled', `Cancelled reconnect timer for ${type}`);
        }
        this.reconnectTimers.clear();
        this.reconnectAttempts.clear();

        for (const key of this.typingIntervals.keys()) {
            this.stopTypingIndicator(key);
        }

        this.conversationQueues.destroy();

        for (const [type, adapter] of this.adapters) {
            try {
                await adapter.stop();
            } catch (error) {
                log.error('adapter_stop_failed', error, `${type} failed to stop`);
            }
        }
        this.started = false;
        log.info('bus_stopped', 'MessageBus stopped');
    }

    /** Intervalo de typing indicator ativo por canal+userId */
    private typingIntervals: Map<string, NodeJS.Timeout> = new Map();

    /**
     * Iniciar indicador de digitação para um canal.
     * Envia imediatamente e depois a cada 4s até stopTypingIndicator().
     */
    private startTypingIndicator(adapter: ChannelAdapter, context: unknown, action: TypingAction = 'typing', key?: string): void {
        if (!adapter.sendTypingIndicator) return;

        const intervalKey = key || 'default';

        // Limpar interval existente se houver
        const existing = this.typingIntervals.get(intervalKey);
        if (existing) clearInterval(existing);

        // Enviar imediatamente
        adapter.sendTypingIndicator(context, action).catch(() => {});

        // Enviar a cada 4s (Telegram expira após ~5s)
        const interval = setInterval(() => {
            adapter.sendTypingIndicator!(context, action).catch(() => {});
        }, 4000);

        this.typingIntervals.set(intervalKey, interval);
    }

    /** Parar indicador de digitação */
    private stopTypingIndicator(key?: string): void {
        const intervalKey = key || 'default';
        const interval = this.typingIntervals.get(intervalKey);
        if (interval) {
            clearInterval(interval);
            this.typingIntervals.delete(intervalKey);
        }
    }

    /**
     * Determinar ação de digitação baseada no tipo de mensagem
     */
    private getTypingAction(msg: NormalizedMessage): TypingAction {
        if (msg.type === 'voice' || msg.type === 'audio') return 'record_voice';
        if (msg.type === 'photo') return 'upload_photo';
        if (msg.type === 'document') return 'upload_document';
        if (msg.type === 'video') return 'record_video';
        return 'typing';
    }

    /**
     * Portão de entrada: deduplica, envia ACK se necessário e enfileira.
     * Retorna imediatamente — o processamento real ocorre em background via ConversationQueueManager.
     */
    async processMessage(msg: NormalizedMessage): Promise<void> {
        // Deduplicate by messageId — Telegram pode re-entregar a mesma atualização
        if (msg.messageId) {
            const dedupeKey = `${msg.channel}:${msg.messageId}`;
            if (this.recentMessageIds.has(dedupeKey)) {
                log.warn('duplicate_message_dropped', `messageId=${msg.messageId} already processed`, { channel: msg.channel, userId: msg.userId });
                return;
            }
            this.recentMessageIds.set(dedupeKey, Date.now());
        }

        const correlationId = crypto.randomUUID();
        const adapter = this.adapters.get(msg.channel);

        log.info('message_received', msg.text.slice(0, 50), {
            channel: msg.channel,
            userId: msg.userId,
            type: msg.type,
            correlationId
        });

        // Chave da fila: por canal + usuário — preserva independência entre usuários
        const queueId = `${msg.channel}:${msg.userId}`;

        // Comandos de prioridade máxima (ex: /cancelar) bypassam a fila completamente.
        // Executam imediatamente, cancelam a operação em curso e descartam tarefas pendentes.
        if (msg.text.startsWith('/')) {
            const commandName = msg.text.split(' ')[0].toLowerCase();
            const priorityHandler = this.priorityCommandHandlers.get(commandName);
            if (priorityHandler) {
                const cleared = this.conversationQueues.clearQueue(queueId);
                const response = await priorityHandler(msg).catch(() => null);
                if (response && adapter) {
                    await adapter.send({ text: response, format: 'plain' }, msg.rawContext).catch(() => {});
                }
                log.info('priority_command_executed', `cmd=${commandName} clearedPending=${cleared}`, { queueId, correlationId });
                return;
            }
        }

        const result = this.conversationQueues.enqueue(
            queueId,
            () => this.processMessageCore(msg, correlationId)
        );

        if ('rejected' in result) {
            log.warn('queue_backpressure', `Rejected message for ${queueId}`, { queueId });
            if (adapter) {
                await adapter.send(
                    {
                        text: '⚠️ Muitas mensagens pendentes nesta conversa.\nAguarde a conclusão das tarefas atuais antes de enviar mais.',
                        format: 'plain'
                    },
                    msg.rawContext
                ).catch(() => {});
            }
            return;
        }

        // Envia ACK apenas no primeiro enqueue extra de cada burst
        if (result.sendAck && adapter) {
            await adapter.send(
                {
                    text: '🧠 Estou concluindo a tarefa anterior.\nSua mensagem já foi adicionada à sequência de processamento. Por favor, aguarde um momento.',
                    format: 'plain'
                },
                msg.rawContext
            ).catch(() => {});
        }

        log.debug('message_queued', `queued=${result.queued} position=${result.position}`, { queueId, correlationId });
    }

    /**
     * Processamento real da mensagem — executado serialmente pela ConversationQueueManager.
     * Inclui: comandos, mídia (Whisper/vision/docs), AgentLoop, resposta ao usuário.
     */
    private async processMessageCore(msg: NormalizedMessage, correlationId: string): Promise<void> {
        const sessionKey: SessionKey = { channel: msg.channel, userId: msg.userId };
        const typingKey = `${msg.channel}:${msg.userId}`;
        const adapter = this.adapters.get(msg.channel);

        // Typing indicator só começa quando a tarefa realmente inicia (não durante espera na fila)
        if (adapter?.sendTypingIndicator) {
            const action = this.getTypingAction(msg);
            this.startTypingIndicator(adapter, msg.rawContext, action, typingKey);
        }

        try {
            // 1. Handle commands
            if (msg.type === 'command' || msg.text.startsWith('/')) {
                const commandName = msg.text.split(' ')[0].toLowerCase();
                const handler = this.commandHandlers.get(commandName);
                if (handler) {
                    const result = await handler(msg);
                    if (result !== null) {
                        if (adapter) {
                            await adapter.send({ text: result, format: 'markdown' }, msg.rawContext);
                        }
                        return;
                    }
                }
                // Comando sem handler registrado — cai para o AgentLoop
            }

            // 2. Handle media attachments (photo, voice, audio, document)
            // O preprocessamento (Whisper, vision, download) ocorre dentro da fila,
            // garantindo que a ordem lógica da conversa seja preservada.
            if (msg.attachments && msg.attachments.length > 0) {
                const mediaResult = await this.processAttachments(msg, sessionKey);
                if (mediaResult) {
                    if (adapter) {
                        await adapter.send(
                            { text: mediaResult, format: 'markdown' },
                            msg.rawContext
                        );
                    }
                    return;
                }
            }

            // 3. Text processing through AgentLoop
            await this.sessionManager.recordUserMessage(sessionKey, msg.text);
            const startTime = Date.now();
            log.info('processing_start', `User: ${msg.text.slice(0, 80)}`, { channel: msg.channel, userId: msg.userId, correlationId });

            const channelCtx = {
                channel: msg.channel,
                chatId: msg.chatId || msg.userId,
                userId: msg.userId,
                metadata: msg.metadata,
                correlationId
            };

            // Snapshot das últimas mensagens da sessão para o GoalExtractor avaliar
            // se a mensagem atual é resposta a um menu/lista do assistente.
            // Feito apenas quando GoalOrchestrator está ativo para evitar overhead desnecessário.
            let recentSessionMessages: Array<{ role: string; content: string }> = [];
            if (this.goalOrchestrator) {
                try {
                    const { messages: transcriptEntries } = await this.sessionManager.buildContext(sessionKey, '');
                    recentSessionMessages = transcriptEntries
                        .filter(m => m.role === 'user' || m.role === 'assistant')
                        .slice(-5, -1) // últimas 4 antes da mensagem atual
                        .map(m => ({ role: m.role as string, content: m.content.slice(0, 400) }));
                } catch { /* continua sem contexto */ }
            }

            // Onboarding: primeira instalação — banco vazio, pede nome e apelido uma única vez.
            // Dashboard web é interface do operador (onboarding já concluído via canal principal) — nunca redireciona.
            if (msg.channel !== 'web' && this.onboardingService?.isOnboardingRequired()) {
                const ob = await this.onboardingService.processMessage(msg.userId, msg.text);
                if (adapter) await adapter.send({ text: ob.reply, format: 'markdown' }, msg.rawContext);
                await this.sessionManager.recordAssistantMessage(sessionKey, ob.reply);
                if (!ob.completed) return;
                // completed → cai no agentLoop para a primeira resposta real
            }

            const response = this.goalOrchestrator
                ? await this.goalOrchestrator.process(msg.userId, msg.text, msg.userId, channelCtx, recentSessionMessages)
                : await this.agentLoop.process(msg.userId, msg.text, msg.userId, channelCtx);
            const duration = Date.now() - startTime;

            const responseText = typeof response === 'string' ? response : response.text;
            const responseOptions = typeof response === 'string' ? undefined : response.options;

            log.info('processing_done', `Duration: ${duration}ms`, {
                responseLength: responseText?.length || 0,
                channel: msg.channel,
                correlationId
            });

            // 4. Envia resposta antes de gravar no DB — erro de DB nunca bloqueia o usuário
            if (adapter) {
                // H1 observabilidade: correlaciona mensagem recebida com resposta enviada
                log.info(`[USER-MESSAGE] message_id=${msg.messageId} session=${msg.channel}:${msg.userId} correlationId=${correlationId} response_len=${responseText?.length ?? 0} duration_ms=${duration}`);
                const normalizedResponse: NormalizedResponse = {
                    text: responseText || 'Desculpe, não consegui gerar uma resposta.',
                    format: 'markdown',
                    options: responseOptions
                };
                await adapter.send(normalizedResponse, msg.rawContext);
            }

            await this.sessionManager.recordAssistantMessage(sessionKey, responseText || '', { model: 'newclaw' }).catch(err => {
                log.error('record_assistant_message_failed', err, 'Failed to persist assistant message; response already sent');
            });

        } catch (error) {
            this.stopTypingIndicator(typingKey);

            const isTimeout = errorMessage(error)?.includes('Timeout') || errorMessage(error)?.includes('abort');
            const userMessage = isTimeout
                ? '⏱️ O modelo demorou mais que o esperado. Tente novamente em alguns instantes.'
                : '⚠️ Erro ao processar mensagem. Tente novamente.';

            log.error('message_processing_failed', error, msg.text.slice(0, 50));
            log.error('error_details', undefined, 'Processing failure details', {
                channel: msg.channel,
                userId: msg.userId,
                correlationId,
                errorMessage: error instanceof Error ? errorMessage(error) : (typeof error === 'object' ? JSON.stringify(error) : String(error)),
                errorStack: error instanceof Error ? error.stack?.split('\n').slice(0, 15).join(' | ') : 'No stack trace'
            });

            if (adapter) {
                await adapter.send(
                    { text: userMessage, format: 'plain' },
                    msg.rawContext
                ).catch(() => {});
            }
        } finally {
            this.stopTypingIndicator(typingKey);
        }
    }

    /** Process attachments via registered handlers */
    private async processAttachments(msg: NormalizedMessage, _sessionKey: SessionKey): Promise<string | null> {
        for (const attachment of msg.attachments || []) {
            const handler = this.mediaHandlers.get(attachment.type);
            if (handler) {
                const result = await handler(msg, attachment);
                if (result === null) {
                    // Handler processed successfully (e.g., voice transcribed → msg.text set)
                    // Continue to text processing pipeline
                    return null;
                }
                if (result !== null) return result;
            }
        }

        // No handler registered — return generic message
        if (msg.attachments && msg.attachments.length > 0) {
            const types = msg.attachments.map(a => a.type).join(', ');
            return `📎 Anexo recebido (${types}). Processamento de mídia não configurado para este canal.`;
        }

        return null;
    }

    /** Baixar arquivo por fileId no canal especificado */
    async downloadFile(channel: ChannelType, fileId: string): Promise<Buffer> {
        const adapter = this.adapters.get(channel);
        if (!adapter?.downloadFile) throw new Error(`Adapter "${channel}" does not support downloadFile`);
        return adapter.downloadFile(fileId);
    }

    /** Enviar áudio/voz para um chatId via o adapter do canal */
    async sendVoice(channel: ChannelType, chatId: string, buffer: Buffer, filename?: string): Promise<void> {
        const adapter = this.adapters.get(channel);
        if (!adapter?.sendVoice) {
            log.warn('send_voice_unsupported', `Adapter "${channel}" does not support sendVoice`);
            return;
        }
        await adapter.sendVoice(chatId, buffer, filename);
    }

    /** Enviar documento para um chatId via o adapter do canal */
    async sendDocument(channel: ChannelType, chatId: string, buffer: Buffer, filename: string, caption?: string): Promise<void> {
        const adapter = this.adapters.get(channel);
        if (!adapter?.sendDocument) {
            log.warn('send_document_unsupported', `Adapter "${channel}" does not support sendDocument`);
            return;
        }
        await adapter.sendDocument(chatId, buffer, filename, caption);
    }

    /** Health check de todos os canais */
    async healthCheck(): Promise<Record<ChannelType, { ok: boolean; details?: string }>> {
        const results: Record<string, { ok: boolean; details?: string }> = {};
        for (const [type, adapter] of this.adapters) {
            results[type] = await adapter.healthCheck();
        }
        return results as Record<ChannelType, { ok: boolean; details?: string }>;
    }

    /** Listar canais registrados */
    listAdapters(): Array<{ channel: ChannelType; name: string; connected: boolean }> {
        return Array.from(this.adapters.entries()).map(([type, adapter]) => ({
            channel: type,
            name: adapter.displayName,
            connected: adapter.isConnected
        }));
    }
}
