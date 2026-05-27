/**
 * ProceduralMemoryService — Memória de como fazer coisas
 *
 * Especializa o grafo cognitivo para memórias procedurais: skills, estratégias,
 * regras e conhecimento de execução. Três responsabilidades:
 *
 *   1. Storage semantics  — tabela `procedural_executions` rastreia histórico
 *      de uso de cada nó procedural (outcome, contexto, reforço aplicado)
 *
 *   2. Retrieval especializado — detecta intent "como fazer X" na query e
 *      retorna candidatos procedurais com score boosted por histórico de sucesso
 *
 *   3. Execution reinforcement — sucesso aumenta confidence/weight do nó;
 *      falha reduz confidence; ambos registrados no event log
 *
 * Tipos procedurais: skill · strategy · rule · knowledge
 */

import Database from 'better-sqlite3';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('ProceduralMemory');

// ── Types ──────────────────────────────────────────────────────────────────

export type ExecutionOutcome = 'success' | 'failure' | 'partial';

export interface ExecutionRecord {
    id: number;
    node_id: string;
    executed_at: string;
    outcome: ExecutionOutcome;
    context: string | null;
    reinforcement: number;
}

export interface ProceduralStats {
    nodeId: string;
    executionCount: number;
    successRate: number;
    lastExecuted: string | null;
    recentlyUsed: boolean;
}

// ── ProceduralMemoryService ────────────────────────────────────────────────

export class ProceduralMemoryService {
    static readonly PROCEDURAL_TYPES = new Set(['skill', 'strategy', 'rule', 'knowledge']);

    private static readonly INTENT_PATTERNS = [
        /\b(como|how to|passo a passo|step by step)\b/i,
        /\b(estratégia para|strategy for|workflow|processo|procedimento)\b/i,
        /\b(qual a melhor forma|melhor abordagem|best approach|best way)\b/i,
        /\b(como fazer|como executar|como realizar|how do i|how can i)\b/i,
        /\b(instrução|instructions?|tutorial|guia|guide)\b/i,
    ];

    private static readonly REINFORCEMENT = {
        success: { confidence: 1.05, weight: 1.08 },
        partial: { confidence: 1.01, weight: 1.02 },
        failure: { confidence: 0.92, weight: 1.0  },
    };

    constructor(private db: Database.Database) {
        this.initSchema();
    }

