/**
 * CognitiveMemoryIndex — Índice leve de resumos cognitivos por nó
 *
 * Cada nó de memória tem um resumo compacto (~120 chars) e metadados de
 * seleção (tier, importância, permanência, keywords) persistidos em SQLite.
 *
 * Invalidação por hash: quando name+content de um nó muda, o índice
 * reconstrói automaticamente o resumo na próxima chamada.
 *
 * Custo por query: O(k) lookups indexados + build apenas para nós stale.
 * Nenhuma chamada LLM — summary determinístico via template.
 */

import { createHash } from 'crypto';
import type Database from 'better-sqlite3';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('CognIndex');

// ── Tipos públicos ────────────────────────────────────────────────────────────

/**
 * Tier cognitivo: define prioridade na seleção de contexto.
 *   0 = Core Identity  → nunca descartado
 *   1 = Permanente     → preferências, traços pessoais — quasi-nunca descartado
 *   2 = Entidades Ativas → projetos, infra, contextos operacionais
 *   3 = Episódico      → fatos, eventos recentes
 *   4 = Reflexivo      → skills, regras, estratégias, conhecimento geral
 */
export enum MemoryTier {
    CORE_IDENTITY   = 0,
    PERMANENT       = 1,
    ACTIVE_ENTITIES = 2,
    EPISODIC        = 3,
    REFLECTION      = 4,
}

export interface MemoryIndexEntry {
    nodeId:     string;
    type:       string;
    entity:     string;      // entidade principal extraída do nome
    summary:    string;      // resumo compacto ≤ 120 chars
    keywords:   string[];    // termos-chave para matching rápido
    importance: number;      // 0-1 calculado por tipo + scope + confidence
    permanence: number;      // 0-1 quão permanente é esta memória
    tier:       MemoryTier;
    updatedAt:  number;      // unix ms do último build do índice
    nodeHash:   string;      // hash curto de name+content para invalidação
}

// Linha interna vinda do SQLite (snake_case)
interface IndexRow {
    node_id:    string;
    type:       string;
    entity:     string;
    summary:    string;
    keywords:   string;   // JSON array serializado
    importance: number;
    permanence: number;
    tier:       number;
    updated_at: number;
    node_hash:  string;
}

// ── Classe principal ──────────────────────────────────────────────────────────

export class CognitiveMemoryIndex {
    constructor(private readonly db: Database.Database) {
        this.ensureSchema();
    }

    // ── API pública ──────────────────────────────────────────────────────────

    /**
     * Retorna summaries para uma lista de nodeIds.
     * Entradas ausentes ou stale são reconstruídas e persistidas.
     */
    getSummaries(nodeIds: string[]): MemoryIndexEntry[] {
        if (nodeIds.length === 0) return [];

        const placeholders = nodeIds.map(() => '?').join(',');

        // Carregar nós do DB (apenas os campos necessários para o hash)
        const nodes = this.db.prepare(`
            SELECT id, type, name, content,
                   confidence, identity_scope, lifecycle_state, updated_at
            FROM memory_nodes
            WHERE id IN (${placeholders})
              AND (lifecycle_state IS NULL OR lifecycle_state NOT IN ('EXPIRED'))
        `).all(...nodeIds) as Array<{
            id: string; type: string; name: string; content: string;
            confidence: number; identity_scope: string;
            lifecycle_state: string; updated_at: string;
        }>;

        if (nodes.length === 0) return [];

        // Carregar entradas de índice existentes
        const existingRows = this.db.prepare(
            `SELECT * FROM memory_index WHERE node_id IN (${placeholders})`
        ).all(...nodeIds) as IndexRow[];

        const cached = new Map<string, IndexRow>(existingRows.map(r => [r.node_id, r]));

        const results: MemoryIndexEntry[] = [];
        const toUpsert: MemoryIndexEntry[] = [];

        for (const node of nodes) {
            const hash = computeHash(node.name, node.content);
            const row  = cached.get(node.id);

            if (row && row.node_hash === hash) {
                results.push(rowToEntry(row));
            } else {
                const entry = this.buildEntry(node, hash);
                results.push(entry);
                toUpsert.push(entry);
            }
        }

        if (toUpsert.length > 0) {
            this.upsertBatch(toUpsert);
            log.debug('index_refreshed', `Built/updated ${toUpsert.length} entries`);
        }

        return results;
    }

