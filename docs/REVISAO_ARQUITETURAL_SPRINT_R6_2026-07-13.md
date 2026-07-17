# Sprint R6 — Critério de seleção, múltiplos artefatos, nomenclatura

**Data:** 2026-07-13
**Branch:** `experimental/artifact-pipeline-refactor`
**Escopo:** resposta às 3 ressalvas sobre R5 e às 6 perguntas da continuação. Nenhum código alterado.

As três ressalvas sobre R5 são legítimas — duas delas expõem lacunas reais no desenho; a terceira, ao ser testada contra o próprio princípio que a motivou, não se sustenta. Tratar as três com o mesmo rigor crítico usado nas sprints anteriores, inclusive contra a ressalva.

---

## 1. O critério de seleção do artefato correto durante o replan está completamente definido?

Não estava — a Ressalva 1 está certa. "Último `GoalAttempt`" ignora que um goal pode produzir mais de um artefato ao longo da execução (`relatorio.pdf` e depois `grafico.png`), e o mais recente não é necessariamente o deliverable do `send_document` em questão.

A correção não precisa de conceito novo: `GoalExecutionLoop.inferExpectedExtensions(userIntent): string[]` (`src/loop/GoalExecutionLoop.ts:3366`) **já existe, já está em produção, e já resolve exatamente esse tipo de ambiguidade** — foi o mecanismo usado para corrigir o Bug 3 de 09/07 (`.py` sendo aceito como prova de entrega de `.pptx`, `project_session_bugs_jul2026_ap`), num call site diferente (`checkClaimsAgainstEvidence`, tempo de validação final). Critério revisado para o replan:

> Entre os `GoalAttempt` bem-sucedidos com artefato registrado, filtrar pelos que têm extensão compatível com `inferExpectedExtensions(step.description ?? goal.userIntent)`; dentro desse subconjunto, pegar o mais recente. Se nenhum artefato bate com a extensão esperada, ou se a extensão não é inferível, cair no comportamento permissivo atual (mais recente sem filtro) — mesma regra de fallback já usada em `checkClaimsAgainstEvidence`.

Isso não introduz uma abstração nova de "compatibilidade" — reusa um mecanismo já validado em produção, só aplicado num ponto do ciclo de vida (replan) onde hoje não é usado. Consistente com o próprio achado de R5 (§3: "o problema é ausência de reutilização de evidência", não ausência de mecanismo).

**Limite aceito, não escondido:** se dois artefatos com a MESMA extensão esperada existirem no mesmo goal (ex.: um `relatorio_v1.pdf` intermediário e o `relatorio_final.pdf`), extensão não desambigua — o critério cai para "mais recente dentro do subconjunto filtrado", que é razoável mas não garantidamente correto. Ver §4.

## 2. Como representar múltiplos artefatos por comando sem aumentar complexidade desnecessariamente?

Ressalva 2 está certa: um único `exec_command` pode gerar `README.md` + `relatorio.pdf` + `slides.pptx` + `log.txt` na mesma chamada. Um campo escalar (`producedArtifactPath: string`, como escrito em R5) não representa isso.

Correção mínima: o campo vira array — `producedArtifactPaths: string[]` em `GoalAttempt`. Isso não muda a forma do contrato de saída proposto em R1 §10.1 (convenção de linha `ARTIFACT: <path>` no stdout) — essa convenção já suportava N linhas implicitamente, só não estava explícito que o campo de armazenamento precisava ser uma coleção. Nenhuma abstração de "coleção inteligente" — um array simples, populado por quantas linhas `ARTIFACT:` o script emitir.

Importante manter explícito (evita reabrir a discussão de scan/heurística): a lista é **declarada pelo script**, nunca inferida por varredura do workspace. `log.txt` do exemplo só entraria na lista se o autor do script decidisse emitir `ARTIFACT: log.txt` — o que normalmente não faria, porque log não é um deliverable. Isso preserva o princípio "formalizar, não inferir" que atravessa R1→R6.

## 3. Path não representa o conceito — nomenclatura mais neutra?

Aqui a ressalva não se sustenta, e vale dizer isso com a mesma franqueza que as duas anteriores mereceram razão.

O argumento (blob storage/backend remoto no futuro) é exatamente o tipo de abstração prematura que o próprio `CLAUDE.md` do projeto proíbe: *"abstrações só podem surgir quando sustentadas por evidências"* (linha 38 do documento de continuação, citando a diretriz). Hoje, 100% dos artefatos do NewClaw são arquivos no sistema de arquivos local (`fs.existsSync`, `resolvePath`, confirmado em toda a auditoria de R1) — não existe nenhum backend remoto, nenhuma evidência de que um vai existir. Renomear `path` para algo neutro (`location`, `ref`, `uri`) agora não previne uma migração futura de forma nenhuma — quando (e se) um segundo backend aparecer com evidência real, renomear um campo é um refactor mecânico e trivial, não uma decisão arquitetural que precisa ser antecipada. Nomear com neutralidade prematura tem custo (indireção sem propósito, um nome menos claro hoje) e benefício zero verificável agora.

**Decisão:** manter `producedArtifactPaths: string[]`, path mesmo — é literalmente o que é. Consistente com Ressalva 1/2 (que foram aceitas por resolverem lacunas reais) e com a rejeição desta (que resolve um problema hipotético, não real) — o critério é o mesmo nos três casos: evidência, não simetria de forma.

## 4. Existe algum caso real/histórico que ainda quebre a hipótese da R5 (revisada com §1-3)?

