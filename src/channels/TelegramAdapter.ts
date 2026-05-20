/**
 * TelegramAdapter — ChannelAdapter completo para Telegram via grammY
 * 
 * Implementa a interface ChannelAdapter com entrada (text, photo, voice, document)
 * e saída (text, audio, document, chunking).
 * 
 * Todo input passa pelo MessageBus como NormalizedMessage.
 * Todo output recebe NormalizedResponse.
 */

import { Bot, Context, InputFile, InlineKeyboard } from 'grammy';
import { errorMessage } from '../shared/errors';
import {
    ChannelAdapter,
    ChannelType,
    TypingAction,
    NormalizedMessage,
    NormalizedResponse,
    ChannelConfig,
    ResponseAttachment
} from './ChannelAdapter';
import { MessageBus } from './MessageBus';
import { mdToTelegramHTML } from '../shared/TelegramFormatter';
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

/** Subset of Telegram Message fields used by this adapter */
type TelegramChatAction = "typing" | "upload_photo" | "record_video" | "record_voice" | "upload_document" | "upload_video" | "upload_voice" | "choose_sticker" | "find_location" | "record_video_note" | "upload_video_note";

interface TelegramMsg {
    photo?: Array<{ file_id: string; width?: number; height?: number }>;
    audio?: { file_id: string; file_name?: string; duration?: number; file_size?: number; mime_type?: string };
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
    caption?: string;
    [key: string]: unknown;
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

    /** Baixar arquivo do Telegram por fileId (token confinado ao adapter) */
    async downloadFile(fileId: string): Promise<Buffer> {
        const file = await this.bot.api.getFile(fileId);
        if (!file.file_path) throw new Error(`File path not available for fileId=${fileId}`);
        const response = await fetch(
            `https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`,
            { signal: AbortSignal.timeout(180_000) }
        );
        if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
        return Buffer.from(await response.arrayBuffer());
    }

    /** Enviar voz (com fallback para audio) via API do grammY */
    async sendVoice(chatId: string, buffer: Buffer, filename: string = 'voice.ogg'): Promise<void> {
        try {
            await this.bot.api.sendVoice(chatId, new InputFile(buffer, filename));
        } catch (e) {
            log.warn('send_voice_fallback_audio', errorMessage(e));
            await this.bot.api.sendAudio(chatId, new InputFile(buffer, filename));
        }
    }

    /** Enviar documento via API do grammY */
    async sendDocument(chatId: string, buffer: Buffer, filename: string, caption?: string): Promise<void> {
        await this.bot.api.sendDocument(
            chatId,
            new InputFile(buffer, filename),
            caption ? { caption: caption.slice(0, 1024) } : undefined
        );
    }

    private started: boolean = false;
    private startRetries: number = 0;
    private maxStartRetries: number = 5;
    private networkRetryCount: number = 0;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private handlersRegistered: boolean = false;
    /** Track how long the bot stayed connected — if < 30s, it's likely 409 conflict */
    private botConnectedAt: number = 0;
    private static readonly STABLE_CONNECTION_MS = 30_000;