    /**
     * Retorna summaries de TODOS os nós de Tier 0 e Tier 1 (identity, preference, trait).
     * Usados pelo ContextPlanner para injetar memória permanente mesmo quando
     * fora do resultado da busca semântica.
     */
    getPermanentSummaries(): MemoryIndexEntry[] {
        // Include ARCHIVED nodes for permanent types — core identity, preferences and traits
        // should remain in the index even if MemoryGovernor archived them due to low confidence.
        // Only truly EXPIRED nodes (TTL-based) are excluded.
        const nodes = this.db.prepare(`
            SELECT id FROM memory_nodes
            WHERE (
                type IN ('identity', 'preference', 'trait')
                OR id LIKE 'core_%'
                OR id LIKE 'user_%'
                OR id = 'user_identity'
            )
            AND (lifecycle_state IS NULL OR lifecycle_state IN ('ACTIVE', 'ARCHIVED'))
            LIMIT 60
        `).all() as Array<{ id: string }>;

        return this.getSummaries(nodes.map(n => n.id));
    }

    /** Invalida uma entrada específica (força rebuild na próxima chamada). */
    invalidate(nodeId: string): void {
        this.db.prepare('DELETE FROM memory_index WHERE node_id = ?').run(nodeId);
    }

    /** Reconstrói índice para os N nós mais recentes. Uso em manutenção. */
    rebuildRecent(limit = 500): number {
        const rows = this.db.prepare(`
            SELECT id FROM memory_nodes
            WHERE lifecycle_state NOT IN ('EXPIRED', 'SUMMARIZED')
            ORDER BY updated_at DESC LIMIT ?
        `).all(limit) as Array<{ id: string }>;
        this.getSummaries(rows.map(r => r.id));
        return rows.length;
    }

    // ── Internos ─────────────────────────────────────────────────────────────

