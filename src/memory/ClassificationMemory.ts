/**
 * ClassificationMemory — Classificação adaptativa por contexto
 * 
 * Adaptado do IalClaw para o NewClaw com persistência SQLite.
 * Classifica inputs por contexto (terminal, coding, chat, analysis)
 * e aprende com sucesso/falha para priorizar respostas.
 */
import { Database } from 'better-sqlite3';

type MemoryContext = 'terminal' | 'coding' | 'chat' | 'analysis' | 'crypto' | 'trading';

export interface ClassificationResult {
    type: string;
    context: MemoryContext;
    confidence: number;
    source: 'context' | 'global';
}

export class ClassificationMemory {
    private db: Database;

    constructor(db: Database) {
        this.db = db;
        this.initializeSchema();
    }

    private initializeSchema(): void {
        const tryAdd = (stmt: string) => { try { this.db.exec(stmt); } catch { /* exists */ } };

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS memory_classifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                input_hash TEXT NOT NULL,
                input_text TEXT NOT NULL,
                normalized TEXT NOT NULL,
                type TEXT NOT NULL,
                context TEXT NOT NULL,
                confidence REAL DEFAULT 0.5,
                hits INTEGER DEFAULT 1,
                penalty_count INTEGER DEFAULT 0,
                last_used TEXT DEFAULT CURRENT_TIMESTAMP,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(input_hash, context)
            )
        `);
        tryAdd('CREATE INDEX IF NOT EXISTS idx_classifications_hash ON memory_classifications(input_hash)');
        tryAdd('CREATE INDEX IF NOT EXISTS idx_classifications_context ON memory_classifications(context)');
        tryAdd('CREATE INDEX IF NOT EXISTS idx_classifications_type ON memory_classifications(type)');

        // Add context columns to memory_nodes if not exists
        tryAdd('ALTER TABLE memory_nodes ADD COLUMN context_type TEXT');
        tryAdd('ALTER TABLE memory_nodes ADD COLUMN classification_score REAL DEFAULT 0');
    }

    /**
     * Detect context from input text
     */
    detectContext(input: string): MemoryContext {
        const n = input.toLowerCase();

        // Terminal: shell commands
        if (/\b(npm|npx|yarn|pnpm|pip|apt|brew|git|docker|kubectl|bash|sh|sudo|systemctl|ssh)\b/.test(n)) return 'terminal';
        if (/\b(install|run|build|start|stop|exec|deploy|pull|push)\b/.test(n)) return 'terminal';

        // Crypto/Trading
        if (/\b(btc|eth|bitcoin|ethereum|crypto|trading|preço|cotação|coin|token|portfolio|patrimônio)\b/.test(n)) return 'trading';

        // Coding: source code
        if (/\b(function|class|interface|type|const|let|var|def|async|await|import|export)\b/.test(n)) return 'coding';
        if (/\.(ts|js|py|go|rs|java|cpp|c|cs)\b/.test(n)) return 'coding';
        if (/[{}()\[\];]/.test(n) && /\b(return|if|else|for|while)\b/.test(n)) return 'coding';

        // Chat: questions
        if (/\?\s*$/.test(n)) return 'chat';
        if (/^(o que|qual|como|quando|onde|por que|porque|what|how|when|where|why|busque|busca)\b/i.test(n)) return 'chat';

        return 'analysis';
    }

    /**
     * Normalize text for comparison
     */
    private normalize(text: string): string {
        return text.toLowerCase().replace(/[^\w\s]/g, '').trim();
    }

    /**
     * Simple hash for input
     */
    private hash(text: string): string {
        let h = 0;
        for (let i = 0; i < text.length; i++) {
            h = ((h << 5) - h + text.charCodeAt(i)) | 0;
        }
        return Math.abs(h).toString(36);
    }

    /**
     * Jaccard similarity between two texts
     */
    private similarity(a: string, b: string): number {
        const aWords = new Set(a.split(/\s+/).filter(w => w.length > 2));
        const bWords = new Set(b.split(/\s+/).filter(w => w.length > 2));
        if (aWords.size === 0 || bWords.size === 0) return 0;
        const intersection = [...aWords].filter(w => bWords.has(w)).length;
        const union = new Set([...aWords, ...bWords]).size;
        return union === 0 ? 0 : intersection / union;
    }

    /**
     * Find best matching classification
     */
    find(input: string): ClassificationResult | null {
        const context = this.detectContext(input);
        const normalized = this.normalize(input);
        const hash = this.hash(normalized);

        // 1. Exact match in same context
        const exact = this.db.prepare(
            'SELECT * FROM memory_classifications WHERE input_hash = ? AND context = ?'
        ).get(hash, context) as any;

        if (exact) {
            this.db.prepare(
                'UPDATE memory_classifications SET hits = hits + 1, last_used = CURRENT_TIMESTAMP WHERE id = ?'
            ).run(exact.id);
            return {
                type: exact.type,
                context: exact.context,
                confidence: Math.min(exact.confidence + 0.05, 1.0),
                source: 'context'
            };
        }

        // 2. Fuzzy match in same context
        const contextRows = this.db.prepare(
            'SELECT * FROM memory_classifications WHERE context = ? ORDER BY hits DESC LIMIT 20'
        ).all(context) as any[];

        let bestMatch: any = null;
        let bestScore = 0;
        const MIN_SIMILARITY = 0.5;

        for (const row of contextRows) {
            const sim = this.similarity(normalized, row.normalized);
            const score = sim * (1 + row.hits * 0.1) * (row.penalty_count > 3 ? 0.5 : 1);
            if (sim >= MIN_SIMILARITY && score > bestScore) {
                bestScore = score;
                bestMatch = row;
            }
        }

        if (bestMatch) {
            return {
                type: bestMatch.type,
                context: bestMatch.context,
                confidence: bestScore * 0.8,
                source: 'context'
            };
        }

        // 3. Global fuzzy match (with penalty)
        const globalRows = this.db.prepare(
            'SELECT * FROM memory_classifications ORDER BY hits DESC LIMIT 20'
        ).all() as any[];

        for (const row of globalRows) {
            const sim = this.similarity(normalized, row.normalized);
            const score = sim * (1 + row.hits * 0.1) * 0.9; // global penalty
            if (sim >= MIN_SIMILARITY && score > bestScore) {
                bestScore = score;
                bestMatch = row;
            }
        }

        if (bestMatch) {
            return {
                type: bestMatch.type,
                context: context, // Use detected context, not stored
                confidence: bestScore * 0.7,
                source: 'global'
            };
        }

        return null;
    }

    /**
     * Store a classification
     */
    store(input: string, type: string, confidence: number): void {
        const context = this.detectContext(input);
        const normalized = this.normalize(input);
        const hash = this.hash(normalized);

        this.db.prepare(`
            INSERT OR REPLACE INTO memory_classifications (input_hash, input_text, normalized, type, context, confidence, hits, last_used)
            VALUES (?, ?, ?, ?, ?, ?, 
                COALESCE((SELECT hits FROM memory_classifications WHERE input_hash = ? AND context = ?), 0) + 1,
                CURRENT_TIMESTAMP)
        `).run(hash, input.substring(0, 500), normalized, type, context, confidence, hash, context);
    }

    /**
     * Penalize a classification (wrong response)
     */
    penalize(input: string): void {
        const hash = this.hash(this.normalize(input));
        this.db.prepare(
            'UPDATE memory_classifications SET penalty_count = penalty_count + 1 WHERE input_hash = ?'
        ).run(hash);
    }

    /**
     * Apply time decay to old entries
     */
    decay(): number {
        const result = this.db.prepare(`
            DELETE FROM memory_classifications 
            WHERE hits <= 1 
              AND penalty_count >= 3 
              AND last_used < datetime('now', '-7 days')
        `).run();
        return result.changes;
    }

    /**
     * Get stats
     */
    stats(): { total: number; byContext: Record<string, number>; byType: Record<string, number> } {
        const total = (this.db.prepare('SELECT COUNT(*) as c FROM memory_classifications').get() as any).c;
        const byContext: Record<string, number> = {};
        const contextRows = this.db.prepare('SELECT context, COUNT(*) as c FROM memory_classifications GROUP BY context').all() as any[];
        for (const r of contextRows) byContext[r.context] = r.c;

        const byType: Record<string, number> = {};
        const typeRows = this.db.prepare('SELECT type, COUNT(*) as c FROM memory_classifications GROUP BY type').all() as any[];
        for (const r of typeRows) byType[r.type] = r.c;

        return { total, byContext, byType };
    }
}