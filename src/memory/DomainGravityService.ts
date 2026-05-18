/**
 * DomainGravityService — Dynamic domain priority based on usage patterns.
 *
 * Replaces the static COGNITIVE_DOMAINS.priority with a live gravity score:
 *   gravity = base_priority + access_bonus * time_decay
 *
 * Rules:
 *   - access_bonus  = min(0.5, access_count * 0.01)  — +0.01 per access, cap +0.5
 *   - time_decay    = 0.95^days_since_last_access     — halves in ~14 days
 *   - floor         = base_priority * 0.5             — never falls below half of base
 *   - ceiling       = 1.0
 */

import Database from 'better-sqlite3';
import { getDomainPriority, COGNITIVE_DOMAINS } from './CognitiveDomains';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('DomainGravity');

interface GravityRow {
    domain_id: string;
    base_priority: number;
    gravity_score: number;
    access_count: number;
    last_accessed: string | null;
}

export class DomainGravityService {
    private db: Database.Database;

    constructor(db: Database.Database) {
        this.db = db;
        this.initSchema();
        this.seedDomains();
    }

    private initSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS domain_gravity (
                domain_id     TEXT PRIMARY KEY,
                base_priority REAL NOT NULL,
                gravity_score REAL NOT NULL,
                access_count  INTEGER DEFAULT 0,
                last_accessed DATETIME,
                updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
    }

    private seedDomains(): void {
        const stmt = this.db.prepare(`
            INSERT OR IGNORE INTO domain_gravity (domain_id, base_priority, gravity_score, access_count)
            VALUES (?, ?, ?, 0)
        `);
        for (const [domainId, def] of Object.entries(COGNITIVE_DOMAINS)) {
            stmt.run(domainId, def.priority, def.priority);
        }
    }

    /** Return the current dynamic gravity score for a domain, or static fallback. */
    getGravity(domainId: string | null | undefined): number {
        if (!domainId) return 0.3;
        const row = this.db.prepare(
            'SELECT gravity_score FROM domain_gravity WHERE domain_id = ?'
        ).get(domainId) as { gravity_score: number } | undefined;
        return row?.gravity_score ?? getDomainPriority(domainId);
    }

    /**
     * Record that a domain was accessed during retrieval.
     * Increments access_count and recalculates gravity_score.
     */
    recordAccess(domainId: string): void {
        if (!domainId) return;

        const existing = this.db.prepare(
            'SELECT base_priority, access_count FROM domain_gravity WHERE domain_id = ?'
        ).get(domainId) as { base_priority: number; access_count: number } | undefined;

        if (!existing) {
            const base = getDomainPriority(domainId);
            this.db.prepare(`
                INSERT INTO domain_gravity (domain_id, base_priority, gravity_score, access_count, last_accessed, updated_at)
                VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))
            `).run(domainId, base, Math.min(1.0, base + 0.01));
            return;
        }

        const newCount = existing.access_count + 1;
        const accessBonus = Math.min(0.5, newCount * 0.01);
        const newGravity = Math.min(1.0, existing.base_priority + accessBonus);

        this.db.prepare(`
            UPDATE domain_gravity
            SET gravity_score = ?, access_count = ?, last_accessed = datetime('now'), updated_at = datetime('now')
            WHERE domain_id = ?
        `).run(newGravity, newCount, domainId);
    }

    /**
     * Apply time-based decay to all domain gravity scores.
     * Called once per governance cycle. Returns count of domains updated.
     */
    decayAll(): number {
        const rows = this.db.prepare(
            'SELECT domain_id, base_priority, gravity_score, last_accessed FROM domain_gravity'
        ).all() as GravityRow[];

        let decayed = 0;
        const now = new Date();

        for (const row of rows) {
            const bonusPart = row.gravity_score - row.base_priority;
            if (bonusPart <= 0.001) continue;

            const lastAccess = row.last_accessed ? new Date(row.last_accessed) : now;
            const daysSince = Math.max(0, (now.getTime() - lastAccess.getTime()) / (1000 * 60 * 60 * 24));
            if (daysSince < 1) continue;

            const decayFactor = Math.pow(0.95, daysSince);
            const newGravity = Math.max(row.base_priority * 0.5, row.base_priority + bonusPart * decayFactor);

            if (Math.abs(newGravity - row.gravity_score) > 0.001) {
                this.db.prepare(
                    `UPDATE domain_gravity SET gravity_score = ?, updated_at = datetime('now') WHERE domain_id = ?`
                ).run(newGravity, row.domain_id);
                decayed++;
            }
        }

        if (decayed > 0) log.info(`Gravity decay: ${decayed} domains updated`);
        return decayed;
    }

    /** Return all gravity scores sorted by current score (for observability). */
    getStats(): Array<{
        domain_id: string;
        gravity_score: number;
        base_priority: number;
        access_count: number;
        last_accessed: string | null;
    }> {
        return this.db.prepare(
            'SELECT domain_id, gravity_score, base_priority, access_count, last_accessed FROM domain_gravity ORDER BY gravity_score DESC'
        ).all() as Array<{
            domain_id: string;
            gravity_score: number;
            base_priority: number;
            access_count: number;
            last_accessed: string | null;
        }>;
    }
}
