[← Painel Executivo](MASTER_EXECUTION_PLAN.md) · [Backlog](ARCHITECTURAL_BACKLOG.md)


# Decisões de Design — Programa de Refatoração Arquitetural NewClaw

Catálogo das escolhas de design feitas ao longo do programa (o que foi decidido e por quê) —
compilado a partir do campo "Lições aprendidas"/"Riscos encontrados" de cada Sprint em
`METRICAS.md`. Diferente da Retrospectiva (que cataloga a AUDITORIA errando) e das
Dependências de Ordem (que cataloga um padrão de risco no CÓDIGO), este documento cataloga
as escolhas que NÓS fizemos durante a execução e por quê.

---

## S01 — ARCH-001

[Ver Sprint completa](SPRINTS/S01-ARCH-001.md) · 2026-07-17 · commit `6c14a9b`

**Do que partiu (indicador antes):** Violações de fronteira: 26 imports `ToolExecutor`/`ToolResult` de `loop/AgentLoop`

**Para onde foi (indicador depois):** 0

**Riscos encontrados:** Nenhum — mudança mecânica de path, sem lógica tocada

**Decisão e lição:** O card original tinha 2 falsos positivos na contagem T0 (`AgentController.ts`/`agentControllerCommands.ts` importam a classe `AgentLoop`, não `ToolExecutor`/`ToolResult` — legítimo). Grep bruto por path sem checar o que é importado super-conta violações; a verificação correta é sempre linha-a-linha nos símbolos, não só no path do módulo.

---

## S02 — ARCH-004

[Ver Sprint completa](SPRINTS/S02-ARCH-004.md) · 2026-07-17 · commit `18ba2a2`

**Do que partiu (indicador antes):** `memory/` com 2 imports de tipo de `loop/` (`GoalTypes` ×2 símbolos combinados, `UnifiedIntentRouter` ×1)

**Para onde foi (indicador depois):** 0

**Riscos encontrados:** Nenhum — só tipos, zero custo em runtime antes e depois

**Decisão e lição:** O escopo real do card era maior que o texto sugeria: `Goal` referencia transitivamente 6 outros tipos (`GoalStatus`, `GoalBlocker`, `SuccessCriterion`, `GoalAttempt`, `ToolMutation`, `PlanStep`), todos precisaram migrar juntos — não dá pra mover um tipo "pela metade" quando outro tipo no mesmo arquivo depende dele por completo. Fechamento transitivo de dependências de tipo deve ser mapeado antes de estimar o esforço de um ARCH de fronteira, não só a lista de símbolos citados no import original.

---

## S03 — ARCH-006

[Ver Sprint completa](SPRINTS/S03-ARCH-006.md) · 2026-07-17 · commit `0225075`

**Do que partiu (indicador antes):** 15 recomputações inline de `status==='pending'` em `GoalExecutionLoop.ts`

**Para onde foi (indicador depois):** 1 accessor único (`getPendingSteps`)

**Riscos encontrados:** Nenhum — assinaturas de saída idênticas em cada call site, só a fonte mudou

**Decisão e lição:** O card citava "6+" mas a varredura completa achou 15 ocorrências reais do mesmo predicado — sempre vale varrer o arquivo inteiro por regex antes de aceitar a contagem do card como teto. 2 ocorrências parecidas (mesma substring `status === 'pending'`) eram outra coisa: `SuccessCriterion.status` (tipo diferente, campo homônimo) e um filtro de mutação de plano (remove supersedidos) — nem toda ocorrência textual do predicado é uma leitura de "pending steps"; a diferenciação semântica evita generalizar demais o accessor.

---

## S04 — ARCH-014

[Ver Sprint completa](SPRINTS/S04-ARCH-014.md) · 2026-07-17 · commit `ccf97c1`

**Do que partiu (indicador antes):** 6 padrões de erro transiente duplicados entre os 2 módulos (`ECONNRESET`/`ETIMEDOUT`/`timeout`/`network`/`rate.?limit`/`429`)

**Para onde foi (indicador depois):** 6 definições nomeadas únicas em `shared/`, compostas por cada consumidor

**Riscos encontrados:** Nenhum — cada regex composta é byte-idêntica à original, comportamento de retry por tool preservado exatamente

**Decisão e lição:** O card citava só 3 padrões sobrepostos; a varredura achou 6. Rejeitei conscientemente a opção "uma lista universal" (mudaria comportamento observável — tools ganhariam/perderiam retries que não tinham, e `GoalEvaluator` poderia misclassificar timeout como erro de rede se os dois conjuntos fossem fundidos numa regex só) — a fonte única deve ser por *padrão individual*, não por *lista consumida igualmente em todo lugar*, quando os consumidores têm decisões genuinamente diferentes sobre o mesmo dado.

---

## S05 — ARCH-017

[Ver Sprint completa](SPRINTS/S05-ARCH-017.md) · 2026-07-17 · commit `dd1a51e`

**Do que partiu (indicador antes):** `ToolExecutorService` morto (0 call sites reais) coexistindo com `ProactiveRecovery.execute()` (caminho real)

**Para onde foi (indicador depois):** `ToolExecutorService` removido; `ToolExecutorLike` consolidada no `ToolExecutor` já existente em `agentLoopTypes.ts`

**Riscos encontrados:** Nenhum — grep de todo `src/` confirma 0 referências residuais; `core/CircuitBreaker.ts` (usado de verdade por `ProviderFactory.ts`) intacto

**Decisão e lição:** O card não citava `tools/powerpoint_control.ts` (usava `ToolExecutorLike`, tipo do mesmo arquivo, só para type-check estrutural) nem os listeners `tool:timeout`/`tool:failed` em `AgentController.ts` (só o `ToolExecutorService` deletado os emitia) — mapear TODOS os exports de um arquivo antes de removê-lo, não só a classe citada no card, evita quebrar consumidores que a auditoria original não viu. Achado à parte, documentado sem corrigir: `core/index.ts` parece não ter nenhum importador em todo o projeto.

---

## S06 — ARCH-025