    private initSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS procedural_executions (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                node_id        TEXT NOT NULL,
                executed_at    TEXT DEFAULT CURRENT_TIMESTAMP,
                outcome        TEXT NOT NULL CHECK(outcome IN ('success', 'failure', 'partial')),
                context        TEXT,
                reinforcement  REAL DEFAULT 0.0,
                FOREIGN KEY (node_id) REFERENCES memory_nodes(id) ON DELETE CASCADE
            )
        `);
        try {
            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_proc_exec_node ON procedural_executions(node_id)`);
            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_proc_exec_at   ON procedural_executions(executed_at)`);
        } catch { /* ignore if already exists */ }
    }

    // ── Intent detection ───────────────────────────────────────────────────

    /**
     * Returns true if the query has a "how to do X" flavor.
     * Used by MultiLayerRetriever to decide whether to run layer 5.
     */
    detectIntent(query: string): boolean {
        return ProceduralMemoryService.INTENT_PATTERNS.some(p => p.test(query));
    }

    // ── Specialized retrieval ──────────────────────────────────────────────

    /**
     * Retrieves procedural nodes (skill/strategy/rule/knowledge) matching the
     * query terms, with scores boosted by execution history.
     *
     * Score formula:
     *   base 0.70
     *   +0.03 per successful execution (cap +0.15 at 5+)
     *   +0.05 if used within the last 7 days
     */
    retrieve(query: string, limit: number = 10): Array<{ nodeId: string; score: number }> {
        const terms = query
            .toLowerCase()
            .replace(/[^\wáàãâéèêíìîóòõôúùûç\s]/g, ' ')
            .split(/\s+/)
            .filter(t => t.length >= 3)
            .slice(0, 5);

        if (terms.length === 0) return [];

        const typePh = [...ProceduralMemoryService.PROCEDURAL_TYPES].map(() => '?').join(',');
        const termCond = terms.map(() => '(LOWER(n.name) LIKE ? OR LOWER(n.content) LIKE ?)').join(' OR ');

        const rows = this.db.prepare(`
            SELECT DISTINCT
                n.id,
                COALESCE(n.confidence, 0.5) AS confidence,
                COALESCE(n.weight,     1.0)  AS weight,
                (SELECT COUNT(*) FROM procedural_executions pe
                 WHERE pe.node_id = n.id AND pe.outcome = 'success') AS success_count,
                (SELECT MAX(pe.executed_at) FROM procedural_executions pe
                 WHERE pe.node_id = n.id) AS last_executed
            FROM memory_nodes n
            WHERE (n.lifecycle_state IS NULL OR n.lifecycle_state = 'ACTIVE')
              AND n.type IN (${typePh})
              AND (${termCond})
            ORDER BY confidence DESC, weight DESC
            LIMIT ?
        `).all(
            ...[...ProceduralMemoryService.PROCEDURAL_TYPES],
            ...terms.flatMap(t => [`%${t}%`, `%${t}%`]),
            limit
        ) as Array<{ id: string; confidence: number; weight: number; success_count: number; last_executed: string | null }>;

        const sevenDaysAgo = Date.now() - 7 * 24 * 3600000;

        return rows.map(row => {
            const execBoost    = Math.min(0.15, row.success_count * 0.03);
            const recencyBoost = row.last_executed && new Date(row.last_executed).getTime() > sevenDaysAgo
                ? 0.05 : 0;
            return {
                nodeId: row.id,
                score:  Math.min(1.0, 0.70 + execBoost + recencyBoost),
            };
        });
    }

    // ── Execution reinforcement ────────────────────────────────────────────

    /**
     * Records an execution result and reinforces (or decays) the node.
     *
     * Reinforcement rules:
     *   success → confidence × 1.05 (cap 0.95), weight × 1.08 (cap 2.0)
     *   partial → confidence × 1.01, weight × 1.02
     *   failure → confidence × 0.92 (floor 0.1), weight unchanged
     *
     * Ignores non-procedural nodes silently.
     */
    recordExecution(nodeId: string, outcome: ExecutionOutcome, context?: string): void {
        const node = this.db.prepare(
            'SELECT type, confidence, weight FROM memory_nodes WHERE id = ?'
        ).get(nodeId) as { type: string; confidence: number; weight: number } | undefined;

        if (!node || !ProceduralMemoryService.PROCEDURAL_TYPES.has(node.type)) {
            log.warn(`recordExecution: node "${nodeId}" not found or not procedural type`);
            return;
        }

        const { confidence: cMult, weight: wMult } = ProceduralMemoryService.REINFORCEMENT[outcome];
        const reinforcement = cMult - 1; // signed delta for storage

        this.db.prepare(`
            INSERT INTO procedural_executions (node_id, outcome, context, reinforcement)
            VALUES (?, ?, ?, ?)
        `).run(nodeId, outcome, context?.slice(0, 500) || null, reinforcement);

        if (outcome === 'success' || outcome === 'partial') {
            this.db.prepare(`
                UPDATE memory_nodes
                SET confidence = MIN(0.95, COALESCE(confidence, 0.5) * ?),
                    weight     = MIN(2.0,  COALESCE(weight,     1.0) * ?)
                WHERE id = ?
            `).run(cMult, wMult, nodeId);
        } else {
            this.db.prepare(`
                UPDATE memory_nodes
                SET confidence = MAX(0.10, COALESCE(confidence, 0.5) * ?)
                WHERE id = ?
            `).run(cMult, nodeId);
        }

        const eventType = outcome === 'success' ? 'skill_succeeded'
            : outcome === 'failure'             ? 'skill_failed'
            :                                     'skill_executed';

        log.info(eventType, 'procedural', { nodeId, outcome, context: context?.slice(0, 200) });
        log.info(`[Procedural] ${nodeId} → ${outcome} (reinforcement ${reinforcement > 0 ? '+' : ''}${reinforcement.toFixed(2)})`);
    }

    // ── Stats ──────────────────────────────────────────────────────────────

    getStats(nodeId: string): ProceduralStats {
        const rows = this.db.prepare(`
            SELECT outcome, executed_at FROM procedural_executions
            WHERE node_id = ? ORDER BY executed_at DESC LIMIT 50
        `).all(nodeId) as Array<{ outcome: string; executed_at: string }>;

        const total     = rows.length;
        const successes = rows.filter(r => r.outcome === 'success').length;
        const last      = rows[0]?.executed_at || null;

        return {
            nodeId,
            executionCount: total,
            successRate:    total > 0 ? successes / total : 0,
            lastExecuted:   last,
            recentlyUsed:   last
                ? new Date(last).getTime() > Date.now() - 7 * 24 * 3600000
                : false,
        };
    }

    // ── Maintenance ────────────────────────────────────────────────────────

    /** Prunes execution records older than keepDays. Returns deleted count. */
    pruneOldExecutions(keepDays: number = 90): number {
        const result = this.db.prepare(
            `DELETE FROM procedural_executions WHERE executed_at < datetime('now', '-' || ? || ' days')`
        ).run(keepDays) as { changes: number };
        return result.changes;
    }
}
