# Investigação em lote — "analisar as aulas dadas e propor mais uma aula" (incidente de 23/09/2026)

Data do relatório: 2026-09-24 · Status: **relatório de investigação (Fase 1)** · Código: nenhuma
alteração nesta campanha (as correções S294–S298 já existiam; ver §E) · Decisões arquiteturais: **PENDENTES**

**Fontes primárias lidas diretamente (não o relatório anterior):** `C:\Users\lucia\NewClaw\logs\newclaw-audit.log`
(24,8 MB, completo), banco de mensagens de produção (cópia somente leitura), código em `D:\IA\newclaw`,
GitHub Security via `gh api`. **Aviso de fonte:** o arquivo `C:\Users\lucia\Downloads\prompt.txt` contém o
briefing desta campanha (é reescrito a cada rodada), **não a conversa**; a conversa foi reconstruída do
banco de mensagens de produção e do log (`[USER-MESSAGE]`, `message_received`).

---

## A. Objetivo original do usuário

Pedido único, idêntico em 5 conversas (6 envios): *"Poderia analisar as aulas dadas e propor mais uma
aula? Em: `<pasta local das aulas de MS Excel Operações Essenciais>`"*. **Intenção reconstruída do
contexto completo:** ler o material já ministrado (a pasta contém 2 apresentações `.pptx` e os 2 PDFs correspondentes, 2 documentos `.docx` — uma lista de
exercícios e o conteúdo programático —, 3 planilhas `.xlsx` e uma subpasta), entender a progressão
e **entregar uma proposta da próxima aula**. O usuário não especificou formato de entrega; nunca
respondeu, esclareceu ou corrigiu (um único turno por conversa).

## B. Resultado real

**0 de 6 execuções em produção concluíram** (todas em 23/09). O usuário recebeu:

| Hora | Conversa | O que recebeu |
|---|---|---|
| 18:43 | `conv_…759619` | "Erro ao processar sua mensagem." (31 caracteres) |
| 19:16 | `conv_…765780` | "Não consegui completar…" + "Informações coletadas" com trechos de memória truncados no meio da palavra (incluindo um nó `HEARTBEAT` sem relação) |
| 20:56 | `conv_…765780` | "Não consegui completar… `python: can't open file '…\workspace\extrator_aulas_v2.py'`" |
| 21:51 | `conv_…003157` | "O script está íntegro — apenas executei com o workdir errado. Executando agora com o caminho absoluto correto:" (**promessa sem execução**, 110 caracteres) |
| 22:47 | `conv_…460023` | Mensagem de entrada **duplicada/corrompida** (artefato do meu teste no navegador, digitação dupla) e cancelada pelo usuário — **não é falha do produto** |
| 23:15 | `conv_…566559` | "Não consegui completar… tentou memory_search, exec_command, read" + fragmentos truncados |

Reprodução em instância isolada (24/09, mesmo pedido, mesmo commit): **sucesso 2 de 3** (flash: sucesso em 28,7 min;
`glm-5.3:cloud`: falha após 5 replans; `glm-5.3:cloud` instrumentado: sucesso em 14,5 min). O objetivo
**é atingível, mas não de forma determinística**.

## C. Linha do tempo (log de produção; hora local; código em execução entre parênteses)

Reinícios do processo e commits do dia determinam a versão de código de cada tentativa: 18:55 (base `e364946`),
20:28 (+S294, S295), 21:49 (+S296, S297), 22:47 (+S298).

**18:43 — sem provider (código base).** 18:14 Ollama iniciou e **se fechou às 18:15** (atualização silenciosa falhou com
"Acesso negado"). 18:43:08 pedido → `fetch failed` em 4–16 ms (×6) → 18:43:31 `Circuit CLOSED → OPEN` →
18:43:43 `ALL_PROVIDERS_CIRCUIT_OPEN` → `[FALLBACK] Provider error at step 1: undefined` → resposta de 31 chars.

