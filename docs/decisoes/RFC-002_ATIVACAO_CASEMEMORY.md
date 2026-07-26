# RFC-002 — Ativação Plena do CaseMemory (S5, sub-etapa 4/4)

> Status: aprovada, implementação nesta mesma sessão (24/07/2026).
> Origem: `docs/RFC-001_APRENDIZADO_OPERACIONAL.md` já mapeava `CaseMemory` como um dos 3
> componentes de conhecimento existentes (Seção 8, matriz); `docs/ADR-001_BASELINE_ARQUITETURAL.md`
> (decisão 4) manteve `CaseMemory` "especializado em sucesso relacionado a objetivo, em modo
> sombra" como baseline aprovada. Este documento não reabre nenhuma dessas decisões — cobre
> apenas a sub-etapa final do roadmap já definido (memória `project_session_bugs_jul2026_s`):
> "recuperar em modo sombra → **ativar de verdade**".

## 1. Estado atual (Fase 1 — Compreensão)

`src/memory/CaseMemory.ts` (546 linhas, sprints S5-S7 já documentadas no próprio módulo) já
implementa integralmente:

- **Captura** (`captureIfEligible`): só grava com evidência de nível de goal (`successCriteria`
  cumprido ou `sentArtifacts` confirmado) — nunca por sucesso de tool call isolada.
- **Duas dimensões de recuperação**, deliberadamente não combinadas em score único:
  - `findRelevantCasesShadow(objective)` — similaridade de **problema**, via embedding.
  - `findSimilarShadow(plan)` — similaridade de **estratégia**, via fingerprint de tools.
- **Applicability Gate** (`findApplicableCasesShadow`, S7): anota cada candidato de similaridade
  de problema com `operationalCompatibility` (create/modify/remove/inspect) — resolve o achado
  S6.5 de que "mesmo objeto, operação oposta" (ex.: criar PPTX × analisar PPTX) tinha cosine
  similarity mais alto que pares genuinamente equivalentes.

**Consumo hoje** (`GoalExecutionLoop.ts`): todos os 3 call sites são modo sombra —
`findApplicableCasesShadow` roda fire-and-forget (`void ...catch(() => [])`, resultado nunca
lido pelo chamador), `findSimilarShadow` roda **depois** que `planner.plan()` já gerou e enviou
o plano (só para log `[CASE-SHADOW-RECOVERY]`). Confirmado por leitura de código nesta sessão —
zero influência em `GoalPlanner`/`RiskAnalyzer`/execução, exatamente como a docstring do módulo
declara.

## 2. O que muda (Fase 2/3 — já resolvidas nas Sprints anteriores, aplicadas aqui)

A pergunta de **desenho** de recuperação (que dimensão, que score, que gate) já foi respondida
pelas Sprints S5-S7 — não é reaberta aqui. A única pergunta desta RFC é **onde e como** o
resultado já computado passa a influenciar a decisão real:

| Dimensão | Ativa nesta RFC? | Por quê |
|---|---|---|
| Similaridade de problema + Applicability Gate (`findApplicableCasesShadow`) | **Sim** | Só depende do `objective` do goal — disponível ANTES de `GoalPlanner.plan()` gerar qualquer coisa. Encaixe natural como Evidence Provider na fase de planejamento inicial, mesmo padrão já usado por `findHardConstraints`/`OperationalKnowledge`. |
| Similaridade de estratégia (`findSimilarShadow`) | **Não, continua sombra** | Estruturalmente só pode rodar DEPOIS que um plano já existe (precisa do fingerprint do plano gerado) — não pode informar a MESMA decisão que a originou. Promovê-la exigiria uma decisão de desenho separada (ex.: consumidor em `RiskAnalyzer` ou `StrategyDiversityGuard`), fora do escopo desta ativação. Registrado como item explicitamente adiado (Seção 5), não esquecido. |

**Mudança concreta**: `CaseMemory` ganha `buildCaseEvidenceHint(objective)` — mesmo contrato de
`OperationalKnowledge.buildEvidenceHint()` (Evidence Provider: texto ou vazio, nunca decide).
Só reporta candidatos com `operationalCompatibility === true`; `'unknown'`/`false` nunca viram
evidência positiva (mesma regra que `findApplicableCasesShadow` já aplica ao logar). `GoalPlanner`
recebe `caseMemory` como dependência injetada (mesmo padrão de `operationalKnowledge`) e consulta
dentro de `plan()`, antes de montar o prompt — o bloco entra no mesmo `enrichedContext` que já
recebe `priorEvidence` (`findHardConstraints`). O call site fire-and-forget em
`GoalExecutionLoop.ts:175` é removido (redundante — a consulta real substitui a diagnóstica).

## 3. Crítica (Fase 2)

- **Risco de viés de repetição**: mostrar "isto já funcionou antes" pode enviesar o Planner a
  repetir uma estratégia menos ideal. Mitigação: é evidência textual, não instrução — mesma
  garantia que qualquer outro Evidence Provider já tem; o Planner já recebe `diversityConstraints`
  (StrategyDiversityGuard) no mesmo prompt, sinal oposto e já existente.
- **Acoplamento novo**: `GoalPlanner` ganha mais uma dependência opcional — mesmo padrão já usado
  para `operationalKnowledge`, `reflectionMemory`; não introduz uma forma nova de acoplamento.
- **Nenhuma decisão automática nova**: `buildCaseEvidenceHint` nunca filtra o plano, nunca decide
  estratégia — só texto, seguindo integralmente o Evidence Provider Pattern.

## 4. Critérios de validação

Mesmos 4 estágios já estabelecidos (`docs/DIRETRIZ_ARQUITETURA_2026-07-13.md`, Validação
Progressiva): unitário → regressão → e2e sintético → ambiente real. Critério de sucesso
específico: um goal cujo objetivo é semanticamente parecido com um Caso já capturado (mesma
operação, tier de evidência confirmado) deve mostrar `[CASE-EVIDENCE-INJECT]` no prompt real de
`plan()`, e a ausência de candidato compatível deve produzir silêncio (bloco vazio), nunca erro.

## 5. Itens explicitamente adiados por esta RFC

- `findSimilarShadow` (similaridade de estratégia) permanece modo sombra — ver Seção 2.
- Calibração estatística do piso de score semântico — `buildCaseEvidenceHint()` usa 0.7 (o único
  ponto de referência real medido no projeto, S6.5) como piso conservador nomeado, não um valor
  calibrado com dados de produção. **Correção a esta RFC** (achado ao revisar `S26` antes de
  implementar): a versão inicial deste documento dizia que threshold "não muda nesta RFC" — errado.
  `S26` (auditoria adversarial) já exigia explicitamente score suficiente **e**
  `operationalCompatibility===true` para qualquer consumidor real, nunca compatibilidade sozinha —
  sem isso, um candidato "mesma operação, tema totalmente diferente" passaria pelo Applicability
  Gate. Corrigido antes do primeiro commit desta ativação (ver `CaseMemory.ts`,
  `MIN_SEMANTIC_SCORE_FOR_EVIDENCE`).
