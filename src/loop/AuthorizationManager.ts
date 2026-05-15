/**
 * AuthorizationManager — Human-in-the-Loop Management
 * 
 * Encapsulates pending actions, authorization requests, and execution.
 */

import { createLogger } from '../shared/AppLogger';
import { ToolExecutor, ToolResult } from './AgentLoop';
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
        const argsStr = JSON.stringify(args, null, 2);
        
        const text = `⚠️ **AUTORIZAÇÃO NECESSÁRIA**\n\nO agente deseja executar uma ferramenta do sistema:\n\n🛠️ **Ferramenta:** \`${toolName}\`\n📦 **Parâmetros:**\n\`\`\`json\n${argsStr}\n\`\`\`\n\nEscolha uma opção abaixo ou digite **"sim"** para autorizar.`;
        
        const options: ResponseOption[] = [
            { label: '✅ Autorizar', value: 'sim' },
            { label: '❌ Cancelar', value: 'cancelar' }
        ];

        return { text, options };
    }

    /** Check if an action matches the pending one (for consumption) */
    isMatch(pending: PendingAction, toolName: string, args: Record<string, any>): boolean {
        return pending.toolName === toolName && 
               JSON.stringify(pending.arguments) === JSON.stringify(args);
    }
}
