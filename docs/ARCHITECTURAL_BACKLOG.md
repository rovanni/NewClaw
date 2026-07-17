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

### ARCH-002 — Resolver travessia de camada `core/CapabilityRegistry` ↔ `loop/EnvironmentProbe` ↔ `core/ToolRegistry`
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

### ARCH-003 — Extrair `StrategyDiversityGuard.fingerprint()`/`ResponseAdapter.extractText()` para local neutro
- **Descrição:** `memory/CaseMemory.ts` importa a classe `StrategyDiversityGuard` (runtime, não só tipo) de `loop/`; `memory/conversational/CMIIngestionPipeline.ts` importa a função `extractText` de `loop/ResponseAdapter.ts`. Ambas são utilitários pequenos e sem estado que não dependem de `AgentLoop`/`GoalExecutionLoop` — podem migrar para `src/shared/` sem quebrar quem já as usa em `loop/`.
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

### ARCH-005 — Fonte única de artefatos entregues
- **Descrição:** O fato "o que já foi entregue ao usuário" existe em 4 estruturas sem sincronização automática: `Goal.sentArtifacts` (persistido), `cycleHistory` do `AgentLoop` (efêmero por sub-turno), a varredura de filesystem em `deliverable_check` (`GoalExecutionLoop.ts`), e o `structuralBypass` (stat direto de um path). Consolidar para que `Goal.sentArtifacts` seja o único registro, com os outros três lendo/escrevendo nele em vez de recalcular a resposta.
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

### ARCH-006 — Accessor único `getPendingSteps(goal, toolName?)`
- **Descrição:** `.filter(s => s.status === 'pending')` é recalculado inline em 6+ pontos de `GoalExecutionLoop.ts`. Substituir por um accessor único.
- **Arquivos afetados:** `src/loop/GoalExecutionLoop.ts` (L614, L619-622, L645-647, L894-898, L1024-1027, L3362-3364).
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

### ARCH-007 — Sincronizar `PlanStep.status`/`.result` com `GoalAttempt.result`
- **Descrição:** Um `PlanStep` pode ficar `status: 'completed'` enquanto o `GoalAttempt` correspondente foi rebaixado para `'partial'` — a ordem real de execução em `GoalExecutionLoop.ts` (downgrade semântico roda antes do `markStepDone('skip')`) confirma o caso. Dois vocabulários (`status` sem `'partial'`; `result` sem `'pending'`/`'skipped'`) sem tradução formal entre eles.
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

### ARCH-008 — `progressModel` derivado sob demanda de `goal.attempts`/`successCriteria`
- **Descrição:** `state.cognitiveContext` já recebeu o tratamento de "derivar de `goal.attempts` a cada chamada" via `buildIncrementalExecutionContext()` — restart-safe. `state.progressModel` não recebeu o mesmo tratamento: reseta para `{components:[], overallPercent:0}` a cada `runLoop()`, incluindo após recovery pós-restart, mesmo quando `goal.attempts`/`successCriteria` já provam progresso real.
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

### ARCH-009 — `CycleResult`/`GoalAttempt` estenderem `ToolResult` em vez de redeclarar `output`/`error`
- **Descrição:** `ToolResult` → `CycleResult` → `GoalAttempt` redeclaram os mesmos 2 campos (`output`, `error`) 3 vezes de forma independente. Qualquer campo novo de proveniência de tool exige decidir, cada vez, em qual das 3 camadas ele deveria viver.
- **Arquivos afetados:** `src/loop/agentLoopTypes.ts` (`ToolResult`), `src/loop/GoalTypes.ts` (`CycleResult`, `GoalAttempt`).
- **Origem (auditorias):** Auditoria II.
- **Categoria:** Single Source of Truth.
- **Classificação:** Refactor Local.
- **Impacto:** Médio (reduz superfície de manutenção futura, não corrige bug hoje).
- **Risco:** Médio — mudança de tipos com superfície ampla (todo consumidor de `CycleResult`/`GoalAttempt`).
- **Esforço:** Médio.
- **Dependências:** Recomendado antes de ARCH-013, ARCH-019, ARCH-020, ARCH-022 (todos constroem/consomem esses tipos — fazer isso cedo reduz churn nos refactors maiores).
- **Pré-requisitos:** Nenhum.
- **Critérios de Aceite:** `output`/`error` são declarados uma única vez; `CycleResult`/`GoalAttempt` estendem/referenciam `ToolResult`.
- **Definition of Done:** `tsc --noEmit` limpo, regressão 100%.
- **Rollback:** Reverter.
- **Testes obrigatórios:** `tsc --noEmit` + regressão completa.
- **Métrica que deverá melhorar:** Single Sources.