    private ensureSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS memory_index (
                node_id     TEXT PRIMARY KEY,
                type        TEXT    NOT NULL,
                entity      TEXT    DEFAULT '',
                summary     TEXT    NOT NULL,
                keywords    TEXT    DEFAULT '[]',
                importance  REAL    DEFAULT 0.5,
                permanence  REAL    DEFAULT 0.5,
                tier        INTEGER DEFAULT 3,
                updated_at  INTEGER NOT NULL,
                node_hash   TEXT    NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_cogn_index_tier
                ON memory_index(tier);
            CREATE INDEX IF NOT EXISTS idx_cogn_index_importance
                ON memory_index(importance DESC);
        `);
    }

    private buildEntry(node: {
        id: string; type: string; name: string; content: string;
        confidence: number; identity_scope: string; updated_at: string;
    }, hash: string): MemoryIndexEntry {
        return {
            nodeId:     node.id,
            type:       node.type,
            entity:     extractEntity(node.name),
            summary:    buildSummary(node.name, node.content),
            keywords:   extractKeywords(node.name, node.content),
            importance: computeImportance(node),
            permanence: computePermanence(node.type),
            tier:       classifyTier(node.id, node.type),
            updatedAt:  Date.now(),
            nodeHash:   hash,
        };
    }

    private upsertBatch(entries: MemoryIndexEntry[]): void {
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO memory_index
              (node_id, type, entity, summary, keywords,
               importance, permanence, tier, updated_at, node_hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const run = this.db.transaction((batch: MemoryIndexEntry[]) => {
            for (const e of batch) {
                stmt.run(
                    e.nodeId, e.type, e.entity, e.summary,
                    JSON.stringify(e.keywords),
                    e.importance, e.permanence, e.tier,
                    e.updatedAt, e.nodeHash
                );
            }
        });
        run(entries);
    }
}

// ── Funções puras (fora da classe para testabilidade) ─────────────────────────

function computeHash(name: string, content: string): string {
    return createHash('md5')
        .update(`${name}|${content ?? ''}`)
        .digest('hex')
        .slice(0, 8);
}

function rowToEntry(row: IndexRow): MemoryIndexEntry {
    return {
        nodeId:     row.node_id,
        type:       row.type,
        entity:     row.entity  ?? '',
        summary:    row.summary,
        keywords:   tryParseJson(row.keywords, []),
        importance: row.importance,
        permanence: row.permanence,
        tier:       row.tier as MemoryTier,
        updatedAt:  row.updated_at,
        nodeHash:   row.node_hash,
    };
}

function tryParseJson<T>(val: string, fallback: T): T {
    try { return JSON.parse(val) as T; } catch { return fallback; }
}

/** Resumo de 1 linha, máx 120 chars. Determinístico, sem LLM. */
function buildSummary(name: string, content: string): string {
    const text = (content ?? '').trim();
    if (!text) return name.slice(0, 120);
    // Primeira frase significativa
    const first = text.split(/[.!\n]/)[0].trim();
    const base  = first.length >= 15 ? first : text;
    return base.slice(0, 120);
}

/** Entidade principal: primeira palavra "inteligível" do nome do nó. */
function extractEntity(name: string): string {
    return (name || '')
        .replace(/[_\-]/g, ' ')
        .split(/\s+/)[0]
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

const STOP = new Set([
    'o','a','os','as','de','do','da','dos','das','em','no','na','e',
    'para','com','por','que','não','the','is','an','and','or','of',
    'to','in','at','on','as','this','it','be','was','are','have',
]);

/** Extrai até 8 keywords relevantes do nome + conteúdo. */
function extractKeywords(name: string, content: string): string[] {
    const text = `${name} ${content ?? ''}`.toLowerCase();
    const words = text
        .split(/\W+/)
        .filter(w => w.length >= 3 && !STOP.has(w));
    return [...new Set(words)].slice(0, 8);
}

/** Importância base por tipo de nó, ajustada por scope e confidence. */
function computeImportance(node: {
    type: string; confidence?: number; identity_scope?: string
}): number {
    const BASE: Record<string, number> = {
        identity:       0.95,
        preference:     0.85,
        trait:          0.80,
        project:        0.70,
        infrastructure: 0.65,
        context:        0.60,
        skill:          0.58,
        knowledge:      0.55,
        rule:           0.55,
        strategy:       0.55,
        fact:           0.40,
        domain:         0.30,
    };
    let base = BASE[node.type] ?? 0.50;
    if (node.identity_scope === 'USER_MEMORY')   base = Math.min(1.0, base * 1.2);
    if (node.identity_scope === 'SYSTEM_MEMORY') base *= 0.9;
    return Math.min(1.0, base * (node.confidence ?? 1.0));
}

/** Permanência: quão "eterno" é um nó (preferências = quase imutáveis, fatos = efêmeros). */
function computePermanence(type: string): number {
    const MAP: Record<string, number> = {
        identity:       1.0,
        preference:     0.95,
        trait:          0.90,
        rule:           0.85,
        strategy:       0.80,
        skill:          0.75,
        knowledge:      0.70,
        project:        0.65,
        infrastructure: 0.65,
        context:        0.50,
        fact:           0.25,
        domain:         0.90,
    };
    return MAP[type] ?? 0.50;
}

/** Classifica o tier cognitivo com base no ID e tipo do nó. */
function classifyTier(id: string, type: string): MemoryTier {
    if (id.startsWith('core_') || id === 'user_identity' || type === 'identity')
        return MemoryTier.CORE_IDENTITY;
    if (type === 'preference' || type === 'trait')
        return MemoryTier.PERMANENT;
    if (type === 'project' || type === 'infrastructure' || type === 'context')
        return MemoryTier.ACTIVE_ENTITIES;
    if (type === 'fact')
        return MemoryTier.EPISODIC;
    return MemoryTier.REFLECTION; // skill, rule, strategy, knowledge, domain
}
