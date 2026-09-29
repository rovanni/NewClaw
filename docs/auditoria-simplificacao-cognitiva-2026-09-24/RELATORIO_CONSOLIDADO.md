# Auditoria de Simplificação Cognitiva — Relatório consolidado

Data: 2026-09-24 · Status: investigação, **zero alteração funcional** · Decisões: todas **PENDENTES**

## Objetivo

Identificar fronteiras onde múltiplas camadas respondem à mesma pergunta ou mantêm representações
concorrentes do mesmo fato, medindo o impacto no comportamento, no custo de raciocínio e na
confiabilidade do LLM. Critério: **agrupar só quando houver responsabilidade duplicada ou
concorrente, comprovada por evidência** — nunca por estética.

## Evidência-base (um único goal real, 23/09/2026 22:49–23:15)

Pedido: "analisar as aulas dadas e propor mais uma aula" (pasta externa). Instância de produção
local, provider Ollama, modelos `glm-5.3-flash:cloud` (58 chamadas) e `glm-5.2:cloud` (18).
Fonte: `newclaw-audit.log`, goal `goal_1790214597600_ov9eh`.

| Medida | Valor |
|---|---|
| Duração total | 1538 s (25,6 min) |
| Ciclos / replans / planos | 12 / 3 (+1 plano inicial) / 8 chamadas de planejamento |
| Chamadas LLM (`chatWithFallback`) | 76, somando 1263 s (82% da duração) |
| Abortos por orçamento de raciocínio | 17 |
| Tempo dentro de passos `agentloop` | 1070 s = **99,9% do tempo de execução de passos** (7 passos) |
| Tempo nos passos com ferramenta direta | ~1 s (exec_command ×2, read ×2, memory_search ×1) |
| Mutações/rebaixamentos do plano | 13 |
| Resultado | `failed` — mas a extração dos 9 arquivos (59 KB, 1833 linhas) existia desde 23:02 |

Atribuição do tempo de LLM pelo componente que precedeu a chamada no log (aproximada): AgentLoop
55 chamadas / 810 s / 11 abortos; planejamento e replan (via SkillLoader/GoalPlanner) ~10 / ~330 s;
validação semântica de passo 8 / 33 s.

---

## Sprint 1 — Mapa de autoridades: "onde mora o artefato?"

| Componente | Responsabilidade atual | Entrada | Saída | Pode alterar a decisão? | Conflito comprovado |
|---|---|---|---|---|---|
| Planner (`GoalPlanner`) | Escolhe o caminho no texto do passo e nos `toolArgs` do plano | objetivo, contexto | passo com `path`/`file_path` | Sim — origem | Escreve "no workspace" (raiz) |
| `agentPrompts.ts` (FILE_OPS, l.62) | Manda o AgentLoop gravar em `tmp/...` (relativo) | prompt do AgentLoop | caminho escolhido pelo LLM em runtime | Sim — em runtime | Contradiz o Planner: script gravado em `tmp/`, executado na raiz (3 replans em 23/09; 3 vezes no histórico) |
| `sanitizePlanSteps` | Registra `writtenPaths`; rebaixa passos; descarta `toolArgs` do rebaixado | plano bruto | plano ajustado | Sim — descarta o caminho (corrigido em S296 só p/ `write`) | Perdia o caminho planejado |
| `RiskAnalyzer` (l.~640) | Infere `send_document.file_path` a partir do `write` anterior | plano | `file_path` inferido | Sim — muta o plano | Segunda inferência independente |
| `resolveArtifactPathFromEvidence` | Resolve o caminho a partir de `goal.attempts.producedArtifactPaths` e `sentArtifacts` | goal, descrição | caminho | Sim — fallback na entrega | Terceira resolução, só lê evidência |
| `write_tool` + `resolvePath` | Resolve o caminho final no disco (canônico) | path pedido | path resolvido | Sim — é a verdade do disco | — |

