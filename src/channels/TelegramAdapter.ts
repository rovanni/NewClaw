/**
 * TelegramAdapter — ChannelAdapter para Telegram via grammY
 * 
 * Implementa a interface ChannelAdapter para que o Telegram
 * funcione como mais um canal no MessageBus do NewClaw.
 */

import { Bot, Context } from 'grammy';
import {
    ChannelAdapter,
    ChannelType,
    NormalizedMessage,
    NormalizedResponse,
    ChannelConfig,
    ChannelAttachment
} from './ChannelAdapter';
import { MessageBus } from './MessageBus';
import { mdToTelegramHTML } from '../shared/TelegramFormatter';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('TelegramAdapter');

export interface TelegramConfig extends ChannelConfig {
    botToken: string;
    allowedUserIds: string[];
    /** Custom handlers for media (delegated from TelegramInputHandler) */
    onPhoto?: (ctx: Context, attachment: ChannelAttachment) => Promise<void>;
    onAudio?: (ctx: Context, attachment: ChannelAttachment) => Promise<void>;
    onDocument?: (ctx: Context, attachment: ChannelAttachment) => Promise<void>;
}

export class TelegramAdapter implements ChannelAdapter {
    readonly channelType: ChannelType = 'telegram';
    readonly displayName: string = 'Telegram';
    private _isConnected: boolean = false;

    private bot: Bot;
    private config: TelegramConfig;
    private bus: MessageBus | null = null;

    constructor(config: TelegramConfig) {
        this.config = config;
        this.bot = new Bot(config.botToken);
    }

    get isConnected(): boolean {
        return this._isConnected;
    }

    /** Conectar ao MessageBus */
    setBus(bus: MessageBus): void {
        this.bus = bus;
    }

    async start(): Promise<void> {
        if (!this.config.enabled) {
            log.info('adapter_disabled', 'Telegram adapter is disabled');
            return;
        }

        // Register message handlers
        this.registerHandlers();

        // Start bot
        await this.bot.start({
            onStart: () => {
                this._isConnected = true;
                log.info('bot_started', '🤖 Telegram Bot rodando!');
            },
            allowed_updates: ['message']
        });
    }

    async stop(): Promise<void> {
        this.bot.stop();
        this._isConnected = false;
        log.info('bot_stopped', 'Telegram Bot stopped');
    }

    /** Enviar resposta via Telegram */
    async send(response: NormalizedResponse, context: any): Promise<void> {
        const ctx = context as Context;
        if (!ctx) return;

        const maxLen = 4096;
        const text = response.format === 'markdown' 
            ? mdToTelegramHTML(response.text)
            : response.text;

        try {
            if (text.length <= maxLen) {
                await ctx.reply(text, { parse_mode: 'HTML' });
            } else {
                // Chunk long messages
                const chunks = this.splitIntoChunks(text, maxLen);
                for (const chunk of chunks) {
                    try {
                        await ctx.reply(chunk, { parse_mode: 'HTML' });
                    } catch {
                        await ctx.reply(chunk);
                    }
                    await new Promise(r => setTimeout(r, 100));
                }
            }
        } catch {
            // Fallback to plain text
            try {
                await ctx.reply(response.text);
            } catch (e: any) {
                log.error('send_failed', e);
            }
        }
    }

    async healthCheck(): Promise<{ ok: boolean; details?: string }> {
        try {
            const me = await this.bot.api.getMe();
            return { ok: true, details: `@${me.username} (${me.first_name})` };
        } catch (e: any) {
            return { ok: false, details: e.message };
        }
    }

    /** Registrar handlers de mensagem do Telegram */
    private registerHandlers(): void {
        // Text messages
        this.bot.on('message:text', async (ctx) => {
            const userId = ctx.from!.id.toString();
            if (!this.config.allowedUserIds.includes(userId)) {
                log.info('unauthorized', `Usuário não autorizado: ${userId}`);
                return;
            }

            const msg: NormalizedMessage = {
                messageId: ctx.message!.message_id.toString(),
                channel: 'telegram',
                userId,
                userName: ctx.from!.first_name,
                type: 'text',
                text: ctx.message!.text!,
                metadata: {
                    botToken: this.config.botToken,
                    handlePhoto: this.config.onPhoto,
                    handleAudio: this.config.onAudio,
                    handleDocument: this.config.onDocument,
                },
                rawContext: ctx,
            };

            if (this.bus) {
                await this.bus.processMessage(msg);
            }
        });

        // Photos
        this.bot.on('message:photo', async (ctx) => {
            const userId = ctx.from!.id.toString();
            if (!this.config.allowedUserIds.includes(userId)) return;

            const photos = (ctx.message as any)?.photo;
            if (!photos || photos.length === 0) return;
            const photo = photos[photos.length - 1];

            if (this.config.onPhoto) {
                await this.config.onPhoto(ctx, {
                    type: 'photo',
                    fileId: photo.file_id,
                    width: photo.width,
                    height: photo.height,
                });
            }
        });

        // Voice/Audio
        this.bot.on('message:voice', async (ctx) => {
            const userId = ctx.from!.id.toString();
            if (!this.config.allowedUserIds.includes(userId)) return;

            if (this.config.onAudio) {
                const voice = ctx.message!.voice!;
                await this.config.onAudio(ctx, {
                    type: 'voice',
                    fileId: voice.file_id,
                    duration: voice.duration,
                    mimeType: voice.mime_type,
                });
            }
        });

        // Documents
        this.bot.on('message:document', async (ctx) => {
            const userId = ctx.from!.id.toString();
            if (!this.config.allowedUserIds.includes(userId)) return;

            if (this.config.onDocument) {
                const doc = (ctx.message as any)?.document;
                await this.config.onDocument(ctx, {
                    type: 'document',
                    fileId: doc.file_id,
                    fileName: doc.file_name,
                    mimeType: doc.mime_type,
                });
            }
        });

        log.info('handlers_registered', 'Telegram message handlers registered');
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
}