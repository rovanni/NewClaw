/**
 * send_audio — Generate TTS audio and send via Telegram
 * Uses edge-tts (AntonioNeural pt-BR) + ffmpeg for ogg conversion
 *
 * MIGRATED: execSync/execFileSync → execFile (non-blocking)
 * Previous execSync calls blocked the event loop for up to 65s during
 * curl uploads. Now all subprocess calls are async.
 */

import { ToolExecutor, ToolResult } from '../loop/agentLoopTypes';
import { execFile } from 'child_process';
import { mkdirSync, existsSync, unlinkSync, readFileSync } from 'fs';
import path from 'path';
import { createLogger } from '../shared/AppLogger';
import { errorMessage } from '../shared/errors';
import { MessageBus } from '../channels/MessageBus';
import { ChannelType } from '../channels/ChannelAdapter';
import { resolvePython3Runtime, defaultPython3Candidates } from '../utils/crossPlatform';

const log = createLogger('SendAudio');

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
    private channel: ChannelType = 'telegram';
    private bus: MessageBus;
    private lastSendTime: number = 0;
    private static readonly MIN_INTERVAL_MS = 10000; // 10s debounce

    constructor(bus: MessageBus) {
        this.bus = bus;
    }

    setContext(chatId: string, channel?: string): void {
        this.chatId = chatId;
        this.channel = (channel || 'telegram') as ChannelType;
    }

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
        // Debounce: prevent duplicate sends within 10 seconds. lastSendTime só é atualizado
        // APÓS um envio bem-sucedido (ver bus.sendVoice() abaixo) — nunca no início da
        // tentativa. Setar aqui incondicionalmente fazia uma falha real (ex.: edge-tts ausente)
        // ser mascarada por um "sucesso" falso na tentativa seguinte dentro da janela de 10s,
        // porque o debounce respondia success:true achando que já tinha enviado de verdade.
        // Bug real: goal de áudio marcado completed sem NENHUM áudio jamais gerado (edge-tts
        // ENOENT em todas as tentativas) — usuário nunca recebeu nada.
        const now = Date.now();
        if (now - this.lastSendTime < SendAudioTool.MIN_INTERVAL_MS) {
            log.info('Debounced — audio already sent recently, skipping.');
            return { success: true, output: '🔊 Áudio já enviado recentemente.' };
        }
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
            const edgeTtsCmd = await this.resolveEdgeTtsCommand();

            log.info(`Generating MP3 with voice=${voice}...`);
            const ttsStart = Date.now();
            try {
                await this.runCommand(edgeTtsCmd.command, [
                    ...edgeTtsCmd.argsPrefix,
                    '--voice', voice,
                    '--text', text,
                    '--write-media', mp3File
                ], 30000);
            } catch (ttsErr) {
                log.error(`edge-tts failed with voice ${voice}:`, errorMessage(ttsErr));
                if (voice !== 'pt-BR-AntonioNeural') {
                    log.info('Falling back to pt-BR-AntonioNeural...');
                    await this.runCommand(edgeTtsCmd.command, [
                        ...edgeTtsCmd.argsPrefix,
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

            if (!this.chatId) {
                log.error('Missing channel context: chatId=' + this.chatId);
                this.cleanupFiles([mp3File, oggFile]);
                return { success: false, output: '', error: 'Contexto de canal não configurado.' };
            }

            try {
                log.info(`Uploading via MessageBus (channel=${this.channel})...`);
                const uploadStart = Date.now();
                const fileBuffer = readFileSync(oggFile);
                await this.bus.sendVoice(this.channel, this.chatId, fileBuffer, 'voice.ogg');
                log.info(`Upload done in ${Date.now() - uploadStart}ms`);
                this.lastSendTime = Date.now();
            } catch (uploadError) {
                log.error('Upload error:', errorMessage(uploadError));
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
     * Resolve como invocar edge-tts sem depender de um binário solto no PATH.
     *
     * Bug real (04/07/2026): `pip install edge-tts` reporta sucesso e o pacote fica
     * instalado, mas no Windows o script de console (edge-tts.exe) é gravado em
     * AppData\Roaming\Python\PythonXXX\Scripts — uma pasta que o instalador do
     * Python NÃO adiciona ao PATH por padrão. Resultado: `spawn edge-tts ENOENT`
     * persiste mesmo depois da instalação "bem-sucedida", pois o processo Node
     * nunca tinha essa pasta no seu PATH herdado (nem um restart resolveria, já
     * que o PATH persistido do usuário também não a contém).
     *
     * Correção: mesmo princípio já usado para o probe de pip (CapabilityRegistry)
     * — não confiar em um nome de binário solto no PATH; resolver o runtime
     * Python 3 real (resolvePython3Runtime/defaultPython3Candidates, já
     * aprovados) e invocar o pacote como módulo (`<runtime> -m edge_tts`), que
     * funciona independente de qualquer diretório de Scripts estar no PATH.
     * EDGE_TTS_PATH continua disponível como escape hatch explícito.
     */
    private async resolveEdgeTtsCommand(): Promise<{ command: string; argsPrefix: string[] }> {
        const override = process.env.EDGE_TTS_PATH;
        if (override) return { command: override, argsPrefix: [] };

        const runtime = await resolvePython3Runtime(defaultPython3Candidates());
        if (runtime) return { command: runtime.command, argsPrefix: [...runtime.argsPrefix, '-m', 'edge_tts'] };

        // Nenhum runtime Python 3 resolvido — mantém o comportamento histórico
        // (binário solto no PATH) como último recurso, sem regredir ambientes
        // onde edge-tts já funciona via PATH sem essa resolução.
        return { command: 'edge-tts', argsPrefix: [] };
    }

    /**
     * Run a command asynchronously using execFile (non-blocking).
     * Unlike execSync, this does NOT block the Node.js event loop.
     */
    private runCommand(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
        return new Promise((resolve, reject) => {
            execFile(command, args, { timeout: timeoutMs, encoding: 'utf-8', windowsHide: true }, (err, stdout, stderr) => {
                if (err) {
                    reject(err);
                } else {
                    resolve({ stdout, stderr });
                }
            });
        });
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
