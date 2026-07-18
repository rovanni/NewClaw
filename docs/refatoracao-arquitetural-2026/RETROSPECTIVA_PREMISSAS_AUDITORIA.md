# Retrospectiva — Premissas da Auditoria que Não Se Sustentaram na Execução

**Data:** 2026-07-18 (atualizado com os casos S16, S17, S18 e S21). **Escopo:** Sprints
`2026-07-S01` a `2026-09-S21` do Programa de Refatoração Arquitetural (`MASTER_EXECUTION_PLAN.md`),
cards ARCH-001 a ARCH-023 (parcial) + ARCH-005/008/009/010/013/018. **Motivo deste documento:** ao
final da S11, o usuário perguntou diretamente por que premissas erradas estavam se repetindo e
pediu um catálogo consolidado — não bug a bug, mas como retrospectiva de processo, para melhorar a
auditoria em si, não só corrigir os sintomas encontrados até agora.

## Por que isto importa

`ARCHITECTURAL_BACKLOG.md` é descrito como a consolidação de 4 auditorias ("Auditoria I —
Duplicação de Decisões", "II — Duplicação de Conhecimento", "III — Complexidade Acidental", "IV —
Violação de Fronteiras Arquiteturais"), todas conduzidas na mesma sessão de engenharia, cobrindo
26 cards. Das **19 Sprints já executadas** (incluindo `S14`, `S17`, `S18` e `S21`, todas adiadas na
Fase 1/2 antes de qualquer código ser escrito — ver casos abaixo), **15 tiveram a premissa/desenho
original do card corrigido durante a execução** — não são exceções, são a maioria, cada vez mais
larga. Isso não
invalida o backlog (o diagnóstico de ALTO NÍVEL — "existe duplicação/acoplamento aqui" — se
confirmou em todos os casos), mas invalida a confiança de que o TEXTO ESPECÍFICO de cada card
(contagens, alegações sobre estrutura de dados, equivalência entre padrões, viabilidade da
PRESCRIÇÃO em si — S14 —, e agora até a EXISTÊNCIA do mecanismo citado como motivação — S17) pode
ser implementado sem reverificação.

## Catálogo — premissa original vs. achado real vs. causa raiz

### S01 / ARCH-001 — Import de `ToolExecutor`/`ToolResult`
- **Premissa do card:** 24 arquivos em `tools/` + `core/ToolRegistry.ts` (25 total).
- **Achado real:** 26 arquivos — `tools/ToolRegistry.ts` (distinto de `core/ToolRegistry.ts`) não
  estava contado; 2 outros arquivos (`AgentController.ts`, `agentControllerCommands.ts`) que o
  grep bruto pegou eram falso-positivo (importam a classe `AgentLoop`, não os tipos-alvo).
- **Causa raiz:** contagem sem grep exaustivo — o card citava um número específico ("24") sem
  anexar o comando usado para chegar nele, sinal de que foi contagem manual/por amostragem.

### S02 / ARCH-004 — Migrar tipos de `GoalTypes` usados por `memory/`
- **Premissa do card:** listava 4 tipos (`Goal`, `PlanStep`, `AttemptOutcome`, `BlockerKind`)
  como se fossem movíveis independentemente.
- **Achado real:** `Goal` referencia transitivamente mais 6 tipos (`GoalStatus`, `GoalBlocker`,
  `SuccessCriterion`, `GoalAttempt`, `ToolMutation`) que tiveram que migrar juntos.
- **Causa raiz:** a auditoria listou os tipos **importados diretamente** pelos consumidores
  (`memory/`), mas não seguiu o grafo de dependência **dentro do arquivo de origem**
  (`GoalTypes.ts`) antes de estimar o que "mover" realmente envolvia.

### S03 / ARCH-006 — Accessor único `getPendingSteps`
- **Premissa do card:** "6+ call sites" (com 6 linhas específicas citadas como exemplo).
- **Achado real:** 15 call sites reais do mesmo predicado.
- **Causa raiz:** o próprio "6+" já sinalizava incerteza — a auditoria citou exemplos
  representativos, não o resultado de uma varredura completa por `status === 'pending'` no
  arquivo inteiro.

### S04 / ARCH-014 — Unificar padrões de erro transiente
- **Premissa do card:** "regex parcialmente sobrepostas (ECONNRESET/ETIMEDOUT/timeout)" — 3
  padrões citados.
- **Achado real:** 6 padrões realmente duplicados entre os dois arquivos (também `network`,
  `rate.?limit`, `429`).
- **Causa raiz:** comparação visual de um subconjunto saliente das duas listas, não um diff
  sistemático de cada padrão de uma lista contra todos os da outra.

### S05 / ARCH-017 — Remover `ToolExecutorService` morto
- **Premissa do card:** "0 call sites reais" — correto para a classe/instância principal.
- **Achado real:** a interface `ToolExecutorLike`, exportada do MESMO arquivo, tinha 1 consumidor
  real (`tools/powerpoint_control.ts`) não mapeado.
- **Causa raiz:** a verificação de "call sites" checou o símbolo principal (a classe `toolExecutor`)
  mas não enumerou **todos os outros exports** do arquivo antes de recomendar removê-lo por
  inteiro.

### S07 / ARCH-026 — Mover `DELIVERABLE_EXTENSIONS`
- **Premissa do card:** implícita — que consumidores de produção eram os únicos afetados pela
  localização do array.
- **Achado real:** um teste de regressão (`S52`) fazia `fs.readFileSync` sobre o path hardcoded
  do arquivo de origem, quebrando quando o array mudou de lugar — comportamento real intacto, só
  a asserção sobre localização de código quebrou.
- **Causa raiz:** a análise de dependências olhou o grafo de imports de **código de produção**,
  não considerou a suíte de testes como um consumidor sensível à localização física de um
  símbolo (um tipo de acoplamento que só aparece rodando a suíte, não lendo o grafo de imports).
  Mesma classe de achado se repetiu em S08 (`S110`, `S34`) e S09 (`S22`).

### S08 / ARCH-002 — Mover `EnvironmentProbe.ts` (categoria diferente — ver nota)
- **Premissa do card:** round-trip de camada `core↔loop↔core` — **essa parte estava correta**.
- **O que deu errado:** não foi a premissa do card, foi (a) meu próprio processo de validação na
  VPS (faltou `.env`/`WORKSPACE_DIR`, causando 2 falsos-positivos) e (b) um bug de teste
  pré-existente não relacionado ao card (`S112`, bashismo `{1..220}` sob `/bin/sh`=`dash`).
- **Por que está neste catálogo mesmo assim:** para deixar claro, por contraste, que nem toda
  Sprint com achados inesperados teve uma premissa de auditoria errada — esta teve gaps de
  **processo de validação** e um **bug de teste coincidente**, categorias diferentes de "a
  descrição do card estava factualmente errada". Detalhe completo: `docs/issues/002`.

### S10 / ARCH-011 — `extractUsedFingerprints` ler `goal.toolsTried`
- **Premissa do card:** "`goal.toolsTried` já guarda a sequência de tools de forma estruturada".
- **Achado real:** `toolsTried` é um **set deduplicado** (sem fronteira por tentativa/replan, sem
  ordem de sequência por plano), não uma sequência — e nunca contém `'agentloop'`.
- **Causa raiz:** o PRÓPRIO comentário no código-fonte já dizia `// set de tool names já
  tentados` — a palavra "set" já contradizia "sequência estruturada" do card. A auditoria não
  conferiu **como o campo é populado** (`GoalStore.addToolTried`, dedup + só grava quando
  `step.toolName` existe) antes de presumir que ele poderia substituir 1:1 a extração via regex.

### S11 / ARCH-016 — Consolidar 4 detectores de loop
- **Premissa do card:** os 4 blocos eram o mesmo padrão ("tool falhou ≥N vezes"), todos
  substituíveis por `StrategyDiversityGuard.extractExhaustedTools()`.
- **Achado real:** só 1 dos 4 é esse padrão. Os outros 3 detectam categoria de blocker+texto
  (pip/venv), categoria de AÇÃO não relacionada a falha (só leitura vs. implementar), e
  ocorrência única em vez de repetição (content_stub).
- **Causa raiz:** similaridade **textual/estrutural superficial** entre os 4 blocos (mesmo
  formato de string, mesma função, mesma vizinhança no arquivo) foi confundida com equivalência
  **semântica** de disparo — a auditoria não leu a condição de disparo (`if`) de cada um
  individualmente antes de propor a fonte de dados unificada.

### S13 / ARCH-007 — Sincronizar `PlanStep.status`/`.result` com `GoalAttempt.result` (categoria nova — ver Síntese, modo 4)
- **Premissa do card:** "a ordem real de execução em `GoalExecutionLoop.ts` (downgrade semântico
  roda antes do `markStepDone('skip')`) confirma o caso" — citava um mecanismo causal específico:
  o caminho de `shouldDowngradeToPartial` (mismatch semântico detectado após o attempt já
  persistido) levaria, no mesmo ciclo, a uma chamada de `markStepDone(..., 'skip')` que
  hardcoda `status: 'completed'`.
