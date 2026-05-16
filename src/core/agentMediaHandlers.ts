import { createLogger } from '../shared/AppLogger';
import { errorMessage } from '../shared/errors';
import type { NormalizedMessage, ChannelAttachment } from '../channels/ChannelAdapter';
import type { MessageBus } from '../channels/MessageBus';

const voiceLog = createLogger('VoiceHandler');
const documentLog = createLogger('DocumentHandler');
const visionLog = createLogger('VisionHandler');

export interface VisionProfile {
    server: string;
    model: string;
}

export async function transcribeAttachment(
    msg: NormalizedMessage,
    attachment: ChannelAttachment,
    messageBus: MessageBus,
    tmpDir: string
): Promise<string | null> {
    try {
        const adapter = messageBus.getAdapter(msg.channel);
        const botToken = adapter?.getBotToken?.();
        const fileId = attachment.fileId;

        if (!botToken || !fileId) {
            voiceLog.error('missing_bot_token_or_file_id', `token=${!!botToken} fileId=${!!fileId}`);
            return '⚠️ Não foi possível obter o arquivo de áudio (token ou fileId ausente).';
        }

        const fileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
        const fileData = await fileRes.json() as { ok?: boolean; result?: { file_path?: string } };

        if (!fileData?.ok || !fileData?.result?.file_path) {
            voiceLog.error('telegram_getfile_failed', JSON.stringify(fileData));
            return '⚠️ Não foi possível obter o caminho do arquivo no Telegram.';
        }

        const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${fileData.result.file_path}`;
        const audioRes = await fetch(downloadUrl);
        if (!audioRes.ok) {
            voiceLog.error('audio_download_failed', `status=${audioRes.status}`);
            return '⚠️ Falha ao baixar o arquivo de áudio do Telegram.';
        }
        const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
        voiceLog.info('audio_downloaded', `size=${audioBuffer.length} type=${attachment.type}`);

        // Convert OGG/OGA (Telegram Opus) to WAV 16kHz mono — whisper.cpp requires WAV
        const fs = await import('fs/promises');
        const pathMod = await import('path');
        const { execFile } = await import('child_process');
        const tmpOgg = pathMod.join(tmpDir, `whisper_${Date.now()}.ogg`);
        const tmpWav = pathMod.join(tmpDir, `whisper_${Date.now()}.wav`);
        let wavBuffer: Buffer;

        try {
            await fs.writeFile(tmpOgg, audioBuffer);
            await new Promise<void>((resolve, reject) => {
                execFile('ffmpeg', ['-y', '-i', tmpOgg, '-ar', '16000', '-ac', '1', tmpWav], {
                    timeout: 30_000,
                }, (err) => err ? reject(err) : resolve());
            });
            wavBuffer = await fs.readFile(tmpWav);
            voiceLog.info('audio_converted', `oggSize=${audioBuffer.length} wavSize=${wavBuffer.length}`);
        } catch (convErr) {
            voiceLog.warn('audio_conversion_failed', errorMessage(convErr));
            wavBuffer = audioBuffer;
        } finally {
            await fs.unlink(tmpOgg).catch(() => {});
            await fs.unlink(tmpWav).catch(() => {});
        }

        const whisperApiUrl = process.env.WHISPER_API_URL || 'http://10.0.0.1:8177';
        const whisperApiFallback = process.env.WHISPER_API_FALLBACK || '';
        const whisperUrls = [whisperApiUrl, whisperApiFallback].filter(Boolean);

        for (const whisperUrl of whisperUrls) {
            try {
                const formData = new FormData();
                formData.append('file', new File([wavBuffer], 'audio.wav', { type: 'audio/wav' }));

                const whisperRes = await fetch(`${whisperUrl}/inference`, {
                    method: 'POST',
                    body: formData,
                    signal: AbortSignal.timeout(60_000),
                });

                if (whisperRes.ok) {
                    const result = await whisperRes.json() as { text?: string; transcription?: string };
                    const transcription = result?.text || result?.transcription || '';
                    if (transcription.trim()) {
                        voiceLog.info('whisper_transcription_ok', `textLen=${transcription.length}`);
                        msg.text = transcription.trim();
                        return null;
                    }
                }
                voiceLog.warn('whisper_api_failed', `url=${whisperUrl} status=${whisperRes.status}`);
            } catch (e) {
                voiceLog.warn('whisper_api_error', `url=${whisperUrl} error=${errorMessage(e)}`);
            }
        }

        // Fallback: local whisper-cli
        const pathMod2 = await import('path');
        const localWavFile = pathMod2.join(tmpDir, `whisper_local_${Date.now()}.wav`);
        const fs2 = await import('fs/promises');
        const { execFile: execFile2 } = await import('child_process');

        try {
            await fs2.writeFile(localWavFile, wavBuffer);
            const whisperPath = process.env.WHISPER_PATH || 'whisper';
            const output = await new Promise<string>((resolve, reject) => {
                execFile2(whisperPath, [localWavFile, '--language', 'pt'], {
                    timeout: 120_000,
                    encoding: 'utf-8',
                }, (err, stdout) => err ? reject(err) : resolve(stdout));
            });
            const transcription = output.trim();
            if (transcription) {
                voiceLog.info('local_whisper_ok', `textLen=${transcription.length}`);
                msg.text = transcription;
                return null;
            }
        } catch (e) {
            voiceLog.warn('local_whisper_failed', `error=${errorMessage(e)}`);
        } finally {
            await fs2.unlink(localWavFile).catch(() => {});
        }

        return '⚠️ Não foi possível transcrever o áudio. Tente enviar como texto.';
    } catch (err) {
        voiceLog.error('transcription_failed', err);
        return `⚠️ Erro na transcrição: ${errorMessage(err)}`;
    }
}

export async function handleDocumentAttachment(
    msg: NormalizedMessage,
    attachment: ChannelAttachment,
    messageBus: MessageBus
): Promise<string | null> {
    try {
        const channel = msg.channel;
        const workspaceDir = process.env.WORKSPACE_DIR || require('path').join(process.cwd(), 'workspace');
        const fs = await import('fs/promises');
        const pathMod = await import('path');

        if (!require('fs').existsSync(workspaceDir)) {
            await fs.mkdir(workspaceDir, { recursive: true });
        }

        let fileBuffer: Buffer | null = null;
        const fileName = attachment.fileName || `file_${Date.now()}`;

        if (channel === 'telegram') {
            const adapter = messageBus.getAdapter('telegram');
            const botToken = adapter?.getBotToken?.();
            const fileId = attachment.fileId;

            if (!botToken || !fileId) {
                documentLog.error('missing_bot_token_or_file_id', `token=${!!botToken} fileId=${!!fileId}`);
                return '⚠️ Não foi possível obter o documento (token ou fileId ausente).';
            }

            const fileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
            const fileData = await fileRes.json() as { ok?: boolean; result?: { file_path?: string } };

            if (fileData?.ok && fileData?.result?.file_path) {
                const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${fileData.result.file_path}`;
                documentLog.info('downloading_from_telegram', `Downloading ${fileName}`, { path: fileData.result.file_path });
                const docRes = await fetch(downloadUrl);
                if (docRes.ok) fileBuffer = Buffer.from(await docRes.arrayBuffer());
                else documentLog.error('telegram_download_failed', { status: docRes.status });
            } else {
                documentLog.error('telegram_getfile_failed', fileData);
            }
        } else if (channel === 'discord' && attachment.url) {
            documentLog.info('downloading_from_discord', `Downloading ${fileName}`, { url: attachment.url });
            const docRes = await fetch(attachment.url);
            if (docRes.ok) fileBuffer = Buffer.from(await docRes.arrayBuffer());
        } else if (attachment.data) {
            fileBuffer = Buffer.from(attachment.data, 'base64');
        }

        if (fileBuffer) {
            const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
            const targetPath = pathMod.join(workspaceDir, safeFileName);
            await fs.writeFile(targetPath, fileBuffer);
            documentLog.info('document_saved', `Saved to ${targetPath}`, { path: targetPath, size: fileBuffer.length });
            msg.text = (msg.text || '') + `\n[ARQUIVO ANEXADO: ${safeFileName} (salvo em workspace/${safeFileName})]\n`;
            return null;
        }

        return `⚠️ Falha ao baixar o arquivo do canal ${channel}.`;
    } catch (err) {
        documentLog.error('document_handling_failed', err);
        return `⚠️ Erro ao processar documento: ${errorMessage(err)}`;
    }
}

