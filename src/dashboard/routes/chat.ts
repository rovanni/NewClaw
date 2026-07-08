import { Router, Request, Response } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import path from 'path';
import { errorMessage } from '../../shared/errors';
import { DashboardContext } from './types';
import type { ChannelAttachment, NormalizedMessage, ResponseAttachment } from '../../channels/ChannelAdapter';

const chatRateLimit = new Map<string, number[]>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;

// Timeout de espera pela resposta do agente (pode envolver várias chamadas de ferramenta/LLM).
const AGENT_RESPONSE_TIMEOUT_MS = 10 * 60_000;

// Middleware multipart isolado desta rota — não substitui nem afeta o express.json() global
// usado pelas demais rotas do dashboard.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024, files: 5 },
});

function classifyAttachmentType(mimeType: string): ChannelAttachment['type'] {
    if (mimeType.startsWith('image/')) return 'photo';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType.startsWith('video/')) return 'video';
    return 'document';
}

// Anexos de SAÍDA (arquivos gerados pelo agente via send_document/send_audio) chegam como
// Buffer puro — Telegram/Discord não precisam de mimetype (a própria API do canal infere),
// mas o navegador precisa de um Blob com `type` correto pra abrir/baixar direito. Cobre só
// as extensões que as skills deste projeto realmente geram (pptx-generator, html-pdf-converter,
// marp) — sem dependência nova (pacote `mime`) para uma lista pequena e estável.
const EXT_MIME: Record<string, string> = {
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pdf': 'application/pdf',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.zip': 'application/zip',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.mp4': 'video/mp4',
};
export function mimeTypeForFile(fileName: string): string {
    return EXT_MIME[path.extname(fileName).toLowerCase()] || 'application/octet-stream';
}

/** Serializa ResponseAttachment (data: Buffer | string) para JSON — o front recebe base64 puro. */
export function serializeAttachment(a: ResponseAttachment): { type: string; fileName?: string; mimeType: string; data: string } {
    const fileName = a.fileName || 'arquivo';
    return {
        type: a.type,
        fileName,
        mimeType: a.mimeType || mimeTypeForFile(fileName),
        data: Buffer.isBuffer(a.data) ? a.data.toString('base64') : String(a.data),
    };
}

export function createChatRouter(ctx: DashboardContext): Router {
    const router = Router();

    router.post('/', upload.array('files', 5), async (req: Request, res: Response) => {
        const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
        const now = Date.now();
        const timestamps = chatRateLimit.get(clientIp) || [];
        const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);

        if (recent.length >= RATE_LIMIT_MAX) {
            const retryAfter = Math.ceil((recent[0] + RATE_LIMIT_WINDOW_MS - now) / 1000);
            res.set('Retry-After', String(retryAfter));
            return res.status(429).json({ error: `Rate limit exceeded. Try again in ${retryAfter}s.` });
        }

        recent.push(now);
        chatRateLimit.set(clientIp, recent);

        if (chatRateLimit.size > 100) {
            for (const [ip, ts] of chatRateLimit) {
                if (ts.every(t => now - t > RATE_LIMIT_WINDOW_MS)) chatRateLimit.delete(ip);
            }
        }

        if (!ctx.controller) {
            return res.status(500).json({ error: 'AgentController not initialized' });
        }

        try {
            const message: string = req.body?.message || '';
            const sessionId: string = req.body?.sessionId || 'web-session';
            const files = (req.files as Express.Multer.File[] | undefined) || [];

            if (!message && files.length === 0) {
                return res.status(400).json({ error: 'Message or attachment required' });
            }

            const attachments: ChannelAttachment[] = files.map(f => ({
                type: classifyAttachmentType(f.mimetype),
                data: f.buffer.toString('base64'),
                fileName: f.originalname,
                mimeType: f.mimetype,
            }));

            const messageBus = ctx.controller.getMessageBus();
            const webAdapter = ctx.controller.getWebAdapter();
            const requestId = crypto.randomUUID();

            // Detecta o canal de origem pelo prefixo do sessionId.
            // O suplemento PowerPoint gera sessionIds com prefixo 'powerpoint-addin-'.
            // Outros canais (dashboard web, Telegram, etc.) nao possuem esse prefixo.
            const metadata: Record<string, unknown> = {};
            if (sessionId.startsWith('powerpoint-addin-')) {
                metadata.hostApp = 'powerpoint';
                // slideContext e enviado pelo add-in com info do slide ativo (numero, total, textos).
                // So existe quando a mensagem vem do suplemento PowerPoint.
                const slideContext = req.body?.slideContext;
                if (slideContext && typeof slideContext === 'object') {
                    metadata.slideContext = slideContext;
                }
            }

            const normalizedMsg: NormalizedMessage = {
                messageId: requestId,
                channel: 'web',
                userId: sessionId,
                type: attachments.length > 0 ? attachments[0].type : 'text',
                text: message,
                attachments: attachments.length > 0 ? attachments : undefined,
                rawContext: requestId,
                chatId: sessionId,
                metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
            };

            // Mesmo pipeline usado por Telegram/Discord/WhatsApp/Signal: MessageBus enfileira
            // por conversa, processa anexos (voice→whisper, photo/document→vision) e roda o
            // AgentLoop/GoalOrchestrator. waitForResponse faz a ponte entre o fire-and-forget
            // do MessageBus e o request/response HTTP desta rota. sessionId é passado para que
            // send_document/send_audio (que só conhecem o chatId, não o requestId) consigam
            // acumular anexos na requisição HTTP certa — ver WebChannelAdapter.
            const responsePromise = webAdapter.waitForResponse(requestId, sessionId, AGENT_RESPONSE_TIMEOUT_MS);
            await messageBus.processMessage(normalizedMsg);
            const response = await responsePromise;

            const outAttachments = (response.attachments ?? []).map(serializeAttachment);

            res.json({
                success: true,
                response: response.text,
                sessionId,
                options: response.options,
                attachments: outAttachments.length > 0 ? outAttachments : undefined,
            });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    return router;
}
