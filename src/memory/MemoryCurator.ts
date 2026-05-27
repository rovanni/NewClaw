import { MemoryManager } from './MemoryManager';
import { GraphAnalytics } from './GraphAnalytics';
import { EmbeddingService } from './EmbeddingService';
import type { MemoryGraphRepository } from './MemoryGraphRepository';
import { createLogger } from '../shared/AppLogger';
import { errorMessage } from '../shared/errors';
const log = createLogger('Memorycurator');
import type { DomainSummaryService } from './DomainSummaryService';
import { getDomainById } from './DomainRegistry';

interface CuratorResult {
    orphansFixed: number;
    hubsCreated: number;
    edgesCreated: string[];
    details: string[];
}

interface NodeForConsolidation {
    id: string;
    name: string;
    content: string;
    type: string;
    domain: string;
    weight: number | null;
    confidence: number | null;
    last_accessed: string | null;
    updated_at: string | null;
}

export interface ConsolidationResult {
    clustersFound: number;
    nodesMarkedSummarized: number;
    summariesCreated: number;
}

export interface DeduplicationResult {
    pairsFound: number;
    nodesSuperseded: number;
    edgesRetargeted: number;
}

export interface DistillationResult {
    nodesPromoted: number;
    interestsExtracted: number;
    episodesArchived: number;
    skipped: boolean;
}

export class MemoryCurator {
    private mm: MemoryManager;
    private repo: MemoryGraphRepository;
    private analytics: GraphAnalytics;
    private embeddingService?: EmbeddingService;
    private domainSummaryService: DomainSummaryService;
    private intervalId: ReturnType<typeof setInterval> | null = null;

    constructor(memoryManager: MemoryManager, embeddingService?: EmbeddingService) {
        this.mm = memoryManager;
        this.repo = memoryManager.getGraphRepository();
        this.analytics = new GraphAnalytics(memoryManager);
        this.embeddingService = embeddingService;
        this.domainSummaryService = memoryManager.getDomainSummaryService();
    }

    private addEdgeSafe(from: string, to: string, relation: string): boolean {
        try {
            this.mm.addEdge(from, to, relation);
            return true;
        } catch {
            return false;
        }
    }

