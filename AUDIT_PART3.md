# AUDIT PART 3 — Cognitive Memory Subsystem

**Escopo:** 12 arquivos em `src/memory/` + arquivos auxiliares de contexto  
**Data:** 2026-05-09  
**Auditor:** nc-audit-p3

---

## Visão Geral

O subsistema de memória do NewClaw é a peça mais rica e mais arriscada da arquitetura. Implementa um grafo cognitivo SQLite com 7 tipos de nó, 16 tipos de relação, camada de atenção com score composto (embedding×0.6 + conectividade×0.25 + recência×0.15 + domínio + relação), feedback com saturação logarítmica, decaimento estrutural, curadoria automática, reconciliação, scoring, classificação adaptativa, domínios cognitivos, embeddings semânticos, e detecção de comunidades Louvain.

É ambicioso e parcialmente funcional. Os problemas são profundos e sistêmicos.

---

## 1. MemoryManager.ts (1094 LOC)

### O que FAZ vs o que AFIRMA fazer

| Afirmação | Realidade |
|-----------|-----------|
| "Facade de persistência" | É muito mais que facade — contém inicialização de schema, bootstrap de grafo, FTS5, métricas, snapshots, traces, user profile, settings, busca semântica com embeddings, e reconstrução de tabela com migration manual |
| "Sistema de grafos para memória semântica" | Funciona, mas com SQL cru e sem abstração de repositorio |

### FSMs Implícitos

- **Ciclo de vida do DB**: construtor → `initialize()` (cria ~10 tabelas, indexes, FTS5, triggers, migrations manuais) → operações CRUD
- **Ciclo FTS5**: `DROP` tabela antiga → `CREATE VIRTUAL TABLE` → `rebuild` → `CREATE TRIGGER` — executa TODA VEZ no construtor. Se a base cresce, o rebuild é O(N) a cada boot
- **Migration de schema**: usa `try { ALTER TABLE } catch {}` para adicionar colunas — não há versão de schema, não há migration file, não há rollback

### Padrões de Memória

| Padrão | Implementação | Qualidade |
|--------|--------------|-----------|
| **Semântica (grafo)** | `memory_nodes` + `memory_edges` com tipos ontológicos, pagerank, community_id | ✅ Funcional, bem modelado |
| **Episódica (mensagens)** | `messages` + `conversations` com FK, porém sem compactação automática | ⚠️ Cresce infinitamente |
| **Working memory** | Nenhuma — delegado ao `CognitiveWorkspace` separado | ❌ Ausente deste arquivo |
| **Scratchpad** | Ausente | ❌ |
| **Classificação** | `memory_classifications` via ClassificationMemory separado | ⚠️ Acoplado via DB direto |

### Persistência vs Volatilidade

- **Persistente**: Tudo em SQLite (WAL). Nenhum dado se perde no reboot
- **Problemático**: `attentionLayer` e `attentionFeedback` são criados no construtor com `try/catch` — se falharem, ficam `null` e não são recriados
- **Problemático**: `semanticSearchWithAttention()` chama `generateEmbedding()` que faz `fetch` ao Ollama sem timeout, sem retry, sem circuit breaker
- **Problemático**: `recordMetricsSnapshot()` é um método público mas nunca chamado automaticamente pelo MemoryManager

### Vazamentos de SQL / Violações de Boundary

1. **`getDatabase()` é público** — retorna `this.db` cru. MemoryGovernor, MemoryCurator, MemoryScoringEngine, MemoryReconciliationEngine, GraphAnalytics, SkillLearner TODOS acessam `(this.mm as any).db` ou `this.memory.getDatabase()` para fazer SQL direto. Isso destrói encapsulamento completamente
2. **`bootstrapCoreGraph()`** — hardcodes 10 nós e 16 arestas com IDs mágicos (`identity`, `core_agent`, `core_user`, etc.) — sem versão, sem idempotência real (apenas `if (!exists)`)
3. **FTS5 rebuild no boot** — `INSERT INTO memory_nodes_fts(memory_nodes_fts) VALUES('rebuild')` reconstrói todo o índice a cada inicialização. Para bases grandes, isso é O(N) dispendioso
4. **Migration de colunas via `ALTER TABLE` em `try/catch`** — não rastreia versão, não garante ordem, silenciosamente ignora erros que NÃO são "column exists"

