# Sprint R2 — Análise Arquitetural: "Cognitive Envelope"

**Data:** 2026-07-13
**Branch:** `experimental/artifact-pipeline-refactor`
**Escopo:** apenas análise. Nenhuma linha de código alterada nesta sprint.
**Base:** achados da Sprint R1 (`docs/AUDITORIA_PIPELINE_ARTEFATOS_SPRINT_R1_2026-07-13.md`) + histórico real do `ArtifactDeliveryRegistry` (implementado em `1dafdab`, integrado parcialmente, removido em `a7862d3` por "8 bugs críticos, 3 interdependentes, zero callers em `src/`").

---

## Resumo executivo

A hipótese está correta sobre o diagnóstico, mas a analogia com a pilha OSI é a parte mais frágil da proposta. O problema real que a Sprint R1 documentou não é "falta de uma camada de transporte" — é falta de **identidade estável, atribuída na criação, que sobreviva a replan**. O NewClaw já tentou uma versão desse conceito (`ArtifactDeliveryRegistry`) e ela morreu especificamente porque sua identidade era derivada de `hash(path + goalId)` — ou seja, quebrava exatamente no cenário que motivou a Sprint R1 (path muda no replan). Qualquer novo desenho precisa resolver esse ponto primeiro, ou reproduz o mesmo bug com nome novo.

Recomendação de fundo: perseguir o conceito, mas trocar a metáfora de "pilha OSI" (encapsulamento linear, estrito, sem retrocesso) por algo mais próximo de **distributed tracing** (`trace_id` propagado, cada camada emite um span, o estado é reconstruído por projeção sobre um log) — porque o pipeline real do NewClaw não é linear: tem replan (volta atrás), sub-turnos `agentloop` (ramifica), e retries. OSI não modela isso; tracing sim.

---

## 1. A hipótese faz sentido para a arquitetura atual?

Sim, para o diagnóstico. R1 §9.5, §9.6 e §8 já mostravam o mesmo sintoma por três ângulos diferentes: não existe um objeto único que atravesse `write`/`exec_command` → `RiskAnalyzer` → `GoalExecutionLoop` → `SendDocumentTool` → `MessageBus` carregando sua própria identidade. Cada camada reconstrói "qual artefato é este" por inferência (heurística sintática no `RiskAnalyzer`, scan de disco em `checkDeliverables`, coincidência de path em `writtenPaths`). Um conceito universal de identidade ataca a causa raiz, não os sintomas individuais.

Onde a hipótese é mais fraca: ela assume que a informação "percorre camadas" de forma parecida com um pacote de rede — sequencial, sem desvio, sem versão concorrente. O pipeline real tem replan (R1 §5) e sub-turnos opacos (R1 §9.1), que são exatamente os dois pontos onde "a mesma unidade lógica" pode ter **múltiplas versões concorrentes ou substituídas** — algo que a pilha OSI não precisa resolver porque um pacote nunca é "substituído por uma versão melhor" no meio do caminho.

---

## 2. Vantagens reais

- **Fim da inferência de `file_path` duplicada** (R1 §5, §9.5): se a identidade nasce no momento da criação (`write`/`exec_command`) e é só *referenciada* depois, `RiskAnalyzer` e `GoalExecutionLoop` param de tentar adivinhar o mesmo dado por dois caminhos diferentes.
- **Contrato para `exec_command`** (R1 §9.6): hoje é o maior buraco — a maioria dos formatos ricos (pptx/pdf/docx) nasce de scripts que devolvem só stdout/exit code. Um envelope obriga a tool a declarar "produzi X" de forma estruturada, o que já era a proposta R1 §10.1 — o Cognitive Envelope é essa proposta generalizada.
- **Unificação natural dos três registros paralelos** (R1 §4): `sentArtifacts`, `SessionManager.deliveredArtifacts` e o callback `onArtifactDelivered` hoje contam a mesma história com semânticas diferentes (uma é "tentativa", outra é "sucesso confirmado"). Um envelope com estados explícitos (`CREATED → VALIDATED → DELIVERED`) torna essa diferença um campo do objeto, não uma inconsistência entre três estruturas.
- **Visibilidade dentro de `agentloop`** (R1 §9.1): se o sub-turno propaga o mesmo id de envelope em vez de virar um único `GoalAttempt` opaco (`toolName: 'agentloop'`), o `GoalExecutionLoop` pai passa a enxergar o que aconteceu dentro sem precisar de heurística adicional.

---

## 3. Riscos reais

