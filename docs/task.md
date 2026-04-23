# NewClaw — Cognitive Memory Evolution Tasks

## ✅ BLOCO 1 — Busca Semântica com Embeddings
- [x] EmbeddingService.ts criado (Ollama nomic-embed-text, 768 dim)
- [x] memory_embeddings table (node_id, embedding BLOB, model)
- [x] /api/memory/search atualizado: Embedding > FTS5 > LIKE fallback
- [x] POST /api/memory/embed — gerar embeddings para nós sem embedding
- [x] cosineSimilarity implementado no EmbeddingService
- [ ] Pull modelo nomic-embed-text na Vênus
- [ ] Testar busca semântica real

## ✅ BLOCO 2 — Detecção de Comunidades (Louvain)
- [x] LouvainDetector.ts — algoritmo Louvain puro TS (sem deps)
- [x] community_id column em memory_nodes
- [x] detectCommunities() em GraphAnalytics.ts
- [x] GET /api/memory/dashboard/communities
- [x] Integração no ciclo do MemoryCurator
- [ ] Testar com grafo maior (esperado >1 comunidade)

## ✅ BLOCO 3 — Decaimento Temporal de Pesos
- [x] last_accessed column em memory_edges
- [x] applyTemporalDecay() no MemoryCurator (×0.98 para >30 dias)
- [x] Peso mínimo 0.1 (nunca zera)
- [x] Integração no ciclo automático do MemoryCurator
- [ ] Verificar decaimento após 30+ dias

## ✅ BLOCO 4 — Dashboards Analíticos
- [x] memory_metrics_history table criada
- [x] recordMetricsSnapshot() no MemoryManager
- [x] GET /api/memory/dashboard/top-nodes
- [x] GET /api/memory/dashboard/evolution
- [x] GET /api/memory/dashboard/communities
- [x] GET /api/memory/dashboard/density
- [x] POST /api/memory/dashboard/record-snapshot
- [ ] Adicionar gráficos no frontend (evolução temporal)

## 📋 Entregáveis
- [x] EmbeddingService.ts
- [x] LouvainDetector.ts
- [x] MemoryManager.ts atualizado
- [x] GraphAnalytics.ts atualizado
- [x] MemoryCurator.ts atualizado
- [x] DashboardServer.ts atualizado
- [x] task.md
- [x] walkthrough.md