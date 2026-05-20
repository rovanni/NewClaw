/**
 * SpreadingActivation — Ativação distribuída no grafo cognitivo
 *
 * Baseado no modelo de Collins & Loftus (1975) adaptado para grafos:
 * quando um nó é acessado, sua ativação se propaga pelos vizinhos
 * com decaimento multiplicativo por hop e decaimento temporal (por hora).
 *
 * Exemplo com DECAY=0.5, HOURLY_DECAY=0.85:
 *   Acesso   → nó seed:    activation 1.0
 *   Hop 1    → vizinhos:   activation 0.5
 *   Hop 2    → v. de v.:   activation 0.25
 *   Após 8h  → ×0.27  (0.85^8)
 *   Após 24h → ×0.02  (effectively zero)
 *
 * O score de ativação é consultado em `AttentionLayer.calculateAttentionScore()`
 * e somado como 7ª dimensão ao score de atenção.
 *
 * Manutenção: `pruneStale()` remove ativações efetivamente zeradas.
 * Chamado com probabilidade 5% em `touchNodes()` para não acumular lixo.
 */

import Database from 'better-sqlite3';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('SpreadingActivation');

// ── Types ──────────────────────────────────────────────────────────────────

interface ActivationRow {
    node_id: string;
    activation: number;
    activated_at: string;
    source: string | null;
}

export interface ActivateOpts {
    /** Multiplicative decay per hop (default 0.5 → 1-hop=0.5, 2-hop=0.25) */
    decay?: number;
    /** Maximum hops to propagate (default 2) */
    maxHops?: number;
    /** Tag stored with the activation for observability */
    source?: string;
}

// ── SpreadingActivation ────────────────────────────────────────────────────

export class SpreadingActivation {
    // Activation decays by this factor each hour
    // 0.85^8 ≈ 0.27 (after 8h) · 0.85^24 ≈ 0.02 (after 24h, effectively zero)
    private readonly HOURLY_DECAY = 0.85;

    // Threshold below which an activation is considered stale and prunable
    private readonly STALE_THRESHOLD = 0.02;

    // Structural relations that carry no semantic activation signal
    private readonly SKIP_RELATIONS = new Set(['next', 'contains', 'has_domain', 'groups']);

    constructor(private db: Database.Database) {
        this.initSchema();
    }

