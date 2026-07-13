# Sprint R7 — Última crítica antes da implementação

**Data:** 2026-07-13
**Branch:** `experimental/artifact-pipeline-refactor`
**Escopo:** tentar derrubar a hipótese da R6 antes de considerar a fase arquitetural encerrada. Nenhum código alterado.

Duas das seis perguntas encontraram achados reais que mudam a recomendação final. Um deles (§1/§3) é a descoberta mais importante desta sprint e cria uma tensão genuína com o hard gate da R3 — não resolvida aqui por decisão unilateral, ver §7.

---

## 1. Ainda existe duplicação estrutural escondida?

Sim — uma terceira, não examinada em nenhuma sprint anterior. `checkDeliverables` (`GoalExecutionLoop.ts:3393`) é chamada antes do replan (R1 §6, `deliverable_check`) e faz uma **varredura real do sistema de arquivos** (`fs.readdirSync` recursivo, profundidade ≤4, filtro por extensão + `mtime` ≥ `goal.createdAt`, cap de 5 arquivos) — uma fonte de evidência **completamente independente** de `goal.attempts`. Ou seja: hoje já existem duas formas de "achar o artefato certo" que não se falam — uma por `goal.attempts` (o que o piloto R6 propõe formalizar) e uma por varredura de disco (`checkDeliverables`, já em produção). Nenhuma sprint anterior nomeou isso porque cada uma olhou só o caminho de `send_document`/`RiskAnalyzer`; `checkDeliverables` fica num call site adjacente (pré-replan) que não tinha sido reexaminado desde o mapeamento original de R1 §6.

**Isso não deveria entrar no piloto agora** (mesmo argumento de disciplina de escopo já aplicado o tempo todo): `checkDeliverables` resolve um problema um pouco diferente (achar deliverable quando NADA foi declarado — é o fallback de última instância) e sua lógica de `mtime`/profundidade/cap já é razoavelmente madura. Mas vale registrar explicitamente como consequência natural do piloto: uma vez que `exec_command` declare `producedArtifactPaths[]` de forma confiável, a necessidade de `checkDeliverables` escanear o disco tende a diminuir (ele deixa de ser o único sinal disponível) — não elimina o call site, mas reduz sua importância. Candidato natural de sprint futura, não desta.

## 2. O contrato mínimo de `exec_command` está completo?

Quase — falta uma verificação. O contrato proposto (linha `ARTIFACT: <path>` no stdout) diz o que o script *alega* ter produzido, mas nada valida isso contra a realidade. Um script que crasha no meio da execução, depois de já ter impresso `ARTIFACT: relatorio.pdf` mas antes de terminar de escrever o arquivo, deixaria uma alegação falsa em `producedArtifactPaths[]`.

Correção mínima, sem conceito novo: ao capturar as linhas `ARTIFACT:`, verificar cada path contra o disco (`fs.existsSync` + tamanho mínimo) antes de gravar em `GoalAttempt` — reusando a mesma constante `MIN_DELIVERABLE_SIZE = 200` bytes já definida em `GoalExecutionLoop.ts:877` (hoje usada só por `checkDeliverables`). Isso é reuso, não invenção — a mesma régua de "não é placeholder" já aplicada em outro lugar da mesma classe.

## 3. Existe bug histórico que contradiz a hipótese da R6?

Sim, e é a descoberta mais importante desta sprint. `project_session_bugs_jul2026_ak.md` (07/07/2026, Bug 2): quando um `PlanStep` é executado via `agentloop` (sub-turno livre, sem `toolName` fixo — R1 §9.1 já chamava isso de "comum quando o passo é criar o arquivo com conteúdo real"), toda a atividade interna (`write`+`exec_command`+`send_document`) vira **um único `GoalAttempt` opaco com `toolName='agentloop'`**. Qualquer consulta que filtre `goal.attempts` por `toolName ∈ {write, exec_command}` — exatamente o que o piloto R6 propõe para `RiskAnalyzer` no replan — **não enxerga nada** nesses casos, porque os attempts reais ficam soterrados dentro do attempt opaco.

