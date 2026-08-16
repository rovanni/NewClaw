import { Router, Request, Response } from 'express';
import { errorMessage } from '../../shared/errors';
import { createLogger } from '../../shared/AppLogger';
import { MemoryManager } from '../../memory/MemoryManager';
import { DashboardContext, DashboardNode, DashboardEdge } from './types';

const log = createLogger('Dashboardserver');

// ── Pure-computation helpers (no DB access) ───────────────────────────────────

function computeCentrality(
    nodes: Array<{ id: string }>,
    edges: Array<{ from_node: string; to_node: string }>
): Record<string, { degree: number; inDegree: number; outDegree: number }> {
    const centrality: Record<string, { degree: number; inDegree: number; outDegree: number }> = {};
    for (const n of nodes) centrality[n.id] = { degree: 0, inDegree: 0, outDegree: 0 };
    for (const e of edges) {
        if (centrality[e.from_node]) { centrality[e.from_node].outDegree++; centrality[e.from_node].degree++; }
        if (centrality[e.to_node]) { centrality[e.to_node].inDegree++; centrality[e.to_node].degree++; }
    }
    return centrality;
}

function normalizeText(value: string): string {
    return value
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function stringSimilarity(left: string, right: string): number {
    const a = normalizeText(left);
    const b = normalizeText(right);
    if (!a || !b) return 0;
    if (a === b) return 1;

    const aTokens = new Set(a.split(' ').filter(Boolean));
    const bTokens = new Set(b.split(' ').filter(Boolean));
    const shared = [...aTokens].filter((token) => bTokens.has(token)).length;
    const tokenScore = shared / Math.max(aTokens.size, bTokens.size, 1);
    const substringBonus = a.includes(b) || b.includes(a) ? 0.15 : 0;

    return Math.min(1, tokenScore + substringBonus);
}

function findDuplicateCandidates(nodes: DashboardNode[]) {
    const candidates: Array<{ left: DashboardNode; right: DashboardNode; similarity: number }> = [];
    for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
            const left = nodes[i];
            const right = nodes[j];
            const nameSimilarity = stringSimilarity(left.name || '', right.name || '');
            const contentSimilarity = stringSimilarity(left.content || '', right.content || '');
            const sameNormalizedName = normalizeText(left.name || '') === normalizeText(right.name || '');
            const similarity = Math.max(nameSimilarity, contentSimilarity * 0.75);
            if (sameNormalizedName || similarity >= 0.82) {
                candidates.push({ left, right, similarity: sameNormalizedName ? 0.98 : similarity });
            }
        }
    }
    return candidates
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, 12)
        .map((item) => ({
            left: { id: item.left.id, name: item.left.name, type: item.left.type },
            right: { id: item.right.id, name: item.right.name, type: item.right.type },
            similarity: Number(item.similarity.toFixed(2)),
        }));
}

function isSystemNode(id: string): boolean {
    return id.startsWith('core_') || id.startsWith('domain_') ||
           id.startsWith('time_') || id.startsWith('user_identity');
}

// Mesmo limiar que MemoryGovernor.DEFAULT_CONFIG.minConfidence usa para decidir arquivamento —
// não é um número novo inventado para esta tela, é o mesmo corte que o sistema já usa para
// decidir "essa memória decaiu demais". Duplicado aqui (em vez de importado) porque este arquivo
// mantém suas funções de cômputo puras, sem depender de classes do motor de memória — mesmo
// padrão já usado por isSystemNode() acima.
const DECAYED_CONFIDENCE_THRESHOLD = 0.3;

