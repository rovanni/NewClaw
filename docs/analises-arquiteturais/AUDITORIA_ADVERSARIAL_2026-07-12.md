# Auditoria Técnica Adversarial — NewClaw

**Data:** 2026-07-12
**Escopo:** `src/` (946 arquivos .ts, ~50k linhas no núcleo)
**Método:** leitura direta do código-fonte, correlação com logs de produção (`tmp_server_out.txt`) e com a suíte de regressão existente. Cada achado abaixo tem localização exata e evidência verificável no repositório.

Regra de honestidade aplicada: onde a hipótese não pôde ser comprovada apenas pelo código, isso é declarado explicitamente.

---

## 1. Resumo executivo

O NewClaw é um agente cognitivo multi-canal com arquitetura madura: fila serial por conversa, circuit breakers, máquina de estados de goals com validação de transição, compressão de sessão com checkpoints, e uma quantidade notável de correções documentadas inline (muitas rastreando bugs reais de produção). A engenharia defensiva é acima da média para um projeto deste porte.

Ainda assim, a auditoria encontrou **defeitos reais capazes de produzir comportamento incorreto**, concentrados em dois eixos:

1. **Concorrência entre conversas**: a serialização por conversa (`ConversationQueueManager`) é sólida, mas existe **estado mutável por-conversa armazenado em campos de instância de singletons** (`AgentLoop`), e existem **caminhos que contornam a fila serial** (callbacks de autorização de workflow). Com `MAX_CONCURRENT_GENERATION=2` (default), isso permite contaminação cruzada de contexto entre usuários.

2. **Segurança de canal**: WhatsApp, Signal e Discord tratam **allowlist vazia como "aberto a todos"**, semântica oposta à do Telegram (que bloqueia todos). Uma configuração incompleta expõe o agente a qualquer remetente.

**Contagem:** 2 Críticos, 4 Altos, 4 Médios, 3 Baixos.

---

## 2. Lista priorizada

| # | Severidade | Área | Título |
|---|-----------|------|--------|
| C1 | **Crítico** | Concorrência | Estado por-conversa em campos de instância do `AgentLoop` singleton |
| C2 | **Crítico** | Segurança / Adapters | Allowlist vazia = canal aberto em WhatsApp/Signal/Discord |
| A1 | Alto | Concorrência / Persistência | Gravações de transcript sem mutex + bypass da fila serial |
| A2 | Alto | Persistência | Auto-recuperação de DB não limpa WAL/SHM stale |
| A3 | Alto | Adapters | Dedup marca `messageId` antes de processar → perda em falha |
| A4 | Alto | Concorrência | `withMutex` "prossegue mesmo assim" após 10s anula a exclusão mútua |
| M1 | Médio | Memória / Escala | `EmbeddingService.search` faz full-scan O(N) em JS + sem checagem de dimensão |
| M2 | Médio | Memória | `MemoryFacade.removeNode` deixa embeddings/métricas órfãos (FK OFF) |
| M3 | Médio | Planejamento / Persistência | `GoalStore` read-modify-write de JSON sem transação |
| M4 | Médio | Arquitetura | `EventBus.onAny` sem unsubscribe utilizável |
| B1 | Baixo | Adapters | Dois mecanismos de reconexão concorrentes (MessageBus + Supervisor) |
| B2 | Baixo | Robustez | `uncaughtException` continua o processo em estado possivelmente corrompido |
| B3 | Baixo | Concorrência | Backpressure descarta mensagem (perda do ponto de vista do usuário) |

---

## 3–6. Evidências, reprodução, impacto e correção

### C1 — Estado por-conversa em campos de instância do `AgentLoop` singleton — **Crítico**

**Localização**
- `src/loop/AgentLoop.ts:174` — `private cognitiveWorkspace = new CognitiveWorkspace();`
- `src/loop/AgentLoop.ts:194` — `private lastToolExecution: {...} | null = null;`
- `src/loop/AgentLoop.ts:201` — `private pendingObserverFeedback: string[] = [];`
- `src/loop/AgentLoop.ts:815` — `run()` faz `this.cognitiveWorkspace.reset();`
- `src/loop/AgentLoop.ts:1591` — `this.cognitiveWorkspace.add(stepCount, response.thinking.trim(), 'reasoning');`
- `src/core/providerQueue.ts:27-29` — `generationQueue = new PQueue({ concurrency: CONCURRENCY_CONFIG.generation })` com default `2` (`providerQueue.ts:5`).
- `src/loop/AgentLoop.ts:919` — a chamada ao LLM roda dentro de `generationQueue.add(...)`.

