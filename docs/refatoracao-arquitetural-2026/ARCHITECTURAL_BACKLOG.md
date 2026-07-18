# Backlog Arquitetural — NewClaw

**Status:** Documento oficial de planejamento. Não é uma auditoria — é a consolidação executável das quatro auditorias já concluídas.
**Baseline:** B1.0 (imutável — nenhum item deste backlog altera comportamento funcional; todos preservam o comportamento observável do sistema).
**Fontes:** Auditoria I (Duplicação de Decisões), Auditoria II (Duplicação de Conhecimento), Auditoria III (Complexidade Acidental), Auditoria IV (Violação de Fronteiras Arquiteturais) — todas conduzidas nesta mesma sessão de engenharia, sem re-análise de código neste documento.
**Escopo deste documento:** consolidar, deduplicar, agrupar em Epics, sequenciar em um DAG, planejar Sprints, definir indicadores, priorizar e validar. Nenhuma implementação, nenhuma auditoria nova, nenhuma sugestão de funcionalidade.

---

## Itens já verificados como corretos (não geram card)

Registrados aqui por rastreabilidade — as auditorias checaram estas áreas e não encontraram problema, então elas **não entram no backlog**:

- `Goal.status` — máquina de transições única (`GoalStore.ALLOWED_TRANSITIONS`), validada tanto em `update()` quanto `setStatus()`. (Auditoria II)
- Capabilities — `CapabilityRegistry` é façade única sobre `CapabilityProbe`/`EnvironmentProbe`, invalidação cascateia corretamente. (Auditoria II) — a localização física do `EnvironmentProbe.ts` continua sendo um problema de fronteira (ver ARCH-002), mas a lógica de consolidação em si está correta.
- Fronteira `src/loop/**` ↔ `*ChannelAdapter` e `src/channels/*Adapter.ts` ↔ Core (`AgentLoop`/`GoalOrchestrator`/etc.) — 0 violações confirmadas por grep. (Auditoria IV)
- `GoalOrchestrator` delegando classificação de goal para `GoalExtractor.classify()` sem reimplementar — ownership correto. (Auditoria I)
- `ERROR_PATTERNS`/`KNOWN_DEPS`/`RECOVERY` como tabelas de dados em vez de if/else — padrão correto, não é code smell. (Auditoria III)

---

# FASE 1-3 — Consolidação, Epics e Cards

## Epic A — Boundary Enforcement
*Origem: Auditoria IV.* Corrigir a direção de dependência entre `core/`, `memory/`, `loop/` e `tools/` para que infraestrutura nunca dependa de orquestração.