### ARCH-010 — Índice incremental de retry por (step, args-hash)
- **Descrição:** `GoalEvaluator.alreadyFailed` faz um scan O(n) de todo `goal.attempts` com `JSON.stringify` a cada falha, sem contador/índice incremental.
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

### ARCH-011 — `StrategyDiversityGuard.extractUsedFingerprints` ler `goal.toolsTried` em vez de regex sobre `strategiesTried`
- **Descrição:** O achado mais nítido de recomputação da Auditoria II: `goal.toolsTried` já guarda a sequência de tools de forma estruturada, mas `extractUsedFingerprints()` reconstrói a mesma informação via regex sobre o texto livre de `strategiesTried`.
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

### ARCH-012 — RFC: Unificar `Goal.successCriteria` e `checkClaimsAgainstEvidence.CLAIM_RULES`
- **Descrição:** Duas formas paralelas de responder "existe prova de que X foi cumprido": uma estruturada e decidida no plano inicial (`successCriteria`), outra inferida por regex sobre a prosa de outro LLM (o validador) depois do fato (`CLAIM_RULES`). Fontes diferentes, momentos diferentes, nenhuma referencia a outra.
- **Arquivos afetados:** `src/loop/GoalTypes.ts` (`SuccessCriterion`), `src/loop/GoalExecutionLoop.ts` (L3240-3387 `checkClaimsAgainstEvidence`, L2945-3228 `validateGoalCompletion`).
- **Origem (auditorias):** Auditoria II.
- **Categoria:** Single Source of Truth.
- **Classificação:** Exige RFC.
- **Impacto:** Alto.
- **Risco:** Alto — dois momentos/LLMs diferentes hoje; fundir exige repensar QUANDO a evidência é coletada, não é uma refatoração mecânica.
- **Esforço:** Alto.
- **Dependências:** ARCH-005 (fonte única de entrega), ARCH-018 (evaluateCriteria absorvendo structuralBypass) devem estar concluídos antes — este item deve ser o último do Epic B.
- **Pré-requisitos:** Documento de Fase 1-5 completo (`DIRETRIZ_ARQUITETURA_2026-07-13.md`) antes de qualquer código.
- **Critérios de Aceite:** Definidos na própria RFC (Fase 4/5 da diretriz).
- **Definition of Done:** RFC aprovada com riscos documentados E, se aprovada para implementação, Validação Progressiva completa até etapa 4.
- **Rollback:** Se a RFC concluir que o risco supera o benefício, o item é encerrado sem código — resultado válido.
- **Testes obrigatórios:** N/A na fase de RFC; se implementado, unitário + regressão + e2e + ambiente real.
- **Métrica que deverá melhorar:** Single Sources, Decision Owners.

---

## Epic C — Decision Ownership
*Origem: Auditoria I.*

### ARCH-013 — Unificar juiz de sucesso de step
- **Descrição:** `evaluateAgentStepSuccess`+`escalateStepEvalToLLM` (heurística própria + LLM própria, "SUCESSO ou FALHA", 15s) e `StepSemanticValidator` (keyword+LLM, "ENDEREÇA a intenção", 8s) rodam em sequência para o mesmo step `agentloop`. Fundir a escalação de `evaluateAgentStepSuccess` dentro de `StepSemanticValidator`, mantendo só a extração determinística (sem LLM) fora dele.
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

### ARCH-014 — Unificar regex de erro transiente entre `GoalEvaluator` e `ProactiveRecovery`
- **Descrição:** `GoalEvaluator.ERROR_PATTERNS[].isRetryable` (nível goal) e `ProactiveRecovery.RECOVERY[tool].retryablePatterns` (nível tool) têm regex parcialmente sobrepostas (`ECONNRESET`/`ETIMEDOUT`/`timeout`) mantidas independentemente.
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

### ARCH-015 — RFC: Args obrigatórios gerados do schema da tool
- **Descrição:** "Quais argumentos são obrigatórios" é declarado em 5 lugares independentes: `parameters.required` de cada tool, `detectMissingRequiredArgs()` (hardcoded), o guard interno de cada `execute()`, `buildToolContracts()` e os blocos de prompt do Planner. Gerar validação + texto de prompt a partir do schema elimina a sincronização manual.
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