**Evidência**
`AgentController` cria **um único** `AgentLoop` (`AgentController.ts:205`) compartilhado por todas as conversas e canais. Os campos `cognitiveWorkspace`, `lastToolExecution` e `pendingObserverFeedback` são **estado mutável por-turno**, mas vivem na instância singleton. O guard de `runWithTools` (`AgentLoop.ts:1108`) só rejeita turnos concorrentes **do mesmo `conversationId`** — turnos de conversas diferentes rodam em paralelo (até `generationQueue.concurrency=2`). Como `run()` chama `this.cognitiveWorkspace.reset()` no início (linha 815), o início de um turno da conversa B **zera o scratchpad de raciocínio da conversa A** que ainda está em andamento; e `add()` (linha 1591) mistura o "thinking" das duas. O mesmo vale para `lastToolExecution` (lido em `commitResponse`, `AgentLoop.ts:624`) e `pendingObserverFeedback` (drenado em `AgentLoop.ts:1442-1450`).

Comprova a intenção de isolar esse tipo de estado o próprio comentário de `GoalExecutionLoop.ts:70-79`, que descreve exatamente este anti-padrão ("como `GoalExecutionLoop` é singleton por processo, dois goals de sessões diferentes podiam ler/escrever o mesmo objeto") e o corrige movendo o estado para variável local. `AgentLoop` **não** recebeu o mesmo tratamento.

**Cenário de reprodução (mínimo)**
1. `MAX_CONCURRENT_GENERATION=2` (default).
2. Usuário U1 (Telegram) e usuário U2 (Discord) enviam mensagens que disparam turnos quase simultâneos.
3. Ambos os turnos passam pelo `generationQueue` com concorrência 2 → rodam de fato em paralelo.
4. O `run()` de U2 executa `cognitiveWorkspace.reset()` enquanto o turno de U1 está entre passos.
5. U1 perde o raciocínio acumulado (self-correction/retry-with-context) e/ou `commitResponse` de U1 lê `lastToolExecution` que na verdade pertence a U2.

**Impacto**
Contaminação de contexto entre usuários: decisões incorretas do agente, validação Q4 (`commitResponse`) avaliando a resposta de uma conversa contra o último tool de outra, e vazamento de "thinking" entre sessões. É um defeito de isolamento e de consistência memória↔execução ao mesmo tempo. Classificação **Crítica** porque cruza fronteira entre usuários distintos.

**Correção recomendada (causa raiz)**
Mover `cognitiveWorkspace`, `lastToolExecution` e `pendingObserverFeedback` para um objeto de estado **local a `runWithTools`** (ou um `Map<conversationId, TurnState>` com ciclo de vida atrelado a `activeTurns`), propagado explicitamente pela cadeia de chamadas — exatamente o padrão já aplicado em `GoalExecutionState` (`GoalExecutionLoop.ts:74-77`). Não altera a arquitetura pública; elimina o compartilhamento por construção.

**Risco de regressão da correção:** Médio. Vários métodos privados leem esses campos; a refatoração precisa passar o estado por parâmetro. Cobertura de teste recomendada: dois turnos concorrentes de conversationIds distintos verificando ausência de cross-talk.

---

### C2 — Allowlist vazia trata canal como aberto (WhatsApp/Signal/Discord) — **Crítico**

**Localização**
- `src/channels/WhatsAppAdapter.ts:272-276` — `if (this.config.allowedJids && this.config.allowedJids.length > 0) { if (!includes) return; }`
- `src/channels/SignalAdapter.ts:301-303` — `if (envelope?.sourceNumber && this.config.allowedNumbers && this.config.allowedNumbers.length > 0 && !includes) return;`
- `src/channels/DiscordAdapter.ts:289-293` e `321-325` — mesmo padrão `length > 0 &&`.
- **Contraste:** `src/channels/TelegramAdapter.ts:325` — `if (!this.config.allowedUserIds.includes(userId)) return;` (sem guard de `length > 0` → lista vazia bloqueia todos).

**Evidência**
Em WhatsApp/Signal/Discord, quando a allowlist está **vazia**, a expressão `length > 0` é falsa e o bloco de verificação inteiro é **pulado** — a mensagem é aceita de **qualquer** remetente. No Telegram, a mesma condição vazia **bloqueia** todos. `index.ts:25-33` monta essas listas via `split(',').filter(len>0)`, então um `.env` sem `WHATSAPP_ALLOWED_JIDS`/`SIGNAL_ALLOWED_NUMBERS`/`DISCORD_ALLOWED_USER_IDS` produz array vazio. Isso é uma **divergência de semântica entre canais** (item explicitamente pedido na auditoria) com consequência de segurança.

