/**
 * CognitiveReflectionEngine — Camada de metacognição do NewClaw
 *
 * Analisa o próprio grafo de memória para gerar metaconhecimento sobre
 * o usuário: padrões de atividade, entidades recorrentes, padrões episódicos
 * e lacunas de cobertura.
 *
 * Isso é distinto do ReflectionMemory (que rastreia falhas de ferramentas).
 * Este engine gera "inteligência contextual real" sobre o usuário.
 *
 * Exemplo de saída no prompt:
 *   [PERFIL COGNITIVO | atualizado Há 3h]
 *   Domínios ativos: DOCENCIA, PROJETOS, CRIPTO
 *   Recorrentes: NewClaw (8×), UTFPR (5×), VPS Mercurio (4×)
 *   Padrão recente: CRIPTO em 5 das últimas 8 sessões
 *
 * Throttling: não roda mais de uma vez a cada 24h (configurável).
 */

import Database from 'better-sqlite3';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('CognitiveReflection');

// ── Row types ──────────────────────────────────────────────

interface ReflectionRow {
    id: string;
    category: string;
    content: string;
    data_json: string | null;
    generated_at: string;
}

interface DomainActivityRow {
    domain_id: string;
    gravity_score: number;
    access_count: number;
}

interface RecurringEntityRow {
    node_name: string;
    domain: string | null;
    total: number;
}

interface EpisodicPatternRow {
    domain: string;
    freq: number;
}

interface GapRow {
    domain: string;
    node_count: number;
    avg_conf: number;
}

// ── Engine ─────────────────────────────────────────────────

export class CognitiveReflectionEngine {
    private db: Database.Database;

    constructor(db: Database.Database) {
        this.db = db;
        this.initSchema();
    }

