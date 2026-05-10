# AUDIT PART 2 — Loop Subsystem (Arquitetural Deep Dive)

**Data:** 2026-05-09  
**Escopo:** 13 arquivos em `src/loop/`  
**Objetivo:** Análise arquitetural profunda — FSMs implícitos, gerenciamento de memória, higiene de raciocínio, violações de fronteira, acoplamento, responsabilidades mistas

---

## 1. AgentLoop.ts (918 linhas)

### O que FAZ vs o que AFIRMA fazer
- **Afirma:** "Atomic Cognition Pattern — unifica execução, validação, reavaliação e crítica em um único TURN"
- **Faz:** Orquestração completa do ciclo de vida de uma mensagem: roteamento de modelo, montagem de prompt, chamada LLM, parsing de resposta, execução de ferramentas (nativas e JSON), síntese final, rastreamento, métricas. É muito mais que um "loop atômico" — é um **God Object** que concentra 7+ responsabilidades.

### FSMs Implícitos
1. **Task FSM (linhas ~350-430):** Estado transita entre `tool_execution → synthesis → completion` com early exits:
   - `isFinalAnswer || isMarkedComplete || hasContentNoTool` → `COMPLETED`
   - `terminalTools (send_audio/document/image/video)` → `COMPLETED` (bypass síntese)
   - `toolFailureCount >= 2` → força síntese com limitação
   - `stepCount >= maxSteps` → `MAX_ITERATIONS` com fallback
   - `hasNoToolsRequested && finalText.length > 0` → `EARLY_EXIT`
2. **Response Extraction FSM:** `action.content → sanitizeContent → extractFinalText → fallback message`. Múltiplos caminhos de extração criam nondeterminismo na saída.
3. **Synthesis FSM:** Se `executedToolsInLastStep && !hasGoodContent` → síntese forçada. Se síntese falha → `lastBestContent`. Se nenhum conteúdo → fallback LLM final.

### Gerenciamento de Memória/Contexto
- **CognitiveWorkspace:** Resetado a cada `run()` — correto, mas significa que raciocínio multi-turn é perdido. Não há mecanismo de distilação entre turns.
- **loopMessages:** Cresce ilimitadamente dentro do while loop (máx 5 steps × 2-3 mensagens/step). Não há trimming ou budget enforcement dentro do loop.
- **metrics:** Array circular com `metricsMaxSize = 100` — OK, mas `getMetrics()` recalcula percentil toda chamada (O(n log n)).
- **classificationMemory/decisionMemory:** Escrita em cada execução, sem batch. Pode causar SQLite contention em alta concorrência.
- **usedToolInputs:** Set<string> — cresce por todo o ciclo mas nunca é limpo entre steps. Impede repetição intencional de ferramentas com parâmetros diferentes após a mesma ferramenta já ter sido chamada com parâmetros iguais (proteção correta contra loops infinitos).

### Higiene de Raciocínio
- **sanitizeContent() DUPLICADO:** Existe uma cópia local em AgentLoop (linhas ~50-120) e outra em ContentExtractor.ts. São **idênticas** exceto que AgentLoop adiciona patterns extras (`<thinking>`, emoji de raciocínio 🤔💭, "Let me..." self-talk). Isso é uma violação DRY séria — qualquer correção precisa ser feita em dois lugares.
- **parseLLMResponse() DUPLICADO:** Existe em AgentLoop e em ContentExtractor.ts com lógica diferente. O de AgentLoop faz regex fallback, o de ContentExtractor faz fence match + embedded JSON. Divergência silenciosa.
- **Thinking leak:** O CognitiveWorkspace preserva `response.thinking`, mas não há garantia de que esse conteúdo não vaze para a resposta final. A sanitização remove tags `<think>` mas não remove o raciocínio que o modelo pode ter embutido no `content` sem tags.

### Violações de Fronteira
- **Acesso direto ao MemoryManager.getDatabase():** `this.skillLearner = new SkillLearner(db)` — passa o database SQLite raw para SkillLearner, violando encapsulamento de MemoryManager.
- **Channel context leak:** `(tool as any).setContext()` — cast para `any` para injetar contexto do Telegram em ferramentas. Acoplamento temporário com canal específico.
- **require() dinâmico:** `const { extractText } = require('./ResponseAdapter')` dentro do método de síntese — import preguiçoso que pode falhar em runtime e não é verificado em compile-time.

