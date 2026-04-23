/**
 * EmbeddingService — Geração e busca de embeddings via Ollama
 *
 * Usa nomic-embed-text (768 dim) por padrão.
 * Fallback automático para FTS5 se embeddings não disponíveis.
 */
import { Database } from 'better-sqlite3';

const DEFAULT_EMBED_MODEL = 'nomic-embed-text';
const EMBED_DIM = 768;

export class EmbeddingService {
    private ollamaUrl: string;
    private model: string;
    private db: Database;

    constructor(db: Database, ollamaUrl: string = 'http://localhost:11434', model: string = DEFAULT_EMBED_MODEL) {
        this.db = db;
        this.ollamaUrl = ollamaUrl;
        this.model = model;
        this.initializeSchema();
    }

    private initializeSchema(): void {
        // Store embeddings as JSON BLOB (sqlite-vss requires custom build — use raw storage)
        const tryAdd = (stmt: string) => { try { this.db.exec(stmt); } catch { /* exists */ } };
        tryAdd(`
            CREATE TABLE IF NOT EXISTS memory_embeddings (
                node_id TEXT PRIMARY KEY,
                embedding BLOB NOT NULL,
                model TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (node_id) REFERENCES memory_nodes(id)
            )
        `);
        tryAdd('CREATE INDEX IF NOT EXISTS idx_embeddings_node ON memory_embeddings(node_id)');
    }

    /**
     * Generate embedding via Ollama API
     */
    async embed(text: string): Promise<number[] | null> {
        try {
            const res = await fetch(`${this.ollamaUrl}/api/embeddings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: this.model, prompt: text })
            });
            if (!res.ok) return null;
            const data = await res.json() as any;
            return data.embedding || null;
        } catch {
            return null;
        }
    }

    /**
     * Generate and store embedding for a node
     */
    async embedNode(nodeId: string, text: string): Promise<boolean> {
        const embedding = await this.embed(text);
        if (!embedding) return false;

        const blob = Buffer.from(new Float64Array(embedding).buffer);
        this.db.prepare(`
            INSERT OR REPLACE INTO memory_embeddings (node_id, embedding, model, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        `).run(nodeId, blob, this.model);
        return true;
    }

    /**
     * Batch embed all nodes that don't have embeddings yet
     */
    async embedMissing(limit: number = 50): Promise<number> {
        const nodes = this.db.prepare(`
            SELECT n.id, n.name, n.content
            FROM memory_nodes n
            LEFT JOIN memory_embeddings e ON n.id = e.node_id
            WHERE e.node_id IS NULL
            LIMIT ?
        `).all(limit) as Array<{ id: string; name: string; content: string }>;

        let count = 0;
        for (const node of nodes) {
            const text = `${node.name} ${node.content}`;
            const ok = await this.embedNode(node.id, text);
            if (ok) count++;
            // Rate limit: 100ms between calls
            await new Promise(r => setTimeout(r, 100));
        }
        return count;
    }

    /**
     * Cosine similarity between two vectors
     */
    private cosineSimilarity(a: number[], b: number[]): number {
        let dot = 0, normA = 0, normB = 0;
        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        const denom = Math.sqrt(normA) * Math.sqrt(normB);
        return denom === 0 ? 0 : dot / denom;
    }

    /**
     * Semantic search using embeddings
     */
    async search(query: string, limit: number = 10): Promise<Array<{ id: string; score: number }>> {
        const queryEmbedding = await this.embed(query);
        if (!queryEmbedding) return [];

        // Load all embeddings and compute similarity
        const rows = this.db.prepare(`
            SELECT e.node_id, e.embedding
            FROM memory_embeddings e
            JOIN memory_nodes n ON e.node_id = n.id
        `).all() as Array<{ node_id: string; embedding: Buffer }>;

        const results: Array<{ id: string; score: number }> = [];
        for (const row of rows) {
            const emb = Array.from(new Float64Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 8));
            const score = this.cosineSimilarity(queryEmbedding, emb);
            results.push({ id: row.node_id, score });
        }

        results.sort((a, b) => b.score - a.score);
        return results.slice(0, limit);
    }

    /**
     * Check if embedding model is available
     */
    async isAvailable(): Promise<boolean> {
        try {
            const res = await fetch(`${this.ollamaUrl}/api/tags`);
            if (!res.ok) return false;
            const data = await res.json() as any;
            return (data.models || []).some((m: any) => m.name.includes(this.model.split(':')[0]));
        } catch {
            return false;
        }
    }

    getModel(): string {
        return this.model;
    }
}