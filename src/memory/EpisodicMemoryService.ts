/**
 * EpisodicMemoryService — Memória episódica do NewClaw
 *
 * Separa "quando aconteceu" (episódico) de "o que é verdade" (semântico).
 * Cada conversa vira um episódio que registra quais nós foram acessados,
 * quais domínios estavam ativos e quantas interações ocorreram.
 *
 * Após inatividade, o episódio é fechado com título e resumo automáticos.
 * O bloco episódico é injetado no prompt antes do contexto semântico.
 *
 * Formato no prompt:
 *   [EPISÓDIOS RECENTES | 2 conversas]
 *   Há 3h (cripto, projetos): BTC Holdings, Deploy Backend
 *   Ontem (agenda): Sprint Planning, Reunião
 */

import Database from 'better-sqlite3';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('EpisodicMemory');

// ── Row types ──────────────────────────────────────────────

interface EpisodeRow {
    conversation_id: string;
    title: string | null;
    summary: string | null;
    domains: string;
    interaction_count: number;
    last_active: string;
    started_at: string;
    ended_at: string | null;
    is_active: number;
}

interface EpisodeNodeRow {
    node_id: string;
    node_name: string;
    domain: string | null;
    access_count: number;
}

export interface Episode {
    conversationId: string;
    title: string;
    summary: string;
    domains: string[];
    topNodes: string[];
    interactionCount: number;
    startedAt: string;
    endedAt: string | null;
    isActive: boolean;
}

// ── Time formatting ────────────────────────────────────────

