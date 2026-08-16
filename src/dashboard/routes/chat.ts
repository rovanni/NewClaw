import { Router, Request, Response } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import path from 'path';
import { errorMessage } from '../../shared/errors';
import { DashboardContext } from './types';
import type { ChannelAttachment, NormalizedMessage, ResponseAttachment } from '../../channels/ChannelAdapter';
import { MessageBus } from '../../channels/MessageBus';

const chatRateLimit = new Map<string, number[]>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;

// Timeout de espera pela resposta do agente (pode envolver várias chamadas de ferramenta/LLM).
const AGENT_RESPONSE_TIMEOUT_MS = 10 * 60_000;

// Middleware multipart isolado desta rota — não substitui nem afeta o express.json() global
// usado pelas demais rotas do dashboard.
//
// O teto de arquivos é o MESMO da ingestão (MessageBus.MAX_ATTACHMENTS_PER_MESSAGE): aceitar aqui
// mais do que o Core processa só produziria upload desperdiçado e anexo virando fato de excedente.
// Antes eram dois números literais independentes — 5 aqui e 5 na interface — que podiam divergir
// numa edição e ninguém perceberia (RFC-004, Correção 5).
export const MAX_UPLOAD_FILES = MessageBus.MAX_ATTACHMENTS_PER_MESSAGE;
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_UPLOAD_FILES },
});

/**
 * Envolve o multer para que uma recusa vire JSON com código estável, e não a página HTML de erro
 * padrão do Express.
 *
 * O que acontecia antes: enviar mais arquivos que o limite produzia `HTTP 500` com corpo
 * `<!DOCTYPE html>…MulterError: Too many files…`. A interface faz `res.json()` nessa resposta,
 * o parse explode e o usuário vê "Unexpected token '<'" — mensagem sem nenhuma relação com o que
 * ele fez. O código (`too_many_files`) é traduzido no cliente, nos três idiomas; o backend não
 * emite texto de usuário, que sairia sempre em português.
 */
