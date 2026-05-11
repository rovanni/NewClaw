/**
 * TelegramAdapter — ChannelAdapter completo para Telegram via grammY
 * 
 * Implementa a interface ChannelAdapter com entrada (text, photo, voice, document)
 * e saída (text, audio, document, chunking).
 * 
 * Todo input passa pelo MessageBus como NormalizedMessage.
 * Todo output recebe NormalizedResponse.
 */

import { Bot, Context, InputFile } from 'grammy';
import {
    ChannelAdapter,
    ChannelType,
    TypingAction,
    NormalizedMessage,
    NormalizedResponse,
    ChannelConfig,
    ChannelAttachment,
    ResponseAttachment
} from './ChannelAdapter';
import { MessageBus } from './MessageBus';
import { mdToTelegramHTML, safeReply } from '../shared/TelegramFormatter';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('TelegramAdapter');

export interface TelegramConfig extends ChannelConfig {
    botToken: string;
    allowedUserIds: string[];
    /** Whisper config for voice transcription */
    whisperApiUrl?: string;
    whisperApiFallback?: string;
    whisperPath?: string;
    whisperModel?: string;
    tmpDir?: string;
    /** TTS config */
    audioVoice?: string;
    audioRate?: string;
}

export class TelegramAdapter implements ChannelAdapter {
    readonly channelType: ChannelType = 'telegram';
    readonly displayName: string = 'Telegram';
    private _isConnected: boolean = false;

    private bot: Bot;
    private config: TelegramConfig;
    private bus: MessageBus | null = null;

    constructor(config: TelegramConfig) {
        this.config = {
            whisperApiUrl: process.env.WHISPER_API_URL || 'http://localhost:8177',
            whisperApiFallback: process.env.WHISPER_API_FALLBACK || '',
            whisperPath: process.env.WHISPER_PATH || '/usr/local/bin/whisper',
            whisperModel: process.env.WHISPER_MODEL || 'tiny',
            tmpDir: './tmp',
            audioVoice: 'pt-BR-AntonioNeural',
            audioRate: '+0%',
            ...config
        };
        this.bot = new Bot(config.botToken);
    }

    get isConnected(): boolean {
        return this._isConnected;
    }

    /** Get grammy Bot instance (for scheduler, etc.) */
    getBot(): Bot {
        return this.bot;
    }

    /** Conectar ao MessageBus */
    setBus(bus: MessageBus): void {
        this.bus = bus;
    }

    /** Retornar o token do bot */
    getBotToken(): string {
        return this.config.botToken;
    }

    private started: boolean = false;
    private startRetries: number = 0;
    private maxStartRetries: number = 3;
    private handlersRegistered: boolean = false;

    async start(): Promise<void> {
        if (!this.config.enabled) {
            log.info('adapter_disabled', 'Telegram adapter is disabled');
            return;
        }

        if (this.started) {
            log.warn('adapter_already_started', 'Telegram adapter already started');
            return;
        }

        // Pre-check: kill any stale bot instances that would cause 409 Conflict
        // This happens when the process was restarted but the old polling loop is still active
        try {
            // Delete webhook to ensure polling mode works
            await this.bot.api.deleteWebhook({ drop_pending_updates: true });
        } catch (e: any) {
            log.warn('delete_webhook_failed', e.message);
        }

        // Register handlers ONCE — grammY throws if handlers are registered multiple times
        if (!this.handlersRegistered) {
            this.registerHandlers();
            this.handlersRegistered = true;
        }
        this.started = true;

        try {
            log.info('bot_starting', 'Iniciando polling do Telegram...');
            await this.bot.start({
                onStart: (info) => {
                    this._isConnected = true;
                    this.startRetries = 0; // Reset on success
                    log.info('bot_started', `🤖 Telegram Bot rodando! botInfo=${JSON.stringify(info).slice(0, 100)}`);
                },
                allowed_updates: ['message']
            });
            // If we reach here, bot.start() resolved (meaning bot was stopped)
            log.warn('bot_start_resolved', 'bot.start() resolved unexpectedly — bot was stopped');
        } catch (e: any) {
            if (e.message?.includes('409') || e.message?.includes('Conflict')) {
                log.error('bot_start_409_conflict', 'Multiple bot instances detected. Waiting for old instance to stop...');
                // Wait and retry — the old instance should time out within ~30s
                if (this.startRetries < this.maxStartRetries) {
                    this.startRetries++;
                    const delay = this.startRetries * 15000; // 15s, 30s, 45s
                    log.info('bot_start_retry', `Retry ${this.startRetries}/${this.maxStartRetries} in ${delay/1000}s...`);
                    this.started = false; // Allow re-entry
                    await new Promise(r => setTimeout(r, delay));
                    return this.start();
                }
                log.error('bot_start_409_exhausted', 'All retries exhausted. Another bot instance is still running.');
            }
            throw e;
        }
    }

