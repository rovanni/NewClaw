import { MemoryManager } from './MemoryManager';
import { GraphAnalytics } from './GraphAnalytics';
import { EmbeddingService } from './EmbeddingService';

interface CuratorResult {
    orphansFixed: number;
    hubsCreated: number;
    edgesCreated: string[];
    details: string[];
}

export class MemoryCurator {
    private mm: MemoryManager;
    private analytics: GraphAnalytics;
    private embeddingService?: EmbeddingService;
    private intervalId: ReturnType<typeof setInterval> | null = null;

    constructor(memoryManager: MemoryManager, embeddingService?: EmbeddingService) {
        this.mm = memoryManager;
        this.analytics = new GraphAnalytics(memoryManager);
        this.embeddingService = embeddingService;
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
        const db = (this.mm as any).db;

        const nodes: Array<{ id: string; type: string; name: string }> = db.prepare('SELECT id, type, name FROM memory_nodes').all();
        const edges: Array<{ from_node: string; to_node: string; relation: string }> = db.prepare('SELECT from_node, to_node, relation FROM memory_edges').all();

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
            // Clean any existing self-loops silently
            db.prepare('DELETE FROM memory_edges WHERE from_node = to_node').run();
            // Clean duplicate daily assignments that were mistakenly put in SYSTEM_HUB
            db.prepare("DELETE FROM memory_edges WHERE from_node = 'ctx_system_memory' AND to_node GLOB 'memory_[0-9][0-9][0-9][0-9]-*'").run();
            
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

        // ── Temporal Decay ──
        await this.applyTemporalDecay();

        return result;
    }

    /**
     * Apply temporal decay to edge weights
     * Edges not accessed in 30 days lose 2% weight (×0.98)
     */
    private async applyTemporalDecay(): Promise<{ decayed: number }> {
        try {
            const db = (this.mm as any).db;

            // Add last_accessed column if not exists
            try { db.exec('ALTER TABLE memory_edges ADD COLUMN last_accessed TEXT'); } catch { /* exists */ }

            // Update last_accessed for recently accessed edges (weight was incremented)
            db.prepare(`
                UPDATE memory_edges SET last_accessed = CURRENT_TIMESTAMP
                WHERE last_accessed IS NULL
            `).run();

            // Apply decay to edges not accessed in 30 days
            const result = db.prepare(`
                UPDATE memory_edges
                SET weight = MAX(weight * 0.98, 0.1)
                WHERE last_accessed < datetime('now', '-30 days')
                  AND weight > 0.1
            `).run();

            if (result.changes > 0) {
                console.log(`[TemporalDecay] ${result.changes} edges decayed (×0.98)`);
            }

            return { decayed: result.changes };
        } catch (error: any) {
            console.error('[TemporalDecay] Error:', error.message);
            return { decayed: 0 };
        }
    }

    startAutoCurate(intervalMs: number = 30 * 60 * 1000): void {
        if (this.intervalId) return;
        this.intervalId = setInterval(async () => {
            try {
                const result = await this.curate();
                await this.analytics.updateMetrics();
                await this.analytics.detectCommunities();

                // Record metrics snapshot for evolution tracking
                try {
                    (this.mm as any).recordMetricsSnapshot?.();
                } catch { /* optional */ }
                await this.analytics.detectCommunities();
                
                // Embed missing nodes (if embedding service available)
                if (this.embeddingService) {
                    const available = await this.embeddingService.isAvailable();
                    if (available) {
                        const embedded = await this.embeddingService.embedMissing(10);
                        if (embedded > 0) console.log(`[MemoryCurator] Embedded ${embedded} new nodes`);
                    }
                }
                
                if (result.orphansFixed > 0) {
                    console.log(`[MemoryCurator] Auto-curated: ${result.details.join('; ')}`);
                }
            } catch (err) {
                console.error('[MemoryCurator] Auto-curation error:', err);
            }
        }, intervalMs);
        
        // Initial run
        this.curate().then(async r => {
            await this.analytics.updateMetrics();
            if (r.orphansFixed > 0) console.log(`[MemoryCurator] Initial: ${r.details.join('; ')}`);
            else console.log('[MemoryCurator] Initial: graph clean, metrics updated.');
        }).catch(e => console.error('[MemoryCurator] Initial error:', e));
    }

    stopAutoCurate(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }
}