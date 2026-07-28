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
import { resolvePython3Runtime, defaultPython3Candidates, which } from '../utils/crossPlatform';
import { EdgeTTS } from 'node-edge-tts';

const log = createLogger('SendAudio');

// Voz padrão para todo áudio em português — mesma escolhida e validada no projeto irmão
// (Thorial/OpenClaw, ver docs/Auditorias/2026-07-26/LIMITACAO_EDGE_TTS_PYTHON_2026-07-26.md).
const DEFAULT_VOICE = 'pt-BR-AntonioNeural';

// Piper (offline, GPL-3.0, invocado só como subprocesso — nunca linkado ao processo do
// NewClaw, mesmo padrão de "agregação" já usado para ffmpeg neste mesmo arquivo) é uma camada
// OPCIONAL, nunca obrigatória: só é usada quando o operador explicitamente baixou os modelos
// (sinal de intenção explícita, não uma suposição — ver "Nunca Adivinhar",
// docs/DIRETRIZ_ARQUITETURA_2026-07-13.md). Ausência dos arquivos = comportamento inalterado
// (node-edge-tts continua o padrão zero-configuração). Ver
// docs/Auditorias/2026-07-26/LIMITACAO_EDGE_TTS_PYTHON_2026-07-26.md para o histórico completo desta decisão.
const PIPER_MODELS_DIR = process.env.PIPER_MODELS_DIR || path.join(process.cwd(), 'models', 'piper');
const PIPER_MODEL_FILE = 'pt-BR-razo-medium.onnx';

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
        const voice = (args.voice as string) || DEFAULT_VOICE;
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
        const oggFile = path.join(audioDir, `tts_${timestamp}.ogg`);
        // Extensão real definida pela engine que de fato gerar o áudio (Piper → .wav,
        // node-edge-tts/CLI Python → .mp3) — ver generateAudio().
        let rawAudioFile = '';

        try {
            log.info(`Generating audio with voice=${voice}...`);
            const ttsStart = Date.now();
            rawAudioFile = await this.generateAudio(text, voice, audioDir, timestamp);
            log.info(`TTS done in ${Date.now() - ttsStart}ms (${path.basename(rawAudioFile)})`);

            // Convert to OGG with ffmpeg (ASYNC — non-blocking). ffmpeg detecta o formato de
            // entrada pelo conteúdo do arquivo, não pela extensão — funciona igual para
            // .wav (Piper) e .mp3 (node-edge-tts/CLI Python), sem branch adicional aqui.
            log.info(`Converting to OGG...`);
            const ffmpegStart = Date.now();
            await this.runCommand('ffmpeg', [
                '-y',
                '-i', rawAudioFile,
                '-c:a', 'libopus',
                '-b:a', '48k',
                '-ar', '48000',
                '-ac', '1',
                oggFile
            ], 15000);
            log.info(`ffmpeg done in ${Date.now() - ffmpegStart}ms`);

            if (!this.chatId) {
                log.error('Missing channel context: chatId=' + this.chatId);
                this.cleanupFiles([rawAudioFile, oggFile]);
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
            this.cleanupFiles([rawAudioFile, oggFile]);

            return { success: true, output: '🔊 Áudio enviado com sucesso!' };
        } catch (error) {
            // Cleanup on error
            this.cleanupFiles([rawAudioFile, oggFile]);
            return { success: false, output: '', error: `Erro ao gerar áudio: ${errorMessage(error)}` };
        }
    }

    /**
     * Gera o arquivo de áudio, em ordem de preferência, e retorna o caminho do arquivo
     * realmente produzido (extensão varia por engine):
     *   0. Piper (subprocesso, offline, 100% local) — só tentado quando o operador já baixou
     *      os modelos (PIPER_MODELS_DIR) explicitamente; presença dos arquivos É o sinal de
     *      intenção, nunca assumido por padrão. Elimina a dependência do serviço da Microsoft
     *      para quem configurou — relevante para escala/uso intenso, não para instalação padrão.
     *   1. node-edge-tts (pacote npm, WebSocket direto ao serviço da Microsoft) — não depende
     *      de runtime Python. Padrão de fábrica (zero configuração) quando Piper não está
     *      instalado.
     *   2. CLI Python `edge-tts` (comportamento histórico) — só tentado se (0) e (1) falharem
     *      de ponta a ponta.
     * Em node-edge-tts/CLI Python, tenta a voz pedida e, se falhar e for diferente de
     * DEFAULT_VOICE, tenta DEFAULT_VOICE antes de escalar para a próxima engine. Piper usa
     * sempre sua própria voz padrão (catálogo de vozes diferente do edge-tts, não há
     * correspondência 1:1 com o parâmetro `voice`).
     *
     * Contexto da escolha: docs/Auditorias/2026-07-26/LIMITACAO_EDGE_TTS_PYTHON_2026-07-26.md — o pacote npm
     * `edge-tts` (nome parecido, projeto diferente) foi avaliado e rejeitado por licença
     * CC BY-NC-SA (não-comercial) e conflito de peer-dependency. `node-edge-tts` é MIT, sem
     * peer-deps, instalação limpa. Piper (`piper-tts`) é GPL-3.0 — invocado só como
     * subprocesso independente (nunca linkado ao processo do NewClaw), mesmo padrão de
     * "agregação" já usado para ffmpeg neste arquivo, não uma vinculação de biblioteca.
     */
    private async generateAudio(text: string, voice: string, audioDir: string, timestamp: number): Promise<string> {
        const piper = this.findPiperInstallation();
        if (piper) {
            const wavFile = path.join(audioDir, `tts_${timestamp}.wav`);
            try {
                log.info(`Piper detectado (${PIPER_MODELS_DIR}) — usando engine offline.`);
                await this.generateViaPiper(text, piper, wavFile);
                return wavFile;
            } catch (piperErr) {
                log.error('Piper failed, falling back to node-edge-tts:', errorMessage(piperErr));
            }
        }

        const mp3File = path.join(audioDir, `tts_${timestamp}.mp3`);
        try {
            await this.generateViaNodeEdgeTts(text, voice, mp3File);
            return mp3File;
        } catch (npmErr) {
            log.error(`node-edge-tts failed with voice ${voice}:`, errorMessage(npmErr));
            if (voice !== DEFAULT_VOICE) {
                try {
                    log.info('node-edge-tts: falling back to ' + DEFAULT_VOICE + '...');
                    await this.generateViaNodeEdgeTts(text, DEFAULT_VOICE, mp3File);
                    return mp3File;
                } catch (npmDefaultErr) {
                    log.error('node-edge-tts failed with default voice too:', errorMessage(npmDefaultErr));
                }
            }
        }

        // Fallback: CLI Python (histórico) — só chega aqui se Piper (se detectado) e
        // node-edge-tts falharam de ponta a ponta.
        log.info('Falling back to Python edge-tts CLI...');
        const edgeTtsCmd = await this.resolveEdgeTtsCommand();
        try {
            await this.runCommand(edgeTtsCmd.command, [
                ...edgeTtsCmd.argsPrefix, '--voice', voice, '--rate=-5%', '--text', text, '--write-media', mp3File,
            ], 30000);
            return mp3File;
        } catch (cliErr) {
            log.error(`Python edge-tts CLI failed with voice ${voice}:`, errorMessage(cliErr));
            if (voice === DEFAULT_VOICE) throw cliErr;
            log.info('Python edge-tts CLI: falling back to ' + DEFAULT_VOICE + '...');
            await this.runCommand(edgeTtsCmd.command, [
                ...edgeTtsCmd.argsPrefix, '--voice', DEFAULT_VOICE, '--rate=-5%', '--text', text, '--write-media', mp3File,
            ], 30000);
            return mp3File;
        }
    }

    /**
     * Gera áudio via node-edge-tts (biblioteca npm) — sem subprocesso, sem Python.
     *
     * DISABLE_NODE_EDGE_TTS=true: escape hatch só para teste determinístico (mesmo espírito de
     * EDGE_TTS_PATH/PIPER_BIN abaixo) — sem isso, um teste que força falha de TTS via
     * EDGE_TTS_PATH (binário CLI inexistente) não conseguia forçar falha aqui, porque este
     * engine roda antes do fallback CLI e não depende de nenhum binário local, só de rede —
     * um teste rodando com rede real disponível "passava" no engine que deveria estar simulando
     * falha, mascarando o cenário que o teste (S28) existe pra provar. Nunca lido em produção.
     */
    private async generateViaNodeEdgeTts(text: string, voice: string, outputPath: string): Promise<void> {
        if (process.env.DISABLE_NODE_EDGE_TTS === 'true') {
            throw new Error('node-edge-tts desabilitado via DISABLE_NODE_EDGE_TTS (teste)');
        }
        const tts = new EdgeTTS({ voice, lang: 'pt-BR', rate: '-5%' });
        await tts.ttsPromise(text, outputPath);
    }

    /**
     * Verifica se o operador já configurou o Piper (offline) — nunca assume, só detecta
     * presença real: modelo + config em PIPER_MODELS_DIR (env var ou `<cwd>/models/piper`) E
     * o binário `piper` alcançável no PATH (mesma função `which()` já usada por
     * CapabilityRegistry/probes de ambiente). Ausência de qualquer um dos três = null,
     * comportamento idêntico ao anterior a esta mudança (node-edge-tts como padrão).
     */
    private findPiperInstallation(): { piperBin: string; model: string; config: string } | null {
        const model = path.join(PIPER_MODELS_DIR, PIPER_MODEL_FILE);
        const config = path.join(PIPER_MODELS_DIR, `${PIPER_MODEL_FILE}.json`);
        if (!existsSync(model) || !existsSync(config)) return null;

        const piperBin = process.env.PIPER_BIN || which('piper');
        if (!piperBin) return null;

        return { piperBin, model, config };
    }

    /** Gera áudio via Piper (subprocesso — texto entra por stdin, WAV sai por -f). */
    private async generateViaPiper(
        text: string,
        piper: { piperBin: string; model: string; config: string },
        outputWav: string,
    ): Promise<void> {
        await this.runCommandWithStdin(
            piper.piperBin,
            ['-m', piper.model, '-c', piper.config, '-f', outputWav],
            text,
            30000,
        );
        if (!existsSync(outputWav)) {
            throw new Error('Piper não gerou o arquivo de áudio esperado.');
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

    /**
     * Mesmo padrão de runCommand(), mas escreve `stdinText` no stdin do processo antes de
     * fechar — necessário para o Piper, que lê o texto a converter via stdin (mesma
     * convenção do CLI oficial, sem passar texto como argumento de linha de comando).
     * Sem shell (execFile puro) — stdinText nunca é interpretado como comando, só como dado.
     */
    private runCommandWithStdin(command: string, args: string[], stdinText: string, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
        return new Promise((resolve, reject) => {
            const child = execFile(command, args, { timeout: timeoutMs, encoding: 'utf-8', windowsHide: true }, (err, stdout, stderr) => {
                if (err) {
                    reject(err);
                } else {
                    resolve({ stdout, stderr });
                }
            });
            child.stdin?.write(stdinText, 'utf-8');
            child.stdin?.end();
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
