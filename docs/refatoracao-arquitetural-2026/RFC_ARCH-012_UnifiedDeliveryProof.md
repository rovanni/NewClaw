# RFC ARCH-012 — Unificar `Goal.successCriteria` e `checkClaimsAgainstEvidence.CLAIM_RULES`

**Sprint:** 2026-11-S27. **Status:** Documento de Fase 1-5 completo, per `DIRETRIZ_ARQUITETURA_2026-07-13.md`. **Decisão de implementar (escopo reformulado) registrada abaixo.**

## Card original (`ARCHITECTURAL_BACKLOG.md`)

> Duas formas paralelas de responder "existe prova de que X foi cumprido": uma estruturada e decidida no plano inicial (`successCriteria`), outra inferida por regex sobre a prosa de outro LLM (o validador) depois do fato (`CLAIM_RULES`). Fontes diferentes, momentos diferentes, nenhuma referencia a outra.

## Achado do Checkpoint CP04 que esta RFC precisa endereçar na Fase 1

O checkpoint `2026-11-CP04` (concluído antes desta Sprint) registrou que a dependência funcional real `ARCH-012 → ARCH-018` (`ARCH-018` foi adiada em S18, `docs/issues/010` — `structuralBypass` não foi absorvido por `evaluateCriteria`) continua aberta, e que esta Sprint precisa decidir explicitamente entre: reabrir `ARCH-018` como pré-requisito, modelar `structuralBypass` como 3ª fonte de evidência na unificação, ou concluir que unificar agora é prematuro. A Fase 1 abaixo endereça isso diretamente.

---

## Fase 1 — Compreensão

### Não são 2 mecanismos, são 3

Lendo `GoalExecutionLoop.ts` linha a linha (não confiando na descrição do card):

1. **`evaluateCriteria()` / `Goal.successCriteria`** (`GoalExecutionLoop.ts:3219-3322`) — checklist determinístico, avaliado **ANTES** de qualquer chamada ao LLM validador. Se `result==='all_met'`, `validateGoalCompletion()` retorna `achieved:true` **sem nunca consultar o LLM** (`GoalExecutionLoop.ts:3339-3345`). `SuccessCriterion.check` é um enum fechado de 4 predicados estruturais sobre `GoalAttempt[]` (`tool_succeeded`, `output_contains`, `output_not_contains`, `file_exists` — `shared/domainTypes.ts:63-67`), nunca sobre texto livre.
2. **`structuralBypass`** (`GoalExecutionLoop.ts:1072-1081`, dentro de `runValidationPhase()`) — checagem de disco: se o único trabalho pendente é `send_document` para um arquivo que já existe com tamanho substantivo, força `achieved:true` **sem chamar `evaluateCriteria()` nem `validateGoalCompletion()` nem o LLM validador**. Existe especificamente para o deadlock histórico "reenviar arquivo já existente" (`project_session_bugs_jul2026_ap`).
3. **`checkClaimsAgainstEvidence()` / `CLAIM_RULES`** (`GoalExecutionLoop.ts:3619-3764`) — só roda **DEPOIS** do LLM validador responder `achieved:true` dentro de `validateGoalCompletion()` (`GoalExecutionLoop.ts:3553-3583`), como um filtro anti-alucinação sobre o **texto livre** (`summary`) que o LLM escreveu — 5 regras regex genéricas (`foi apresentado`, `foi enviado/entregue`, `foi exportado/convertido`, `foi organizado`, `foi criado/gerado`), cada uma mapeada a um conjunto de tools que deveriam ter rodado com sucesso para sustentar a alegação.

O card citou 2; o código tem 3. `structuralBypass` é exatamente o mecanismo que motivou `ARCH-018` (adiada) — a razão pela qual o CP04 sinalizou a dependência: qualquer unificação que ignore `structuralBypass` deixa um 3º caminho de fora, mesmo que unifique os outros 2 perfeitamente.

### Quem produz `successCriteria`