[Ver Sprint completa](SPRINTS/S06-ARCH-025.md) · 2026-07-17 · commit `7aa5bc4`

**Do que partiu (indicador antes):** 2 blocos de prompt (~95% idênticos, per o card) copiados à mão em `buildPlanPrompt`/`buildReplanPrompt`

**Para onde foi (indicador depois):** `buildRequiredArgsReference()`/`buildBatchCollectionBlock()` como fonte única

**Riscos encontrados:** Nenhum, mas **mudança de comportamento intencional**: convergir 2 textos em 1 exige escolher um vencedor nos pontos divergentes — o prompt de replan ganhou os 2 tipos de nó de `memory_write` que faltavam (`project`/`knowledge`), documentado explicitamente, não escondido

**Decisão e lição:** A comparação real achou 6 divergências, não só as citadas no card ("~95%" era literal, não estimativa vaga) — a mais séria era uma lacuna de conteúdo (3 de 5 tipos de nó), não só diferença de wording. Ao contrário de S01-S05, este card *pretende* mudar texto observável — "regressão 100%" aqui significa comportamento de execução inalterado (testes passam), não texto de prompt idêntico ao anterior, já que o objetivo do card é justamente eliminar a diferença.

---

## S07 — ARCH-026

[Ver Sprint completa](SPRINTS/S07-ARCH-026.md) · 2026-07-17 · commit `e97405d`

**Do que partiu (indicador antes):** `DELIVERABLE_EXTENSIONS` duplicado (`AgentLoop.ts`) fora do módulo que já centraliza `SOURCE_SCRIPT_EXTENSIONS`

**Para onde foi (indicador depois):** 1 export único em `inferExpectedExtensions.ts`

**Riscos encontrados:** 1 encontrado e corrigido no ato — `S52` fazia asserção sobre o texto-fonte exato de `AgentLoop.ts`, quebrou quando o array mudou de arquivo (comportamento real intacto, só a localização do código mudou)

**Decisão e lição:** Primeira Sprint deste programa em que a suíte de regressão realmente pegou algo — prova de que a distinção Regressão Funcional/Arquitetural (adicionada nesta sessão, a pedido do usuário) não é só formalidade: um refactor "limpo" (comportamento idêntico) ainda pode quebrar um teste que faz asserção sobre onde o código mora, não só o que ele faz. Rodar a suíte de verdade após cada Sprint, não assumir que vai passar, continua sendo o item que mais paga dividendo.

---

## S08 — ARCH-002

[Ver Sprint completa](SPRINTS/S08-ARCH-002.md) · 2026-07-17 · commit `151fd6a, 36036de`

**Do que partiu (indicador antes):** Round-trip `core/CapabilityRegistry` ↔ `loop/EnvironmentProbe` ↔ `core/ToolRegistry`

**Para onde foi (indicador depois):** `EnvironmentProbe.ts` movido para `core/`; import agora intra-camada nos dois sentidos

**Riscos encontrados:** 0 causados por este ARCH — mas achei 1 bug de teste real (`S112`, corrigido) e 1 fragilidade de asserção documentada (`S13`, não corrigida) escondidos atrás do que eu tinha rotulado apressadamente como "diferença de ambiente"

**Decisão e lição:** **"Reproduz no commit anterior, na mesma máquina" prova ausência de regressão, mas não substitui investigar a causa raiz de cada falha** — só descobri o bug real do S112 (e que os outros 2 eram falha do meu próprio setup, não do Linux) porque o usuário perguntou diretamente "as falhas estão sendo documentadas?" em vez de aceitar minha primeira conclusão ("gap de ambiente pré-existente", vaga demais) como suficiente. A skill `verify` já tinha a resposta certa (`.env` com `WORKSPACE_DIR`) — pular esse passo ao adaptar o procedimento pra uma VPS remota via SSH foi o que gerou 2 dos 3 falsos positivos.

---

## S09 — ARCH-003

[Ver Sprint completa](SPRINTS/S09-ARCH-003.md) · 2026-07-17 · commit `d9efaff`

**Do que partiu (indicador antes):** `memory/` dependia em runtime de 2 símbolos de `loop/` (`StrategyDiversityGuard`, `extractText`)

**Para onde foi (indicador depois):** `StrategyDiversityGuard.ts` movido inteiro; `extractText` extraído de `ResponseBuilder.ts` (não de `ResponseAdapter.ts`, um shim depreciado)

**Riscos encontrados:** 0 causados por este ARCH — mas achei 2 funções `extractText` diferentes com o mesmo nome no código (`ContentExtractor.ts` tem outra, assinatura `unknown`→`string`, com docstring desatualizado dizendo que `ContextCompressor` a usaria, quando na verdade usa a outra)

**Decisão e lição:** `ResponseAdapter.ts`, citado no card, acabou sendo só um shim `@deprecated` — a implementação real de `extractText` estava em `ResponseBuilder.ts`, junto com 3 outras responsabilidades (normalizeResponse, ContextValidator, DecisionPostProcessor) que TÊM dependência real de `loop/` (`AgentState`, `ToolResult`) e não deveriam mover. Mapear o card contra o código real antes de mover evitou mover o arquivo errado ou arrastar dependências desnecessárias para `shared/`.

---

## S10 — ARCH-011

[Ver Sprint completa](SPRINTS/S10-ARCH-011.md) · 2026-07-17 · commit `fbaf1a0`

**Do que partiu (indicador antes):** Regex recomputava por texto livre o que `toolsTried` já guarda estruturado (com lacuna real: só 11 de 25 tools reconhecidas)

**Para onde foi (indicador depois):** `toolsTried.join('→')` como fonte primária aditiva; regex sobrevive só p/ detectar `'agentloop'`

**Riscos encontrados:** 0 causados por este ARCH — mas confirmou e corrigiu (efeito colateral direto) a lista hardcoded de 11/25 tools no regex antigo, `docs/issues/005`

