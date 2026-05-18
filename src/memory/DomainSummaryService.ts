/**
 * DomainSummaryService — Resumos por domínio cognitivo
 *
 * Mantém uma tabela `domain_summaries` com resumo compacto de cada domínio.
 * Gerado sem LLM: agrega os nós de maior peso+confiança do domínio.
 *
 * Fluxo:
 *   MemoryCurator.startAutoCurate() → refreshAll() a cada ciclo
 *   ContextBuilder.buildContext()   → buildPromptBlock() injetado antes dos detalhes
 *
 * Benefício: o LLM recebe o resumo do domínio em ~100 tokens antes dos nós
 * detalhados, economizando contexto e melhorando coerência temática.
 */

import type Database from 'better-sqlite3';
import { getDomainById } from './DomainRegistry';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('DomainSummaryService');

// ── Types ───────────────────────────────────────────────────────────────

export interface DomainSummary {
    domainId: string;
    summary: string;
    recentTopics: string[];
    highPriorityEntities: string[];
    nodeCount: number;
    lastUpdated: string;
}

interface DomainSummaryRow {
    domain_id: string;
    summary: string;
    recent_topics: string;
    high_priority_entities: string;
    node_count: number;
    last_updated: string;
}

interface NodeRow {
    id: string;
    name: string;
    content: string;
    weight: number | null;
    confidence: number | null;
    last_accessed: string | null;
    updated_at: string | null;
}

// ── DomainSummaryService ────────────────────────────────────────────────

export class DomainSummaryService {
    private db: Database.Database;

    constructor(db: Database.Database) {
        this.db = db;
        this.initSchema();
    }

    private initSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS domain_summaries (
                domain_id TEXT PRIMARY KEY,
                summary TEXT NOT NULL DEFAULT '',
                recent_topics TEXT NOT NULL DEFAULT '[]',
                high_priority_entities TEXT NOT NULL DEFAULT '[]',
                node_count INTEGER NOT NULL DEFAULT 0,
                last_updated TEXT NOT NULL DEFAULT (datetime('now'))
            )
        `);
    }

    // ── Refresh ─────────────────────────────────────────────────────────

    /**
     * Regenera o resumo de um único domínio a partir dos seus nós atuais.
     * Chamado pelo MemoryCurator ou manualmente via memory_admin.
     */
    refreshDomain(domainId: string): void {
        const nodes = this.db.prepare(`
            SELECT id, name, content, weight, confidence, last_accessed, updated_at
            FROM memory_nodes
            WHERE domain = ?
              AND type NOT IN ('legacy_container')
              AND content IS NOT NULL AND content != ''
            ORDER BY (COALESCE(weight, 0.5) * COALESCE(confidence, 0.5)) DESC
        `).all(domainId) as NodeRow[];

        if (nodes.length === 0) return;

        const nodeCount = nodes.length;

        // Top-5 por weight*confidence → summary compacto (~150 chars por nó)
        const topNodes = nodes.slice(0, 5);
        const summaryParts = topNodes.map(n => {
            const text = (n.content || n.name || '').trim();
            return text.length > 150 ? text.slice(0, 147) + '...' : text;
        });
        const summary = summaryParts.join('. ');

        // Entidades de alta prioridade = top-3 por peso
        const highPriority = nodes
            .slice(0, 3)
            .map(n => n.name)
            .filter((name): name is string => !!name);

        // Tópicos recentes = últimos 3 acessados
        const recentTopics = [...nodes]
            .filter(n => n.last_accessed || n.updated_at)
            .sort((a, b) => {
                const ta = new Date(a.last_accessed ?? a.updated_at ?? '').getTime();
                const tb = new Date(b.last_accessed ?? b.updated_at ?? '').getTime();
                return tb - ta;
            })
            .slice(0, 3)
            .map(n => n.name)
            .filter((name): name is string => !!name);

        this.db.prepare(`
            INSERT INTO domain_summaries
                (domain_id, summary, recent_topics, high_priority_entities, node_count, last_updated)
            VALUES (?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(domain_id) DO UPDATE SET
                summary = excluded.summary,
                recent_topics = excluded.recent_topics,
                high_priority_entities = excluded.high_priority_entities,
                node_count = excluded.node_count,
                last_updated = excluded.last_updated
        `).run(
            domainId,
            summary,
            JSON.stringify(recentTopics),
            JSON.stringify(highPriority),
            nodeCount
        );
    }

    /**
     * Regenera resumos de todos os domínios que têm nós.
     * Retorna o número de domínios processados.
     */
    refreshAll(): number {
        const domains = this.db.prepare(`
            SELECT DISTINCT domain FROM memory_nodes
            WHERE domain IS NOT NULL AND domain != ''
              AND type NOT IN ('legacy_container')
        `).all() as Array<{ domain: string }>;

        let count = 0;
        for (const { domain } of domains) {
            try {
                this.refreshDomain(domain);
                count++;
            } catch (e) {
                log.warn(`refreshDomain failed for ${domain}: ${String(e)}`);
            }
        }

        if (count > 0) log.info(`Domain summaries refreshed: ${count} domains`);
        return count;
    }

    // ── Read ─────────────────────────────────────────────────────────────

    getSummary(domainId: string): DomainSummary | null {
        const row = this.db.prepare(
            'SELECT * FROM domain_summaries WHERE domain_id = ?'
        ).get(domainId) as DomainSummaryRow | undefined;

        if (!row) return null;
        return {
            domainId: row.domain_id,
            summary: row.summary,
            recentTopics: this.parseJsonArray(row.recent_topics),
            highPriorityEntities: this.parseJsonArray(row.high_priority_entities),
            nodeCount: row.node_count,
            lastUpdated: row.last_updated,
        };
    }

    getAllSummaries(): DomainSummary[] {
        const rows = this.db.prepare(
            'SELECT * FROM domain_summaries ORDER BY node_count DESC'
        ).all() as DomainSummaryRow[];

        return rows.map(row => ({
            domainId: row.domain_id,
            summary: row.summary,
            recentTopics: this.parseJsonArray(row.recent_topics),
            highPriorityEntities: this.parseJsonArray(row.high_priority_entities),
            nodeCount: row.node_count,
            lastUpdated: row.last_updated,
        }));
    }

    // ── Prompt Block ──────────────────────────────────────────────────────

    /**
     * Formata o resumo de um domínio para injeção no prompt do LLM.
     * Retorna string vazia se não houver resumo.
     *
     * Formato:
     *   [DOMÍNIO: CRIPTO | 12 nós]
     *   Bitcoin está em alta, portfólio consolidado...
     *   Recente: BTC Holdings, ETH Trade
     *   Principais: Portfólio, Bitcoin, Exchange
     */
    buildPromptBlock(domainId: string): string {
        const data = this.getSummary(domainId);
        if (!data || !data.summary) return '';

        const domainDef = getDomainById(domainId);
        const name = domainDef?.name ?? domainId.replace('domain_', '').toUpperCase();

        const lines: string[] = [
            `[DOMÍNIO: ${name} | ${data.nodeCount} nós]`,
            data.summary,
        ];

        if (data.recentTopics.length > 0) {
            lines.push(`Recente: ${data.recentTopics.join(', ')}`);
        }
        if (data.highPriorityEntities.length > 0) {
            lines.push(`Principais: ${data.highPriorityEntities.join(', ')}`);
        }

        return lines.join('\n');
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    private parseJsonArray(raw: string | null): string[] {
        try {
            const parsed = JSON.parse(raw ?? '[]');
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }
}
