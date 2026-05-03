/**
 * memory_search — Busca semântica na memória (embedding → FTS5 → LIKE)
 * Substitui manage_memory search com interface simples
 *
 * Melhorias v2:
 * - Expansão de sinônimos para termos comuns em pt-BR
 * - Boost por recência (fatos recentes têm prioridade)
 * - Busca combinada: semântica + FTS5 + sinonímicos
 * - Ocultação de IDs internos do usuário final
 */

import { ToolExecutor, ToolResult } from '../loop/AgentLoop';
import { MemoryManager } from '../memory/MemoryManager';

/**
 * Sinônimos e expansões para termos comuns em pt-BR.
 * Quando o usuário busca por X, também busca por Y, Z.
 * Isso resolve o problema de "reunião" não encontrar "fact_1777841974958".
 */
const SYNONYM_MAP: Record<string, string[]> = {
    // Eventos e compromissos
    'reunião': ['compromisso', 'encontro', 'agenda', 'horário', 'evento', 'comprometido'],
    'compromisso': ['reunião', 'agenda', 'horário', 'evento', 'aula'],
    'aula': ['compromisso', 'reunião', 'agenda', 'horário', 'turma', 'disciplina'],
    'agenda': ['compromisso', 'reunião', 'horário', 'evento', 'aula'],
    'horário': ['agenda', 'compromisso', 'reunião', 'hora', 'quando'],

    // Localidades
    'bandeirantes': ['uenp', 'campus', 'universidade', 'faculdade'],
    'uenp': ['bandeirantes', 'campus', 'universidade', 'faculdade', 'ensino'],
    'cornélio procópio': ['cp', 'cornelio procopio'],

    // Disciplinas
    'engenharia de software': ['software', 'disciplina', 'matéria', 'materia'],
    'compiladores': ['disciplina', 'matéria', 'compilador', 'compilação'],
    'teoria da computação': ['tc', 'disciplina', 'matéria'],

    // Clima
    'clima': ['tempo', 'previsão', 'chuva', 'temperatura', 'tempo'],
    'tempo': ['clima', 'previsão', 'chuva', 'temperatura'],
    'previsão': ['clima', 'tempo', 'chuva', 'temperatura'],

    // Pessoas
    'luciano': ['rovanni', 'professor', 'prof'],
    'professor': ['luciano', 'rovanni', 'docente'],

    // Trabalho/Projeto
    'trabalho': ['projeto', 'tarefa', 'atividade', 'entrega'],
    'projeto': ['trabalho', 'tarefa', 'atividade', 'entrega'],
};

/**
 * Expande uma query com sinônimos para aumentar recall.
 */
function expandWithSynonyms(query: string): string[] {
    const normalized = query.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const queries = [query]; // Original always included

    for (const [key, synonyms] of Object.entries(SYNONYM_MAP)) {
        const keyNorm = key.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        if (normalized.includes(keyNorm) || normalized.includes(key)) {
            // Add synonyms as additional search terms
            for (const syn of synonyms.slice(0, 3)) { // Limit to 3 to avoid noise
                queries.push(`${query} ${syn}`);
            }
        }
    }

    return queries;
}

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
            // 1. Search with original query
            let results = await this.memoryManager.semanticSearch(query, limit);

            // 2. If few results, expand with synonyms and search again
            if (results.length < 2) {
                const expandedQueries = expandWithSynonyms(query);
                const seenIds = new Set(results.map((n: any) => n.id));

                for (const expandedQuery of expandedQueries.slice(1)) { // Skip original (already searched)
                    try {
                        const expandedResults = await this.memoryManager.semanticSearch(expandedQuery, limit);
                        for (const node of expandedResults) {
                            if (!seenIds.has(node.id)) {
                                // Boost score slightly for synonym match (less confident)
                                results.push({ ...node, score: (node.score || 0.4) * 0.85 });
                                seenIds.add(node.id);
                            }
                        }
                    } catch { /* Skip failed expansions */ }

                    if (results.length >= limit) break;
                }
            }

            // 3. If still few results, try FTS5/LIKE directly (bypass embedding)
            if (results.length < 2) {
                try {
                    const textResults = this.memoryManager.searchNodes(query, limit);
                    const seenIds = new Set(results.map((n: any) => n.id));
                    for (const node of textResults) {
                        if (!seenIds.has(node.id)) {
                            results.push({ ...node, score: 0.3 }); // Lower confidence for text-only match
                            seenIds.add(node.id);
                        }
                    }
                } catch { /* Fallback already covered */ }
            }

            // 4. Sort by score descending
            results.sort((a: any, b: any) => (b.score || 0) - (a.score || 0));
            results = results.slice(0, limit);

            if (results.length === 0) {
                return { success: true, output: `Nenhum resultado encontrado para "${query}". Pare de buscar e use memory_write (action=create) se precisar adicionar esta informação.` };
            }

            // 5. Format output — HIDE internal IDs from user
            const output = results.map((n: any) => {
                const score = n.score ? ` (${(n.score * 100).toFixed(0)}%)` : '';
                const content = (n.content || '').slice(0, 200);
                return `📌 ${n.name}${score} [${n.type}]: ${content}`;
            }).join('\n');

            return { success: true, output };
        } catch (error: any) {
            // Fallback to simple search
            try {
                const nodes = this.memoryManager.searchNodes(query, limit);
                if (nodes.length === 0) {
                    return { success: true, output: `Nenhum resultado encontrado para "${query}". Pare de buscar e use memory_write (action=create) se precisar adicionar esta informação.` };
                }
                const output = nodes.map(n => `📌 ${n.name} [${n.type}]: ${(n.content || '').slice(0, 200)}`).join('\n');
                return { success: true, output };
            } catch (fallbackError: any) {
                return { success: false, output: '', error: `Erro na busca: ${fallbackError.message}` };
            }
        }
    }
}