**Decisão e lição:** A premissa do card ("toolsTried já guarda a sequência estruturada") não se sustentou 1:1 na inspeção real — é deduplicado, sem fronteira por tentativa, nunca contém `'agentloop'`. Trocar a fonte por completo teria enfraquecido a semântica do fingerprint (de "sequência exata" pra algo mais vago). Design aditivo (soma ao invés de substitui) preservou a semântica original e ainda assim atingiu o critério de aceite do card ("fonte primária"). Card marcado "Quick Win" pelo backlog, mas a investigação de premissa levou tanto quanto uma Sprint típica desse programa — "Quick Win" descreve o tamanho do diff, não necessariamente o esforço de entender se a premissa é sequer verdadeira.

---

## S11 — ARCH-016

[Ver Sprint completa](SPRINTS/S11-ARCH-016.md) · 2026-07-17 · commit `52e8e3c`

**Do que partiu (indicador antes):** 4 blocos de detecção de loop com texto quase idêntico gerado por código duplicado 4x

**Para onde foi (indicador depois):** `buildLoopDirective()` como fonte única de FORMATAÇÃO para os 4; `extractExhaustedTools()` como fonte aditiva só onde o padrão realmente se aplica (1 de 4)

**Riscos encontrados:** 0 causados por este ARCH

**Decisão e lição:** A premissa do card ("os 4 blocos são o mesmo padrão de detecção") não se sustentou — só 1 de 4 é genuinamente "tool falhou N vezes"; os outros 3 detectam categoria de blocker+texto, categoria de ação (não falha), e ocorrência única (não repetição). Forçar os 4 pra `extractExhaustedTools()` como o card sugeria teria quebrado 3 deles silenciosamente. Terceira Sprint seguida (depois de S08 e S10) onde a premissa original do backlog não resistiu à inspeção do código real — o padrão está claro o suficiente pra virar hábito permanente: nunca implementar a "troca de fonte" de um card sem antes confirmar que as duas fontes representam genuinamente a mesma coisa.

---

## S12 — ARCH-023

[Ver Sprint completa](SPRINTS/S12-ARCH-023.md) · 2026-07-17 · commit `88ede55`

**Do que partiu (indicador antes):** 4 transformações de `command` (marp/pandoc/PowerShell) como `if`s soltos em `execute()`, ordem só documentada em comentário

**Para onde foi (indicador depois):** `COMMAND_FIXUP_PIPELINE` (array nomeado, 4 steps) + `applyFixup()`, chamado individualmente nos mesmos 4 pontos exatos

**Riscos encontrados:** 1 achado e corrigido no ato — `S11` fazia asserção sobre `needsPowerShellWrap(` aparecer no texto literal de `execute()`, quebrou quando a chamada foi pro `condition()` do pipeline (mesma classe de achado do S52/S110/S34/S22)

**Decisão e lição:** Primeira Sprint com premissa quase inteiramente correta (a única correção: "~12 funções" incluía helpers de PowerShell não relacionados à cadeia de transformação sequencial, e 2 delas eram gates de validação, não transformações). Decisão consciente de NÃO usar um loop único: `isSearchCommand` precisa ler o comando antes do `wrap_powershell` rodar, ou grep/rg/find nunca mais seriam reconhecidos depois do embrulho em PowerShell — a "estrutura de dados explícita" que o card pede não exige forçar tudo num `for` só quando isso quebraria uma dependência de ordem real e documentada.

---

## S13 — ARCH-007

[Ver Sprint completa](SPRINTS/S13-ARCH-007.md) · 2026-07-17 · commit `216f039`

**Do que partiu (indicador antes):** `PlanStep.status` hardcoded `'completed'` em `markStepDone()` independente do outcome real do `GoalAttempt` mais recente — divergência invisível fora de `goal.attempts`

**Para onde foi (indicador depois):** `PlanStep.lastAttemptOutcome?: AttemptOutcome` novo, populado com o `reflectionOutcome` já calculado (antes só usado pela ReflectionMemory)

**Riscos encontrados:** 0 causados por este ARCH

**Decisão e lição:** A premissa do card estava certa no resultado (`completed` com attempt `partial` acontece de verdade) mas errada na causa citada — o caminho de "downgrade semântico" que o card apontava (L1137-1202) nunca chega a chamar `markStepDone`, porque `cycleResult.outcome` já deixa de ser `'success'` antes do `switch`. O gatilho real é o caminho da Sprint 0.8 (heurística de baixa confiança), já coberto por outro teste (S85) só no nível do `GoalAttempt` — faltava propagar pro `PlanStep`. Reforça o padrão dos Sprints anteriores: o sintoma correto no card não garante que a causa citada seja a real; vale rastrear o fluxo de execução ponta a ponta antes de implementar, mesmo quando a conclusão final ("é preciso um fix aqui") já parecia óbvia. Decisão de design foi deliberadamente a opção de MENOR blast radius das duas oferecidas pelo card (não mexer no enum de `status`, usado por ~15 call sites) — em vez de mudar retry behavior por um caminho que nunca foi desenhado pra re-tentar.

---

## S14 — ARCH-009

[Ver Sprint completa](SPRINTS/S14-ARCH-009.md) · 2026-07-17 · commit `92c46da (docs)`

**Do que partiu (indicador antes):** `output`/`error` redeclarados independentemente em `ToolResult`/`CycleResult`/`GoalAttempt` (premissa do card)

**Para onde foi (indicador depois):** Nenhuma mudança — Sprint adiada antes de codificar

**Riscos encontrados:** 0 causados (nenhum código tocado), mas achado grave sobre a viabilidade do card em si

