/**
 * SignalAdapter — ChannelAdapter para Signal via signal-cli
 * 
 * Implementa a interface ChannelAdapter para que o Signal
 * funcione como canal no MessageBus do NewClaw.
 * 
 * Usa signal-cli (Java) como backend via DBus ou JSON-RPC.
 * Requer: signal-cli instalado e número registrado.
 * 
 * Setup:
 *   1. Instalar signal-cli: https://github.com/AsamK/signal-cli
 *   2. Registrar: signal-cli -u +5511999999999 register
 *   3. Verificar: signal-cli -u +5511999999999 verify <code>
 *   4. Iniciar daemon: signal-cli -u +5511999999999 daemon
 *   5. Configurar SIGNAL_PHONE_NUMBER no .env
 */

import { execFile } from 'child_process';
import { createServer, type Server } from 'http';
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

const log = createLogger('SignalAdapter');

export interface SignalConfig extends ChannelConfig {
    /** Phone number with country code (e.g., +5511999999999) */
    phoneNumber: string;
    /** signal-cli command path */
    signalCliPath?: string;
    /** Allowed phone numbers (e.g., ['+5511999999999']) — empty = all */
    allowedNumbers?: string[];
    /** JSON-RPC port for signal-cli daemon */
    rpcPort?: number;
    /** Internal HTTP server port for receiving webhooks */
    webhookPort?: number;
}

interface SignalMessage {
    envelope?: {
        source?: string;
        sourceNumber?: string;
        sourceName?: string;
        timestamp?: number;
        dataMessage?: {
            timestamp?: number;
            message?: string;
            expiresInSeconds?: number;
            groupInfo?: { groupId?: string };
            attachments?: Array<{
                id?: string;
                contentType?: string;
                filename?: string;
                size?: number;
            }>;
        };
    };
}

export class SignalAdapter implements ChannelAdapter {
    readonly channelType: ChannelType = 'signal';
    readonly displayName: string = 'Signal';
    private _isConnected: boolean = false;

    private config: SignalConfig;
    private bus: MessageBus | null = null;
    private webhookServer: Server | null = null;

    constructor(config: SignalConfig) {
        this.config = {
            enabled: config.enabled ?? false,
            phoneNumber: config.phoneNumber || '',
            signalCliPath: config.signalCliPath || 'signal-cli',
            allowedNumbers: config.allowedNumbers || [],
            rpcPort: config.rpcPort || 7583,
            webhookPort: config.webhookPort || 7584,
        };
        // Merge remaining config keys
        if (config.botToken !== undefined) (this.config as any).botToken = config.botToken;
    }

    get isConnected(): boolean {
        return this._isConnected;
    }

    setBus(bus: MessageBus): void {
        this.bus = bus;
    }

    async start(): Promise<void> {
        if (!this.config.enabled) {
            log.info('adapter_disabled', 'Signal adapter is disabled');
            return;
        }

        if (!this.config.phoneNumber) {
            log.warn('no_phone', 'Signal phone number not configured');
            return;
        }

        // Check if signal-cli is available
        try {
            await this.execSignalCli(['--version']);
            log.info('cli_found', 'signal-cli found');
        } catch (e: any) {
            log.error('cli_not_found', e, 'signal-cli not found. Install: https://github.com/AsamK/signal-cli');
            return;
        }

        // Start webhook receiver server
        await this.startWebhookServer();

        // Register webhook with signal-cli
        try {
            await this.execSignalCli([
                '-u', this.config.phoneNumber,
                'receive',
                '--json',
                '--timeout', '3600',
            ]);
            // Long-running — we don't await this
        } catch {
            // Expected to timeout — we'll use the webhook approach instead
        }

        // Alternative: use JSON-RPC if daemon is running
        this._isConnected = true;
        log.info('adapter_started', '✅ Signal adapter started');

        // Start receive loop in background
        this.startReceiveLoop();
    }

