# AUDIT PART 1 — Análise Profunda dos Arquivos Core

**Data:** 2026-05-09  
**Escopo:** 8 arquivos core + arquivos de suporte (SessionContext, ContextBudget, AgentLoop, etc.)

---

## 1. `src/index.ts` — Entry Point

### O que FAZ vs o que DIZ fazer
- **Diz:** Entry point que inicializa o sistema multi-canal
- **Faz:** Inicializa AgentController com toda a dependência wiring (15+ imports diretos, 15+ tools, 4 canais). É um arquivo de bootstrap que concentra TUDO: config, DI manual, health checks, scheduler start.

### FSM Implícito
- `start()` → sequência de inicialização com `setTimeout(() => scheduler.startAll(), 5000)` — timing frágil
- Ordem de inicialização é CRÍTICA mas NÃO guardada: MemoryManager → ProviderFactory → SkillLoader → SkillLearner → AgentLoop → OnboardingService → SessionManager → SessionContext → SessionLearner → Scheduler → MemoryGovernor → MessageBus → AuditorService → Canais
- Se QUALQUER passo falhar, o sistema fica em estado parcial sem recuperação

### Gerenciamento de Memória/Contexto
- `setInterval` para cleanup de sessões (5 min) e governance cycle (24h) — sem cleanup no shutdown
- Nenhum graceful shutdown; processos em background continuam após SIGINT/SIGTERM

### Violações de Boundary
- **CRÍTICO:** `memory.getDatabase()` é acessado diretamente em 15+ locais através de AgentController (SkillLearner, AuditorService, SessionManager, /skills commands)
- Transcrição de áudio (Whisper) embutida diretamente no AgentController — lógica de infraestrutura num orquestrador

### Acoplamento
- 20+ imports diretos — God Object
- AgentController conhece TODOS os subsistemas: Memory, Provider, Skills, Sessions, Scheduler, Auditor, Voice, Canais
- Circular: AgentController cria AgentLoop, AgentLoop recebe MemoryManager que é criado por AgentController

### Reasoning Hygiene
- N/A (ponto de entrada, sem processamento de reasoning)

### Problemas
1. **Constructor faz TUDO** — 200+ linhas de wiring no constructor
2. **Sem DI container** — cada dependência é criada manualmente com ordem implícita
3. **setInterval sem cleanup** — potential resource leak em testes
4. **Whisper logic no controller** — deveria ser um VoiceService separado
5. **Hardcoded timeout** `5000ms` para scheduler start — racing condition

---

## 2. `src/core/AgentController.ts` — Facade Principal

### O que FAZ vs o que DIZ fazer
- **Diz:** Orquestra ChannelAdapter → MessageBus → AgentLoop
- **Faz:** God Object com 650+ linhas que gerencia TUDO: canais, tools, sessões, scheduler, voice transcription, comandos, onboarding, auditoria

### FSM Implícito
- Estado de inicialização: `constructor()` → tudo criado mas NÃO iniciado
- `start()` → MessageBus.startAll() + periodic tasks
- **NÃO existe estado de "starting", "running", "stopping", "error"** — boolean lifecycle implícito
- Scheduler trigger handler usa `async` mas não trata erros de forma granular

### Gerenciamento de Memória/Contexto
- `transcribeAttachment()` aloca buffers de áudio em memória, converte WAV, roda whisper-cli — TUDO em memória
- Sem timeout no processo ffmpeg/whisper para o caminho local (timeout de 30s e 120s são declarados mas `execFile` com callback é frágil)
- `tmpFile` e `wavFile` são limpos no `finally`, MAS se o processo crashar antes, ficam orfãos

### Violações de Boundary
- **CRÍTICO:** `this.memory.getDatabase()` vaza para: SkillLearner, OnboardingService, AuditorService, SessionManager, /skills commands, /skill_approve, /skill_reject
- Comandos SQL escritos diretamente no controller (`SELECT id FROM auto_skills`, `UPDATE auto_skills SET status`)
- `this.messageBus['adapters']?.get(msg.channel)` — acesso privado via bracket notation