- **Achado real:** o SINTOMA final do card estava certo — um `PlanStep` pode mesmo ficar
  `completed` com o `GoalAttempt` mais recente `'partial'`. Mas o MECANISMO citado nunca ocorre:
  o caminho de `shouldDowngradeToPartial` muda `cycleResult.outcome` para `'partial'`/`'blocked'`
  ANTES do `switch(cycleResult.outcome)`, e nenhum desses dois `case`s chama `markStepDone`. O
  gatilho real (confirmado e coberto por teste, `S119`) é outro caminho, já documentado no
  próprio código-fonte (comentário "Sprint 0.8"): uma heurística de sucesso de BAIXA confiança
  grava `GoalAttempt.result: 'partial'`, mas como `toolResult.success` continua `true`,
  `cycleResult.outcome` ainda vira `'success'` — cai em `case 'success'` → `markStepDone(...,
  'skip')`, o mesmo destino final, só que por uma porta diferente da citada no card.
- **Causa raiz:** a auditoria original encontrou dois locais de código (`markStepDone` e o bloco
  de downgrade semântico) fisicamente próximos e temporariamente plausíveis de estarem
  conectados, e inferiu uma relação causal direta entre eles sem simular o `cycleResult.outcome`
  passo a passo entre os dois pontos. O fluxo de controle real (outcome muda de valor entre o
  bloco citado e o `switch`) só fica visível lendo o código com atenção ao STATE MUTATION
  intermediário, não à proximidade textual dos dois trechos.

