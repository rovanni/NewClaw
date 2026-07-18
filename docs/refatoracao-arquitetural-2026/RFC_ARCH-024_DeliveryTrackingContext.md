# RFC ARCH-024 — Consolidar callbacks de rastreamento de entrega de `ChannelContext`

**Sprint:** 2026-09-S19. **Status:** Documento de Fase 1-5 completo, per `DIRETRIZ_ARQUITETURA_2026-07-13.md`. **Sem código nesta Sprint** — decisão de implementar (ou não) e como, registrada abaixo.

## Card original (`ARCHITECTURAL_BACKLOG.md`)

> 5 campos de callback (`deferSendDocument`, `isDeferredArtifact`, `onArtifactDelivered`, `isAudioAlreadySent`, `recentMessages`) foram acumulados em `ChannelContext` um a um, cada um resolvendo um bug pontual — nenhum é sobre o canal (Telegram/Discord/Web), todos são sobre rastreamento de entrega de goal. Consolidar num contrato dedicado.

---

## Fase 1 — Compreensão

### Os 5 campos, origem e propósito real (lidos linha a linha em `agentLoopTypes.ts`)

| Campo | Adicionado por (comentário no código) | Propósito real |
|---|---|---|
| `deferSendDocument` | FIX C | Intercepta `send_document` dentro de um sub-turno `agentloop`, adia o envio real até pós-validação. |
| `isDeferredArtifact` | P3-DEDUP | Evita que o mesmo artefato seja diferido duas vezes na mesma execução de step. |
| `onArtifactDelivered` | CORREÇÃO 1 | DELIVERY-GUARD (AgentLoop) notifica GoalExecutionLoop de uma entrega direta, sem passar por `deferSendDocument`. |
| `isAudioAlreadySent` | — | Dedup de `send_audio` (sem `file_path` estável — cada chamada gera um arquivo com timestamp único). |
| `recentMessages` | microauditoria de continuidade conversacional (08/07/2026) | Janela de turnos recentes (user/assistant) para `UnifiedIntentRouter` classificar mensagens elípticas ("continue", "isso"). |

### Onde cada campo é produzido e consumido (grep completo, não amostra)

**Produção real (onde os valores são construídos):**
- `channel`/`chatId`/`userId`/`metadata`/`correlationId`/`recentMessages` — construídos **uma única vez**, em `MessageBus.ts:465-472` (`channelCtx`), no ponto em que QUALQUER mensagem de QUALQUER canal entra no Core. Nenhum dos 4 campos de delivery-tracking aparece aqui.
- `deferSendDocument`/`isDeferredArtifact`/`onArtifactDelivered`/`isAudioAlreadySent` — construídos **só dentro de `GoalExecutionLoop.executeStep()`** (`GoalExecutionLoop.ts:1783-1820`), que faz `{ ...channelContext, deferSendDocument: (args) => {...}, ... }` — um objeto NOVO, por STEP, fechando sobre um `Map` local (`deferredSendArgsMap`) que só existe durante aquela chamada de `executeStep()`. Nunca existem fora do caminho `GoalExecutionLoop → AgentLoop.process()` para um step sem `toolName` (dispatch `agentloop`).

**Consumo real:**
- Os 4 campos de delivery-tracking são lidos em exatamente 6 pontos de `AgentLoop.ts` (linhas 1807, 1809, 1852, 2155, 2255/2276, 2674) — todos dentro do laço principal de tool-calling (`runWithTools`).
- `recentMessages` é lido em `AgentLoop.ts:1212` só para repassar adiante a `UnifiedIntentRouter`/`GoalOrchestrator`/`GoalExtractor` — nenhuma relação com entrega de artefato.

### Achado que corrige a premissa do card

