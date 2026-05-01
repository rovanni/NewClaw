/**
 * MessageBus — Central de roteamento de mensagens entre canais e o AgentLoop
 * 
 * Recebe mensagens normalizadas de qualquer ChannelAdapter,
 * roteia para o AgentLoop, e devolve a resposta ao canal de origem.
 * 
 * Funciona como o Gateway do OpenClaw, mas integrado ao NewClaw.
 */

import { AgentLoop } from '../loop/AgentLoop';
import { SessionManager, type SessionKey } from '../session/SessionManager';
import {
    ChannelAdapter,
    ChannelType,
    NormalizedMessage,
    NormalizedResponse,
    ChannelSession,
    ChannelAttachment
} from './ChannelAdapter';
import { mdToTelegramHTML } from '../shared/TelegramFormatter';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('MessageBus');

export class MessageBus {
    private adapters: Map<ChannelType, ChannelAdapter> = new Map();
    private agentLoop: AgentLoop;
    private sessionManager: SessionManager;
    private started: boolean = false;

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

    /** Iniciar todos os canais */
    async startAll(): Promise<void> {
        if (this.started) return;

        for (const [type, adapter] of this.adapters) {
            try {
                if (adapter.isConnected) {
                    await adapter.start();
                    log.info('adapter_started', `${adapter.displayName} started`);
                } else {
                    log.warn('adapter_skipped', `${adapter.displayName} not connected, skipping`);
                }
            } catch (error: any) {
                log.error('adapter_start_failed', error, `${type} failed to start`);
            }
        }

        this.started = true;
        log.info('bus_started', `MessageBus started with ${this.adapters.size} adapters`);
    }

    /** Parar todos os canais */
    async stopAll(): Promise<void> {
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

    /**
     * Processar mensagem de qualquer canal.
     * Chamado pelos adapters quando recebem uma mensagem.
     */
    async processMessage(msg: NormalizedMessage): Promise<void> {
        const sessionKey: SessionKey = { channel: msg.channel, userId: msg.userId };

        log.info('message_received', msg.text.slice(0, 50), {
            channel: msg.channel,
            userId: msg.userId,
            type: msg.type
        });

        try {
            // 1. Handle attachments (photos, audio, documents)
            if (msg.type !== 'text' && msg.attachments && msg.attachments.length > 0) {
                await this.processAttachments(msg, sessionKey);
                return;
            }

            // 2. Text processing through AgentLoop
            this.agentLoop.setTelegramContext(
                msg.userId,
                (msg.metadata?.botToken as string) || ''
            );

            await this.sessionManager.recordUserMessage(sessionKey, msg.text);
            const response = await this.agentLoop.process(msg.userId, msg.text);
            await this.sessionManager.recordAssistantMessage(sessionKey, response || '', { model: 'newclaw' });

            // 3. Send response back through the originating channel
            const adapter = this.adapters.get(msg.channel);
            if (adapter) {
                const normalizedResponse: NormalizedResponse = {
                    text: response || 'Desculpe, não consegui gerar uma resposta.',
                    format: 'markdown'
                };
                await adapter.send(normalizedResponse, msg.rawContext);
            }

        } catch (error: any) {
            log.error('message_processing_failed', error, msg.text.slice(0, 50));
            // Try to send error to user
            const adapter = this.adapters.get(msg.channel);
            if (adapter) {
                await adapter.send(
                    { text: '⚠️ Erro interno ao processar mensagem. Tente novamente.', format: 'plain' },
                    msg.rawContext
                ).catch(() => {});
            }
        }
    }

    /** Process attachments based on type */
    private async processAttachments(msg: NormalizedMessage, sessionKey: SessionKey): Promise<void> {
        const adapter = this.adapters.get(msg.channel);
        if (!adapter) return;

        for (const attachment of msg.attachments || []) {
            switch (attachment.type) {
                case 'photo':
                    await this.processPhoto(msg, attachment, sessionKey, adapter);
                    break;
                case 'voice':
                case 'audio':
                    await this.processAudio(msg, attachment, sessionKey, adapter);
                    break;
                case 'document':
                    await this.processDocument(msg, attachment, sessionKey, adapter);
                    break;
                default:
                    await adapter.send(
                        { text: `⚠️ Tipo de anexo não suportado: ${attachment.type}`, format: 'plain' },
                        msg.rawContext
                    );
            }
        }
    }

    private async processPhoto(msg: NormalizedMessage, attachment: ChannelAttachment, sessionKey: SessionKey, adapter: ChannelAdapter): Promise<void> {
        // Delegate to channel-specific vision handler via metadata
        if (msg.metadata?.handlePhoto) {
            await msg.metadata.handlePhoto(msg.rawContext, attachment);
            return;
        }
        await adapter.send({ text: '⚠️ Processamento de imagem não disponível neste canal.', format: 'plain' }, msg.rawContext);
    }

    private async processAudio(msg: NormalizedMessage, attachment: ChannelAttachment, sessionKey: SessionKey, adapter: ChannelAdapter): Promise<void> {
        if (msg.metadata?.handleAudio) {
            await msg.metadata.handleAudio(msg.rawContext, attachment);
            return;
        }
        await adapter.send({ text: '⚠️ Processamento de áudio não disponível neste canal.', format: 'plain' }, msg.rawContext);
    }

    private async processDocument(msg: NormalizedMessage, attachment: ChannelAttachment, sessionKey: SessionKey, adapter: ChannelAdapter): Promise<void> {
        if (msg.metadata?.handleDocument) {
            await msg.metadata.handleDocument(msg.rawContext, attachment);
            return;
        }
        await adapter.send({ text: '⚠️ Processamento de documento não disponível neste canal.', format: 'plain' }, msg.rawContext);
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