### S14 / ARCH-009 — `CycleResult`/`GoalAttempt` estenderem `ToolResult` (categoria nova — ver Síntese, modo 5)
- **Premissa do card:** "`ToolResult` → `CycleResult` → `GoalAttempt` redeclaram os mesmos 2 campos
  (`output`, `error`) 3 vezes de forma independente" — prescrição: os dois últimos passam a
  `extends ToolResult`.
- **Achado real:** `CycleResult` não tem campo `error` (só `output`, opcional) — já não são "os
  mesmos 2 campos" nos 3 tipos. Mais grave: a prescrição não compila — `ToolResult.output` é
  obrigatório, `CycleResult.output`/`GoalAttempt.output` são legitimamente opcionais (ausentes em
  vários outcomes reais), e TypeScript não permite herdar um campo obrigatório como opcional. Pior
  ainda: `GoalAttempt` mora em `shared/domainTypes.ts` (camada neutra, ARCH-004/S02) e `ToolResult`
  em `loop/agentLoopTypes.ts` — fazer `GoalAttempt extends ToolResult` obrigaria `shared/` a
  importar de `loop/`, a violação de fronteira exata que ARCH-004 corrigiu.
- **Causa raiz:** diferente dos 4 modos abaixo (onde a CONCLUSÃO ou o CAMINHO CAUSAL citado pelo
  card precisava de correção, mas a AÇÃO prescrita em si era executável), aqui o problema está na
  PRESCRIÇÃO — o "como resolver" citado literalmente no card é estruturalmente inviável, não só
  impreciso. A auditoria original comparou os NOMES dos 2 campos (`output`/`error`) entre os 3
  tipos e concluiu "duplicação → unificar via herança" sem verificar (a) se a obrigatoriedade era
  compatível entre os 3 (não é) nem (b) em qual camada cada tipo fisicamente mora hoje (mudou desde
  a auditoria original — `GoalAttempt` só foi para `shared/` no ARCH-004/S02, uma Sprint DESTE
  MESMO programa, posterior à auditoria que gerou o card ARCH-009).
