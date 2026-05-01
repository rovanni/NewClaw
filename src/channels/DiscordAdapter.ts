/**
 * DiscordAdapter — ChannelAdapter para Discord via discord.js
 * 
 * Implementa a interface ChannelAdapter para que o Discord
 * funcione como canal no MessageBus do NewClaw.
 * 
 * Normaliza mensagens Discord → NormalizedMessage
 * NormalizedResponse → mensagens Discord (embeds, files, etc.)
 */

import {
    Client,
    GatewayIntentBits,
    Message,
    Partials,
    TextChannel,
    EmbedBuilder,
    AttachmentBuilder,
    ChannelType as DiscordChannelType
} from 'discord.js';
import {
    ChannelAdapter,
    ChannelType,
    NormalizedMessage,
    NormalizedResponse,
    ChannelConfig,
    ChannelAttachment,
    ResponseAttachment
} from './ChannelAdapter';
import { MessageBus } from './MessageBus';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('DiscordAdapter');

export interface DiscordConfig extends ChannelConfig {
    botToken: string;
    /** IDs de servidores permitidos (vazio = todos) */
    allowedGuildIds?: string[];
    /** IDs de usuários permitidos (vazio = todos nos guilds permitidos) */
    allowedUserIds?: string[];
    /** Canal padrão para mensagens do bot (ID) */
    defaultChannelId?: string;
}

export class DiscordAdapter implements ChannelAdapter {
    readonly channelType: ChannelType = 'discord';
    readonly displayName: string = 'Discord';
    private _isConnected: boolean = false;

    private client: Client;
    private config: DiscordConfig;
    private bus: MessageBus | null = null;

