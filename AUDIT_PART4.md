# AUDIT PART 4 — Canais, Sessão, Cognição: Análise Arquitetural Profunda

**Data:** 2026-05-09  
**Escopo:** Channels (MessageBus, ChannelAdapter, TelegramAdapter, SignalAdapter, DiscordAdapter, WhatsAppAdapter, index), Session (SessionManager, SessionContext, SessionTranscript, SessionLearner, EventRanker), Cognitive (CognitiveWorkspace), Loop complementares (ContextBuilder, ContextBudget, ContextCompressor, ContextValidator, DecisionPostProcessor, ResponseAdapter, ResponseBuilder, routeIntent, ObserverValidator, ModelRouter, SkillLearner, ExecutionTrace, ProviderFactory)

---

## 1. MESSAGEBUS — Hub Central de Roteamento

### Responsabilidades Reais
- Roteamento central entre adapters de canal e AgentLoop
- Processamento de mensagens normalizadas (text, photo, voice, audio, document, command)
- Despacho para handlers registrados (onMessage callback)

### Padrões de Mensagem/Evento
- **Entrada:** `NormalizedMessage` — tipada, estruturada, com `type` discriminado
- **Saída:** `NormalizedResponse` — tipado, com `format: 'markdown' | 'html' | 'plain'`, attachments, reactions
- **VANTAGEM:** Tipagem forte na interface — bom contrato entre canais e núcleo

### Problemas Identificados
1. **Acoplamento via `rawContext: any`** — O `NormalizedMessage.rawContext` carrega o contexto nativo do canal (grammy `Context`, discord.js `Message`, string de telefone Signal). Isso viola isolamento de canal: o AgentLoop recebe um `any` e precisa saber qual canal originou para responder corretamente. **Boundary leak crítico.**
2. **Sem correlation ID** — Mensagens não possuem ID de correlação para rastrear request→response através do pipeline. Impossível correlacionar logs entre MessageBus → AgentLoop → LLM → resposta.
3. **Sem filas/backspressure** — `processMessage` é assíncrono mas sem fila. Se múltiplas mensagens chegarem simultaneamente (ex: usuário envia texto + imagem), processamento paralelo sem ordenação garantida.
4. **Sem timeout/circuit breaker** — Se AgentLoop travar, mensagens acumulam sem timeout.

---

## 2. CHANNELADAPTER — Interface de Abstração

### Design
- Interface limpa: `start()`, `stop()`, `send()`, `healthCheck()`, `sendTypingIndicator()`
- `NormalizedMessage` e `NormalizedResponse` como contratos centrais
- `ChannelType` union type: `'telegram' | 'discord' | 'signal' | 'whatsapp' | 'web'`

### Avaliação Positiva
- **Bom design de interface** — Adapter pattern correto, cada canal implementa a mesma interface
- **Tipagem forte** — `TypingAction`, `ChannelAttachment`, `ResponseAttachment` bem definidos
- **Extensibilidade** — Novos canais só precisam implementar a interface

### Problemas
1. **`getBotToken?()` na interface** — Expõe credenciais na interface do adapter. Token NÃO deveria ser acessível externamente.
2. **`rawContext?: any`** — Como já mencionado, buraco na abstração que vaza implementação interna do canal.
3. **Sem interface de lifecycle events** — Não há `onConnected`, `onDisconnected`, `onError` padronizados. Cada adapter gerencia seu próprio estado sem notificar o sistema.

---

## 3. TELEGRAM ADAPTER — Implementação de Produção

### Responsabilidades
- Integração completa com grammY (Bot, Context, InputFile)
- Input: text, photo, voice, audio, document, commands
- Output: text (markdown/HTML com chunking), audio (voice), documents, typing indicator
- Autorização via `allowedUserIds`

### Qualidade: **Alta** — O adapter mais maduro e completo

### Padrões Observados
- **Chunking inteligente** — `splitIntoChunks` respeita blocos `<pre>` para não quebrar código
- **Retry em 409 Conflict** — Pre-check `deleteWebhook` + retry com backoff exponencial
- **Fallback de formatação** — Tenta HTML, fallback para plain text
- **Media confirmation skip** — Não envia mensagens de confirmação de mídia (`🔊 Áudio enviado...`)

