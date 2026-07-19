# ARCH-008 — "Recovery de goals ativos no boot" não existe no código; premissa citava um mecanismo inexistente

## Resolvido em 2026-07-19 (reabertura de S17, pós-encerramento do programa)

Este achado foi **resolvido**, não permanece como pendência. O fix desenhado abaixo foi
implementado com 1 simplificação encontrada durante a reabertura: em vez de re-escanear
`goal.attempts` manualmente para derivar o status de steps `pending` já tentados, a implementação
real usa `PlanStep.lastAttemptOutcome` (adicionado por `ARCH-007`/S13, sinal restart-safe já
persistido — não existia como tal quando este achado foi escrito). Achado adicional de
consequência real: `progressModel.overallPercent` alimenta a lógica `ADAPTIVE-BUDGET` (bônus de
replan), então o bug não era só uma barra de progresso — quebrava esse bônus para todo goal
retomado via aprovação. Validado em ambiente real (`GoalOrchestrator.resumeFromAuth()` contra um
goal real, `AgentController` real). Detalhe completo:
`docs/refatoracao-arquitetural-2026/SPRINTS/S17-ARCH-008.md`. O texto abaixo é preservado como
registro histórico do achado original de julho.

## Contexto

Achado durante a Sprint `2026-08-S17` (ARCH-008, `MASTER_EXECUTION_PLAN.md`), na etapa de
reverificação de premissa (Fase 1 da `DIRETRIZ_ARQUITETURA_2026-07-13.md`) — antes de qualquer
linha de código ser tocada. O card justificava a mudança com: "`progressModel` reseta... incluindo
após recovery pós-restart, mesmo quando `goal.attempts`/`successCriteria` já provam progresso
real... um cenário real dado que o sistema já tem recovery de goals ativos no boot". Essa última
alegação não se sustenta.

## Achado real

**Não existe recovery automático de goals no boot.** `AgentController`'s construtor chama
`this.goalStore.getAllActive()` (goals em `active`/`executing`/`blocked`/`replanning`) e **só
loga** — o próprio log emite `recovered=false` explicitamente (`src/core/AgentController.ts:149-155`,
comentário "ITEM6: detecta goals em estado não-terminal deixados por shutdown anterior"). O mesmo
padrão (log-only) existe no `stop()`, para o shutdown (`[SHUTDOWN-ACTIVE-GOALS]`). Nenhum dos dois
pontos chama `resumeGoal()` ou `runLoop()`. Um goal deixado em `executing` quando o processo morre
fica **permanentemente órfão** no SQLite — nada volta a executá-lo, com ou sem este ARCH.

**O único call site real de `GoalExecutionLoop.resumeGoal()`** é
`GoalOrchestrator.resumeFromAuth()` (`src/loop/GoalOrchestrator.ts:538`) — disparado quando o
usuário aprova/rejeita uma ação perigosa (`exec_command`, etc.) via `workflowCallback`. É um fluxo
inteiramente **normal, no mesmo processo, sem restart** — acontece toda vez que um goal com
progresso real bate numa autorização pendente.

## O defeito subjacente é real, só o gatilho descrito no card está errado

`runLoop()` (ponto de entrada compartilhado por `executeGoal()`/`resumeGoal()`) sempre inicializa
`state.progressModel = {components: [], overallPercent: 0, ...}` — sem exceção
(`src/loop/GoalExecutionLoop.ts:570-578`). Isso significa que toda vez que um goal com progresso
real (steps já `completed`, `goal.attempts` com sucessos) bate num gate de autorização e é
retomado via `resumeGoal()`, o `progressModel` reseta para zero, no MESMO processo, sem crash
nenhum — mais frequente e mais fácil de reproduzir do que o cenário de "restart" que o card
descrevia.

## Fix desenhado (não implementado — Sprint adiada)

`buildInitialProgressModel(goal)`: reconstrói `components` a partir de `goal.currentPlan` (steps
`status==='completed'`, únicos valores realmente usados na prática — `'failed'`/`'skipped'`
nunca são setados em `PlanStep.status` em lugar nenhum do código, confirmado por grep) + para
steps ainda `pending` com pelo menos um `GoalAttempt` já registrado, deriva `'in_progress'`/`'failed'`
a partir do `result` do attempt mais recente daquele step. Usado só na criação do `state` dentro de
`runLoop()`, no mesmo espírito de `buildIncrementalExecutionContext()` (que já faz o equivalente
para `cognitiveContext`). Para `executeGoal()` (goal novo, plano todo `pending`, sem attempts),
retorna `[]` — comportamento idêntico ao atual, zero mudança nesse caminho.

## Decisão

Adiado por decisão do usuário — a mesma prescrição/fix continua válida em desenho, mas a premissa
do card estava errada num ponto estrutural (o mecanismo que justificava a urgência/cenário de teste
não existe), o suficiente para justificar não implementar nesta sessão sem revisão adicional.

## Impacto na Validação Progressiva (nota para quando este ARCH for retomado)

Como não existe recovery-por-restart de verdade, "matar o processo e validar recovery" (a
prescrição literal do card para a etapa 4) não é testável — não há nada a observar. A validação
real, quando este ARCH for retomado, precisa ser: goal real com progresso real acumulado, batendo
numa autorização real (ex.: `exec_command` em modo `SAFE`), aprovada via API real, confirmando que
`progressModel` sobrevive ao `resumeGoal()` — não um teste de restart de processo.

## Severidade

N/A — não é um bug em produção (o defeito de UX existe, mas nunca foi confirmado causando dano real
reportado), é uma correção de premissa de auditoria encontrada antes da implementação. Registrado
para que ARCH-008 não seja re-proposto do zero com a mesma alegação de "recovery no boot".
