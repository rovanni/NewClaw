# MASTER_EXECUTION_PLAN.md — Refatoração Arquitetural NewClaw

**Este documento NÃO substitui `ARCHITECTURAL_BACKLOG.md`.** O backlog é a fonte de verdade sobre O QUÊ e POR QUÊ (descrição de cada problema, evidências, arquivos, critérios). Este documento é a fonte de verdade sobre QUANDO e COMO EXECUTAR — a ordem operacional, o rastreamento de status e o histórico de execução.

**Antes de implementar qualquer Sprint, ler `RETROSPECTIVA_PREMISSAS_AUDITORIA.md`** — catálogo cumulativo de premissas do backlog que não se sustentaram na execução (7 de 11 Sprints até agora) e os 3 modos de falha recorrentes da auditoria original. Não é opcional, é o histórico do que já deu errado quando essa reverificação foi pulada.

**Antes de mexer em qualquer arquivo, também checar `DEPENDENCIAS_ORDEM_IMPLICITA.md`** — catálogo cumulativo de trechos de código cujo comportamento correto depende de uma ORDEM de execução ou de dados só documentada num comentário solto (não reforçada por tipo, estrutura ou teste). Um desses casos (`RiskAnalyzer.ts`) já causou um bug real de produção quando reordenado sem essa consciência. Sempre que uma Sprint encontrar um comentário do tipo "roda antes/depois de", "ordem importa", "precisa ser checado antes/depois" — tratar como invariante a preservar e, se for uma instância nova, registrar no documento.

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
| 2026-07-S09 | Jul/2026 | Boundary Enforcement | ARCH-003 | 🟢 | CP01 | d9efaff | `memory/` 0 imports de runtime de `loop/`; achado colateral doc. em issues/004 |
| 2026-07-S10 | Jul/2026 | Single Source of Truth | ARCH-011 | 🟢 | S09 | fbaf1a0 | Fonte primária estruturada aditiva + fallback agentloop; 14 tools "invisíveis" corrigidas de brinde |
| 2026-08-S11 | Ago/2026 | Decision Ownership | ARCH-016 | 🟢 | S10 | 52e8e3c | Template compartilhado nos 4 blocos; fonte estruturada aditiva só em exec_command (1/4, correto per docs/issues/006) |
| 2026-08-S12 | Ago/2026 | Structural Simplification | ARCH-023 | 🟢 | CP01 | 88ede55 | Pipeline nomeado (4 steps), gates de validação preservados como ifs, S11 corrigido |
| 2026-08-S13 | Ago/2026 | Single Source of Truth | ARCH-007 | 🟢 | CP01 | 216f039 | `PlanStep.lastAttemptOutcome` novo campo; gatilho real ≠ premissa literal do card (ver ARCHITECTURAL_BACKLOG "Executado como") — teste novo S119, 122/122 |
| 2026-08-S14 | Ago/2026 | Single Source of Truth | ARCH-009 | ⏸ | CP01 | 92c46da (docs) | Adiado antes de codificar — prescrição do card (`extends ToolResult`) não compila + reintroduz violação de fronteira do ARCH-004; consolidado em `REVISAO_CONSOLIDADA_TIPOS_PENDENTE.md` |
| 2026-08-S15 | Ago/2026 | Single Source of Truth | ARCH-010 | 🟢 | CP01 | ebea0f5 | `hasIdenticalFailedAttempt()` nomeado + `computeToolInputKey` (não índice persistido — SSOT/restart-safety), fix colateral direto: dedup de `send_document` por `file_path`, teste `S120`, 123/123 |
| 2026-08-CP02 | Ago/2026 | Checkpoint | — | 🟢 | S08-S15 | — | S08-S13/S15 🟢 (7/8), S14 ⏸ adiada com justificativa registrada (não é falha); 0 violações de fronteira novas, regressão 123/123, nenhum indicador piorou |
| 2026-08-S16 | Ago/2026 | Single Source of Truth | ARCH-005 | 🟢 | CP02 | 7abede2 | Escopo redesenhado (Fase 1/2): premissa das "4 estruturas desincronizadas" não se sustentou; fix cirúrgico de normalização de path (`resolvePath`) em `deliverable_check`, achado real confirmado em ambiente real (LLM real, goal real), `S121` novo, 124/124 |
| 2026-08-S17 | Ago/2026 | Single Source of Truth | ARCH-008 | ⏸ | S16 | 4e01818 | Adiado antes de codificar — premissa citava "recovery no boot" que não existe (6º modo de falha); defeito real via resumeGoal()/auth, fix desenhado em `docs/issues/009` |
| 2026-08-S18 | Ago/2026 | Decision Ownership | ARCH-018 | ⏸ | S16 | 4171d31 | Adiado antes de codificar — `file_exists` checa attempt, não disco (2ª instância do modo 3); reaproveitá-lo reintroduziria o deadlock histórico; fix desenhado em `docs/issues/010` |
| 2026-09-S19 | Set/2026 | Structural Simplification | ARCH-024-RFC | 🟢 | CP02 | 9b6fc80 | RFC aprovada, escopo corrigido: 4 campos consolidados (não 5 — `recentMessages` não é delivery-tracking); campo aninhado `deliveryTracking`, não parâmetro separado; ver `RFC_ARCH-024_DeliveryTrackingContext.md` |
| 2026-09-S20 | Set/2026 | Decision Ownership | ARCH-015-RFC | 🟢 | S06 | b883cac | RFC aprovada com escopo REDUZIDO: só texto de prompt (`requiredArgsHint`); validação não aprovada (lógica condicional em 3+ tools, sem incidente real motivando); ver `RFC_ARCH-015_SchemaGeneratedRequiredArgs.md` |
| 2026-09-CP03 | Set/2026 | Checkpoint | — | 🟢 | S16-S20 | — | S16/S19/S20 🟢 (3/5), S17/S18 ⏸ adiadas com justificativa (não bloqueiam); 0 violações de fronteira novas, regressão 124/124; risco de S16 não extrapolado pra baixo em S24/S25 |
| 2026-09-S21 | Set/2026 | Decision Ownership | ARCH-013 | ⏸ | CP03, S14 | 505a8a9 | Adiado antes de codificar — premissa CORRETA e prescrição viável, mas fundir sem ajuste perde sinal `stepSuccessConfident` (7º modo de falha); fix desenhado em `docs/issues/011` |
| 2026-09-S22 | Set/2026 | Structural Simplification | ARCH-022 | ⚪ | S16, S14, S21 | — | — |
| 2026-10-S23 | Out/2026 | Structural Simplification | ARCH-024-Impl | ⚪ | S19 (aprovação) | — | — |
| 2026-10-S24 | Out/2026 | Structural Simplification | ARCH-020 | ⚪ | S16, S03, S13, S17, S14 | — | — |
| 2026-10-S25 | Out/2026 | Structural Simplification | ARCH-019 | ⚪ | S16, S22, S23; **nunca simultânea com S24** | — | — |
| 2026-11-S26 | Nov/2026 | Decision Ownership | ARCH-015-Impl | ⚪ | S20 (aprovação — cumprida, escopo reduzido) | — | — |
| 2026-11-CP04 | Nov/2026 | Checkpoint | — | ⚪ | S21-S26 | — | — |
| 2026-11-S27 | Nov/2026 | Single Source of Truth | ARCH-012 | ⚪ | S16, S18 | — | — |
| 2026-12-CP05 | Dez/2026 | Checkpoint de Encerramento | — | ⚪ | S27 | — | — |

---

## RESUMO EXECUTIVO

**Programa:** Refatoração Arquitetural NewClaw
**Status Geral:** 🟢 Em execução — Fase 0, S01-S13/S15/S16/S19/S20, Checkpoints CP01/CP02/CP03 concluídos; S14/S17/S18 adiadas (ver abaixo)
**Progresso:** 15 / 26 ARCH concluídos (~58%) — ARCH-008 (S17), ARCH-009 (S14), ARCH-013 (S21) e ARCH-018 (S18) adiados, não contam como concluídos nem como pendências simples. ARCH-024 e ARCH-015 têm RFC aprovada (S19/S20), mas só contam como concluídos quando a Impl (S23/S26) landar — Definition of Done de ambos os cards exige as duas etapas
**Sprint Atual:** Nenhuma em andamento (S21 adiada antes de codificar — próxima é 2026-09-S22)
**Próxima Sprint:** 2026-09-S22 (ARCH-022) — decompor `GoalExecutionLoop.executeStep()` e eliminar os 4 blocos duplicados de "registrar falha"; não bloqueada pelo adiamento de S21 (dependência era sequenciamento)
**Epic Atual:** Epic A concluído; Epic B "concluído" no sentido de nenhum item executável restante nesta ordem — ARCH-005/006/007/010/011 feitos, ARCH-008 adiado, ARCH-012 deliberadamente deferido para o fim do programa; Epic C — ARCH-014/015(RFC)/016/017 feitos/aprovados, ARCH-008/013/018 adiados (nenhum bloqueia S22); Epic D iniciado — ARCH-023 feito, ARCH-024 com RFC aprovada (Impl em S23); Epic E concluído — ARCH-025/026 feitos
**Próximo Marco:** 2026-11-CP04
**Última Atualização:** 2026-07-18 (Sprint S21 adiada)
**Build:** 🟢 `npm run build` limpo (inalterado — S17/S18/S19/S20/S21/CP03 não tocaram código de produção)
**Testes:** 🟢 124/124 (inalterado)
**Regressão:** 🟢 124/124 (pós-S16, inalterado)
**Riscos Abertos:** 0 materializados — nota permanente: a VPS `venus@10.0.0.10` usada para validação Linux tem histórico de exigir `.env`/`WORKSPACE_DIR` explícito (skill `verify`) para não gerar falso-positivo — ver `docs/issues/002`. S16 (ARCH-005) teve o escopo redesenhado na Fase 1/2 para um fix cirúrgico — risco real ficou bem menor que o estimado, mas isso NÃO deve ser extrapolado para S24/S25 (ver revisão de riscos do CP03) — a redução veio de a premissa do card estar errada, não de a área ser inerentemente mais fácil.
**RFCs Pendentes:** 1 (ARCH-012, deliberadamente por último) — ARCH-024 (S19) e ARCH-015 (S20) concluíram a RFC, ambas aprovadas com escopo corrigido/reduzido em relação ao card original; Impls agendadas para S23/S26
**Temas Adiados para Revisão Consolidada:** 1 (ARCH-009 — ver `docs/refatoracao-arquitetural-2026/REVISAO_CONSOLIDADA_TIPOS_PENDENTE.md`, que já lista ARCH-024 e `docs/issues/004` como temas correlatos a tratar junto quando essa revisão abrir)
**Temas Adiados sem Consolidação (categoria própria):** 3 (ARCH-008 — premissa citava mecanismo de recovery-no-boot inexistente, `docs/issues/009`; ARCH-018 — `file_exists` não faz o que o card presumia, reaproveitá-lo reintroduziria o deadlock histórico, `docs/issues/010`, **dependência real de ARCH-012**, não só sequenciamento; ARCH-013 — premissa correta, mas fundir sem ajuste perde o sinal `stepSuccessConfident`, `docs/issues/011`, categoria nova — 7º modo de falha)
**Dívida Arquitetural Restante:** 8 ARCH (6 cards executáveis restantes + ARCH-008/ARCH-009/ARCH-013/ARCH-018 adiados + ARCH-021 formalmente absorvido em ARCH-020, sem sprint própria)
**Achados fora de escopo documentados (`docs/issues/`):** 002 (falsos-positivos de validação VPS), 003 (`core/index.ts` barrel possivelmente morto), 004 (2 funções `extractText` com nome colidindo), 005 (regex de tool names desatualizada — corrigido de brinde na própria S10), 006 (análise de por que os 4 detectores de loop não convergem pra 1 fonte só — não é pendência, é registro de decisão), 008 (ARCH-009: `extends ToolResult` não compila + reintroduz violação de fronteira do ARCH-004 — motivo do adiamento de S14), 009 (ARCH-008: "recovery no boot" citado pelo card não existe no runtime — motivo do adiamento de S17), 010 (ARCH-018: `file_exists` checa attempt não disco, reaproveitá-lo reintroduziria o deadlock histórico — motivo do adiamento de S18), 011 (ARCH-013: fundir sem ajuste perde sinal `stepSuccessConfident` — motivo do adiamento de S21)

