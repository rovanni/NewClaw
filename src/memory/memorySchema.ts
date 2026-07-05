import Database from 'better-sqlite3';
import { createLogger } from '../shared/AppLogger';
import { errorMessage } from '../shared/errors';
import { PragmaColumnRow, CountRow } from './memoryTypes';

const log = createLogger('Memoryschema');

export const INVERSE_RELATIONS: Record<string, string> = {
    prefers: 'preferred_by',
    works_on: 'has_contributor',
    runs_on: 'hosts',
    belongs_to: 'has_member',
    owns: 'owned_by',
    uses: 'used_by',
    depends_on: 'required_by',
    contains: 'contained_in',
    created: 'created_by',
    reads: 'read_by',
    writes: 'written_by',
    teaches: 'taught_by',
    caused_by: 'causes',
    learned_from: 'source_of',
    part_of: 'has_part',
};

export function safeExec(db: Database.Database, sql: string): void {
    const isSafePattern = /^(CREATE INDEX IF NOT EXISTS [a-z0-9_]+ ON [a-z0-9_]+\([a-z0-9_]+\))$/i.test(sql);
    if (!isSafePattern) {
        log.warn('migration_safety_check', 'Blocked potentially unsafe SQL execution', { sql });
        return;
    }
    try { db.exec(sql); } catch { /* ignore duplicate index errors */ }
}

export function safeAddColumn(db: Database.Database, table: string, column: string, type: string): void {
    const allowedTables = ['memory_nodes', 'memory_edges', 'node_metrics', 'user_profile', 'conversations', 'messages', 'agent_traces'];
    const allowedTypes = ['TEXT', 'INTEGER', 'REAL', 'DATETIME', 'BOOLEAN'];
    const isValidIdentifier = (id: string) => /^[a-z0-9_]+$/i.test(id);

    if (!allowedTables.includes(table) || !isValidIdentifier(column)) {
        log.error('migration_safety_violation', 'Invalid table or column name', undefined, { table, column });
        return;
    }
    const baseType = type.split(' ')[0].toUpperCase();
    if (!allowedTypes.includes(baseType)) {
        log.error('migration_safety_violation', 'Invalid SQL type', undefined, { type });
        return;
    }

    // Check if table exists before attempting ALTER TABLE
    try {
        const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
        if (!tableExists) {
            log.info('migration_skip_table_missing', 'Table does not exist yet — column will be created with table', { table, column });
            return;
        }
    } catch { /* ignore pragma errors */ }

    try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    } catch (e) {
        if (!errorMessage(e).includes('duplicate column name')) {
            log.warn('migration_column_failed', errorMessage(e), { table, column });
        }
    }
}

export function migrateMemoryNodesCheckConstraint(db: Database.Database): void {
    try {
        const testId = `__migration_test_${Date.now()}`;
        try {
            db.prepare("INSERT INTO memory_nodes (id, type, name, content) VALUES (?, 'rule', 'test', 'test')").run(testId);
            db.prepare('DELETE FROM memory_nodes WHERE id = ?').run(testId);
            return;
        } catch (e) {
            if (!String(e).includes('CHECK constraint')) return;
        }

        log.info('migration_start', 'Migrating memory_nodes CHECK constraint to support new types...');
        db.pragma('foreign_keys = OFF');

        const doMigrate = db.transaction(() => {
            db.exec('DROP TABLE IF EXISTS memory_nodes_new');
            db.exec(`
                CREATE TABLE memory_nodes_new (
                    id TEXT PRIMARY KEY,
                    type TEXT NOT NULL CHECK(type IN ('identity', 'preference', 'project', 'context', 'fact', 'skill', 'infrastructure', 'trait', 'rule', 'strategy', 'knowledge')),
                    name TEXT NOT NULL,
                    content TEXT NOT NULL,
                    metadata TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    pagerank REAL DEFAULT 0.0,
                    degree INTEGER DEFAULT 0,
                    betweenness REAL DEFAULT 0.0,
                    closeness REAL DEFAULT 0.0,
                    weight REAL DEFAULT 1.0,
                    confidence REAL DEFAULT 1.0,
                    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
                    context_type TEXT,
                    classification_score REAL DEFAULT 0,
                    community_id INTEGER DEFAULT 0,
                    domain TEXT,
                    last_accessed DATETIME,
                    lifecycle_state TEXT,
                    expires_at DATETIME,
                    epistemic_status TEXT,
                    identity_scope TEXT
                )
            `);

            const srcCols = new Set(
                (db.prepare('PRAGMA table_info(memory_nodes)').all() as { name: string }[]).map(c => c.name)
            );
            const allCols = [
                'id', 'type', 'name', 'content', 'metadata', 'created_at', 'updated_at',
                'pagerank', 'degree', 'betweenness', 'closeness', 'weight', 'confidence',
                'last_updated', 'context_type', 'classification_score', 'community_id',
                'domain', 'last_accessed', 'lifecycle_state', 'expires_at', 'epistemic_status', 'identity_scope',
            ];
            const copyList = allCols.filter(c => srcCols.has(c)).join(', ');
            log.info('migration_copy', `Copying columns from memory_nodes to memory_nodes_new...`);

            db.exec(`INSERT INTO memory_nodes_new (${copyList}) SELECT ${copyList} FROM memory_nodes`);
            db.exec('DROP TABLE memory_nodes');
            db.exec('ALTER TABLE memory_nodes_new RENAME TO memory_nodes');
        });
        doMigrate();

        safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_memory_nodes_type ON memory_nodes(type)');
        safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_memory_nodes_name ON memory_nodes(name)');
        safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_memory_nodes_pagerank ON memory_nodes(pagerank)');
        safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_memory_nodes_degree ON memory_nodes(degree)');

        db.pragma('foreign_keys = ON');
        db.pragma('integrity_check');
        log.info('migration_done', 'memory_nodes CHECK constraint migration completed successfully.');
    } catch (e) {
        log.error('migration_failed', e, 'memory_nodes CHECK constraint migration failed');
        try { db.pragma('foreign_keys = ON'); } catch { /* best-effort */ }
    }
}

