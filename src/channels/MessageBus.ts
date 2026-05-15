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
import {
    ChannelAdapter,
    ChannelType,
    TypingAction,
    NormalizedMessage,
    NormalizedResponse,
    ChannelSession,
    ChannelAttachment
} from './ChannelAdapter';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('MessageBus');

export class MessageBus {
    private adapters: Map<ChannelType, ChannelAdapter> = new Map();
    private agentLoop: AgentLoop;
    private sessionManager: SessionManager;
    private started: boolean = false;
    /** Custom command handlers (e.g., /clear, /skills) */
    private commandHandlers: Map<string, (msg: NormalizedMessage) => Promise<string | null>> = new Map();
    /** Custom media handlers */
    private mediaHandlers: Map<string, (msg: NormalizedMessage, attachment: ChannelAttachment) => Promise<string | null>> = new Map();

    constructor(agentLoop: AgentLoop, sessionManager: SessionManager) {
        this.agentLoop = agentLoop;
        this.sessionManager = sessionManager;
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

    /** Registrar handler de comando (ex: /clear, /skills) */
    registerCommand(command: string, handler: (msg: NormalizedMessage) => Promise<string | null>): void {
        this.commandHandlers.set(command, handler);
    }

    /** Registrar handler de mídia (ex: photo → vision, voice → whisper) */
    registerMediaHandler(type: string, handler: (msg: NormalizedMessage, attachment: ChannelAttachment) => Promise<string | null>): void {
        this.mediaHandlers.set(type, handler);
    }

    /** Obter um adapter pelo tipo */
    getAdapter(type: ChannelType): ChannelAdapter | undefined {
        return this.adapters.get(type);
    }

    /** Iniciar todos os canais com auto-reconexão */
    async startAll(): Promise<void> {
        if (this.started) return;

        for (const [type, adapter] of this.adapters) {
            try {
                await adapter.start();
                log.info('adapter_started', `${adapter.displayName} started`);
            } catch (error: any) {
                // Don't crash — schedule background reconnect
                // Each adapter handles its own reconnect via scheduleReconnect
                log.error('adapter_start_failed', error, `${type} failed to start — will retry in background`);
                this.scheduleAdapterReconnect(type, adapter, error);
            }
        }

        this.started = true;
        log.info('bus_started', `MessageBus started with ${this.adapters.size} adapters`);
    }

    /** Agendar reconexão para um adapter que falhou */
    private reconnectTimers: Map<ChannelType, NodeJS.Timeout> = new Map();
    private reconnectAttempts: Map<ChannelType, number> = new Map();

    private scheduleAdapterReconnect(type: ChannelType, adapter: ChannelAdapter, error: any): void {
        const attempts = (this.reconnectAttempts.get(type) || 0) + 1;
        this.reconnectAttempts.set(type, attempts);

        // Backoff exponencial: 10s, 20s, 40s, 80s... max 5min
        const delay = Math.min(10 * Math.pow(2, attempts - 1), 300) * 1000;

        log.info('adapter_reconnect_scheduled', `${adapter.displayName} reconnect attempt ${attempts} in ${delay/1000}s`, {
            channel: type,
            attempt: attempts,
            delayMs: delay,
            error: error?.message || String(error)
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
            } catch (reconnectError: any) {
                log.error('adapter_reconnect_failed', `${adapter.displayName} reconnect failed`, reconnectError?.message || String(reconnectError));
                this.scheduleAdapterReconnect(type, adapter, reconnectError);
            }
        }, delay);

        this.reconnectTimers.set(type, timer);
    }

    /** Parar todos os canais e cancelar reconexões */
    async stopAll(): Promise<void> {
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

        for (const [type, adapter] of this.adapters) {
            try {
                await adapter.stop();
            } catch (error: any) {
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
    private startTypingIndicator(adapter: ChannelAdapter, context: any, action: TypingAction = 'typing', key?: string): void {
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
     * Processar mensagem de qualquer canal.
     * Chamado pelos adapters quando recebem uma mensagem.
     */
    async processMessage(msg: NormalizedMessage): Promise<void> {
        const sessionKey: SessionKey = { channel: msg.channel, userId: msg.userId };
        const typingKey = `${msg.channel}:${msg.userId}`;

        const correlationId = crypto.randomUUID();

        log.info('message_received', msg.text.slice(0, 50), {
            channel: msg.channel,
            userId: msg.userId,
            type: msg.type,
            correlationId
        });

        // Iniciar typing indicator antes do processamento
        const adapter = this.adapters.get(msg.channel);
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
                // If no handler, fall through to AgentLoop
            }

            // 2. Handle media attachments (photo, voice, audio, document)
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
            log.info('processing_start', `User: ${msg.text.slice(0, 80)}`, { channel: msg.channel, userId: msg.userId });
            const response = await this.agentLoop.process(
                msg.userId,
                msg.text,
                msg.userId,
                {
                    channel: msg.channel,
                    chatId: msg.chatId || msg.userId,
                    botToken: adapter?.getBotToken ? adapter.getBotToken() : undefined,
                    metadata: msg.metadata,
                    correlationId
                }
            );
            const duration = Date.now() - startTime;
            
            const responseText = typeof response === 'string' ? response : response.text;
            const responseOptions = typeof response === 'string' ? undefined : response.options;

            log.info('processing_done', `Duration: ${duration}ms`, { 
                responseLength: responseText?.length || 0,
                channel: msg.channel
            });
            await this.sessionManager.recordAssistantMessage(sessionKey, responseText || '', { model: 'newclaw' });

            // 4. Send response back through the originating channel
            if (adapter) {
                const normalizedResponse: NormalizedResponse = {
                    text: responseText || 'Desculpe, não consegui gerar uma resposta.',
                    format: 'markdown',
                    options: responseOptions
                };
                await adapter.send(normalizedResponse, msg.rawContext);
            }

        } catch (error: any) {
            const isTimeout = error?.message?.includes('Timeout') || error?.message?.includes('abort');
            const userMessage = isTimeout 
                ? '⏱️ O modelo demorou mais que o esperado. Tente novamente em alguns instantes.' 
                : '⚠️ Erro ao processar mensagem. Tente novamente.';
            
            log.error('message_processing_failed', error, msg.text.slice(0, 50));
            log.error('error_details', {
                channel: msg.channel,
                userId: msg.userId,
                errorMessage: error?.message || 'Unknown error',
                errorStack: error?.stack?.split('\n').slice(0, 3).join(' | ')
            });
            if (adapter) {
                await adapter.send(
                    { text: userMessage, format: 'plain' },
                    msg.rawContext
                ).catch(() => {});
            }
        } finally {
            // Sempre parar o typing indicator ao finalizar
            this.stopTypingIndicator(typingKey);
        }
    }

    /** Process attachments via registered handlers */
    private async processAttachments(msg: NormalizedMessage, sessionKey: SessionKey): Promise<string | null> {
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

    /** Health check de todos os canais */
    async healthCheck(): Promise<Record<ChannelType, { ok: boolean; details?: string }>> {
        const results: Record<string, { ok: boolean; details?: string }> = {};
        for (const [type, adapter] of this.adapters) {
            results[type] = await adapter.healthCheck();
        }
        return results as any;
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
