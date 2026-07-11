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
// Limite de sessões com anexo órfão acumulado — proteção contra crescimento sem fim caso uma
// sessão nunca mais mande mensagem (ver orphanedAttachments abaixo). Mesma ordem de grandeza
// do que uma instalação local/pequena de VPS suportaria sem preocupação de memória.
const MAX_ORPHANED_SESSIONS = 200;

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
    // Anexos que ficaram sem requisição HTTP viva pra entregar (ver sendDocument abaixo) —
    // guardados por chatId e mesclados na PRÓXIMA resposta dessa mesma sessão, seja qual for
    // o assunto dela. Cobre o canal web puro (dashboard), que — ao contrário do suplemento
    // PowerPoint — não tem mecanismo de polling próprio para buscar entregas assíncronas.
    private orphanedAttachments: Map<string, ResponseAttachment[]> = new Map();

    async start(): Promise<void> { /* sem conexão externa a iniciar */ }

    async stop(): Promise<void> {
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new Error('WebChannelAdapter stopped'));
        }
        this.pending.clear();
        this.orphanedAttachments.clear();
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
        // Antes de resolver, verifica se essa sessão tem entrega órfã acumulada (ver
        // sendDocument) — o próximo round-trip HTTP da mesma conversa é a primeira chance de
        // efetivamente entregar um anexo que ficou pronto depois que a requisição original já
        // tinha fechado (ex.: goal que passou dos 10min do AGENT_RESPONSE_TIMEOUT_MS).
        const orphaned = this.orphanedAttachments.get(p.chatId);
        if (orphaned && orphaned.length > 0) {
            this.orphanedAttachments.delete(p.chatId);
            p.attachments.push(...orphaned);
            log.info('orphaned_attachments_merged', `chatId=${p.chatId} count=${orphaned.length}`);
        }
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
            // Canal web puro (dashboard) não tem polling — guarda o anexo pra entregar assim
            // que a mesma sessão mandar a próxima mensagem (ver send()), em vez de descartar.
            // Reproduzido ao vivo em 10/07: goal validou com sucesso (.pptx gerado e íntegro
            // no workspace) mas a entrega falhou porque a requisição HTTP original já tinha
            // fechado (goal levou 21min, além do AGENT_RESPONSE_TIMEOUT_MS de 10min) — o
            // usuário nunca recebeu um arquivo que já existia pronto, e repetiu o pedido do
            // zero. Isso lançava exceção antes (mesma classe de falso-sucesso corrigida abaixo
            // em sendVoice) — agora vira uma entrega adiada de verdade.
            let list = this.orphanedAttachments.get(chatId);
            if (!list) {
                if (this.orphanedAttachments.size >= MAX_ORPHANED_SESSIONS) {
                    const oldestChatId = this.orphanedAttachments.keys().next().value;
                    if (oldestChatId !== undefined) this.orphanedAttachments.delete(oldestChatId);
                }
                list = [];
                this.orphanedAttachments.set(chatId, list);
            }
            list.push({ type: 'document', data: buffer, fileName: filename });
            log.info('send_document_queued_orphaned', `chatId=${chatId} filename=${filename} sem HTTP pendente — entrega adiada pra próxima mensagem da sessão`);
            return;
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