### Mixed Responsibilities
1. Voice transcription (deveria ser VoiceService)
2. Command registration (deveria ser CommandRegistry)
3. Skill/tool registration (deveria ser FeatureFlag)
4. System prompt construction (deveria ser PromptBuilder)
5. Scheduler trigger handling (deveria ser scheduler callback)
6. Channel adapter lifecycle (deveria ser ChannelManager)

### Acoplamento
- Bidirecional com MessageBus (controller cria bus, adapters recebem bus)
- Forte com AgentLoop (controller é o único criador)
- Forte com MemoryManager (compartilhado com 8+ componentes)
- Forte com ProviderFactory (compartilhado com 4+ componentes)

### Reasoning Hygiene
- N/A (orquestrador, não processa reasoning)

### Problemas
1. **God Object** — 650+ linhas, 20+ responsabilidades
2. **Database leak** — SQL direto no controller
3. **Bracket access** em propriedade privada (`messageBus['adapters']`)
4. **Sem graceful shutdown** — setInterval continua após crash
5. **Whisper fallback chain** complexa demais para estar no controller

---

## 3. `src/core/AgentStateManager.ts` — Estado do Agente

### O que FAZ vs o que DIZ fazer
- **Diz:** Gerencia estado do agente (mode, focus, confidence, stability)
- **Faz:** CRUD simples sobre um nó de memória (`agent_state`) com cálculo de stability/drift baseado em buffer circular de 5 estados

### FSM Implícito
- `AgentMode`: 'learning' | 'assisting' | 'exploring' — **sem transições definidas**
- `AgentFocus`: 'automation' | 'study' | 'project' | 'unknown' — **sem transições definidas**
- Qualquer modo pode ir para qualquer outro sem validação
- `updateFromInteraction()` modifica confidence e alignment baseado em success/consistency, MAS é chamado de fora sem contrato

### Gerenciamento de Memória/Contexto
- `lastStates` buffer circular de tamanho 5 — **não é limpo**, cresce até 5 e para
- Estado é persistido via `memory.addNode()` — sobrescreve o nó `agent_state` inteiro a cada update
- **NÃO existe invalidação de cache** — se o DB mudar externamente, o getState() lê o nó antigo

### Violações de Boundary
- Acessa `this.memory` diretamente (não via interface)
- `getNode()` e `addNode()` sem validação de schema

### Mixed Responsibilities
- Estado E persistência E cálculo de stability — deveria ser separado
- `initializeAfterOnboarding()` mistura lógica de onboarding com gestão de estado

### Acoplamento
- Forte com MemoryManager (recebe no constructor)
- Usado por: AgentLoop, StateStabilityGuard, DecisionPostProcessor

### Reasoning Hygiene
- N/A (gerencia estado, não reasoning)

### Problemas
1. **Sem FSM formal** — transições de modo são livres
2. **Buffer circular hardcoded** (5) — não configurável
3. **Sobrescrita atômica** de estado — sem merge parcial, sem conflict resolution
4. **Sem validação** de valores de confidence (0.1-1.0 hardcode mas não enforced)
5. **`getState()` faz JSON.parse sem try/catch robusto** — tem fallback mas não loga a corrupção

---

## 4. `src/core/SimpleDecisionEngine.ts` — Roteamento Determinístico

### O que FAZ vs o que DIZ fazer
- **Diz:** Deterministic intent parser — classifica DIRECT_REPLY vs EXECUTE
- **Faz:** Pattern matching com regex para rotear para tools específicos. É um decision tree hardcoded com 9 ferramentas e ~50 patterns

### FSM Implícito
- Classificação: `small_talk` → DIRECT_REPLY | `destructive` → EXECUTE (confirm) | keyword match → EXECUTE com tool específico | default → LLM
- **Sem estados intermediários** — classificação é puramente functional
- Ordem de avaliação é CRÍTICA: destructive check → small talk → audio → memory → crypto → web → shell → files → default

### Gerenciamento de Memória/Contexto
- Nenhum — stateless

### Violações de Boundary
- **NENHUMA** — é um pure function module, bem isolado

### Mixed Responsibilities
- Nenhuma — responsabilidade única (classificação)