> Este bloco deve ser reescrito ao final de cada Sprint — não editado por trecho, substituído por inteiro — para refletir o estado real no momento.

## Dashboard Executivo — Estado Global de Validação

Snapshot do estado de validação do branch `refactor/architectural-backlog` neste momento — não de uma Sprint isolada. Se qualquer linha virar ✘, nenhuma Sprint nova deve começar até ela voltar a ✔ (a causa pode ser uma Sprint anterior que saiu do ar sem que alguém tenha notado).

| Indicador | Status | Última verificação | Evidência |
|---|---|---|---|
| Build (`npm run build`) | ✔ | 2026-07-18 (pós-S16) | Windows: limpo. Linux real (VPS Ubuntu 24.04, validado em S08): limpo |
| tsc (`tsc --noEmit`) | ✔ | 2026-07-18 (pós-S16) | 0 erros |
| Unit + Regression Tests (Regressão Funcional) | ✔ | 2026-07-18 (pós-S16) | `npm run test:regression` — 124/124 (`S121` novo, cobre normalização de path em `deliverable_check`; `S10` corrigido, asserção presa a source) |
| Integration Tests | ✔ | 2026-07-18 | Etapa 4 (ambiente real) executada em S08 (VPS Linux) e em S16 (instância isolada Windows, LLM real `glm-5.2:cloud`, goal real, dado real do SQLite) — ver `docs/issues/002` e o card de S16. S13/S15 não exigiram etapa 4 (mudanças em memória, sem dependência de SO/filesystem/LLM) |
| Architecture Metrics (Regressão Arquitetural) | ✔ | 2026-07-18 (pós-S16) | Boundary (ARCH-001/002/003/004): Epic A **concluído**. SSOT/Recomputation (ARCH-005/006/007/010/011): accessor único + fonte primária estruturada para fingerprint + `PlanStep.lastAttemptOutcome` fecha a divergência status/attempt + dedup de retry nomeado e consistente (`computeToolInputKey`) + comparação de path em `deliverable_check` normalizada (`resolvePath`). ARCH-009 (S14) **adiado** — `output`/`error` continuam redeclarados independentemente em `ToolResult`/`CycleResult`/`GoalAttempt`, sem piora em relação a T0. Decision Ownership (ARCH-014/016/017): 6/6 regexes byte-idênticas, 0 ocorrências residuais de `ToolExecutorService`, 4 detectores de loop com template compartilhado. Structural Simplification (ARCH-023): pipeline de fixups de `exec_command.ts` como array nomeado (4 steps), gates de validação preservados como `if`s. Technical Cleanup (ARCH-025/026): fonte única confirmada. Hotspots: `GoalExecutionLoop.ts` 3529+ linhas (T0: 3515), `AgentLoop.ts` 2913 linhas (T0: 2913, inalterado) |

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
- [x] Aprovar `ARCHITECTURAL_BACKLOG.md` formalmente (já ocorreu, conforme instrução recebida) — **Responsável:** Luciano Rovanni do Nascimento. **Data:** 2026-07-17.
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

**Antes de implementar, reverificar a premissa do card contra o código atual** —
`RETROSPECTIVA_PREMISSAS_AUDITORIA.md` mostra que 7 de 11 Sprints já executadas
(S01-S11) tiveram alguma alegação do card corrigida na prática: contagens (S01/S03/S04), grafo
de dependência incompleto (S02/S05), ou equivalência semântica assumida sem verificação
(S10/S11). Isso não é exceção, é a norma até agora — tratar como etapa obrigatória, não
opcional, e não assumir que "o card descreve um padrão plausível" é o mesmo que "o card está
correto". Especificamente: toda contagem numérica no card merece um grep/contagem real; todo
"mover X" merece checar o que X referencia por dentro; toda "unificar fonte A com fonte B"
merece ler como A e B são de fato populadas/decididas antes de assumir que são a mesma coisa.

**Ao ler os arquivos envolvidos, também checar dependências de ordem implícita** —
`DEPENDENCIAS_ORDEM_IMPLICITA.md` cataloga trechos cujo comportamento correto
depende de uma sequência de execução/dados só documentada em comentário solto (um deles já
causou um bug real de produção quando reordenado). Se um comentário do tipo "roda antes/depois
de", "ordem importa" aparecer num arquivo tocado pela Sprint, preservar a posição relativa
exata — não assumir que consolidar/reordenar é seguro só porque parece equivalente.