### Acoplamento
- **Alto:** Depende de ProviderFactory, MemoryManager, CognitiveWorkspace, ContextBuilder, ContextBudget, ResponseBuilder, SessionContext, ModelRouter, SkillLearner, AgentStateManager, ClassificationMemory, DecisionMemory, ExecutionTrace — **13 dependências diretas**.
- **llmQueue global:** `const llmQueue = new PQueue({ concurrency: 1 })` — singleton global que serializa TODAS as chamadas LLM. Bottleneck em multi-sessão.

### Responsabilidades Mistas
1. Roteamento de modelo (deveria ser externo)
2. Montagem de prompt (deveria ser PromptBuilder dedicado)
3. Parsing de resposta (deveria ser exclusivo de ResponseAdapter/ContentExtractor)
4. Execução de ferramentas (deveria ser ToolExecutor dedicado)
5. Síntese pós-execução (deveria ser Synthesizer dedicado)
6. Rastreamento/métricas (deveria ser decorator/middleware)
7. Prompt de sistema hardcoded (PROMPT_COMPONENTS — 200+ linhas de texto em constante)

### Risco Emergente
- O `llmQueue` com concurrency=1 significa que se duas sessões concurrently chamam o LLM, uma espera a outra. Em produção multi-usuário, isso é um **serializador global** que degrada latência linearmente com o número de sessões ativas.

---

## 2. ContextBuilder.ts

### O que FAZ
- Seleciona nós de memória semântica relevantes à query usando ranking ponderado (similaridade × 0.6 + conectividade × 0.25 + recência × 0.15).
- **Relevance Gate:** Filtra saudações/mensagens sociais para não injetar contexto obsoleto.

### FSMs Implícitos
- **Relevance Gate:** `isSocialOrGreeting()` → retorna string vazia (sem contexto) ou prossegue com ranking. Simples e correto.

### Gerenciamento de Memória
- Acessa `this.memory.getDatabase()` diretamente para queries de conectividade e recência — **violação de encapsulamento** do MemoryManager.
- `semanticSearchWithAttention` com fallback para `semanticSearch` — resiliente, mas se ambos falharem, retorna array vazio silenciosamente.
- `compactContent()` trunca em 200 chars com heurística de período — aceitável, mas pode cortar contexto importante.

### Acoplamento
- Depende de MemoryManager (forte — acesso direto ao DB).
- Usado por SessionContext e AgentLoop.

### Higiene de Raciocínio
- **Score de conectividade:** `degree / 10` — hardcode do divisor. Nenhum nó terá score 1.0 sem 10+ edges. Isso penaliza nós isolados mesmo que sejam altamente relevantes.
- **Recência:** Heurística fixa (1h=1.0, 24h=0.7, 7d=0.3, 30d+=0.1). Não considera a natureza do nó (fatos permanentes vs eventos temporais).

---

## 3. ContextBudget.ts

### O que FAZ
- Monta mensagens de contexto com orçamento de tokens por bloco: system(1500), state(500), memory(1000), history(2000), skills(500).
- Trunca blocos que excedem seu orçamento.
- Safety check final: se total > maxInputTokens, remove blocos de menor prioridade.

### FSMs Implícitos
- **Budget allocation FSM:** Ordem fixa de prioridade: system(10) > user(9) > state(8) > checkpoint(7) > memory(6) > skills(5) > history(3). Quando overflow, blocos de baixa prioridade são truncados primeiro.

### Gerenciamento de Memória
- **estimateTokens():** Heurística `charsPerToken = 3 + (1 - codeRatio) × 0.5`. Código é estimado em ~3 chars/token, texto em ~3.5 chars/token. Precisão ≈85% para texto, ≈70% para código. Aceitável para orçamento, mas pode subestimar código significativamente.
- **truncateToTokens():** Corta em `maxTokens × 3.5` chars, depois busca último período/newline. Pode resultar em truncamento agressivo se o texto for denso em código.
- **History budget:** Máximo 6 mensagens × 1500 chars = ~9000 chars ≈ ~2600 tokens. Mas o orçamento é de 2000 tokens, então na prática serão ~4 mensações de tamanho médio.