    async curate(): Promise<CuratorResult> {
        const result: CuratorResult = { orphansFixed: 0, hubsCreated: 0, edgesCreated: [], details: [] };

        const nodes = this.repo.getAllNodes();
        const edges = this.repo.getAllEdges();

        const connectedNodes = new Set<string>();
        for (const e of edges) {
            connectedNodes.add(e.from_node);
            connectedNodes.add(e.to_node);
        }

        const DAILY_HUB = 'ctx_daily_memory';
        const SYSTEM_HUB = 'ctx_system_memory';
        const INFRA_HUB = 'ctx_infrastructure';

        const orphans = nodes.filter(n => !connectedNodes.has(n.id));

        // Remove hubs from orphans to prevent self-loops
        const trueOrphans = orphans.filter(o => o.id !== DAILY_HUB && o.id !== SYSTEM_HUB && o.id !== INFRA_HUB);

        if (trueOrphans.length === 0) {
            this.repo.deleteSelfLoops();
            this.repo.deleteDuplicateDailySystemEdges();

            result.details.push('No true orphans found — graph is clean!');
            return result;
        }

        result.details.push(`Found ${trueOrphans.length} true orphan nodes`);

        // Classify orphans STRICTLY
        const dailyOrphans = trueOrphans.filter(o => /^memory_\d{4}-\d{2}-\d{2}/.test(o.id));
        const systemOrphans = trueOrphans.filter(o => !dailyOrphans.includes(o) && (o.id.startsWith('memory_') || o.id.startsWith('service:') || o.id.startsWith('infra_')));
        const otherOrphans = trueOrphans.filter(o => !dailyOrphans.includes(o) && !systemOrphans.includes(o));

        // Create hubs if missing
        const hubDefs = [
            { id: DAILY_HUB, name: 'Diário de Memória' },
            { id: SYSTEM_HUB, name: 'Memória do Sistema' },
            { id: INFRA_HUB, name: 'Infraestrutura' },
        ];

        for (const hub of hubDefs) {
            if (!nodes.some(n => n.id === hub.id)) {
                this.mm.addNode({ id: hub.id, type: 'context', name: hub.name, content: `Hub para nós de ${hub.name}` });
                result.hubsCreated++;
                result.details.push(`Created hub: ${hub.id}`);
            }
        }

        // Connect core_identity → hubs
        if (nodes.some(n => n.id === 'core_identity')) {
            for (const hubId of [DAILY_HUB, SYSTEM_HUB, INFRA_HUB]) {
                if (!edges.some(e => e.from_node === 'core_identity' && e.to_node === hubId)) {
                    if (this.addEdgeSafe('core_identity', hubId, 'manages')) {
                        result.edgesCreated.push(`core_identity --manages--> ${hubId}`);
                    }
                }
            }
        }

        // Connect daily orphans to daily hub
        for (const o of dailyOrphans) {
            this.addEdgeSafe(DAILY_HUB, o.id, 'contains');
            result.orphansFixed++;
            result.edgesCreated.push(`${DAILY_HUB} --contains--> ${o.id}`);
        }

        // Chain daily nodes chronologically
        const sorted = [...dailyOrphans].sort((a, b) => a.id.localeCompare(b.id));
        for (let i = 0; i < sorted.length - 1; i++) {
            if (!edges.some(e => e.from_node === sorted[i].id && e.to_node === sorted[i + 1].id && e.relation === 'next')) {
                this.addEdgeSafe(sorted[i].id, sorted[i + 1].id, 'next');
                result.edgesCreated.push(`${sorted[i].id} --next--> ${sorted[i + 1].id}`);
            }
        }

        // Connect system/infra orphans
        for (const o of systemOrphans) {
            const hub = (o.id.startsWith('service:') || o.id.startsWith('infra_')) ? INFRA_HUB : SYSTEM_HUB;
            this.addEdgeSafe(hub, o.id, 'contains');
            result.orphansFixed++;
            result.edgesCreated.push(`${hub} --contains--> ${o.id}`);
        }

        // Connect other orphans by type
        for (const o of otherOrphans) {
            if (o.type === 'preference' && nodes.some(n => n.id === 'core_user')) {
                this.addEdgeSafe('core_user', o.id, 'prefers');
                result.orphansFixed++;
                result.edgesCreated.push(`core_user --prefers--> ${o.id}`);
            } else if (o.type === 'project' && nodes.some(n => n.id === 'core_user')) {
                this.addEdgeSafe('core_user', o.id, 'works_on');
                result.orphansFixed++;
                result.edgesCreated.push(`core_user --works_on--> ${o.id}`);
            } else if (o.type === 'skill') {
                this.addEdgeSafe(INFRA_HUB, o.id, 'contains');
                result.orphansFixed++;
                result.edgesCreated.push(`${INFRA_HUB} --contains--> ${o.id}`);
            } else {
                this.addEdgeSafe(SYSTEM_HUB, o.id, 'contains');
                result.orphansFixed++;
                result.edgesCreated.push(`${SYSTEM_HUB} --contains--> ${o.id}`);
            }
        }

        // Connect daily hub to first daily node
        const allDaily = nodes.filter(n => /^memory_\d{4}-\d{2}-\d{2}$/.test(n.id)).sort((a, b) => a.id.localeCompare(b.id));
        if (allDaily.length > 0 && !edges.some(e => e.from_node === DAILY_HUB && e.to_node === allDaily[0].id)) {
            this.addEdgeSafe(DAILY_HUB, allDaily[0].id, 'contains');
            result.edgesCreated.push(`${DAILY_HUB} --contains--> ${allDaily[0].id}`);
        }

        result.details.push(`Fixed ${result.orphansFixed} orphans, created ${result.hubsCreated} hubs, ${result.edgesCreated.length} edges`);

        // ── Identity Cleanup ──
        const cleanup = this.cleanupInvalidNodes();
        result.details.push(`Cleaned ${cleanup.invalidCount} invalid identity nodes`);

        // ── Temporal Decay ──
        await this.applyTemporalDecay();

        return result;
    }

    private cleanupInvalidNodes(): { invalidCount: number } {
        let invalidCount = 0;
        const forbiddenPatterns = [/se chama/i, /é o/i, /é a/i, /chamado/i, /meu nome/i, /nome é/i];

        for (const node of this.repo.getIdentityNodes()) {
            const isUnstructured = node.content.length > 80 || forbiddenPatterns.some(p => p.test(node.content));
            if (isUnstructured && node.id !== 'core_user' && node.id !== 'core_identity' && node.id !== 'core_agent') {
                this.repo.updateNodeWeightAndMeta(node.id, 0.2, 0.2);
                invalidCount++;
            }
        }

        for (const orphan of this.repo.getUnconnectedIdentityNodes()) {
            this.addEdgeSafe('core_user', orphan.id, 'has_identity');
        }

        return { invalidCount };
    }

    private async enforceStorageQuotas(): Promise<{ prunedTraces: number; prunedMessages: number }> {
        try {
            const prunedTraces = this.repo.pruneOldTraces(3);
            let prunedMessages = 0;

            for (const convId of this.repo.getConversationIds()) {
                prunedMessages += this.repo.pruneOldMessagesForConversation(convId, 1000);
            }

            const prunedProcedural = this.mm.getProceduralMemory().pruneOldExecutions(90);

            if (prunedTraces > 0 || prunedMessages > 0 || prunedProcedural > 0) {
                log.info(`[StorageQuotas] Pruned ${prunedTraces} traces, ${prunedMessages} messages, ${prunedProcedural} procedural executions.`);
            }

            return { prunedTraces, prunedMessages };
        } catch (error) {
            log.error('[StorageQuotas] Error:', errorMessage(error));
            return { prunedTraces: 0, prunedMessages: 0 };
        }
    }

    private async applyTemporalDecay(): Promise<{ decayed: number }> {
        try {
            this.repo.ensureEdgeLastAccessed();
            const decayed = this.repo.decayOldEdges(30, 0.98, 0.1);
            if (decayed > 0) log.info(`[TemporalDecay] ${decayed} edges decayed (×0.98)`);
            return { decayed };
        } catch (error) {
            log.error('[TemporalDecay] Error:', errorMessage(error));
            return { decayed: 0 };
        }
    }