Dois produtores (`grep` completo de `successCriteria\s*[:=]`):
- **`GoalPlanner.ts:941-942`** — o LLM do plano propõe critérios livremente, por goal, no JSON do plano inicial.
- **`ensureDeliverySuccessCriteria()`** (`planning/ensureDeliverySuccessCriteria.ts`) — injeta deterministicamente um critério `tool_succeeded`/`tool:'send_document'` (ou `send_audio`) sempre que o plano final contém esse step, **independente do que o LLM do plano lembrou de propor**. O próprio docstring da função (linhas 7-14) documenta o bug real que a motivou: 04/07/2026, um goal de áudio foi marcado `achieved:true` só por causa de fraseio ambíguo no resumo do validador ("foi enviado" vs "enviou") — **nenhuma tool de entrega real precisava ter tido sucesso genuíno**. `successCriteria` foi desenhado deliberadamente para **não depender do texto livre do LLM validador** nesse caso — esse é o motivo de ele rodar ANTES do LLM, não depois.

### `CLAIM_RULES` é genérico, não por-goal

As 5 regras são hardcoded, estáticas, e se aplicam a **qualquer** goal — não são geradas a partir do plano específico. Não existe (e não pode existir, sem inventar novos critérios) um `successCriteria` correspondente às 4 categorias "apresentação", "exportação", "organização", "criação" — só a categoria "envio/entrega" tem uma contraparte estrutural (`AUTO_DELIVERY_CRITERION_IDS`).

### Achado real 1 — a premissa do card só se sustenta para 1 das 5 `CLAIM_RULES`

Comparação campo a campo confirma: só a regra "foi enviado/entregue" (`requiredTools: ['send_document', 'send_audio']`) tem uma contraparte estrutural real em `successCriteria` (via `ensureDeliverySuccessCriteria`). As outras 4 regras não duplicam nada — são a única defesa existente contra alucinação de categorias de ação que `successCriteria` nunca tenta cobrir. "Unificar tudo" trataria como duplicação algo que, para 4/5 dos casos, não é.

### Achado real 2 — para o 1 caso que É duplicação, os dois mecanismos hoje **divergem em rigor**, e isso é um bug real, não hipotético

`checkClaimsAgainstEvidence()` tem, desde 09/07/2026 (comentário no código, linhas 3676-3686, motivado por `project_session_bugs_jul2026_ap`), uma checagem de **tipo de arquivo**: um `send_document` só conta como evidência de entrega se o arquivo enviado bater com a extensão que `inferExpectedExtensions(goal.userIntent)` espera (`matchesExpectedType()`, linhas 3688-3689). O incidente que motivou isso: um script `.py` foi enviado por engano no lugar do `.pptx` pedido, e o evidence-checker aceitou porque `sentArtifacts` não estava vazio — sem checar SE o arquivo certo tinha sido enviado.

**`evaluateCriteria()`'s `case 'tool_succeeded'`** (linhas 3240-3248) — o caminho que resolve o critério auto-injetado de entrega — **não tem nenhuma checagem de tipo**: `if (relevant.length > 0) { criterion.status = 'met'; ... }`. Qualquer `send_document` bem-sucedido, de **qualquer arquivo**, satisfaz o critério.

**`structuralBypass`** (linhas 1072-1081) — também não tem checagem de tipo: só `fs.statSync(resolved).size >= MIN_DELIVERABLE_SIZE`.

**Consequência real, não hipotética:** como `evaluateCriteria()` roda ANTES do LLM validador e `structuralBypass` roda ANTES de `evaluateCriteria()` sequer ser chamado, **2 dos 3 caminhos que decidem "entrega comprovada, `achieved:true`" nunca passam pela proteção de tipo de arquivo que foi adicionada especificamente para fechar o incidente de 09/07** — essa proteção só é exercitada quando o goal cai no caminho mais lento (LLM validador → `achieved:true` → `checkClaimsAgainstEvidence`). Um goal cujo único critério pendente é o de entrega auto-injetado, ou cujo único step pendente é um `send_document` de arquivo já existente, pode reproduzir o MESMO bug de 09/07 (arquivo errado, mas do tamanho certo, aceito como prova de entrega) sem que a proteção já escrita para esse exato cenário jamais seja consultada.

### Trabalho relacionado já feito nesta área (histórico real, não hipotético)

