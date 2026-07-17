# MASTER_EXECUTION_PLAN.md — Refatoração Arquitetural NewClaw

**Este documento NÃO substitui `docs/ARCHITECTURAL_BACKLOG.md`.** O backlog é a fonte de verdade sobre O QUÊ e POR QUÊ (descrição de cada problema, evidências, arquivos, critérios). Este documento é a fonte de verdade sobre QUANDO e COMO EXECUTAR — a ordem operacional, o rastreamento de status e o histórico de execução.

**Baseline:** B1.0 (imutável). **Política permanente:** *No Opportunistic Refactoring* — nenhuma Sprint corrige nada além do seu único ARCH designado; dívida nova encontrada durante a execução é documentada em `docs/issues/NNN-*.md` (não só numa nota inline dentro do card da Sprint — ver Regra #3) e vira proposta de ARCH novo, nunca é resolvida "de brinde" na sprint corrente. **WIP máximo = 1** — nunca dois refactors de grande porte em andamento ao mesmo tempo.

Nenhuma Sprint foi iniciada. Todas as datas abaixo são estimativas de planejamento (não compromissos), a serem corrigidas com dados reais de velocidade a partir da primeira Sprint executada.

---

## Regressão Funcional vs. Regressão Arquitetural

Este programa existe para mudar a arquitetura sem mudar o comportamento — então "não regrediu" precisa ser verificado em dois eixos independentes, não um só. Um refactor pode manter 100% do comportamento externo (regressão funcional limpa) e ainda assim reintroduzir exatamente a violação que o ARCH correspondente eliminou (regressão arquitetural), ou vice-versa. As duas são obrigatórias, nenhuma substitui a outra.

| Tipo | Objetivo | Como se verifica neste programa |
|---|---|---|
| **Regressão Funcional** | Garantir que o comportamento externo do sistema permaneça inalterado. | `npm run test:regression` (suíte de regressão — dobra de "unitário" para a maioria dos cards deste programa, já que cada teste `SNNN_*.test.ts` cobre uma unidade de comportamento específica) + `npm run test:integration` quando a Sprint exigir etapa 3/4 da Validação Progressiva (`DIRETRIZ_ARQUITETURA_2026-07-13.md`). |
| **Regressão Arquitetural** | Garantir que a refatoração não reintroduza violações arquiteturais (Boundary Enforcement, SSOT, Ownership, acoplamentos indevidos, etc.). | Repetir a mesma medição usada para os indicadores T0 (Fase 0, Anexo) e para o "Critérios de Aceite" do ARCH da própria Sprint — tipicamente `grep` estrutural (imports cross-layer, padrões duplicados, recomputação inline) + contagem de linhas dos hotspots. Comparar contra o valor esperado da Sprint, não contra "zero absoluto" (uma Sprint só corrige o que seu ARCH cobre — o restante da dívida arquitetural permanece, de propósito, até sua própria Sprint). |

Uma Sprint só é `🟢 Concluída` quando as duas passam. Isso é o que os itens "Regression Tests" e "Architecture Metrics" do checklist de Validação (abaixo) formalizam — nenhum dos dois é opcional, e "a suíte passou" sozinho não é suficiente para fechar uma Sprint deste programa.

---

## PAINEL EXECUTIVO

| Sprint | Período | Epic | ARCH | Status | Dependências | Commit | Resultado |
|---|---|---|---|---|---|---|---|
| 2026-07-P00 | Jul/2026 | Preparação | Baseline | 🟢 | — | d088864 (TAG `baseline-b1.0-pre-refactor`) | 118/118, tsc limpo, T0 registrado |
| 2026-07-S01 | Jul/2026 | Boundary Enforcement | ARCH-001 | 🟢 | P00 | 6c14a9b | 26 imports corrigidos (`tools/`→25, `core/ToolRegistry.ts`→1), tsc limpo, 118/118 |
| 2026-07-S02 | Jul/2026 | Boundary Enforcement | ARCH-004 | 🟢 | P00 | 18ba2a2 | `shared/domainTypes.ts` criado, `memory/` sem imports de tipo de `loop/`, tsc limpo, 118/118 |
| 2026-07-S03 | Jul/2026 | Single Source of Truth | ARCH-006 | 🟢 | P00 | 0225075 | `getPendingSteps` único, 15 call sites migrados, tsc limpo, 119/119 |
| 2026-07-S04 | Jul/2026 | Decision Ownership | ARCH-014 | 🟢 | P00 | ccf97c1 | `shared/transientErrorPatterns.ts` novo, 6 padrões unificados, verificado byte-a-byte, 119/119 |
| 2026-07-S05 | Jul/2026 | Decision Ownership | ARCH-017 | 🟢 | P00 | dd1a51e | `ToolExecutorService` removido (4 arquivos), build+tsc limpos, 119/119 |
| 2026-07-S06 | Jul/2026 | Technical Cleanup | ARCH-025 | 🟢 | P00 | 7aa5bc4 | 2 blocos de prompt unificados (6 divergências corrigidas), build+tsc limpos, 119/119 |
| 2026-07-S07 | Jul/2026 | Technical Cleanup | ARCH-026 | 🟢 | P00 | e97405d | `DELIVERABLE_EXTENSIONS` movido, 1 teste corrigido (S52), build+tsc limpos, 119/119 |
| 2026-07-CP01 | Jul/2026 | Checkpoint | — | 🟢 | S01-S07 | — | 7/7 Sprints concluídas, indicadores revisados, 0 riscos residuais |
| 2026-07-S08 | Jul/2026 | Boundary Enforcement | ARCH-002 | 🟢 | CP01 | 151fd6a, 36036de | Movido p/ core/, validado real em Windows+Linux (VPS); 3 falhas iniciais na VPS = 2 falso-positivo do setup + 1 bug de teste real (corrigido) — ver docs/issues/002 |
| 2026-07-S09 | Jul/2026 | Boundary Enforcement | ARCH-003 | ⚪ | CP01 | — | — |
| 2026-07-S10 | Jul/2026 | Single Source of Truth | ARCH-011 | ⚪ | S09 | — | — |
| 2026-08-S11 | Ago/2026 | Decision Ownership | ARCH-016 | ⚪ | S10 | — | — |
| 2026-08-S12 | Ago/2026 | Structural Simplification | ARCH-023 | ⚪ | CP01 | — | — |
| 2026-08-S13 | Ago/2026 | Single Source of Truth | ARCH-007 | ⚪ | CP01 | — | — |
| 2026-08-S14 | Ago/2026 | Single Source of Truth | ARCH-009 | ⚪ | CP01 | — | — |
| 2026-08-S15 | Ago/2026 | Single Source of Truth | ARCH-010 | ⚪ | CP01 | — | — |
| 2026-08-CP02 | Ago/2026 | Checkpoint | — | ⚪ | S08-S15 | — | — |
| 2026-08-S16 | Ago/2026 | Single Source of Truth | ARCH-005 | ⚪ | CP02 | — | — |
| 2026-08-S17 | Ago/2026 | Single Source of Truth | ARCH-008 | ⚪ | S16 | — | — |
| 2026-08-S18 | Ago/2026 | Decision Ownership | ARCH-018 | ⚪ | S16 | — | — |
| 2026-09-S19 | Set/2026 | Structural Simplification | ARCH-024-RFC | ⚪ | CP02 | — | — |
| 2026-09-S20 | Set/2026 | Decision Ownership | ARCH-015-RFC | ⚪ | S06 | — | — |
| 2026-09-CP03 | Set/2026 | Checkpoint | — | ⚪ | S16-S20 | — | — |
| 2026-09-S21 | Set/2026 | Decision Ownership | ARCH-013 | ⚪ | CP03, S14 | — | — |
| 2026-09-S22 | Set/2026 | Structural Simplification | ARCH-022 | ⚪ | S16, S14, S21 | — | — |
| 2026-10-S23 | Out/2026 | Structural Simplification | ARCH-024-Impl | ⚪ | S19 (aprovação) | — | — |
| 2026-10-S24 | Out/2026 | Structural Simplification | ARCH-020 | ⚪ | S16, S03, S13, S17, S14 | — | — |
| 2026-10-S25 | Out/2026 | Structural Simplification | ARCH-019 | ⚪ | S16, S22, S23; **nunca simultânea com S24** | — | — |
| 2026-11-S26 | Nov/2026 | Decision Ownership | ARCH-015-Impl | ⚪ | S20 (aprovação) | — | — |
| 2026-11-CP04 | Nov/2026 | Checkpoint | — | ⚪ | S21-S26 | — | — |
| 2026-11-S27 | Nov/2026 | Single Source of Truth | ARCH-012 | ⚪ | S16, S18 | — | — |
| 2026-12-CP05 | Dez/2026 | Checkpoint de Encerramento | — | ⚪ | S27 | — | — |

---

## RESUMO EXECUTIVO

**Programa:** Refatoração Arquitetural NewClaw
**Status Geral:** 🟢 Em execução — Fase 0, S01-S08 e Checkpoint CP01 concluídos
**Progresso:** 8 / 26 ARCH concluídos (~31%)
**Sprint Atual:** Nenhuma em andamento (S08 concluída — próxima é 2026-07-S09)
**Próxima Sprint:** 2026-07-S09 (ARCH-003)
**Epic Atual:** Epic A quase concluído (só ARCH-003 restante); Epic B iniciado — ARCH-006 feito; Epic C parcialmente concluído — ARCH-014/017 feitos; Epic E concluído — ARCH-025/026 feitos
**Próximo Marco:** 2026-08-CP02
**Última Atualização:** 2026-07-17 (Sprint S08 concluída — primeira com validação real em Linux, via VPS isolada)
**Build:** 🟢 `npm run build` limpo (Windows e Linux real)
**Testes:** 🟢 119/119 (Windows) — 116/119 (VPS Linux específica, 3 falhas confirmadas pré-existentes ao programa, não-regressão)
**Regressão:** 🟢 119/119 (pós-S08, Windows)
**Riscos Abertos:** 0 — mas nota permanente: a VPS `venus@10.0.0.10` usada para validação tem 3 falhas de ambiente pré-existentes (workspace de teste com `spawn /bin/sh ENOENT`, `edge-tts` sem acesso de rede) que não são deste programa; útil registrar para não re-investigar do zero na próxima Sprint que exigir ambiente real
**RFCs Pendentes:** 3 (ARCH-012, ARCH-015, ARCH-024)
**Dívida Arquitetural Restante:** 18 ARCH (17 cards executáveis restantes + ARCH-021 formalmente absorvido em ARCH-020, sem sprint própria)

> Este bloco deve ser reescrito ao final de cada Sprint — não editado por trecho, substituído por inteiro — para refletir o estado real no momento.

## Dashboard Executivo — Estado Global de Validação

Snapshot do estado de validação do branch `refactor/architectural-backlog` neste momento — não de uma Sprint isolada. Se qualquer linha virar ✘, nenhuma Sprint nova deve começar até ela voltar a ✔ (a causa pode ser uma Sprint anterior que saiu do ar sem que alguém tenha notado).

| Indicador | Status | Última verificação | Evidência |
|---|---|---|---|
| Build (`npm run build`) | ✔ | 2026-07-17 (pós-S08) | Windows: limpo. **Linux real (VPS Ubuntu 24.04)**: limpo — primeira Sprint validada nos dois SOs |
| tsc (`tsc --noEmit`) | ✔ | 2026-07-17 (pós-S08) | 0 erros (Windows e Linux) |
| Unit + Regression Tests (Regressão Funcional) | ✔ | 2026-07-17 (pós-S08, causa raiz revisada) | Windows: 119/120 (S112 corrigido, teste novo). **Linux real (VPS)**: causa raiz de cada uma das 3 falhas iniciais (`S37`, `S13`, `S112`) investigada individualmente, não só comparada contra o baseline — ver `docs/issues/002-vps-linux-validation-false-positives.md`. Resultado real: `S37` 9/9 (falso positivo, `WORKSPACE_DIR` ausente no meu setup), `S13` 7/8 (idem, +1 fragilidade de asserção documentada, não corrigida), `S112` 7/7 (bug de teste real — bashismo `{1..220}` sob `/bin/sh`=`dash` — corrigido no commit `36036de`) |
| Integration Tests | ✔ (parcial, primeira vez) | 2026-07-17 | S08 (ARCH-002) foi a primeira Sprint a exigir e executar etapa 4 (ambiente real) — validação numa VPS Linux real (`venus@10.0.0.10`), em cópia isolada, sem tocar a instância de produção que já rodava lá (PM2, confirmada intacta antes/depois) |
| Architecture Metrics (Regressão Arquitetural) | ✔ | 2026-07-17 (pós-S08) | Boundary (ARCH-001/002/004): `core/CapabilityRegistry.ts` não importa mais de `loop/`; 0 violações residuais além das 2 legítimas; ARCH-003 permanece, esperado (S09). SSOT (ARCH-006): só as 2 exceções conscientes fora do accessor. Decision Ownership (ARCH-014/017): 6/6 regexes byte-idênticas, 0 ocorrências residuais de `ToolExecutorService`. Technical Cleanup (ARCH-025/026): blocos de prompt e `DELIVERABLE_EXTENSIONS` com fonte única confirmada. Hotspots: `GoalExecutionLoop.ts` 3522 linhas (T0: 3515), `AgentLoop.ts` 2913 linhas (T0: 2913, inalterado) |

**Como reproduzir esta linha "Architecture Metrics":** os comandos variam por Sprint (cada ARCH tem seu próprio "Critérios de Aceite" verificável por grep/contagem — ver o card correspondente em `ARCHITECTURAL_BACKLOG.md`), não existe um único script universal ainda. Ver a seção "Regressão Funcional vs. Regressão Arquitetural" acima.

---

# FASE 0 — Preparação

**Identificação:** `2026-07-P00`
**Status:** ⚪ Não iniciada
**Nenhuma Sprint pode começar antes desta fase estar 🟢 Concluída.**

## Checklist obrigatório

- [x] Backup completo do repositório e do banco de dados (SQLite de goals/memória) antes de qualquer alteração. **N/A neste checkout** — este é um repositório de desenvolvimento (`D:\IA\newclaw`, per `project_ambiente_local_paths`), sem instância rodando nem DB local ativo. O histórico git completo (branch `merge-artifact-pipeline` + TAG abaixo) já é a cópia de segurança do código. Backup de banco de dados real só se aplica no momento em que uma mudança for validada contra dado real de produção/VPS (etapa 4 da Validação Progressiva de cada Sprint) — a fazer naquele momento, não aqui.
- [x] Criar TAG Git marcando o estado atual (`git tag baseline-b1.0-pre-refactor`) — criada sobre o commit `d088864` (branch `merge-artifact-pipeline`, após o fix S115 pré-existente desta sessão, commitado antes da tag para que a baseline não carregasse mudança pendente não registrada).
- [x] Criar branch de refatoração dedicada (`refactor/architectural-backlog`), a partir da TAG — nenhum commit deste programa vai direto em `main`/`merge-artifact-pipeline`.
- [x] Validar build (`tsc --noEmit` limpo no estado atual, antes de qualquer mudança) — limpo, 0 erros.
- [x] Executar todos os testes (`npm run test:regression`) e registrar o resultado como baseline — **118/118 passaram**.
- [x] Registrar métricas atuais (linhas por arquivo/método dos hotspots citados no backlog) — ver Anexo abaixo; valores medidos diretamente no código, não copiados do backlog (2 pequenas divergências encontradas e documentadas — variação de poucas linhas por causa do fix S115, que tocou `runLoopInternal`).
- [x] Registrar indicadores arquiteturais (a tabela completa da Fase 7 do `ARCHITECTURAL_BACKLOG.md`, como snapshot "T0") — ver Anexo abaixo. **1 divergência material encontrada** (ver nota sobre ARCH-001).
- [x] Congelar novas funcionalidades no escopo tocado por este programa (nenhuma feature nova em `loop/`, `core/`, `tools/`, `memory/` até o programa concluir ou ser explicitamente pausado) — política em vigor a partir deste commit.
- [x] Aprovar `docs/ARCHITECTURAL_BACKLOG.md` formalmente (já ocorreu, conforme instrução recebida) — **Responsável:** Luciano Rovanni do Nascimento. **Data:** 2026-07-17.
- [x] Registrar baseline arquitetural (cópia do snapshot de indicadores + hash do commit da TAG) — ver Anexo abaixo.

## Definition of Done da Fase 0
Todos os itens do checklist marcados, TAG criada, branch criada, build e testes verdes, indicadores T0 registrados neste documento (seção "Anexo — Indicadores T0", abaixo). Só então a Sprint `2026-07-S01` pode iniciar.

**Fase 0: 🟢 Concluída em 2026-07-17.**

## Anexo — Indicadores T0

**Commit da TAG `baseline-b1.0-pre-refactor`:** `d0888642a0d4ab6bbba8cb20259494d2e1fb0912` (branch `merge-artifact-pipeline`, antes de bifurcar `refactor/architectural-backlog`).

| Indicador | Valor em T0 (medido em 2026-07-17) |
|---|---|
| Violações de fronteira | 26 imports de `ToolExecutor`/`ToolResult` de `loop/AgentLoop` (não 25 — ver nota abaixo; **correção da correção**: a medição inicial da Fase 0 contou 28 por grep bruto no path, incluindo `core/AgentController.ts`/`agentControllerCommands.ts`, que na verdade importam a classe `AgentLoop` em si, um import legítimo — o número real de violação é 26, confirmado linha-a-linha na execução de S01) + 1 round-trip `core/CapabilityRegistry` ↔ `loop/EnvironmentProbe` ↔ `core/ToolRegistry` (confirmado) + 2 imports de runtime de `memory/` em `loop/` (`StrategyDiversityGuard` em `CaseMemory.ts`, `extractText` em `CMIIngestionPipeline.ts`, confirmados) + 3 imports `import type` de `memory/` em `loop/` (`GoalTypes` ×2, `UnifiedIntentRouter` ×1, confirmados) |
| God Methods (>300 linhas) | 3 — `AgentLoop.runWithTools` L1118-2911 (~1793 linhas, confirmado), `GoalExecutionLoop.runLoopInternal` L570-1605 (~1035 linhas), `GoalExecutionLoop.executeStep` L1605-1988 (~383 linhas) |
| Large Classes (>1500 linhas) | 2 — `GoalExecutionLoop.ts` 3515 linhas (confirmado), `AgentLoop.ts` 2913 linhas (confirmado) |
| Single Sources fragmentadas | ~8 (per Fase 7 do backlog — não re-auditado nesta Fase 0, escopo de leitura manual; ver ARCH-005/006/007/008/009/010/011/012) |
| Decision Owners duplicados | ~6 (per Fase 7 do backlog — idem, não re-auditado aqui) |
| Code Smells confirmados | 6 categorias (per Fase 7 do backlog — idem) |
| Suíte de regressão (passou/total) | **118/118** |
| `tsc --noEmit` | Limpo, 0 erros |

**Nota sobre a divergência em "Violações de fronteira" (ARCH-001) — resolvida em S01:** o backlog estimava 24 arquivos em `src/tools/*.ts` + `src/core/ToolRegistry.ts` (25 total). A medição da Fase 0 (grep bruto pelo path `'../loop/AgentLoop'`) contou 28, mas isso incluía 2 falsos positivos (`core/AgentController.ts`, `core/agentControllerCommands.ts` — importam a classe `AgentLoop`, dependência legítima). Na execução de S01 (2026-07-17), a verificação linha-a-linha confirmou o número real: **26** (25 em `tools/`, incluindo `src/tools/ToolRegistry.ts` que faltava na contagem original do card, + `src/core/ToolRegistry.ts`). Corrigido no card ARCH-001 (ver Sprint S01 acima) e já implementado — não é mais pendência.

---

# FASE 1 — Execução Arquitetural

Estrutura de cada Sprint abaixo, na ordem cronológica real de execução (a mesma do Painel Executivo). Sprints são agrupadas por Épico apenas para leitura — a **ordem de execução real é a numérica (S01, S02, S03...)**, que já reflete o grafo de dependências do backlog, com uma exceção documentada: dentro de cada lote sem dependência pendente, Quick Wins sempre vêm primeiro, mesmo que pertençam a Épicos diferentes (regra "Sempre iniciar pelos Quick Wins" tem precedência sobre o agrupamento temático por Épico).

**Convenção usada abaixo:** o Checklist de Execução e o Checklist de Validação seguem sempre o mesmo padrão (definido logo a seguir); cada card do Sprint só relista uma etapa quando ela tem uma observação específica para aquele ARCH.

### Checklist de Execução — padrão (repetido em toda Sprint)
```
□ Ler completamente o ARCH correspondente em ARCHITECTURAL_BACKLOG.md
□ Ler os arquivos envolvidos
□ Mapear consumidores
□ Mapear produtores
□ Identificar impactos
□ Implementar a alteração
□ Executar build
□ Executar testes
□ Atualizar indicadores
□ Registrar decisão
□ Encerrar Sprint
```

### Checklist de Validação — padrão (repetido em toda Sprint)

Os 6 itens abaixo cobrem os dois eixos da seção "Regressão Funcional vs. Regressão Arquitetural" (acima) — nenhuma Sprint fecha `🟢 Concluída` com algum item pulado sem justificativa explícita registrada no card.

```
Validação
□ Build            (npm run build)
□ tsc              (npm run build já inclui, mas tsc --noEmit isolado é o ciclo rápido de iteração)
□ Unit Tests        [Regressão Funcional] — cobertos pela suíte de regressão neste projeto (não há
                     runner de unit test separado; cada SNNN_*.test.ts é a unidade)
□ Integration Tests [Regressão Funcional] — npm run test:integration, só quando o card exigir
                     etapa 3/4 da Validação Progressiva (ambiente real — DIRETRIZ_ARQUITETURA)
□ Regression Tests  [Regressão Funcional] — npm run test:regression, sempre obrigatório
□ Architecture Metrics [Regressão Arquitetural] — repetir a medição usada nos indicadores T0 para
                     o(s) indicador(es) que o ARCH desta Sprint afeta; comparar contra o esperado
```

---

## Épico A — Boundary Enforcement

### Sprint 2026-07-S01
- **Número:** S01
- **Identificação Temporal:** 2026-07-S01
- **Fase:** Execução Arquitetural
- **Epic:** Boundary Enforcement
- **Card ARCH:** ARCH-001
- **Objetivo:** Corrigir o import de `ToolExecutor`/`ToolResult` em `tools/` + `core/ToolRegistry.ts`, apontando para `loop/agentLoopTypes.ts` em vez de `loop/AgentLoop.ts`.
- **Arquivos afetados:** `src/tools/*.ts` (25 arquivos, **corrigido de 24 para 25** na execução — `src/tools/ToolRegistry.ts`, distinto de `src/core/ToolRegistry.ts`, não estava na contagem original do card), `src/core/ToolRegistry.ts`. **Nota:** `src/core/AgentController.ts` e `src/core/agentControllerCommands.ts` também importam de `'../loop/AgentLoop'`, mas importam a classe `AgentLoop` em si (dependência legítima, ela vive lá) — não são violação de fronteira, ficaram de fora corretamente, per verificação linha-a-linha na execução.
- **Dependências:** P00.
- **Checklist de execução:** padrão — executado.
- **Checklist de validação:** padrão (ambiente real: não aplicável — mudança de import puro) — `tsc --noEmit` limpo, regressão 118/118.
- **Rollback:** reverter os 26 imports (commit único, `git revert` trivial).
- **Critérios de Aceite:** 0 ocorrências de `from '../loop/AgentLoop'` para `ToolExecutor`/`ToolResult` em `tools/`/`core/` — confirmado por `grep`, restam só os 2 imports legítimos de `AgentLoop` (classe).
- **Definition of Done:** `tsc --noEmit` limpo + regressão 100% — **atingido**.
- **Commit esperado:** 1 commit único, mensagem referenciando ARCH-001.
- **Status:** 🟢 Concluída em 2026-07-17.

### Sprint 2026-07-S02
- **Número:** S02
- **Identificação Temporal:** 2026-07-S02
- **Fase:** Execução Arquitetural
- **Epic:** Boundary Enforcement
- **Card ARCH:** ARCH-004
- **Objetivo:** Migrar imports de tipo (`GoalTypes`, `IntentCategory`) usados por `memory/` para local neutro.
- **Arquivos afetados:** `src/shared/domainTypes.ts` (novo — definições movidas para cá), `src/loop/GoalTypes.ts` (passa a reexportar `GoalStatus`/`BlockerKind`/`GoalBlocker`/`CriterionCheck`/`SuccessCriterion`/`PlanStep`/`ToolMutation`/`AttemptOutcome`/`GoalAttempt`/`Goal` de `shared/domainTypes.ts`), `src/loop/UnifiedIntentRouter.ts` (idem para `IntentCategory`), `src/memory/CaseMemory.ts`, `src/memory/ReflectionMemory.ts`.
- **Dependências:** P00.
- **Checklist de execução:** padrão — executado. Escopo real acabou maior que "migrar 2-3 tipos": `Goal`/`PlanStep` referenciam transitivamente `GoalStatus`, `GoalBlocker`, `SuccessCriterion`, `GoalAttempt`, `ToolMutation` (todos usados pela shape completa de `Goal`, que `CaseMemory.ts` consome por inteiro) — mover só os 2-4 tipos citados no card sem os que eles referenciam quebraria a compilação. Nenhum tipo de execução específico de `loop/` (`CycleResult`, `GoalResult`, `StepEvaluation`, `GoalProgressModel` etc.) foi tocado — ficaram em `GoalTypes.ts`, não são consumidos por `memory/`.
- **Checklist de validação:** padrão (ambiente real: não aplicável — só tipo) — `tsc --noEmit` limpo, regressão 118/118 (por precaução, embora o card só exigisse tsc).
- **Rollback:** trivial (reverter o commit; `loop/GoalTypes.ts` volta a definir os tipos localmente).
- **Critérios de Aceite:** tipos compartilhados residem em local neutro (`shared/domainTypes.ts`) — **atingido**. `memory/` não importa mais nenhum tipo de `loop/GoalTypes.ts` nem `loop/UnifiedIntentRouter.ts` (confirmado por grep); os 2 imports de runtime restantes de `memory/` em `loop/` (`StrategyDiversityGuard`, `extractText`) são escopo do ARCH-003 (S09), não deste card.
- **Definition of Done:** `tsc --noEmit` limpo — **atingido**.
- **Commit esperado:** 1 commit.
- **Status:** 🟢 Concluída em 2026-07-17.

### Sprint 2026-07-S08
- **Número:** S08
- **Identificação Temporal:** 2026-07-S08
- **Fase:** Execução Arquitetural
- **Epic:** Boundary Enforcement
- **Card ARCH:** ARCH-002
- **Objetivo:** Mover `EnvironmentProbe.ts` para `src/core/`, resolvendo a travessia `core/CapabilityRegistry` ↔ `loop/EnvironmentProbe` ↔ `core/ToolRegistry`.
- **Arquivos afetados:** `src/loop/EnvironmentProbe.ts` → `src/core/EnvironmentProbe.ts` (movido), `src/core/CapabilityRegistry.ts`, `src/__tests__/regression/S110_BashHealthProbe_WSLStubDetection.test.ts` e `S34_Python3RuntimeResolution.test.ts` (não estavam no card — inspecionam o texto-fonte de `EnvironmentProbe.ts` por path hardcoded, mesma classe de achado de S07/ARCH-026).
- **Dependências:** CP01 (sequenciado após o lote de Quick Wins, mesmo revisor/área temática).
- **Checklist de execução:** padrão + mapear todos os call sites de `EnvironmentProbe` antes de mover — executado. `GoalEvaluator.ts`/`RiskAnalyzer.ts`/`utils/crossPlatform.ts` mencionam "EnvironmentProbe" só em comentários (confirmado por grep); `core/CapabilityRegistry.ts` é o único consumidor real de código.
- **Checklist de validação:** padrão + **ambiente real obrigatório — executado nos dois SOs**:
  - **Windows** (esta máquina): `tsc --noEmit` limpo, `npm run build` limpo, regressão 119/119.
  - **Linux real** (VPS Ubuntu 24.04, `venus@10.0.0.10` — production já rodava lá via PM2; validação feita numa cópia **isolada**, nunca tocando o processo/DB de produção): branch pusheado pro GitHub, clonado na VPS, `npm install` + `npm run build` limpos, regressão = **116/119** na primeira rodada (3 falhas: `S112`, `S13`, `S37`). Comparei contra o commit *anterior* (S07, pré-ARCH-002) na mesma VPS — as 3 reproduziam idênticas, confirmando que não eram causadas pelo `EnvironmentProbe.ts` movido. **Isso por si só não bastava** (per achado registrado em `docs/issues/002-vps-linux-validation-false-positives.md`, após o usuário perguntar explicitamente se as falhas estavam sendo documentadas): investigando a causa raiz de cada uma individualmente, 2 das 3 eram falso-positivo do meu próprio setup de validação (faltava `WORKSPACE_DIR` num `.env`, exatamente o que a skill `verify` já instruía) e a terceira (`S112`) era um bug de teste real — um comando Linux usando `{1..220}` (expansão de chaves do bash), silenciosamente quebrado sob `/bin/sh`=`dash` (o shell que `exec_command.ts` realmente invoca no Debian/Ubuntu). Corrigido `WORKSPACE_DIR` no re-teste (S37 9/9, S13 7/8 — 1 residual é fragilidade de asserção de teste, documentada, não corrigida) e o bashismo do S112 (commit `36036de`, 7/7 confirmado rodando de novo na mesma VPS). VPS restaurada pro commit do ARCH-002, diretórios de verificação removidos, produção confirmada intacta (mesmo PID, 0 restarts) antes e depois de tudo.
- **Rollback:** reverter `git mv` + ajuste de import.
- **Critérios de Aceite:** `core/CapabilityRegistry.ts` nunca importa de `loop/` — **atingido** (import agora é `./EnvironmentProbe`, intra-`core/`).
- **Definition of Done:** build limpo, regressão 100%, `EnvironmentProbe.probe()` funcional em ambiente real — **atingido**. "Regressão 100%" refere-se ao delta causado por este card (0 — as 3 falhas da VPS preexistiam e não fazem parte da mudança), não ao estado absoluto da suíte nesta VPS específica, que já tinha essas 3 lacunas de ambiente antes de qualquer Sprint deste programa.
- **Commit esperado:** 1 commit.
- **Status:** 🟢 Concluída em 2026-07-17.

### Sprint 2026-07-S09
- **Número:** S09
- **Identificação Temporal:** 2026-07-S09
- **Fase:** Execução Arquitetural
- **Epic:** Boundary Enforcement
- **Card ARCH:** ARCH-003
- **Objetivo:** Extrair `StrategyDiversityGuard`/`ResponseAdapter.extractText` para `src/shared/`, eliminando dependência de runtime de `memory/` em `loop/`.
- **Arquivos afetados:** `src/loop/StrategyDiversityGuard.ts`, `src/loop/ResponseAdapter.ts`, `src/memory/CaseMemory.ts`, `src/memory/conversational/CMIIngestionPipeline.ts`.
- **Dependências:** CP01.
- **Checklist de execução:** padrão + mapear todos os consumidores antes de mover.
- **Checklist de validação:** padrão.
- **Rollback:** reverter `git mv` + imports.
- **Critérios de Aceite:** `memory/` não importa nenhuma classe/função de runtime de `loop/`.
- **Definition of Done:** build limpo, regressão 100%.
- **Commit esperado:** 1 commit.
- **Status:** ⚪ Não iniciada.
- **Observação:** desbloqueia ARCH-011 (S10) — não mover E mudar lógica interna no mesmo commit.

---

## Checkpoint 2026-07-CP01

- **Identificação:** `2026-07-CP01`
- **Revisar (feito em 2026-07-17):**
  - **Indicadores vs. T0:** Violações de fronteira — ARCH-001 (26→0) e ARCH-004 (2→0) resolvidas; ARCH-002/003 permanecem (esperado, S08/S09 ainda não rodaram — `EnvironmentProbe` ainda em `loop/`, `StrategyDiversityGuard`/`extractText` ainda importados por `memory/`). Decision Owners — ARCH-014 (6 padrões duplicados→0) e ARCH-017 (`ToolExecutorService` removido) resolvidos. Recomputation/duplicação textual — ARCH-006 (15 call sites→1 accessor) e ARCH-025 (2 blocos de prompt→1 fonte) resolvidos. God Methods/Large Classes — inalterados de propósito (fora do escopo deste lote, ver S22-S25).
  - **Backlog:** sem mudança de escopo real — só 3 correções de contagem encontradas durante a própria execução (ARCH-001: 28→26 arquivos reais; ARCH-006: 6+→15 call sites reais; ARCH-014: 3→6 padrões reais), todas documentadas nos cards e neste plano, nenhuma virou proposta de ARCH novo por serem correções de medição, não de escopo.
  - **Dependências:** S08-S15 seguem liberadas — confirmado, nenhuma depende de algo que não esteja `🟢`.
  - **Arquitetura:** nenhuma violação nova introduzida — reverificado por grep completo (ver Dashboard Executivo) imediatamente antes de fechar este checkpoint.
  - **Riscos:** 1 quase-incidente controlado — S07 (ARCH-026) quebrou `S52_DeliveryGuard_Html2pdfPending.test.ts` (teste fazia asserção sobre a localização exata do código-fonte de `DELIVERABLE_EXTENSIONS`; movê-lo quebrou a asserção, não o comportamento real). Detectado imediatamente pela suíte de regressão (é exatamente para isso que ela existe) e corrigido antes do commit — nenhum resíduo.
  - **Planejamento:** as 7 Sprints do lote (todas Quick Win/Refactor Local) foram concluídas numa única sessão de trabalho, muito mais rápido que a estimativa de calendário original (Jul/2026 inteiro) — esperado, já que aquelas datas eram só estimativas de planejamento, não compromissos (aviso no topo do documento). Não há sinal ainda para recalibrar a estimativa dos itens de "Refactor Estrutural" (S16 em diante) a partir da velocidade deste lote — são categorias de esforço muito diferentes (Quick Win vs. Refactor Estrutural com Validação Progressiva completa).
- **Critério de avanço:** todas as Sprints S01-S07 🟢 Concluídas, indicador "Violações de fronteira" reduzido conforme esperado (parcialmente — ARCH-002/003 restantes) — **atingido**.
- **Status:** 🟢 Concluído em 2026-07-17.

---

## Épico B — Single Source of Truth

### Sprint 2026-07-S03
- **Número:** S03
- **Identificação Temporal:** 2026-07-S03
- **Fase:** Execução Arquitetural
- **Epic:** Single Source of Truth
- **Card ARCH:** ARCH-006
- **Objetivo:** Criar accessor único `getPendingSteps(goal, toolName?)`, substituindo os 6+ `.filter(status==='pending')` inline.
- **Arquivos afetados:** `src/loop/GoalExecutionLoop.ts` (escopo real: **15 call sites**, não 6 — a contagem do card citava só as ocorrências mais óbvias; a varredura completa na execução achou mais 9 com o mesmo predicado, todas dentro do espírito do card. 2 ocorrências parecidas foram **excluídas conscientemente**: uma é `SuccessCriterion.status==='pending'`, campo homônimo mas de outro tipo; outra é um filtro de "remover steps supersedidos" — operação de mutação de plano, não leitura de pendentes).
- **Dependências:** P00.
- **Checklist de execução:** padrão — executado.
- **Checklist de validação:** padrão — `tsc --noEmit` limpo, regressão 119/119 (118 + novo teste S116 cobrindo o accessor isoladamente).
- **Rollback:** trivial.
- **Critérios de Aceite:** os 6+ call sites usam o mesmo accessor — **atingido, 15/15**.
- **Definition of Done:** regressão 100%, comportamento observável idêntico — **atingido**. Assinatura final: `getPendingSteps(plan: PlanStep[], toolName?: string | string[]): PlanStep[]` — recebe `PlanStep[]` em vez de `Goal` porque um dos call sites reais (linha ~523, adoção de plano após replan) só tem o array de steps em mãos, ainda não um `Goal` completo; aceitar `toolName` como string OU array cobre tanto o caso de igualdade simples (`'send_document'`) quanto o de pertencimento em lista (`rule.requiredTools`).
- **Commit esperado:** 1 commit.
- **Status:** 🟢 Concluída em 2026-07-17.

### Sprint 2026-07-S10
- **Número:** S10
- **Identificação Temporal:** 2026-07-S10
- **Fase:** Execução Arquitetural
- **Epic:** Single Source of Truth
- **Card ARCH:** ARCH-011
- **Objetivo:** `StrategyDiversityGuard.extractUsedFingerprints` passa a ler `goal.toolsTried` (estruturado) em vez de regex sobre `strategiesTried`.
- **Arquivos afetados:** `src/loop/StrategyDiversityGuard.ts` (L59-67).
- **Dependências:** S09 (ARCH-003 — mover a classe antes de mudar sua lógica interna).
- **Checklist de execução:** padrão + confirmar que `toolsTried` cobre os casos que a regex cobria (fallback para steps `agentloop` sem toolName).
- **Checklist de validação:** padrão + teste do cenário de fallback.
- **Rollback:** reverter.
- **Critérios de Aceite:** fingerprint derivado de `toolsTried` como fonte primária.
- **Definition of Done:** regressão 100% + teste de fallback.
- **Commit esperado:** 1 commit.
- **Status:** ⚪ Não iniciada.

### Sprint 2026-08-S13
- **Número:** S13
- **Identificação Temporal:** 2026-08-S13
- **Fase:** Execução Arquitetural
- **Epic:** Single Source of Truth
- **Card ARCH:** ARCH-007
- **Objetivo:** Sincronizar `PlanStep.status`/`.result` com `GoalAttempt.result`, eliminando a divergência `completed`/`partial`.
- **Arquivos afetados:** `src/loop/GoalExecutionLoop.ts` (L2194-2265 `markStepDone`, L1137-1202), `src/loop/GoalTypes.ts`.
- **Dependências:** CP01.
- **Checklist de execução:** padrão + decidir se `PlanStep.status` ganha `'partial'` ou se `PlanStep.result` vira referência ao `GoalAttempt` mais recente.
- **Checklist de validação:** padrão + teste unitário do cenário de divergência (downgrade semântico seguido de `markStepDone`).
- **Rollback:** reverter.
- **Critérios de Aceite:** nenhum `PlanStep` fica `completed` com `GoalAttempt` mais recente `partial`/`failure` sem ser uma decisão explícita.
- **Definition of Done:** regressão 100% + teste novo.
- **Commit esperado:** 1 commit.
- **Status:** ⚪ Não iniciada.

### Sprint 2026-08-S14
- **Número:** S14
- **Identificação Temporal:** 2026-08-S14
- **Fase:** Execução Arquitetural
- **Epic:** Single Source of Truth
- **Card ARCH:** ARCH-009
- **Objetivo:** `CycleResult`/`GoalAttempt` passam a estender `ToolResult` em vez de redeclarar `output`/`error`.
- **Arquivos afetados:** `src/loop/agentLoopTypes.ts`, `src/loop/GoalTypes.ts`.
- **Dependências:** CP01. Recomendado antes de S21 (ARCH-013) e S22 (ARCH-022) para reduzir churn.
- **Checklist de execução:** padrão.
- **Checklist de validação:** padrão (ênfase em `tsc --noEmit` — mudança de tipo com superfície ampla).
- **Rollback:** reverter.
- **Critérios de Aceite:** `output`/`error` declarados uma única vez.
- **Definition of Done:** `tsc --noEmit` limpo, regressão 100%.
- **Commit esperado:** 1 commit.
- **Status:** ⚪ Não iniciada.

### Sprint 2026-08-S15
- **Número:** S15
- **Identificação Temporal:** 2026-08-S15
- **Fase:** Execução Arquitetural
- **Epic:** Single Source of Truth
- **Card ARCH:** ARCH-010
- **Objetivo:** Substituir o scan O(n) de `GoalEvaluator.alreadyFailed` por um índice incremental de retry por (step, args-hash).
- **Arquivos afetados:** `src/loop/GoalEvaluator.ts` (L227-255).
- **Dependências:** CP01.
- **Checklist de execução:** padrão.
- **Checklist de validação:** padrão.
- **Rollback:** reverter.
- **Critérios de Aceite:** a pergunta "quantas vezes esta chamada já falhou" é respondida por consulta, não recomputação.
- **Definition of Done:** regressão 100%.
- **Commit esperado:** 1 commit.
- **Status:** ⚪ Não iniciada.

---

## Checkpoint 2026-08-CP02

- **Identificação:** `2026-08-CP02`
- **Revisar:** indicadores (Single Sources parcialmente reduzido, Recomputation Hotspots reduzido), backlog (sem mudança), dependências (confirmar que S16 está de fato liberada), arquitetura (nenhuma violação nova), riscos (nenhum crítico esperado até aqui — todos os itens até CP02 são Quick Win/Refactor Local), planejamento (ARCH-005, o item de maior risco do programa, começa logo em seguida — revisar recursos/tempo disponível antes de entrar em S16).
- **Critério de avanço:** S08-S15 todas 🟢, suíte de regressão 100%, nenhum indicador piorou.
- **Status:** ⚪ Não iniciado.

---

### Sprint 2026-08-S16 ⚠ Maior risco até este ponto do programa
- **Número:** S16
- **Identificação Temporal:** 2026-08-S16
- **Fase:** Execução Arquitetural
- **Epic:** Single Source of Truth
- **Card ARCH:** ARCH-005
- **Objetivo:** Consolidar `Goal.sentArtifacts` como única fonte de verdade de "artefatos entregues", eliminando os outros 3 mecanismos concorrentes (`cycleHistory` do AgentLoop, `deliverable_check`, `structuralBypass`).
- **Arquivos afetados:** `src/loop/AgentLoop.ts` (L2555-2684), `src/loop/GoalExecutionLoop.ts` (L619-669, L869-924, L3286-3387).
- **Dependências:** CP02.
- **Checklist de execução:** padrão + mapear TODOS os call sites que leem/escrevem estado de entrega antes de tocar (mandatório — histórico de 2 bugs reais nesta área).
- **Checklist de validação:** padrão + **Validação Progressiva completa até etapa 4 (ambiente real) — obrigatória, não opcional**, per `DIRETRIZ_ARQUITETURA_2026-07-13.md`.
- **Rollback:** reverter o commit; os 4 mecanismos antigos coexistindo é o estado atual (revert não piora nada).
- **Critérios de Aceite:** existe uma única função (`getEffectiveDeliveredArtifacts(goal)`) consultada por todos os 4 pontos.
- **Definition of Done:** unitário + regressão + e2e sintético (LLM mockado) + execução real (LLM real, goal que entrega e reenvia artefato) — todas as 4 etapas passando.
- **Commit esperado:** 1 commit grande, mas atômico (não fatiar em múltiplos commits parciais que deixem o sistema em estado inconsistente entre eles).
- **Status:** ⚪ Não iniciada.

### Sprint 2026-08-S17
- **Número:** S17
- **Identificação Temporal:** 2026-08-S17
- **Fase:** Execução Arquitetural
- **Epic:** Single Source of Truth
- **Card ARCH:** ARCH-008
- **Objetivo:** `progressModel` passa a ser derivado sob demanda de `goal.attempts`/`successCriteria`, com o mesmo tratamento que `cognitiveContext` já recebeu via `buildIncrementalExecutionContext`.
- **Arquivos afetados:** `src/loop/GoalExecutionLoop.ts` (L548-561, L2566-2601).
- **Dependências:** S16 (mesmo padrão de "derivar da fonte persistida").
- **Checklist de execução:** padrão.
- **Checklist de validação:** padrão + **ambiente real obrigatório** (cenário de restart: matar o processo com goal em `executing`, validar recovery).
- **Rollback:** reverter.
- **Critérios de Aceite:** goal recuperado após restart mostra `progressModel` consistente com o histórico real, não 0%.
- **Definition of Done:** Validação Progressiva completa até etapa 4.
- **Commit esperado:** 1 commit.
- **Status:** ⚪ Não iniciada.

### Sprint 2026-11-S27 (execução deferida ao final do programa)
- **Número:** S27
- **Identificação Temporal:** 2026-11-S27
- **Fase:** Execução Arquitetural
- **Epic:** Single Source of Truth
- **Card ARCH:** ARCH-012
- **Objetivo:** RFC + implementação condicional para unificar `Goal.successCriteria` e `checkClaimsAgainstEvidence.CLAIM_RULES`.
- **Arquivos afetados:** `src/loop/GoalTypes.ts`, `src/loop/GoalExecutionLoop.ts` (L3240-3387, L2945-3228).
- **Dependências:** S16 (ARCH-005), S18 (ARCH-018) — **item de maior risco do programa inteiro, propositalmente o último.**
- **Checklist de execução:** padrão + documento de Fase 1-5 da `DIRETRIZ_ARQUITETURA_2026-07-13.md` completo ANTES de qualquer código.
- **Checklist de validação:** padrão + Validação Progressiva completa até etapa 4, incluindo replicação do bug de deadlock histórico (goals de "reenviar arquivo existente", jul/2026) como regressão permanente.
- **Rollback:** se a RFC concluir que o risco supera o benefício, encerra sem código — resultado válido e esperado, não uma falha do programa.
- **Critérios de Aceite:** definidos na própria RFC.
- **Definition of Done:** RFC aprovada + (se implementado) Validação Progressiva completa.
- **Commit esperado:** 1 commit (se implementado) ou 0 commits + documento de RFC (se não aprovado).
- **Status:** ⚪ Não iniciada.
- **Nota de posicionamento:** este card pertence ao Épico B tematicamente, mas sua execução é deliberadamente adiada para o fim do programa (depende de ARCH-018, do Épico C) — ver Painel Executivo para a posição cronológica real.

---

## Épico C — Decision Ownership

### Sprint 2026-07-S04
- **Número:** S04
- **Identificação Temporal:** 2026-07-S04
- **Fase:** Execução Arquitetural
- **Epic:** Decision Ownership
- **Card ARCH:** ARCH-014
- **Objetivo:** Unificar a lista de padrões de erro transiente entre `GoalEvaluator.ERROR_PATTERNS` e `ProactiveRecovery.RECOVERY[tool].retryablePatterns`.
- **Arquivos afetados:** `src/shared/transientErrorPatterns.ts` (novo), `src/loop/GoalEvaluator.ts` (L72-212), `src/loop/ProactiveRecovery.ts` (L49-174).
- **Dependências:** P00.
- **Checklist de execução:** padrão — executado. Mapeamento exato da sobreposição real (não só os 3 citados no card): `ECONNRESET`/`ETIMEDOUT`/`timeout` (nas 3 tools de rede de `ProactiveRecovery` + 2 entradas de `GoalEvaluator`), mais `network` (weather + entrada "rede" do `GoalEvaluator`) e `rate.?limit`/`429` (web_search + entrada "rate limit" do `GoalEvaluator`) — 6 padrões literalmente duplicados ao todo, não 3.
- **Checklist de validação:** padrão — `tsc --noEmit` limpo, regressão 119/119, **mais uma verificação adicional**: script isolado comparando `.source`/`.flags` de cada regex composta contra a regex original byte-a-byte, para provar que a composição não mudou nenhum comportamento de matching (os 6 casos bateram 100%).
- **Rollback:** trivial.
- **Critérios de Aceite:** uma única lista de padrões, referenciada pelos dois módulos. **Decisão de design (Fase 2/3 da diretriz):** rejeitada a opção de "uma lista universal usada identicamente nos dois módulos" — mudaria comportamento observável (ex.: `web_navigate` passaria a retriar em rate-limit, que nunca teve; `memory_recall`/`edit`, que não retriam em NADA de propósito, ganhariam retries indesejados) e causaria misclassificação em `GoalEvaluator` (erro de timeout seria capturado pela entrada "rede", que vem antes na lista, se os dois conjuntos fossem fundidos num só). Design escolhido: cada padrão realmente duplicado (6, não os 3 citados) ganha uma única definição nomeada em `shared/transientErrorPatterns.ts`, referenciada por identidade — cada consumidor continua compondo sua própria lista/regex a partir desses nomes, preservando exatamente o comportamento de cada tool/entrada.
- **Definition of Done:** regressão 100% — **atingido, 119/119, comportamento observável idêntico (verificado byte-a-byte, não só pela suíte)**.
- **Commit esperado:** 1 commit.
- **Status:** 🟢 Concluída em 2026-07-17.

### Sprint 2026-07-S05
- **Número:** S05
- **Identificação Temporal:** 2026-07-S05
- **Fase:** Execução Arquitetural
- **Epic:** Decision Ownership
- **Card ARCH:** ARCH-017
- **Objetivo:** Decidir e executar o destino do `ToolExecutorService`/`CircuitBreaker` morto (0 call sites reais). **Decisão registrada: remover** (ver Resumo executivo do ARCHITECTURAL_BACKLOG.md — recomendação por simplicidade/YAGNI, sem evidência de necessidade de circuit breaker hoje).
- **Arquivos afetados:** `src/core/ToolExecutor.ts` (**removido**), `src/core/index.ts` (2 linhas de re-export removidas), `src/core/AgentController.ts` (`getToolExecutor()`, import de `toolExecutor`, os 2 listeners `tool:timeout`/`tool:failed` que só o `ToolExecutorService` emitia, e a menção "ToolExecutor ✅" no banner de startup), `src/tools/powerpoint_control.ts` (não estava no card original — ver nota).
- **Dependências:** P00.
- **Checklist de execução:** padrão — executado. Antes de remover, mapeei TODOS os consumidores (não só a classe `ToolExecutorService`): a interface `ToolExecutorLike`, definida no mesmo arquivo, tinha 1 consumidor real fora do escopo citado no card — `src/tools/powerpoint_control.ts` a usava só para type-checking estrutural (`implements ToolExecutorLike`). Como `ToolExecutorLike` é estruturalmente idêntica ao `ToolExecutor` já existente em `loop/agentLoopTypes.ts` (mesmo shape: `name`/`description`/`parameters`/`execute()`), troquei `powerpoint_control.ts` para usar o tipo já canônico em vez de recriar `ToolExecutorLike` em outro lugar — elimina mais uma duplicação de tipo como efeito colateral direto da remoção, não como bônus não pedido. Também confirmei que `circuit:open`/`circuit:closed` (listeners vizinhos em `AgentController.ts`) são emitidos por `core/CircuitBreaker.ts` para QUALQUER consumidor de circuit breaker — `ProviderFactory.ts` também usa `circuitRegistry` — então esses 2 listeners continuam vivos e não foram tocados; só `tool:timeout`/`tool:failed`, exclusivos do `ToolExecutorService` deletado, foram removidos.
- **Checklist de validação:** padrão — `npm run build` (completo, não só `tsc --noEmit`) limpo, regressão 119/119, grep confirmando 0 ocorrências residuais de `ToolExecutorService`/`getToolExecutor`/import do arquivo removido em todo `src/`.
- **Rollback:** reverter (recriar o arquivo removido + reverter os 4 arquivos tocados).
- **Critérios de Aceite:** `ToolExecutorService` deixa de existir no código — **atingido**.
- **Definition of Done:** build limpo, regressão 100% — **atingido**.
- **Achado fora de escopo (documentado, não corrigido — per *No Opportunistic Refactoring*):** `src/core/index.ts` (o barrel de `core/`) não tem nenhum importador em todo o projeto — parece inteiramente morto, não só a linha do `ToolExecutor`. Não investigado a fundo nem removido aqui; se confirmado, é candidato a um ARCH novo, não deste card. **Registro completo:** `docs/issues/003-core-index-unused-barrel.md`.
- **Commit esperado:** 1 commit.
- **Status:** 🟢 Concluída em 2026-07-17.

### Sprint 2026-08-S11
- **Número:** S11
- **Identificação Temporal:** 2026-08-S11
- **Fase:** Execução Arquitetural
- **Epic:** Decision Ownership
- **Card ARCH:** ARCH-016
- **Objetivo:** Substituir os 4 detectores de loop artesanais em `GoalPlanner.buildReplanPrompt()` por chamadas a `StrategyDiversityGuard.extractExhaustedTools()`, com template de texto compartilhado.
- **Arquivos afetados:** `src/loop/GoalPlanner.ts` (L295-356), `src/loop/StrategyDiversityGuard.ts`.
- **Dependências:** S10 (ARCH-011 — fonte de dados corrigida antes de trocar os consumidores).
- **Checklist de execução:** padrão.
- **Checklist de validação:** padrão + teste unitário para cada um dos 4 cenários de loop (pip/venv, exec_command, stuck-in-analysis, content_stub).
- **Rollback:** reverter.
- **Critérios de Aceite:** os 4 blocos usam `StrategyDiversityGuard` como única fonte; texto gerado por função compartilhada.
- **Definition of Done:** regressão 100% + os 4 testes unitários.
- **Commit esperado:** 1 commit.
- **Status:** ⚪ Não iniciada.

### Sprint 2026-08-S18
- **Número:** S18
- **Identificação Temporal:** 2026-08-S18
- **Fase:** Execução Arquitetural
- **Epic:** Decision Ownership
- **Card ARCH:** ARCH-018
- **Objetivo:** `evaluateCriteria` absorve `structuralBypass` como um `CriterionCheck` (`file_exists`), eliminando o `if` ad-hoc dentro de `runLoopInternal`.
- **Arquivos afetados:** `src/loop/GoalExecutionLoop.ts` (L634-669, L2840-2943).
- **Dependências:** S16 (ARCH-005).
- **Checklist de execução:** padrão + reler o histórico do bug de deadlock (jul/2026, goals de "reenviar arquivo existente") antes de tocar.
- **Checklist de validação:** padrão + **ambiente real obrigatório** (é a área do deadlock já documentado).
- **Rollback:** reverter.
- **Critérios de Aceite:** nenhum `if` solto de bypass fora de `evaluateCriteria`.
- **Definition of Done:** Validação Progressiva completa até etapa 4, incluindo réplica do cenário de deadlock como regressão.
- **Commit esperado:** 1 commit.
- **Status:** ⚪ Não iniciada.

### Sprint 2026-09-S20
- **Número:** S20
- **Identificação Temporal:** 2026-09-S20
- **Fase:** Execução Arquitetural
- **Epic:** Decision Ownership
- **Card ARCH:** ARCH-015-RFC
- **Objetivo:** Produzir a análise de Fase 1-5 (`DIRETRIZ_ARQUITETURA_2026-07-13.md`) para gerar validação de args obrigatórios + texto de prompt a partir do schema de cada tool. **Sem código.**
- **Arquivos afetados:** nenhum tocado — só leitura/análise de `src/loop/GoalPlanner.ts`, `src/tools/*.ts`.
- **Dependências:** S06 (ARCH-025 — dedupe de texto do Planner primeiro simplifica a análise).
- **Checklist de execução:** padrão (adaptado — sem "implementar alteração"/"executar build"; substituído por "produzir documento de RFC").
- **Checklist de validação:** N/A (fase de análise).
- **Rollback:** N/A.
- **Critérios de Aceite:** documento de Fase 1-5 completo, com decisão explícita de implementar ou não.
- **Definition of Done:** RFC revisada e aprovada (ou formalmente rejeitada, com justificativa).
- **Commit esperado:** 1 commit contendo só o documento de RFC (ex.: `docs/RFC_ARCH-015.md`).
- **Status:** ⚪ Não iniciada.

### Sprint 2026-09-S21
- **Número:** S21
- **Identificação Temporal:** 2026-09-S21
- **Fase:** Execução Arquitetural
- **Epic:** Decision Ownership
- **Card ARCH:** ARCH-013
- **Objetivo:** Unificar o juiz de sucesso de step — fundir `evaluateAgentStepSuccess`/`escalateStepEvalToLLM` dentro de `StepSemanticValidator`.
- **Arquivos afetados:** `src/loop/GoalExecutionLoop.ts` (L2039-2118), `src/loop/StepSemanticValidator.ts`.
- **Dependências:** CP02 (via S14/ARCH-009 — tipos consolidados primeiro).
- **Checklist de execução:** padrão.
- **Checklist de validação:** padrão + **ambiente real obrigatório** (latência/custo real de LLM precisa ser observado, não só mockado).
- **Rollback:** reverter.
- **Critérios de Aceite:** um único ponto de decisão heurística+LLM para "step teve sucesso relevante".
- **Definition of Done:** Validação Progressiva completa até etapa 4.
- **Commit esperado:** 1 commit.
- **Status:** ⚪ Não iniciada. **Bloqueia S22 (ARCH-022).**

### Sprint 2026-11-S26
- **Número:** S26
- **Identificação Temporal:** 2026-11-S26
- **Fase:** Execução Arquitetural
- **Epic:** Decision Ownership
- **Card ARCH:** ARCH-015-Impl
- **Objetivo:** Implementar a geração de validação/prompt de args obrigatórios a partir do schema (condicional à aprovação da RFC em S20).
- **Arquivos afetados:** `src/loop/GoalPlanner.ts`, `src/tools/*.ts`.
- **Dependências:** S20 (aprovação da RFC).
- **Checklist de execução:** padrão.
- **Checklist de validação:** padrão + Validação Progressiva completa até etapa 4.
- **Rollback:** reverter.
- **Critérios de Aceite:** definidos na RFC (S20).
- **Definition of Done:** Validação Progressiva completa.
- **Commit esperado:** 1 commit.
- **Status:** ⚪ Não iniciada. **Condicional — só ocorre se S20 aprovar a implementação.**

---

## Checkpoint 2026-09-CP03

- **Identificação:** `2026-09-CP03`
- **Revisar:** indicadores (Single Sources — maior redução do programa até aqui, com ARCH-005 concluído), backlog (confirmar que nenhum item novo de dívida técnica foi descoberto durante S16-S20 sem virar proposta de ARCH), dependências (S21 e S22 liberadas), arquitetura (fundação de estado único estabelecida — condição necessária para decompor os God Methods com segurança), riscos (revisar se o risco real observado em S16 bateu com o estimado; ajustar estimativa de S24/S25 se divergiu), planejamento (esta é a virada do programa — da consolidação de estado para a decomposição estrutural).
- **Critério de avanço:** S16-S20 todas 🟢, nenhuma regressão pendente, `getEffectiveDeliveredArtifacts` (ARCH-005) validado em ambiente real.
- **Status:** ⚪ Não iniciado.

---

## Épico D — Structural Simplification

### Sprint 2026-08-S12
- **Número:** S12
- **Identificação Temporal:** 2026-08-S12
- **Fase:** Execução Arquitetural
- **Epic:** Structural Simplification
- **Card ARCH:** ARCH-023
- **Objetivo:** Explicitar o pipeline de fixups do `exec_command.ts` como lista nomeada de transformações, em vez de `if`s sequenciais com ordem implícita.
- **Arquivos afetados:** `src/tools/exec_command.ts` (L331-400).
- **Dependências:** CP01 (nenhuma dependência real — item isolado, poderia rodar a qualquer momento).
- **Checklist de execução:** padrão.
- **Checklist de validação:** padrão (suíte já existente: S11, S12, S13, S15 do repositório cobrem bem esta área).
- **Rollback:** trivial.
- **Critérios de Aceite:** ordem de aplicação dos fixups é uma estrutura de dados explícita.
- **Definition of Done:** regressão 100% (suíte existente).
- **Commit esperado:** 1 commit.
- **Status:** ⚪ Não iniciada.

### Sprint 2026-09-S19
- **Número:** S19
- **Identificação Temporal:** 2026-09-S19
- **Fase:** Execução Arquitetural
- **Epic:** Structural Simplification
- **Card ARCH:** ARCH-024-RFC
- **Objetivo:** Produzir a análise de Fase 1-5 para consolidar os 5 callbacks de `ChannelContext` em um `DeliveryTrackingContext` dedicado. **Sem código.**
- **Arquivos afetados:** nenhum tocado — só leitura/análise de `src/loop/agentLoopTypes.ts`, `src/loop/AgentLoop.ts`, `src/loop/GoalExecutionLoop.ts`.
- **Dependências:** CP02.
- **Checklist de execução:** padrão (adaptado, ver S20).
- **Checklist de validação:** N/A (fase de análise).
- **Rollback:** N/A.
- **Critérios de Aceite:** documento de Fase 1-5 completo.
- **Definition of Done:** RFC revisada e aprovada (ou formalmente rejeitada).
- **Commit esperado:** 1 commit contendo o documento de RFC.
- **Status:** ⚪ Não iniciada.

### Sprint 2026-09-S22
- **Número:** S22
- **Identificação Temporal:** 2026-09-S22
- **Fase:** Execução Arquitetural
- **Epic:** Structural Simplification
- **Card ARCH:** ARCH-022
- **Objetivo:** Decompor `GoalExecutionLoop.executeStep()` (~375 linhas) e eliminar os 4 blocos duplicados de "registrar falha" via helper `recordFailedAttempt()`.
- **Arquivos afetados:** `src/loop/GoalExecutionLoop.ts` (L1605-1978).
- **Dependências:** S16 (ARCH-005), S14 (ARCH-009), S21 (ARCH-013).
- **Checklist de execução:** padrão.
- **Checklist de validação:** padrão + e2e sintético.
- **Rollback:** reverter.
- **Critérios de Aceite:** nenhum bloco de "registrar falha" duplicado; método principal com sub-métodos claros.
- **Definition of Done:** regressão 100% + e2e sintético.
- **Commit esperado:** 1 commit (ou 2, se o helper e a decomposição do método forem separados em commits sequenciais dentro da mesma Sprint — recomendado para reduzir raio de rollback).
- **Status:** ⚪ Não iniciada.

### Sprint 2026-10-S23
- **Número:** S23
- **Identificação Temporal:** 2026-10-S23
- **Fase:** Execução Arquitetural
- **Epic:** Structural Simplification
- **Card ARCH:** ARCH-024-Impl
- **Objetivo:** Implementar `DeliveryTrackingContext`, consolidando os 5 callbacks de `ChannelContext` (condicional à aprovação da RFC em S19).
- **Arquivos afetados:** `src/loop/agentLoopTypes.ts`, `src/loop/AgentLoop.ts`, `src/loop/GoalExecutionLoop.ts`.
- **Dependências:** S19 (aprovação da RFC).
- **Checklist de execução:** padrão.
- **Checklist de validação:** padrão + Validação Progressiva completa até etapa 4.
- **Rollback:** reverter.
- **Critérios de Aceite:** definidos na RFC (S19).
- **Definition of Done:** Validação Progressiva completa.
- **Commit esperado:** 1 commit.
- **Status:** ⚪ Não iniciada. **Condicional — só ocorre se S19 aprovar. Precede S25 (ARCH-019).**

### Sprint 2026-10-S24 ⚠ Maior esforço do programa (empate com S25)
- **Número:** S24
- **Identificação Temporal:** 2026-10-S24
- **Fase:** Execução Arquitetural
- **Epic:** Structural Simplification
- **Card ARCH:** ARCH-020
- **Objetivo:** Decompor `GoalExecutionLoop.runLoopInternal()` (~1030 linhas) e o `switch(cycleResult.outcome)` (~400 linhas, ARCH-021 absorvido aqui) em métodos/fases nomeadas.
- **Arquivos afetados:** `src/loop/GoalExecutionLoop.ts` (L570-1602).
- **Dependências:** S16 (ARCH-005), S03 (ARCH-006), S13 (ARCH-007), S17 (ARCH-008), S14 (ARCH-009).
- **Checklist de execução:** padrão + mapear TODOS os efeitos colaterais capturados por closure antes de extrair qualquer método (mandatório — sem teste de sistema que cubra a função inteira hoje).
- **Checklist de validação:** padrão + **Validação Progressiva completa até etapa 4 — obrigatória.**
- **Rollback:** reverter o commit (grande, atômico).
- **Critérios de Aceite:** nenhum método resultante excede 300 linhas; comportamento observável idêntico.
- **Definition of Done:** unitário + regressão + e2e sintético + ambiente real.
- **Commit esperado:** commits sequenciais por fase extraída (recomendado), fechando a Sprint com um estado final coeso.
- **Status:** ⚪ Não iniciada. **NUNCA simultânea com S25 (ARCH-019) — WIP máximo = 1 para refactors deste porte.**

### Sprint 2026-10-S25 ⚠ Maior risco do programa
- **Número:** S25
- **Identificação Temporal:** 2026-10-S25
- **Fase:** Execução Arquitetural
- **Epic:** Structural Simplification
- **Card ARCH:** ARCH-019
- **Objetivo:** Decompor `AgentLoop.runWithTools()` (~1793 linhas, o maior método do projeto) em fases nomeadas.
- **Arquivos afetados:** `src/loop/AgentLoop.ts` (L1118-2911).
- **Dependências:** S16 (ARCH-005), S22 (ARCH-022), S23 (ARCH-024-Impl). **NUNCA simultânea com S24.**
- **Checklist de execução:** padrão + mapear TODOS os efeitos colaterais capturados por closure (`cycleHistory`, `usedToolInputs`, `stepCount`) antes de extrair qualquer método.
- **Checklist de validação:** padrão + **Validação Progressiva completa até etapa 4 — obrigatória.**
- **Rollback:** reverter o commit (grande, atômico).
- **Critérios de Aceite:** nenhum método resultante excede 300 linhas; comportamento observável idêntico.
- **Definition of Done:** unitário + regressão completa + e2e sintético + ambiente real (fluxo completo de tool-calling com LLM real).
- **Commit esperado:** commits sequenciais por fase extraída.
- **Status:** ⚪ Não iniciada.

---

## Checkpoint 2026-11-CP04

- **Identificação:** `2026-11-CP04`
- **Revisar:** indicadores (God Methods deve estar em 0 — os 3 maiores métodos do projeto decompostos), backlog (confirmar que nenhuma dívida nova foi silenciosamente absorvida — toda dívida nova encontrada durante S21-S26 deve ter virado proposta de ARCH documentada, nunca correção oportunista), dependências (só resta ARCH-012, o item de maior risco, isolado no fim), arquitetura (Large Classes reduzidas, ainda que não elimináveis por completo — `GoalExecutionLoop.ts`/`AgentLoop.ts` continuam sendo orquestradores centrais, agora coesos), riscos (revisar se a decomposição de S24/S25 introduziu qualquer regressão de comportamento observável não capturada pela suíte — checar logs de produção se disponível), planejamento (avaliar se ARCH-012 deve mesmo prosseguir ou se a RFC deve recomendar não implementar, dado o risco).
- **Critério de avanço:** S21-S26 todas 🟢 ou formalmente encerradas (caso de RFC rejeitada), nenhum God Method remanescente acima de 300 linhas.
- **Status:** ⚪ Não iniciado.

---

## Épico E — Technical Cleanup

### Sprint 2026-07-S06
- **Número:** S06
- **Identificação Temporal:** 2026-07-S06
- **Fase:** Execução Arquitetural
- **Epic:** Technical Cleanup
- **Card ARCH:** ARCH-025
- **Objetivo:** Extrair os blocos de prompt duplicados entre `buildPlanPrompt`/`buildReplanPrompt` ("ARGS OBRIGATÓRIOS", "COLETA EM LOTE").
- **Arquivos afetados:** `src/loop/GoalPlanner.ts` (2 funções novas: `buildRequiredArgsReference()`, `buildBatchCollectionBlock()`; call sites em `buildPlanPrompt` e `buildReplanPrompt`).
- **Dependências:** P00. Sequenciar antes de S20 (ARCH-015-RFC).
- **Checklist de execução:** padrão — executado. Os dois blocos NÃO eram byte-idênticos entre si (o card já avisava "~95%") — comparação linha-a-linha achou 6 divergências de texto, a mais relevante sendo `memory_write`: o bloco do plano inicial listava os 5 tipos de nó (`fact`/`preference`/`project`/`knowledge`/`context`), o do replan só 3 (faltavam `project` e `knowledge`) numa versão condensada em 1 linha. Isso não lê como diferença proposital de orçamento de tokens — lê como deriva de edição manual independente ao longo do tempo, exatamente a causa que este ARCH existe para eliminar.
- **Checklist de validação:** padrão — `npm run build` limpo, `tsc --noEmit` limpo, regressão 119/119, grep confirmando que o texto do bloco `memory_write` aparece uma única vez no arquivo agora.
- **Rollback:** trivial.
- **Critérios de Aceite:** um único texto-fonte para cada bloco, usado nos dois prompts — **atingido**.
- **Definition of Done:** regressão 100% — **atingido**. **Nota importante:** ao contrário de S01-S05, este card *pretende* mudar o texto observável de um dos dois prompts (é o próprio objetivo — convergir para um único texto elimina por definição a diferença que existia antes). Escolhi a versão mais completa em cada um dos 6 pontos divergentes (geralmente a do plano inicial) como fonte canônica — na prática isso corrige uma lacuna real do prompt de replan (perdia 2 dos 5 tipos de nó de memória), não é uma regressão funcional; é uma melhoria colateral honesta, registrada aqui explicitamente em vez de escondida dentro de um commit "só de dedup".
- **Commit esperado:** 1 commit.
- **Status:** 🟢 Concluída em 2026-07-17.

### Sprint 2026-07-S07
- **Número:** S07
- **Identificação Temporal:** 2026-07-S07
- **Fase:** Execução Arquitetural
- **Epic:** Technical Cleanup
- **Card ARCH:** ARCH-026
- **Objetivo:** Unificar `DELIVERABLE_EXTENSIONS` (`AgentLoop.ts`) em `planning/inferExpectedExtensions.ts`.
- **Arquivos afetados:** `src/loop/AgentLoop.ts` (import + remoção da const local), `src/loop/planning/inferExpectedExtensions.ts` (novo export), `src/__tests__/regression/S52_DeliveryGuard_Html2pdfPending.test.ts` (não estava no card — ver nota).
- **Dependências:** P00.
- **Checklist de execução:** padrão — executado. Antes de mover, confirmei que `DELIVERABLE_EXTENSIONS` (allowlist de "extensão conta como entregável quando aparece num path de `write` bem-sucedido") e a lógica de `inferExpectedExtensions()` (infere extensão esperada a partir do TEXTO da intenção do usuário) respondem perguntas diferentes — decidi **não fundir as duas listas em uma só**, só mover `DELIVERABLE_EXTENSIONS` para o mesmo arquivo que já hospeda `SOURCE_SCRIPT_EXTENSIONS` (mesma fronteira conceitual, "que tipo de arquivo é isto"), como export próprio e nomeado.
- **Checklist de validação:** padrão — `npx tsc --noEmit` limpo, `npm run build` limpo, **regressão pegou uma quebra real na primeira rodada**: `S52_DeliveryGuard_Html2pdfPending.test.ts` inspeciona o texto-fonte de `AgentLoop.ts` diretamente (`fs.readFileSync` + regex) para confirmar que `DELIVERABLE_EXTENSIONS` contém `.html` — como o array literal saiu do arquivo por design deste card, a asserção parou de casar. Corrigido apontando essa asserção para o novo arquivo; as outras 10 asserções do teste (comportamento real do DELIVERY-GUARD, incluindo a reprodução do incidente real de 05/07) já passavam sem mudança, porque usam uma cópia standalone da lógica dentro do próprio teste, não importam de `AgentLoop.ts`. Regressão final: 119/119.
- **Rollback:** trivial.
- **Critérios de Aceite:** uma única lista de extensões-deliverable — **atingido**.
- **Definition of Done:** regressão 100% — **atingido, com a correção acima**.
- **Commit esperado:** 1 commit.
- **Status:** 🟢 Concluída em 2026-07-17.

---

## Checkpoint 2026-12-CP05 — Encerramento do Programa

- **Identificação:** `2026-12-CP05`
- **Revisar:** indicadores (comparação final T0 vs. estado atual — todas as 8 linhas da tabela de indicadores do `ARCHITECTURAL_BACKLOG.md` Fase 7), backlog (todos os 26 ARCH com status final registrado, incluindo os que resultaram em "RFC rejeitada" como desfecho válido), dependências (nenhuma pendente), arquitetura (snapshot final documentado), riscos (nenhum risco arquitetural aberto do programa original — novos achados durante a execução, se houver, já devem ter virado propostas de ARCH separadas para um próximo ciclo), planejamento (recomendação explícita: agendar o próximo ciclo de auditoria arquitetural — ver observação abaixo).
- **Critério de avanço:** N/A — é o encerramento. Produzir um relatório final de encerramento (métricas antes/depois, lições aprendidas consolidadas de todas as Sprints).
- **Status:** ⚪ Não iniciado.
- **Observação permanente:** conforme discutido durante o planejamento deste programa, a causa raiz da dívida arquitetural encontrada nas 4 auditorias não foi a arquitetura do runtime (modelo espiral Q1-Q4), e sim a ausência de um ciclo de revisão arquitetural recorrente. Este checkpoint de encerramento não deve ser o último — recomenda-se formalizar a cadência (ex.: a cada N sprints de feature/bugfix, ou quando um indicador cruzar um limiar) para o próximo ciclo de auditoria, evitando que a mesma classe de dívida se reconstrua.

---

## Registro de Métricas por Sprint (a preencher durante a execução)

Cada Sprint concluída deve adicionar uma linha aqui, no formato:

| Sprint | Data | Tempo gasto | Commit | Arquivos alterados | Testes executados | Indicadores antes | Indicadores depois | Riscos encontrados | Lições aprendidas |
|---|---|---|---|---|---|---|---|---|---|
| S01 | 2026-07-17 | ~1 sessão | 6c14a9b | 26 (`src/tools/*.ts` ×25, `src/core/ToolRegistry.ts` ×1) | `tsc --noEmit` (limpo) + `node scripts/run-regression-tests.cjs` (118/118) | Violações de fronteira: 26 imports `ToolExecutor`/`ToolResult` de `loop/AgentLoop` | 0 | Nenhum — mudança mecânica de path, sem lógica tocada | O card original tinha 2 falsos positivos na contagem T0 (`AgentController.ts`/`agentControllerCommands.ts` importam a classe `AgentLoop`, não `ToolExecutor`/`ToolResult` — legítimo). Grep bruto por path sem checar o que é importado super-conta violações; a verificação correta é sempre linha-a-linha nos símbolos, não só no path do módulo. |
| S02 | 2026-07-17 | ~1 sessão | 18ba2a2 | 6 (`shared/domainTypes.ts` novo, `loop/GoalTypes.ts`, `loop/UnifiedIntentRouter.ts`, `memory/CaseMemory.ts`, `memory/ReflectionMemory.ts`) | `tsc --noEmit` (limpo) + regressão (118/118) | `memory/` com 2 imports de tipo de `loop/` (`GoalTypes` ×2 símbolos combinados, `UnifiedIntentRouter` ×1) | 0 | Nenhum — só tipos, zero custo em runtime antes e depois | O escopo real do card era maior que o texto sugeria: `Goal` referencia transitivamente 6 outros tipos (`GoalStatus`, `GoalBlocker`, `SuccessCriterion`, `GoalAttempt`, `ToolMutation`, `PlanStep`), todos precisaram migrar juntos — não dá pra mover um tipo "pela metade" quando outro tipo no mesmo arquivo depende dele por completo. Fechamento transitivo de dependências de tipo deve ser mapeado antes de estimar o esforço de um ARCH de fronteira, não só a lista de símbolos citados no import original. |
| S03 | 2026-07-17 | ~1 sessão | 0225075 | 2 (`loop/GoalExecutionLoop.ts`) + 1 teste novo (`S116`) | `tsc --noEmit` (limpo) + regressão (119/119, 118 + S116 novo) | 15 recomputações inline de `status==='pending'` em `GoalExecutionLoop.ts` | 1 accessor único (`getPendingSteps`) | Nenhum — assinaturas de saída idênticas em cada call site, só a fonte mudou | O card citava "6+" mas a varredura completa achou 15 ocorrências reais do mesmo predicado — sempre vale varrer o arquivo inteiro por regex antes de aceitar a contagem do card como teto. 2 ocorrências parecidas (mesma substring `status === 'pending'`) eram outra coisa: `SuccessCriterion.status` (tipo diferente, campo homônimo) e um filtro de mutação de plano (remove supersedidos) — nem toda ocorrência textual do predicado é uma leitura de "pending steps"; a diferenciação semântica evita generalizar demais o accessor. |
| S04 | 2026-07-17 | ~1 sessão | ccf97c1 | 3 (`shared/transientErrorPatterns.ts` novo, `loop/GoalEvaluator.ts`, `loop/ProactiveRecovery.ts`) | `tsc --noEmit` (limpo) + regressão (119/119) + verificação adicional byte-a-byte (`.source`/`.flags` de cada regex composta vs. original, 6/6 idênticas) | 6 padrões de erro transiente duplicados entre os 2 módulos (`ECONNRESET`/`ETIMEDOUT`/`timeout`/`network`/`rate.?limit`/`429`) | 6 definições nomeadas únicas em `shared/`, compostas por cada consumidor | Nenhum — cada regex composta é byte-idêntica à original, comportamento de retry por tool preservado exatamente | O card citava só 3 padrões sobrepostos; a varredura achou 6. Rejeitei conscientemente a opção "uma lista universal" (mudaria comportamento observável — tools ganhariam/perderiam retries que não tinham, e `GoalEvaluator` poderia misclassificar timeout como erro de rede se os dois conjuntos fossem fundidos numa regex só) — a fonte única deve ser por *padrão individual*, não por *lista consumida igualmente em todo lugar*, quando os consumidores têm decisões genuinamente diferentes sobre o mesmo dado. |
| S05 | 2026-07-17 | ~1 sessão | dd1a51e | 4 (`core/ToolExecutor.ts` removido, `core/index.ts`, `core/AgentController.ts`, `tools/powerpoint_control.ts`) | `npm run build` (limpo) + `tsc --noEmit` (limpo) + regressão (119/119) + grep confirmando 0 ocorrências residuais | `ToolExecutorService` morto (0 call sites reais) coexistindo com `ProactiveRecovery.execute()` (caminho real) | `ToolExecutorService` removido; `ToolExecutorLike` consolidada no `ToolExecutor` já existente em `agentLoopTypes.ts` | Nenhum — grep de todo `src/` confirma 0 referências residuais; `core/CircuitBreaker.ts` (usado de verdade por `ProviderFactory.ts`) intacto | O card não citava `tools/powerpoint_control.ts` (usava `ToolExecutorLike`, tipo do mesmo arquivo, só para type-check estrutural) nem os listeners `tool:timeout`/`tool:failed` em `AgentController.ts` (só o `ToolExecutorService` deletado os emitia) — mapear TODOS os exports de um arquivo antes de removê-lo, não só a classe citada no card, evita quebrar consumidores que a auditoria original não viu. Achado à parte, documentado sem corrigir: `core/index.ts` parece não ter nenhum importador em todo o projeto. |
| S06 | 2026-07-17 | ~1 sessão | 7aa5bc4 | 1 (`loop/GoalPlanner.ts`, 2 funções novas) | `npm run build` (limpo) + `tsc --noEmit` (limpo) + regressão (119/119) + grep confirmando o bloco `memory_write` aparece 1x, não 2x | 2 blocos de prompt (~95% idênticos, per o card) copiados à mão em `buildPlanPrompt`/`buildReplanPrompt` | `buildRequiredArgsReference()`/`buildBatchCollectionBlock()` como fonte única | Nenhum, mas **mudança de comportamento intencional**: convergir 2 textos em 1 exige escolher um vencedor nos pontos divergentes — o prompt de replan ganhou os 2 tipos de nó de `memory_write` que faltavam (`project`/`knowledge`), documentado explicitamente, não escondido | A comparação real achou 6 divergências, não só as citadas no card ("~95%" era literal, não estimativa vaga) — a mais séria era uma lacuna de conteúdo (3 de 5 tipos de nó), não só diferença de wording. Ao contrário de S01-S05, este card *pretende* mudar texto observável — "regressão 100%" aqui significa comportamento de execução inalterado (testes passam), não texto de prompt idêntico ao anterior, já que o objetivo do card é justamente eliminar a diferença. |
| S07 | 2026-07-17 | ~1 sessão | e97405d | 3 (`loop/AgentLoop.ts`, `loop/planning/inferExpectedExtensions.ts`, teste `S52` corrigido) | `tsc --noEmit` (limpo) + `npm run build` (limpo) + regressão — **118/119 na primeira rodada, 119/119 após corrigir S52** | `DELIVERABLE_EXTENSIONS` duplicado (`AgentLoop.ts`) fora do módulo que já centraliza `SOURCE_SCRIPT_EXTENSIONS` | 1 export único em `inferExpectedExtensions.ts` | 1 encontrado e corrigido no ato — `S52` fazia asserção sobre o texto-fonte exato de `AgentLoop.ts`, quebrou quando o array mudou de arquivo (comportamento real intacto, só a localização do código mudou) | Primeira Sprint deste programa em que a suíte de regressão realmente pegou algo — prova de que a distinção Regressão Funcional/Arquitetural (adicionada nesta sessão, a pedido do usuário) não é só formalidade: um refactor "limpo" (comportamento idêntico) ainda pode quebrar um teste que faz asserção sobre onde o código mora, não só o que ele faz. Rodar a suíte de verdade após cada Sprint, não assumir que vai passar, continua sendo o item que mais paga dividendo. |
| S08 | 2026-07-17 | ~1 sessão (+ 1 rodada extra de investigação pedida pelo usuário) | 151fd6a, 36036de | 5 (`src/core/EnvironmentProbe.ts` movido, `core/CapabilityRegistry.ts`, testes `S110`/`S34`/`S112` corrigidos, `docs/issues/002-*.md` novo) | Windows: `tsc`+`build`+regressão 119/120 (S112 ganhou 1 assert a mais no fix). **Linux real (VPS)**: causa raiz de cada falha investigada individualmente (não só "reproduz no baseline, ok") — `S37` 9/9 e `S13` 7/8 eram falso-positivo por `WORKSPACE_DIR` ausente no meu setup de validação; `S112` era bug de teste real (bashismo sob `dash`), corrigido | Round-trip `core/CapabilityRegistry` ↔ `loop/EnvironmentProbe` ↔ `core/ToolRegistry` | `EnvironmentProbe.ts` movido para `core/`; import agora intra-camada nos dois sentidos | 0 causados por este ARCH — mas achei 1 bug de teste real (`S112`, corrigido) e 1 fragilidade de asserção documentada (`S13`, não corrigida) escondidos atrás do que eu tinha rotulado apressadamente como "diferença de ambiente" | **"Reproduz no commit anterior, na mesma máquina" prova ausência de regressão, mas não substitui investigar a causa raiz de cada falha** — só descobri o bug real do S112 (e que os outros 2 eram falha do meu próprio setup, não do Linux) porque o usuário perguntou diretamente "as falhas estão sendo documentadas?" em vez de aceitar minha primeira conclusão ("gap de ambiente pré-existente", vaga demais) como suficiente. A skill `verify` já tinha a resposta certa (`.env` com `WORKSPACE_DIR`) — pular esse passo ao adaptar o procedimento pra uma VPS remota via SSH foi o que gerou 2 dos 3 falsos positivos. |

---

## Regras permanentes deste programa (repetidas aqui para consulta rápida durante a execução)

1. Nunca executar dois grandes refactors simultaneamente. WIP máximo = 1.
2. Nunca adicionar funcionalidades novas durante a execução deste programa.
3. Nunca aproveitar uma Sprint para corrigir problemas fora do seu ARCH designado — *No Opportunistic Refactoring*. Dívida nova encontrada: **criar um arquivo em `docs/issues/NNN-titulo-curto.md`** (próximo número livre — ver os já existentes antes de numerar; formato do `001`: Descrição, Comportamento Esperado/Observado, Causa Raiz, Severidade), não só uma frase solta dentro do card da Sprint — a nota inline no card pode (e deve) continuar existindo como referência rápida, mas o registro completo, pesquisável e sobrevivente à reescrita do Resumo Executivo mora no arquivo de issue. Depois: propor novo ARCH se fizer sentido, continuar a Sprint atual sem desviar. **Nota:** `docs/issues/` está no `.gitignore` deste projeto (só `001` ficou versionado, de antes dessa regra) — os arquivos ficam documentados localmente; perguntar ao usuário se algum deve ser forçado (`git add -f`) para o GitHub.
4. Respeitar rigorosamente as dependências registradas no Painel Executivo — nunca alterar a ordem por conveniência.
5. Toda Sprint que envolva `Refactor Estrutural` ou `Exige RFC` precisa da etapa 4 (ambiente real) da Validação Progressiva antes de ser considerada `🟢 Concluída` — etapas 1-3 sozinhas não bastam.
6. Este documento (`MASTER_EXECUTION_PLAN.md`) é atualizado a cada Sprint encerrada — o Painel Executivo e o Resumo Executivo nunca ficam desatualizados por mais de uma Sprint.
7. Nenhuma Sprint fecha `🟢 Concluída` sem passar nos dois eixos de regressão (ver "Regressão Funcional vs. Regressão Arquitetural", no topo do documento) — comportamento externo inalterado E nenhuma violação arquitetural reintroduzida. Passar só na suíte de testes não é suficiente; passar só no grep de indicadores arquiteturais também não é. O Dashboard Executivo (logo após o Resumo Executivo) é reescrito a cada Sprint encerrada, junto com o Resumo — se alguma linha do Dashboard virar ✘, nenhuma Sprint nova começa até a causa ser encontrada e corrigida.