/**
 * Adds 'domain' type to memory_nodes CHECK constraint.
 * Follows the same pattern as migrateMemoryNodesCheckConstraint.
 */
export function migrateDomainNodeType(db: Database.Database): void {
    try {
        const testId = `__domain_test_${Date.now()}`;
        try {
            db.prepare("INSERT INTO memory_nodes (id, type, name, content) VALUES (?, 'domain', 'test', 'test')").run(testId);
            db.prepare('DELETE FROM memory_nodes WHERE id = ?').run(testId);
            return; // already supports 'domain' type
        } catch (e) {
            if (!String(e).includes('CHECK constraint')) return;
        }

        log.info('migration_start', "Migrating memory_nodes CHECK constraint to support 'domain' type...");
        db.pragma('foreign_keys = OFF');

        // Usa transação para garantir atomicidade: se qualquer passo falhar,
        // o banco volta ao estado anterior sem tabelas órfãs.
        const doMigrate = db.transaction(() => {
            db.exec('DROP TABLE IF EXISTS memory_nodes_domain');

            db.exec(`
                CREATE TABLE memory_nodes_domain (
                    id TEXT PRIMARY KEY,
                    type TEXT NOT NULL CHECK(type IN ('identity', 'preference', 'project', 'context', 'fact', 'skill', 'infrastructure', 'trait', 'rule', 'strategy', 'knowledge', 'domain')),
                    name TEXT NOT NULL,
                    content TEXT NOT NULL,
                    metadata TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    pagerank REAL DEFAULT 0.0,
                    degree INTEGER DEFAULT 0,
                    betweenness REAL DEFAULT 0.0,
                    closeness REAL DEFAULT 0.0,
                    weight REAL DEFAULT 1.0,
                    confidence REAL DEFAULT 1.0,
                    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
                    context_type TEXT,
                    classification_score REAL DEFAULT 0,
                    community_id INTEGER DEFAULT 0,
                    domain TEXT,
                    last_accessed DATETIME,
                    lifecycle_state TEXT,
                    expires_at DATETIME,
                    epistemic_status TEXT,
                    identity_scope TEXT
                )
            `);

            // INSERT com lista explícita de colunas: copia apenas as que existem em memory_nodes.
            // Evita falha por mismatch quando o banco fonte tem mais ou menos colunas que o esperado
            // (cenário comum ao restaurar backup de outra versão do sistema).
            const srcCols = new Set(
                (db.prepare('PRAGMA table_info(memory_nodes)').all() as { name: string }[]).map(c => c.name)
            );
            const allCols = [
                'id', 'type', 'name', 'content', 'metadata', 'created_at', 'updated_at',
                'pagerank', 'degree', 'betweenness', 'closeness', 'weight', 'confidence',
                'last_updated', 'context_type', 'classification_score', 'community_id',
                'domain', 'last_accessed', 'lifecycle_state', 'expires_at', 'epistemic_status', 'identity_scope',
            ];
            const copyList = allCols.filter(c => srcCols.has(c)).join(', ');
            db.exec(`INSERT INTO memory_nodes_domain (${copyList}) SELECT ${copyList} FROM memory_nodes`);

            db.exec('DROP TABLE memory_nodes');
            db.exec('ALTER TABLE memory_nodes_domain RENAME TO memory_nodes');
        });
        doMigrate();

        safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_memory_nodes_type ON memory_nodes(type)');
        safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_memory_nodes_name ON memory_nodes(name)');
        safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_memory_nodes_pagerank ON memory_nodes(pagerank)');
        safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_memory_nodes_degree ON memory_nodes(degree)');

        db.pragma('foreign_keys = ON');
        db.pragma('integrity_check');
        log.info('migration_done', "memory_nodes 'domain' type migration completed successfully.");
    } catch (e) {
        log.error('migration_failed', e, "memory_nodes 'domain' type migration failed");
        try { db.pragma('foreign_keys = ON'); } catch { /* best-effort */ }
    }
}