**Cenário de reprodução**
1. Operador habilita o canal Discord definindo `DISCORD_BOT_TOKEN` mas esquece `DISCORD_ALLOWED_USER_IDS`.
2. Qualquer usuário em qualquer guild onde o bot esteja pode enviar comandos — incluindo goals que executam `exec_command`/`ssh_exec` (ferramentas marcadas `dangerous`, `AgentController.ts:622,644`).

**Impacto**
Execução de comandos e vazamento de dados por remetentes não autorizados. Combinado com o pipeline de goals autônomos, um terceiro pode acionar ações no host. **Crítico.**

**Correção recomendada (causa raiz)**
Unificar a semântica de allowlist em todos os adapters: **lista vazia = negar tudo** (fail-closed), igual ao Telegram. Extrair um helper compartilhado `isAllowed(id, allowlist)` em `ChannelAdapter`/`shared` para eliminar as 4 implementações divergentes. Alternativamente, se "vazio = aberto" for intencional para algum caso, torná-lo explícito via flag (`CHANNEL_OPEN=true`) e logar um aviso alto no boot — nunca implícito.

**Risco de regressão:** Baixo, mas muda comportamento observável: instalações que hoje rodam sem allowlist (confiando no "aberto") pararão de responder até configurar a lista. Deve ser destacado no changelog.

---

### A1 — Gravações de transcript sem mutex + bypass da fila serial — **Alto**

**Localização**
- `src/session/SessionManager.ts:213-243` — `recordUserMessage`/`recordAssistantMessage` usam `withMutex`.
- `src/session/SessionManager.ts:245-253, 255-320, 384-396` — `recordSystemMessage`, `recordToolCall`, `recordToolResult` **não** usam `withMutex`; chamam `transcript.append()` (síncrono) direto.
- `src/session/SessionTranscript.ts:184-192` — `appendAsync` (protegido por `writeMutex`) existe mas **nunca é chamado** por `SessionManager` (que sempre usa `append` síncrono).
- `src/session/SessionTranscript.ts:207-241` — `appendSync` faz `this.seqCounter++` e atualiza `this.index.lastOffset/lastSeq/totalEntries` sem lock.
- **Bypass da fila:** `src/core/AgentController.ts:606,614` — `createWorkflowCallback` chama `recordAssistantMessage` fora do `ConversationQueueManager`; `TelegramAdapter.ts:544-552` roteia callbacks `auth:*` direto para `workflowCallback`, **sem** passar por `MessageBus.processMessage` (comentário na linha 548: "NÃO envia para MessageBus — bypass completo do pipeline conversacional").

**Evidência**
A serialização por conversa garante ordem apenas para mensagens que passam pela `ConversationQueueManager`. Um callback de autorização (clique de botão "Aprovar") é processado **imediatamente**, em paralelo a um turno em andamento da mesma sessão. Durante esse turno, `AgentLoop`/`GoalExecutionLoop` gravam `recordToolCall`/`recordToolResult` **sem mutex** (`AgentLoop.ts:1957,2277,2617`; `GoalExecutionLoop.ts:1833`), enquanto o callback grava `recordAssistantMessage` **com** mutex — mas em locks diferentes, ou seja, sem exclusão real entre os dois. Ambos executam `transcript.append()` → `seqCounter++` e mutação de `index` concorrentes. O `writeMutex` da própria `SessionTranscript` (que resolveria isso) está morto porque `SessionManager` nunca chama `appendAsync`.

**Cenário de reprodução**
1. Goal em execução dispara `needs_auth` e envia botões de aprovação; o goal continua produzindo passos (tool_call/tool_result) enquanto aguarda.
2. Usuário clica "Aprovar" → `workflowCallback` roda fora da fila e chama `recordAssistantMessage`.
3. As duas escritas colidem em `seqCounter`/`index.lastOffset` → dois eventos recebem o mesmo `seq`, ou o offset de checkpoint gravado aponta para o byte errado.
4. `getSinceCheckpoint()`/`replay(from)` seekam para offset incorreto → contexto do LLM truncado ou duplicado.

**Impacto**
Corrupção de ordenação e de offsets do índice de sessão → perda ou duplicação de mensagens no contexto reconstruído, decisões incorretas no turno seguinte. Alto (não cruza usuários, mas corrompe estado persistido).

**Correção recomendada (causa raiz)**
Fazer **todas** as gravações de transcript passarem pelo mesmo mutex por-sessão: mover `recordToolCall/recordToolResult/recordSystemMessage` para dentro de `withMutex`, **ou** trocar `transcript.append` por `transcript.appendAsync` em todos os call sites (ativando o `writeMutex` já existente). Adicionalmente, encaminhar o callback de workflow pela `ConversationQueueManager` da sessão (ou adquirir o mesmo mutex) para serializar com o turno em voo.