    constructor(config: DiscordConfig) {
        this.config = config;

        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.DirectMessages,
                GatewayIntentBits.MessageContent,
            ],
            partials: [
                Partials.Channel,
                Partials.Message,
            ],
        });
    }

    get isConnected(): boolean {
        return this._isConnected;
    }

    /** Get discord.js Client instance */
    getClient(): Client {
        return this.client;
    }

    /** Conectar ao MessageBus */
    setBus(bus: MessageBus): void {
        this.bus = bus;
    }

    async start(): Promise<void> {
        if (!this.config.enabled) {
            log.info('adapter_disabled', 'Discord adapter is disabled');
            return;
        }

        if (!this.config.botToken) {
            log.warn('no_token', 'Discord bot token not configured');
            return;
        }

        this.registerHandlers();

        try {
            await this.client.login(this.config.botToken);
            this._isConnected = true;
            log.info('bot_started', '🤖 Discord Bot rodando!');
        } catch (e: any) {
            log.error('login_failed', e, 'Discord login failed');
            this._isConnected = false;
        }
    }

    async stop(): Promise<void> {
        this.client.destroy();
        this._isConnected = false;
        log.info('bot_stopped', 'Discord Bot stopped');
    }

    /** Enviar resposta normalizada via Discord */
    async send(response: NormalizedResponse, context: any): Promise<void> {
        const channel = context as TextChannel;
        if (!channel) {
            log.warn('no_channel', 'No Discord channel in context');
            return;
        }

        try {
            // Send attachments first
            if (response.attachments && response.attachments.length > 0) {
                for (const attachment of response.attachments) {
                    await this.sendAttachment(channel, attachment);
                }
            }

            // Send text
            if (!response.text || response.text.trim().length === 0) return;

            // Discord limit: 2000 chars
            const maxLen = 2000;

            if (response.format === 'markdown') {
                // Discord supports markdown natively
                if (response.text.length <= maxLen) {
                    await channel.send(response.text);
                } else {
                    const chunks = this.splitIntoChunks(response.text, maxLen);
                    for (const chunk of chunks) {
                        await channel.send(chunk);
                        await new Promise(r => setTimeout(r, 100));
                    }
                }
            } else {
                // Plain or HTML (strip HTML for Discord)
                const text = this.stripHtml(response.text);
                if (text.length <= maxLen) {
                    await channel.send(text);
                } else {
                    const chunks = this.splitIntoChunks(text, maxLen);
                    for (const chunk of chunks) {
                        await channel.send(chunk);
                        await new Promise(r => setTimeout(r, 100));
                    }
                }
            }

            // Reactions
            if (response.reactions && response.reactions.length > 0) {
                // Discord reactions on last sent message — not trivial to implement here
                // Future: store last message ID and react
            }
        } catch (e: any) {
            log.error('send_failed', e);
        }
    }

    /** Enviar para canal específico (por ID) */
    async sendToChannel(channelId: string, response: NormalizedResponse): Promise<void> {
        try {
            const channel = this.client.channels.cache.get(channelId);
            if (!channel || !channel.isTextBased()) {
                log.warn('channel_not_found', `Discord channel ${channelId} not found or not text`);
                return;
            }
            await this.send(response, channel);
        } catch (e: any) {
            log.error('send_to_channel_failed', e);
        }
    }

    async healthCheck(): Promise<{ ok: boolean; details?: string }> {
        if (!this._isConnected) {
            return { ok: false, details: 'Not connected' };
        }
        try {
            const user = this.client.user;
            return { ok: true, details: `${user?.username} (${this.client.guilds.cache.size} guilds)` };
        } catch (e: any) {
            return { ok: false, details: e.message };
        }
    }

    // ─── Private: Input Handlers ────────────────────────────────

    private registerHandlers(): void {
        this.client.once('ready', () => {
            log.info('ready', `Logged in as ${this.client.user?.tag}`);
        });

        this.client.on('messageCreate', async (message: Message) => {
            // Ignore bot messages
            if (message.author.bot) return;

            // Guild whitelist
            if (this.config.allowedGuildIds && this.config.allowedGuildIds.length > 0) {
                if (message.guild && !this.config.allowedGuildIds.includes(message.guild.id)) {
                    return;
                }
            }

            // User whitelist
            if (this.config.allowedUserIds && this.config.allowedUserIds.length > 0) {
                if (!this.config.allowedUserIds.includes(message.author.id)) {
                    return;
                }
            }

            // Determine message type
            let type: NormalizedMessage['type'] = 'text';
            let text = message.content || '';
            const attachments: ChannelAttachment[] = [];

            // Process Discord attachments
            if (message.attachments.size > 0) {
                for (const [, attachment] of message.attachments) {
                    const contentType = attachment.contentType || '';
                    
                    if (contentType.startsWith('image/')) {
                        type = 'photo';
                        attachments.push({
                            type: 'photo',
                            fileId: attachment.id,
                            url: attachment.url,
                            fileName: attachment.name || undefined,
                            width: attachment.width || undefined,
                            height: attachment.height || undefined,
                        });
                    } else if (contentType.startsWith('audio/')) {
                        type = 'audio';
                        attachments.push({
                            type: contentType.includes('ogg') || contentType.includes('opus') ? 'voice' : 'audio',
                            fileId: attachment.id,
                            url: attachment.url,
                            fileName: attachment.name || undefined,
                            mimeType: contentType,
                            duration: undefined,
                        });
                    } else {
                        type = 'document';
                        attachments.push({
                            type: 'document',
                            fileId: attachment.id,
                            url: attachment.url,
                            fileName: attachment.name || undefined,
                            mimeType: contentType || undefined,
                        });
                    }
                }
            }

            // If there are attachments but also text, set type to text
            // (MessageBus will handle both)
            if (attachments.length > 0 && text.trim().length > 0) {
                type = 'text'; // Text takes priority — attachments are supplementary
            }

            const msg: NormalizedMessage = {
                messageId: message.id,
                channel: 'discord',
                userId: message.author.id,
                userName: message.author.username,
                type,
                text,
                attachments: attachments.length > 0 ? attachments : undefined,
                replyToId: message.reference?.messageId || undefined,
                rawContext: message.channel,
                chatId: message.channelId,
                metadata: {
                    guildId: message.guildId,
                    channelId: message.channelId,
                    authorTag: message.author.tag,
                },
            };

            if (this.bus) {
                await this.bus.processMessage(msg);
            }
        });

        this.client.on('error', (error) => {
            log.error('client_error', error);
        });

        log.info('handlers_registered', 'Discord message handlers registered');
    }

    // ─── Private: Output Helpers ────────────────────────────────

    private async sendAttachment(channel: TextChannel, attachment: ResponseAttachment): Promise<void> {
        try {
            const fs = await import('fs');
            const filePath = typeof attachment.data === 'string' ? attachment.data : '';

            if (!filePath || !fs.existsSync(filePath)) {
                log.warn('attachment_not_found', `File not found: ${filePath}`);
                return;
            }

            const discordAttachment = new AttachmentBuilder(filePath, {
                name: attachment.fileName || undefined,
            });

            switch (attachment.type) {
                case 'audio':
                    await channel.send({ files: [discordAttachment] });
                    break;
                case 'document':
                    await channel.send({ files: [discordAttachment] });
                    break;
                case 'photo':
                    await channel.send({ files: [discordAttachment] });
                    break;
            }
        } catch (e: any) {
            log.error('attachment_send_failed', e);
        }
    }

    private splitIntoChunks(text: string, maxLength: number): string[] {
        const chunks: string[] = [];
        const lines = text.split('\n');
        let current = '';

        for (const line of lines) {
            if ((current + '\n' + line).length > maxLength) {
                if (current) chunks.push(current);
                current = line;
            } else {
                current = current ? current + '\n' + line : line;
            }
        }
        if (current) chunks.push(current);
        return chunks;
    }

    private stripHtml(text: string): string {
        return text
            .replace(/<b>(.*?)<\/b>/g, '**$1**')
            .replace(/<i>(.*?)<\/i>/g, '*$1*')
            .replace(/<code>(.*?)<\/code>/g, '`$1`')
            .replace(/<pre>(.*?)<\/pre>/g, '```\n$1\n```')
            .replace(/<[^>]+>/g, '')
            .trim();
    }
}