### Violações de Fronteira
- Nenhuma. Bem encapsulado, pura função de construção.

### Risco Emergente
- **Re-sorting bug:** Quando há overflow, o código ordena por prioridade descendente, trunca, depois re-ordena por role. Mas a re-ordenação final ordena `system(0) > user(1) > assistant(2)`, o que coloca system messages ANTES de user (correto para LLMs), mas pode quebrar a ordem relativa entre blocos system de mesma role (ex: state antes de memory).

---

## 4. ContextCompressor.ts

### O que FAZ vs o que AFIRMA
- **Afirma:** "DEPRECATED — Compression is now handled by SessionManager.maybeCompress()"
- **Faz:** Ainda funciona! Compressão por summarização LLM: mantém system + últimas 4 mensagens, resume o resto com chamada LLM. Útil como fallback quando SessionManager falha.

### FSMs Implícitos
- **Compress decision:** `totalChars > MAX_CONTEXT_CHARS (12000) && messages.length > 4` → compress. Caso contrário, retorna inalterado.

### Gerenciamento de Memória
- `MAX_CONTEXT_CHARS = 12000` — hardcode que não respeita o ContextBudget. Os dois sistemas operam com limites diferentes (chars vs tokens).
- **Summarization prompt:** Fixo em pt-BR, 200 palavras máximo. Sem budget enforcement na resposta do LLM.

### Acoplamento
- Depende de ProviderFactory (para chamada LLM) e de ResponseAdapter.extractText (import).

### Higiene de Raciocínio
- **Risco de alucinação:** O prompt de sumarização pede "resuma a conversa", mas não fornece critérios de o que é importante preservar (decisões, fatos, ações). O resumo pode perder informações críticas.

---

## 5. ContextValidator.ts

### O que FAZ
- Avalia qualidade e confiabilidade do contexto antes de passar ao LLM.
- Retorna `quality` (0-1), `hasConflict` (boolean), `recommendation` (assertive/neutral/cautious).

### FSMs Implícitos
- **Quality FSM:** `quality -= penalties` → resultado em [0,1]. Thresholds: assertive > 0.8, neutral 0.5-0.8, cautious < 0.5.

### Problemas
- **Conflict detection ingênua:** Verifica se linhas com `:` no contexto têm o mesmo subject com valores diferentes. Isso funciona apenas para contextos estruturados como `subject: value`. Não detecta contradições semânticas.
- **Drift/stability thresholds hardcoded:** `drift_risk > 0.8`, `stability < 0.3`. Não são configuráveis.
- **Quality penalties mágicos:** `-0.3` para contexto curto, `-0.1` para contexto médio, `-0.2` para drift alto, `-0.1` para estabilidade baixa. Sem justificativa empírica.

### Higiene de Raciocínio
- Este módulo é usado por DecisionPostProcessor para modular a resposta. Se o validator estiver errado (ex: falso conflito), a modulação será incorreta. É um **single point of failure** na cadeia de confiança.

---

## 6. ContentExtractor.ts

### O que FAZ
- **sanitizeContent():** Remove artefatos técnicos do output LLM (think tags, tool call leaks, JSON wrappers, code fences, system prompt leaks).
- **parseLLMResponse():** Extrai dados estruturados (action, thought, evaluation) de output JSON do LLM.
- **extractText():** Extração lightweight de texto de qualquer resposta LLM.

### FSMs Implícitos
- **Sanitization pipeline:** `think tags → bold markers → JSON extraction → code fence removal → system prompt leak removal → action/evaluation/thought JSON removal`. Ordem importa — remoção prematura de JSON pode quebrar extração posterior.

### Duplicação com AgentLoop
- **sanitizeContent()** é idêntica à versão em AgentLoop exceto pelos patterns extras no AgentLoop (`<thinking>`, emoji, "Let me..." self-talk). Isso é um **bug de consistência** — se um novo pattern de leak for descoberto, precisa ser corrigido em dois lugares.
- **parseLLMResponse()** tem lógica diferente da versão em AgentLoop. O de ContentExtractor faz fence match + embedded JSON, o de AgentLoop faz regex + fallback de content field. **Comportamento divergente** para o mesmo input.