- **Repetir o `ArtifactDeliveryRegistry`.** Ver §4 — risco central desta análise, tratado em detalhe abaixo.
- **God Object por acoplamento de import, não só por tamanho de classe.** Se o envelope for um serviço central mutável, toda camada (`WriteTool`, `ExecCommandTool`, `RiskAnalyzer`, `GoalExecutionLoop`, `AgentLoop` DELIVERY-GUARD, `SendDocumentTool`, `MessageBus`, `SessionManager`) precisa importá-lo e mutá-lo. Um bug nesse módulo compartilhado afeta escrita, execução, planejamento, envio e validação **simultaneamente** — hoje um bug em `SessionManager.deliveredArtifacts` (R1 §9.3) não quebra `sentArtifacts`, porque são estruturas independentes. Centralizar troca "bugs isolados e pequenos" por "um bug que derruba tudo".
- **Escritores concorrentes na mesma identidade.** R1 §6 já lista 3 pontos de disparo de envio independentes (dispatch nativo do `AgentLoop`, DELIVERY-GUARD interno, deferred sends do `GoalExecutionLoop`). Se todos mutam o mesmo envelope, é preciso uma regra de "único escritor por transição de estado" — regra fácil de enunciar, difícil de garantir com 3+ call sites que já existem e não foram desenhados para isso.
- **`exec_command` não pode ser "envelopado" de graça.** Ele hoje não sabe que produz um artefato (R1 §3, §9.6). Adotar o conceito exige mudar o contrato da tool (ex.: convenção de linha `ARTIFACT: <path>` já proposta em R1 §10.1) — não é uma camada que se adiciona por fora sem tocar nas tools existentes.
- **`SendAudioTool` não se encaixa no modelo de camadas.** Cria e entrega no mesmo tool call (R1 §3) — não há um momento intermediário para "passar o envelope adiante". Ou o tool é dividido em duas fases, ou o conceito precisa de uma exceção desde o dia 1.
- **Persistência ingênua.** A versão anterior do registry fazia `saveToDisk()` (JSON, síncrono) a cada chamada — risco de I/O redundante e de corrida entre processos. Isso é evitável (ver §10), mas é o tipo de detalhe que já causou dor real no projeto uma vez.

---

## 4. Conflita com decisões anteriores do projeto?

Sim, diretamente — e este é o ponto mais importante da análise.

O `ArtifactDeliveryRegistry` (commit `1dafdab`, 02/06/2026) era, na prática, uma primeira tentativa deste mesmo conceito: um objeto central com ciclo de vida explícito `CREATED → VALIDATED → DELIVERED → SUPERSEDED`, id estável, persistência em disco, integrado em `RiskAnalyzer`, `GoalExecutionLoop`, `ContextBuilder` e `ReflectionMemory`. Foi removido em `a7862d3` (13/06/2026) com a justificativa registrada: "8 bugs críticos, 3 interdependentes, zero callers em `src/`" — ou seja, apesar de integrado em várias camadas, na prática tinha virado código morto e instável. A arquitetura atual ("Strategy B", R1 §9.7) é **deliberadamente** descentralizada: cada camada resolve seu pedaço, `sentArtifacts` (por goal, com gate de sucesso) e `SessionManager.deliveredArtifacts` (por sessão, sem gate) coexistem porque servem propósitos diferentes.

Achado concreto ao inspecionar o código removido: a identidade do registry antigo era `artifactId = hash(artifactPath + goalId)`. Isso significa que a identidade **dependia do path** — exatamente o dado que muda quando há replan/pivô de estratégia (R1 §5, o bug que o fix de hoje, `7d086d4`, corrigiu na camada de execução). Um envelope cuja identidade nasce do path herda o mesmo defeito estrutural que o conceito deveria resolver. Qualquer novo desenho **precisa** atribuir identidade na criação, de forma independente do path, ou é a mesma ideia com nome novo.

Não implica que a ideia esteja condenada — implica que a Sprint R2 precisa nomear explicitamente por que desta vez é diferente, algo que a proposta original (do e-mail/log) ainda não faz.

---

## 5. Pode coexistir gradualmente com a arquitetura atual?

Sim, mas só se o envelope for desenhado como **estrutura de dados imutável e append-only** (cada camada gera um novo registro referenciando o id, nunca muta um objeto compartilhado em memória), e não como um serviço central com estado mutável — que foi exatamente o desenho que falhou da última vez.

