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

function computeMemoryReview(nodes: DashboardNode[], edges: DashboardEdge[]) {
    const centrality: Record<string, { degree: number; inDegree: number; outDegree: number }> = {};
    for (const node of nodes) centrality[node.id] = { degree: 0, inDegree: 0, outDegree: 0 };
    for (const edge of edges) {
        if (centrality[edge.from_node]) { centrality[edge.from_node].outDegree++; centrality[edge.from_node].degree++; }
        if (centrality[edge.to_node]) { centrality[edge.to_node].inDegree++; centrality[edge.to_node].degree++; }
    }

    const orphanNodes = nodes
        .filter((node) => (centrality[node.id]?.degree || 0) === 0)
        .map((node) => ({
            id: node.id, type: node.type, name: node.name,
            contentLength: String(node.content || '').trim().length,
        }));

    const sparseNodes = nodes
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

    const duplicateCandidates = findDuplicateCandidates(nodes);

    const issues = [
        ...orphanNodes.map((node) => ({
            kind: 'orphan', priority: 100, nodeId: node.id,
            title: node.name || node.id, detail: 'No sem relacoes',
        })),
        ...sparseNodes.map((node) => ({
            kind: 'sparse',
            priority: 70 - Math.min(node.contentLength, 60) + (node.degree === 0 ? 10 : 0),
            nodeId: node.id, title: node.name || node.id,
            detail: `Conteudo curto (${node.contentLength} chars), grau ${node.degree}`,
        })),
        ...duplicateCandidates.map((pair) => ({
            kind: 'duplicate',
            priority: 80 + Math.round(pair.similarity * 10),
            nodeId: pair.left.id, secondaryNodeId: pair.right.id,
            title: `${pair.left.name || pair.left.id} / ${pair.right.name || pair.right.id}`,
            detail: `Possivel duplicata (${Math.round(pair.similarity * 100)}%)`,
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
    const densityBonus = Math.min(20, Math.round(edgeDensity * 8));
    const qualityScore = Math.max(0, Math.min(100, 55 + densityBonus - orphanPenalty - sparsePenalty - duplicatePenalty));

    return {
        summary: {
            totalNodes: nodes.length, totalEdges: edges.length,
            orphanCount: orphanNodes.length, sparseCount: sparseNodes.length,
            duplicateCount: duplicateCandidates.length, qualityScore,
        },
        orphanNodes, sparseNodes, duplicateCandidates, issues, centrality,
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
            if (!keepId || !mergeId) return res.status(400).json({ error: 'keepId and mergeId are required' });
            if (keepId === mergeId) return res.status(400).json({ error: 'keepId and mergeId must be different' });

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

            if (ctx.embeddingService) {
                try {
                    const available = await ctx.embeddingService.isAvailable();
                    if (available) {
                        const results = await ctx.embeddingService.search(q, 20);
                        if (results.length > 0) {
                            const ids = results.map(r => r.id);
                            const scores = new Map(results.map(r => [r.id, r.score]));
                            const nodes = ctx.memoryManager.getDashboardRepository().searchNodes(q, ids);
                            const nodesWithScore = nodes.map(n => ({ ...n, score: scores.get(n.id) || 0 }));
                            nodesWithScore.sort((a, b) => b.score - a.score);
                            return res.json({ success: true, nodes: nodesWithScore, method: 'embedding' });
                        }
                    }
                } catch { /* fall through to text search */ }
            }

            const nodes = ctx.memoryManager.getDashboardRepository().searchNodes(q);
            const method = nodes.length > 0 ? 'fts5' : 'like';
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