- **Decisão:** adiado por pedido do usuário, consolidado com outros achados de modelagem de tipo
  compartilhado em `docs/refatoracao-arquitetural-2026/REVISAO_CONSOLIDADA_TIPOS_PENDENTE.md`
  (junto com ARCH-024, mesma classe de problema). Registro técnico completo:
  `docs/issues/008-arch009-extends-toolresult-breaks-typing-and-boundary.md`.

### S16 / ARCH-005 — Fonte única de artefatos entregues (categoria: enumeração + equivalência, modos 1+3 combinados)
- **Premissa do card:** "o fato 'o que já foi entregue' existe em 4 estruturas SEM SINCRONIZAÇÃO
  AUTOMÁTICA" — `Goal.sentArtifacts`, `cycleHistory` (AgentLoop), `structuralBypass`,
  `deliverable_check` — consolidar numa função única.
- **Achado real:** as 4 já convergiam majoritariamente para `sentArtifacts` (via
  `onArtifactDelivered`, `.has()`, fallback em `checkClaimsAgainstEvidence`) — não estavam
  desincronizadas como o card afirmava. `structuralBypass` responde uma pergunta diferente por
  natureza (arquivo existe em disco → bypass de validação, não "foi entregue"), erro de categoria
  se fosse absorvido na função proposta. O escopo do card também estava incompleto —
  `planning/artifactContract.ts` também lê `sentArtifacts` e não constava. Os 2 bugs históricos
  citados como motivação já tinham sido corrigidos por Sprints anteriores a este programa.
- **Causa raiz:** combinação dos modos 1 (enumeração não-exaustiva — a lista de "4 estruturas" não
  foi obtida por grep completo de consumidores de `sentArtifacts`) e 3 (equivalência assumida sem
  verificar — os 4 mecanismos foram tratados como "a mesma decisão duplicada" sem checar se cada
  um já delegava pra fonte única em algum grau).
- **Achado novo e real, não coberto pela premissa original:** `sentArtifacts` guarda path CRU,
  `checkDeliverables()` retorna path ABSOLUTO — `deliverable_check` comparava os dois sem
  normalizar, podendo reinjetar um `send_document` duplicado de um arquivo já entregue por path
  relativo. Confirmado com dado real (LLM real usou path relativo de fato) em ambiente real. Fix
  cirúrgico implementado em vez da consolidação completa — ver `docs/issues/008` não se aplica
  aqui (esse é do S14); ver commit `7abede2`.

### S17 / ARCH-008 — `progressModel` restart-safe (categoria nova — 6º modo de falha, ver Síntese)
- **Premissa do card:** "`progressModel` reseta... incluindo após recovery pós-restart... o
  sistema já tem recovery de goals ativos no boot."
- **Achado real:** NÃO existe recovery automático no boot — `AgentController.getAllActive()` só
  loga (`recovered=false` explícito no próprio log), nunca chama `resumeGoal()`/`runLoop()`. O
  mecanismo citado como motivação/cenário de teste da mudança simplesmente não existe no código.
