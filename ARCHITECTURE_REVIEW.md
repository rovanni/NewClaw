# NewClaw — Revisão Arquitetural Completa

## PARTE 7 — DIAGNÓSTICO DE BOUNDARIES & LEAKS

---

### 7.1 Boundary Leaks Detectados

| # | Leak | Origem → Destino | Severidade | Detalhe |
|---|------|-------------------|------------|---------|
| L1 | **MemoryManager vaza para todos** | `MemoryManager.getDatabase()` | 🔴 Crítico | 15+ componentes recebem `Database.Database` bruto e executam SQL direto. Zero abstração de dados. |
| L2 | **AgentController vaza config para Tools** | `AgentController.transcribeAttachment()` | 🟡 Médio | Método privado do controller acessa `this.config` para Whisper/TTS — tools deveriam receber isso via injeção |
| L3 | **SessionManager vaza MemoryManager** | `SessionManager.getMemory()` | 🟡 Médio | Expõe a instância inteira de MemoryManager para qualquer consumidor |
| L4 | **ProviderFactory acessado diretamente** | `AgentLoop.providerFactory` público | 🟡 Médio | LLM routing e fallback são acoplados ao AgentLoop, não isolados |
| L5 | **ChannelContext cru no AgentLoop** | `ChannelContext` com `botToken` | 🟠 Alto | `botToken` do Telegram vaza pelo pipeline inteiro: Adapter → MessageBus → AgentLoop → Tools |
| L6 | **SkillLearner recebe DB bruto** | `new SkillLearner(db)` | 🟡 Médio | Acesso SQL direto à tabela `auto_skills` sem interface |
| L7 | **AuditorService recebe DB bruto** | `new AuditorService({...}, this.memory.getDatabase())` | 🟡 Médio | Auditoria acessa DB diretamente, sem repository |
| L8 | **AttentionFeedback background timers** | `setInterval` interno | 🟠 Alto | Timers de decaimento/normalização rodam sem lifecycle management — nunca são limpos no shutdown |
| L9 | **Scheduler → TelegramAdapter** | `controller.scheduler.setTriggerHandler` | 🔴 Crítico | Scheduler acessa `this.telegramAdapter.sendToChat()` diretamente — acoplamento hardcoded |
| L10 | **EmbeddingService hardcoded** | `MemoryManager.generateEmbedding()` | 🟡 Médio | URL do Ollama embutida no código (`http://localhost:11434`) sem configuração |

---

### 7.2 Cross-Layer Contamination

| # | Contaminação | Arquivo(s) | Detalhe |
|---|-------------|------------|---------|
| C1 | **Lógica de negócio no Controller** | `AgentController.ts` (650 linhas) | Controller registra comandos `/clear`, `/skills`, `/skill_approve` com SQL direto. Responsabilidade de UI + negócio + infra. |
| C2 | **Apresentação no Loop** | `AgentLoop.ts` (918 linhas) | Sanitização de output (`sanitizeContent`), formatação de mensagens de erro para usuário, e lógica de "resposta amigável" no AgentLoop. |
| C3 | **Prompt Engineering hardcoded** | `AgentLoop.PROMPT_COMPONENTS` | 7 blocos de prompt (~150 linhas) hardcoded no loop. Deveriam ser configuração/arquivo externo. |
| C4 | **SQL em MemoryGovernor** | `MemoryGovernor.ts` | Governador faz `SELECT * FROM memory_nodes` e manipula resultados diretamente. Deveria usar Repository pattern. |
| C5 | **SQL em AttentionLayer** | `AttentionLayer.ts` | Queries SQL hardcoded para cálculo de atenção. Não usa MemoryManager. |
| C6 | **SQL em AttentionFeedback** | `AttentionFeedback.ts` | 846 linhas de lógica de feedback + SQL direto. Deveria ser separado em Repository + Service. |
| C7 | **Infraestrutura em SessionManager** | `SessionManager.ts` | Gerencia filesystem (JSONL), SQLite (checkpoints), mutexes, e compressão de contexto no mesmo arquivo. |
| C8 | **Whisper/TTS no Controller** | `AgentController.transcribeAttachment()` | Lógica de download, conversão de áudio, fallback de API — claramente responsabilidade de um AudioService. |
| C9 | **Tool routing duplicado** | `routeIntent.ts` + `SimpleDecisionEngine.ts` | Dois sistemas de intent routing com regex overlapped. Nenhum é usado consistentemente. |
| C10 | **Embedding no MemoryManager** | `MemoryManager.semanticSearch()` | Geração de embeddings hardcoded (Ollama nomic-embed-text) dentro do facade de memória. |

