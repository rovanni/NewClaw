# 🧠 AUDITORIA ARQUITETURAL COMPLETA — NewClaw
## Transição: Chat Wrapper → AI Operating System / Cognitive Agent Runtime

**Data:** 2026-05-09  
**Base:** 22.803 linhas de código TypeScript (src/)  
**Arquivos analisados:** 45+ arquivos-fonte

---

# PARTE 1 — MAPEAMENTO REAL DA ARQUITETURA

| Componente Atual | Papel Atual | Equivalente Arquitetural | Problemas |
|---|---|---|---|
| **AgentController** (650 linhas) | Bootstrap, DI container, Whisper, comandos, scheduler | **Application Kernel** | Mistura DI, áudio, comandos, scheduler, skill registro. `getDatabase()` vaza. Scheduler acopla TelegramAdapter diretamente. |
| **AgentLoop** (918 linhas) | LLM call, tool exec, response parsing, sanitização, metrics, FSM conversa | **Task Orchestrator / Turn Engine** | Monolito. Prompt hardcoded (7 blocos ~150 linhas). Sanitização regex frágil. FSM implícita via early returns. `llmQueue` global concurrency=1. |
| **AgentStateManager** (100 linhas) | Estados: learning/assisting/exploring + confiança + foco | **State Manager (parcial)** | 3 estados apenas. Transições sem guards. Persiste no grafo como JSON (sem schema). `lastStates` é array em memória (perde no restart). |
| **StateStabilityGuard** (60 linhas) | Buffer de transições de foco | **Transition Guard (parcial)** | Apenas guarda `current_focus`. Sem guards para `mode` ou `confidence`. `changeBuffer` nunca é limpo exceto quando foco muda. |
| **MemoryManager** (1094 linhas) | ORM, Repository, Embedding, FTS, Graph, User profile, Settings, Trace | **Memory Facade (inflado)** | `getDatabase()` vaza para 15+ componentes. SQL hardcoded em 8+ métodos. Ontologia + schema + queries + embedding tudo misturado. |
| **MemoryGovernor** (670 linhas) | Decay, GC, conflict resolution, archive | **Memory Lifecycle Manager** | SQL direto. `accessLog` é Map em memória (perde no restart). Archive sem restore. |
| **AttentionLayer** (580 linhas) | Attention scoring com embedding + recency + connectivity + domain | **Attention Engine** | SQL direto. Não usa MemoryManager. Recomputa scores a cada query (sem cache estruturado). |
| **AttentionFeedback** (849 linhas) | Feedback cognitivo, saturação logarítmica, anti-dominância, anomalias | **Feedback Engine** | 3 `setInterval` background que NUNCA são parados no shutdown. SQL direto. Embedding cache sem TTL. |
| **CognitiveWorkspace** (170 linhas) | Working memory temporário com budget, TTL, distillation | **Scratchpad / Working Memory** | ✅ Bem desenhado. Budget, TTL, auto-prune, distillation. MAS: `toSystemContext()` vaza reasoning para o prompt sem validação de boundary. |
| **ProviderFactory** (1153 linhas) | Provider creation, retry, fallback, streaming, metrics, classification | **Provider Runtime Layer** | Monolito. Classification + retry + fallback + streaming + metrics tudo junto. Queue global concurrency=1. |
| **MessageBus** (284 linhas) | Roteamento de mensagens, typing indicator, comandos | **Message Gateway (parcial)** | Typing intervals sem cleanup garantido em crash. Comandos registrados no controller, não no bus. |
| **SessionManager** (581 linhas) | Sessões, JSONL, mutex, compressão, checkpoints | **Session Lifecycle Manager** | Mutex por sessão com timeout de 30s (pode não ser suficiente). JSONL cresce indefinidamente. `activeFiles` Map nunca limpo. |
| **SessionTranscript** (362 linhas) | Append-only JSONL com índice | **Event Log (parcial)** | Sem compactação automática. Sem TTL. WriteStream nunca é fechado explicitamente no shutdown. |
| **ContextBuilder** (140 linhas) | Seleção semântica de contexto com ranking | **Context Selector** | `getDatabase()` vaza. SQL direto em 3 métodos. Relevance Gate para greetings (bom). |
| **ContextBudget** (180 linhas) | Distribuição de orçamento de tokens por bloco | **Token Budget Manager** | ✅ Bem desenhado. Budget por bloco com prioridades. MAS: truncate regex pode cortar em ponto ruim. |
| **ContextCompressor** (80 linhas) | Compressão via LLM (DEPRECATED) | **Legacy** | Marcado como deprecated. SessionManager faz compressão própria. Deveria ser removido. |
| **ModelRouter** (328 linhas) | Classificação de intenção → roteamento de modelo | **Intent Router (duplicado)** | Duplica funcionalidade de `SimpleDecisionEngine` e `routeIntent`. Classification cache sem purge ativo. |
| **SimpleDecisionEngine** (100 linhas) | Classificação determinística por keywords | **Intent Router (duplicado)** | Duplica `routeIntent` e `ModelRouter`. Regex de keywords é frágil (match parcial). |
| **routeIntent** (80 linhas) | Roteamento determinístico por regex | **Intent Router (duplicado)** | Terceiro sistema de intent routing. Regex overlap com os outros dois. |
| **DecisionPostProcessor** (60 linhas) | Modulação de resposta por estado cognitivo | **Response Modulator** | ✅ Bem focado. Mas altera resposta via regex replace (frágil). Max 2 changes arbitrário. |
| **ObserverValidator** (90 linhas) | Validação pós-execução via LLM observador | **Quality Gate (parcial)** | Consome tokens extras. Fallback é `approved: true` (perigoso). Não valida reasoning, só resultado final. |
| **ClassificationMemory** (240 linhas) | Classificação adaptativa por contexto | **Classification Cache** | SQL direto. `detectContext()` é regex hardcoded. Não integra com ModelRouter. |
| **DecisionMemory** | Cache de decisões anteriores | **Decision Cache** | SQL direto. Sem TTL. Sem invalidação. |
| **SkillLearner** (507 linhas) | Auto-skill creation from patterns | **Procedural Memory (parcial)** | SQL direto. Proposals sem auto-cleanup. `status: proposed` acumula infinitamente. |
| **ExecutionTrace** (100 linhas) | Rastreabilidade do loop | **Trace Manager** | ✅ Bom. EventEmitter, steps tipados, stats. MAS: `recentTraces` limitado a 50 e nunca persistido. |
| **DashboardServer** (1793 linhas) | HTTP server, DB queries, templates, API, auth | **Observability Server (inflado)** | Monolito gigante. SQL direto em 20+ queries. Auth hardcoded. Templates inline. |

