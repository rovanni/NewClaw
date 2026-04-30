import { ToolExecutor, ToolResult } from '../loop/AgentLoop';
import { MemoryManager } from '../memory/MemoryManager';

export class ManageMemoryTool implements ToolExecutor {
    name = 'manage_memory';
    description = 'Ferramenta oficial para o NewClaw interagir com o grafo de memória. REGRAS: (1) SEMPRE conecte novos nós ao grafo — use connect_nodes após upsert_node se necessário. (2) NÓS ÓRFÃOS = GRAFO QUEBRADO. (3) Conecte fatos/skills a user_identity. (4) Busque antes de criar para evitar duplicatas. Ações: search, upsert_node, connect_nodes, delete_node.';
    parameters = {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['search', 'upsert_node', 'connect_nodes', 'delete_node'], description: 'Ação que deseja realizar' },
            query: { type: 'string', description: 'Para buscar. Termo de busca semântica' },
            node_id: { type: 'string', description: 'ID curto e único do nó (usado para criação, atualização e deleção). Ex: "user_name", "proj_newclaw"' },
            node_type: { type: 'string', enum: ['identity', 'preference', 'project', 'context', 'fact', 'skill', 'infrastructure'], description: 'Tipo do nó, se for criar/atualizar' },
            node_name: { type: 'string', description: 'Nome humano do nó' },
            node_content: { type: 'string', description: 'Conteúdo descritivo da memória' },
            from_node: { type: 'string', description: 'ID do nó de origem para conectar' },
            to_node: { type: 'string', description: 'ID do nó de destino para conectar' },
            relation: { type: 'string', description: 'A relação semântica (ex: belongs_to, related_to, uses, prefers...)' }
        },
        required: ['action']
    };

    private memoryManager: MemoryManager;

    constructor(memoryManager: MemoryManager) {
        this.memoryManager = memoryManager;
    }

    /**
     * Smart relation inference based on node type + content analysis.
     * Uses the ontology (identity→project='created', identity→fact='has_trait', etc.)
     * and content keywords to pick the best relation.
     */
    private inferRelation(nodeType: string, nodeName: string, nodeContent: string): string {
        const text = ((nodeName || '') + ' ' + (nodeContent || '')).toLowerCase();

        switch (nodeType) {
            case 'preference':
                return 'prefers';
            case 'project':
                if (text.match(/criei|criou|desenvolvi|autor|meu projeto|minha/i)) return 'created';
                return 'works_on';
            case 'skill':
                return 'uses';
            case 'infrastructure':
                return 'uses';
            case 'context':
                return 'belongs_to';
            case 'fact':
                if (text.match(/criei|criou|desenvolvi|autor|built|made|fiz|construí/i)) return 'created';
                if (text.match(/prefiro|gosto|adoro|amo|favorit/i)) return 'prefers';
                if (text.match(/objetivo|meta|goal|plano|planejo/i)) return 'has_goal';
                if (text.match(/traço|característica|habilidade|skill|trait/i)) return 'has_trait';
                return 'has_trait';
            case 'trait':
                return 'has_trait';
            case 'rule':
            case 'strategy':
            case 'knowledge':
                return 'belongs_to';
            default:
                return 'related_to';
        }
    }

    async execute(args: Record<string, any>): Promise<ToolResult> {
        try {
            const action = args.action;

            if (action === 'search') {
                if (!args.query) return { success: false, error: 'Ação search exige parâmetro "query".', output: '' };
                const results = await this.memoryManager.semanticSearch(args.query, 10);
                if (results.length === 0) return { success: true, output: 'Nenhum nó encontrado para essa busca.' };
                const output = results.map((n: any) => 
                    `[${n.score?.toFixed(2) || '?'}] ${n.id} (${n.type}): ${n.name} — ${(n.content || '').slice(0, 100)}`
                ).join('\n');
                return { success: true, output: 'Busca semântica:\n' + output };
            }

            if (action === 'upsert_node') {
                if (!args.node_id || !args.node_type || !args.node_name || !args.node_content) {
                    return { success: false, error: 'upsert_node exige: node_id, node_type, node_name, e node_content.', output: '' };
                }

                const existing = this.memoryManager.getNode(args.node_id);
                if (existing) {
                    existing.name = args.node_name;
                    existing.type = args.node_type as any;
                    if (!existing.content.includes(args.node_content)) {
                        existing.content += '\n' + args.node_content;
                    }
                    this.memoryManager.addNode(existing);
                    return { success: true, output: `✅ Nó "${args.node_id}" atualizado com sucesso.` };
                } else {
                    this.memoryManager.addNode({
                        id: args.node_id,
                        type: args.node_type as any,
                        name: args.node_name,
                        content: args.node_content
                    });

                    // Auto-connect to user_identity with smart relation
                    let connectedRelation = 'related_to';
                    if (args.node_id !== 'user_identity' && args.node_id !== 'core_user') {
                        const userIdentity = this.memoryManager.getNode('user_identity');
                        if (userIdentity) {
                            connectedRelation = this.inferRelation(args.node_type, args.node_name, args.node_content);
                            try {
                                this.memoryManager.addEdge('user_identity', args.node_id, connectedRelation);
                            } catch (e) { /* ignore if already connected */ }
                        }
                    }

                    return { success: true, output: `✅ Nó "${args.node_id}" criado e conectado ao user_identity via "${connectedRelation}". Use connect_nodes para conexões adicionais.` };
                }
            }

            if (action === 'connect_nodes') {
                if (!args.from_node || !args.to_node || !args.relation) {
                    return { success: false, error: 'connect_nodes exige: from_node, to_node e relation.', output: '' };
                }
                const fromNode = this.memoryManager.getNode(args.from_node);
                const toNode = this.memoryManager.getNode(args.to_node);
                if (!fromNode || !toNode) {
                    return { success: false, error: `Nó(s) não encontrado(s). Origem existe? ${!!fromNode}. Destino existe? ${!!toNode}`, output: '' };
                }
                this.memoryManager.addEdge(args.from_node, args.to_node, args.relation);
                return { success: true, output: `✅ Sucesso! Os nós foram conectados via "${args.relation}".` };
            }
            
            if (action === 'delete_node') {
                if (!args.node_id) return { success: false, error: 'delete_node exige node_id', output: '' };
                const db = (this.memoryManager as any).db;
                db.prepare('DELETE FROM memory_edges WHERE from_node = ? OR to_node = ?').run(args.node_id, args.node_id);
                db.prepare('DELETE FROM memory_nodes WHERE id = ?').run(args.node_id);
                return { success: true, output: `✅ Nó "${args.node_id}" e todas as suas arestas foram deletados permanentemente.` };
            }

            return { success: false, error: `Ação "${action}" desconhecida.`, output: '' };

        } catch (error: any) {
            return {
                success: false,
                output: '',
                error: `System Error: ${error.message}`
            };
        }
    }
}