    async stop(): Promise<void> {
        this.bot.stop();
        this._isConnected = false;
        log.info('bot_stopped', 'Telegram Bot stopped');
    }

    /** Enviar resposta normalizada via Telegram */
    async send(response: NormalizedResponse, context: any): Promise<void> {
        const ctx = context as Context;
        if (!ctx) return;

        // Send attachments first (audio, documents)
        if (response.attachments && response.attachments.length > 0) {
            for (const attachment of response.attachments) {
                await this.sendAttachment(ctx, attachment);
            }
        }

        // Send text
        if (!response.text || response.text.trim().length === 0) return;

        // Skip media confirmation messages
        const isMediaConfirmation = /^🔊 (Áudio|Arquivo|Documento) enviado/i.test(response.text.trim());
        if (isMediaConfirmation) return;

        const maxLen = 4096;

        try {
            // Handle format
            if (response.format === 'markdown' || response.format === 'html') {
                const html = mdToTelegramHTML(response.text);
                if (html.length <= maxLen) {
                    try {
                        await ctx.reply(html, { parse_mode: 'HTML' });
                    } catch {
                        await ctx.reply(response.text);
                    }
                } else {
                    const chunks = this.splitIntoChunks(html, maxLen);
                    for (const chunk of chunks) {
                        try {
                            await ctx.reply(chunk, { parse_mode: 'HTML' });
                        } catch {
                            await ctx.reply(chunk);
                        }
                        await new Promise(r => setTimeout(r, 100));
                    }
                }
            } else {
                // Plain text
                if (response.text.length <= maxLen) {
                    await ctx.reply(response.text);
                } else {
                    const chunks = this.splitIntoChunks(response.text, maxLen);
                    for (const chunk of chunks) {
                        await ctx.reply(chunk);
                        await new Promise(r => setTimeout(r, 100));
                    }
                }
            }

            // Send reactions
            if (response.reactions && response.reactions.length > 0) {
                // Telegram doesn't natively support reactions in the same way
                // Skip for now — future: use setMessageReaction if available
            }
        } catch (e: any) {
            log.error('send_failed', e);
        }
    }