### Acoplamento
- Acoplado aos nomes de tools: `crypto_report`, `web_search`, `exec_command`, `manage_memory`, `write`, `read`, `edit`, `send_audio`
- Se uma tool mudar de nome, o engine quebra silenciosamente
- **Duplicação com `routeIntent.ts`** — ambos fazem pattern matching com regexes sobrepostas mas diferentes

### Reasoning Hygiene
- N/A — não processa reasoning

### Problemas
1. **Duplicação com routeIntent.ts** — dois sistemas de roteamento com patterns ligeiramente diferentes
2. **Regex frágil** — patterns hardcoded, difícil manter, overlap entre categorias
3. **Sem confidence scoring real** — confidence é hardcoded (0.8, 0.99)
4. **Sem aprendizado** — patterns não evoluem com uso
5. **`extractParams` é stub** — retorna `{}` ou `input` sem parsing real

---

## 5. `src/core/StateStabilityGuard.ts` — Guarda de Estabilidade

### O que FAZ vs o que DIZ fazer
- **Diz:** Previne transições erráticas de estado
- **Faz:** Buffer de 2 ocorrências para mudança de focus. Se stability > 0.9, aplica imediatamente

### FSM Implícito
- **Buffer de transição**: focus só muda após 2 confirmações OU se stability > 0.9
- **Estados implícitos**: `buffered` (aguardando confirmação) | `applied` (aplicado) | `rejected` (nunca confirmado, silenciosamente descartado)
- **NÃO existe reject explícito** — se o buffer for sobrescrito com focus diferente, o anterior é perdido

### Gerenciamento de Memória/Contexto
- `changeBuffer: Map<string, { value, count }>` — cresce indefinidamente (apenas `current_focus` é guardado)
- **Sem TTL ou cleanup** — embora na prática só tenha 1 key

### Violações de Boundary
- Acessa `AgentStateManager` diretamente (sem interface)

### Mixed Responsibilities
- Guarda E executor — `requestTransition()` decide E aplica
- Deveria separar: Policy (quando aplicar) de Execution (aplicar via stateManager)

### Acoplamento
- Forte com AgentStateManager (recebe no constructor)

### Reasoning Hygiene
- N/A

### Problemas
1. **Buffer unbounded** — embora na prática só 1 key, o design permite growth
2. **Sem reject explícito** — focus antigo é silenciosamente descartado
3. **Sem logging** de transições bloqueadas (apenas `log.info`)
4. **Sem métricas** — quantas transições foram bloqueadas? Qual focus mudou mais?
5. **Limiar 0.9 é hardcoded** — deveria ser configurável

---

## 6. `src/core/ExecutionTrace.ts` — Rastreabilidade

### O que FAZ vs o que DIZ fazer
- **Diz:** Registra cada step do raciocínio
- **Faz:** EventEmitter singleton que cria traces com steps numerados, armazena em Map, move para `recentTraces` (max 50) ao completar

### FSM Implícito
- Trace lifecycle: `running` → `completed` | `error` | `max_iterations`
- **Sem estado `cancelled`** — se um trace for abandonado, fica no Map `traces` para sempre
- `traces: Map<string, ExecutionTrace>` — **LEAK POTENTIAL**: traces em `running` nunca são removidos se o `completeTrace()` nunca for chamado

### Gerenciamento de Memória/Contexto
- `traces` Map cresce ilimitadamente para traces em `running`
- `recentTraces` array limitado a 50 — OK
- **Sem TTL ou cleanup de traces running** — se AgentLoop crashar sem completar o trace, fica no Map

### Violações de Boundary
- Nenhuma — é um event emitter isolado

### Mixed Responsibilities
- Trace management E event emission E stats aggregation
- Deveria separar: TraceStore (persistência) de TraceEmitter (eventos SSE)

### Acoplamento
- Usado por AgentLoop (startTrace, addStep, completeTrace)
- Dashboard server consome eventos SSE
- MemoryManager.saveTrace() persiste no DB

### Reasoning Hygiene
- **BOA PRÁTICA**: `step.data` contém `thought` do LLM, MAS é trace data — não é exposto ao usuário
- Steps são numerados sequencialmente — rastreabilidade OK