### Problemas
1. **`metadata: { botToken: this.config.botToken }`** — Token do bot propagado em CADA mensagem normalizada. Se qualquer componente logar `NormalizedMessage`, vaza o token. **Risco de segurança HIGH.**
2. **Dynamic `import('fs')`** — `sendAttachment` usa `await import('fs')` a cada envio. Deveria ser importação estática ou cache.
3. **Sem rate limiting** — Apenas `100ms` delay entre chunks. Telegram tem rate limits (30 msg/s em grupos, 1 msg/s em chats privados). Sem controle adaptativo.
4. **Typing indicator sem timeout** — `sendTypingIndicator` envia ação mas não renova a cada 5s para operações longas.

---

## 4. SIGNAL ADAPTER — Implementação Experimental

### Responsabilidades
- Integração com signal-cli via DBus/JSON-RPC
- Recebimento via webhook server ou polling (`receive --json --timeout`)
- Envio via `signal-cli send`

### Qualidade: **Média-Baixa** — Funcional mas com falhas arquiteturais significativas

### Problemas Críticos
1. **`startReceiveLoop()` sem cleanup** — Loop infinito `while (this._isConnected)` sem mecanismo de graceful shutdown. Se `stop()` for chamado, o loop continua até a próxima iteração verificar a flag.
2. **`execFile` síncrono para envio** — Cada mensagem invoca `signal-cli send` como subprocesso. Overhead de processo (~200ms+ por msg). Para produção, deveria usar JSON-RPC ou DBus.
3. **Webhook server sem autenticação** — `startWebhookServer` aceita POST em `/signal/webhook` sem qualquer verificação. Qualquer pessoa pode injetar mensagens.
4. **`signal-cli receive --timeout 3600`** — Long-polling com 1h de timeout iniciado no `start()` mas não aguardado (comentário diz "we don't await this"). Conexão perdida silenciosamente.
5. **Config type-unsafe** — `(this.config as any).botToken` — cast para `any` indica que a interface não foi projetada para Signal.

---

## 5. DISCORD ADAPTER — Implementação Parcial

### Responsabilidades
- Integração com discord.js (Client, GatewayIntentBits, Partials)
- Input: mensagens de texto + attachments (photos, audio, documents)
- Output: texto markdown/plain, attachments via AttachmentBuilder
- Autorização: `allowedGuildIds` + `allowedUserIds`

### Qualidade: **Média** — Estrutura correta mas sem tratamento de rate limits do Discord

### Problemas
1. **Sem rate limiter** — Discord tem rate limits rigorosos (5 msg/5s em canais). Chunks enviados com apenas 100ms de delay podem causar 429.
2. **`stripHtml` rudimentar** — Regex-based HTML→Discord markdown. Não cobre lists, tables, links. Perda de formatação significativa.
3. **Reações não implementadas** — `response.reactions` mencionado mas com `// Skip for now — future`.
4. **Typing indicator ausente** — Não implementa `sendTypingIndicator()`. Discord suporta via `channel.sendTyping()`.
5. **Guild whitelist no handler** — Verificação de guild feita DENTRO do handler de mensagem, não no nível do adapter. Mensagens de guilds não permitidas ainda disparam o handler.

---

## 6. WHATSAPP ADAPTER — Implementação via Baileys

### Responsabilidades
- Integração com @whiskeysockets/baileys (WASocket)
- Autenticação via QR code ou pairing code
- Input: texto, imagem, vídeo, áudio, voz, documento, contato, localização
- Output: texto (markdown stripped), áudio, documento, imagem
- Send queue (PQueue concurrency=1)

### Qualidade: **Média-Alta** — Melhor estrutura de concurrency entre os adapters

### Padrões Positivos
- **PQueue para envio** — Serializa mensagens WhatsApp (necessário por limites da API)
- **Reconexão automática** — `connection.update` handler com reconexão em disconnect
- **Auth state persistente** — `useMultiFileAuthState` com diretório dedicado
- **Pairing code** — Suporte a pairing como alternativa ao QR

### Problemas
1. **`stripMarkdown` destrutivo** — Converte `**bold**` → `*bold*`, mas o regex de code blocks `\``\`\`` é incorreto. Resultado: formatação quebrada em mensagens longas.
2. **`handleMessage` não faz download de mídia** — `fileId` é o `msg.key.id` (message ID), não um caminho de arquivo. Para baixar mídia, precisa usar `this.sock!.downloadMediaMessage()`. Atualmente, mídia recebida é inacessível.
3. **`makeCacheableSignalKeyStore` com logger vazio** — Logger `{} as any` perde toda a telemetria de auth.
4. **`sendAttachment` lê arquivo do disco** — Mas `ResponseAttachment.data` pode ser `Buffer`. A conversão `typeof data === 'string'` ignora Buffers.