---

# PARTE 2 — FSM E LIFECYCLE

## FSMs Implícitas Detectadas

### 1. AgentLoop (FSM principal — NÃO declarada)

O `AgentLoop.process()` contém uma FSM implícita com transições por early returns e flags:

```
[RECEIVE_MSG] → classify_intent
  ├─ small_talk? → DIRECT_REPLY → [DONE]
  ├─ tool_match?  → EXECUTE_TOOL → check_result → [DONE | RETRY]
  └─ no_match?    → LLM_CALL → parse_response
                      ├─ has_tool_calls? → EXECUTE_TOOL → check_result
                      │    ├─ max_iterations? → [FORCE_REPLY]
                      │    └─ has_more_tools? → loop back to LLM_CALL
                      └─ no_tool_calls? → [DONE]
```

**Estados implícitos no código:**
- `IDLE` — nenhuma requisição em processamento (não existe explicitamente)
- `CLASSIFYING` — `SimpleDecisionEngine.classify()` ou `routeIntent()`
- `LLM_CALLING` — `chatWithFallback()` em andamento
- `TOOL_EXECUTING` — `tool.execute()` em andamento
- `ITERATING` — loop de tool calls (max 2 iterações)
- `REPLYING` — `sanitizeContent()` + envio
- `TIMEOUT` — `didTimeout: true` no resultado
- `ERROR` — catch block com fallback message

**Problemas:**
- Sem estado explícito — impossível saber o estado atual
- Sem transições formais — early returns e flags substituem guards
- Max iterations hardcoded (2) sem configuração
- Timeout é um "estado fantasma" — não muda comportamento do loop
- Cancelamento não existe — uma vez em LLM_CALL, não há como abortar

### 2. AgentStateManager (FSM de modo — MINIMAL)

```
learning ↔ assisting ↔ exploring
```

**Transições possíveis (sem guards):**
- `learning → assisting`: via `initializeAfterOnboarding()`
- `assisting → learning`: via `updateFromInteraction(success=false)`
- `exploring → *`: via `updateState({current_focus: 'exploring'})`

**Problemas:**
- `exploring` nunca é atribuído pelo código
- Transição `assisting → learning` por falha é perigosa (oscilação)
- Sem evento de transição — ninguém é notificado da mudança
- Estado é persistido como JSON no grafo (sem schema validation)

### 3. MessageBus (FSM de processamento — IMPLÍCITA)

```
[RECEIVE] → check_command
  ├─ command? → handle_command → [REPLY]
  ├─ attachment? → process_attachments → [REPLY | FALLBACK]
  └─ text? → AgentLoop.process → [REPLY]
  
finally → stopTypingIndicator
```

**Problemas:**
- Typing indicator pode vazar se processo crashar antes do finally
- Comandos são processados antes do AgentLoop (bypass de reasoning)
- Sem estado de "processando" — mensagens concorrentes podem colidir

### 4. SessionManager (FSM de compressão — IMPLÍCITA)

```
[ADDING_MSG] → check_threshold
  ├─ under_limit? → continue
  └─ over_limit? → compress → create_checkpoint → continue
```

