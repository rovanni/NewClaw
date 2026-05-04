/**
 * ResponseBuilder — Format tool results without calling LLM again.
 * 
 * Rules:
 * - file_ops read: truncate and format directly
 * - file_ops create/move/delete: success message directly
 * - memory_search: format top results directly
 * - memory_write: success message directly
 * - memory_admin: format stats directly
 * - exec_command: truncate and format directly
 * - send_document/send_audio: already returned directly (before this)
 * - web_search: LLM formatting (already handled separately)
 * - Only use LLM for tools that need interpretation (none currently)
 */

import { ToolResult } from './AgentLoop';

export class ResponseBuilder {

    /**
     * Build a direct response from tool result — NO LLM call needed.
     * Returns null if LLM formatting is needed (shouldn't happen after this refactor).
     */
    buildResponse(toolName: string, toolParams: Record<string, any>, toolResult: ToolResult): string | null {
        if (!toolResult.success) {
            return this.formatError(toolName, toolResult.error || 'Erro desconhecido');
        }

        switch (toolName) {
            case 'write':
            case 'edit':
            case 'read':
                return this.formatFileOps(toolParams, toolResult);
            case 'memory_search':
                return this.formatMemorySearch(toolResult);
            case 'memory_write':
                return this.formatMemoryWrite(toolParams, toolResult);
            case 'memory_admin':
                return this.formatMemoryAdmin(toolParams, toolResult);
            case 'exec_command':
                return this.formatExecCommand(toolResult);
            default:
                // Unknown tools still need LLM
                return null;
        }
    }

    private formatFileOps(params: Record<string, any>, result: ToolResult): string {
        const output = result.output || '';

        // Write results
        if (output.startsWith('Criado:') || output.startsWith('Sobrescrito:')) {
            return `✅ Arquivo criado: ${params.path || 'arquivo'}\n${output}`;
        }
        // Edit results
        if (output.startsWith('Substituição OK:') || output.startsWith('Patch OK:') || output.startsWith('Conteúdo adicionado:') || output.startsWith('Arquivo criado:')) {
            return `✅ ${output}`;
        }
        // List/directory results
        if (output.startsWith('📁') || (output.includes('/') && output.includes('📄'))) {
            return `📁 ${output}`;
        }

        // Read — truncate long content
        const maxLen = 1500;
        if (output.length > maxLen) {
            return `📄 Conteúdo do arquivo (truncado):\n\`\`\`\n${output.slice(0, maxLen)}\n\`\`\`\n\n*[Arquivo com ${output.length} caracteres. Use send_document para enviar o arquivo completo.]*`;
        }
        return `📄 Conteúdo do arquivo:\n\`\`\`\n${output}\n\`\`\``;
    }

    private formatMemorySearch(result: ToolResult): string {
        const output = result.output || '';
        if (output.length > 1000) {
            return `🔍 Resultados da busca:\n${output.slice(0, 1000)}\n\n*[Mais resultados disponíveis]*`;
        }
        return `🔍 Resultados da busca:\n${output}`;
    }

    private formatMemoryWrite(params: Record<string, any>, result: ToolResult): string {
        const action = params.action || '';
        const output = result.output || '';

        switch (action) {
            case 'create':
                return `✅ Nó criado: ${params.id || 'novo nó'}`;
            case 'update':
                return `✅ Nó atualizado: ${params.id || 'nó'}`;
            case 'connect':
                return `✅ Conexão criada: ${params.from || ''} → [${params.relation || 'related_to'}] → ${params.to || ''}`;
            case 'delete':
                return `✅ ${output}`;
            case 'merge':
                return `✅ ${output}`;
            default:
                return output.slice(0, 500) || 'Ação executada.';
        }
    }

    private formatMemoryAdmin(params: Record<string, any>, result: ToolResult): string {
        const action = params.action || '';
        const output = result.output || '';

        // Stats, list, orphans, etc. — format directly
        if (output.length > 1500) {
            return `${output.slice(0, 1500)}\n\n*[Resultado truncado]*`;
        }
        return output;
    }

    private formatExecCommand(result: ToolResult): string {
        const output = result.output || '';
        if (output.length > 1500) {
            return `💻 Resultado:\n\`\`\`\n${output.slice(0, 1500)}\n\`\`\`\n\n*[Resultado truncado]*`;
        }
        return `💻 Resultado:\n\`\`\`\n${output}\n\`\`\``;
    }

    private formatError(toolName: string, error: string): string {
        // Format errors directly — no LLM needed
        if (error.includes('não encontrado')) {
            return `❌ Não encontrado: ${error}`;
        }
        if (error.includes('obrigatório') || error.includes('exige')) {
            return `❌ Parâmetro obrigatório: ${error}`;
        }
        return `❌ Erro em ${toolName}: ${error.slice(0, 200)}`;
    }
}