- `S16`/`ARCH-005` (18/07): consolidação de `sentArtifacts` como fonte de artefatos entregues; achado real foi um bug de normalização de path (não o que o card original presumia) — mesma família de "premissa do card estava incompleta, o bug real era outro, mais específico".
- `S18`/`ARCH-018` (adiada): tentou fazer `successCriteria`/`file_exists` absorver `structuralBypass` — bloqueado porque `file_exists` checa `GoalAttempt.output` (prova indireta via attempt), enquanto `structuralBypass` faz `fs.statSync()` direto no disco, sem depender de nenhum attempt do goal atual — reaproveitar `file_exists` literalmente reintroduziria o deadlock histórico que `structuralBypass` existe para fechar.
- Nenhuma tentativa anterior neste programa tentou unificar especificamente `CLAIM_RULES` com `successCriteria` — este é o primeiro exame real dessa dupla.

---

## Fase 2 — Crítica da hipótese

1. **Unificação completa de tipo (fundir `CLAIM_RULES` em `SuccessCriterion`/`CriterionCheck`) tem alto risco por baixo valor real.** 4 das 5 regras não duplicam nada — inventar novos `CriterionCheck`/critérios auto-injetados para "apresentação"/"organização"/"exportação"/"criação" só para ter algo a unificar é scope creep sem evidência de necessidade (nenhum incidente documentado motiva isso). E os 2 mecanismos operam em domínios de dado fundamentalmente diferentes por um motivo deliberado e documentado: `successCriteria` existe especificamente para NÃO depender do texto livre do LLM validador (bug de 04/07 que motivou `ensureDeliverySuccessCriteria`); fundir os dois em um único modelo/momento de avaliação arriscaria reintroduzir exatamente essa fragilidade para o caminho comum (a maioria dos goals resolve via o checklist rápido, não via o LLM).
2. **O card, mesmo interpretado literalmente, ignora um 3º mecanismo (`structuralBypass`) que responde à mesma pergunta.** "Unificar os 2 nomeados" deixaria esse 3º caminho — que tem exatamente o mesmo gap de tipo — de fora, mesmo que a unificação dos outros 2 fosse perfeita.
3. **Conflito real com decisão anterior:** `ensureDeliverySuccessCriteria` foi desenhada deliberadamente (docstring próprio) para bypassar a fragilidade do texto livre do validador. Qualquer unificação que faça o caminho comum de critérios de entrega voltar a depender de correspondência de padrão sobre texto livre reintroduziria o bug de 04/07 que essa função existe para fechar — inaceitável.
4. **Nenhuma das alternativas de unificação de tipo elimina uma classe de bug nova; existe um bug REAL e não-hipotético já identificado (Achado real 2) que uma correção muito mais estreita já fecha.** Preferir a correção que ataca a causa raiz confirmada, não a reformulação de tipo mais ambiciosa e arriscada — mesmo princípio já usado nas RFCs de `ARCH-015`/`ARCH-024` (escopo reduzido ao que tem evidência real).
5. **Risco de God Object:** nenhuma das alternativas consideradas (Fase 3) introduz uma classe/serviço central novo — não se aplica aqui.

---

## Fase 3 — Pesquisa de alternativas

