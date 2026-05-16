/**
 * MemoryManager — Facade de persistência do NewClaw
 * 
 * Usa SQLite (better-sqlite3) com WAL para memória conversacional
 * + Sistema de grafos para memória semântica (como o IalClaw)
 */

import Database from 'better-sqlite3';
import { errorMessage } from '../shared/errors';
import { AttentionLayer } from "./AttentionLayer";
import { AttentionFeedback } from "./AttentionFeedback";
import path from 'path';
import fs from 'fs';
import { createLogger } from '../shared/AppLogger';
import { MemoryFacade, SqliteMemoryFacade } from './MemoryFacade';
import { ConfidenceClassifier } from '../core/ConfidenceClassifier';
const log = createLogger('Memorymanager');

export interface Message {
    id?: number;
    conversation_id: string;
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    created_at?: string;
}

export interface Conversation {
    id: string;
    user_id: string;
    provider: string;
    created_at?: string;
    updated_at?: string;
}

export interface MemoryNode {
    id: string;
    type: 'identity' | 'preference' | 'project' | 'context' | 'fact' | 'skill' | 'infrastructure';
    name: string;
    content: string;
    metadata?: Record<string, string>;
    pagerank?: number;
    degree?: number;
    community_id?: number;
    weight?: number;
    confidence?: number;
    last_updated?: string;
    created_at?: string;
    updated_at?: string;
}

export interface MemoryEdge {
    from: string;
    to: string;
    relation: string;
    weight?: number;
}

// Memory management core
export class MemoryManager {
    private db: Database.Database;
    private attentionLayer: AttentionLayer | null = null;
    private attentionFeedback: AttentionFeedback | null = null;
    private facade: MemoryFacade | null = null;
    private classifier: ConfidenceClassifier;

    getFacade(): MemoryFacade {
        if (!this.facade) {
            this.facade = new SqliteMemoryFacade(this.db, this);
        }
        return this.facade;
    }

    // ── Ontologia formal do grafo de memória ──
    static readonly NODE_TYPES: Record<string, { label: string; description: string }> = {
        identity:  { label: 'Identidade',  description: 'Entidades centrais (usuário, agente)' },
        preference:{ label: 'Preferência', description: 'Interesses, escolhas, configurações' },
        project:   { label: 'Projeto',     description: 'Iniciativas, sistemas, produtos' },
        skill:     { label: 'Habilidade',  description: 'Competências, serviços, ferramentas' },
        context:   { label: 'Contexto',    description: 'Infraestrutura, ambiente, configuração' },
        fact:      { label: 'Fato',        description: 'Informações temporais ou eventos' },
        infrastructure: { label: 'Infraestrutura',  description: 'VPS, servidores, exchanges, hosts físicos' },
    };

    static readonly RELATION_ONTOLOGY: Record<string, { label: string; description: string; allowedFrom: string[]; allowedTo: string[] }> = {
        belongs_to: { label: 'pertence a',      description: 'Pertinência hierárquica',        allowedFrom: ['identity','skill','project','context'], allowedTo: ['identity','project','context'] },
        owns:       { label: 'possui',          description: 'Posse direta',                   allowedFrom: ['identity'],                             allowedTo: ['project','skill','context'] },
        prefers:    { label: 'prefere',         description: 'Preferência ou interesse',      allowedFrom: ['identity'],                             allowedTo: ['preference'] },
        works_on:   { label: 'trabalha em',     description: 'Envolvimento ativo',             allowedFrom: ['identity'],                             allowedTo: ['project'] },
        uses:       { label: 'usa',             description: 'Uso de ferramenta/serviço',     allowedFrom: ['identity','project','skill','infrastructure'],           allowedTo: ['skill','context','infrastructure'] },
        runs_on:    { label: 'executa em',      description: 'Hospedagem/infraestrutura',     allowedFrom: ['project','skill','infrastructure'],      allowedTo: ['context','infrastructure'] },
        references: { label: 'referencia',      description: 'Referência informativa',         allowedFrom: ['*'],                                    allowedTo: ['*'] },
        related_to: { label: 'relacionado',     description: 'Relação genérica',              allowedFrom: ['*'],                                    allowedTo: ['*'] },
        depends_on: { label: 'depende de',      description: 'Dependência técnica',           allowedFrom: ['project','skill','context','infrastructure'],             allowedTo: ['project','skill','context','infrastructure'] },
        contains:  { label: 'contém',          description: 'Composição hierárquica',         allowedFrom: ['project','context'],                     allowedTo: ['skill','context','fact'] },
        created:   { label: 'criou',           description: 'Autoria/criação',               allowedFrom: ['identity'],                             allowedTo: ['project','fact'] },
        reads:     { label: 'lê',              description: 'Leitura de dados',               allowedFrom: ['skill','project'],                       allowedTo: ['skill','context'] },
        writes:    { label: 'escreve',          description: 'Escrita de dados',              allowedFrom: ['skill','project'],                       allowedTo: ['skill','context'] },
        hosts:     { label: 'hospeda',          description: 'Infraestrutura hospeda projeto', allowedFrom: ['infrastructure'],                       allowedTo: ['project','skill'] },
        has_preference: { label: 'possui preferência', description: 'Preferência de usuário',     allowedFrom: ['identity'],                             allowedTo: ['preference'] },
        has_goal:       { label: 'tem objetivo',      description: 'Objetivo ou meta',          allowedFrom: ['identity'],                             allowedTo: ['project', 'fact'] },
        has_trait:      { label: 'possui traço',      description: 'Característica ou perícia',  allowedFrom: ['identity'],                             allowedTo: ['fact', 'preference'] },
        has_identity:   { label: 'tem identidade',    description: 'Relaciona usuário ao seu nome/ID', allowedFrom: ['identity'],                       allowedTo: ['identity'] },
    };