Nesse formato, a migração pode ser incremental: `sentArtifacts` e `SessionManager.deliveredArtifacts` continuam existindo e sendo alimentados como hoje, mas passam a ler o mesmo `envelopeId` em vez de reconstruí-lo por inferência. Nenhuma estrutura existente precisa ser removida no dia 1. Isso é compatível com R1 §10 ("qualquer uma dessas oportunidades pode virar uma sprint independente e pequena").

---

## 6. Reduziria as classes de bugs da Sprint R1?

Parcialmente — não é bala de prata.

**Resolveria diretamente:**
- §9.5 (duas heurísticas de `file_path` independentes) — identidade única elimina a necessidade de inferir duas vezes.
- §9.6 (nenhum contrato entre `exec_command` e "artefato produzido") — é literalmente a proposta.
- §9.1 (opacidade de `agentloop`) — parcialmente, se o sub-turno propagar o envelope em vez de virar um `GoalAttempt` opaco.

**Não resolveria sem mudança adicional:**
- §9.2 (`SendDocumentTool` sem rota para WhatsApp/Signal) — é um bug de roteamento por canal, não de identidade do artefato.
- §9.4 (`MessageBus.sendDocument` resolve silenciosamente quando o adapter não suporta) — é um bug de tratamento de erro. O envelope pode *expor* o sintoma melhor (o envelope fica "preso" em `PENDING_DELIVERY` em vez de simplesmente desaparecer), mas não corrige a causa — `sendDocument` continuaria precisando do mesmo fix que `sendVoice` já recebeu (Hotfix S29).

Conclusão: o envelope ataca a classe de bugs "o sistema não sabe que dois objetos são o mesmo objeto". Não ataca a classe "uma operação falhou silenciosamente". São problemas diferentes que R1 misturou na mesma auditoria porque afetam a mesma pipeline.

---

## 7. Padrões conhecidos semelhantes

- **OSI / encapsulamento de protocolo** (a analogia do usuário): forte para "cada camada adiciona metadado sem alterar a carga", fraca para o formato real do pipeline (linear, sem retrocesso, sem versionamento concorrente).
- **Distributed tracing (OpenTelemetry: trace_id + spans):** cada serviço/camada emite um *span* referenciando o mesmo `trace_id`; o estado final é reconstruído como uma árvore/DAG a partir do log de spans, não mutando um registro compartilhado. Modela naturalmente ramificação (sub-turnos `agentloop`) e reordenação (replan) — os dois pontos onde a analogia OSI falha. **É o padrão mais próximo do formato real do problema.**
- **Event Sourcing:** em vez de um registro mutável por artefato, cada camada grava um evento imutável (`ArtifactCreated`, `ArtifactValidated`, `ArtifactSuperseded`, `ArtifactDelivered`) contra o mesmo id; o "estado atual" é uma projeção (fold) calculada sob demanda. Resolve diretamente o problema de concorrência entre escritores (§3) porque não há mutação in-place para haver corrida — só apensação. Combina bem com o fato de o `GoalStore` já rodar sobre `better-sqlite3` com transações reais (`S102_GoalStore_TransactionalAppend.test.ts` confirma rollback funcional hoje).
- **Saga / Process Manager** (arquiteturas orientadas a evento): entidade com identidade que atravessa múltiplos serviços, cada um anexando seu pedaço de estado — mesma ideia da Sprint R2, com o vocabulário de sistemas distribuídos em vez de redes.
- **Aggregate Root (DDD):** "Artefato" como raiz de agregação com invariantes de transição de estado aplicadas por um único ponto de entrada — relevante para a regra de "único escritor por transição" citada em §3.

---

## 8. Existe uma abstração melhor que "Cognitive Envelope"?

Talvez. Dado que o formato real do problema é mais parecido com tracing distribuído do que com encapsulamento OSI, um nome como **"Cognitive Trace"** ou **"Artifact Lineage"** comunicaria melhor o comportamento esperado (um id que se ramifica e se reconstrói por projeção) do que "Envelope" (que sugere "uma coisa carregada linearmente, sem alteração de identidade, sem ramificação"). "Envelope" também colide semanticamente com "mensagem" em sistemas de bus (o projeto acabou de introduzir `MessageBus`, commit `b45fa4f`) — pode gerar ambiguidade entre "envelope de mensagem do canal" e "envelope cognitivo do artefato".

Mas o nome é secundário. A decisão que realmente importa é estrutural: **log de eventos imutável e apensado** vs. **registro central mutável**. O nome pode ser decidido depois — não vale travar a Sprint R2 nisso.

---

## 9. Vale só para a pipeline de entrega, ou é um conceito fundamental do Cognitive Kernel?