    /**
     * Sparse Graph Strategy — remove arestas fracas que poluem o retrieval.
     *
     * Executado após decayOldEdges() para que arestas já decaídas abaixo do limiar
     * sejam imediatamente elegíveis para poda nesta mesma rodada.
     *
     * Thresholds:
     *   - weight < 0.15 AND confidence < 0.30 AND inativa há 30+ dias → deletar
     *   - grau de saída > 25 arestas por nó → manter apenas as 25 mais fortes
     *
     * Relações estruturais protegidas: contains, next, summarizes, has_identity, has_domain, groups
     */
    async pruneWeakEdges(): Promise<{ prunedWeak: number; prunedOverflow: number }> {
        try {
            const result = this.repo.pruneWeakEdges();
            if (result.prunedWeak > 0 || result.prunedOverflow > 0) {
                log.info(`[SparseGraph] ${result.prunedWeak} weak edges removidas, ${result.prunedOverflow} overflow (max-degree enforced)`);
            }
            return result;
        } catch (error) {
            log.error('[SparseGraph] pruneWeakEdges falhou:', errorMessage(error));
            return { prunedWeak: 0, prunedOverflow: 0 };
        }
    }

    // ── Knowledge Distillation ───────────────────────────────────────────────
    //
    // Cristaliza padrões episódicos em conhecimento semântico permanente.
    // É o "fechamento do loop": CognitiveReflectionEngine observa padrões,
    // distillKnowledge() os escreve de volta no grafo como nós duráveis.
    //
    // Três passos:
    //   1. Node promotion: nós estáveis (3+ sessões distintas) → boost confidence/weight
    //   2. Interest extraction: domínios em 5+ das últimas 20 sessões → nó preference USER_MEMORY
    //   3. Episode archiving: episódios > 30 dias → is_active = -1 (excluídos do prompt, preservados)

    private readonly DISTILLATION_MIN_EPISODES          = 10;  // novas sessões desde última distilação
    private readonly DISTILLATION_FALLBACK_DAYS         = 7;   // alternativa temporal: 7 dias + 5 sessões
    private readonly DISTILLATION_FALLBACK_MIN_EP       = 5;
    private readonly DISTILLATION_NODE_MIN_SESSIONS     = 3;   // nó em N+ sessões distintas → promover
    private readonly DISTILLATION_INTEREST_MIN_SESSIONS = 5;   // domínio em N+ das últimas 20 → preferência
    private readonly DISTILLATION_ARCHIVE_DAYS          = 30;  // arquivar episódios mais velhos que isto