**Decisão e lição:** A prescrição literal do card (`extends ToolResult`) não compila — `output` obrigatório em `ToolResult` vs. opcional em `CycleResult`/`GoalAttempt`, TS não permite herdar obrigatório→opcional — e, se forçada via mudança de tipo, reintroduziria a violação de fronteira `shared/→loop/` que o ARCH-004 (S02) já corrigiu (`GoalAttempt` mora em `shared/domainTypes.ts` desde então). Primeira Sprint do programa em que a PRESCRIÇÃO do card, não só o diagnóstico/causa citada, se mostrou estruturalmente inviável (5º modo de falha, catalogado em `RETROSPECTIVA_PREMISSAS_AUDITORIA.md`) — a auditoria original comparou nomes de campo entre 3 tipos sem verificar obrigatoriedade nem a camada física de cada um, que mudou desde a auditoria por causa de outra Sprint deste mesmo programa (ARCH-004). Por decisão do usuário, consolidado (não resolvido pontualmente) com achados correlatos de modelagem de tipo compartilhado — `REVISAO_CONSOLIDADA_TIPOS_PENDENTE.md`, que já inclui ARCH-024 (mesma classe de problema em `ChannelContext`) e `docs/issues/004`.

---

## S15 — ARCH-010

[Ver Sprint completa](SPRINTS/S15-ARCH-010.md) · 2026-07-17 · commit `ebea0f5`

**Do que partiu (indicador antes):** Dedup `alreadyFailed` inline em `evaluate()`, `JSON.stringify` bruto para comparar args, `send_document` nunca dedupava entre legendas cosmeticamente diferentes

**Para onde foi (indicador depois):** `hasIdenticalFailedAttempt()` método nomeado, chave via `computeToolInputKey()` (já existente/testado, S90) — sem índice persistido/cacheado

**Riscos encontrados:** 0 causados por este ARCH

**Decisão e lição:** A premissa do card citava um "método" que na verdade era uma `const` local, e pedia responder "quantas vezes já falhou" quando o código só precisa de um booleano ("já falhou alguma vez com estes args exatos?") — nenhum consumidor real precisa da contagem. Mais importante: um índice incremental de verdade (o que o card literalmente pedia) foi conscientemente REJEITADO na Fase 2 — `Goal` é recarregado do `GoalStore` a cada mudança de estado relevante em `runLoopInternal`, não existe objeto estável em memória entre ciclos pra um cache se anexar com segurança, e um índice persistido criaria uma segunda fonte de verdade para dado já 100% contido em `goal.attempts` (o oposto do que o Epic B pede), com o mesmo risco de restart-safety ainda em aberto do ARCH-008. A solução implementada (método nomeado + reuso de `computeToolInputKey`) entrega a "clareza" que era o ganho real admitido pelo próprio card, sem os riscos do índice literal — e como efeito direto (não oportunista) de calcular a chave de args corretamente, corrigiu o mesmo gap de dedup de `send_document` por legenda que S90 já tinha corrigido numa camada diferente (`AgentLoop`), agora consistente também em `GoalEvaluator`.

---

## S16 — ARCH-005

[Ver Sprint completa](SPRINTS/S16-ARCH-005.md) · 2026-07-18 · commit `7abede2`

**Do que partiu (indicador antes):** "4 estruturas desincronizadas" de artefatos entregues (premissa do card)

**Para onde foi (indicador depois):** Fix cirúrgico: `sentArtifacts`/`pendingSendPaths` normalizados via `resolvePath()` antes de comparar contra paths absolutos de `checkDeliverables()` em `deliverable_check`

**Riscos encontrados:** 0 causados por este ARCH — mas achado 1 bug real não documentado antes (mismatch de path cru vs. resolvido), confirmado com dado real em ambiente real

**Decisão e lição:** Maior desvio de premissa do programa até agora: a reverificação de Fase 1/2 mostrou que as "4 estruturas" já convergiam majoritariamente para `sentArtifacts` (via `onArtifactDelivered`, `.has()`, fallback em `checkClaimsAgainstEvidence`), que o escopo do card estava incompleto (faltava `planning/artifactContract.ts`), e que os 2 bugs históricos citados como motivação já tinham sido corrigidos por Sprints anteriores a este programa. Consolidar 4 mecanismos já majoritariamente sincronizados, pra prevenir uma 3ª ocorrência hipotética de bug já resolvido 2x, tinha valor questionável frente ao risco de um Refactor Estrutural. Apresentei 3 alternativas ao usuário (fix cirúrgico / consolidação completa / adiar como ARCH-009); optou pelo fix cirúrgico. Etapa 4 (obrigatória pelo card original) foi cumprida apesar do escopo reduzido, por decisão do usuário, dado que a mudança toca resolução de path — categoria com histórico de bugs só visíveis fora de mocks (`feedback_verificar_fixes_de_verdade`); rodei uma instância isolada real com LLM real, que confirmou com dado genuíno (não hipotético) que `send_document` de fato usa paths relativos na prática, validando a precondição do bug antes mesmo de testar o fix. VPS Linux oferecida e dispensada pelo usuário (código só usa `path.resolve`/`path.join`, sem lógica por SO).

---

## S17 — ARCH-008

[Ver Sprint completa](SPRINTS/S17-ARCH-008.md) · 2026-07-18 · commit `4e01818`

**Do que partiu (indicador antes):** `progressModel` reseta a cada `runLoop()`, perdendo progresso "pós-restart" (premissa do card)

**Para onde foi (indicador depois):** Nenhuma mudança — Sprint adiada antes de codificar

**Riscos encontrados:** 0 causados (nenhum código tocado), mas achado grave sobre a premissa do card

**Decisão e lição:** O mecanismo citado como motivação/cenário de teste ("o sistema já tem recovery de goals ativos no boot") não existe — `AgentController.getAllActive()` só loga no boot/shutdown (`recovered=false` explícito), nunca chama `resumeGoal()`. O defeito é real, mas via outro caminho: o único call site de `resumeGoal()` é `GoalOrchestrator.resumeFromAuth()` (aprovação de ação perigosa), mesmo processo, sem restart — mais frequente que o cenário descrito. 6º modo de falha catalogado (auditoria afirmando que um mecanismo operacional existe, sem verificar contra o runtime) — o mais perigoso dos 6 por ler como fato de arquitetura, não como inferência. Fix desenhado (`buildInitialProgressModel`, deriva de `goal.currentPlan`/`goal.attempts`, mesmo espírito de `buildIncrementalExecutionContext`) mas não implementado — usuário optou por adiar e documentar em vez de corrigir pontualmente, dado que a etapa 4 prescrita pelo card ("matar o processo") nem sequer é testável nesse sistema.