A ambição declarada (resposta textual, conversa, memória, plano, decisão, código, documento — tudo como especialização do mesmo conceito) é uma generalização muito maior do que o que a Sprint R1 auditou. R1 mapeou **só** a pipeline de artefatos; não há evidência, nesta auditoria, de que `CaseMemory`, `ReflectionMemory` ou o sistema de conversa/sessão sofrem do mesmo sintoma (múltiplas fontes de verdade inconsistentes sobre a mesma identidade). Pode ser verdade, mas hoje é uma hipótese não verificada, não um achado.

Isso também esbarra numa instrução que já rege o projeto: não desenhar abstração para necessidade hipotética futura. Recomendo tratar "conceito fundamental do Kernel" como uma hipótese a revisitar **depois** que a versão estreita (artefatos) provar valor — não como escopo da Sprint R2. Se o desenho ficar honesto sobre isso (`envelopeId` genérico o bastante para não precisar ser reescrito depois, mas sem implementar generalidade que ninguém pediu ainda), a porta fica aberta sem pagar o custo agora.

---

## 10. Como evoluir sem recriar o `ArtifactDeliveryRegistry`

Cinco decisões concretas, cada uma endereçando um motivo específico de morte da tentativa anterior:

1. **Identidade nasce na criação, independente do path.** O registry antigo usava `hash(path + goalId)` — quebra quando o path muda no replan (exatamente o bug que R1 documentou como ainda vivo, §5). O novo id deve ser gerado pela camada criadora (`write`/`exec_command`) no momento da criação e nunca recalculado a partir do path.

2. **Log de eventos apensado, não registro mutável.** Em vez de um objeto em memória que cada camada importa e muta (`recordCreated`, `markDelivered`, ...), cada camada grava um evento referenciando o `envelopeId`. Estado atual é uma projeção calculada sob demanda, não um valor mantido sincronizado por N call sites. Isso elimina a classe de bug "escritor concorrente pisa no estado de outro" citada em §3, e é consistente com o padrão de tracing (§7).

3. **Sem serviço central importado por toda camada.** O registry antigo virou código morto porque acabou desconectado das camadas reais (zero callers confirmados na remoção) apesar de ter sido integrado em 4 arquivos na criação — sinal de que a integração foi mais fácil de escrever do que de manter. Um tipo de dado (`interface` + helpers puros) que cada camada usa para "anexar seu evento" é mais barato de manter acoplado do que um serviço com API própria que precisa ser chamado corretamente em cada um dos 3+ pontos de envio já mapeados (R1 §6).

4. **Reusar a persistência transacional que já existe.** O registry antigo fazia `saveToDisk()` síncrono em JSON a cada chamada — mecanismo próprio, sem as garantias que o resto do projeto já tem. O `GoalStore` já roda sobre `better-sqlite3` com transações reais e rollback (confirmado em `S102_GoalStore_TransactionalAppend.test.ts`). Os eventos do envelope deveriam viver como parte dessa mesma transação (ex.: apensados junto com `GoalAttempt`), não como um arquivo paralelo.

5. **Começar pelo menor gap real, não pela migração completa.** R1 §10.1 (contrato de `exec_command`) e §10.5 (reconciliação de `file_path` no replan) são os dois pontos onde a dor é concreta e isolada. Provar o conceito ali — sem tocar `sentArtifacts`, `SessionManager.deliveredArtifacts`, memória ou conversa — antes de generalizar. Se o conceito não sobreviver a esse teste pequeno, ele não deveria virar conceito de Kernel.

---

## Conclusão da Sprint R2

O diagnóstico da hipótese está correto: falta identidade estável entre camadas, e isso explica vários achados independentes da Sprint R1. A metáfora OSI é a parte fraca — o formato real do pipeline (replan, ramificação via `agentloop`, retries) se parece mais com tracing distribuído / event sourcing do que com encapsulamento linear de protocolo. O maior risco não é a ideia em si, é repetir o desenho específico do `ArtifactDeliveryRegistry` (identidade derivada de path, registro central mutável, persistência síncrona própria) sob um nome novo — a evidência de que isso falhou já existe no histórico do projeto.

**Escopo não decidido nesta sprint** (por design — R2 é só análise): se e quando prosseguir, começar por R1 §10.1 (contrato de artefato para `exec_command`) como piloto isolado, com identidade atribuída na criação e persistência apensada à transação existente do `GoalStore` — sem tocar `sentArtifacts`/`deliveredArtifacts`/memória/conversa até o piloto provar valor.

---

## 11. Proposta de desenho recomendado (ainda análise — não implementar)