---

### 7.3 Mixed Responsibilities

| Arquivo | Linhas | Responsabilidades Misturadas |
|---------|--------|----------------------------|
| `AgentController.ts` | 650 | Bootstrap, DI container, comando handling, Whisper transcrição, scheduler trigger, skill registro, system prompt builder |
| `AgentLoop.ts` | 918 | LLM call, tool execution, response parsing, sanitização de output, metrics, FSM de conversa, greeting fast-path |
| `MemoryManager.ts` | 1094 | ORM, Repository, Embedding, FTS, Graph traversal, User profile, Bootstrap do grafo, Metrics, Settings, Trace persistence |
| `MemoryGovernor.ts` | 670 | Governance + SQL direto + Archive logic + Conflict resolution |
| `AttentionFeedback.ts` | 849 | Feedback logic + SQL direto + Embedding cache + Background timers + Anomaly detection |
| `DashboardServer.ts` | 1793 | HTTP server + DB queries + Template rendering + API routing + Auth |
| `AuditorService.ts` | 1687 | Self-audit + SQL + File scanning + LLM calls + Auto-fix |
| `ProviderFactory.ts` | 1153 | Provider creation + Retry logic + Fallback + Streaming + Metrics + Classification |

---

### 7.4 Stream Leakage

| # | Leak | Detalhe |
|---|------|---------|
| S1 | **LLM streaming não implementado** | `ProviderFactory` tem métodos de streaming mas `AgentLoop` sempre usa `chatWithFallback()` síncrono. Tokens são processados em bloco, não em stream. |
| S2 | **Tool results fluem como strings** | Resultados de tools são `string` sem tipagem. Sem protocolo de resultado — erro, sucesso, e dados misturados em texto. |
| S3 | **Typing indicator leak** | `MessageBus.startTypingIndicator()` usa `setInterval` sem cleanup garantido em todos os paths de erro. |
| S4 | **CognitiveWorkspace → LLM** | `CognitiveWorkspace.toSystemContext()` injeta raciocínio interno no prompt do LLM. Não há validação de boundary — conteúdo interno pode vazar para a resposta. |
| S5 | **Session compression leak** | `ContextCompressor` envia mensagens para LLM para sumarizar. Conteúdo do checkpoint vaza para outro provider sem isolamento. |

---

### 7.5 Memory Leakage

| # | Leak | Arquivo | Detalhe |
|---|------|---------|---------|
| M1 | **Session Map cresce sem bound** | `SessionManager.sessions: Map<string, SessionTranscript>` | Cleanup existe (`cleanupInactiveSessions`) mas é chamado apenas via `setInterval` no controller. Em multi-user, pode crescer indefinidamente. |
| M2 | **ClassificationCache sem TTL real** | `ModelRouter.classificationCache` | Map com TTL de 5 min, mas nunca é purgado ativamente. Em uso prolongado, acumula entradas expiradas. |
| M3 | **Metrics ring buffer sem compactação** | `AgentLoop.metrics: LoopMetrics[]` | Limite de 100, mas `shift()` é O(n). Em alta frequência, gera pressão de GC. |
| M4 | **AttentionFeedback.embeddingCache** | `embeddingCache: Map<string, Float64Array>` | Limite de 500, mas eviction remove apenas 100 de cada vez. Embeddings são ~3KB cada = 1.5MB no pior caso. |
| M5 | **ChangeBuffer no StateStabilityGuard** | `changeBuffer: Map<string, {value, count}>` | Nunca é limpo exceto quando o foco muda. Em uso prolongado, acumula estados antigos. |
| M6 | **ActiveFiles por sessão** | `SessionManager.activeFiles: Map<string, Set<string>>` | Limite de 10 por sessão, mas o Map principal nunca é limpo quando sessões expiram. |
| M7 | **JSONL transcript files crescem** | `SessionTranscript` | Compactação existe (`compactSession`) mas nunca é chamada automaticamente. Arquivos crescem indefinidamente. |
| M8 | **Typing intervals** | `MessageBus.typingIntervals: Map<string, NodeJS.Timeout>` | Limpos em `finally`, mas se o processo crashar, intervals órfãos podem acumular. |
| M9 | **Background timers do AttentionFeedback** | 3 `setInterval` | Nunca são parados no shutdown do AgentController. `stopBackgroundJobs()` existe mas não é chamado. |