---

## 7. SESSION MANAGER — Gestão de Sessões com Mutex

### Responsabilidades Reais
- Criação/recuperação de sessões por `SessionKey { channel, userId }`
- Mutex por sessão (concorrência segura)
- Compressão híbrida: por contagem de mensagens OU estimativa de tokens
- Checkpoints estruturados com resumo LLM
- `/clear` cria nova sessão (não limpa a existente — boa prática)
- Tracking de arquivos ativos por sessão

### FSM Implícito
```
[NEW] → createSession → [ACTIVE]
[ACTIVE] → maybeCompress → [COMPRESSING] → [ACTIVE]
[ACTIVE] → checkpoint → [ACTIVE w/ checkpoint]
[ACTIVE] → clear → [NEW session created]
```

### Qualidade: **Alta** — Design production-grade com mutex e compressão

### Problemas
1. **Mutex por sessão mas não por operação** — `getSession` e `getOrCreateSession` usam mutex, mas `recordUserMessage`/`recordAssistantMessage` podem não. Se duas operações concorrem, transcript pode ficar inconsistente.
2. **`getDatabase()` leak** — ContextBuilder acessa o banco SQLite diretamente via `this.memory.getDatabase()` para queries de connectivity e recency. Isso quebra a abstração do MemoryManager.
3. **Compressão síncrona bloqueante** — `maybeCompress` chama LLM para resumir. Se o LLM demorar, a sessão fica bloqueada pelo mutex. Deveria ser assíncrona com marcação.
4. **Sem TTL/expiração de sessão** — Sessões nunca expiram automaticamente. Sessões de usuários inativos há meses permanecem na memória.

---

## 8. SESSION CONTEXT — Montagem de Contexto para LLM

### Responsabilidades
- Pipeline de montagem de contexto: system → state → memory → skills → checkpoint → history → current
- Orquestra SessionManager (transcript + checkpoints) + ContextBuilder (semantic search) + ContextBudget (token limits)

### Padrão Observado
- Cada bloco é uma mensagem `system` separada — **bom design**, evita concatenação monolítica
- Budget enforcement por bloco com prioridades (system=10, current=9, state=8, checkpoint=7, memory=6, skills=5, history=3)

### Problemas
1. **ContextBudget final safety check quebra ordem** — Se `totalTokens > maxInputTokens`, blocos são ordenados por prioridade, truncados, e depois RE-ordenados por role. Mas a reordenação pode colocar mensagens de usuário ANTES de system, quebrando a ordem semântica.
2. **`estimateTokens` impreciso** — Usa heurística de `charsPerToken = 3 + (1 - codeRatio) * 0.5`. Para português (mais tokens/char que inglês), isso subestima em ~20%. Risk: context overflow silencioso.
3. **Sem deduplicação** — Se memory context e checkpoint summary contêm os mesmos fatos, ambos são incluídos. Sem mecanismo de dedup.
4. **`buildLLMMessages` é assíncrono mas não cancelável** — Se o LLM já começou a responder e o contexto ainda está sendo montado, não há cancelamento.

---

## 9. SESSION TRANSCRIPT — Log Append-Only JSONL

### Responsabilidades
- JSONL append-only com index file (.idx.json)
- Mutex por transcript (concorrência)
- Replay com seek otimizado via checkpoints
- Rebuild automático de index se corrompido

### Qualidade: **Alta** — Event-sourcing correto com index

### Padrões Positivos
- **Append-only** — Nunca modifica entradas existentes, apenas anexa
- **Index file** — Permite seek rápido sem ler arquivo inteiro
- **Checkpoint offsets** — Replay desde checkpoint evita ler arquivo inteiro
- **Mutex** — `appendAsync` usa promise chain para serializar escritas
- **Rebuild** — Se index está corrompido, rebuilda a partir do JSONL

### Problemas
1. **Index persistido apenas a cada 10 entradas** — Se o processo crashar antes do 10º append, entradas são preservadas no JSONL mas o index fica desatualizado. Rebuild resolve mas com custo de escanear o arquivo inteiro.
2. **WriteStream não é fechado em crash** — `close()` depende de flush ser chamado. Em crash abrupto (SIGKILL), dados em buffer podem ser perdidos.
3. **Sem compressão/compactação** — JSONL cresce indefinidamente. Para sessões longas (1000+ entradas), arquivo pode ficar grande. Checkpoint ajuda no replay mas não reduz tamanho do arquivo.
4. **`appendSync` ainda existe** — Mesmo com `appendAsync` disponível, o método síncrono `append` pode ser chamado por código legado, quebrando a garantia de mutex.

