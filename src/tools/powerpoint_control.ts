import { ToolExecutorLike } from '../core/ToolExecutor';
import { powerpointBroker, CommandArgs } from '../dashboard/routes/powerpointBroker';
import { ContextAwareTool, ToolResult } from '../loop/agentLoopTypes';

class PowerPointControlTool implements ToolExecutorLike, ContextAwareTool {
    name = 'powerpoint_control';
    description = 'Executa comandos interativos na apresentação ativa do PowerPoint. O comando é bloqueante até o PowerPoint reportar o sucesso ou falha real.';
    
    parameters = {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['addTextBox'],
                description: 'A ação a ser executada no PowerPoint.'
            },
            text: {
                type: 'string',
                description: 'O texto a ser adicionado. Obrigatório para addTextBox.'
            },
            x: {
                type: 'number',
                description: 'Posição X da caixa de texto (opcional).'
            },
            y: {
                type: 'number',
                description: 'Posição Y da caixa de texto (opcional).'
            }
        },
        required: ['action']
    };

    private currentSessionId?: string;

    setContext(chatId: string, _channel?: string): void {
        this.currentSessionId = chatId;
    }

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
        if (!this.currentSessionId || !this.currentSessionId.startsWith('powerpoint-addin-')) {
            return {
                success: false,
                output: 'Erro: Esta ferramenta só pode ser usada quando você está conectado através do suplemento do PowerPoint.'
            };
        }

        const action = args.action as string;
        if (action !== 'addTextBox') {
            return {
                success: false,
                output: `Erro: Ação '${action}' não é suportada por esta versão da ferramenta.`
            };
        }

        if (!args.text || typeof args.text !== 'string') {
            return {
                success: false,
                output: 'Erro: O argumento "text" é obrigatório e deve ser uma string.'
            };
        }

        const cmdArgs: CommandArgs = {
            text: args.text,
            x: typeof args.x === 'number' ? args.x : undefined,
            y: typeof args.y === 'number' ? args.y : undefined,
        };

        // Dispatch e aguarda o resultado real (timeout de 60s)
        const result = await powerpointBroker.dispatch(this.currentSessionId, action, cmdArgs, 60000);

        return {
            success: result.success,
            output: result.output
        };
    }
}

export const powerpointControlTool = new PowerPointControlTool();
