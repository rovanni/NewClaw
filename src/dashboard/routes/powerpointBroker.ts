import crypto from 'crypto';

export type CommandStatus = 'executed' | 'failed' | 'unsupported';

export interface CommandArgs {
    text: string;
    x?: number;
    y?: number;
}

export interface PendingCommand {
    commandId: string;
    sessionId: string;
    action: 'addTextBox';
    args: CommandArgs;
    resolve: (result: { success: boolean; output: string }) => void;
    timeoutId: NodeJS.Timeout;
}

export interface ClientCommand {
    commandId: string;
    action: 'addTextBox';
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