**Problemas:**
- Compressão é síncrona e bloqueante
- Sem estado de "compressing" — nova mensagem pode chegar durante compressão
- Checkpoint pode falhar silenciosamente

## FSM Centralizada Proposta

```
ESTADOS OFICIAIS:

  IDLE ───────→ PLANNING ──────→ THINKING
    ↑               │                 │
    │               │                 ↓
    │               │           STREAMING
    │               │                 │
    │               ↓                 ↓
    │         EXECUTING_TOOL ←── WAITING_TOOL
    │               │                 │
    │               ↓                 │
    │         FINALIZING ←────────────┘
    │               │
    ↓               ↓
  DONE ←────── CANCELLED
    
  FAILED ←──── TIMEOUT
    │               │
    ↓               ↓
  RECOVERING ←─────┘
    │
    ↓
  IDLE | HALTED

TRANSIÇÕES VÁLIDAS:
  IDLE → PLANNING          (on user message)
  PLANNING → THINKING      (on intent classified)
  THINKING → STREAMING     (on LLM start)
  THINKING → EXECUTING_TOOL (on tool call parsed)
  STREAMING → FINALIZING    (on stream complete)
  EXECUTING_TOOL → WAITING_TOOL (on tool dispatched)
  WAITING_TOOL → EXECUTING_TOOL (on tool result, more tools)
  WAITING_TOOL → FINALIZING     (on tool result, no more tools)
  FINALIZING → DONE          (on response sent)
  FINALIZING → PLANNING      (on iteration needed)
  ANY → TIMEOUT              (on timeout)
  ANY → FAILED               (on unhandled error)
  ANY → CANCELLED            (on user cancel)
  TIMEOUT → RECOVERING       (on retry)
  FAILED → RECOVERING        (on retry)
  RECOVERING → PLANNING      (on recovery success)
  RECOVERING → HALTED         (on max retries)
  HALTED → IDLE              (on manual reset)

ESTADOS INVÁLIDOS (devem ser detectados):
  THINKING sem user input
  EXECUTING_TOOL sem tool call
  STREAMING sem LLM provider
  RECOVERING sem error context
```

---

# PARTE 3 — MEMÓRIA COGNITIVA

## Mapeamento de Tipos de Memória

| Tipo | Existe? | Componente | Status | Riscos |
|---|---|---|---|---|
| **Semantic Memory** | ✅ Completo | MemoryManager + Graph + AttentionLayer | Funcional | `getDatabase()` vaza. SQL em 8+ componentes. Sem schema migration. |
| **Episodic Memory** | 🟡 Parcial | SessionTranscript (JSONL) | Apenas log, sem retrieval estruturado | Sem query por episódio. Sem sumarização automática. JSONL cresce indefinidamente. |
| **Working Memory** | ✅ Bem feito | CognitiveWorkspace | Budget, TTL, auto-prune, distillation | `toSystemContext()` pode vazar reasoning para output. Não é isolado por sessão. |
| **Procedural Memory** | 🟡 Parcial | SkillLearner + auto_skills | Apenas proposals, sem auto-ativação | `status: proposed` acumula. Sem limpeza. Sem integração com intent routing. |
| **Scratchpad** | ✅ Funcional | CognitiveWorkspace (tipo `reasoning`, `planning`) | Tipos: planning, reasoning, reflection, error_recovery, self_correction | Reset por turno (bom). Mas sem persistência entre turnos (perde contexto de raciocínio longo). |
| **Reflection Memory** | ❌ Inexistente | — | Nenhum componente faz metacognição | Sem self-evaluation. Sem aprendizado de erros estruturado. ObserverValidator valida resultado, não reasoning. |

## Riscos de Contaminação de Memória

### 🔴 Recursive Self-Conditioning
**Risco:** BAIXO  
CognitiveWorkspace NÃO é persistido no grafo. Reset por turno. Comentário explícito: "NEVER persisted to semantic memory graph (prevents self-contamination)". ✅

### 🟠 Reasoning Contamination
**Risco:** MÉDIO  
`CognitiveWorkspace.toSystemContext()` injeta reasoning no prompt do LLM. Se o LLM reproduzir esse reasoning na resposta, `sanitizeContent()` tenta limpar com regex — mas regex é frágil e não cobre todos os casos. Além disso, o `ContextBuilder` pode injetar nós do grafo que foram criados a partir de raciocínio (sem marcação de confiança).

### 🔴 False Beliefs Persistence
**Risco:** ALTO  
MemoryManager.addNode() não valida a veracidade do conteúdo. Nós criados a partir de inferência do LLM são marcados como `source: 'inferred'` pelo Governor, MAS:
1. Inference confidence começa em 0.6 (alto demais para inference)
2. Reinforcement via attention pode inflar confiança de inferências
3. Sem validação humana antes de persistir
4. `MemoryGovernor.usefulBoost` (0.05) reforça nó que "ajudou", mesmo sendo inferência

