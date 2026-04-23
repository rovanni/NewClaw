/**
 * memory_write — Criar, atualizar, conectar, deletar ou mesclar nós de memória
 * v2: Adicionado action=merge com análise inteligente
 *
 * Ações:
 * - create: Criar novo nó
 * - update: Atualizar nó existente
 * - connect: Conectar dois nós
 * - delete: Remover nó e suas conexões
 * - merge: Mesclar nós duplicados (análise inteligente)
 */

import { ToolExecutor, ToolResult } from '../loop/AgentLoop';
import { MemoryManager } from '../memory/MemoryManager';

export class MemoryWriteTool implements ToolExecutor {
    name = 'memory_write';
    description = 'Criar, atualizar, conectar, deletar ou mesclar nós na memória. Busque antes para evitar duplicatas, mas se não encontrar, USE action=create para criar um novo nó imediatamente. Não fique preso em loops de busca e não é estritamente obrigatório conectar a um nó existente.';
    parameters = {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['create', 'update', 'connect', 'delete', 'merge'],
                description: 'Ação: create (novo nó), update (atualizar existente), connect (ligar dois nós), delete (remover nó), merge (mesclar duplicatas)'
            },
            id: { type: 'string', description: 'ID do nó. Obrigatório para update/connect/delete. Para merge: ID do nó que vai absorver.' },
            type: { type: 'string', enum: ['identity', 'preference', 'project', 'context', 'fact', 'skill', 'infrastructure', 'trait', 'rule', 'strategy', 'knowledge'], description: 'Tipo do nó (apenas para create)' },
            name: { type: 'string', description: 'Nome do nó (create/update)' },
            content: { type: 'string', description: 'Conteúdo do nó (create/update)' },
            from: { type: 'string', description: 'ID do nó de origem (connect)' },
            to: { type: 'string', description: 'ID do nó de destino (connect)' },
            relation: { type: 'string', description: 'Tipo da relação (connect)' },
            merge_ids: { type: 'array', items: { type: 'string' }, description: 'Lista de IDs a mesclar no nó principal (merge). Esses nós serão removidos.' },
            domain: { type: 'string', enum: ['core_identity', 'user_modeling', 'memory_graph', 'active_context', 'skills_tools', 'governance_safety', 'cognitive_architecture'], description: 'Domínio cognitivo do nó (create/update)' }
        },
        required: ['action']
    };

    private memoryManager: MemoryManager;

    constructor(memoryManager: MemoryManager) {
        this.memoryManager = memoryManager;
    }

    async execute(args: Record<string, any>): Promise<ToolResult> {
        const action = (args.action as string) || (args.content ? 'create' : '');

        if (!args.id && args.content) {
            args.id = `fact_${Date.now()}`;
            args.name = (args.content as string).slice(0, 50);
            args.type = args.type || 'fact';
        }

        try {
            switch (action) {
                case 'create': return await this.create(args);
                case 'update': return await this.update(args);
                case 'connect': return await this.connect(args);
                case 'delete': return await this.delete(args);
                case 'merge': return await this.merge(args);
                default: return { success: false, output: '', error: `Ação "${action}" inválida. Use: create, update, connect, delete, merge.` };
            }
        } catch (error: any) {
            return { success: false, output: '', error: `Erro: ${error.message}` };
        }
    }

    private getDb(): any {
        return (this.memoryManager as any).db;
    }

    // ── CREATE ────────────────────────────────────────────────

    private async create(args: Record<string, any>): Promise<ToolResult> {
        const { id, type, name, content, domain } = args;
        if (!id || !type || !name || !content) {
            return { success: false, output: '', error: 'create exige: id, type, name, content.' };
        }

        const existing = this.memoryManager.getNode(id);
        if (existing) {
            existing.name = name;
            existing.type = type as any;
            existing.content = content;
            this.memoryManager.addNode(existing);

            // Update domain if provided
            if (domain) {
                this.getDb()?.prepare('UPDATE memory_nodes SET domain = ? WHERE id = ?').run(domain, id);
            }

            return { success: true, output: `✅ Nó "${id}" atualizado (já existia).` };
        }

        this.memoryManager.addNode({ id, type: type as any, name, content });

        // Set domain if provided
        if (domain) {
            this.getDb()?.prepare('UPDATE memory_nodes SET domain = ? WHERE id = ?').run(domain, id);
        }

        return { success: true, output: `✅ Nó "${id}" criado no domínio ${domain || type}. Use action=connect para ligá-lo.` };
    }

    // ── UPDATE ────────────────────────────────────────────────

    private async update(args: Record<string, any>): Promise<ToolResult> {
        const { id, name, content, domain } = args;
        if (!id) return { success: false, output: '', error: 'update exige: id.' };

        const node = this.memoryManager.getNode(id);
        if (!node) return { success: false, output: '', error: `Nó "${id}" não encontrado.` };

        if (name) node.name = name;
        if (content) node.content = content;
        this.memoryManager.addNode(node);

        // Update domain
        if (domain) {
            this.getDb()?.prepare('UPDATE memory_nodes SET domain = ? WHERE id = ?').run(domain, id);
        }

        // Re-generate embedding
        await this.regenerateEmbedding(id, node);

        return { success: true, output: `✅ Nó "${id}" atualizado.` };
    }

    // ── CONNECT ────────────────────────────────────────────────

    private async connect(args: Record<string, any>): Promise<ToolResult> {
        const { from, to, relation } = args;
        if (!from || !to || !relation) {
            return { success: false, output: '', error: 'connect exige: from, to, relation.' };
        }

        const fromNode = this.memoryManager.getNode(from);
        const toNode = this.memoryManager.getNode(to);
        if (!fromNode) return { success: false, output: '', error: `Nó origem "${from}" não encontrado.` };
        if (!toNode) return { success: false, output: '', error: `Nó destino "${to}" não encontrado.` };

        this.memoryManager.addEdge(from, to, relation);

        // Generate embedding for from node
        await this.regenerateEmbedding(from, fromNode);

        return { success: true, output: `✅ Conectado: ${from} → [${relation}] → ${to}.` };
    }

    // ── DELETE ────────────────────────────────────────────────

    private async delete(args: Record<string, any>): Promise<ToolResult> {
        const { id } = args;
        if (!id) return { success: false, output: '', error: 'delete exige: id.' };

        const db = this.getDb();
        if (!db) return { success: false, output: '', error: 'DB não disponível.' };

        // Check if node exists
        const node = this.memoryManager.getNode(id);
        if (!node) return { success: false, output: '', error: `Nó "${id}" não encontrado.` };

        // Count edges that will be removed
        const edges = db.prepare(
            'SELECT COUNT(*) as cnt FROM memory_edges WHERE from_node = ? OR to_node = ?'
        ).get(id, id) as any;

        db.prepare('DELETE FROM memory_edges WHERE from_node = ? OR to_node = ?').run(id, id);
        db.prepare('DELETE FROM memory_nodes WHERE id = ?').run(id);
        db.prepare('DELETE FROM memory_embeddings WHERE node_id = ?').run(id);
        db.prepare('DELETE FROM node_metrics WHERE node_id = ?').run(id);

        return { success: true, output: `✅ Nó "${id}" (${node.type}/${node.name}) removido com ${edges?.cnt || 0} conexões.` };
    }

    // ── MERGE (Inteligente) ──────────────────────────────────

    /**
     * Merge duplicate nodes into one.
     *
     * Algorithm:
     * 1. Validate: target must exist, source IDs must exist
     * 2. Check: are sources actually similar? (same name or overlapping content)
     * 3. Merge content: combine content from all sources into target
     * 4. Transfer edges: rewire all edges from sources to target
     * 5. Keep best type: use the most specific type among all nodes
     * 6. Delete sources
     * 7. Update embeddings
     *
     * Safety: Never merge nodes of type 'identity' with different names.
     */
    private async merge(args: Record<string, any>): Promise<ToolResult> {
        const { id, merge_ids } = args;
        if (!id || !merge_ids || !Array.isArray(merge_ids) || merge_ids.length === 0) {
            return { success: false, output: '', error: 'merge exige: id (nó destino) e merge_ids (lista de IDs para mesclar).' };
        }

        const db = this.getDb();
        if (!db) return { success: false, output: '', error: 'DB não disponível.' };

        // 1. Validate target
        const target = this.memoryManager.getNode(id);
        if (!target) return { success: false, output: '', error: `Nó destino "${id}" não encontrado.` };

        // Safety: never merge identity nodes with different names
        if (target.type === 'identity') {
            return { success: false, output: '', error: `Segurança: não é possível mesclar nós do tipo "identity". Use update para corrigir.` };
        }

        const results: string[] = [];
        let edgesTransferred = 0;
        let contentMerged = false;

        for (const sourceId of merge_ids) {
            if (sourceId === id) continue; // Skip self

            const source = this.memoryManager.getNode(sourceId);
            if (!source) {
                results.push(`⚠️ "${sourceId}" não encontrado, ignorado.`);
                continue;
            }

            // 2. Safety check: never merge identity nodes
            if (source.type === 'identity') {
                results.push(`⚠️ "${sourceId}" é identity, ignorado por segurança.`);
                continue;
            }

            // 3. Check similarity: same name OR overlapping content keywords
            const nameMatch = source.name.toLowerCase() === target.name.toLowerCase();
            const contentOverlap = this.calculateContentOverlap(source.content || '', target.content || '');
            if (!nameMatch && contentOverlap < 0.2) {
                results.push(`⚠️ "${sourceId}" parece diferente de "${id}" (similaridade: ${(contentOverlap * 100).toFixed(0)}%). Mesclando mesmo assim...`);
            }

            // 4. Merge content: append source content if not already present
            if (source.content && !target.content.includes(source.content.slice(0, 50))) {
                target.content = target.content + '\n\n' + source.content;
                contentMerged = true;
            }

            // 5. Transfer edges from source to target
            const sourceEdges = db.prepare(
                'SELECT from_node, to_node, relation, weight FROM memory_edges WHERE from_node = ? OR to_node = ?'
            ).all(sourceId, sourceId) as any[];

            for (const edge of sourceEdges) {
                if (edge.from_node === sourceId) {
                    // Avoid self-loops and duplicates
                    const exists = db.prepare(
                        'SELECT 1 FROM memory_edges WHERE from_node = ? AND to_node = ? AND relation = ?'
                    ).get(id, edge.to_node, edge.relation);
                    if (!exists && edge.to_node !== id) {
                        db.prepare('INSERT OR IGNORE INTO memory_edges (from_node, to_node, relation, weight) VALUES (?, ?, ?, ?)')
                            .run(id, edge.to_node, edge.relation, edge.weight || 1.0);
                        edgesTransferred++;
                    }
                }
                if (edge.to_node === sourceId) {
                    const exists = db.prepare(
                        'SELECT 1 FROM memory_edges WHERE from_node = ? AND to_node = ? AND relation = ?'
                    ).get(edge.from_node, id, edge.relation);
                    if (!exists && edge.from_node !== id) {
                        db.prepare('INSERT OR IGNORE INTO memory_edges (from_node, to_node, relation, weight) VALUES (?, ?, ?, ?)')
                            .run(edge.from_node, id, edge.relation, edge.weight || 1.0);
                        edgesTransferred++;
                    }
                }
            }

            // 6. Use best type (most specific wins: identity > preference > project > fact > context)
            const typePriority: Record<string, number> = {
                identity: 7, trait: 6, rule: 5, strategy: 4, knowledge: 3,
                preference: 3, project: 2, skill: 2, fact: 1, context: 1, infrastructure: 1
            };
            if ((typePriority[source.type] || 0) > (typePriority[target.type] || 0)) {
                target.type = source.type;
                results.push(`Tipo atualizado: ${source.type} (mais específico que ${target.type})`);
            }

            // Use best domain
            const sourceDomain = db.prepare('SELECT domain FROM memory_nodes WHERE id = ?').get(sourceId) as any;
            if (sourceDomain?.domain && !db.prepare('SELECT domain FROM memory_nodes WHERE id = ?').get(id)) {
                db.prepare('UPDATE memory_nodes SET domain = ? WHERE id = ?').run(sourceDomain.domain, id);
            }

            // 7. Delete source
            db.prepare('DELETE FROM memory_edges WHERE from_node = ? OR to_node = ?').run(sourceId, sourceId);
            db.prepare('DELETE FROM memory_nodes WHERE id = ?').run(sourceId);
            db.prepare('DELETE FROM memory_embeddings WHERE node_id = ?').run(sourceId);
            db.prepare('DELETE FROM node_metrics WHERE node_id = ?').run(sourceId);

            results.push(`✅ "${sourceId}" (${source.type}/${source.name}) mesclado em "${id}"`);
        }

        // Update target with merged content
        if (contentMerged) {
            this.memoryManager.addNode(target);
        }

        // Update domain
        if (args.domain) {
            db.prepare('UPDATE memory_nodes SET domain = ? WHERE id = ?').run(args.domain, id);
        }

        // Regenerate embedding
        await this.regenerateEmbedding(id, target);

        return {
            success: true,
            output: `✅ Merge concluído: ${merge_ids.length} nós mesclados em "${id}". ${edgesTransferred} conexões transferidas.\n${results.join('\n')}`
        };
    }

    // ── Helpers ──────────────────────────────────────────────

    private async regenerateEmbedding(nodeId: string, node: any): Promise<void> {
        try {
            const text = `${node.name}: ${(node.content || '').slice(0, 200)}`;
            const resp = await fetch('http://localhost:11434/api/embeddings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'nomic-embed-text:latest', prompt: text }),
                signal: AbortSignal.timeout(15000)
            });
            if (resp.ok) {
                const data = await resp.json() as any;
                if (data.embedding) {
                    const buf = Buffer.from(new Float64Array(data.embedding).buffer);
                    this.getDb()?.prepare('INSERT OR REPLACE INTO memory_embeddings (node_id, embedding, model, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)')
                        .run(nodeId, buf, 'nomic-embed-text');
                }
            }
        } catch { /* embedding optional */ }
    }

    /**
     * Calculate content overlap between two strings (Jaccard similarity of words).
     * Returns 0-1 where 1 = identical content.
     */
    private calculateContentOverlap(a: string, b: string): number {
        if (!a || !b) return 0;
        const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 3));
        const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 3));
        if (wordsA.size === 0 || wordsB.size === 0) return 0;
        let intersection = 0;
        for (const w of wordsA) { if (wordsB.has(w)) intersection++; }
        return intersection / Math.max(wordsA.size, wordsB.size);
    }
}