    private initSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS memory_reflections (
                id           TEXT PRIMARY KEY,
                category     TEXT NOT NULL,
                content      TEXT NOT NULL,
                data_json    TEXT,
                generated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        try {
            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_reflections_category ON memory_reflections(category)`);
        } catch { /* ignore */ }
    }

    // ── Analysis methods ───────────────────────────────────

    /**
     * Top domains by gravity score (minimum 3 accesses to be meaningful).
     * → "Domínios ativos: DOCENCIA, PROJETOS, CRIPTO"
     */
    private analyzeActivityPatterns(): string | null {
        const rows = this.db.prepare(`
            SELECT domain_id, gravity_score, access_count
            FROM domain_gravity
            WHERE access_count >= 3
            ORDER BY gravity_score DESC, access_count DESC
            LIMIT 4
        `).all() as DomainActivityRow[];

        if (rows.length === 0) return null;

        const labels = rows.map(r => {
            const label = r.domain_id.replace(/^domain_/, '').toUpperCase();
            const pct = Math.round(r.gravity_score * 100);
            return `${label} (${pct}%)`;
        });

        return `Domínios ativos: ${labels.join(', ')}`;
    }

    /**
     * Nodes that appear most frequently across episodes (minimum 2 occurrences).
     * → "Recorrentes: NewClaw (8×), UTFPR (5×), VPS Mercurio (4×)"
     */
    private analyzeRecurringEntities(): string | null {
        const rows = this.db.prepare(`
            SELECT node_name, domain, SUM(access_count) AS total
            FROM episode_nodes
            GROUP BY node_id
            HAVING total >= 2
            ORDER BY total DESC
            LIMIT 5
        `).all() as RecurringEntityRow[];

        if (rows.length === 0) return null;

        const labels = rows.map(r => `${r.node_name} (${r.total}×)`);
        return `Recorrentes: ${labels.join(', ')}`;
    }

    /**
     * Most common domains in the last 14 days of closed episodes.
     * → "Padrão recente: CRIPTO em 5 das últimas 8 sessões"
     */
    private analyzeEpisodicPatterns(): string | null {
        // Count total recent closed episodes for denominator
        const total = (this.db.prepare(`
            SELECT COUNT(*) AS cnt FROM memory_episodes
            WHERE is_active = 0 AND ended_at > datetime('now', '-14 days')
        `).get() as { cnt: number } | undefined)?.cnt ?? 0;

        if (total < 3) return null;

        const rows = this.db.prepare(`
            SELECT je.value AS domain, COUNT(*) AS freq
            FROM memory_episodes me, json_each(me.domains) je
            WHERE me.is_active = 0
              AND me.ended_at > datetime('now', '-14 days')
            GROUP BY je.value
            HAVING freq >= 2
            ORDER BY freq DESC
            LIMIT 3
        `).all() as EpisodicPatternRow[];

        if (rows.length === 0) return null;

        const parts = rows.map(r => {
            const label = r.domain.replace(/^domain_/, '').toUpperCase();
            return `${label} em ${r.freq}/${total} sessões`;
        });
        return `Padrão recente: ${parts.join(' · ')}`;
    }

    /**
     * Domains with few active nodes or low average confidence — knowledge gaps.
     * → "Pouca cobertura: AGENDA (2 nós), CLIMA (conf. 0.3)"
     */
    private detectKnowledgeGaps(): string | null {
        const rows = this.db.prepare(`
            SELECT domain,
                   COUNT(*) AS node_count,
                   ROUND(AVG(confidence), 2) AS avg_conf
            FROM memory_nodes
            WHERE domain IS NOT NULL
              AND domain NOT LIKE 'core_%'
              AND domain NOT LIKE 'user_%'
              AND (lifecycle_state IS NULL OR lifecycle_state = 'ACTIVE')
              AND type NOT IN ('identity', 'domain')
            GROUP BY domain
            HAVING node_count < 3 OR avg_conf < 0.35
            ORDER BY node_count ASC, avg_conf ASC
            LIMIT 3
        `).all() as GapRow[];

        if (rows.length === 0) return null;

        const labels = rows.map(r => {
            const label = r.domain.replace(/^domain_/, '').toUpperCase();
            return r.node_count < 3
                ? `${label} (${r.node_count} nós)`
                : `${label} (conf. ${r.avg_conf})`;
        });
        return `Pouca cobertura: ${labels.join(', ')}`;
    }

    // ── Cycle ─────────────────────────────────────────────

    /**
     * Run all analyses and persist results.
     * Returns number of reflection categories updated.
     */
    private runAnalyses(): number {
        const analyses: Array<{ id: string; category: string; fn: () => string | null }> = [
            { id: 'reflection_activity',  category: 'activity',  fn: () => this.analyzeActivityPatterns() },
            { id: 'reflection_entities',  category: 'entities',  fn: () => this.analyzeRecurringEntities() },
            { id: 'reflection_episodes',  category: 'episodes',  fn: () => this.analyzeEpisodicPatterns() },
            { id: 'reflection_gaps',      category: 'gaps',      fn: () => this.detectKnowledgeGaps() },
        ];

        let updated = 0;
        const stmt = this.db.prepare(`
            INSERT INTO memory_reflections (id, category, content, generated_at)
            VALUES (?, ?, ?, datetime('now'))
            ON CONFLICT(id) DO UPDATE SET
                content = excluded.content,
                generated_at = excluded.generated_at
        `);

        for (const { id, category, fn } of analyses) {
            try {
                const content = fn();
                if (!content) continue;
                stmt.run(id, category, content);
                updated++;
            } catch (e) {
                log.warn(`Analysis ${id} failed`, String(e));
            }
        }

        return updated;
    }

    /**
     * Check if enough time has passed since the last reflection cycle.
     */
    shouldRun(minIntervalHours: number = 24): boolean {
        const row = this.db.prepare(
            "SELECT value FROM memory WHERE key = 'last_reflection_at'"
        ).get() as { value: string } | undefined;

        if (!row) return true;
        const hoursSince = (Date.now() - new Date(row.value).getTime()) / 3600000;
        return hoursSince >= minIntervalHours;
    }

    /**
     * Run reflection cycle if throttle allows.
     * @param force Skip throttle check (e.g. for tests or manual trigger)
     * Returns count of reflection categories updated (0 if skipped).
     */
    runReflectionCycle(force: boolean = false): number {
        if (!force && !this.shouldRun()) return 0;

        log.info('Running cognitive reflection cycle...');
        const updated = this.runAnalyses();

        // Record timestamp in settings
        this.db.prepare(
            "INSERT OR REPLACE INTO memory (key, value, category) VALUES ('last_reflection_at', ?, 'system')"
        ).run(new Date().toISOString());

        log.info(`Reflection cycle complete: ${updated} categories updated`);
        return updated;
    }

    // ── Read ──────────────────────────────────────────────

    /**
     * Build the cognitive profile block for injection into the LLM prompt.
     * Returns empty string if no reflections exist yet.
     */
    buildReflectionBlock(): string {
        const rows = this.db.prepare(`
            SELECT content, generated_at FROM memory_reflections
            ORDER BY CASE category
                WHEN 'activity'  THEN 1
                WHEN 'entities'  THEN 2
                WHEN 'episodes'  THEN 3
                WHEN 'gaps'      THEN 4
                ELSE 5
            END
        `).all() as Array<{ content: string; generated_at: string }>;

        if (rows.length === 0) return '';

        const when = timeAgo(rows[0].generated_at);
        const lines = rows.map(r => r.content);
        return `[PERFIL COGNITIVO | atualizado ${when}]\n` + lines.join('\n');
    }

    /** Return all current reflections for observability. */
    getReflections(): ReflectionRow[] {
        return this.db.prepare(
            'SELECT * FROM memory_reflections ORDER BY generated_at DESC'
        ).all() as ReflectionRow[];
    }
}

// ── Helpers ────────────────────────────────────────────────

function timeAgo(isoDate: string): string {
    const diffMs = Date.now() - new Date(isoDate).getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffH   = Math.floor(diffMs / 3600000);
    const diffD   = Math.floor(diffMs / 86400000);
    if (diffMin < 60)  return `Há ${diffMin}min`;
    if (diffH   < 24)  return `Há ${diffH}h`;
    if (diffD   === 1) return 'Ontem';
    return `Há ${diffD} dias`;
}