- **O defeito subjacente é real, só o gatilho é outro:** o único call site de `resumeGoal()` é
  `GoalOrchestrator.resumeFromAuth()` (fluxo de aprovação de ação perigosa) — MESMO PROCESSO, sem
  restart. `progressModel` reseta ali igualmente, perdendo progresso real toda vez que um goal com
  histórico bate numa autorização e é retomado — mais frequente que o cenário de restart descrito.
- **Causa raiz:** diferente de todos os modos anteriores — aqui não é uma contagem errada, um
  grafo de dependência incompleto, uma equivalência semântica falsa, ou uma rota causal trocada. É
  a auditoria original citando um MECANISMO OPERACIONAL (recovery automático) como justificativa
  de urgência/cenário de teste sem verificar que ele existe no runtime. Documentado em
  `docs/issues/009`. Adiado por decisão do usuário — fix desenhado, não implementado.

### S18 / ARCH-018 — `evaluateCriteria` absorve `structuralBypass` (categoria: modo 3, instância nova)
- **Premissa do card:** "`file_exists` já existe como `CriterionCheck` — expressar o
  [`structuralBypass`] como mais um critério elimina o `if` ad-hoc".
- **Achado real:** `file_exists` (implementação atual) checa se existe um `GoalAttempt`
  bem-sucedido com `output` não-vazio — prova indireta via texto de tool, NÃO uma consulta ao
  disco. `structuralBypass` faz `fs.statSync()` direto no disco, sem depender de nenhum attempt —
  exatamente para cobrir o caso (o Bug 2 original) de um arquivo que já existia ANTES do goal
  começar, sem nenhuma evidência de attempt. Reaproveitar `file_exists` literalmente teria feito
  `structuralBypass` retornar `'unverifiable'` na maioria dos casos, reintroduzindo o deadlock que
  ele foi criado para fechar.
- **Achado estrutural adicional:** `structuralBypass` deriva alvos dinamicamente do plano atual
  (`pendingSendSteps`, que muda a cada replan); `SuccessCriterion` é uma lista estática, decidida
  na criação do plano. Encaixar um no outro de verdade exigiria sincronizar as duas fontes a cada
  replan — risco de nova divergência, não simplificação.
- **Causa raiz:** instância nova do modo 3 (equivalência semântica assumida sem verificação) — dois
  mecanismos com nomes/conceitos parecidos ("existe o arquivo?") tratados como intercambiáveis sem
  checar COMO cada um decide isso de fato (attempt-output vs. disco direto), o mesmo padrão de
  S10/S11. Auto-detectado nesta Sprint só porque o card operava numa área com histórico de bug
  real de produção (Bug 2, `project_session_bugs_jul2026_ap`), o que motivou reverificação extra
  antes de tocar código.
- **Decisão:** adiado por decisão do usuário, mesma linha de S14/S17. Registro técnico completo,
  incluindo a alternativa de design levantada (novo `CriterionCheck` dedicado, não reaproveitar
  `file_exists`): `docs/issues/010-arch018-file-exists-checks-attempts-not-disk.md`.

### S19 / ARCH-024-RFC — `DeliveryTrackingContext` (categoria: modo 3, instância nova)
- **Premissa do card:** os 5 campos de callback de `ChannelContext` (`deferSendDocument`,
  `isDeferredArtifact`, `onArtifactDelivered`, `isAudioAlreadySent`, `recentMessages`) são "todos
  sobre rastreamento de entrega de goal".
- **Achado real:** `recentMessages` não é — construído em `MessageBus.ts` (mesmo lugar/razão que
  `channel`/`chatId`/`userId`), consumido só por `UnifiedIntentRouter` pra classificação de
  intenção, zero relação com entrega. Só 4 dos 5 campos são genuinamente delivery-tracking.
  Análise completa (Sprint de RFC, sem código): `RFC_ARCH-024_DeliveryTrackingContext.md`.