Juntando §7, §9 e §10 num desenho concreto, sem a metáfora OSI e sem repetir o `ArtifactDeliveryRegistry`:

**Nome:** `ArtifactTrace` (não "Cognitive Envelope"/"Cognitive Artifact"). Deliberadamente escopado a artefatos — não a "tudo que a cognição produz" (§9) — e deliberadamente evitando a palavra "Envelope", que colide com o vocabulário de `MessageBus` recém-introduzido.

**Identidade:** `traceId` (UUID v4), gerado pela camada criadora (`WriteTool`/`exec_command`) no instante da criação. Nunca derivado de `path`, `goalId` ou qualquer combinação de dados que muda entre replans — esse foi o defeito estrutural do registry antigo (§4).

**Forma dos dados:** log de eventos apensado, não registro mutável. Cada camada emite um evento contra o `traceId`; nada é sobrescrito in-place:

```
type ArtifactEvent =
  | { type: 'created',   traceId, path, goalId, planStepId, cycle, ts }
  | { type: 'validated', traceId, evidence, ts }
  | { type: 'superseded', traceId, supersededBy, reason, ts }
  | { type: 'delivery_attempted', traceId, channel, chatId, ts }
  | { type: 'delivered', traceId, channel, chatId, ts }
  | { type: 'failed',    traceId, stage, error, ts }
```

O "estado atual" de um artefato (`project(traceId)`) é uma função pura que dobra (`fold`) os eventos — nunca um valor mantido sincronizado por N call sites. Isso elimina a classe de bug "escritor concorrente pisa no estado de outro" (§3), porque apensar não tem condição de corrida da mesma forma que mutação in-place tem.

**Persistência:** os eventos vivem como linhas em SQLite, apensadas na **mesma transação** que já grava o `GoalAttempt` correspondente (`GoalStore` já tem essa garantia — `S102_GoalStore_TransactionalAppend.test.ts`). Sem arquivo JSON paralelo, sem `saveToDisk()` síncrono por chamada — o erro concreto do registry antigo.

**Sem serviço central importado por toda camada.** `ArtifactTrace` é um par de funções puras (`emit`, `project`) mais um tipo — não uma classe com API própria e estado em memória que cada camada precisa lembrar de chamar corretamente. Reduz o modo de falha "integrado em 4 lugares na criação, zero callers na remoção" que matou a tentativa anterior.

**Propagação no plano:** `PlanStep` ganha um campo opcional `artifactTraceId?: string`, paralelo a `toolArgs.file_path` (não o substitui — coexistência, §5). Quando `RiskAnalyzer` hoje infere `file_path` por proximidade sintática (§5), passa a resolver primeiro via `project(traceId)`; só cai na heurística sintática se não houver `traceId` (steps legados/planos antigos). Num replan, se o step anterior já tinha um `traceId`, o novo step herda o mesmo id — a reconciliação deixa de ser reativa (feita hoje só na entrega, pelo fix `7d086d4`) e passa a ser automática por herança de identidade.

**Sub-turnos `agentloop` (§9.1):** quando `GoalExecutionLoop` delega um step com `artifactTraceId` para um sub-turno, propaga o id no `ChannelContext`. Tool calls internos ao sub-turno (`write`, `exec_command`, `send_document`) emitem eventos contra esse mesmo `traceId` em vez de desaparecerem dentro de um único `GoalAttempt` opaco (`toolName: 'agentloop'`).

**Coexistência:** `sentArtifacts` e `SessionManager.deliveredArtifacts` continuam existindo sem mudança de contrato — apenas passam a ser alimentados a partir do mesmo evento `delivered`, em vez de cada um decidir por conta própria quando algo foi "entregue". Migração é aditiva, não um corte.

**Piloto recomendado (não implementar ainda):** restringir a primeira versão a exatamente dois pontos, os mesmos que R1 §10.1 e §10.5 já isolaram:
1. `exec_command` ganha uma forma estruturada de declarar `{type:'created', traceId, path}` quando o script gera um artefato (convenção de linha de output, capturada deterministicamente — sem regex sobre texto livre).
2. `RiskAnalyzer`/`GoalExecutionLoop` passam a resolver `file_path` de `send_document` via `traceId` quando disponível, com fallback para a heurística atual.

Critério de sucesso do piloto: um teste de regressão equivalente ao `S109` (que hoje cobre a correção reativa de `7d086d4`) passando via herança de `traceId` no replan, sem depender de inferência por path. Se esse teste não simplificar em relação ao fix atual, o conceito não pagou seu custo e não deveria se expandir.
