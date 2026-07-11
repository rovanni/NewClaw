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
 *
 * ── Entrega órfã (texto, anexos, áudio) ─────────────────────────────────────────────
 * O ciclo de vida do Goal e o ciclo de vida da requisição HTTP são independentes: um Goal
 * pode legitimamente levar mais tempo que o teto de espera do HTTP (AGENT_RESPONSE_TIMEOUT_MS
 * em chat.ts) — ele continua rodando em background (fire-and-forget, ver MessageBus.
 * processMessage) mesmo depois do `pending` daquela requisição já ter expirado. Quando isso
 * acontece, `send()`/`sendDocument()`/`sendVoice()` não têm mais nenhum `pending` vivo pra
 * resolver. Em vez de descartar o resultado (perda silenciosa, reproduzida ao vivo em
 * 10-11/07/2026 com o texto final de um goal de .pptx sendo jogado fora depois de 21min),
 * TODA entrega sem `pending` — texto, anexos de documento, áudio — cai numa única fila
 * `orphanedDeliveries` por chatId, e é entregue (mesclada) automaticamente na resposta da
 * PRÓXIMA mensagem dessa mesma sessão, qualquer que seja o assunto dela. Um único mecanismo
 * cobre os dois casos que antes eram tratados de formas diferentes (anexo tinha fallback,
 * texto não tinha nenhum).
 */
import { ChannelAdapter, ChannelType, NormalizedResponse, ResponseAttachment } from './ChannelAdapter';
import { createLogger } from '../shared/AppLogger';
import { powerpointBroker } from '../dashboard/routes/powerpointBroker';

const log = createLogger('WebChannelAdapter');
const POWERPOINT_SESSION_PREFIX = 'powerpoint-addin-';
// Limite de sessões com entrega órfã acumulada — proteção contra crescimento sem fim caso
// uma sessão nunca mais mande mensagem. Mesma ordem de grandeza do que uma instalação
// local/pequena de VPS suportaria sem preocupação de memória.
const MAX_ORPHANED_SESSIONS = 200;
// Limite de entregas órfãs acumuladas POR sessão — evita que uma única sessão que nunca
// retorna acumule memória sem limite (ex.: goal que chama send_document repetidas vezes
// enquanto está órfão). Descarta a mais antiga dessa sessão ao estourar, mantendo as mais
// recentes — mesma política de eviction usada no cap global acima.
const MAX_ORPHANED_DELIVERIES_PER_SESSION = 10;
// Tempo que o adapter lembra qual chatId pertencia a um requestId que já estourou o timeout
// de waitForResponse — precisa sobreviver o suficiente pra que, quando o Goal finalmente
// terminar (fire-and-forget, sem relação com esse timeout), send() ainda saiba pra qual
// sessão rotear a entrega órfã. TTL generoso só para não vazar caso o Goal nunca chame
// send() de volta (ex.: trava numa exceção não tratada em algum outro ponto).
const TIMED_OUT_REQUEST_TTL_MS = 30 * 60_000;

interface PendingRequest {
    resolve: (response: NormalizedResponse) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
    chatId: string;
    attachments: ResponseAttachment[];
}

interface TimedOutRequest {
    chatId: string;
    cleanupTimer: NodeJS.Timeout;
}

export class WebChannelAdapter implements ChannelAdapter {
    readonly channelType: ChannelType = 'web';
    readonly displayName: string = 'Web Dashboard';
    readonly isConnected: boolean = true;

    private pending: Map<string, PendingRequest> = new Map();
    // Requisições cujo waitForResponse já expirou, mas cujo Goal correspondente pode ainda
    // terminar e chamar send()/sendDocument()/sendVoice() depois — ver nota de classe.
    private timedOutRequests: Map<string, TimedOutRequest> = new Map();
    // Entregas (texto + anexos) sem requisição HTTP viva pra receber — guardadas por chatId e
    // mescladas na PRÓXIMA resposta dessa mesma sessão. Cobre o canal web puro (dashboard),
    // que — ao contrário do suplemento PowerPoint — não tem mecanismo de polling próprio para
    // buscar entregas assíncronas.
    private orphanedDeliveries: Map<string, NormalizedResponse[]> = new Map();

    async start(): Promise<void> { /* sem conexão externa a iniciar */ }