---

## S18 — ARCH-018

[Ver Sprint completa](SPRINTS/S18-ARCH-018.md) · 2026-07-18 · commit `4171d31`

**Do que partiu (indicador antes):** `structuralBypass` é um `if` solto fora de `evaluateCriteria` (premissa do card)

**Para onde foi (indicador depois):** Nenhuma mudança — Sprint adiada antes de codificar

**Riscos encontrados:** 0 causados (nenhum código tocado), mas achado grave sobre a premissa numa área de bug histórico real

**Decisão e lição:** O card presumia que `CriterionCheck: 'file_exists'` já cobria o caso de uso de `structuralBypass` — não cobre: `file_exists` checa `GoalAttempt.output` não-vazio, `structuralBypass` faz `fs.statSync()` direto no disco sem depender de attempt algum (motivo de existir: o Bug 2 original era sobre arquivo pré-existente ao goal, sem attempt como evidência). Reaproveitar `file_exists` literalmente reintroduziria o deadlock. Achado estrutural adicional: alvos de `structuralBypass` são dinâmicos (plano atual, muda a cada replan) vs. `successCriteria` estática — sincronizar as duas seria um risco novo, não uma simplificação. 2ª instância confirmada do modo 3 da retrospectiva (mesmo modo de S10/S11) — reforça que "equivalência semântica assumida sem verificação" é o modo mais recorrente do catálogo, não um acaso isolado. Alternativa desenhada (`CriterionCheck` novo dedicado) mas não implementada — usuário optou por adiar, mesma linha de S14/S17, dado o histórico de bug real nesta área específica.

---

## S19 — ARCH-024-RFC

[Ver Sprint completa](SPRINTS/S19-ARCH-024-RFC.md) · 2026-07-18 · commit `9b6fc80`

**Do que partiu (indicador antes):** 5 campos de callback "todos sobre rastreamento de entrega" (premissa do card)

**Para onde foi (indicador depois):** RFC aprovada: 4 campos (não 5) consolidados em `ChannelContext.deliveryTracking` (campo aninhado, não parâmetro separado)

**Riscos encontrados:** 0 (Sprint de análise, sem código)

**Decisão e lição:** Grep completo dos 5 campos mostrou que `recentMessages` é construído em `MessageBus.ts` (mesmo lugar/razão que `channel`/`chatId`/`userId`) e consumido só por `UnifiedIntentRouter`, sem nenhuma relação com entrega de artefato — a premissa do card ("nenhum é sobre o canal, todos sobre entrega") valia pra 4 dos 5, não pros 5. Avaliadas 4 alternativas de forma de consolidação; escolhida a de menor risco (campo aninhado dentro de `ChannelContext`, não parâmetro novo em `AgentLoop.process()`) por preservar a assinatura de método existente — o card não distinguia entre as duas formas, e a diferença de risco entre elas é grande. RFC aprovada com esse escopo corrigido; implementação agendada para S23 (já condicionada a esta RFC).

---

## S20 — ARCH-015-RFC

[Ver Sprint completa](SPRINTS/S20-ARCH-015-RFC.md) · 2026-07-18 · commit `b883cac`

**Do que partiu (indicador antes):** "gerar validação + texto de prompt a partir do schema" resolve os 5 lugares de args obrigatórios (premissa do card)

**Para onde foi (indicador depois):** RFC aprovada com escopo REDUZIDO: só texto de prompt (`requiredArgsHint` co-localizado por tool); validação não aprovada nesta forma

**Riscos encontrados:** 0 (Sprint de análise, sem código)

**Decisão e lição:** Achado 1: os "5 lugares" nem cobrem o mesmo conjunto de tools — `memory_write` nunca aparece em `detectMissingRequiredArgs()` (grep completo confirma), só no schema e no guard interno. Achado 2, mais grave: a lógica de "obrigatório" não é um `required: string[]` plano pra pelo menos 3 tools (`web_navigate`/`crypto_analysis`: condicional a outro campo do mesmo args; `edit`: "uma de 3 combinações válidas") — gerar a VALIDAÇÃO a partir do schema atual perderia essa lógica condicional silenciosamente, uma regressão de comportamento, não uma simplificação, a menos que o formato do schema seja estendido pra um dialeto condicional (esforço de modelagem maior que o "Risco: Médio" do card sugeria). Achado 3: só a metade de TEXTO DE PROMPT tem incidente real confirmado (S06/ARCH-025 achou drift real entre os 2 blocos de prompt) — a metade de validação não tem nenhum incidente de produção documentado motivando urgência, diferente de S16/S18. RFC aprovou só a metade de menor risco e com evidência real de valor (texto de prompt via campo novo `requiredArgsHint` em `ToolExecutor`, agregado por `ToolRegistry.getEnabled()`); a metade de validação fica candidata a uma RFC futura distinta, condicionada a desenhar um dialeto de schema condicional primeiro.

---

## S21 — ARCH-013

[Ver Sprint completa](SPRINTS/S21-ARCH-013.md) · 2026-07-18 · commit `505a8a9`

**Do que partiu (indicador antes):** 2 juízes de sucesso de step rodam em sequência desnecessária, fundir reduz 2 chamadas de LLM pra 1 (premissa do card)

**Para onde foi (indicador depois):** Nenhuma mudança — Sprint adiada antes de codificar

**Riscos encontrados:** 0 causados (nenhum código tocado), mas achado de categoria nova sobre a consequência da fusão