    async stop(): Promise<void> {
        if (this.webhookServer) {
            this.webhookServer.close();
            this.webhookServer = null;
        }
        this._isConnected = false;
        log.info('adapter_stopped', 'Signal adapter stopped');
    }

    async send(response: NormalizedResponse, context: any): Promise<void> {
        const phoneNumber = context as string;
        if (!phoneNumber || !this.config.phoneNumber) {
            log.warn('no_phone', 'No phone number for Signal send');
            return;
        }

        try {
            // Send attachments first
            if (response.attachments && response.attachments.length > 0) {
                for (const attachment of response.attachments) {
                    await this.sendAttachment(phoneNumber, attachment);
                }
            }

            // Send text
            if (!response.text || response.text.trim().length === 0) return;

            const text = response.text;
            const maxLen = 8000; // Signal limit ~8K

            if (text.length <= maxLen) {
                await this.sendTextMessage(phoneNumber, text);
            } else {
                const chunks = this.splitIntoChunks(text, maxLen);
                for (const chunk of chunks) {
                    await this.sendTextMessage(phoneNumber, chunk);
                    await new Promise(r => setTimeout(r, 500));
                }
            }
        } catch (e: any) {
            log.error('send_failed', e, `Signal send failed to ${phoneNumber}`);
        }
    }

    /** Send to a specific phone number */
    async sendToPhone(phoneNumber: string, response: NormalizedResponse): Promise<void> {
        await this.send(response, phoneNumber);
    }

    async healthCheck(): Promise<{ ok: boolean; details?: string }> {
        if (!this._isConnected) {
            return { ok: false, details: 'Not connected' };
        }
        try {
            const version = await this.execSignalCli(['--version']);
            return { ok: true, details: `Signal CLI ${version.trim()}` };
        } catch (e: any) {
            return { ok: false, details: `signal-cli error: ${e.message}` };
        }
    }

    // ─── Private: Receive Loop ─────────────────────────────────

    private startReceiveLoop(): void {
        const receiveLoop = async () => {
            while (this._isConnected) {
                try {
                    await this.receiveMessages();
                } catch (e: any) {
                    log.error('receive_error', e, 'Signal receive loop error');
                    await new Promise(r => setTimeout(r, 5000));
                }
            }
        };
        receiveLoop();
    }

    private async receiveMessages(): Promise<void> {
        return new Promise((resolve) => {
            const args = [
                '-u', this.config.phoneNumber,
                'receive',
                '--json',
                '--timeout', '60',
            ];

            const signalPath = this.config.signalCliPath || 'signal-cli';

            const child = execFile(signalPath, args, {
                maxBuffer: 10 * 1024 * 1024,
                timeout: 120000,
            }, (error: any, stdout: string) => {
                if (error && error.code !== 0 && !error.killed) {
                    log.warn('receive_timeout', 'Signal receive timeout (normal for long-polling)');
                    resolve();
                    return;
                }

                if (!stdout) {
                    resolve();
                    return;
                }

                // Parse JSON lines
                for (const line of stdout.split('\n').filter((l: string) => l.trim())) {
                    try {
                        const msg: SignalMessage = JSON.parse(line);
                        this.handleSignalMessage(msg);
                    } catch {
                        // Skip non-JSON lines
                    }
                }

                resolve();
            });

            // If child process is killed, resolve
            child.on('close', () => resolve());
        });
    }

