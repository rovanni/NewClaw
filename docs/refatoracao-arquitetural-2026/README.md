# Programa de Refatoração Arquitetural NewClaw (2026)

**Status: 🟢 Concluído em 2026-07-18 e integrado em `main`.** Branch `refactor/architectural-backlog`
(95 commits sobre a baseline `baseline-b1.0-pre-refactor`) mesclada em `main` via merge commit
`f230fd9`, tag de marco `v2.0.0`. `tsc --noEmit` e a suíte de regressão completa reconfirmados
limpos em `main` pós-merge, antes da tag.

## O que foi este programa

Quatro auditorias arquiteturais independentes do runtime do NewClaw (o "Cognitive Kernel" — núcleo
de IA por trás dos canais Telegram/Discord/WhatsApp/Signal/Web) identificaram 26 problemas
estruturais recorrentes: violações de fronteira entre camadas (`loop/`/`core/`/`memory/`), conceitos
com múltiplas fontes de verdade divergentes (SSOT), decisões duplicadas em lugares diferentes sem
dono único, e 3 métodos "God Method" que já passavam de 1000 linhas cada. Este programa existiu para
resolver os 26, com um princípio central herdado de `docs/DIRETRIZ_ARQUITETURA_2026-07-13.md`:
**nunca implementar a primeira solução encontrada** — toda mudança arquitetural passa por 5 fases
(Compreensão → Crítica → Alternativas → Síntese → Validação) antes de qualquer código, e toda mudança
estrutural relevante exige validação em ambiente real (LLM real, filesystem real, goal real) antes de
ser considerada concluída — não só passar na suíte de testes.

## Resultado final

- **26/26 cards com desfecho registrado** — 24 concluídos (22 do encerramento original +
  `ARCH-013` e `ARCH-008`, implementadas nas reaberturas de 2026-07-18/19), 1 formalmente adiado
  (`ARCH-018`) e 1 encerrado como Won't Fix após reabertura (`ARCH-009`, 2026-07-18 — ver
  `docs/issues/012`) — nenhum esquecido, todos com `docs/issues/NNN` correspondente.
- **3/3 RFCs concluídas, 0 rejeitadas** — 2 delas (`ARCH-012`, `ARCH-015`) aprovadas com escopo
  reduzido em relação ao card original, por decisão fundamentada em investigação real, não por
  precaução genérica.
- **0 violações de fronteira remanescentes** (eram ~4 famílias/31 ocorrências).
- **God Methods: 3 → 1** (`AgentLoop.runWithTools`, 419 linhas — única exceção documentada e aceita,
  os outros 2 maiores métodos do projeto foram totalmente decompostos).
- **Single Sources fragmentadas: 8 → 2** (os 2 remanescentes são adiamentos formais, não
  esquecimentos).
- **Regressão: 118 → 128 testes**, 0 quebras líquidas acumuladas ao longo de 27 Sprints.
- Ver a revisão completa de indicadores (T0 vs. final, todas as linhas) em
  [`CHECKPOINTS/CP05.md`](CHECKPOINTS/CP05.md).

## Guia de leitura — onde encontrar o quê

| Você quer saber... | Vá em |
|---|---|
| O quê e por quê de um problema específico (descrição, evidências, arquivos, critérios de aceite) | [`ARCHITECTURAL_BACKLOG.md`](ARCHITECTURAL_BACKLOG.md) |
| Quando e como cada card foi executado, o Painel Executivo cronológico completo | [`MASTER_EXECUTION_PLAN.md`](MASTER_EXECUTION_PLAN.md) |
| A história completa de uma Sprint específica (objetivo, decisão de design, validação, commit) | [`SPRINTS/`](SPRINTS/) — um arquivo por Sprint, `SNN-ARCH-XXX.md` |
| O resultado de um Checkpoint de revisão (CP01-CP05) | [`CHECKPOINTS/`](CHECKPOINTS/) |
| Comparar todas as Sprints lado a lado (tempo, indicadores antes/depois, riscos) | [`METRICAS.md`](METRICAS.md) |
| Por que escolhemos X e não Y em cada Sprint | [`EXECUCAO_DECISOES_DE_DESIGN.md`](EXECUCAO_DECISOES_DE_DESIGN.md) |
| Por que a auditoria original errou em ~30% dos casos, e os 7 modos de falha catalogados | [`RETROSPECTIVA_PREMISSAS_AUDITORIA.md`](RETROSPECTIVA_PREMISSAS_AUDITORIA.md) |
| Trechos de código cujo comportamento depende de ordem de execução implícita | [`DEPENDENCIAS_ORDEM_IMPLICITA.md`](DEPENDENCIAS_ORDEM_IMPLICITA.md) |
| As 3 RFCs formais do programa, na íntegra | `RFC_ARCH-012_UnifiedDeliveryProof.md`, `RFC_ARCH-015_SchemaGeneratedRequiredArgs.md`, `RFC_ARCH-024_DeliveryTrackingContext.md` |
| Como esta própria pasta foi organizada, e o precedente para o próximo programa | [`PLANO_REORGANIZACAO_DOCUMENTAL.md`](PLANO_REORGANIZACAO_DOCUMENTAL.md) |