---

## 10. SESSION LEARNER — Extração de Fatos Padrão

### Responsabilidades
- Extrai fatos de transcrições de sessão usando pattern matching
- Tipos: identity, preference, project, infrastructure, skill, fact
- Upsert no MemoryManager graph
- Tracking de última sequência processada por sessão

### Qualidade: **Média** — Funcional mas limitado

### Problemas
1. **Pattern matching em português only** — Regex `/^(eu sou o|meu nome é|chamo-me)/i` funciona apenas para português. Sem suporte a inglês ou outros idiomas.
2. **Confiabilidade hardcoded** — Confianças fixas (identity: 0.9, preference: 0.7, project: 0.8, infrastructure: 0.85). Sem calibração ou aprendizado baseado em acertos/erros.
3. **Sem desambiguação** — Se o usuário diz "meu nome é Luciano" e depois "meu nome é Lucas", cria dois nós de identidade com pesos diferentes mas sem resolver o conflito.
4. **`processedSeqs` é in-memory** — Mapa em memória, perdido a cada restart. No restart, `learnFromSession` reprocessa tudo desde o início da sessão (ou desde o último checkpoint, se houver).
5. **Upsert direto no MemoryManager** — Chama `this.memory.addNode()` e `this.memory.addEdge()` diretamente, sem passar pelo MemoryGovernor (que tem conflito/overlap detection). **Boundary violation.**
6. **Extração de fatos de mensagens longas sem conteúdo** — Se `content.length > 100` mas nenhum pattern matchou, cria um fato genérico com `confidence: 0.5`. Ruído cognitivo.

---

## 11. EVENT RANKER — Priorização de Eventos

### Responsabilidades
- Ranking de eventos de transcrição por importância
- Fatores: role weight, length, recency (exponential decay), questions, decisions, tool failures, token count

### Qualidade: **Média** — Funcional mas simples

### Problemas
1. **Decay factor hardcoded** — `RECENCY_DECAY = 0.93` com half-life de ~10 mensagens. Para sessões longas (50+ mensagens), eventos antigos são praticamente zerados mesmo que contenham informações críticas.
2. **Sem contextualização semântica** — Ranking é puramente sintático (regex + length + position). Não considera relevância semântica ao tópico atual da conversa.
3. **Sem integração com AttentionLayer** — MemoryManager tem um sistema de atenção sofisticado (embedding similarity × context relevance × recency × relation strength). EventRanker não o utiliza.
4. **Decisões detectadas por regex pt-BR** — `/(prefiro|quero|gosto|implementa|cria)/` — Mesmo problema do SessionLearner: monolíngue.

---

## 12. COGNITIVE WORKSPACE — Memória de Trabalho Governada

### Responsabilidades
- Scratchpad de trabalho com token budget (~2000 tokens) e TTL (5 min)
- Auto-pruning por LRU e tamanho
- Distillation: compacta workspace via LLM quando excede 60% do budget
- Integração com AgentLoop como "pensamento interno"

### FSM Implícito
```
[EMPTY] → add → [ACTIVE]
[ACTIVE] → add (budget ok) → [ACTIVE]
[ACTIVE] → add (budget full) → [DISTILLING] → [ACTIVE (compacted)]
[ACTIVE] → TTL expired → [EMPTY]
[ACTIVE] → clear → [EMPTY]
```

### Qualidade: **Alta** — Bom design de workspace governado

### Padrões Positivos
- **Budget enforcement** — Tokens limitados com eviction LRU
- **Distillation** — Compactação inteligente via LLM antes de descartar
- **TTL** — Entradas expiram após 5 minutos, mantendo workspace relevante
- **Isolamento** — Explicitamente separado da memória semântica de longo prazo

### Problemas
1. **Distillation bloqueante** — `distill()` chama LLM de forma síncrona. Se o LLM demorar, o workspace fica indisponível. Deveria ser non-blocking com snapshot.
2. **Sem snapshot antes da distillation** — Se o LLM falhar ou produzir resumo ruim, as entradas originais já foram removidas. Sem recovery.
3. **TTL de 5 minutos hardcoded** — Para sessões longas com tópicos persistentes, 5 minutos é muito pouco. Para sessões rápidas, é adequado. Deveria ser configurável por sessão.
4. **Sem integração com SessionTranscript** — Workspace entries poderiam ser persistidos no transcript como eventos tipo `workspace_entry`, mas não são. Perda de contexto em restart.