- **Causa raiz:** modo 3 (equivalência assumida sem verificação) — 4ª instância confirmada (depois de S10, S11, S18).

### S20 / ARCH-015-RFC — Args obrigatórios gerados do schema (categoria: modo 3, instância nova)
- **Premissa do card:** gerar validação + texto de prompt a partir do schema elimina a
  sincronização manual dos "5 lugares" que hoje declaram args obrigatórios independentemente.
- **Achado real:** os "5 lugares" nem cobrem o mesmo conjunto de tools (`memory_write` nunca
  aparece em `detectMissingRequiredArgs()`); mais grave, a lógica de "obrigatório" não é um
  `required: string[]` plano pra pelo menos 3 tools (`web_navigate`/`crypto_analysis`: condicional
  a outro campo; `edit`: "uma de 3 combinações válidas") — gerar a VALIDAÇÃO a partir do schema
  atual perderia essa lógica condicional silenciosamente. Só a metade de texto de prompt tem
  incidente real confirmado (S06/ARCH-025). RFC aprovou só essa metade. Análise completa:
  `RFC_ARCH-015_SchemaGeneratedRequiredArgs.md`.
- **Causa raiz:** modo 3 (equivalência assumida sem verificação — um `required: string[]` tratado
  como equivalente a uma lógica condicional que ele não consegue expressar) — 5ª instância.

### S21 / ARCH-013 — Unificar juiz de sucesso de step (categoria nova — 7º modo de falha, ver Síntese)
- **Premissa do card:** fundir a escalação de `evaluateAgentStepSuccess`/`escalateStepEvalToLLM`
  dentro de `StepSemanticValidator`, mantendo só a extração determinística (regex) fora dele —
  reduz de 2 chamadas de LLM por step pra 1.
- **Achado — diferente de todos os casos anteriores:** o DIAGNÓSTICO do card está correto (os dois
  mecanismos respondem perguntas diferentes — "sucesso/falha" vs. "relevância semântica" — mas a
  MESMA condição de ambiguidade tende a disparar escalação nos dois estágios pro mesmo step,
  confirmado por leitura da sequência real de chamadas). A PRESCRIÇÃO é tecnicamente viável —
  compila, roda, não reintroduz nenhuma violação. O que falta: rastrear a CONSEQUÊNCIA completa da
  remoção proposta. Hoje, quando a LLM da zona ambígua confirma sucesso, marca
  `stepSuccessConfident=true`, que decide se `GoalAttempt.result` vira `'success'` ou `'partial'`.
  `StepSemanticValidator` só tem um sinal NEGATIVO (`shouldDowngradeToPartial`) — nunca um
  positivo equivalente. Remover a chamada da zona ambígua sem dar ao `StepSemanticValidator` um
  sinal de promoção faria TODO step ambíguo virar `'partial'` sempre, mesmo quando genuinamente
  bem-sucedido — mudança de comportamento observável (critérios de conclusão de goal, contagem de
  retry) que o card não menciona.
- **Causa raiz:** nenhum dos 6 modos anteriores encaixa exatamente — não é enumeração incompleta,
  grafo de dependência incompleto, equivalência semântica falsa, rota causal errada, prescrição
  inviável, ou mecanismo inexistente. É a auditoria original não ter rastreado a cadeia COMPLETA
  de efeitos colaterais de "remover uma chamada" até um campo (`stepSuccessConfident`) usado bem
  longe do ponto de remoção proposto (~15 linhas depois, num cálculo de `GoalAttempt.result`).
- **Decisão:** adiado por decisão do usuário, mesma linha de S14/S17/S18. Alternativa desenhada
  (StepSemanticValidator ganha sinal de promoção, não só de rebaixamento) mas não implementada.
  Registro técnico completo: `docs/issues/011-arch013-merge-loses-confident-success-signal.md`.

## Síntese — causas raiz recorrentes