### Problemas
1. **Memory leak** — traces em `running` nunca são limpos se `completeTrace()` não for chamado
2. **Sem estado `cancelled`** — traces órfãos
3. **Max 50 recent** — em produção com alto volume, traces antigos são perdidos
4. **Emits síncronos** — EventEmitter pode bloquear o loop se listeners forem lentos

---

## 7. `src/core/ToolRegistry.ts` — Registro de Ferramentas

### O que FAZ vs o que DIZ fazer
- **Diz:** Registro centralizado de tools com enable/disable
- **Faz:** Map<string, ToolEntry> com métodos CRUD simples. Singleton exportado

### FSM Implícito
- **Registro → Habilitado → Desabilitado → Removido**
- Sem validação de transição — qualquer tool pode ser desabilitada a qualquer momento
- `get()` retorna `undefined` se desabilitada — **callers precisam checar undefined**

### Gerenciamento de Memória/Contexto
- Tools ficam em memória para sempre — sem cleanup
- **OK** porque tools são registradas no startup e não mudam

### Violações de Boundary
- Nenhuma — é um registro isolado

### Mixed Responsibilities
- Nenhuma — responsabilidade única

### Acoplamento
- AgentController registra tools
- AgentLoop consulta tools por nome
- **Forte acoplamento por nome** — string matching sem tipo

### Reasoning Hygiene
- N/A

### Problemas
1. **Singleton global** — `export const ToolRegistry = new ToolRegistryClass()` — impossível testar isoladamente
2. **Sem validação de schema** — qualquer objeto com `name`, `description`, `parameters`, `execute` é aceito
3. **Sem hot-reload** — tools são registradas uma vez no startup
4. **`dangerous` flag é apenas informativo** — nenhuma enforcement de segurança
5. **`get()` retorna `undefined` silenciosamente** para tools desabilitadas — deveria lançar ou ter comportamento explícito

---

## 8. `src/core/ProviderFactory.ts` — Troca Dinâmica de LLMs

### O que FAZ vs o que DIZ fazer
- **Diz:** Troca dinâmica de LLMs com fallback automático
- **Faz:** Orquestra 5 providers (Gemini, DeepSeek, Groq, Ollama, OpenRouter) com streaming, retry, fallback em cadeia, extração de thinking/reasoning, e timeout progressivo

### FSM Implícito
- **Request lifecycle**: 
  1. `created` → tenta provider preferencial
  2. `attempting` → streaming com 3 timeouts (connection 30s, activity 120s, max 300s)
  3. `success` → retorna resultado
  4. `timeout` → aborta, tenta próximo provider
  5. `error` → loga, tenta próximo
  6. `fallback` → tenta non-streaming como último recurso
  7. `exhausted` → retorna LLMResult com status error/timeout
- **AbortController chaining** — cada attempt cria novo controller, aborta o anterior
- **Streaming FSM**: `connecting` → `streaming` → `done` | `error` | `timeout`
- **Buffer partial recovery** — se stream falha com conteúdo parcial, retorna o que tem

### Gerenciamento de Memória/Contexto
- `PQueue` com concurrency=1 para generation e classification — **bottleneck em multi-session**
- `traces` Map em ExecutionTrace — potential leak (ver acima)
- **Streaming buffers** são isolados por chamada — bom design

### Violações de Boundary
- **CRÍTICO**: `_consumeStream()` acessa `thinking` do modelo — mas o comentário diz "NEVER shown to user" e preserva em `response.thinking`
- **Anti-leak sanitization** em `AgentLoop.sanitizeContent()` remove tags de thinking, MAS `response.thinking` é preservado e passado para `CognitiveWorkspace`
- **Potential leak**: se `sanitizeContent()` falhar, thinking pode aparecer na resposta final

### Mixed Responsibilities
1. Provider instantiation E lifecycle E routing E fallback E retry E streaming E timeout E buffer management
2. Deveria separar: ProviderFactory (routing/fallback) de StreamManager (streaming/buffer/timeout)