### Higiene de Raciocínio
- **System prompt leak removal:** `result.replace(/^Você é o núcleo cognitivo[\s\S]*?(?=\n\n|\n[A-Z])/i, '')` — regex frágil que depende do texto exato do prompt. Se o prompt mudar, a proteção quebra silenciosamente.
- **Thought leak removal:** Remove `"thought": "..."` mas não remove thinking em formato não-JSON. Modelos que "pensam em voz alta" sem tags estruturadas vazam raciocínio.

---

## 7. DecisionPostProcessor.ts

### O que FAZ
- Modula a resposta do LLM com base no estado cognitivo e na validação de contexto.
- Nunca reescreve completamente — apenas ajusta tom e proatividade.

### FSMs Implícitos
- **Modulation FSM:** 
  - `recommendation === 'cautious' && !isAlreadySoftened` → suaviza afirmações + adiciona prefixo
  - `stability < 0.4` → remove sugestões proativas
  - `drift_risk > 0.8 && !modulated.includes('?')` → adiciona "Fez sentido?"
  - `confidence < 0.2 && !isAlreadySoftened` → adiciona nota de confiança reduzida

### Problemas
- **maxChanges = 2:** Limita a 2 modificações por resposta, mas a contagem é incremental (`changeCount++`). Se a primeira modificação (regex replace) não mudar nada, `changeCount` não incrementa, mas se mudar, conta. Lógica correta mas confusa.
- **Regex de suavização:** `replace(/Certamente,|Com certeza,|Garanto que/g, 'Pode ser que')` — apenas 3 patterns em pt-BR. Modelos podem usar sinônimos não cobertos.
- **Proatividade removal:** `replace(/Além disso, (posso|poderia).*|Também posso.*|Que tal se.*/gi, '')` — regex greedy que pode remover sentenças inteiras, incluindo conteúdo útil.
- **"Fez sentido?"** adicionado quando drift_risk > 0.8 — isso é um **prompt injection reverso**: o agente está modificando sua própria resposta com base em métricas internas que o usuário não vê.

### Higiene de Raciocínio
- A modulação é **stateless** — não considera histórico de modulações anteriores. Se o agente já adicionou "Pode ser que" em uma interação anterior, não há memória disso. Potencial para modulação cumulativa em conversas longas.

---

## 8. ModelRouter.ts

### O que FAZ
- Roteamento inteligente de modelos: classificação determinística primeiro (instantâneo), LLM fallback para casos ambíguos.
- Categorias: chat, code, vision, light, analysis, execution.

### FSMs Implícitos
- **Routing FSM:**
  1. `fallbackClassify(query)` → se categoria ≠ 'chat', usa determinístico (0ms)
  2. Se 'chat' (ambíguo), tenta `llmClassify(query)` com timeout de 30s
  3. Se LLM falha, volta para `fallbackClassify`
  4. Se nada funciona, retorna perfil 'chat' default

### Gerenciamento de Memória
- **classificationCache:** `Map<string, { category, timestamp }>` com TTL de 5 minutos. Sem limite de tamanho — **memory leak potencial** em execução longa.
- **usageLog:** `Map<string, number>` sem limite — cresce indefinidamente.

### Acoplamento
- **ProviderFactory:** Recebido via construtor como `any` (evita dependência circular). Mas `llmClassify()` faz cast para `(this as any).providerFactory as ProviderFactory` — type safety completamente quebrado.
- **Fallback fetch:** Se ProviderFactory não está disponível, faz `fetch()` direto para o servidor Ollama — bypass completo de ProviderFactory, sem rate limiting, sem queue, sem retry, sem logging de métricas.

### Higiene de Raciocínio
- **Prompt de classificação:** Multilíngue mas focado em pt-BR. Pode classificar incorretamente queries em inglês que parecem código (ex: "create a new feature").
- **Deterministic rules:** `keywords` e `patterns` são hardcode. Se o modelo muda (ex: novo modelo melhor em código), as regras não se adaptam.

---