    async stop(): Promise<void> {
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new Error('WebChannelAdapter stopped'));
        }
        this.pending.clear();
        for (const [, t] of this.timedOutRequests) clearTimeout(t.cleanupTimer);
        this.timedOutRequests.clear();
        this.orphanedDeliveries.clear();
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
     *
     * Se o timeout disparar antes do Goal terminar, o chatId é preservado em
     * `timedOutRequests` (ver nota de classe) — o Goal não é cancelado, só a esperança de
     * entrega síncrona é.
     */
    waitForResponse(requestId: string, chatId: string, timeoutMs: number): Promise<NormalizedResponse> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                const cleanupTimer = setTimeout(() => this.timedOutRequests.delete(requestId), TIMED_OUT_REQUEST_TTL_MS);
                cleanupTimer.unref?.();
                this.timedOutRequests.set(requestId, { chatId, cleanupTimer });
                reject(new Error('Timeout aguardando resposta do agente'));
            }, timeoutMs);
            this.pending.set(requestId, { resolve, reject, timer, chatId, attachments: [] });
        });
    }

    async send(response: NormalizedResponse, context: unknown): Promise<void> {
        const requestId = typeof context === 'string' ? context : String(context);
        const p = this.pending.get(requestId);
        if (!p) {
            this.handleOrphanedSend(requestId, response);
            return;
        }
        clearTimeout(p.timer);
        this.pending.delete(requestId);
        const withTurnAttachments: NormalizedResponse = p.attachments.length > 0
            ? { ...response, attachments: [...(response.attachments ?? []), ...p.attachments] }
            : response;
        p.resolve(this.mergeOrphaned(p.chatId, withTurnAttachments));
    }

    /**
     * send() sem pending vivo: ou a requisição nunca existiu neste adapter (canal errado —
     * não deveria acontecer em uso normal), ou o waitForResponse dela já estourou o timeout
     * e o Goal só terminou depois (ver nota de classe). Nesse segundo caso, a resposta inteira
     * — texto e anexos — vira uma entrega órfã em vez de ser descartada.
     */
    private handleOrphanedSend(requestId: string, response: NormalizedResponse): void {
        const timedOut = this.timedOutRequests.get(requestId);
        if (!timedOut) {
            log.warn('send_no_pending', `Nenhuma requisição HTTP pendente nem registro de timeout para requestId=${requestId} — resposta descartada`);
            return;
        }
        clearTimeout(timedOut.cleanupTimer);
        this.timedOutRequests.delete(requestId);
        this.queueOrphaned(timedOut.chatId, response);
        log.info(
            'response_queued_orphaned',
            `chatId=${timedOut.chatId} requestId=${requestId} reason=http_wait_already_timed_out has_attachments=${(response.attachments?.length ?? 0) > 0}`
        );
    }

    /** Acumula uma entrega (texto e/ou anexos) sem HTTP pendente, respeitando os caps de memória. */
    private queueOrphaned(chatId: string, response: NormalizedResponse): void {
        let list = this.orphanedDeliveries.get(chatId);
        if (!list) {
            if (this.orphanedDeliveries.size >= MAX_ORPHANED_SESSIONS) {
                const oldestChatId = this.orphanedDeliveries.keys().next().value;
                if (oldestChatId !== undefined) this.orphanedDeliveries.delete(oldestChatId);
            }
            list = [];
            this.orphanedDeliveries.set(chatId, list);
        }
        if (list.length >= MAX_ORPHANED_DELIVERIES_PER_SESSION) {
            list.shift();
        }
        list.push(response);
    }

    /**
     * Antes de resolver uma resposta normal, verifica se essa sessão tem entregas órfãs
     * acumuladas e as funde — texto concatenado (com separador visível) e anexos anexados.
     * Consome a fila (delete) para nunca reentregar a mesma entrega órfã duas vezes.
     */
    private mergeOrphaned(chatId: string, response: NormalizedResponse): NormalizedResponse {
        const queued = this.orphanedDeliveries.get(chatId);
        if (!queued || queued.length === 0) return response;
        this.orphanedDeliveries.delete(chatId);
        log.info('orphaned_deliveries_merged', `chatId=${chatId} count=${queued.length}`);

        const orphanedTexts = queued.map(r => r.text).filter((t): t is string => !!t && t.trim().length > 0);
        const orphanedAttachments = queued.flatMap(r => r.attachments ?? []);
        const orphanedOptions = queued.flatMap(r => r.options ?? []);

        const text = orphanedTexts.length > 0
            ? `📎 *Entrega pendente de uma tarefa anterior:*\n${orphanedTexts.join('\n\n')}\n\n---\n\n${response.text}`
            : response.text;

        return {
            ...response,
            text,
            attachments: orphanedAttachments.length > 0 ? [...(response.attachments ?? []), ...orphanedAttachments] : response.attachments,
            options: orphanedOptions.length > 0 ? [...(response.options ?? []), ...orphanedOptions] : response.options,
        };
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
            // Transporte fundamentalmente diferente do dashboard puro (polling do cliente, não
            // request/response) — não dá pra unificar com orphanedDeliveries sem inventar
            // polling onde não existe; mantido como caminho próprio deliberadamente.
            if (chatId.startsWith(POWERPOINT_SESSION_PREFIX)) {
                powerpointBroker.pushDocument(chatId, buffer.toString('base64'), filename);
                log.info('send_document_deferred_to_broker', `chatId=${chatId} filename=${filename} entregue via polling (sem HTTP pendente)`);
                return;
            }
            // Canal web puro (dashboard) não tem polling — guarda o anexo pra entregar assim
            // que a mesma sessão mandar a próxima mensagem (ver mergeOrphaned), em vez de
            // descartar.
            this.queueOrphaned(chatId, { text: '', format: 'plain', attachments: [{ type: 'document', data: buffer, fileName: filename }] });
            log.info('send_document_queued_orphaned', `chatId=${chatId} filename=${filename} sem HTTP pendente — entrega adiada pra próxima mensagem da sessão`);
            return;
        }
        p.attachments.push({ type: 'document', data: buffer, fileName: filename });
    }

    /** Acumula um áudio/voz para entrega junto da resposta final de texto (ver nota de classe). */
    async sendVoice(chatId: string, buffer: Buffer, filename: string = 'voice.ogg'): Promise<void> {
        const p = this.findPendingByChatId(chatId);
        if (!p) {
            // Mesma política de sendDocument (generalização, ver nota de classe): antes lançava
            // exceção para evitar falso-sucesso, mas isso descartava o áudio pra sempre mesmo já
            // pronto — agora fica em espera e é entregue na próxima mensagem da mesma sessão.
            this.queueOrphaned(chatId, { text: '', format: 'plain', attachments: [{ type: 'audio', data: buffer, fileName: filename }] });
            log.info('send_voice_queued_orphaned', `chatId=${chatId} filename=${filename} sem HTTP pendente — entrega adiada pra próxima mensagem da sessão`);
            return;
        }
        p.attachments.push({ type: 'audio', data: buffer, fileName: filename });
    }
}