### ARCH-016 — Consolidar detecção de loop em `StrategyDiversityGuard`
- **Descrição:** `GoalPlanner.buildReplanPrompt()` tem 4 blocos artesanais e paralelos de detecção de repetição (`pipVenvLoopDirective`, `execCommandBanDirective`, `stuckInAnalysis`/`implementDirective`, `contentStubDirective`), cada um recontando `blockers`/`strategiesTried` com critério próprio, nenhum reusando `StrategyDiversityGuard.extractExhaustedTools()` (que já existe e já resolve "tool falhou ≥N vezes"). Além de trocar a fonte de dados, extrair um template comum (`buildLoopDirective`) para os 4 blocos de texto, hoje quase idênticos.
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

### ARCH-017 — Decidir destino do `ToolExecutorService`/`CircuitBreaker` morto
- **Descrição:** `core/ToolExecutor.ts` (`ToolExecutorService`, com `CircuitBreaker` completo) tem 0 call sites reais — nem `GoalExecutionLoop`, nem `ProactiveRecovery`, nem `AgentLoop` o usam; `AgentController.getToolExecutor()` também não tem caller. Toda execução real passa por `ProactiveRecovery.execute()` direto.
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

### ARCH-018 — `evaluateCriteria` absorve `structuralBypass` como `CriterionCheck`
- **Descrição:** `structuralBypass` (`GoalExecutionLoop.ts` L634-669) é um desvio de código solto dentro de `runLoopInternal` que faz `fs.statSync` direto para decidir "já pode considerar entregue". `file_exists` já existe como `CriterionCheck` — expressar o bypass como mais um critério elimina o `if` ad-hoc.
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

