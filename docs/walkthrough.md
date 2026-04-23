# Walkthrough — Evolução da Memória Cognitiva do NewClaw

## Data: 2026-04-13

---

## 📦 Arquivos Criados

### EmbeddingService.ts
- Localização: `src/memory/EmbeddingService.ts`
- Responsabilidade: Gerar embeddings via Ollama (`nomic-embed-text`, 768 dim) e buscar por similaridade coseno
- Tabela: `memory_embeddings` (node_id TEXT PK, embedding BLOB, model TEXT)
- Métodos: `embed()`, `embedNode()`, `embedMissing()`, `search()`, `isAvailable()`
- Fallback: Se embeddings indisponíveis, cai para FTS5 → LIKE

### LouvainDetector.ts
- Localização: `src/memory/LouvainDetector.ts`
- Responsabilidade: Algoritmo Louvain para detecção de comunidades (puro TS, sem deps externas)
- Métodos: `detect(maxIterations)`, `summarize(communities)`
- Saída: `Map<nodeId, communityId>`

---

## 📦 Arquivos Modificados

### MemoryManager.ts
**Adições:**
1. `memory_metrics_history` table — histórico de métricas por nó (pagerank, degree, betweenness, closeness, community_id)
2. `recordMetricsSnapshot()` — grava snapshot das métricas atuais de todos os nós
3. FTS5 corrigido: `fts_rowid INTEGER` em vez de `content_rowid='id'` (TEXT PK causava SQLITE_CORRUPT_VTAB)
4. `addNode()` atualizado para auto-atribuir `fts_rowid`

### GraphAnalytics.ts
**Adições:**
1. Import `LouvainDetector`
2. `detectCommunities()` — roda Louvain, persiste `community_id` em cada nó
3. Column `community_id` adicionada via ALTER TABLE (safe)

### MemoryCurator.ts
**Adições:**
1. Import `EmbeddingService`
2. Construtor aceita `embeddingService` opcional
3. `applyTemporalDecay()` — decaimento ×0.98 para arestas com `last_accessed` > 30 dias, peso mínimo 0.1
4. Column `last_accessed` adicionada em `memory_edges`
5. Ciclo automático agora inclui:
   - `detectCommunities()` (Louvain)
   - `recordMetricsSnapshot()` (histórico)
   - `embeddingService.embedMissing(10)` (se disponível)

### DashboardServer.ts
**Adições:**
1. Import `EmbeddingService`, prop `embeddingService`
2. Inicialização do EmbeddingService no `setMemoryManager()`
3. `/api/memory/search` → async, fallback chain: Embedding → FTS5 → LIKE
4. `POST /api/memory/embed` — gera embeddings para nós sem embedding
5. Dashboard endpoints (Bloco 4):
   - `GET /api/memory/dashboard/top-nodes?metric=pagerank&limit=10`
   - `GET /api/memory/dashboard/evolution?node_id=core_user&limit=100`
   - `GET /api/memory/dashboard/communities`
   - `GET /api/memory/dashboard/density`
   - `POST /api/memory/dashboard/record-snapshot`

---

## 🗄️ Schema Changes (SQLite)

### Novas tabelas
```sql
-- Embeddings
CREATE TABLE memory_embeddings (
  node_id TEXT PRIMARY KEY,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Metrics history
CREATE TABLE memory_metrics_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL,
  pagerank REAL DEFAULT 0.0,
  degree INTEGER DEFAULT 0,
  betweenness REAL DEFAULT 0.0,
  closeness REAL DEFAULT 0.0,
  community_id INTEGER DEFAULT 0,
  recorded_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

### Novas colunas
```sql
ALTER TABLE memory_nodes ADD COLUMN fts_rowid INTEGER;
ALTER TABLE memory_nodes ADD COLUMN community_id INTEGER DEFAULT 0;
ALTER TABLE memory_edges ADD COLUMN last_accessed TEXT;
```

---

## 🔄 Ciclo do MemoryCurator (atualizado)

```
A cada 30 minutos:
1. curate()           — organizar órfãos
2. updateMetrics()    — PageRank, centralidades
3. detectCommunities()— Louvain, community_id
4. applyTemporalDecay()— decaimento ×0.98 (>30 dias)
5. recordMetricsSnapshot()— histórico de métricas
6. embedMissing(10)   — gerar embeddings (se Ollama disponível)
```

---

## 🔍 FTS5 Fix (importante)

**Problema:** `content_rowid='id'` com TEXT PK → `SQLITE_CORRUPT_VTAB`
**Solução:** Coluna `fts_rowid INTEGER` separada, auto-atribuída no `addNode()`
**Triggers:** Atualizados para usar `new.fts_rowid`/`old.fts_rowid` como rowid
**Rebuild:** `INSERT INTO memory_nodes_fts(memory_nodes_fts) VALUES('rebuild')` ao iniciar

---

## 🧪 Testes Manuais

```bash
# Density
curl http://localhost:3090/api/memory/dashboard/density

# Top nodes
curl "http://localhost:3090/api/memory/dashboard/top-nodes?metric=pagerank&limit=5"

# Communities
curl http://localhost:3090/api/memory/dashboard/communities

# Evolution
curl "http://localhost:3090/api/memory/dashboard/evolution?node_id=core_user&limit=10"

# Search (FTS5)
curl "http://localhost:3090/api/memory/search?q=trading"

# Search (Embedding — requires nomic-embed-text)
curl "http://localhost:3090/api/memory/search?q=plataforma+de+trading+com+inteligencia+artificial"

# Embed missing nodes
curl -X POST http://localhost:3090/api/memory/embed -H 'Content-Type: application/json' -d '{"limit": 50}'

# Record metrics snapshot
curl -X POST http://localhost:3090/api/memory/dashboard/record-snapshot
```

---

## ⚠️ Próximos passos

1. Pull `nomic-embed-text` na Vênus: `ssh venus 'ollama pull nomic-embed-text'`
2. Testar busca semântica real
3. Adicionar gráficos de evolução no frontend (memory-graph.html)
4. Considerar sqlite-vss para busca vetorial nativa (performance)
5. Decaimento temporal: verificar após 30 dias de uso real