    private validateRelation(fromType: string, relation: string, toType: string): boolean {
        const rel = MemoryManager.RELATION_ONTOLOGY[relation];
        if (!rel) return true; // Allow custom relations
        if (rel.allowedFrom[0] === '*' && rel.allowedTo[0] === '*') return true;
        if (!rel.allowedFrom.includes(fromType) && !rel.allowedFrom.includes('*')) return false;
        if (!rel.allowedTo.includes(toType) && !rel.allowedTo.includes('*')) return false;
        return true;
    }

    // ── Ontologia fim ──

    private inverseRelations: Record<string, string> = {};

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
        this.initialize();
    }

    private initialize(): void {
        // Tabela de conversas
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                provider TEXT DEFAULT 'gemini',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Tabela de mensagens
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id TEXT NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
                content TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (conversation_id) REFERENCES conversations(id)
            )
        `);

        // Tabela de nós do grafo de memória
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS memory_nodes (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL CHECK(type IN ('identity', 'preference', 'project', 'context', 'fact', 'skill', 'infrastructure')),
                name TEXT NOT NULL,
                content TEXT NOT NULL,
                metadata TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Tabela de arestas do grafo de memória
        this.db.exec(`
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

        // Inverse relation map
        const INVERSE_RELATIONS: Record<string, string> = {
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
        };
        this.inverseRelations = INVERSE_RELATIONS;

        // Índices
        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_memory_nodes_type ON memory_nodes(type);
            CREATE INDEX IF NOT EXISTS idx_memory_nodes_name ON memory_nodes(name);
            CREATE INDEX IF NOT EXISTS idx_memory_edges_from ON memory_edges(from_node);
            CREATE INDEX IF NOT EXISTS idx_memory_edges_to ON memory_edges(to_node);
            CREATE INDEX IF NOT EXISTS idx_memory_edges_relation ON memory_edges(relation);
        `);

        // ── Metrics History (Bloco 4) ──
        this.db.exec(`
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
        this.safeExec('CREATE INDEX IF NOT EXISTS idx_metrics_history_node ON memory_metrics_history(node_id)');
        this.safeExec('CREATE INDEX IF NOT EXISTS idx_metrics_history_recorded ON memory_metrics_history(recorded_at)');

        // ── Schema Analytics Migration (Safe Additions) ──
        this.safeAddColumn('memory_nodes', 'pagerank', 'REAL DEFAULT 0.0');
        this.safeAddColumn('memory_nodes', 'degree', 'INTEGER DEFAULT 0');
        this.safeAddColumn('memory_nodes', 'betweenness', 'REAL DEFAULT 0.0');
        this.safeAddColumn('memory_nodes', 'closeness', 'REAL DEFAULT 0.0');

        this.safeExec('CREATE INDEX IF NOT EXISTS idx_memory_nodes_pagerank ON memory_nodes(pagerank)');
        this.safeExec('CREATE INDEX IF NOT EXISTS idx_memory_nodes_degree ON memory_nodes(degree)');

        // ── FTS5 Semantic Search (using native rowid — no fts_rowid column needed) ──
        // Only drop and recreate FTS if schema migration requires it (fts_rowid column)
        // Do NOT drop FTS on every startup — this was causing DB corruption race conditions
        const currentCols = (this.db.prepare("PRAGMA table_info(memory_nodes)").all() as any[]).map(c => c.name);
        const needsFtsRebuild = currentCols.includes('fts_rowid');

        if (needsFtsRebuild) {
            try { this.db.exec('DROP TRIGGER IF EXISTS memory_nodes_ai'); } catch (e) { log.warn('fts_migration_cleanup_failed', errorMessage(e)); }
            try { this.db.exec('DROP TRIGGER IF EXISTS memory_nodes_ad'); } catch (e) { log.warn('fts_migration_cleanup_failed', errorMessage(e)); }
            try { this.db.exec('DROP TRIGGER IF EXISTS memory_nodes_au'); } catch (e) { log.warn('fts_migration_cleanup_failed', errorMessage(e)); }
            try { this.db.exec('DROP TABLE IF EXISTS memory_nodes_fts'); } catch (e) { log.warn('fts_migration_cleanup_failed', errorMessage(e)); }

            // Migrate: recreate table without fts_rowid (disable FK during migration)
            this.db.pragma('foreign_keys = OFF');
            this.db.exec(`CREATE TABLE IF NOT EXISTS memory_nodes_v3 (
                id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL,
                metadata TEXT DEFAULT '{}', pagerank REAL DEFAULT 0.0, degree INTEGER DEFAULT 0,
                betweenness REAL DEFAULT 0.0, closeness REAL DEFAULT 0.0, community_id INTEGER DEFAULT 0,
                context_type TEXT, classification_score REAL DEFAULT 0, last_accessed TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            )`);
            this.db.exec(`INSERT INTO memory_nodes_v3 SELECT id, type, name, content, metadata, pagerank, degree, betweenness, closeness, community_id, context_type, classification_score, last_accessed, created_at, updated_at FROM memory_nodes`);
            this.db.exec('DROP TABLE memory_nodes');
            this.db.exec('ALTER TABLE memory_nodes_v3 RENAME TO memory_nodes');
            this.db.pragma('foreign_keys = ON');
            log.info('[MemoryManager] Migrated: removed fts_rowid column');
        }

        // Create FTS5 using native rowid (no content_rowid — uses SQLite's built-in rowid)
        // Use CREATE VIRTUAL TABLE IF NOT EXISTS to avoid destructive rebuild on every startup
        this.db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS memory_nodes_fts
            USING fts5(name, content, type, content='memory_nodes');
        `);

        // FTS index: only rebuild if the table is empty (new DB or after schema migration)
        try {
            const ftsCount = (this.db.prepare('SELECT count(*) as count FROM memory_nodes_fts').get() as any).count;
            if (ftsCount === 0) {
                log.info('[MemoryManager] Rebuilding FTS index (empty)...');
                this.db.exec(`INSERT INTO memory_nodes_fts(memory_nodes_fts) VALUES('rebuild')`);
            }
        } catch (e) {
            // FTS table might not exist yet or be corrupted — rebuild safely
            log.warn('[MemoryManager] FTS rebuild needed:', errorMessage(e));
            try {
                this.db.exec('DROP TABLE IF EXISTS memory_nodes_fts');
                this.db.exec(`CREATE VIRTUAL TABLE memory_nodes_fts USING fts5(name, content, type, content='memory_nodes')`);
                this.db.exec(`INSERT INTO memory_nodes_fts(memory_nodes_fts) VALUES('rebuild')`);
                log.info('[MemoryManager] FTS index rebuilt successfully');
            } catch (rebuildErr) {
                log.error('[MemoryManager] FTS rebuild failed:', errorMessage(rebuildErr));
            }
        }

        // FTS Triggers are REMOVED — they cause DB corruption with better-sqlite3 transactions.
        // Instead, FTS is rebuilt periodically when empty or via explicit rebuild.
        // The memory search fallback uses LIKE queries when FTS is stale.

        // ── Snapshots do grafo ──
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS graph_snapshots (
                id TEXT PRIMARY KEY,
                label TEXT,
                node_count INTEGER,
                edge_count INTEGER,
                snapshot_data TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Tabela de traces do agente
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS agent_traces (
                id TEXT PRIMARY KEY,
                conversation_id TEXT,
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

        // Tabela de versionamento de config
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS agent_config (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                config_json TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                is_active BOOLEAN DEFAULT 1
            )
        `);

        // Tabela de configurações genéricas (key-value)
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS memory (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                category TEXT DEFAULT 'system',
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Tabela de perfis de usuário
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS user_profile (
                user_id TEXT PRIMARY KEY,
                name TEXT,
                language_preference TEXT DEFAULT 'pt-BR',
                response_style TEXT DEFAULT 'amigável',
                expertise TEXT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        this.ensureUserProfileSchema();
        this.ensureMemorySchema();
        this.incrementBootCount();
        this.bootstrapCoreGraph();
    }

    private ensureMemorySchema(): void {
        this.safeAddColumn('memory_nodes', 'weight', 'REAL DEFAULT 1.0');
        this.safeAddColumn('memory_nodes', 'confidence', 'REAL DEFAULT 1.0');
        this.safeAddColumn('memory_nodes', 'last_updated', 'DATETIME DEFAULT CURRENT_TIMESTAMP');
        this.safeAddColumn('memory_nodes', 'domain', 'TEXT');
        this.safeAddColumn('memory_edges', 'last_accessed', 'DATETIME');
        this.safeAddColumn('memory_edges', 'domain', 'TEXT');
        this.safeAddColumn('node_metrics', 'last_accessed', 'DATETIME');
    }

    /**
     * Safe wrapper for schema migrations (ALTER TABLE / CREATE INDEX).
     * Validates that the query follows expected safe patterns.
     */
    private safeExec(sql: string): void {
        // Only allow CREATE INDEX or simple PRAGMA/ALTER that are known safe patterns
        const isSafePattern = /^(CREATE INDEX IF NOT EXISTS [a-z0-9_]+ ON [a-z0-9_]+\([a-z0-9_]+\))$/i.test(sql);
        
        if (!isSafePattern) {
            log.warn('migration_safety_check', 'Blocked potentially unsafe SQL execution', { sql });
            return;
        }

        try {
            this.db.exec(sql);
        } catch (e) {
            // Ignore if index already exists or similar non-critical errors
        }
    }

    /**
     * Centralized method to add columns safely with allow-list validation.
     * Prevents SQL injection by verifying table and column names against a safe pattern.
     */
    private safeAddColumn(table: string, column: string, type: string): void {
        const allowedTables = ['memory_nodes', 'memory_edges', 'node_metrics', 'user_profile', 'conversations', 'messages'];
        const allowedTypes = ['TEXT', 'INTEGER', 'REAL', 'DATETIME', 'BOOLEAN'];
        
        // Validate identifiers (alphanumeric + underscore only)
        const isValidIdentifier = (id: string) => /^[a-z0-9_]+$/i.test(id);
        
        if (!allowedTables.includes(table) || !isValidIdentifier(column)) {
            log.error('migration_safety_violation', 'Invalid table or column name', undefined, { table, column });
            return;
        }

        // Basic type validation (must start with an allowed SQL type)
        const baseType = type.split(' ')[0].toUpperCase();
        if (!allowedTypes.includes(baseType)) {
            log.error('migration_safety_violation', 'Invalid SQL type', undefined, { type });
            return;
        }

        try {
            this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
        } catch (e) {
            if (!errorMessage(e).includes('duplicate column name')) {
                log.warn('migration_column_failed', errorMessage(e), { table, column });
            }
        }
    }

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
        this.updateLastActive();
        this.refreshHeartbeatNode();
    }

    private updateLastActive(): void {
        const key = 'last_active';
        this.db.prepare('INSERT OR REPLACE INTO memory (key, value, category) VALUES (?, ?, ?)').run(key, new Date().toISOString(), 'system');
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

    private ensureUserProfileSchema(): void {
        const columns = new Set(
            ((this.db.prepare("PRAGMA table_info(user_profile)").all() as any[]) || []).map(c => c.name)
        );
        const addColumn = (sql: string) => {
            try { this.db.exec(sql); } catch (e) { 
                if (!errorMessage(e).includes('duplicate column name')) {
                    log.warn('schema_update_failed', errorMessage(e), { sql });
                }
            }
        };

        if (!columns.has('assistant_name')) addColumn("ALTER TABLE user_profile ADD COLUMN assistant_name TEXT");
        if (!columns.has('goals')) addColumn("ALTER TABLE user_profile ADD COLUMN goals TEXT");
        if (!columns.has('familiarity')) addColumn("ALTER TABLE user_profile ADD COLUMN familiarity TEXT");
        if (!columns.has('learning_mode')) addColumn("ALTER TABLE user_profile ADD COLUMN learning_mode TEXT DEFAULT 'enabled'");
        if (!columns.has('autonomy_level')) addColumn("ALTER TABLE user_profile ADD COLUMN autonomy_level TEXT DEFAULT 'balanced'");
        if (!columns.has('workspace_path')) addColumn("ALTER TABLE user_profile ADD COLUMN workspace_path TEXT");
        if (!columns.has('onboarding_completed')) addColumn("ALTER TABLE user_profile ADD COLUMN onboarding_completed INTEGER DEFAULT 0");
        if (!columns.has('created_at')) addColumn("ALTER TABLE user_profile ADD COLUMN created_at TEXT");

        this.db.exec(`
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

    setUserName(userId: string, name: string): void {
        this.db.prepare('UPDATE user_profile SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?').run(name, userId);
        this.addNode({ id: 'user_identity', type: 'identity', name: name, content: `Nome oficial: ${name}`, confidence: 1.0 });
        try { 
            this.addEdge('core_user', 'user_identity', 'has_identity', 1.0, 1.0); 
        } catch (e) {
            log.warn('bootstrap_edge_failed', errorMessage(e), { from: 'core_user', to: 'user_identity' });
        }
    }

    private bootstrapCoreGraph(): void {
        const nodes: MemoryNode[] = [
            {
                id: 'identity',
                type: 'identity',
                name: 'IDENTITY',
                content: 'Nó-raiz da identidade cognitiva do NewClaw. Conecta agente, usuário, estilo e princípios.'
            },
            {
                id: 'core_identity',
                type: 'identity',
                name: 'IDENTITY CORE',
                content: 'Hub estrutural da identidade cognitiva. Mantido para compatibilidade com curadoria e expansão do grafo.'
            },
            {
                id: 'core_agent',
                type: 'identity',
                name: 'AGENTS',
                content: 'Representa o agente NewClaw, seu papel como copiloto local, memória persistente e capacidade de agir com ferramentas.'
            },
            {
                id: 'core_soul',
                type: 'context',
                name: 'SOUL',
                content: 'Guarda a personalidade, voz, valores e tom do sistema: útil, acolhedor, direto e persistente.'
            },
            {
                id: 'core_tools',
                type: 'skill',
                name: 'TOOLS',
                content: 'Hub das ferramentas disponíveis para pesquisar, editar arquivos, executar comandos, navegar e gerenciar memória.'
            },
            {
                id: 'core_user',
                type: 'identity',
                name: 'USER',
                content: 'Perfil vivo do usuário. Deve ser enriquecido gradualmente com nome, objetivos, preferências, contexto e histórico.'
            },
            {
                id: 'core_heartbeat',
                type: 'fact',
                name: 'HEARTBEAT',
                content: 'Marca o estado inicial do sistema e serve como trilha de vida do agente: instalação, boot, onboarding e eventos importantes.'
            },
            {
                id: 'core_memory',
                type: 'context',
                name: 'MEMORY',
                content: 'Hub da memória semântica persistente. Organiza nós, relações, contexto relevante e recuperação futura.'
            },
            {
                id: 'system_reflection',
                type: 'fact',
                name: 'system_reflection',
                content: 'System initialized with base cognitive graph and awaiting user interaction'
            },
            {
                id: 'agent_state',
                type: 'context',
                name: 'agent_state',
                content: JSON.stringify({
                    mode: 'learning',
                    confidence: 0.5,
                    user_alignment: 0.5,
                    current_focus: 'unknown'
                })
            }
        ];

        for (const node of nodes) {
            const existing = this.db.prepare('SELECT 1 FROM memory_nodes WHERE id = ?').get(node.id);
            if (!existing) {
                this.addNode(node);
            }
        }

        const existingUserPref = this.getNode('pref_workspace');
        if (!existingUserPref) {
            const defaultPath = process.env.WORKSPACE_DIR || '/newclaw/workspace';
            this.addNode({
                id: 'pref_workspace',
                type: 'preference',
                name: 'Workspace',
                content: `Workspace principal do NewClaw em ${defaultPath}`
            });
        }

        const baseEdges: Array<[string, string, string]> = [
            ['identity', 'core_agent', 'related_to'],
            ['identity', 'core_user', 'related_to'],
            ['identity', 'core_soul', 'related_to'],
            ['identity', 'core_memory', 'related_to'],
            ['identity', 'core_identity', 'related_to'],
            ['core_identity', 'core_agent', 'related_to'],
            ['core_identity', 'core_user', 'related_to'],
            ['core_identity', 'core_memory', 'related_to'],
            ['core_agent', 'core_tools', 'uses'],
            ['core_agent', 'core_memory', 'related_to'],
            ['core_agent', 'core_heartbeat', 'created'],
            ['core_user', 'core_memory', 'related_to'],
            ['core_user', 'pref_workspace', 'prefers'],
            ['core_memory', 'core_heartbeat', 'contains'],
            ['core_memory', 'core_tools', 'contains'],
            ['core_soul', 'core_agent', 'related_to']
        ];

        for (const [from, to, relation] of baseEdges) {
            try {
                const hasEdge = this.db.prepare('SELECT 1 FROM memory_edges WHERE from_node = ? AND to_node = ? LIMIT 1').get(from, to);
                if (!hasEdge) {
                    this.addEdge(from, to, relation);
                }
            } catch {
                // Keep bootstrap resilient across ontology changes.
            }
        }
    }

    // === Conversas ===

    getOrCreateConversation(userId: string): string {
        const existing = this.db.prepare('SELECT id, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1').get(userId) as { id: string, updated_at: string } | undefined;
        if (existing) {
            // Se a conversa estiver ociosa há mais de 4 horas, cria uma nova para resetar o contexto curto (evita ghost-context)
            const lastUpdate = new Date(existing.updated_at.replace(' ', 'T') + 'Z').getTime();
            const now = Date.now();
            if ((now - lastUpdate) > 4 * 60 * 60 * 1000) {
                return this.createNewConversation(userId);
            }
            return existing.id;
        }
        return this.createNewConversation(userId);
    }

    createNewConversation(userId: string): string {
        const id = `conv_${userId}_${Date.now()}`;
        this.db.prepare('INSERT INTO conversations (id, user_id) VALUES (?, ?)').run(id, userId);
        return id;
    }

    addMessage(conversationId: string, role: Message['role'], content: string): void {
        this.db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)').run(conversationId, role, content);
        this.db.prepare('UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(conversationId);
        if (role === 'user') this.incrementInteractionCount();
    }

    getRecentMessages(conversationId: string, limit: number = 5): Message[] {
        return this.db.prepare(
            'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?'
        ).all(conversationId, limit).reverse() as Message[];
    }


    /**
     * Search messages in a conversation by keywords (FTS5 or LIKE fallback).
     * Returns up to `limit` messages matching the query, ordered by recency.
     */
    searchMessages(conversationId: string, query: string, limit: number = 6): Message[] {
        // Extract keywords from query (remove stop words, keep meaningful terms)
        const stopWords = new Set(['o', 'a', 'os', 'as', 'de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas', 'um', 'uma', 'uns', 'umas', 'e', 'ou', 'mas', 'se', 'que', 'não', 'para', 'com', 'por', 'como', 'isso', 'esse', 'essa', 'estes', 'estas', 'esse', 'isso', 'aquilo', 'the', 'is', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by']);
        const keywords = query.toLowerCase()
            .replace(/[^\w\sáàãâéèêíìîóòõôúùûç]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 2 && !stopWords.has(w));

        if (keywords.length === 0) return [];

        // Try FTS5 on messages content
        try {
            const results = this.db.prepare(`
                SELECT * FROM messages 
                WHERE conversation_id = ? 
                AND content LIKE '%' || ? || '%'
                ORDER BY created_at DESC 
                LIMIT ?
            `).all(conversationId, `%${keywords[0]}%`, limit) as Message[];

            if (results.length > 0) return results.reverse();
        } catch { /* FTS not available */ }

        // Fallback: LIKE search with multiple keywords
        const conditions = keywords.map(() => 'content LIKE ?').join(' OR ');
        const params = keywords.map(k => `%${k}%`);
        const results = this.db.prepare(`
            SELECT * FROM messages 
            WHERE conversation_id = ? AND (${conditions})
            ORDER BY created_at DESC 
            LIMIT ?
        `).all(conversationId, ...params, limit) as Message[];

        return results.reverse();
    }

    // === Grafo de Memória (como IalClaw) ===

    addNode(node: MemoryNode, source: string = 'unknown'): void {
        const classification = this.classifier.classify(node.content, source, node.metadata);
        
        // Sanitização de Dados: FACT vs INFERENCE pipeline
        if (!this.classifier.shouldPersist(classification.confidence)) {
            log.warn(`[MemoryManager] Preventing persistence of ${classification.confidence} content: ${node.id}`);
            return;
        }

        // Apply classification score if not explicitly set
        const confidenceScore = node.confidence ?? classification.score;

        // Truncate metadata if too large (prevents "Too many properties to enumerate")
        let metadataObj = node.metadata || {};
        let metadataJson = JSON.stringify(metadataObj);
        if (metadataJson.length > 8000) {
            // Keep only top-level string values, truncate each
            const truncated: Record<string, any> = {};
            const keys = Object.keys(metadataObj).slice(0, 20); // max 20 keys
            for (const key of keys) {
                const val = String(metadataObj[key] ?? '');
                truncated[key] = val.length > 500 ? val.slice(0, 500) + '...' : metadataObj[key];
            }
            truncated['_truncated'] = true;
            metadataObj = truncated;
            metadataJson = JSON.stringify(metadataObj);
            log.warn(`[MemoryManager] Truncated metadata for node ${node.id}: ${metadataJson.length} chars`);
        }

        this.db.prepare(`
            INSERT OR REPLACE INTO memory_nodes (id, type, name, content, metadata, weight, confidence, last_updated, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).run(
            node.id, 
            node.type, 
            node.name, 
            node.content, 
            metadataJson,
            node.weight ?? 1.0,
            confidenceScore,
            node.last_updated || new Date().toISOString()
        );

        // Auto-register in node_metrics so the table is never empty for existing nodes
        try {
            this.db.prepare(`
                INSERT OR IGNORE INTO node_metrics (node_id, usage_count, last_accessed_at, reinforcement_score, memory_class)
                VALUES (?, 0, CURRENT_TIMESTAMP, 0.0, 'latent')
            `).run(node.id);
        } catch {
            // node_metrics table may not exist in older schemas
        }
    }

    getNode(id: string): MemoryNode | undefined {
        const row = this.db.prepare('SELECT * FROM memory_nodes WHERE id = ?').get(id) as any;
        if (!row) return undefined;
        return { 
            ...row, 
            metadata: JSON.parse(row.metadata || '{}'),
            weight: row.weight,
            confidence: row.confidence,
            last_updated: row.last_updated
        };
    }

    getNodesByType(type: MemoryNode['type']): MemoryNode[] {
        return this.db.prepare('SELECT * FROM memory_nodes WHERE type = ?').all(type) as MemoryNode[];
    }

    searchNodes(query: string, limit: number = 10): MemoryNode[] {
        // Extract keywords for robust search
        const stopWords = new Set(['o', 'a', 'os', 'as', 'de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas', 'um', 'uma', 'uns', 'umas', 'e', 'ou', 'mas', 'se', 'que', 'não', 'para', 'com', 'por', 'como', 'isso', 'esse', 'essa', 'estes', 'estas', 'esse', 'isso', 'aquilo', 'the', 'is', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by']);
        const keywords = query.toLowerCase()
            .replace(/[^\w\sáàãâéèêíìîóòõôúùûç]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 2 && !stopWords.has(w));

        const searchTokens = keywords.length > 0 ? keywords : [query];

        // 1. Try FTS5 full-text search with OR logic
        try {
            const ftsQuery = searchTokens.join(' OR ');
            const ftsResults = this.db.prepare(`
                SELECT n.* FROM memory_nodes n
                JOIN memory_nodes_fts f ON f.rowid = n.rowid
                WHERE memory_nodes_fts MATCH ?
                ORDER BY rank LIMIT ?
            `).all(ftsQuery, limit) as MemoryNode[];
            if (ftsResults.length > 0) return ftsResults;
        } catch { /* FTS5 might fail on special chars */ }

        // 2. Fallback to LIKE with OR logic
        const conditions = searchTokens.map(() => '(name LIKE ? OR content LIKE ?)').join(' OR ');
        const params = searchTokens.flatMap(k => [`%${k}%`, `%${k}%`]);
        
        return this.db.prepare(`
            SELECT * FROM memory_nodes 
            WHERE ${conditions}
            ORDER BY updated_at DESC LIMIT ?
        `).all(...params, limit) as MemoryNode[];
    }

    /**
     * Semantic search using embeddings (cosine similarity)
     * Requires embedding for query — generates on the fly via Ollama
     */
    async semanticSearch(query: string, limit: number = 5): Promise<Array<MemoryNode & { score: number }>> {
        const results: Array<MemoryNode & { score: number }> = [];
        const foundIds = new Set<string>();

        // 1. Try embedding search
        const queryEmbedding = await this.generateEmbedding(query);
        if (queryEmbedding) {
            const rows = this.db.prepare(
                'SELECT node_id, embedding FROM memory_embeddings'
            ).all() as Array<{ node_id: string; embedding: Buffer }>;

            if (rows.length > 0) {
                const queryVec = new Float64Array(queryEmbedding);
                const scored: Array<{ nodeId: string; score: number }> = [];

                for (const row of rows) {
                    const nodeVec = new Float64Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 8);
                    const similarity = this.cosineSimilarity(queryVec, nodeVec);
                    scored.push({ nodeId: row.node_id, score: similarity });
                }

                scored.sort((a, b) => b.score - a.score);
                for (const item of scored) {
                    if (item.score < 0.3) continue;
                    if (results.length >= limit) break;
                    const node = this.getNode(item.nodeId);
                    if (node) {
                        results.push({ ...node, score: item.score });
                        foundIds.add(item.nodeId);
                    }
                }
            }
        }

        // 2. Fill remaining with FTS5/LIKE
        if (results.length < limit) {
            const textResults = this.searchNodes(query, limit);
            for (const node of textResults) {
                if (foundIds.has(node.id)) continue;
                if (results.length >= limit) break;
                results.push({ ...node, score: 0.4 }); // FTS5/LIKE gets lower score
                foundIds.add(node.id);
            }
        }

        return results;
    }


    /**
     * Semantic search with Attention Layer — contextual, prioritized retrieval.
     * Falls back to plain semanticSearch if AttentionLayer is not available.
     */
    async semanticSearchWithAttention(query: string, limit: number = 5): Promise<Array<MemoryNode & { score: number; attentionScore?: number }>> {
        // 1. Get embedding candidates (wider pool for attention re-ranking)
        const embeddingResults: Array<{ nodeId: string; score: number }> = [];
        const queryEmbedding = await this.generateEmbedding(query);

        if (queryEmbedding) {
            const rows = this.db.prepare(
                'SELECT node_id, embedding FROM memory_embeddings'
            ).all() as Array<{ node_id: string; embedding: Buffer }>;

            if (rows.length > 0) {
                const queryVec = new Float64Array(queryEmbedding);
                for (const row of rows) {
                    const nodeVec = new Float64Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 8);
                    const similarity = this.cosineSimilarity(queryVec, nodeVec);
                    if (similarity >= 0.25) {
                        embeddingResults.push({ nodeId: row.node_id, score: similarity });
                    }
                }
            }
        }

        // 2. If AttentionLayer available, use attention-based re-ranking
        if (this.attentionLayer) {
            const attentionResults = this.attentionLayer.searchWithAttention(embeddingResults, limit);

            // Convert to MemoryNode format
            const results: Array<MemoryNode & { score: number; attentionScore: number }> = [];
            for (const ar of attentionResults) {
                const node = this.getNode(ar.nodeId);
                if (node) {
                    results.push({
                        ...node,
                        score: ar.attentionScore,
                        attentionScore: ar.attentionScore,
                    });
                }
            }

            // Touch accessed nodes in context
            this.attentionLayer.touchNodes(results.map(r => r.id));

            // Record feedback (co-usage)
            if (this.attentionFeedback) {
                this.attentionFeedback.recordCoUsage(results.map(r => r.id));
            }

            return results;
        }

        // 3. Fallback to plain semanticSearch
        return this.semanticSearch(query, limit);
    }

    /**
     * Get the AttentionLayer instance (for external access).
     */
    getAttentionFeedback(): AttentionFeedback | null {
        return this.attentionFeedback;
    }

    getAttentionLayer(): AttentionLayer | null {
        return this.attentionLayer;
    }

    private async generateEmbedding(text: string): Promise<Float64Array | null> {
        try {
            const response = await fetch('http://localhost:11434/api/embeddings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'nomic-embed-text:latest', prompt: text })
            });
            if (!response.ok) return null;
            const data = await response.json() as any;
            const embedding = data.embedding;
            if (!embedding) return null;
            return new Float64Array(embedding);
        } catch {
            return null;
        }
    }

    private cosineSimilarity(a: Float64Array, b: Float64Array): number {
        let dot = 0, normA = 0, normB = 0;
        const len = Math.min(a.length, b.length);
        for (let i = 0; i < len; i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        const denom = Math.sqrt(normA) * Math.sqrt(normB);
        return denom === 0 ? 0 : dot / denom;
    }

    addEdge(from: string, to: string, relation: string, weight: number = 1.0, confidence: number = 1.0): void {
        // Validate relation ontology
        const fromNode = this.getNode(from);
        const toNode = this.getNode(to);
        if (fromNode && toNode) {
            if (!this.validateRelation(fromNode.type, relation, toNode.type)) {
                // Fallback: try 'related_to' which accepts all types
                if (this.validateRelation(fromNode.type, 'related_to', toNode.type)) {
                    log.warn(`[MemoryManager] Relation "${relation}" invalid for ${fromNode.type}->${toNode.type}. Falling back to "related_to".`);
                    relation = 'related_to';
                } else if (this.validateRelation(fromNode.type, 'has_trait', toNode.type)) {
                    log.warn(`[MemoryManager] Relation "${relation}" invalid for ${fromNode.type}->${toNode.type}. Falling back to "has_trait".`);
                    relation = 'has_trait';
                } else {
                    log.warn(`[MemoryManager] No valid relation for ${fromNode.type}->${toNode.type}. Using "related_to" as last resort.`);
                    relation = 'related_to';
                }
            }
        }
        this.db.prepare(`
            INSERT OR REPLACE INTO memory_edges (from_node, to_node, relation, weight, confidence)
            VALUES (?, ?, ?, ?, ?)
        `).run(from, to, relation, weight, confidence);
    }

    /** Add an edge and optionally its inverse relation */
    addEdgeWithInverse(from: string, to: string, relation: string, weight: number = 1.0, confidence: number = 1.0): string[] {
        this.addEdge(from, to, relation, weight, confidence);
        const created: string[] = [`${from} --${relation}--> ${to}`];
        const inverse = this.inverseRelations[relation];
        if (inverse) {
            this.addEdge(to, from, inverse, weight, confidence);
            created.push(`${to} --${inverse}--> ${from}`);
        }
        return created;
    }

    getInverseRelationMap(): Record<string, string> {
        return { ...this.inverseRelations };
    }

    getRelatedNodes(nodeId: string, relation?: string): MemoryNode[] {
        const sql = relation
            ? `SELECT n.* FROM memory_nodes n JOIN memory_edges e ON n.id = e.to_node WHERE e.from_node = ? AND e.relation = ?`
            : `SELECT n.* FROM memory_nodes n JOIN memory_edges e ON n.id = e.to_node WHERE e.from_node = ?`;
        const params = relation ? [nodeId, relation] : [nodeId];
        return this.db.prepare(sql).all(...params) as MemoryNode[];
    }

    // === Identidade e Preferências ===

    getIdentity(): MemoryNode | undefined {
        return this.getNode('identity');
    }

    setIdentity(name: string, content: string): void {
        this.addNode({ id: 'identity', type: 'identity', name, content });
    }

    getPreferences(): MemoryNode[] {
        return this.getNodesByType('preference');
    }

    addPreference(name: string, content: string): void {
        this.addNode({ id: `pref_${name}`, type: 'preference', name, content });
    }

    // === Contexto ===

    getContext(maxChars: number = 1500): string {
        const identity = this.getIdentity();
        const preferences = this.getPreferences();
        const projects = this.getNodesByType('project');
        // Top 3 facts by pagerank for compact context
        const allFacts = this.getNodesByType('fact');
        const facts = allFacts.sort((a, b) => (b.pagerank || 0) - (a.pagerank || 0)).slice(0, 3);

        let context = '';
        if (identity) context += `Identidade: ${identity.name} - ${(identity.content || '').slice(0, 120)}\n`;
        if (preferences.length) context += `Preferências: ${preferences.map(p => (p.content || '').slice(0, 80)).join(', ')}\n`;
        if (projects.length) context += `Projetos: ${projects.map(p => `${p.name}: ${(p.content || '').slice(0, 80)}`).join(', ')}\n`;
        if (facts.length) context += `Fatos: ${facts.map(f => (f.content || '').slice(0, 100)).join('; ')}\n`;

        // Inject core knowledge nodes (tools, workspace, structure)
        const coreNodes = this.db.prepare(
            "SELECT id, name, content FROM memory_nodes WHERE id LIKE 'core_%' OR id = 'pref_workspace' ORDER BY id"
        ).all() as Array<{id: string; name: string; content: string}>;
        if (coreNodes.length) {
            context += '\nConhecimento do sistema:\n';
            for (const node of coreNodes) {
                const snippet = (node.content || '').slice(0, 150);
                context += `- ${node.name}: ${snippet}\n`;
            }
        }

        // Hard limit
        if (context.length > maxChars) {
            context = context.substring(0, maxChars) + '...[truncado]';
        }

        return context;
    }

    // === Metrics History (Bloco 4) ===

    /**
     * Record current metrics snapshot for all nodes
     */
    recordMetricsSnapshot(): number {
        const nodes = this.db.prepare(
            'SELECT id, pagerank, degree, betweenness, closeness, community_id FROM memory_nodes'
        ).all() as Array<{ id: string; pagerank: number; degree: number; betweenness: number; closeness: number; community_id: number }>;

        const stmt = this.db.prepare(
            'INSERT INTO memory_metrics_history (node_id, pagerank, degree, betweenness, closeness, community_id) VALUES (?, ?, ?, ?, ?, ?)'
        );
        const transaction = this.db.transaction((rows: typeof nodes) => {
            for (const n of rows) {
                stmt.run(n.id, n.pagerank || 0, n.degree || 0, n.betweenness || 0, n.closeness || 0, n.community_id || 0);
            }
        });
        transaction(nodes);
        return nodes.length;
    }

    // === Snapshots do grafo ===

    createSnapshot(label?: string): string {
        const id = `snap_${Date.now()}`;
        const nodes = this.db.prepare('SELECT * FROM memory_nodes').all();
        const edges = this.db.prepare('SELECT * FROM memory_edges').all();
        const snapshotData = JSON.stringify({ nodes, edges });
        this.db.prepare(`
            INSERT INTO graph_snapshots (id, label, node_count, edge_count, snapshot_data)
            VALUES (?, ?, ?, ?, ?)
        `).run(id, label || `Snapshot ${new Date().toISOString()}`, nodes.length, edges.length, snapshotData);
        return id;
    }

    listSnapshots(): { id: string; label: string; node_count: number; edge_count: number; created_at: string }[] {
        return this.db.prepare('SELECT id, label, node_count, edge_count, created_at FROM graph_snapshots ORDER BY created_at DESC').all() as any[];
    }

    restoreSnapshot(id: string): boolean {
        const row = this.db.prepare('SELECT * FROM graph_snapshots WHERE id = ?').get(id) as any;
        if (!row) return false;
        const data = JSON.parse(row.snapshot_data);

        const restoreTransaction = this.db.transaction(() => {
            this.db.exec('DELETE FROM memory_edges');
            this.db.exec('DELETE FROM memory_nodes');

            const insertNode = this.db.prepare(
                `INSERT OR REPLACE INTO memory_nodes
                 (id, type, name, content, metadata, pagerank, degree, betweenness, closeness, community_id, weight, confidence, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            );
            for (const n of data.nodes) {
                insertNode.run(
                    n.id, n.type, n.name, n.content, n.metadata,
                    n.pagerank || 0, n.degree || 0, n.betweenness || 0, n.closeness || 0, n.community_id || 0,
                    n.weight || 1.0, n.confidence || 1.0,
                    n.created_at, n.updated_at
                );
            }

            const insertEdge = this.db.prepare(
                `INSERT OR REPLACE INTO memory_edges (from_node, to_node, relation, weight, confidence, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)`
            );
            for (const e of data.edges) {
                insertEdge.run(e.from_node, e.to_node, e.relation, e.weight, e.confidence || 1.0, e.created_at);
            }
        });

        restoreTransaction();
        return true;
    }

    deleteSnapshot(id: string): boolean {
        return this.db.prepare('DELETE FROM graph_snapshots WHERE id = ?').run(id).changes > 0;
    }

    close(): void {
        this.attentionFeedback?.stopBackgroundJobs();
        this.db.close();
    }

    // ── Settings (key-value in memory table) ──

    getSetting(key: string): string | null {
        try {
            const row = this.db.prepare('SELECT value FROM memory WHERE key = ?').get(key) as any;
            return row?.value || null;
        } catch {
            return null;
        }
    }

    setSetting(key: string, value: string, category: string = 'system'): void {
        this.db.prepare('INSERT OR REPLACE INTO memory (key, value, category, updated_at) VALUES (?, ?, ?, datetime("now"))').run(key, value, category);
    }

    // ── User Profile ──

    getUserProfile(userId: string): { name: string; language_preference: string; response_style: string; expertise: string } | null {
        try {
            return this.db.prepare('SELECT name, language_preference, response_style, expertise FROM user_profile WHERE user_id = ?').get(userId) as any;
        } catch {
            return null;
        }
    }

    /**
     * Persist an agent execution trace step
     */
    public saveTrace(trace: {
        id: string;
        conversation_id?: string;
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
                INSERT INTO agent_traces (id, conversation_id, step, decision, tool, input, output, provider, duration_ms)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                trace.id,
                trace.conversation_id || null,
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
