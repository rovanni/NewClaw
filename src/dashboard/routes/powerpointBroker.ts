import crypto from 'crypto';

export type CommandStatus = 'executed' | 'failed' | 'unsupported';
export type CommandAction = 'addTextBox' | 'insertDocument';

export interface CommandArgs {
    text?: string;
    x?: number;
    y?: number;
    /** insertDocument: conteúdo do arquivo em base64 */
    data?: string;
    /** insertDocument: nome do arquivo (usado para decidir como inserir) */
    fileName?: string;
}

export interface PendingCommand {
    commandId: string;
    sessionId: string;
    action: CommandAction;
    args: CommandArgs;
    resolve: (result: { success: boolean; output: string }) => void;
    timeoutId: NodeJS.Timeout;
}

export interface ClientCommand {
    commandId: string;
    action: CommandAction;
    args: CommandArgs;
}

export class PowerPointBroker {
    // Fila de comandos pendentes por sessionId (o que o frontend vai puxar)
    private queues = new Map<string, ClientCommand[]>();
    // Comandos aguardando resolução
    private pending = new Map<string, PendingCommand>();

    public dispatch(sessionId: string, action: 'addTextBox', args: CommandArgs, timeoutMs = 60000): Promise<{ success: boolean; output: string }> {
        return new Promise((resolve) => {
            const commandId = crypto.randomUUID();

            const timeoutId = setTimeout(() => {
                this.cleanup(commandId);
                resolve({ success: false, output: `Timeout: o comando ${commandId} expirou após ${timeoutMs}ms sem resposta do PowerPoint.` });
            }, timeoutMs);

            const pendingCmd: PendingCommand = {
                commandId,
                sessionId,
                action,
                args,
                resolve,
                timeoutId
            };

            this.pending.set(commandId, pendingCmd);

            let queue = this.queues.get(sessionId);
            if (!queue) {
                queue = [];
                this.queues.set(sessionId, queue);
            }
            queue.push({ commandId, action, args });
        });
    }

    /**
     * Enfileira um documento para entrega assíncrona via polling, sem esperar ack — usado
     * quando o goal que gerou o anexo termina depois que a requisição HTTP original que o
     * pediu já foi fechada (ex.: mensagem enfileirada atrás de uma conversa ocupada, cujo
     * round-trip HTTP foi resolvido de imediato com um ACK). Ver WebChannelAdapter.sendDocument.
     */
    public pushDocument(sessionId: string, data: string, fileName: string): void {
        let queue = this.queues.get(sessionId);
        if (!queue) {
            queue = [];
            this.queues.set(sessionId, queue);
        }
        queue.push({ commandId: crypto.randomUUID(), action: 'insertDocument', args: { data, fileName } });
    }

    public poll(sessionId: string): ClientCommand | null {
        const queue = this.queues.get(sessionId);
        if (!queue || queue.length === 0) {
            return null;
        }
        // Não removemos do queue até o timeout ou o result, mas para o polling
        // shift() remove da fila de "a entregar"
        const cmd = queue.shift()!;
        if (queue.length === 0) {
            this.queues.delete(sessionId);
        }
        return cmd;
    }

    public ack(commandId: string, sessionId: string, status: CommandStatus, error?: string): { error?: string } {
        const pendingCmd = this.pending.get(commandId);

        if (!pendingCmd) {
            return { error: 'Unknown commandId or duplicate result' };
        }

        if (pendingCmd.sessionId !== sessionId) {
            return { error: 'Session mismatch' };
        }

        clearTimeout(pendingCmd.timeoutId);
        this.pending.delete(commandId);

        // Remove from queue if it was still there (e.g. never polled)
        const queue = this.queues.get(sessionId);
        if (queue) {
            const index = queue.findIndex(c => c.commandId === commandId);
            if (index !== -1) {
                queue.splice(index, 1);
            }
        }

        if (status === 'executed') {
            pendingCmd.resolve({ success: true, output: `Comando executado com sucesso.` });
        } else {
            pendingCmd.resolve({ success: false, output: `Falha na execução: ${error || status}` });
        }

        return {};
    }

    private cleanup(commandId: string) {
        const pendingCmd = this.pending.get(commandId);
        if (!pendingCmd) return;
        this.pending.delete(commandId);

        const queue = this.queues.get(pendingCmd.sessionId);
        if (queue) {
            const index = queue.findIndex(c => c.commandId === commandId);
            if (index !== -1) {
                queue.splice(index, 1);
            }
        }
    }
}

export const powerpointBroker = new PowerPointBroker();