## 9. ResponseAdapter.ts

### O que FAZ
- Normalização de resposta LLM em estrutura tipada (`NormalizedResponse`).
- Extração lightweight de texto (`extractText`).
- Pipeline: `raw → sanitizeContent → parseLLMResponse → normalizeResponse`.

### FSMs Implícitos
- **Normalization FSM:**
  1. Se parsed JSON tem `action.type === 'tool'` → tipo 'tool' com toolName/toolInput
  2. Se parsed JSON tem `action.type === 'final_answer'` ou `action.content` → tipo 'final_answer'
  3. Se rawContent não vazio → tipo 'final_answer' com conteúdo raw
  4. Caso contrário → tipo 'empty'

### Problemas
- **Três caminhos de extração de texto:** `normalizeResponse`, `extractText`, e `sanitizeContent`. Cada um com lógica diferente. Em AgentLoop, a extração final usa `extractFinalText()` que chama `normalizeFromRaw()`, que chama `normalizeResponse()` que chama `parseLLMResponse()`. Mas também há `parseLLMResponse()` local e `sanitizeContent()` local. **Seis funções diferentes** envolvidas na extração de texto de uma resposta LLM.

### Higiene de Raciocínio
- **evaluate extraction:** `evaluation.confidence` é mapeado como `low | medium | high`, mas o LLM pode retornar qualquer string. Não há validação ou default explícito para strings inesperadas.

---

## 10. ResponseBuilder.ts

### O que FAZ
- Formata resultados de ferramentas em mensagens amigáveis SEM chamar o LLM novamente.
- Cases: file_ops, memory_search, memory_write, memory_admin, exec_command.
- Retorna `null` para ferramentas desconhecidas (sinaliza que precisa de LLM).

### FSMs Implícitos
- **Output formatting FSM:** Para cada tool, formato fixo. Para `write`/`edit`: sucesso ou truncamento. Para `memory_search`: truncamento em 1000 chars. Para `exec_command`: truncamento em 1500 chars.

### Problemas
- **Hardcoded truncation:** Valores mágicos (1500, 1000 chars) sem configuração.
- **Error detection por substring:** `error.includes('não encontrado')`, `error.includes('obrigatório')` — frágil, depende de mensagens de erro em pt-BR específicas.
- **Retorna null para tools desconhecidos:** Mas em AgentLoop, `null` nunca é tratado — se ResponseBuilder retorna null, o resultado cai no fluxo de síntese LLM. Fluxo correto, mas não documentado.

---

## 11. routeIntent.ts

### O que FAZ
- Roteamento determinístico de intenções: mapeia texto do usuário para ações (tool, llm, compound, audio_request).
- Sem LLM — puramente regex/keyword matching.

### FSMs Implícitos
- **Intent routing FSM (ordem importa!):**
  1. Small talk → 'llm'
  2. Audio/TTS → 'audio_request' ou 'compound' (se precisa de dados)
  3. Memory write → 'tool: memory_write'
  4. Memory search → 'tool: memory_search'
  5. Crypto → 'tool: web_search'
  6. Web search → 'tool: web_search'
  7. Shell commands → 'tool: exec_command'
  8. File create → 'tool: write'
  9. File read → 'tool: read'
  10. File edit → 'tool: edit'
  11. Default → 'llm'

