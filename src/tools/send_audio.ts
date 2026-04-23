/**
 * send_audio — Generate TTS audio and send via Telegram
 * Uses edge-tts (AntonioNeural pt-BR) + ffmpeg for ogg conversion
 */

import { ToolExecutor, ToolResult } from '../loop/AgentLoop';
import { execSync } from 'child_process';
import { mkdirSync, existsSync } from 'fs';
import path from 'path';

export class SendAudioTool implements ToolExecutor {
    name = 'send_audio';
    description = 'Gera áudio TTS em português e envia via Telegram. Use quando o usuário pedir para ouvir, falar, narrar ou gerar áudio.';
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

    setContext(chatId: string, botToken: string): void {
        this.chatId = chatId;
        this.botToken = botToken;
    }

    async execute(args: Record<string, any>): Promise<ToolResult> {
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
            // Generate audio with edge-tts (use full path)
            const edgeTtsPath = process.env.EDGE_TTS_PATH || 'edge-tts';
            execSync(`"${edgeTtsPath}" --voice "${voice}" --text "${text.replace(/"/g, '\\"')}" --write-media "${mp3File}"`, {
                timeout: 30000,
                stdio: 'pipe'
            });

            // Convert to ogg/opus for Telegram voice message
            execSync(`ffmpeg -y -i "${mp3File}" -c:a libopus -b:a 48k -ar 48000 -ac 1 "${oggFile}"`, {
                timeout: 15000,
                stdio: 'pipe'
            });

            // Send via Telegram using curl (most reliable)
            if (this.chatId && this.botToken) {
                try {
                    execSync(`curl -s -F "chat_id=${this.chatId}" -F "voice=@${oggFile}" "https://api.telegram.org/bot${this.botToken}/sendVoice"`, {
                        timeout: 30000,
                        stdio: 'pipe'
                    });
                } catch (curlError: any) {
                    // Fallback: try as audio instead of voice
                    try {
                        execSync(`curl -s -F "chat_id=${this.chatId}" -F "audio=@${oggFile}" "https://api.telegram.org/bot${this.botToken}/sendAudio"`, {
                            timeout: 30000,
                            stdio: 'pipe'
                        });
                    } catch (audioError: any) {
                        return { success: false, output: '', error: `Telegram send failed: ${audioError.message}` };
                    }
                }
            }

            // Cleanup
            try { execSync(`rm -f "${mp3File}"`); } catch { /* ignore */ }

            return { success: true, output: '🔊 Áudio enviado com sucesso!' };
        } catch (error: any) {
            // Cleanup on error
            try { execSync(`rm -f "${mp3File}" "${oggFile}"`); } catch { /* ignore */ }
            return { success: false, output: '', error: `Erro ao gerar áudio: ${error.message}` };
        }
    }
}