Essa mesma classe de bug já apareceu **duas vezes** no mesmo arquivo antes desta seria a terceira: `checkClaimsAgainstEvidence` (jun/2026, corrigida usando `goal.sentArtifacts` como evidência alternativa) e `validateGoalCompletion` (07/07/2026, corrigida com o bloco `deliveredArtifactsBlock`, também lendo `goal.sentArtifacts`). A própria memória do bug já registrou a recomendação: *"se aparecer um 3º sintoma parecido... vale considerar uma extração estrutural única (`getEffectiveDeliveredArtifacts(goal)`)"*. O piloto R6, exatamente como especificado até aqui, seria esse terceiro sintoma — silenciosamente incompleto para a fração de goals que usam `agentloop` (que R1 já caracterizou como comum, não rara).

## 4. O reuso de `inferExpectedExtensions()` elimina duplicação ou só centraliza uma heurística que deveria desaparecer?

Só centraliza — e isso precisa ficar dito sem meio-termo. `inferExpectedExtensions()` continua sendo heurística (regex/palavra-chave sobre texto livre do pedido do usuário), não um contrato declarado. O ganho real do piloto é reduzir de **duas ou três heurísticas independentes, podendo divergir** para **uma heurística, uma implementação, reusada em todos os call sites** — isso é a causa estrutural de R1 §5 sendo corrigida de fato. Não é o mesmo que eliminar a natureza heurística da inferência, o que só aconteceria com o Output Contract explícito do Planner já cogitado (e corretamente adiado) em R6 §6. Ficar claro sobre isso evita que uma sprint futura trate o piloto como "problema resolvido" quando na verdade é "duplicação resolvida, heurística em si ainda pendente".

## 5. Arquitetura consolidada ainda não explorada, mais simples?

Nenhuma nova — as opções relevantes (Git/CAS, DAM, tracing, event sourcing, artifact repositories, workflow engines) já foram cobertas em R4-R6. Um reforço, não uma novidade: **Bazel** declara `outs = [...]` como contrato obrigatório de uma regra de build — se a ação não produzir exatamente o que declarou, o build falha explicitamente. Isso reforça a correção de §2 (verificar `ARTIFACT:` contra o disco) como o padrão certo, não é uma arquitetura alternativa nova. Não há indício de que mais uma rodada de comparação com arquiteturas conhecidas vá render achado novo — os candidatos já foram exauridos nas sprints anteriores.

## 6. Existe razão técnica forte para NÃO começar a implementação agora?

Não no sentido de "a arquitetura está imatura" — está. A razão para pausar antes do código é mais estreita: **o achado de §3 exige uma decisão de escopo que o hard gate da R3 não previu**, e essa decisão não deveria ser tomada unilateralmente nesta sprint. Ver §7.

---

## 7. A tensão que precisa de decisão

O hard gate da R3 lista explicitamente `sentArtifacts` entre os componentes que o piloto **não pode tocar**. O achado de §3 mostra que, sem consultar `goal.sentArtifacts` (leitura, não escrita — o mesmo padrão já usado nas duas correções anteriores da mesma classe de bug), o piloto fica cego exatamente nos casos que R1 §9.1 já descreveu como comuns (`agentloop`). Duas saídas, sem escolher por conta própria:

**Opção A — manter o hard gate literal.** Piloto resolve só o caminho `write`/`exec_command` direto no plano; casos via `agentloop` continuam com o comportamento atual (heurística sintática antiga, sem melhoria). Risco documentado e aceito, não escondido — mas o piloto entrega menos do que parece prometer, e replica (pela terceira vez) uma lacuna já conhecida em vez de fechá-la.