Analisando os 15 casos acima (excluindo S08, categoria diferente), os erros se agrupam em
**7 modos de falha da auditoria original**, não 15 causas distintas — o modo 3 (equivalência
semântica assumida sem verificação) sozinho já responde por 5 dos 15 casos (S10, S11, S18, S19,
S20), confirmando que não é um acaso isolado, é o modo mais recorrente do catálogo, disparado:

1. **Enumeração não-exaustiva** (S01, S03, S04) — contagens/listas citadas no card eram
   amostras ou resultado de busca parcial, não o resultado de uma varredura automatizada
   completa contra o código atual.
2. **Grafo de dependência incompleto** (S02, S05) — o escopo de "o que precisa mover/remover
   junto" foi decidido olhando só o símbolo citado no card, sem seguir suas próprias
   dependências transitivas (S02) nem enumerar os demais exports do mesmo arquivo (S05).
3. **Equivalência assumida sem verificar a semântica real** (S10, S11, S18, S19, S20) — mecanismos
   foram tratados como intercambiáveis por terem nome/formato parecido, sem confirmar que
   representam o mesmo CONCEITO (como o dado é populado, o que cada condição realmente checa). O
   modo mais recorrente do catálogo — 5 instâncias confirmadas.
4. **Rota causal citada não é a rota real, apesar do sintoma final estar correto** (S13) —
   diferente dos modos 1-3 (onde a CONCLUSÃO do card também precisou de correção), aqui a
   conclusão de alto nível ("existe essa divergência") se confirmou exatamente como descrita; só
   o CAMINHO DE CÓDIGO citado como prova/mecanismo estava errado. É o modo de falha mais
   perigoso de detectar, porque o sintoma correto tende a validar precocemente a explicação
   errada — só aparece simulando a mutação de estado (aqui, `cycleResult.outcome`) entre os dois
   pontos citados, não checando se os dois trechos citados existem (ambos existiam) ou se estão
   perto um do outro no arquivo (estavam).
5. **A prescrição em si é estruturalmente inviável, não só o diagnóstico** (S14) — diferente dos
   modos 1-4 (onde o QUE FAZER prescrito continuava executável, só a contagem/grafo/causa citada
   precisava de ajuste), aqui o "como resolver" literal do card (`extends ToolResult`) não
   compila, e forçá-lo reintroduziria uma violação de fronteira que outra Sprint DESTE MESMO
   programa já corrigiu. A causa específica deste modo: o card foi escrito pela auditoria original
   ANTES de ARCH-004 (S02) ter movido `GoalAttempt` para `shared/domainTypes.ts` — a auditoria
   comparou nomes de campo entre tipos sem verificar (a) compatibilidade de obrigatoriedade nem
   (b) que a topologia de camadas dos tipos envolvidos muda ao longo da execução do próprio
   programa que o card pertence.
6. **O mecanismo citado como motivação/justificativa simplesmente não existe no runtime** (S17) —
   diferente de todos os modos anteriores, aqui a auditoria não errou uma contagem, um grafo, uma
   equivalência, uma rota causal, ou uma prescrição — errou ao AFIRMAR QUE UM MECANISMO
   OPERACIONAL EXISTE ("o sistema já tem recovery de goals ativos no boot") sem verificar essa
   alegação contra o código. O sintoma final que motivou o card (perda de progresso) continua
   real, só que via um caminho completamente diferente (fluxo de autorização, não restart) que a
   auditoria nunca mencionou. É o modo mais perigoso de detectar por leitura superficial do card,
   porque a alegação lê como um FATO sobre a arquitetura ("o sistema já faz X"), não como uma
   inferência do próprio auditor — só aparece grepando o código em busca do mecanismo citado e
   confirmando que ele não existe, não lendo a lógica ao redor do sintoma.
