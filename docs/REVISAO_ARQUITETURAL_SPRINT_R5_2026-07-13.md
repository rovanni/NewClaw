# Sprint R5 — Hash não é identidade lógica: revisão do piloto

**Data:** 2026-07-13
**Branch:** `experimental/artifact-pipeline-refactor`
**Escopo:** resposta às 6 perguntas da revisão crítica sobre R4 (`docs/REVISAO_ARQUITETURAL_FINAL_SPRINT_R4_2026-07-13.md`). Nenhum código alterado.

A ressalva levantada está correta e a R4 não tinha essa distinção explícita: hash responde "este conteúdo é exatamente igual?", não "isto continua sendo o mesmo objeto de negócio?". Um documento corrigido é o mesmo documento lógico com hash diferente; um `.md` e o `.pdf` gerado a partir dele são o mesmo documento lógico com hashes que nunca vão bater. A R4 usou "identidade por conteúdo" sem declarar que estava resolvendo só a camada física — esta sprint corrige isso.

A conclusão vai além de corrigir a nomenclatura: **reexaminando a causa raiz do R1 pela terceira vez (R1 → R4 → agora), o piloto não precisa de nenhum conceito de identidade — nem hash, nem UUID.** Precisa só de uma consulta cronológica sobre dado que já existe.

---

## 1. A identidade do piloto deve ser hash de conteúdo, ou existe algo mais simples e robusto?

Existe algo mais simples: **nenhuma identidade, para o piloto.**

Voltando à causa raiz exata de R1 §5 — o `send_document.file_path` fica desatualizado depois de um replan porque `RiskAnalyzer` infere por proximidade sintática no JSON do plano, enquanto `GoalExecutionLoop` (no fix `7d086d4`) usa evidência real (`goal.attempts`) só no momento da entrega. Dentro de **um único goal**, em qualquer instante, existe exatamente um artefato "mais recente" para um determinado deliverable — o último `GoalAttempt` bem-sucedido com `toolName ∈ {write, exec_command}`. Não é preciso comparar dois artefatos para saber se "são o mesmo" (nem por hash, nem por id) — é preciso só pegar o mais recente, por ordem cronológica (`GoalAttempt.executedAt`/`cycle`, campos que já existem).

Isso já é exatamente o padrão que `writtenPaths`/`artifactPaths` usam hoje em `validateGoalCompletion` (R1 §7-8) — só que só no fim do ciclo. R4 propôs achar o artefato certo do replan; a resposta mais simples é: **rodar a mesma consulta que já existe, mais cedo**, não inventar um `producedArtifactHash`. Hash vira desnecessário porque não há nada pra comparar dentro do escopo de um goal — só há "o que foi escrito por último".

## 2. Estamos confundindo identidade física com identidade lógica?

Sim, e a confusão está um nível acima do que a ressalva já identificou: tanto R2 (UUID) quanto R4 (hash) assumiram que o piloto precisa de **algum tipo de identidade persistente** — a discussão até aqui foi "qual tipo de identidade", nunca "identidade é sequer necessária aqui". A resposta de §1 mostra que não é. Identidade (física ou lógica) só passa a ser necessária quando é preciso **correlacionar dois artefatos observados em momentos/lugares diferentes** — cross-goal (reenvio de arquivo pré-existente, R2 §12.1), ou múltiplas representações do mesmo documento (`.md`→`.pdf`). Nenhum dos dois está no hard gate aprovado pela R3. Dentro do hard gate, não há correlação a fazer — só leitura do estado mais recente.

## 3. O piloto precisa de algum conceito novo, ou só formalizar o que já existe em `GoalAttempt`?

Só formalizar. Confirma a suspeita já levantada no próprio documento de continuação. Mudança mínima:
- `exec_command` reporta, de forma estruturada, qual arquivo produziu (gap real, documentado em R1 §9.6 — isso não muda com nenhuma das revisões).
- `GoalAttempt` ganha um campo simples pra guardar isso — nome sugerido `producedArtifactPath` (um fato, não uma alegação de identidade — ver §5).
- `RiskAnalyzer`, no replan, consulta `goal.attempts` por esse campo (mais recente, bem-sucedido) em vez de inferir do texto do plano.

Nada disso é um conceito novo — é o mesmo padrão de `writtenPaths` já existente, aplicado num ponto do ciclo de vida onde hoje não é aplicado.

## 4. Existe risco arquitetural ainda não identificado, decorrente de identidade por conteúdo?

Como a recomendação desta sprint é **não adotar hash como identidade no piloto**, o risco fica moot para o piloto em si. Mas vale registrar para quando hash for reintroduzido (cross-goal, fora de escopo agora): hash não deve nunca ser chamado ou tratado como "identidade do artefato" — só como impressão digital de conteúdo, útil para checagem de duplicata exata. Se no futuro for necessário decidir "isto é o mesmo documento que já vimos", hash sozinho vai errar sistematicamente nos dois exemplos que a ressalva já deu (correção de conteúdo; mesmo documento em formatos diferentes) — ver §6 para o padrão certo nesse caso futuro.

