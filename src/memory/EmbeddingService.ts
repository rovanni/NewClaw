/**
 * EmbeddingService — Geração e busca de embeddings via Ollama
 *
 * Usa nomic-embed-text (768 dim) por padrão.
 * Fallback automático para FTS5 se embeddings não disponíveis.
 */
import { Database } from 'better-sqlite3';

/**
 * Ponto único de verdade para o modelo de embedding (usado aqui, em memory_write.ts,
 * memory_admin.ts, MemoryManager.ts e CMIIngestionPipeline.ts — antes cada um tinha sua própria
 * string literal, 3 delas como `'nomic-embed-text:latest'` e 2 como `'nomic-embed-text'` sem
 * tag).
 *
 * Achado real (16/08/2026, instância local de produção): o Ollama local só tinha
 * `nomic-embed-text:v1.5` puxado — nem `:latest` nem o nome sem tag (que o Ollama resolve como
 * `:latest` por convenção) existiam. Toda chamada de embedding vinha falhando silenciosamente —
 * a geração sempre foi best-effort (fetch dentro de try/catch que nunca propaga falha) — e o
 * embedding mais recente no banco de produção era de 09/06/2026, dois meses antes desta
 * descoberta, apesar da aplicação rodando continuamente e criando nós novos o tempo todo.
 */
/**
 * O modelo de embedding escolhido pelo usuário (EMBED_MODEL). Vazio = nenhum escolhido: os embeddings ficam desligados e a busca
 * segue por palavras. Diretiva de 14/10/2026 — nenhum modelo no código (antes: 'nomic-embed-text:v1.5' fixo, sem configuração;
 * nas instâncias da mantenedora ele já não gerava vetores — 5 tentativas, 0 gerados).
 */
export function modeloDeEmbedding(): string {
    return (process.env.EMBED_MODEL || '').trim();
}

export class EmbeddingService {
    private ollamaUrl: string;
    private modeloFixo?: string;
    private db: Database;

    /** Sem `model`, vale a escolha atual do usuário (EMBED_MODEL), lida a cada uso: trocar no painel vale na hora. */
    constructor(db: Database, ollamaUrl: string = 'http://localhost:11434', model?: string) {
        this.db = db;
        this.ollamaUrl = ollamaUrl;
        this.modeloFixo = model;
        this.initializeSchema();
    }

    private get model(): string {
        return this.modeloFixo ?? modeloDeEmbedding();
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
        if (!this.model) return null;   // nenhum modelo de embedding escolhido (EMBED_MODEL)
        try {
            const res = await fetch(`${this.ollamaUrl}/api/embeddings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: this.model, prompt: text })
            });
            if (!res.ok) return null;
            const data = await res.json() as { embedding?: number[] };
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
     *
     * Público (S6, roadmap de aprendizado orientado a objetivos): função pura, sem estado
     * (não referencia `this`) — reaproveitada por CaseMemory.findRelevantCasesShadow() para
     * similaridade de objetivo, em vez de duplicar a mesma matemática pela terceira vez no
     * projeto (já existia uma cópia divergente em MemoryManager.cosineSimilarity).
     */
    cosineSimilarity(a: number[], b: number[]): number {
        if (a.length !== b.length) {
            throw new Error(`Dimension mismatch: vector A has length ${a.length}, vector B has length ${b.length}`);
        }
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
            if (queryEmbedding.length !== emb.length) {
                continue; // fail-closed: skip embedding of mismatched dimension
            }
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
        if (!this.model) return false;   // nenhum modelo escolhido: não está disponível, sem adivinhar
        try {
            const res = await fetch(`${this.ollamaUrl}/api/tags`);
            if (!res.ok) return false;
            const data = await res.json() as { models?: Array<{ name: string }> };
            return (data.models || []).some(m => m.name.includes(this.model.split(':')[0]));
        } catch {
            return false;
        }
    }

    getModel(): string {
        return this.model;
    }

    /**
     * Vetores feitos por OUTRO modelo não servem para o atual (dimensões e espaço diferentes — a busca já os pulava pela
     * dimensão, mas mesmo de dimensão igual não são comparáveis). Apagados ao reindexar. Devolve quantos saíram.
     */
    descartarDeOutroModelo(): number {
        if (!this.model) return 0;
        return this.db.prepare('DELETE FROM memory_embeddings WHERE model != ?').run(this.model).changes;
    }

    /** Quantos nós ainda não têm vetor. */
    pendentes(): number {
        return (this.db.prepare(`
            SELECT COUNT(*) AS n FROM memory_nodes n LEFT JOIN memory_embeddings e ON n.id = e.node_id WHERE e.node_id IS NULL
        `).get() as { n: number }).n;
    }
}