### ARCH-001 — Corrigir import de `ToolExecutor`/`ToolResult` para a fonte neutra ✅ Concluído (2026-07-17, Sprint S01)
- **Descrição:** 25 arquivos em `src/tools/*.ts` (incluindo `src/tools/ToolRegistry.ts`, distinto de `src/core/ToolRegistry.ts` — não contado na estimativa original de 24) + `src/core/ToolRegistry.ts` importam `ToolExecutor`/`ToolResult` de `'../loop/AgentLoop'`. `AgentLoop.ts` (L46-56) apenas reexporta esses tipos — a definição real, neutra e sem dependências de negócio já está em `loop/agentLoopTypes.ts`. Trocar o caminho do import elimina o acoplamento aparente de 26 arquivos ao maior "God Method" do projeto. **Verificado na execução:** `src/core/AgentController.ts` e `src/core/agentControllerCommands.ts` também importam de `'../loop/AgentLoop'`, mas a classe `AgentLoop` em si — dependência legítima, fora do escopo deste card.
- **Arquivos afetados:** `src/tools/*.ts` (25 arquivos), `src/core/ToolRegistry.ts`.
- **Origem (auditorias):** Auditoria IV.
- **Categoria:** Boundary Enforcement.
- **Classificação:** Quick Win.
- **Impacto:** Alto (maior fan-in invertido do projeto).
- **Risco:** Muito baixo — troca mecânica de path, `tsc --noEmit` valida.
- **Esforço:** Baixo (1 sprint parcial).
- **Dependências:** Nenhuma.
- **Pré-requisitos:** Nenhum.
- **Critérios de Aceite:** Nenhum arquivo em `tools/` ou `core/` importa de `loop/AgentLoop` para obter `ToolExecutor`/`ToolResult`; todos importam de `loop/agentLoopTypes`.
- **Definition of Done:** `grep` por `from '../loop/AgentLoop'` em `tools/`/`core/` retorna 0 ocorrências para esses dois tipos; `tsc --noEmit` limpo; suíte de regressão 100%.
- **Rollback:** Reverter os 25 imports (git revert trivial).
- **Testes obrigatórios:** Unitário (nenhum comportamento muda) + `tsc --noEmit` + suíte de regressão completa.
- **Métrica que deverá melhorar:** Violações de fronteira (Indicador #1).

### ARCH-002 — Resolver travessia de camada `core/CapabilityRegistry` ↔ `loop/EnvironmentProbe` ↔ `core/ToolRegistry` ✅ Concluído (2026-07-17, Sprint S08) — validado em Windows e Linux real (VPS)
- **Descrição:** `core/CapabilityRegistry.ts` importa `EnvironmentProbe` de `loop/`; `EnvironmentProbe.ts` importa `ToolRegistry` de volta de `core/`. Não é um ciclo de import literal, mas é uma ida-e-volta entre camadas para uma responsabilidade (detectar binários via `which`) que é conceitualmente infraestrutura, não orquestração. Mover `EnvironmentProbe.ts` para `src/core/` resolve a direção sem mudar nenhuma lógica interna do arquivo.
- **Arquivos afetados:** `src/loop/EnvironmentProbe.ts` (mover para `src/core/`), `src/core/CapabilityRegistry.ts` (ajustar import).
- **Origem (auditorias):** Auditoria IV.
- **Categoria:** Boundary Enforcement.
- **Classificação:** Refactor Local.
- **Impacto:** Médio.
- **Risco:** Médio — precisa confirmar que nenhum arquivo em `loop/` importa `EnvironmentProbe` por um path que quebraria com a mudança.
- **Esforço:** Baixo.
- **Dependências:** Nenhuma obrigatória; recomenda-se sequenciar após ARCH-001 (mesma área temática, mesmo revisor).
- **Pré-requisitos:** Levantar todos os call sites de `EnvironmentProbe` antes de mover (mapear entorno, per `feedback_correcoes_pontuais`).
- **Critérios de Aceite:** `core/CapabilityRegistry.ts` nunca importa de `loop/`; `EnvironmentProbe` vive em `core/`.
- **Definition of Done:** Build limpo, suíte de regressão 100%, `EnvironmentProbe.probe()` continua funcional em ambiente real (Windows + Linux, per Validação Progressiva etapa 4).
- **Rollback:** Reverter o `git mv` + ajuste de import.
- **Testes obrigatórios:** Unitário + regressão + validação em ambiente real (o probe já teve bugs reais de plataforma antes).
- **Métrica que deverá melhorar:** Violações de fronteira, Dependências invertidas.

### ARCH-003 — Extrair `StrategyDiversityGuard.fingerprint()`/`ResponseAdapter.extractText()` para local neutro ✅ Concluído (2026-07-17, Sprint S09)
- **Descrição:** `memory/CaseMemory.ts` importa a classe `StrategyDiversityGuard` (runtime, não só tipo) de `loop/`; `memory/conversational/CMIIngestionPipeline.ts` importa a função `extractText` de `loop/ResponseAdapter.ts`. Ambas são utilitários pequenos e sem estado que não dependem de `AgentLoop`/`GoalExecutionLoop` — podem migrar para `src/shared/` sem quebrar quem já as usa em `loop/`. **Executado como:** `StrategyDiversityGuard.ts` movido inteiro (já era autocontido); `extractText` extraído de `loop/ResponseBuilder.ts` (não de `ResponseAdapter.ts`, que é só um shim depreciado reexportando de lá) para `shared/extractText.ts`, mantendo o resto de `ResponseBuilder.ts` (com dependências reais de `loop/`) intacto. Achado colateral fora de escopo: existem 2 funções `extractText` com o mesmo nome e assinaturas diferentes no código — `docs/issues/004-duplicate-extracttext-functions.md`.
- **Arquivos afetados:** `src/loop/StrategyDiversityGuard.ts`, `src/loop/ResponseAdapter.ts`, `src/memory/CaseMemory.ts`, `src/memory/conversational/CMIIngestionPipeline.ts`.
- **Origem (auditorias):** Auditoria IV.
- **Categoria:** Boundary Enforcement.
- **Classificação:** Refactor Local.
- **Impacto:** Médio.
- **Risco:** Médio (mudar localização de uma classe usada por múltiplos consumidores).
- **Esforço:** Baixo-Médio.
- **Dependências:** Nenhuma obrigatória. Interage com ARCH-011 (mesma classe) — recomenda-se fazer ARCH-003 antes de ARCH-011 para não mover E mudar lógica interna no mesmo commit.
- **Pré-requisitos:** Mapear todos os consumidores de `StrategyDiversityGuard`/`extractText`.
- **Critérios de Aceite:** `memory/` não importa nenhuma classe/função de runtime de `loop/`, só tipos (se necessário).
- **Definition of Done:** Build limpo, suíte 100%, nenhum consumidor quebrado.
- **Rollback:** Reverter `git mv` + imports.
- **Testes obrigatórios:** Unitário + regressão.
- **Métrica que deverá melhorar:** Violações de fronteira, Dependências invertidas.

### ARCH-004 — Migrar imports de tipo (`GoalTypes`, `IntentCategory`) usados por `memory/` para local neutro ✅ Concluído (2026-07-17, Sprint S02)
- **Descrição:** `memory/CaseMemory.ts` e `memory/ReflectionMemory.ts` importam `type {Goal, PlanStep, AttemptOutcome, BlockerKind}` de `loop/GoalTypes.ts` e `type {IntentCategory}` de `loop/UnifiedIntentRouter.ts`. Como são `import type`, o custo em runtime é zero — mas a direção continua invertida. Prioridade mais baixa que os demais itens do Epic A. **Executado como:** `src/shared/domainTypes.ts` novo, contendo `Goal`/`PlanStep`/`GoalAttempt`/`GoalBlocker`/`SuccessCriterion`/`ToolMutation`/`GoalStatus`/`BlockerKind`/`CriterionCheck`/`AttemptOutcome`/`IntentCategory` (o fechamento transitivo real de `Goal`, maior que os 2-4 tipos citados originalmente — `Goal` referencia todos os outros). `loop/GoalTypes.ts` e `loop/UnifiedIntentRouter.ts` reexportam de lá, zero ripple nos consumidores existentes em `loop/`.
- **Arquivos afetados:** `src/loop/GoalTypes.ts`, `src/loop/UnifiedIntentRouter.ts`, `src/memory/CaseMemory.ts`, `src/memory/ReflectionMemory.ts`.
- **Origem (auditorias):** Auditoria IV.
- **Categoria:** Boundary Enforcement.
- **Classificação:** Quick Win.
- **Impacto:** Baixo.
- **Risco:** Baixo.
- **Esforço:** Baixo.
- **Dependências:** Nenhuma.
- **Pré-requisitos:** Nenhum.
- **Critérios de Aceite:** Tipos compartilhados entre `loop/` e `memory/` residem em um local que nenhuma das duas camadas "possui" sozinha (ex: `shared/domainTypes.ts`).
- **Definition of Done:** `tsc --noEmit` limpo.
- **Rollback:** Trivial.
- **Testes obrigatórios:** `tsc --noEmit` (é só tipo, sem teste de runtime necessário).
- **Métrica que deverá melhorar:** Violações de fronteira (parcial — tipo-only já é baixo risco).

---

## Epic B — Single Source of Truth
*Origem: Auditoria II, mais a dimensão de conhecimento dos hotspots de Auditoria I/III que compartilham o mesmo código.*

### ARCH-005 — Fonte única de artefatos entregues ✅ Concluído (2026-07-18, Sprint S16) — executado como fix cirúrgico de normalização de path, não consolidação
- **Descrição:** O fato "o que já foi entregue ao usuário" existe em 4 estruturas sem sincronização automática: `Goal.sentArtifacts` (persistido), `cycleHistory` do `AgentLoop` (efêmero por sub-turno), a varredura de filesystem em `deliverable_check` (`GoalExecutionLoop.ts`), e o `structuralBypass` (stat direto de um path). Consolidar para que `Goal.sentArtifacts` seja o único registro, com os outros três lendo/escrevendo nele em vez de recalcular a resposta.
- **Executado como:** a premissa não se sustentou na reverificação (Fase 1/2) — as "4 estruturas" já NÃO são independentes: `cycleHistory` (AgentLoop) já notifica `Goal.sentArtifacts` via `onArtifactDelivered`; `deliverable_check` já consulta `sentArtifacts.has()`; `checkClaimsAgainstEvidence` já cai para `sentArtifacts` como evidência secundária; `structuralBypass` responde uma pergunta DIFERENTE por natureza ("arquivo já existe em disco, posso pular validação por LLM"), não "foi entregue" — juntá-lo à função proposta seria erro de categoria. Além disso, o escopo do card estava incompleto: `src/loop/planning/artifactContract.ts` (`resolveArtifactPathFromEvidence`) também lê `sentArtifacts` e não constava nos "Arquivos afetados". Os 2 bugs reais de produção citados como motivação já tinham sido corrigidos em Sprints anteriores a este programa (`structuralBypass` para o deadlock de "reenviar arquivo existente"; checagem de extensão em `checkClaimsAgainstEvidence` para o artefato errado aceito como prova — ambos documentados em `project_session_bugs_jul2026_ap`/`_ak` na memória). Consolidar 4 mecanismos já majoritariamente sincronizados, para prevenir uma 3ª ocorrência hipotética de um bug já resolvido 2x, tinha valor questionável frente ao risco de um Refactor Estrutural Alto-risco. **Achado novo, não documentado antes:** `sentArtifacts` guarda o path CRU (`toolArgs.file_path`, como o LLM passou — pode ser relativo, ex. `"aula.pptx"`); `checkDeliverables()` (usado por `deliverable_check`) retorna paths ABSOLUTOS (`path.join(workspaceDir, ...)`). `deliverable_check` comparava os dois direto via `.has()` sem normalizar — um arquivo já entregue (via path relativo) podia ser tratado como "não entregue" quando `checkDeliverables()` o encontrava pelo path absoluto, gerando um `send_document` duplicado. **Fix implementado** (escolha do usuário entre 3 alternativas, dado o achado): normaliza ambos os lados via `resolvePath()` (já usada por write/read/exec_command) antes de comparar — `sentArtifactsResolved`/`pendingSendPaths` resolvidos, em vez de consolidar os 4 mecanismos numa função nova. Escopo único: `GoalExecutionLoop.ts`, bloco "Item 2: Deliverable Check".
- **Arquivos afetados:** `src/loop/AgentLoop.ts` (L2555-2684, DELIVERY-GUARD), `src/loop/GoalExecutionLoop.ts` (L619-669 `structuralBypass`, L869-924 `deliverable_check`, L3286-3387 `checkClaimsAgainstEvidence`).
- **Origem (auditorias):** Auditoria I (Complexity Hotspot #2.1 — maior hotspot de decisão), Auditoria II (Knowledge Ownership Map — "Artefatos entregues"), Auditoria III (o código destes 4 mecanismos vive dentro dos God Methods `runWithTools`/`runLoopInternal`).
- **Categoria:** Single Source of Truth.
- **Classificação:** Refactor Estrutural.
- **Impacto:** Muito Alto — maior hotspot identificado em 3 das 4 auditorias.
- **Risco:** Alto — 3 arquivos, histórico de 2 bugs reais de produção na mesma área (entrega via `agentloop` invisível a camadas downstream).
- **Esforço:** Alto.
- **Dependências:** Nenhuma (é a base para vários outros itens).
- **Pré-requisitos:** Mapear TODOS os call sites que leem/escrevem estado de entrega antes de tocar (per `feedback_correcoes_pontuais` — mapear o entorno inteiro).
- **Critérios de Aceite:** Existe uma única função (ex.: `getEffectiveDeliveredArtifacts(goal)`) consultada por `deliverable_check`, `structuralBypass`, `checkClaimsAgainstEvidence` e pelo callback do `DELIVERY-GUARD` do `AgentLoop`.
- **Definition of Done:** Validação Progressiva completa (unitário → regressão → e2e sintético → **ambiente real**, per `DIRETRIZ_ARQUITETURA_2026-07-13.md`) — este item, dado seu histórico de bugs reais, não pode ser considerado concluído sem a etapa 4.
- **Rollback:** Reverter o commit; manter os 4 mecanismos antigos coexistindo é o estado atual (não piora nada se revertido).
- **Testes obrigatórios:** Unitário + regressão + e2e sintético (LLM mockado) + execução real (LLM real, goal real que entrega + reenvia artefato).
- **Métrica que deverá melhorar:** Single Sources (Indicador #4), Decision Owners (Indicador #5).

### ARCH-006 — Accessor único `getPendingSteps(goal, toolName?)` ✅ Concluído (2026-07-17, Sprint S03)
- **Descrição:** `.filter(s => s.status === 'pending')` é recalculado inline em 6+ pontos de `GoalExecutionLoop.ts`. Substituir por um accessor único. **Executado como:** `getPendingSteps(plan: PlanStep[], toolName?: string | string[])` — 15 call sites reais migrados (não 6; varredura completa achou mais), 2 ocorrências semelhantes excluídas por serem outra coisa (status de `SuccessCriterion`; filtro de mutação "remover steps supersedidos").
- **Arquivos afetados:** `src/loop/GoalExecutionLoop.ts` (15 call sites — ver nota acima).
- **Origem (auditorias):** Auditoria II.
- **Categoria:** Single Source of Truth.
- **Classificação:** Quick Win.
- **Impacto:** Baixo-Médio.
- **Risco:** Baixo.
- **Esforço:** Baixo.
- **Dependências:** Nenhuma. Recomendado antes de ARCH-020 (facilita a decomposição de `runLoopInternal`).
- **Pré-requisitos:** Nenhum.
- **Critérios de Aceite:** Os 6+ call sites usam o mesmo accessor.
- **Definition of Done:** Regressão 100%, nenhuma mudança de comportamento observável.
- **Rollback:** Trivial.
- **Testes obrigatórios:** Unitário + regressão.
- **Métrica que deverá melhorar:** Recomputation Hotspots (indicador qualitativo, ver Fase 7).

### ARCH-007 — Sincronizar `PlanStep.status`/`.result` com `GoalAttempt.result` ✅ Concluído (2026-07-17, Sprint S13)
- **Descrição:** Um `PlanStep` pode ficar `status: 'completed'` enquanto o `GoalAttempt` correspondente foi rebaixado para `'partial'` — a ordem real de execução em `GoalExecutionLoop.ts` (downgrade semântico roda antes do `markStepDone('skip')`) confirma o caso. Dois vocabulários (`status` sem `'partial'`; `result` sem `'pending'`/`'skipped'`) sem tradução formal entre eles.
- **Executado como:** premissa confirmada, mas a rota causal exata era outra — o caminho de downgrade semântico (`shouldDowngradeToPartial`) NUNCA chega a chamar `markStepDone('skip')` no mesmo ciclo (o `cycleResult.outcome` já virou `'partial'`/`'blocked'` antes do `switch`, e nenhum desses `case`s chama `markStepDone`). O gatilho real, reproduzido e coberto por teste (S119), é o outro caminho que a Sprint 0.8 já deixava documentado: heurística de sucesso de BAIXA confiança (`stepSuccessConfident=false`, ex. fallback `substantial_response`) grava `GoalAttempt.result: 'partial'` mas `toolResult.success=true` ainda leva `cycleResult.outcome` a `'success'` — cai em `case 'success'` → `markStepDone(..., 'skip')`. Entre as duas opções do card ("`status` ganha `'partial'`" vs. "`result` vira referência ao attempt"), optei pela segunda, mas sem tocar `PlanStep.result` (string de output, campo com significado diferente do `GoalAttempt.result`): adicionado `PlanStep.lastAttemptOutcome?: AttemptOutcome`, populado em `markStepDone()` com o `reflectionOutcome` já calculado corretamente (só usado antes para `ReflectionMemory`). `status` continua significando só "progressão do plano" (não será redespachado) — não ganhou `'partial'`, e o comportamento de retry não mudou (mudar isso seria uma decisão de produto distinta, fora do escopo/risco que o card descrevia). Não tocou nenhum dos ~15 call sites que filtram `status === 'completed'` (risco zero de regressão ali). Campo opcional, serializado via JSON existente em `GoalStore` — sem migração de schema.
- **Arquivos afetados:** `src/loop/GoalExecutionLoop.ts` (L2194-2265 `markStepDone`, L1137-1202), `src/loop/GoalTypes.ts` (`PlanStep`, `GoalAttempt`).
- **Origem (auditorias):** Auditoria II.
- **Categoria:** Single Source of Truth.
- **Classificação:** Refactor Local.
- **Impacto:** Médio.
- **Risco:** Médio (toca a máquina de estados de step, usada por vários consumidores).
- **Esforço:** Médio.
- **Dependências:** Nenhuma obrigatória; sequenciar antes de ARCH-020.
- **Pré-requisitos:** Decidir se `PlanStep.status` ganha o valor `'partial'` ou se `PlanStep.result` passa a ser só uma referência ao `GoalAttempt` mais recente (não duas cópias).
- **Critérios de Aceite:** Nenhum `PlanStep` pode estar `completed` enquanto seu `GoalAttempt` mais recente é `partial`/`failure` sem que isso seja uma decisão explícita, não acidental.
- **Definition of Done:** Regressão 100% + teste novo cobrindo o cenário de divergência encontrado.
- **Rollback:** Reverter.
- **Testes obrigatórios:** Unitário (cenário de downgrade semântico seguido de `markStepDone`) + regressão.
- **Métrica que deverá melhorar:** Source of Truth Conflicts (indicador qualitativo).

### ARCH-008 — `progressModel` derivado sob demanda de `goal.attempts`/`successCriteria` ⏸ Adiado (2026-07-18, Sprint S17) — premissa citava mecanismo inexistente
- **Descrição:** `state.cognitiveContext` já recebeu o tratamento de "derivar de `goal.attempts` a cada chamada" via `buildIncrementalExecutionContext()` — restart-safe. `state.progressModel` não recebeu o mesmo tratamento: reseta para `{components:[], overallPercent:0}` a cada `runLoop()`, incluindo após recovery pós-restart, mesmo quando `goal.attempts`/`successCriteria` já provam progresso real.
- **Adiado na S17, antes de codificar (Fase 1 da diretriz de arquitetura):** a premissa citava um mecanismo que não existe — não há recovery automático de goals no boot (`AgentController.getAllActive()` só loga, `recovered=false` explícito no próprio log; nunca chama `resumeGoal()`/`runLoop()`). O defeito subjacente (progressModel perdido) é real, mas o gatilho é outro: o único call site de `resumeGoal()` é `GoalOrchestrator.resumeFromAuth()` (fluxo de aprovação de ação perigosa), que reseta `progressModel` no MESMO processo, sem restart, sempre que um goal com histórico bate numa autorização. Registro técnico completo, incluindo o fix desenhado (`buildInitialProgressModel`, não implementado): `docs/issues/009-arch008-no-automatic-boot-recovery-exists.md`. 6º modo de falha catalogado em `RETROSPECTIVA_PREMISSAS_AUDITORIA.md`. Por decisão do usuário, adiado sem consolidação com outro tema (categoria distinta de ARCH-009/ARCH-024) — retomar lendo o achado antes de re-propor o card original.
- **Arquivos afetados:** `src/loop/GoalExecutionLoop.ts` (L548-561 criação do `state`, L2566-2601 `updateProgressModel`).
- **Origem (auditorias):** Auditoria II.
- **Categoria:** Single Source of Truth.
- **Classificação:** Refactor Local.
- **Impacto:** Alto (corrige perda de progresso pós-restart, um cenário real dado que o sistema já tem recovery de goals ativos no boot).
- **Risco:** Médio — é o caminho de validação de conclusão, sensível.
- **Esforço:** Médio.
- **Dependências:** Recomendado após ARCH-005 (mesmo padrão de "derivar da fonte persistida").
- **Pré-requisitos:** Nenhum.
- **Critérios de Aceite:** Um goal recuperado após restart mostra `progressModel` consistente com `goal.attempts`/`successCriteria`, não 0%.
- **Definition of Done:** Validação Progressiva completa até etapa 4 (cenário de restart precisa ser testado em ambiente real, não só mockado).
- **Rollback:** Reverter.
- **Testes obrigatórios:** Unitário + regressão + e2e sintético + ambiente real (matar o processo com um goal em `executing` e validar recovery).
- **Métrica que deverá melhorar:** Single Sources.

### ARCH-009 — `CycleResult`/`GoalAttempt` estenderem `ToolResult` em vez de redeclarar `output`/`error` ⏸ Adiado (2026-07-17, Sprint S14) — consolidar em revisão de tipos futura
- **Descrição:** `ToolResult` → `CycleResult` → `GoalAttempt` redeclaram os mesmos 2 campos (`output`, `error`) 3 vezes de forma independente. Qualquer campo novo de proveniência de tool exige decidir, cada vez, em qual das 3 camadas ele deveria viver.
- **Adiado na S14, antes de qualquer código (Fase 1/2 da diretriz de arquitetura):** a premissa não se sustentou como descrita — `CycleResult` não tem campo `error` próprio (só `blocker.description`), e a prescrição literal (`extends ToolResult`) não compila: `ToolResult.output` é obrigatório, `CycleResult.output`/`GoalAttempt.output` são legitimamente opcionais, e TS não permite herdar um campo obrigatório como opcional. Mais grave: `GoalAttempt` mora em `shared/domainTypes.ts` desde o ARCH-004 (S02) — fazer `GoalAttempt extends ToolResult` (que mora em `loop/agentLoopTypes.ts`) reintroduziria a violação de fronteira `shared/→loop/` que aquele ARCH corrigiu. Registro técnico completo: `docs/issues/008-arch009-extends-toolresult-breaks-typing-and-boundary.md`. Por decisão do usuário, o tema foi consolidado (não resolvido pontualmente) com outros achados de modelagem de tipo compartilhado entre camadas — ver `docs/refatoracao-arquitetural-2026/REVISAO_CONSOLIDADA_TIPOS_PENDENTE.md`, que já registra a direção provável (tipo-base mínimo em `shared/domainTypes.ts`, estendido de `loop/` na direção correta) para quando a revisão consolidada for aberta.
- **Arquivos afetados:** `src/loop/agentLoopTypes.ts` (`ToolResult`), `src/loop/GoalTypes.ts` (`CycleResult`, `GoalAttempt`).
- **Origem (auditorias):** Auditoria II.
- **Categoria:** Single Source of Truth.
- **Classificação:** Refactor Local.
- **Impacto:** Médio (reduz superfície de manutenção futura, não corrige bug hoje).
- **Risco:** Médio — mudança de tipos com superfície ampla (todo consumidor de `CycleResult`/`GoalAttempt`).
- **Esforço:** Médio.
- **Dependências:** Recomendado antes de ARCH-013, ARCH-019, ARCH-020, ARCH-022 (todos constroem/consomem esses tipos — fazer isso cedo reduz churn nos refactors maiores). **Com o adiamento (S14): a recomendação era de sequenciamento (reduzir churn), não bloqueio funcional — S21/S22/S24 podem prosseguir usando a forma atual, não consolidada, dos 3 tipos.**
- **Pré-requisitos:** Nenhum.
- **Critérios de Aceite:** `output`/`error` são declarados uma única vez; `CycleResult`/`GoalAttempt` estendem/referenciam `ToolResult`.
- **Definition of Done:** `tsc --noEmit` limpo, regressão 100%.
- **Rollback:** Reverter.
- **Testes obrigatórios:** `tsc --noEmit` + regressão completa.
- **Métrica que deverá melhorar:** Single Sources.

### ARCH-010 — Índice incremental de retry por (step, args-hash) ✅ Concluído (2026-07-17, Sprint S15) — executado como método nomeado, não índice persistido
- **Descrição:** `GoalEvaluator.alreadyFailed` faz um scan O(n) de todo `goal.attempts` com `JSON.stringify` a cada falha, sem contador/índice incremental.
- **Executado como:** premissa parcialmente corrigida — `alreadyFailed` não era um método, era uma `const` local computada inline via `.some()` (short-circuit, não um scan sempre completo); e a pergunta real que o código responde é booleana ("esta chamada exata já falhou?"), não uma contagem ("quantas vezes?") como o Critério de Aceite original sugeria — nenhum consumidor precisa do número. Um índice real (persistido ou cacheado entre ciclos) foi descartado na Fase 2/3: `Goal` é recarregado via `GoalStore.getById()` a cada ciclo em `GoalExecutionLoop.runLoopInternal` (confirmado, dezenas de call sites) — não existe um objeto `Goal` estável em memória entre ciclos ao qual um cache pudesse se anexar por referência; um índice persistido exigiria campo novo no schema E lógica de sincronização incremental toda vez que `GoalStore.addAttempt()` roda, introduzindo uma SEGUNDA fonte de verdade para o mesmo dado que já existe em `goal.attempts` — o oposto do que o próprio Epic B (Single Source of Truth) pede, e com o mesmo risco de restart-safety ainda não resolvido pelo ARCH-008 (item irmão deste Epic). Implementado em vez disso: `hasIdenticalFailedAttempt(goal, planStep, toolName)`, método nomeado privado em `GoalEvaluator`, chamado por consulta (satisfaz o texto literal do Critério de Aceite: "respondida por consulta, não recomputação"), usando `computeToolInputKey()` (`loop/planning/computeToolInputKey.ts`, já existente e testado — S90) para a chave de args em vez de `JSON.stringify` bruto. Efeito direto (não oportunista — é a definição de "computar o args-hash corretamente"): `send_document` agora dedupla corretamente por `file_path` mesmo com legenda cosmeticamente diferente entre tentativas — mesma classe de bug que `computeToolInputKey` já tinha corrigido na camada de `AgentLoop` (S90), agora consistente também na camada de `GoalEvaluator`. Teste novo `S120` (5 assertions, 4 cenários: dedup por args idênticos, sem dedup por args diferentes, dedup de `send_document` por `file_path` com legenda variando, sem dedup quando `file_path` genuinamente difere). Risco real ficou MENOR que o estimado pelo card (nenhuma mudança de schema/estrutura de `Goal`).
- **Arquivos afetados:** `src/loop/GoalEvaluator.ts` (L227-255).
- **Origem (auditorias):** Auditoria II.
- **Categoria:** Single Source of Truth.
- **Classificação:** Refactor Local.
- **Impacto:** Baixo-Médio (ganho de performance marginal hoje, dado volume baixo de attempts por goal; ganho real é clareza).
- **Risco:** Médio — muda a estrutura de `Goal` ou exige campo novo persistido.
- **Esforço:** Médio.
- **Dependências:** Nenhuma.
- **Pré-requisitos:** Nenhum.
- **Critérios de Aceite:** A pergunta "quantas vezes esta chamada exata já falhou" é respondida por consulta, não recomputação.
- **Definition de Done:** Regressão 100%.
- **Rollback:** Reverter.
- **Testes obrigatórios:** Unitário + regressão.
- **Métrica que deverá melhorar:** Recomputation Hotspots.

### ARCH-011 — `StrategyDiversityGuard.extractUsedFingerprints` ler `goal.toolsTried` em vez de regex sobre `strategiesTried` ✅ Concluído (2026-07-17, Sprint S10)
- **Descrição:** O achado mais nítido de recomputação da Auditoria II: `goal.toolsTried` já guarda a sequência de tools de forma estruturada, mas `extractUsedFingerprints()` reconstrói a mesma informação via regex sobre o texto livre de `strategiesTried`. **Correção na execução:** a premissa "já guarda a sequência" não se sustentou totalmente — `toolsTried` é deduplicado, sem fronteira por tentativa, e nunca contém `'agentloop'`. Implementado como fonte primária ADITIVA (soma ao Set de fingerprints), com o regex sobrevivendo só como fallback para detectar `'agentloop'` — não mais para reconhecer nomes de tool (eliminando, como efeito colateral, uma lista hardcoded que cobria só 11 de 25 tools reais, `docs/issues/005`).
- **Arquivos afetados:** `src/loop/StrategyDiversityGuard.ts` (L59-67).
- **Origem (auditorias):** Auditoria II.
- **Categoria:** Single Source of Truth.
- **Classificação:** Quick Win (uma vez que ARCH-003 já tenha movido a classe, se aplicável).
- **Impacto:** Alto (é o exemplo mais claro de dado já estruturado sendo reconstruído por parsing).
- **Risco:** Médio — muda o que conta como "fingerprint repetido", pode alterar comportamento de replan em casos de borda.
- **Esforço:** Baixo-Médio.
- **Dependências:** Sequenciar após ARCH-003 (mesma classe, evitar mover + mudar lógica no mesmo commit).
- **Pré-requisitos:** Confirmar que `goal.toolsTried` cobre todos os casos que a regex cobria (fallback para regex só quando não há tool estruturada, ex. steps `agentloop`).
- **Critérios de Aceite:** Fingerprint de estratégia é derivado de `toolsTried` como fonte primária.
- **Definition of Done:** Regressão 100% + teste cobrindo o caso de fallback (step sem toolName).
- **Rollback:** Reverter.
- **Testes obrigatórios:** Unitário + regressão.
- **Métrica que deverá melhorar:** Recomputation Hotspots, Single Sources.

### ARCH-012 — RFC: Unificar `Goal.successCriteria` e `checkClaimsAgainstEvidence.CLAIM_RULES` ✅ Concluído (2026-07-18, Sprint S27 — RFC + implementação de escopo reformulado)
- **Descrição:** Duas formas paralelas de responder "existe prova de que X foi cumprido": uma estruturada e decidida no plano inicial (`successCriteria`), outra inferida por regex sobre a prosa de outro LLM (o validador) depois do fato (`CLAIM_RULES`). Fontes diferentes, momentos diferentes, nenhuma referencia a outra.
- **RFC (S27) — o problema real era outro:** a investigação encontrou 3 mecanismos, não 2 (`structuralBypass`, dentro de `runValidationPhase`, também decide "entrega comprovada" e o card nem o menciona — é o mecanismo que motivou `ARCH-018`, adiada). Da premissa "duas formas paralelas... nenhuma referencia a outra": só se sustenta para 1 das 5 `CLAIM_RULES` (a de entrega, que tem contraparte em `ensureDeliverySuccessCriteria`) — as outras 4 (apresentação/exportação/organização/criação) não têm nada a unificar, são a única defesa contra alucinação para categorias que `successCriteria` nunca cobre. Para o 1 caso real de sobreposição, o achado que importa não é "estarem duplicados", é que **divergem em rigor**: só `checkClaimsAgainstEvidence` (pós-LLM) verificava se o arquivo enviado batia com o tipo esperado pelo pedido (proteção de 09/07, fechando o bug de um `.py` aceito no lugar de um `.pptx`) — `evaluateCriteria` (checklist pré-LLM) e `structuralBypass` (bypass de disco, também pré-LLM) não tinham essa checagem, e ambos rodam ANTES, escondendo o problema que a proteção lenta nunca chega a ver. RFC completa: `docs/refatoracao-arquitetural-2026/RFC_ARCH-012_UnifiedDeliveryProof.md`. **Decisão aprovada:** unificação completa de TIPO foi rejeitada (alto risco — reintroduziria a fragilidade de 04/07 que motivou separar os 2 estágios de pipeline; scope creep sem evidência para as 4 regras sem contraparte) — implementado escopo reduzido (Alternativa D): extrair o predicado já existente (`isExpectedDeliverableFile`, `planning/inferExpectedExtensions.ts`) e reusá-lo nos 3 pontos, sem unificar tipo/dado. Não depende de `ARCH-018` (que resolveria uma questão de modelagem de dados diferente da que este fix resolve) — `ARCH-018` permanece adiada.
- **Executado como (S27):** `isExpectedDeliverableFile(userIntent, filePath): boolean` nova em `planning/inferExpectedExtensions.ts`, extraída do `matchesExpectedType` antes inline em `checkClaimsAgainstEvidence`. Reusada em 3 pontos: (1) `checkClaimsAgainstEvidence` (comportamento idêntico, só a origem do código muda), (2) `evaluateCriteria()`'s `case 'tool_succeeded'` quando `criterion.tool === 'send_document'` (antes: `relevant.length > 0` bastava, sem checar tipo), (3) `structuralBypass` (`runValidationPhase`, antes só checava tamanho de arquivo via `MIN_DELIVERABLE_SIZE`).
- **Validação Progressiva (S27):** tsc+build limpos, regressão 128/128 (127 existentes + `S125_ARCH012_DeliveryTypeMatchAcrossPaths.test.ts` novo, 8/8 asserts — unidade do predicado + `evaluateCriteria` com tipo certo/errado + `structuralBypass` end-to-end via `runLoopInternal()` real com tipo certo/errado). Etapa 4 em sandbox isolado (`D:/IA/newclaw-verify-s27`, LLM real `glm-5.2:cloud`): goal real pedindo reenvio de uma "apresentação de slides" com só um `.py` no workspace — LLM real planejou `send_document` do `.py`, mas nem `structuralBypass` nem `evaluateCriteria` aceitaram (`auto_delivery_send_document` ficou `pending`, não `met`), goal caiu no replan normal em vez de completar prematuramente com o arquivo errado — LLM real se autocorrigiu tentando executar o script pra gerar o artefato de verdade. Commit: `0ca79ed`.
- **Arquivos afetados:** `src/loop/GoalTypes.ts` (`SuccessCriterion`), `src/loop/GoalExecutionLoop.ts` (L3240-3387 `checkClaimsAgainstEvidence`, L2945-3228 `validateGoalCompletion`).
- **Origem (auditorias):** Auditoria II.
- **Categoria:** Single Source of Truth.
- **Classificação:** Exige RFC.
- **Impacto:** Alto.
- **Risco:** Alto — dois momentos/LLMs diferentes hoje; fundir exige repensar QUANDO a evidência é coletada, não é uma refatoração mecânica.
- **Esforço:** Alto.
- **Dependências:** ARCH-005 (fonte única de entrega, concluído — S16). ~~ARCH-018 (evaluateCriteria absorvendo structuralBypass) precisa estar concluído antes~~ — **dependência resolvida na Fase 1 da RFC de S27, não por retomar ARCH-018**: a dependência real era só para a unificação de TIPO/DADO (que a RFC rejeitou por risco, Fase 2/4) — o escopo efetivamente implementado (extrair e reusar um predicado puro nos 3 mecanismos) não exige que `structuralBypass` compartilhe modelo de dados com `SuccessCriterion`, então não herda esse bloqueio. `ARCH-018` **permanece adiada**, sem re-abertura necessária para este resultado.
- **Pré-requisitos:** Documento de Fase 1-5 completo (`DIRETRIZ_ARQUITETURA_2026-07-13.md`) antes de qualquer código.
- **Critérios de Aceite:** Definidos na própria RFC (Fase 4/5 da diretriz).
- **Definition of Done:** RFC aprovada com riscos documentados E, se aprovada para implementação, Validação Progressiva completa até etapa 4.
- **Rollback:** Se a RFC concluir que o risco supera o benefício, o item é encerrado sem código — resultado válido.
- **Testes obrigatórios:** N/A na fase de RFC; se implementado, unitário + regressão + e2e + ambiente real.
- **Métrica que deverá melhorar:** Single Sources, Decision Owners.

---

## Epic C — Decision Ownership
*Origem: Auditoria I.*

### ARCH-013 — Unificar juiz de sucesso de step ⏸ Adiado (2026-07-18, Sprint S21) — desenho viável, consequência não anunciada pelo card
- **Descrição:** `evaluateAgentStepSuccess`+`escalateStepEvalToLLM` (heurística própria + LLM própria, "SUCESSO ou FALHA", 15s) e `StepSemanticValidator` (keyword+LLM, "ENDEREÇA a intenção", 8s) rodam em sequência para o mesmo step `agentloop`. Fundir a escalação de `evaluateAgentStepSuccess` dentro de `StepSemanticValidator`, mantendo só a extração determinística (sem LLM) fora dele.
- **Adiado na S21, antes de codificar (Fase 1/2 da diretriz de arquitetura):** diferente dos achados anteriores deste programa, aqui o DIAGNÓSTICO do card está correto (os dois mecanismos de fato rodam em sequência desnecessária pro mesmo step em casos reais, confirmado lendo a sequência de chamadas) e a PRESCRIÇÃO é tecnicamente viável — compila e roda sem erro. O que falta: quando `escalateStepEvalToLLM` confirma sucesso com confiança, marca `stepSuccessConfident=true`, que decide se `GoalAttempt.result` vira `'success'` ou `'partial'`. `StepSemanticValidator` só tem hoje um sinal NEGATIVO (`shouldDowngradeToPartial`) — remover a chamada da zona ambígua sem dar a ele um sinal de PROMOÇÃo equivalente faria todo step ambíguo virar `'partial'` sempre, mudando comportamento observável de conclusão de goal de forma silenciosa (não anunciada pelo card). Registro técnico completo, incluindo o fix desenhado (StepSemanticValidator ganha sinal de promoção, não só rebaixamento): `docs/issues/011-arch013-merge-loses-confident-success-signal.md`. 7º modo de falha catalogado em `RETROSPECTIVA_PREMISSAS_AUDITORIA.md` — categoria nova, distinta dos 6 anteriores (aqui a premissa está certa, falta rastrear a consequência completa). Por decisão do usuário, adiado sem consolidação com outro tema.
- **Arquivos afetados:** `src/loop/GoalExecutionLoop.ts` (L2039-2118), `src/loop/StepSemanticValidator.ts`.
- **Origem (auditorias):** Auditoria I (Complexity Hotspot #2.2), Auditoria III (ambos vivem dentro de `executeStep()`, um dos métodos mais longos do projeto).
- **Categoria:** Decision Ownership.
- **Classificação:** Refactor Estrutural.
- **Impacto:** Alto.
- **Risco:** Médio — muda latência/custo de LLM por step (de potencialmente 2 chamadas para 1).
- **Esforço:** Médio-Alto.
- **Dependências:** ARCH-009 (tipos consolidados primeiro). Bloqueia ARCH-022 (fazer antes de decompor `executeStep` reduz a lógica a ser carveada).
- **Pré-requisitos:** Nenhum.
- **Critérios de Aceite:** Existe um único ponto de decisão heurística+LLM para "este step teve sucesso relevante".
- **Definition of Done:** Validação Progressiva completa até etapa 4 (latência real de LLM precisa ser observada, não só mockada).
- **Rollback:** Reverter.
- **Testes obrigatórios:** Unitário + regressão + e2e sintético + ambiente real (LLM real).
- **Métrica que deverá melhorar:** Decision Owners.

### ARCH-014 — Unificar regex de erro transiente entre `GoalEvaluator` e `ProactiveRecovery` ✅ Concluído (2026-07-17, Sprint S04)
- **Descrição:** `GoalEvaluator.ERROR_PATTERNS[].isRetryable` (nível goal) e `ProactiveRecovery.RECOVERY[tool].retryablePatterns` (nível tool) têm regex parcialmente sobrepostas (`ECONNRESET`/`ETIMEDOUT`/`timeout`) mantidas independentemente. **Executado como:** `src/shared/transientErrorPatterns.ts` novo com 6 padrões nomeados (a sobreposição real, maior que os 3 citados — inclui também `network` e `rate.?limit`/`429`), cada consumidor compondo sua própria lista/regex a partir deles; nenhuma lista universal (rejeitada deliberadamente — mudaria comportamento de retry por tool). Verificado byte-a-byte que a composição preserva 100% o comportamento anterior.
- **Arquivos afetados:** `src/loop/GoalEvaluator.ts` (L72-212), `src/loop/ProactiveRecovery.ts` (L49-174).
- **Origem (auditorias):** Auditoria I.
- **Categoria:** Decision Ownership.
- **Classificação:** Quick Win.
- **Impacto:** Baixo.
- **Risco:** Baixo.
- **Esforço:** Baixo.
- **Dependências:** Nenhuma.
- **Pré-requisitos:** Nenhum.
- **Critérios de Aceite:** Uma única lista de padrões de erro transiente, referenciada pelos dois módulos.
- **Definition of Done:** Regressão 100%.
- **Rollback:** Trivial.
- **Testes obrigatórios:** Unitário + regressão.
- **Métrica que deverá melhorar:** Decision Owners.

### ARCH-015 — RFC: Args obrigatórios gerados do schema da tool ✅ Concluído (2026-07-18, Sprint S26 — implementação do escopo reduzido aprovado em S20)
- **Descrição:** "Quais argumentos são obrigatórios" é declarado em 5 lugares independentes: `parameters.required` de cada tool, `detectMissingRequiredArgs()` (hardcoded), o guard interno de cada `execute()`, `buildToolContracts()` e os blocos de prompt do Planner. Gerar validação + texto de prompt a partir do schema elimina a sincronização manual.
- **RFC (S20) — achados que reduziram o escopo aprovado:** (1) os "5 lugares" nem cobrem o mesmo conjunto de tools — `memory_write` está em `parameters.required` e no guard de `execute()`, mas NUNCA apareceu em `detectMissingRequiredArgs()`, confirmado por grep completo; (2) a lógica de "obrigatório" não é um `required: string[]` plano para pelo menos 3 tools (`web_navigate`, `crypto_analysis`: condicional a outro campo; `edit`: "uma de 3 combinações válidas") — gerar a VALIDAÇÃO a partir do schema atual perderia essa lógica silenciosamente, uma regressão, não simplificação, a menos que o próprio formato do schema seja estendido para um dialeto condicional (trabalho de modelagem maior que o "Risco: Médio" do card sugeria, sem incidente de produção real motivando a urgência); (3) só a metade de TEXTO DE PROMPT tem incidente real confirmado (S06/ARCH-025 achou drift real entre os 2 blocos). RFC completa: `docs/refatoracao-arquitetural-2026/RFC_ARCH-015_SchemaGeneratedRequiredArgs.md`. **Decisão aprovada:** só a geração do texto de prompt (campo novo `requiredArgsHint?: string` em `ToolExecutor`, co-localizado no arquivo de cada tool, agregado via `ToolRegistry.getEnabled()`) — a metade de VALIDAÇÃO (`detectMissingRequiredArgs`, guards internos, `parameters.required`) **não foi aprovada nesta forma**, fica candidata a uma RFC futura e distinta, condicionada a desenhar primeiro um dialeto de schema condicional.
- **Executado como (S26):** `agentLoopTypes.ts` ganhou `ToolExecutor.requiredArgsHint?: string`. As 7 tools que já tinham linha no bloco hardcoded antigo (`edit`, `send_document`, `list_workspace`, `read`, `memory_write`, `crypto_analysis`, `web_navigate`) receberam o campo com o texto extraído verbatim (`memory_write` preserva o bloco multi-linha de tipos de nó). `GoalPlanner.buildRequiredArgsReference()` (usada tanto no prompt inicial de plano quanto no de replan, mesma função, 2 call sites) passou de template literal hardcoded para `ToolRegistry.getEnabled().map(t => t.requiredArgsHint).filter(Boolean).join('\n')`. `web_search` deliberadamente sem hint (nunca teve linha no bloco antigo) — usada como caso negativo no teste novo. Elimina a classe de bug de drift entre texto do prompt e tool real: renomear/remover uma tool não deixa mais texto órfão no prompt; adicionar uma tool nova com args obrigatórios não-óbvios passa a ter hint só adicionando o campo no arquivo da própria tool, sem tocar `GoalPlanner.ts`.
- **Validação Progressiva (S26):** tsc --noEmit limpo, build limpo, regressão 127/127 (126 existentes + `S124_GoalPlanner_RequiredArgsHintFromToolRegistry.test.ts` novo, 21/21 asserts — confirma via `ToolRegistry` real + `GoalPlanner.replan()` real com LLM fake capturando o prompt que os 7 hints chegam corretos, incluindo o caso multi-linha, e que `web_search` fica de fora). Etapa 4 em sandbox isolado (`D:/IA/newclaw-verify-s26`, LLM real `glm-5.2:cloud`/Ollama): goal real "criar nota.txt e enviar" → plano real `[write,send_document]`, `send_document` recebeu `file_path` corretamente na 1ª tentativa (`args_provided=true`, `replans=0`) — confirma que o hint agregado dinamicamente de `ToolRegistry` chega ao prompt real e é suficiente pro LLM operar sem blocker. Commit: `314831b`.
- **Arquivos afetados:** `src/loop/GoalPlanner.ts` (L491-548 `detectMissingRequiredArgs`, L49-96 `buildToolContracts`), todas as tools em `src/tools/*.ts` (`parameters`).
- **Origem (auditorias):** Auditoria I (RE3), citado por referência cruzada na Auditoria II (sem achado novo lá).
- **Categoria:** Decision Ownership.
- **Classificação:** Exige RFC.
- **Impacto:** Alto (elimina 5 pontos de sincronização manual).
- **Risco:** Médio — o schema hoje (`Record<string, unknown>` livre) não é suficientemente tipado para gerar tudo automaticamente sem trabalho de modelagem.
- **Esforço:** Alto.
- **Dependências:** Sequenciar depois de ARCH-025 (dedupe de texto primeiro simplifica a reescrita orientada a schema).
- **Pré-requisitos:** Documento de Fase 1-5 completo antes de qualquer código.
- **Critérios de Aceite:** Definidos na RFC.
- **Definition of Done:** RFC aprovada +, se implementado, Validação Progressiva completa.
- **Rollback:** Se RFC concluir que não vale o risco, encerra sem código.
- **Testes obrigatórios:** N/A na fase de RFC; se implementado, unitário + regressão + e2e + ambiente real.
- **Métrica que deverá melhorar:** Decision Owners, Single Sources.

### ARCH-016 — Consolidar detecção de loop em `StrategyDiversityGuard` ✅ Concluído (2026-07-17, Sprint S11)
- **Descrição:** `GoalPlanner.buildReplanPrompt()` tem 4 blocos artesanais e paralelos de detecção de repetição (`pipVenvLoopDirective`, `execCommandBanDirective`, `stuckInAnalysis`/`implementDirective`, `contentStubDirective`), cada um recontando `blockers`/`strategiesTried` com critério próprio, nenhum reusando `StrategyDiversityGuard.extractExhaustedTools()` (que já existe e já resolve "tool falhou ≥N vezes"). Além de trocar a fonte de dados, extrair um template comum (`buildLoopDirective`) para os 4 blocos de texto, hoje quase idênticos. **Correção na execução:** a premissa "os 4 são o mesmo padrão" não se sustentou — só `execCommandBanDirective` é genuinamente "tool falhou N vezes"; os outros 3 detectam categoria de blocker+texto, categoria de ação (não falha) e ocorrência única (não repetição), respectivamente — `docs/issues/006`. Template compartilhado aplicado aos 4 (real, seguro); fonte de dados unificada só onde fazia sentido (1 de 4), aditivamente.
- **Arquivos afetados:** `src/loop/GoalPlanner.ts` (L295-356), `src/loop/StrategyDiversityGuard.ts`.
- **Origem (auditorias):** Auditoria I (Complexity Hotspot #2.3, QW4), Auditoria III (Data Clump, SC2 — mesmo código, ângulo de duplicação textual).
- **Categoria:** Decision Ownership.
- **Classificação:** Quick Win (parte de template) + Refactor Local (parte de fonte de dados).
- **Impacto:** Alto.
- **Risco:** Médio — muda thresholds efetivos de detecção de loop (de contagem de `blockers` para contagem de `attempts` com `result==='failure'`), pode alterar quando um replan aciona a diretiva.
- **Esforço:** Médio.
- **Dependências:** Sequenciar após ARCH-011 (mesma classe, fonte de dados já corrigida).
- **Pré-requisitos:** Nenhum.
- **Critérios de Aceite:** Os 4 blocos usam `StrategyDiversityGuard` como única fonte; texto gerado por uma função compartilhada.
- **Definition of Done:** Regressão 100% + teste cobrindo cada um dos 4 cenários de loop.
- **Rollback:** Reverter.
- **Testes obrigatórios:** Unitário (4 cenários) + regressão.
- **Métrica que deverá melhorar:** Decision Owners, Code Smells (Data Clump).

### ARCH-017 — Decidir destino do `ToolExecutorService`/`CircuitBreaker` morto ✅ Concluído (2026-07-17, Sprint S05 — decisão: remover)
- **Descrição:** `core/ToolExecutor.ts` (`ToolExecutorService`, com `CircuitBreaker` completo) tem 0 call sites reais — nem `GoalExecutionLoop`, nem `ProactiveRecovery`, nem `AgentLoop` o usam; `AgentController.getToolExecutor()` também não tem caller. Toda execução real passa por `ProactiveRecovery.execute()` direto. **Executado como:** arquivo removido inteiro; `ToolExecutorLike` (interface do mesmo arquivo, com 1 consumidor real não citado no card — `tools/powerpoint_control.ts`) substituída pelo `ToolExecutor` já existente em `loop/agentLoopTypes.ts` (estruturalmente idêntico). `core/CircuitBreaker.ts` (usado de verdade por `ProviderFactory.ts`) **não foi tocado** — só o wrapper morto que o envolvia.
- **Arquivos afetados:** `src/core/ToolExecutor.ts`, `src/core/AgentController.ts` (`getToolExecutor`), `src/loop/ProactiveRecovery.ts` (se optar por conectar em vez de remover).
- **Origem (auditorias):** Auditoria I (#9, QW3).
- **Categoria:** Decision Ownership / Technical Cleanup.
- **Classificação:** Quick Win (remover) ou Refactor Local (conectar).
- **Impacto:** Médio (remove peça morta que confunde leitura) a Alto (se conectado, ganha circuit breaker de verdade).
- **Risco:** Baixo (remover) / Médio (conectar — muda comportamento de retry real em produção).
- **Esforço:** Baixo (remover) / Médio (conectar).
- **Dependências:** Nenhuma.
- **Pré-requisitos:** Decisão explícita do responsável técnico: remover ou conectar (este backlog não decide por antecipação — ver Fase 8, este item entra priorizado como "decisão pendente").
- **Critérios de Aceite:** Ou `ToolExecutorService` deixa de existir, ou está genuinamente no caminho de execução de toda tool.
- **Definition of Done:** Se remover: build limpo, regressão 100%. Se conectar: Validação Progressiva completa até etapa 4 (circuit breaker real precisa ser observado sob falha real).
- **Rollback:** Se remover: reverter. Se conectar: reverter a integração, manter a classe órfã como estava.
- **Testes obrigatórios:** Regressão completa; se conectar, teste de circuit breaker abrindo sob falhas reais.
- **Métrica que deverá melhorar:** Decision Owners, God Methods indiretamente (remove uma opção de caminho a considerar).

### ARCH-018 — `evaluateCriteria` absorve `structuralBypass` como `CriterionCheck` ⏸ Adiado (2026-07-18, Sprint S18) — premissa presumia equivalência semântica que não existe
- **Descrição:** `structuralBypass` (`GoalExecutionLoop.ts` L634-669) é um desvio de código solto dentro de `runLoopInternal` que faz `fs.statSync` direto para decidir "já pode considerar entregue". `file_exists` já existe como `CriterionCheck` — expressar o bypass como mais um critério elimina o `if` ad-hoc.
- **Adiado na S18, antes de codificar (Fase 1 da diretriz de arquitetura):** a implementação real de `file_exists` (`evaluateCriteria()`) checa se existe um `GoalAttempt` bem-sucedido com `output` não-vazio — NÃO consulta o disco. `structuralBypass` faz `fs.statSync()` direto no disco, sem depender de nenhum attempt, exatamente porque o Bug 2 original (`project_session_bugs_jul2026_ap`) era sobre arquivos que já existiam ANTES do goal começar, sem attempt nenhum como evidência. Reaproveitar `file_exists` literalmente reintroduziria o deadlock que `structuralBypass` foi criado para fechar. Achado estrutural adicional: `structuralBypass` deriva alvos dinamicamente do plano atual (muda a cada replan); `successCriteria` é uma lista estática — encaixar um no outro exigiria sincronizar as duas fontes a cada replan, um risco novo, não uma simplificação. Registro técnico completo, incluindo a alternativa de design (novo `CriterionCheck` dedicado, sem reaproveitar `file_exists`): `docs/issues/010-arch018-file-exists-checks-attempts-not-disk.md`. 2ª instância confirmada do modo 3 da retrospectiva (equivalência semântica assumida sem verificação — mesmo modo de S10/S11). Por decisão do usuário, adiado sem consolidação com outro tema.
- **Arquivos afetados:** `src/loop/GoalExecutionLoop.ts` (L634-669, L2840-2943 `evaluateCriteria`).
- **Origem (auditorias):** Auditoria I (RE4).
- **Categoria:** Decision Ownership.
- **Classificação:** Refactor Local.
- **Impacto:** Médio.
- **Risco:** Médio — é o caminho que já teve um bug real de deadlock documentado (jul/2026, goals de "reenviar arquivo existente").
- **Esforço:** Médio.
- **Dependências:** ARCH-005 (fonte única de artefatos entregues) deve vir antes.
- **Pré-requisitos:** Reler o histórico do bug de deadlock antes de tocar (contexto já documentado em memória do projeto).
- **Critérios de Aceite:** Nenhum `if` solto de bypass fora de `evaluateCriteria`.
- **Definition of Done:** Validação Progressiva completa até etapa 4 (é a área do deadlock já documentado).
- **Rollback:** Reverter.
- **Testes obrigatórios:** Unitário (replicar o cenário do bug de deadlock original como regressão) + e2e + ambiente real.
- **Métrica que deverá melhorar:** Decision Owners, Single Sources.

---

## Epic D — Structural Simplification
*Origem: Auditoria III.*

### ARCH-019 — Decompor `AgentLoop.runWithTools()` (~1793 linhas) ✅ Concluído (2026-07-18, Sprint S25, 6 incrementos)
- **Descrição:** Maior método do projeto — é praticamente a classe inteira depois do construtor. Decompor em fases nomeadas (parse de tool call, dispatch, delivery-guard, orçamento de steps, etc.), sem mudar comportamento.
- **Executado como (S25, 6 incrementos sequenciais em ordem crescente de risco — decisão do usuário via AskUserQuestion, dado que o método é ~1.7x maior que o ARCH-020/S24 e tem ~3x mais variáveis mutáveis por closure):**
  - **Incremento 1 (commit `53a4fa3`):** bloco "Structured turn diagnostics" (puramente de leitura, sem mutação de estado do chamador) → `logTurnDiagnostics()`, recebendo um `TurnDiagnosticsInput` nomeado (~25 sinais) em vez de parâmetros posicionais.
  - **Incremento 2 (commit `3b40632`):** "Delivery guard" (re-entra no loop com instrução de entrega quando um arquivo foi escrito mas não enviado) → `runDeliveryGuardPhase()`.
  - **Incremento 3 (commit `baf5d34`):** síntese pós-loop + fallback definitivo (a cauda do método, sempre termina em `return`) → `runSynthesisAndFallbackPhase()` — único incremento sem discriminated union (todo caminho já é `return`).
  - **Incremento 4 (commit `45788e1`):** dispatch JSON-action (caminho alternativo ao tool-calling nativo, para modelos sem function-calling) → `runJsonActionDispatch()`.
  - **Incremento 5 (commit `0778076`):** dispatch de tool-calling nativo — a peça mais arriscada. `runNativeToolCallDispatch()` sozinho ficou com 487 linhas (acima do limite); sub-decomposto em mais 2 níveis (decisão do usuário) → `dispatchSingleNativeToolCall()` (por toolCall do batch) → `executeAndRecordNativeToolCall()` + `applyPostToolCallGuardsAndFinalize()` (as 2 metades do antigo `if(tool){...}`). 4 métodos, todos < 300 linhas.
  - **Incremento 6 (commit `73d246c`):** `setupTurn()` (roteamento de intenção + 4 fast-paths + sessão/DecisionContext + orçamento de steps) + `checkContextGrowthGuard()` (2º corte, decisão do usuário após o 1º corte sozinho deixar `runWithTools()` em 509 linhas).
  - **Achado real mais importante (Incremento 6, pego por análise da fronteira try/catch, não por teste):** `trace`/`fsm`/`move`/`turnAbort` e todo o estado acumulador do loop (`cycleHistory`, `toolFailureCount`, contadores de guard) são declarados ANTES do `try{}` de `runWithTools()` — mover a criação de `trace` para dentro de `setupTurn()` teria introduzido um bug real: se `traceManager.startTrace()` lançasse exceção depois de movido, o `catch(fsmError)` do chamador tentaria ler `trace.status` de um `trace` nunca atribuído. `setupTurn()` só cobre o código que roda DEPOIS de `move('START_TURN')` — por isso seu escopo final ficou ~18 campos, não os ~40 inicialmente cogitados.
  - **Critério de aceite parcialmente cumprido:** 8 dos 9 métodos novos (Incrementos 1-6) ficam < 300 linhas. `runWithTools()` cai de ~1793 para 419 linhas (77% de redução) — ainda acima de 300, **aceito explicitamente pelo usuário** como resultado final: o que resta é o esqueleto do `while` loop + declarações pré-try (não extraíveis, ver achado acima) + o `catch/finally` obrigatório (rede de segurança do lifecycle do trace), nunca movido em nenhum dos 6 incrementos.
  - **3 classes distintas de erro pegas por `tsc` antes de qualquer teste rodar, cada uma num incremento diferente:** referência ausente (Incremento 4 — 3 constantes locais esquecidas como parâmetro), tipo errado (Incremento 5 — `ToolCallRequest` em vez de `ToolCall`, dois tipos parecidos com campos diferentes), parâmetro não utilizado (Incremento 6 — `turnSignal` passado para `setupTurn()` mas nunca lido lá). Nenhuma dessas classes de erro é a mesma que os bugs de VALOR (threading de `priorFeedback` em ARCH-020/S24) — reforça que `tsc` cobre corretude de referência/estrutura, não de valor; os dois mecanismos de verificação são complementares, nenhum substitui o outro.
  - **Validação:** tsc+build limpos nos 6 incrementos; regressão 126/126 em todos (0 quebras de teste em nenhum incremento desta Sprint — diferente de ARCH-020/S24, que teve 1 quebra de fonte-texto). Etapa 4 real executada em todos os 6 incrementos (instância isolada, LLM real) — nem todo cenário de teste conseguiu forçar deterministicamente o caminho específico sendo validado (o classificador do ambiente de teste frequentemente roteou requests via `GoalExecutionLoop` direto em vez de `AgentLoop.process()`), mas nenhuma execução real crashou desde que o código de cada incremento landou, e os incrementos 1 e 6 confirmaram sinais de log específicos (`[TURN-DIAGNOSTICS]` ausente mas explicado; `[UNIFIED-ROUTER]`/`[STEP-BUDGET]` confirmados) com dados reais.
- **Arquivos afetados:** `src/loop/AgentLoop.ts` (L1118-2911).
- **Origem (auditorias):** Auditoria III (Hotspot #1, Muito Alta).
- **Categoria:** Structural Simplification.
- **Classificação:** Refactor Estrutural.
- **Impacto:** Muito Alto.
- **Risco:** Alto — closures capturando `cycleHistory`, `usedToolInputs`, `stepCount` por referência; sem teste de sistema que cubra a função inteira.
- **Esforço:** Muito Alto.
- **Dependências:** ARCH-005, ARCH-007 (implementação do novo contrato de callbacks). **Nunca simultâneo com ARCH-020** (mesmo WIP-limit: ambos são cirurgias grandes em concerns de entrega/estado sobrepostos — risco de merge conflict e fadiga de revisão). Cumprida — ARCH-020 concluído em S24, antes de S25 começar.
- **Pré-requisitos:** Mapear TODOS os efeitos colaterais capturados por closure antes de extrair qualquer método. Cumprido — Fase 1 leu o método inteiro antes de qualquer extração.
- **Critérios de Aceite:** Nenhum método resultante da decomposição excede 300 linhas; comportamento observável idêntico. **Parcialmente cumprido** — ver nota acima (`runWithTools()` em 419 linhas, aceito como exceção documentada).
- **Definition of Done:** Validação Progressiva completa até etapa 4. Cumprido nos 6 incrementos.
- **Rollback:** Reverter os 6 commits, na ordem inversa: `73d246c`, `0778076`, `45788e1`, `baf5d34`, `3b40632`, `53a4fa3`.
- **Testes obrigatórios:** Unitário + regressão completa + e2e sintético + ambiente real (fluxo completo de tool-calling com LLM real). Cumprido.
- **Métrica que deverá melhorar:** God Methods (Indicador #2), Large Classes (Indicador #3).

### ARCH-020 — Decompor `GoalExecutionLoop.runLoopInternal()` (~1030 linhas) + `switch(cycleResult.outcome)` ✅ Concluído (2026-07-18, Sprint S24, commits 0173795 + 2782216)
- **Descrição:** Segundo maior método do projeto. Contém dentro de si o `switch` de outcome (~400 linhas) — decompor ambos juntos: cada `case` vira um método nomeado (`handleSuccessOutcome`, `handlePartialOutcome`, etc.), e o corpo restante de `runLoopInternal` vira fases nomeadas.
- **Executado como (S24, 2 incrementos sequenciais na mesma Sprint — decisão do usuário sobre a estratégia de fatiamento, dado o risco explicitamente sinalizado pelo card):**
  - **Incremento 1 (commit `0173795`):** os 6 `case`s do switch (`success`/`partial`/`needs_auth`/`needs_dependency`/`blocked`/`failed`) viraram métodos `handle*Outcome()`, reusando o discriminated union já validado em `dispatchAgentloopStep()`/`finalizeStepAttempt()` (ARCH-022/S22) — `earlyReturn:true` replica um `return` do case original, `earlyReturn:false` um `break`. Nenhum excede 300 linhas (maior: `handleSuccessOutcome`, 141). Achado real: `handleBlockedOutcome`'s guard "sem blocker" (inalcançável pelos 3 produtores reais de `outcome='blocked'` hoje, mas permitido pelo tipo `GoalBlocker | undefined`) devolvia `priorFeedback` sempre `undefined` em vez de preservar o valor recebido do chamador — corrigido antes de rodar a suíte, coberto por teste novo `S123`. Teste `S16` corrigido (fonte-texto presa a `pendingStep`→renomeado `step`).
  - **Incremento 2 (commit `2782216`):** o bloco `if (readyToValidate) {...}` e o bloco de execução do step pendente viraram 4 métodos: `runValidationPhase`, `runValidationAchievedPhase`, `runValidationNotAchievedPhase`, `runStepExecutionPhase` — mesmo padrão discriminated union (`continueLoop`/`earlyReturn`/`proceedToSwitch`). `runLoopInternal()` cai de ~1030 para 154 linhas; nenhum dos 4 novos métodos excede 300 (maior: `runStepExecutionPhase`, 221). Achado real, 2 instâncias da MESMA classe de bug do Incremento 1: os branches "bonus de replan concedido" e "deliverable_check injetou send steps" de `runValidationNotAchievedPhase` inicialmente devolviam `priorFeedback` errado (hardcoded, não preservado) ao virarem `continueLoop` — corrigido antes de rodar qualquer teste, mesmo padrão de correção (threading como parâmetro de entrada).
  - **Critério de aceite cumprido:** nenhum método resultante excede 300 linhas — confirmado para o método inteiro (11 métodos novos no total entre os 2 incrementos), não só o switch.
  - **Validação:** tsc+build limpos nos 2 incrementos; regressão 126/126 (1 quebra de fonte-texto no Incremento 1, corrigida; 0 quebras no Incremento 2). Etapa 4 real executada nos 2 incrementos (instância isolada, LLM real, goals reais completos com entrega de arquivo confirmada em disco) — obrigatória pela Classificação `Refactor Estrutural` do card, não dispensada.
- **Arquivos afetados:** `src/loop/GoalExecutionLoop.ts` (L570-1602).
- **Origem (auditorias):** Auditoria III (Hotspot #2 e #3).
- **Categoria:** Structural Simplification.
- **Classificação:** Refactor Estrutural.
- **Impacto:** Muito Alto.
- **Risco:** Alto (mesma natureza do ARCH-019, arquivo central do sistema de goals).
- **Esforço:** Muito Alto.
- **Dependências:** ARCH-005, ARCH-006, ARCH-007, ARCH-008, ARCH-009. **Nunca simultâneo com ARCH-019.** ARCH-008/ARCH-009 adiados (S17/S14) não bloqueiam — dependência era sequenciamento, não funcional; ver notas nos respectivos cards.
- **Pré-requisitos:** Mesma exigência de mapeamento de efeitos colaterais do ARCH-019.
- **Critérios de Aceite:** Nenhum método resultante excede 300 linhas.
- **Definition of Done:** Validação Progressiva completa até etapa 4.
- **Rollback:** Reverter.
- **Testes obrigatórios:** Unitário + regressão + e2e sintético + ambiente real.
- **Métrica que deverá melhorar:** God Methods, Large Classes.

### ARCH-021 — (absorvido em ARCH-020) ✅ Concluído junto com ARCH-020 (2026-07-18, Sprint S24, Incremento 1, commit 0173795)
- **Nota:** O achado original da Auditoria III ("quebrar o switch em métodos por case") é tratado como parte integrante de ARCH-020, não como item separado — o switch vive fisicamente dentro de `runLoopInternal` e não pode ser decomposto de forma segura isoladamente sem repetir o mapeamento de efeitos colaterais já exigido pelo item pai. Executado como o Incremento 1 de ARCH-020 — ver detalhes lá.

### ARCH-022 — Decompor `GoalExecutionLoop.executeStep()` (~375 linhas) + eliminar 4 blocos duplicados ✅ Concluído (2026-07-18, Sprint S22)
- **Descrição:** Extrair um helper `recordFailedAttempt(goal, step, {error, output, cycle})` para os 4 blocos quase idênticos de "construir `GoalAttempt` de falha + persistir + avaliar" (guarda de step-name-as-path, botões de auth, catch, e o próprio fluxo principal). Depois, separar o método em: dispatch direto (tool) vs dispatch `agentloop` vs pós-processamento (registro de attempt, tracking, dedup).
- **Executado como:** premissa dos "4 blocos quase idênticos" parcialmente corrigida na Fase 1 — comparação campo a campo mostrou que só 3 dos 4 blocos são genuinamente equivalentes (guarda de step-name-as-path, catch, e a construção de attempt do guard de auth): os 3 fazem `result:'failure'` + persistem + (exceto o guard de auth) chamam `evaluator.evaluate()`. O guard de auth NUNCA chamava `evaluator.evaluate()` — retorna `needs_auth` direto, sem classificação de erro/retry — então `recordFailedAttempt()` foi implementado cobrindo só a parte de "construir attempt + persistir" (sem decidir o outcome), deixando cada chamador decidir depois o que fazer com o resultado (preserva a diferença real de comportamento entre os 3). O 4º bloco ("o próprio fluxo principal") NÃO foi absorvido no helper — tem 5 campos extras (mutations, evaluation, traceId, subToolCalls, producedArtifactPaths) que os outros 3 não têm, e não é exclusivamente um bloco de falha (cobre success/partial/failure) — forçá-lo no helper teria exigido um sinature muito mais amplo que o `{error, output, cycle}` que o card pedia, ou perda desses 5 campos. Decomposição em 3 métodos novos (`dispatchToolStep`, `dispatchAgentloopStep`, `finalizeStepAttempt`) + o helper, exatamente como o card propunha na 2ª parte. Teste novo `S122` (4 cenários do card + 1 controle, 21 assertions). Teste `S51` corrigido (asserção presa a `step.toolName` inline no source — o guard moveu pra dentro de `dispatchToolStep`, que recebe `toolName` como parâmetro explícito, mesma classe de achado de S52/S110/S34/S22-teste/S11/S10). Regressão 125/125.
- **Arquivos afetados:** `src/loop/GoalExecutionLoop.ts` (`executeStep` decomposto + 4 métodos novos), teste novo `S122`, teste `S51` corrigido.
- **Origem (auditorias):** Auditoria III (Hotspot #4, SC1, SC5).
- **Categoria:** Structural Simplification.
- **Classificação:** Refactor Local (o helper) + Refactor Estrutural (a decomposição do método).
- **Impacto:** Alto.
- **Risco:** Médio (menor que ARCH-019/020 — método menor e mais localizado).
- **Esforço:** Médio-Alto.
- **Dependências:** ARCH-005, ARCH-009, ARCH-013 (simplificar o juiz de sucesso antes reduz a lógica a decompor). **ARCH-009/ARCH-013 adiados (S14/S21) não bloqueiam — dependência era sequenciamento (reduzir lógica a decompor), não funcional; S22 pode prosseguir com os 2 juízes ainda separados, só com mais lógica a carvear.**
- **Pré-requisitos:** Nenhum além das dependências.
- **Critérios de Aceite:** Nenhum bloco de "registrar falha" duplicado; método principal com sub-métodos claros.
- **Definition of Done:** Regressão 100% + e2e sintético.
- **Rollback:** Reverter.
- **Testes obrigatórios:** Unitário (os 4 cenários de falha) + regressão + e2e sintético.
- **Métrica que deverá melhorar:** God Methods, Code Smells (Duplicated Code).

### ARCH-023 — Explicitar pipeline de fixups do `exec_command.ts` ✅ Concluído (2026-07-17, Sprint S12)
- **Descrição:** ~12 funções puras de correção (marp/pandoc/PowerShell/CLIXML) são aplicadas via `if`s sequenciais dentro de `execute()`, com ordem importando implicitamente (comentários dizem "roda por ÚLTIMO"). Expressar como uma lista nomeada de transformações aplicadas em sequência explícita torna a ordem auditável sem mudar o resultado. **Executado como:** `COMMAND_FIXUP_PIPELINE` (4 steps que de fato mutam `command` numa cadeia onde a ordem importa) + `applyFixup()`, chamado individualmente nos mesmos 4 pontos onde os `if`s inline estavam — não um loop único, porque `isSearchCommand` precisa ler o comando ANTES do fixup `wrap_powershell` (embrulho em PowerShell/Base64 esconderia grep/rg/find da detecção). 2 gates de validação (`isMarpWithoutInputFile`/`isPandocWithoutInputFile`) ficaram como `if`s diretos — abortam em vez de transformar, sem dependência de ordem entre si.
- **Arquivos afetados:** `src/tools/exec_command.ts` (L331-400).
- **Origem (auditorias):** Auditoria III (Divergent Change, majoritariamente essencial).
- **Categoria:** Structural Simplification.
- **Classificação:** Refactor Local.
- **Impacto:** Baixo-Médio (a complexidade em si é majoritariamente essencial — este item só corrige a FALTA de estrutura explícita, não remove nenhuma correção).
- **Risco:** Baixo — arquivo isolado, já bem coberto por testes de regressão existentes (S11, S12, S13, S15).
- **Esforço:** Baixo.
- **Dependências:** Nenhuma — pode rodar a qualquer momento, inclusive em paralelo com qualquer outro item.
- **Pré-requisitos:** Nenhum.
- **Critérios de Aceite:** A ordem de aplicação dos fixups é uma estrutura de dados explícita, não uma sequência de `if`s.
- **Definition of Done:** Regressão 100% (suíte já existente cobre bem esta área).
- **Rollback:** Trivial.
- **Testes obrigatórios:** Regressão (S11, S12, S13, S15 já existentes).
- **Métrica que deverá melhorar:** Code Smells (Divergent Change), custo cognitivo.

### ARCH-024 — RFC + Implementação: `DeliveryTrackingContext` (consolidar callbacks de `ChannelContext`) ✅ Concluído (RFC: 2026-09/S19; Implementação: 2026-07-18/S23, commit ff2dd23)
- **Descrição:** 5 campos de callback (`deferSendDocument`, `isDeferredArtifact`, `onArtifactDelivered`, `isAudioAlreadySent`, `recentMessages`) foram acumulados em `ChannelContext` um a um, cada um resolvendo um bug pontual — nenhum é sobre o canal (Telegram/Discord/Web), todos são sobre rastreamento de entrega de goal. Consolidar num contrato dedicado.
- **RFC (S19) — premissa corrigida:** `recentMessages` NÃO é sobre rastreamento de entrega — é construído em `MessageBus.ts` (mesmo lugar/razão que `channel`/`chatId`/`userId`) e consumido só por `UnifiedIntentRouter` para classificação de intenção, sem nenhuma relação com `send_document`/`send_audio`. Só os outros 4 campos são genuinamente "delivery tracking" (produzidos exclusivamente dentro de `GoalExecutionLoop.executeStep()`, consumidos em 6 pontos de `AgentLoop.ts`). RFC completa: `docs/refatoracao-arquitetural-2026/RFC_ARCH-024_DeliveryTrackingContext.md`. **Decisão aprovada:** consolidar os 4 campos (excluindo `recentMessages`) como um único campo aninhado `ChannelContext.deliveryTracking?: DeliveryTrackingContext`, em vez de um parâmetro separado na assinatura de `AgentLoop.process()` (a leitura mais literal do card, rejeitada por risco desproporcional ao ganho — ver Fase 2/3 da RFC) — preserva a assinatura de método existente, mudança mecânica de baixo risco em ~9 call sites.
- **Executado como (S23, 2026-07-18, commit ff2dd23):** exatamente o desenho aprovado na RFC, sem desvio de escopo. `DeliveryTrackingContext` criada em `agentLoopTypes.ts`; `ChannelContext.deliveryTracking?: DeliveryTrackingContext` substitui os 4 campos soltos (`recentMessages` mantido como campo direto, confirmado não-relacionado); produtor único em `GoalExecutionLoop.dispatchAgentloopStep()` (linha ~1893, dentro do objeto `goalChannelContext`) passou a aninhar os 4 closures sob `deliveryTracking: {...}`; os 7 pontos de leitura em `AgentLoop.ts` (linhas 1807/1809/1818/1852/2155/2255/2276/2674 — 8 no total, um a mais do que o levantamento original de "6 pontos" da RFC, que não tinha contado a própria chamada `channelContext.deferSendDocument(...)` na linha 1818 como um consumo distinto do guard condicional da linha 1807) ganharam o hop `.deliveryTracking`. Única quebra de teste prevista e confirmada: `S44_SendAudio_GoalReplanDedup.test.ts`, regex `nativePathGuard` (fonte-texto-frágil, mesma classe de fragilidade já registrada em S22/S51) — corrigida. Validação Progressiva: tsc limpo, build limpo, 125/125 regressão. **Etapa 4 (ambiente real) executada** — a Classificação do card é `Exige RFC` (linha "Classificação" abaixo), o que a Regra Permanente #5 do `MASTER_EXECUTION_PLAN.md` torna obrigatório para fechar `🟢 Concluída` independentemente do meu julgamento inicial de que a mudança seria "puramente estrutural" (revertido nesta mesma Sprint, ver abaixo). Instância isolada Windows, LLM real (glm-5.2:cloud), goal real ("crie um arquivo .txt e envie para mim") — confirmou que `deferSendDocument` aninhado sob `deliveryTracking` popula `deferredSendArgs` de verdade (log `[DELIVERY-REGISTRY] artifact="teste_s23.txt" status=delivered`), que o arquivo foi escrito e efetivamente entregue, fechando o ciclo completo produtor (`GoalExecutionLoop`) → consumidor (`AgentLoop`) → flush pós-ciclo, sem nenhum passo silenciosamente no-opado.
- **Autocorreção durante a Sprint:** cheguei a registrar "Etapa 4 dispensada" com a justificativa de que a mudança não tinha superfície de ambiente real — decisão revertida ao reler a Regra Permanente #5 (classificação `Exige RFC` exige etapa 4 categoricamente, não por avaliação de risco caso a caso) e ao notar um risco concreto que eu tinha subestimado: todos os campos de `deliveryTracking` são opcionais (`?.`), então um erro de wiring (aninhamento errado, produtor esquecendo de propagar o sub-objeto) não geraria erro de tipo — apenas faria os guards de dedup virarem no-op silencioso, reintroduzindo exatamente os bugs de envio duplicado (S10/S44/S51) que este subsistema existe para prevenir. `tsc` sozinho não cobre esse risco.
- **Arquivos afetados:** `src/loop/agentLoopTypes.ts` (`ChannelContext`), `src/loop/AgentLoop.ts`, `src/loop/GoalExecutionLoop.ts` (todos os consumidores dos 5 campos).
- **Origem (auditorias):** Auditoria III (SC8, Data Clump).
- **Categoria:** Structural Simplification.
- **Classificação:** Exige RFC.
- **Impacto:** Médio-Alto (facilita ARCH-019).
- **Risco:** Alto — toca o contrato entre `AgentLoop` e `GoalExecutionLoop`, superfície ampla.
- **Esforço:** Alto.
- **Dependências:** Deve ser resolvido (ao menos a RFC) antes de ARCH-019, já que uma interface de entrega mais limpa facilita a decomposição de `runWithTools`.
- **Pré-requisitos:** Documento de Fase 1-5 completo antes de qualquer código.
- **Critérios de Aceite:** Definidos na RFC.
- **Definition of Done:** RFC aprovada +, se implementado, Validação Progressiva completa.
- **Rollback:** Se RFC concluir que não vale o risco agora, o item fica documentado e pausado — `runWithTools` ainda pode ser decomposto sem ele, só com mais cuidado.
- **Testes obrigatórios:** N/A na fase de RFC; se implementado, unitário + regressão + e2e + ambiente real.
- **Métrica que deverá melhorar:** Code Smells (Data Clump), acoplamento.

---

## Epic E — Technical Cleanup
*Origem: Auditoria I e III — itens pequenos, isolados, baixo risco.*

### ARCH-025 — Extrair blocos de prompt duplicados entre `buildPlanPrompt`/`buildReplanPrompt` ✅ Concluído (2026-07-17, Sprint S06)
- **Descrição:** "ARGS OBRIGATÓRIOS POR FERRAMENTA"/"REFERÊNCIA DE ARGS OBRIGATÓRIOS" e "COLETA EM LOTE" são ~95% texto idêntico, copiado à mão duas vezes em `GoalPlanner.ts`. **Executado como:** `buildRequiredArgsReference()`/`buildBatchCollectionBlock()` novas, únicas fontes para os dois prompts. A comparação real achou 6 divergências textuais entre as duas cópias (não só formatação) — a mais relevante: o replan tinha só 3 dos 5 tipos de nó de `memory_write`. Convergido para a versão mais completa, o que corrige essa lacuna do prompt de replan como efeito colateral direto da deduplicação.
- **Arquivos afetados:** `src/loop/GoalPlanner.ts` (L225-245, L412-427).
- **Origem (auditorias):** Auditoria I (QW1).
- **Categoria:** Technical Cleanup.
- **Classificação:** Quick Win.
- **Impacto:** Baixo-Médio.
- **Risco:** Baixo.
- **Esforço:** Baixo.
- **Dependências:** Nenhuma. Sequenciar antes de ARCH-015 (RFC de schema).
- **Pré-requisitos:** Nenhum.
- **Critérios de Aceite:** Um único texto-fonte para cada bloco, usado nos dois prompts.
- **Definition of Done:** Regressão 100%.
- **Rollback:** Trivial.
- **Testes obrigatórios:** Regressão.
- **Métrica que deverá melhorar:** Code Smells (duplicação textual).

### ARCH-026 — Unificar `DELIVERABLE_EXTENSIONS` em `inferExpectedExtensions.ts` ✅ Concluído (2026-07-17, Sprint S07)
- **Descrição:** `AgentLoop.ts` mantém uma lista fixa própria (`DELIVERABLE_EXTENSIONS`) separada da lógica de inferência já centralizada em `planning/inferExpectedExtensions.ts` (que já unificou `SOURCE_SCRIPT_EXTENSIONS` antes). **Executado como:** `DELIVERABLE_EXTENSIONS` movido para `inferExpectedExtensions.ts` como export próprio, ao lado de (não fundido com) `SOURCE_SCRIPT_EXTENSIONS` — permanece uma lista distinta de `inferExpectedExtensions()`, pois respondem perguntas diferentes (extensão de um path já escrito vs. extensão esperada pelo texto da intenção). Quebrou (e corrigiu) um teste de regressão que inspecionava o texto-fonte de `AgentLoop.ts` diretamente — evidência de que a Regressão Arquitetural precisa incluir também os testes que fazem asserção sobre localização de código, não só sobre comportamento.
- **Arquivos afetados:** `src/loop/AgentLoop.ts` (L2562), `src/loop/planning/inferExpectedExtensions.ts`.
- **Origem (auditorias):** Auditoria I (QW5).
- **Categoria:** Technical Cleanup.
- **Classificação:** Quick Win.
- **Impacto:** Baixo.
- **Risco:** Baixo.
- **Esforço:** Baixo.
- **Dependências:** Nenhuma.
- **Pré-requisitos:** Nenhum.
- **Critérios de Aceite:** Uma única lista de extensões-deliverable.
- **Definition of Done:** Regressão 100%.
- **Rollback:** Trivial.
- **Testes obrigatórios:** Regressão.
- **Métrica que deverá melhorar:** Single Sources.

---

# FASE 4 — Grafo de Dependências (DAG)

```
Tier 0 (sem dependências, paralelizáveis entre si)
  ARCH-001  ARCH-002  ARCH-004  ARCH-014  ARCH-017  ARCH-023  ARCH-025  ARCH-026
      │
      ▼
Tier 1 (dependem só de Tier 0 ou de nada, mas concentram base para o resto)
  ARCH-003 ──► ARCH-011 ──► ARCH-016
  ARCH-005 (base para quase tudo abaixo)
  ARCH-009
      │
      ▼
Tier 2 (dependem de Tier 1)
  ARCH-005 ──► ARCH-006, ARCH-007, ARCH-008, ARCH-010, ARCH-018
  ARCH-009 ──► ARCH-013
      │
      ▼
Tier 3 (RFCs — podem rodar em paralelo com Tier 1/2, são só análise)
  ARCH-015 (RFC)      ARCH-024 (RFC)      [preparam Tier 4]
      │
      ▼
Tier 4 (Refactors Estruturais grandes — mutuamente exclusivos entre si por WIP)
  ARCH-013 ──► ARCH-022 ──► ARCH-020 ──► ARCH-019 (ordem sequencial recomendada,
                                                      nunca ARCH-019 e ARCH-020
                                                      simultâneos)
  ARCH-024 (implementação, pós-RFC) ──► precede ARCH-019
      │
      ▼
Tier 5 (implementação condicional das RFCs, e o item de maior risco por último)
  ARCH-015 (implementação, pós-RFC)
  ARCH-012 (RFC + implementação condicional — último item do backlog)
```

**O que desbloqueia o quê:**
- ARCH-005 desbloqueia ARCH-006, 007, 008, 010, 018, e é pré-requisito informal de ARCH-019/020 (ambos tocam a lógica de entrega que ARCH-005 unifica).
- ARCH-009 desbloqueia ARCH-013 (tipos consolidados antes de fundir os juízes de sucesso).
- ARCH-013 desbloqueia ARCH-022 (juiz de sucesso simplificado antes de decompor o método que o hospeda).
- ARCH-003 desbloqueia ARCH-011 (mover a classe antes de mudar sua lógica interna).
- ARCH-011 desbloqueia ARCH-016 (fonte de dados corrigida antes de trocar os consumidores).
- ARCH-024 (RFC + implementação) deveria preceder ARCH-019 (contrato de callback mais limpo facilita a decomposição do maior método do projeto) — não é bloqueio absoluto, é recomendação de sequência para reduzir risco.

**O que pode ocorrer em paralelo:**
- Todo o Tier 0 entre si.
- ARCH-003/011/016 (StrategyDiversityGuard) em paralelo com ARCH-006/007/008/009/010 (SSOT do GoalExecutionLoop) — áreas de código disjuntas.
- ARCH-015 e ARCH-024 (as duas RFCs) em paralelo entre si e em paralelo com qualquer item de Tier 1/2 — são trabalho de análise, não competem por arquivo.
- ARCH-023 (exec_command) em paralelo com qualquer coisa — arquivo isolado, sem dependência.

**O que nunca deve ocorrer simultaneamente:**
- **ARCH-019 e ARCH-020** — ambos são cirurgias de grande porte em concerns de entrega/estado sobrepostos (`AgentLoop` ↔ `GoalExecutionLoop` trocam artefatos e callbacks constantemente); rodar os dois ao mesmo tempo maximiza risco de merge conflict e torna a revisão de code review inviável (ninguém revisa dois refactors de >1000 linhas simultâneos com confiança).
- **ARCH-012 e qualquer outro item do Epic B** — ARCH-012 é o item de maior risco do backlog inteiro; deve ser o último a rodar, com todo o resto do Epic B já estabilizado.

---

# FASE 5 — Planejamento das Sprints

Cada Sprint resolve **um único** problema arquitetural. Onde vários cards pequenos compartilham o mesmo objetivo real (ex.: os 3 itens de `StrategyDiversityGuard`), eles formam uma única Sprint porque são, na prática, um único esforço de engenharia.

### Sprint 0 — Higienização mecânica de fronteiras e duplicação textual
- **Objetivo arquitetural:** Eliminar violações de fronteira triviais e duplicação textual óbvia, sem qualquer risco funcional.
- **Itens:** ARCH-001, ARCH-002, ARCH-004, ARCH-014, ARCH-017, ARCH-023, ARCH-025, ARCH-026.
- **Arquivos envolvidos:** `tools/*.ts` (24), `core/ToolRegistry.ts`, `core/CapabilityRegistry.ts`, `loop/EnvironmentProbe.ts`, `loop/GoalEvaluator.ts`, `loop/ProactiveRecovery.ts`, `core/ToolExecutor.ts`, `tools/exec_command.ts`, `loop/GoalPlanner.ts`, `loop/AgentLoop.ts` (só a lista `DELIVERABLE_EXTENSIONS`).
- **Risco:** Baixo.
- **Estimativa:** Pequena (todos os itens são Quick Win, exceto ARCH-002/017 que são Refactor Local pequeno).
- **Critérios de aceite:** `tsc --noEmit` limpo; 0 ocorrências de import de `ToolExecutor`/`ToolResult` de `AgentLoop.ts`; `ToolExecutorService` com destino decidido.
- **Testes:** Unitário + regressão completa (118/118 ou o total vigente).
- **Rollback:** Cada item é revertível individualmente (commits pequenos e independentes).
- **Métricas:** Violações de fronteira → 0 nas categorias cobertas; Decision Owners parcialmente reduzido.

### Sprint 1 — Fonte única de artefatos entregues
- **Objetivo arquitetural:** Consolidar `Goal.sentArtifacts` como único registro de entrega.
- **Itens:** ARCH-005.
- **Arquivos envolvidos:** `loop/AgentLoop.ts`, `loop/GoalExecutionLoop.ts`.
- **Risco:** Alto.
- **Estimativa:** Grande.
- **Critérios de aceite:** Ver ARCH-005.
- **Testes:** Validação Progressiva completa até etapa 4 (ambiente real obrigatório).
- **Rollback:** Reverter o commit único e atômico.
- **Métricas:** Single Sources (artefatos entregues) → 1 fonte; Decision Owners (entrega) → 1 dono.

### Sprint 2 — Consistência de estado por goal (SSOT restante)
- **Objetivo arquitetural:** Eliminar as demais fontes de verdade concorrentes de estado por goal.
- **Itens:** ARCH-006, ARCH-007, ARCH-008, ARCH-009, ARCH-010.
- **Arquivos envolvidos:** `loop/GoalExecutionLoop.ts`, `loop/GoalTypes.ts`, `loop/agentLoopTypes.ts`, `loop/GoalEvaluator.ts`.
- **Risco:** Médio.
- **Estimativa:** Média-Grande.
- **Critérios de aceite:** Ver cards individuais.
- **Testes:** Unitário + regressão + e2e sintético; ARCH-008 exige ambiente real (cenário de restart).
- **Rollback:** Por item (5 commits independentes dentro da sprint).
- **Métricas:** Single Sources → reduzido em 4 conceitos; Recomputation Hotspots → reduzido.
- **Paralelizável com:** Sprint 3.

### Sprint 3 — Consolidação do `StrategyDiversityGuard`
- **Objetivo arquitetural:** Uma única fonte para "essa estratégia/tool já foi tentada".
- **Itens:** ARCH-003, ARCH-011, ARCH-016 (nesta ordem interna).
- **Arquivos envolvidos:** `loop/StrategyDiversityGuard.ts`, `loop/ResponseAdapter.ts`, `memory/CaseMemory.ts`, `memory/conversational/CMIIngestionPipeline.ts`, `loop/GoalPlanner.ts`.
- **Risco:** Médio.
- **Estimativa:** Média.
- **Critérios de aceite:** Ver cards individuais.
- **Testes:** Unitário (4 cenários de loop) + regressão.
- **Rollback:** Por item.
- **Métricas:** Recomputation Hotspots → 0 nesta área; Decision Owners (diversidade de replan) → 1 dono; Violações de fronteira → reduzido.
- **Paralelizável com:** Sprint 2.

### Sprint 4 — Unificação do juiz de sucesso de step
- **Objetivo arquitetural:** Um único avaliador de "o step teve sucesso relevante".
- **Itens:** ARCH-013.
- **Arquivos envolvidos:** `loop/GoalExecutionLoop.ts`, `loop/StepSemanticValidator.ts`.
- **Risco:** Médio.
- **Estimativa:** Média-Grande.
- **Critérios de aceite:** Ver ARCH-013.
- **Testes:** Validação Progressiva completa até etapa 4.
- **Rollback:** Reverter o commit.
- **Métricas:** Decision Owners → 1 dono para "sucesso de step".

### Sprint 5 — RFC: Contrato de entrega (`DeliveryTrackingContext`)
- **Objetivo arquitetural:** Produzir a análise de Fase 1-5 para consolidar os 5 callbacks de `ChannelContext`. Sem código.
- **Itens:** ARCH-024 (fase de RFC).
- **Arquivos envolvidos:** Nenhum tocado — só leitura/análise de `loop/agentLoopTypes.ts`, `loop/AgentLoop.ts`, `loop/GoalExecutionLoop.ts`.
- **Risco:** Nenhum (é análise).
- **Estimativa:** Pequena-Média.
- **Critérios de aceite:** Documento de Fase 1-5 completo, com decisão de implementar ou não.
- **Testes:** N/A.
- **Rollback:** N/A.
- **Métricas:** N/A (esta sprint não move indicador, prepara a que move).
- **Paralelizável com:** Sprints 2, 3, 4, 6.

### Sprint 6 — RFC: Args obrigatórios via schema
- **Objetivo arquitetural:** Produzir a análise de Fase 1-5 para gerar validação/prompt a partir do schema de cada tool. Sem código.
- **Itens:** ARCH-015 (fase de RFC).
- **Arquivos envolvidos:** Nenhum tocado — só leitura/análise.
- **Risco:** Nenhum.
- **Estimativa:** Pequena-Média.
- **Critérios de aceite:** Documento de Fase 1-5 completo.
- **Testes:** N/A.
- **Rollback:** N/A.
- **Métricas:** N/A.
- **Paralelizável com:** Sprints 2, 3, 4, 5.

### Sprint 7 — Implementação: `DeliveryTrackingContext`
- **Objetivo arquitetural:** Implementar a consolidação de callbacks aprovada na Sprint 5 (condicional).
- **Itens:** ARCH-024 (implementação).
- **Arquivos envolvidos:** `loop/agentLoopTypes.ts`, `loop/AgentLoop.ts`, `loop/GoalExecutionLoop.ts`.
- **Risco:** Alto.
- **Estimativa:** Grande.
- **Critérios de aceite:** Ver ARCH-024.
- **Testes:** Validação Progressiva completa até etapa 4.
- **Rollback:** Reverter.
- **Métricas:** Code Smells (Data Clump) → resolvido; Acoplamento → reduzido.
- **Condição:** Só ocorre se a Sprint 5 aprovar a implementação.

### Sprint 8 — Decomposição de `executeStep()`
- **Objetivo arquitetural:** Reduzir o terceiro maior método do projeto e eliminar a duplicação de blocos de falha.
- **Itens:** ARCH-022.
- **Arquivos envolvidos:** `loop/GoalExecutionLoop.ts`.
- **Risco:** Médio.
- **Estimativa:** Média-Grande.
- **Critérios de aceite:** Ver ARCH-022.
- **Testes:** Unitário + regressão + e2e sintético.
- **Rollback:** Reverter.
- **Métricas:** God Methods → -1; Code Smells (Duplicated Code) → resolvido.

### Sprint 9 — Decomposição de `runLoopInternal()` + `switch`
- **Objetivo arquitetural:** Reduzir o segundo maior método do projeto.
- **Itens:** ARCH-020 (inclui ARCH-021).
- **Arquivos envolvidos:** `loop/GoalExecutionLoop.ts`.
- **Risco:** Alto.
- **Estimativa:** Muito Grande.
- **Critérios de aceite:** Ver ARCH-020.
- **Testes:** Validação Progressiva completa até etapa 4.
- **Rollback:** Reverter (commit grande, atômico).
- **Métricas:** God Methods → -1; Large Classes (`GoalExecutionLoop.ts`) → linhas reduzidas.
- **Nunca simultânea com:** Sprint 10.

### Sprint 10 — Decomposição de `runWithTools()`
- **Objetivo arquitetural:** Reduzir o maior método do projeto.
- **Itens:** ARCH-019.
- **Arquivos envolvidos:** `loop/AgentLoop.ts`.
- **Risco:** Muito Alto.
- **Estimativa:** Muito Grande.
- **Critérios de aceite:** Ver ARCH-019.
- **Testes:** Validação Progressiva completa até etapa 4.
- **Rollback:** Reverter.
- **Métricas:** God Methods → -1 (o maior); Large Classes (`AgentLoop.ts`) → linhas reduzidas.
- **Nunca simultânea com:** Sprint 9.

### Sprint 11 — Implementação: Args obrigatórios via schema
- **Objetivo arquitetural:** Implementar a unificação aprovada na Sprint 6 (condicional).
- **Itens:** ARCH-015 (implementação).
- **Arquivos envolvidos:** `loop/GoalPlanner.ts`, `tools/*.ts`.
- **Risco:** Médio.
- **Estimativa:** Grande.
- **Critérios de aceite:** Ver ARCH-015.
- **Testes:** Validação Progressiva completa até etapa 4.
- **Rollback:** Reverter.
- **Métricas:** Decision Owners → 1 dono; Single Sources → 1 fonte.
- **Condição:** Só ocorre se a Sprint 6 aprovar a implementação.

### Sprint 12 — RFC + implementação condicional: Unificação de evidência de conclusão
- **Objetivo arquitetural:** Fundir `successCriteria` e `CLAIM_RULES`, e absorver `structuralBypass` em `evaluateCriteria`.
- **Itens:** ARCH-012, ARCH-018.
- **Arquivos envolvidos:** `loop/GoalTypes.ts`, `loop/GoalExecutionLoop.ts`.
- **Risco:** Alto (o mais alto do backlog).
- **Estimativa:** Muito Grande.
- **Critérios de aceite:** Ver ARCH-012/018.
- **Testes:** Validação Progressiva completa até etapa 4, incluindo replicação do bug de deadlock histórico como regressão permanente.
- **Rollback:** Se a RFC (dentro desta sprint) concluir que não vale o risco, a sprint encerra só com o documento de análise, sem código — resultado válido e esperado.
- **Métricas:** Single Sources → última fonte concorrente eliminada; Decision Owners → último dono duplicado eliminado.
- **Pré-requisito:** Todo o restante do backlog concluído e estável (é intencionalmente a última sprint).

---

# FASE 6 — Roadmap Executivo

| Sprint | Objetivo | Complexidade | Risco | Dependências | Impacto | Arquivos principais |
|---|---|---|---|---|---|---|
| 0 | Higienização mecânica de fronteiras | Baixa | Baixo | Nenhuma | Médio | `tools/*.ts`, `core/*.ts` |
| 1 | Fonte única de artefatos entregues | Alta | Alto | Sprint 0 | Muito Alto | `AgentLoop.ts`, `GoalExecutionLoop.ts` |
| 2 | Consistência de estado por goal | Média-Alta | Médio | Sprint 1 | Alto | `GoalExecutionLoop.ts`, `GoalTypes.ts` |
| 3 | Consolidação `StrategyDiversityGuard` | Média | Médio | Sprint 0 | Alto | `StrategyDiversityGuard.ts`, `GoalPlanner.ts` |
| 4 | Unificação do juiz de sucesso de step | Média-Alta | Médio | Sprint 2 | Alto | `GoalExecutionLoop.ts`, `StepSemanticValidator.ts` |
| 5 | RFC — Contrato de entrega | Baixa | Nenhum | — | Preparatório | (análise) |
| 6 | RFC — Args obrigatórios via schema | Baixa | Nenhum | — | Preparatório | (análise) |
| 7 | Implementação — `DeliveryTrackingContext` | Alta | Alto | Sprint 5 | Médio-Alto | `agentLoopTypes.ts`, `AgentLoop.ts` |
| 8 | Decomposição `executeStep()` | Média-Alta | Médio | Sprints 1, 2, 4 | Alto | `GoalExecutionLoop.ts` |
| 9 | Decomposição `runLoopInternal()` | Muito Alta | Alto | Sprints 1, 2 | Muito Alto | `GoalExecutionLoop.ts` |
| 10 | Decomposição `runWithTools()` | Muito Alta | Muito Alto | Sprints 1, 7, 8 | Muito Alto | `AgentLoop.ts` |
| 11 | Implementação — Args via schema | Alta | Médio | Sprint 6 | Alto | `GoalPlanner.ts`, `tools/*.ts` |
| 12 | Unificação de evidência de conclusão | Muito Alta | Muito Alto | Todo o resto | Alto | `GoalTypes.ts`, `GoalExecutionLoop.ts` |

---

# FASE 7 — Indicadores Arquiteturais

| Indicador | Estado Atual | Estado Esperado | Sprint responsável | Como medir |
|---|---|---|---|---|
| Violações de fronteira (runtime) | ~4 famílias (25 imports de tool contract + 1 round-trip core↔loop + 2 deps runtime de memory/) | 0 | Sprint 0, 3 | `grep` por imports cross-layer invertidos (`core/`→`loop/`, `memory/`→`loop/` fora de tipos neutros) |
| God Methods (>300 linhas) | 3 (`runWithTools` ~1793, `runLoopInternal` ~1030, `executeStep` ~375) | 0 | Sprints 8, 9, 10 | Contagem de linhas por método (script simples de análise estática) |
| Large Classes (>1500 linhas) | 2 (`GoalExecutionLoop.ts` 3515, `AgentLoop.ts` 2913) | Reduzido (meta realista: <2000 linhas cada — são orquestradores centrais, coesão é mais relevante que tamanho absoluto) | Sprints 9, 10 (consequência) | `wc -l` por arquivo |
| Single Sources (conceitos com múltiplas fontes) | ~8 (artefatos entregues, pending steps, step outcome, progressModel, tool results, retry history, estratégias, evidências) | 1 (evidências — só se ARCH-012 não for aprovada) a 0 | Sprints 1, 2, 3, 12 | Revisão manual do Knowledge Ownership Map por conceito |
| Decision Owners (decisões duplicadas) | ~6 (sucesso de step, conclusão de goal, entrega necessária, retry-worthy, dedup, args obrigatórios) | 0-1 | Sprints 1, 3, 4, 8, 11, 12 | Revisão manual do Decision Ownership Map por decisão |
| Code Smells confirmados | 6 categorias (Long Method x5, Large Class x2, Data Clump x2, Duplicated Code x1, Feature Envy parcial x1, Divergent Change x1) | Long Method e Duplicated Code → 0; Data Clump → 0-1 (Divergent Change do `exec_command.ts` é majoritariamente essencial, não deve ser "zerado" à força) | Sprints 3, 7, 8, 9, 10 | Revisão manual contra a lista da Auditoria III |
| Acoplamentos (imports cross-layer invertidos) | 4 famílias (mesmas de "Violações de fronteira") | 0 | Sprint 0, 3 | Mesmo grep de violações de fronteira |
| Dependências invertidas | Mesmas 4 famílias | 0 | Sprint 0, 3 | Mesmo grep |

---

# FASE 8 — Priorização

Critério explícito: **não priorizar por tamanho** — um item grande (ARCH-019) só é feito tarde porque depende de outros, não porque "é grande demais para agora". A ordem abaixo pondera valor arquitetural, redução de risco, redução de acoplamento, facilidade de rollback, facilidade de teste, esforço e frequência de manutenção — nessa ordem de peso.

1. **ARCH-001** (fronteira, import) — valor arquitetural alto, risco de execução quase zero, rollback trivial, testável por `tsc`. Prioridade máxima.
2. **ARCH-005** (fonte única de entrega) — maior valor arquitetural do backlog (aparece em 3 auditorias), mas risco alto — priorizado logo em seguida porque desbloqueia o maior número de itens subsequentes (redução de acoplamento futuro compensa o risco presente).
3. **ARCH-014, ARCH-017, ARCH-023, ARCH-025, ARCH-026** (Sprint 0, restante) — baixo esforço, baixo risco, alta frequência de manutenção futura se não corrigidos agora (cada um é um lugar a mais para esquecer de sincronizar).
4. **ARCH-002, ARCH-003, ARCH-004** (fronteira, restante) — valor arquitetural médio, risco médio, mas baixa urgência (não bloqueiam nada crítico).
5. **ARCH-006 a ARCH-010** (SSOT restante) — valor arquitetural alto, esforço médio, alta facilidade de teste (comportamento determinístico, fácil de cobrir com regressão).
6. **ARCH-011, ARCH-016** — valor arquitetural alto (elimina o achado mais nítido de recomputação do projeto), risco médio.
7. **ARCH-013** — valor arquitetural alto, mas risco médio-alto por envolver latência/custo de LLM real — exige etapa 4 da Validação Progressiva, não pode ser apressado.
8. **ARCH-022** — facilidade de teste boa (método menor, mais localizado que 019/020), prioridade antes dos dois maiores.
9. **ARCH-020** antes de **ARCH-019** — `GoalExecutionLoop` tem mais dependências de outros itens já resolvidas neste ponto do roadmap; `AgentLoop` fica para depois de sua própria RFC de contrato (ARCH-024) amadurecer.
10. **ARCH-015, ARCH-024** (RFCs) — podem ser adiantadas no calendário (rodam em paralelo, Sprints 5/6), mas a IMPLEMENTAÇÃO delas é de baixa urgência relativa — ficam depois dos itens de maior redução de acoplamento.
11. **ARCH-012 + ARCH-018** — último, por ser o item de maior risco e exigir todo o resto estável como pré-condição de segurança.

---

# FASE 9 — Validação

**O backlog cobre TODOS os problemas encontrados?**
Sim. As 26 recomendações citadas nas 4 auditorias (Quick Wins + Refactors Estruturais + RFCs de cada uma) mapeiam 1:1 ou consolidadas para os 26 cards ARCH-001 a ARCH-026 (com ARCH-021 formalmente absorvido em ARCH-020, documentado explicitamente, não omitido). Os itens que as auditorias verificaram como corretos (Goal Status, Capabilities, fronteira Channel↔Core, `ERROR_PATTERNS` como dado) estão listados na seção "Itens já verificados como corretos" para rastreabilidade, sem virar card.

**Existe item duplicado?**
Não. Onde o mesmo problema apareceu em mais de uma auditoria, foi consolidado em um único card com múltiplas origens registradas: ARCH-005 (Auditorias I, II, III), ARCH-013 (Auditorias I, III), ARCH-016 (Auditorias I, III), ARCH-015 (Auditoria I, referenciado sem achado novo na II).

**Existe Sprint com objetivos misturados?**
Não — cada Sprint tem um objetivo arquitetural único. A Sprint 3 agrupa 3 cards (ARCH-003/011/016), mas os três resolvem o MESMO objetivo (`StrategyDiversityGuard` como dono único de detecção de repetição), não objetivos diferentes. A Sprint 12 agrupa ARCH-012 e ARCH-018 pelo mesmo motivo (ambos são "avaliação de conclusão do goal").

**Existe dependência circular?**
Não. O DAG da Fase 4 foi construído em camadas (Tier 0 → 5) sem nenhum item de tier inferior depender de um tier superior. Verificação explícita: ARCH-005 não depende de nada que dependa dele; ARCH-019/020 dependem de ARCH-005/009 mas nada em Epic B depende de Epic D.

**Existe Sprint grande demais?**
As Sprints 9 e 10 (decomposição de `runLoopInternal`/`runWithTools`) são as maiores em estimativa ("Muito Grande"), mas não estão sobre-escopadas — cada uma resolve um único método, é o tamanho real do método que é grande, não um acúmulo de objetivos na sprint. Não há redução de escopo possível sem deixar o método parcialmente decomposto (pior estado que o atual).

**Existe Quick Win que deveria vir antes?**
Não — todos os Quick Wins identificados nas 4 auditorias já estão na Sprint 0 (a primeira do roadmap), exceto os que têm uma dependência técnica real que os empurra para depois (ARCH-011 depende de ARCH-003; ARCH-016 depende de ARCH-011).

**Existe Refactor Estrutural bloqueado por outro item?**
Sim, e é intencional: ARCH-019/020 são bloqueados por ARCH-005/009 (e outros); ARCH-022 é bloqueado por ARCH-013; ARCH-012 é bloqueado por praticamente todo o resto do Epic B. Isso reflete a ordem de segurança real (não dá para decompor um método que lê estado fragmentado sem herdar a fragmentação) — não é um defeito do backlog, é o motivo pelo qual o DAG existe.

---

## Resumo executivo

O backlog contém **26 cards arquiteturais**, agrupados em **5 Epics**, executados em **13 Sprints** (0 a 12), com três RFCs formais (ARCH-012, ARCH-015, ARCH-024) que podem resultar em "não implementar" como desfecho válido. O maior valor concentrado está em um único item (ARCH-005, fonte única de artefatos entregues), citado por 3 das 4 auditorias — é o item que mais desbloqueia trabalho subsequente e deveria ser tratado como a prioridade estratégica real do próximo trimestre de engenharia, à frente até dos Quick Wins de fronteira (que são mais fáceis, mas de impacto individual menor). Os itens de maior risco (Sprints 9, 10, 12) foram deliberadamente sequenciados para o fim do roadmap, depois que a fundação de estado único (Epic B) já estiver validada em ambiente real — consistente com a exigência já registrada em `DIRETRIZ_ARQUITETURA_2026-07-13.md` de que mudanças estruturais não sejam consideradas concluídas sem a etapa 4 da Validação Progressiva.