---

### 7.6 Proposals

#### 7.6.1 Protocolo Tipado de Mensagens

```typescript
// src/protocol/messages.ts

interface Envelope<T extends Payload> {
  id: string;                    // UUID v4
  timestamp: string;              // ISO 8601
  source: Layer;                  // 'channel' | 'loop' | 'memory' | 'tool' | 'cognitive'
  target: Layer;
  correlationId?: string;        // Para rastrear request/response
  metadata: Record<string, unknown>;
  payload: T;
}

// Payloads tipados (discriminados)
type Payload =
  | UserMessagePayload
  | AssistantMessagePayload
  | ToolCallPayload
  | ToolResultPayload
  | MemoryQueryPayload
  | MemoryResponsePayload
  | StateTransitionPayload
  | ErrorResponsePayload;

interface UserMessagePayload {
  kind: 'user_message';
  text: string;
  channel: ChannelType;
  userId: string;
  attachments?: Attachment[];
}

interface ToolResultPayload {
  kind: 'tool_result';
  toolName: string;
  success: boolean;
  output: string;
  durationMs: number;
}

interface ErrorResponsePayload {
  kind: 'error';
  code: string;
  message: string;
  recoverable: boolean;
  retryable: boolean;
}
```

**Benefícios:**
- Tipagem garante contrato entre camadas
- `correlationId` permite rastrear requisições end-to-end
- `source/target` previne acesso cross-layer
- `ErrorResponsePayload` com `recoverable/retryable` permite FSM de recovery

---

#### 7.6.2 Structured Stream Protocol

```typescript
// src/protocol/stream.ts

type StreamEvent =
  | { type: 'chunk'; content: string; index: number }
  | { type: 'tool_start'; tool: string; input: Record<string, unknown> }
  | { type: 'tool_end'; tool: string; result: ToolResultPayload }
  | { type: 'thinking'; content: string }     // CognitiveWorkspace
  | { type: 'state_change'; from: AgentState; to: AgentState }
  | { type: 'checkpoint'; summary: string }
  | { type: 'complete'; finalText: string; metrics: LoopMetrics }
  | { type: 'error'; error: ErrorResponsePayload };

interface StreamSink {
  onEvent(event: StreamEvent): Promise<void>;
  onComplete(finalText: string): Promise<void>;
  onError(error: ErrorResponsePayload): Promise<void>;
}
```

**Benefícios:**
- Substitui o padrão atual de "string concatenation + polling"
- Permite streaming real para o Telegram (typing + chunks)
- CognitiveWorkspace emite eventos de thinking separados do output
- State transitions são observáveis em tempo real

---

#### 7.6.3 Visibility Model (O que vê o quê)

```
┌─────────────────────────────────────────────────────┐
│                    CHANNEL LAYER                      │
│  TelegramAdapter │ DiscordAdapter │ WhatsAppAdapter   │
│         ↓ vê apenas: NormalizedMessage/Response       │
├─────────────────────────────────────────────────────┤
│                    MESSAGE BUS                        │
│         ↓ vê: Envelope<UserMessagePayload>             │
├─────────────────────────────────────────────────────┤
│                  AGENT LOOP                           │
│  Vê: SessionContext, CognitiveWorkspace, Tools        │
│  NÃO vê: DB bruto, embeddings, SQL                   │
├─────────────────────────────────────────────────────┤
│               MEMORY LAYER                           │
│  MemoryFacade (interface)                            │
│  ├── GraphRepository (SQL isolado)                   │
│  ├── EmbeddingService (HTTP isolado)                 │
│  ├── AttentionService (cálculos isolados)             │
│  └── GovernanceService (decay/conflict isolado)       │
│         ↓ vê apenas: MemoryQueryPayload/Response      │
├─────────────────────────────────────────────────────┤
│                  STATE LAYER                          │
│  AgentStateManager → StateStabilityGuard              │
│  NÃO vê: DB, Messages, Tools                         │
├─────────────────────────────────────────────────────┤
│                 COGNITIVE LAYER                       │
│  CognitiveWorkspace (interno ao Loop)                 │
│  NUNCA persistido, NUNCA mostrado ao usuário          │
│  NUNCA acessado por outras camadas                   │
└─────────────────────────────────────────────────────┘
```