**Achado:** há **5 pontos** que decidem ou reinterpretam o caminho de um artefato, cada um com
sua própria fonte de entrada. Duplicação de conhecimento **comprovada** (mesmo fato — "onde o
arquivo está" — com representações concorrentes; divergência real e datada).

**Quem deveria ser a autoridade:** não decidido (ver Decisões pendentes).

## Sprint 2 — Mapa dos juízes

| Juiz | Pergunta que responde | Consome | Quem o executa |
|---|---|---|---|
| `GoalEvaluator` | Em que **estado** ficou o resultado da tool? (success/partial/blocked/failed) | resultado estruturado + padrões de erro/exit code | GoalExecutionLoop |
| `StepSemanticValidator` | O output **satisfaz a intenção do passo**? | output do passo | GoalExecutionLoop |
| Grounding (`ObserverValidator`/AgentLoop) | As **afirmações** da resposta têm evidência? | resposta + resultados de ferramentas | AgentLoop (antes de entregar) |
| `ObserverValidator` | A resposta tem **qualidade**? | resposta | AgentLoop — nesta janela 23 de 26 execuções foram `skipped [DETERMINISTIC]` |
| `commitResponse` (Q4) | Há promessa não cumprida / alucinação de ação? | resposta + histórico | AgentLoop |

**Achado 1 — não são "quatro juízes da mesma pergunta".** As perguntas diferem; por isso **não há
evidência para agrupá-los por pergunta duplicada**.

**Achado 2 — o defeito está na composição em série.** Cadeia comprovada em 23:10–23:11:
Grounding marca `NOT_EVALUABLE` (afirmação "tmp/extracao_aulas.txt corresponde ao alvo desta
tarefa" não verificável) → a resposta é **descartada** → a saída do passo vira mensagem genérica
de falha → `StepSemanticValidator` lê essa mensagem e reporta `MISMATCH` → o passo é bloqueado →
replan. O juiz final avaliou corretamente o que recebeu; o que estava errado era o que ele
recebeu.

**Correção de uma afirmação anterior minha (23/09):** eu disse que o verificador "reprovou um passo
que tinha funcionado". Os dados não sustentam isso: dos 6 `MISMATCH` do goal, **todos** descrevem
saída degenerada ("mensagem de erro genérica", "apenas repete a intenção", "mensagem
introdutória"), isto é, o passo `agentloop` realmente não produziu resultado. O que falhou foi a
etapa anterior (orçamento de raciocínio, trava, grounding).

**Achado 3 — heurística semântica.** 3 das 5 promoções `promote_to_confident_success` foram
decididas por contagem de termos-chave ("6/14", "9/20", "10/20 termos-chave encontrados") — sobreposição
lexical decidindo uma pergunta semântica, contra a regra "determinismo valida / LLM interpreta".

## Sprint 3 — Estado dos artefatos

Existe estado estruturado: `GoalAttempt.producedArtifactPaths` + `goal.sentArtifacts`. Ele só é
preenchido quando: (a) `write` grava conteúdo substantivo; (b) `exec_command` imprime uma linha
`ARTIFACT: <path>` verificada no disco; (c) o AgentLoop grava e entrega (pseudo-attempt).

**Achado:** a convenção `ARTIFACT:` (b) está documentada **apenas em comentários de código**;
nenhum prompt nem skill a ensina ao LLM (busca em `src/` e `skills/`). Um script escrito pelo LLM
imprime, como ocorreu: "Extração concluída: tmp/extracao_aulas.txt (9 arquivos processados)" —
**não é reconhecido**. Resultado: 0 ocorrências de `ARTIFACT:` no log da janela; o artefato de 59 KB
existia no disco e **não existia no estado do goal**.

Autoridade **de fato** hoje: o filesystem (via `resolvePath`) e o texto do LLM; o estado
estruturado é contrato opt-in que o produtor típico (script gerado por LLM) não cumpre.

## Sprint 4 — Replan e perda de estado

`buildReplanPrompt` (GoalPlanner.ts:331) recebe: objetivo/intenção, estratégias tentadas
(strings), blockers anteriores (`kind: description`), dica de reflexão, contexto de memória,
diretivas de loop, bloco de progresso (rótulo + evidência de 80 caracteres).
`goal.attempts` é usado **só para contar** falhas de `exec_command` e detectar loop.

| Sobrevive ao replan | Não chega ao replanner |
|---|---|
| objetivo, blockers (texto), estratégias (texto), progresso (80 chars), memória | saídas dos attempts, `producedArtifactPaths`, `sentArtifacts` (exceto via contexto), resultados de ferramentas, descobertas |

**Achado:** "a extração existe" chegou ao replan às 23:11 só porque o texto do blocker citava
`tmp/extracao_aulas...` — por acaso, não por desenho. Falha de **estado**, não de planejamento.

## Sprint 5 — Carga cognitiva

- O custo **não** está nos juízes: validação semântica = 8 chamadas / 33 s. Está no executor
  opaco: passos `agentloop` = 55 chamadas, 810 s, 11 dos 17 abortos.
- Cada replan = 1 plano novo (~60–120 s). 3 replans ≈ 5 min de planejamento.
- O planner emite `agentloop` como nome de ferramenta 2 vezes; o `sanitizePlanSteps` o remove
  ("não existe no ToolRegistry"). Conceito interno vazando para o vocabulário do LLM.
- Não foi possível separar "contexto grande" de "modelo verboso": os abortos ocorrem tanto com
  8000 quanto com 32000 caracteres de raciocínio, com `inputTokens` entre ~800 e ~8900. **Sem
  evidência para atribuir a causa.**

## Matriz de decisão

| Candidato | Evidência | Impacto | Duplicação comprovada? | Agrupar? | Risco |
|---|---|---|---|---|---|
| Autoridade do artefato | 5 pontos de decisão; 4+ falhas datadas | Alto | **Sim** | Candidato forte | Médio — toca planner, sanitize, RiskAnalyzer, AgentLoop |
| Juízes do passo | 4 juízes, 4 perguntas distintas | Alto | **Não** por pergunta; **sim** por composição em série | Não agrupar; tratar o **contrato entre eles** (o que um juiz entrega ao próximo) | Baixo–médio |
| Estado de artefatos no replan | replan não recebe `producedArtifactPaths`; `ARTIFACT:` não ensinado | Alto | Não é duplicação — é **lacuna** | Não agrupar; **propagar** o estado existente | Baixo |
| Executor opaco `agentloop` | 99,9% do tempo dos passos; 13 mutações | Alto | Parcial (planner ↔ executor) | Investigar antes | Alto |
| Prompt de replan (diretivas empilhadas) | débito conhecido | Médio | Sem medição nesta janela | Sem evidência nova | — |
| Heurística "termos-chave" no validador | 3/5 promoções | Médio | Viola regra do projeto | Substituir mecanismo | Médio |

## Decisões PENDENTES (para o usuário)

1. Quem é a **autoridade única** do caminho de um artefato: o Planner, o executor (AgentLoop) ou
   o estado registrado após a produção?
2. Propagar `producedArtifactPaths`/saídas ao replanner (lacuna de estado) — e ensinar a
   convenção `ARTIFACT:` ao LLM, ou reconhecer artefatos por outro sinal estrutural (diff do
   filesystem antes/depois do passo)?
3. Contrato entre Grounding e o validador semântico: um descarte por Grounding deve chegar ao
   validador como **"resposta descartada"** (fato distinto) e não como texto genérico de falha?
4. Substituir a contagem de "termos-chave" no `StepSemanticValidator` (viola determinismo valida /
   LLM interpreta)?
5. Investigar o executor opaco `agentloop` como campanha própria?

## Fora do escopo (registrado)

- Orçamento de raciocínio (decisão do usuário em 23/09: manter).
- Timeout de 15 s do classificador de goal (2,4% de estouro em 246 medições; decisão: manter).
- `workspace\workspace`: não verificado nos logs desta campanha.
- Mensagem final com trechos de memória truncados no meio da palavra.
- Cancelamento pelo usuário não aborta a chamada de planejamento já em voo (observado 22:48–22:49).
- Alertas de code-scanning do GitHub (rate limiting, request forgery).

---

## Atualização de 24/09/2026 — consolidação das campanhas

Insumos novos: investigação comparativa (Codex, OpenHands, OpenClaw; Aider e Cline como
arquiteturas distintas) e leitura do banco de produção. Nenhum código alterado.

### O que a investigação mudou

- **Campanha A deixou de ser "criar observação de artefatos".** O fato já estava persistido em
  `goal.attempts` (attempts 6, 7 e 11 citam `tmp/extracao_aulas.txt`); faltava o **consumidor**
  (`buildReplanPrompt` só conta falhas). Decisão revisada: projeção factual compacta do histórico
  no replan — ver `RFC_CAMPANHA_A_ESTADO_DE_ARTEFATOS.md`.
- Tese central da auditoria, agora com evidência de dois lados: **a informação existe em vários
  lugares, mas cada camada recebe uma projeção diferente dela.** Não é falta de memória.

### Mapa das campanhas

| | Campanha | Problema comprovado | Evidência | Está em aberto |
|---|---|---|---|---|
| A | Estado → replan | Histórico existe e não chega ao replanner | attempts 6/7/11; `buildReplanPrompt` | Formato e tetos da projeção |
| B | Carga cognitiva | 17 abortos de orçamento; 82% do tempo em LLM; 99,9% do tempo de passos dentro de `agentloop` | log do goal | **Causa** (contexto grande × modelo verboso × ações ruins) — não medida |
| C | Autoridade do caminho | 5 pontos decidem o caminho; 3+ falhas datadas | Sprint 1 | Quem é a autoridade |
| D | Decisões semânticas | 3 de 5 promoções por contagem de palavras-chave; descarte do Grounding vira "falha genérica" | Sprint 2 | Contrato Grounding→validador; substituição da heurística |

### Relações entre elas (o que a auditoria sugere, não decide)

- **A e a simplificação do contexto do replan podem ser a mesma campanha.** O prompt de replan é
  montado por blocos independentes (blockers, estratégias, reflexão, memória, quatro diretivas de
  loop, progresso). Adicionar o histórico factual sem revisar os demais blocos aumenta o prompt;
  revisar o conjunto é o que respeita o limite de carga cognitiva.
- **B condiciona o tamanho de A.** Qualquer texto novo no prompt de replan precisa de orçamento
  definido por B.
- **C e a projeção de A tocam o mesmo fato** (caminho do arquivo), mas em momentos diferentes:
  A informa o que já existe; C decide onde algo deve ser gravado. Podem andar separadas.
- **D é independente de A** (regra de arquitetura, não de estado) e não deve ser misturada.

### Decisões PENDENTES

1. A pequena mudança de A entra numa campanha maior de **contexto do replan** ou fica isolada?
2. Ordem das campanhas depois de A. A auditoria não tem evidência para ordenar B, C e D pela
   ordem de dano; só B tem dado de custo (tempo), sem causa.
3. Antes de implementar qualquer uma: medir em B o que falta (contexto × modelo × ações), porque
   define o teto que A pode usar.

---

## Decisões de 24/09/2026 (adotadas) e regra permanente

- **A não é uma campanha isolada.** Entra como capacidade de uma campanha maior de **simplificação do
  contexto do replan**, cuja pergunta é: *qual é o mínimo de estado factual que o LLM precisa
  receber para tomar a próxima decisão?*
- **Ordem:** B (medir carga cognitiva) → C (autoridade de caminhos) → D (decisões semânticas) →
  implementar A junto da simplificação do replan, "somente o que B/C demonstrarem necessário".
- **Nenhuma implementação de A, B, C ou D está aprovada.** Estado do código: sem alteração.
- **Regra:** nenhuma campanha cria nova fonte de verdade para informação que já exista em
  `GoalAttempt`, `ToolResult`, filesystem ou outro estado autoritativo existente. Primeiro medir e
  reutilizar; só criar representação nova diante de lacuna comprovada.
- **Rastreabilidade:** S294–S298 (commits `bf5518d`, `1ea77ea`, `0e6abd4`, `de4610f`) estão
  commitados **localmente e não foram enviados ao GitHub**. Working tree verificado limpo em
  24/09: `git diff`, `--ignore-space-at-eol` e `--ignore-space-change` vazios; blobs dos seis
  arquivos idênticos ao HEAD (o `M` era cache de metadados; `git add --renormalize` o limpou sem
  alterar conteúdo).

## Campanha B — medição da carga cognitiva (somente leitura)

Fonte: `newclaw-audit.log` inteiro (24/07–23/09/2026): 3 431 chamadas em streaming ao Ollama
(desfecho conhecido em ~3 200). Extração por `[STREAM] START/DONE/THINKING BUDGET`. Nada foi
instrumentado nem alterado.

| Hipótese | Medida | Resultado |
|---|---|---|
| **Contexto grande** | taxa de aborto × tokens de entrada; evolução no goal | **`glm-5.3-flash`: não sustentada.** Aborto em 25,4% das chamadas com < 1 000 tokens e 47,5% no grupo de mediana 703 tokens; na janela do goal a entrada mediana das abortadas (2 582) é igual à das concluídas (2 529); sem crescimento ao longo do goal (3 036 → 2 530 → 2 512). **`glm-5.2`: sustentada acima de 8k** (0,2–1,8% até 8k; 10,6% em 8–16k, n=66) |
| **Modelo verboso** | raciocínio, saída e duração das chamadas concluídas | `glm-5.3-flash`: raciocínio mediano 154 × 72 chunks (2,1×), saída 698 × 225 tokens (3,1×), duração 6,8 s × 2,8 s (2,4×). Aborto: 18,6% (79/425) × 1,3% (35/2 620); no período de coexistência (26/08–23/09) 18,6% × 0,0% (n=262). **Ressalva: os papéis diferem** (o `glm-5.2` atende sobretudo classificação/auxiliares; o flash atende os papéis pesados) — associação forte, causa **não isolada** |
| **Ações ruins** | attempts do goal | 12 attempts: 6 success, 5 partial, 1 failure; 5 de 7 passos `agentloop` ficaram `partial`; 3 replans; `same_tool_limit` 4× (exec_command ×3, read ×1); 13 mutações de plano |
| **Repetição de contexto** | leituras e crescimento intra-passo | o **mesmo arquivo de 60 824 B foi lido 6×** em 25 min; 2 saltos de contexto de 5,5–5,8× (12,8k → 74k caracteres) no passo em que ele entrou inteiro. No log inteiro: 52 eventos `context_growth`, razão mediana 2,8× |
| **Combinação** | custo dos abortos no goal | 16 abortos (28% das 57 chamadas do flash) descartaram **483 s = 31% dos 1 538 s**; as 41 concluídas do flash somaram 674 s. 14 das 41 concluídas usaram ≥ ~4 000 caracteres de raciocínio (metade do limite de 8 000) |

### Conclusão de B (fato × inferência × hipótese)

- **Fato:** para o `glm-5.3-flash` o aborto **não depende do tamanho do contexto** (mesma entrada
  mediana em abortadas e concluídas; alta mesmo com < 1 000 tokens). O custo é grande: 31% do tempo
  do goal em raciocínio descartado.
- **Inferência:** o principal fator é o **comportamento de raciocínio do modelo** (mais verboso que
  o `glm-5.2` em todas as métricas de chamadas concluídas), não o tamanho do prompt.
- **Consequência para a simplificação do replan:** o orçamento de contexto **não é o gargalo** para o
  flash — reduzir o prompt não deve ser vendido como correção dos abortos. Manter a projeção de A
  pequena continua válido (prompts > 8k tokens prejudicam o `glm-5.2` e o custo é somado), mas por
  outro motivo.
- **Hipótese em aberto (não provada):** que a causa seja o modelo e não o papel que ele exerce.
  O log **não registra o papel** de cada chamada (planner, executor, síntese, validador), então a
  separação modelo × papel não é possível só com leitura.
- **Não medido:** qualidade das respostas; quanto do fallback não-streaming se recupera depois de
  um aborto (o log não permite inferir com segurança).

### Como resolver a hipótese em aberto (decisão do usuário, nenhuma executada)

1. **Experimento controlado, sem alterar código:** repetir o mesmo pedido em instância isolada com
   `glm-5.2` nos papéis pesados e comparar a taxa de aborto e o tempo. É mudança de configuração,
   não de código; custa ~25 min de execução.
2. **Instrumentação mínima (mudança de código, só com aprovação):** registrar o papel (`role`) no
   log de cada chamada, para separar modelo × papel nas próximas medições.

---

## B1 — experimento controlado (24/09/2026): flash × `glm-5.3:cloud`

Sem alteração de código. Duas instâncias isoladas (skill `verify`; DB, workspace e porta próprios;
sem canais externos), sequenciais, mesmo pedido, mesmo commit (`de4610f`), estado limpo.
**Única variável:** o modelo dos 9 papéis pesados (`MODEL_CHAT/CODE/LIGHT/ANALYSIS/EXECUTION`,
`PLANNER/RISK/OBSERVER/CLASSIFIER`). `OLLAMA_MODEL=glm-5.2` (extrator de goal) igual nos dois.
Braço B usou `glm-5.3:cloud` por decisão do usuário (em vez do `glm-5.2` planejado).
Pasta das aulas: idêntica antes/depois (11 arquivos). Instâncias encerradas; portas livres.

| | A — flash (controle) | B — `glm-5.3:cloud` |
|---|---|---|
| Resultado do goal | **success** | **failed** (abandonado, 5 replans) |
| Duração | 1 722 s | 1 832 s |
| Ciclos / replans / attempts | 10 / 2 / 11 (9 ok, 1 parcial, 1 falha) | 12 / 5 / 10 (5 ok, 3 parciais, 2 falhas) |
| Chamadas em streaming (papéis pesados) | 44 | 59 |
| Abortos por orçamento de raciocínio | 10 (23%), 585 s = 34% do goal | 25 (42%), 674 s = 37% do goal |
| Chamadas concluídas: tempo mediano | 13,0 s | 2,7 s |
| Saída mediana / raciocínio mediano (chunks) | 1 020 tok / 212 | 416 tok / 237 |
| Entrada mediana | 2 592 tok | 2 725 tok |
| `exec_command` / `same_tool_limit` / mutações de plano | 7 / 2 / 7 | 26 / 7 / 14 |
| Releituras | 8 arquivos ≤ 17 KB, 2–4× | 1 arquivo de **324 KB** lido 4× |
| Chamadas do `glm-5.2` (auxiliares) | 13, 0 abortos | 19, 0 abortos |

### Leitura (fato × inferência × hipótese)

- **Fato:** trocar o flash pelo `glm-5.3:cloud` **não reduziu** os abortos (23% → 42%) e o goal não
  concluiu. A hipótese "o problema é o `glm-5.3-flash` em si" **não é sustentada**.
- **Fato:** o raciocínio mediano das chamadas concluídas é parecido (212 × 237 chunks); o `5.3`
  completo responde mais rápido (2,7 × 13,0 s) e com menos saída. O flash é mais verboso na
  **saída**, não no raciocínio que dispara o aborto.
- **Fato:** as chamadas auxiliares (`glm-5.2`, classificação) tiveram 0 abortos nos dois braços.
  Os abortos se concentram nos papéis pesados, com qualquer dos dois modelos da família GLM-5.3.
- **Inferência:** a hipótese **papel/tipo de tarefa** ganhou força; modelo ficou em segundo plano.
- **Fato (Problema 2):** o braço B gerou e releu 4× um arquivo consolidado de 324 KB, com
  26 chamadas de `exec_command` e 7 travas — trabalho redundante, de novo.
- **Limites:** n = 1 por braço (a diferença de desfecho — sucesso × falha — pode ser variância);
  instância isolada com memória vazia e modo `developer` (a produção usa `god`; igual nos dois
  braços); o teste do usuário em `localhost:3090` rodou em paralelo por alguns minutos durante o
  braço A; **`glm-5.2` nos papéis pesados não foi testado**.

### Decisão pendente (B2)

Registrar o papel no log de cada chamada continua sendo a forma de separar papel × modelo sem
repetir 30 min de execução; alternativa sem código: repetir os braços (n ≥ 3) e acrescentar um
braço com `glm-5.2`.

---

## B2 — instrumentação de papel/componente e primeira tabela real (24/09/2026)

**Conclusão provisória (decisão de 24/09, mantida):** *B1 não demonstrou que o modelo é a causa dos
abortos. A evidência atual desloca a investigação para a combinação modelo × papel × tarefa e para
o trabalho redundante produzido pelo AgentLoop, especialmente releituras e execuções repetidas.*

### O que foi instrumentado (observabilidade apenas)

- `ProviderFactory.chatWithFallback` virou um wrapper fino sobre o corpo original, **sem alterá-lo**;
  devolve o **mesmo objeto** de resultado (identidade verificada em teste) e emite uma linha
  `[LLM-CALL]` por chamada. Campo opcional `diag` em `ChatFallbackOptions` (mesmo padrão de opt-in
  de `anunciarSubstituicao`/`reasoningIntensive`); 13 chamadores informam componente/papel/fase
  (`goal` quando o chamador o conhece). Sem estado, banco ou contexto novos. Teste `S299` (17
  verificações, com controle negativo e guarda de completude para chamadores futuros).
- Campos: `component role phase goal cycle step model status fallback attempts aborted
  reasoning_chars in_est in out ms via`. Achado da primeira execução real: o campo `model` mostrava
  o pseudo-modelo `non-streaming-fallback` e escondia o modelo real — corrigido (`model` = primeira
  tentativa; `via=non-streaming`).
- Releituras de arquivo: já estavam no log (`READ-RESULT`); apenas contabilizadas, sem cache.

### Primeira tabela (instância isolada, `glm-5.3:cloud` nos papéis pesados, pelo painel; goal com sucesso em 867 s)

| Componente.fase | Chamadas | Abortos | Tempo (s) | Entrada mediana (tok) | Raciocínio descartado (chars) |
|---|---:|---:|---:|---:|---:|
| GoalPlanner.replan | 2 | **2/2** | 238 | 3 144 | 63 976 |
| RiskAnalyzer | 3 | **3/3** | 152 | 670 | 23 983 |
| GoalPlanner.plan | 1 | **1/1** | 118 | 3 594 | 31 997 |
| AgentLoop.loop | 7 | 2/7 | 101 | 5 812 | 15 995 |
| AgentLoop.synthesis | 2 | **2/2** | 56 | 2 156 | 15 981 |
| ObserverValidator.grounding | 2 | 0/2 | 51 | 2 280 | 0 |
| GoalExecutionLoop.completion-validator | 2 | 0/2 | 22 | 1 578 | 0 |
| contentStubClassifier / UnifiedIntentRouter / StepSemanticValidator | 3/3/2 | 0 | 22/18/14 | 338–942 | 0 |
| GoalExtractor / DomainRegistry | 1 / 2 | 0 | 9 / 63 | 348–1 248 | 0 |

Total: 30 chamadas, 864 s somados; 10 chamadas com aborto respondem por **637 s (74%)**.
Ressalva de método: as linhas anteriores ao ajuste de `model` mostram o modelo **configurado** para
o componente, não o observado.

### Leitura (fato × inferência × hipótese)

- **Fato:** os abortos se concentram em **quatro papéis**: planejador (plan/replan: 3/3),
  `RiskAnalyzer` (3/3), síntese do AgentLoop (2/2) e o passo do AgentLoop (2/7). Classificadores,
  validadores, juiz de grounding e extrator: **0 abortos**.
- **Fato:** o mesmo `glm-5.3:cloud` que abortou 100% no planejador não abortou no extrator de goal,
  no `DomainRegistry` nem no juiz de grounding (n pequeno). Junto com B1, o **papel** explica mais
  que o modelo.
- **Fato:** o `RiskAnalyzer` aborta com entrada mediana de **670 tokens** — prompt pequeno,
  raciocínio de 8–16 mil caracteres descartado. Confirma que o tamanho do contexto não é o gatilho.
- **Fato:** cada chamada abortada custa 50–136 s porque inclui as tentativas de retry e o fallback
  não-streaming dentro da mesma chamada (planejador: ~2 min).
- **Inferência:** o custo está nos papéis que **geram decisão estruturada com muito raciocínio**
  (planejar, revisar plano, sintetizar), e a repetição dessas chamadas por replan multiplica o custo.
- **Hipótese em aberto:** se o abortar-e-refazer do `RiskAnalyzer` (que revisa o plano) agrega valor
  proporcional a 2–3 chamadas de ~50 s; e por que o planejador precisa de ~32 000 caracteres de
  raciocínio. Ambas exigem olhar o conteúdo do prompt, não só métricas.
- **Limites:** n = 1 execução; instância isolada com memória vazia, modo `developer`; linhas do
  início no formato antigo de `model`.

### Próximo passo (decisão sua)

Ordem definida: B2 → analisar → C → D → A/contexto do replan. B fica candidato a fechar com esta
tabela; o que ela sugere investigar em seguida (sem código) é o **conteúdo** dos prompts do
planejador e do `RiskAnalyzer` (tamanho por bloco, repetição entre replans).

---

## B3 — anatomia dos prompts (somente leitura, 24/09/2026)

Sem alterar código, testes, configuração ou comportamento; a instrumentação **não** foi copiada
para a instalação principal. Fonte: o goal do B2 (`goal_1790264620894_7fo9o`, sucesso, 867 s).

**Método (o que é fato):** não há prompts persistidos (`agent_traces` guarda entradas/saídas de
ferramentas). Os prompts foram **reconstruídos chamando o código real** (`GoalPlanner.plan/replan`,
`RiskAnalyzer.reviewPlanWithLLM`, `buildMasterPrompt`, definições das ferramentas) com um
`providerFactory` falso que captura as mensagens em vez de chamar o modelo, alimentado pelo estado
do goal no banco. Validação contra o log: plano 12 708 × 14 376 caracteres medidos (resíduo 12%);
replan 1 9 413 × 11 500 (18%); replan 2 11 615 × 13 648 (15%); `RiskAnalyzer` 2 315–3 504 ×
652–806 tokens medidos (confere). **Resíduo não reconstruído:** bloco de capacidades (~824 chars,
medido no log como 206 tok), descrições de 7 ferramentas que não instanciei e o bloco de progresso.
Blocos nomeados só pelos marcadores que o próprio template define.

### Planejador e replan (caracteres; tokens ≈ /4)

| Bloco | plan | replan 1 | replan 2 | Repetido entre chamadas? |
|---|---:|---:|---:|---|
| Instruções estáticas (categorias de ferramentas, esquemas de args, avisos ⚠️, regras) | 11 080 (87%) | 7 440 (79%) | 7 440 (64%) | **sim** — idênticas |
| Dinâmico (objetivo, contexto, blocker, diversidade, alerta de loop) | 1 628 (13%) | 1 973 (21%) | 4 175 (36%) | não |
| Histórico / attempts / saídas de ferramentas | 0 | 0 | 0 | não entram no prompt |
| Não reconstruído (log) | 1 668 | 2 087 | 2 033 | — |

Comparação consecutiva (linhas idênticas): replan 1 reaproveita **72%** do plan; replan 2 reaproveita
**69%** do replan 1; **6 434 chars (~1,6 mil tokens) são idênticos nas 3 chamadas**. Conteúdo
exclusivo: plan 47%, replan 1 11%, replan 2 30%. **Não há acúmulo**: cada replan é um prompt novo
de 9–12 mil caracteres com o mesmo esqueleto e um cabeçalho dinâmico diferente.

### RiskAnalyzer (670 tokens, 3/3 abortos, 44–55 s)

- Prompt = ~2 150 chars estáticos (4 verificações + esquemas de `write`/`web_navigate`/`weather`/
  `send_audio` + formato JSON + lista de ferramentas) + objetivo (251) + passos (100–200 cada).
- **Tarefa:** "revise o plano; se precisar de ajuste, **devolva o plano completo corrigido**" (até
  5 passos com `toolArgs`) — julgamento + geração, com timeout fixo de 60 s.
- Diferente do juiz de grounding e do planejador, **não usa `reasoningIntensive`** (teto de 8 000
  chars de raciocínio em vez de 32 000) — fato de código (`RiskAnalyzer.callRiskLLM`).
- Linha do tempo da 1ª chamada: streaming abortou em **20 s** (8 014 chars, nenhum conteúdo) →
  fallback sem streaming respondeu com sucesso em **33 s**.

### AgentLoop

| Componente do custo | Tamanho | Fonte |
|---|---:|---|
| Prompt de sistema (`buildMasterPrompt`), categoria `execution`/`code` (as usadas) | 9 080 / 7 504 chars (~2,3 / 1,9 mil tok) | código real |
| Definições das 11 ferramentas enviadas por chamada | 8 527 chars (~2,1 mil tok); `memory_write` sozinho 2 412 (28%) | código real |
| Tokens reais por chamada do laço | 5 725–6 727 | log |
| Estimativa só das mensagens (`in_est`) | 2 506–3 791 | log |
| Excesso real − estimado | 2 800–3 100 tok = ferramentas (~2,1 mil) + envelope/template (~0,8 mil, **inferência**) | derivado |
| Crescimento por rodada de ferramenta no passo | +264 a +516 tok | log |

- A síntese (`in_est` 1 891–2 422) é **> 90% o mesmo prompt de sistema** de ~9 mil chars.
- **Fato de texto:** `JSON_FORMAT` (913 chars, anexado a **todo** prompt de sistema, inclusive
  o da síntese) diz "responda SEMPRE em JSON estruturado" e "**Pense uma vez, pense profundo**"; a
  síntese acrescenta "RESPONDA EM TEXTO PURO (NÃO use JSON…)". As duas instruções coexistem na mesma
  chamada. **Causalidade não provada** (ver hipóteses).
- Abortadas × concluídas no `AgentLoop.loop`: tamanho igual (2 506 e 3 791 × 3 009–3 602 tok). As
  abortadas são a **1ª chamada de um passo**, a **chamada após dois erros seguidos** (Traceback +
  erro de PowerShell) e as **sínteses**; as concluídas são as rodadas curtas após um resultado.

### O custo dos abortos (10 chamadas abortadas do goal)

Das 637 s: **376 s (59%) são raciocínio de streaming descartado** e 261 s (41%) são o retry/fallback
que **entregou o resultado**. **10 de 10 terminaram com `status=success`.** O planejador descarta
78–87 s de streaming (limite de 32 000 chars) e o fallback sem streaming conclui em 24–50 s.

### Resposta à pergunta de B3

| Fator | Veredito | Evidência |
|---|---|---|
| Volume de contexto | **Não** explica | abortos com 650–800 tok; abortadas e concluídas do mesmo tamanho |
| Repetição de contexto | **Sim, mas de instruções estáticas**, não de histórico | 51–68% dos prompts do planejador são idênticos entre chamadas; histórico e saídas de ferramentas nem entram no replan |
| Natureza da tarefa | **Sim** | abortam planejar, revisar plano, sintetizar e o 1º/depois-de-erro do laço; classificar/validar/grounding não |
| Instruções/sistema | **Provável, causalidade a testar** | 79–87% do planejador e >90% da síntese são instruções fixas; "Pense… profundo" + instrução contraditória na síntese |
| Histórico / resultados de ferramentas | **Não neste goal** | +264–516 tok por rodada; a releitura de arquivo grande (B1) é outro fenômeno |
| Desenho da trava + fallback | **Sim, fator de custo** | 59% do tempo abortado é descarte; 10/10 recuperados pelo fallback |

### Hipóteses em aberto (nenhuma testada; nenhuma correção proposta)

1. As instruções de "pensar fundo"/JSON obrigatório aumentam o raciocínio do `AgentLoop`.
2. O fallback sem streaming conclui mais rápido que o raciocínio em streaming (causa desconhecida:
   comportamento de raciocínio diferente entre os modos?).
3. As 11 mil chars de regras do planejador são o que exige 32 000 chars de raciocínio.
4. `RiskAnalyzer` sem `reasoningIntensive` é inconsistência de configuração ou decisão deliberada.

Cada uma exigiria um experimento controlado (chamadas reais ao modelo), não mais leitura.

---

## Nota de rastreabilidade — repetição ≠ redundância (decisão de 24/09)

A "repetição" medida em B3 (6 434 caracteres idênticos nas três chamadas do planejador) são
**instruções estáticas**. Elas podem ser necessárias, parcialmente necessárias ou redundantes — **ainda
não sabemos**. **Repetição observada ≠ redundância comprovada.** Nenhuma instrução deve ser removida
apenas porque aparece repetida. A (projeção factual no replan) continua congelada.

## B4 — conflito JSON × texto puro na síntese do AgentLoop (experimento isolado, 24/09/2026)

**Escopo:** somente experimento controlado. Nenhum código definitivo alterado, nada commitado como
solução; scripts em diretório temporário fora do repositório.

**Desenho.** Mesmas mensagens de síntese que `AgentLoop.runSynthesisAndFallbackPhase` monta
(`[system: prompt-mestre da categoria execution]`, `[user: [GOAL STEP] …]`, `[tool: resultado ≤ 1 200
chars]`, `[system: "SÍNTESE FINAL OBRIGATÓRIA — RESPONDA EM TEXTO PURO (NÃO use JSON…)" + corpo]`),
chamadas reais em streaming ao `glm-5.3:cloud` com a mesma forma de requisição do `OllamaProvider`
(`num_ctx` 32 768, `tools: []`), **sem** o corte de 8 000 caracteres (medindo o raciocínio até o 1º
conteúdo e o tempo total; "≥ 8000" = teria abortado). Três braços, **só o prompt de sistema varia**:
V0 atual; V1 sem o bloco `JSON_FORMAT` inteiro; V2 com `JSON_FORMAT`, sem a frase "Pense uma vez,
pense profundo" (separa as duas coisas que o mesmo bloco carrega). Três casos com dados reais: A
listagem da pasta (bem-sucedida), B erro real de Python capturado no log, C leitura de um `.docx`.
Ordem embaralhada dentro de cada bloco. Corte 1: 3 casos × 3 repetições × 3 braços = 27. Como a
amostra por célula era pequena, corte 2 (mesma configuração, só o caso B): 10 repetições × 3 = 30
(**decisão tomada depois de ver o corte 1 — resultado exploratório**).

### Resultados

| Caso | Braço | n | Raciocínio antes do 1º conteúdo (mediana) | ≥ 8 000 (teria abortado) | Tempo total (mediana) |
|---|---|---:|---:|---:|---:|
| A e C (18 chamadas) | todos | 18 | 0,7–2,6 mil | **0/18** | 2–8 s |
| B erro (corte 2) | V0 atual | 10 | 13 507 | **8/10** | 23,1 s |
| B erro (corte 2) | V1 sem `JSON_FORMAT` | 10 | 7 666 | **4/10** | 16,4 s |
| B erro (corte 2) | V2 sem "pense profundo" | 10 | 13 828 | 7/10 | 20,4 s |
| B erro (cortes 1+2) | V0 / V1 / V2 | 13 cada | 12 370 / 7 481 / 12 760 | 11/13 / 5/13 / 9/13 | — |

Testes (corte 2, raciocínio): V0 × V1 Mann-Whitney p≈0,06; V0 × V2 p≈0,76. Proporção ≥ 8 000: V0
8/10 × V1 4/10, Fisher p≈0,17 (cortes juntos 11/13 × 5/13). Todas as 57 chamadas terminaram `ok`.

### Leitura (fato × inferência × hipótese)

- **Fato:** o raciocínio longo aparece **só no caso "explicar um erro"** (B): nos casos A e C, 0 de
  18 chamadas passou de 8 000 caracteres em qualquer braço. **A natureza da tarefa domina.**
- **Fato:** no caso B, **remover o bloco `JSON_FORMAT`** reduziu a mediana de raciocínio (~13,5 mil →
  ~7,7 mil, −43%), a fração que teria abortado (8/10 → 4/10) e o tempo (23,1 → 16,4 s). Sinal
  **borderline** (p≈0,06 no corte 2; exploratório por causa da amostra estendida).
- **Fato:** remover **só** "Pense uma vez, pense profundo" **não mudou nada** (p≈0,76). A frase não é
  o gatilho.
- **Inferência:** a presença do bloco de formato JSON obrigatório na síntese está associada a mais
  raciocínio quando há um erro a explicar.
- **Não isolado (hipótese):** V1 remove o bloco todo; não separa "exigência de JSON" de "**conflito**
  com a instrução de texto puro". O teste limpo do conflito seria um braço V3 com `JSON_FORMAT` mantido
  e **sem** a instrução "TEXTO PURO" (instruções consistentes). Não executado.
- **Limites:** modelo único (`glm-5.3:cloud`); prompt de sistema reconstruído só com o prompt-mestre
  (sem bloco de memória nem histórico real do laço); chamadas diretas ao Ollama, sem a trava do
  NewClaw; um tipo de erro; latência de nuvem variável (o Ollama do usuário foi reiniciado/atualizado
  para a 0.34.4 durante a sessão, ~4 min de indisponibilidade antes do experimento — sem efeito nas
  chamadas medidas); efeito borderline e exploratório.

### Estado das demais frentes

B5 (instruções estáticas do planejador), B6 (`reasoningIntensive` do `RiskAnalyzer`) e B7 (streaming →
fallback) **não foram iniciadas**. Regra mantida: nenhuma correção durante a medição.

---

## B4 — fechamento com V3 (24/09/2026): o conflito NÃO é a causa

Mesmo desenho e mesmo caso (B, síntese após erro real), agora com **quatro braços embaralhados na
mesma sessão** (10 repetições cada, 40 chamadas, todas `ok`), para que V3 seja comparado com
controles contemporâneos. Verificação prévia por texto, antes de rodar: mensagens de usuário e de
ferramenta idênticas nos quatro braços; V3 tem o **mesmo prompt de sistema do V0** e difere só na
instrução de síntese (sem "TEXTO PURO / NÃO use JSON / linguagem natural").

| Braço | `JSON_FORMAT` | "texto puro" | "pense profundo" |
|---|---|---|---|
| V0 atual | sim | sim | sim |
| V1 | **não** | **sim** (mantida — ver correção abaixo) | não (vem junto do bloco) |
| V2 | sim | sim | **não** |
| **V3** | sim | **não** | sim |

**Correção de registro:** na tabela de planejamento o V1 constava com "texto puro: não". No que foi
executado (B4 e agora), o V1 removeu só o `JSON_FORMAT`; a instrução de síntese em texto puro
**permaneceu**. Não muda a lógica (V1 e V3 são os dois braços "sem conflito"), mas fica registrado.

| Braço | Raciocínio antes do 1º conteúdo (chars): mediana [mín–máx] | ≥ 8 000 (teria abortado) | Tempo total mediano (p90) | Resposta em JSON |
|---|---|---:|---:|---:|
| V0 atual | 8 979 [2 118–47 287] | 5/10 | 14,0 s (64 s) | 1/10 |
| V1 sem `JSON_FORMAT` | 4 252 [1 360–13 062] | 3/10 | 6,7 s (20 s) | 2/10 |
| V2 sem "pense profundo" | 10 956 [3 141–34 437] | 6/10 | 16,0 s (47 s) | 0/10 |
| **V3 sem "texto puro"** | **38 146 [12 984–101 711]** | **10/10** | **49,4 s (143 s)** | **10/10** |

### Leitura (fato × inferência × hipótese) — análise descritiva, sem alegar significância

(O corte 2 do B4 foi decidido depois de ver o corte 1; por isso nenhuma conclusão aqui é "prova".)

- **Fato:** **remover a instrução conflitante piorou muito.** V3 raciocinou ~4× mais que V0 (mediana
  38 mil × 9 mil caracteres), todas as 10 chamadas passariam do teto de 8 000, e **10/10 responderam
  em JSON**. Os valores mal se sobrepõem (mínimo do V3, 12 984, está acima da mediana do V0, 8 979).
  **A hipótese "o conflito JSON × texto puro faz o modelo raciocinar mais" não se sustenta; o dado
  aponta o contrário.**
- **Fato:** a instrução de texto puro **protege**: com ela (V0/V2) 9–10 de 10 respostas saem em texto;
  sem ela (V3), 10/10 saem em JSON e o raciocínio explode.
- **Fato:** sem o bloco `JSON_FORMAT` (V1) o raciocínio é o menor (mediana 4 252; 6,7 s), coerente
  com o B4.
- **Fato:** a frase "Pense uma vez, pense profundo" continua sem efeito visível (V2 ≈ V0).
- **Fato (dentro do braço):** as chamadas que responderam em JSON raciocinaram mais que as em texto
  (V0: 18 507 × 7 806; V1: 11 997 × 3 672) — n minúsculo, só consistente com a leitura abaixo.
- **Inferência:** o que está associado a mais raciocínio é o **contrato de saída JSON estruturado**
  (`thought`, `action`, `confidence`, `is_complete`…) — quando o modelo o segue, delibera muito; a
  instrução de texto puro o desvia parcialmente. O conflito em si não é o mecanismo.
- **Hipótese em aberto (não testada):** as chamadas do **laço com ferramentas** do `AgentLoop`
  também recebem o `JSON_FORMAT` e **não** têm nenhuma instrução de texto puro — seria análogo ao V3.
  Pode explicar parte dos abortos do laço (2/7 em B2; primeira chamada de um passo e chamada após
  erro). Exigiria um experimento com ferramentas, não esta reconstrução.
- **Variabilidade entre execuções:** a mediana do V0 hoje (8 979) difere das anteriores (12 370–13 507
  com o mesmo prompt). Só comparações contemporâneas dentro de uma mesma sessão são confiáveis.
- **Limites (inalterados):** modelo único; prompt-mestre sem bloco de memória nem histórico do laço;
  chamadas diretas ao Ollama sem a trava do NewClaw; um tipo de erro; cloud com latência variável.

### Consequência para a decisão de projeto (sem correção proposta)

Nenhuma alteração é sustentada por B4: remover a instrução de texto puro, que seria a leitura
ingênua da hipótese original, **agravaria** o problema. B4 fica **concluído**: o conflito foi
testado e refutado como causa; o efeito do contrato JSON fica como achado a investigar no laço com
ferramentas. Regra mantida: nenhuma correção durante a medição.


---

## B4.1 — AgentLoop real com ferramentas reais: onde o fato vira estado e onde deixa de ser fatual (24/09/2026)

**Pergunta:** quando o NewClaw executa um AgentLoop real com ferramentas, onde o fato produzido pela ferramenta
é transformado em estado, e em que ponto esse estado deixa de ser factual e passa a ser reinterpretado
desnecessariamente?

**Método (nenhum arquivo do repositório alterado; nada commitado).** Instância isolada (porta própria, DB/workspace
próprios, sem canais externos, `developer`, `glm-5.3:cloud` nos papéis pesados), com um **shim de observação fora
do repositório** que só registra e repassa: toda chamada ao LLM (mensagens completas e resposta), o resultado
**bruto** de cada ferramenta e o que o `StepSemanticValidator` recebe/decide. Mesmo pedido das aulas. Resultado do goal:
`failed` (12 ciclos, 5 replans, 1 080 s). Capturados: 50 chamadas LLM, 23 execuções de ferramenta, 7 validações.
Pasta das aulas idêntica antes/depois. Erro de método corrigido no caminho: a 1ª versão do shim importava módulos do
projeto antes do `.env` (o `index.ts` carrega o `.env` antes de tudo) — reiniciada com a ordem correta.
**n = 1 execução**; comparações são estruturais, não estatísticas.

### Fronteira 1 — ferramenta → observação → próxima decisão (fluxo "factual"): **fiel**

- **11 de 11** resultados de ferramenta localizados no pedido seguinte são **idênticos** ao bruto (sem truncar,
  sem anotar, sem reescrever). Esse cruzamento **não perde nem reinterpreta** o fato.
- O modelo **não responde em JSON no laço**: **11 de 11** chamadas do laço foram **chamadas nativas de ferramenta**
  (0 JSON de ação); as 4 sínteses vieram em texto. O contrato `JSON_FORMAT` do prompt de sistema é, no laço, inerte —
  a hipótese "JSON_FORMAT causa o problema do laço" **não se sustenta nesta execução**.

### Fronteira 2 — onde o fato deixa de ser factual: o encerramento do laço por guarda determinística

`SAFETY-GUARD` (log do servidor) nesta execução: `same_tool_limit` 1×, `context_growth` 3× (`ratio_limit` 4,64 e 4,04;
`absolute_limit` 17 124 > 16 000). **Cada `context_growth` disparou logo depois de o modelo ler o arquivo de que o
passo precisava** (`aulas_content.txt`, 36 KB / 16 KB por leitura) e **antes** de qualquer gravação. Sequência, nos 3 casos:

```
read do arquivo necessário (observação fiel)
  → guarda context_growth encerra o laço (o sistema SABE: "encerrado por guarda antes da ação")
  → síntese forçada: o LLM recebe só o ÚLTIMO resultado truncado a 1 200 chars + "Confirme O QUE foi realizado"
  → saída = intenção ("Vou criar o arquivo da proposta agora mesmo…")
  → Observer(qualidade, LLM, 11–27 s, até 23 mil chars de raciocínio) → approved:false
  → Grounding (LLM) → {"claims":[]}
  → StepSemanticValidator (LLM) → mismatch
  → blocker (texto) → replan (LLM) → RiskAnalyzer (LLM)
```

- O fato **estruturado** "o passo foi cortado pela guarda X antes de produzir o entregável" existe no instante
  da guarda e **vira texto livre** (a síntese) que **três juízes reinterpretam** para redescobrir o que o sistema
  já sabia. Para os 3 eventos: 12 chamadas LLM e ~122 s entre a guarda e o veredito.
- É o **segundo fluxo** do desenho da campanha (interpretação → mensagem → volta como "resultado" → validador →
  replan), com a origem localizada: **não é "prompt grande"; é a guarda tratando uma observação legítima e grande
  como anomalia**, seguida de uma síntese pedida para um passo que não aconteceu.
- Frequência (log de produção inteiro): 58 eventos `context_growth` (52 `ratio_limit`, 6 `absolute_limit`);
  **26 (45%)** seguidos de síntese forçada em ≤ 3 s. Mecanismo **recorrente, não universal**. Na produção, o goal de
  23:15 mostra o mesmo padrão (23:02:54 `absolute_limit` 16 855 logo após o `read` de `extracao_aulas.txt`).
- **Não provado:** que mudar limiares/contrato da guarda melhoraria o desfecho (não testado; decisão de autoridade
  pendente — *o que uma guarda pode fazer com uma observação legítima?*).

### Fronteira 3 — replan (prompts reais capturados)

O replanner recebe: objetivo, **texto do blocker** (descrição truncada a **200 caracteres** em `GoalEvaluator.ts:520/570`),
blockers anteriores, estratégias tentadas, progresso, memória. **Não recebe attempts/saídas** (confirma B3 com prompts
reais). Os nomes `extract_content`/`aulas_content` chegam **só por texto de blocker/estratégia** (a partir do replan #25).

### Correção de um relatório anterior (S295)

**A correção S295 não chega ao planejador para caminhos longos.** O erro bruto do `read` tem 701 caracteres e
"Raízes permitidas" começa no caractere **208**; o blocker guarda os primeiros **200**. No replan #27 o marcador
**não aparece** e no replan #25 o planejador **escolheu de novo** `read` em pasta externa. A descrição do `read`
também não chega ao planejador (ferramentas "padrão" são omitidas de `buildToolDescriptions`). **Status: parcial
(corrige a mensagem da ferramenta; a evidência não atravessa a fronteira até o replanner).**

### Outros fatos da execução real

- **Windows:** `python3` resolve para o *stub* da Microsoft Store (`exit 9009`, 3 ocorrências); o modelo descobriu em
  345 s um Python real (`…\msys64\ucrt64\bin\python3.exe`) e o **esqueceu no passo seguinte** (repetiu `python3` em 641 s):
  fato de ambiente descoberto num passo **não persiste** entre passos (cada `AgentLoop` de passo começa com "0 recent
  msgs"). O probe de ambiente checou `pandoc/marp/pip3/node/npm/ffmpeg`, **não o interpretador Python**.
- **Caminho (duas autoridades) persiste:** o planejador escreveu `python extract_content.py` (raiz) e o `AgentLoop`
  gravou `tmp/extract_content.py` → `exit 2` (421 s). S296 só cobre `write` rebaixado **com** `toolArgs`; aqui o passo
  já era `agentloop` sem argumentos.
- **`StepSemanticValidator` devolveu JSON inválido em 2 de 6** validações ("LLM sem JSON válido" → `unverifiable`):
  o validador degrada silenciosamente.
- **Distribuição do tempo de LLM nesta execução (1 006 s, 50 chamadas):** planejar/replanejar/revisar plano **57%**
  (10 chamadas, 569 s: replan 32%, RiskAnalyzer 19%); julgar 19% (15 chamadas); executar (laço + síntese) **22%**;
  classificar 3%. Em B2/produção o `AgentLoop` foi maior (64% no goal de 23:15 com flash). **"O AgentLoop é o custo
  dominante" não vale universalmente** — depende do modelo e da execução.

### Conclusão de B4.1 (a decisão sobre a arquitetura continua PENDENTE)

1. A fronteira **ferramenta → observação** é fiel. O fato factual é perdido **depois**, no encerramento do laço por
   guarda e na síntese forçada que transforma um passo **não executado** em "resultado".
2. Esse resultado sintético é reinterpretado por **três juízes LLM em série** sobre um fato **que o sistema já
   conhecia de forma estruturada**.
3. Isso **corrobora** (com origem localizada) a violação de fronteira de estado apontada pelo protocolo, **mas com uma
   causa de entrada diferente da hipótese "JSON/contrato"**: a guarda de crescimento de contexto.
4. O AgentLoop opaco **não** é demonstrado como causa primária; o custo de planejar/revisar plano é maior nesta execução.
5. **Nenhuma correção proposta nesta fase.** Decisões pendentes: (a) o que uma guarda pode fazer com observação legítima;
   (b) se a síntese forçada deve existir para passo cujo entregável não foi produzido; (c) como um fato **estruturado**
   ("encerrado por guarda X") atravessa até o validador; (d) persistência de fatos de ambiente entre passos.

Nota multiplataforma: o `python3`-stub é específico do Windows, mas a causa conceitual (fato de ambiente não persistido
entre passos) é comum aos três sistemas.


---

## B4.1.x — Cadeia observação → `context_growth` → síntese forçada → juízes → estado seguinte (25/09/2026)

Somente leitura: nenhum código de produção alterado; S299 não copiado para a instalação. Fontes: código
(`AgentLoop.ts` `checkContextGrowthGuard` ~3478–3590, blocos de síntese ~2105/2181), captura B4.1 (`capture.jsonl`,
n=1) e o log de produção de 23/09.

### A. Entrada
Não é `ToolResult`, Observation nem resultado do Grounding: é o **array `loopMessages` inteiro**; a métrica soma
`content.length` de todas as mensagens.

### B. Condição determinística
`stepCount>1 && !dedupAbort` e (`atual/inicial > 2.5` com base mínima 4 000 chars, **ou** `atual−inicial > 16 000` chars).
Mede **caracteres acumulados**, não tokens nem nº de mensagens, e não distingue crescimento por anomalia de
crescimento por **observação legítima** (um `read` de arquivo necessário). Se `lastTool==='read' && !writeToolsUsed`
concede +2 passos uma única vez — **exceto** quando `ANALYSIS_INTENT_PATTERN.test(userText)` é verdadeiro. O `userText` de
um passo de goal contém o objetivo global ("analisar…"); nos 4 prompts `[GOAL STEP]` capturados a regex casou
(`analis`/`avali`/`verifi`): **a extensão nunca foi concedida**.

### C. Cadeia
guarda → `dedupAbort=true`, `dedupAbortTool='context_growth:<motivo>'` → síntese com 4 mensagens
[system mestre, último user, **último** tool message truncado a 1 200, instrução de síntese] → texto → Observer
(qualidade) → Grounding → StepSemanticValidator/promoção → `GoalAttempt` (output 300 B/8 000 B) → blocker (`slice(0,200)`)
→ replan → RiskAnalyzer. A instrução de síntese afirma "o loop foi interrompido porque a ferramenta
`context_growth:absolute_limit` foi chamada repetidamente" (**causa falsa**: não é ferramenta) e lista só
`nome: success`.

### D. Antes × depois da síntese (captura, 4 sínteses)
| síntese | resultados de ferramenta no passo | bruto | preservado na síntese |
|---|---|---|---|
| #22 (same_tool) | 5 (3 exec, 1 write, …) | 1 593 | só o último exec (812); **4 de 5 resultados somem**, incl. o `write` ok |
| #45 | 7 | 43 835 | último `read`: 1 200 de 36 400 (3 %); os outros 6 somem |
| #61 | 2 | 16 427 | 1 200 de 16 370 (7 %) |
| #69 | 1 | 36 677 | 1 200 (3 %) |
Nenhuma instrução de síntese continha o entregável do passo nem o caminho de qualquer arquivo produzido antes.
Saídas: intenção ("Vou criar o arquivo…") em #45/#61/#69; #22 disse "Etapa concluída com sucesso" após 4 resultados
descartados. **Fato objetivo perdido:** resultados anteriores de ferramenta (caminhos, sucessos, saídas) e o próprio
motivo estruturado do corte; sobra só o último resultado truncado + uma causa incorreta.

### Produção (23/09, 23:02:54)
`read` de `tmp/extracao_aulas.txt` (59,4 KB, 1 833 linhas) → `absolute_limit` 16 855 → "Trimmed context: 18 → 4
messages" → síntese de **2 287 chars** (aqui **não** foi intenção, ao contrário da captura) → Observer LLM
`approved=false conf 0.88` ("planejado GRAVAR `extrator_aulas.py`, executado só `read`") → **mesmo assim** o passo
fechou `outcome=success` por `SEMANTIC-PROMOTE` (9/20 termos, conf 0.75). Passo 3 então leu `aulas_extraidas.md`
(nome que nunca existiu) → blocker `tool_error`. **Não provado:** que a síntese tenha feito o nome
`tmp/extracao_aulas.txt` desaparecer — o `aulas_extraidas.md` do passo 3 pode ter vindo do plano original; precisa
verificar o plano. O que está provado: o Observer discordou e o veredito foi sobrescrito por heurística de palavras.

### S295 (truncamento) — mesma cadeia?
Parcialmente **irmã, não a mesma**: o erro do `read` (701 chars) passa pelo blocker (`GoalEvaluator.ts:520/570`,
200 chars) sem Grounding nem síntese; a causa é o limite do blocker. Mas é o mesmo *padrão* — fatos truncados em
fronteiras de estado. Inventário: blocker 200 · `attempt.output` 300/8 000 (`attemptOutputLimit`) ·
`GoalExecutionLoop:2947/2960/3036/3250/3332` 200 · síntese 1 200 (`AgentLoop:2105/2181`) · semântico 500/600 ·
hint 500. **Registrada como subquestão independente**; correção holística proposta em conjunto com a decisão 3.

### Conclusão
O contrato "Grounding → passo" é **consequência**; a fronteira que corrompe estado é mais cedo:
**guarda de caracteres que trata observação legítima como anomalia + síntese que só recebe 1 200 chars do último
resultado e uma causa falsa**. Alternativas (todas PENDENTES, nada aprovado): (i) fato estruturado "passo encerrado
por guarda X sem entregável" propagado ao validador/planner em vez de texto reinterpretado; (ii) síntese
alimentada por todos os resultados do passo (evidência), não só o último truncado; (iii) guarda que não trate
`read` legítimo como anomalia. "Repetição observada ≠ redundância comprovada" registrada.

### B4.1.x — Origem de `aulas_extraidas.md` (25/09/2026; somente leitura)

Fontes: log de produção e linha do goal `…ov9eh` em `newclaw.db` (aberto `mode=ro`). **Limite:** `current_plan` guarda só
a geração vigente; os planos das gerações 0/1 não são persistidos nem logados por inteiro — só `attempts`
(com `planStepId`, `args`, `planGeneration`), `blockers`, `strategies_tried`, `REPLAN_DIFF` e `Q2 risks`.

Cronologia:
1. 22:55:23 replan 1 (blocker `semantic_mismatch`). Nenhum blocker anterior contém `aulas_extraidas`.
2. 22:56:45 plano geração 1 (Planner), 22:57:44 RiskAnalyzer ajusta (`planAdjusted=true`). **Primeira ocorrência do nome no
   log inteiro**: os riscos do RiskAnalyzer dizem "Falta um step `read` explícito de `aulas_extraidas.md`". Ou seja, o nome
   já existia no plano/na análise **antes de qualquer execução da geração 1**.
3. 22:58:39 o `AgentLoop` do step_1 grava `extrator_aulas.py` e gera **`tmp/extracao_aulas.txt`** (nome escolhido na execução).
4. 23:02:54 `context_growth` (dentro desse mesmo step_1) → síntese → promoção; 23:04:53 step_1 `success`.
5. 23:04:54 step_2 `exec_command` `python extrator_aulas.py` (sem argumentos; o script grava seu default `tmp/extracao_aulas.txt`).
6. 23:05:01 step_3 `read aulas_extraidas.md` → não existe → blocker `tool_error`.

Classificação: **terceira cadeia**, nem a hipótese 1 nem a 2 exatamente:
```
Planner/RiskAnalyzer (geração 1): plano promete  aulas_extraidas.md
AgentLoop (execução step_1):       produz         tmp/extracao_aulas.txt   (nome escolhido em runtime)
context_growth + síntese:          não introduz nem apaga nenhum dos dois nomes (o nome do plano já existia)
step_3 do plano:                   lê             aulas_extraidas.md       → falha
```
A síntese **não** é a origem do nome. A divergência é a "duas autoridades de caminho" já registrada (E3): o plano fixa
um caminho, o AgentLoop escolhe outro, e nenhum fato liga os dois. O que a guarda/síntese acrescentam é outra coisa: o
fato "produzi tmp/extracao_aulas.txt" só existia no `output` do exec (`Extração concluída: tmp/extracao_aulas.txt`) e
em texto de síntese; o step_3 do plano nunca o consulta.

Não provado: se o nome nasceu no Planner ou no RiskAnalyzer (o ajuste do plano não é persistido por geração).
Nenhuma correção proposta; decisão sobre guarda, síntese e/ou contrato de estado continua PENDENTE.

### E3 — autoridade do caminho: planned path → resultado real → attempt → próximo passo (25/09/2026; somente leitura)

Duas linhas separadas (decisão do operador): **E3** (este bloco) e **perda de estado por `context_growth`** (linha
independente, já documentada acima; não se mistura aqui).

Respostas às 7 perguntas, com arquivo/linha:
1. **Caminho planejado** — `PlanStep.toolArgs.path` (persistido em `goals.current_plan`; só a geração vigente). Aqui:
   `{"path":"aulas_extraidas.md"}` no step_3 `read`. Sem registro por geração.
2. **Caminho produzido** — como **texto** no `output` do attempt (`exec_command`: "Extração concluída: tmp/extracao_aulas.txt (9 arquivos
   processados)", persistido em `goals.attempts`). Como dado estruturado o campo existe — `GoalAttempt.producedArtifactPaths`
   (`GoalExecutionLoop.ts:2615`, `artifactContract.ts`) — mas **estava `null` nos 12 attempts** do goal.
3. **`ToolResult`** — tem o campo estruturado `artifactPaths` (`agentLoopTypes.ts:8`), preenchido só por: `write` substantivo
   (`write_tool.ts:172`) e linhas `ARTIFACT: <path>` verificadas no stdout de `exec_command` (`exec_command.ts:653`). O `python`
   gerado pelo LLM gravou o arquivo sozinho e não emitiu `ARTIFACT:`. A convenção `ARTIFACT:` **não aparece em nenhum prompt**
   (só em código/tipos): o produtor (LLM) nunca é instruído a usá-la.
4. **Attempt** — preserva o texto bruto (8 000 B para agentloop). O step `agentloop` é um attempt opaco: escritas internas
   não chegam a `producedArtifactPaths` (só `deferredSends` viram pseudo-attempt, `GoalExecutionLoop.ts:2640–2668`).
5. **Próximo passo** — um `read` com `toolArgs.path` executa **o path do plano, literal**; nada o reconcilia com evidência.
   `priorStepEvidence` (`GoalExecutionLoop.ts:2410`) só alimenta o **Grounding do AgentLoop**, só da mesma `planGeneration`,
   só `success`, e não é consultado para despachar `read`.
6. **Autoridade** — na prática, o **plano** (toolArgs), por omissão: não há componente que arbitre plano × fato para `read`.
   Para `send_document` **existe** arbitragem por evidência (`resolveArtifactPathFromEvidence`: `RiskAnalyzer.ts:668` em tempo
   de plano; `GoalExecutionLoop.ts:1337` no envio diferido).
7. **Mecanismo existente** — sim: `goal.attempts.producedArtifactPaths` + `resolveArtifactPathFromEvidence`. Não seria estado novo.

Replan: `buildReplanPrompt` não recebe attempts nem artefatos (só texto de blocker/estratégia); o blocker perde o restante do
erro após 200 chars.

Achado adicional: mesmo que `producedArtifactPaths` estivesse preenchido com `tmp/extracao_aulas.txt`,
`resolveArtifactPathFromEvidence` o **descartaria**: `inferExpectedExtensions` devolve `[.xlsx,.xls]` para este pedido ("Excel" no
caminho da pasta), e `matchesExpected` exige essas extensões. Ou seja, o contrato existente falharia por outra causa já
registrada (decisão 5). Não testado em execução; leitura de código.

**Classificação de E3:** *contrato existente, mas não propagado* — com duas lacunas nomeáveis e independentes:
(a) **produtor**: o campo estruturado só é preenchido por `write` direto e por `ARTIFACT:` opt-in não ensinado; caminhos criados
por subprocessos e por escritas dentro do `agentloop` ficam só em texto; (b) **consumidor**: só `send_document` consulta a
evidência; `read` (e replan) obedecem ao plano. A formulação "duas autoridades" **não** se sustenta: há uma autoridade
correta (`attempts`) que uma projeção intermediária não recebe. Não provado: que preencher o campo e/ou estender o consumidor
resolveria o incidente (não testado). Nenhuma correção proposta; opções (guarda+contrato, projeção dos attempts, planner,
replan) permanecem PENDENTES.
