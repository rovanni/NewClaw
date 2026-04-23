/**
 * memory_search — Busca semântica na memória (embedding → FTS5 → LIKE)
 * Substitui manage_memory search com interface simples
 */

import { ToolExecutor, ToolResult } from '../loop/AgentLoop';
import { MemoryManager } from '../memory/MemoryManager';

export class MemorySearchTool implements ToolExecutor {
    name = 'memory_search';
    description = 'Busca na memória interna do NewClaw. Use para encontrar informações sobre qualquer assunto já registrado. Retorna nós relevantes com score de similaridade.';
    parameters = {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Termo de busca (palavras-chave ou frase)' },
            limit: { type: 'number', description: 'Número máximo de resultados (padrão: 5)' }
        },
        required: ['query']
    };

    private memoryManager: MemoryManager;

    constructor(memoryManager: MemoryManager) {
        this.memoryManager = memoryManager;
    }

    async execute(args: Record<string, any>): Promise<ToolResult> {
        const query = args.query as string;
        const limit = (args.limit as number) || 5;

        if (!query) {
            return { success: false, output: '', error: 'Query não fornecida.' };
        }

        try {
            const results = await this.memoryManager.semanticSearch(query, limit);

            if (results.length === 0) {
                return { success: true, output: `Nenhum resultado encontrado para "${query}". Pare de buscar e use memory_write (action=create) se precisar adicionar esta informação.` };
            }

            const output = results.map((n: any) => {
                const score = n.score ? ` (${(n.score * 100).toFixed(0)}%)` : '';
                const content = (n.content || '').slice(0, 200);
                return `📌 ${n.name} (ID: ${n.id})${score} [${n.type}]: ${content}`;
            }).join('\n');

            return { success: true, output };
        } catch (error: any) {
            // Fallback to simple search
            try {
                const nodes = this.memoryManager.searchNodes(query, limit);
                if (nodes.length === 0) {
                    return { success: true, output: `Nenhum resultado encontrado para "${query}". Pare de buscar e use memory_write (action=create) se precisar adicionar esta informação.` };
                }
                const output = nodes.map(n => `📌 ${n.name} (ID: ${n.id}) [${n.type}]: ${(n.content || '').slice(0, 200)}`).join('\n');
                return { success: true, output };
            } catch (fallbackError: any) {
                return { success: false, output: '', error: `Erro na busca: ${fallbackError.message}` };
            }
        }
    }
}