**Regra fundamental:** Cada camada só vê a interface da camada imediatamente abaixo. `getDatabase()` é proibido fora do Memory Layer.

---

#### 7.6.4 Authority Model (Quem pode fazer o quê)

| Authority | Component | Pode Fazer | Não Pode Fazer |
|-----------|-----------|------------|----------------|
| **Channel** | TelegramAdapter | Normalizar mensagens, enviar respostas | Acessar DB, chamar LLM, modificar estado |
| **Bus** | MessageBus | Roteamento, typing indicator, comandos | Executar tools, acessar memória |
| **Loop** | AgentLoop | Orquestrar turno, chamar LLM, executar tools | Acessar DB diretamente, modificar estado sem FSM |
| **Memory** | MemoryFacade | Query/update grafo, embeddings, attention | Chamar LLM, acessar channels |
| **State** | AgentStateManager | Transições de estado, stability guard | Acessar DB, chamar LLM, tools |
| **Cognitive** | CognitiveWorkspace | Raciocínio temporário, auto-correção | Persistir, vazar para output, acessar DB |
| **Governor** | MemoryGovernor | Decay, GC, conflict resolution | Chamar LLM, acessar channels, modificar estado do agente |

---

## PARTE 8 — AI OPERATING SYSTEM READINESS

| Área | Nota | Comentários |
|------|------|-------------|
| **Cognição** | 6/10 | CognitiveWorkspace existe com budget e TTL. Mas não é integrado ao prompt de forma governada — `toSystemContext()` é chamado mas o conteúdo pode vazar. Faltam: reasoning chains estruturados, metacognição, self-reflection explícito. |
| **FSM** | 4/10 | `AgentStateManager` tem estados (learning/assisting/exploring) mas transições são implícitas e não-event-driven. Não existe FSM formal — estados mudam por `updateState()` direto sem guards transicionais. `StateStabilityGuard` é um buffer, não uma máquina de estados. |
| **Lifecycle** | 5/10 | Bootstrap funciona, mas shutdown é incompleto: `AttentionFeedback.stopBackgroundJobs()` nunca é chamado. Timers órfãos. Scheduler não tem cleanup. Session cleanup depende de `setInterval` no controller. |
| **Memória** | 7/10 | Grafo semântico robusto com ontologia, attention layer, feedback com saturação logarítmica, governor com decay/conflict/GC. Mas: DB bruto vaza por toda a codebase, embedding service é hardcoded, e não há episodic memory separada (tudo é graph). |
| **Tool orchestration** | 6/10 | Tools são registradas e executadas com resultado tipado (`ToolResult`). Mas: paralelismo não existe (serial), não há timeout por tool, não há retry, e tools recebem contexto via `setContext()` (casting para `any`). |
| **Recovery** | 4/10 | Fallback de provider funciona (chatWithFallback). Mas: não há circuit breaker, não há dead letter queue, sessões não se recuperam de crash, e o único mecanismo de recovery é "tente de novo com outro provider". |
| **Observabilidade** | 5/10 | Logs estruturados via AppLogger, metrics no AgentLoop, traces no SQLite. Mas: não há distributed tracing, não há health check endpoint (DashboardServer tem mas é ad-hoc), não há alertas, e AttentionFeedback gera anomalias que ninguém consome. |
| **Segurança cognitiva** | 5/10 | `sanitizeContent()` filtra leaking de prompts. Anti-injection prompt existe. Mas: não há sandbox de tools, não há rate limiting por usuário, e o system prompt é acessível via tool calls de memória. |
| **Boundary management** | 3/10 | Zero separação formal entre camadas. `getDatabase()` vaza para 15+ componentes. Sem protocolo de mensagens tipado. Sem visibility model. Sem authority model. Acoplamento é alto em todas as direções. |
| **Escalabilidade** | 4/10 | PQueue com concurrency=1 serializa todas as chamadas LLM. SQLite é single-writer. Sem horizontal scaling. Multi-user funciona mas com contenção global. |
| **Concorrência** | 3/10 | Mutex por sessão existe (SessionManager), mas LLM queue é global com concurrency=1. Sem priority queue. Uma requisição lenta bloqueia todas as outras. |
| **Reasoning hygiene** | 5/10 | CognitiveWorkspace tem budget, TTL e distillation. Mas: não há validação de coerência do raciocínio, não há self-correction explícito, e o thinking do LLM pode vazar para o output (sanitizeContent tenta limpar mas é regex). |
| **Runtime architecture** | 4/10 | Monolito: tudo roda em um processo Node.js. Sem separação de concerns em runtime. Background timers são `setInterval` sem supervisão. Sem graceful degradation. |
| **Agent isolation** | 3/10 | Não existe isolamento entre agentes. Um bug em qualquer componente derruba tudo. SessionManager é por canal, mas o AgentLoop é singleton. Não há sandbox. |