### 🟠 Hallucinated Memory
**Risco:** MÉDIO  
O LLM pode gerar tool calls de `memory_write` com conteúdo alucinado. O sistema não tem verificação de factualidade antes de persistir. MemoryGovernor tem conflict detection, mas só detecta contradições, não alucinações.

### 🟡 Memory Drift
**Risco:** BAIXO-MÉDIO  
Decay factor de 0.98/dia é conservador. MAS: se um nó for acessado frequentemente (mesmo sem utilidade), `usefulBoost` previne decay. Sem mecanismo de "negative feedback" explícito do usuário.

---

# PARTE 4 — REASONING HYGIENE

## Análise de Sanitização

### `sanitizeContent()` (AgentLoop.ts, ~80 linhas)

**O que faz:**
1. Remove tags `<think>...</think>` e `thinking`
2. Remove `[TOOL_CALL]...[/TOOL_CALL]`
3. Remove bold residual `**`
4. Tenta parsear JSON action blocks
5. Remove code fences que envolvem toda a resposta
6. Remove fragmentos de system prompt que vazaram
7. Remove `thought` e `thinking` JSON fields
8. Remove prefixos de self-talk ("Let me...", "I'll...", "Vou...", "Devo...")

**Problemas:**
- **Regex frágil:** `/^(?:Let me|I'll|I should|...)/` — quebra em respostas multi-linha
- **Não tipa conteúdo:** Tudo é string, sem distinção FACT vs INFERENCE
- **Não filtra reasoning persistido:** Se reasoning vazar para o grafo via `memory_write`, sanitize não alcança
- **Provider-dependent:** Cada provider (Ollama, Gemini, DeepSeek) vaza reasoning em formatos diferentes
- **Pós-hoc:** Sanitiza DEPOIS que o LLM já processou, não previne vazamento

### Vazamentos Detectados

| # | Vazamento | Origem | Destino | Severidade |
|---|---|---|---|---|
| V1 | CognitiveWorkspace → prompt | `toSystemContext()` | LLM system message | 🟡 Médio — necessário para reasoning, mas sem boundary validation |
| V2 | System prompt → output | Prompt leaking | Resposta do usuário | 🔴 Alto — regex não cobre todos os casos |
| V3 | Tool result → memory | `memory_write` tool | Grafo semântico | 🔴 Alto — sem validação de factualidade |
| V4 | JSON action blocks | LLM response format | Output visível | 🟡 Médio — regex funciona mas é frágil |
| V5 | ContextCompression → LLM | Checkpoint de sessão | Provider de sumarização | 🟡 Médio — conteúdo interno vaza para outro provider |

## Classificação de Confiança Proposta

O sistema NÃO diferencia tipos de conteúdo. Tudo é `string`. Proposta:

| Tipo | Descrição | Exemplo | Persistir? |
|---|---|---|---|
| **FACT** | Informação verificada externamente | "BTC: $67,432" (via web_search) | ✅ confidence: 1.0 |
| **INFERENCE** | Dedução lógica do LLM | "Baseado no padrão, provavelmente..." | ✅ confidence: 0.6 |
| **HYPOTHESIS** | Hipótese não verificada | "Parece que o servidor pode estar..." | ⚠️ confidence: 0.3, TTL curto |
| **REASONING** | Chain-of-thought interno | Passos de planejamento | ❌ Nunca persistir |
| **SPECULATION** | Especulação explícita | "Talvez futuramente..." | ❌ Nunca persistir |
| **TOOL_RESULT** | Output de ferramenta | Resultado do exec_command | ✅ confidence: 0.9 (verificado) |
| **USER_INPUT** | Input direto do usuário | "Meu nome é Luciano" | ✅ confidence: 1.0 (explicit) |

**Implementação atual:** Apenas `source: 'explicit' | 'inferred' | 'system'` no MemoryGovernor — insuficiente.

---

# PARTE 5 — TOOL ORCHESTRATION

## Tool Lifecycle Atual

```
Registro → AgentLoop.process() → SimpleDecisionEngine/routeIntent → tool.execute() → ToolResult
```

**Problemas:**

| # | Problema | Detalhe |
|---|---|---|
| T1 | **Sem retry** | Se `tool.execute()` falha, o LLM pode tentar de novo, mas sem retry automático |
| T2 | **Sem timeout por tool** | Timeout global do LLM (60-120s), mas ferramenta individual pode travar |
| T3 | **Sem paralelismo** | Tools executam serialmente no loop |
| T4 | **Sem cancelamento** | Uma vez em execução, não há como abortar |
| T5 | **Sem validação de input** | `args` é `Record<string, any>` — sem schema |
| T6 | **Result é string** | `ToolResult.output: string` — sem tipagem estruturada |
| T7 | **3 sistemas de routing** | `SimpleDecisionEngine`, `routeIntent`, `ModelRouter` — overlap de keywords |
| T8 | **Sem dead letter queue** | Tool failures são logadas mas não enfileiradas para retry |
| T9 | **Max iterations = 2** | Hardcoded, sem configuração |
| T10 | **Tool registry global** | `ToolRegistry` é Map simples, sem namespacing |