    async start(): Promise<void> {
        if (!this.config.enabled) {
            log.info('adapter_disabled', 'Telegram adapter is disabled');
            return;
        }

        if (this.started && this._isConnected) {
            log.warn('adapter_already_started', 'Telegram adapter already started and connected');
            return;
        }

        // Pre-check: kill any stale bot instances that would cause 409 Conflict
        // This happens when the process was restarted but the old polling loop is still active
        try {
            // Delete webhook to ensure polling mode works
            await this.bot.api.deleteWebhook({ drop_pending_updates: true });
        } catch (e) {
            log.warn('delete_webhook_failed', errorMessage(e));
        }

        // Grace period: give Telegram time to release the old polling connection
        // This is critical during restarts — the old process may still be dying
        const gracePeriod = parseInt(process.env.TELEGRAM_START_GRACE_MS || '3000', 10);
        if (gracePeriod > 0) {
            log.info('startup_grace_period', `Waiting ${gracePeriod}ms for old instance to release...`);
            await new Promise(r => setTimeout(r, gracePeriod));
        }

        // Register handlers ONCE — grammY throws if handlers are registered multiple times
        if (!this.handlersRegistered) {
            this.registerHandlers();
            this.handlersRegistered = true;
        }
        this.started = true;

        try {
            log.info('bot_starting', 'Iniciando polling do Telegram...');
            const pollingInfo = await this.bot.api.getMe();
            log.info('bot_api_check', `getMe OK: id=${pollingInfo.id} username=${pollingInfo.username}`);
            await this.bot.start({
                onStart: (info) => {
                    this._isConnected = true;
                    this.botConnectedAt = Date.now();
                    this.networkRetryCount = 0; // Reset network retries on success
                    log.info('bot_started', `🤖 Telegram Bot rodando! botInfo=${JSON.stringify(info).slice(0, 100)}`);
                },
            });
            // If we reach here, bot.start() resolved (meaning bot was stopped)
            const uptimeMs = this.botConnectedAt ? Date.now() - this.botConnectedAt : 0;
            const wasStable = uptimeMs > TelegramAdapter.STABLE_CONNECTION_MS;
            if (wasStable) {
                // Bot ran for a while then stopped normally — reset retries
                this.startRetries = 0;
            }
            log.warn('bot_start_resolved', `bot.start() resolved unexpectedly — bot was stopped (uptime=${uptimeMs}ms, stable=${wasStable})`);
        } catch (e) {
            if (errorMessage(e)?.includes('409') || errorMessage(e)?.includes('Conflict')) {
                this.startRetries++;
                log.error('bot_start_409_conflict', `Multiple bot instances detected (attempt ${this.startRetries}/${this.maxStartRetries}). Waiting for old instance to stop...`);
                if (this.startRetries <= this.maxStartRetries) {
                    const delay = Math.min(this.startRetries * 20, 120); // 20s, 40s, 60s, 80s, 100s, 120s max
                    log.info('bot_start_retry', `Retry ${this.startRetries}/${this.maxStartRetries} in ${delay}s...`);
                    this.started = false;
                    this._isConnected = false;
                    await new Promise(r => setTimeout(r, delay * 1000));
                    return this.start();
                }
                log.error('bot_start_409_exhausted', 'All retries exhausted. Another bot instance is still running.');
                // Schedule background retry instead of giving up completely
                this.scheduleReconnect(30);
                return;
            }
            // Network errors — schedule background retry instead of crashing
            if (errorMessage(e)?.includes('Network') || errorMessage(e)?.includes('ECONNREFUSED') ||
                errorMessage(e)?.includes('ENOTFOUND') || errorMessage(e)?.includes('ETIMEDOUT') ||
                errorMessage(e)?.includes('fetch failed') || errorMessage(e)?.includes('request failed')) {
                this.networkRetryCount++;
                const delay = Math.min(this.networkRetryCount * 10, 300); // 10s, 20s, 30s... max 5min
                log.error('bot_start_network_error', `Network error on start (attempt ${this.networkRetryCount}). Scheduling reconnect in ${delay}s...`, errorMessage(e));
                this.scheduleReconnect(delay);
                return;
            }
            throw e;
        }
    }

