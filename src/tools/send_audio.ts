/**
 * send_audio — Generate TTS audio and send via Telegram
 * Uses edge-tts (AntonioNeural pt-BR) + ffmpeg for ogg conversion
 * 
 * MIGRATED: execSync/execFileSync → execFile (non-blocking)
 * Previous execSync calls blocked the event loop for up to 65s during
 * curl uploads. Now all subprocess calls are async.
 */

import { ToolExecutor, ToolResult } from '../loop/AgentLoop';
import { execFile } from 'child_process';
import { mkdirSync, existsSync, unlinkSync } from 'fs';
import path from 'path';
import { createLogger } from '../shared/AppLogger';
import { errorMessage } from '../shared/errors';
const log = createLogger('SendAudio');

interface TelegramSendResponse {
    ok: boolean;
    result?: { voice?: { duration?: number }; audio?: { duration?: number }; [key: string]: unknown };
    description?: string;
    [key: string]: unknown;
}

export class SendAudioTool implements ToolExecutor {
    name = 'send_audio';
    description = 'Gera áudio TTS em português e envia via Telegram. Use quando o usuário pedir para ouvir, falar, narrar ou gerar áudio. NÃO chame esta ferramenta mais de uma vez por pedido.';
    parameters = {
        type: 'object',
        properties: {
            text: { type: 'string', description: 'Texto para converter em áudio' },
            voice: { type: 'string', description: 'Voz (padrão: pt-BR-AntonioNeural)' }
        },
        required: ['text']
    };

    private chatId: string | null = null;
    private botToken: string | null = null;
    private lastSendTime: number = 0;
    private static readonly MIN_INTERVAL_MS = 10000; // 10s debounce

    setContext(chatId: string, botToken: string): void {
        this.chatId = chatId;
        this.botToken = botToken;
    }