## Ferramentas Terminais

| Ferramenta | Pode Terminar? | Risco |
|---|---|---|
| `web_search` | ✅ Sim | Resultado pode ser grande |
| `exec_command` | ✅ Sim | ⚠️ Comando destrutivo sem confirmação |
| `send_audio` | ✅ Sim | Side effect irreversível |
| `send_document` | ✅ Sim | Side effect irreversível |
| `memory_write` | ✅ Sim | ⚠️ Persiste sem validação |
| `crypto_analysis` | ✅ Sim | Pode demorar |

## Ferramentas Long-Running

| Ferramenta | Timeout | Risco |
|---|---|---|
| `exec_command` | ❌ Sem timeout | Pode travar indefinidamente |
| `web_search` | ❌ Sem timeout | Depende de fetch externo |
| `ssh_exec` | ❌ Sem timeout | SSH pode travar |

## Schedulers/Queues Implícitos

| Componente | Tipo | Detalhe |
|---|---|---|
| `llmQueue` (PQueue) | Queue serial | Concurrency=1, global, sem prioridade |
| `classificationQueue` (PQueue) | Queue serial | Concurrency=1, para classificação de modelo |
| `SessionManager.sessionMutexes` | Mutex Map | Mutex por sessão, timeout 30s |
| `AttentionFeedback.timers` | 3x setInterval | Decay, normalização, monitoramento |

---

# PARTE 6 — OBSERVABILIDADE

## O Que Existe

| Componente | Tipo | Detalhe |
|---|---|---|
| `AppLogger` | Logger estruturado | ✅ `createLogger('Component')` com níveis |
| `ExecutionTrace` | Trace de loop | ✅ Steps tipados, EventEmitter, stats |
| `LoopMetrics` | Metrics por turno | ✅ Timestamp, tempo, provider, tokens, timeout |
| `SessionTranscript` | Event log JSONL | ✅ Append-only com índice |
| `AttentionFeedback.stats()` | Métricas de atenção | ✅ Nós ativos, reinforcement, anomalias |
| `DashboardServer` | HTTP dashboard | ✅ SSE endpoints, stats, traces |

## O Que FALTA

| # | Capacidade | Status | Impacto |
|---|---|---|---|
| O1 | **Correlation IDs** | ❌ Inexistente | Impossível rastrear request end-to-end |
| O2 | **Session Replay** | ❌ Inexistente | Impossível reproduzir bugs |
| O3 | **Cognitive Timeline** | ❌ Inexistente | Impossível ver raciocínio em timeline |
| O4 | **State Transition Logs** | ❌ Inexistente | FSM implícita = sem log de transição |
| O5 | **Memory Activation Tracing** | ❌ Inexistente | Não se sabe quais nós foram usados em cada turno |
| O6 | **Tool Execution Graph** | ❌ Inexistente | Não se sabe qual tool gerou qual resultado |
| O7 | **Stream Event Replay** | ❌ Inexistente | Streaming não é logado |
| O8 | **Distributed Tracing** | ❌ Inexistente | Sem span IDs, sem trace propagation |
| O9 | **Health Check Estruturado** | 🟡 Parcial | DashboardServer tem `/api/health` mas é ad-hoc |
| O10 | **Alertas** | ❌ Inexistente | Anomalias são logadas mas não acionam ações |

---

# PARTE 7 — BOUNDARY MANAGEMENT

## Separação Atual

| Camada | Componentes | Vazamentos |
|---|---|---|
| **Channel** | TelegramAdapter, DiscordAdapter, SignalAdapter, WhatsAppAdapter | `botToken` vaza pelo pipeline |
| **Bus** | MessageBus | Typing intervals sem cleanup, comandos bypassam reasoning |
| **Loop** | AgentLoop, ContextBuilder, ContextBudget, DecisionPostProcessor | Acessa DB direto, CognitiveWorkspace vaza para prompt |
| **Memory** | MemoryManager, Governor, AttentionLayer, Feedback | `getDatabase()` vaza para 15+ componentes |
| **State** | AgentStateManager, StateStabilityGuard | Persiste como JSON sem schema, `lastStates` em memória |
| **Cognitive** | CognitiveWorkspace | `toSystemContext()` sem boundary validation |
| **Tools** | 15+ ferramentas | Recebem contexto via `setContext(any)`, sem tipagem |

## 10 Boundary Leaks Críticos

