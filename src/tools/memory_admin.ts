/**
 * memory_admin — Administração e diagnóstico autônomo do grafo cognitivo
 * Permite que o NewClaw gerencie sua própria memória: listar, diagnosticar,
 * limpar órfãos, mesclar duplicatas, reindexar, recalcular métricas.
 *
 * Ações:
 * - stats: Estatísticas gerais do grafo
 * - list: Listar nós por tipo, domínio ou query
 * - orphans: Encontrar nós sem conexões
 * - duplicates: Encontrar nós duplicados (nome ou conteúdo similar)
 * - ghosts: Encontrar nós com conteúdo vazio ou apenas filename
 * - cleanup: Remover órfãos e ghosts automaticamente
 * - domains: Listar domínios e seus counts
 * - reindex: Regenerar embeddings para nós específicos ou todos
 * - recalc: Recalcular PageRank e comunidades
 * - inspect: Inspecionar um nó específico com suas conexões
 */

import { ToolExecutor, ToolResult } from '../loop/AgentLoop';
import { MemoryManager } from '../memory/MemoryManager';

export class MemoryAdminTool implements ToolExecutor {
    name = 'memory_admin';
    description = 'Administrar e diagnosticar o grafo cognitivo. Ações: stats, list, orphans, duplicates, ghosts, cleanup, domains, reindex, recalc, inspect. Use para manter a memória organizada e sem problemas.';
    parameters = {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['stats', 'list', 'orphans', 'duplicates', 'ghosts', 'cleanup', 'domains', 'reindex', 'recalc', 'inspect'],
                description: 'Ação administrativa. stats=estatísticas, list=listar nós, orphans=nós sem conexões, duplicates=nós duplicados, ghosts=nós vazios/filename, cleanup=remover órfãos+ghosts, domains=domínios, reindex=regenerar embeddings, recalc=recalcular métricas, inspect=inspecionar nó'
            },
            filter: {
                type: 'string',
                description: 'Filtro opcional: tipo (fact,context,skill...), domínio (memory_graph,skills_tools...), ou query de busca'
            },
            id: {
                type: 'string',
                description: 'ID do nó para inspect ou reindex específico'
            },
            limit: {
                type: 'number',
                description: 'Limite de resultados (padrão: 20)'
            }
        },
        required: ['action']
    };

    private memoryManager: MemoryManager;

    constructor(memoryManager: MemoryManager) {
        this.memoryManager = memoryManager;
    }

    private getDb(): any {
        return (this.memoryManager as any).db;
    }

    async execute(args: Record<string, any>): Promise<ToolResult> {
        const action = args.action as string;
        const filter = (args.filter as string) || '';
        const id = (args.id as string) || '';
        const limit = (args.limit as number) || 20;

        try {
            switch (action) {
                case 'stats': return this.stats();
                case 'list': return this.list(filter, limit);
                case 'orphans': return this.orphans();
                case 'duplicates': return this.duplicates();
                case 'ghosts': return this.ghosts();
                case 'cleanup': return this.cleanup();
                case 'domains': return this.domains();
                case 'reindex': return await this.reindex(id);
                case 'recalc': return this.recalc();
                case 'inspect': return this.inspect(id);
                default: return { success: false, output: '', error: `Ação "${action}" inválida. Use: stats, list, orphans, duplicates, ghosts, cleanup, domains, reindex, recalc, inspect.` };
            }
        } catch (error: any) {
            return { success: false, output: '', error: `Erro: ${error.message}` };
        }
    }

    // ── STATS ──────────────────────────────────────────────

    private stats(): ToolResult {
        const db = this.getDb();
        const nodeCount = (db.prepare('SELECT COUNT(*) as c FROM memory_nodes').get() as any).c;
        const edgeCount = (db.prepare('SELECT COUNT(*) as c FROM memory_edges').get() as any).c;
        const embeddingCount = (db.prepare('SELECT COUNT(*) as c FROM memory_embeddings').get() as any).c;
        const orphanCount = (db.prepare(`
            SELECT COUNT(*) as c FROM memory_nodes n
            WHERE n.id NOT IN (SELECT from_node FROM memory_edges)
              AND n.id NOT IN (SELECT to_node FROM memory_edges)
        `).get() as any).c;
        const ghostCount = (db.prepare(`
            SELECT COUNT(*) as c FROM memory_nodes
            WHERE (length(content) < 30 AND id NOT LIKE 'memory_%' AND type != 'context') OR content LIKE '%.md' AND length(content) < 50
        `).get() as any).c;

        const types = db.prepare('SELECT type, COUNT(*) as c FROM memory_nodes GROUP BY type ORDER BY c DESC').all() as any[];
        const domainStats = db.prepare('SELECT domain, COUNT(*) as c FROM memory_nodes GROUP BY domain ORDER BY c DESC').all() as any[];

        let output = `📊 Estatísticas do Grafo Cognitivo:\n`;
        output += `   Nós: ${nodeCount} | Arestas: ${edgeCount} | Embeddings: ${embeddingCount}\n`;
        output += `   Órfãos: ${orphanCount} | Ghosts: ${ghostCount}\n\n`;
        output += `   Por Tipo:\n`;
        for (const t of types) output += `     ${t.type}: ${t.c}\n`;
        output += `\n   Por Domínio:\n`;
        for (const d of domainStats) output += `     ${d.domain || '(none)'}: ${d.c}\n`;

        return { success: true, output };
    }

    // ── LIST ──────────────────────────────────────────────

    private list(filter: string, limit: number): ToolResult {
        const db = this.getDb();
        let rows: any[];

        if (!filter) {
            rows = db.prepare('SELECT id, type, domain, name, length(content) as len FROM memory_nodes ORDER BY domain, id LIMIT ?').all(limit) as any[];
        } else {
            // Try as type first
            const byType = db.prepare('SELECT id, type, domain, name, length(content) as len FROM memory_nodes WHERE type = ? ORDER BY domain, id LIMIT ?').all(filter, limit) as any[];
            if (byType.length > 0) {
                rows = byType;
            } else {
                // Try as domain
                const byDomain = db.prepare('SELECT id, type, domain, name, length(content) as len FROM memory_nodes WHERE domain = ? ORDER BY id LIMIT ?').all(filter, limit) as any[];
                if (byDomain.length > 0) {
                    rows = byDomain;
                } else {
                    // Search by name or content
                    rows = db.prepare("SELECT id, type, domain, name, length(content) as len FROM memory_nodes WHERE name LIKE ? OR content LIKE ? ORDER BY id LIMIT ?")
                        .all(`%${filter}%`, `%${filter}%`, limit) as any[];
                }
            }
        }

        if (rows.length === 0) return { success: true, output: 'Nenhum nó encontrado.' };

        let output = `📋 ${rows.length} nós encontrados:\n`;
        for (const r of rows) {
            const status = r.len < 30 ? '⚠️ GHOST' : '✅';
            output += `  ${status} ${r.id} | ${r.type}/${r.domain || '?'} | ${r.name} (${r.len} chars)\n`;
        }
        return { success: true, output };
    }

    // ── ORPHANS ──────────────────────────────────────────

    private orphans(): ToolResult {
        const db = this.getDb();
        const orphans = db.prepare(`
            SELECT id, type, domain, name, length(content) as len FROM memory_nodes n
            WHERE n.id NOT IN (SELECT from_node FROM memory_edges)
              AND n.id NOT IN (SELECT to_node FROM memory_edges)
        `).all() as any[];

        if (orphans.length === 0) return { success: true, output: '✅ Nenhum nó órfão encontrado.' };

        let output = `🔗 ${orphans.length} nós órfãos (sem conexões):\n`;
        for (const o of orphans) {
            output += `  ${o.id} | ${o.type}/${o.domain || '?'} | ${o.name} (${o.len} chars)\n`;
        }
        output += `\nUse memory_write connect para conectar, ou memory_admin cleanup para remover ghosts.`;
        return { success: true, output };
    }

    // ── DUPLICATES ──────────────────────────────────────

    private duplicates(): ToolResult {
        const db = this.getDb();
        // Find nodes with similar names (case-insensitive)
        const dupes = db.prepare(`
            SELECT a.id as id1, b.id as id2, a.name as name1, b.name as name2,
                   a.type as type1, b.type as type2, a.domain as domain1
            FROM memory_nodes a
            JOIN memory_nodes b ON a.id < b.id
                AND (LOWER(a.name) = LOWER(b.name) OR LOWER(a.name) LIKE '%' || LOWER(b.name) || '%')
            ORDER BY a.domain, a.name
            LIMIT 30
        `).all() as any[];

        if (dupes.length === 0) return { success: true, output: '✅ Nenhuma duplicata óbvia encontrada.' };

        let output = `📋 ${dupes.length} possíveis duplicatas:\n`;
        for (const d of dupes) {
            output += `  "${d.name1}" (${d.id1}) ↔ "${d.name2}" (${d.id2}) [${d.domain1}]\n`;
        }
        output += `\nUse memory_write merge para mesclar duplicatas.`;
        return { success: true, output };
    }

    // ── GHOSTS ──────────────────────────────────────────

    private ghosts(): ToolResult {
        const db = this.getDb();
        const ghosts = db.prepare(`
            SELECT id, type, domain, name, content FROM memory_nodes
            WHERE (length(content) < 30 AND id NOT LIKE 'memory_%' AND type != 'context')
               OR (content LIKE '%.md' AND length(content) < 50 AND id NOT LIKE 'memory_%')
            ORDER BY domain, id
        `).all() as any[];

        if (ghosts.length === 0) return { success: true, output: '✅ Nenhum ghost encontrado.' };

        let output = `👻 ${ghosts.length} nós ghost (conteúdo vazio ou filename):\n`;
        for (const g of ghosts) {
            output += `  ${g.id} | ${g.type}/${g.domain || '?'} | content: "${g.content.slice(0, 50)}"\n`;
        }
        output += `\nUse memory_admin cleanup para remover, ou memory_write update para preencher.`;
        return { success: true, output };
    }

    // ── CLEANUP ─────────────────────────────────────────

    private cleanup(): ToolResult {
        const db = this.getDb();

        // Find and remove ghosts
        const ghosts = db.prepare(`
            SELECT id FROM memory_nodes
            WHERE length(content) < 10
               OR (content LIKE '%.md' AND length(content) < 50 AND id NOT LIKE 'memory_%')
        `).all() as any[];

        // Find and remove orphans that are also ghosts
        const orphanGhosts = db.prepare(`
            SELECT n.id FROM memory_nodes n
            WHERE n.id NOT IN (SELECT from_node FROM memory_edges)
              AND n.id NOT IN (SELECT to_node FROM memory_edges)
              AND (length(n.content) < 30 OR (n.content LIKE '%.md' AND length(n.content) < 50))
        `).all() as any[];

        const toRemove = [...new Set([...ghosts.map(g => g.id), ...orphanGhosts.map(o => o.id)])];

        // Safety: never remove identity or preference nodes
        const safeToRemove = toRemove.filter(id => {
            const node = db.prepare('SELECT type, id FROM memory_nodes WHERE id = ?').get(id) as any;
            return node && node.type !== 'identity' && !id.startsWith('core:') && !id.startsWith('pref_');
        });

        if (safeToRemove.length === 0) return { success: true, output: '✅ Nenhum ghost seguro para remover (identity, core, pref são protegidos).' };

        const deletedEdges = db.prepare(`
            DELETE FROM memory_edges WHERE from_node IN (${safeToRemove.map(() => '?').join(',')})
                OR to_node IN (${safeToRemove.map(() => '?').join(',')})
        `).run(...safeToRemove, ...safeToRemove).changes;

        const deletedEmbeddings = db.prepare(`
            DELETE FROM memory_embeddings WHERE node_id IN (${safeToRemove.map(() => '?').join(',')})
        `).run(...safeToRemove).changes;

        const deletedMetrics = db.prepare(`
            DELETE FROM node_metrics WHERE node_id IN (${safeToRemove.map(() => '?').join(',')})
        `).run(...safeToRemove).changes;

        const deletedNodes = db.prepare(`
            DELETE FROM memory_nodes WHERE id IN (${safeToRemove.map(() => '?').join(',')})
        `).run(...safeToRemove).changes;

        return {
            success: true,
            output: `🧹 Cleanup concluído:\n   ${deletedNodes} nós removidos\n   ${deletedEdges} arestas removidas\n   ${deletedEmbeddings} embeddings removidos\n   ${deletedMetrics} métricas removidas\n   Protegidos: identity, core:*, pref_*`
        };
    }

    // ── DOMAINS ──────────────────────────────────────────

    private domains(): ToolResult {
        const db = this.getDb();
        const domains = db.prepare('SELECT domain, COUNT(*) as c FROM memory_nodes GROUP BY domain ORDER BY c DESC').all() as any[];
        const types = db.prepare('SELECT type, COUNT(*) as c FROM memory_nodes GROUP BY type ORDER BY c DESC').all() as any[];

        let output = `📊 Domínios:\n`;
        for (const d of domains) output += `  ${d.domain || '(none)'}: ${d.c} nós\n`;
        output += `\n📊 Tipos:\n`;
        for (const t of types) output += `  ${t.type}: ${t.c} nós\n`;

        return { success: true, output };
    }

    // ── REINDEX ──────────────────────────────────────────

    private async reindex(id?: string): Promise<ToolResult> {
        const db = this.getDb();
        let nodes: any[];

        if (id) {
            nodes = db.prepare('SELECT id, name, content FROM memory_nodes WHERE id = ?').all(id) as any[];
        } else {
            nodes = db.prepare('SELECT id, name, content FROM memory_nodes').all() as any[];
        }

        let updated = 0;
        let failed = 0;

        for (const node of nodes) {
            const text = `${node.name}: ${(node.content || '').slice(0, 300)}`;
            try {
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
                        db.prepare('INSERT OR REPLACE INTO memory_embeddings (node_id, embedding, model, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)')
                            .run(node.id, buf, 'nomic-embed-text');
                        updated++;
                    }
                } else { failed++; }
            } catch { failed++; }
        }

        return {
            success: true,
            output: `🔄 Reindexação concluída: ${updated} embeddings atualizados, ${failed} falhas de ${nodes.length} nós.`
        };
    }

    // ── RECALC ──────────────────────────────────────────

    private recalc(): ToolResult {
        const db = this.getDb();
        const nodeCount = (db.prepare('SELECT COUNT(*) as c FROM memory_nodes').get() as any).c;

        // Simple degree calculation
        const degrees = db.prepare(`
            SELECT n.id, COUNT(DISTINCT e.from_node) + COUNT(DISTINCT e2.to_node) as degree
            FROM memory_nodes n
            LEFT JOIN memory_edges e ON n.id = e.from_node
            LEFT JOIN memory_edges e2 ON n.id = e2.to_node
            GROUP BY n.id
        `).all() as any[];

        const updateStmt = db.prepare('UPDATE memory_nodes SET degree = ?, pagerank = ? WHERE id = ?');
        const transaction = db.transaction((rows: any[]) => {
            for (const row of rows) {
                const pr = Math.min(row.degree / nodeCount, 1.0);
                updateStmt.run(row.degree, pr, row.id);
            }
        });
        transaction(degrees);

        return {
            success: true,
            output: `📊 Métricas recalculadas para ${degrees.length} nós (degree + pagerank simplificado).`
        };
    }

    // ── INSPECT ──────────────────────────────────────────

    private inspect(id: string): ToolResult {
        if (!id) return { success: false, output: '', error: 'inspect exige: id do nó.' };

        const db = this.getDb();
        const node = db.prepare('SELECT * FROM memory_nodes WHERE id = ?').get(id) as any;
        if (!node) return { success: false, output: '', error: `Nó "${id}" não encontrado.` };

        const outEdges = db.prepare('SELECT to_node, relation, weight FROM memory_edges WHERE from_node = ?').all(id) as any[];
        const inEdges = db.prepare('SELECT from_node, relation, weight FROM memory_edges WHERE to_node = ?').all(id) as any[];
        const embedding = db.prepare('SELECT model, updated_at FROM memory_embeddings WHERE node_id = ?').get(id) as any;

        let output = `🔍 Nó: ${node.id}\n`;
        output += `   Nome: ${node.name}\n`;
        output += `   Tipo: ${node.type} | Domínio: ${node.domain || '(none)'}\n`;
        output += `   PageRank: ${(node.pagerank || 0).toFixed(4)} | Degree: ${node.degree || 0}\n`;
        output += `   Conteúdo (${(node.content || '').length} chars):\n   ${(node.content || '').slice(0, 300)}${(node.content || '').length > 300 ? '...' : ''}\n`;
        output += `\n   → Conexões saindo (${outEdges.length}):\n`;
        for (const e of outEdges) output += `     → [${e.relation}] ${e.to_node} (w=${e.weight})\n`;
        output += `   ← Conexões entrando (${inEdges.length}):\n`;
        for (const e of inEdges) output += `     ← [${e.relation}] ${e.from_node} (w=${e.weight})\n`;
        if (embedding) output += `\n   Embedding: ${embedding.model} (${embedding.updated_at})\n`;

        return { success: true, output };
    }
}