# Fase 3 — Auditoria de Impacto de Implementação (RFC-003)

> Esta não é uma auditoria da RFC — a RFC já responde "como deve funcionar" e está aprovada
> (`docs/decisoes/RFC-003_AQUISICAO_CONHECIMENTO_OPERACIONAL.md`, Fases 1 e 1b concluídas, Fase 2 —
> alinhamento documental — concluída). Este documento responde a pergunta seguinte: **onde isso
> impacta o código real, hoje?** Cada linha abaixo foi verificada lendo o arquivo citado nesta
> mesma data (2026-07-27), não inferida da RFC sozinha.
>
> Convenção desta categoria de documento: `docs/CONVENCOES_DOCUMENTAIS.md` → análise contida,
> seguindo o processo de 5 fases da Diretriz, que ainda não abre um programa de várias Sprints —
> o esboço de Sprints ao final é intencionalmente leve (ordem e escopo, não desenho detalhado);
> quando a Sprint A de fato começar, ela ganha sua própria pasta de programa, não antes.

---

## 1. Auditoria de Impacto por Componente

| Componente | Muda? | Impacto | Evidência (arquivo:linha) |
|---|---|---|---|
| `GoalExecutionLoop.handleNeedsDependencyOutcome()` | ✅ muda | **Alto** | `src/loop/GoalExecutionLoop.ts:866-920` — hoje só consulta `KNOWN_DEPS` via `cycleResult.depInfo`/`resolveInstallCommand()`; nunca consulta `OperationalKnowledge`. Precisa de um novo branch: sem entrada em `KNOWN_DEPS` (ou sem comando resolvido para o SO), checar elegibilidade tática em `OperationalKnowledge` antes de cair no caminho manual atual. |
| `GoalEvaluator.evaluate()` (classificação `missing_tool`) | ✅ muda | **Médio-Alto** | `src/loop/GoalEvaluator.ts:280-304` — hoje resolve `dep = KNOWN_DEPS[missingCmd]` e para se não encontrar. Precisa consultar `OperationalKnowledge` como segunda fonte antes de desistir (ordem "Reutilização" da RFC-003: 1. Distribuído, 2. Aprendido, 3. Novo ciclo). |
| `KNOWN_DEPS` (o catálogo em si, dados) | ❌ não muda | — | RFC-003 é explícita: conhecimento aprendido nunca escreve automaticamente aqui. Nenhuma entrada, nenhum campo novo. |
| `OperationalKnowledge` | ✅ muda | **Alto** | `src/memory/OperationalKnowledge.ts` — faltam: (1) método de consulta "elegível a atalho tático" (hoje só existe `buildEvidenceHint()`, informativo; falta algo como `isTacticallyEligible(tool, platform)` aplicando o limiar de RFC-001 §2); (2) validação objetiva na captura — `captureFromGoal()` hoje credita sucesso por heurística ("próximo exec_command deu certo"), RFC-003 exige comando de verificação explícito; (3) campo de origem/fonte (pesquisa vs. improviso do LLM) para rastreabilidade. |
| `GoalPlanner` | ✅ muda | **Médio** | `src/loop/GoalPlanner.ts:490-502,751-842` — já tem o padrão exato a reaproveitar: `operationalSection`/`buildEvidenceHint()` já injeta conhecimento aprendido como bloco de evidência (`operationalSection` na linha 502). Precisa de um bloco irmão para candidatos de pesquisa nova (saída de "Pesquisar"), mesma forma, sem novo mecanismo de composição de prompt. |
| `resolveInstallCommand()` | ⚠️ talvez | **Baixo-Médio** | `src/loop/planning/resolveInstallCommand.ts` — função pura, só consome `DependencyInfo`. Decisão de design em aberto (não resolvida por esta auditoria, cabe ao Sprint de design): a checagem de elegibilidade tática do `OperationalKnowledge` fica **dentro** desta função (estendendo a assinatura) ou **ao lado dela**, em `GoalExecutionLoop`/`GoalEvaluator`? Ambas preservam o princípio "Nunca Adivinhar" da função; a escolha é só de organização de código. |
| `CapabilityRegistry`/`EnvironmentProbe` | ⚠️ talvez | **Baixo** | `src/core/CapabilityRegistry.ts:86-112` já detecta `platform`, `distro`, `packageManager`, `architecture`, `containerized` — cobre a maior parte de "Descoberta" (RFC-003). Não detecta privilégio elevado (admin/root) nem ambiente virtual Python ativo, ambos citados como exemplos de descoberta na RFC. Podem ser adicionados como campos novos (aditivos) se o Sprint de design decidir que são necessários para a primeira fatia — não são bloqueantes. |
| `PromptComposer.buildCompactEnv()` | ⚠️ talvez | **Baixo** | `src/core/PromptComposer.ts` — só muda **se** `CapabilityRegistry` ganhar os campos novos acima; precisaria incluí-los no bloco `[CAPACIDADES DO AMBIENTE]`. Consequência direta do item anterior, não uma decisão independente. |
| `PermissionRegistry`/`CapabilityMode` | ❌ não muda | — | `src/core/CapabilityMode.ts:53,67,81` já tem `install_dependencies: false` (SAFE) / `true` (DEVELOPER) / `true` (GOD) — exatamente o gate que a RFC-003 usa, verificado contra o código real na consolidação da RFC. Nenhuma capability nova necessária. |
| `RiskAnalyzer`/`isDestructive()` | ❌ não muda | — | A RFC-003 é explícita: bloqueios de segurança absolutos continuam se aplicando integralmente a qualquer execução, tática ou não — já rodam hoje para todo `exec_command`, independente de origem. Nenhuma mudança necessária para preservar essa garantia. |
| `sanitizePlanSteps.ts` | ❌ não muda | — | Valida dependência **entre steps de um plano já decidido** (`TOOL_DEPENDENCY_ARG` etc.) — camada ortogonal ao ciclo de aquisição, que decide **se** e **como** uma hipótese de instalação é formada, não a integridade estrutural de steps dentro de um plano. |
| `ReflectionMemory` | ❌ não muda | — | RFC-003 explicitamente não se estende a este componente. Observação para a etapa de testes (não é mudança de código): uma falha de validação de hipótese tática pode ser candidata simultânea a `OperationalKnowledge.failure_count` e a um padrão de falha genérico de `ReflectionMemory` — vale um teste de regressão verificando que as duas contagens coexistem sem se anular, não uma alteração de arquitetura. |
| `CaseMemory` | ❌ não muda | — | Captura por nível de goal, agnóstica a **como** o goal foi resolvido por baixo (`CaseMemory.captureIfEligible()`, chaveado por embedding do objetivo do usuário) — um goal que passou pelo novo ciclo continua sendo capturado exatamente como qualquer outro goal validado, sem nenhuma mudança necessária no componente. Diferente do exemplo do usuário (que marcou "talvez"): com a RFC-003 lida com atenção, a resposta é definitivamente "não muda". |
| Skill `dependency-curator` | ❌ não muda | — | RFC-003 mantém o caminho assíncrono (humano aciona, relatório, PR) inteiramente inalterado — os dois caminhos coexistem por desenho (`PIPELINE_CURADORIA_DEPENDENCIAS.md` §6, adendo já registrado na Fase 2). |
| `ToolRegistry` / tools `web_search`, `web_navigate` | ❌ não muda | — | `src/tools/web_search.ts` e `src/tools/web_navigate.ts` já existem e já são tools registradas e utilizáveis por um goal comum — "Pesquisar" (RFC-003) reaproveita essas tools existentes, não precisa de nenhuma tool nova (Gate de Extensão antes de Criação já satisfeito por reuso). |