| # | Leak | Severidade | Detalhe |
|---|---|---|---|
| L1 | **`getDatabase()` vaza para 15+ componentes** | 🔴 Crítico | SkillLearner, AuditorService, AttentionLayer, AttentionFeedback, ClassificationMemory, DecisionMemory, ContextBuilder, SchedulerService, OnboardingService — todos recebem DB bruto |
| L2 | **`botToken` vaza pelo pipeline** | 🔴 Alto | ChannelContext.carries `botToken` do Telegram |
| L3 | **Scheduler → TelegramAdapter acoplado** | 🔴 Crítico | `scheduler.setTriggerHandler` acessa `telegramAdapter.sendToChat()` diretamente |
| L4 | **Whisper/TTS no AgentController** | 🟡 Médio | Lógica de áudio (download, conversão, fallback) deveria ser AudioService |
| L5 | **MemoryManager é facade mas vaza DB** | 🟠 Alto | Qualquer componente pode fazer SQL direto |
| L6 | **CognitiveWorkspace → prompt sem validação** | 🟡 Médio | `toSystemContext()` injeta reasoning sem tipo |
| L7 | **ProviderFactory acessado diretamente pelo Loop** | 🟡 Médio | LLM routing não é isolado |
| L8 | **3 sistemas de intent routing** | 🟡 Médio | SimpleDecisionEngine, routeIntent, ModelRouter |
| L9 | **ContextBuilder faz SQL direto** | 🟡 Médio | `getConnectivity()`, `getRecency()`, `getTopRelations()` |
| L10 | **AttentionFeedback timers órfãos** | 🟠 Alto | 3 setInterval nunca parados no shutdown |

## 8 Cross-Layer Contaminations

| # | Contaminação | Detalhe |
|---|---|---|
| C1 | **Lógica de negócio no Controller** | Comandos `/clear`, `/skills`, `/skill_approve` com SQL direto |
| C2 | **Apresentação no Loop** | `sanitizeContent()`, formatação de erro amigável |
| C3 | **Prompt engineering hardcoded** | 7 blocos ~150 linhas no AgentLoop |
| C4 | **SQL em AttentionLayer/Feedback/Governor** | Queries SQL hardcoded sem Repository |
| C5 | **Whisper/TTS no Controller** | Download, conversão, fallback de API |
| C6 | **Intent routing triplicado** | SimpleDecisionEngine + routeIntent + ModelRouter |
| C7 | **Embedding hardcoded no MemoryManager** | URL `http://localhost:11434` embutida |
| C8 | **SessionManager gerencia filesystem + DB + mutex + compressão** | 4 responsabilidades em 1 classe |

---

# PARTE 8 — AI OPERATING SYSTEM READINESS

| Área | Nota | Comentários |
|---|---|---|
| **Cognição** | 6/10 | CognitiveWorkspace com budget, TTL, distillation. Mas sem metacognição formal, sem reflection memory, sem validation de coerência. |
| **FSM** | 3/10 | AgentStateManager tem 3 estados sem guards. AgentLoop é FSM implícita com early returns. StateStabilityGuard só protege focus. Sem máquina de estados formal. |
| **Lifecycle** | 4/10 | Bootstrap funciona. Shutdown INCOMPLETO: AttentionFeedback timers nunca parados. Session cleanup por setInterval. JSONL WriteStream sem close explícito. |
| **Memória** | 7/10 | Grafo semântico robusto com ontologia, attention, feedback com saturação, governor com decay/conflict/GC. MAS: DB vaza, embedding hardcoded, sem episodic memory retrieval. |
| **Tool orchestration** | 5/10 | 15+ tools registradas. MAS: sem retry, sem timeout por tool, sem paralelismo, sem cancelamento, result é string, 3 sistemas de routing duplicados. |
| **Recovery** | 3/10 | Fallback de provider funciona. MAS: sem circuit breaker, sem dead letter queue, sem recovery de sessão, timeout é "tente de novo com outro provider". |
| **Observabilidade** | 5/10 | Logs estruturados, ExecutionTrace, metrics, dashboard SSE. MAS: sem correlation IDs, sem replay, sem cognitive timeline, sem distributed tracing. |
| **Segurança cognitiva** | 5/10 | `sanitizeContent()` tenta filtrar. Anti-injection prompt existe. MAS: sem sandbox de tools, sem rate limiting, system prompt acessível via memory_write. |
| **Boundary management** | 3/10 | Zero separação formal. `getDatabase()` vaza para 15+ componentes. Sem protocolo tipado. Sem visibility model. Sem authority model. |
| **Escalabilidade** | 4/10 | PQueue concurrency=1 serializa LLM. SQLite single-writer. Sem horizontal scaling. Multi-user com contenção global. |
| **Concorrência** | 3/10 | Mutex por sessão existe. MAS: LLM queue é global serial. Sem priority queue. Uma requisição lenta bloqueia todas. |
| **Reasoning hygiene** | 5/10 | CognitiveWorkspace tem governança. MAS: `toSystemContext()` vaza reasoning sem boundary. sanitizeContent é regex. Sem classificação de confiança. |
| **Runtime architecture** | 4/10 | Node.js single-thread. Sem worker threads para tools. Sem graceful shutdown. Sem health monitoring automático. |
| **Agent isolation** | 3/10 | Sem sandbox. Tools executam no mesmo processo. Memória compartilhada entre sessões. Sem isolamento de contexto. |

