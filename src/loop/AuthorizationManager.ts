/**
 * AuthorizationManager — Human-in-the-Loop Management
 * 
 * Encapsulates pending actions, authorization requests, and execution.
 */

import { createLogger } from '../shared/AppLogger';
import { ResponseOption } from '../channels/ChannelAdapter';


const log = createLogger('AuthorizationManager');

export interface PendingAction {
    toolName: string;
    arguments: Record<string, any>;
    timestamp: number;
}

export interface AuthRequest {
    text: string;
    options: ResponseOption[];
}

export class AuthorizationManager {
    private pendingActions = new Map<string, PendingAction>();

    /** Add a tool call to the pending queue */
    addPending(conversationId: string, toolName: string, args: Record<string, any>): void {
        this.pendingActions.set(conversationId, {
            toolName,
            arguments: args,
            timestamp: Date.now()
        });
        log.info(`[AUTH] Action pending for ${conversationId}: ${toolName}`);
    }

    /** Get the pending action for a conversation */
    getPending(conversationId: string): PendingAction | undefined {
        return this.pendingActions.get(conversationId);
    }

    /** Remove a pending action */
    removePending(conversationId: string): void {
        this.pendingActions.delete(conversationId);
    }

    /** Format a request message with interactive buttons */
    formatRequest(toolName: string, args: Record<string, any>): AuthRequest {
        const { emoji, action, details, risk } = this.summarize(toolName, args);

        const lines = [
            `${emoji} **${action}**`,
            '',
            ...details.map(d => `• ${d}`),
            '',
            risk === 'high'
                ? '⚠️ _Esta ação pode modificar o sistema. Confirme apenas se esperava isso._'
                : '_Responda **sim** para autorizar ou **não** para cancelar._',
        ];

        const text = lines.join('\n');

        const options: ResponseOption[] = [
            { label: '✅ Sim, pode fazer', value: 'sim' },
            { label: '❌ Não, cancela', value: 'cancelar' }
        ];

        return { text, options };
    }

    private summarize(toolName: string, args: Record<string, any>): {
        emoji: string; action: string; details: string[]; risk: 'low' | 'medium' | 'high';
    } {
        switch (toolName) {
            case 'exec_command': {
                const cmd = String(args.command || '').trim();
                const lines = cmd.split('\n').map(l => l.trim()).filter(Boolean);
                // Infer intent from first non-comment, non-variable line
                const meaningful = lines.find(l => !l.startsWith('#') && !l.match(/^[A-Z_]+=/) && l.length > 3) || lines[0] || cmd;
                const preview = meaningful.length > 70 ? meaningful.slice(0, 70) + '…' : meaningful;
                const isDestructive = /rm\s+-rf|drop\s+table|mkfs|format/i.test(cmd);
                return {
                    emoji: '🖥️',
                    action: 'Executar comando no servidor',
                    details: [
                        `\`${preview}\``,
                        lines.length > 1 ? `_(script com ${lines.length} linhas)_` : '',
                        args.workdir ? `Diretório: \`${args.workdir}\`` : '',
                    ].filter(Boolean),
                    risk: isDestructive ? 'high' : 'medium',
                };
            }

            case 'write_file':
            case 'edit_file': {
                const filePath = String(args.path || args.file_path || '');
                const fileName = filePath.split('/').pop() || filePath;
                const isOverwrite = toolName === 'write_file';
                return {
                    emoji: '📝',
                    action: isOverwrite ? `Criar/sobrescrever arquivo` : `Editar arquivo`,
                    details: [`\`${fileName}\``],
                    risk: 'medium',
                };
            }

            case 'send_document': {
                const filePath = String(args.file_path || '');
                const fileName = filePath.split('/').pop() || filePath;
                return {
                    emoji: '📤',
                    action: 'Enviar arquivo',
                    details: [`\`${fileName}\``],
                    risk: 'low',
                };
            }

            case 'send_image':
            case 'send_video':
            case 'send_audio': {
                const filePath = String(args.file_path || args.path || '');
                const fileName = filePath.split('/').pop() || filePath;
                const typeLabel = toolName === 'send_image' ? 'imagem' : toolName === 'send_video' ? 'vídeo' : 'áudio';
                return {
                    emoji: '📤',
                    action: `Enviar ${typeLabel}`,
                    details: [`\`${fileName}\``],
                    risk: 'low',
                };
            }

            case 'read_tool': {
                const filePath = String(args.path || args.file_path || '');
                const fileName = filePath.split('/').pop() || filePath;
                return {
                    emoji: '📂',
                    action: 'Ler arquivo',
                    details: [`\`${fileName}\``],
                    risk: 'low',
                };
            }

            case 'schedule_tool': {
                return {
                    emoji: '⏰',
                    action: 'Agendar tarefa',
                    details: [
                        args.task ? `Tarefa: ${String(args.task).slice(0, 60)}` : '',
                        args.when ? `Quando: ${args.when}` : '',
                    ].filter(Boolean),
                    risk: 'low',
                };
            }

            default: {
                // Generic fallback: show first 2 params in readable form
                const pairs = Object.entries(args)
                    .slice(0, 2)
                    .map(([k, v]) => `${k}: \`${String(v).slice(0, 60)}\``);
                return {
                    emoji: '🛠️',
                    action: `Usar ferramenta: ${toolName}`,
                    details: pairs,
                    risk: 'medium',
                };
            }
        }
    }

    /** Check if an action matches the pending one (for consumption) */
    isMatch(pending: PendingAction, toolName: string, args: Record<string, any>): boolean {
        return pending.toolName === toolName && 
               JSON.stringify(pending.arguments) === JSON.stringify(args);
    }
}