**Risco de regressão:** Médio. `appendAsync` muda `append` de síncrono para assíncrono; call sites que dependem do `seq` retornado precisam `await`. A suíte `S74_AgentLoop_ToolCallPersistence` e `S68_AgentLoop_SessionKeyChannel` cobrem parte do caminho.

---

### A2 — Auto-recuperação de DB não limpa WAL/SHM stale — **Alto**

**Localização**
- `src/core/dbRecovery.ts:59-64` — `autoRecoverDatabase` faz `fs.copyFileSync(best, dbMain)` sem remover `dbMain-wal`/`dbMain-shm`.
- **Contraste:** `src/index.ts:140-142` — o caminho de *restore manual* faz exatamente essa limpeza: `fs.unlinkSync(dbMain + '-wal')` / `'-shm'` antes de copiar, com comentário explicando o motivo ("o SQLite ao abrir o banco restaurado encontra um WAL de outro banco e tenta aplicar os frames — resultado: 'disk image is malformed'").
- `src/core/agentControllerSetup.ts:10` — `db.pragma('journal_mode = WAL')` (o banco sempre abre em WAL).

**Evidência**
O código já **sabe** que copiar um `.db` por cima sem remover o WAL/SHM antigo causa "disk image malformed" — está documentado e tratado no restore manual (`index.ts`). Mas o `autoRecoverDatabase` (acionado quando o boot detecta corrupção, `index.ts:161`) copia o backup sobre `newclaw.db` **sem** apagar `newclaw.db-wal`/`-shm` remanescentes do banco corrompido. Como `openDatabase` reabre em modo WAL logo em seguida, o SQLite tenta aplicar frames do WAL stale sobre o banco recém-restaurado.

**Cenário de reprodução**
1. Processo morre deixando `newclaw.db` corrompido + `newclaw.db-wal` não-checkpointed.
2. Reboot: `new AgentController` lança erro de corrupção; `index.ts:161` chama `autoRecoverDatabase`.
3. `copyFileSync(backup, newclaw.db)` — mas `newclaw.db-wal` antigo permanece.
4. `new AgentController(config)` (retry, `index.ts:171`) abre WAL → aplica WAL stale → "disk image malformed" de novo → recuperação falha silenciosamente ou entra em loop.

**Impacto**
A auto-recuperação — justamente o mecanismo que deveria salvar o boot — pode falhar ou reverter o restore. Alto: indisponibilidade total do serviço num cenário que o projeto tenta explicitamente cobrir.

**Correção recomendada**
Em `autoRecoverDatabase`, antes do `copyFileSync`, replicar a limpeza de `index.ts:140-141`: `unlinkSync(dbMain + '-wal')` e `'-shm'` (tolerando ausência). Idealmente extrair um helper `replaceDatabaseFile(src, dest)` usado pelos dois caminhos para não divergirem de novo.

**Risco de regressão:** Baixo. Apenas remove arquivos auxiliares que deveriam ser descartados junto com o banco corrompido.

---

### A3 — Dedup marca `messageId` antes de processar → perda em falha — **Alto**

**Localização**
- `src/channels/MessageBus.ts:276-283` — `recentMessageIds.set(dedupeKey, Date.now())` é executado **antes** de enfileirar/processar; um segundo recebimento do mesmo `messageId` retorna cedo (`duplicate_message_dropped`).
- Processamento real: `MessageBus.ts:351-505` (`processMessageCore`), que roda depois, em background.

**Evidência**
O `messageId` é registrado como "já processado" no momento da **admissão**, não da **conclusão**. Se `processMessageCore` falhar de forma que o turno não gere resposta e o Telegram reentregar a mesma update (o adapter é fire-and-forget, `TelegramAdapter.ts:365`), a reentrega é descartada como duplicata — a mensagem nunca é reprocessada. O TTL de 5 min (`MESSAGE_ID_TTL_MS`, linha 49) mantém o bloqueio ativo durante toda a janela em que o Telegram tentaria reentregar.

**Cenário de reprodução**
1. Telegram entrega update X; `MessageBus` marca `telegram:X` como visto e enfileira.
2. O processo cai (ou o turno lança antes de `adapter.send`) durante o processamento de X.
3. No restart, o Telegram reentrega X (não foi confirmado via getUpdates).
4. Se o `recentMessageIds` sobreviveu (mesmo processo) ou a reentrega chega dentro dos 5 min, X é dropado → mensagem do usuário perdida sem resposta.

Observação: `recentMessageIds` é in-memory, então após restart completo o bloqueio some — o risco concreto é o de falha **sem** restart (exceção no meio do turno) dentro da janela TTL.

