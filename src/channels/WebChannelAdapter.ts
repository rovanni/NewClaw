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
 */
import { ChannelAdapter, ChannelType, NormalizedResponse } from './ChannelAdapter';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('WebChannelAdapter');

interface PendingRequest {
    resolve: (response: NormalizedResponse) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
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
     */
    waitForResponse(requestId: string, timeoutMs: number): Promise<NormalizedResponse> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new Error('Timeout aguardando resposta do agente'));
            }, timeoutMs);
            this.pending.set(requestId, { resolve, reject, timer });
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
        p.resolve(response);
    }
}