export function uploadFiles(req: Request, res: Response, next: (err?: unknown) => void): void {
    upload.array('files', MAX_UPLOAD_FILES)(req, res, (err: unknown) => {
        if (err instanceof multer.MulterError) {
            const code = err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE'
                ? 'too_many_files'
                : err.code === 'LIMIT_FILE_SIZE' ? 'file_too_large' : 'upload_failed';
            res.status(400).json({
                success: false,
                error: code,
                max: MAX_UPLOAD_FILES,
                maxBytes: MAX_UPLOAD_BYTES,
            });
            return;
        }
        if (err) {
            res.status(400).json({ success: false, error: 'upload_failed' });
            return;
        }
        next();
    });
}

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

    /**
     * Conversas processando agora — GET /api/chat/active.
     *
     * A interface consulta isto ao carregar para restaurar o indicador de progresso e o botão de
     * parar. Sem isso, o estado "processando" existia só na aba que enviou a mensagem: recarregar
     * a página, trocar de tela ou reiniciar o servidor deixava o usuário sem indicação nenhuma e
     * sem como interromper, com o turno seguindo em execução e o modelo ocupando a GPU.
     *
     * Leitura de memória, sem I/O: pode ser chamado no polling do dashboard.
     */
    router.get('/active', (_req: Request, res: Response) => {
        const controller = ctx.controller as unknown as {
            agentLoop?: { getActiveTurns?: () => Array<{ conversationId: string; elapsedMs: number }> };
            goalOrchestrator?: { getActiveGoals?: () => Array<{ id: string; sessionKey: string; status: string; createdAt: number }> };
        };

        const active: Array<{ conversationId: string; elapsedMs: number; kind: 'turn' | 'goal'; status?: string }> = [];
        for (const t of controller?.agentLoop?.getActiveTurns?.() ?? []) {
            active.push({ ...t, kind: 'turn' });
        }

        // Goals TAMBÉM contam, e são o caso que mais demora: uma pergunta pode ser roteada para o
        // GoalOrchestrator em vez do AgentLoop, e aí `activeTurns` fica vazio enquanto o trabalho
        // continua por minutos. Foi exatamente o que aconteceu em 02/08/2026 (route=goal, 189s de
        // execução) — olhar só os turnos deixaria a tela dizendo "ocioso" com o goal rodando.
        const now = Date.now();
        for (const g of controller?.goalOrchestrator?.getActiveGoals?.() ?? []) {
            // sessionKey costuma ser "canal:usuário"; a interface web usa a parte do usuário como
            // id de conversa. Sem a chave, o goal ainda aparece — o essencial é o usuário saber
            // que existe algo em andamento.
            // Goal `blocked` NÃO é trabalho em andamento: ele está parado esperando uma decisão
            // humana (autorização) ou um replan. Reportá-lo como ativo fazia a interface exibir
            // "processando" e manter o botão de enviar em modo "Parar" — o usuário não conseguia
            // nem responder à autorização que o próprio sistema estava pedindo (observado ao
            // dirigir o painel em 04/08/2026). Quem representa esse estado é `pendingAuth` abaixo.
            if (g.status === 'blocked') continue;
            const conversationId = (g.sessionKey ?? '').split(':').pop() || g.id;
            if (active.some(a => a.conversationId === conversationId)) continue;  // já contado como turno
            active.push({
                conversationId,
                elapsedMs: g.createdAt ? now - g.createdAt : 0,
                kind: 'goal',
                status: g.status,
            });
        }

        // Ações perigosas esperando decisão do usuário NESTA conversa. Vive aqui, e não num
        // endpoint próprio, porque é a mesma pergunta que a tela já faz ("o que está acontecendo
        // com a minha conversa?") no mesmo polling — um goal em `needs_auth` está justamente
        // PARADO, então nunca apareceria na lista `active` acima.
        const conversationId = typeof _req.query.sessionId === 'string' ? _req.query.sessionId : undefined;
        const workflowEngine = (ctx.controller as unknown as {
            getWorkflowEngine?: () => { getPendingByConversation?: (id: string) => Array<{ id: string; tool: string; params: Record<string, unknown>; createdAt: number }> };
        }).getWorkflowEngine?.();
        const pendingAuth = (conversationId && workflowEngine?.getPendingByConversation)
            ? workflowEngine.getPendingByConversation(conversationId).map(t => ({
                txnId: t.id,
                tool: t.tool,
                // Só o comando/alvo, para a interface poder mostrar o que está sendo aprovado.
                // Nunca o objeto inteiro de params: pode conter conteúdo grande de arquivo.
                detail: typeof t.params?.command === 'string' ? t.params.command as string : undefined,
                createdAt: t.createdAt,
            }))
            : [];

        // S226: janela entre o 202 de POST /api/chat e o goal/turn existir em algo rastreável
        // (activeTurns/GoalStore) — classificação (GoalExtractor/UnifiedIntentRouter) sozinha já
        // leva alguns segundos, e até ela terminar `active` acima está corretamente vazio. Sem
        // este campo, um polling que caia nessa janela conclui "terminou" antes de ter começado
        // (incidente observado 12/08/2026: resposta computada em 13s pelo backend, nunca exibida
        // — o polling desistiu do turnId nos primeiros ~2,5s). turnId é opcional e só informado
        // pelo polling que já tem um turno em mãos (ver startTurnPolling no front, S227).
        const turnId = typeof _req.query.turnId === 'string' ? _req.query.turnId : undefined;
        const pending = !!(turnId && ctx.controller?.getWebAdapter().hasPendingAsyncTurn(turnId));

        res.json({ success: true, active, pendingAuth, pending });
    });

    /**
     * Decisão de autorização vinda do Dashboard — POST /api/chat/auth-decision.
     *
     * Telegram/Discord/WhatsApp/Signal entregam essa decisão pelo botão inline da plataforma
     * (texto `auth:<approve|reject>:<txnId>`), e os quatro chamam a MESMA closure de
     * `AgentController.createWorkflowCallback()`. O canal web não tem botão de plataforma — esta
     * rota é o equivalente dele, e chama exatamente a mesma closure. Nenhuma regra de
     * autorização, de goal ou de sessão é reimplementada aqui: a rota só traduz "o usuário
     * clicou" para a chamada que já existe, e devolve à tela o texto que o callback produziu
     * (mesmo caminho `waitForResponse` do POST /api/chat).
     */
    router.post('/auth-decision', async (req: Request, res: Response) => {
        const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
        const txnId = typeof req.body?.txnId === 'string' ? req.body.txnId.trim() : '';
        const decision = req.body?.decision === 'approved' ? 'approved'
            : req.body?.decision === 'rejected' ? 'rejected' : null;

        if (!sessionId || !txnId || !decision) {
            return res.status(400).json({ success: false, error: 'sessionId, txnId e decision ("approved"|"rejected") são obrigatórios' });
        }

        if (!ctx.controller) {
            return res.status(503).json({ success: false, error: 'Agente não inicializado' });
        }

        try {
            const webAdapter = ctx.controller.getWebAdapter();
            if (!webAdapter.workflowCallback) {
                return res.status(503).json({ success: false, error: 'Canal web sem callback de autorização registrado' });
            }

            const requestId = crypto.randomUUID();
            const responsePromise = webAdapter.waitForResponse(requestId, sessionId, AGENT_RESPONSE_TIMEOUT_MS);
            await webAdapter.workflowCallback(sessionId, txnId, decision, requestId);
            const response = await responsePromise;

            res.json({
                success: true,
                response: response.text,
                attachments: (response.attachments ?? []).map(serializeAttachment),
            });
        } catch (err) {
            res.status(500).json({ success: false, error: errorMessage(err) });
        }
    });

    router.post('/', uploadFiles, async (req: Request, res: Response) => {
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

            // Fluxo assíncrono (Incremento 2): O WebChannelAdapter não cria timer nem prende requisição HTTP.
            webAdapter.registerAsyncTurn(requestId, sessionId);

            messageBus.processMessage(normalizedMsg).catch(err => {
                console.error('processMessage_failed_async', err, 'Background processing failed for outbox flow');
            });

            res.status(202).json({
                success: true,
                turnId: requestId,
                sessionId
            });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    /**
     * Incremento 2: GET /api/chat/outbox
     * Endpoint determinístico para consultar a Outbox pelo turnId.
     */
    router.get('/outbox', async (req: Request, res: Response) => {
        const turnId = req.query.turnId as string;
        if (!turnId) {
            return res.status(400).json({ success: false, error: 'turnId obrigatorio' });
        }

        if (!ctx.controller) {
            return res.status(503).json({ success: false, error: 'Agente não inicializado' });
        }

        const webAdapter = ctx.controller.getWebAdapter();
        const response = webAdapter.consumeOutbox(turnId);

        if (!response) {
            // A resposta não está pronta ou o turnId é inválido
            return res.status(404).json({ success: false, error: 'not_ready_or_not_found' });
        }

        const outAttachments = (response.attachments ?? []).map(serializeAttachment);

        res.json({
            success: true,
            response: response.text,
            options: response.options,
            attachments: outAttachments.length > 0 ? outAttachments : undefined,
        });
    });

    return router;
}