export function computeMemoryReview(nodes: DashboardNode[], edges: DashboardEdge[]) {
    const centrality: Record<string, { degree: number; inDegree: number; outDegree: number }> = {};
    for (const node of nodes) centrality[node.id] = { degree: 0, inDegree: 0, outDegree: 0 };
    for (const edge of edges) {
        if (centrality[edge.from_node]) { centrality[edge.from_node].outDegree++; centrality[edge.from_node].degree++; }
        if (centrality[edge.to_node]) { centrality[edge.to_node].inDegree++; centrality[edge.to_node].degree++; }
    }

    // Exclude system nodes from orphan/sparse detection — they have structural roles
    const reviewable = nodes.filter(n => !isSystemNode(n.id));

    const orphanNodes = reviewable
        .filter((node) => (centrality[node.id]?.degree || 0) === 0)
        .map((node) => ({
            id: node.id, type: node.type, name: node.name,
            contentLength: String(node.content || '').trim().length,
        }));

    const sparseNodes = reviewable
        .filter((node) => {
            const degree = centrality[node.id]?.degree || 0;
            const contentLength = String(node.content || '').trim().length;
            return contentLength < 40 || (degree <= 1 && contentLength < 120);
        })
        .map((node) => ({
            id: node.id, type: node.type, name: node.name,
            degree: centrality[node.id]?.degree || 0,
            contentLength: String(node.content || '').trim().length,
        }))
        .sort((a, b) => a.contentLength - b.contentLength || a.degree - b.degree)
        .slice(0, 20);

    const duplicateCandidates = findDuplicateCandidates(reviewable);

    // Nós cuja confiança decaiu abaixo do limiar de arquivamento do MemoryGovernor — o operador
    // pediu explicitamente uma forma de ver "nós que decairam muito" para decidir se apaga, em
    // vez de depender só do arquivamento automático (que é lento por design para nós tipo fact).
    const decayedNodes = reviewable
        .filter((node) => {
            const confidence = (node as { confidence?: unknown }).confidence;
            return typeof confidence === 'number' && confidence < DECAYED_CONFIDENCE_THRESHOLD;
        })
        .map((node) => ({
            id: node.id, type: node.type, name: node.name,
            confidence: (node as { confidence?: number }).confidence ?? 0,
        }))
        .sort((a, b) => a.confidence - b.confidence)
        .slice(0, 20);

    // Issues: orphans, sparse e decayed — duplicates têm seção dedicada própria na UI
    const issues = [
        ...orphanNodes.map((node) => ({
            kind: 'orphan', priority: 100, nodeId: node.id,
            title: node.name || node.id, detail: 'Nó sem relações',
        })),
        ...sparseNodes.map((node) => ({
            kind: 'sparse',
            priority: 70 - Math.min(node.contentLength, 60) + (node.degree === 0 ? 10 : 0),
            nodeId: node.id, title: node.name || node.id,
            detail: `Conteúdo curto (${node.contentLength} chars), grau ${node.degree}`,
        })),
        ...decayedNodes.map((node) => ({
            kind: 'decayed',
            priority: 90 - Math.round(node.confidence * 100),
            nodeId: node.id, title: node.name || node.id,
            detail: `Confiança em ${Math.round(node.confidence * 100)}% (abaixo de ${Math.round(DECAYED_CONFIDENCE_THRESHOLD * 100)}%)`,
        })),
    ]
        .sort((a, b) => b.priority - a.priority)
        .slice(0, 25);

    const totalNodes = Math.max(nodes.length, 1);
    const totalEdges = edges.length;
    const edgeDensity = totalNodes > 1 ? totalEdges / totalNodes : totalEdges;
    const orphanPenalty = Math.min(35, Math.round((orphanNodes.length / totalNodes) * 100));
    const sparsePenalty = Math.min(25, Math.round((sparseNodes.length / totalNodes) * 60));
    const duplicatePenalty = Math.min(15, duplicateCandidates.length * 3);
    const decayedPenalty = Math.min(20, Math.round((decayedNodes.length / totalNodes) * 60));
    const densityBonus = Math.min(20, Math.round(edgeDensity * 8));
    const qualityScore = Math.max(0, Math.min(100, 55 + densityBonus - orphanPenalty - sparsePenalty - duplicatePenalty - decayedPenalty));

    return {
        summary: {
            totalNodes: nodes.length, totalEdges: edges.length,
            orphanCount: orphanNodes.length, sparseCount: sparseNodes.length,
            duplicateCount: duplicateCandidates.length, decayedCount: decayedNodes.length, qualityScore,
        },
        orphanNodes, sparseNodes, duplicateCandidates, decayedNodes, issues, centrality,
    };
}