**Decisão e lição:** **Único caso do programa até agora onde a premissa do card está CORRETA e a prescrição é tecnicamente viável** (compila, roda, não reintroduz violação) — o que faltou foi rastrear a consequência completa: `escalateStepEvalToLLM` confirmando sucesso marca `stepSuccessConfident=true`, que decide se `GoalAttempt.result` vira `'success'` ou `'partial'`; `StepSemanticValidator` só tem sinal negativo (`shouldDowngradeToPartial`) — fundir sem dar a ele um sinal de promoção equivalente faria todo step ambíguo virar `'partial'` sempre, mudança de comportamento observável não anunciada pelo card. 7º modo de falha catalogado (categoria nova, distinta dos 6 anteriores — aqui não é a premissa que falha, é a consequência da mudança que não foi seguida até o fim). Alternativa desenhada (StepSemanticValidator ganha sinal de promoção) mas não implementada — usuário optou por adiar, mesma linha de S14/S17/S18 apesar da categoria diferente do achado.

---

## S22 — ARCH-022

[Ver Sprint completa](SPRINTS/S22-ARCH-022.md) · 2026-07-18 · commit `3ee9751`

**Do que partiu (indicador antes):** "4 blocos quase idênticos de construir GoalAttempt de falha" — todos intercambiáveis num único helper (premissa do card)

**Para onde foi (indicador depois):** Só 3 dos 4 blocos são genuinamente equivalentes — `recordFailedAttempt()` cobre só "construir attempt + persistir" (sem decidir outcome); decomposição em `dispatchToolStep`/`dispatchAgentloopStep`/`finalizeStepAttempt`

**Riscos encontrados:** 0 causados por este ARCH

**Decisão e lição:** Comparação campo a campo dos 4 blocos mostrou que o guard de auth (`needs_auth`) NUNCA chamava `evaluator.evaluate()` — diferente dos outros 3, que sempre chamavam — então forçá-lo no mesmo helper que decide o outcome teria mudado esse comportamento. O 4º bloco ("fluxo principal") tem 5 campos extras (mutations/evaluation/traceId/subToolCalls/producedArtifactPaths) e cobre success/partial/failure, não só falha — não foi absorvido no helper, ficou em `finalizeStepAttempt()` com sua própria construção mais rica. Decisão: `recordFailedAttempt()` cobre só a parte "attempt+persist" (não o "decidir outcome"), preservando a diferença real entre os 3 blocos que a absorve. Achado colateral do refactor (não do card): teste `S51` tinha uma asserção de source-text presa a `step.toolName` inline — quebrou quando o guard moveu pra `dispatchToolStep()` (recebe `toolName` como parâmetro explícito, mesmo valor, só outro nome de variável) — mesma classe de achado de S52/S110/S34/S22-teste-antigo/S11/S10, corrigida no ato. Diferente de S14/S17/S18/S21 (todas adiadas), esta correção de premissa não foi grave o suficiente para justificar adiar — o card continuou implementável com um ajuste de design razoável, então a Sprint foi concluída normalmente.

---

## S23 — ARCH-024-Impl

[Ver Sprint completa](SPRINTS/S23-ARCH-024-Impl.md) · 2026-07-18 · commit `ff2dd23`

**Do que partiu (indicador antes):** 4 campos soltos (`deferSendDocument`/`isDeferredArtifact`/`onArtifactDelivered`/`isAudioAlreadySent`) espalhados em `ChannelContext`, "6 pontos de consumo" em `AgentLoop.ts` por (RFC S19)

**Para onde foi (indicador depois):** `DeliveryTrackingContext` interface nova; `ChannelContext.deliveryTracking?: DeliveryTrackingContext` substitui os 4 campos; produtor único em `GoalExecutionLoop.dispatchAgentloopStep()` aninha os 4 closures; 7 leituras em `AgentLoop.ts` ganham o hop `.deliveryTracking`

**Riscos encontrados:** 0 causados por este ARCH

**Decisão e lição:** A contagem "6 pontos de consumo" da RFC (S19) estava subcontada — a reverificação de Fase 1 desta Sprint achou 8 (a chamada direta `channelContext.deferSendDocument(...)` na linha 1818 não tinha sido contada como um consumo distinto do guard condicional da linha 1807). Não invalida a RFC (mesma decisão de desenho), mas reforça: sempre reverificar contagens de "N pontos" citadas em RFCs anteriores por grep direto, não por confiança no documento. Decisão mais importante da Sprint não foi de design, foi de processo: registrei inicialmente "etapa 4 dispensada" com a justificativa de que a mudança era "puramente estrutural" — revertido ao reler a Regra Permanente #5 (a Classificação do card é `Exige RFC`, que torna a etapa 4 obrigatória categoricamente, não por avaliação de risco minha) e ao identificar, tarde mas a tempo, um risco real que essa justificativa tinha ignorado: todos os campos de `deliveryTracking` são opcionais, então um erro de wiring seria invisível ao `tsc` — apenas faria os guards de dedup virarem no-op silencioso, reintroduzindo os bugs de envio duplicado (S10/S44/S51) que este subsistema existe para prevenir. A etapa 4 real, uma vez executada, encontrou 0 problemas — mas o valor não estava no resultado, estava em fechar exatamente esse ponto cego que `tsc`+regressão sozinhos não cobrem. Caminho `send_audio`/`isAudioAlreadySent` não exercitado na etapa 4 (exigiria montar um cenário de replan pós-sucesso); cobertura desse campo específico ficou pela suíte de regressão e pela garantia de que os 4 campos passaram pela mesma operação mecânica de aninhamento.

---

## S24 — ARCH-020

[Ver Sprint completa](SPRINTS/S24-ARCH-020.md) · 2026-07-18 · commit `0173795 (Incremento 1), 2782216 (Incremento 2)`

**Do que partiu (indicador antes):** `runLoopInternal()` ~1030 linhas + switch de outcome ~400 linhas (2º maior método do projeto) — "cada case vira método nomeado, corpo restante vira fases nomeadas"

**Para onde foi (indicador depois):** Incremento 1: 6 `case`s → 6 métodos `handle*Outcome()` (discriminated union `earlyReturn`, mesmo padrão do S22). Incremento 2: bloco `readyToValidate` + bloco de execução de step → 4 métodos (`runValidationPhase`/`runValidationAchievedPhase`/`runValidationNotAchievedPhase`/`runStepExecutionPhase`, união `continueLoop`/`earlyReturn`/`proceedToSwitch`). `runLoopInternal()` cai de ~1030 para 154 linhas; nenhum dos 11 métodos novos excede 300 (maior: `runStepExecutionPhase`, 221)

