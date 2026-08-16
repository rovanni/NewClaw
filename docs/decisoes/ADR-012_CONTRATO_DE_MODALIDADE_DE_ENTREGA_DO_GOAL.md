# ADR-012 — Contrato de modalidade de entrega do Goal

> **Status:** decisão tomada em 16/08/2026. Campanha "O8 — Contrato de Modalidade" (continuação de
> S230/S231).
>
> Escopo: **como o sistema sabe** que um Goal prometeu uma resposta em texto, um artefato
> (documento/áudio), ou ambos — e como essa promessa sobrevive a replans. Não decide se um
> abandono de entrega é legítimo ou uma falha (isso continua sendo julgamento do LLM validador).
>
> Base factual: investigação O7 (externa a este repositório, não documentada em `docs/`) +
> leitura do estado real do código em 16/08/2026 + `S230_Provenance_ResponseContract.test.ts` +
> `S244_DeliveryContract_NotSilentlyAbandoned.test.ts` + `S245_DeliveryContract_E2E_ValidateGoalCompletion.test.ts`.

## 1. Contexto

Uma investigação externa (campanha "O1"–"O8", conduzida fora deste repositório) levantou a
hipótese de que o `GoalPlanner`/`GoalExecutionLoop` não têm nenhum registro persistente do que um
Goal prometeu entregar — e que, por isso, um replan pode trocar silenciosamente "resposta em
texto" por "arquivo" (ou vice-versa) sem que nenhuma camada perceba. A hipótese de mecanismo
proposta era combinar `IntentCategory` (já produzida por `UnifiedIntentRouter`) com
`inferExpectedExtensions()` (heurística de regex sobre o texto do usuário) para inferir a
modalidade esperada.

Ao investigar (Fase 1 da diretriz), duas coisas mudaram a pergunta:

1. **Parte do problema já tinha sido resolvida**, por um caminho diferente do hipotetizado:
   `ensureResponseContractCriterion()` (Sprint de Response Contract, ver `S230`) já injeta um
   critério `response_produced` a partir de `IntentCategory` — GATE estrutural, nunca `'met'`
   deterministicamente, que sobrevive a todo replan.
2. **`inferExpectedExtensions()` já está registrada como débito conhecido** em
   `docs/ARCHITECTURE/RESPONSABILIDADE_ANTES_DO_MECANISMO.md` ("Retrato em 09/08/2026") —
   regex interpretando linguagem natural. Usá-la para decidir modalidade teria aprofundado essa
   violação, não resolvido o problema.

Rodando a matriz de 9 casos da investigação original contra `inferExpectedExtensions()` real,
3 dos 9 casos falham (extensão ausente indistinguível de "sem artefato pedido"; formato citado
sem extensão literal — ex. "em CSV" — não reconhecido; menção a "imagem" como *input* confundida
com pedido de imagem como *deliverable*). A hipótese de mecanismo original não teria passado no
próprio critério de aprovação que a investigação propôs para si mesma.

## 2. O problema arquitetural real (depois da Fase 1)

O sistema já resolve a metade **RESPOSTA** do contrato (`response_produced`, persistente entre
replans via `preservedCriteria`). Não resolvia a metade **ARTEFATO**:
`ensureDeliverySuccessCriteria()` — por design, documentado em código — recalcula o critério
`tool_succeeded(send_document|send_audio)` do zero a cada replan, a partir apenas do plano final
da geração vigente. Isso é correto quando um replan abandona a entrega por um motivo real (ex.:
dependência ausente) — não deveria deixar o Goal preso exigindo uma tool que a estratégia atual
não usa mais.

O efeito colateral não coberto por nenhum teste: se `send_document`/`send_audio` esteve numa
geração **anterior** do plano e a geração atual não a contém mais, e a categoria do Goal está
**fora** de `RESPONSE_CONTRACT_CATEGORIES` (`system_operation`/`destructive` — ação pura, sem
pergunta embutida, por isso excluídas de `response_produced`), **nenhum** critério restante força
a passagem pelo validador LLM (`validateGoalCompletion`). Se o resto do checklist fecha
deterministicamente, `achieved=true` sai sem que o validador jamais releia `userIntent` para notar
a ausência do artefato prometido.

## 3. Alternativas consideradas