    private async handleSignalMessage(msg: SignalMessage): Promise<void> {
        const envelope = msg.envelope;
        if (!envelope || !envelope.dataMessage) return;

        const sourceNumber = envelope.sourceNumber || envelope.source || '';
        const sourceName = envelope.sourceName || '';
        const dataMessage = envelope.dataMessage;

        // Phone number whitelist
            if (envelope?.sourceNumber && this.config.allowedNumbers && this.config.allowedNumbers.length > 0 && !this.config.allowedNumbers.includes(envelope.sourceNumber)) {
            return;
        }

        const userId = sourceNumber.replace(/[+\s]/g, '');
        let type: NormalizedMessage['type'] = 'text';
        let text = dataMessage.message || '';
        const attachments: ChannelAttachment[] = [];

        if (dataMessage.attachments && dataMessage.attachments.length > 0) {
            for (const att of dataMessage.attachments) {
                const contentType = att.contentType || '';
                if (contentType.startsWith('image/')) {
                    type = 'photo';
                    attachments.push({
                        type: 'photo',
                        fileId: att.id || '',
                        mimeType: contentType,
                        fileName: att.filename,
                    });
                } else if (contentType.startsWith('audio/')) {
                    type = 'voice';
                    attachments.push({
                        type: 'voice',
                        fileId: att.id || '',
                        mimeType: contentType,
                    });
                } else {
                    type = 'document';
                    attachments.push({
                        type: 'document',
                        fileId: att.id || '',
                        mimeType: contentType,
                        fileName: att.filename,
                    });
                }
            }
        }

        if (!text && attachments.length === 0) return;

        const normalizedMsg: NormalizedMessage = {
            messageId: (dataMessage.timestamp || Date.now()).toString(),
            channel: 'signal',
            userId,
            userName: sourceName || undefined,
            type,
            text,
            attachments: attachments.length > 0 ? attachments : undefined,
            rawContext: sourceNumber,
            chatId: sourceNumber,
            metadata: {
                sourceName,
                timestamp: dataMessage.timestamp,
                groupId: dataMessage.groupInfo?.groupId,
            },
        };

        if (this.bus) {
            await this.bus.processMessage(normalizedMsg);
        }
    }

    // ─── Private: Send Helpers ──────────────────────────────────

    private async sendTextMessage(phoneNumber: string, text: string): Promise<void> {
        const args = [
            '-u', this.config.phoneNumber,
            'send',
            phoneNumber,
            '-m', text,
        ];

        await this.execSignalCli(args);
    }

    private async sendAttachment(phoneNumber: string, attachment: ResponseAttachment): Promise<void> {
        const fs = await import('fs');
        const filePath = typeof attachment.data === 'string' ? attachment.data : '';

        if (!filePath || !fs.existsSync(filePath)) {
            log.warn('attachment_not_found', `File not found: ${filePath}`);
            return;
        }

        const args = [
            '-u', this.config.phoneNumber,
            'send',
            phoneNumber,
            '-a', filePath,
        ];

        if (attachment.fileName) {
            args.push('--caption', attachment.fileName);
        }

        await this.execSignalCli(args);
    }

    private async startWebhookServer(): Promise<void> {
        return new Promise((resolve) => {
            const port = this.config.webhookPort || 7584;
            this.webhookServer = createServer(async (req, res) => {
                if (req.method === 'POST' && req.url === '/signal/webhook') {
                    let body = '';
                    req.on('data', (chunk) => { body += chunk; });
                    req.on('end', async () => {
                        try {
                            const msg: SignalMessage = JSON.parse(body);
                            await this.handleSignalMessage(msg);
                            res.writeHead(200);
                            res.end('OK');
                        } catch (e: any) {
                            log.error('webhook_parse_error', e);
                            res.writeHead(400);
                            res.end('Bad Request');
                        }
                    });
                } else {
                    res.writeHead(404);
                    res.end('Not Found');
                }
            });

            this.webhookServer!.listen(port, () => {
                log.info('webhook_started', `Signal webhook server on port ${port}`);
                resolve();
            });
        });
    }

    private execSignalCli(args: string[]): Promise<string> {
        const signalPath = this.config.signalCliPath || 'signal-cli';
        return new Promise((resolve, reject) => {
            execFile(signalPath, args, {
                timeout: 30000,
                maxBuffer: 5 * 1024 * 1024,
            }, (error: any, stdout: string, stderr: string) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(stdout);
                }
            });
        });
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