    /**
     * Distila N conversas em conhecimento semântico permanente.
     *
     * Throttle: só roda quando há DISTILLATION_MIN_EPISODES novas sessões fechadas
     * desde a última execução, ou após DISTILLATION_FALLBACK_DAYS dias + 5 sessões.
     * Idempotente: re-executar não duplica nós (addNode usa ON CONFLICT DO UPDATE).
     */
    async distillKnowledge(): Promise<DistillationResult> {
        const db = this.mm.getDatabase();

        // ── Throttle ──────────────────────────────────────────────────────────
        const lastRunRow = db.prepare(
            "SELECT value FROM memory WHERE key = 'last_distillation_at'"
        ).get() as { value: string } | undefined;

        const closedSince: number = lastRunRow
            ? (db.prepare(`
                SELECT COUNT(*) AS cnt FROM memory_episodes
                WHERE is_active = 0 AND ended_at > ?
              `).get(lastRunRow.value) as { cnt: number }).cnt
            : (db.prepare(
                `SELECT COUNT(*) AS cnt FROM memory_episodes WHERE is_active = 0`
              ).get() as { cnt: number }).cnt;

        const daysSinceLast = lastRunRow
            ? (Date.now() - new Date(lastRunRow.value).getTime()) / 86400000
            : 999;

        const shouldRun =
            closedSince >= this.DISTILLATION_MIN_EPISODES ||
            (daysSinceLast >= this.DISTILLATION_FALLBACK_DAYS && closedSince >= this.DISTILLATION_FALLBACK_MIN_EP);

        if (!shouldRun) {
            return { nodesPromoted: 0, interestsExtracted: 0, episodesArchived: 0, skipped: true };
        }

        const result: DistillationResult = { nodesPromoted: 0, interestsExtracted: 0, episodesArchived: 0, skipped: false };

        // ── Passo 1: Promover nós estáveis ────────────────────────────────────
        // confidence ×1.15 (cap 0.95), weight ×1.1 (cap 2.0)
        // Critério: apareceu em DISTILLATION_NODE_MIN_SESSIONS+ sessões distintas
        const stableNodes = db.prepare(`
            SELECT en.node_id
            FROM episode_nodes en
            JOIN memory_nodes n ON n.id = en.node_id
            WHERE (n.lifecycle_state IS NULL OR n.lifecycle_state = 'ACTIVE')
              AND n.type NOT IN ('domain', 'identity')
              AND n.id NOT LIKE 'core_%'
            GROUP BY en.node_id
            HAVING COUNT(DISTINCT en.conversation_id) >= ?
        `).all(this.DISTILLATION_NODE_MIN_SESSIONS) as Array<{ node_id: string }>;

        const promoteStmt = db.prepare(`
            UPDATE memory_nodes
            SET confidence = MIN(COALESCE(confidence, 0.5) * 1.15, 0.95),
                weight     = MIN(COALESCE(weight,     1.0) * 1.10, 2.00)
            WHERE id = ?
        `);

        for (const { node_id } of stableNodes) {
            try {
                promoteStmt.run(node_id);
                log.info('node_promoted', 'distillation', { nodeId: node_id });
                result.nodesPromoted++;
            } catch { /* keep going */ }
        }

        // ── Passo 2: Extrair interesses estáveis ──────────────────────────────
        // Domínio em 5+ das últimas 20 sessões fechadas → nó preference USER_MEMORY
        // Nó é idempotente: id fixo = 'distilled_interest_<domain>'
        const recentEpCount = (db.prepare(
            `SELECT COUNT(*) AS cnt FROM (SELECT 1 FROM memory_episodes WHERE is_active = 0 LIMIT 20)`
        ).get() as { cnt: number }).cnt;

        if (recentEpCount >= this.DISTILLATION_INTEREST_MIN_SESSIONS) {
            const stableDomains = db.prepare(`
                SELECT je.value AS domain, COUNT(*) AS freq
                FROM (
                    SELECT domains FROM memory_episodes
                    WHERE is_active = 0
                    ORDER BY ended_at DESC LIMIT 20
                ) recent_ep, json_each(recent_ep.domains) je
                GROUP BY je.value
                HAVING freq >= ?
            `).all(this.DISTILLATION_INTEREST_MIN_SESSIONS) as Array<{ domain: string; freq: number }>;

            for (const { domain, freq } of stableDomains) {
                const domainLabel = domain.replace(/^domain_/, '').toLowerCase();
                const nodeId = `distilled_interest_${domain}`;
                try {
                    this.mm.addNode({
                        id: nodeId,
                        type: 'preference',
                        name: `Interesse: ${domainLabel}`,
                        content: `Interesse estável: ${domainLabel} detectado em ${freq}/${recentEpCount} sessões recentes.`,
                        confidence: 0.8,
                        weight: 1.2,
                        metadata: {
                            distilled: 'true',
                            source_domain: domain,
                            episode_frequency: String(freq),
                            distilled_at: new Date().toISOString(),
                        },
                    }, 'distillation');

                    this.mm.getFacade().setNodeDomain(nodeId, domain);
                    this.addEdgeSafe('core_user', nodeId, 'prefers');
                    this.addEdgeSafe(domain, nodeId, 'contains');

                    result.interestsExtracted++;
                } catch (e) {
                    log.warn(`[Distillation] Falha ao criar interesse para ${domain}: ${errorMessage(e)}`);
                }
            }
        }

        // ── Passo 3: Arquivar episódios antigos ───────────────────────────────
        // is_active = -1 → arquivado: excluído do prompt, preservado no banco para auditoria
        result.episodesArchived = db.prepare(`
            UPDATE memory_episodes
            SET is_active = -1
            WHERE is_active = 0
              AND ended_at < datetime('now', '-' || ? || ' days')
        `).run(this.DISTILLATION_ARCHIVE_DAYS).changes;

        // ── Registrar timestamp ───────────────────────────────────────────────
        db.prepare(
            "INSERT OR REPLACE INTO memory (key, value, category) VALUES ('last_distillation_at', ?, 'system')"
        ).run(new Date().toISOString());

        log.info(`[Distillation] ${result.nodesPromoted} nós promovidos | ${result.interestsExtracted} interesses | ${result.episodesArchived} episódios arquivados`);
        return result;
    }

    // ── Node Deduplication (non-destructive) ─────────────────────────────────
    //
    // Complementa a consolidação semântica (que age só em nós stale).
    // Dedup age em nós ATIVOS — qualquer confidence/weight.
    //
    // Dois passos:
    //   1. Name dedup (O(n)): nome normalizado idêntico → mescla o mais fraco no mais forte
    //   2. Content dedup (O(n²) boundado): Jaccard > 0.75, mesmo type → mescla
    //
    // Merge não-destrutivo:
    //   - Todas as arestas (entrada/saída) do duplicado são redirecionadas para o canônico
    //   - Duplicado marcado lifecycle_state = 'SUPERSEDED' (dado preservado, recuperável)
    //   - Nenhum nó é deletado

    private readonly DEDUP_CONTENT_THRESHOLD = 0.75;
    private readonly DEDUP_MAX_CANDIDATES = 200; // teto para scan O(n²)

    // Nunca deduplica: hubs estruturais, nós de identidade, core/domain/user_identity
    private readonly DEDUP_PROTECTED_TYPES = new Set(['identity', 'domain']);