    private initSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS node_activations (
                node_id      TEXT PRIMARY KEY,
                activation   REAL NOT NULL DEFAULT 0,
                activated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                source       TEXT
            )
        `);
        try {
            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_node_activations_at ON node_activations(activated_at)`);
        } catch { /* ignore */ }
    }

    // ── Write ──────────────────────────────────────────────────────────────

    /**
     * Activate seed nodes (strength 1.0) and propagate to neighbors with decay.
     *
     * Uses MAX-merge on conflict: if a node already has higher activation,
     * the incoming propagation doesn't reduce it.
     *
     * Structural relations (next, contains, has_domain, groups) are skipped
     * because they don't carry semantic activation signal.
     */
    activate(seedIds: string[], opts?: ActivateOpts): void {
        const decay    = opts?.decay    ?? 0.5;
        const maxHops  = opts?.maxHops  ?? 2;
        const source   = opts?.source   ?? 'touch';

        if (seedIds.length === 0) return;

        const skipRels = [...this.SKIP_RELATIONS].map(() => '?').join(',');
        const upsert = this.db.prepare(`
            INSERT INTO node_activations (node_id, activation, activated_at, source)
            VALUES (?, ?, datetime('now'), ?)
            ON CONFLICT(node_id) DO UPDATE SET
                activation   = MAX(excluded.activation, node_activations.activation),
                activated_at = datetime('now'),
                source       = excluded.source
        `);

        const tx = this.db.transaction(() => {
            // Activate seeds at full strength
            for (const id of seedIds) upsert.run(id, 1.0, source);

            // Propagate through hops
            let currentHop = [...seedIds];
            const activated = new Set(seedIds);

            for (let hop = 1; hop <= maxHops; hop++) {
                if (currentHop.length === 0) break;

                const strength = Math.pow(decay, hop);
                const ph = currentHop.map(() => '?').join(',');

                const neighbors = this.db.prepare(`
                    SELECT DISTINCT to_node AS id FROM memory_edges
                    WHERE from_node IN (${ph})
                      AND relation NOT IN (${skipRels})
                    UNION
                    SELECT DISTINCT from_node AS id FROM memory_edges
                    WHERE to_node IN (${ph})
                      AND relation NOT IN (${skipRels})
                `).all(...currentHop, ...[...this.SKIP_RELATIONS],
                       ...currentHop, ...[...this.SKIP_RELATIONS]) as Array<{ id: string }>;

                const nextHop: string[] = [];
                for (const { id } of neighbors) {
                    if (activated.has(id)) continue;
                    activated.add(id);
                    nextHop.push(id);
                    upsert.run(id, strength, `${source}:hop${hop}`);
                }

                currentHop = nextHop;
            }
        });

        try {
            tx();
        } catch (e) {
            log.warn(`activate() failed: ${String(e)}`);
        }
    }

    // ── Read ───────────────────────────────────────────────────────────────

    /**
     * Return the current effective activation for a node, applying time decay.
     * Returns 0 if the node has never been activated or activation is stale.
     */
    getActivation(nodeId: string): number {
        const row = this.db.prepare(
            'SELECT activation, activated_at FROM node_activations WHERE node_id = ?'
        ).get(nodeId) as Pick<ActivationRow, 'activation' | 'activated_at'> | undefined;

        if (!row) return 0;
        return this.applyTimeDecay(row.activation, row.activated_at);
    }

    /**
     * Return activation scores for a batch of node IDs.
     * More efficient than calling getActivation() individually.
     */
    getActivations(nodeIds: string[]): Map<string, number> {
        const result = new Map<string, number>();
        if (nodeIds.length === 0) return result;

        const ph = nodeIds.map(() => '?').join(',');
        const rows = this.db.prepare(
            `SELECT node_id, activation, activated_at FROM node_activations WHERE node_id IN (${ph})`
        ).all(...nodeIds) as ActivationRow[];

        for (const row of rows) {
            const effective = this.applyTimeDecay(row.activation, row.activated_at);
            if (effective > this.STALE_THRESHOLD) {
                result.set(row.node_id, effective);
            }
        }

        return result;
    }

    private applyTimeDecay(activation: number, activatedAt: string): number {
        const ageHours = (Date.now() - new Date(activatedAt).getTime()) / 3600000;
        const decayed = activation * Math.pow(this.HOURLY_DECAY, ageHours);
        return decayed < this.STALE_THRESHOLD ? 0 : decayed;
    }

    // ── Maintenance ────────────────────────────────────────────────────────

    /**
     * Remove activations that are effectively zero (below STALE_THRESHOLD).
     * Called probabilistically from touchNodes() to avoid accumulating stale rows.
     * Returns count of rows deleted.
     */
    pruneStale(): number {
        // max hours = log(threshold) / log(HOURLY_DECAY)
        // = log(0.02) / log(0.85) ≈ 24.6h
        const maxHours = Math.ceil(Math.log(this.STALE_THRESHOLD) / Math.log(this.HOURLY_DECAY));
        const result = this.db.prepare(
            `DELETE FROM node_activations WHERE activated_at < datetime('now', '-' || ? || ' hours')`
        ).run(maxHours) as { changes: number };
        return result.changes;
    }

    /** Return all current activations for observability/debugging. */
    getStats(): Array<{ nodeId: string; activation: number; effectiveActivation: number; activatedAt: string; source: string | null }> {
        const rows = this.db.prepare(
            'SELECT * FROM node_activations ORDER BY activation DESC LIMIT 50'
        ).all() as ActivationRow[];

        return rows.map(r => ({
            nodeId:             r.node_id,
            activation:         r.activation,
            effectiveActivation: this.applyTimeDecay(r.activation, r.activated_at),
            activatedAt:        r.activated_at,
            source:             r.source,
        }));
    }
}