### Acoplamento
- Forte com AgentLoop (chamador principal)
- Forte com OllamaProvider (único com streaming)
- Fraco com outros providers (sem streaming)
- ModelRouter decide modelo, ProviderFactory decide provider — **potencial conflito**

### Reasoning Hygiene
- **BOA PRÁTICA**: Thinking é separado de content — `response.thinking` é preservado para CognitiveWorkspace
- **RISCO**: Thinking pode vazar se sanitizeContent() não cobrir todos os patterns
- **RISCO**: `extractChunkText()` retorna `thinking` como tipo separado, MAS se o modelo não usar tags especiais, thinking aparece como `content`

### Problemas
1. **PQueue concurrency=1** — bottleneck serial para todas as chamadas LLM
2. **classificationQueue e generationQueue** — bem intencionado MAS o código de fallback NÃO usa classificationQueue
3. **Streaming buffer partial** — se stream falha, retorna conteúdo parcial sem indicar ao caller que é incompleto
4. **Timeout tripla** (connection/activity/max) — complexa, com timers criados e destruídos em cada chunk
5. **`extractLeakedToolCalls()`** — tenta parsear JSON de conteúdo, potencial injection vector
6. **Non-streaming fallback** — `_fallbackNonStreaming()` é marcado como "WARNING: Not currently called" MAS é chamado em `chatWithFallback` como último recurso
7. **Provider model setting é mutável** — `setModel()` muda estado global, não é thread-safe em multi-request

---

## Análise Cruzada — Padrões Sistêmicos

### 1. Violação de Boundary Mais Crítica: `getDatabase()`

| Componente | Acessa DB Diretamente? | Como |
|---|---|---|
| AgentController | ✅ | `/skills`, `/skill_approve`, `/skill_reject`, transcrição |
| SessionManager | ✅ | `ensureCheckpointSchema()`, `saveCheckpoint()`, `loadCheckpoints()`, `ensureConversation()` |
| SkillLearner | ✅ | `ensureTable()`, migrations, CRUD completo |
| AuditorService | ✅ | Diagnóstico direto |
| AgentStateManager | ✅ | `getNode('agent_state')`, `addNode()` |
| MemoryGovernor | ✅ | Acesso total ao grafo |
| ClassificationMemory | ✅ | CRUD de classificações |
| DecisionMemory | ✅ | CRUD de decisões |

**Impacto**: Mudança no schema do SQLite quebra 8+ componentes independentemente. Sem interface de abstração.

### 2. FSMs Implícitos Sem Controle

| Componente | FSM Implícito | Problema |
|---|---|---|
| AgentController | stopped → starting → running | Sem estados formais, sem recovery |
| AgentLoop | idle → thinking → tool_exec → synthesizing → done | 5+ early-return paths, sem state tracking |
| ProviderFactory | created → attempting → streaming → done/error | 3 timeouts sobrepostos, abort chaining |
| SessionManager | active → compressing → compacting → closed | Mutex por session, sem deadlock detection |
| AgentStateManager | learning → assisting → exploring | Sem transições definidas, qualquer modo vai para qualquer outro |
| ExecutionTrace | running → completed/error/max_iterations | Sem `cancelled`, traces órfãos ficam no Map |

### 3. Memory Leaks Identificados

| Componente | Leak | Severidade |
|---|---|---|
| ExecutionTrace | `traces` Map para traces em `running` nunca removidos se `completeTrace` não chamado | **ALTA** |
| SessionManager | `sessions`, `sessionMutexes`, `compressionCheckpoints`, `activeFiles`, `lastActivity` — 5 Maps paralelos | **MÉDIA** (cleanup existe mas é periódico) |
| ProviderFactory | `PQueue` com concurrency=1 serializa todas as requests | **MÉDIA** (bottleneck, não leak) |
| AgentLoop | `metrics` array com max 100 entries — OK | BAIXA |
| StateStabilityGuard | `changeBuffer` — cresce 1 key, nunca limpo | BAIXA |

### 4. Reasoning Hygiene — Resumo