export function ensureMemorySchema(db: Database.Database): void {
    safeAddColumn(db, 'memory_nodes', 'weight', 'REAL DEFAULT 1.0');
    safeAddColumn(db, 'memory_nodes', 'confidence', 'REAL DEFAULT 1.0');
    safeAddColumn(db, 'memory_nodes', 'last_updated', 'DATETIME DEFAULT CURRENT_TIMESTAMP');
    safeAddColumn(db, 'memory_nodes', 'domain', 'TEXT');
    safeAddColumn(db, 'memory_nodes', 'last_accessed', 'DATETIME');
    safeAddColumn(db, 'memory_nodes', 'lifecycle_state', 'TEXT');
    safeAddColumn(db, 'memory_nodes', 'expires_at', 'DATETIME');
    safeAddColumn(db, 'memory_nodes', 'epistemic_status', 'TEXT');
    safeAddColumn(db, 'memory_nodes', 'identity_scope', 'TEXT');
    safeAddColumn(db, 'memory_edges', 'last_accessed', 'DATETIME');
    safeAddColumn(db, 'memory_edges', 'domain', 'TEXT');
    safeAddColumn(db, 'node_metrics', 'last_accessed', 'DATETIME');
    safeAddColumn(db, 'agent_traces', 'correlation_id', 'TEXT');
    safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_memory_nodes_lifecycle ON memory_nodes(lifecycle_state)');
    safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_memory_nodes_expires ON memory_nodes(expires_at)');
    safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_memory_nodes_identity_scope ON memory_nodes(identity_scope)');
    migrateMemoryNodesCheckConstraint(db);
    migrateDomainNodeType(db);
}

export function ensureUserProfileSchema(db: Database.Database): void {
    const columns = new Set(
        ((db.prepare('PRAGMA table_info(user_profile)').all() as PragmaColumnRow[]) || []).map(c => c.name)
    );
    const addColumn = (sql: string) => {
        try { db.exec(sql); } catch (e) {
            if (!errorMessage(e).includes('duplicate column name')) {
                log.warn('schema_update_failed', errorMessage(e), { sql });
            }
        }
    };

    if (!columns.has('nickname'))             addColumn('ALTER TABLE user_profile ADD COLUMN nickname TEXT');
    if (!columns.has('intent'))               addColumn('ALTER TABLE user_profile ADD COLUMN intent TEXT');
    if (!columns.has('assistant_name'))       addColumn('ALTER TABLE user_profile ADD COLUMN assistant_name TEXT');
    if (!columns.has('goals'))                addColumn('ALTER TABLE user_profile ADD COLUMN goals TEXT');
    if (!columns.has('familiarity'))          addColumn('ALTER TABLE user_profile ADD COLUMN familiarity TEXT');
    if (!columns.has('learning_mode'))        addColumn("ALTER TABLE user_profile ADD COLUMN learning_mode TEXT DEFAULT 'enabled'");
    if (!columns.has('autonomy_level'))       addColumn("ALTER TABLE user_profile ADD COLUMN autonomy_level TEXT DEFAULT 'balanced'");
    if (!columns.has('workspace_path'))       addColumn('ALTER TABLE user_profile ADD COLUMN workspace_path TEXT');
    if (!columns.has('onboarding_completed')) addColumn('ALTER TABLE user_profile ADD COLUMN onboarding_completed INTEGER DEFAULT 0');
    if (!columns.has('created_at'))           addColumn('ALTER TABLE user_profile ADD COLUMN created_at TEXT');

    db.exec(`
        UPDATE user_profile
        SET created_at = COALESCE(created_at, updated_at, CURRENT_TIMESTAMP),
            updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP),
            response_style = COALESCE(response_style, 'adaptive'),
            language_preference = COALESCE(language_preference, 'system'),
            learning_mode = COALESCE(learning_mode, 'enabled'),
            autonomy_level = COALESCE(autonomy_level, 'balanced'),
            onboarding_completed = COALESCE(onboarding_completed, 0)
    `);
}

