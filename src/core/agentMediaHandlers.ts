import { createLogger } from '../shared/AppLogger';
import { errorMessage } from '../shared/errors';
import type { NormalizedMessage, ChannelAttachment } from '../channels/ChannelAdapter';
import type { MessageBus } from '../channels/MessageBus';
import type { MemoryManager } from '../memory/MemoryManager';
import fsStatic from 'fs';
import pathStatic from 'path';

const voiceLog = createLogger('VoiceHandler');
const documentLog = createLogger('DocumentHandler');
const visionLog = createLogger('VisionHandler');

// ── Workspace Index ───────────────────────────────────────────────────────────

function countWorkspace(dir: string): { files: number; dirs: number } {
    let files = 0; let dirs = 0;
    try {
        const entries = fsStatic.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
            if (e.isDirectory()) { dirs++; const sub = countWorkspace(pathStatic.join(dir, e.name)); files += sub.files; dirs += sub.dirs; }
            else files++;
        }
    } catch { /* ignore unreadable dirs */ }
    return { files, dirs };
}

/**
 * Updates core_workspace with a lightweight summary (no full tree).
 * The model must use list_workspace tool to explore files on demand.
 */
export function refreshWorkspaceIndex(memory: MemoryManager): void {
    const workspaceDir = process.env.WORKSPACE_DIR || './workspace';
    try {
        if (!fsStatic.existsSync(workspaceDir)) return;

        const { files, dirs } = countWorkspace(workspaceDir);
        const content = files === 0
            ? `Workspace: ${workspaceDir} (vazio)\nAtualizado em: ${new Date().toISOString()}\nUse list_workspace para listar arquivos.`
            : `Workspace: ${workspaceDir}\nAtualizado em: ${new Date().toISOString()}\nConteúdo: ${files} arquivo(s) em ${dirs} pasta(s).\nUse a ferramenta list_workspace para navegar pastas e localizar arquivos específicos.`;

        memory.addNode({
            id: 'core_workspace',
            type: 'context',
            name: 'WORKSPACE',
            content,
            confidence: 1.0,
        });
        try { memory.addEdge('core_memory', 'core_workspace', 'contains'); } catch { /* ignore */ }
    } catch (err) {
        documentLog.warn('core_workspace_refresh_failed', String(err));
    }
}

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
        const fileId = attachment.fileId;

        if (!fileId) {
            voiceLog.error('missing_file_id', 'fileId ausente no attachment');
            return '⚠️ Não foi possível obter o arquivo de áudio (fileId ausente).';
        }

        let audioBuffer: Buffer;
        try {
            audioBuffer = await messageBus.downloadFile(msg.channel, fileId);
        } catch (e) {
            voiceLog.error('audio_download_failed', e);
            return '⚠️ Falha ao baixar o arquivo de áudio do Telegram.';
        }
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

const IMAGE_EXTENSIONS = /\.(jpe?g|png|gif|webp|bmp|tiff?)$/i;

export async function handleDocumentAttachment(
    msg: NormalizedMessage,
    attachment: ChannelAttachment,
    messageBus: MessageBus,
    memory?: MemoryManager,
    visionProfile?: VisionProfile | null
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
            const fileId = attachment.fileId;
            if (!fileId) {
                documentLog.error('missing_file_id', 'fileId ausente no attachment');
            } else {
                try {
                    documentLog.info('downloading_from_telegram', `Downloading ${fileName}`);
                    fileBuffer = await messageBus.downloadFile('telegram', fileId);
                } catch (e) {
                    documentLog.error('telegram_download_failed', e);
                }
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

            const isImage = visionProfile != null && (
                (attachment.mimeType != null && attachment.mimeType.startsWith('image/')) ||
                IMAGE_EXTENSIONS.test(safeFileName)
            );
            if (isImage) {
                const mimeInfo = attachment.mimeType ? ` (${attachment.mimeType})` : '';
                documentLog.info('image_document_detected', `[VISION] image detected via document: ${safeFileName}${mimeInfo}`);
                documentLog.info('image_processing', `[VISION] processing image: ${safeFileName}`);
                const visionDescription = await processVision(fileBuffer, safeFileName, visionProfile);
                documentLog.info('image_analysis_complete', `[VISION] analysis completed: ${safeFileName} (${visionDescription.length} chars)`);
                msg.text = (msg.text || '') + `\n[IMAGEM RECEBIDA: ${safeFileName}]\n[DESCRIÇÃO DA VISÃO]: ${visionDescription}\n`;
            } else {
                msg.text = (msg.text || '') + `\n[ARQUIVO ANEXADO: ${safeFileName} (salvo em workspace/${safeFileName})]\n`;
            }

            // Refresh the workspace index so the model sees all files after this upload.
            if (memory) refreshWorkspaceIndex(memory);

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
        visionLog.warn('vision_not_configured', 'Perfil de visão não encontrado no ModelProfileRegistry.');
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
            const fileId = attachment.fileId;
            if (fileId) {
                try {
                    fileBuffer = await messageBus.downloadFile('telegram', fileId);
                    fileName = `photo_${Date.now()}.jpg`;
                } catch (e) {
                    visionLog.warn('telegram_photo_download_failed', errorMessage(e));
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