    /**
     * Detecta e mescla nós ativos near-duplicados.
     * Canônico = nó com maior weight × confidence × (pagerank + 0.01).
     * Duplicado = marcado SUPERSEDED; suas arestas migram para o canônico.
     */
    async deduplicateNodes(): Promise<DeduplicationResult> {
        const result: DeduplicationResult = { pairsFound: 0, nodesSuperseded: 0, edgesRetargeted: 0 };
        const db = this.mm.getDatabase();

        const candidates = db.prepare(`
            SELECT id, name, content, type, weight, confidence, pagerank
            FROM memory_nodes
            WHERE (lifecycle_state IS NULL OR lifecycle_state = 'ACTIVE')
              AND content IS NOT NULL AND content != ''
              AND id NOT LIKE 'core_%'
              AND id NOT LIKE 'domain_%'
              AND id NOT LIKE 'user_identity%'
            ORDER BY (COALESCE(weight, 1.0) * COALESCE(confidence, 1.0)) DESC
        `).all() as Array<{
            id: string; name: string; content: string; type: string;
            weight: number | null; confidence: number | null; pagerank: number | null;
        }>;

        const normName = (s: string) => s.toLowerCase().trim().replace(/\s+/g, ' ');
        const nodeScore = (n: { weight: number | null; confidence: number | null; pagerank: number | null }) =>
            (n.weight ?? 1.0) * (n.confidence ?? 1.0) * ((n.pagerank ?? 0) + 0.01);

        const superseded = new Set<string>();

        // ── Passo 1: Name dedup (O(n)) ─────────────────────────────────
        const byName = new Map<string, typeof candidates>();
        for (const node of candidates) {
            if (this.DEDUP_PROTECTED_TYPES.has(node.type)) continue;
            const key = normName(node.name);
            const group = byName.get(key) ?? [];
            group.push(node);
            byName.set(key, group);
        }

        const mergePairs: Array<[typeof candidates[0], typeof candidates[0]]> = [];

        for (const group of byName.values()) {
            if (group.length < 2) continue;
            group.sort((a, b) => nodeScore(b) - nodeScore(a));
            const canonical = group[0];
            for (let i = 1; i < group.length; i++) {
                mergePairs.push([canonical, group[i]]);
            }
        }

        // ── Passo 2: Content dedup (O(n²) boundado) ────────────────────
        // Apenas candidatos não-protegidos, limitado por DEDUP_MAX_CANDIDATES
        const contentCandidates = candidates
            .filter(n => !this.DEDUP_PROTECTED_TYPES.has(n.type))
            .slice(0, this.DEDUP_MAX_CANDIDATES);

        for (let i = 0; i < contentCandidates.length; i++) {
            for (let j = i + 1; j < contentCandidates.length; j++) {
                const a = contentCandidates[i];
                const b = contentCandidates[j];
                if (a.type !== b.type) continue;
                if (normName(a.name) === normName(b.name)) continue; // já coberto pelo passo 1
                if (this.jaccardSimilarity(a.content, b.content) >= this.DEDUP_CONTENT_THRESHOLD) {
                    const canonical = nodeScore(a) >= nodeScore(b) ? a : b;
                    const dup = canonical === a ? b : a;
                    mergePairs.push([canonical, dup]);
                }
            }
        }

        // ── Executar merges ─────────────────────────────────────────────
        for (const [canonical, dup] of mergePairs) {
            if (superseded.has(dup.id) || superseded.has(canonical.id)) continue;

            result.pairsFound++;
            result.edgesRetargeted += this.retargetEdges(db, dup.id, canonical.id);

            const metaRaw = db.prepare('SELECT metadata FROM memory_nodes WHERE id = ?')
                .get(dup.id) as { metadata: string | null } | undefined;
            const meta = JSON.parse(metaRaw?.metadata ?? '{}') as Record<string, string>;
            meta['superseded_by'] = canonical.id;
            meta['superseded_at'] = new Date().toISOString();

            db.prepare(`UPDATE memory_nodes SET lifecycle_state = 'SUPERSEDED', metadata = ? WHERE id = ?`)
                .run(JSON.stringify(meta), dup.id);

            superseded.add(dup.id);
            log.info('node_superseded', 'dedup', { nodeId: dup.id, canonical_id: canonical.id });
            result.nodesSuperseded++;

            log.info(`[Dedup] ${dup.id} → SUPERSEDED (canônico: ${canonical.id})`);
        }

        return result;
    }