## As 7 lições mais importantes (das 27 Sprints)

1. Reverificar a premissa do card contra o código real, sempre — não é exceção, é a norma (8 de 27
   Sprints tiveram alguma alegação corrigida na prática).
2. `tsc` e revisão humana/LLM linha a linha são mecanismos de detecção complementares — um pega
   erros de referência/tipo, o outro pega erros de valor (threading de estado mutável); nenhum
   substitui o outro.
3. A etapa 4 (ambiente real) não é burocracia — encontrou seu próprio motivo de existir mais de uma
   vez, confirmando com dado real (LLM real, goal real) o que a suíte de testes sozinha não provava.
4. Nunca deixar o próprio julgamento de risco substituir uma regra categórica já registrada no
   programa (Regra Permanente #5 — etapa 4 obrigatória para mudanças estruturais/RFCs).
5. O critério de 300 linhas não é uma regra cega — é um sinal que pede julgamento contextual sobre
   a natureza do código que resta.
6. Escopo reduzido, fundamentado em evidência real, bate escopo literal do card mais vezes do que
   o contrário — 2 das 3 RFCs do programa acabaram menores que o card original propunha.
7. Fonte única > correção pontual, sempre que a classe de bug se repete — cada extração de função
   compartilhada fechou uma classe inteira de bug futuro, não só o caso observado.

## Próximo ciclo

A causa raiz da dívida arquitetural encontrada pelas 4 auditorias originais não foi a arquitetura do
runtime em si — foi a ausência de um ciclo de revisão recorrente. Este encerramento não deve ser o
último: recomenda-se uma auditoria arquitetural leve a cada ~8-10 Sprints de feature/bugfix (ou
quando `God Methods`/`Large Classes` cruzarem os limiares da Fase 7), reaproveitando o processo de 5
fases de `docs/DIRETRIZ_ARQUITETURA_2026-07-13.md`, que continua em vigor. Ver `CHECKPOINTS/CP05.md`
para a recomendação completa, incluindo o primeiro item de trabalho sugerido (re-auditar o Decision
Ownership Map e o Code Smells original, não totalmente re-medidos célula a célula neste encerramento).

**Já em andamento (2026-07-18/19):** 3 dos 4 cards adiados já foram reabertos sob esse próximo
ciclo. `ARCH-009` (S14) foi o primeiro — a auditoria confirmou a premissa de julho, corrigiu o
escopo da alternativa proposta e reavaliou Impacto/Risco/Esforço para Baixo/Baixo/Pequeno, mas o
usuário decidiu encerrar o card sem implementar (Won't Fix) por falta de motivação real, não por
inviabilidade técnica — ver `docs/issues/012-arch009-wontfix-decision.md`. `ARCH-013` (S21) foi o
segundo — diferente do ARCH-009, aqui havia ganho real (elimina uma 2ª chamada de LLM redundante
por step ambíguo, latência/custo mensuráveis, não só duplicação cosmética); implementado com um
design revisado (`GoalStore.promoteLastAttemptToSuccess()`, contraparte do
`downgradeLastAttemptToPartial()` já existente), validado até etapa 4 com LLM real — ver
`SPRINTS/S21-ARCH-013.md`. `ARCH-008` (S17) foi o terceiro — bug real confirmado (progresso
resetava a cada `resumeGoal()`, quebrando inclusive a lógica de bônus de replan
`ADAPTIVE-BUDGET`, não só a barra de progresso visual); implementado com
`buildInitialProgressModel()` reaproveitando `PlanStep.lastAttemptOutcome` (ARCH-007), validado
via `GoalOrchestrator.resumeFromAuth()` real contra um goal real (achado lateral: o canal Web
Dashboard não tem `workflowCallback` wired para aprovação de ações perigosas, contornado chamando
o `AgentController` real diretamente) — ver `SPRINTS/S17-ARCH-008.md`. Resta 1 candidato
formalmente adiado (`ARCH-018`) para a próxima rodada deste ciclo.
