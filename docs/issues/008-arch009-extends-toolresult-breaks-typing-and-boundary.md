# ARCH-009 — `extends ToolResult` literal não compila e reintroduz violação de fronteira já corrigida

## Contexto

Achado durante a Sprint `2026-08-S14` (ARCH-009, `MASTER_EXECUTION_PLAN.md`), na etapa de
reverificação de premissa (Fase 1 da `DIRETRIZ_ARQUITETURA_2026-07-13.md`) — antes de qualquer
linha de código ser tocada. O card propunha: "`CycleResult`/`GoalAttempt` passam a estender
`ToolResult` em vez de redeclarar `output`/`error`". Não é o caso — a prescrição literal falha por
dois motivos independentes, cada um suficiente para descartá-la.

## Achado real

**1. `CycleResult` não tem campo `error`** — a premissa "os mesmos 2 campos redeclarados 3 vezes"
já não corresponde à estrutura real. `CycleResult` (`src/loop/GoalTypes.ts`) só redeclara `output`
(opcional); o erro de uma falha é absorvido em `blocker.description`, nunca um campo `error`
próprio. `GoalAttempt` (`src/shared/domainTypes.ts`) e `ToolResult` (`src/loop/agentLoopTypes.ts`)
são os únicos dois tipos que realmente têm ambos os campos.

**2. `output` tem obrigatoriedade incompatível entre os três tipos** — `ToolResult.output` é
`string` (obrigatório); `CycleResult.output` e `GoalAttempt.output` são `string | undefined`
(opcionais, e legitimamente ausentes em vários casos — ex.: `CycleResult` com
`outcome: 'blocked'`/`'needs_auth'`/`'partial'` frequentemente não populam `output`). TypeScript
não permite que uma interface que estende outra torne um campo herdado obrigatório→opcional
(`string` não é super-tipo de `string | undefined`, é o inverso). `interface CycleResult extends
ToolResult` não compila sem antes tornar `output` sempre presente em `CycleResult` — o que exigiria
sintetizar um valor onde hoje legitimamente não há um, mudando comportamento observável (ex.: um
consumidor que hoje testa `cycleResult.output === undefined` como sinal de "sem output ainda"
pararia de funcionar).

**3. Reintroduz a violação de fronteira corrigida em S02/S04 (ARCH-004)** — `GoalAttempt` vive hoje
em `src/shared/domainTypes.ts` (camada neutra, 0 imports, confirmado por grep), movido para lá
justamente pelo ARCH-004 para que `memory/` não dependesse de `loop/`. `ToolResult` vive em
`src/loop/agentLoopTypes.ts`. Fazer `GoalAttempt extends ToolResult` obrigaria
`shared/domainTypes.ts` a importar de `loop/agentLoopTypes.ts` — a direção exatamente proibida pelo
Epic A (Boundary Enforcement) deste mesmo programa (`ARCHITECTURE.md`, `shared/` nunca depende de
`loop/`). Seria regredir, na mesma Sprint, uma correção arquitetural já fechada em Sprints
anteriores.

## Alternativa levantada (não implementada nesta Sprint — ver decisão abaixo)

Extrair uma interface mínima `{ output?: string; error?: string }` para `shared/domainTypes.ts`
(que já é a camada neutra, 0 imports). `ToolResult` (loop/) e `CycleResult` (loop/) estenderiam essa
base de lá — direção `loop/ → shared/`, a mesma já estabelecida — com `ToolResult` estreitando
`output` para obrigatório (válido em TS: `string` é subtipo de `string | undefined`). `GoalAttempt`
estenderia a mesma base diretamente, no mesmo arquivo. O próprio Critério de Aceite do card já
previa essa flexibilidade ("`CycleResult`/`GoalAttempt` **estendem/referenciam** `ToolResult`" —
não exige `extends` literal).

## Decisão

Não implementar isoladamente nesta Sprint. O usuário optou por **adiar ARCH-009** e consolidá-lo
junto com outros achados relacionados a modelagem de tipos compartilhados/fronteiras entre `loop/`
e `shared/` numa revisão dedicada futura, em vez de decidir a forma final do tipo compartilhado
Sprint a Sprint. Ver `docs/refatoracao-arquitetural-2026/REVISAO_CONSOLIDADA_TIPOS_PENDENTE.md`.

## Severidade

N/A — não é um bug, é uma correção de premissa encontrada antes da implementação (Fase 1/2 da
diretriz de arquitetura fizeram exatamente o papel para o qual existem). Registrado para que o
card ARCH-009 não seja re-proposto do zero na revisão consolidada sem este contexto.