    /**
     * Redireciona todas as arestas de `fromId` para `toId` (merge não-destrutivo).
     * Conflitos de PK são resolvidos deletando a aresta redundante.
     * Retorna o número de arestas efetivamente redirecionadas.
     */
    private retargetEdges(
        db: ReturnType<typeof this.mm.getDatabase>,
        fromId: string,
        toId: string
    ): number {
        let count = 0;

        const outEdges = db.prepare(
            'SELECT to_node, relation FROM memory_edges WHERE from_node = ?'
        ).all(fromId) as Array<{ to_node: string; relation: string }>;

        const inEdges = db.prepare(
            'SELECT from_node, relation FROM memory_edges WHERE to_node = ?'
        ).all(fromId) as Array<{ from_node: string; relation: string }>;

        const hasEdge = db.prepare(
            'SELECT 1 FROM memory_edges WHERE from_node = ? AND to_node = ? AND relation = ?'
        );
        const deleteEdge = db.prepare(
            'DELETE FROM memory_edges WHERE from_node = ? AND to_node = ? AND relation = ?'
        );
        const updateFrom = db.prepare(
            'UPDATE memory_edges SET from_node = ? WHERE from_node = ? AND to_node = ? AND relation = ?'
        );
        const updateTo = db.prepare(
            'UPDATE memory_edges SET to_node = ? WHERE from_node = ? AND to_node = ? AND relation = ?'
        );

        const tx = db.transaction(() => {
            for (const e of outEdges) {
                if (e.to_node === toId) {
                    deleteEdge.run(fromId, e.to_node, e.relation);
                    continue;
                }
                if (hasEdge.get(toId, e.to_node, e.relation)) {
                    deleteEdge.run(fromId, e.to_node, e.relation);
                } else {
                    updateFrom.run(toId, fromId, e.to_node, e.relation);
                    count++;
                }
            }

            for (const e of inEdges) {
                if (e.from_node === toId) {
                    deleteEdge.run(e.from_node, fromId, e.relation);
                    continue;
                }
                if (hasEdge.get(e.from_node, toId, e.relation)) {
                    deleteEdge.run(e.from_node, fromId, e.relation);
                } else {
                    updateTo.run(toId, e.from_node, fromId, e.relation);
                    count++;
                }
            }
        });
        tx();

        return count;
    }

    // ── Semantic Consolidation (non-destructive) ─────────────────────────────
    //
    // Philosophy: "lossy semantic compression with structural reversibility"
    //   - Original nodes are PRESERVED, only marked lifecycle_state = SUMMARIZED
    //   - Summary node tracks full lineage via `summarizes` edges
    //   - SUMMARIZED nodes are excluded from default retrieval but fully recoverable
    //   - Supports future: deep recall, replay cognitivo, explainability, re-summarization

    private readonly CONSOLIDATION_MIN_CONFIDENCE = 0.5;
    private readonly CONSOLIDATION_MAX_WEIGHT = 0.7;         // protect high-weight (important) nodes
    private readonly CONSOLIDATION_MIN_STALENESS_DAYS = 14;
    private readonly CONSOLIDATION_MIN_CLUSTER_SIZE = 3;
    private readonly CONSOLIDATION_SIMILARITY_THRESHOLD = 0.35;

    // Never consolidate: core identity, infra, main projects, preferences, governance
    private readonly CONSOLIDATION_PROTECTED_DOMAINS = new Set([
        'core_identity', 'user_modeling', 'governance_safety',
        'domain_infra', 'domain_projetos', 'domain_preferencias',
    ]);

    // Preferred targets: ephemeral, repetitive, operational data — looser threshold
    private readonly CONSOLIDATION_PRIORITY_DOMAINS = new Set([
        'domain_clima', 'domain_agenda',
    ]);

