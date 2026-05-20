/**
 * MemoryManager — Facade de persistência do NewClaw
 *
 * Delega para módulos especializados:
 *   memorySchema.ts        — schema SQLite + migrations
 *   conversationRepository — CRUD de conversas e mensagens
 *   graphRepository        — nós, arestas, ontologia, bootstrap
 *   snapshotRepository     — snapshots e métricas históricas
 *   semanticSearch (inline) — embeddings e busca semântica
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { createLogger } from '../shared/AppLogger';
import { errorMessage } from '../shared/errors';
import { AttentionLayer } from './AttentionLayer';
import { AttentionFeedback } from './AttentionFeedback';
import { MemoryFacade, SqliteMemoryFacade } from './MemoryFacade';
import { ConfidenceClassifier } from '../core/ConfidenceClassifier';

import { initializeSchema } from './memorySchema';
import * as conv from './conversationRepository';
import * as graph from './graphRepository';
import * as snap from './snapshotRepository';
import { DashboardMemoryRepository } from '../dashboard/DashboardMemoryRepository';
import { MemoryGraphRepository } from './MemoryGraphRepository';
import { EmbeddingService } from './EmbeddingService';
import { ClassificationMemory } from './ClassificationMemory';
import { DecisionMemory } from './DecisionMemory';
import { DomainSummaryService } from './DomainSummaryService';
import { EpisodicMemoryService } from './EpisodicMemoryService';
import { CognitiveReflectionEngine } from './CognitiveReflectionEngine';
import { MemoryEventLog } from './MemoryEventLog';

export type { Message, Conversation, MemoryNode, MemoryEdge } from './memoryTypes';

const log = createLogger('Memorymanager');

export class MemoryManager {
    private db: Database.Database;
    private attentionLayer: AttentionLayer | null = null;
    private attentionFeedback: AttentionFeedback | null = null;
    private facade: MemoryFacade | null = null;
    private dashboardRepo: DashboardMemoryRepository | null = null;
    private graphRepo: MemoryGraphRepository | null = null;
    private embeddingServiceInstance: EmbeddingService | null = null;
    private classificationMemoryInstance: ClassificationMemory | null = null;
    private decisionMemoryInstance: DecisionMemory | null = null;
    private domainSummaryServiceInstance: DomainSummaryService | null = null;
    private episodicMemoryServiceInstance: EpisodicMemoryService | null = null;
    private cognitiveReflectionEngineInstance: CognitiveReflectionEngine | null = null;
    private eventLogInstance: MemoryEventLog | null = null;
    private classifier: ConfidenceClassifier;
    private inverseRelations: Record<string, string> = {};

    // Re-export ontology so external code (e.g. dashboard) can still access them
    static readonly NODE_TYPES = graph.NODE_TYPES;
    static readonly RELATION_ONTOLOGY = graph.RELATION_ONTOLOGY;

    /**
     * @internal — uso restrito a src/memory/ e testes.
     * Componentes externos devem usar getFacade() ou getGraphRepository().
     */
    getDatabase(): Database.Database { return this.db; }

    getFacade(): MemoryFacade {
        if (!this.facade) this.facade = new SqliteMemoryFacade(this.db, this);
        return this.facade;
    }

    getDashboardRepository(): DashboardMemoryRepository {
        if (!this.dashboardRepo) this.dashboardRepo = new DashboardMemoryRepository(this.db);
        return this.dashboardRepo;
    }

    getGraphRepository(): MemoryGraphRepository {
        if (!this.graphRepo) this.graphRepo = new MemoryGraphRepository(this.db);
        return this.graphRepo;
    }

    getEmbeddingService(): EmbeddingService {
        if (!this.embeddingServiceInstance) this.embeddingServiceInstance = new EmbeddingService(this.db);
        return this.embeddingServiceInstance;
    }

    getClassificationMemory(): ClassificationMemory {
        if (!this.classificationMemoryInstance) this.classificationMemoryInstance = new ClassificationMemory(this.db);
        return this.classificationMemoryInstance;
    }

    getDecisionMemory(): DecisionMemory {
        if (!this.decisionMemoryInstance) this.decisionMemoryInstance = new DecisionMemory(this.db);
        return this.decisionMemoryInstance;
    }

    getDomainSummaryService(): DomainSummaryService {
        if (!this.domainSummaryServiceInstance) this.domainSummaryServiceInstance = new DomainSummaryService(this.db);
        return this.domainSummaryServiceInstance;
    }

    getEventLog(): MemoryEventLog {
        if (!this.eventLogInstance) this.eventLogInstance = new MemoryEventLog(this.db);
        return this.eventLogInstance;
    }

    getEpisodicMemoryService(): EpisodicMemoryService {
        if (!this.episodicMemoryServiceInstance)
            this.episodicMemoryServiceInstance = new EpisodicMemoryService(this.db, this.getEventLog());
        return this.episodicMemoryServiceInstance;
    }

    getCognitiveReflectionEngine(): CognitiveReflectionEngine {
        if (!this.cognitiveReflectionEngineInstance)
            this.cognitiveReflectionEngineInstance = new CognitiveReflectionEngine(this.db, this.getEventLog());
        return this.cognitiveReflectionEngineInstance;
    }

    constructor(dbOrPath: string | Database.Database = './data/newclaw.db') {
        if (typeof dbOrPath === 'string') {
            const dir = path.dirname(dbOrPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            this.db = new Database(dbOrPath);
            this.db.pragma('journal_mode = DELETE');
            this.db.pragma('synchronous = NORMAL');
            this.db.pragma('busy_timeout = 5000');
        } else {
            this.db = dbOrPath;
            this.db.pragma('busy_timeout = 5000');
        }
        this.classifier = new ConfidenceClassifier();
        try { this.attentionLayer = new AttentionLayer(this.db); } catch (e) { log.warn('init_failed', 'AttentionLayer init failed', { error: String(e) }); }
        try { this.attentionFeedback = new AttentionFeedback(this.db); } catch (e) { log.warn('init_failed', 'AttentionFeedback init failed', { error: String(e) }); }

        this.inverseRelations = initializeSchema(this.db);
        this.incrementBootCount();
        graph.bootstrapCoreGraph(this.db, this.classifier);
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────────

    private incrementBootCount(): void {
        const key = 'boot_count';
        const current = this.db.prepare('SELECT value FROM memory WHERE key = ?').get(key) as { value: string } | undefined;
        const newValue = (parseInt(current?.value || '0') + 1).toString();
        this.db.prepare('INSERT OR REPLACE INTO memory (key, value, category) VALUES (?, ?, ?)').run(key, newValue, 'system');
    }

    public incrementInteractionCount(): void {
        const key = 'interaction_count';
        const current = this.db.prepare('SELECT value FROM memory WHERE key = ?').get(key) as { value: string } | undefined;
        const newValue = (parseInt(current?.value || '0') + 1).toString();
        this.db.prepare('INSERT OR REPLACE INTO memory (key, value, category) VALUES (?, ?, ?)').run(key, newValue, 'system');
        this.db.prepare('INSERT OR REPLACE INTO memory (key, value, category) VALUES (?, ?, ?)').run('last_active', new Date().toISOString(), 'system');
        this.refreshHeartbeatNode();
    }

    private refreshHeartbeatNode(): void {
        const boot = this.getSetting('boot_count') || '0';
        const interactions = this.getSetting('interaction_count') || '0';
        const last = this.getSetting('last_active') || 'Never';
        this.addNode({
            id: 'core_heartbeat',
            type: 'fact',
            name: 'HEARTBEAT',
            content: `Estado do sistema: Boot #${boot}, Interações: ${interactions}, Última atividade: ${last}.`
        });
    }

    close(): void {
        this.attentionFeedback?.stopBackgroundJobs();
        this.db.close();
    }

    // ── Settings ───────────────────────────────────────────────────────────────

    getSetting(key: string): string | null {
        try {
            const row = this.db.prepare('SELECT value FROM memory WHERE key = ?').get(key) as { value: string } | undefined;
            return row?.value ?? null;
        } catch { return null; }
    }

    setSetting(key: string, value: string, category: string = 'system'): void {
        this.db.prepare('INSERT OR REPLACE INTO memory (key, value, category) VALUES (?, ?, ?)').run(key, value, category);
    }

    // ── User Profile ───────────────────────────────────────────────────────────

    getUserProfile(userId: string): { name: string; language_preference: string; response_style: string; expertise: string } | null {
        try {
            return this.db.prepare(
                'SELECT name, language_preference, response_style, expertise FROM user_profile WHERE user_id = ?'
            ).get(userId) as { name: string; language_preference: string; response_style: string; expertise: string } | null;
        } catch { return null; }
    }

    setUserName(userId: string, name: string): void {
        this.db.prepare('UPDATE user_profile SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?').run(name, userId);
        this.addNode({ id: 'user_identity', type: 'identity', name, content: `Nome oficial: ${name}`, confidence: 1.0 });
        try {
            this.addEdge('core_user', 'user_identity', 'has_identity', 1.0, 1.0);
        } catch (e) {
            log.warn('bootstrap_edge_failed', errorMessage(e), { from: 'core_user', to: 'user_identity' });
        }
    }

    // ── Conversations ──────────────────────────────────────────────────────────

    getOrCreateConversation(userId: string): string {
        return conv.getOrCreateConversation(this.db, userId);
    }

    createNewConversation(userId: string): string {
        return conv.createNewConversation(this.db, userId);
    }

    addMessage(conversationId: string, role: 'user' | 'assistant' | 'system' | 'tool', content: string): void {
        conv.addMessage(this.db, conversationId, role, content);
        if (role === 'user') this.incrementInteractionCount();
    }

    getRecentMessages(conversationId: string, limit: number = 5) {
        return conv.getRecentMessages(this.db, conversationId, limit);
    }

    searchMessages(conversationId: string, query: string, limit: number = 6) {
        return conv.searchMessages(this.db, conversationId, query, limit);
    }

    // ── Graph: Nodes ───────────────────────────────────────────────────────────

    addNode(node: import('./memoryTypes').MemoryNode, source: string = 'unknown'): void {
        const isNew = !this.db.prepare('SELECT 1 FROM memory_nodes WHERE id = ?').get(node.id);
        graph.addNode(this.db, this.classifier, node, source);
        this.getEventLog().log(
            isNew ? 'node_added' : 'node_updated',
            node.id, 'node',
            { type: node.type, source },
            source
        );
    }

    getNode(id: string): import('./memoryTypes').MemoryNode | undefined {
        return graph.getNode(this.db, id);
    }

    getNodesByType(type: import('./memoryTypes').MemoryNode['type']): import('./memoryTypes').MemoryNode[] {
        return graph.getNodesByType(this.db, type);
    }

    searchNodes(query: string, limit: number = 10): import('./memoryTypes').MemoryNode[] {
        return graph.searchNodes(this.db, query, limit);
    }

    // ── Graph: Edges ───────────────────────────────────────────────────────────

    addEdge(from: string, to: string, relation: string, weight: number = 1.0, confidence: number = 1.0): void {
        graph.addEdge(this.db, from, to, relation, weight, confidence);
    }

    addEdgeWithInverse(from: string, to: string, relation: string, weight: number = 1.0, confidence: number = 1.0): string[] {
        return graph.addEdgeWithInverse(this.db, from, to, relation, weight, confidence, this.inverseRelations);
    }

    getInverseRelationMap(): Record<string, string> {
        return { ...this.inverseRelations };
    }

    getRelatedNodes(nodeId: string, relation?: string): import('./memoryTypes').MemoryNode[] {
        return graph.getRelatedNodes(this.db, nodeId, relation);
    }

    // ── Graph: High-level helpers ──────────────────────────────────────────────

    getIdentity(): import('./memoryTypes').MemoryNode | undefined { return graph.getNode(this.db, 'identity'); }
    setIdentity(name: string, content: string): void { this.addNode({ id: 'identity', type: 'identity', name, content }); }
    getPreferences(): import('./memoryTypes').MemoryNode[] { return graph.getNodesByType(this.db, 'preference'); }
    addPreference(name: string, content: string): void { this.addNode({ id: `pref_${name}`, type: 'preference', name, content }); }

    getContext(maxChars: number = 1500): string {
        const ctx = graph.getContext(this.db);
        return ctx.length > maxChars ? ctx.substring(0, maxChars) + '...[truncado]' : ctx;
    }

    // ── Keyword Search (no embeddings) ────────────────────────────────────────

    /**
     * Fast synchronous text search using SQL LIKE — no embedding generation.
     * All provided terms are OR-combined against the content column.
     * Excludes EXPIRED/SUMMARIZED/ARCHIVED nodes.
     */
    keywordSearch(terms: string[], limit = 5): import('./memoryTypes').MemoryNode[] {
        if (terms.length === 0) return [];
        try {
            const conditions = terms.map(() => 'content LIKE ?').join(' OR ');
            const params: unknown[] = [...terms.map(t => `%${t}%`), limit];
            return this.db.prepare(`
                SELECT * FROM memory_nodes
                WHERE lifecycle_state NOT IN ('EXPIRED', 'SUMMARIZED', 'ARCHIVED')
                AND (${conditions})
                ORDER BY confidence DESC, weight DESC
                LIMIT ?
            `).all(...params) as import('./memoryTypes').MemoryNode[];
        } catch {
            return [];
        }
    }

    // ── Semantic Search ────────────────────────────────────────────────────────

    async semanticSearch(query: string, limit: number = 5): Promise<Array<import('./memoryTypes').MemoryNode & { score: number }>> {
        const results: Array<import('./memoryTypes').MemoryNode & { score: number }> = [];
        const foundIds = new Set<string>();

        const queryEmbedding = await this.generateEmbedding(query);
        if (queryEmbedding) {
            const rows = this.db.prepare('SELECT node_id, embedding FROM memory_embeddings').all() as Array<{ node_id: string; embedding: Buffer }>;
            if (rows.length > 0) {
                const queryVec = new Float64Array(queryEmbedding);
                const scored = rows.map(row => ({
                    nodeId: row.node_id,
                    score: this.cosineSimilarity(queryVec, new Float64Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 8))
                })).sort((a, b) => b.score - a.score);

                for (const item of scored) {
                    if (item.score < 0.3 || results.length >= limit) break;
                    const node = this.getNode(item.nodeId);
                    if (node && node.lifecycle_state !== 'SUMMARIZED' && node.lifecycle_state !== 'EXPIRED') {
                        results.push({ ...node, score: item.score });
                        foundIds.add(item.nodeId);
                    }
                }
            }
        }

        if (results.length < limit) {
            for (const node of this.searchNodes(query, limit)) {
                if (!foundIds.has(node.id) && results.length < limit && node.lifecycle_state !== 'SUMMARIZED' && node.lifecycle_state !== 'EXPIRED') {
                    results.push({ ...node, score: 0.4 });
                    foundIds.add(node.id);
                }
            }
        }

        return results;
    }

    async semanticSearchWithAttention(
        query: string,
        limit: number = 5
    ): Promise<Array<import('./memoryTypes').MemoryNode & { score: number; attentionScore?: number }>> {
        const embeddingResults: Array<{ nodeId: string; score: number }> = [];
        const queryEmbedding = await this.generateEmbedding(query);

        if (queryEmbedding) {
            const rows = this.db.prepare('SELECT node_id, embedding FROM memory_embeddings').all() as Array<{ node_id: string; embedding: Buffer }>;
            if (rows.length > 0) {
                const queryVec = new Float64Array(queryEmbedding);
                for (const row of rows) {
                    const nodeVec = new Float64Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 8);
                    const similarity = this.cosineSimilarity(queryVec, nodeVec);
                    if (similarity >= 0.25) embeddingResults.push({ nodeId: row.node_id, score: similarity });
                }
            }
        }

        if (this.attentionLayer) {
            const attentionResults = this.attentionLayer.searchWithAttention(embeddingResults, limit);
            const results: Array<import('./memoryTypes').MemoryNode & { score: number; attentionScore: number }> = [];
            for (const ar of attentionResults) {
                const node = this.getNode(ar.nodeId);
                if (node) results.push({ ...node, score: ar.attentionScore, attentionScore: ar.attentionScore });
            }
            this.attentionLayer.touchNodes(results.map(r => r.id));
            this.attentionFeedback?.recordCoUsage(results.map(r => r.id));
            return results;
        }

        return this.semanticSearch(query, limit);
    }

    getAttentionFeedback(): AttentionFeedback | null { return this.attentionFeedback; }
    getAttentionLayer(): AttentionLayer | null { return this.attentionLayer; }

    private async generateEmbedding(text: string): Promise<Float64Array | null> {
        try {
            const response = await fetch('http://localhost:11434/api/embeddings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'nomic-embed-text:latest', prompt: text })
            });
            if (!response.ok) return null;
            const data = await response.json() as { embedding?: number[] };
            if (!data.embedding) return null;
            return new Float64Array(data.embedding);
        } catch { return null; }
    }

    private cosineSimilarity(a: Float64Array, b: Float64Array): number {
        let dot = 0, normA = 0, normB = 0;
        const len = Math.min(a.length, b.length);
        for (let i = 0; i < len; i++) { dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i]; }
        const denom = Math.sqrt(normA) * Math.sqrt(normB);
        return denom === 0 ? 0 : dot / denom;
    }

    // ── Metrics & Snapshots ────────────────────────────────────────────────────

    recordMetricsSnapshot(): number { return snap.recordMetricsSnapshot(this.db); }
    createSnapshot(label?: string): string { return snap.createSnapshot(this.db, label); }
    listSnapshots(): Omit<import('./memoryTypes').SnapshotRow, 'snapshot_data'>[] { return snap.listSnapshots(this.db); }
    restoreSnapshot(id: string): boolean { return snap.restoreSnapshot(this.db, id); }
    deleteSnapshot(id: string): boolean { return snap.deleteSnapshot(this.db, id); }

    // ── Agent Trace ────────────────────────────────────────────────────────────

    public saveTrace(trace: {
        id: string;
        conversation_id?: string;
        correlation_id?: string;
        step: number;
        decision?: string;
        tool?: string;
        input?: string;
        output?: string;
        provider?: string;
        duration_ms?: number;
    }): void {
        try {
            this.db.prepare(`
                INSERT INTO agent_traces (id, conversation_id, correlation_id, step, decision, tool, input, output, provider, duration_ms)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                trace.id,
                trace.conversation_id || null,
                trace.correlation_id || null,
                trace.step,
                trace.decision || null,
                trace.tool || null,
                trace.input || null,
                trace.output || null,
                trace.provider || null,
                trace.duration_ms || null
            );
        } catch (e) {
            log.error('save_trace_failed', errorMessage(e));
        }
    }
}