    async execute(args: Record<string, any>): Promise<ToolResult> {
        // Debounce: prevent duplicate sends within 10 seconds
        const now = Date.now();
        if (now - this.lastSendTime < SendAudioTool.MIN_INTERVAL_MS) {
            log.info('Debounced — audio already sent recently, skipping.');
            return { success: true, output: '🔊 Áudio já enviado recentemente.' };
        }
        this.lastSendTime = now;
        let text = args.text as string;
        const voice = (args.voice as string) || 'pt-BR-AntonioNeural';
        if (!text) return { success: false, output: '', error: 'Texto não fornecido.' };

        // Normalize text for TTS (avoid spelling out acronyms)
        text = text
            .replace(/\bRIVER\b/g, 'River')
            .replace(/\bBTC\b/g, 'Bitcoin')
            .replace(/\bETH\b/g, 'Ethereum')
            .replace(/\bSOL\b/g, 'Solana')
            .replace(/\bADA\b/g, 'Cardano')
            .replace(/\bXRP\b/g, 'Ripple')
            .replace(/\bDOGE\b/g, 'Dogecoin')
            .replace(/\bUSD\b/g, 'dólares')
            .replace(/\bUSDT\b/g, 'Tether')
            .replace(/\bMCap\b/g, 'Market cap')
            .replace(/%/g, ' por cento')
            .replace(/\$/g, '')
            .replace(/[\*_`#]/g, '');

        const audioDir = process.env.AUDIO_DIR || path.join(__dirname, "..", "audio");
        if (!existsSync(audioDir)) mkdirSync(audioDir, { recursive: true });

        const timestamp = Date.now();
        const mp3File = path.join(audioDir, `tts_${timestamp}.mp3`);
        const oggFile = path.join(audioDir, `tts_${timestamp}.ogg`);

        try {
            // Generate audio with edge-tts (ASYNC — non-blocking)
            const edgeTtsPath = process.env.EDGE_TTS_PATH || 'edge-tts';
            
            log.info(`Generating MP3 with voice=${voice}...`);
            const ttsStart = Date.now();
            try {
                await this.runCommand(edgeTtsPath, [
                    '--voice', voice,
                    '--text', text,
                    '--write-media', mp3File
                ], 30000);
            } catch (ttsErr) {
                log.error(`edge-tts failed with voice ${voice}:`, errorMessage(ttsErr));
                if (voice !== 'pt-BR-AntonioNeural') {
                    log.info('Falling back to pt-BR-AntonioNeural...');
                    await this.runCommand(edgeTtsPath, [
                        '--voice', 'pt-BR-AntonioNeural',
                        '--text', text,
                        '--write-media', mp3File
                    ], 30000);
                } else {
                    throw ttsErr;
                }
            }
            log.info(`edge-tts done in ${Date.now() - ttsStart}ms`);

            // Convert to OGG with ffmpeg (ASYNC — non-blocking)
            log.info(`Converting to OGG...`);
            const ffmpegStart = Date.now();
            await this.runCommand('ffmpeg', [
                '-y',
                '-i', mp3File,
                '-c:a', 'libopus',
                '-b:a', '48k',
                '-ar', '48000',
                '-ac', '1',
                oggFile
            ], 15000);
            log.info(`ffmpeg done in ${Date.now() - ffmpegStart}ms`);

            // Send via Telegram using HTTP multipart (ASYNC — non-blocking)
            if (!this.chatId || !this.botToken) {
                log.error('Missing Telegram context: chatId=' + this.chatId + ' botToken=' + (this.botToken ? 'SET' : 'NULL'));
                this.cleanupFiles([mp3File, oggFile]);
                return { success: false, output: '', error: 'Contexto Telegram não configurado. Não foi possível enviar o áudio.' };
            }

            try {
                log.info(`Uploading to Telegram via HTTP multipart...`);
                const uploadStart = Date.now();
                const sendResult = await this.sendVoiceTelegram(oggFile);
                log.info(`Telegram upload done in ${Date.now() - uploadStart}ms`);

                if (!sendResult.ok) {
                    log.error('Telegram sendVoice failed, trying sendAudio fallback...');
                    const fallbackResult = await this.sendAudioTelegram(oggFile);
                    if (!fallbackResult.ok) {
                        return { success: false, output: '', error: `Telegram sendVoice/sendAudio failed: ${JSON.stringify(fallbackResult)}` };
                    }
                } else {
                    log.info('voice_sent', 'Voice sent OK', { duration: sendResult.result?.voice?.duration || '?' });
                }
            } catch (uploadError) {
                log.error('Telegram upload error:', errorMessage(uploadError));
                return { success: false, output: '', error: `Upload failed: ${errorMessage(uploadError)}` };
            }

            // Cleanup
            this.cleanupFiles([mp3File, oggFile]);

            return { success: true, output: '🔊 Áudio enviado com sucesso!' };
        } catch (error) {
            // Cleanup on error
            this.cleanupFiles([mp3File, oggFile]);
            return { success: false, output: '', error: `Erro ao gerar áudio: ${errorMessage(error)}` };
        }
    }

    /**
     * Run a command asynchronously using execFile (non-blocking).
     * Unlike execSync, this does NOT block the Node.js event loop.
     */
    private runCommand(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
        return new Promise((resolve, reject) => {
            execFile(command, args, { timeout: timeoutMs, encoding: 'utf-8' }, (err, stdout, stderr) => {
                if (err) {
                    reject(err);
                } else {
                    resolve({ stdout, stderr });
                }
            });
        });
    }

    /**
     * Send voice message to Telegram via native HTTP multipart (no curl needed).
     * Uses global fetch() + FormData + File — all native in Node.js 22.
     */
    private async sendVoiceTelegram(oggPath: string): Promise<TelegramSendResponse> {
        const fs = await import('fs');
        const fileBuffer = fs.readFileSync(oggPath);

        const formData = new FormData();
        formData.append('chat_id', this.chatId!);
        formData.append('voice', new File([fileBuffer], 'voice.ogg', { type: 'audio/ogg' }));

        const response = await fetch(
            `https://api.telegram.org/bot${this.botToken}/sendVoice`,
            { method: 'POST', body: formData, signal: AbortSignal.timeout(35000) }
        );
        return response.json() as Promise<TelegramSendResponse>;
    }

    /**
     * Send audio message to Telegram via native HTTP multipart.
     */
    private async sendAudioTelegram(oggPath: string): Promise<TelegramSendResponse> {
        const fs = await import('fs');
        const fileBuffer = fs.readFileSync(oggPath);

        const formData = new FormData();
        formData.append('chat_id', this.chatId!);
        formData.append('audio', new File([fileBuffer], 'audio.ogg', { type: 'audio/ogg' }));

        const response = await fetch(
            `https://api.telegram.org/bot${this.botToken}/sendAudio`,
            { method: 'POST', body: formData, signal: AbortSignal.timeout(35000) }
        );
        return response.json() as Promise<TelegramSendResponse>;
    }

    private cleanupFiles(files: string[]): void {
        for (const file of files) {
            try {
                if (existsSync(file)) unlinkSync(file);
            } catch (err) {
                log.error(`Cleanup failed for ${file}:`, (err as Error).message);
            }
        }
    }
}