**Nota média: 4.0/10** — Funcional como chatbot, não robusto como AI OS.

---

# PARTE 9 — ROADMAP ARQUITETURAL

## 1. O Que Já Está Pronto (Funcional)

| Componente | Estado | Qualidade |
|---|---|---|
| Memory Graph (Semantic) | ✅ Funcional | Boa (ontologia, attention, feedback, governor) |
| CognitiveWorkspace (Working) | ✅ Funcional | Boa (budget, TTL, distillation) |
| Multi-channel (4 adapters) | ✅ Funcional | Boa (Telegram, Discord, Signal, WhatsApp) |
| Session Management | ✅ Funcional | Média (JSONL, mutex, compressão) |
| LLM Provider Fallback | ✅ Funcional | Boa (4 providers, retry automático) |
| Context Budget | ✅ Funcional | Boa (distribuição por prioridade) |
| Execution Trace | ✅ Funcional | Média (EventEmitter, steps) |
| Skill Learning | 🟡 Parcial | Média (proposals, sem auto-ativação) |
| Decision PostProcessor | ✅ Funcional | Boa (modulação por estado) |
| Observer Validator | ✅ Funcional | Média (validação pós-execução) |

## 2. O Que Precisa Refatorar

| Componente | Problema | Ação |
|---|---|---|
| AgentController (650 linhas) | Monolito: DI + áudio + comandos + scheduler | Extrair AudioService, CommandRegistry, SchedulerBridge |
| AgentLoop (918 linhas) | Monolito: LLM + tools + sanitização + FSM | Separar TurnEngine, ResponseSanitizer, IterationController |
| MemoryManager (1094 linhas) | Monolito: ORM + Repository + Embedding + Graph | Extrair GraphRepository, EmbeddingService, SettingsRepository |
| DashboardServer (1793 linhas) | Monolito: HTTP + DB + templates + auth | Extrair API routes, TemplateEngine, AuthService |
| ProviderFactory (1153 linhas) | Monolito: Provider + retry + fallback + streaming + classification | Extrair ProviderRegistry, RetryPolicy, StreamingAdapter, ModelClassifier |
| AttentionFeedback (849 linhas) | Lógica + SQL + cache + timers | Extrair FeedbackRepository, FeedbackScheduler |

## 3. O Que Precisa Modularizar

| Módulo | Ação |
|---|---|
| Intent Routing | Unificar SimpleDecisionEngine + routeIntent + ModelRouter → IntentRouter |
| FSM | Criar AgentFSM formal com estados, guards, transições |
| Memory Access | Criar MemoryFacade que esconde getDatabase() |
| Tool Execution | Criar ToolExecutor com timeout, retry, schema validation |
| Session Lifecycle | Separar SessionStore, CompressionService, CheckpointManager |
| Audio Pipeline | Extrair AudioService (Whisper + TTS + conversão) |
| Command System | Extrair CommandRegistry com handler registration |

## 4. O Que Precisa Desacoplar

| Acoplamento | Ação |
|---|---|
| getDatabase() → 15 componentes | MemoryFacade com interfaces tipadas |
| Scheduler → TelegramAdapter | Event bus: scheduler emite evento, adapter escuta |
| AgentLoop → MemoryManager direto | Via MemoryFacade |
| AgentLoop → ProviderFactory direto | Via ProviderInterface |
| ContextBuilder → SQL direto | Via MemoryFacade |
| AttentionFeedback → SQL direto | Via FeedbackRepository |

## 5. O Que Precisa Remover

| Componente | Razão |
|---|---|
| ContextCompressor | Marcado como deprecated, SessionManager faz próprio |
| SimpleDecisionEngine | Duplica routeIntent e ModelRouter |
| routeIntent.ts | Duplica SimpleDecisionEngine e ModelRouter |
| Prompt blocks hardcoded no AgentLoop | Mover para PromptRegistry (YAML/JSON) |
| `getDatabase()` público | Substituir por MemoryFacade |

## 6. O Que Precisa Nascer como Novo Subsystem

| Subsystem | Responsabilidade |
|---|---|
| **AgentFSM** | Máquina de estados formal com transições, guards, eventos |
| **MemoryFacade** | Interface tipada que esconde DB, embeddings, attention |
| **TypedMessageBus** | Protocolo tipado com Envelope<T>, correlationId, source/target |
| **ToolExecutor** | Executor com timeout, retry, schema validation, cancelamento |
| **AudioService** | Whisper + TTS + conversão de áudio isolado do controller |
| **CommandRegistry** | Registro de comandos com handler, middleware, permission |
| **ReflectionEngine** | Metacognição: self-evaluation, error learning, reasoning validation |
| **ConfidenceClassifier** | Tipagem FACT/INFERENCE/HYPOTHESIS/SPECULATION para conteúdo |
| **EventBus** | Desacoplamento: scheduler → event → adapter |
| **LifecycleManager** | Start/stop ordenado, graceful shutdown, health checks |