### Gerenciamento de Context Window

- `getContext(maxChars)` retorna texto concatenado com identidade + preferências + projetos + top-3 fatos + nós `core_*`. É linear e sem atenção
- `semanticSearch()` faz busca FTS5 → LIKE fallback, mas NÃO usa embedding para re-ranking
- `semanticSearchWithAttention()` é o pipeline principal, mas o método `generateEmbedding()` dentro do MemoryManager faz `fetch` síncrono ao Ollama sem timeout

### Riscos de Contaminação de Memória

1. **`addNode()` com `INSERT OR REPLACE`** — se um nó com mesmo ID mas tipo/conteúdo diferente é adicionado, substitui silenciosamente. Sem merge, sem diff, sem aviso
2. **`refreshHeartbeatNode()`** — reescreve `core_heartbeat` a cada interação com dados de `boot_count` e `interaction_count`. É um nó que muda constantemente — polui métricas e atenção
3. **`incrementInteractionCount()`** — incrementa counter e depois chama `refreshHeartbeatNode()` que reescreve o nó — write amplification
4. **`addEdge()` com validação ontológica** — se a relação é inválida, faz fallback para `related_to` ou `has_trait` em vez de REJEITAR. Isso degrada a ontologia progressivamente

### Cache e Leak Risks

- Nenhum cache em memória. Toda operação é um SELECT direto no SQLite
- `semanticSearch()` carrega TODOS os embeddings (`SELECT node_id, embedding FROM memory_embeddings`) para cosine similarity em memória — O(N) na RAM
- `searchNodes()` faz FTS5 + LIKE fallback sem limite de query — risk de queries muito amplas

---

## 2. MemoryGovernor.ts (670 LOC)

### O que FAZ

- Decay de confiança baseado em tempo, acesso, e fonte (explicit/inferred/system)
- Detecção de conflitos entre fatos (contradição, overlap, duplicata)
- Resolução automática de conflitos (replace, reduce_confidence, keep_both, merge, archive)
- Garbage collection de nós com baixa confiança
- Feedback de uso (reforço com diminishing returns, penalização)
- Ciclo completo de governança: decay → conflict → GC

### FSMs Implícitos

- **Estado de confiança**: `1.0 → 0.98^n → minConfidence → archive/delete` — implícito via `confidence` field
- **Estado de conflito**: detectado → classificado → resolvido — mas sem persistir estado de conflito, sem log de resoluções

### Violações de Boundary

1. **`getAllNodes()` faz `SELECT *` direto** via `this.memory.getDatabase()` — boundary leak
2. **`archiveNode()`** — muda o `type` para `context` e baixa confiança, mas o nó original TIPO É PERDIDO (salvo em `metadata.original_type`). Se o schema tem `CHECK(type IN (...))`, `context` pode não ser o tipo certo
3. **`resolveConflicts()`** — pode modificar múltiplos nós em sequência sem transação. Se falhar no meio, deixa o grafo em estado inconsistente

### Riscos de Contaminação

1. **`accessLog` é `Map<string, {count, lastAccessed, wasHelpful}>`** — EM MEMÓRIA, não persistido. A cada reboot, todo o access log é perdido, o que zera o tracking de staleness e invalida o decay acelerado
2. **`markAsExplicit()` / `markAsInferred()`** — chamadas isoladas, sem rastro. Um nó pode ser marcado como `explicit` e depois `inferred` sem auditoria
3. **`runGovernanceCycle()`** — faz decay → conflict → GC em sequência. O GC pode apagar nós que acabaram de ser decaídos, antes que o usuário tenha chance de recuperar

### Gerenciamento de Confiança

- **Diminishing returns**: `boost = usefulBoost * 0.75^(count-1)` — bom, mas o `count` é do accessLog em memória, perdido a cada reboot
- **MaxConfidence ceiling**: 0.95 — impede que nó chegue a 1.0, mas identity nodes são criados com confidence 1.0 e protected
- **Decay acelerado para nós sem acesso** — 50% extra decay se não está no accessLog — mas o accessLog é volátil!

---

## 3. MemoryCurator.ts (~300 LOC)

### O que FAZ

- Detecta e corrige nós órfãos (sem arestas)
- Cria hubs (daily, system, infrastructure) para conectar órfãos
- Cadeia nós diários cronologicamente (`next`)
- Limpa nós de identidade inválidos (texto livre, > 80 chars)
- Aplica decay temporal às arestas (0.98× a cada 30 dias)
- Auto-curatagem com intervalo configurável (30 min default)