7. **A prescrição é tecnicamente viável, mas a consequência completa de implementá-la não foi
   rastreada** (S21) — diferente de todos os modos anteriores, aqui o DIAGNÓSTICO do card está
   certo (os dois mecanismos citados de fato rodam em sequência desnecessária) e a PRESCRIÇÃO
   compila e roda sem erro — o que falta é seguir a cadeia de efeitos colaterais da mudança
   proposta até o fim. Remover uma chamada de LLM sem notar que um campo populado só por ela
   (`stepSuccessConfident`) é lido ~15 linhas depois, num cálculo de resultado final, causaria uma
   mudança silenciosa de comportamento observável — nenhum erro de compilação, nenhuma violação
   reintroduzida, só um comportamento diferente do atual sem o card ter avisado.

**Conclusão sobre a natureza da auditoria original:** os modos 1-4 são consistentes com uma
auditoria conduzida em **varredura ampla** (grep/leitura rápida cobrindo os 26 cards numa única
sessão) — apropriada para GERAR candidatos de dívida arquitetural, mas insuficiente para
PRESCREVER a implementação exata sem reverificação. Isso não é uma falha da auditoria em si (o
diagnóstico de alto nível — "existe uma violação/duplicação aqui" — se confirmou nos 19/19 casos
até agora) — é uma característica esperada de qualquer varredura ampla que cobre muito código em
pouco tempo, agravada no modo 5 pelo fato de o próprio backlog descrever um alvo em movimento (o
código muda a cada Sprint do mesmo programa que consulta o card), no modo 6 pelo fato de a
auditoria ter inferido a EXISTÊNCIA de um mecanismo a partir do comportamento observado (perda de
progresso), sem confirmar a causa citada por leitura direta do código responsável, e no modo 7
pelo fato de a auditoria original ter avaliado a mudança proposta só no ponto de remoção, sem
seguir os campos/sinais que dependiam do que foi removido até o consumidor final. O ponto de
falha real seria implementar a PRESCRIÇÃO do card sem a Fase 1 (compreensão) da
`DIRETRIZ_ARQUITETURA_2026-07-13.md` — que já existe, já é mandatória, mas cujo resultado prático
(achar a premissa/desenho errado em 15 de 19 casos) não estava sendo consolidado em lugar nenhum
até este documento.

## Ação — o que muda no processo a partir de agora

1. **`MASTER_EXECUTION_PLAN.md`, Checklist de Execução — padrão:** o item "Ler completamente
   o ARCH correspondente" passa a incluir explicitamente "reverificar cada alegação numérica e
   cada afirmação sobre estrutura/semântica de dados contra o código atual — não assumir que o
   card está correto só porque descreve um padrão plausível" (ver commit desta mudança).
2. **Sprints restantes (S12 em diante):** tratar a reverificação de premissa como **etapa
   obrigatória e esperada**, não como trabalho extra — o histórico deste documento mostra que é
   a norma (7 de 11), não a exceção.
3. **Achados classificados por modo de falha** (enumeração incompleta / grafo de dependência
   incompleto / equivalência semântica não verificada / rota causal errada / prescrição
   estruturalmente inviável / mecanismo citado inexistente / consequência não rastreada) ajudam a
   saber ONDE olhar com mais cuidado em cada card restante: cards que citam contagens específicas
   → checar modo 1; cards que pedem mover/remover um símbolo → checar modo 2; cards que propõem
   unificar duas fontes de dados ou dois mecanismos → checar modo 3; cards que citam um mecanismo
   causal específico → checar modo 4; cards que prescrevem `extends`/herança/fusão de tipos entre
   camadas → checar modo 5; cards que justificam a mudança citando "o sistema já faz X"/"já existe
   Y" como fato de arquitetura → checar modo 6 (grep pelo mecanismo citado ANTES de aceitar que ele
   existe); cards que prescrevem "remover"/"fundir"/"simplificar" uma chamada ou campo → checar
   modo 7 (seguir CADA consumidor do que será removido até o fim da cadeia, não só o ponto de
   remoção — um campo populado por uma chamada pode ser lido bem longe dali).
4. Este documento deve ser **atualizado** (não substituído) conforme novas Sprints revelem novos
   casos — é um registro cumulativo do programa inteiro, não um relatório de um momento único.