**Impacto**
Perda silenciosa de mensagem do usuário em cenário de falha. Alto porque viola a garantia declarada no cabeçalho do `ConversationQueueManager` ("sem descarte").

**Correção recomendada**
Marcar o `messageId` como processado **somente após** a conclusão bem-sucedida de `processMessageCore` (ou registrar um estado `in_flight` que é promovido a `done` no sucesso e **removido** no erro, permitindo reprocessamento). Manter a dedup de admissão apenas para duplicatas **simultâneas** (janela curta), não para toda a janela de 5 min.

**Risco de regressão:** Médio. Precisa evitar reintroduzir o problema oposto (processar duas vezes uma update legitimamente duplicada). Um estado tri-valente (in_flight/done/failed) resolve ambos.

---

### A4 — `withMutex` "prossegue mesmo assim" após 10s anula a exclusão mútua — **Alto**

**Localização**
- `src/session/SessionManager.ts:126-137` — `mutexTimeout` de 10s; no timeout, o `catch` apenas loga `mutex_timeout` e **continua** (`proceeding anyway`), executando `fn()` sem esperar a operação anterior.

**Evidência**
O comentário (linha 136) e o código deixam explícito: se a operação anterior levar >10s, a próxima **não espera** e roda concorrentemente. Chamadas de compressão de sessão envolvem LLM (`ContextCompressor.compress`, `SessionManager.ts:469`) que pode exceder 10s sob carga ou com provider lento. Nesse ponto, duas operações da **mesma sessão** manipulam o mesmo `SessionTranscript` em paralelo — reintroduzindo a corrida que o mutex existia para prevenir (relacionado a A1).

**Cenário de reprodução**
1. `recordUserMessage` dispara `maybeCompress` → chamada LLM de compressão demora 12s.
2. Nova mensagem chega (ou o goal grava resposta) na mesma sessão; `withMutex` espera 10s, estoura o timeout e prossegue.
3. Duas escritas concorrentes no mesmo transcript/checkpoint.

**Impacto**
Corrupção de ordenação/checkpoint sob latência de provider — degradação que aparece exatamente quando o sistema está sob stress. Alto.

**Correção recomendada**
O timeout do mutex deve ser uma **rede de segurança contra deadlock**, não um "libere e prossiga concorrente". Duas opções compatíveis com a arquitetura: (a) elevar o timeout acima do teto real de compressão e tratar estouro como erro (rejeitar a operação e devolver mensagem ao usuário) em vez de prosseguir; ou (b) mover a compressão LLM para **fora** da seção crítica (computar o resumo sem lock, adquirir o lock só para o `append` do checkpoint — operação rápida). (b) é preferível: elimina a causa (I/O lento dentro do lock) em vez de mascarar.

**Risco de regressão:** Médio. (b) exige revalidar que nenhum estado lido para compressão muda entre o cálculo e o commit do checkpoint.

---

### M1 — `EmbeddingService.search`: full-scan O(N) em JS + sem checagem de dimensão — **Médio**

**Localização**
- `src/memory/EmbeddingService.ts:117-137` — carrega **todos** os embeddings (`SELECT ... JOIN memory_nodes`) e calcula cosine em JS para cada linha, a cada query.
- `src/memory/EmbeddingService.ts:103-112` — `cosineSimilarity` itera `for i < a.length` sem verificar `a.length === b.length`.

**Evidência**
Não há índice vetorial (o comentário na linha 24 confirma: "sqlite-vss requires custom build — use raw storage"). Cada busca semântica é O(N_nós × dim), com desserialização de `Float64Array` por linha. Além disso, se o modelo de embedding mudar (ex.: `nomic-embed-text` 768-dim → outro de dim diferente), vetores antigos e novos coexistem na tabela e `cosineSimilarity` itera até `a.length` (a query), lendo lixo/`undefined` para dims além do vetor armazenado — score silenciosamente incorreto, sem erro.

**Impacto**
Gargalo de escala (latência cresce linearmente com a memória) e **corrupção silenciosa de ranking** em troca de modelo. Médio: não quebra hoje com poucos nós (log mostra 15 nós no boot), mas degrada e pode ranquear errado.

**Correção recomendada**
(1) Guardar `dim` junto do embedding e filtrar/rejeitar vetores de dimensão diferente da query em `search` (fail-closed em vez de score corrompido). (2) Para escala, paginar/pré-filtrar por FTS antes do cosine, ou adotar um índice ANN. Sem mudar arquitetura, o mínimo é a checagem de dimensão.

**Risco de regressão:** Baixo para a checagem de dimensão; médio para mudança de índice.

---