---

## 13. CONTEXT BUILDER — Busca Semântica com Atenção

### Responsabilidades
- Pipeline: query → relevance gate → semantic search → rank → compact → context string
- Ranking: similarity × 0.6 + connectivity × 0.25 + recency × 0.15
- Top-K (5-8) nós com conteúdo compactado (200 chars)
- Relevance gate: social messages/greetings get no context

### Qualidade: **Média** — Funcional mas com acoplamento problemático

### Problemas
1. **`this.memory.getDatabase()`** — Acessa o banco SQLite diretamente para queries de connectivity e recency. **Boundary leak crítico** — quebra encapsulamento do MemoryManager.
2. **Fallback silencioso** — Se semantic search falha, cai para `this.memory.getContext(200)` sem log de warning. Perda de observabilidade.
3. **Compactação agressiva** — 200 chars por nó, cortando no último período. Para nós tipo `project` ou `infrastructure`, 200 chars podem ser insuficientes.
4. **Top-K fixo** — `MAX_NODES = 6` hardcoded. Para queries complexas, 6 nós podem ser pouco. Para queries simples, desperdício de tokens.

---

## 14. CONTEXT BUDGET — Controle de Orçamento de Tokens

### Responsabilidades
- Distribuição de orçamento: system(1500), state(500), memory(1000), history(2000), skills(500), response(4000)
- Truncagem inteligente por prioridade
- Estimativa de tokens com heurística code-aware

### Qualidade: **Média-Alta** — Conceito correto, execução com falhas

### Problemas
1. **Estimativa de tokens imprecisa** — `charsPerToken = 3 + (1 - codeRatio) * 0.5` subestima tokens em português. Deveria usar `charsPerToken ≈ 3` para pt-BR (sem code adjustment).
2. **Safety check quebra ordem** — Quando `totalTokens > maxInputTokens`, blocos são ordenados por prioridade e truncados, depois reordenados por role. Mas a reordenação pode resultar em mensagens de usuário antes de system, quebrando o contrato do LLM.
3. **Sem inter-block dedup** — Se memory block e checkpoint summary contêm os mesmos fatos, ambos são incluídos sem verificação.
4. **`maxMessageChars = 1500`** — Pode cortar mensagens de usuário importantes no meio. Sem indicador visual de truncamento para o usuário.

---

## 15. CONTEXT COMPRESSOR — DEPRECATED mas Ainda Usado

### Status: **DEPRECATED** — Comentário diz "DO NOT use this class directly in AgentLoop"

### Problema
1. **Ainda importado** — Mesmo deprecated, `ContextCompressor` é importado por `SessionManager` para sumarização via LLM. Deveria ser removido ou renomeado para `SessionSummarizer` para evitar confusão.
2. **Fallback de sumarização** — Se LLM falha, usa um fallback que apenas pega primeiros 100 chars de cada mensagem de usuário. Péssima qualidade de resumo.
3. **`MAX_CONTEXT_CHARS = 12000`** — Hardcoded, não respeita o `ContextBudget`. Conflito de orçamento.

---

## 16. CONTEXT VALIDATOR — Validação de Qualidade de Contexto

### Responsabilidades
- Avalia qualidade do contexto: densidade, metadata (drift/stability), conflitos
- Retorna: quality score (0-1), hasConflict, recommendation (assertive/neutral/cautious)

### Qualidade: **Média** — Simples mas funcional

### Problemas
1. **Conflito detectado por chave:valor simples** — `subjects.set(subject, value)` detecta conflito se o mesmo subject tem valores diferentes. Mas "user_name: Luciano" e "user_name: luciano" (case different) são detectados como conflito.
2. **Thresholds hardcoded** — Quality < 0.5 → cautious, < 0.8 → neutral, else → assertive. Sem calibração baseada em outcomes reais.
3. **Não integrado com AttentionLayer** — Validação é puramente sintática. Não consulta o sistema de atenção que já tem scores de relevância.

---

## 17. DECISION POST-PROCESSOR — Modulação de Resposta

### Responsabilidades
- Modula tom da resposta baseado em: validation recommendation, state stability, drift risk, confidence
- Nunca reescreve completamente — apenas ajusta tom/proatividade

### Qualidade: **Média** — Conceito interessante, execução frágil