### Problemas
- **ORDEM IMPORTA:** Se um usuário disser "guarde o preço do bitcoin", a intenção será classificada como 'memory_write' (match #3) e NUNCA chegará em 'crypto' (match #5). Isso pode ser intencional (memória tem prioridade), mas é frágil.
- **Audio request regex:** `/(por favor\s*)?(me\s*)?(gerar?\s*(um|uma)?\s*(áudio|audio|voz)|...)/i` — regex complexa que pode falhar com variação natural de linguagem.
- **Params genéricos:** Para `write`, params são `{ path: './workspace/sites/', content: '' }` — path hardcoded e content vazio. O LLM precisa preencher isso depois, mas o intent router não valida isso.
- **Sobreposição com ModelRouter e SkillLearner:** Três sistemas fazem classificação de intenção com lógica diferente e sem coordenação. routeIntent é determinístico, ModelRouter é híbrido, SkillLearner é estatístico.

---

## 12. ObserverValidator.ts

### O que FAZ
- Validação pós-execução via LLM: após executar uma ferramenta, um modelo observador (qwen3.5:cloud) avalia se a ação foi correta.
- Retorna `approved`, `reason`, `confidence`, `suggestedFix`.

### FSMs Implícitos
- **Validation FSM:**
  1. Envia prompt ao modelo observador
  2. Se JSON parseado com sucesso → retorna resultado
  3. Se JSON não encontrado → assume aprovado (confidence 0.5)
  4. Se erro → assume aprovado (confidence 0.3)

### Problemas
- **Custo adicional:** Toda validação requer uma chamada LLM extra. Em produção, isso DOBRA o custo e latência de interações com ferramentas.
- **Auto-aprovação em falha:** Se o observador falha, assume aprovado. Isso é um **escape hatch perigoso** — invalida o propósito do observador.
- **Truncamento de input:** `userMessage.slice(0, 500)`, `toolResult.slice(0, 1000)`, `finalResponse.slice(0, 500)` — pode cortar contexto crítico para validação.
- **JSON extraction frágil:** `content.match(/\{[^}]*"approved"[^}]*\}/s)` — não funciona para JSON aninhado com `}` dentro de strings. RegEx não é parser de JSON.

### Higiene de Raciocínio
- **NÃO É USADO EM AGENTLOOP!** Apesar de existir, o ObserverValidator não é chamado em nenhum lugar do loop principal. É um ** módulo órfão** — infraestrutura de validação que nunca é executada.

---

## 13. SkillLearner.ts

### O que FAZ
- Aprendizado procedural automático: registra padrões de uso de ferramentas, propõe skills baseadas em padrões repetidos, e fornece contexto de skills ao prompt do sistema.
- Estágio 2: gera propostas, mas apenas skills aprovadas ('active') são usadas em runtime.

### FSMs Implícitos
- **Skill lifecycle FSM:** `proposed → active | rejected`
  - `recordPattern()` → acumula estatísticas
  - `tryCreateSkillProposal()` → se padrão atinge threshold, cria skill 'proposed'
  - `approveSkill()` → muda para 'active'
  - `rejectSkill()` → muda para 'rejected'
- **Match FSM:** `matchSkill()` → busca na DB → se confiança ≥ threshold → retorna skill → `bumpSkillHit()`

### Gerenciamento de Memória
- **Duas tabelas SQLite:** `auto_skills` (skills) e `skill_patterns` (padrões). Sem foreign key entre elas.
- **`recordPattern()`** faz UPSERT manual (SELECT → UPDATE ou INSERT) — deveria usar `INSERT ... ON CONFLICT DO UPDATE` (SQLite suporta).
- **`tryCreateSkillProposal()`** é chamado a CADA `recordPattern()`. Faz 2 queries (count + avg) + INSERT para cada registro. Em alta frequência, isso é **N+1 queries por interação**.

### Acoplamento
- Recebe `Database` raw via construtor — mesmo problema de violação de encapsulamento que AgentLoop.
- `observe()` método genérico para eventos do sistema — mas nunca é chamado por nenhum outro módulo.

### Higiene de Raciocínio
- **Pattern extraction:** `extractPattern()` usa regex hardcode para classificar input. Os mesmos patterns que routeIntent.ts e ModelRouter.ts usam — **tripla duplicação de lógica de classificação**.
- **Confidence computation:** `computeConfidence()` usa fórmula `successRate × sampleWeight + successRate × (1 - sampleWeight) - latencyPenalty`. Isso simplifica para `successRate - latencyPenalty`. O `sampleWeight` é redundante — não altera o resultado final.
- **Skill proposals hardcode:** Os seeds de skill (crypto_price, weather, etc.) são fixos no código. Não são gerados automaticamente — são templates predefinidos disfarçados de aprendizado.

### Risco Emergente
- **Skill contamination:** Qualquer input do usuário é registrado como pattern. Se o usuário enviar spam ou mensagens maliciosas, os patterns serão corrompidos. Não há sanity check no input antes de registrar.

---

## Resumo Executivo — Problemas Arquiteturais Críticos

### 🔴 Crítico (Deve corrigir antes de escalar)

| # | Problema | Arquivos | Impacto |
|---|----------|----------|---------|
| 1 | **God Object AgentLoop** — 7+ responsabilidades, 13 dependências, 918 linhas | AgentLoop.ts | Manutenção zero, qualquer mudança quebra algo |
| 2 | **Triplicação de classificação** — routeIntent, ModelRouter, SkillLearner fazem o mesmo com lógica diferente | routeIntent.ts, ModelRouter.ts, SkillLearner.ts | Comportamento inconsistente, manutenção 3x |
| 3 | **Duplicação de sanitização** — sanitizeContent() em AgentLoop e ContentExtractor são idênticas exceto por extras | AgentLoop.ts, ContentExtractor.ts | Bug de consistência, correções em dois lugares |
| 4 | **Duplicação de parsing** — parseLLMResponse() em AgentLoop e ContentExtractor têm lógica diferente | AgentLoop.ts, ContentExtractor.ts | Comportamento divergente silencioso |
| 5 | **llmQueue global concurrency=1** — serializa todas as chamadas LLM | AgentLoop.ts | Bottleneck em multi-sessão |
| 6 | **Memory leak em ModelRouter** — classificationCache e usageLog sem limite | ModelRouter.ts | OOM em execução longa |
| 7 | **ObserverValidator órfão** — nunca é chamado, infraestrutura morta | ObserverValidator.ts | Custo de manutenção sem benefício |

### 🟡 Moderado (Corrigir na próxima iteração)

| # | Problema | Arquivos | Impacto |
|---|----------|----------|---------|
| 8 | **Violação de encapsulamento** — `memory.getDatabase()` passado como raw DB | AgentLoop, ContextBuilder, SkillLearner | Acoplamento com schema SQLite |
| 9 | **Orçamentos inconsistentes** — ContextCompressor usa chars (12000), ContextBudget usa tokens | ContextCompressor.ts, ContextBudget.ts | Compressão pode conflitar com budget |
| 10 | **DecisionPostProcessor stateless** — não considera histórico de modulações | DecisionPostProcessor.ts | Modulação cumulativa em conversas longas |
| 11 | **ContextValidator conflict detection ingênuo** — só detecta conflitos em `key: value` | ContextValidator.ts | Falsos negativos em conflitos semânticos |
| 12 | **RouteIntent ordem-dependente** — primeiro match ganha, sem priorização semântica | routeIntent.ts | Intenções compostas (ex: "guarde preço do bitcoin") sempre perdem a segunda intenção |
| 13 | **SkillLearner N+1 queries** — recordPattern faz múltiplas queries por interação | SkillLearner.ts | Degradção de performance em alta frequência |
| 14 | **Dynamic require()** em AgentLoop — `require('./ResponseAdapter')` dentro de método | AgentLoop.ts | Pode falhar em runtime, não é verificado em compile-time |

### 🟢 Baixo (Monitorar)

| # | Problema | Arquivos | Impacto |
|---|----------|----------|---------|
| 15 | **Metrics recalculation** — getMetrics() recalcula percentile toda chamada | AgentLoop.ts | Performance degradada se chamado frequentemente |
| 16 | **Hardcoded truncation values** — ResponseBuilder usa mágicos 1000, 1500 | ResponseBuilder.ts | Inflexível para diferentes contextos |
| 17 | **ModelRouter fallback fetch** — bypass de ProviderFactory | ModelRouter.ts | Sem rate limiting, métricas, ou retry |
| 18 | **SkillLearner hardcoded seeds** — templates fixos disfarçados de aprendizado | SkillLearner.ts | Falsa autonomia |
| 19 | **ContextBudget re-sort bug** — overflow handling pode quebrar ordem relativa entre system blocks | ContextBudget.ts | Contexto pode chegar desordenado ao LLM |
| 20 | **RouteIntent hardcoded paths** — `'./workspace/sites/'` para write | routeIntent.ts | Inflexível, pode não existir |

---

## Diagrama de Dependências do Loop

```
AgentLoop (God Object)
├── ProviderFactory ──────── LLM calls, fallback, metrics
├── MemoryManager ────────── getDatabase() leak
├── CognitiveWorkspace ────── working memory (per-turn)
├── ContextBuilder ────────── semantic context (leaks DB access)
│   └── MemoryManager ────── semantic search
├── ContextBudget ─────────── token budgeting (clean)
├── ResponseBuilder ───────── direct tool formatting (clean)
├── SessionContext ────────── session pipeline
│   ├── SessionManager ────── transcripts, checkpoints
│   └── ContextBuilder ────── (shared with AgentLoop)
├── ModelRouter ───────────── model routing
│   └── ProviderFactory ──── (circular via `any`)
├── SkillLearner ──────────── pattern learning (leaks DB)
├── AgentStateManager ─────── cognitive state
├── DecisionPostProcessor ─── response modulation
├── ContextValidator ──────── quality assessment
├── ObserverValidator ─────── (ORPHAN — never called)
├── ClassificationMemory ─── classification persistence
└── DecisionMemory ────────── decision persistence

routeIntent ────────────────── (standalone, no dependencies)
```

---

## Classificação de AI OS Readiness

| Arquivo | Responsabilidade Única | FSM Explícito | Memória Higiene | Boundary Safe | Score |
|---------|----------------------|---------------|-----------------|---------------|-------|
| AgentLoop.ts | ❌ (7+ responsibilities) | ❌ (implicit, complex) | ⚠️ (workspace OK, metrics OK, context unbounded) | ❌ (leaks DB, channel context) | 2/10 |
| ContextBuilder.ts | ✅ | ✅ (simple gate) | ❌ (leaks DB) | ⚠️ (MemoryManager coupling) | 6/10 |
| ContextBudget.ts | ✅ | ✅ (priority-based) | ✅ (bounded) | ✅ | 9/10 |
| ContextCompressor.ts | ⚠️ (deprecated but active) | ✅ (simple) | ⚠️ (hardcoded limits) | ✅ | 5/10 |
| ContextValidator.ts | ✅ | ✅ (quality FSM) | ✅ | ✅ | 6/10 |
| ContentExtractor.ts | ✅ | ✅ (pipeline) | ✅ | ✅ (no external deps) | 7/10 |
| DecisionPostProcessor.ts | ✅ | ✅ (modulation FSM) | ⚠️ (stateless modulation) | ✅ | 6/10 |
| ModelRouter.ts | ⚠️ (routing + classification) | ✅ (routing FSM) | ❌ (memory leak) | ❌ (ProviderFactory bypass) | 4/10 |
| ResponseAdapter.ts | ✅ | ✅ (normalization FSM) | ✅ | ✅ | 8/10 |
| ResponseBuilder.ts | ✅ | ✅ (formatting) | ⚠️ (hardcoded truncation) | ✅ | 7/10 |
| routeIntent.ts | ✅ | ✅ (priority routing) | ✅ | ✅ | 6/10 |
| ObserverValidator.ts | ✅ | ✅ (validation FSM) | ✅ | ✅ | 7/10* |
| SkillLearner.ts | ⚠️ (learning + matching + persistence) | ✅ (lifecycle FSM) | ❌ (N+1 queries) | ❌ (leaks DB) | 4/10 |

*ObserverValidator: 7/10 estrutural, mas 0/10 em utilização (nunca chamado)

**Média Loop:** 5.4/10

---

## Recomendações Prioritárias

1. **Desmembrar AgentLoop** em: PromptBuilder, ToolOrchestrator, ResponseExtractor, LoopController, MetricsCollector
2. **Unificar classificação** em um único IntentClassifier que routeIntent, ModelRouter e SkillLearner usam
3. **Eliminar duplicação** — uma única sanitizeContent() e parseLLMResponse() em ContentExtractor, importadas por todos
4. **Remover ObserverValidator** ou integrá-lo no loop principal
5. **Adicionar limite** ao classificationCache e usageLog do ModelRouter (LRU eviction)
6. **Substituir llmQueue global** por semáforo por provider em ProviderFactory
7. **Encapsular acesso ao DB** — MemoryManager deve expor métodos, não `getDatabase()`
8. **Unificar orçamento** — ContextCompressor deve usar ContextBudget, não chars hardcoded