### Violações de Boundary

1. **`(this.mm as any).db`** — acessa o banco privado do MemoryManager diretamente, bypassando a API
2. **SQL cru para tudo** — `SELECT id, type, name FROM memory_nodes`, `DELETE FROM memory_edges WHERE from_node = to_node` — nenhuma abstração
3. **`ALTER TABLE memory_edges ADD COLUMN last_accessed TEXT`** em `try/catch` dentro de `applyTemporalDecay()` — migration em tempo de operação

### Riscos

1. **`cleanupInvalidNodes()`** — reduz confiança de nós identity com conteúdo > 80 chars OU que batem em padrões regex (`/se chama/i`, `/é o/i`). Isso pode destruir dados válidos (ex: "O Luciano é o professor de engenharia de software")
2. **Auto-curatagem a cada 30 minutos** — roda `curate()` + `updateMetrics()` + `detectCommunities()` + `embedMissing()` automaticamente. Para bases grandes, `detectCommunities()` é O(N²) e `embedMissing()` faz N chamadas HTTP ao Ollama
3. **Nó órfão de tipo `preference`** é automaticamente conectado a `core_user` com relação `prefers` — mas pode ser preferência de outrém

---

## 4. MemoryScoringEngine.ts (~100 LOC)

### O que FAZ

- `applyDecay()` — decai confiança de nós por 0.99× por dia, exceto `core_*` e `identity`
- `boostNode()` — reforço com diminishing returns
- `setConfidence()` — set direto de confiança
- `autoScoreNodes()` — seta identity para confiança 1.0, preference para 0.85
- `calibrate()` — ajuste por sinal (consistent/contradictory/neutral)

### Problemas

1. **Conflito com MemoryGovernor** — ambos fazem decay de confiança mas com fórmulas diferentes (Governor: `0.98^days * sourceWeight`; ScoringEngine: `0.99` flat). Se ambos rodam, decay é duplicado
2. **`autoScoreNodes()`** faz `UPDATE` em batch sem WHERE temporal — reseta TODOS os nós identity para confidence 1.0 e preference para 0.85, potencialmente sobre-escrevendo valores calibrados
3. **`boostNode()`** e `setConfidence()`** chamam `addNode()` que faz `INSERT OR REPLACE` — isto aciona os triggers FTS5 para delete+insert, causando write amplification
4. **`calibrate()`** — chamada manual, sem integração com o pipeline de atenção ou feedback

---

## 5. MemoryReconciliationEngine.ts (~90 LOC)

### O que FAZ

- Compara todos os nós de tipo `preference`, `fact`, `skill` dois a dois
- Se similaridade Jaccard > 0.75, modula o nó mais antigo (−0.05 weight, −0.02 confidence)
- Nunca deleta, apenas reduz peso

### Problemas

1. **O(N²)** — compara todos os pares. Para 1000 nós, são 499.500 comparações. Para 10000, 49.995.000. Sem amostragem, sem índice
2. **Similaridade Jaccard em palavras** — muito superficial. "Prefiro Python" e "Prefiro programar em Python" teriam similaridade alta (correto), mas "Python é a melhor linguagem" e "Python é a pior linguagem" também (incorreto — é contradição, não overlap)
3. **Sem integração com Governor** — Governor tem detecção de conflitos mais sofisticada, mas ReconciliationEngine não a usa
4. **`modulateNode()` chama `addNode()`** — write amplification novamente

---

## 6. AttentionLayer.ts (~350 LOC)

### O que FAZ

- Score composto de atenção: `embedding×w1 + context×w2 + recency×w3 + relation×w4 + domain×w5`
- Context state persistido em `attention_context` (active goal, recent nodes, current task)
- Busca com atenção: embedding candidates + neighborhood expansion + re-ranking
- Touch tracking: marca nós como recentemente acessados
- Logging de buscas para analytics

### FSMs Implícitos

- **Context window**: FIFO de tamanho 20, persistido em SQLite
- **Search history**: logado em `attention_history` sem TTL — cresce infinitamente

### Violações de Boundary

