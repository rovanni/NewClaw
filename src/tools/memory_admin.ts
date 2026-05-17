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
import type { MemoryGraphRepository } from '../memory/MemoryGraphRepository';
import { errorMessage } from '../shared/errors';

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

    private repo: MemoryGraphRepository;

    constructor(memoryManager: MemoryManager) {
        this.repo = memoryManager.getGraphRepository();
    }

    async execute(args: Record<string, any>): Promise<ToolResult> {
        const action = args.action as string;
        const filter = (args.filter as string) || '';
        const id = (args.id as string) || '';
        const limit = (args.limit as number) || 20;

        try {
            switch (action) {
                case 'stats':      return this.stats();
                case 'list':       return this.list(filter, limit);
                case 'orphans':    return this.orphans();
                case 'duplicates': return this.duplicates();
                case 'ghosts':     return this.ghosts();
                case 'cleanup':    return this.cleanup();
                case 'domains':    return this.domains();
                case 'reindex':    return await this.reindex(id);
                case 'recalc':     return this.recalc();
                case 'inspect':    return this.inspect(id);
                default:
                    return { success: false, output: '', error: `Ação "${action}" inválida. Use: stats, list, orphans, duplicates, ghosts, cleanup, domains, reindex, recalc, inspect.` };
            }
        } catch (error) {
            return { success: false, output: '', error: `Erro: ${errorMessage(error)}` };
        }
    }

    // ── STATS ─────────────────────────────────────────────────────────────────

    private stats(): ToolResult {
        const s = this.repo.getGraphStats();

        let output = `📊 Estatísticas do Grafo Cognitivo:\n`;
        output += `   Nós: ${s.nodeCount} | Arestas: ${s.edgeCount} | Embeddings: ${s.embeddingCount}\n`;
        output += `   Órfãos: ${s.orphanCount} | Ghosts: ${s.ghostCount}\n\n`;
        output += `   Por Tipo:\n`;
        for (const t of s.typeBreakdown) output += `     ${t.type}: ${t.c}\n`;
        output += `\n   Por Domínio:\n`;
        for (const d of s.domainBreakdown) output += `     ${d.domain || '(none)'}: ${d.c}\n`;

        return { success: true, output };
    }

    // ── LIST ──────────────────────────────────────────────────────────────────

    private list(filter: string, limit: number): ToolResult {
        const rows = this.repo.listNodesByFilter(filter, limit);
        if (rows.length === 0) return { success: true, output: 'Nenhum nó encontrado.' };

        let output = `📋 ${rows.length} nós encontrados:\n`;
        for (const r of rows) {
            const status = (r.len ?? 0) < 30 ? '⚠️ GHOST' : '✅';
            output += `  ${status} ${r.id} | ${r.type}/${r.domain || '?'} | ${r.name} (${r.len} chars)\n`;
        }
        return { success: true, output };
    }

    // ── ORPHANS ───────────────────────────────────────────────────────────────

    private orphans(): ToolResult {
        const orphans = this.repo.getOrphanNodes();
        if (orphans.length === 0) return { success: true, output: '✅ Nenhum nó órfão encontrado.' };

        let output = `🔗 ${orphans.length} nós órfãos (sem conexões):\n`;
        for (const o of orphans) {
            output += `  ${o.id} | ${o.type}/${o.domain || '?'} | ${o.name} (${o.len} chars)\n`;
        }
        output += `\nUse memory_write connect para conectar, ou memory_admin cleanup para remover ghosts.`;
        return { success: true, output };
    }

    // ── DUPLICATES ────────────────────────────────────────────────────────────

    private duplicates(): ToolResult {
        const dupes = this.repo.getDuplicateNodes();
        if (dupes.length === 0) return { success: true, output: '✅ Nenhuma duplicata óbvia encontrada.' };

        let output = `📋 ${dupes.length} possíveis duplicatas:\n`;
        for (const d of dupes) {
            output += `  "${d.name1}" (${d.id1}) ↔ "${d.name2}" (${d.id2}) [${d.domain1}]\n`;
        }
        output += `\nUse memory_write merge para mesclar duplicatas.`;
        return { success: true, output };
    }

    // ── GHOSTS ────────────────────────────────────────────────────────────────

    private ghosts(): ToolResult {
        const ghosts = this.repo.getGhostNodes();
        if (ghosts.length === 0) return { success: true, output: '✅ Nenhum ghost encontrado.' };

        let output = `👻 ${ghosts.length} nós ghost (conteúdo vazio ou filename):\n`;
        for (const g of ghosts) {
            output += `  ${g.id} | ${g.type}/${g.domain || '?'} | content: "${(g.content || '').slice(0, 50)}"\n`;
        }
        output += `\nUse memory_admin cleanup para remover, ou memory_write update para preencher.`;
        return { success: true, output };
    }

    // ── CLEANUP ───────────────────────────────────────────────────────────────

    private cleanup(): ToolResult {
        const result = this.repo.cleanupGhostsAndOrphans();

        if (result.removedIds.length === 0) {
            return { success: true, output: '✅ Nenhum ghost seguro para remover (identity, core, pref são protegidos).' };
        }

        return {
            success: true,
            output: `🧹 Cleanup concluído:\n   ${result.deletedNodes} nós removidos\n   ${result.deletedEdges} arestas removidas\n   ${result.deletedEmbeddings} embeddings removidos\n   ${result.deletedMetrics} métricas removidas\n   Protegidos: identity, core:*, core_*, pref_*`
        };
    }

    // ── DOMAINS ───────────────────────────────────────────────────────────────

    private domains(): ToolResult {
        const { domains, types } = this.repo.getDomainStats();

        let output = `📊 Domínios:\n`;
        for (const d of domains) output += `  ${d.domain || '(none)'}: ${d.c} nós\n`;
        output += `\n📊 Tipos:\n`;
        for (const t of types) output += `  ${t.type}: ${t.c} nós\n`;

        return { success: true, output };
    }

    // ── REINDEX ───────────────────────────────────────────────────────────────

    private async reindex(id?: string): Promise<ToolResult> {
        const nodes = this.repo.getNodesForReindex(id || undefined);
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
                    const data = await resp.json() as { embedding?: number[] };
                    if (data.embedding) {
                        const buf = Buffer.from(new Float64Array(data.embedding).buffer);
                        this.repo.upsertEmbedding(node.id, buf, 'nomic-embed-text');
                        updated++;
                    } else { failed++; }
                } else { failed++; }
            } catch { failed++; }
        }

        return {
            success: true,
            output: `🔄 Reindexação concluída: ${updated} embeddings atualizados, ${failed} falhas de ${nodes.length} nós.`
        };
    }

    // ── RECALC ────────────────────────────────────────────────────────────────

    private recalc(): ToolResult {
        const updated = this.repo.recalcDegreeAndPagerank();
        return {
            success: true,
            output: `📊 Métricas recalculadas para ${updated} nós (degree + pagerank simplificado).`
        };
    }

    // ── INSPECT ───────────────────────────────────────────────────────────────

    private inspect(id: string): ToolResult {
        if (!id) return { success: false, output: '', error: 'inspect exige: id do nó.' };

        const result = this.repo.inspectNode(id);
        if (!result) return { success: false, output: '', error: `Nó "${id}" não encontrado.` };

        const { node, outEdges, inEdges, embedding } = result;

        let output = `🔍 Nó: ${node.id}\n`;
        output += `   Nome: ${node.name}\n`;
        output += `   Tipo: ${node.type} | Domínio: ${node.domain || '(none)'}\n`;
        output += `   PageRank: ${(node.pagerank || 0).toFixed(4)} | Degree: ${node.degree || 0}\n`;
        const content = node.content || '';
        output += `   Conteúdo (${content.length} chars):\n   ${content.slice(0, 300)}${content.length > 300 ? '...' : ''}\n`;
        output += `\n   → Conexões saindo (${outEdges.length}):\n`;
        for (const e of outEdges) output += `     → [${e.relation}] ${e.to_node} (w=${e.weight})\n`;
        output += `   ← Conexões entrando (${inEdges.length}):\n`;
        for (const e of inEdges) output += `     ← [${e.relation}] ${e.from_node} (w=${e.weight})\n`;
        if (embedding) output += `\n   Embedding: ${embedding.model} (${embedding.updated_at})\n`;

        return { success: true, output };
    }
}
