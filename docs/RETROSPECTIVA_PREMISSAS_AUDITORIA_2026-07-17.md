# Retrospectiva — Premissas da Auditoria que Não Se Sustentaram na Execução

**Data:** 2026-07-17. **Escopo:** Sprints `2026-07-S01` a `2026-08-S13` do Programa de Refatoração
Arquitetural (`docs/MASTER_EXECUTION_PLAN.md`), cards ARCH-001 a ARCH-023 (parcial). **Motivo
deste documento:** ao final da S11, o usuário perguntou diretamente por que premissas erradas
estavam se repetindo e pediu um catálogo consolidado — não bug a bug, mas como retrospectiva de
processo, para melhorar a auditoria em si, não só corrigir os sintomas encontrados até agora.

## Por que isto importa

`docs/ARCHITECTURAL_BACKLOG.md` é descrito como a consolidação de 4 auditorias ("Auditoria I —
Duplicação de Decisões", "II — Duplicação de Conhecimento", "III — Complexidade Acidental", "IV —
Violação de Fronteiras Arquiteturais"), todas conduzidas na mesma sessão de engenharia, cobrindo
26 cards. Das **11 Sprints já executadas**, **7 tiveram a premissa original do card corrigida
durante a implementação** — não são exceções, são a maioria. Isso não invalida o backlog (o
diagnóstico de ALTO NÍVEL — "existe duplicação/acoplamento aqui" — se confirmou em todos os
casos), mas invalida a confiança de que o TEXTO ESPECÍFICO de cada card (contagens, alegações
sobre estrutura de dados, equivalência entre padrões) pode ser implementado sem reverificação.

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

## Síntese — causas raiz recorrentes

Analisando os 8 casos acima (excluindo S08, categoria diferente), os erros se agrupam em
**4 modos de falha da auditoria original**, não 8 causas distintas:

1. **Enumeração não-exaustiva** (S01, S03, S04) — contagens/listas citadas no card eram
   amostras ou resultado de busca parcial, não o resultado de uma varredura automatizada
   completa contra o código atual.
2. **Grafo de dependência incompleto** (S02, S05) — o escopo de "o que precisa mover/remover
   junto" foi decidido olhando só o símbolo citado no card, sem seguir suas próprias
   dependências transitivas (S02) nem enumerar os demais exports do mesmo arquivo (S05).
3. **Equivalência assumida sem verificar a semântica real** (S10, S11) — dois mecanismos foram
   tratados como intercambiáveis por terem nome/formato parecido, sem confirmar que representam
   o mesmo CONCEITO (como o dado é populado, o que cada condição realmente checa).
4. **Rota causal citada não é a rota real, apesar do sintoma final estar correto** (S13) —
   diferente dos modos 1-3 (onde a CONCLUSÃO do card também precisou de correção), aqui a
   conclusão de alto nível ("existe essa divergência") se confirmou exatamente como descrita; só
   o CAMINHO DE CÓDIGO citado como prova/mecanismo estava errado. É o modo de falha mais
   perigoso de detectar, porque o sintoma correto tende a validar precocemente a explicação
   errada — só aparece simulando a mutação de estado (aqui, `cycleResult.outcome`) entre os dois
   pontos citados, não checando se os dois trechos citados existem (ambos existiam) ou se estão
   perto um do outro no arquivo (estavam).

**Conclusão sobre a natureza da auditoria original:** os modos 1-3 são consistentes com uma
auditoria conduzida em **varredura ampla** (grep/leitura rápida cobrindo os 26 cards numa única
sessão) — apropriada para GERAR candidatos de dívida arquitetural, mas insuficiente para
PRESCREVER a implementação exata sem reverificação. Isso não é uma falha da auditoria em si (o
diagnóstico de alto nível — "existe uma violação/duplicação aqui" — se confirmou nos 11/11 casos
até agora) — é uma característica esperada de qualquer varredura ampla que cobre muito código em
pouco tempo. O ponto de falha real seria implementar a PRESCRIÇÃO do card sem a Fase 1
(compreensão) da `DIRETRIZ_ARQUITETURA_2026-07-13.md` — que já existe, já é mandatória, mas cujo
resultado prático (achar a premissa errada em 7 de 11 casos) não estava sendo consolidado em
lugar nenhum até este documento.

## Ação — o que muda no processo a partir de agora

1. **`docs/MASTER_EXECUTION_PLAN.md`, Checklist de Execução — padrão:** o item "Ler completamente
   o ARCH correspondente" passa a incluir explicitamente "reverificar cada alegação numérica e
   cada afirmação sobre estrutura/semântica de dados contra o código atual — não assumir que o
   card está correto só porque descreve um padrão plausível" (ver commit desta mudança).
2. **Sprints restantes (S12 em diante):** tratar a reverificação de premissa como **etapa
   obrigatória e esperada**, não como trabalho extra — o histórico deste documento mostra que é
   a norma (7 de 11), não a exceção.
3. **Achados classificados por modo de falha** (enumeração incompleta / grafo de dependência
   incompleto / equivalência semântica não verificada) ajudam a saber ONDE olhar com mais cuidado
   em cada card restante: cards que citam contagens específicas → checar modo 1; cards que pedem
   mover/remover um símbolo → checar modo 2; cards que propõem unificar duas fontes de dados ou
   dois mecanismos → checar modo 3.
4. Este documento deve ser **atualizado** (não substituído) conforme novas Sprints revelem novos
   casos — é um registro cumulativo do programa inteiro, não um relatório de um momento único.