### ARCH-019 — Decompor `AgentLoop.runWithTools()` (~1793 linhas)
- **Descrição:** Maior método do projeto — é praticamente a classe inteira depois do construtor. Decompor em fases nomeadas (parse de tool call, dispatch, delivery-guard, orçamento de steps, etc.), sem mudar comportamento.
- **Arquivos afetados:** `src/loop/AgentLoop.ts` (L1118-2911).
- **Origem (auditorias):** Auditoria III (Hotspot #1, Muito Alta).
- **Categoria:** Structural Simplification.
- **Classificação:** Refactor Estrutural.
- **Impacto:** Muito Alto.
- **Risco:** Alto — closures capturando `cycleHistory`, `usedToolInputs`, `stepCount` por referência; sem teste de sistema que cubra a função inteira.
- **Esforço:** Muito Alto.
- **Dependências:** ARCH-005, ARCH-007 (implementação do novo contrato de callbacks). **Nunca simultâneo com ARCH-020** (mesmo WIP-limit: ambos são cirurgias grandes em concerns de entrega/estado sobrepostos — risco de merge conflict e fadiga de revisão).
- **Pré-requisitos:** Mapear TODOS os efeitos colaterais capturados por closure antes de extrair qualquer método.
- **Critérios de Aceite:** Nenhum método resultante da decomposição excede 300 linhas; comportamento observável idêntico.
- **Definition of Done:** Validação Progressiva completa até etapa 4.
- **Rollback:** Reverter o commit (grande, mas atômico).
- **Testes obrigatórios:** Unitário + regressão completa + e2e sintético + ambiente real (fluxo completo de tool-calling com LLM real).
- **Métrica que deverá melhorar:** God Methods (Indicador #2), Large Classes (Indicador #3).

### ARCH-020 — Decompor `GoalExecutionLoop.runLoopInternal()` (~1030 linhas) + `switch(cycleResult.outcome)`
- **Descrição:** Segundo maior método do projeto. Contém dentro de si o `switch` de outcome (~400 linhas) — decompor ambos juntos: cada `case` vira um método nomeado (`handleSuccessOutcome`, `handlePartialOutcome`, etc.), e o corpo restante de `runLoopInternal` vira fases nomeadas.
- **Arquivos afetados:** `src/loop/GoalExecutionLoop.ts` (L570-1602).
- **Origem (auditorias):** Auditoria III (Hotspot #2 e #3).
- **Categoria:** Structural Simplification.
- **Classificação:** Refactor Estrutural.
- **Impacto:** Muito Alto.
- **Risco:** Alto (mesma natureza do ARCH-019, arquivo central do sistema de goals).
- **Esforço:** Muito Alto.
- **Dependências:** ARCH-005, ARCH-006, ARCH-007, ARCH-008, ARCH-009. **Nunca simultâneo com ARCH-019.**
- **Pré-requisitos:** Mesma exigência de mapeamento de efeitos colaterais do ARCH-019.
- **Critérios de Aceite:** Nenhum método resultante excede 300 linhas.
- **Definition of Done:** Validação Progressiva completa até etapa 4.
- **Rollback:** Reverter.
- **Testes obrigatórios:** Unitário + regressão + e2e sintético + ambiente real.
- **Métrica que deverá melhorar:** God Methods, Large Classes.

### ARCH-021 — (absorvido em ARCH-020)
- **Nota:** O achado original da Auditoria III ("quebrar o switch em métodos por case") é tratado como parte integrante de ARCH-020, não como item separado — o switch vive fisicamente dentro de `runLoopInternal` e não pode ser decomposto de forma segura isoladamente sem repetir o mapeamento de efeitos colaterais já exigido pelo item pai.

### ARCH-022 — Decompor `GoalExecutionLoop.executeStep()` (~375 linhas) + eliminar 4 blocos duplicados
- **Descrição:** Extrair um helper `recordFailedAttempt(goal, step, {error, output, cycle})` para os 4 blocos quase idênticos de "construir `GoalAttempt` de falha + persistir + avaliar" (guarda de step-name-as-path, botões de auth, catch, e o próprio fluxo principal). Depois, separar o método em: dispatch direto (tool) vs dispatch `agentloop` vs pós-processamento (registro de attempt, tracking, dedup).
- **Arquivos afetados:** `src/loop/GoalExecutionLoop.ts` (L1605-1978).
- **Origem (auditorias):** Auditoria III (Hotspot #4, SC1, SC5).
- **Categoria:** Structural Simplification.
- **Classificação:** Refactor Local (o helper) + Refactor Estrutural (a decomposição do método).
- **Impacto:** Alto.
- **Risco:** Médio (menor que ARCH-019/020 — método menor e mais localizado).
- **Esforço:** Médio-Alto.
- **Dependências:** ARCH-005, ARCH-009, ARCH-013 (simplificar o juiz de sucesso antes reduz a lógica a decompor).
- **Pré-requisitos:** Nenhum além das dependências.
- **Critérios de Aceite:** Nenhum bloco de "registrar falha" duplicado; método principal com sub-métodos claros.
- **Definition of Done:** Regressão 100% + e2e sintético.
- **Rollback:** Reverter.
- **Testes obrigatórios:** Unitário (os 4 cenários de falha) + regressão + e2e sintético.
- **Métrica que deverá melhorar:** God Methods, Code Smells (Duplicated Code).

### ARCH-023 — Explicitar pipeline de fixups do `exec_command.ts`
- **Descrição:** ~12 funções puras de correção (marp/pandoc/PowerShell/CLIXML) são aplicadas via `if`s sequenciais dentro de `execute()`, com ordem importando implicitamente (comentários dizem "roda por ÚLTIMO"). Expressar como uma lista nomeada de transformações aplicadas em sequência explícita torna a ordem auditável sem mudar o resultado.
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

### ARCH-024 — RFC + Implementação: `DeliveryTrackingContext` (consolidar callbacks de `ChannelContext`)
- **Descrição:** 5 campos de callback (`deferSendDocument`, `isDeferredArtifact`, `onArtifactDelivered`, `isAudioAlreadySent`, `recentMessages`) foram acumulados em `ChannelContext` um a um, cada um resolvendo um bug pontual — nenhum é sobre o canal (Telegram/Discord/Web), todos são sobre rastreamento de entrega de goal. Consolidar num contrato dedicado.
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

### ARCH-025 — Extrair blocos de prompt duplicados entre `buildPlanPrompt`/`buildReplanPrompt`
- **Descrição:** "ARGS OBRIGATÓRIOS POR FERRAMENTA"/"REFERÊNCIA DE ARGS OBRIGATÓRIOS" e "COLETA EM LOTE" são ~95% texto idêntico, copiado à mão duas vezes em `GoalPlanner.ts`.
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

### ARCH-026 — Unificar `DELIVERABLE_EXTENSIONS` em `inferExpectedExtensions.ts`
- **Descrição:** `AgentLoop.ts` mantém uma lista fixa própria (`DELIVERABLE_EXTENSIONS`) separada da lógica de inferência já centralizada em `planning/inferExpectedExtensions.ts` (que já unificou `SOURCE_SCRIPT_EXTENSIONS` antes).
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