**Riscos encontrados:** 0 causados por este ARCH

**Decisão e lição:** Premissa de TAMANHO do card (~1030 linhas) bateu quase exatamente com a medição real — diferente da maioria dos cards desta sessão; git log confirmou que o método nunca tinha sido decomposto antes (cresceu organicamente desde a criação do módulo). Decisão de processo mais importante: em vez de decompor o método inteiro num único commit (maior risco concentrado do programa até agora), apresentadas 3 alternativas ao usuário — escolhido o fatiamento em 2 incrementos sequenciais dentro da MESMA Sprint, cada um com sua própria Validação Progressiva completa até etapa 4, reduzindo blast radius por commit sem violar WIP=1. **3 instâncias do mesmo bug, pegas por leitura antes de testar, não pela suíte:** o discriminated-union pattern exige que todo branch que não reatribui `priorFeedback` explicitamente devolva o valor RECEBIDO como parâmetro; `handleBlockedOutcome` (Incremento 1) e 2 branches de `runValidationNotAchievedPhase` (Incremento 2 — "bonus de replan" e "deliverable_check injetou sends") inicialmente devolviam `priorFeedback` incorreto (hardcoded) nesse caso — encontrados por grep sistemático de todo assignment a `priorFeedback` no arquivo ANTES de rodar qualquer validação, não pela suíte de regressão (que nunca rodou com os bugs presentes, então não é evidência de "a suíte teria pegado"). Única quebra de teste real: `S16` (Incremento 1), mesma classe de fragilidade de fonte-texto já catalogada (S52/S110/S34/S22/S51/S44) — corrigida. Lição para S25 (`AgentLoop.runWithTools()`, mesma classe de risco): decomposição de estado mutável via closure exige revisão humana/LLM linha a linha do threading de cada variável reassinalável, não só cobertura de teste — e o padrão de 2+ incrementos sequenciais com etapa 4 própria vale considerar de novo lá.

---

## S25 — ARCH-019

[Ver Sprint completa](SPRINTS/S25-ARCH-019.md) · 2026-07-18 · commit `53a4fa3 (Inc.1), 3b40632 (Inc.2), baf5d34 (Inc.3), 45788e1 (Inc.4), 0778076 (Inc.5), 73d246c (Inc.6)`

**Do que partiu (indicador antes):** `runWithTools()` ~1793 linhas (maior método do projeto, "praticamente a classe inteira depois do construtor") — decompor em fases nomeadas (parse de tool call, dispatch, delivery-guard, orçamento de steps)

**Para onde foi (indicador depois):** 6 incrementos em ordem crescente de risco (decisão do usuário via AskUserQuestion, dado o método ser ~1.7x maior que S24 e ter ~3x mais variáveis mutáveis): (1) turn diagnostics → `logTurnDiagnostics()`; (2) delivery-guard → `runDeliveryGuardPhase()`; (3) synthesis+fallback → `runSynthesisAndFallbackPhase()` (única sem discriminated union — toda a cauda já termina em `return`); (4) JSON-action dispatch → `runJsonActionDispatch()`; (5) native tool-calling dispatch → sub-decomposto em 4 métodos (`runNativeToolCallDispatch`/`dispatchSingleNativeToolCall`/`executeAndRecordNativeToolCall`/`applyPostToolCallGuardsAndFinalize`) após o 1º corte sozinho dar 487 linhas; (6) setup do turno + context-growth guard → `setupTurn()` + `checkContextGrowthGuard()`, 2º corte decidido pelo usuário após o 1º deixar `runWithTools()` em 509 linhas. `runWithTools()` cai de ~1793 para 419 linhas (77%)

**Riscos encontrados:** 0 causados por este ARCH

**Decisão e lição:** Premissa de TAMANHO do card (~1793 linhas) bateu quase exatamente, mesma categoria de S24. **3 classes DISTINTAS de erro pegas por `tsc` antes de qualquer teste, uma por incremento (4/5/6):** referência ausente (3 constantes locais esquecidas como parâmetro em `runJsonActionDispatch`), tipo errado (`ToolCallRequest` em vez de `ToolCall` — dois tipos parecidos, campos diferentes — em `runNativeToolCallDispatch`), parâmetro não utilizado (`turnSignal` passado para `setupTurn()` mas nunca lido lá, já que só é necessário no `while` loop que `setupTurn()` não cobre). Nenhuma dessas 3 é da mesma classe dos bugs de VALOR (threading de `priorFeedback`) achados em S24 — confirma que `tsc` (referência/estrutura) e leitura cuidadosa (valor) são mecanismos complementares, nenhum substitui o outro. **Achado real mais importante (Incremento 6, análise da fronteira try/catch antes de escrever código):** `trace`/`fsm`/`move`/`turnAbort` são declarados ANTES do `try{}` de `runWithTools()` — mover a criação de `trace` para dentro de uma fase extraída chamada de DENTRO do try teria introduzido um bug real (se `traceManager.startTrace()` lançasse exceção depois de movida, o `catch(fsmError)` do chamador leria `trace.status` de um `trace` nunca atribuído). **Decisão de processo mais significativa:** quando `runNativeToolCallDispatch()` (Incremento 5) sozinho deu 487 linhas — acima do limite de 300 — apresentadas 2 alternativas ao usuário (sub-decompor mais 2 níveis / aceitar como exceção documentada); optou pela sub-decomposição estrita. O MESMO padrão de decisão se repetiu no Incremento 6 quando `runWithTools()` ficou em 509 linhas após o 1º corte — dessa vez o usuário optou por UM corte adicional (context-growth guard) mas aceitou o resultado final (419 linhas) como exceção documentada, reconhecendo que fragmentar mais arriscaria quebrar o próprio esqueleto de controle do `while` loop, não mais "extrair uma fase distinta". Isso demonstra que "seguir o critério literal de 300 linhas" não é uma regra cega até o fim — o usuário fez 2 julgamentos de trade-off distintos (sub-decompor vs. aceitar) em pontos diferentes da MESMA Sprint, cada um calibrado à natureza específica do código restante.

