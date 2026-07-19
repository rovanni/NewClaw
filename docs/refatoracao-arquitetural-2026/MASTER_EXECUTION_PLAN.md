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

| Sprint | Período | Epic | ARCH | Status | Dependências | Commit | Resultado | Detalhe |
|---|---|---|---|---|---|---|---|---|
| 2026-07-P00 | Jul/2026 | Preparação | Baseline | 🟢 | — | d088864 (TAG `baseline-b1.0-pre-refactor`) | 118/118, tsc limpo, T0 registrado |  |
| 2026-07-S01 | Jul/2026 | Boundary Enforcement | ARCH-001 | 🟢 | P00 | 6c14a9b | 26 imports corrigidos (`tools/`→25, `core/ToolRegistry.ts`→1), tsc limpo, 118/118 | [ver](SPRINTS/S01-ARCH-001.md) |
| 2026-07-S02 | Jul/2026 | Boundary Enforcement | ARCH-004 | 🟢 | P00 | 18ba2a2 | `shared/domainTypes.ts` criado, `memory/` sem imports de tipo de `loop/`, tsc limpo, 118/118 | [ver](SPRINTS/S02-ARCH-004.md) |
| 2026-07-S03 | Jul/2026 | Single Source of Truth | ARCH-006 | 🟢 | P00 | 0225075 | `getPendingSteps` único, 15 call sites migrados, tsc limpo, 119/119 | [ver](SPRINTS/S03-ARCH-006.md) |
| 2026-07-S04 | Jul/2026 | Decision Ownership | ARCH-014 | 🟢 | P00 | ccf97c1 | `shared/transientErrorPatterns.ts` novo, 6 padrões unificados, verificado byte-a-byte, 119/119 | [ver](SPRINTS/S04-ARCH-014.md) |
| 2026-07-S05 | Jul/2026 | Decision Ownership | ARCH-017 | 🟢 | P00 | dd1a51e | `ToolExecutorService` removido (4 arquivos), build+tsc limpos, 119/119 | [ver](SPRINTS/S05-ARCH-017.md) |
| 2026-07-S06 | Jul/2026 | Technical Cleanup | ARCH-025 | 🟢 | P00 | 7aa5bc4 | 2 blocos de prompt unificados (6 divergências corrigidas), build+tsc limpos, 119/119 | [ver](SPRINTS/S06-ARCH-025.md) |
| 2026-07-S07 | Jul/2026 | Technical Cleanup | ARCH-026 | 🟢 | P00 | e97405d | `DELIVERABLE_EXTENSIONS` movido, 1 teste corrigido (S52), build+tsc limpos, 119/119 | [ver](SPRINTS/S07-ARCH-026.md) |
| 2026-07-CP01 | Jul/2026 | Checkpoint | — | 🟢 | S01-S07 | — | 7/7 Sprints concluídas, indicadores revisados, 0 riscos residuais | [ver](CHECKPOINTS/CP01.md) |
| 2026-07-S08 | Jul/2026 | Boundary Enforcement | ARCH-002 | 🟢 | CP01 | 151fd6a, 36036de | Movido p/ core/, validado real em Windows+Linux (VPS); 3 falhas iniciais na VPS = 2 falso-positivo do setup + 1 bug de teste real (corrigido) — ver docs/issues/002 | [ver](SPRINTS/S08-ARCH-002.md) |
| 2026-07-S09 | Jul/2026 | Boundary Enforcement | ARCH-003 | 🟢 | CP01 | d9efaff | `memory/` 0 imports de runtime de `loop/`; achado colateral doc. em issues/004 | [ver](SPRINTS/S09-ARCH-003.md) |
| 2026-07-S10 | Jul/2026 | Single Source of Truth | ARCH-011 | 🟢 | S09 | fbaf1a0 | Fonte primária estruturada aditiva + fallback agentloop; 14 tools "invisíveis" corrigidas de brinde | [ver](SPRINTS/S10-ARCH-011.md) |
| 2026-08-S11 | Ago/2026 | Decision Ownership | ARCH-016 | 🟢 | S10 | 52e8e3c | Template compartilhado nos 4 blocos; fonte estruturada aditiva só em exec_command (1/4, correto per docs/issues/006) | [ver](SPRINTS/S11-ARCH-016.md) |
| 2026-08-S12 | Ago/2026 | Structural Simplification | ARCH-023 | 🟢 | CP01 | 88ede55 | Pipeline nomeado (4 steps), gates de validação preservados como ifs, S11 corrigido | [ver](SPRINTS/S12-ARCH-023.md) |
| 2026-08-S13 | Ago/2026 | Single Source of Truth | ARCH-007 | 🟢 | CP01 | 216f039 | `PlanStep.lastAttemptOutcome` novo campo; gatilho real ≠ premissa literal do card (ver ARCHITECTURAL_BACKLOG "Executado como") — teste novo S119, 122/122 | [ver](SPRINTS/S13-ARCH-007.md) |
| 2026-08-S14 | Ago/2026 (reaberto e encerrado 2026-07-18) | Single Source of Truth | ARCH-009 | 🚫 | CP01 | 92c46da (docs), reabertura sem novo commit de código | Adiado em 2026-07-17 (prescrição `extends ToolResult` não compila + reintroduz violação de fronteira do ARCH-004); reaberto em 2026-07-18 como 1º item do próximo ciclo de auditoria (CP05) — escopo corrigido (só ToolResult+GoalAttempt) reavalia Impacto/Risco/Esforço para Baixo/Baixo/Pequeno, mas usuário decidiu encerrar sem implementar (ganho antecipatório, sem bug real) — ver `docs/issues/012` | [ver](SPRINTS/S14-ARCH-009.md) |
| 2026-08-S15 | Ago/2026 | Single Source of Truth | ARCH-010 | 🟢 | CP01 | ebea0f5 | `hasIdenticalFailedAttempt()` nomeado + `computeToolInputKey` (não índice persistido — SSOT/restart-safety), fix colateral direto: dedup de `send_document` por `file_path`, teste `S120`, 123/123 | [ver](SPRINTS/S15-ARCH-010.md) |
| 2026-08-CP02 | Ago/2026 | Checkpoint | — | 🟢 | S08-S15 | — | S08-S13/S15 🟢 (7/8), S14 ⏸ adiada com justificativa registrada (não é falha); 0 violações de fronteira novas, regressão 123/123, nenhum indicador piorou | [ver](CHECKPOINTS/CP02.md) |
| 2026-08-S16 | Ago/2026 | Single Source of Truth | ARCH-005 | 🟢 | CP02 | 7abede2 | Escopo redesenhado (Fase 1/2): premissa das "4 estruturas desincronizadas" não se sustentou; fix cirúrgico de normalização de path (`resolvePath`) em `deliverable_check`, achado real confirmado em ambiente real (LLM real, goal real), `S121` novo, 124/124 | [ver](SPRINTS/S16-ARCH-005.md) |
| 2026-08-S17 | Ago/2026 (reaberto e concluído 2026-07-19) | Single Source of Truth | ARCH-008 | 🟢 | S16 | 4e01818 (adiamento original) + implementação (`GoalExecutionLoop.ts`, `S127` novo) | Reaberto como 3º item do próximo ciclo de auditoria (pós-ARCH-013); `buildInitialProgressModel()` novo usando `PlanStep.lastAttemptOutcome` (ARCH-007); achado real: bug quebrava a lógica `ADAPTIVE-BUDGET`, não só a barra de progresso visual; regressão 130/130; etapa 4 real confirmou `progressModel` preservado via `resumeFromAuth()` contra goal real | [ver](SPRINTS/S17-ARCH-008.md) |
| 2026-08-S18 | Ago/2026 | Decision Ownership | ARCH-018 | ⏸ | S16 | 4171d31 | Adiado antes de codificar — `file_exists` checa attempt, não disco (2ª instância do modo 3); reaproveitá-lo reintroduziria o deadlock histórico; fix desenhado em `docs/issues/010` | [ver](SPRINTS/S18-ARCH-018.md) |
| 2026-09-S19 | Set/2026 | Structural Simplification | ARCH-024-RFC | 🟢 | CP02 | 9b6fc80 | RFC aprovada, escopo corrigido: 4 campos consolidados (não 5 — `recentMessages` não é delivery-tracking); campo aninhado `deliveryTracking`, não parâmetro separado; ver `RFC_ARCH-024_DeliveryTrackingContext.md` | [ver](SPRINTS/S19-ARCH-024-RFC.md) |
| 2026-09-S20 | Set/2026 | Decision Ownership | ARCH-015-RFC | 🟢 | S06 | b883cac | RFC aprovada com escopo REDUZIDO: só texto de prompt (`requiredArgsHint`); validação não aprovada (lógica condicional em 3+ tools, sem incidente real motivando); ver `RFC_ARCH-015_SchemaGeneratedRequiredArgs.md` | [ver](SPRINTS/S20-ARCH-015-RFC.md) |
| 2026-09-CP03 | Set/2026 | Checkpoint | — | 🟢 | S16-S20 | — | S16/S19/S20 🟢 (3/5), S17/S18 ⏸ adiadas com justificativa (não bloqueiam); 0 violações de fronteira novas, regressão 124/124; risco de S16 não extrapolado pra baixo em S24/S25 | [ver](CHECKPOINTS/CP03.md) |
| 2026-09-S21 | Set/2026 (reaberto e concluído 2026-07-18) | Decision Ownership | ARCH-013 | 🟢 | CP03, S14 | 505a8a9 (adiamento original) + implementação (StepSemanticValidator.ts, GoalStore.ts, GoalExecutionLoop.ts, GoalTypes.ts, S85/S119 corrigidos, S126 novo) | Reaberto como 2º item do próximo ciclo de auditoria (pós-ARCH-009); `escalateStepEvalToLLM` removida, `StepSemanticValidator.shouldPromoteToConfidentSuccess` + `GoalStore.promoteLastAttemptToSuccess()` novos; regressão 129/129; etapa 4 real confirmou `[SEMANTIC-PROMOTE]` com LLM real promovendo um step `agentloop` genuíno, goal completo, arquivo entregue | [ver](SPRINTS/S21-ARCH-013.md) |
| 2026-09-S22 | Set/2026 | Structural Simplification | ARCH-022 | 🟢 | S16, S14, S21 | 3ee9751 | `executeStep()` decomposto (orquestrador + 4 métodos); só 3 de 4 blocos "quase idênticos" eram genuinamente equivalentes; `S122` novo (21 assertions), `S51` corrigido; 125/125 | [ver](SPRINTS/S22-ARCH-022.md) |
| 2026-10-S23 | Out/2026 (executada 2026-07-18) | Structural Simplification | ARCH-024-Impl | 🟢 | S19 (aprovação) | ff2dd23 | 4 campos nested sob `deliveryTracking` (não 5 — `recentMessages` excluído pela RFC); achado real: 8 pontos de consumo em `AgentLoop.ts`, não 6 como a RFC contou; `S44` corrigido (fonte-texto-frágil, mesma classe de S22/S51); tsc+build limpos, 125/125; **etapa 4 real executada** (autocorrigida — dispensa inicial revertida por Regra #5, classificação `Exige RFC`) — goal real confirmou `deferSendDocument` aninhado entregando arquivo de verdade | [ver](SPRINTS/S23-ARCH-024-Impl.md) |
| 2026-10-S24 | Out/2026 (executada 2026-07-18) | Structural Simplification | ARCH-020 | 🟢 | S16, S03, S13, S17, S14 | 0173795, 2782216 | 2 incrementos sequenciais (switch → 6 handlers; corpo pré-switch → 4 fases); `runLoopInternal` 1030→154 linhas, maior método novo 221; 3 instâncias do mesmo bug de priorFeedback pegas por leitura antes de testar; tsc+build limpos, 126/126 (1 fonte-texto corrigida); etapa 4 real ×2, ambos completos com entrega de arquivo confirmada | [ver](SPRINTS/S24-ARCH-020.md) |
| 2026-10-S25 | Out/2026 (executada 2026-07-18) | Structural Simplification | ARCH-019 | 🟢 | S16, S22, S23; nunca simultânea com S24 (cumprida) | 53a4fa3, 3b40632, baf5d34, 45788e1, 0778076, 73d246c | 6 incrementos crescentes de risco; maior refactor do programa. `runWithTools` 1793→419 linhas (77%); 8/9 métodos novos < 300 (exceção documentada: o orquestrador remanescente, aceita pelo usuário). 3 classes de erro de referência/tipo/parâmetro pegas por tsc antes de testar; tsc+build limpos, 126/126 em todos os 6 incrementos (0 quebras); etapa 4 real em todos os 6 | [ver](SPRINTS/S25-ARCH-019.md) |
| 2026-11-S26 | Nov/2026 (executada 2026-07-18) | Decision Ownership | ARCH-015-Impl | 🟢 | S20 (aprovação — cumprida, escopo reduzido) | 314831b | `buildRequiredArgsReference()` de template hardcoded → agregação de `ToolExecutor.requiredArgsHint` via `ToolRegistry.getEnabled()`; 7 tools migradas verbatim; nota de S25 "etapa 4 dispensável" corrigida (Classificação `Exige RFC` a torna obrigatória, Regra #5); tsc+build limpos, 127/127 (126+`S124` novo); etapa 4 real confirmou hint chegando ao prompt e `send_document` recebendo `file_path` na 1ª tentativa | [ver](SPRINTS/S26-ARCH-015-Impl.md) |
| 2026-11-CP04 | Nov/2026 (executada 2026-07-18) | Checkpoint | — | 🟢 | S21-S26 | — | S21-S26 todas 🟢 ou formalmente encerradas (S21 ⏸ adiada com justificativa); 0 God Method > 300 linhas fora da exceção documentada (`runWithTools`, 419); achado de planejamento: dependência real ARCH-012→ARCH-018 (adiada) ainda não resolvida — sinalizado, não decidido nesta revisão | [ver](CHECKPOINTS/CP04.md) |
| 2026-11-S27 | Nov/2026 (executada 2026-07-18) | Single Source of Truth | ARCH-012 | 🟢 | S16 (cumprida); S18 — dependência resolvida sem retomar (ver card) | 0ca79ed | RFC achou 3 mecanismos (não 2 — `structuralBypass` também decide "entrega comprovada"), premissa de duplicação só vale p/ 1 de 5 CLAIM_RULES; problema real = 2 rotas sem checagem de tipo de arquivo que a 3ª já tinha (reabre o bug de 09/07); unificação de tipo rejeitada por risco, implementado predicado compartilhado (`isExpectedDeliverableFile`) nos 3 pontos; tsc+build limpos, 128/128 (127+`S125` novo); etapa 4 real confirmou com LLM real que arquivo de tipo errado não completa mais o goal prematuramente — **último card executável do backlog** | [ver](SPRINTS/S27-ARCH-012.md) |
| 2026-12-CP05 | Dez/2026 (executada 2026-07-18) | Checkpoint de Encerramento | — | 🟢 | S27 (cumprida) | — | 26/26 ARCH com desfecho final (22 concluídos + 4 adiados), 3/3 RFCs concluídas, 0 violações de fronteira, God Methods 3→1 (exceção documentada), regressão 118→128; reorganização documental (SPRINTS/+CHECKPOINTS/+METRICAS.md+README.md) executada | [ver](CHECKPOINTS/CP05.md) |

---

## RESUMO EXECUTIVO

**Programa:** Refatoração Arquitetural NewClaw
**Status Geral:** 🟢 **Programa concluído** (2026-07-18) — Fase 0, S01-S27, Checkpoints CP01-CP05 todos concluídos. Próximo ciclo de auditoria (recomendado pelo CP05) em andamento desde 2026-07-18: S14/ARCH-009 reaberta e encerrada como Won't Fix; S21/ARCH-013 e S17/ARCH-008 reabertas e **implementadas**. Só S18/ARCH-018 permanece formalmente adiada. Todos os 26 cards do backlog têm desfecho final registrado.
**Progresso:** 24 / 26 ARCH concluídos (~92%) — só ARCH-018 (S18) permanece formalmente adiado; ARCH-009 (S14) encerrado como Won't Fix (`docs/issues/012`); ARCH-013 (S21) e ARCH-008 (S17) reabertos e **implementados** nesta rodada — ver `SPRINTS/S21-ARCH-013.md`/`SPRINTS/S17-ARCH-008.md`. ARCH-024 concluído (RFC S19 + Impl S23). ARCH-020+ARCH-021 concluídos juntos (S24, ARCH-021 absorvido). ARCH-019 concluído (S25, 6 incrementos). ARCH-015 concluído (RFC S20 + Impl S26). ARCH-012 concluído (RFC + Impl de escopo reformulado, S27).
**Sprint Atual:** Nenhuma em andamento (S17/ARCH-008 concluída — 3º item do próximo ciclo de auditoria)
**Próxima Sprint:** Nenhuma agendada — único candidato restante do ciclo de auditoria: ARCH-018 (S18), ver "Dívida Arquitetural Restante" abaixo.
**Epic Atual:** Epic A concluído; **Epic B concluído** — ARCH-005/006/007/008/010/011/012 feitos (ARCH-008 via reabertura), ARCH-009 encerrado (Won't Fix); **Epic C concluído** — ARCH-013/014/015/016/017 todos feitos (ARCH-013 via reabertura); **Epic D concluído** — ARCH-019/020/021/022/023/024 todos feitos; Epic E concluído — ARCH-025/026 feitos
**Próximo Marco:** nenhum agendado — próximo passo é decidir se/quando reabrir ARCH-018 (S18), o único item formalmente adiado restante
**Última Atualização:** 2026-07-19 (S17/ARCH-008 reaberta e concluída, pós-encerramento do programa)
**Build:** 🟢 `npm run build` limpo
**Testes:** 🟢 130/130
**Regressão:** 🟢 130/130 (129 pós-ARCH-013 + `S127` novo — ARCH-008 — 0 quebras líquidas)
**Riscos Abertos:** 1 materializado (não bloqueante, registrado no CP04, ainda válido): nenhum log de produção real está disponível para validar S24-S27 nem as reaberturas de S21/S17 — a branch `refactor/architectural-backlog` continua não mesclada em `main` (mesmo após o merge de `main` original em `f230fd9`/`v2.0.0`, o trabalho desta rodada de reaberturas ainda não foi mesclado de volta); toda evidência de comportamento real vem das etapas 4 (sandboxes isolados), não de observação de produção. Nota permanente: a VPS `venus@10.0.0.10` usada para validação Linux tem histórico de exigir `.env`/`WORKSPACE_DIR` explícito (skill `verify`) para não gerar falso-positivo — ver `docs/issues/002`. **Achado novo desta rodada:** o canal Web Dashboard não tem `workflowCallback` wired para aprovar ações perigosas (`ARCHITECTURE.md` já documentava isso para os 4 canais que TÊM — não havia até agora um registro explícito de que o Dashboard é o oposto); contornado na validação real de S17 chamando `GoalOrchestrator.resumeFromAuth()` diretamente via `AgentController` real, mesma classe/wiring de produção, sem passar pelo canal.
**RFCs Pendentes:** 0 — ARCH-024 (S19+S23, concluído), ARCH-015 (S20+S26, concluído), ARCH-012 (S27, concluído). **Todas as 3 RFCs do programa concluídas.**
**Temas Adiados para Revisão Consolidada:** 0 — item 1 (ARCH-009) encerrado como Won't Fix em 2026-07-18 (`docs/issues/012`); item 2 (ARCH-024) já estava concluído (S19/S23) desde antes; item 3 (`docs/issues/004`, colisão de nome `extractText`) permanece aberto mas **desvinculado** desta revisão. Ver `REVISAO_CONSOLIDADA_TIPOS_PENDENTE.md` (mantido como registro histórico da decisão, não mais como pendência ativa).
**Temas Adiados sem Consolidação (categoria própria):** 1 (ARCH-018 — `file_exists` não faz o que o card presumia, reaproveitá-lo reintroduziria o deadlock histórico, `docs/issues/010` — **dependência de ARCH-012 resolvida em S27 sem reabrir este item** (ver card `ARCH-012`))
**Encerrados sem implementar (Won't Fix):** 1 (ARCH-009/S14 — reaberto e encerrado em 2026-07-18; escopo corrigido reavaliou Impacto/Risco/Esforço para Baixo/Baixo/Pequeno, mas decisão do usuário foi não implementar por falta de motivação real, `docs/issues/012`)
**Dívida Arquitetural Restante:** 1 ARCH formalmente adiado e reabrível, 0 executáveis (ARCH-018/S18) — 26 total − 24 concluídos − 1 encerrado (Won't Fix) = 1 candidato remanescente ao próximo ciclo de auditoria.
**Achados fora de escopo documentados (`docs/issues/`):** 002 (falsos-positivos de validação VPS), 003 (`core/index.ts` barrel possivelmente morto), 004 (2 funções `extractText` com nome colidindo — candidato independente de quick win, não mais vinculado à revisão de tipos), 005 (regex de tool names desatualizada — corrigido de brinde na própria S10), 006 (análise de por que os 4 detectores de loop não convergem pra 1 fonte só — não é pendência, é registro de decisão), 008 (ARCH-009: `extends ToolResult` não compila + reintroduz violação de fronteira do ARCH-004 — motivo do adiamento original de S14, resolvido via Won't Fix), 009 (ARCH-008: "recovery no boot" citado pelo card não existe no runtime — motivo do adiamento original de S17, resolvido na reabertura via `buildInitialProgressModel`), 010 (ARCH-018: `file_exists` checa attempt não disco, reaproveitá-lo reintroduziria o deadlock histórico — motivo do adiamento de S18, ainda aberto), 011 (ARCH-013: fundir sem ajuste perde sinal `stepSuccessConfident` — motivo do adiamento ORIGINAL de S21, resolvido na reabertura via `promoteLastAttemptToSuccess`), 012 (ARCH-009: auditoria de reabertura + decisão final Won't Fix, 2026-07-18)

> Este bloco deve ser reescrito ao final de cada Sprint — não editado por trecho, substituído por inteiro — para refletir o estado real no momento.

## Dashboard Executivo — Estado Global de Validação

Snapshot do estado de validação do branch `refactor/architectural-backlog` neste momento — não de uma Sprint isolada. Se qualquer linha virar ✘, nenhuma Sprint nova deve começar até ela voltar a ✔ (a causa pode ser uma Sprint anterior que saiu do ar sem que alguém tenha notado).

| Indicador | Status | Última verificação | Evidência |
|---|---|---|---|
| Build (`npm run build`) | ✔ | 2026-07-18 (pós-S27, final) | Windows: limpo em todas as 27 Sprints. Linux real (VPS Ubuntu 24.04, validado em S08): limpo |
| tsc (`tsc --noEmit`) | ✔ | 2026-07-18 (pós-S27, final) | 0 erros em todas as 27 Sprints |
| Unit + Regression Tests (Regressão Funcional) | ✔ | 2026-07-18 (pós-S27, final) | `npm run test:regression` — **128/128** (118 na baseline T0 → 128 ao final; 10 testes novos cobrindo achados reais de 8 Sprints, 0 quebras líquidas acumuladas) |
| Integration Tests | ✔ | 2026-07-18 (pós-S27, final) | Etapa 4 (ambiente real, LLM real `glm-5.2:cloud`) executada em toda Sprint classificada `Refactor Estrutural`/`Exige RFC` (Regra #5) — S08 (VPS Linux), S16, S22-S27 (sandboxes isolados Windows), incluindo os 6 incrementos de S25 e as 2 rodadas de S23/S24 |
| Architecture Metrics (Regressão Arquitetural) | ✔ | 2026-07-18 (pós-S27, final) | **Epic A (Boundary), D (Structural Simplification) e E (Technical Cleanup) inteiramente concluídos.** Epic B (SSOT): 6/8 conceitos fragmentados resolvidos (ARCH-005/006/007/010/011/012), 2 adiados por decisão explícita (ARCH-008/009). Epic C (Decision Ownership): ARCH-014/015/016/017 concluídos, ARCH-013/018 adiados. God Methods 3→1 (exceção documentada, `runWithTools` 419 linhas). Ver revisão completa em `CHECKPOINTS/CP05.md` |

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

## Sprints e Checkpoints — detalhamento completo

Cada Sprint (S01-S27) e cada Checkpoint (CP01-CP05) tem seu próprio arquivo — Objetivo, Arquivos
afetados, Dependências, Checklists, Decisão de design/premissa reverificada, Critérios de Aceite,
Definition of Done, Commit, Status. O Painel Executivo acima já lista todas as 33 entradas em
ordem cronológica real, cada uma com um link `[ver]` para o arquivo correspondente.

- `SPRINTS/SNN-ARCH-XXX.md` — uma por Sprint, nomeada pelo card ARCH principal que ela implementa.
- `CHECKPOINTS/CPNN.md` — uma por Checkpoint (CP01-CP05).
- `METRICAS.md` — tabela comparável lado a lado de todas as Sprints (tempo gasto, indicadores
  antes/depois, riscos, lições) — visão que a narrativa por Sprint não apresenta de forma
  comparável.
- `EXECUCAO_DECISOES_DE_DESIGN.md` — catálogo das escolhas de design feitas ao longo do programa
  (o que foi decidido e por quê), compilado a partir de cada Sprint.
- `README.md` — ponto de entrada do programa: o que foi, o resultado final, guia de leitura.

---

## Regras permanentes deste programa (repetidas aqui para consulta rápida durante a execução)

1. Nunca executar dois grandes refactors simultaneamente. WIP máximo = 1.
2. Nunca adicionar funcionalidades novas durante a execução deste programa.
3. Nunca aproveitar uma Sprint para corrigir problemas fora do seu ARCH designado — *No Opportunistic Refactoring*. Dívida nova encontrada: **criar um arquivo em `docs/issues/NNN-titulo-curto.md`** (próximo número livre — ver os já existentes antes de numerar; formato do `001`: Descrição, Comportamento Esperado/Observado, Causa Raiz, Severidade), não só uma frase solta dentro do card da Sprint — a nota inline no card pode (e deve) continuar existindo como referência rápida, mas o registro completo, pesquisável e sobrevivente à reescrita do Resumo Executivo mora no arquivo de issue. Depois: propor novo ARCH se fizer sentido, continuar a Sprint atual sem desviar. **Nota:** `docs/issues/` está no `.gitignore` deste projeto (só `001` ficou versionado, de antes dessa regra) — os arquivos ficam documentados localmente; perguntar ao usuário se algum deve ser forçado (`git add -f`) para o GitHub.
4. Respeitar rigorosamente as dependências registradas no Painel Executivo — nunca alterar a ordem por conveniência.
5. Toda Sprint que envolva `Refactor Estrutural` ou `Exige RFC` precisa da etapa 4 (ambiente real) da Validação Progressiva antes de ser considerada `🟢 Concluída` — etapas 1-3 sozinhas não bastam.
6. Este documento (`MASTER_EXECUTION_PLAN.md`) é atualizado a cada Sprint encerrada — o Painel Executivo e o Resumo Executivo nunca ficam desatualizados por mais de uma Sprint.
7. Nenhuma Sprint fecha `🟢 Concluída` sem passar nos dois eixos de regressão (ver "Regressão Funcional vs. Regressão Arquitetural", no topo do documento) — comportamento externo inalterado E nenhuma violação arquitetural reintroduzida. Passar só na suíte de testes não é suficiente; passar só no grep de indicadores arquiteturais também não é. O Dashboard Executivo (logo após o Resumo Executivo) é reescrito a cada Sprint encerrada, junto com o Resumo — se alguma linha do Dashboard virar ✘, nenhuma Sprint nova começa até a causa ser encontrada e corrigida.