| Componente | Thinking Handling | Leak Risk |
|---|---|---|
| ProviderFactory | Separado em `response.thinking`, preservado | **MÉDIA** — sanitizeContent pode falhar |
| AgentLoop | Adicionado ao CognitiveWorkspace, reset a cada turn | **BAIXA** — bom design |
| CognitiveWorkspace | Auto-pruned, TTL 5min, budget 2000 tokens | **BAIXA** |
| sanitizeContent() | 15+ patterns de remoção de thinking | **MÉDIA** — regex-based, frágil |
| DecisionPostProcessor | Modula resposta baseado em state, NÃO expõe thinking | **BAIXA** |

### 5. Mixed Responsibilities — God Object Alert

| Componente | Linhas | Responsabilidades |
|---|---|---|
| AgentController | 650+ | Voice, Commands, Tools, Scheduler, Channels, DB queries, System prompt |
| ProviderFactory | 1153 | 5 providers, Streaming, Fallback, Retry, Timeout, Buffer, Tool extraction |
| AgentLoop | 918+ | Prompt assembly, LLM calls, Tool execution, JSON parsing, State tracking, Metrics, Trace |
| MemoryManager | 1094 | Graph, FTS, Embeddings, Conversations, CRUD, Search |

### 6. Acoplamento por String — Fragilidade

| Local | String Hardcoded | Risco |
|---|---|---|
| ToolRegistry | `tool.name` lookup | Tool renomeada = crash silencioso |
| SimpleDecisionEngine | `tool: 'crypto_report'`, etc | Regex vs tool name mismatch |
| routeIntent | `action: 'tool'`, `tool: 'web_search'` | Duplicação com DecisionEngine |
| AgentLoop | `terminalTools = ['send_audio', ...]` | Hardcoded, sem validação |
| SessionManager | `'telegram:8071707790'` | Canal hardcoded |

### 7. Duplicação de Roteamento

**SimpleDecisionEngine** e **routeIntent.ts** fazem a mesma coisa:
- Ambos mapeiam texto para tools via regex
- Patterns são **sobrepostos mas diferentes** (ex: "pesquisar" vai para `web_search` em routeIntent mas `manage_memory` em DecisionEngine)
- **Conflito**: se ambos forem chamados, podem rotear para tools diferentes
- Solução: unificar em um único IntentRouter com patterns consolidados

### 8. Context Budget — Análise

O `ContextBudget` é bem estruturado com:
- Prioridades por bloco (system=10, user=9, state=8, checkpoint=7, memory=6, skills=5, history=3)
- Token limits por bloco (system=1500, state=500, memory=1000, history=2000, skills=500)
- Truncamento inteligente com `truncateToTokens` e `truncateToChars`
- Safety check final com reordenação por prioridade

**Problemas:**
1. `estimateTokens()` é uma heurística simples (3-3.5 chars/token) — pode ser impreciso para code
2. History budget é consumido sequencialmente (FIFO) — mensagens mais antigas consomem budget antes
3. Checkpoint e history COMPETEM pelo mesmo budget (historyMaxTokens) — conflito de design
4. Sem overlap/overlap entre blocos — se system prompt exceder 1500 tokens, é truncado sem aviso

---

## Score Card — AI OS Readiness (Part 1)

| Dimensão | Score | Notas |
|---|---|---|
| **Cognitive Stability** | 4/10 | StabilityGuard frágil, FSM implícito, sem recovery |
| **Degradation Prevention** | 5/10 | Fallback chain existe, mas PQueue=1 é bottleneck, sem circuit breaker |
| **Observability** | 5/10 | ExecutionTrace bom mas com leak, DashboardServer separado |
| **State Control** | 3/10 | Sem FSM formal, transições livres, estado em 5+ Maps |
| **Memory Hygiene** | 5/10 | ContextBudget OK, SessionManager tem cleanup, mas traces leakam |
| **Interruptibility** | 3/10 | AbortController existe mas apenas em ProviderFactory, AgentLoop não é interrompível |
| **Recovery** | 3/10 | Sem recovery states, sem checkpoint/restore, traces órfãos |
| **Reasoning Hygiene** | 6/10 | Thinking separado, CognitiveWorkspace governado, sanitizeContent abrangente mas frágil |

**Média Part 1: 4.25/10**