    /**
     * Non-destructive semantic compression.
     *
     * For each cluster of stale, low-confidence, similar nodes:
     *   1. Creates a summary node with rich lineage metadata
     *   2. Creates `summarizes` edges: summary → each original
     *   3. Sets lifecycle_state = SUMMARIZED on originals (data fully preserved)
     *
     * Safety guards:
     *   - confidence < 0.5  AND  weight < 0.7  AND  not accessed in 14+ days
     *   - never touches identity, domain, core_*, domain_*, user_identity*, protected domains
     *   - requires >= 3 similar nodes to justify consolidation
     */
    async consolidateStaleClusters(): Promise<ConsolidationResult> {
        const result: ConsolidationResult = { clustersFound: 0, nodesMarkedSummarized: 0, summariesCreated: 0 };
        const db = this.mm.getDatabase();
        const staleness = this.CONSOLIDATION_MIN_STALENESS_DAYS;

        const staleNodes = db.prepare(`
            SELECT id, name, content, type, domain, weight, confidence, last_accessed, updated_at
            FROM memory_nodes
            WHERE confidence < ?
              AND (weight IS NULL OR weight < ?)
              AND type NOT IN ('identity', 'domain', 'legacy_container')
              AND (lifecycle_state IS NULL OR lifecycle_state = 'ACTIVE')
              AND id NOT LIKE 'core_%'
              AND id NOT LIKE 'domain_%'
              AND id NOT LIKE 'user_identity%'
              AND (last_accessed IS NULL OR last_accessed < datetime('now', '-' || ? || ' days'))
              AND (updated_at IS NULL OR updated_at < datetime('now', '-' || ? || ' days'))
              AND domain IS NOT NULL AND domain != ''
              AND content IS NOT NULL AND content != ''
            ORDER BY domain, type
        `).all(
            this.CONSOLIDATION_MIN_CONFIDENCE,
            this.CONSOLIDATION_MAX_WEIGHT,
            staleness,
            staleness
        ) as NodeForConsolidation[];

        if (staleNodes.length < this.CONSOLIDATION_MIN_CLUSTER_SIZE) return result;

        // Group by (domain, type) — skip protected domains
        const groups = new Map<string, NodeForConsolidation[]>();
        for (const node of staleNodes) {
            if (this.CONSOLIDATION_PROTECTED_DOMAINS.has(node.domain)) continue;
            const key = `${node.domain}::${node.type}`;
            const group = groups.get(key) ?? [];
            group.push(node);
            groups.set(key, group);
        }

        for (const [key, nodes] of groups) {
            if (nodes.length < this.CONSOLIDATION_MIN_CLUSTER_SIZE) continue;

            const [domainId, type] = key.split('::');

            // Priority domains get looser threshold → more aggressive compression
            const threshold = this.CONSOLIDATION_PRIORITY_DOMAINS.has(domainId)
                ? this.CONSOLIDATION_SIMILARITY_THRESHOLD * 0.8
                : this.CONSOLIDATION_SIMILARITY_THRESHOLD;

            const clusters = this.findSimilarityClusters(nodes, threshold);

            for (const cluster of clusters) {
                if (cluster.length < this.CONSOLIDATION_MIN_CLUSTER_SIZE) continue;

                result.clustersFound++;

                // 1. Create summary node with lineage metadata
                const summaryNode = this.buildSummaryNode(cluster, domainId, type);
                try {
                    this.mm.addNode(summaryNode, 'consolidation');
                    this.mm.getFacade().setNodeDomain(summaryNode.id, domainId);
                    this.addEdgeSafe(domainId, summaryNode.id, 'contains');
                    result.summariesCreated++;
                } catch (e) {
                    log.warn(`[Consolidation] Failed to create summary node: ${errorMessage(e)}`);
                    continue;
                }

                // 2. Explicit lineage: summary --summarizes--> each original
                for (const node of cluster) {
                    this.addEdgeSafe(summaryNode.id, node.id, 'summarizes');
                }

                // 3. Mark originals as SUMMARIZED — data preserved, excluded from default retrieval
                for (const node of cluster) {
                    try {
                        const metaRaw = db.prepare(
                            'SELECT metadata FROM memory_nodes WHERE id = ?'
                        ).get(node.id) as { metadata: string | null } | undefined;

                        const meta: Record<string, string> = JSON.parse(metaRaw?.metadata ?? '{}');
                        meta['summarized_into'] = summaryNode.id;
                        meta['summarized_at'] = new Date().toISOString();

                        db.prepare(`
                            UPDATE memory_nodes SET lifecycle_state = 'SUMMARIZED', metadata = ? WHERE id = ?
                        `).run(JSON.stringify(meta), node.id);

                        log.info('node_summarized', 'consolidation', { nodeId: node.id, summarized_into: summaryNode.id, domain: domainId });
                        result.nodesMarkedSummarized++;
                    } catch (e) {
                        log.warn(`[Consolidation] Failed to mark node ${node.id}: ${errorMessage(e)}`);
                    }
                }

                log.info(`[Consolidation] ${cluster.length} nodes → ${summaryNode.id} [${domainId}/${type}]`);
            }
        }

        return result;
    }