**Nota média geral: 4.6/10** — Funcional mas não arquiteturalmente robusto.

---

## PARTE 9 — ROADMAP ARQUITETURAL

### 9.1 O que já está pronto (funcional)

1. ✅ **Pipeline de mensagens multi-canal** — Telegram, Discord, WhatsApp, Signal via MessageBus
2. ✅ **Grafo de memória semântica** — Ontologia formal, nós/arestas tipados, FTS5, embedding search
3. ✅ **Attention Layer com feedback** — Scoring de atenção, co-usage validado, decaimento estrutural
4. ✅ **Memory Governor** — Decay de confiança, detecção de conflitos, GC, archive
5. ✅ **Session management com compressão** — Checkpoints, JSONL, hybrid compression (mensagem + token)
6. ✅ **ContextBudget** — Orçamento de tokens por bloco, priorização, truncation
7. ✅ **CognitiveWorkspace** — Working memory governada com budget, TTL, distillation
8. ✅ **ModelRouter** — Roteamento determinístico + LLM, fallback, cache
9. ✅ **Provider fallback** — Multi-provider com retry e fallback automático
10. ✅ **Tool registry** — 15+ tools com execução e resultado tipado
11. ✅ **Guardrails de output** — sanitizeContent(), anti-leak, anti-injection
12. ✅ **AuditorService** — Self-diagnosis com LLM
13. ✅ **SessionTranscript** — Append-only JSONL com índice, replay, compactação

### 9.2 O que precisa refatorar

| Item | Arquivo | Prioridade | Justificativa |
|------|---------|------------|---------------|
| R1 | `AgentController.ts` | 🔴 Alta | Separar em: bootstrap, DI, commands, audio, scheduler. 650 linhas misturadas. |
| R2 | `AgentLoop.ts` | 🔴 Alta | Separar prompt building, response parsing, tool execution, sanitization. 918 linhas. |
| R3 | `MemoryManager.ts` | 🔴 Alta | Extrair: GraphRepository, EmbeddingService, UserProfileRepository, SettingsStore. 1094 linhas. |
| R4 | `ProviderFactory.ts` | 🟡 Média | Separar: Provider creation, retry/fallback logic, streaming, metrics. |
| R5 | `DashboardServer.ts` | 🟡 Média | Separar: HTTP server, API routes, template rendering. 1793 linhas. |
| R6 | `AuditorService.ts` | 🟡 Média | Separar: File scanner, LLM caller, auto-fix engine. |
| R7 | `SimpleDecisionEngine.ts` + `routeIntent.ts` | 🔴 Alta | Unificar em um único IntentRouter com interface clara. |

### 9.3 O que precisa modularizar