### Problemas
1. **Regex em pt-BR** — `/Certamente,|Com certeza,|Garanto que/` → `Pode ser que`. Só funciona para respostas em português. Se o LLM responder em inglês, nenhuma modulação ocorre.
2. **`maxChanges = 2`** — Limite arbitrário. Em respostas longas, 2 mudanças podem ser insuficientes. Em respostas curtas, 2 mudanças podem distorcer o sentido.
3. **Prefix automático** — Adiciona "Pelo que consegui verificar, " sem considerar se já existe um prefix similar.
4. **Side effect** — Modifica a string de resposta diretamente. Não há logging das mudanças feitas. Impossível auditor o que foi modificado.

---

## 18. RESPONSE ADAPTER — Normalização de Resposta

### Responsabilidades
- `normalizeResponse`: estrutura completa (type, content, thought, evaluation, toolName, toolInput)
- `extractText`: extração leve de texto (para compressor, validator)
- Pipeline: raw → sanitize → parse → normalize

### Qualidade: **Média-Alta** — Pipeline claro com fallbacks

### Problemas
1. **Two functions with overlapping responsibility** — `normalizeResponse` e `extractText` ambas tentam parsear JSON. Se o formato muda, ambas precisam ser atualizadas.
2. **`extractText` remove `<think>` tags** — Regex `/<think>[\s\S]*?<\/think>/gi` pode remover conteúdo legítimo se o LLM não usar tags de thinking.
3. **`normalizeFromRaw` recebe `parseFn` como parâmetro** — Injeção de dependência boa, mas nenhum caller valida se `parseFn` retorna `null` vs `{}`.

---

## 19. RESPONSE BUILDER — Formatação Direta de Tool Results

### Responsabilidades
- Formata resultados de ferramentas sem chamar LLM
- Formato específico por ferramenta: write, edit, read, memory_search, memory_write, memory_admin, exec_command
- Truncagem de output longo

### Qualidade: **Média** — Funcional mas hardcoded

### Problemas
1. **Hardcoded tool names** — Switch case com strings literais. Se uma ferramenta é adicionada sem atualizar o builder, retorna `null` e chama LLM desnecessariamente.
2. **Truncagem em 1500 chars sem indicar onde continuar** — "Use send_document para enviar o arquivo completo" mas sem contexto do que foi cortado.
3. **Sem formatação adaptativa por canal** — Usa markdown code blocks independentemente do canal. WhatsApp não suporta code blocks.

---

## 20. ROUTE INTENT — Roteamento Determinístico + LLM

### Responsabilidades
- Roteamento de intenção: determinístico primeiro (regex), LLM como fallback
- Categorias: llm, tool, compound (data + audio), audio_request

### Qualidade: **Média** — Funcional mas com limitações

### Problemas
1. **Regex pt-BR only** — Toda a detecção é em português. Sem suporte multilíngue.
2. **Ordem de matching importa** — Audio request é checado ANTES de memory write. Se o usuário diz "narre na memória", pode ser roteado como audio ao invés de memory.
3. **`write` tool com path hardcoded** — `{ path: './workspace/sites/', content: '' }`. O path é sempre o mesmo independentemente do contexto.
4. **Sem fallback para ferramentas desconhecidas** — Se nenhum pattern matcha, retorna `{ action: 'llm' }`. Isso é correto, mas ferramentas customizadas (ex: skills) nunca são roteadas deterministicamente.

---

## 21. OBSERVER VALIDATOR — Validação Pós-Execução via LLM

### Responsabilidades
- Usa LLM secundário (qwen3.5:cloud) para validar qualidade de respostas
- Apenas para execuções com ferramentas
- Retorna: approved, reason, confidence, suggestedFix

### Qualidade: **Média** — Overhead significativo para ganho questionável

### Problemas
1. **Custo duplicado** — Cada tool execution gera 2 chamadas LLM: a principal + a validação. Para um assistente que já é lento, adicionar ~2s de validação por execução é caro.
2. **JSON parsing frágil** — `jsonMatch = content.match(/\{[^}]*"approved"[^}]*\}/s)` não funciona se o JSON tem nested objects. O `[^}]*` para no primeiro `}`.
3. **Fallback sempre aprova** — Se o observer falha, retorna `{ approved: true, confidence: 0.3 }`. Isso significa que falhas do observer são silenciosas e o sistema nunca rejeita nada.
4. **`suggestedFix` nunca é usado** — O `suggestedFix` é retornado mas nenhum componente o consome. Work morto.

---

## 22. MODEL ROUTER — Roteamento de Modelos por Intenção

### Responsabilidades
- Classificação determinística (regex) + LLM fallback para roteamento de modelos
- Categorias: chat, code, vision, light, analysis, execution
- Cache de classificação (5 min TTL)
- Profiles configuráveis por modelo