/**
 * Initialize all database tables, indexes, FTS, and run schema migrations.
 * Returns the inverse-relations map that MemoryManager needs.
 */
export function initializeSchema(db: Database.Database): Record<string, string> {
    db.exec(`
        CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            provider TEXT DEFAULT 'gemini',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
            content TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id)
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS memory_nodes (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL CHECK(type IN ('identity', 'preference', 'project', 'context', 'fact', 'skill', 'infrastructure', 'trait', 'rule', 'strategy', 'knowledge')),
            name TEXT NOT NULL,
            content TEXT NOT NULL,
            metadata TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS memory_edges (
            from_node TEXT NOT NULL,
            to_node TEXT NOT NULL,
            relation TEXT NOT NULL,
            weight REAL DEFAULT 1.0,
            confidence REAL DEFAULT 1.0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (from_node, to_node, relation),
            FOREIGN KEY (from_node) REFERENCES memory_nodes(id),
            FOREIGN KEY (to_node) REFERENCES memory_nodes(id)
        )
    `);

    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_memory_nodes_type ON memory_nodes(type);
        CREATE INDEX IF NOT EXISTS idx_memory_nodes_name ON memory_nodes(name);
        CREATE INDEX IF NOT EXISTS idx_memory_edges_from ON memory_edges(from_node);
        CREATE INDEX IF NOT EXISTS idx_memory_edges_to ON memory_edges(to_node);
        CREATE INDEX IF NOT EXISTS idx_memory_edges_relation ON memory_edges(relation);
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS memory_metrics_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            node_id TEXT NOT NULL,
            pagerank REAL DEFAULT 0.0,
            degree INTEGER DEFAULT 0,
            betweenness REAL DEFAULT 0.0,
            closeness REAL DEFAULT 0.0,
            community_id INTEGER DEFAULT 0,
            recorded_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (node_id) REFERENCES memory_nodes(id)
        )
    `);
    safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_metrics_history_node ON memory_metrics_history(node_id)');
    safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_metrics_history_recorded ON memory_metrics_history(recorded_at)');

    safeAddColumn(db, 'memory_nodes', 'pagerank', 'REAL DEFAULT 0.0');
    safeAddColumn(db, 'memory_nodes', 'degree', 'INTEGER DEFAULT 0');
    safeAddColumn(db, 'memory_nodes', 'betweenness', 'REAL DEFAULT 0.0');
    safeAddColumn(db, 'memory_nodes', 'closeness', 'REAL DEFAULT 0.0');
    safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_memory_nodes_pagerank ON memory_nodes(pagerank)');
    safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_memory_nodes_degree ON memory_nodes(degree)');

    // FTS5 migration: remove stale fts_rowid column if present
    const currentCols = (db.prepare('PRAGMA table_info(memory_nodes)').all() as PragmaColumnRow[]).map(c => c.name);
    if (currentCols.includes('fts_rowid')) {
        try { db.exec('DROP TRIGGER IF EXISTS memory_nodes_ai'); } catch (e) { log.warn('fts_migration_cleanup_failed', errorMessage(e)); }
        try { db.exec('DROP TRIGGER IF EXISTS memory_nodes_ad'); } catch (e) { log.warn('fts_migration_cleanup_failed', errorMessage(e)); }
        try { db.exec('DROP TRIGGER IF EXISTS memory_nodes_au'); } catch (e) { log.warn('fts_migration_cleanup_failed', errorMessage(e)); }
        try { db.exec('DROP TABLE IF EXISTS memory_nodes_fts'); } catch (e) { log.warn('fts_migration_cleanup_failed', errorMessage(e)); }

        db.pragma('foreign_keys = OFF');
        db.exec(`CREATE TABLE IF NOT EXISTS memory_nodes_v3 (
            id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL,
            metadata TEXT DEFAULT '{}', pagerank REAL DEFAULT 0.0, degree INTEGER DEFAULT 0,
            betweenness REAL DEFAULT 0.0, closeness REAL DEFAULT 0.0, community_id INTEGER DEFAULT 0,
            context_type TEXT, classification_score REAL DEFAULT 0, last_accessed TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
        db.exec(`INSERT INTO memory_nodes_v3 SELECT id, type, name, content, metadata, pagerank, degree, betweenness, closeness, community_id, context_type, classification_score, last_accessed, created_at, updated_at FROM memory_nodes`);
        db.exec('DROP TABLE memory_nodes');
        db.exec('ALTER TABLE memory_nodes_v3 RENAME TO memory_nodes');
        db.pragma('foreign_keys = ON');
        log.info('[MemorySchema] Migrated: removed fts_rowid column');
    }

    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_nodes_fts USING fts5(name, content, type, content='memory_nodes')`);

    try {
        const ftsCount = (db.prepare('SELECT count(*) as count FROM memory_nodes_fts').get() as CountRow).count;
        if (ftsCount === 0) {
            log.info('[MemorySchema] Rebuilding FTS index (empty)...');
            db.exec(`INSERT INTO memory_nodes_fts(memory_nodes_fts) VALUES('rebuild')`);
        }
    } catch (e) {
        log.warn('[MemorySchema] FTS rebuild needed:', errorMessage(e));
        try {
            db.exec('DROP TABLE IF EXISTS memory_nodes_fts');
            db.exec(`CREATE VIRTUAL TABLE memory_nodes_fts USING fts5(name, content, type, content='memory_nodes')`);
            db.exec(`INSERT INTO memory_nodes_fts(memory_nodes_fts) VALUES('rebuild')`);
            log.info('[MemorySchema] FTS index rebuilt successfully');
        } catch (rebuildErr) {
            log.error('[MemorySchema] FTS rebuild failed:', errorMessage(rebuildErr));
        }
    }

    db.exec(`
        CREATE TABLE IF NOT EXISTS graph_snapshots (
            id TEXT PRIMARY KEY,
            label TEXT,
            node_count INTEGER,
            edge_count INTEGER,
            snapshot_data TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS agent_traces (
            id TEXT PRIMARY KEY,
            conversation_id TEXT,
            correlation_id TEXT,
            step INTEGER,
            decision TEXT,
            tool TEXT,
            input TEXT,
            output TEXT,
            provider TEXT,
            duration_ms INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS agent_config (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            config_json TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            is_active BOOLEAN DEFAULT 1
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS memory (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            category TEXT DEFAULT 'system',
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS user_profile (
            user_id TEXT PRIMARY KEY,
            name TEXT,
            nickname TEXT,
            intent TEXT,
            language_preference TEXT DEFAULT 'pt-BR',
            response_style TEXT DEFAULT 'amigável',
            expertise TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    ensureUserProfileSchema(db);
    ensureMemorySchema(db);
    ensureCMISchema(db);

    return { ...INVERSE_RELATIONS };
}

/**
 * Schema para o Conversational Memory Index (CMI).
 * Episódios conversacionais indexados semanticamente.
 * Separado do grafo semântico (memory_nodes) — camada episódica, não factual.
 */
export function ensureCMISchema(db: Database.Database): void {
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS conversation_chunks (
                id TEXT PRIMARY KEY,
                session_key TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                start_seq INTEGER NOT NULL,
                end_seq INTEGER NOT NULL,
                start_timestamp INTEGER NOT NULL,
                end_timestamp INTEGER NOT NULL,
                summary TEXT NOT NULL,
                topics TEXT NOT NULL DEFAULT '[]',
                entities TEXT NOT NULL DEFAULT '[]',
                intent TEXT NOT NULL DEFAULT '',
                messages TEXT NOT NULL DEFAULT '[]',
                embedding BLOB,
                workflow_id TEXT,
                tools_used TEXT NOT NULL DEFAULT '[]',
                chunk_quality REAL NOT NULL DEFAULT 0.5,
                cut_trigger TEXT NOT NULL DEFAULT 'window_size',
                created_at INTEGER NOT NULL,
                last_accessed_at INTEGER,
                access_count INTEGER NOT NULL DEFAULT 0,
                expires_at INTEGER
            )
        `);
        const tryIdx = (sql: string) => { try { db.exec(sql); } catch { /* exists */ } };
        tryIdx('CREATE INDEX IF NOT EXISTS idx_cmi_session_time ON conversation_chunks(session_key, start_timestamp DESC)');
        tryIdx('CREATE INDEX IF NOT EXISTS idx_cmi_quality ON conversation_chunks(chunk_quality DESC)');
        tryIdx('CREATE INDEX IF NOT EXISTS idx_cmi_expires ON conversation_chunks(expires_at)');
        tryIdx('CREATE INDEX IF NOT EXISTS idx_cmi_created ON conversation_chunks(created_at DESC)');
    } catch (e) {
        log.warn('ensureCMISchema', `CMI schema error: ${String(e)}`);
    }
}