---

## S26 — ARCH-015-Impl

[Ver Sprint completa](SPRINTS/S26-ARCH-015-Impl.md) · 2026-07-18 · commit `314831b`

**Do que partiu (indicador antes):** `buildRequiredArgsReference()` em `GoalPlanner.ts` — template literal hardcoded com 7 tools embutidas, única fonte do texto de "args obrigatórios" no prompt do Planner

**Para onde foi (indicador depois):** Campo novo `ToolExecutor.requiredArgsHint?: string`, co-localizado em cada arquivo de tool (texto extraído verbatim do bloco antigo); `buildRequiredArgsReference()` reescrita para `ToolRegistry.getEnabled().map(t => t.requiredArgsHint).filter(Boolean).join('\n')`; `web_search` deliberadamente sem hint (nunca teve linha no bloco antigo), usada como caso negativo no teste

**Riscos encontrados:** 0 causados por este ARCH

**Decisão e lição:** Implementação da RFC aprovada em S20 (Alternativa D, escopo reduzido) — sem drift em relação ao que a RFC descreveu, confirmado por reverificação de `GoalPlanner.ts` no início da Sprint. **Decisão de processo mais relevante:** a nota deixada ao fim de S25 sugerindo "etapa 4 provavelmente dispensável dado o escopo reduzido" foi tratada como hipótese a reverificar, não como conclusão — a Classificação real do card (`Exige RFC`) e a Definition of Done (Validação Progressiva completa) tornam a etapa 4 obrigatória categoricamente, mesma disciplina auto-corrigida em S23 (Regra Permanente #5: julgamento de risco próprio nunca substitui uma regra categórica já registrada). Etapa 4 confirmou, com dado real, que a agregação dinâmica via `ToolRegistry` produz um prompt funcionalmente equivalente ao template hardcoded anterior — sem esse teste, o único jeito de saber seria confiar que o refactor de agregação de string não alterou a semântica do texto final, exatamente o tipo de suposição que os 2 incidentes documentados na Diretriz (`SessionTranscript`/`resolveArtifactPathFromEvidence`) mostram não ser seguro assumir sem rodar contra o sistema real.

---

## S27 — ARCH-012

[Ver Sprint completa](SPRINTS/S27-ARCH-012.md) · 2026-07-18 · commit `0ca79ed`

**Do que partiu (indicador antes):** "2 formas paralelas de provar entrega (`successCriteria`/`CLAIM_RULES`), nenhuma referencia a outra" — premissa literal do card

**Para onde foi (indicador depois):** RFC achou 3 mecanismos, não 2 (`structuralBypass` também decide "entrega comprovada"); "duplicação" só vale pra 1 de 5 `CLAIM_RULES`; o problema real é DIVERGÊNCIA DE RIGOR entre os 3 (só 1 verificava tipo de arquivo). Unificação de tipo rejeitada por risco; implementado `isExpectedDeliverableFile()` (predicado extraído) reusado nos 3 pontos, sem unificar dado

**Riscos encontrados:** 0 causados por este ARCH

**Decisão e lição:** **Achado mais importante do programa inteiro nesta Sprint, e o item de maior risco do backlog:** a premissa do card ("2 formas paralelas, nenhuma referencia a outra") não se sustentou — leitura linha a linha achou um 3º mecanismo (`structuralBypass`) que o card nem menciona, e mostrou que a "duplicação" alegada só existe pra 1 das 5 `CLAIM_RULES` (a de entrega — as outras 4 não têm contraparte estrutural nenhuma, não há nada pra unificar ali). Para o 1 caso real de sobreposição, o achado que importa não é "estarem duplicados" — é que os 3 mecanismos DIVERGEM em rigor: `checkClaimsAgainstEvidence` (pós-LLM) verifica desde 09/07 se o arquivo enviado bate com o tipo esperado (fechando o bug de um `.py` aceito no lugar de um `.pptx` pedido); `evaluateCriteria` (checklist pré-LLM, short-circuit) e `structuralBypass` (bypass de disco, também pré-LLM) NÃO tinham essa checagem — e como os 2 rodam ANTES, "escondiam" o mesmo bug que a proteção lenta existe pra fechar, sem nunca chegar a consultá-la. Unificação completa de TIPO (fundir `CLAIM_RULES` em `SuccessCriterion`) foi rejeitada na Fase 2/4 por reintroduzir a fragilidade de 04/07 que motivou separar os 2 estágios de pipeline em primeiro lugar (`ensureDeliverySuccessCriteria` existe especificamente pra NÃO depender do texto livre do validador) — implementado em vez disso o compartilhamento de um predicado PURO (`isExpectedDeliverableFile`, extraído de código já existente e já validado em produção) nos 3 pontos, sem unificar tipo/dado. **Isso também resolveu, sem reabrir, o achado de planejamento do Checkpoint CP04** (dependência real `ARCH-012→ARCH-018`): essa dependência só se aplicava a uma unificação de TIPO, que a Fase 2/4 rejeitou — o escopo efetivamente implementado não precisa que `structuralBypass` compartilhe modelo de dados com `SuccessCriterion`, então não herda o bloqueio; `ARCH-018` permanece adiada, sem necessidade de reabertura. Mesmo padrão de correção de premissa já visto 7+ vezes neste programa (S08/S10/S11/S14/S16/S17/S18/S21) — mas desta vez, diferente da maioria dos casos anteriores, a correção da premissa não levou a adiar a Sprint: revelou um bug real e concreto (não hipotético) que uma correção de escopo muito mais estreita e segura já fechava, então a Sprint foi implementada normalmente, só que resolvendo um problema diferente do que o card original imaginava. **Com S27, todos os 26 cards do backlog estão resolvidos** (concluídos ou formalmente adiados) — resta só o Checkpoint de Encerramento `2026-12-CP05`.

---