Um caso real corrobora o desenho, um caso hipotético expõe o limite já reconhecido em §1:

- **Corrobora:** o Bug 3 de 09/07 (`.py` aceito como prova de `.pptx`) já foi corrigido em produção usando exatamente `inferExpectedExtensions` — a mesma ferramenta que §1 propõe reusar no replan. Não é uma hipótese nova sendo testada; é um mecanismo que já provou resolver esse tipo exato de ambiguidade.
- **Limite não resolvido, aceito conscientemente:** dois artefatos de mesma extensão esperada no mesmo goal (relatório intermediário vs. final) — extensão não desambigua, cai pra "mais recente entre os compatíveis", que é uma heurística razoável mas não uma garantia. Não é motivo para bloquear o piloto (nenhum bug histórico documentado bateu nesse caso especificamente), mas deveria virar um teste de regressão explícito no momento da implementação, não um ponto cego silencioso.

## 5. Estamos atacando a causa estrutural correta, ou ainda existe simplificação excessiva?

A causa estrutural correta (R1 §5): duas heurísticas de resolução de `file_path`, independentes, sem comunicação — uma sintática (`RiskAnalyzer`, tempo de plano), uma por evidência (`GoalExecutionLoop`, tempo de entrega). Com §1 desta sprint, a correção deixa de ser "inventar uma terceira forma de resolver" e passa a ser **fazer as duas convergirem para o mesmo mecanismo** (`goal.attempts` + `inferExpectedExtensions`), rodando em dois momentos do ciclo de vida. Isso é mais forte estruturalmente do que qualquer versão anterior (R2 UUID, R4 hash) porque não adiciona um terceiro caminho paralelo — elimina a duplicação ao fazer o caminho de planejamento reusar literalmente a mesma função que o caminho de execução já usa.

Simplificação excessiva remanescente: nenhuma identificada nesta passada, exceto o limite já nomeado em §4 (aceito, não escondido).

## 6. Arquitetura consolidada ainda não explorada?

Duas, uma que reforça o desenho atual e uma que é genuinamente mais elegante mas prematura:

- **Artifact Repositories (Maven/npm/Docker registries):** o publicador declara explicitamente o que publica (coordenadas Maven, `files` do `package.json`, `COPY --from` em multi-stage builds) — nunca por varredura do diretório de build. É o mesmo princípio da convenção `ARTIFACT: <path>` (opt-in, declarativo) já adotada desde R1 §10.1, agora reforçada por um paralelo direto da indústria que ainda não tinha sido nomeado nesta cadeia de sprints (R1-R5 citaram Git/CAS/DAM/tracing/build systems genéricos, nunca artifact repositories especificamente).
- **Workflow engines com output binding nomeado (Airflow XCom, Temporal activity results):** uma task declara resultados sob um **nome de slot lógico** (não por tipo de arquivo), e a task seguinte referencia esse nome — resolveria o limite de §4 (mesma extensão, deliverable ambíguo) de forma mais precisa que `inferExpectedExtensions`. É **genuinamente mais elegante** para esse caso específico, mas exige mudar o schema de `PlanStep` (o step precisaria declarar um `outputSlot` nomeado) e o prompt do `GoalPlanner` — superfície bem maior que o piloto atual, sem evidência de que o limite de §4 já causou um bug real (ver §4). **Não adotar agora** — registrar como evolução natural se/quando aparecer um caso real de ambiguidade por extensão, não antes.

---

## Síntese — piloto R6 (substitui a forma final de R5)

| Campo/mecanismo | R5 | R6 |
|---|---|---|
| Armazenamento em `GoalAttempt` | `producedArtifactPath: string` | `producedArtifactPaths: string[]` |
| Critério de seleção no replan | Mais recente, sem filtro | Mais recente **entre os compatíveis com `inferExpectedExtensions`**, com fallback para "mais recente sem filtro" se nada bater |
| Nomenclatura | — | Mantida (`path`) — ressalva de neutralidade rejeitada por falta de evidência |
| Mecanismo de extensão | Não usado no replan | Reuso de `inferExpectedExtensions` (`GoalExecutionLoop.ts:3366`), hoje privado — precisa virar helper compartilhado (mesmo padrão já aplicado no projeto a `sanitizePlanSteps`, `CONTENT_STUB_PATTERNS`, `resolvePath`, `extractMissingExecutable`) pra ser chamado também por `RiskAnalyzer` |

Escopo do hard gate da R3 continua intacto (`exec_command` + resolução de `file_path` no replan; nada de `sentArtifacts`/`SessionManager`/memória/`agentloop`/conversas).

**Avaliação de maturidade (conforme pedido pela diretriz final do log):** as três ressalvas foram endereçadas — duas aceitas e incorporadas (§1, §2), uma rejeitada com justificativa (§3). O único ponto em aberto é o limite nomeado em §4, que é um risco conhecido e testável, não uma lacuna de design. Não surgiu, nesta passada, nenhuma alternativa "claramente superior" que justifique abandonar a hipótese da R5/R6 — a alternativa mais elegante encontrada (output binding nomeado, §6) foi deliberadamente adiada por falta de evidência de necessidade, seguindo a mesma régua aplicada a toda a cadeia R1-R6. **A arquitetura do piloto parece ter atingido maturidade suficiente para implementação**, condicionada a: (a) o teste de regressão do caso-limite de §4 ser escrito junto com o piloto, não depois; (b) manter o hard gate de escopo da R3 sem expansão.

Nenhum código foi alterado nesta sprint.