### M2 — `MemoryFacade.removeNode` deixa embeddings/métricas órfãos (FK OFF) — **Médio**

**Localização**
- `src/memory/MemoryFacade.ts:185-191` — `removeNode` apaga edges + node, **não** apaga `memory_embeddings` nem `node_metrics`.
- `src/memory/MemoryFacade.ts:253-261` — `deleteNodeFull` apaga tudo (edges, embeddings, node_metrics, node) — prova de que a limpeza completa é conhecida e necessária.
- `src/core/agentControllerSetup.ts` — `openDatabase` **não** define `PRAGMA foreign_keys = ON`; `memorySchema.ts` só liga FK temporariamente durante migrações (linhas 135, 220) e a deixa OFF no runtime normal.
- `EmbeddingService.ts:33` declara `FOREIGN KEY (node_id) REFERENCES memory_nodes(id)` — que não é aplicada porque FK está OFF.

**Evidência**
Existem dois caminhos de deleção com semânticas diferentes. Como as foreign keys estão desligadas em runtime, apagar via `removeNode` não cascateia — a linha em `memory_embeddings`/`node_metrics` permanece apontando para um `node_id` inexistente. `EmbeddingService.search` faz `JOIN memory_nodes`, então órfãos não aparecem em resultados (bom), mas acumulam indefinidamente e `embedMissing` nunca os reconcilia. É inconsistência de estado + crescimento de tabela.

**Impacto**
Referências órfãs e crescimento não-limitado de `memory_embeddings`. Médio: não corrompe respostas hoje (JOIN filtra), mas viola integridade referencial e desperdiça espaço; se algum caminho futuro fizer `SELECT` sem JOIN, retornará lixo.

**Correção recomendada**
Fazer `removeNode` delegar para a mesma limpeza de `deleteNodeFull` (ou unificar em um único método privado `deleteNodeCascade`). Complementarmente, avaliar ligar `PRAGMA foreign_keys = ON` com `ON DELETE CASCADE` nas tabelas dependentes — mas isso é mudança maior; a correção mínima e segura é unificar os dois deletes.

**Risco de regressão:** Baixo. `deleteNodeFull` já faz o superset do que `removeNode` faz.

---

### M3 — `GoalStore` read-modify-write de JSON sem transação — **Médio**

**Localização**
- `src/loop/GoalStore.ts:346-364` (`addAttempt`), `367-392` (`addBlocker`/`recordBlocker`), `400-414` (`updateLastAttempt`), `440-452` (`addToolTried`/`addStrategyTried`) — todos fazem `getById` → mutação em memória → `update` (novo `UPDATE` completo), sem transação envolvendo leitura+escrita.

**Evidência**
Cada um lê o goal inteiro, modifica um array (attempts/blockers/toolsTried) e regrava o JSON. Se duas escritas ao **mesmo goal** ocorrerem entre o `getById` e o `update`, a segunda sobrescreve a primeira (lost update). Hoje a `ConversationQueueManager` serializa por conversa e um goal pertence a uma sessão, o que **mitiga** o caso comum. Porém `resumeFromAuth`/`abortGoalFromAuth` (`GoalOrchestrator.ts:521,555`) rodam pelo caminho de callback de workflow que **contorna a fila** (ver A1) e podem coincidir com um turno que ainda grava attempts do mesmo goal.

**Impacto**
Perda de um `attempt`/`blocker` registrado, ou `pendingTxnId` reaparecendo após limpeza. Médio e parcialmente latente — depende da coincidência temporal viabilizada pelo bypass de A1.

**Correção recomendada**
Envolver read-modify-write em `db.transaction(...)` (better-sqlite3 suporta e o projeto já usa em `snapshotRepository.ts:17`), ou converter appends de array para operações idempotentes por-id. Resolver A1 (serializar o callback de workflow) remove a janela concorrente principal.

**Risco de regressão:** Baixo. Transações better-sqlite3 são síncronas e locais.

---

### M4 — `EventBus.onAny` sem unsubscribe utilizável — **Médio (latente)**

**Localização**
- `src/core/EventBus.ts:207-215` — `onAny` registra o handler em **cada** `EventTypes` e retorna um `id = Date.now()` que **não** é usado por nenhum `off`; não há como desinscrever.

**Evidência**
O handler é anexado a N tipos de evento e o valor de retorno é um número inútil para remoção. `AgentController.ts:437` chama `onAny` uma vez no construtor. Como o `AgentController` é criado uma vez por processo (e, no caminho de auto-recovery, `index.ts:171`, **duas vezes**), um segundo `AgentController` registraria um segundo conjunto de handlers no **mesmo** `eventBus` singleton (`EventBus.ts:264`) sem remover os do primeiro — cada `SCHEDULER_TRIGGER` seria processado em duplicidade.