**`recentMessages` NÃO é sobre rastreamento de entrega de goal.** É construído no mesmo lugar e pela mesma razão que `channel`/`chatId`/`userId` (enriquecer o contexto de UMA mensagem recebida, em `MessageBus.ts`, incondicional a qualquer goal existir), para um consumidor (classificação de intenção) que não tem nenhuma relação com `send_document`/`send_audio`/entrega. A alegação do card ("nenhum é sobre o canal... todos são sobre rastreamento de entrega") é verdadeira para 4 dos 5 campos, não para os 5 — mais uma instância do modo de falha "equivalência assumida sem verificação" já catalogado em `RETROSPECTIVA_PREMISSAS_AUDITORIA.md` (modo 3), desta vez pega ANTES de virar Sprint de implementação porque a S19 é, por desenho, uma Sprint de RFC.

---

## Fase 2 — Crítica da hipótese

Perguntas que a proposta original ("consolidar os 5 num contrato dedicado") não respondia:

1. **Incluir `recentMessages` no `DeliveryTrackingContext` misturaria dois conceitos não relacionados** dentro do "contrato dedicado" — exatamente o tipo de contaminação que a consolidação deveria eliminar, não reproduzir com um nome novo.
2. **"Consolidar num contrato dedicado" é ambíguo sobre a FORMA:** vira (a) um novo PARÂMETRO separado de `channelContext` na assinatura de `AgentLoop.process()`/`runWithTools()`, ou (b) um único CAMPO aninhado dentro do próprio `ChannelContext` (`channelContext.deliveryTracking`)? O card não distingue, mas o risco das duas é muito diferente.
3. **Opção (a) — parâmetro separado — exige mudar a assinatura de `AgentLoop.process()`** e de todo call site que já o invoca hoje, incluindo os caminhos que NÃO passam por `GoalExecutionLoop` (turnos de chat direto, sem goal) — esses precisariam decidir explicitamente "passar `undefined`" ou similar. É a leitura mais "correta" filosoficamente (separa por completo a responsabilidade de canal da de goal-delivery), mas é exatamente o "Risco: Alto — toca o contrato entre AgentLoop e GoalExecutionLoop, superfície ampla" que o próprio card já sinalizava, e paga esse risco por um ganho majoritariamente estético.
4. Um "God Object" novo seria: criar `DeliveryTrackingContext` mas continuar deixando os 4 campos soltos no `ChannelContext` (só documentado como "logicamente relacionado", sem consolidação real de tipo) — não resolveria o Data Clump (SC8) de verdade, só adicionaria um nome sem função.

---

## Fase 3 — Pesquisa de alternativas

| Alternativa | Descrição | Risco | Resolve o Data Clump (SC8)? |
|---|---|---|---|
| **A — Rejeitar, não fazer nada** | Mantém os 4 campos soltos. | Nenhum | Não |
| **B — `DeliveryTrackingContext` como parâmetro novo e separado** | `AgentLoop.process(message, channelContext, deliveryTracking?, ...)`. Leitura mais literal do card. | Alto — muda assinatura de método central, todo call site precisa decidir o que passar | Sim, e separa por completo do canal |
| **C — `DeliveryTrackingContext` como campo único aninhado em `ChannelContext`** | `ChannelContext.deliveryTracking?: DeliveryTrackingContext`, contendo os 4 campos (SEM `recentMessages`). Assinatura de `AgentLoop.process()` não muda — `channelContext` continua sendo o único parâmetro de contexto. | Baixo — mudança mecânica em ~9 call sites confirmados (6 em `AgentLoop.ts`, os de construção em `GoalExecutionLoop.ts`) | Sim — 4 campos soltos viram 1 objeto nomeado |
| **D — Mover as 4 closures pra fora de `ChannelContext` inteiramente, como parâmetro posicional só de `executeStep`→`agentLoop.process` (não um novo tipo em `agentLoopTypes.ts`)** | Equivalente a B em risco, sem nem o benefício de um tipo nomeado reusável. | Alto, sem ganho adicional sobre B | Sim, mas pior ergonomia |

Padrão de engenharia de software relevante: **Parameter Object** — quando um grupo de parâmetros sempre viaja junto e é usado pela mesma razão, virar um único objeto nomeado (exatamente o que C faz) resolve o Data Clump sem precisar alterar a ASSINATURA de quem os consome, só a FORMA de acesso (`x.campo` → `x.grupo.campo`).