## 5. Como evitar que o piloto cristalize conceitos que dificultem a separação futura (Documento Lógico × Representação Física × Histórico)?

Evitando nomear qualquer coisa como "identidade" agora. `producedArtifactPath` é uma leitura de fato (o que o `exec_command` escreveu), não uma alegação de que dois artefatos "são o mesmo objeto". Isso deixa a porta aberta pra três camadas futuras, cada uma resolvida pelo padrão certo quando (e se) houver evidência de necessidade — não antes:

- **Documento lógico** — quando for preciso, é um Entity com ID atribuído na criação (padrão DDD, ver §6) — não hash, não path.
- **Representação física** — hash de conteúdo continua sendo a ferramenta certa aqui (R4 estava certa nisso, só chamou a coisa errada de "identidade").
- **Histórico operacional** — event log / distributed tracing (R2), quando `sentArtifacts`/`SessionManager`/cross-goal entrarem em escopo.

O piloto de hoje não constrói nenhuma das três camadas — só formaliza um dado que já existe (§3), o que não compromete nenhuma delas depois.

## 6. Existe arquitetura consolidada ainda não explorada que modele isto melhor?

Sim — **DDD: Entity vs. Value Object** é a peça que faltava conectar. A ressalva descreve exatamente essa distinção sem nomeá-la:

- Um **Value Object** é definido inteiramente pelo seu conteúdo — dois Value Objects com o mesmo conteúdo são intercambiáveis. Hash de conteúdo é a implementação natural de igualdade de Value Object. É isso que R4 encontrou (ad hoc, em `GoalExecutionLoop.ts`) — e é a resposta certa pra "representação física" (§5).
- Uma **Entity** tem um ID atribuído na criação, independente do conteúdo, e permanece "a mesma entidade" mesmo quando seu conteúdo muda (ex.: uma linha de banco de dados com PK estável, mesmo depois de um `UPDATE`). Isso é exatamente "documento corrigido continua sendo o mesmo documento" da ressalva. **Se e quando** o projeto precisar de identidade lógica de verdade, o padrão certo é uma Entity com ID atribuído — o que, ironicamente, é estruturalmente parecido com o `traceId` (UUID) que a R2 propôs originalmente. A R2 não estava errada na forma; estava errada no *momento* (nenhuma evidência ainda de que o piloto precisa disso) e na *ambição* (tentou ser Entity + Value Object + Log num conceito só).

Isso também reconecta com o achado já feito em R4 §3: **DAM (Asset × Rendition) já é a materialização desse par** — `Asset` = Entity (documento lógico), `Rendition` = Value Object por hash (representação física). Nada novo a inventar; só uma confirmação de que a arquitetura certa, quando for a hora, já estava certa desde R4 — só precisava do vocabulário DDD pra ficar inequívoca.

**Não explorado até agora, vale registrar para o futuro:** *Idempotency keys* de workflow engines (Temporal, Airflow) resolvem um problema adjacente — "esta execução já aconteceu?" — usando uma chave de negócio (não hash, não UUID técnico) definida pelo chamador. É outro exemplo do mesmo princípio: identidade lógica é **atribuída por quem entende o domínio**, nunca **derivada** de uma propriedade técnica do dado (path ou hash). Reforça por que nem R2 (UUID técnico opaco) nem R4 (hash) tinham a resposta completa para a camada lógica — só a R5 (não precisar de identidade lógica ainda) e a observação DDD (quando precisar, é Entity/ID atribuído com significado de negócio, não técnico) fecham o raciocínio.

---

## Síntese

| | R4 | R5 (esta sprint) |
|---|---|---|
| Conceito novo introduzido | Identidade por hash de conteúdo | Nenhum |
| Campo novo | `producedArtifactHash` | `producedArtifactPath` (fato, não identidade) |
| Mecanismo de resolução no replan | Comparar hash | Consultar `goal.attempts` por recência (padrão já usado em `writtenPaths`) |
| O que fica registrado para o futuro | — | Se/quando precisar de identidade lógica: Entity com ID atribuído (DDD), não hash. Hash continua certo só para a camada de representação física (Value Object). |

O piloto (escopo travado pela R3: `exec_command` declara o que produziu + `RiskAnalyzer` resolve `file_path` no replan) não muda de tamanho — muda de mecanismo, ficando **menor ainda** que a R4: zero conceitos novos, só um campo de fato e uma consulta cronológica sobre estrutura que já existe.

Nenhuma das hipóteses em aberto de R3 (dedup sob retry, reenvio de arquivo pré-existente) é resolvida por esta sprint — continuam fora do hard gate, e continuam sendo o ponto onde, no futuro, a distinção Entity/Value Object (§6) vai ser precisa de verdade.

Nenhum código foi alterado nesta sprint.