### A — `IntentCategory + inferExpectedExtensions` como sinal único de modalidade
**Descartada.** Falha em 3/9 casos da própria matriz de validação (Seção 1); aprofunda um débito
de regex-como-interpretador-semântico já registrado; e resolveria só o sintoma ("qual modalidade
este texto pede") sem resolver a causa real ("o replan esquece o que já foi prometido").

### B — Um campo único de "modalidade esperada" (enum: `texto` \| `artefato` \| `ambos`) no Goal
**Descartada.** Um Goal pode legitimamente precisar de resposta e artefato ao mesmo tempo, ou
descobrir a necessidade de um artefato só depois de começar (ex.: replan decide que só um PDF
resolve um problema que a resposta textual não resolveria). Um enum único força uma decisão
prematura e cria uma terceira fonte de verdade que competiria com os dois checklists de critério
que já existem — contra a "Regra de custo" de `RESPONSABILIDADE_ANTES_DO_MECANISMO.md`
(substituir, nunca somar).

### C — Sempre exigir `tool_succeeded(send_document)` uma vez prometido, mesmo se abandonado
**Descartada.** Reintroduziria exatamente o problema que a decisão original de recalcular por
geração (S230-adjacente) existe para evitar: um Goal preso exigindo uma tool que a estratégia
vigente genuinamente não usa mais (ex.: pandoc ausente, usuário já avisado por outro caminho).

### D — Dois gates estruturais independentes: `response_produced` (já existente) +
`delivery_not_silently_abandoned` (novo)
**Escolhida.** Ver Seção 4.

## 4. Decisão

**1. A modalidade de um Goal não é um campo único — é a soma de dois fatos estruturais
independentes**, cada um respondendo uma pergunta diferente:

* *Este Goal deve resposta em texto?* → `IntentCategory` → `response_produced` (já existente,
  S230). Decidido uma vez, no plano inicial; persiste por toda a vida do Goal.
* *Este Goal abandonou uma entrega de artefato que já prometeu?* → presença/ausência de
  `send_document`/`send_audio` através das gerações do plano → `delivery_not_silently_abandoned`
  (novo, esta ADR). Recalculado a cada replan, a partir de um fato acumulado — não de um enum
  fixado de antemão.

**2. Novo fato persistido: `Goal.deliveryToolsEverPromised`.** Lista de tools de entrega
(`send_document`/`send_audio`) que estiveram em **qualquer** geração do plano deste Goal —
monotônica, nunca esquecida, acumulada por `trackPromisedDeliveryTools()` tanto no plano inicial
quanto em todo replan.

**3. `detectAbandonedDeliveryTools()`** — puro, estrutural: uma tool está abandonada quando esteve
em `deliveryToolsEverPromised`, não está no plano final da geração atual, e nada correspondente
foi entregue de fato (`goal.sentArtifacts`). Não interpreta texto — só compara listas.

**4. `ensureDeliveryNotAbandonedCriterion()`** injeta o critério `delivery_not_silently_abandoned`
só quando há abandono real — mesmo padrão de `response_produced`: nunca `'met'`
deterministicamente (`evaluateCriteria()`, GATE puro), o que impede o checklist de fechar
`achieved=true` sozinho e força `validateGoalCompletion()` (LLM) a julgar, com o fato
explicitamente no prompt (`abandonedDeliveryBlock`, ao lado do `responseContractBlock` já
existente) — Evidence Provider Pattern: o Core entrega o fato, o LLM decide se é abandono
legítimo ou entrega esquecida.

### 4.1 A regra que a decisão cria

> Uma promessa de entrega não desaparece quando um replan a remove do plano — ela vira um fato que
> o validador precisa ver, até que a entrega aconteça ou o LLM confirme que o abandono foi
> comunicado ao usuário.

## 5. Gate obrigatório — Extensão antes de Criação

**Nenhum arquivo novo.** Nenhuma Tool, Skill ou Script.

| Candidato | Precisa existir? | O que já existe | Decisão |
|---|---|---|---|
| Mecanismo de GATE estrutural | Não | `response_produced` (S230) já é exatamente esse padrão | Reaproveitado, mesmo módulo (`ensureDeliverySuccessCriteria.ts`) |
| Canal para o fato chegar ao validador | Não | `responseContractBlock` em `validateGoalCompletion()` já injeta fato análogo | Bloco irmão, mesmo prompt |
| Persistência de campo novo no Goal | Não | `sentArtifacts`/`planGeneration` já seguem o padrão TEXT/JSON + `ALTER TABLE` retrocompatível em `GoalStore.ts` | Mesmo padrão, nova coluna |

Os três arquivos tocados (`domainTypes.ts`, `ensureDeliverySuccessCriteria.ts`,
`GoalExecutionLoop.ts`, `GoalStore.ts`) já existiam e já continham o padrão exato a estender.

## 6. O que esta ADR NÃO muda

* **A recalculação de `tool_succeeded(send_document|send_audio)` a cada replan.** Continua exatamente
  como antes — um replan legítimo que abandona a entrega ainda não fica preso.
* **Quem decide se um abandono é legítimo.** Continua sendo o LLM validador, nunca o determinismo.
* **`response_produced`/S230.** Intocado — os dois gates são independentes e podem coexistir.
* **Categorias em `RESPONSE_CONTRACT_CATEGORIES`.** Não alteradas por esta ADR (a inclusão de
  `'creation'` no `Set`, sem justificativa correspondente no comentário, é um achado separado,
  registrado na Seção 9, não corrigido aqui).
* **Avanço de marco de construção** (`runValidationAchievedPhase`, milestone advance) não chama
  `ensureDeliverySuccessCriteria`/`trackPromisedDeliveryTools` — pré-existente a esta ADR, fora de
  escopo (ver Seção 9).

## 7. Consequências

* **Uma coluna nova no schema do Goal**, retrocompatível (goals legados leem `[]`).
* **Nenhuma chamada de LLM nova em condições normais** — o custo só existe quando há abandono real
  (raro por construção, mesmo argumento de custo de `response_produced`).
* **Reversibilidade:** alta. Sem abandono detectado, o comportamento é idêntico ao atual — a
  coluna fica `[]`/vazia e nenhum critério novo é injetado.

## 8. Validação exigida

Validação Progressiva completa, executada nesta mesma Sprint:

1. **Unitário** — `S244_DeliveryContract_NotSilentlyAbandoned.test.ts`: as 3 funções puras,
   isoladas, incluindo os 6 cenários estruturais de `detectAbandonedDeliveryTools` e a reprodução
   do gap original (categoria fora de `RESPONSE_CONTRACT_CATEGORIES`). 29/29.
2. **Regressão completa** — `npm run test:regression`: 243/243 (suíte inteira, incluindo S244/S245).
3. **E2E sintético** — `S245_DeliveryContract_E2E_ValidateGoalCompletion.test.ts`: instancia
   `GoalExecutionLoop` real com LLM mockado, chama os métodos privados reais
   (`evaluateCriteria`/`validateGoalCompletion`) — confirma que o GATE força Caminho 2, que o
   Caminho 1 (checklist puro, sem LLM) continua intacto quando não há abandono, e que o texto do
   fato aparece no prompt real enviado ao LLM. 10/10.
4. **Ambiente real isolado** — instância isolada (`skill verify`), LLM real (`glm-5.2:cloud` via
   Ollama), SQLite real, HTTP real: goal real ("escreva um poema e envie como .txt") confirmou
   `delivery_tools_ever_promised: ["send_document"]` persistido corretamente na coluna nova de um
   banco SQLite real (não `:memory:`), sem regressão no fluxo de `response_produced` já existente.

## 9. Limites conhecidos

* **O caminho de abandono não foi exercitado ao vivo (etapa 4).** O goal real de validação
  completou em 1 ciclo, sem replan — não houve oportunidade de observar
  `delivery_not_silently_abandoned` sendo injetado por um replan real de um LLM real. A cobertura
  desse caminho específico vem de S244 (matemática pura) + S245 (mesmo código real, cenário
  construído manualmente) — estruturalmente idêntico ao caminho de replan real (mesmas funções,
  mesmos argumentos), mas não confirmado ao vivo. Risco residual baixo, não nulo.
* **`'creation'` em `RESPONSE_CONTRACT_CATEGORIES`.** Presente no `Set` desde antes desta ADR, sem
  justificativa no comentário que documenta as demais 5 categorias (S230). Pode ser intencional ou
  resíduo de edição — não investigado nesta Sprint, registrado aqui para não ficar implícito.
* **Avanço de marco de construção não recalcula nenhum dos dois contratos.** Pré-existente
  (`successCriteria` já não era tocado ali antes desta ADR); um Goal de construção que promete um
  artefato num marco e o abandona ao avançar de marco não é coberto por
  `deliveryToolsEverPromised` (que só é atualizado nos 2 pontos que chamam
  `ensureDeliverySuccessCriteria`). Fora de escopo — mudar o fluxo de avanço de marco é uma decisão
  arquitetural própria, não uma extensão pontual.