function timeAgo(isoDate: string): string {
    const then = new Date(isoDate);
    const diffMs = Date.now() - then.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffH   = Math.floor(diffMs / 3600000);
    const diffD   = Math.floor(diffMs / 86400000);

    if (diffMin < 60)  return `Há ${diffMin}min`;
    if (diffH   < 24)  return `Há ${diffH}h`;
    if (diffD   === 1) return 'Ontem';
    if (diffD   < 7)   return `Há ${diffD} dias`;
    return then.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

// ── Service ────────────────────────────────────────────────

export class EpisodicMemoryService {
    private db: Database.Database;

    constructor(db: Database.Database) {
        this.db = db;
        this.initSchema();
    }

    private initSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS memory_episodes (
                conversation_id  TEXT PRIMARY KEY,
                title            TEXT,
                summary          TEXT,
                domains          TEXT DEFAULT '[]',
                interaction_count INTEGER DEFAULT 0,
                last_active      DATETIME DEFAULT CURRENT_TIMESTAMP,
                started_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
                ended_at         DATETIME,
                is_active        INTEGER DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS episode_nodes (
                conversation_id TEXT NOT NULL,
                node_id         TEXT NOT NULL,
                node_name       TEXT NOT NULL,
                domain          TEXT,
                access_count    INTEGER DEFAULT 1,
                first_accessed  DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (conversation_id, node_id)
            );
        `);

        try {
            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_episodes_active ON memory_episodes(is_active, last_active)`);
            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_episode_nodes_conv ON episode_nodes(conversation_id)`);
        } catch { /* ignore if already exists */ }
    }

    // ── Write ──────────────────────────────────────────────

    /** Ensure an episode row exists for this conversation. */
    private ensureEpisode(conversationId: string): void {
        this.db.prepare(`
            INSERT OR IGNORE INTO memory_episodes (conversation_id, started_at, last_active)
            VALUES (?, datetime('now'), datetime('now'))
        `).run(conversationId);
    }

    /**
     * Record that a query/interaction happened in this conversation.
     * Call once per user message.
     */
    recordInteraction(conversationId: string): void {
        this.ensureEpisode(conversationId);
        this.db.prepare(`
            UPDATE memory_episodes
            SET interaction_count = interaction_count + 1,
                last_active = datetime('now')
            WHERE conversation_id = ?
        `).run(conversationId);
    }

    /**
     * Record which memory nodes were accessed during a query.
     * Looks up node name and domain from memory_nodes.
     */
    recordNodeAccesses(conversationId: string, nodeIds: string[]): void {
        if (nodeIds.length === 0) return;
        this.ensureEpisode(conversationId);

        const lookupStmt = this.db.prepare('SELECT name, domain FROM memory_nodes WHERE id = ?');
        const upsertStmt = this.db.prepare(`
            INSERT INTO episode_nodes (conversation_id, node_id, node_name, domain, access_count)
            VALUES (?, ?, ?, ?, 1)
            ON CONFLICT(conversation_id, node_id) DO UPDATE SET
                access_count = access_count + 1
        `);

        for (const nodeId of nodeIds) {
            const meta = lookupStmt.get(nodeId) as { name: string; domain: string | null } | undefined;
            if (!meta) continue;
            upsertStmt.run(conversationId, nodeId, meta.name, meta.domain);
        }

        this.updateEpisodeDomains(conversationId);
    }

    private updateEpisodeDomains(conversationId: string): void {
        const rows = this.db.prepare(`
            SELECT DISTINCT domain FROM episode_nodes
            WHERE conversation_id = ? AND domain IS NOT NULL
        `).all(conversationId) as Array<{ domain: string }>;

        const domains = rows.map(r => r.domain);
        this.db.prepare(`
            UPDATE memory_episodes SET domains = ? WHERE conversation_id = ?
        `).run(JSON.stringify(domains), conversationId);
    }

    // ── Close ─────────────────────────────────────────────

    /** Close a single episode: generate title + summary and mark inactive. */
    closeEpisode(conversationId: string): void {
        const topNodes = this.db.prepare(`
            SELECT node_name, domain FROM episode_nodes
            WHERE conversation_id = ?
            ORDER BY access_count DESC LIMIT 5
        `).all(conversationId) as EpisodeNodeRow[];

        if (topNodes.length === 0) {
            // Nothing was accessed — just close silently
            this.db.prepare(`
                UPDATE memory_episodes
                SET is_active = 0, ended_at = datetime('now')
                WHERE conversation_id = ?
            `).run(conversationId);
            return;
        }

        const domains = [...new Set(topNodes.map(n => n.domain).filter(Boolean) as string[])];
        const nodeNames = topNodes.slice(0, 3).map(n => n.node_name).join(', ');
        const domainStr = domains.slice(0, 2).join(', ');
        const title   = domainStr ? `Conversa sobre ${domainStr}` : 'Conversa';
        const summary = nodeNames;

        this.db.prepare(`
            UPDATE memory_episodes
            SET is_active = 0, ended_at = datetime('now'),
                title = ?, summary = ?, domains = ?
            WHERE conversation_id = ?
        `).run(title, summary, JSON.stringify(domains), conversationId);

        log.info(`Episode closed: ${conversationId} — "${title}": ${summary}`);
    }

    /**
     * Close all episodes that have been inactive for more than maxAgeHours.
     * Called by MemoryGovernor. Returns count of episodes closed.
     */
    closeStaleEpisodes(maxAgeHours: number = 2): number {
        const stale = this.db.prepare(`
            SELECT conversation_id FROM memory_episodes
            WHERE is_active = 1
              AND last_active < datetime('now', '-' || ? || ' hours')
        `).all(maxAgeHours) as Array<{ conversation_id: string }>;

        for (const { conversation_id } of stale) {
            try { this.closeEpisode(conversation_id); } catch { /* keep going */ }
        }

        if (stale.length > 0) log.info(`Closed ${stale.length} stale episodes`);
        return stale.length;
    }

    // ── Read ──────────────────────────────────────────────

    /**
     * Build the episodic context block for injection into the LLM prompt.
     * Excludes the current conversation (that's the live context, not history).
     * Returns empty string if no closed episodes exist.
     */
    buildEpisodicPromptBlock(currentConversationId?: string, limit: number = 3): string {
        const rows = this.db.prepare(`
            SELECT conversation_id, title, summary, domains, started_at
            FROM memory_episodes
            WHERE is_active = 0
              AND summary IS NOT NULL
              ${currentConversationId ? 'AND conversation_id != ?' : ''}
            ORDER BY ended_at DESC
            LIMIT ?
        `).all(...(currentConversationId ? [currentConversationId, limit] : [limit])) as EpisodeRow[];

        if (rows.length === 0) return '';

        const lines = rows.map(row => {
            const when    = timeAgo(row.started_at);
            const domains = (JSON.parse(row.domains || '[]') as string[]).slice(0, 2).join(', ');
            const summary = row.summary || '';
            return domains
                ? `${when} (${domains}): ${summary}`
                : `${when}: ${summary}`;
        });

        return `[EPISÓDIOS RECENTES | ${rows.length} conversa${rows.length > 1 ? 's' : ''}]\n` + lines.join('\n');
    }

    /** Return recent episodes for observability/debugging. */
    getRecentEpisodes(limit: number = 10): Episode[] {
        const rows = this.db.prepare(`
            SELECT * FROM memory_episodes ORDER BY started_at DESC LIMIT ?
        `).all(limit) as EpisodeRow[];

        return rows.map(row => {
            const topNodes = this.db.prepare(`
                SELECT node_name FROM episode_nodes
                WHERE conversation_id = ? ORDER BY access_count DESC LIMIT 5
            `).all(row.conversation_id) as Array<{ node_name: string }>;

            return {
                conversationId:   row.conversation_id,
                title:            row.title || '(sem título)',
                summary:          row.summary || '',
                domains:          JSON.parse(row.domains || '[]'),
                topNodes:         topNodes.map(n => n.node_name),
                interactionCount: row.interaction_count,
                startedAt:        row.started_at,
                endedAt:          row.ended_at,
                isActive:         row.is_active === 1,
            };
        });
    }
}
