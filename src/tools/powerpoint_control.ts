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
                enum: ['addTextBox', 'getPresentation', 'getSlide'],
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
            },
            index: {
                type: 'number',
                description: 'O índice do slide (1-indexed) para consulta ou alteração. Usado em getSlide.'
            },
            id: {
                type: 'string',
                description: 'O ID permanente do slide. Usado em getSlide (tem precedência sobre o índice).'
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
        const validActions = ['addTextBox', 'getPresentation', 'getSlide'];
        if (!validActions.includes(action)) {
            return {
                success: false,
                output: `Erro: Ação '${action}' não é suportada por esta versão da ferramenta.`
            };
        }

        if (action === 'addTextBox' && (!args.text || typeof args.text !== 'string')) {
            return {
                success: false,
                output: 'Erro: O argumento "text" é obrigatório e deve ser uma string para addTextBox.'
            };
        }

        const cmdArgs: CommandArgs = {};
        if (action === 'addTextBox') {
            cmdArgs.text = args.text as string;
            cmdArgs.x = typeof args.x === 'number' ? args.x : undefined;
            cmdArgs.y = typeof args.y === 'number' ? args.y : undefined;
        } else if (action === 'getSlide') {
            cmdArgs.index = typeof args.index === 'number' ? args.index : undefined;
            cmdArgs.id = typeof args.id === 'string' ? args.id : undefined;
        }

        // Dispatch e aguarda o resultado real (timeout de 60s)
        const result = await powerpointBroker.dispatch(this.currentSessionId, action as any, cmdArgs, 60000);

        if (result.success) {
            let finalOutput = result.output;
            if (result.data) {
                finalOutput += `\nDados estruturados:\n${JSON.stringify(result.data, null, 2)}`;
            }
            return {
                success: true,
                output: finalOutput
            };
        } else {
            return {
                success: false,
                output: result.output
            };
        }
    }
}

export const powerpointControlTool = new PowerPointControlTool();
