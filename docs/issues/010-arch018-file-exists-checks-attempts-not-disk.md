# ARCH-018 — `CriterionCheck: 'file_exists'` checa output de attempt, não o disco; `structuralBypass` não pode ser plugado nele literalmente

## Contexto

Achado durante a Sprint `2026-08-S18` (ARCH-018, `MASTER_EXECUTION_PLAN.md`), na etapa de
reverificação de premissa (Fase 1 da `DIRETRIZ_ARQUITETURA_2026-07-13.md`) — antes de qualquer
linha de código ser tocada, precisamente porque este card opera na área de um bug real de
deadlock já documentado (`project_session_bugs_jul2026_ap`, Bug 2). O card propunha: "`file_exists`
já existe como `CriterionCheck` — expressar o [`structuralBypass`] como mais um critério elimina o
`if` ad-hoc".

## Achado real

**`file_exists` (implementação atual, `GoalExecutionLoop.evaluateCriteria()`, case `'file_exists'`)
NÃO consulta o disco.** Considera o critério cumprido quando existe um `GoalAttempt`
bem-sucedido (`result==='success'`) com `output` não-vazio — na prática, "algum `exec_command`
(ex. `ls`/`test -f`) rodou e retornou algo não-vazio", uma prova indireta via texto de tool,
não uma verificação de arquivo real.

**`structuralBypass` (`GoalExecutionLoop.ts`, dentro de `runLoopInternal`, bloco "Bypass
estrutural") faz `fs.statSync(resolved).size >= MIN_DELIVERABLE_SIZE` DIRETO no disco**, sem
depender de nenhum `GoalAttempt` anterior — essa é precisamente a razão de sua existência: o Bug 2
original era sobre goals de "reenviar um arquivo que **já existia antes do goal começar**", sem
nenhum `write`/`exec_command` DENTRO do goal como evidência prévia. Se `structuralBypass` fosse
reescrito para usar a semântica atual de `file_exists`, ele quase sempre retornaria
`'unverifiable'` (não há attempt a checar) — **reintroduzindo o deadlock exato que ele foi criado
para fechar**.

## Segundo problema, estrutural (não só semântico)

`structuralBypass` deriva seus alvos **dinamicamente**, a cada ciclo, de
`getPendingSteps(currentGoal.currentPlan, 'send_document')` — que muda a cada replan (paths podem
ser corrigidos entre tentativas, ver achado de S16). `SuccessCriterion`/`evaluateCriteria()`
operam sobre `goal.successCriteria`, uma lista **estática**, decidida na criação/replan do plano e
avaliada repetidamente sem mudar de alvo. Encaixar a lógica dinâmica de `structuralBypass` dentro
do modelo estático de `successCriteria` de verdade (não só cosmeticamente) exigiria manter as duas
fontes sincronizadas a cada replan — um risco de nova divergência entre plano e critérios, não uma
simplificação, exatamente o tipo de coisa que o Epic Single Source of Truth deste programa existe
para eliminar, não criar.

## Alternativa levantada (não implementada — Sprint adiada)

Criar um `CriterionCheck` NOVO e distinto (não reaproveitar `'file_exists'`) que preserva
exatamente a lógica atual de `structuralBypass` (`fs.statSync` direto, sem depender de attempts) —
resolveria o Critério de Aceite literal do card ("nenhum `if` solto de bypass fora de
`evaluateCriteria`") sem mudar comportamento nem arriscar reintroduzir o deadlock. Ainda restaria
resolver a sincronização dinâmica-vs-estática descrita acima antes de qualquer implementação.

## Decisão

Adiado por decisão do usuário — a mesma linha de ARCH-008/ARCH-009 (S17/S14): quando a premissa
quebra de forma estrutural numa área com histórico de bug real de produção, preferir adiar e
documentar a decidir uma correção pontual na mesma sessão.

## Severidade

N/A — não é um bug em produção (o `structuralBypass` atual continua funcionando corretamente,
intocado), é uma correção de premissa de auditoria encontrada antes da implementação. Registrado
para que ARCH-018 não seja re-proposto assumindo que `file_exists` já resolve o caso de uso.
