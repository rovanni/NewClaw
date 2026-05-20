/**
 * TemporalLayer — Índice temporal hierárquico no grafo cognitivo
 *
 * Cria nós de ano (`time_YYYY`) e os conecta com `next`, formando uma
 * linha do tempo navegável. Cada nó de memória novo é anotado com
 * `occurred_in → time_YYYY`, permitindo queries temporais:
 *   "o que aprendi em 2025?" → expande time_2025 via occurred_in
 *
 * Estrutura:
 *   time_2024 --next--> time_2025 --next--> time_2026
 *   node_A    --occurred_in--> time_2025
 *   node_B    --occurred_in--> time_2025
 */

import Database from 'better-sqlite3';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('TemporalLayer');

export class TemporalLayer {
    constructor(private db: Database.Database) {}

    // ── Year nodes ─────────────────────────────────────────────────────────

    /**
     * Ensures a year node exists in the graph.
     * If the previous year node exists, links prev --next--> current.
     * Idempotent — safe to call on every boot.
     */
    ensureYearNode(year: number): string {
        const id = `time_${year}`;
        const exists = this.db.prepare('SELECT 1 FROM memory_nodes WHERE id = ?').get(id);
        if (!exists) {
            this.db.prepare(`
                INSERT OR IGNORE INTO memory_nodes
                    (id, type, name, content, weight, confidence, identity_scope)
                VALUES (?, 'context', ?, ?, 0.5, 1.0, 'SYSTEM_MEMORY')
            `).run(id, String(year), `Período temporal: ano ${year}`);

            const prevId = `time_${year - 1}`;
            const prevExists = this.db.prepare('SELECT 1 FROM memory_nodes WHERE id = ?').get(prevId);
            if (prevExists) {
                this.db.prepare(`
                    INSERT OR IGNORE INTO memory_edges (from_node, to_node, relation, weight, confidence)
                    VALUES (?, ?, 'next', 1.0, 1.0)
                `).run(prevId, id);
            }
        }
        return id;
    }

    // ── Node annotation ────────────────────────────────────────────────────

    /**
     * Creates a `node --occurred_in--> time_YYYY` edge.
     * The node must already exist in memory_nodes (FK constraint).
     */
    attachNode(nodeId: string, date: Date = new Date()): void {
        const yearNodeId = this.ensureYearNode(date.getFullYear());
        try {
            this.db.prepare(`
                INSERT OR IGNORE INTO memory_edges (from_node, to_node, relation, weight, confidence)
                VALUES (?, ?, 'occurred_in', 0.7, 1.0)
            `).run(nodeId, yearNodeId);
        } catch (e) {
            log.warn(`attachNode(${nodeId}) failed: ${String(e)}`);
        }
    }

    // ── Query parsing ──────────────────────────────────────────────────────

    /**
     * Extracts a year reference from a natural-language query.
     * Supports explicit 4-digit years and relative expressions (PT-BR + EN).
     * Returns null if no temporal reference is detected.
     */
    extractYear(query: string): number | null {
        const match = query.match(/\b(20\d{2})\b/);
        if (match) return parseInt(match[1]);

        const thisYear = new Date().getFullYear();
        if (/\b(este ano|this year|ano atual|ano corrente)\b/i.test(query)) return thisYear;
        if (/\b(ano passado|last year)\b/i.test(query)) return thisYear - 1;

        return null;
    }

    // ── Retrieval ──────────────────────────────────────────────────────────

    /**
     * Returns node IDs that occurred in a given year, most recent first.
     * Only returns ACTIVE nodes.
     */
    getNodesForYear(year: number, limit: number = 20): string[] {
        const yearNodeId = `time_${year}`;
        const yearExists = this.db.prepare('SELECT 1 FROM memory_nodes WHERE id = ?').get(yearNodeId);
        if (!yearExists) return [];

        const rows = this.db.prepare(`
            SELECT e.from_node
            FROM memory_edges e
            JOIN memory_nodes n ON n.id = e.from_node
            WHERE e.to_node = ?
              AND e.relation = 'occurred_in'
              AND (n.lifecycle_state IS NULL OR n.lifecycle_state = 'ACTIVE')
            ORDER BY e.rowid DESC
            LIMIT ?
        `).all(yearNodeId, limit) as Array<{ from_node: string }>;

        return rows.map(r => r.from_node);
    }
}