| Alternativa | Escopo | Risco | Evidência de valor real |
|---|---|---|---|
| **A — Unificação completa de tipo:** `CLAIM_RULES` viram entradas de `SuccessCriterion`/`CriterionCheck` novo, um único modelo/momento de avaliação | Redesenhar `CriterionCheck` para incluir um variant que opera sobre texto livre pós-LLM; inventar critérios auto-injetados para as 4 categorias sem contraparte hoje; decidir quando cada um roda | Alto — arrisca reintroduzir a fragilidade de 04/07 no caminho comum; scope creep para 4 categorias sem incidente real; força 2 estágios de pipeline com propósitos diferentes (pré-LLM rápido vs. pós-LLM anti-alucinação) a compartilhar 1 modelo | Nenhum incidente real motiva as 4 categorias sem contraparte; a fusão de estágio arrisca o único incidente real que motivou a separação em primeiro lugar |
| **B — Rejeitar, encerrar sem código** | Nenhuma mudança | Nenhum | Resultado válido per o card ("risco supera o benefício") — mas deixaria aberto um bug REAL confirmado nesta própria investigação (Achado real 2), que uma correção de escopo muito menor já fecha com segurança |
| **C — Reabrir `ARCH-018` primeiro** (absorver `structuralBypass` no modelo de `SuccessCriterion`), só então reavaliar unificação com `CLAIM_RULES` | Retomar o desenho já rejeitado em S18 (`file_exists` não serve; precisaria de um `CriterionCheck` novo tipo `file_exists_on_disk` independente de attempts) | Médio-Alto — esforço maior, sem reduzir o risco do gap de tipo encontrado (que não depende de `structuralBypass` estar unificado ou não) | O gap de tipo (Achado real 2) pode ser fechado sem depender disso — tornaria C um trabalho adicional sem ganho extra sobre D |
| **D — Escopo reformulado: extrair o predicado de verificação de tipo já existente e aplicá-lo nos 2 caminhos que hoje não o têm** — `matchesExpectedType()`/`inferExpectedExtensions()` (já implementado, já testado em produção dentro de `checkClaimsAgainstEvidence`) vira uma função exportada (`isExpectedDeliverableFile`, em `planning/inferExpectedExtensions.ts` — mesmo módulo, mesmo padrão de extração do ARCH-026) e passa a ser chamada também em `evaluateCriteria()` (caso `tool_succeeded`/`tool:'send_document'`) e em `structuralBypass` | 2 pontos de chamada novos + 1 função extraída (sem mudança de tipo/dado); nenhuma mudança em `CLAIM_RULES` nem em `SuccessCriterion` | Baixo — reusa uma função já permissiva-por-design e já validada em produção (não inventa heurística nova); pontos de chamada isolados e testáveis independentemente | Fecha diretamente o bug confirmado do Achado real 2, nos 2 caminhos que hoje o reproduzem — sem precisar resolver `ARCH-018` primeiro, porque a correção não exige que os 3 mecanismos compartilhem tipo, só que compartilhem o mesmo predicado de verificação |

---

## Fase 4 — Síntese

**Recomendação: Alternativa D — escopo inteiramente reformulado em relação ao card original.**

O card pedia "unificar `successCriteria` e `CLAIM_RULES`" presumindo que a duplicação estrutural entre eles é o problema. A investigação real mostrou o oposto do que o card presumia em 2 pontos: (1) a "duplicação" só existe para 1 de 5 regras — as outras 4 não têm nada para unificar; (2) para essa 1 regra que de fato se sobrepõe, o problema real não é "estarem duplicadas", é **divergirem em rigor** — o mecanismo mais rápido (checklist, `structuralBypass`) é MENOS rigoroso que o mais lento (`checkClaimsAgainstEvidence`), criando um bypass reproduzível do mesmo bug que motivou adicionar rigor ao mecanismo lento em primeiro lugar.

D fecha exatamente esse gap, com risco baixo: extrai uma função já existente e já permissiva-por-design (não inventa heurística nova) e a aplica nos 2 pontos que hoje não a chamam. Não precisa de `ARCH-018` como pré-requisito — a dependência que o CP04 sinalizou dizia respeito a uma unificação de TIPO (que exigiria decidir onde `structuralBypass` "mora" no modelo de dados); D não faz esse tipo de unificação, só compartilha uma função pura entre os 3 locais, o que não tem essa dependência.

**Por que A foi descartada:** alto risco (reintroduz a fragilidade de 04/07 no caminho comum), scope creep sem evidência (4 de 5 regras não têm contraparte), maior esforço sem eliminar o bug real encontrado nesta investigação (o gap de tipo persistiria mesmo com os tipos unificados, a menos que o novo tipo unificado também incorporasse a checagem — nesse caso a unificação de tipo não seria o que resolve o bug, D resolveria de qualquer forma).

**Por que B foi descartada:** deixaria aberto um bug real, evidenciado por código (não hipotético), que D fecha com risco baixo — inconsistente com a filosofia do programa de eliminar causas estruturais confirmadas quando uma correção segura e incremental existe.

**Por que C foi descartada:** resolve uma questão de modelagem de dados (onde `structuralBypass` "mora") que não é pré-requisito para fechar o bug real encontrado — trabalho adicional sem redução de risco adicional sobre D.

