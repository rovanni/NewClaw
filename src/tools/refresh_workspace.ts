import { ToolExecutor, ToolResult } from '../loop/AgentLoop';
import { refreshWorkspaceIndex } from '../core/agentMediaHandlers';
import type { MemoryManager } from '../memory/MemoryManager';

export class RefreshWorkspaceTool implements ToolExecutor {
    name = 'refresh_workspace';
    description = 'Atualiza o índice do workspace (core_workspace) varrendo o diretório e registrando todos os arquivos com tamanho e data. Use quando o usuário mencionar que enviou arquivos, quando quiser listar o que está no workspace, ou quando suspeitar que o índice está desatualizado.';
    parameters = {
        type: 'object',
        properties: {},
        required: [],
    };

    constructor(private memory: MemoryManager) {}

    async execute(_args: Record<string, unknown>): Promise<ToolResult> {
        try {
            refreshWorkspaceIndex(this.memory);
            const node = this.memory.getNode('core_workspace');
            const content = node?.content || '(workspace vazio)';
            return { success: true, output: `Índice atualizado.\n\n${content}` };
        } catch (err) {
            return { success: false, output: '', error: String(err) };
        }
    }
}
