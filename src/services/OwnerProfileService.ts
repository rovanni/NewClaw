import type Database from 'better-sqlite3';
import { createLogger } from '../shared/AppLogger';
import { OperationalMode, isValidMode } from '../core/CapabilityMode';
import { PermissionRegistry } from '../core/PermissionRegistry';

const log = createLogger('OwnerProfileService');

export interface OwnerProfile {
    configured: boolean;
    locked: boolean;
    ownerName: string | null;
    ownerId: string | null;
    capabilityMode: OperationalMode;
    createdAt: string;
    updatedAt: string;
}

type AuditEvent =
    | 'name_set'
    | 'name_change_confirmed'
    | 'overwrite_blocked'
    | 'lock_toggled'
    | 'onboarding_confirmed'
    | 'capability_mode_changed';

export class OwnerProfileService {
    private db: Database.Database;

    constructor(db: Database.Database) {
        this.db = db;
        this.ensureSchema();
    }

    private ensureSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS owner_profile (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                owner_name TEXT,
                owner_user_id TEXT,
                configured INTEGER DEFAULT 0,
                locked INTEGER DEFAULT 0,
                capability_mode TEXT DEFAULT 'safe',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Migração: adiciona coluna capability_mode em bancos existentes
        try {
            this.db.exec(`ALTER TABLE owner_profile ADD COLUMN capability_mode TEXT DEFAULT 'safe'`);
        } catch { /* coluna já existe — ignorar */ }

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS owner_audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_type TEXT NOT NULL,
                attempted_value TEXT,
                source TEXT,
                blocked INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        `);

        this.db.prepare(
            `INSERT OR IGNORE INTO owner_profile (id, configured, locked, capability_mode) VALUES (1, 0, 0, 'safe')`
        ).run();

        // Restaura o modo salvo no PermissionRegistry
        const row = this.db.prepare('SELECT capability_mode FROM owner_profile WHERE id = 1').get() as Record<string, unknown> | undefined;
        const savedMode = (row?.capability_mode as string) ?? 'safe';
        PermissionRegistry.getInstance().restoreMode(savedMode);

        // Persiste automaticamente quando o modo muda em runtime
        PermissionRegistry.getInstance().onChange((newMode) => {
            try {
                this.db.prepare(
                    'UPDATE owner_profile SET capability_mode = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1'
                ).run(newMode);
            } catch { /* non-fatal */ }
        });
    }

    getProfile(): OwnerProfile {
        const row = this.db.prepare('SELECT * FROM owner_profile WHERE id = 1').get() as Record<string, unknown>;
        const savedMode = (row.capability_mode as string) ?? 'safe';
        return {
            configured: row.configured === 1,
            locked: row.locked === 1,
            ownerName: (row.owner_name as string | null) ?? null,
            ownerId: (row.owner_user_id as string | null) ?? null,
            capabilityMode: isValidMode(savedMode) ? (savedMode as OperationalMode) : OperationalMode.SAFE,
            createdAt: row.created_at as string,
            updatedAt: row.updated_at as string,
        };
    }

    /**
     * Altera o modo operacional e persiste no banco.
     * Requer confirmação explícita para GOD mode.
     */
    setCapabilityMode(newMode: OperationalMode, source: string, godModeConfirmed = false): {
        success: boolean;
        error?: string;
    } {
        const result = PermissionRegistry.getInstance().setMode(newMode, source, godModeConfirmed);
        if (!result.success) return result;

        this.audit('capability_mode_changed', newMode, source, false);
        log.info(`capability_mode_changed: ${newMode} (source=${source})`);
        return { success: true };
    }

    getCapabilityMode(): OperationalMode {
        return PermissionRegistry.getInstance().getMode();
    }

    isLocked(): boolean {
        return this.getProfile().locked;
    }

    getOwnerName(): string | null {
        return this.getProfile().ownerName;
    }

    /**
     * Called at startup: seeds from env vars only if owner not yet configured.
     * If already configured, only the locked flag can be toggled from env.
     */
    initFromEnv(ownerName: string, ownerId: string, locked: boolean): void {
        const profile = this.getProfile();
        if (!profile.configured) {
            if (ownerName) {
                this.db.prepare(`
                    UPDATE owner_profile SET
                        owner_name = ?,
                        owner_user_id = ?,
                        configured = 1,
                        locked = ?,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = 1
                `).run(ownerName, ownerId || null, locked ? 1 : 0);
                this.audit('name_set', ownerName, 'env', false);
                log.info(`owner_initialized: name="${ownerName}" locked=${locked}`);
            }
        } else if (profile.locked !== locked) {
            this.db.prepare(
                'UPDATE owner_profile SET locked = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1'
            ).run(locked ? 1 : 0);
            this.audit('lock_toggled', String(locked), 'env', false);
        }
    }

    /**
     * Called when owner explicitly confirms their name (onboarding or conversation).
     * Sets configured=true and locked=true.
     */
    confirmOwnerName(name: string, userId?: string, source = 'onboarding'): void {
        this.db.prepare(`
            UPDATE owner_profile SET
                owner_name = ?,
                owner_user_id = COALESCE(?, owner_user_id),
                configured = 1,
                locked = 1,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = 1
        `).run(name, userId ?? null);
        this.audit('onboarding_confirmed', name, source, false);
        log.info(`owner_confirmed: name="${name}" source=${source}`);
    }

    /**
     * Called from the dashboard for explicit, auditable name changes.
     */
    updateFromDashboard(ownerName: string, locked: boolean): void {
        this.db.prepare(`
            UPDATE owner_profile SET
                owner_name = ?,
                configured = 1,
                locked = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = 1
        `).run(ownerName, locked ? 1 : 0);
        this.audit('name_change_confirmed', ownerName, 'dashboard', false);
        log.info(`owner_updated_dashboard: name="${ownerName}" locked=${locked}`);
    }

    /**
     * Log and warn when LLM tries to overwrite a protected identity node.
     */
    logBlockedOverwrite(nodeId: string, attemptedContent: string, source: string): void {
        const preview = attemptedContent.slice(0, 120);
        this.audit('overwrite_blocked', `node=${nodeId} | ${preview}`, source, true);
        log.warn('identity_overwrite_blocked', undefined, { nodeId, source, preview });
    }

    getAuditLog(limit = 100): Array<Record<string, unknown>> {
        try {
            return this.db.prepare(
                'SELECT * FROM owner_audit_log ORDER BY created_at DESC LIMIT ?'
            ).all(limit) as Array<Record<string, unknown>>;
        } catch { return []; }
    }

    private audit(eventType: AuditEvent, value: string, source: string, blocked: boolean): void {
        try {
            this.db.prepare(
                'INSERT INTO owner_audit_log (event_type, attempted_value, source, blocked) VALUES (?, ?, ?, ?)'
            ).run(eventType, value, source, blocked ? 1 : 0);
        } catch { /* non-fatal */ }
    }
}