1. **Recebe `Database` diretamente no construtor** — não passa por MemoryManager, acessa SQL cru
2. **`searchWithAttention()`** recebe embedding results de fora, mas faz queries adicionais ao DB para cada candidato — N+1 queries
3. **`calculateContextRelevance()`** faz 3 níveis de queries (direct, 1-hop, 2-hop) — para cada candidato, potencialmente 1+|recentNodes| queries por nível

### Riscos de Contaminação

1. **Context window pode ser poluído** — `touchNode()` é chamado a cada busca, incluindo buscas irrelevantes. Se o usuário pergunta sobre "Python" e depois sobre "receita de bolo", os nós de Python permanecem no context window por 20 posições
2. **`updateContext()` com `activeGoal` e `currentTask`** — quem define isso? Não há integração documentada com AgentStateManager ou DecisionEngine
3. **Pesos fixos (w1=1.0, w2=2.0, w3=1.5, w4=1.0, w5=0.5)** — hardcoded, não adaptativos, não persistidos

---

## 7. AttentionFeedback.ts (849 LOC)

### O que FAZ

- Registro de uso com saturação logarítmica: `increment = base / (1 + 0.3 × ln(1 + count))`
- Validação de co-usage (aresta pré-existente OU similaridade semântica > 0.3 OU vizinho em comum)
- Reforço cognitivo de arestas validadas
- Decaimento estrutural (0.02/dia para nós, 0.03/7dias para arestas, exceto relações críticas)
- Anti-dominância: `√score` em vez de linear, cap em 2.5
- Promoção de diversidade por domínio (max 2 por domínio)
- Classificação dinâmica: active (≥2.0 ou recente), longterm (≥0.5), latent
- Normalização periódica
- Monitoramento com detecção de anomalias (concentração, órfãos, sparse edges, reinforcement bursts)
- Background jobs: decay (1h), normalization (30min), monitoring (5min)

### Pontos Fortes

- Saturação logarítmica é matemática correta
- Validação de co-usage antes de criar arestas é excelente
- Anti-dominância com sqrt é inteligente
- Diversidade por domínio é boa prática
- Detecção de anomalias é proativa

### Problemas

1. **3 timers em background** — `setInterval` sem unref, sem graceful shutdown (destroy() existe mas não é chamado em shutdown)
2. **`embeddingCache` limitado a 500** — eviction é FIFO simples, não LRU. Poderia evictar embeddings quentes
3. **`recordCoUsage(nodeIds)`** — O(N²) no número de nós co-usados. Para 20 nós, são 190 pares, cada um com validação de similaridade + 2 queries SQL
4. **`decayEdges()` carrega TODAS as arestas** — `SELECT * FROM memory_edges WHERE weight > 0.1` — para grafos grandes, isso é problemático
5. **`monitor()` carrega top3 e total** — query simples, mas roda a cada 5 minutos
6. **`suggestConnections()`** — O(N²) nos top-20 nós com queries SQL para cada par — potencialmente 380 queries
7. **Normalização** — `UPDATE node_metrics SET reinforcement_score = (reinforcement_score / max) * MAX_REINFORCEMENT` — se `max` é 0 ou próximo, divide por zero

---

## 8. ClassificationMemory.ts (~230 LOC)

### O que FAZ

- Detecta contexto (terminal, coding, chat, analysis, crypto, trading) por regex
- Armazena classificações com hash, confiança, hits, penalty_count
- Busca por hash exato → fuzzy (Jaccard) no contexto → fuzzy global
- Penaliza classificações erradas
- Decay: remove entradas com ≤1 hit, ≥3 penalties, >7 dias sem uso

### Problemas

1. **DB recebido diretamente no construtor** — boundary leak, não passa por MemoryManager
2. **`ALTER TABLE memory_nodes ADD COLUMN context_type/classification_score`** — modifica tabela de outro subsistema
3. **Hash do input é um hash JS simples (non-cryptographic)** — colisões possíveis, especialmente para strings curtas
4. **Fuzzy search carrega top-20 por contexto** — `SELECT * FROM memory_classifications WHERE context = ? ORDER BY hits DESC LIMIT 20` — para cada busca
5. **`decay()` remove registros agressivamente** — `hits ≤ 1 AND penalty_count ≥ 3 AND last_used < 7 days` — pode remover classificações válidas que ainda não tiveram chance de acumular hits
6. **Integração com SimpleDecisionEngine e ModelRouter** — ambos fazem classificação por regex, mas NÃO usam ClassificationMemory. Há 3 sistemas de classificação independentes