    /** Enviar para chatId específico (scheduler, etc.) */
    async sendToChat(chatId: string | number, response: NormalizedResponse): Promise<void> {
        const maxLen = 4096;
        const text = response.format === 'markdown'
            ? mdToTelegramHTML(response.text)
            : response.text;

        try {
            if (text.length <= maxLen) {
                try {
                    await this.bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' });
                } catch {
                    await this.bot.api.sendMessage(chatId, response.text);
                }
            } else {
                const chunks = this.splitIntoChunks(text, maxLen);
                for (const chunk of chunks) {
                    try {
                        await this.bot.api.sendMessage(chatId, chunk, { parse_mode: 'HTML' });
                    } catch {
                        await this.bot.api.sendMessage(chatId, chunk);
                    }
                    await new Promise(r => setTimeout(r, 100));
                }
            }
        } catch (e: any) {
            log.error('send_to_chat_failed', e);
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

    /** Enviar indicador de digitação ("typing...") no Telegram */
    async sendTypingIndicator(context: any, action: TypingAction = 'typing'): Promise<void> {
        try {
            const ctx = context as Context;
            if (!ctx) return;
            const chatAction = action === 'typing' ? 'typing'
                : action === 'upload_photo' ? 'upload_photo'
                : action === 'record_video' ? 'record_video'
                : action === 'record_voice' ? 'record_voice'
                : action === 'upload_document' ? 'upload_document'
                : 'typing';
            await ctx.replyWithChatAction(chatAction as any);
        } catch {
            // Silently fail — typing indicator is best-effort
        }
    }

    // ─── Private: Input Handlers ────────────────────────────────

    private registerHandlers(): void {
        // Text messages
        this.bot.on('message:text', async (ctx) => {
            const userId = ctx.from!.id.toString();
            log.info('text_message_received', `userId=${userId} text="${ctx.message?.text?.slice(0, 50)}"`);
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
                rawContext: ctx,
                chatId: ctx.chat!.id.toString(),
                metadata: { botToken: this.config.botToken },
            };

            if (this.bus) {
                await this.bus.processMessage(msg);
            }
        });

        // Commands
        this.bot.on('message', async (ctx) => {
            const userId = ctx.from!.id.toString();
            log.info('generic_message_received', `userId=${userId} type=${ctx.message?.text ? 'text' : 'other'} has_voice=${!!ctx.message?.voice} has_audio=${!!(ctx.message as any)?.audio}`);
            const text = ctx.message?.text;
            if (!text || !text.startsWith('/')) return;

            if (!this.config.allowedUserIds.includes(userId)) return;

            const msg: NormalizedMessage = {
                messageId: ctx.message!.message_id.toString(),
                channel: 'telegram',
                userId,
                userName: ctx.from!.first_name,
                type: 'command',
                text,
                rawContext: ctx,
                chatId: ctx.chat!.id.toString(),
                metadata: { botToken: this.config.botToken },
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

            const msg: NormalizedMessage = {
                messageId: ctx.message!.message_id.toString(),
                channel: 'telegram',
                userId,
                userName: ctx.from!.first_name,
                type: 'photo',
                text: (ctx.message as any)?.caption || '',
                attachments: [{
                    type: 'photo',
                    fileId: photo.file_id,
                    width: photo.width,
                    height: photo.height,
                }],
                rawContext: ctx,
                chatId: ctx.chat!.id.toString(),
                metadata: { botToken: this.config.botToken },
            };

            if (this.bus) {
                await this.bus.processMessage(msg);
            }
        });

        // Voice
        this.bot.on('message:voice', async (ctx) => {
            const userId = ctx.from!.id.toString();
            log.info('voice_received', `userId=${userId} duration=${ctx.message!.voice?.duration}s`);
            if (!this.config.allowedUserIds.includes(userId)) return;

            const voice = ctx.message!.voice!;
            const msg: NormalizedMessage = {
                messageId: ctx.message!.message_id.toString(),
                channel: 'telegram',
                userId,
                userName: ctx.from!.first_name,
                type: 'voice',
                text: '',
                attachments: [{
                    type: 'voice',
                    fileId: voice.file_id,
                    duration: voice.duration,
                    mimeType: voice.mime_type,
                }],
                rawContext: ctx,
                chatId: ctx.chat!.id.toString(),
                metadata: { botToken: this.config.botToken },
            };

            if (this.bus) {
                await this.bus.processMessage(msg);
            }
        });

        // Audio files
        this.bot.on('message:audio', async (ctx) => {
            const userId = ctx.from!.id.toString();
            log.info('audio_received', `userId=${userId} file=${(ctx.message as any)?.audio?.file_name}`);
            if (!this.config.allowedUserIds.includes(userId)) return;

            const audio = (ctx.message as any)?.audio;
            if (!audio) return;

            const msg: NormalizedMessage = {
                messageId: ctx.message!.message_id.toString(),
                channel: 'telegram',
                userId,
                userName: ctx.from!.first_name,
                type: 'audio',
                text: '',
                attachments: [{
                    type: 'audio',
                    fileId: audio.file_id,
                    duration: audio.duration,
                    fileName: audio.file_name,
                    mimeType: audio.mime_type,
                }],
                rawContext: ctx,
                chatId: ctx.chat!.id.toString(),
                metadata: { botToken: this.config.botToken },
            };

            if (this.bus) {
                await this.bus.processMessage(msg);
            }
        });

        // Documents
        this.bot.on('message:document', async (ctx) => {
            const userId = ctx.from!.id.toString();
            if (!this.config.allowedUserIds.includes(userId)) return;

            const doc = (ctx.message as any)?.document;
            if (!doc) return;

            const msg: NormalizedMessage = {
                messageId: ctx.message!.message_id.toString(),
                channel: 'telegram',
                userId,
                userName: ctx.from!.first_name,
                type: 'document',
                text: (ctx.message as any)?.caption || '',
                attachments: [{
                    type: 'document',
                    fileId: doc.file_id,
                    fileName: doc.file_name,
                    mimeType: doc.mime_type,
                }],
                rawContext: ctx,
                chatId: ctx.chat!.id.toString(),
                metadata: { botToken: this.config.botToken },
            };

            if (this.bus) {
                await this.bus.processMessage(msg);
            }
        });

        log.info('handlers_registered', 'Telegram message handlers registered');
    }

    // ─── Private: Output Helpers ────────────────────────────────

    private async sendAttachment(ctx: Context, attachment: ResponseAttachment): Promise<void> {
        try {
            switch (attachment.type) {
                case 'audio': {
                    const filePath = typeof attachment.data === 'string' ? attachment.data : '';
                    if (filePath) {
                        const fs = await import('fs');
                        if (fs.existsSync(filePath)) {
                            await ctx.replyWithVoice(new InputFile(filePath));
                        }
                    }
                    break;
                }
                case 'document': {
                    const filePath = typeof attachment.data === 'string' ? attachment.data : '';
                    if (filePath) {
                        const fs = await import('fs');
                        if (fs.existsSync(filePath)) {
                            await ctx.replyWithDocument(new InputFile(filePath, attachment.fileName || 'document'));
                        }
                    }
                    break;
                }
                case 'photo': {
                    const filePath = typeof attachment.data === 'string' ? attachment.data : '';
                    if (filePath) {
                        const fs = await import('fs');
                        if (fs.existsSync(filePath)) {
                            await ctx.replyWithPhoto(new InputFile(filePath));
                        }
                    }
                    break;
                }
            }
        } catch (e: any) {
            log.error('attachment_send_failed', e);
        }
    }

    private splitIntoChunks(text: string, maxLength: number): string[] {
        const chunks: string[] = [];
        const lines = text.split('\n');
        let current = '';
        let insidePre = false;

        for (const line of lines) {
            // Track <pre> block boundaries to avoid splitting mid-code
            const preOpenCount = (line.match(/<pre>/g) || []).length;
            const preCloseCount = (line.match(/<\/pre>/g) || []).length;
            const wouldBreakPre = insidePre;
            insidePre = insidePre ? (preCloseCount === 0) : (preOpenCount > preCloseCount);

            const wouldOverflow = (current + '\n' + line).length > maxLength;

            if (wouldOverflow && !wouldBreakPre) {
                // Safe to split here — not inside a <pre> block
                if (current) chunks.push(current);
                current = line;
            } else if (wouldOverflow && wouldBreakPre) {
                // Inside <pre> — force include the line to keep code intact
                // If current chunk + line exceeds limit by a lot, we have no choice but to split
                if (current.length > 0 && (current + '\n' + line).length > maxLength * 1.5) {
                    // Close the <pre> in current chunk, open new <pre> in next
                    current += '\n</pre>';
                    chunks.push(current);
                    current = '<pre>' + line;
                    insidePre = true;
                } else {
                    current = current ? current + '\n' + line : line;
                }
            } else {
                current = current ? current + '\n' + line : line;
            }
        }
        if (current) chunks.push(current);
        return chunks;
    }
}