---

## Fase 4 — Síntese

**Recomendação: Alternativa C**, com o escopo do card corrigido para 4 campos (excluindo `recentMessages`).

- **Por que C e não B:** o ganho de B (separar completamente a assinatura do método) é majoritariamente estético — os 4 campos já são opcionais (`?`) e já são `undefined` em todo call site que não passa por `GoalExecutionLoop.executeStep()`; C preserva exatamente essa mesma propriedade (`channelContext.deliveryTracking` também fica `undefined` nesses casos) sem tocar a assinatura de `AgentLoop.process()`/`runWithTools()`, reduzindo o "Risco: Alto" citado no card para baixo. B fica registrado como alternativa válida caso uma Sprint futura (ARCH-019, decomposição de `runWithTools`) revele necessidade real de separar de vez — não há essa evidência hoje.
- **Por que excluir `recentMessages`:** não é o mesmo conceito (confirmado por onde é construído e por quem consome) — incluí-lo no `DeliveryTrackingContext` seria repetir o erro de mistura de conceitos que a consolidação busca corrigir, só com um nome novo.
- **Desenho da implementação (para ARCH-024-Impl, S23):**
  ```ts
  // agentLoopTypes.ts
  export interface DeliveryTrackingContext {
      deferSendDocument?: (args: Record<string, unknown>) => void;
      isDeferredArtifact?: (filePath: string) => boolean;
      onArtifactDelivered?: (filePath: string) => void;
      isAudioAlreadySent?: () => boolean;
  }
  export interface ChannelContext {
      channel: string;
      chatId: string;
      userId?: string;
      metadata?: Record<string, unknown>;
      correlationId?: string;
      recentMessages?: Array<{ role: string; content: string }>;
      deliveryTracking?: DeliveryTrackingContext;
  }
  ```
  `GoalExecutionLoop.executeStep()` constrói `{ ...channelContext, deliveryTracking: { deferSendDocument, isDeferredArtifact, onArtifactDelivered, isAudioAlreadySent } }` em vez dos 4 campos soltos. Os 6 pontos de leitura em `AgentLoop.ts` trocam `channelContext?.X` por `channelContext?.deliveryTracking?.X`.

---

## Fase 5 — Validação

- **Baseada em evidência real do projeto, não hipótese?** Sim — os 5 campos, seus produtores e os 6+ consumidores foram lidos linha a linha nesta RFC, não presumidos a partir da descrição do card.
- **Resolve um problema estrutural ou só um sintoma?** Estrutural — elimina o Data Clump real (SC8) sem introduzir um substituto equivalente.
- **Reduz a complexidade total do sistema?** Sim — 4 campos soltos em `ChannelContext` viram 1 campo com tipo nomeado; nenhuma assinatura de método muda.
- **Elimina múltiplas fontes de verdade?** Não é o alvo direto desta RFC (não há duplicação de dado aqui, é fragmentação de contrato) — mas não introduz nenhuma.
- **Mantém a filosofia do Cognitive Kernel?** Sim — não cria um objeto novo de responsabilidade ampla, é um agrupamento local de 4 campos que já viajavam juntos.
- **Pode ser implementada incrementalmente?** Sim — mudança mecânica, 1 Sprint, ~9 call sites.
- **Pode ser revertida facilmente?** Sim — reverter o commit, campos voltam a ser soltos.

## Decisão

**Aprovada para implementação** (Alternativa C, escopo de 4 campos — `recentMessages` fica de fora, permanece campo direto de `ChannelContext`). Sprint de implementação: **ARCH-024-Impl (S23)**, condicionada a esta RFC — sem mudança de escopo/dependências do restante do plano (S23 já estava condicionada à aprovação desta RFC).

**Riscos residuais:** nenhum identificado além do risco mecânico normal de renomear 9 call sites (mitigado por `tsc --noEmit` pegando qualquer um esquecido, já que os campos deixam de existir soltos em `ChannelContext`). **Hipóteses não comprovadas:** nenhuma — a mudança é puramente de forma de contrato, sem lógica nova.