| Módulo | Componentes atuais | Interface proposta |
|--------|-------------------|-------------------|
| **Memory Layer** | MemoryManager, AttentionLayer, AttentionFeedback, MemoryGovernor, MemoryCurator, EmbeddingService, ClassificationMemory, DecisionMemory, GraphAnalytics, LouvainDetector, MemoryReconciliationEngine, MemoryScoringEngine | `MemoryFacade` → `GraphRepository` + `EmbeddingService` + `AttentionService` + `GovernanceService` + `SearchService` |
| **State Machine** | AgentStateManager, StateStabilityGuard | `StateMachine<AgentState>` com transições explícitas e guards |
| **Audio Service** | Transcrição em AgentController, WhisperAdapter | `AudioService` com `transcribe()` e `synthesize()` |
| **Intent Router** | SimpleDecisionEngine, routeIntent | `IntentRouter` unificado com fallback chain |
| **Session Layer** | SessionManager, SessionContext, SessionTranscript, ContextBudget, ContextBuilder, ContextCompressor | `SessionService` → `TranscriptStore` + `ContextBuilder` + `Compressor` |

### 9.4 O que precisa desacoplar

| Acoplamento | Solução |
|-------------|---------|
| `getDatabase()` vaza para 15+ componentes | Criar `MemoryFacade` com interfaces tipadas; proibir `getDatabase()` fora do Memory Layer |
| `AgentLoop` instancia `AgentStateManager` diretamente | DI container com interfaces |
| `MessageBus` depende de `AgentLoop` diretamente | Event-driven: MessageBus emite evento, AgentLoop consome |
| Tools recebem contexto via `(tool as any).setContext()` | Interface `ToolWithContext` ou injeção via constructor |
| `SchedulerService` hardcodes TelegramAdapter | `SchedulerService` emite evento → MessageBus roteia para canal |
| `ContextBuilder` acessa `MemoryManager` diretamente | `ContextBuilder` recebe `SearchService` interface |
| Background timers sem lifecycle | `LifecycleManager` que gerencia start/stop de todos os timers |
| Prompt components hardcoded no AgentLoop | `PromptRegistry` com templates em YAML/arquivos |

### 9.5 O que precisa remover

| Item | Razão |
|------|-------|
| `SimpleDecisionEngine.ts` | Duplicado com `routeIntent.ts`. Unificar. |
| `routeIntent.ts` | Ver acima. |
| `ChangeBuffer` no `StateStabilityGuard` | Substituir por FSM formal com event sourcing. |
| `classificationCache` no `ModelRouter` | Substituir por cache com TTL e purga automática. |
| `PQueue concurrency=1` no AgentLoop | Implementar priority queue com concurrency configurável. |
| Inline SQL em `MemoryGovernor`, `AttentionLayer`, `AttentionFeedback` | Migrar para Repository pattern. |
| `getDatabase()` público em `MemoryManager` | Remover; criar interfaces específicas. |

### 9.6 O que precisa nascer como novo subsystem

| Subsystem | Responsabilidade | Prioridade |
|-----------|-----------------|------------|
| **Event Bus** | Comunicação desacoplada entre camadas (substitui chamadas diretas) | 🔴 Alta |
| **Lifecycle Manager** | Gerenciar start/stop/graceful shutdown de todos os serviços | 🔴 Alta |
| **Circuit Breaker** | Proteger chamadas a LLM/APIs com fallback e half-open | 🔴 Alta |
| **Memory Facade** | Interface tipada para acesso à memória (esconde DB) | 🔴 Alta |
| **State Machine** | FSM formal com estados, transições, guards, e persistência | 🟡 Média |
| **Prompt Registry** | Templates de prompt em YAML com versionamento | 🟡 Média |
| **Audio Service** | Transcrição e síntese de áudio desacopladas | 🟡 Média |
| **Health Check Service** | Endpoint consolidado de saúde com métricas de todos os subsystems | 🟡 Média |
| **Dead Letter Queue** | Mensagens que falharam são armazenadas para retry/revisão | 🟢 Baixa |
| **Distributed Tracing** | Correlation IDs end-to-end com tracing de spans | 🟢 Baixa |

---

### 9.7 Priorização por Tempo