---

## 9. CognitiveDomains.ts (~120 LOC)

### O que FAZ

- Define 7 domínios cognitivos com prioridades e tipos permitidos
- Valida tipo↔domínio
- Sugere domínio para tipo
- Fornece prioridade para AttentionLayer
- Define forças cross-domain

### Problemas

1. **Domínios e tipos são declarativos mas NÃO aplicados** — não há constraint no schema, não há validação no `addNode()`. O campo `domain` existe em `memory_nodes` mas nunca é populado automaticamente
2. **`suggestDomainForType()`** — retorna o primeiro domínio que aceita o tipo, mas não é chamado em nenhum lugar do código
3. **`CROSS_DOMAIN_STRENGTH`** — definido mas nunca usado pelo AttentionLayer ou AttentionFeedback
4. **Tipos permitidos vs tipos reais do schema** — `context_state`, `active_goal`, `current_task`, `goal`, `knowledge`, `trait`, `rule`, `strategy` são tipos de domínio mas NÃO existem no `CHECK(type IN (...))` do schema. Isso causa silenciosa falha de inserção

---

## 10. EmbeddingService.ts (~130 LOC)

### O que FAZ

- Gera embeddings via Ollama (`nomic-embed-text`, 768 dim)
- Armazena em `memory_embeddings` como BLOB (Float64Array)
- Busca semântica por cosine similarity (load all → compare in memory)
- Batch embedding de nós sem embedding
- Verifica disponibilidade do modelo

### Problemas

1. **`search()` carrega TODOS os embeddings** — `SELECT e.node_id, e.embedding FROM memory_embeddings e JOIN memory_nodes n ON e.node_id = n.id` — O(N) na RAM. Para 10K nós com 768 dim, são ~60MB
2. **Sem índice vetorial** — cosine similarity é linear scan. Para bases grandes, é inviável
3. **`embedMissing()` faz `setTimeout(100)` entre chamadas** — rate limiting manual, mas sem retry, sem backoff, sem circuit breaker
4. **O modelo de embedding é hardcoded** — `nomic-embed-text` — não configurável via env ou config
5. **`isAvailable()` faz `fetch` ao Ollama sem timeout** — se Ollama está down, trava

---

## 11. GraphAnalytics.ts (~200 LOC)

### O que FAZ

- Calcula PageRank, Degree, Betweenness (BFS approx.), Closeness centrality
- Detecta comunidades via LouvainDetector
- Persiste métricas em `memory_nodes` (pagerank, degree, betweenness, closeness) e `node_metrics`
- Backfill de node_metrics para nós sem métricas

### Problemas

1. **O(N²) para betweenness e closeness** — BFS de cada nó para cada nó. Para 1000 nós, ~1M operações. Para 10000, ~100M. Sem amostragem
2. **PageRank com 50 iterações fixas** — sem convergência checking. Pode não convergir ou convergir antes
3. **Transaction de update** — `UPDATE memory_nodes SET pagerank = ?, degree = ?, ...` para CADA nó individualmente. Para 1000 nós, 1000 UPDATEs em transaction (bom), mas sem batch UPDATE
4. **`(this.mm as any).db`** — boundary leak clássico
5. **`detectCommunities()`** — usa LouvainDetector que é O(N×E) — potencialmente muito custoso
6. **Chamado por MemoryCurator.autoCurate()** a cada 30 minutos — sem throttle, sem condição de tamanho do grafo

---

## 12. LouvainDetector.ts (~110 LOC)

### O que FAZ

- Implementação pura do algoritmo Louvain em TypeScript
- Detecção de comunidades em grafos não direcionados

### Problemas

1. **Apenas fase 1 (local moves)** — não implementa fase 2 (aggregate/contract communities). Isso significa que a qualidade das comunidades é subótima
2. **O(N²) no loop de modularity** — `sigmaTot` é recalculado iterando sobre TODOS os nós para CADA movimento proposto
3. **`maxIterations = 20`** — pode não ser suficiente para convergência
4. **Não lida com grafos disconexos** — se há componentes isolados, cada um vira uma comunidade singleton

---

## Cross-Cutting Issues

### 1. Boundary Violation: `getDatabase()` é uma Bomba