    /** Schedule a background reconnect attempt */
    private scheduleReconnect(delaySeconds: number): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }
        log.info('reconnect_scheduled', `Reconnect attempt scheduled in ${delaySeconds}s`);
        this.reconnectTimer = setTimeout(async () => {
            log.info('reconnect_attempt', 'Attempting to reconnect Telegram bot...');
            this.started = false;
            this._isConnected = false;
            this.startRetries = 0;
            try {
                await this.start();
            } catch (e) {
                log.error('reconnect_failed', 'Reconnect attempt failed', errorMessage(e));
            }
        }, delaySeconds * 1000);
    }

    async stop(): Promise<void> {
        // Cancel any pending reconnect
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        // Graceful shutdown: tell Telegram to drop the polling connection
        // BEFORE stopping grammY, so the 409 Conflict window is minimized
        try {
            await this.bot.api.deleteWebhook({ drop_pending_updates: true });
            log.info('webhook_dropped', 'Dropped pending updates before stop');
        } catch (e) {
            log.warn('drop_webhook_on_stop_failed', errorMessage(e));
        }

        // Give Telegram a moment to process the drop
        await new Promise(r => setTimeout(r, 2000));

        this.bot.stop();
        this._isConnected = false;
        this.started = false;
        log.info('bot_stopped', 'Telegram Bot stopped gracefully');
    }

    /** Enviar resposta normalizada via Telegram */
    async send(response: NormalizedResponse, context: unknown): Promise<void> {
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
                const keyboard = response.options ? new InlineKeyboard() : undefined;
                if (keyboard && response.options) {
                    response.options.forEach(opt => {
                        keyboard.text(opt.label, opt.value).row();
                    });
                }

                if (html.length <= maxLen) {
                    try {
                        await ctx.reply(html, { parse_mode: 'HTML', reply_markup: keyboard });
                    } catch {
                        await ctx.reply(response.text, { reply_markup: keyboard });
                    }
                } else {
                    const chunks = this.splitIntoChunks(html, maxLen);
                    for (let i = 0; i < chunks.length; i++) {
                        const isLast = i === chunks.length - 1;
                        try {
                            await ctx.reply(chunks[i], { 
                                parse_mode: 'HTML', 
                                reply_markup: isLast ? keyboard : undefined 
                            });
                        } catch {
                            await ctx.reply(chunks[i], { 
                                reply_markup: isLast ? keyboard : undefined 
                            });
                        }
                        await new Promise(r => setTimeout(r, 100));
                    }
                }
            } else {
                // Plain text
                const keyboard = response.options ? new InlineKeyboard() : undefined;
                if (keyboard && response.options) {
                    response.options.forEach(opt => {
                        keyboard.text(opt.label, opt.value).row();
                    });
                }

                if (response.text.length <= maxLen) {
                    await ctx.reply(response.text, { reply_markup: keyboard });
                } else {
                    const chunks = this.splitIntoChunks(response.text, maxLen);
                    for (let i = 0; i < chunks.length; i++) {
                        const isLast = i === chunks.length - 1;
                        await ctx.reply(chunks[i], { 
                            reply_markup: isLast ? keyboard : undefined 
                        });
                        await new Promise(r => setTimeout(r, 100));
                    }
                }
            }

            // Send reactions
            if (response.reactions && response.reactions.length > 0) {
                // Telegram doesn't natively support reactions in the same way
                // Skip for now — future: use setMessageReaction if available
            }
        } catch (e) {
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
        } catch (e) {
            log.error('send_to_chat_failed', e);
        }
    }

    async healthCheck(): Promise<{ ok: boolean; details?: string }> {
        try {
            const me = await this.bot.api.getMe();
            return { ok: true, details: `@${me.username} (${me.first_name})` };
        } catch (e) {
            return { ok: false, details: errorMessage(e) };
        }
    }

    /** Enviar indicador de digitação ("typing...") no Telegram */
    async sendTypingIndicator(context: unknown, action: TypingAction = 'typing'): Promise<void> {
        try {
            const ctx = context as Context;
            if (!ctx) return;
            const chatAction = action === 'typing' ? 'typing'
                : action === 'upload_photo' ? 'upload_photo'
                : action === 'record_video' ? 'record_video'
                : action === 'record_voice' ? 'record_voice'
                : action === 'upload_document' ? 'upload_document'
                : 'typing';
            await ctx.replyWithChatAction(chatAction as TelegramChatAction);
        } catch {
            // Silently fail — typing indicator is best-effort
        }
    }

    // ─── Private: Input Handlers ────────────────────────────────

    private registerHandlers(): void {
        // ── Debug middleware: log every incoming update ──
        // ── Global error handler ──
        this.bot.catch((err) => {
            log.error('bot_error', err instanceof Error ? err : undefined, String(err));
        });

        // ── Debug middleware: log every incoming update ──
        this.bot.use(async (ctx, next) => {
            log.info('update_received', `update_id=${ctx.update.update_id} type=${Object.keys(ctx.update).filter(k => k !== 'update_id').join(',')}`);
            return next();
        });

        // Text messages (including commands) — fire-and-forget so grammY stays responsive.
        // This allows /cancel to be processed immediately even while a turn is running.
        this.bot.on('message:text', (ctx) => {
            const userId = ctx.from!.id.toString();
            log.info('text_message_received', `userId=${userId} text="${ctx.message?.text?.slice(0, 50)}"`);
            if (!this.config.allowedUserIds.includes(userId)) {
                log.info('unauthorized', `Usuário não autorizado: ${userId}`);
                return;
            }

            const text = ctx.message!.text!;
            const msg: NormalizedMessage = {
                messageId: ctx.message!.message_id.toString(),
                channel: 'telegram',
                userId,
                userName: ctx.from!.first_name,
                type: text.startsWith('/') ? 'command' : 'text',
                text,
                rawContext: ctx,
                chatId: ctx.chat!.id.toString(),
                metadata: {},
            };

            if (this.bus) {
                this.bus.processMessage(msg).catch(err =>
                    log.error('process_message_error', err instanceof Error ? err : undefined, String(err))
                );
            }
        });

        // Photos
        this.bot.on('message:photo', async (ctx) => {
            const userId = ctx.from!.id.toString();
            if (!this.config.allowedUserIds.includes(userId)) return;

            const photos = (ctx.message as unknown as TelegramMsg)?.photo;
            if (!photos || photos.length === 0) return;
            const photo = photos[photos.length - 1];

            const msg: NormalizedMessage = {
                messageId: ctx.message!.message_id.toString(),
                channel: 'telegram',
                userId,
                userName: ctx.from!.first_name,
                type: 'photo',
                text: (ctx.message as unknown as TelegramMsg)?.caption || '',
                attachments: [{
                    type: 'photo',
                    fileId: photo.file_id,
                    width: photo.width,
                    height: photo.height,
                }],
                rawContext: ctx,
                chatId: ctx.chat!.id.toString(),
                metadata: {},
            };

            if (this.bus) {
                this.bus.processMessage(msg).catch(err =>
                    log.error('process_message_error', err instanceof Error ? err : undefined, String(err))
                );
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
                metadata: {},
            };

            if (this.bus) {
                this.bus.processMessage(msg).catch(err =>
                    log.error('process_message_error', err instanceof Error ? err : undefined, String(err))
                );
            }
        });

        // Audio files
        this.bot.on('message:audio', async (ctx) => {
            const userId = ctx.from!.id.toString();
            log.info('audio_received', `userId=${userId} file=${(ctx.message as unknown as TelegramMsg)?.audio?.file_name}`);
            if (!this.config.allowedUserIds.includes(userId)) return;

            const audio = (ctx.message as unknown as TelegramMsg)?.audio;
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
                metadata: {},
            };

            if (this.bus) {
                this.bus.processMessage(msg).catch(err =>
                    log.error('process_message_error', err instanceof Error ? err : undefined, String(err))
                );
            }
        });

        // Documents
        this.bot.on('message:document', async (ctx) => {
            // ... (keeping existing logic)
            const userId = ctx.from!.id.toString();
            if (!this.config.allowedUserIds.includes(userId)) return;

            const doc = (ctx.message as unknown as TelegramMsg)?.document;
            if (!doc) return;

            const msg: NormalizedMessage = {
                messageId: ctx.message!.message_id.toString(),
                channel: 'telegram',
                userId,
                userName: ctx.from!.first_name,
                type: 'document',
                text: (ctx.message as unknown as TelegramMsg)?.caption || '',
                attachments: [{
                    type: 'document',
                    fileId: doc.file_id,
                    fileName: doc.file_name,
                    mimeType: doc.mime_type,
                }],
                rawContext: ctx,
                chatId: ctx.chat!.id.toString(),
                metadata: {},
            };

            if (this.bus) {
                this.bus.processMessage(msg).catch(err =>
                    log.error('process_message_error', err instanceof Error ? err : undefined, String(err))
                );
            }
        });

        // Callback queries (Button clicks)
        this.bot.on('callback_query:data', async (ctx) => {
            const userId = ctx.from.id.toString();
            if (!this.config.allowedUserIds.includes(userId)) return;

            const data = ctx.callbackQuery.data;
            log.info('callback_received', `userId=${userId} data="${data}"`);

            // Answer callback to remove loading state
            await ctx.answerCallbackQuery().catch(() => {});

            // Optional: Edit message to remove buttons or show selection
            // await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});

            const msg: NormalizedMessage = {
                messageId: `cb_${ctx.callbackQuery.id}`,
                channel: 'telegram',
                userId,
                userName: ctx.from.first_name,
                type: 'text',
                text: data, // Treat button value as text input
                rawContext: ctx,
                chatId: ctx.chat?.id.toString() || userId,
                metadata: { isCallback: true },
            };

            if (this.bus) {
                this.bus.processMessage(msg).catch(err =>
                    log.error('process_message_error', err instanceof Error ? err : undefined, String(err))
                );
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
        } catch (e) {
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