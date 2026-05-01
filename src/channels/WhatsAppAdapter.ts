/**
 * WhatsAppAdapter — ChannelAdapter para WhatsApp via Baileys
 * 
 * Implementa a interface ChannelAdapter para que o WhatsApp
 * funcione como canal no MessageBus do NewClaw.
 * 
 * Usa @whiskeysockets/baileys (multi-device WhatsApp Web API).
 * Autenticação via QR code ou pairing code.
 */

import {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    type WASocket,
    type proto,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
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
import PQueue from 'p-queue';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';

const log = createLogger('WhatsAppAdapter');

export interface WhatsAppConfig extends ChannelConfig {
    /** Session auth directory */
    authDir?: string;
    /** Phone number for pairing (e.g., '5511999999999') */
    phoneNumber?: string;
    /** Allowed JIDs (e.g., ['5511999999999@s.whatsapp.net']) — empty = all contacts */
    allowedJids?: string[];
    /** Browser to emulate */
    browser?: string;
}

export class WhatsAppAdapter implements ChannelAdapter {
    readonly channelType: ChannelType = 'whatsapp';
    readonly displayName: string = 'WhatsApp';
    private _isConnected: boolean = false;

    private config: WhatsAppConfig;
    private bus: MessageBus | null = null;
    private sock: WASocket | null = null;
    private sendQueue: PQueue;
    private authDir: string;

    constructor(config: WhatsAppConfig) {
        this.config = {
            enabled: config.enabled ?? false,
            authDir: config.authDir || './data/whatsapp-auth',
            phoneNumber: config.phoneNumber || '',
            allowedJids: config.allowedJids || [],
            browser: config.browser || 'NewClaw',
        };
        // Merge any extra keys from config
        if (config.botToken !== undefined) (this.config as any).botToken = config.botToken;
        this.sendQueue = new PQueue({ concurrency: 1 });
        this.authDir = this.config.authDir!;

        if (!existsSync(this.authDir)) {
            mkdirSync(this.authDir, { recursive: true });
        }
    }

    get isConnected(): boolean {
        return this._isConnected && this.sock !== null;
    }

    setBus(bus: MessageBus): void {
        this.bus = bus;
    }

    async start(): Promise<void> {
        if (!this.config.enabled) {
            log.info('adapter_disabled', 'WhatsApp adapter is disabled');
            return;
        }

        try {
            const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
            const { version } = await fetchLatestBaileysVersion();

            this.sock = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, {
                        info: () => {},
                        error: () => {},
                        warn: () => {},
                        debug: () => {},
                        trace: () => {},
                        child: () => ({ info: () => {}, error: () => {}, warn: () => {}, debug: () => {}, trace: () => {} }),
                    } as any),
                },
                printQRInTerminal: true,
                browser: [this.config.browser || 'NewClaw', 'Chrome', '120.0'] as [string, string, string],
                connectTimeoutMs: 30_000,
                keepAliveIntervalMs: 25_000,
            });

            // Save credentials on update
            this.sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    log.info('qr_code', 'WhatsApp QR code generated — scan with your phone');
                }

                if (connection === 'close') {
                    const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
                    const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                    log.warn('connection_closed', `WhatsApp disconnected (code: ${statusCode})`);

                    if (shouldReconnect) {
                        log.info('reconnecting', 'Reconnecting WhatsApp...');
                        await this.start();
                    } else {
                        this._isConnected = false;
                        log.error('logged_out', 'WhatsApp logged out — delete auth dir and re-scan QR');
                    }
                } else if (connection === 'open') {
                    this._isConnected = true;
                    log.info('connected', '✅ WhatsApp connected!');

                    if (this.config.phoneNumber && !state.creds.registered) {
                        try {
                            if (this.sock) {
                                await this.sock.requestPairingCode(this.config.phoneNumber);
                                log.info('pairing_code', `Pairing code requested for ${this.config.phoneNumber}`);
                            }
                        } catch (e: any) {
                            log.warn('pairing_failed', e.message);
                        }
                    }
                }
            });

            this.sock.ev.on('creds.update', saveCreds);

            // Handle incoming messages
            this.sock.ev.on('messages.upsert', async ({ messages }) => {
                for (const msg of messages) {
                    if (!msg.key?.fromMe && msg.message) {
                        await this.handleMessage(msg);
                    }
                }
            });

            log.info('adapter_started', 'WhatsApp adapter started');
        } catch (e: any) {
            log.error('start_failed', e, 'WhatsApp adapter failed to start');
            this._isConnected = false;
        }
    }

    async stop(): Promise<void> {
        if (this.sock) {
            this.sock.end(undefined);
            this.sock = null;
        }
        this._isConnected = false;
        log.info('adapter_stopped', 'WhatsApp adapter stopped');
    }

    async send(response: NormalizedResponse, context: any): Promise<void> {
        const jid = context as string;
        if (!jid || !this.sock) {
            log.warn('no_jid', 'No JID or socket available for WhatsApp send');
            return;
        }

        await this.sendQueue.add(async () => {
            try {
                // Send attachments first
                if (response.attachments && response.attachments.length > 0) {
                    for (const attachment of response.attachments) {
                        await this.sendAttachment(jid, attachment);
                    }
                }

                // Send text
                if (!response.text || response.text.trim().length === 0) return;

                const text = this.stripMarkdown(response.text);
                const maxLen = 4096;

                if (text.length <= maxLen) {
                    await this.sock!.sendMessage(jid, { text });
                } else {
                    const chunks = this.splitIntoChunks(text, maxLen);
                    for (const chunk of chunks) {
                        await this.sock!.sendMessage(jid, { text: chunk });
                        await new Promise(r => setTimeout(r, 500));
                    }
                }
            } catch (e: any) {
                log.error('send_failed', e, `WhatsApp send failed to ${jid}`);
            }
        });
    }

    /** Send to a specific JID */
    async sendToJid(jid: string, response: NormalizedResponse): Promise<void> {
        await this.send(response, jid);
    }

    async healthCheck(): Promise<{ ok: boolean; details?: string }> {
        if (!this._isConnected || !this.sock) {
            return { ok: false, details: 'Not connected' };
        }
        return { ok: true, details: `WhatsApp connected (${this.config.phoneNumber || 'QR authenticated'})` };
    }

    // ─── Private: Message Handling ─────────────────────────────

    private async handleMessage(msg: proto.IWebMessageInfo): Promise<void> {
        if (!msg.message || msg.key?.fromMe) return;

        const jid = msg.key?.remoteJid || '';
        const userId = jid.split('@')[0] || jid;

        // JID whitelist
        if (this.config.allowedJids && this.config.allowedJids.length > 0) {
            if (!this.config.allowedJids.includes(jid) && !this.config.allowedJids.includes(userId)) {
                return;
            }
        }

        const message = msg.message;
        let type: NormalizedMessage['type'] = 'text';
        let text = '';
        const attachments: ChannelAttachment[] = [];

        if (message.conversation) {
            text = message.conversation;
        } else if (message.extendedTextMessage?.text) {
            text = message.extendedTextMessage.text;
        } else if (message.imageMessage) {
            text = message.imageMessage.caption || '';
            type = 'photo';
            attachments.push({
                type: 'photo',
                fileId: msg.key?.id || '',
                mimeType: message.imageMessage.mimetype ?? undefined,
                width: message.imageMessage.width ?? undefined,
                height: message.imageMessage.height ?? undefined,
            });
        } else if (message.videoMessage) {
            text = message.videoMessage.caption || '';
            type = 'video';
            attachments.push({
                type: 'video',
                fileId: msg.key?.id || '',
                mimeType: message.videoMessage.mimetype ?? undefined,
                duration: message.videoMessage.seconds ?? undefined,
            });
        } else if (message.audioMessage) {
            type = message.audioMessage.ptt ? 'voice' : 'audio';
            attachments.push({
                type,
                fileId: msg.key?.id || '',
                mimeType: message.audioMessage.mimetype ?? undefined,
                duration: message.audioMessage.seconds ?? undefined,
            });
        } else if (message.documentMessage) {
            text = message.documentMessage.caption || '';
            type = 'document';
            attachments.push({
                type: 'document',
                fileId: msg.key?.id || '',
                fileName: message.documentMessage.fileName ?? undefined,
                mimeType: message.documentMessage.mimetype ?? undefined,
            });
        } else if (message.stickerMessage) {
            type = 'photo';
            attachments.push({
                type: 'photo',
                fileId: msg.key?.id || '',
                mimeType: message.stickerMessage.mimetype ?? undefined,
            });
        } else if (message.contactMessage) {
            text = `Contato: ${message.contactMessage.displayName}`;
        } else if (message.locationMessage) {
            text = `Localização: ${message.locationMessage.degreesLatitude}, ${message.locationMessage.degreesLongitude}`;
        } else {
            text = message.conversation || message.extendedTextMessage?.text || '[Mensagem não suportada]';
        }

        if (!text && attachments.length === 0) return;

        const normalizedMsg: NormalizedMessage = {
            messageId: msg.key?.id || Date.now().toString(),
            channel: 'whatsapp',
            userId,
            userName: msg.pushName ?? undefined,
            type,
            text,
            attachments: attachments.length > 0 ? attachments : undefined,
            replyToId: msg.message?.extendedTextMessage?.contextInfo?.stanzaId ?? undefined,
            rawContext: jid,
            chatId: jid,
            metadata: {
                pushName: msg.pushName ?? undefined,
                participant: msg.key?.participant ?? undefined,
            },
        };

        if (this.bus) {
            await this.bus.processMessage(normalizedMsg);
        }
    }

    // ─── Private: Output Helpers ────────────────────────────────

    private async sendAttachment(jid: string, attachment: ResponseAttachment): Promise<void> {
        if (!this.sock) return;

        const filePath = typeof attachment.data === 'string' ? attachment.data : '';
        if (!filePath || !existsSync(filePath)) {
            log.warn('attachment_not_found', `File not found: ${filePath}`);
            return;
        }

        try {
            const buffer = readFileSync(filePath);
            const fileName = attachment.fileName || filePath.split('/').pop() || 'file';

            switch (attachment.type) {
                case 'audio': {
                    await this.sock.sendMessage(jid, {
                        audio: buffer,
                        mimetype: attachment.mimeType || 'audio/ogg',
                        ptt: true,
                    });
                    break;
                }
                case 'document': {
                    await this.sock.sendMessage(jid, {
                        document: buffer,
                        fileName,
                        mimetype: attachment.mimeType || 'application/octet-stream',
                    });
                    break;
                }
                case 'photo': {
                    await this.sock.sendMessage(jid, {
                        image: buffer,
                        mimetype: attachment.mimeType || 'image/jpeg',
                    });
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

    private stripMarkdown(text: string): string {
        return text
            .replace(/\*\*(.*?)\*\*/g, '*$1*')
            .replace(/__(.*?)__/g, '_$1_')
            .replace(/~~(.*?)~~/g, '~$1~')
            .replace(/```[\s\S]*?```/g, (m) => `\`\`\`${m.slice(3, -3)}\`\`\``)
            .replace(/`([^`]+)`/g, '```$1```')
            .trim();
    }
}