---

## 2. Matriz de Responsabilidade

| Componente | Nova responsabilidade (se houver) | Mudou? |
|---|---|---|
| `GoalExecutionLoop` | Orquestrar o ciclo: checar `OperationalKnowledge` antes de desistir, injetar step de pesquisa quando elegível por modo, aplicar condição de parada pelo orçamento já existente | ✅ |
| `GoalEvaluator` | Consultar `OperationalKnowledge` como segunda fonte na classificação `missing_tool`, antes do caminho manual | ✅ |
| `OperationalKnowledge` | Validar objetivamente antes de creditar sucesso; expor consulta de elegibilidade tática; registrar origem/fonte do conhecimento | ✅ |
| `GoalPlanner` | Apresentar candidatos de pesquisa nova como bloco de evidência (mesma forma de `operationalSection` já existente) — **nunca** escolher entre eles sozinho | ✅ |
| `resolveInstallCommand` | Nenhuma nova responsabilidade decidida ainda — ponto de design em aberto | ⚠️ (decisão pendente) |
| `CapabilityRegistry` | Possível: detectar privilégio elevado e ambiente virtual ativo | ⚠️ (decisão pendente) |
| `KNOWN_DEPS` | Nenhuma | ❌ |
| `PermissionRegistry`/`CapabilityMode` | Nenhuma — gate já existe (`install_dependencies`) | ❌ |
| `RiskAnalyzer` | Nenhuma — já cobre qualquer execução, sem exceção | ❌ |
| `sanitizePlanSteps` | Nenhuma | ❌ |
| `ReflectionMemory` | Nenhuma (só observação de coexistência para testes) | ❌ |
| `CaseMemory` | Nenhuma | ❌ |
| Skill `dependency-curator` | Nenhuma | ❌ |
| `ToolRegistry`/`web_search`/`web_navigate` | Nenhuma — reuso puro | ❌ |