**18:59 — goal `…3iqi2` (código base; 992 s).** 18:59:39 `route=goal_orchestrator`; 19:00:42 plano com pelo menos 5 passos (inclui
`send_document` e um passo que registra na memória com `memory_write`); 19:01:53 passo 1 `memory_search` **promovido por "6/13 termos-chave"**; 19:03:33 primeiro
`SEMANTIC-MISMATCH` (saída do `agentloop` = "aviso intermediário"); 19:03:01 e 19:04:03 `context_growth` de 2,6× e 4,9×; 19:06:44 Grounding
`REJECTED`; 19:07:09 blocker → replan 1 (passo `memory_write` que o usuário nunca pediu); 19:09:19 `memory_search` devolve
posições de criptomoedas → mismatch → replan 2; 19:10:49 `read` em pasta fora do sandbox → `tool_error` → replan 3 ("abandonar o
read do caminho externo"); 19:13:38 e 19:16:12 mismatch → **12 ciclos, 3 replans, `failed`**.

**20:29 — goal `…qze7w` (+S294/S295; 1 566 s).** 20:33:59 Grounding `NOT_EVALUABLE` → **20:34:04 mismatch "mensagem genérica de falha
dizendo que não encontrou confirmação"**; 20:34:29, 20:38:00, 20:45:58, 20:50:18, 20:52:32 `same_tool_limit` (`exec_command`); 20:41:59,
20:46:27, 20:54:41 **o passo seguinte roda `python …\workspace\extrator*.py` que não existe** (o script foi gravado em
`workspace\tmp\`) → 3 replans com o mesmo defeito; 20:47:33 `read` do consolidado com **0 bytes**; 20:56:12 **12 ciclos, 5 replans, `failed`**.

**21:50 — rota `agentloop` (+S296/S297; 79 s).** 21:50:28 `route=agentloop reason=goal_extractor_timeout` (classificador excedeu 15 s);
21:50:47 quarto `exec_command` → `same_tool_limit`; 21:51:20 síntese abortada por orçamento de raciocínio; 21:51:28 resposta = narração do passo anterior (bug tratado em S298).

**22:49 — goal `…ov9eh` (+S298; 1 539 s).** 22:58:34 grava `extrator_aulas.py`; 22:58:39 `extracao_aulas.txt` com **140 bytes** (resíduo na raiz);
**23:02:52 `exec_command`: "Extração concluída: tmp/extracao_aulas.txt (9 arquivos processados)"**; 23:04:53 passo promovido por "9/20 termos-chave";
**23:05:01 o passo seguinte lê `aulas_extraidas.md` — nome suposto pelo plano, que não existe → blocker → replan 1**; 23:06:23 o replan **já cita**
`tmp/extracao_aulas.txt`; 23:07–23:08 releituras (`extracao_aulas.txt` lido 6× no goal) e `same_tool_limit` (`read`); 23:08:58 `context_growth` **5,8×** (12,8 mil → 74 mil caracteres);
23:10:05 Grounding `NOT_EVALUABLE` sobre a afirmação "tmp/extracao_aulas.txt corresponde ao alvo desta tarefa" → 23:11:14 resposta parcial também descartada →
**23:11:17 mismatch "mensagem genérica de falha em encontrar informações"** → replan 2 (23:12:13 "Consumir a extração já gerada"); 23:15:36 **12 ciclos → `failed`**. Entre 23:02:52 e 23:15:36: **34 chamadas LLM, 8 abortos por orçamento de raciocínio**.

## D. Fluxo completo (código real) e as dez perguntas por transição

```
usuário → MessageBus → GoalOrchestrator: GoalExtractor.quickClassify (heurística) → LLM (15 s) ⇢ UnifiedIntentRouter (LLM)
 → GoalPlanner.plan (LLM, ~87% instruções fixas) → RiskAnalyzer.reviewPlanWithLLM (LLM) + sanitizePlanSteps (rebaixa/descarta args)
 → GoalExecutionLoop → por passo: tool direta (GoalEvaluator determinístico) OU AgentLoop (LLM, laço com ferramentas; Observer/Grounding antes de devolver)
 → ToolResult → GoalAttempt (persistido: saída truncada em 300 B, 8 000 B p/ agentloop) → StepSemanticValidator (termos-chave ⇢ LLM)
 → blocker (texto) → GoalPlanner.replan (LLM; NÃO recebe attempts/saídas) → … → MAX_CYCLES=12 → entrega/mensagem de falha
```

| Transição | Produz | Persiste | Interpreta / autoridade | Reinterpretada? | Perda / contradição |
|---|---|---|---|---|---|
| pedido → "é goal?" | GoalExtractor (heurística + LLM) | — | GoalExtractor **e** UnifiedIntentRouter respondem à mesma pergunta ("exige planejamento?") | **sim: discordam em 63 de 235 comparações (27%)** | rota `agentloop` sem replan quando o extrator estoura 15 s |
| plano → passos | GoalPlanner | `currentPlan` | RiskAnalyzer revê; sanitize rebaixa | sim (3 camadas mutam o plano; 13 mutações no goal de 23:15) | rebaixamento descartava `toolArgs` (caminho planejado) — S296 |
| passo `agentloop` → saída | AgentLoop (LLM) | `attempt.output` | Observer/Grounding, depois StepSemanticValidator | **sim, em série** | **Grounding descarta a resposta e devolve texto de chat; o validador lê esse texto como "saída do passo"** |
| tool → artefato | tool | `producedArtifactPaths` só se `write` ou linha `ARTIFACT:` | quem consome: resolvedor de entrega | — | `exec_command` de script gerado por LLM não declara; **0 ocorrências no log** |
| attempts → replan | — | `goal.attempts` | GoalPlanner.replan | — | **`buildReplanPrompt` só conta falhas de `exec_command`; saídas, comandos e caminhos não entram** |
| replan → passos | LLM | novo plano | RiskAnalyzer + sanitize | sim | caminho suposto ≠ caminho gravado (3 replans) |
| ciclos → fim | GoalExecutionLoop | `cycles` | `MAX_CYCLES=12` | — | os 3 goals falharam com **`cycles=12`** |

Respostas às perguntas 9 e 10: **existe informação que existe no sistema e não chega ao LLM** (attempts/saídas/artefatos no replan; estado do
Grounding no validador). **Informação sem origem factual tratada como fato:** promoção a "sucesso" por contagem de termos-chave (§G/§I); a mensagem
de falha apresenta como "Informações coletadas" saídas cruas de `memory_search` sem juízo de relevância (nó `HEARTBEAT`).

## E. Causas comprovadas (evidência: log + código + reprodução)

| # | Causa | Evidência | Situação |
|---|---|---|---|
| E1 | Ollama parado (atualização automática) → nenhum provider; mensagem genérica | 18:14–18:15 log do Ollama; 18:43 `ALL_PROVIDERS_CIRCUIT_OPEN` | **corrigido S294** (mensagem) — a causa é externa |
| E2 | Planejador escolheu `read` fora do sandbox; a fronteira era desconhecida | 19:10:49 `⛔ Caminho fora do sandbox`; 22:49 não repetiu após S295 (**revisado em 24/09, B4.1:** o erro tem 701 caracteres e a evidência acrescentada começa no 208º; o blocker guarda 200 — não chega ao replanner; no replan #25 o `read` externo foi escolhido de novo) | **parcial S295** (corrige a mensagem da ferramenta; a evidência não atravessa até o planejador) |
| E3 | Script gravado em `workspace\tmp\` e executado em `workspace\` | 20:41:59/20:46:27/20:54:41; `agentPrompts.ts:62` (`tmp/`) × descrição do passo ("no workspace") | **parcial S296** (`write` rebaixado leva o caminho); a duas-autoridades permanece (§H) |
| E4 | Turno encerrado por trava entregava a narração como resposta | 21:50:47 + 21:51:28; regra `length > 100` | **corrigido S298** |
| E5 | **Contrato Grounding → passo perdido**: o texto de chat do bloqueio vira "saída do passo" e é lido como falha | código `AgentLoop.groundingBlockedMessage`; razões verbatim 20:34:04 e 23:11:17 | **não corrigido — PENDENTE** |
| E6 | **Fim por `MAX_CYCLES=12`** em todos os goals; cada passo bloqueado e cada replan consome ciclos | 3 `GoalAudit` com `cycles=12` | estrutural |
| E7 | Passos `agentloop` sem resultado utilizável (narração/erro genérico) por abortos de raciocínio, `same_tool_limit`, Grounding e crescimento de contexto | mismatches em 3 goals (todos descrevem saída degenerada); B2: 10/10 chamadas abortadas recuperadas por fallback, 59% do tempo descartado | causa **do sintoma** comprovada; causa **do raciocínio excessivo** só parcial (§F) |
| E8 | Promoção a sucesso por contagem de termos-chave | `StepSemanticValidator.fastPathCheck` (`hitRate ≥ 0,35`, `includes`); 19:01:53 "6/13", 23:04:53 "9/20", 23:13:11 "10/20" | problema arquitetural (§G) |
| E9 | Resposta de rota `agentloop` quando o classificador estoura 15 s (2,4% das 246 medições) | 21:50:28 e 18:43:31 | fato; decisão de manter o orçamento já tomada |

## F. Causas prováveis (não comprovadas)

- **Contrato de saída JSON do `AgentLoop`** (`JSON_FORMAT`, anexado a todo prompt de sistema): experimento B4 (isolado, `glm-5.3:cloud`, síntese após erro): sem o bloco, raciocínio
  mediano 7,7 mil × 13,5 mil caracteres; **removendo só a instrução de texto puro piora 4×** (V3: 38 mil, 10/10 em JSON). Efeito exploratório, um modelo, um tipo de erro. **Laço com ferramentas não testado.**
- **Tarefa do `RiskAnalyzer`** (revisar + reescrever plano completo, teto de 8 000 chars de raciocínio, sem `reasoningIntensive`): 3/3 abortos com ~670 tokens de entrada.
- **Replan sem os fatos** dos attempts: o replanner **já citava** `tmp/extracao_aulas.txt` (via texto do blocker) e ainda replanejou reescrever; portanto **o efeito de projetar attempts no replan é hipótese**, não causa provada.
- **Modelo × papel:** flash 18,6% de abortos × `glm-5.2` 1,3% no histórico; em B1/B2 o mesmo `glm-5.3` aborta no planejador e não no extrator → papel/tarefa pesa mais que modelo.

## G. Problemas arquiteturais por camada

- **Roteamento:** duas camadas decidem "exige planejamento" (27% de discordância); a rota `agentloop` não tem replan.
- **Planejamento:** 87% do prompt do plano é regra fixa; 6 434 chars idênticos em plan/replan1/replan2 (**repetição ≠ redundância comprovada**).
- **Execução:** passo `agentloop` é opaco (99,9% do tempo dos passos; 7 passos = 1 070 s). Três autoridades para o caminho do artefato; `exec_command` não declara o que produz.
- **Validação:** cadeia em série Observer/Grounding → StepSemanticValidator → GoalEvaluator; **o descarte de uma camada é lido como falha pela seguinte (E5)**.
- **Decisões semânticas por regex/contagem (código exato):**
  1. `StepSemanticValidator.fastPathCheck` — "o output satisfaz a intenção?" decidido por `outputLower.includes(termo)` e limiar 0,35/0,72 (STOPWORDS só PT/EN; regex `[^a-z0-9áéíóúãõâêôçàü\s]` descarta `ñ`).
  2. `inferExpectedExtensions(userIntent)` — "que arquivo o usuário quer?" por regex de palavras-chave. **Reproduzido com o pedido real:** devolve **`[".xlsx",".xls"]` porque o nome da pasta contém "Excel"**; o mesmo em EN e ES; com outro nome de pasta devolve `[]`; "escreva um resumo em texto sobre o Excel" → `.xlsx`. Consumido em `artifactContract.resolveArtifactPathFromEvidence` (filtra candidatos), `GoalExecutionLoop` `deliverable_check` (:1505) e `checkDeliverables`. **Não é causa comprovada do incidente** (o `deliverable_check` não chegou a executar nos goals; nenhuma linha no log), mas é **defeito arquitetural** que derrota exatamente a salvaguarda "já existe saída, não regenere".
  3. `GoalExtractor.quickClassify` — intenção "goal/não-goal" por heurística (`heuristic_positive/negative`).
  4. `AgentLoop.looksLikePendingActionPromise/looksLikeUnfulfilledFuturePromise` — "a resposta promete e não cumpre?" por regex **somente em português**.
  5. `GoalExecutionLoop.isModificationGoal` — intenção "modificar" por regex sobre o texto do usuário.
  **Nenhuma foi substituída por outra heurística, conforme o briefing.**

## H. Duplicação de autoridade (o mesmo conhecimento decidido em vários lugares)

| Conhecimento | Onde é decidido |
|---|---|
| "Este pedido exige planejamento?" | `GoalExtractor` (heurística+LLM), `UnifiedIntentRouter` (LLM), `GoalOrchestrator` (compara os dois; 63 discordâncias) |
| Onde o artefato mora | Planner (texto do passo/`toolArgs`), `agentPrompts.ts` (`tmp/`), `sanitizePlanSteps`, `RiskAnalyzer` (inferência de `file_path`), `resolveArtifactPathFromEvidence` |
| Que tipo de arquivo entregar | `inferExpectedExtensions` (regex), planejador, AgentLoop |
| "O passo cumpriu a intenção?" | `GoalEvaluator` (estado da tool), `StepSemanticValidator`, Grounding/Observer, `validateGoalCompletion` (LLM) — **perguntas diferentes, mas encadeadas em série sem contrato de estado** |
| O que foi produzido | `producedArtifactPaths` (declarado/verificado), `attempt.output` (texto), `sentArtifacts` (entregue), `checkDeliverables` (varredura por mtime), `core_workspace` (só contagem) — **não existe `observedArtifacts`** |

**Estruturas de artefato (A–F do briefing):** **autoridade sobre o que foi produzido** = o filesystem, acessado por `resolvePath`/`checkDeliverables`;
**declaração do LLM** = `ARTIFACT:` (verificada no disco) e o texto de `attempt.output`; **observação objetiva** = `checkDeliverables` (mtime, profundidade ≤ 4, teto 5,
só na entrega) e `write_tool` (artefato gravado); **estado persistido** = `goal.attempts` (12 attempts no goal de 23:15; `producedArtifactPaths` **vazio nos 12**) e `sentArtifacts`;
**chega ao replanner:** nenhuma delas, exceto por acaso (texto do blocker); **chega à entrega:** `producedArtifactPaths` + `sentArtifacts` (`resolveArtifactPathFromEvidence`) e `checkDeliverables`.

## I. Problemas de carga cognitiva (medidos; ver B1–B4 do relatório consolidado)

- Chamadas LLM = **82%** da duração do goal de 23:15, com **17 abortos** por orçamento de raciocínio (31% da duração descartada); no goal
instrumentado de 24/09, 10 chamadas abortadas, 59% do tempo delas descartado.
- **Pergunta do briefing — quantas vezes o mesmo fato é reinterpretado até a decisão seguinte?** O fato "extração concluída" (23:02:52) passou por: ferramenta (sucesso) → narração do `agentloop` (LLM) → Grounding (LLM, **descartou**) → resposta parcial (LLM) → Grounding de novo → StepSemanticValidator (**leu o texto de descarte**) → blocker (texto) → `replan` (LLM) → RiskAnalyzer (LLM) → sanitize → novo `agentloop` que **releu o arquivo** — **≥ 9 reinterpretações e 34 chamadas LLM em 12,7 minutos** sem que o fato fosse consumido.
- Prompt do planejador: **11 080 de 12 708 caracteres** são instruções fixas; histórico e saídas **não entram** no replan.
- `AgentLoop`: 11 esquemas de ferramentas ≈ 2,1 mil tokens (`memory_write` 28%) + prompt de sistema de 7,5–9 mil caracteres por chamada; a síntese reenvia o mesmo prompt de sistema.
- **Não se conclui "muitos módulos":** as camadas respondem a perguntas diferentes; o custo está nas **reinterpretações em série** e no **executor opaco**.

## J. Multiplataforma

- Camada de shell: tradução bash→PowerShell só quando `process.platform === 'win32'` e o comando exige (necessidade da plataforma); hints por plataforma (`FIND_FILE_HINT`, `GREP_HEAD_HINT`) já são condicionais.
- **Corrigido (S297):** `Get-Content` do PowerShell 5.1 lia UTF-8 como ANSI (reproduzido com o wrapper real); só afeta Windows PowerShell 5.1 (no Linux/macOS o wrapper não é aplicado).
- **Achado menor, não causal:** `checkDeliverables` faz `scan('/tmp', 0)` fixo (`GoalExecutionLoop.ts:4442`) — inexistente no Windows; a abstração neutra seria `os.tmpdir()`. **Não implementado** (não comprovado como causa).
- O caminho `tmp/` (convenção de `agentPrompts.ts`) é relativo ao workspace e neutro; o defeito é a **divergência entre autoridades**, comum aos três sistemas (não é Windows-only).

## K. Internacionalização (PT/EN/ES)

- Core emite português fixo (débito declarado em `ARCHITECTURE.md`): mensagem de falha do `GracefulDeliveryOrchestrator`, mensagens de bloqueio do Grounding, **e as que eu introduzi**: `ProviderFactory` (S294) e `buildInterruptionNotice` (S298) — **dívida nova, registrada**; a alternativa "fato para o LLM verbalizar" (RFC-004) não vale quando o provider está fora do ar, então exige uma tabela mínima de mensagens de último recurso por idioma (**PENDENTE**).
- Heurísticas dependentes de idioma: STOPWORDS (PT/EN, sem ES), `looksLikePendingActionPromise` (só PT), `inferExpectedExtensions` (palavras PT + parte EN), `isModificationGoal` (PT/EN).
- Prompts de planejamento em português (voltados ao LLM; a resposta ao usuário segue a diretiva de idioma).

## L. Segurança (GitHub Security, verificado em 24/09/2026 via `gh api`)

Dependabot **0** abertos (vários corrigidos em 23/09) · Code scanning **4 abertos**: `js/missing-rate-limiting` em `DashboardServer.ts:66` e 2× no teste `S277`, `js/request-forgery` (erro) em `OpenAIProvider.ts:46` desde 25/08 (já protegido por `assertNotSsrfTarget`) · Secret scanning **0** · 1 advisory **publicado** (GHSA-jpx8-29mp-v4hw: HMAC vazio no modo senha do dashboard — corrigido, **não reabrir**) · 1 PR Dependabot aberto (`fast-uri`, addin do PowerPoint). **Nenhum relacionado ao incidente → FORA DO ESCOPO.** Nenhuma correção proposta toca autenticação.

## M. O que NÃO deve ser criado

`observedArtifacts`, `ArtifactRegistry/Trace`, UUID/hash/log de eventos, watcher, snapshot de filesystem (alternativas já rejeitadas com evidência; Codex/Cline mostram incidentes de custo), cache de leitura de arquivos, `FileReadCache`. **Não remover instruções do planejador** por serem repetidas. **Não remover a instrução de texto puro da síntese** (B4/V3 mostra que agrava). Nenhum novo juiz: dois componentes só se fundem se responderem à mesma pergunta — **não é o caso** entre Grounding, StepSemanticValidator, GoalEvaluator e Observer; o que falta é **contrato de estado** entre eles.

## N. Sprints (uma campanha; execução condicionada às decisões de §P)

1. **Causa raiz do incidente** — feito (S294–S298 + esta investigação).
2. **Contrato Grounding → GoalExecutionLoop** (E5): o passo precisa saber que a resposta foi retida, com o motivo estruturado, em vez de ler texto de chat.
3. **Autoridade do caminho do artefato** e do tipo de entrega (`inferExpectedExtensions` → componente semântico com validação estrutural).
4. **Fluxo de informação para o replan** (projeção compacta dos attempts) — junto da revisão do prompt de replan, com orçamento definido pela medição B.
5. **Decisão semântica sem contagem de palavras** (`StepSemanticValidator` fast path, promessas, intenção).
6. **Carga cognitiva do `AgentLoop`** (contrato JSON × ferramentas nativas; trava + fallback; `RiskAnalyzer`).
7. **Regressão + build + typecheck + navegação completa** (obrigatória **depois** de qualquer alteração).

## O. Dossiê das correções propostas (todas PENDENTES; nenhuma implementada nesta campanha)

**O.1 — Contrato Grounding → passo (E5)**
Problema: o descarte do Grounding vira "falha genérica". Evidência: `groundingBlockedMessage` (texto de chat) + razões verbatim 20:34:04, 23:11:17. Causa: informação estruturada (`GroundingState`) existe e não atravessa a fronteira `AgentLoop → GoalExecutionLoop`. Componentes: `AgentLoop.commitResponse`, `GoalExecutionLoop.dispatchAgentloopStep`, `StepSemanticValidator`. **Alternativas:** (a) devolver `{retido: true, estado, motivo}` estruturado e o validador tratar "resposta retida" como fato distinto; (b) não aplicar Grounding de usuário a saídas internas de passo (o passo não é entregue); (c) passar ao validador a evidência de ferramentas em vez do texto. **Autoridade a decidir** (o passo cumpriu? quem sabe é a evidência de ferramentas, não a narração). Holística: elimina a classe "descarte lido como falha" em qualquer canal/idioma. Windows/Linux/macOS: neutro. PT/EN/ES: neutro (estado é enum; o texto ao usuário segue a diretiva de idioma). Risco: liberar passos que hoje são bloqueados por afirmações não sustentadas — precisa manter a barreira de entrega ao usuário. Testes: caso real (retido → não é mismatch), negativo (afirmação falsa segue bloqueada na entrega).

**O.2 — Tipo de entrega por semântica, não por regex**
Problema: `inferExpectedExtensions` erra com o nome da pasta. Evidência: saída da função com o pedido real (`.xlsx`). Causa: decisão semântica por regex de palavras. Componente: `planning/inferExpectedExtensions.ts` + 3 consumidores. **Alternativa:** o componente que já interpreta o pedido por LLM (`GoalExtractor`) declara o tipo esperado; o determinismo só **valida** a extensão (lista estrutural) e, na dúvida, **não infere** (`NUNCA_ADIVINHAR`). Multilíngue por construção. Risco: mais um campo no contrato do extrator; goals legados sem o campo. Testes: pasta chamada "Excel" com pedido de proposta em texto; ES/EN.

**O.3 — Fast path do `StepSemanticValidator`**
Problema: promoção a sucesso por contagem de termos-chave. Evidência: 3 de 5 promoções no goal de 23:15 (e "6/13" às 19:01:53). **Alternativa:** determinismo fornece **fatos** (sucesso da tool, exit code, artefato verificado no disco); o LLM interpreta se satisfazem a intenção. Custo: os validadores respondem por 8 chamadas/33 s (2,6% do tempo de LLM) — barato. Risco: mais latência por passo simples; manter atalho **estrutural** (ex.: `write` com artefato verificado). Testes: promoção sem contagem; ES.

**O.4 — Fatos dos attempts no replan (A)**
Problema: replan não recebe saídas/caminhos. Evidência: `buildReplanPrompt`; attempts 6/7/11. **Hipótese não provada** de que muda o desfecho (o replanner já citava o arquivo). Alternativa: projeção compacta, temporária, com tetos rígidos, **junto** da revisão do prompt do replan. Risco: aumentar o prompt. **Congelada por decisão do usuário até B/C/D.**

**O.5 — Autoridade do caminho do artefato (C)**
Problema: cinco pontos decidem/reinterpretam. Alternativa registrada: o executor observa e o estado registra; Planner/AgentLoop só expressam intenção. Precisa de decisão de autoridade (**PENDENTE**), sem novo registry.

**O.6 — Carga do `AgentLoop`** (JSON × ferramentas nativas, trava + fallback, `RiskAnalyzer`): exige experimentos com ferramentas; **PENDENTE**.

**O.7 — Duas classes de decisão de rota**: `GoalExtractor` × `UnifiedIntentRouter` (27% de discordância): qual é a autoridade de "exige planejamento"? **PENDENTE**.

**O.8 — Mensagens de último recurso em PT/EN/ES** (S294/S298): tabela mínima por idioma quando não há LLM disponível. **PENDENTE**.

## P. Decisões PENDENTES (para o usuário)

1. E5 (contrato Grounding → passo): escolher a alternativa (a), (b) ou (c) — a autoridade sobre "o passo cumpriu?".
2. O.2: aceitar que `GoalExtractor` declare o tipo de entrega esperado (novo campo no contrato do extrator).
3. O.3: substituir o fast path por fatos + LLM.
4. Autoridade única de "exige planejamento" (O.7).
5. Ordem: sugiro **E5 → O.3 → O.2 → (B/C) → A**, por evidência causal decrescente.
6. Aprovação para experimento do laço com ferramentas (contrato JSON).
7. Tabela de mensagens de último recurso PT/EN/ES.

## Q. Verificações desta campanha

Nenhum código alterado; **regressão/build/typecheck/navegação não se aplicam** (só investigação). GitHub Security reverificado (§L). Estado do repositório: S294–S299 commitados **localmente**, não enviados ao GitHub.

## R. Atualização B4.1 (24/09/2026) — ver `RELATORIO_CONSOLIDADO.md`, seção B4.1

- **E5 ganhou origem localizada e um segundo elo:** além do texto de bloqueio do Grounding, a **guarda `context_growth`** encerra o laço logo depois de uma observação legítima grande e uma **síntese forçada** transforma um passo não executado em "resultado", reinterpretado por 3 juízes LLM em série (3 de 3 eventos da execução instrumentada; 45% dos 58 eventos de produção foram seguidos de síntese forçada).
- **S295 rebaixada para "parcial"** (evidência truncada em 200 caracteres antes do replan).
- **`AgentLoop` opaco não é causa primária demonstrada;** nesta execução planejar/replanejar/revisar plano = 57% do tempo de LLM.
- **Contrato JSON no laço:** 11/11 respostas foram chamadas nativas de ferramenta (JSON inerte no laço); o efeito medido em B4 vale para a síntese.
- Nenhuma decisão arquitetural tomada; nenhum código alterado.