#### 🔴 Curto Prazo (1-2 semanas) — Estabilidade Cognitiva & Prevention

| # | Ação | Impacto | Esforço |
|---|------|---------|---------|
| 1 | **Criar MemoryFacade** — Interface tipada que esconde `getDatabase()` | 🔴 Boundary leak crítico | 2-3 dias |
| 2 | **Lifecycle Manager** — Start/stop de timers e serviços no shutdown | 🔴 Memory leak de timers | 1 dia |
| 3 | **Unificar IntentRouter** — Eliminar `SimpleDecisionEngine` e `routeIntent.ts` | 🔴 Duplicação perigosa | 1 dia |
| 4 | **Circuit Breaker no ProviderFactory** | 🔴 Recovery sem resilência | 1-2 dias |
| 5 | **Criar Event Bus básico** (emit/subscribe) | 🔴 Desacoplamento mínimo | 1 dia |
| 6 | **Gracious shutdown do AttentionFeedback** | 🔴 Timers órfãos | 0.5 dia |

#### 🟡 Médio Prazo (2-6 semanas) — Observabilidade & Controle

| # | Ação | Impacto | Esforço |
|---|------|---------|---------|
| 7 | **Refatorar AgentController** — Separar em 5 módulos | Boundary management | 3-4 dias |
| 8 | **Refatorar AgentLoop** — Extrair prompt, parsing, sanitization | Reasoning hygiene | 3-4 dias |
| 9 | **Refatorar MemoryManager** — Extrair GraphRepository, EmbeddingService | Boundary leak | 4-5 dias |
| 10 | **FSM formal para AgentState** — Transições explícitas | Controle de estados | 2-3 dias |
| 11 | **Protocolo tipado de mensagens** — Envelope<T> | Boundary management | 2-3 dias |
| 12 | **Health Check Service** — Endpoint consolidado | Observabilidade | 1-2 dias |
| 13 | **Session cleanup automático** — Compactação periódica de JSONL | Memory leakage | 1 dia |

#### 🟢 Longo Prazo (6-12 semanas) — Escalabilidade & Resiliência

| # | Ação | Impacto | Esforço |
|---|------|---------|---------|
| 14 | **Streaming real de LLM** — Substituir polling por StreamEvent | Escalabilidade | 5-7 dias |
| 15 | **Priority Queue para LLM** — Substituir PQueue concurrency=1 | Concorrência | 2-3 dias |
| 16 | **Dead Letter Queue** — Mensagens falhas armazenadas | Recovery | 2-3 dias |
| 17 | **Distributed Tracing** — Correlation IDs end-to-end | Observabilidade | 3-4 dias |
| 18 | **Agent isolation** — Sandbox de tools, resource limits | Segurança cognitiva | 5-7 dias |
| 19 | **Horizontal scaling** — Separar workers de LLM do main process | Escalabilidade | 7-10 dias |
| 20 | **Prompt Registry** — Templates YAML com versionamento | Reasoning hygiene | 2-3 dias |

---

## RESUMO EXECUTIVO

O NewClaw é um **sistema agentic funcional** com features avançadas (grafo semântico, attention layer, memory governor, cognitive workspace, session compression). Porém, sofre de **acoplamento estrutural** que limita sua evolução:

**Pontos fortes:**
- Grafo de memória com ontologia formal e governance
- Attention layer com feedback e anti-dominância
- Session management com compressão híbrida
- Context budget com priorização por bloco
- Multi-provider com fallback

**Riscos críticos:**
- `getDatabase()` vaza para 15+ componentes (zero abstração de dados)
- Monolito de 918 linhas no AgentLoop
- Timers órfãos sem lifecycle management
- LLM queue serial (concurrency=1) bloqueia multi-usuário
- FSM implícito sem guards transicionais
- Prompt engineering hardcoded no loop

**Ação imediata recomendada:** MemoryFacade + Lifecycle Manager + Event Bus básico. Esses três mudam o jogo de boundary management com menos de 1 semana de trabalho.

**Nota de maturidade como AI OS: 4.6/10** — Funcional como assistente, mas precisa de arquitetura de camadas para ser robusto como sistema operacional cognitivo.