### Qualidade: **Média-Alta** — Bem estruturado com cache

### Padrões Positivos
- **Cache de classificação** — Evita chamar LLM para a mesma query repetida
- **Fallback chain** — Determinístico → LLM → Determinístico (fallback)
- **Queue separada** — `classificationQueue` separada da `generationQueue` no ProviderFactory
- **Config dinâmica** — Modelos podem ser sobrescritos por config

### Problemas
1. **Classification cache é in-memory** — `Map<string, { category, timestamp }>` perdido a cada restart. Sem persistência.
2. **LLM classification timeout** — 30s timeout para classificação. Em pico, isso bloqueia a resposta.
3. **ProviderFactory typed as `any`** — `private providerFactory?: any` — perde toda a tipagem. Se ProviderFactory muda, erros são silenciosos.
4. **`execution` category** — Existe no config mas `routeIntent.ts` nunca roteia para ela. A decisão de usar modelo de execução é feita em outro lugar (AgentLoop).
5. **Sem métricas de acurácia** — `usageLog` conta frequência mas não rastreia se a classificação foi correta. Sem feedback loop.

---

## 23. SKILL LEARNER — Auto-aprendizado de Skills

### Responsabilidades
- Registra padrões de uso de ferramentas (pattern × tool × success_rate × latency)
- Propõe skills automáticas quando padrões atingem threshold
- Matching de skills por padrão de input
- Ciclo de vida: proposed → active → rejected

### Qualidade: **Média** — Conceito bom, execução com falhas

### Problemas
1. **`extractPattern` é regex fixa** — Os mesmos patterns hardcoded do `routeIntent.ts`. Não aprende novos patterns dinamicamente, apenas mapeia inputs existentes.
2. **Skill proposal automática** — `tryCreateSkillProposal()` é chamado dentro de `recordPattern()`. Se threshold é atingido, skill é criada automaticamente com status `proposed`. Sem revisão humana.
3. **Skill definitions hardcoded em português** — `skillDefs` contém prompts em português hardcoded. Se o usuário interage em inglês, skills ainda geram prompts em pt-BR.
4. **`observe()` method** — Registra eventos como `event:${event}` com `tool_name: 'system'`. Isso polui a tabela `skill_patterns` com dados que não são patterns de ferramenta.
5. **Confidence calculation** — `computeConfidence` usa `sampleWeight = Math.min(1, total / 5)`. Com apenas 1-2 amostras, confidence é muito baixo (0-0.4). Threshold de 0.6 exige 3+ sucessos. Inviável para skills novas.
6. **Sem garbage collection** — `skill_patterns` cresce indefinidamente. Patterns com `success_count: 0` nunca são limpos.

---

## 24. EXECUTION TRACE — Rastreabilidade

### Responsabilidades
- Registra cada step do raciocínio: decision, tool_call, tool_result, llm_call, llm_response, error, final
- EventEmitter para dashboard SSE
- Estatísticas: total, avg duration, by status, by provider
- Buffer circular de 50 traces recentes

### Qualidade: **Média-Alta** — Observabilidade básica mas funcional

### Problemas
1. **Buffer de 50 traces** — `maxRecent = 50`. Em produção com alto volume, traces recentes são perdidos rapidamente. Sem persistência.
2. **Sem correlation ID** — Traces não são vinculados a session IDs de forma observável. O `sessionId` existe mas não é propagado para logs externos.
3. **`addStep` aceita `data: Record<string, any>`** — Qualquer dado pode ser adicionado a um step. Sem schema, sem validação. Se logs são exportados, formatos inconsistentes.
4. **EventEmitter sem limit** — Se dashboard não consome eventos, EventEmitter acumula listeners. Sem cleanup.

---

## 25. PROVIDER FACTORY — Troca Dinâmica de LLMs

### Responsabilidades
- Gerenciamento de múltiplos providers: Gemini, DeepSeek, Groq, Ollama
- Streaming com chunk extraction universal
- Fallback chain com structured results
- Separate queues: classification (fast) vs generation (long)
- Metrics tracking

### Qualidade: **Alta** — Design robusto com fallback e streaming universal

### Padrões Positivos
- **`extractChunkText` universal** — Suporta Ollama, OpenAI, Anthropic, Gemini formats
- **`isChunkActive`** — Detecta qualquer atividade de streaming (não apenas content)
- **Fallback estruturado** — `LLMResult` com `attempts[]`, `fallbackReason`, status
- **Queue separada** — Classification não bloqueia generation