```
□ Ler completamente o ARCH correspondente em ARCHITECTURAL_BACKLOG.md
□ Reverificar cada alegação numérica/estrutural do card contra o código atual (ver nota acima)
□ Ler os arquivos envolvidos — atento a comentários de dependência de ordem (ver nota acima)
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
- **Arquivos afetados:** `src/shared/StrategyDiversityGuard.ts` (movido de `loop/`), `src/shared/extractText.ts` (novo — extraído de `loop/ResponseBuilder.ts`, não de `ResponseAdapter.ts`, que é só um shim depreciado), `src/loop/GoalExecutionLoop.ts`, `src/loop/GoalPlanner.ts`, `src/loop/ResponseBuilder.ts`, `src/memory/CaseMemory.ts`, `src/memory/conversational/CMIIngestionPipeline.ts`, teste `S22` corrigido (path hardcoded).
- **Dependências:** CP01.
- **Checklist de execução:** padrão + mapear todos os consumidores antes de mover — executado. Achado: `ResponseAdapter.ts` (citado no card) é só um shim `@deprecated` reexportando de `ResponseBuilder.ts`, onde `extractText` realmente vive — extraí só essa função (verificada sem dependências externas) para `shared/`, mantendo o resto de `ResponseBuilder.ts` (que usa `AgentState`/`ToolResult`/`sanitizeContent`, dependências reais de `loop/`) no lugar.
- **Checklist de validação:** padrão — `tsc --noEmit` limpo, `npm run build` limpo, regressão 119/119, grep confirmando 0 imports de runtime de `loop/` em `memory/`.
- **Rollback:** reverter `git mv` + imports.
- **Critérios de Aceite:** `memory/` não importa nenhuma classe/função de runtime de `loop/` — **atingido**.
- **Definition of Done:** build limpo, regressão 100% — **atingido**.
- **Achado fora de escopo (documentado, não corrigido):** existem 2 funções `extractText` diferentes no código com o mesmo nome (a movida aqui, `(content: string) => string`; e `ContentExtractor.extractText`, `(response: unknown) => string`) — docstring desta última afirma que `ContextCompressor` deveria usá-la, mas `ContextCompressor.ts` na verdade importa a OUTRA. Registro completo: `docs/issues/004-duplicate-extracttext-functions.md`.
- **Commit esperado:** 1 commit.
- **Status:** 🟢 Concluída em 2026-07-17.
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
- **Arquivos afetados:** `src/shared/StrategyDiversityGuard.ts` (movido em S09), teste novo `S117`.
- **Dependências:** S09 (ARCH-003 — mover a classe antes de mudar sua lógica interna).
- **Checklist de execução:** padrão + confirmar que `toolsTried` cobre os casos que a regex cobria (fallback para steps `agentloop` sem toolName) — executado, e a premissa do card não se sustentou inteiramente: `goal.toolsTried` é uma lista DEDUPLICADA (sem fronteira por tentativa/replan) de tools reais, não "a sequência estruturada" completa que o card presumia — trocar 1:1 teria mudado a semântica do fingerprint de "sequência ordenada exata" para algo mais fraco. Design escolhido: `toolsTried` vira fonte primária ADITIVA (soma ao Set de fingerprints, não substitui), regex sobrevive só como fallback para detectar `'agentloop'` (única coisa que `toolsTried` estruturalmente não representa — `GoalExecutionLoop.ts:1928` só grava `addToolTried` quando `step.toolName` existe).
- **Checklist de validação:** padrão + teste do cenário de fallback — `tsc --noEmit` limpo, `npm run build` limpo, regressão 120/120 (119 + `S117` novo, 6 cenários incluindo o fallback de `agentloop` explicitamente pedido pelo card).
- **Rollback:** reverter.
- **Critérios de Aceite:** fingerprint derivado de `toolsTried` como fonte primária — **atingido** (aditivamente, não substitutivamente — ver nota acima).
- **Definition of Done:** regressão 100% + teste de fallback — **atingido**.
- **Achado colateral fora de escopo, resolvido como efeito direto da mudança de fonte:** a lista hardcoded de nomes de tool no regex antigo cobria só 11 de 25 tools reais registradas — 14 tools (incluindo `ssh_exec`, `weather`, `send_audio`) nunca eram reconhecidas em `strategiesTried`. Como o regex agora só busca `'agentloop'` (não mais nomes de tool), essa classe de bug desaparece sem precisar de correção separada. Registro completo: `docs/issues/005-strategydiversityguard-stale-tool-regex.md`.
- **Commit esperado:** 1 commit.
- **Status:** 🟢 Concluída em 2026-07-17.

### Sprint 2026-08-S13 ✅ Concluída
- **Número:** S13
- **Identificação Temporal:** 2026-08-S13
- **Fase:** Execução Arquitetural
- **Epic:** Single Source of Truth
- **Card ARCH:** ARCH-007
- **Objetivo:** Sincronizar `PlanStep.status`/`.result` com `GoalAttempt.result`, eliminando a divergência `completed`/`partial`.
- **Arquivos afetados:** `src/loop/GoalExecutionLoop.ts` (`markStepDone`), `src/shared/domainTypes.ts` (`PlanStep`).
- **Dependências:** CP01.
- **Premissa reverificada:** confirmada, mas por rota causal diferente da descrita no card. O card cita "downgrade semântico roda antes do `markStepDone('skip')`" — na leitura do código atual, esse caminho específico (`shouldDowngradeToPartial`) NUNCA chega a `markStepDone` no mesmo ciclo: `cycleResult.outcome` já vira `'partial'`/`'blocked'` antes do `switch`, e nenhum desses `case`s chama `markStepDone`. O gatilho real (reproduzido em teste, S119.2) é o caminho da Sprint 0.8 já documentado no próprio código: heurística de sucesso de baixa confiança grava `GoalAttempt.result: 'partial'`, mas `toolResult.success=true` ainda leva a `cycleResult.outcome='success'` → `case 'success'` → `markStepDone(..., 'skip')`. O sintoma final (PlanStep `completed` com attempt `partial`) é o mesmo que o card previa; só o caminho que leva até lá é outro.
- **Decisão de design:** entre as duas opções do card, optei por "expor o outcome real do attempt" em vez de "`status` ganha `'partial'`" — adicionar `'partial'` ao enum de `status` tocaria ~15 call sites que fazem `status === 'completed'`/`!== 'completed'` (incluindo `getPendingSteps`, que decide o que é redespachado) e mudaria semântica de retry, um risco maior do que o card descrevia (Médio). Em vez disso: `PlanStep.lastAttemptOutcome?: AttemptOutcome`, populado em `markStepDone()` com o `reflectionOutcome` já calculado (antes só alimentava `ReflectionMemory`, descartado depois). `status` continua só como eixo de progressão do plano — retry behavior inalterado (por design, ver S85). Campo opcional, sem migração de schema (`currentPlan` é JSON).
- **Checklist de execução:** padrão — sem dependências de ordem implícita novas encontradas nesta área.
- **Checklist de validação:** padrão + teste novo `S119_PlanStepLastAttemptOutcome_ARCH007.test.ts` (4 cenários: alta confiança, baixa confiança/o caso central, downgrade semântico escalando pra blocked, modos 'add'/'finalize' sem regressão).
- **Rollback:** reverter (campo opcional, aditivo — reversível sem side effects).
- **Critérios de Aceite:** nenhum `PlanStep` fica `completed` com `GoalAttempt` mais recente `partial`/`failure` sem ser uma decisão explícita — agora é explícito via `lastAttemptOutcome`, consultável sem duplicar a busca em `goal.attempts`.
- **Definition of Done:** regressão 100% (122/122) + teste novo (S119, 8 assertions).
- **Commit:** `216f039` — `fix(ARCH-007): expose real GoalAttempt outcome on PlanStep via lastAttemptOutcome`.
- **Status:** 🟢 Concluída em 2026-07-17.

### Sprint 2026-08-S14 ⏸ Adiada — ver decisão abaixo
- **Número:** S14
- **Identificação Temporal:** 2026-08-S14
- **Fase:** Execução Arquitetural
- **Epic:** Single Source of Truth
- **Card ARCH:** ARCH-009
- **Objetivo:** `CycleResult`/`GoalAttempt` passam a estender `ToolResult` em vez de redeclarar `output`/`error`.
- **Arquivos afetados:** nenhum tocado em código — só documentação (a Sprint foi adiada na Fase 1/2, antes de qualquer mudança).
- **Dependências:** CP01. Recomendado antes de S21 (ARCH-013) e S22 (ARCH-022) para reduzir churn — **essa recomendação continua de pé como sequenciamento preferencial, mas não é bloqueio: ver nota de impacto downstream abaixo.**
- **Premissa reverificada (Fase 1) — não se sustentou:** `CycleResult` não tem campo `error` próprio (o erro de uma falha vira `blocker.description`, nunca um campo separado) — já não são "os mesmos 2 campos redeclarados 3 vezes" como o card descrevia.
- **Crítica da hipótese (Fase 2) — a prescrição literal é inviável, não só a contagem:**
  1. `ToolResult.output` é obrigatório; `CycleResult.output`/`GoalAttempt.output` são opcionais e legitimamente ausentes em vários outcomes reais (`blocked`, `needs_auth`, `partial` sem dep). TypeScript não permite que uma interface herde um campo obrigatório como opcional — `extends ToolResult` não compila sem sintetizar um `output` sempre presente, mudando comportamento observável.
  2. `GoalAttempt` mora em `src/shared/domainTypes.ts` desde o ARCH-004 (S02) — camada neutra, 0 imports, movida para lá justamente para que `memory/` não dependesse de `loop/`. `ToolResult` mora em `src/loop/agentLoopTypes.ts`. `GoalAttempt extends ToolResult` obrigaria `shared/` a importar de `loop/` — a direção exatamente proibida pelo Epic A (Boundary Enforcement), reintroduzindo numa Sprint deste programa uma violação que outra Sprint deste MESMO programa já fechou.
  - Registro técnico completo: `docs/issues/008-arch009-extends-toolresult-breaks-typing-and-boundary.md`.
- **Pesquisa de alternativas (Fase 3):** uma interface-base mínima `{ output?: string; error?: string }` em `shared/domainTypes.ts` (camada neutra), com `ToolResult` (loop/) e `CycleResult` (loop/) estendendo-a na direção correta (`loop/ → shared/`, já estabelecida) e `GoalAttempt` (shared/) estendendo-a diretamente — satisfaz o próprio Critério de Aceite do card ("estendem/**referenciam** `ToolResult`") sem os 2 problemas acima. Não implementada nesta Sprint por decisão do usuário — ver abaixo.
- **Decisão do usuário (Fase 4/5 — síntese e validação):** em vez de decidir a forma final do tipo compartilhado isoladamente nesta Sprint, consolidar com outros achados de modelagem de tipo entre `loop/`/`shared/` (notadamente ARCH-024, mesma classe de problema em `ChannelContext`) numa revisão dedicada futura. Documento novo criado para essa consolidação: `docs/refatoracao-arquitetural-2026/REVISAO_CONSOLIDADA_TIPOS_PENDENTE.md`.
- **Checklist de execução:** interrompido conscientemente após a Fase 2 (Crítica) — nenhuma implementação, nenhum build, nenhum teste executado, porque não houve mudança de código.
- **Checklist de validação:** N/A — sem código tocado, os indicadores de build/tsc/regressão do Dashboard Executivo permanecem exatamente como estavam pós-S13.
- **Rollback:** N/A — nenhuma mudança de código feita.
- **Critérios de Aceite:** não avaliado — Sprint adiada antes da fase de implementação.
- **Definition of Done:** N/A nesta forma. Redefinido quando a revisão consolidada (`REVISAO_CONSOLIDADA_TIPOS_PENDENTE.md`) for aberta.
- **Impacto downstream (dependências citando S14/ARCH-009):** `S21` (ARCH-013), `S22` (ARCH-022) e `S24` (ARCH-020) citam "tipos consolidados primeiro" como sequenciamento recomendado. Nenhuma fica bloqueada — a dependência era sobre reduzir churn, não uma dependência funcional; todas podem prosseguir usando a forma atual (não consolidada) de `ToolResult`/`CycleResult`/`GoalAttempt` sem risco, per nota já adicionada em cada uma dessas 3 Sprints abaixo.
- **Commit esperado:** 1 commit (só documentação — achado + adiamento, sem código).
- **Status:** ⏸ Adiada em 2026-07-17, antes de codificar. Não é `🟢 Concluída` nem `⚪ Não iniciada` — categoria nova, ver `docs/refatoracao-arquitetural-2026/REVISAO_CONSOLIDADA_TIPOS_PENDENTE.md` para reabertura futura.

### Sprint 2026-08-S15 ✅ Concluída
- **Número:** S15
- **Identificação Temporal:** 2026-08-S15
- **Fase:** Execução Arquitetural
- **Epic:** Single Source of Truth
- **Card ARCH:** ARCH-010
- **Objetivo:** Substituir o scan O(n) de `GoalEvaluator.alreadyFailed` por um índice incremental de retry por (step, args-hash).
- **Arquivos afetados:** `src/loop/GoalEvaluator.ts` (import + método novo `hasIdenticalFailedAttempt`), teste novo `S120_GoalEvaluator_HasIdenticalFailedAttempt.test.ts`.
- **Dependências:** CP01.
- **Premissa reverificada (Fase 1) — parcialmente corrigida:** `alreadyFailed` não era um método, era uma `const` local computada inline via `.some()` (short-circuit — não necessariamente um scan completo em todo caso). Mais relevante: a pergunta que o código realmente responde é BOOLEANA ("esta chamada exata já falhou?"), não uma CONTAGEM ("quantas vezes?", como o Critério de Aceite original sugeria) — nenhum consumidor precisa do número, só do sim/não. Nenhuma duplicação desta lógica de dedup foi encontrada em outros arquivos (site único, confirmado por grep; `S79` documenta e depende exatamente deste comportamento).
- **Crítica da hipótese (Fase 2) — um índice real (persistido ou cacheado) foi descartado:** `Goal` é recarregado via `this.goalStore.getById()` a cada mudança de estado relevante dentro de `GoalExecutionLoop.runLoopInternal` (dezenas de call sites confirmados) — não existe um objeto `Goal` estável em memória entre ciclos ao qual um cache pudesse se anexar por referência de forma segura. Um índice persistido exigiria (a) campo novo no schema de `Goal`/`GoalStore` e (b) lógica de sincronização incremental toda vez que `GoalStore.addAttempt()` roda (em outro módulo) — introduzindo uma SEGUNDA fonte de verdade para um dado que já está inteiramente contido em `goal.attempts`, o oposto do que o próprio Epic B (Single Source of Truth) pede. Carrega ainda o mesmo risco de restart-safety já identificado, e ainda não resolvido, pelo ARCH-010's item-irmão `ARCH-008` (cache que não sobrevive a um restart do processo com goal em `executing`).
- **Pesquisa de alternativas (Fase 3):** (A) rejeitar o card — descartada, havia ganho real de clareza disponível a baixo custo; (B) extrair a lógica para um método nomeado, respondida "por consulta" (não por índice) — **escolhida**; (C) índice incremental real persistido/cacheado — rejeitada na Fase 2 (violação de SSOT + risco de restart-safety não resolvido).
- **Síntese (Fase 4):** `hasIdenticalFailedAttempt(goal, planStep, toolName): boolean`, método privado novo em `GoalEvaluator`, chamado por `evaluate()` no lugar do bloco inline. Chave de args via `computeToolInputKey()` (`loop/planning/computeToolInputKey.ts`, já existente, já testado — `S90`) em vez de `JSON.stringify` bruto — reuso de uma função canônica já estabelecida no código para "tool+args → chave de dedup", em vez de uma segunda lógica de hashing paralela (mesmo princípio de reuso que orientou S09: preferir a fonte real já existente a inventar uma nova). **Efeito colateral direto, não oportunista** (é a própria definição de "computar o args-hash corretamente", não um achado à parte): `send_document` agora dedupla corretamente por `file_path` mesmo quando a legenda varia cosmeticamente entre tentativas — a mesma classe de bug que `computeToolInputKey` já tinha corrigido na camada de `AgentLoop` (`usedToolInputs`, S90) hoje passa a ser tratada de forma consistente também na camada de `GoalEvaluator` (retry entre ciclos do goal).
- **Validação (Fase 5):** baseada em evidência real do código (sim — `alreadyFailed` inspecionado linha a linha, `Goal` reload confirmado por grep, `computeToolInputKey` confirmado existente e testado). Resolve problema estrutural (nomeação/clareza + fonte de chave consistente) sem introduzir uma nova fonte de verdade — ao contrário, evita criar uma. Reduz complexidade real (index cacheado teria aumentado). Mantém a filosofia do Cognitive Kernel. Implementável incrementalmente (método pequeno, 1 arquivo). Reversível trivialmente.
- **Checklist de execução:** padrão — nenhuma dependência de ordem implícita nova encontrada nesta área (a ordem "dedup roda antes de `classifyError`" já era assim e continua, só isolada num método).
- **Checklist de validação:** padrão. **Ambiente real (etapa 4) não exigido** — mudança puramente em memória (comparação de args), sem dependência de SO/filesystem/LLM, mesmo raciocínio já usado em S13 para dispensar a etapa 4. `tsc --noEmit` limpo, `npm run build` limpo, regressão 123/123 (122 + `S120` novo, 4 cenários/5 assertions).
- **Rollback:** reverter (método novo, sem mudança de schema/estrutura de `Goal` — reversão trivial, sem side effects).
- **Critérios de Aceite:** a pergunta "esta chamada exata já falhou?" (não "quantas vezes" — corrigido na Fase 1) é respondida por consulta nomeada, não por bloco inline recomputado — **atingido**.
- **Definition of Done:** regressão 100% — **atingido, 123/123**. Risco real ficou MENOR que o estimado pelo card ("muda a estrutura de `Goal` ou exige campo novo persistido" — nenhuma das duas coisas aconteceu, por decisão deliberada de design).
- **Commit esperado:** 2 commits (implementação; depois docs — registro de hash+métricas).
- **Status:** 🟢 Concluída em 2026-07-17.
- **Status:** ⚪ Não iniciada.

---

## Checkpoint 2026-08-CP02

- **Identificação:** `2026-08-CP02`
- **Revisado em 2026-07-17:**
  - **Indicadores:** Single Sources — `getPendingSteps` (S03), `PlanStep.lastAttemptOutcome` (S13), `toolsTried` como fonte primária de fingerprint (S10), dedup de retry nomeado via `computeToolInputKey` (S15) reduzem a fragmentação medida em T0. Recomputation Hotspots — S10/S11/S15 substituíram recomputação inline por consulta nomeada/fonte estruturada nos 3 pontos que tocaram. Boundary (re-grep nesta revisão): 0 ocorrências de `from '../loop/AgentLoop'` para `ToolExecutor`/`ToolResult` em `tools/`; 0 imports de `loop/` em `memory/` — nenhuma violação nova reintroduzida por S08-S15, Epic A continua concluído.
  - **Backlog:** 1 mudança de escopo real desde CP01 — ARCH-009 (S14) **adiado**, não implementado como o card descrevia (`docs/issues/008`, `REVISAO_CONSOLIDADA_TIPOS_PENDENTE.md`, 5º modo de falha catalogado em `RETROSPECTIVA_PREMISSAS_AUDITORIA.md`). Diferente das correções de contagem de CP01, este é o primeiro caso do programa em que uma Sprint inteira não foi implementada — tratado explicitmente abaixo no Critério de Avanço, não escondido.
  - **Dependências:** S16 (ARCH-005) depende só deste checkpoint — confirmado liberado. S17 depende de S16. Notas de dependência de S21/S22/S24 (que citavam S14) já atualizadas na própria Sprint S14 para refletir que não bloqueiam.
  - **Arquitetura:** nenhuma violação nova — reconfirmado por grep nesta revisão (ver Indicadores acima), consistente com o Dashboard Executivo (pós-S15).
  - **Riscos:** nenhum crítico materializado em S08-S15. S08 teve os 3 falsos-positivos/bug de teste da VPS (já investigados e fechados, `docs/issues/002`). S14 não é um risco realizado — é uma Sprint adiada de forma controlada, com documentação completa e sem código tocado (risco de regressão = 0). Risco real do programa continua concentrado à frente: S16 (ARCH-005) é explicitamente marcada `⚠ Maior risco até este ponto do programa`.
  - **Planejamento:** ritmo do lote S08-S15 seguiu o mesmo padrão de CP01 (sessão única, muito mais rápido que a estimativa de calendário) — mesma ressalva de CP01 continua valendo: não há sinal ainda para recalibrar a estimativa de S16 (Refactor Estrutural, Validação Progressiva completa até etapa 4) a partir da velocidade deste lote de Quick Win/Refactor Local. Antes de abrir S16: revisar tempo/recursos disponíveis dado que é o primeiro item do programa a exigir etapa 4 (ambiente real) desde S08, e o de maior impacto (`Goal.sentArtifacts` como fonte única de artefatos entregues, histórico de 2 bugs reais de produção na mesma área).
- **Critério de avanço — reinterpretado à luz do adiamento de S14:** o texto original ("S08-S15 todas 🟢") foi escrito antes de o programa ter uma categoria "adiada com justificativa" — que não existia em CP01. Tratando `⏸ Adiada` (não código tocado, achado documentado, decisão explícita do usuário, sem risco de regressão) como satisfazendo o espírito do critério, no mesmo princípio já usado para "RFC rejeitada" (ARCH-012/S27: "resultado válido e esperado, não uma falha do programa") — **atingido**: S08/S09/S10/S11/S12/S13/S15 🟢 (7/8), S14 ⏸ com justificativa completa registrada; suíte de regressão 123/123; nenhum indicador arquitetural piorou (reconfirmado por grep nesta revisão, não só copiado do Dashboard).
- **Status:** 🟢 Concluído em 2026-07-17.

---

### Sprint 2026-08-S16 ⚠ Maior risco até este ponto do programa ✅ Concluída — escopo redesenhado na Fase 1/2
- **Número:** S16
- **Identificação Temporal:** 2026-08-S16
- **Fase:** Execução Arquitetural
- **Epic:** Single Source of Truth
- **Card ARCH:** ARCH-005
- **Objetivo:** Consolidar `Goal.sentArtifacts` como única fonte de verdade de "artefatos entregues", eliminando os outros 3 mecanismos concorrentes (`cycleHistory` do AgentLoop, `deliverable_check`, `structuralBypass`).
- **Arquivos afetados (real):** `src/loop/GoalExecutionLoop.ts` (bloco "Item 2: Deliverable Check", ~L886-923 — não os 3 blocos originalmente listados no card), teste novo `S121`, teste `S10` corrigido (asserção presa a source).
- **Dependências:** CP02.
- **Premissa reverificada (Fase 1) — não se sustentou; ver "Executado como" no card `ARCHITECTURAL_BACKLOG.md`:** as "4 estruturas" já convergem majoritariamente para `sentArtifacts` (via `onArtifactDelivered`, `.has()`, fallback em `checkClaimsAgainstEvidence`); `structuralBypass` responde uma pergunta diferente por natureza (existência em disco para bypass de validação, não "foi entregue"); o escopo do card não incluía `planning/artifactContract.ts`, que também lê `sentArtifacts`; os 2 bugs históricos citados como motivação já foram corrigidos em Sprints anteriores a este programa (`project_session_bugs_jul2026_ap`/`_ak` na memória).
- **Crítica da hipótese (Fase 2):** consolidar 4 mecanismos já majoritariamente sincronizados, para prevenir uma 3ª ocorrência hipotética de uma classe de bug já corrigida 2x, tinha valor questionável frente ao risco real de um Refactor Estrutural Alto-risco com Validação Progressiva completa obrigatória.
- **Achado novo (não documentado antes de S16):** `sentArtifacts` guarda o path CRU (`toolArgs.file_path`, relativo ou absoluto conforme o LLM passou); `checkDeliverables()` retorna paths sempre ABSOLUTOS. `deliverable_check` comparava os dois direto via `.has()` — um arquivo já entregue por path relativo podia ser tratado como "não entregue" e reinjetado como `send_document` duplicado.
- **Pesquisa de alternativas (Fase 3), apresentadas ao usuário:** (A) fix cirúrgico só do mismatch de path — **escolhida**; (B) consolidação completa como o card pede literalmente; (C) adiar como ARCH-009. Usuário escolheu (A).
- **Síntese (Fase 4):** normaliza `sentArtifacts`/`pendingSendPaths` via `resolvePath()` (já usada por write/read/exec_command) antes de comparar contra os paths absolutos de `checkDeliverables()` — `sentArtifactsResolved`, novo, escopo único (1 bloco de código). Sentinela `__send_audio_delivered__` explicitamente excluído da normalização (não é um path real).
- **Checklist de execução:** padrão + mapeamento completo de consumidores/produtores de `sentArtifacts`/`producedArtifactPaths` antes de tocar (achou o consumidor não listado em `artifactContract.ts`) — nenhuma dependência de ordem implícita nova encontrada.
- **Checklist de validação:** padrão + **etapa 4 (ambiente real) executada**, per decisão do usuário dado que o fix toca resolução de path (categoria com histórico de bugs só visíveis fora de testes mockados, `feedback_verificar_fixes_de_verdade`):
  - Unitário + regressão: `tsc --noEmit` limpo, `npm run build` limpo, regressão 124/124 (123 + `S121` novo, 2 cenários/3 assertions; `S10` corrigido — asserção presa ao texto exato do source, mesma classe de achado de S52/S110/S34/S22/S11).
  - **Ambiente real:** instância isolada local (Windows, LLM real `glm-5.2:cloud` via Ollama, filesystem real) — goal real ("crie nota_s16.txt e envie") confirmou a PRECONDIÇÃO do bug com dado real: o LLM enviou o arquivo via path relativo (`sent_artifacts: ["nota_s16.txt"]`, lido direto do SQLite da instância). Script de verificação rodou o código-fonte real (`resolvePath`, réplica de `checkDeliverables()`) contra esse dado real: SEM o fix, o arquivo seria reinjetado como não-entregue; COM o fix, reconhecido corretamente. Achado à parte (falso-positivo do próprio setup, não do código): `.env` escrito via heredoc guardou `WORKSPACE_DIR` em formato Git-Bash não traduzido pelo Node no Windows, causando um diretório espelhado `C:\c\Users\...` — mesma classe de achado do S08, sem impacto na avaliação do fix. Validação na VPS Linux oferecida e **dispensada pelo usuário** — código tocado usa só `path.resolve`/`path.join` (sem branch por SO), e `S121` já roda na suíte de regressão que valida o branch na VPS de qualquer forma.
- **Rollback:** reverter o commit — `sentArtifacts`/`pendingSendPaths` voltam à comparação bruta (estado pré-S16, sem piora).
- **Critérios de Aceite:** redefinidos por decisão do usuário — não mais "função única `getEffectiveDeliveredArtifacts`", e sim "nenhuma comparação de path entre `sentArtifacts` e paths absolutos de `checkDeliverables()` sem normalização prévia" — **atingido**.
- **Definition of Done:** unitário + regressão + ambiente real (Windows, LLM real, dado real) — **atingido**. VPS Linux dispensada por decisão explícita do usuário (código cross-platform-safe, sem lógica condicional por SO).
- **Commit esperado:** 2 commits (implementação + teste; depois docs — registro de hash+métricas).
- **Status:** 🟢 Concluída em 2026-07-18.

### Sprint 2026-08-S17 ⏸ Adiada — ver decisão abaixo
- **Número:** S17
- **Identificação Temporal:** 2026-08-S17
- **Fase:** Execução Arquitetural
- **Epic:** Single Source of Truth
- **Card ARCH:** ARCH-008
- **Objetivo:** `progressModel` passa a ser derivado sob demanda de `goal.attempts`/`successCriteria`, com o mesmo tratamento que `cognitiveContext` já recebeu via `buildIncrementalExecutionContext`.
- **Arquivos afetados:** nenhum tocado em código — só documentação (a Sprint foi adiada na Fase 1, antes de qualquer mudança).
- **Dependências:** S16 (mesmo padrão de "derivar da fonte persistida") — cumprida, não é o motivo do adiamento.
- **Premissa reverificada (Fase 1) — não se sustentou, categoria nova (6º modo de falha):** o card justificava a mudança citando "o sistema já tem recovery de goals ativos no boot" — **esse mecanismo não existe**. `AgentController.getAllActive()` roda no boot e no shutdown só para LOGAR (`recovered=false` explícito no próprio log de produção) — nunca chama `resumeGoal()`/`runLoop()`. Um goal deixado `executing` quando o processo morre fica permanentemente órfão, sem qualquer recovery, com ou sem este ARCH.
- **O defeito subjacente é real, só o gatilho é outro:** o único call site de `resumeGoal()` é `GoalOrchestrator.resumeFromAuth()` (aprovação de ação perigosa) — mesmo processo, sem restart algum. `progressModel` reseta ali igualmente, e esse caminho é MAIS frequente/fácil de reproduzir do que o cenário de restart que o card descrevia.
- **Fix desenhado (não implementado):** `buildInitialProgressModel(goal)` — reconstrói `components` a partir de `goal.currentPlan` (steps `completed`) + `goal.attempts` (steps `pending` com attempt já registrado), no mesmo espírito de `buildIncrementalExecutionContext()`. Usado só na criação do `state` em `runLoop()`. Para `executeGoal()` (goal novo), retorna `[]` — zero mudança nesse caminho. Registro técnico completo: `docs/issues/009-arch008-no-automatic-boot-recovery-exists.md`.
- **Decisão do usuário:** adiar e documentar, mesma linha de S14 — a premissa errada era estrutural o suficiente (o mecanismo citado como motivação simplesmente não existe) para justificar não implementar sem revisão adicional, mesmo com o fix já desenhado.
- **Checklist de execução:** interrompido conscientemente após a Fase 1/2 — nenhuma implementação, nenhum build, nenhum teste executado.
- **Checklist de validação:** N/A — sem código tocado, indicadores do Dashboard Executivo permanecem exatamente como estavam pós-S16.
- **Rollback:** N/A — nenhuma mudança de código feita.
- **Critérios de Aceite:** não avaliado — Sprint adiada antes da fase de implementação. **Nota para quando for retomado:** a prescrição original de etapa 4 ("matar o processo, validar recovery") não é testável, porque não existe recovery-por-restart — a validação real precisa ser via fluxo de autorização (`resumeFromAuth`), não restart de processo.
- **Definition of Done:** N/A nesta forma.
- **Commit esperado:** 1 commit (só documentação — achado + adiamento, sem código).
- **Status:** ⏸ Adiada em 2026-07-18, antes de codificar.

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
- **Arquivos afetados:** `src/loop/GoalPlanner.ts` (função nova `buildLoopDirective`, 4 blocos reescritos), teste novo `S118`. `StrategyDiversityGuard.ts` **não precisou de mudança** — `extractExhaustedTools()` já existia e já fazia o que era necessário.
- **Dependências:** S10 (ARCH-011 — fonte de dados corrigida antes de trocar os consumidores).
- **Checklist de execução:** padrão — executado. A premissa do card ("os 4 blocos são variações do mesmo padrão") não se sustentou: cada um detecta um TIPO de sinal diferente (categoria de blocker+texto; tool específica falhando; categoria de ação, não falha; ocorrência única vs. repetição) — análise completa em `docs/issues/006-loop-directives-different-signal-kinds.md`. Forçar os 4 pra `extractExhaustedTools()` teria quebrado 3 deles (nunca disparariam ou mudariam de threshold silenciosamente).
- **Checklist de validação:** padrão + teste unitário para cada um dos 4 cenários de loop — `tsc --noEmit` limpo, `npm run build` limpo, regressão 121/121 (120 + `S118` novo, 5 cenários incluindo um extra provando o gatilho aditivo da fonte estruturada). Verificação byte-a-byte adicional: os 3 blocos com lógica inalterada (pip/venv, stuck-in-analysis, content_stub) produzem texto IDÊNTICO ao original (exceto 1 normalização cosmética de indentação documentada no commit); só o texto do bloco `exec_command` pode variar quando disparado pela fonte estruturada nova.
- **Rollback:** reverter.
- **Critérios de Aceite:** os 4 blocos usam `StrategyDiversityGuard` como única fonte; texto gerado por função compartilhada. **Atingido parcialmente por desenho, não por limitação:** texto compartilhado — sim, 4/4; fonte de dados de `StrategyDiversityGuard` — sim para 1/4 (o único caso onde faz sentido), aditivamente, sem perder cobertura.
- **Definition of Done:** regressão 100% + os 4 testes unitários — **atingido** (`S118`, 5 cenários).
- **Commit esperado:** 1 commit.
- **Status:** 🟢 Concluída em 2026-07-17.

### Sprint 2026-08-S18 ⏸ Adiada — ver decisão abaixo
- **Número:** S18
- **Identificação Temporal:** 2026-08-S18
- **Fase:** Execução Arquitetural
- **Epic:** Decision Ownership
- **Card ARCH:** ARCH-018
- **Objetivo:** `evaluateCriteria` absorve `structuralBypass` como um `CriterionCheck` (`file_exists`), eliminando o `if` ad-hoc dentro de `runLoopInternal`.
- **Arquivos afetados:** nenhum tocado em código — só documentação (Sprint adiada na Fase 1, antes de qualquer mudança).
- **Dependências:** S16 (ARCH-005) — cumprida, não é o motivo do adiamento.
- **Checklist de execução:** padrão + reler o histórico do bug de deadlock (`project_session_bugs_jul2026_ap`, Bug 2) antes de tocar — **cumprido, e é exatamente essa releitura que revelou o problema de premissa abaixo.**
- **Premissa reverificada (Fase 1) — não se sustentou, 2ª instância do modo 3 (equivalência semântica assumida sem verificação, mesmo modo de S10/S11):** o card presumia que `CriterionCheck: 'file_exists'` já resolvia o caso de uso de `structuralBypass` — não resolve. `file_exists` (implementação real) checa se existe um `GoalAttempt` bem-sucedido com `output` não-vazio; `structuralBypass` faz `fs.statSync()` DIRETO no disco, sem depender de attempt nenhum — exatamente porque o Bug 2 original era sobre arquivo que já existia ANTES do goal, sem nenhum attempt como evidência. Reaproveitar `file_exists` literalmente reintroduziria o deadlock.
- **Achado estrutural adicional:** `structuralBypass` deriva alvos dinamicamente do plano atual (`pendingSendSteps`, muda a cada replan); `successCriteria` é lista estática decidida na criação do plano. Sincronizar as duas de verdade seria um risco novo de divergência, não uma simplificação — contrário ao próprio Epic (Single Source of Truth) que este card pertence.
- **Alternativa levantada (não implementada):** `CriterionCheck` novo e dedicado, preservando a lógica exata de `structuralBypass` (disco direto, sem attempts) — resolveria o Critério de Aceite literal ("nenhum if solto fora de evaluateCriteria") sem os riscos acima. Registro técnico completo: `docs/issues/010-arch018-file-exists-checks-attempts-not-disk.md`.
- **Decisão do usuário:** adiar e documentar — mesma linha de S14/S17: premissa quebrada de forma estrutural numa área com histórico de bug real de produção não é corrigida pontualmente na mesma sessão.
- **Checklist de execução:** interrompido conscientemente após a Fase 1/2 — nenhuma implementação, build, ou teste executado.
- **Checklist de validação:** N/A — sem código tocado, indicadores do Dashboard Executivo permanecem exatamente como estavam pós-S16.
- **Rollback:** N/A — nenhuma mudança de código feita.
- **Critérios de Aceite:** não avaliado — Sprint adiada antes da fase de implementação.
- **Definition of Done:** N/A nesta forma.
- **Nota de dependência real (não apenas sequenciamento):** diferente de S14/S17, o adiamento de S18 bloqueia funcionalmente ARCH-012 (S27) — ver nota adicionada no card `ARCH-012` em `ARCHITECTURAL_BACKLOG.md`. Como ARCH-012 já é o último item do programa, há tempo de retomar ARCH-018 antes — mas não tratar como "livre" sem revisão.
- **Commit esperado:** 1 commit (só documentação — achado + adiamento, sem código).
- **Status:** ⏸ Adiada em 2026-07-18, antes de codificar.

### Sprint 2026-09-S20 ✅ Concluída
- **Número:** S20
- **Identificação Temporal:** 2026-09-S20
- **Fase:** Execução Arquitetural
- **Epic:** Decision Ownership
- **Card ARCH:** ARCH-015-RFC
- **Objetivo:** Produzir a análise de Fase 1-5 (`DIRETRIZ_ARQUITETURA_2026-07-13.md`) para gerar validação de args obrigatórios + texto de prompt a partir do schema de cada tool. **Sem código.**
- **Arquivos afetados:** nenhum de produção — `docs/refatoracao-arquitetural-2026/RFC_ARCH-015_SchemaGeneratedRequiredArgs.md` (novo).
- **Dependências:** S06 (ARCH-025) — cumprida.
- **Premissa reverificada (Fase 1) — parcialmente corrigida:** os "5 lugares" citados pelo card nem cobrem o mesmo conjunto de tools (`memory_write` nunca aparece em `detectMissingRequiredArgs()`, confirmado por grep completo). Mais importante: a lógica de "obrigatório" não é um `required: string[]` plano pra pelo menos 3 tools (`web_navigate`/`crypto_analysis`: condicional a outro campo; `edit`: "uma de 3 combinações válidas") — gerar a VALIDAÇÃO a partir do schema atual perderia essa lógica silenciosamente. Só a metade de TEXTO DE PROMPT tem incidente real confirmado (S06/ARCH-025, drift real entre os 2 blocos).
- **Fase 2/3 (crítica + alternativas):** 4 opções avaliadas — codegen completo (validação+prompt) via schema condicional estendido; híbrido (só tools com `required` plano geradas); rejeitar; só o texto de prompt migra, co-localizado no arquivo de cada tool (`requiredArgsHint` novo em `ToolExecutor`).
- **Decisão (Fase 4/5):** aprovado com **escopo reduzido** — só a 4ª opção (texto de prompt). A metade de validação não foi aprovada nesta forma; fica candidata a uma RFC futura e distinta, condicionada a desenhar um dialeto de schema condicional primeiro. Documento completo: `RFC_ARCH-015_SchemaGeneratedRequiredArgs.md`.
- **Checklist de execução:** padrão, adaptado para análise.
- **Checklist de validação:** N/A (fase de análise).
- **Rollback:** N/A — nenhum código tocado.
- **Critérios de Aceite:** documento de Fase 1-5 completo, com decisão explícita — **atingido**.
- **Definition of Done:** RFC revisada e aprovada — **atingido**, com escopo reduzido em relação ao card original (só texto de prompt, não validação).
- **Commit esperado:** 1 commit contendo o documento de RFC.
- **Status:** 🟢 Concluída em 2026-07-18.

### Sprint 2026-09-S21 ⏸ Adiada — ver decisão abaixo
- **Número:** S21
- **Identificação Temporal:** 2026-09-S21
- **Fase:** Execução Arquitetural
- **Epic:** Decision Ownership
- **Card ARCH:** ARCH-013
- **Objetivo:** Unificar o juiz de sucesso de step — fundir `evaluateAgentStepSuccess`/`escalateStepEvalToLLM` dentro de `StepSemanticValidator`.
- **Arquivos afetados:** nenhum tocado em código — só documentação (Sprint adiada na Fase 1/2, antes de qualquer mudança).
- **Dependências:** CP02 (via S14/ARCH-009 — tipos consolidados primeiro) — não-bloqueante, já resolvido (ver nota anterior); não foi o motivo do adiamento.
- **Premissa reverificada (Fase 1) — CONFIRMADA, diferente de todos os casos anteriores:** os dois mecanismos de fato rodam em sequência desnecessária pro mesmo step em casos reais (a mesma condição de ambiguidade tende a disparar escalação nos 2 estágios). A prescrição é tecnicamente viável.
- **Crítica da hipótese (Fase 2) — achado novo, categoria diferente de S14/S17/S18:** implementar a fusão literalmente ("mantendo só a extração determinística fora dele") perde um sinal não mencionado pelo card. Hoje, `escalateStepEvalToLLM` confirmando sucesso marca `stepSuccessConfident=true`, que decide se `GoalAttempt.result` vira `'success'` ou `'partial'`. `StepSemanticValidator` só tem sinal NEGATIVO (`shouldDowngradeToPartial`) — sem um sinal de PROMOÇÃO equivalente, todo step da zona ambígua passaria a virar `'partial'` sempre, mudando o comportamento observável de conclusão de goal de forma silenciosa (compila, roda, não reintroduz nenhuma violação — só muda um resultado que o card não anunciava mudar).
- **Alternativa desenhada (não implementada):** dar ao `StepSemanticValidator` os dois sentidos do sinal — um veredito `'relevant'` de alta confiança também promove `stepSuccessConfident=true`, não só `'mismatch'` rebaixando como já faz hoje. Preserva o comportamento observável atual, ainda reduz de 2 chamadas de LLM pra 1 no caso duplo. Registro técnico completo: `docs/issues/011-arch013-merge-loses-confident-success-signal.md`.
- **Decisão do usuário:** adiar e documentar — mesma linha de S14/S17/S18, apesar de esta ser uma categoria de achado diferente (7º modo de falha: premissa correta, prescrição viável, consequência não rastreada até o fim).
- **Checklist de execução:** interrompido conscientemente após a Fase 1/2 — nenhuma implementação, build, ou teste executado.
- **Checklist de validação:** N/A — sem código tocado, indicadores do Dashboard Executivo permanecem exatamente como estavam pós-S16.
- **Rollback:** N/A — nenhuma mudança de código feita.
- **Critérios de Aceite:** não avaliado — Sprint adiada antes da fase de implementação.
- **Definition of Done:** N/A nesta forma.
- **Commit esperado:** 1 commit (só documentação — achado + adiamento, sem código).
- **Status:** ⏸ Adiada em 2026-07-18, antes de codificar. **Não bloqueia mais S22 (ARCH-022) de forma funcional — ver nota adicionada no card de S22.**

### Sprint 2026-11-S26
- **Número:** S26
- **Identificação Temporal:** 2026-11-S26
- **Fase:** Execução Arquitetural
- **Epic:** Decision Ownership
- **Card ARCH:** ARCH-015-Impl
- **Objetivo:** ~~Implementar a geração de validação/prompt de args obrigatórios a partir do schema~~ — **escopo reduzido pela RFC (S20):** implementar só a geração do TEXTO DE PROMPT (`requiredArgsHint` co-localizado por tool, agregado via `ToolRegistry`). A metade de VALIDAÇÃO (`detectMissingRequiredArgs`) não foi aprovada — ver `RFC_ARCH-015_SchemaGeneratedRequiredArgs.md`.
- **Arquivos afetados:** `src/loop/agentLoopTypes.ts` (`ToolExecutor.requiredArgsHint` novo), `src/loop/GoalPlanner.ts` (`buildRequiredArgsReference()` reescrita), `src/tools/*.ts` (campo novo por tool que hoje tem entrada em `buildRequiredArgsReference()`/`buildToolContracts()`).
- **Dependências:** S20 (aprovação da RFC) — cumprida, com escopo reduzido.
- **Checklist de execução:** padrão.
- **Checklist de validação:** padrão. Etapa 4 (ambiente real) provavelmente dispensável dado o escopo reduzido (geração de string, sem lógica de validação/SO/filesystem/LLM tocada) — reavaliar no início da própria S26, não presumir aqui.
- **Rollback:** reverter.
- **Critérios de Aceite:** definidos na RFC (S20) — escopo reduzido a texto de prompt.
- **Definition of Done:** Validação Progressiva completa (etapas aplicáveis ao escopo reduzido).
- **Commit esperado:** 1 commit.
- **Status:** ⚪ Não iniciada. **Condicional — só ocorre se S20 aprovar a implementação.**

---

## Checkpoint 2026-09-CP03

- **Identificação:** `2026-09-CP03`
- **Revisado em 2026-07-18:**
  - **Indicadores:** Single Sources — S16 (ARCH-005) normalizou a comparação de path em `deliverable_check`; S19/S20 (RFCs) não tocaram código, mas já corrigiram o DESENHO de duas futuras consolidações (`DeliveryTrackingContext`, `requiredArgsHint`) antes de qualquer implementação errada. Boundary (re-grep nesta revisão): 0 ocorrências de `from '../loop/AgentLoop'` para `ToolExecutor`/`ToolResult` em `tools/`; 0 imports de `loop/` em `memory/` — nenhuma violação nova, consistente com CP01/CP02.
  - **Backlog:** nenhuma dívida nova encontrada durante S16-S20 escapou do processo — todo achado de premissa (S16, S17, S18, S19, S20) virou `docs/issues/NNN` e/ou nota "Executado como"/"RFC" no card correspondente, nenhum corrigido "de brinde" fora do escopo do card da própria Sprint.
  - **Dependências:** S21 (ARCH-013) confirmado liberado (dependia de CP02 + S14, ambas resolvidas/não-bloqueantes). S22 (ARCH-022) depende de S16 (✅), S14 (adiada, não-bloqueante), S21 (ainda não rodou) — segue corretamente bloqueada por S21, não por nada desta leva.
  - **Arquitetura:** nenhuma violação nova — reconfirmado por grep completo nesta revisão (ver Indicadores acima).
  - **Riscos:** o risco real observado em S16 (redesenhado para um fix cirúrgico após a Fase 1/2) ficou BEM menor que o estimado pelo card original — mas a causa foi a premissa do card estar errada (as "4 estruturas" já convergiam), não que mudanças nesta área do sistema sejam inerentemente mais fáceis do que o esperado. **Não extrapolar esse resultado para calibrar S24/S25 pra baixo** — a Fase 1/2 de S24/S25 (decomposição de `runLoopInternal`/`runWithTools`) não tem o mesmo tipo de "escape hatch" (não há premissa a corrigir que reduza o escopo; a complexidade dos dois métodos é real e confirmada, não uma alegação de auditoria a verificar). Mantida a estimativa original de Alto risco/esforço para S24/S25.
  - **Planejamento:** confirmado — este é o ponto de virada do programa. Consolidação de estado (Epic B, praticamente encerrado nesta ordem — só ARCH-008 adiado e ARCH-012 deliberadamente por último restam) dá lugar à decomposição estrutural (Epic D, S22 em diante) e ao fechamento do Epic C (S21, depois ARCH-018 quando for retomado).
- **Critério de avanço — reinterpretado, mesmo princípio já usado em CP02:** o texto original ("S16-S20 todas 🟢" + "`getEffectiveDeliveredArtifacts` validado em ambiente real") foi escrito antes de (a) a categoria "adiada com justificativa" existir no programa, e (b) a Fase 1/2 de S16 ter corrigido a premissa e descartado `getEffectiveDeliveredArtifacts` como solução (não construída de propósito — ver card ARCH-005, "Executado como"). Aplicando a mesma reinterpretação de CP02: `⏸ Adiada` conta como não-bloqueante quando documentada (S17, S18); "validado em ambiente real" é satisfeito pelo que S16 REALMENTE validou (o fix de normalização de path, com LLM real e goal real), não pela função específica que o card presumia — **atingido**: S16/S19/S20 🟢 (3/5), S17/S18 ⏸ com justificativa completa registrada; regressão 124/124 (inalterada desde S16, nenhuma Sprint desta leva tocou código depois); nenhum indicador arquitetural piorou.
- **Status:** 🟢 Concluído em 2026-07-18.

---

## Épico D — Structural Simplification

### Sprint 2026-08-S12
- **Número:** S12
- **Identificação Temporal:** 2026-08-S12
- **Fase:** Execução Arquitetural
- **Epic:** Structural Simplification
- **Card ARCH:** ARCH-023
- **Objetivo:** Explicitar o pipeline de fixups do `exec_command.ts` como lista nomeada de transformações, em vez de `if`s sequenciais com ordem implícita.
- **Arquivos afetados:** `src/tools/exec_command.ts` (`COMMAND_FIXUP_PIPELINE` novo + `applyFixup()`), teste `S11` corrigido (asserção estrutural presa a localização de código).
- **Dependências:** CP01 (nenhuma dependência real — item isolado, poderia rodar a qualquer momento).
- **Checklist de execução:** padrão + reverificação de premissa (per `docs/RETROSPECTIVA_PREMISSAS_AUDITORIA`) — a contagem "~12 funções" do card estava plausível (11 funções puras relacionadas a comando/fixup realmente existem no arquivo), mas nem todas fazem parte de uma "cadeia de transformação sequencial": só 4 mutam `command` diretamente numa ordem que importa (`remap_foreign_workspace_paths`, `add_marp_no_stdin`, `remove_pandoc_no_stdin`, `wrap_powershell`) — essas viraram o pipeline. 2 são gates de validação que ABORTAM em vez de transformar (`isMarpWithoutInputFile`, `isPandocWithoutInputFile`) — ficaram como `if`s diretos, intercalados exatamente onde estavam, porque um comentário no código original (`isMarpWithoutNoStdin`, linha ~230) já avisava que a ordem entre gate e fixup importa. As demais (`translateChainOperatorsForPowerShell`, `translateDevNullForPowerShell`, etc.) são helpers específicos de PowerShell chamados de dentro de `wrapForWindowsPowerShell`, não uma cadeia própria.
- **Checklist de validação:** padrão (suíte já existente: S11, S12, S13, S15 do repositório cobrem bem esta área) — `tsc --noEmit` limpo, `npm run build` limpo, regressão 121/121, os 4 arquivos de teste citados no card rodados individualmente e confirmados verdes.
- **Rollback:** trivial.
- **Critérios de Aceite:** ordem de aplicação dos fixups é uma estrutura de dados explícita — **atingido**, `COMMAND_FIXUP_PIPELINE` (array nomeado, 4 steps) consumido via `applyFixup(nome, command, ctx)` nos 4 pontos de chamada exatos que antes eram `if`s inline.
- **Definition of Done:** regressão 100% (suíte existente) — **atingido**.
- **Decisão de design (risco zero, não um loop único):** cogitei rodar os 4 steps num `for` só, mas descartei — `isSearchCommand` (calculado ENTRE os fixups de marp/pandoc e o `wrap_powershell`) precisa ler o comando ANTES de ser embrulhado em PowerShell, senão `grep`/`rg`/`find` nunca mais seriam reconhecidos depois do wrap, quebrando o tratamento de "exit code 1 = sem resultados" no Windows. `applyFixup()` é chamado individualmente, no ponto exato onde o `if` antigo estava — o array é a fonte única de definição (nome/condição/transformação), não necessariamente de execução em lote.
- **Commit esperado:** 1 commit.
- **Status:** 🟢 Concluída em 2026-07-17.

### Sprint 2026-09-S19 ✅ Concluída
- **Número:** S19
- **Identificação Temporal:** 2026-09-S19
- **Fase:** Execução Arquitetural
- **Epic:** Structural Simplification
- **Card ARCH:** ARCH-024-RFC
- **Objetivo:** Produzir a análise de Fase 1-5 para consolidar os 5 callbacks de `ChannelContext` em um `DeliveryTrackingContext` dedicado. **Sem código.**
- **Arquivos afetados:** nenhum de produção — `docs/refatoracao-arquitetural-2026/RFC_ARCH-024_DeliveryTrackingContext.md` (novo).
- **Dependências:** CP02.
- **Premissa reverificada (Fase 1) — corrigida:** a alegação do card ("nenhum [dos 5 campos] é sobre o canal, todos são sobre rastreamento de entrega") vale para 4 dos 5, não para os 5 — `recentMessages` é construído em `MessageBus.ts` (mesmo lugar/razão que `channel`/`chatId`/`userId`) e consumido só por `UnifiedIntentRouter` para classificação de intenção, sem nenhuma relação com entrega de artefato. Confirmado por grep completo de produtores/consumidores dos 5 campos, não por amostra.
- **Fase 2/3 (crítica + alternativas):** avaliadas 4 opções — rejeitar; `DeliveryTrackingContext` como parâmetro novo separado de `channelContext` (leitura mais literal do card, risco alto — muda assinatura de `AgentLoop.process()`); `DeliveryTrackingContext` como campo único aninhado dentro do próprio `ChannelContext` (`channelContext.deliveryTracking`, risco baixo — assinatura de método inalterada); mover as closures pra fora de `agentLoopTypes.ts` sem tipo nomeado (pior ergonomia, mesmo risco da 2ª opção).
- **Decisão (Fase 4/5):** aprovado — campo único aninhado (padrão Parameter Object), 4 campos consolidados (`recentMessages` excluído, permanece campo direto de `ChannelContext`). Documento completo com desenho de implementação: `RFC_ARCH-024_DeliveryTrackingContext.md`.
- **Checklist de execução:** padrão, adaptado para análise (sem "implementar"/"build"/"testes").
- **Checklist de validação:** N/A (fase de análise, per o próprio card).
- **Rollback:** N/A — nenhum código tocado.
- **Critérios de Aceite:** documento de Fase 1-5 completo — **atingido**.
- **Definition of Done:** RFC revisada e aprovada — **atingido**, com escopo corrigido (4 campos, não 5) e forma de implementação definida (campo aninhado, não parâmetro separado).
- **Commit esperado:** 1 commit contendo o documento de RFC.
- **Status:** 🟢 Concluída em 2026-07-18.

### Sprint 2026-09-S22
- **Número:** S22
- **Identificação Temporal:** 2026-09-S22
- **Fase:** Execução Arquitetural
- **Epic:** Structural Simplification
- **Card ARCH:** ARCH-022
- **Objetivo:** Decompor `GoalExecutionLoop.executeStep()` (~375 linhas) e eliminar os 4 blocos duplicados de "registrar falha" via helper `recordFailedAttempt()`.
- **Arquivos afetados:** `src/loop/GoalExecutionLoop.ts` (L1605-1978).
- **Dependências:** S16 (ARCH-005), S14 (ARCH-009), S21 (ARCH-013). **Atualização (S14 adiada, 2026-07-17): não bloqueia mais — ver `REVISAO_CONSOLIDADA_TIPOS_PENDENTE.md`. Atualização (S21 adiada, 2026-07-18): idem — dependência era sequenciamento (reduzir lógica a decompor), não funcional; S22 pode prosseguir com os 2 juízes de sucesso ainda separados, ver `docs/issues/011`.**
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
- **Dependências:** S16 (ARCH-005), S03 (ARCH-006), S13 (ARCH-007), S17 (ARCH-008), S14 (ARCH-009). **Atualização (S14 adiada, 2026-07-17): não bloqueia mais — ver nota em S14; `REVISAO_CONSOLIDADA_TIPOS_PENDENTE.md`. Atualização (S17 adiada, 2026-07-18): idem — ver `docs/issues/009`.**
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
- **Tarefa de housekeeping documental — parte 1 já concluída (S13, fora de ordem, a pedido do usuário):** os 5 documentos do programa já vivem em `docs/refatoracao-arquitetural-2026/` (movidos antes do encerramento, por preferência explícita do usuário de não depender de busca/memória para achá-los). **Parte 2, ainda deferida para este checkpoint:** dividir `MASTER_EXECUTION_PLAN.md` (já congelado neste ponto) em `SPRINTS/`+`CHECKPOINTS/`+`METRICAS.md`, compilar `EXECUCAO_DECISOES_DE_DESIGN.md` (novo) e escrever `README.md` como índice — plano completo em `PLANO_REORGANIZACAO_DOCUMENTAL.md`, seção 3.2-3.5 (a decomposição, diferente do agrupamento em pasta, continua fazendo sentido só depois que o documento parar de crescer).
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
| S08 | 2026-07-17 | ~1 sessão (+ 1 rodada extra de investigação pedida pelo usuário) | 151fd6a, 36036de | 5 (`src/core/EnvironmentProbe.ts` movido, `core/CapabilityRegistry.ts`, testes `S110`/`S34`/`S112` corrigidos, `docs/issues/002-*.md` novo) | Windows: `tsc`+`build`+regressão 119/119 (S112 ganhou 1 assert a mais no fix). **Linux real (VPS)**: causa raiz de cada falha investigada individualmente (não só "reproduz no baseline, ok") — `S37` 9/9 e `S13` 7/8 eram falso-positivo por `WORKSPACE_DIR` ausente no meu setup de validação; `S112` era bug de teste real (bashismo sob `dash`), corrigido | Round-trip `core/CapabilityRegistry` ↔ `loop/EnvironmentProbe` ↔ `core/ToolRegistry` | `EnvironmentProbe.ts` movido para `core/`; import agora intra-camada nos dois sentidos | 0 causados por este ARCH — mas achei 1 bug de teste real (`S112`, corrigido) e 1 fragilidade de asserção documentada (`S13`, não corrigida) escondidos atrás do que eu tinha rotulado apressadamente como "diferença de ambiente" | **"Reproduz no commit anterior, na mesma máquina" prova ausência de regressão, mas não substitui investigar a causa raiz de cada falha** — só descobri o bug real do S112 (e que os outros 2 eram falha do meu próprio setup, não do Linux) porque o usuário perguntou diretamente "as falhas estão sendo documentadas?" em vez de aceitar minha primeira conclusão ("gap de ambiente pré-existente", vaga demais) como suficiente. A skill `verify` já tinha a resposta certa (`.env` com `WORKSPACE_DIR`) — pular esse passo ao adaptar o procedimento pra uma VPS remota via SSH foi o que gerou 2 dos 3 falsos positivos. |
| S09 | 2026-07-17 | ~1 sessão | d9efaff | 8 (`shared/StrategyDiversityGuard.ts` movido, `shared/extractText.ts` novo, `loop/GoalExecutionLoop.ts`, `loop/GoalPlanner.ts`, `loop/ResponseBuilder.ts`, `memory/CaseMemory.ts`, `memory/conversational/CMIIngestionPipeline.ts`, teste `S22` corrigido) | `tsc --noEmit` (limpo) + `npm run build` (limpo) + regressão (119/119) + grep confirmando 0 imports de runtime de `loop/` em `memory/` | `memory/` dependia em runtime de 2 símbolos de `loop/` (`StrategyDiversityGuard`, `extractText`) | `StrategyDiversityGuard.ts` movido inteiro; `extractText` extraído de `ResponseBuilder.ts` (não de `ResponseAdapter.ts`, um shim depreciado) | 0 causados por este ARCH — mas achei 2 funções `extractText` diferentes com o mesmo nome no código (`ContentExtractor.ts` tem outra, assinatura `unknown`→`string`, com docstring desatualizado dizendo que `ContextCompressor` a usaria, quando na verdade usa a outra) | `ResponseAdapter.ts`, citado no card, acabou sendo só um shim `@deprecated` — a implementação real de `extractText` estava em `ResponseBuilder.ts`, junto com 3 outras responsabilidades (normalizeResponse, ContextValidator, DecisionPostProcessor) que TÊM dependência real de `loop/` (`AgentState`, `ToolResult`) e não deveriam mover. Mapear o card contra o código real antes de mover evitou mover o arquivo errado ou arrastar dependências desnecessárias para `shared/`. |
| S10 | 2026-07-17 | ~1 sessão | fbaf1a0 | 2 (`shared/StrategyDiversityGuard.ts`, teste novo `S117`) | `tsc --noEmit` (limpo) + `npm run build` (limpo) + regressão (120/120, 119 + `S117` novo, 6 cenários) | Regex recomputava por texto livre o que `toolsTried` já guarda estruturado (com lacuna real: só 11 de 25 tools reconhecidas) | `toolsTried.join('→')` como fonte primária aditiva; regex sobrevive só p/ detectar `'agentloop'` | 0 causados por este ARCH — mas confirmou e corrigiu (efeito colateral direto) a lista hardcoded de 11/25 tools no regex antigo, `docs/issues/005` | A premissa do card ("toolsTried já guarda a sequência estruturada") não se sustentou 1:1 na inspeção real — é deduplicado, sem fronteira por tentativa, nunca contém `'agentloop'`. Trocar a fonte por completo teria enfraquecido a semântica do fingerprint (de "sequência exata" pra algo mais vago). Design aditivo (soma ao invés de substitui) preservou a semântica original e ainda assim atingiu o critério de aceite do card ("fonte primária"). Card marcado "Quick Win" pelo backlog, mas a investigação de premissa levou tanto quanto uma Sprint típica desse programa — "Quick Win" descreve o tamanho do diff, não necessariamente o esforço de entender se a premissa é sequer verdadeira. |
| S11 | 2026-07-17 | ~1 sessão | 52e8e3c | 2 (`loop/GoalPlanner.ts`, teste novo `S118`) | `tsc --noEmit` (limpo) + `npm run build` (limpo) + regressão (121/121, 120 + `S118` novo, 5 cenários) + verificação byte-a-byte adicional (3 de 4 blocos idênticos ao original, 1 normalização cosmética documentada) | 4 blocos de detecção de loop com texto quase idêntico gerado por código duplicado 4x | `buildLoopDirective()` como fonte única de FORMATAÇÃO para os 4; `extractExhaustedTools()` como fonte aditiva só onde o padrão realmente se aplica (1 de 4) | 0 causados por este ARCH | A premissa do card ("os 4 blocos são o mesmo padrão de detecção") não se sustentou — só 1 de 4 é genuinamente "tool falhou N vezes"; os outros 3 detectam categoria de blocker+texto, categoria de ação (não falha), e ocorrência única (não repetição). Forçar os 4 pra `extractExhaustedTools()` como o card sugeria teria quebrado 3 deles silenciosamente. Terceira Sprint seguida (depois de S08 e S10) onde a premissa original do backlog não resistiu à inspeção do código real — o padrão está claro o suficiente pra virar hábito permanente: nunca implementar a "troca de fonte" de um card sem antes confirmar que as duas fontes representam genuinamente a mesma coisa. |
| S12 | 2026-07-17 | ~1 sessão | 88ede55 | 2 (`tools/exec_command.ts`, teste `S11` corrigido) | `tsc --noEmit` (limpo) + `npm run build` (limpo) + regressão (121/121) + os 4 arquivos citados no card (S11/S12/S13/S15) rodados individualmente e confirmados verdes | 4 transformações de `command` (marp/pandoc/PowerShell) como `if`s soltos em `execute()`, ordem só documentada em comentário | `COMMAND_FIXUP_PIPELINE` (array nomeado, 4 steps) + `applyFixup()`, chamado individualmente nos mesmos 4 pontos exatos | 1 achado e corrigido no ato — `S11` fazia asserção sobre `needsPowerShellWrap(` aparecer no texto literal de `execute()`, quebrou quando a chamada foi pro `condition()` do pipeline (mesma classe de achado do S52/S110/S34/S22) | Primeira Sprint com premissa quase inteiramente correta (a única correção: "~12 funções" incluía helpers de PowerShell não relacionados à cadeia de transformação sequencial, e 2 delas eram gates de validação, não transformações). Decisão consciente de NÃO usar um loop único: `isSearchCommand` precisa ler o comando antes do `wrap_powershell` rodar, ou grep/rg/find nunca mais seriam reconhecidos depois do embrulho em PowerShell — a "estrutura de dados explícita" que o card pede não exige forçar tudo num `for` só quando isso quebraria uma dependência de ordem real e documentada. |
| S13 | 2026-07-17 | ~1 sessão | 216f039 | 3 (`shared/domainTypes.ts`, `loop/GoalExecutionLoop.ts`, teste novo `S119`) | `tsc --noEmit` (limpo) + `npm run build` (limpo) + regressão (122/122, 121 + `S119` novo, 4 cenários/8 assertions) | `PlanStep.status` hardcoded `'completed'` em `markStepDone()` independente do outcome real do `GoalAttempt` mais recente — divergência invisível fora de `goal.attempts` | `PlanStep.lastAttemptOutcome?: AttemptOutcome` novo, populado com o `reflectionOutcome` já calculado (antes só usado pela ReflectionMemory) | 0 causados por este ARCH | A premissa do card estava certa no resultado (`completed` com attempt `partial` acontece de verdade) mas errada na causa citada — o caminho de "downgrade semântico" que o card apontava (L1137-1202) nunca chega a chamar `markStepDone`, porque `cycleResult.outcome` já deixa de ser `'success'` antes do `switch`. O gatilho real é o caminho da Sprint 0.8 (heurística de baixa confiança), já coberto por outro teste (S85) só no nível do `GoalAttempt` — faltava propagar pro `PlanStep`. Reforça o padrão dos Sprints anteriores: o sintoma correto no card não garante que a causa citada seja a real; vale rastrear o fluxo de execução ponta a ponta antes de implementar, mesmo quando a conclusão final ("é preciso um fix aqui") já parecia óbvia. Decisão de design foi deliberadamente a opção de MENOR blast radius das duas oferecidas pelo card (não mexer no enum de `status`, usado por ~15 call sites) — em vez de mudar retry behavior por um caminho que nunca foi desenhado pra re-tentar. |
| S14 | 2026-07-17 | ~1 sessão (adiada na Fase 1/2, sem implementação) | 92c46da (docs) | 0 arquivos de código; 4 arquivos de doc (`docs/issues/008` novo, `REVISAO_CONSOLIDADA_TIPOS_PENDENTE.md` novo, `RETROSPECTIVA_PREMISSAS_AUDITORIA.md`, `ARCHITECTURAL_BACKLOG.md`) + este documento | N/A — nenhum código tocado, nada a rodar | `output`/`error` redeclarados independentemente em `ToolResult`/`CycleResult`/`GoalAttempt` (premissa do card) | Nenhuma mudança — Sprint adiada antes de codificar | 0 causados (nenhum código tocado), mas achado grave sobre a viabilidade do card em si | A prescrição literal do card (`extends ToolResult`) não compila — `output` obrigatório em `ToolResult` vs. opcional em `CycleResult`/`GoalAttempt`, TS não permite herdar obrigatório→opcional — e, se forçada via mudança de tipo, reintroduziria a violação de fronteira `shared/→loop/` que o ARCH-004 (S02) já corrigiu (`GoalAttempt` mora em `shared/domainTypes.ts` desde então). Primeira Sprint do programa em que a PRESCRIÇÃO do card, não só o diagnóstico/causa citada, se mostrou estruturalmente inviável (5º modo de falha, catalogado em `RETROSPECTIVA_PREMISSAS_AUDITORIA.md`) — a auditoria original comparou nomes de campo entre 3 tipos sem verificar obrigatoriedade nem a camada física de cada um, que mudou desde a auditoria por causa de outra Sprint deste mesmo programa (ARCH-004). Por decisão do usuário, consolidado (não resolvido pontualmente) com achados correlatos de modelagem de tipo compartilhado — `REVISAO_CONSOLIDADA_TIPOS_PENDENTE.md`, que já inclui ARCH-024 (mesma classe de problema em `ChannelContext`) e `docs/issues/004`. |
| S15 | 2026-07-17 | ~1 sessão | ebea0f5 | 2 (`loop/GoalEvaluator.ts`, teste novo `S120`) | `tsc --noEmit` (limpo) + `npm run build` (limpo) + regressão (123/123, 122 + `S120` novo, 4 cenários/5 assertions) | Dedup `alreadyFailed` inline em `evaluate()`, `JSON.stringify` bruto para comparar args, `send_document` nunca dedupava entre legendas cosmeticamente diferentes | `hasIdenticalFailedAttempt()` método nomeado, chave via `computeToolInputKey()` (já existente/testado, S90) — sem índice persistido/cacheado | 0 causados por este ARCH | A premissa do card citava um "método" que na verdade era uma `const` local, e pedia responder "quantas vezes já falhou" quando o código só precisa de um booleano ("já falhou alguma vez com estes args exatos?") — nenhum consumidor real precisa da contagem. Mais importante: um índice incremental de verdade (o que o card literalmente pedia) foi conscientemente REJEITADO na Fase 2 — `Goal` é recarregado do `GoalStore` a cada mudança de estado relevante em `runLoopInternal`, não existe objeto estável em memória entre ciclos pra um cache se anexar com segurança, e um índice persistido criaria uma segunda fonte de verdade para dado já 100% contido em `goal.attempts` (o oposto do que o Epic B pede), com o mesmo risco de restart-safety ainda em aberto do ARCH-008. A solução implementada (método nomeado + reuso de `computeToolInputKey`) entrega a "clareza" que era o ganho real admitido pelo próprio card, sem os riscos do índice literal — e como efeito direto (não oportunista) de calcular a chave de args corretamente, corrigiu o mesmo gap de dedup de `send_document` por legenda que S90 já tinha corrigido numa camada diferente (`AgentLoop`), agora consistente também em `GoalEvaluator`. |
| S16 | 2026-07-18 | ~1 sessão (incl. Fase 1/2 extensa + etapa 4 real) | 7abede2 | 2 código (`loop/GoalExecutionLoop.ts`, teste novo `S121`) + 1 teste corrigido (`S10`) | `tsc --noEmit` (limpo) + `npm run build` (limpo) + regressão (124/124, 123 + `S121` novo, 2 cenários/3 assertions) + **etapa 4 real**: instância isolada Windows, LLM real (glm-5.2:cloud), goal real, dado real do SQLite confirmando a precondição do bug e a correção nos dois sentidos | "4 estruturas desincronizadas" de artefatos entregues (premissa do card) | Fix cirúrgico: `sentArtifacts`/`pendingSendPaths` normalizados via `resolvePath()` antes de comparar contra paths absolutos de `checkDeliverables()` em `deliverable_check` | 0 causados por este ARCH — mas achado 1 bug real não documentado antes (mismatch de path cru vs. resolvido), confirmado com dado real em ambiente real | Maior desvio de premissa do programa até agora: a reverificação de Fase 1/2 mostrou que as "4 estruturas" já convergiam majoritariamente para `sentArtifacts` (via `onArtifactDelivered`, `.has()`, fallback em `checkClaimsAgainstEvidence`), que o escopo do card estava incompleto (faltava `planning/artifactContract.ts`), e que os 2 bugs históricos citados como motivação já tinham sido corrigidos por Sprints anteriores a este programa. Consolidar 4 mecanismos já majoritariamente sincronizados, pra prevenir uma 3ª ocorrência hipotética de bug já resolvido 2x, tinha valor questionável frente ao risco de um Refactor Estrutural. Apresentei 3 alternativas ao usuário (fix cirúrgico / consolidação completa / adiar como ARCH-009); optou pelo fix cirúrgico. Etapa 4 (obrigatória pelo card original) foi cumprida apesar do escopo reduzido, por decisão do usuário, dado que a mudança toca resolução de path — categoria com histórico de bugs só visíveis fora de mocks (`feedback_verificar_fixes_de_verdade`); rodei uma instância isolada real com LLM real, que confirmou com dado genuíno (não hipotético) que `send_document` de fato usa paths relativos na prática, validando a precondição do bug antes mesmo de testar o fix. VPS Linux oferecida e dispensada pelo usuário (código só usa `path.resolve`/`path.join`, sem lógica por SO). |
| S17 | 2026-07-18 | ~1 sessão (adiada na Fase 1, sem implementação) | 4e01818 | 0 arquivos de código; 1 arquivo de doc novo (`docs/issues/009`) + `RETROSPECTIVA_PREMISSAS_AUDITORIA.md`/`ARCHITECTURAL_BACKLOG.md` + este documento | N/A — nenhum código tocado, nada a rodar | `progressModel` reseta a cada `runLoop()`, perdendo progresso "pós-restart" (premissa do card) | Nenhuma mudança — Sprint adiada antes de codificar | 0 causados (nenhum código tocado), mas achado grave sobre a premissa do card | O mecanismo citado como motivação/cenário de teste ("o sistema já tem recovery de goals ativos no boot") não existe — `AgentController.getAllActive()` só loga no boot/shutdown (`recovered=false` explícito), nunca chama `resumeGoal()`. O defeito é real, mas via outro caminho: o único call site de `resumeGoal()` é `GoalOrchestrator.resumeFromAuth()` (aprovação de ação perigosa), mesmo processo, sem restart — mais frequente que o cenário descrito. 6º modo de falha catalogado (auditoria afirmando que um mecanismo operacional existe, sem verificar contra o runtime) — o mais perigoso dos 6 por ler como fato de arquitetura, não como inferência. Fix desenhado (`buildInitialProgressModel`, deriva de `goal.currentPlan`/`goal.attempts`, mesmo espírito de `buildIncrementalExecutionContext`) mas não implementado — usuário optou por adiar e documentar em vez de corrigir pontualmente, dado que a etapa 4 prescrita pelo card ("matar o processo") nem sequer é testável nesse sistema. |
| S18 | 2026-07-18 | ~1 sessão (adiada na Fase 1, sem implementação) | 4171d31 | 0 arquivos de código; 1 arquivo de doc novo (`docs/issues/010`) + `RETROSPECTIVA_PREMISSAS_AUDITORIA.md`/`ARCHITECTURAL_BACKLOG.md` + este documento | N/A — nenhum código tocado, nada a rodar | `structuralBypass` é um `if` solto fora de `evaluateCriteria` (premissa do card) | Nenhuma mudança — Sprint adiada antes de codificar | 0 causados (nenhum código tocado), mas achado grave sobre a premissa numa área de bug histórico real | O card presumia que `CriterionCheck: 'file_exists'` já cobria o caso de uso de `structuralBypass` — não cobre: `file_exists` checa `GoalAttempt.output` não-vazio, `structuralBypass` faz `fs.statSync()` direto no disco sem depender de attempt algum (motivo de existir: o Bug 2 original era sobre arquivo pré-existente ao goal, sem attempt como evidência). Reaproveitar `file_exists` literalmente reintroduziria o deadlock. Achado estrutural adicional: alvos de `structuralBypass` são dinâmicos (plano atual, muda a cada replan) vs. `successCriteria` estática — sincronizar as duas seria um risco novo, não uma simplificação. 2ª instância confirmada do modo 3 da retrospectiva (mesmo modo de S10/S11) — reforça que "equivalência semântica assumida sem verificação" é o modo mais recorrente do catálogo, não um acaso isolado. Alternativa desenhada (`CriterionCheck` novo dedicado) mas não implementada — usuário optou por adiar, mesma linha de S14/S17, dado o histórico de bug real nesta área específica. |
| S19 | 2026-07-18 | ~1 sessão | 9b6fc80 | 1 (`RFC_ARCH-024_DeliveryTrackingContext.md`, novo) | N/A (Sprint de RFC — sem código, sem build/teste) | 5 campos de callback "todos sobre rastreamento de entrega" (premissa do card) | RFC aprovada: 4 campos (não 5) consolidados em `ChannelContext.deliveryTracking` (campo aninhado, não parâmetro separado) | 0 (Sprint de análise, sem código) | Grep completo dos 5 campos mostrou que `recentMessages` é construído em `MessageBus.ts` (mesmo lugar/razão que `channel`/`chatId`/`userId`) e consumido só por `UnifiedIntentRouter`, sem nenhuma relação com entrega de artefato — a premissa do card ("nenhum é sobre o canal, todos sobre entrega") valia pra 4 dos 5, não pros 5. Avaliadas 4 alternativas de forma de consolidação; escolhida a de menor risco (campo aninhado dentro de `ChannelContext`, não parâmetro novo em `AgentLoop.process()`) por preservar a assinatura de método existente — o card não distinguia entre as duas formas, e a diferença de risco entre elas é grande. RFC aprovada com esse escopo corrigido; implementação agendada para S23 (já condicionada a esta RFC). |
| S20 | 2026-07-18 | ~1 sessão | b883cac | 1 (`RFC_ARCH-015_SchemaGeneratedRequiredArgs.md`, novo) | N/A (Sprint de RFC — sem código, sem build/teste) | "gerar validação + texto de prompt a partir do schema" resolve os 5 lugares de args obrigatórios (premissa do card) | RFC aprovada com escopo REDUZIDO: só texto de prompt (`requiredArgsHint` co-localizado por tool); validação não aprovada nesta forma | 0 (Sprint de análise, sem código) | Achado 1: os "5 lugares" nem cobrem o mesmo conjunto de tools — `memory_write` nunca aparece em `detectMissingRequiredArgs()` (grep completo confirma), só no schema e no guard interno. Achado 2, mais grave: a lógica de "obrigatório" não é um `required: string[]` plano pra pelo menos 3 tools (`web_navigate`/`crypto_analysis`: condicional a outro campo do mesmo args; `edit`: "uma de 3 combinações válidas") — gerar a VALIDAÇÃO a partir do schema atual perderia essa lógica condicional silenciosamente, uma regressão de comportamento, não uma simplificação, a menos que o formato do schema seja estendido pra um dialeto condicional (esforço de modelagem maior que o "Risco: Médio" do card sugeria). Achado 3: só a metade de TEXTO DE PROMPT tem incidente real confirmado (S06/ARCH-025 achou drift real entre os 2 blocos de prompt) — a metade de validação não tem nenhum incidente de produção documentado motivando urgência, diferente de S16/S18. RFC aprovou só a metade de menor risco e com evidência real de valor (texto de prompt via campo novo `requiredArgsHint` em `ToolExecutor`, agregado por `ToolRegistry.getEnabled()`); a metade de validação fica candidata a uma RFC futura distinta, condicionada a desenhar um dialeto de schema condicional primeiro. |
| S21 | 2026-07-18 | ~1 sessão (adiada na Fase 1/2, sem implementação) | 505a8a9 | 0 arquivos de código; 1 arquivo de doc novo (`docs/issues/011`) + `RETROSPECTIVA_PREMISSAS_AUDITORIA.md`/`ARCHITECTURAL_BACKLOG.md` + este documento | N/A — nenhum código tocado, nada a rodar | 2 juízes de sucesso de step rodam em sequência desnecessária, fundir reduz 2 chamadas de LLM pra 1 (premissa do card) | Nenhuma mudança — Sprint adiada antes de codificar | 0 causados (nenhum código tocado), mas achado de categoria nova sobre a consequência da fusão | **Único caso do programa até agora onde a premissa do card está CORRETA e a prescrição é tecnicamente viável** (compila, roda, não reintroduz violação) — o que faltou foi rastrear a consequência completa: `escalateStepEvalToLLM` confirmando sucesso marca `stepSuccessConfident=true`, que decide se `GoalAttempt.result` vira `'success'` ou `'partial'`; `StepSemanticValidator` só tem sinal negativo (`shouldDowngradeToPartial`) — fundir sem dar a ele um sinal de promoção equivalente faria todo step ambíguo virar `'partial'` sempre, mudança de comportamento observável não anunciada pelo card. 7º modo de falha catalogado (categoria nova, distinta dos 6 anteriores — aqui não é a premissa que falha, é a consequência da mudança que não foi seguida até o fim). Alternativa desenhada (StepSemanticValidator ganha sinal de promoção) mas não implementada — usuário optou por adiar, mesma linha de S14/S17/S18 apesar da categoria diferente do achado. |

---

## Regras permanentes deste programa (repetidas aqui para consulta rápida durante a execução)

1. Nunca executar dois grandes refactors simultaneamente. WIP máximo = 1.
2. Nunca adicionar funcionalidades novas durante a execução deste programa.
3. Nunca aproveitar uma Sprint para corrigir problemas fora do seu ARCH designado — *No Opportunistic Refactoring*. Dívida nova encontrada: **criar um arquivo em `docs/issues/NNN-titulo-curto.md`** (próximo número livre — ver os já existentes antes de numerar; formato do `001`: Descrição, Comportamento Esperado/Observado, Causa Raiz, Severidade), não só uma frase solta dentro do card da Sprint — a nota inline no card pode (e deve) continuar existindo como referência rápida, mas o registro completo, pesquisável e sobrevivente à reescrita do Resumo Executivo mora no arquivo de issue. Depois: propor novo ARCH se fizer sentido, continuar a Sprint atual sem desviar. **Nota:** `docs/issues/` está no `.gitignore` deste projeto (só `001` ficou versionado, de antes dessa regra) — os arquivos ficam documentados localmente; perguntar ao usuário se algum deve ser forçado (`git add -f`) para o GitHub.
4. Respeitar rigorosamente as dependências registradas no Painel Executivo — nunca alterar a ordem por conveniência.
5. Toda Sprint que envolva `Refactor Estrutural` ou `Exige RFC` precisa da etapa 4 (ambiente real) da Validação Progressiva antes de ser considerada `🟢 Concluída` — etapas 1-3 sozinhas não bastam.
6. Este documento (`MASTER_EXECUTION_PLAN.md`) é atualizado a cada Sprint encerrada — o Painel Executivo e o Resumo Executivo nunca ficam desatualizados por mais de uma Sprint.
7. Nenhuma Sprint fecha `🟢 Concluída` sem passar nos dois eixos de regressão (ver "Regressão Funcional vs. Regressão Arquitetural", no topo do documento) — comportamento externo inalterado E nenhuma violação arquitetural reintroduzida. Passar só na suíte de testes não é suficiente; passar só no grep de indicadores arquiteturais também não é. O Dashboard Executivo (logo após o Resumo Executivo) é reescrito a cada Sprint encerrada, junto com o Resumo — se alguma linha do Dashboard virar ✘, nenhuma Sprint nova começa até a causa ser encontrada e corrigida.