**Cenário de reprodução**
1. Boot detecta corrupção → `autoRecoverDatabase` → `new AgentController(config)` pela segunda vez (`index.ts:171`).
2. Dois handlers `onAny` ativos no `eventBus` global.
3. Uma tarefa agendada dispara → `agentLoop.process` roda **duas vezes** → possível dupla resposta/dupla execução de efeito colateral (ex.: envio duplicado).

**Impacto**
Duplicação de eventos/execuções no caminho de recuperação. Médio porque exige o caminho de auto-recovery para se manifestar, mas é uma consequência real de estado global sem teardown.

**Correção recomendada**
`onAny` deve retornar uma função de unsubscribe (como `on`/`once` já fazem, `EventBus.ts:157-167`) que remove o handler de todos os tipos; e o `AgentController` deve limpar suas assinaturas no `stop()`/antes de recriar. Alternativamente, garantir que o retry de auto-recovery destrua o primeiro controller antes de criar o segundo.

**Risco de regressão:** Baixo.

---

### B1 — Dois mecanismos de reconexão concorrentes — **Baixo**

**Localização**
- `src/channels/MessageBus.ts:156-188` — `scheduleAdapterReconnect` (backoff próprio do bus).
- `src/channels/TelegramPollingSupervisor.ts:187-317` — o Telegram tem seu **próprio** loop de reconexão/cooldown/circuit-breaker.

**Evidência**
Se `adapter.start()` do Telegram falhar em `startAll` (`MessageBus.ts:137-144`), o bus agenda sua própria reconexão **enquanto** o `TelegramPollingSupervisor` também gerencia reconexão internamente. Dois relógios independentes podem chamar `start()` sobrepostos. O supervisor tem guard `if (this.pollingActive) return` (`TelegramPollingSupervisor.ts:108`), o que **mitiga**, mas a coordenação entre as duas camadas não é explícita.

**Impacto**
Baixo: risco de logs confusos e tentativas redundantes; o guard de `pollingActive` e o PID-lock evitam dupla conexão real. Não comprovado que cause 409 adicional — **hipótese de dano concreto não comprovada**, reportada como acoplamento arriscado.

**Correção recomendada**
Adapters com supervisor interno (Telegram) deveriam sinalizar ao bus que **eles** gerenciam reconexão, e `startAll` não deveria agendar `scheduleAdapterReconnect` para eles. Padronizar via uma flag `adapter.selfHealing`.

**Risco de regressão:** Baixo.

---

### B2 — `uncaughtException` continua em estado possivelmente corrompido — **Baixo**

**Localização**
- `src/index.ts:86-99` — só sai em erros com `ENOMEM`/`heap out of memory`/`FATAL`; qualquer outra `uncaughtException` é logada e o processo **continua**.

**Evidência**
Uma `uncaughtException` genérica indica, por definição, que uma exceção escapou de todo `try/catch` — o estado do módulo que a lançou pode estar inconsistente. Continuar (linha 98) mantém o serviço vivo (objetivo declarado) mas arrisca operar sobre estado corrompido (ex.: uma transação SQLite parcialmente aplicada, um `SessionTranscript` com stream em estado inválido).

**Impacto**
Baixo/situacional: trade-off consciente (disponibilidade vs. correção). Reportado por completude — não é um bug, é um risco de design que pode mascarar corrupção.

**Correção recomendada**
Distinguir exceções por origem: erros de I/O/rede transitórios → continuar; erros de invariante (asserção, corrupção de DB, `RangeError`/`TypeError` inesperados) → drenar e reiniciar de forma controlada (deixar o PM2 reiniciar limpo). Manter métrica de frequência para detectar loops.

**Risco de regressão:** Baixo, mas muda política de disponibilidade — decidir conscientemente.

---

### B3 — Backpressure descarta mensagem — **Baixo**

**Localização**
- `src/core/ConversationQueueManager.ts:75-78` — ao atingir `MAX_PENDING` (default 20), a mensagem é **rejeitada** (`backpressure`); `MessageBus.ts:319-331` avisa o usuário.

**Evidência**
Comportamento intencional e comunicado ao usuário ("Muitas mensagens pendentes"). Do ponto de vista de garantias, ainda assim é **perda** da mensagem daquele turno (o usuário precisa reenviar). Documentado aqui porque a auditoria lista "perda de mensagens" — este é o único ponto onde há descarte deliberado.

**Impacto**
Baixo e por design. Não é bug.