// ── Router ────────────────────────────────────────────────────────────────────

export function createMemoryRouter(ctx: DashboardContext): Router {
    const router = Router();

    router.get('/graph', (_req: Request, res: Response) => {
        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const type = _req.query.type as string | undefined;
            const limit = Math.min(parseInt(String(_req.query.limit)) || 200, 500);
            const { nodes, edges } = ctx.memoryManager.getDashboardRepository().getGraph(type, limit);
            res.json({ success: true, nodes, edges });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    router.get('/graph/:nodeId', (req: Request, res: Response) => {
        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const nodeId = String(req.params.nodeId);
            const depth = parseInt(String(req.query.depth)) || 1;
            const { nodes, edges } = ctx.memoryManager.getDashboardRepository().getNodeNeighborhood(nodeId, depth);
            res.json({ success: true, nodes, edges, center: nodeId, depth });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    router.get('/ontology', (_req: Request, res: Response) => {
        res.json({
            success: true,
            nodeTypes: MemoryManager.NODE_TYPES,
            relations: Object.entries(MemoryManager.RELATION_ONTOLOGY).map(([key, val]) => ({
                id: key,
                label: val.label,
                description: val.description,
                allowedFrom: val.allowedFrom,
                allowedTo: val.allowedTo,
                inverse: null
            })),
            inverseRelations: {}
        });
    });

    router.get('/snapshots', (_req: Request, res: Response) => {
        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const snapshots = ctx.memoryManager.listSnapshots() ?? [];
            res.json({ success: true, snapshots });
        } catch (err) { res.status(500).json({ error: errorMessage(err) }); }
    });

    router.post('/snapshots', (req: Request, res: Response) => {
        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const id = ctx.memoryManager.createSnapshot(req.body.label as string);
            res.json({ success: true, id });
        } catch (err) { res.status(500).json({ error: errorMessage(err) }); }
    });

    router.post('/snapshots/:id/restore', (req: Request, res: Response) => {
        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const ok = ctx.memoryManager.restoreSnapshot(String(req.params.id));
            ok ? res.json({ success: true }) : res.status(404).json({ error: 'Snapshot not found' });
        } catch (err) { res.status(500).json({ error: errorMessage(err) }); }
    });

    router.delete('/snapshots/:id', (req: Request, res: Response) => {
        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const ok = ctx.memoryManager.deleteSnapshot(String(req.params.id));
            ok ? res.json({ success: true }) : res.status(404).json({ error: 'Snapshot not found' });
        } catch (err) { res.status(500).json({ error: errorMessage(err) }); }
    });

    router.get('/stats', (_req: Request, res: Response) => {
        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const data = ctx.memoryManager.getDashboardRepository().getStats();
            const { totalNodes, totalEdges, totalMessages, totalConversations, nodesByType, allNodesForCentrality, allEdgesForCentrality } = data;
            res.json({
                success: true,
                stats: { totalNodes, totalEdges, totalMessages, totalConversations, nodesByType },
                centrality: computeCentrality(allNodesForCentrality, allEdgesForCentrality)
            });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    router.get('/review', (_req: Request, res: Response) => {
        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const { nodes, edges } = ctx.memoryManager.getDashboardRepository().getReviewData();
            const review = computeMemoryReview(nodes as DashboardNode[], edges as DashboardEdge[]);
            res.json({ success: true, review });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    router.post('/merge', (req: Request, res: Response) => {
        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const { keepId, mergeId } = req.body || {};
            if (!keepId || !mergeId) return res.status(400).json({ error: 'keepId e mergeId são obrigatórios' });
            if (keepId === mergeId) return res.status(400).json({ error: 'keepId e mergeId devem ser diferentes' });
            if (isSystemNode(keepId) || isSystemNode(mergeId)) {
                return res.status(403).json({ error: `Nós de sistema não podem ser mesclados.` });
            }

            const repo = ctx.memoryManager.getDashboardRepository();
            const snapshotId = ctx.memoryManager.createSnapshot?.(`pre-merge:${keepId}<-${mergeId}`) || null;
            const result = repo.mergeNodes(keepId, mergeId);
            if (!result) return res.status(404).json({ error: 'Node not found' });

            log.info(`Nodes merged: keep=${keepId}, removed=${mergeId}`);
            res.json({ success: true, snapshotId, keptNodeId: keepId, removedNodeId: mergeId });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    router.get('/nodes', (req: Request, res: Response) => {
        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const type = req.query.type as string | undefined;
            const limit = parseInt(String(req.query.limit)) || 50;
            const nodes = ctx.memoryManager.getDashboardRepository().listNodes(type, limit);
            res.json({ success: true, nodes });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    router.get('/search', async (req: Request, res: Response) => {
        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const q = req.query.q as string;
            if (!q) return res.status(400).json({ error: 'Query parameter "q" required' });

            // Combina busca lexical (nome+conteúdo, FTS5/LIKE) com busca por embedding — nunca
            // uma como fallback condicional da outra. Achado real (15/08/2026): o código antigo só
            // rodava a busca textual quando `embeddingService.search()` devolvia ZERO resultados —
            // mas `EmbeddingService.search()` não tem piso de similaridade (nenhum `score < X`
            // corta o resultado), então praticamente qualquer busca com embeddings disponíveis
            // devolve `results.length > 0`, e a busca por nome/conteúdo nunca chegava a rodar. Um
            // nó com "RIVER" literalmente no nome ficava invisível se o ranking por vetor não o
            // colocasse no top-20 semântico — mesmo sendo uma correspondência textual exata.
            const dashboardRepo = ctx.memoryManager.getDashboardRepository();
            const merged = new Map<string, { id: string; type: string; name: string; content: string; updated_at: string; score: number }>();

            // 1. Lexical — sempre roda, já cobre nome E conteúdo (memory_nodes_fts indexa
            //    `name, content, type`; fallback LIKE cobre os dois campos também).
            for (const n of dashboardRepo.searchNodes(q)) {
                merged.set(n.id, { id: n.id, type: n.type, name: n.name, content: n.content, updated_at: n.updated_at, score: 0.5 });
            }

            // 2. Semântica — soma, não substitui. Quando o mesmo nó aparece nos dois, fica com o
            //    maior score (evidência textual exata não deve perder pra uma similaridade
            //    marginal, mas uma similaridade muito alta também não deve perder pro score fixo
            //    do match textual).
            let usedEmbedding = false;
            if (ctx.embeddingService) {
                try {
                    const available = await ctx.embeddingService.isAvailable();
                    if (available) {
                        const embResults = await ctx.embeddingService.search(q, 20);
                        if (embResults.length > 0) {
                            usedEmbedding = true;
                            const ids = embResults.map(r => r.id);
                            const scoreMap = new Map(embResults.map(r => [r.id, r.score]));
                            const embNodes = dashboardRepo.searchNodes(q, ids);
                            for (const n of embNodes) {
                                const embScore = scoreMap.get(n.id) ?? 0;
                                const existing = merged.get(n.id);
                                merged.set(n.id, { id: n.id, type: n.type, name: n.name, content: n.content, updated_at: n.updated_at, score: Math.max(existing?.score ?? 0, embScore) });
                            }
                        }
                    }
                } catch { /* busca por embedding é best-effort — resultado lexical continua valendo */ }
            }

            const nodes = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, 20);
            const method = usedEmbedding ? 'combined' : (nodes.length > 0 ? 'fts5_like' : 'none');
            return res.json({ success: true, nodes, method });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    router.get('/analytics', (_req: Request, res: Response) => {
        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const { nodes, totalEdges } = ctx.memoryManager.getDashboardRepository().getAnalytics();
            const maxEdges = nodes.length * (nodes.length - 1);
            const density = maxEdges > 0 ? totalEdges / maxEdges : 0;

            const topByDegree = [...nodes].sort((a, b) => (b.degree || 0) - (a.degree || 0)).slice(0, 10).map(n => ({ id: n.id, name: n.name, type: n.type, value: n.degree }));
            const topByBetweenness = [...nodes].sort((a, b) => (b.betweenness || 0) - (a.betweenness || 0)).slice(0, 10).map(n => ({ id: n.id, name: n.name, type: n.type, value: Math.round((n.betweenness || 0) * 100) / 100 }));
            const topByCloseness = [...nodes].sort((a, b) => (b.closeness || 0) - (a.closeness || 0)).slice(0, 10).map(n => ({ id: n.id, name: n.name, type: n.type, value: Math.round((n.closeness || 0) * 100) / 100 }));

            res.json({
                success: true,
                analytics: {
                    totalNodes: nodes.length, totalEdges,
                    density: Math.round(density * 10000) / 10000,
                    avgDegree: nodes.length > 0 ? Math.round(totalEdges * 2 / nodes.length * 100) / 100 : 0,
                    topByDegree, topByBetweenness, topByCloseness
                }
            });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    router.get('/nodes/:id', (req: Request, res: Response) => {
        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const id = String(req.params.id);
            const result = ctx.memoryManager.getDashboardRepository().getNodeWithEdges(id);
            if (!result) return res.status(404).json({ error: 'Node not found' });

            const { node, edges } = result;
            try {
                (node as DashboardNode).metadata = JSON.parse(String((node as DashboardNode).metadata || '{}'));
            } catch (e) {
                log.warn(`Corrupted metadata for node ${id}: ${errorMessage(e)}`);
                (node as DashboardNode).metadata = {};
            }
            res.json({ success: true, node, edges });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    router.put('/nodes/:id', (req: Request, res: Response) => {
        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const id = String(req.params.id);
            if (isSystemNode(id)) {
                return res.status(403).json({ error: `Nó de sistema "${id}" não pode ser modificado via API. Use PUT /api/system/owner-profile para identidade do dono.` });
            }
            const { type, name, content } = req.body;
            const updated = ctx.memoryManager.getDashboardRepository().updateNode(id, { type, name, content });
            if (!updated) return res.status(404).json({ error: 'Node not found' });
            log.info(`Node updated: ${id}`);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    router.post('/nodes', (req: Request, res: Response) => {
        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const { id, type, name, content } = req.body;
            if (!id || !type || !name || content === undefined) {
                return res.status(400).json({ error: 'id, type, name, content required' });
            }
            if (isSystemNode(String(id))) {
                return res.status(403).json({ error: `Nó de sistema "${id}" não pode ser criado/sobrescrito via API.` });
            }
            ctx.memoryManager.getDashboardRepository().createNode(id, type, name, content);
            log.info(`Node created: ${id} (${type})`);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    router.delete('/nodes/:id', (req: Request, res: Response) => {
        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const id = String(req.params.id);
            if (isSystemNode(id)) {
                return res.status(403).json({ error: `Nó de sistema "${id}" não pode ser deletado via API.` });
            }
            ctx.memoryManager.getDashboardRepository().deleteNode(id);
            log.info(`Node deleted: ${id}`);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    router.post('/edges', (req: Request, res: Response) => {
        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const { from, to, relation, weight } = req.body;
            if (!from || !to || !relation) return res.status(400).json({ error: 'from, to, relation required' });
            ctx.memoryManager.getDashboardRepository().createEdge(from, to, relation, weight);
            log.info(`Edge created: ${from} -${relation}-> ${to}`);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    router.delete('/edges', (req: Request, res: Response) => {
        if (!ctx.memoryManager) return res.status(500).json({ error: 'Memory not available' });
        try {
            const { from, to, relation } = req.body;
            ctx.memoryManager.getDashboardRepository().deleteEdge(from, to, relation);
            log.info(`Edge deleted: ${from} -${relation}-> ${to}`);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    return router;
}