### Problemas
1. **API key exposta em URL** — `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}` — API key na URL é visível em logs, browser history, e proxies.
2. **Singleton pattern** — `let defaultInstance: ProviderFactory | null = null` — Instância global compartilhada. Sem injeção de dependência.
3. **`chatWithFallback` é sequencial** — Tenta providers um por um. Sem parallel racing (competitive routing).
4. **Sem retry com backoff** — Se um provider falha, tenta o próximo mas não retenta o mesmo provider. Falhas transitórias (network, rate limit) não são tratadas.
5. **Metrics são in-memory** — `metrics` Map não é persistido. Em restart, histórico de latência e sucesso é perdido.

---

## SUMÁRIO DE PROBLEMAS CRÍTICOS

| # | Componente | Problema | Severidade |
|---|-----------|----------|------------|
| 1 | ChannelAdapter | `rawContext: any` vaza implementação interna do canal | HIGH |
| 2 | TelegramAdapter | `metadata.botToken` propagado em cada mensagem | HIGH |
| 3 | SignalAdapter | Webhook sem autenticação | CRITICAL |
| 4 | SignalAdapter | Receive loop sem graceful shutdown | MEDIUM |
| 5 | SessionManager | `getDatabase()` leak para ContextBuilder | HIGH |
| 6 | SessionLearner | Upsert direto sem MemoryGovernor | MEDIUM |
| 7 | ContextBuilder | Queries SQL diretas via `memory.getDatabase()` | HIGH |
| 8 | ContextBudget | Safety check quebra ordem de mensagens | MEDIUM |
| 9 | CognitiveWorkspace | Distillation bloqueante sem snapshot | MEDIUM |
| 10 | ProviderFactory | API key na URL do Gemini | HIGH |
| 11 | ModelRouter | ProviderFactory tipado como `any` | LOW |
| 12 | SkillLearner | Pattern extraction hardcoded em pt-BR | MEDIUM |
| 13 | EventRanker | Sem integração com AttentionLayer | LOW |
| 14 | ObserverValidator | Custo duplicado de LLM, suggestedFix nunca usado | MEDIUM |
| 15 | ExecutionTrace | Buffer de 50 traces sem persistência | LOW |

---

## PADRÕES ARQUITETURAIS IDENTIFICADOS

### ✅ Padrões Bem Aplicados
1. **Adapter Pattern** — ChannelAdapter interface limpa e consistente
2. **Event Sourcing** — SessionTranscript com JSONL append-only
3. **Budget Pattern** — ContextBudget com prioridades e truncagem
4. **Governed Workspace** — CognitiveWorkspace com TTL, budget e distillation
5. **Mutex per Session** — Concorrência segura em SessionManager

### ⚠️ Padrões Problemáticos
1. **God Object** — MemoryManager vaza `getDatabase()` para 3+ componentes
2. **Stringly-Typed Routing** — `routeIntent.ts` com regex para classificação
3. **In-Memory Everything** — Cache, traces, patterns, metrics — tudo em memória
4. **Dual Compression** — ContextCompressor (deprecated) + ContextBudget coexistem
5. **Observability Gap** — Sem correlation IDs, sem distributed tracing

---

## RECOMENDAÇÕES PRIORITÁRIAS

### P0 — Correção Imediata
1. **Remover `metadata.botToken`** de NormalizedMessage — Token não deve sair do adapter
2. **Adicionar autenticação ao Signal webhook** — Qualquer um pode injetar mensagens
3. **Eliminar `getDatabase()` leak** — MemoryManager deve expor métodos `getNodeConnectivity()` e `getNodeRecency()` ao invés de dar acesso ao banco

### P1 — Melhoria Arquitetural
4. **Eliminar `rawContext: any`** — Substituir por `replyCallback: (response: NormalizedResponse) => Promise<void>` ou channel response interface
5. **Unificar compressão** — Remover ContextCompressor deprecated, usar apenas ContextBudget
6. **Adicionar correlation IDs** — UUID por mensagem, propagado por todo o pipeline
7. **Implementar backpressure no MessageBus** — Fila com prioridade e timeout

### P2 — Evolução
8. **SkillLearner: LLM-based pattern extraction** ao invés de regex hardcoded
9. **ModelRouter: feedback loop** — Rastrear acurácia de classificação
10. **ObserverValidator: remover ou restringir** — Usar apenas em modo debug, não em produção
11. **Session expiry** — TTL automático para sessões inativas
12. **Distributed tracing** — Propagar trace ID por todo o pipeline