**`MemoryManager.getDatabase()`** é público e retorna `this.db`. Isto é usado por:

- MemoryGovernor (via `this.memory.getDatabase()`)
- MemoryCurator (via `(this.mm as any).db`)
- MemoryScoringEngine (via `this.memory.getDatabase()`)
- MemoryReconciliationEngine (via `this.memory.getDatabase()`)
- GraphAnalytics (via `(this.mm as any).db`)
- AttentionLayer (recebe `Database` no construtor)
- AttentionFeedback (recebe `Database` no construtor)
- ClassificationMemory (recebe `Database` no construtor)
- SkillLearner (recebe `Database` no construtor)

**9 componentes** acessam SQL cru diretamente. Qualquer mudança de schema exige mudança em 9+ arquivos.

### 2. Múltiplos Sistemas de Classificação Conflitantes

| Sistema | Arquivo | Método |
|---------|---------|--------|
| SimpleDecisionEngine | `core/SimpleDecisionEngine.ts` | Regex → tool/exec/llm |
| routeIntent | `loop/routeIntent.ts` | Regex → tool/llm/compound |
| ClassificationMemory | `memory/ClassificationMemory.ts` | Regex + Jaccard → context |
| ModelRouter | `loop/ModelRouter.ts` | Regex + LLM → model profile |
| AgentStateManager | `core/AgentStateManager.ts` | Estado → mode |

Cada um classifica o input de forma independente, sem compartilhar resultados. Se ClassificationMemory classifica como "coding" mas ModelRouter classifica como "chat", não há resolução.

### 3. Decay Duplicado e Conflitante

| Componente | Taxa | Escopo |
|------------|------|--------|
| MemoryGovernor | `0.98^days × sourceWeight` | confiança de nós |
| MemoryScoringEngine | `0.99` flat por dia | confiança de nós (exceto core/identity) |
| MemoryCurator | `0.98` por 30 dias | peso de arestas |
| AttentionFeedback | `0.02 × daysSince / resistance` | reinforcement score |

Se todos rodarem, a confiança decai 4x mais rápido do que o esperado por qualquer um individualmente.

### 4. Memória Episódica Sem Limites

A tabela `messages` cresce infinitamente. Não há:
- Compactação automática (o `ContextCompressor` existe mas é DEPRECATED)
- TTL para mensagens antigas
- Partitioning por conversation_id
- Limite de linhas por conversa

### 5. Write Amplification

- `addNode()` → `INSERT OR REPLACE` → trigger FTS5 delete+insert → `INSERT OR REPLACE` into `node_metrics` → potencialmente `UPDATE memory_nodes SET last_accessed`
- Cada `touchNode()` faz 1 UPDATE em `memory_nodes` + 1 UPDATE em `attention_context`
- `recordCoUsage()` para N nós faz N² validações + N² SQL queries + N² `UPDATE/INSERT` em `memory_edges`
- `refreshHeartbeatNode()` reescreve um nó a cada interação

### 6. Context Window Management

O pipeline de contexto é:

```
ContextBuilder.buildContext(query)
  → relevance gate (greeting check)
  → semanticSearchWithAttention(query, 12)
    → generateEmbedding(query) [fetch Ollama, sem timeout]
    → cosine similarity em memória [O(N)]
    → AttentionLayer.searchWithAttention()
      → N queries por candidato
  → rankAndSelect() (6 nodes max, 200 chars each)
  
SessionContext.buildLLMMessages()
  → ContextBudget.buildMessages()
    → system prompt (1500 tokens max)
    → state block (500 tokens max)
    → memory block (1000 tokens max) [resultado do ContextBuilder]
    → skills block (500 tokens max)
    → checkpoint (2000 tokens max)
    → recent messages (2000 tokens, 6 msgs max, 1500 chars each)
    → current message (unlimited)
```

**Problemas:**
- Memory block de 1000 tokens (≈4KB) é MUITO pouco para um grafo cognitivo com centenas de nós
- `generateEmbedding` sem timeout pode travar o pipeline inteiro
- ContextBudget NÃO consulta a AttentionLayer ou Governor — pode incluir nós com confiança < 0.3
- ContextValidator faz checagem de conflitos por `subject:value` parsing — muito ingênuo

### 7. Reasoning Hygiene

