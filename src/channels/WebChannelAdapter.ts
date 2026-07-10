/**
 * WebChannelAdapter — ChannelAdapter para o Dashboard web (chat em localhost:3090)
 *
 * O MessageBus é fire-and-forget: processMessage() enfileira e retorna; a resposta real
 * chega depois via adapter.send(). O Dashboard, porém, expõe um endpoint HTTP request/response
 * (POST /api/chat). Este adapter faz a ponte: cada requisição HTTP registra um "pending"
 * por requestId antes de chamar messageBus.processMessage(); send() resolve esse pending
 * quando a resposta chega, permitindo à rota apenas dar `await`.
 *
 * Não há conexão externa a manter (start/stop são no-ops) — o "canal" é a própria requisição HTTP.
 *
 * ── Anexos (send_document / send_audio) ─────────────────────────────────────────────
 * Telegram e Discord entregam anexos via push imediato (a tool manda o arquivo assim que
 * é gerado, no meio do turno). O canal web não tem "push" — só existe UM round-trip HTTP
 * por turno, resolvido pela resposta final de texto (send()). Por isso sendDocument()/
 * sendVoice() aqui NÃO enviam nada sozinhos: acumulam o anexo no pending da sessão (por
 * chatId, que é o mesmo id usado por send_document.setContext) e send() funde esses
 * anexos acumulados na NormalizedResponse final antes de resolver a promise pendente.
 * Isso cobre inclusive o caso comum de deferSendDocument (GoalExecutionLoop adia o
 * send_document pro fim do goal) — o anexo chega perto do texto final de qualquer forma.
 */
import { ChannelAdapter, ChannelType, NormalizedResponse, ResponseAttachment } from './ChannelAdapter';
import { createLogger } from '../shared/AppLogger';
import { powerpointBroker } from '../dashboard/routes/powerpointBroker';

const log = createLogger('WebChannelAdapter');
const POWERPOINT_SESSION_PREFIX = 'powerpoint-addin-';

interface PendingRequest {
    resolve: (response: NormalizedResponse) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
    chatId: string;
    attachments: ResponseAttachment[];
}

export class WebChannelAdapter implements ChannelAdapter {
    readonly channelType: ChannelType = 'web';
    readonly displayName: string = 'Web Dashboard';
    readonly isConnected: boolean = true;

    private pending: Map<string, PendingRequest> = new Map();

    async start(): Promise<void> { /* sem conexão externa a iniciar */ }

    async stop(): Promise<void> {
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new Error('WebChannelAdapter stopped'));
        }
        this.pending.clear();
    }

    async healthCheck(): Promise<{ ok: boolean; details?: string }> {
        return { ok: true, details: `${this.pending.size} requisição(ões) pendente(s)` };
    }

    /**
     * Aguarda a resposta do MessageBus para uma requisição HTTP específica (rawContext=requestId).
     * Resolve no primeiro send() recebido. Caso o MessageBus dispare um ACK de fila ocupada
     * (duas mensagens simultâneas na mesma sessão) antes da resposta final, o round-trip HTTP
     * retorna o ACK; a resposta final segue sendo persistida na conversa normalmente.
     *
     * chatId (mesmo valor de NormalizedMessage.chatId/sessionId) é guardado no pending para
     * que sendDocument()/sendVoice() — chamados por chatId, não por requestId — encontrem a
     * requisição HTTP em aberto certa e acumulem o anexo nela.
     */
    waitForResponse(requestId: string, chatId: string, timeoutMs: number): Promise<NormalizedResponse> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new Error('Timeout aguardando resposta do agente'));
            }, timeoutMs);
            this.pending.set(requestId, { resolve, reject, timer, chatId, attachments: [] });
        });
    }

    async send(response: NormalizedResponse, context: unknown): Promise<void> {
        const requestId = typeof context === 'string' ? context : String(context);
        const p = this.pending.get(requestId);
        if (!p) {
            log.warn('send_no_pending', `Nenhuma requisição HTTP pendente para requestId=${requestId}`);
            return;
        }
        clearTimeout(p.timer);
        this.pending.delete(requestId);
        p.resolve(p.attachments.length > 0
            ? { ...response, attachments: [...(response.attachments ?? []), ...p.attachments] }
            : response);
    }

    /** Encontra o pending mais recente para um chatId — usado por sendDocument/sendVoice. */
    private findPendingByChatId(chatId: string): PendingRequest | undefined {
        let match: PendingRequest | undefined;
        for (const p of this.pending.values()) {
            if (p.chatId === chatId) match = p; // mais recente vence (Map preserva ordem de inserção)
        }
        return match;
    }

    /** Acumula um documento para entrega junto da resposta final de texto (ver nota de classe). */
    async sendDocument(chatId: string, buffer: Buffer, filename: string, _caption?: string): Promise<void> {
        const p = this.findPendingByChatId(chatId);
        if (!p) {
            // Sessão do suplemento PowerPoint: mesmo sem HTTP vivo, o suplemento faz polling de
            // comandos (startCommandPolling em powerpoint.ts) — usa esse canal como entrega
            // assíncrona em vez de descartar. Cobre o caso de uma mensagem enfileirada atrás de
            // uma conversa ocupada: o round-trip HTTP original já foi resolvido com um ACK antes
            // do goal terminar, então quando o anexo fica pronto não há mais requisição pendente.
            if (chatId.startsWith(POWERPOINT_SESSION_PREFIX)) {
                powerpointBroker.pushDocument(chatId, buffer.toString('base64'), filename);
                log.info('send_document_deferred_to_broker', `chatId=${chatId} filename=${filename} entregue via polling (sem HTTP pendente)`);
                return;
            }
            // Lança em vez de descartar silenciosamente: sem isso, send_document.ts acreditava
            // que o anexo tinha sido entregue quando na verdade não havia requisição HTTP viva
            // para acumulá-lo — mesma classe de falso-sucesso corrigida em sendVoice abaixo.
            throw new Error(`Nenhuma requisição HTTP pendente para chatId=${chatId} — anexo descartado`);
        }
        p.attachments.push({ type: 'document', data: buffer, fileName: filename });
    }

    /** Acumula um áudio/voz para entrega junto da resposta final de texto (ver nota de classe). */
    async sendVoice(chatId: string, buffer: Buffer, filename: string = 'voice.ogg'): Promise<void> {
        const p = this.findPendingByChatId(chatId);
        if (!p) {
            // Lança em vez de descartar silenciosamente (ver bug real documentado em send_audio.ts:
            // goal marcado completed sem áudio nenhum ter chegado ao usuário).
            throw new Error(`Nenhuma requisição HTTP pendente para chatId=${chatId} — anexo descartado`);
        }
        p.attachments.push({ type: 'audio', data: buffer, fileName: filename });
    }
}