---

## PRIORIZAÇÃO

### 🔴 Curto Prazo (1-2 semanas) — Estabilidade & Observabilidade

| # | Ação | Impacto | Esforço |
|---|---|---|---|
| 1 | **MemoryFacade** — Interface tipada que esconde `getDatabase()` | 🔴 Crítico — elimina 15 vazamentos | 2-3 dias |
| 2 | **LifecycleManager** — Start/stop de timers, WriteStream, services | 🔴 Crítico — elimina leaks de shutdown | 1 dia |
| 3 | **Graceful Shutdown** — Parar AttentionFeedback timers, fechar streams | 🔴 Crítico — impede resource leak | 0.5 dia |
| 4 | **Unificar IntentRouter** — Eliminar SimpleDecisionEngine e routeIntent | 🟡 Médio — reduz confusão e bugs | 1 dia |
| 5 | **AgentFSM básica** — Estados IDLE, THINKING, EXECUTING_TOOL, DONE | 🟡 Médio — permite observabilidade | 2 dias |
| 6 | **EventBus básico** — emit/subscribe para scheduler → adapter | 🟡 Médio — desacopla scheduler | 1 dia |

### 🟡 Médio Prazo (2-6 semanas) — Arquitetura & Modularização

| # | Ação | Impacto | Esforço |
|---|---|---|---|
| 7 | Refatorar AgentController (5 módulos) | Alto — reduz 650 → 5 módulos | 3-5 dias |
| 8 | Refatorar AgentLoop (TurnEngine, Sanitizer, Iteration) | Alto — reduz 918 → 3 módulos | 3-5 dias |
| 9 | Refatorar MemoryManager (Repository, Embedding, Settings) | Alto — reduz 1094 → 4 módulos | 3-5 dias |
| 10 | Protocolo Tipado de Mensagens (Envelope<T>) | Alto — define contratos | 2-3 dias |
| 11 | ConfidenceClassifier (FACT/INFERENCE/SPECULATION) | Médio — previne contaminação | 2 dias |
| 12 | ToolExecutor com timeout + retry + cancelamento | Médio — robustez de tools | 2-3 dias |
| 13 | PromptRegistry (YAML versionado) | Médio — desacopla prompts | 1 dia |
| 14 | Session cleanup automático (TTL + compactação) | Médio — previne crescimento | 1 dia |
| 15 | Circuit Breaker no ProviderFactory | Médio — previne cascading failures | 1-2 dias |

### 🟢 Longo Prazo (6-12 semanas) — Cognitive Runtime

| # | Ação | Impacto | Esforço |
|---|---|---|---|
| 16 | ReflectionEngine (metacognição, self-evaluation) | Alto — AI OS capability | 2-3 semanas |
| 17 | Streaming real de LLM (StreamEvent protocol) | Alto — UX + observabilidade | 1-2 semanas |
| 18 | Priority Queue (substituir PQueue concurrency=1) | Alto — multi-user | 1 semana |
| 19 | Dead Letter Queue para tool failures | Médio — recovery | 3-5 dias |
| 20 | Distributed Tracing (correlation IDs, span IDs) | Médio — observabilidade | 1 semana |
| 21 | Agent Isolation (sandbox de tools, sessões isoladas) | Alto — segurança | 2-3 semanas |
| 22 | Horizontal Scaling (SQLite → PostgreSQL) | Alto — escalabilidade | 2-3 semanas |
| 23 | Episodic Memory (retrieval estruturado de sessões) | Médio — cognição | 1-2 semanas |
| 24 | Session Replay Infrastructure | Médio — debugging | 1 semana |
| 25 | Cognitive Timeline (visualização de raciocínio) | Médio — observabilidade | 1 semana |

---

## Resumo Executivo

**NewClaw é um sistema agentic funcional** com memória semântica robusta, multi-canal operacional, e mecanismos cognitivos (attention, feedback, governor) bem pensados. MAS:

1. **É um chat wrapper, não um AI OS** — FSM implícita, sem lifecycle management, sem boundary enforcement
2. **`getDatabase()` é o vazamento sistêmico** — 15+ componentes acessam SQL direto, zero abstração
3. **3 sistemas de intent routing se sobrepõem** — confusão, não robustez
4. **Reasoning vaza sem classificação** — tudo é string, sem FACT vs INFERENCE
5. **Shutdown é incompleto** — timers órfãos, streams não fechados
6. **Observabilidade é superficial** — logs sim, correlation IDs não, replay não

**Ação imediata de maior impacto:** MemoryFacade + LifecycleManager + AgentFSM básica. Menos de 1 semana de trabalho, muda fundamentalmente a capacidade de observabilidade e robustez do sistema.