- **Prompt content NÃO é persistido** em nenhum lugar — bom
- **Mas:** `memory_block` no contexto inclui nós do grafo que podem conter conteúdo de LLM anterior (ex: resumos gerados, fatos inferidos). Se o LLM alucinou um fato e ele foi persistido no grafo, ele entra no contexto da próxima interação como fato
- **MemoryGovernor.markAsInferred()** reduz confiança, mas NÃO há um pipeline automático que marca fatos como `inferred` antes de persistir. O `addNode()` não exige `source`
- **DecisionPostProcessor** modula a resposta do LLM baseado no estado, mas NÃO verifica se fatos no contexto são `explicit` vs `inferred`

### 8. Memory Drift

- **Confidence decay sem ground truth** — não há mecanismo para verificar se um fato que está sendo decaído ainda é verdadeiro. Fatos explícitos de alta confiança podem decair para 0.3 e serem coletados pelo GC
- **Auto-curation conecta órfãos automaticamente** — se um nó de "bitcoin preço: 50000" fica órfão, é conectado ao hub `ctx_daily_memory`. Se o preço mudou para 80000, o nó antigo continua conectado com confiança decaída mas ainda presente
- **No content diffing** — quando `addNode()` faz `INSERT OR REPLACE`, não há diff ou versionamento. O conteúdo anterior é perdido completamente

---

## Scorecard: AI OS Readiness (Memory Subsystem)

| Dimensão | Score | Notas |
|----------|-------|-------|
| **Persistência** | 7/10 | SQLite WAL é sólido, mas sem TTL, sem partitioning |
| **Boundary** | 2/10 | `getDatabase()` leak para 9 componentes |
| **Escalabilidade** | 3/10 | O(N²) em reconciliation, embedding search, betweenness |
| **Higiene Cognitiva** | 4/10 | Decay duplicado, sem ground truth, inferred automático |
| **Observabilidade** | 5/10 | Logs básicos, métricas em AttentionFeedback, mas sem dashboards |
| **Contaminação** | 4/10 | addNode() sem diff, FTS5 rebuild, alucinável |
| **Context Management** | 5/10 | Budget existe mas é muito restrito, sem atenção no pipeline |
| **Classificação** | 3/10 | 5 sistemas independentes, sem resolução |
| **FSM/Lifecycle** | 4/10 | Ciclos de vida implícitos, sem state machine formal |
| **Recuperação** | 6/10 | Snapshots existem, mas sem auto-restore |

**Média ponderada: 4.3/10**

---

## Recomendações Prioritárias

### P0 — Crítico

1. **Eliminar `getDatabase()`** — Criar Repository pattern com métodos específicos (ex: `NodeRepository.find()`, `EdgeRepository.query()`). Todos os componentes devem usar a API, não SQL cru
2. **Unificar sistemas de classificação** — Um único Classifier que serve SimpleDecisionEngine, ModelRouter, e ClassificationMemory
3. **Unificar decay** — MemoryGovernor deve ser o ÚNICO responsável por decay. Remover decay de ScoringEngine e Curator
4. **Adicionar TTL para memória episódica** — `messages` precisa de compactação automática ou TTL
5. **Adicionar timeout e circuit breaker** para `generateEmbedding()` e `isAvailable()`

### P1 — Importante

6. **Adicionar `source` tracking** — Todo `addNode()` deve registrar se o fato é `explicit`, `inferred`, ou `system`. O Governor já suporta isso, mas não é aplicado na inserção
7. **ContextBudget deve consultar AttentionLayer** — O memory block deve incluir apenas nós com `memory_class = 'active'` e `confidence > 0.5`
8. **Reduzir write amplification** — Batch updates, evitar `addNode()` para meros touch/update
9. **Indexar embedding search** — Usar sqlite-vec ou um ANN index para evitar O(N) scan
10. **Schema versioning** — Adicionar tabela `schema_version` e migration sequencial em vez de `ALTER TABLE try/catch`

### P2 — Melhoria

11. **Substituir FTS5 rebuild no boot** por incremental triggers (que já existem mas são seguidos de rebuild)
12. **Adicionar content diffing** em `addNode()` — persistir versões anteriores
13. **Tornar pesos de atenção configuráveis** e adaptativos
14. **Louvain fase 2** — agregar comunidades para melhor qualidade
15. **Amostragem em ReconciliationEngine** — em vez de O(N²), comparar apenas nós do mesmo tipo e domínio