    /**
     * Union-find clustering with path compression.
     * Groups nodes where pairwise Jaccard similarity >= threshold.
     */
    private findSimilarityClusters(
        nodes: NodeForConsolidation[],
        threshold: number = this.CONSOLIDATION_SIMILARITY_THRESHOLD
    ): NodeForConsolidation[][] {
        const parent = new Map<string, string>(nodes.map(n => [n.id, n.id]));

        const find = (id: string): string => {
            if (parent.get(id) !== id) parent.set(id, find(parent.get(id)!));
            return parent.get(id)!;
        };

        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                if (this.jaccardSimilarity(nodes[i].content, nodes[j].content) >= threshold) {
                    parent.set(find(nodes[i].id), find(nodes[j].id));
                }
            }
        }

        const clusterMap = new Map<string, NodeForConsolidation[]>();
        for (const node of nodes) {
            const root = find(node.id);
            const cluster = clusterMap.get(root) ?? [];
            cluster.push(node);
            clusterMap.set(root, cluster);
        }

        return Array.from(clusterMap.values());
    }

    private buildSummaryNode(
        nodes: NodeForConsolidation[],
        domainId: string,
        type: string
    ): { id: string; type: 'fact' | 'preference' | 'skill' | 'knowledge'; name: string; content: string; confidence: number; weight: number; metadata: Record<string, string>; last_updated: string } {
        const sorted = [...nodes].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
        const domainName = getDomainById(domainId)?.name ?? domainId.replace('domain_', '').toUpperCase();

        const topContent = sorted
            .slice(0, 3)
            .map(n => (n.content || n.name || '').trim().slice(0, 120))
            .filter(Boolean)
            .join('. ');

        const avgConfidence = nodes.reduce((s, n) => s + (n.confidence ?? 0.3), 0) / nodes.length;
        const maxWeight = Math.max(...nodes.map(n => n.weight ?? 0.3));
        const semanticCoherence = this.computeSemanticCoherence(nodes);

        return {
            id: `summary_${domainId}_${type}_${Date.now()}`,
            type: (['preference', 'skill', 'knowledge'].includes(type) ? type : 'fact') as 'fact' | 'preference' | 'skill' | 'knowledge',
            name: `[Summary] ${domainName} — ${nodes.length} nós (${type})`,
            content: topContent || `Resumo semântico de ${nodes.length} registros de ${domainName}`,
            confidence: Math.round(avgConfidence * 100) / 100,
            weight: Math.round(maxWeight * 100) / 100,
            metadata: {
                summary_type: 'semantic_compression',
                source_count: String(nodes.length),
                compression_confidence: String(Math.round(avgConfidence * 100) / 100),
                semantic_coherence: String(semanticCoherence),
                generated_at: new Date().toISOString(),
                source_domain: domainId,
                source_type: type,
                source_ids: nodes.slice(0, 8).map(n => n.id).join(','),
            },
            last_updated: new Date().toISOString(),
        };
    }

    /** Average pairwise Jaccard similarity across all cluster members. */
    private computeSemanticCoherence(nodes: NodeForConsolidation[]): number {
        if (nodes.length < 2) return 1.0;
        let total = 0;
        let pairs = 0;
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                total += this.jaccardSimilarity(nodes[i].content, nodes[j].content);
                pairs++;
            }
        }
        return pairs > 0 ? Math.round((total / pairs) * 100) / 100 : 1.0;
    }

    private jaccardSimilarity(a: string, b: string): number {
        const wordsA = new Set((a ?? '').toLowerCase().split(/\s+/).filter(w => w.length > 3));
        const wordsB = new Set((b ?? '').toLowerCase().split(/\s+/).filter(w => w.length > 3));
        if (wordsA.size === 0 || wordsB.size === 0) return 0;
        const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
        const union = new Set([...wordsA, ...wordsB]).size;
        return union === 0 ? 0 : intersection / union;
    }

    startAutoCurate(intervalMs: number = 30 * 60 * 1000): void {
        if (this.intervalId) return;
        this.intervalId = setInterval(async () => {
            try {
                const result = await this.curate();
                await this.enforceStorageQuotas();
                await this.analytics.updateMetrics();
                await this.analytics.detectCommunities();

                if (Math.random() < 0.1) {
                    log.info('[MemoryCurator] Running VACUUM to reclaim disk space...');
                    this.repo.vacuum();
                }

                // Embed missing nodes (if embedding service available)
                if (this.embeddingService) {
                    const available = await this.embeddingService.isAvailable();
                    if (available) {
                        const embedded = await this.embeddingService.embedMissing(10);
                        if (embedded > 0) log.info(`[MemoryCurator] Embedded ${embedded} new nodes`);
                    }
                }

                // Sparse graph: prune weak edges after decay so limiar já reflecte o peso pós-decaimento
                try {
                    await this.pruneWeakEdges();
                } catch (e) {
                    log.warn('[MemoryCurator] pruneWeakEdges failed:', errorMessage(e));
                }

                // Dedup: mesclar nós ativos near-duplicados antes da consolidação semântica
                try {
                    const dedup = await this.deduplicateNodes();
                    if (dedup.nodesSuperseded > 0) {
                        log.info(`[Dedup] ${dedup.pairsFound} pares, ${dedup.nodesSuperseded} SUPERSEDED, ${dedup.edgesRetargeted} arestas redirecionadas`);
                    }
                } catch (e) {
                    log.warn('[MemoryCurator] deduplicateNodes failed:', errorMessage(e));
                }

                // Non-destructive semantic consolidation
                try {
                    const consolidation = await this.consolidateStaleClusters();
                    if (consolidation.summariesCreated > 0) {
                        log.info(`[Consolidation] ${consolidation.summariesCreated} summaries, ${consolidation.nodesMarkedSummarized} nodes marked SUMMARIZED`);
                    }
                } catch (e) {
                    log.warn('[MemoryCurator] Consolidation failed:', errorMessage(e));
                }

                // Knowledge Distillation: cristaliza padrões episódicos em nós permanentes (throttled)
                try {
                    const distill = await this.distillKnowledge();
                    if (!distill.skipped && (distill.nodesPromoted > 0 || distill.interestsExtracted > 0)) {
                        log.info(`[Distillation] ${distill.nodesPromoted} promovidos | ${distill.interestsExtracted} interesses | ${distill.episodesArchived} arquivados`);
                    }
                } catch (e) {
                    log.warn('[MemoryCurator] distillKnowledge failed:', errorMessage(e));
                }

                // Refresh domain summaries after curation
                try {
                    const refreshed = this.domainSummaryService.refreshAll();
                    if (refreshed > 0) log.info(`[MemoryCurator] Domain summaries refreshed: ${refreshed} domains`);
                } catch (e) {
                    log.warn('[MemoryCurator] Domain summary refresh failed:', errorMessage(e));
                }

                if (result.orphansFixed > 0) {
                    log.info(`[MemoryCurator] Auto-curated: ${result.details.join('; ')}`);
                }
            } catch (err) {
                log.error('[MemoryCurator] Auto-curation error:', err);
            }
        }, intervalMs);

        // Initial run (with 2s delay to let DB stabilize after startup)
        setTimeout(async () => {
            try {
                const r = await this.curate();
                await this.analytics.updateMetrics();
                this.domainSummaryService.refreshAll();
                if (r.orphansFixed > 0) log.info(`[MemoryCurator] Initial: ${r.details.join('; ')}`);
                else log.info('[MemoryCurator] Initial: graph clean, metrics updated.');
            } catch (e) {
                log.error('[MemoryCurator] Initial error:', e);
            }
        }, 2000);
    }

    stopAutoCurate(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }
}