**Correção recomendada**
Nenhuma obrigatória. Se a garantia "sem descarte" do cabeçalho do arquivo for para valer, considerar persistir mensagens excedentes em disco em vez de rejeitar. Caso contrário, alinhar o comentário do cabeçalho (que promete "sem descarte") com o comportamento real de backpressure.

**Risco de regressão:** N/A.

---

## 7. Risco de regressão das correções (consolidado)

| Achado | Risco da correção | Observação |
|--------|-------------------|-----------|
| C1 | Médio | Refatorar estado para local/`Map` por turno; testar 2 conversas concorrentes |
| C2 | Baixo (muda comportamento) | Fail-closed pode "quebrar" instalações que dependiam do aberto — documentar |
| A1 | Médio | `appendAsync` torna `append` assíncrono; ajustar call sites que usam `seq` |
| A2 | Baixo | Só remove WAL/SHM stale |
| A3 | Médio | Evitar reprocessamento duplo legítimo (estado tri-valente) |
| A4 | Médio | Mover LLM para fora do lock exige revalidar consistência do checkpoint |
| M1 | Baixo/Médio | Checagem de dimensão é trivial; índice ANN é maior |
| M2 | Baixo | Unificar com `deleteNodeFull` |
| M3 | Baixo | Transações better-sqlite3 já usadas no projeto |
| M4 | Baixo | Retornar unsubscribe + teardown no `stop()` |
| B1/B2/B3 | Baixo | Ajustes de política/coordenação |

## 8. Grau de confiança da análise

- **Alta confiança** (comprovado diretamente no código): C1, C2, A1, A2, A3, A4, M1, M2, M3, M4.
- **Confiança média / dano concreto não totalmente comprovado**: B1 (o guard `pollingActive` + PID-lock podem neutralizar o dano real — reportado como acoplamento, não como falha comprovada).
- **Não auditado dinamicamente**: nenhuma execução em runtime foi feita; a análise é estática + correlação com `tmp_server_out.txt`. Race conditions (C1, A1, A4, M3) são comprovadas pela estrutura do código (estado compartilhado + caminhos concorrentes), não por um trace de corrida capturado ao vivo.

---

## Contagem final

- **Críticos:** 2 (C1, C2)
- **Altos:** 4 (A1, A2, A3, A4)
- **Médios:** 4 (M1, M2, M3, M4)
- **Baixos:** 3 (B1, B2, B3)

### Áreas auditadas
Concorrência (filas `p-queue`, mutex de sessão, `activeTurns`, `BackgroundCognitionQueue`, `generationQueue`/`taskQueue`, `CircuitBreaker`, `ToolExecutor` timeout/retry/cancel); Memória (SessionTranscript/SessionManager, ReflectionMemory, EmbeddingService, MemoryFacade, snapshotRepository, CognitiveWorkspace); Planejamento (GoalStore máquina de estados, GoalOrchestrator, GoalExecutionLoop — estado local); Tool calling (ToolExecutor, exec_command auto-fix/PowerShell/CLIXML); Adapters (Telegram + Supervisor, WhatsApp, Signal, Discord, Web); Persistência (SQLite WAL/pragmas, dbRecovery, restore, embeddings BLOB, checkpoints); Segurança (allowlists de canal, auth do dashboard, exec/ssh dangerous); Arquitetura (EventBus, injeção por setter para quebrar ciclos, singletons).

### Áreas NÃO auditadas em profundidade (recomendadas para próxima passagem)
- **RiskAnalyzer / ObserverValidator / StepSemanticValidator** — lógica de análise de risco por step (lida superficialmente; merece auditoria própria de prompts e parsing de JSON do LLM).
- **CMI (memória conversacional)** — `CMIEngine/CMIBuffer/CMIIngestionPipeline` (fire-and-forget a partir do SessionManager; não auditado o pipeline interno).
- **MemoryCurator / MemoryGovernor / GraphAnalytics** — ciclos de decaimento, GC, detecção de conflito e pagerank (só o acionamento foi visto).
- **Dashboard routes** (`chat`, `maintenance`, `memory`, `config`) — além de `auth.ts`; não auditados quanto a injeção/validação de input e escrita de `.env` (`config.ts:72` escreve `.env` a partir de request body — candidato a auditoria de segurança).
- **WhatsApp/Baileys e Signal-cli** — parsing de payloads externos e reconexão (só a allowlist foi verificada).
- **SkillLearner / SkillInstaller / SkillLoader** — geração e escrita de `SKILL.md` a partir de saída de LLM (`SkillLearner.ts:691`).
- **PowerPoint add-in / broker** (`powerpointBroker`, `powerpoint_control`) — canal e ciclo de vida de entrega órfã.
- **ProviderFactory / fallback entre provedores** — lógica de seleção, timeout dinâmico e circuit por-provedor.