**Opção B — emenda mínima e escopada.** Permitir que o piloto **leia** (nunca escreva) `goal.sentArtifacts` como sinal adicional, exatamente como as duas correções anteriores da mesma classe de bug já fizeram — sem tocar `AgentLoop`, sem construir `getEffectiveDeliveredArtifacts()` como abstração nova (isso continua sendo trabalho de sprint futura, per a própria memória do bug), só estendendo a consulta do piloto para não repetir um blind spot já visto duas vezes.

Recomendação: Opção B — o argumento central de toda essa cadeia de sprints foi sempre "usar evidência real que já existe" (R5/R6); `sentArtifacts` é exatamente esse tipo de evidência já existente, e negá-la por uma leitura literal do hard gate reproduziria, de forma menor, o mesmo tipo de lacuna silenciosa que a Sprint R1 inteira foi feita para expor. Mas a decisão de esticar um hard gate que o próprio usuário definiu na R3 não é minha para tomar sozinho.

**Decisão (2026-07-13):** Opção B — emenda mínima aprovada. O hard gate da R3 fica ajustado: `sentArtifacts` pode ser **lido** (nunca escrito) pela resolução de `file_path` no replan, como sinal adicional quando `goal.attempts` não tem um `write`/`exec_command` direto (caso `agentloop`). Continua proibido: escrever em `sentArtifacts`, tocar `AgentLoop` internamente, construir `getEffectiveDeliveredArtifacts()` como abstração nova (fica para sprint futura, se um 4º sintoma da mesma classe aparecer), tocar `SessionManager`/memória/conversas.

---

## Síntese

Nenhuma alternativa "claramente superior" ao desenho da R6 apareceu — o desenho central (reusar `goal.attempts` + `inferExpectedExtensions`, sem UUID/hash/event log) resiste. As mudanças desta sprint são aditivas, não substitutivas:

1. Verificar `ARTIFACT:` declarado contra o disco (existência + `MIN_DELIVERABLE_SIZE`) antes de confiar nele — reuso de constante já existente.
2. Decisão pendente (§7) sobre ler `goal.sentArtifacts` para não herdar o blind spot de `agentloop`, já visto 2x no histórico do projeto.
3. Nomear `checkDeliverables` (§1) como candidato de simplificação futura, sem tocar agora.

Com a decisão de §7 tomada, a fase arquitetural está encerrada — não há mais pergunta em aberto que uma oitava rodada de análise resolveria sem informação nova (código real rodando).

### Especificação final do piloto (R1 → R7)

- `exec_command` declara artefatos produzidos via convenção de linha `ARTIFACT: <path>` no stdout, uma linha por artefato (§ R6.2).
- Cada `ARTIFACT:` declarado é verificado contra o disco (existência + `MIN_DELIVERABLE_SIZE` ≥200 bytes, constante já existente em `GoalExecutionLoop.ts:877`) antes de ser gravado em `GoalAttempt.producedArtifactPaths: string[]` (§ R7.2).
- `RiskAnalyzer`, no replan, resolve `file_path` de `send_document` consultando: (a) `goal.attempts` por `producedArtifactPaths` compatível com `inferExpectedExtensions(step.description ?? goal.userIntent)`, mais recente primeiro; (b) se nada compatível, **leitura** de `goal.sentArtifacts` como sinal adicional (cobre o caso `agentloop`, decisão de §7); (c) se nada em nenhum dos dois, fallback para a heurística sintática atual (comportamento inalterado).
- Nenhum UUID, hash, Event Log, Projection ou `ArtifactTrace`.
- Não tocar: escrita em `sentArtifacts`, `AgentLoop` internamente, `SessionManager`, memória, conversas, `checkDeliverables` (candidato de sprint futura, § R7.1).
- Teste de regressão obrigatório junto com o piloto: caso-limite de dois artefatos de mesma extensão esperada no mesmo goal (§ R6.4, aceito como limite não resolvido, precisa estar coberto por teste, não silenciosamente ignorado).

Nenhum código foi alterado nesta sprint.