Esta tabela existe para o mesmo motivo que a RFC-003 já registrou explicitamente para si mesma: impedir o efeito "já que estou aqui vou colocar isso neste componente" — qualquer step de implementação que altere uma linha marcada ❌ acima deve primeiro justificar por que a auditoria estava errada, não simplesmente incluir a mudança de passagem.

---

## 3. Esboço de Sprints (ordem e escopo — não desenho detalhado)

Leve de propósito — cada Sprint ganha seu próprio desenho (e, se a soma virar um programa de fato,
sua própria pasta `docs/<nome>-2026-07-27/`) só quando começar de verdade, não antes:

1. **Sprint A — Infraestrutura**: método de consulta de elegibilidade tática em
   `OperationalKnowledge` (sem mudar `captureFromGoal()` ainda); decisão de design sobre onde a
   checagem tática se encaixa (`resolveInstallCommand` vs. caminho paralelo).
2. **Sprint B — Discovery**: extensão pontual de `CapabilityRegistry` (privilégio elevado, venv)
   **se** o Sprint A concluir que são necessários para a primeira fatia real.
3. **Sprint C — Research**: novo branch em `handleNeedsDependencyOutcome()`/`GoalEvaluator.evaluate()`
   que aciona pesquisa (via `web_search`/`web_navigate` já existentes) quando `KNOWN_DEPS` e
   `OperationalKnowledge` não resolvem, gated por `permissionRegistry.can('install_dependencies')`.
4. **Sprint D — Validation**: comando de verificação explícito por dependência, fechando a lacuna
   já registrada em `OperationalKnowledge.captureFromGoal()`.
5. **Sprint E — OperationalKnowledge**: aplicar o modelo de confiança de dois níveis (RFC-001 §2)
   à nova origem de conhecimento (pesquisa mediada pelo Planner), sem redefinir o modelo existente.
6. **Sprint F — Integração**: bloco de evidência novo em `GoalPlanner` para candidatos de pesquisa;
   condição de parada amarrada ao orçamento existente (`retryBudget`/`replanBudget`).
7. **Sprint G — Testes**: Validação Progressiva completa (`docs/DIRETRIZ_ARQUITETURA_2026-07-13.md`)
   — unitário → regressão → e2e sintético → ambiente real, incluindo o caso real que originou toda
   esta investigação (`ffmpeg` ausente no Windows) e a observação de coexistência com
   `ReflectionMemory` (Seção 1 acima).

---

## 4. Ponto em aberto que esta auditoria não resolve (propositalmente)

A decisão sobre **onde** a checagem de elegibilidade tática do `OperationalKnowledge` se encaixa
(dentro de `resolveInstallCommand()` vs. paralela a ela) é implementação, não arquitetura — a RFC-003
não precisa decidir isso, e esta auditoria também não decide, para não antecipar um Sprint que
ainda não começou. Fica registrado aqui como a primeira pergunta concreta do Sprint A.