export async function processVision(
    fileBuffer: Buffer,
    fileName: string,
    visionProfile: VisionProfile | null
): Promise<string> {
    if (!visionProfile) {
        visionLog.warn('vision_not_configured', 'Perfil de visão não encontrado no ModelRouter.');
        return '(Visão não configurada)';
    }
    try {
        visionLog.info('vision_start', `Analisando imagem ${fileName} com o modelo ${visionProfile.model}...`);
        const base64Image = fileBuffer.toString('base64');
        const { OllamaProvider } = await import('./ProviderFactory');
        const visionProvider = new OllamaProvider(visionProfile.server, visionProfile.model);
        const response = await visionProvider.chat([
            {
                role: 'user',
                content: 'Descreva esta imagem em detalhes. Se houver texto, faça o OCR completo e extraia o conteúdo.',
                images: [base64Image]
            }
        ]);
        const description = response.content || 'Não foi possível extrair informações da imagem.';
        visionLog.info('vision_complete', `Descrição gerada (${description.length} caracteres)`);
        return description;
    } catch (err) {
        visionLog.error('vision_failed', err);
        return `Erro ao processar visão: ${errorMessage(err)}`;
    }
}

export async function handlePhotoAttachment(
    msg: NormalizedMessage,
    attachment: ChannelAttachment,
    messageBus: MessageBus,
    visionProfile: VisionProfile | null
): Promise<string | null> {
    try {
        const channel = msg.channel;
        const workspaceDir = process.env.WORKSPACE_DIR || require('path').join(process.cwd(), 'workspace');
        const fs = await import('fs/promises');
        const pathMod = await import('path');

        if (!require('fs').existsSync(workspaceDir)) {
            await fs.mkdir(workspaceDir, { recursive: true });
        }

        let fileBuffer: Buffer | null = null;
        let fileName = attachment.fileName || `photo_${Date.now()}.jpg`;

        if (channel === 'telegram') {
            const adapter = messageBus.getAdapter('telegram');
            const botToken = adapter?.getBotToken?.();
            const fileId = attachment.fileId;

            if (botToken && fileId) {
                const fileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
                const fileData = await fileRes.json() as { ok?: boolean; result?: { file_path?: string } };

                if (fileData?.ok && fileData?.result?.file_path) {
                    const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${fileData.result.file_path}`;
                    const imgRes = await fetch(downloadUrl);
                    if (imgRes.ok) {
                        fileBuffer = Buffer.from(await imgRes.arrayBuffer());
                        const ext = pathMod.extname(fileData.result.file_path);
                        if (ext) fileName = `photo_${Date.now()}${ext}`;
                    }
                }
            }
        } else if (channel === 'discord' && attachment.url) {
            const imgRes = await fetch(attachment.url);
            if (imgRes.ok) fileBuffer = Buffer.from(await imgRes.arrayBuffer());
        }

        if (fileBuffer) {
            const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
            const targetPath = pathMod.join(workspaceDir, safeFileName);
            await fs.writeFile(targetPath, fileBuffer);
            visionLog.info('photo_saved', `Saved to ${targetPath}`, { path: targetPath, size: fileBuffer.length });

            const visionDescription = await processVision(fileBuffer, safeFileName, visionProfile);
            msg.text = (msg.text || '') + `\n[IMAGEM RECEBIDA: ${safeFileName}]\n[DESCRIÇÃO DA VISÃO]: ${visionDescription}\n`;
            return null;
        }

        return `⚠️ Falha ao baixar a imagem do canal ${channel}.`;
    } catch (err) {
        visionLog.error('photo_handling_failed', err);
        return `⚠️ Erro ao processar imagem: ${errorMessage(err)}`;
    }
}