**Riscos que permanecem:**
- `isExpectedDeliverableFile()` herda o mesmo comportamento permissivo de `inferExpectedExtensions()`: quando o intent não permite inferir uma extensão esperada, a função não restringe nada — goals com intent genérico continuam sem essa proteção, nos 3 caminhos. Isso não é um risco NOVO introduzido por esta mudança — é o mesmo comportamento já aceito em produção desde que `checkClaimsAgainstEvidence` ganhou essa checagem (09/07).
- Mudar `evaluateCriteria()`'s `tool_succeeded`/`send_document` para exigir tipo correto pode, em teoria, fazer um critério que hoje resolve na 1ª tentativa (`achieved:true` via checklist rápido) passar a cair no caminho lento (LLM validador) quando o arquivo enviado não bate com o tipo esperado — **efeito pretendido**, não colateral: nesse cenário, o LLM validador + `checkClaimsAgainstEvidence` vão pegar a mesma inconsistência que já pegam hoje nesse caminho, só que agora o checklist rápido não vai mais "esconder" o problema antes de chegar lá.
- `structuralBypass` deixando de disparar quando o arquivo em disco não bate com o tipo esperado significa que esses goals caem no fluxo normal de replan/validação — comportamento mais lento, mas correto; nenhuma regra permanente do programa proíbe isso.

---

## Fase 5 — Validação

- **Baseada em evidências reais do projeto, não hipótese?** Sim — os 2 achados centrais (divergência de rigor entre `evaluateCriteria`/`structuralBypass` e `checkClaimsAgainstEvidence`) vêm de leitura linha a linha do código real, não de suposição.
- **Resolve um problema estrutural ou só um sintoma?** Estrutural — fecha a causa raiz (ausência do mesmo predicado nos 3 lugares que decidem a mesma pergunta), não um caso isolado.
- **Reduz a complexidade total do sistema?** Sim — 1 função pura nova, reusada, em vez de 3 implementações divergentes da mesma checagem (2 delas simplesmente ausentes hoje).
- **Elimina múltiplas fontes de verdade?** Parcialmente e honestamente: não elimina os 3 MECANISMOS (isso exigiria a unificação de tipo que a Fase 2/4 rejeitou por risco) — elimina a DIVERGÊNCIA de comportamento entre eles para a checagem de tipo de arquivo especificamente.
- **Mantém a filosofia do Cognitive Kernel?** Sim — sem novo God Object, sem acoplamento novo entre módulos (a função nova mora no módulo que já é a fonte única de `inferExpectedExtensions`).
- **Pode ser implementada incrementalmente?** Sim — 2 pontos de chamada, cada um testável e revertível isoladamente.
- **Pode ser revertida facilmente?** Sim — remover as 2 chamadas novas volta ao comportamento atual exatamente.

Todas as respostas satisfatórias — **aprovada para implementação, escopo D.**

## Decisão

**Aprovada para implementação com escopo reformulado.** Não implementa a unificação de tipo pedida literalmente pelo card original (rejeitada na Fase 2/4, risco alto e valor não evidenciado para 4 das 5 regras) — implementa o fechamento do gap de rigor real encontrado nesta investigação entre os 3 mecanismos que hoje respondem "entrega comprovada":

1. `isExpectedDeliverableFile(userIntent, filePath): boolean` nova, exportada em `planning/inferExpectedExtensions.ts`, extraída do `matchesExpectedType` hoje inline em `checkClaimsAgainstEvidence`.
2. `checkClaimsAgainstEvidence()` passa a chamar a função extraída (comportamento idêntico, só a origem do código muda).
3. `evaluateCriteria()`'s `case 'tool_succeeded'` passa a chamar a mesma função quando `criterion.tool === 'send_document'`, antes de marcar `status:'met'`.
4. `structuralBypass` (`runValidationPhase`) passa a chamar a mesma função no predicado `.every()`, antes de aceitar o bypass.

`ARCH-018` (absorver `structuralBypass` no modelo de dados de `SuccessCriterion`) **permanece adiada** — esta RFC não a resolve nem depende dela: a correção aprovada compartilha uma função, não um tipo de dado, então a dependência que o CP04 sinalizou (relevante só para uma unificação de TIPO) não se aplica ao escopo D.
