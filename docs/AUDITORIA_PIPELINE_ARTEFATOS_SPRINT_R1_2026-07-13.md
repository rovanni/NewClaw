# Sprint R1 — Auditoria da Pipeline Atual de Entrega de Artefatos

**Data:** 2026-07-13
**Branch:** `experimental/artifact-pipeline-refactor`
**Escopo:** leitura e mapeamento apenas — nenhuma linha de código alterada nesta sprint.
**Método:** leitura direta do código-fonte (`src/loop`, `src/tools`, `src/channels`, `src/session`), correlação com a suíte de regressão existente (32 arquivos tocam `send_document`/entrega) e com o achado real do dia 12/07/2026 (goal `..._8nchb`, corrigido no commit `7d086d4`).

---

## 1. Diagrama de dependências

```
Usuário
  │
  ▼
LLM (planejamento)
  │  gera plano JSON: [{toolName, toolArgs}, ...]
  ▼
GoalPlanner.ts ────────────────► injeta SCHEMAS OBRIGATÓRIOS no prompt
  │                               (send_document: {"file_path": "..."})
  ▼
RiskAnalyzer.ts ───────────────► sanitiza steps; INFERE file_path ausente
  │                               a partir do último 'write' anterior no
  │                               mesmo plano (heurística #1 de inferência)
  ▼
GoalStore (currentPlan) ───────► persiste o plano; steps 'pending'
  │
  ▼
GoalExecutionLoop.runLoopInternal
  │
  ├─► executeStep() por step do plano
  │     │
  │     ├─► toolName='write'/'exec_command' ──► cria o artefato no disco
  │     │     (WriteTool escreve texto; exec_command roda scripts que
  │     │      geram .pptx/.pdf/.docx/.mp4 via ferramentas externas)
  │     │
  │     ├─► toolName='agentloop' ──► delega a um SUB-TURNO do AgentLoop
  │     │     (opaco para goal.attempts — ver §9.1)
  │     │       │
  │     │       ├─► AgentLoop.runWithTools() — ciclo write→exec→send
  │     │       │     próprio, com seu PRÓPRIO DELIVERY-GUARD interno
  │     │       │     (re-entra o loop se detectar arquivo criado e
  │     │       │      não enviado)
  │     │       └─► se send_document suceder aqui dentro:
  │     │             channelContext.onArtifactDelivered(path)
  │     │             (callback direto, contorna GoalExecutionLoop)
  │     │
  │     └─► toolName='send_document' ──► SendDocumentTool.execute()
  │           │
  │           ├─ resolvePath(file_path) + fs.existsSync (gate local)
  │           ├─ roteia por this.channel: discord | web | else→telegram
  │           │  (⚠️ ver §9.2 — whatsapp/signal caem no "else")
  │           └─► MessageBus.sendDocument(channel, chatId, buffer, ...)
  │                 │
  │                 ▼
  │           Adapter.sendDocument() (por canal)
  │             ├─ TelegramAdapter: bot.api.sendDocument (direto)
  │             ├─ DiscordAdapter: adapter.send({attachments:[...]})
  │             └─ WebChannelAdapter: HTTP pendente OU
  │                powerpointBroker (polling) OU
  │                queueOrphaned (próxima mensagem da sessão)
  │
  ▼
GoalExecutionLoop (pós-step)
  │
  ├─► GoalEvaluator.classifyError() — se falhou, classifica blocker
  │     (genérico: ERROR_PATTERNS por regex, não específico de artefato)
  │
  ├─► StepSemanticValidator / ObserverValidator — mismatch semântico
  │     (genérico: compara descrição do step com output, não olha
  │      file_path especificamente)
  │
  └─► ao concluir todos os steps: validateGoalCompletion()
        │
        ├─ evaluateCriteria() — checklist determinístico (successCriteria)
        ├─ writtenPaths (goal.attempts 'write'/'edit' com sucesso)
        │   + checkClaimsAgainstEvidence() — anti-alucinação genérica
        ├─ [FIX HOJE] artifactPaths retornado — evidência real p/ correção
        └─► se achieved=true: processa deferredSends (send_document
              'pending' no plano) — AQUI que o fix de hoje (S109) atua
```

Camadas paralelas que também guardam estado de artefato, fora dessa espinha dorsal:

```
SessionManager.deliveredArtifacts   (por SESSÃO, não por goal — sobrevive a
                                      compressão; alimentado no MOMENTO DA
                                      CHAMADA de send_document, não no sucesso)
        │
        ▼
SessionContext.getDeliveredArtifactsBlock() → injetado no prompt do AgentLoop
("ARQUIVOS ENVIADOS AO USUÁRIO NESTA SESSÃO")
```

---

## 2. Componentes envolvidos e responsabilidades

| Componente | Arquivo | Responsabilidade |
|---|---|---|
| `GoalPlanner` | `src/loop/GoalPlanner.ts` | Gera o plano inicial/replan via LLM; injeta schema de args obrigatórios no prompt |
| `RiskAnalyzer` | `src/loop/RiskAnalyzer.ts` | Sanitiza plano, muta steps inválidos, **infere `file_path`** ausente a partir de `write` anterior |
| `GoalStore` | `src/loop/GoalStore.ts` | Persiste `currentPlan`, `attempts`, `sentArtifacts`, `blockers` em SQLite |
| `GoalExecutionLoop` | `src/loop/GoalExecutionLoop.ts` | Orquestra execução do plano, deferred sends, `validateGoalCompletion`, `checkDeliverables` |
| `AgentLoop` | `src/loop/AgentLoop.ts` | Ciclo de cognição conversacional; tem seu **próprio** DELIVERY-GUARD (independente do GoalExecutionLoop) para turnos que não são goals, ou sub-turnos `agentloop` dentro de um goal |
| `GoalEvaluator` | `src/loop/GoalEvaluator.ts` | Classifica erro de qualquer tool (`ERROR_PATTERNS`) em `GoalBlocker` — genérico, não específico de artefato |
| `StepSemanticValidator` | `src/loop/StepSemanticValidator.ts` | Detecta mismatch entre descrição do step e output real — genérico |
| `ObserverValidator` | `src/loop/ObserverValidator.ts` | Validação determinística/LLM de que a tool executou o que devia — genérico |
| `WriteTool` | `src/tools/write_tool.ts` | Cria arquivo de TEXTO; tem `CONTENT-STUB-GATE` (recusa placeholders) |
| `ExecCommandTool` | `src/tools/exec_command.ts` | Roda scripts externos — é o caminho real de criação de `.pptx`/`.pdf`/`.docx`/`.mp4` (via python-pptx, html2pdf.sh, ffmpeg etc.), mas não tem noção de "artefato": só retorna stdout/exit code |
| `SendDocumentTool` | `src/tools/send_document.ts` | Único ponto de entrada de envio de documento; exige arquivo **já existente** no disco |
| `SendAudioTool` | `src/tools/send_audio.ts` | Cria E envia o áudio no mesmo tool call (diferente de send_document — não separa criação/entrega) |
| `MessageBus` | `src/channels/MessageBus.ts` | Roteia `sendDocument`/`sendVoice` para o adapter do canal certo |
| Adapters (`Telegram`/`Discord`/`WebChannel`) | `src/channels/*Adapter.ts` | Implementação concreta de envio por canal |
| `SessionManager` | `src/session/SessionManager.ts` | Mantém `deliveredArtifacts` por sessão (cross-goal), consumido via `SessionContext` |

---

## 3. Criação de artefatos

| Formato | Mecanismo | Observação |
|---|---|---|
| Texto/HTML/MD/código | `WriteTool` | Único tool com gate de conteúdo (`CONTENT_STUB_PATTERNS`) |
| PDF | `exec_command` → `scripts/html2pdf.sh` (bash) ou Marp CLI | Depende de `bash` funcional — ver achado do commit `7d086d4` (WSL stub) |
| PPTX | `exec_command` → script Python (`python-pptx`) escrito antes via `WriteTool` | Dois tool calls (`write` do `.py` + `exec_command` que roda), nenhum dos dois "sabe" que o resultado é o `.pptx` final |
| DOCX/XLSX | `exec_command` → scripts equivalentes (não auditado em detalhe nesta passada) | Mesmo padrão do PPTX |
| Áudio | `SendAudioTool` (edge-tts + ffmpeg, tudo dentro do próprio tool) | **Não segue o padrão create→send**: um único tool call cria e entrega |

**Achado estrutural:** `exec_command` é o criador de fato da maioria dos formatos "ricos" (pptx/pdf/docx), mas devolve só texto (stdout/stderr/exit code) — **não há nenhum contrato que diga "este exec_command produziu o artefato X"**. Essa informação só é recuperada depois, heuristicamente, por quem lê `goal.attempts`/faz scan do workspace.

---

## 4. Registro de artefatos — três mecanismos paralelos, três semânticas diferentes

| Mecanismo | Escopo | Quando marca "entregue" | Sobrevive a quê |
|---|---|---|---|
| `sentArtifacts` (`GoalExecutionLoop`, persistido em `GoalStore`) | Por **goal** | Só após `send_document`/DELIVERY-GUARD confirmarem sucesso real | Restart do processo (SQLite) |
| `SessionManager.deliveredArtifacts` | Por **sessão** (cross-goal) | **No momento da CHAMADA** de `send_document` (`recordToolCall`, linha ~310) — não verifica se a tool teve sucesso | Compressão de sessão; NÃO sobrevive a restart (in-memory) |
| `onArtifactDelivered` callback (`ChannelContext`) | Por **turno** | Só chamado após `result.success===true` (tanto em `AgentLoop` quanto no dispatch nativo) | Nada — é só o canal de notificação que alimenta `sentArtifacts` |

**Achado de inconsistência (§9.3):** `SessionManager.deliveredArtifacts` registra a tentativa, não o resultado — o nome do campo ("delivered") promete algo que a implementação não garante. Se `send_document` FALHAR (ex.: arquivo não encontrado), o path ainda aparece em "ARQUIVOS ENVIADOS AO USUÁRIO NESTA SESSÃO" injetado no próximo prompt do LLM.

---

## 5. Planejamento — como o Planner e o RiskAnalyzer referenciam artefatos

- `GoalPlanner` não infere nada: só documenta o schema esperado (`{"file_path": "..."}`) no prompt.
- `RiskAnalyzer.analyze()` faz a **heurística de inferência #1**: se um step `send_document` não tem `file_path`, procura o `write` anterior mais próximo NO MESMO PLANO (não em execução real) e copia o path dele — mas para de procurar se encontra um `exec_command`/`agentloop` no meio (reconhecendo que esses podem ter mudado o artefato final). Isso é puramente sintático, sobre o JSON do plano, ANTES de qualquer execução.
- Replans (`GoalPlanner.replan`) podem trocar a estratégia inteira (`REPLAN_DIFF prev_tools=... new_tools=...`, já visto em produção) sem qualquer mecanismo que reconcilie `file_path` de um `send_document` que sobreviveu do plano anterior — **esse é exatamente o bug que o commit `7d086d4` corrigiu, mas na CAMADA DE EXECUÇÃO (`GoalExecutionLoop`), não na camada de planejamento.**

**Duplicação confirmada:** existem agora DUAS heurísticas de resolução de `file_path` para `send_document`, em dois momentos diferentes do ciclo de vida:
1. `RiskAnalyzer` — tempo de **planejamento**, infere por proximidade sintática no JSON do plano.
2. `GoalExecutionLoop` (fix de hoje) — tempo de **execução**, infere por evidência real em disco (`validateGoalCompletion.artifactPaths`).

Elas não se comunicam e não compartilham código.

---

## 6. Envio — todos os call sites de `send_document`/`sendVoice`/`sendAudio`

| Call site | Arquivo | Contexto |
|---|---|---|
| Dispatch nativo de tool call (turno normal) | `AgentLoop.ts` (~linha 2140, 2260) | Conversa comum, fora de um goal |
| DELIVERY-GUARD interno do AgentLoop | `AgentLoop.ts` (~linha 2598-2655) | Re-entra o loop se detecta "arquivo criado, não enviado"; tem seu PRÓPRIO cap de steps (`deliveryStepCap`) |
| Deferred sends do goal | `GoalExecutionLoop.ts` (~linha 730) | Depois de `validateGoalCompletion` retornar `achieved=true` — **onde o fix de hoje atua** |
| `deliverable_check` | `GoalExecutionLoop.ts` (~linha 840) | Antes de replanejar, se `achieved=false`: escaneia workspace via `checkDeliverables` e injeta `send_document` novo — **só roda se `inferExpectedExtensions` conseguir inferir alguma extensão do texto do pedido do usuário** |
| `send_audio` | `SendAudioTool.execute()` | Autocontido — gera e envia no mesmo call |

**Achado — `sendDocument` vs `sendVoice` divergem em robustez (`MessageBus.ts`):**
```ts
async sendVoice(...) {
    if (!adapter?.sendVoice) throw new Error(...);   // FALHA ALTO (fix S29/Hotfix E)
}
async sendDocument(...) {
    if (!adapter?.sendDocument) { log.warn(...); return; }  // ⚠️ RESOLVE SILENCIOSAMENTE
}
```
O mesmo bug que motivou o "Hotfix E" (S29) para `sendVoice` — resolver silenciosamente quando o canal não suporta a operação, fazendo o chamador acreditar em sucesso — **ainda existe hoje em `sendDocument`**. Combinado com o próximo achado, isso é potencialmente explorável.

**Achado — `SendDocumentTool` não trata WhatsApp/Signal:**
```ts
if (this.channel === 'discord') return this.sendToDiscord(...);
else if (this.channel === 'web') return this.sendToWeb(...);
else return this.sendToTelegram(...);   // ⚠️ whatsapp/signal caem aqui
```
Se `this.channel` for `'whatsapp'` ou `'signal'`, o tool tenta enviar via **Telegram** (canal errado) em vez de falhar explicitamente ou rotear certo. Não confirmado em produção nesta auditoria (não vi evidência de log), mas é uma inconsistência estrutural clara — está fora do escopo desta sprint corrigir, mas é candidato natural para a Sprint R2 ou para correção pontual imediata (a critério do usuário).

---

## 7. Validação

| Camada | O que valida | Específico de artefato? |
|---|---|---|
| `evaluateCriteria` (determinístico) | Checklist de `successCriteria` (ex.: `auto_delivery_send_document`) | Sim, mas só "a tool rodou", não "o arquivo certo" |
| `validateGoalCompletion` (LLM) | Pergunta ao LLM se o objetivo foi atingido, injetando conteúdo real dos arquivos escritos | Sim — é aqui que mora `writtenPaths`/`artifactPaths` (o fix de hoje) |
| `checkClaimsAgainstEvidence` | Anti-alucinação: se o LLM afirma "enviei X", exige um `attempt` real da tool correspondente | Parcialmente — usa `inferExpectedExtensions` pra exigir tipo de arquivo compatível (adicionado após bug real 09/07: `.py` aceito como prova de ".pptx enviado") |
| `GoalEvaluator.classifyError` | Classifica QUALQUER erro de tool em `GoalBlocker` por regex (`ERROR_PATTERNS`) | Não — genérico |
| `StepSemanticValidator`/`ObserverValidator` | Mismatch entre descrição do step e output | Não — genérico |
| `RiskAnalyzer` (Q2, tempo de plano) | Risco do plano ANTES de executar | Só na inferência de `file_path` (§5) |

---

## 8. Estado — onde o sistema considera um arquivo "criado/validado/pronto/enviado/entregue/falhou"

| Estado | Onde vive | Fonte de verdade |
|---|---|---|
| Criado | Disco (`fs.existsSync`) | Nenhuma estrutura formal — cada camada faz seu próprio `fs.existsSync`/`fs.statSync` |
| Validado | `validateGoalCompletion.artifactPaths` (novo, hoje) / `writtenPaths` | `goal.attempts` com `toolName ∈ {write,edit}` e `result='success'` — **não cobre arquivos gerados por `exec_command`/scripts**, exceto quando o path escrito coincide |
| Pronto p/ envio | `PlanStep.status === 'pending' && toolName === 'send_document'` | `currentPlan` no `GoalStore` |
| Enviado (tentativa) | `SessionManager.deliveredArtifacts` | Call-time, não success-gated (§4) |
| Entregue (confirmado) | `sentArtifacts` (goal) | Success-gated via `trackArtifact`/`onArtifactDelivered` |
| Falhou | `GoalBlocker` (`kind: 'tool_error'`, etc.) | `GoalEvaluator.classifyError`, persistido em `goal.blockers` |

**Onde diverge da realidade:** exatamente no ponto que o fix de hoje corrigiu — "Validado" (existe evidência real em disco) e "Pronto p/ envio" (o que o `PlanStep.toolArgs.file_path` diz) podem apontar para **arquivos diferentes** quando há replan/pivô de estratégia no meio da execução, porque nada reconcilia os dois automaticamente — cada replan gera um novo `PlanStep` com o `file_path` que o LLM "acha" que vai ser o resultado, não o que de fato foi escrito.

---

## 9. Consolidado — duplicações, heurísticas, inferências por `filePath` e riscos

### 9.1 Opacidade do `agentloop` como tipo de step
Quando o plano usa `toolName: 'agentloop'` (comum quando o passo é "criar o arquivo com conteúdo real"), TODA a atividade interna (write, exec_command, send_document) vira **um único `goal.attempts` com `toolName: 'agentloop'`** — invisível para: `writtenPaths` (só olha `write`/`edit` — mas o comentário em `validateGoalCompletion` mesmo reconhece isso como ponto cego conhecido), `checkClaimsAgainstEvidence` (mitigado parcialmente via `goal.sentArtifacts`), e para o `RiskAnalyzer` no replan seguinte.

### 9.2 `SendDocumentTool` sem rota para WhatsApp/Signal
Ver §6 — fallback silencioso para Telegram.

### 9.3 `SessionManager.deliveredArtifacts` != entrega confirmada
Ver §4 — nome promete "delivered", implementação é "attempted".

### 9.4 `MessageBus.sendDocument` resolve silenciosamente quando o adapter não suporta
Ver §6 — mesma classe de bug que `sendVoice` já teve corrigida (S29), não replicada aqui.

### 9.5 Duas heurísticas de inferência de `file_path`, independentes
Ver §5 — `RiskAnalyzer` (tempo de plano, sintático) vs. `GoalExecutionLoop` (tempo de execução, evidência real — fix de hoje). Nenhuma reusa a outra.

### 9.6 Nenhum contrato entre `exec_command` e "artefato produzido"
Ver §3 — a maioria dos formatos ricos (pptx/pdf/docx) nasce de scripts rodados via `exec_command`, que não tem noção de "arquivo de saída"; tudo que existe depois é inferência posterior (scan de workspace, `writtenPaths`, ou o LLM "lembrando" o nome que ele mesmo escolheu).

### 9.7 Tentativa histórica de centralização já revertida
`ArtifactDeliveryRegistry` existiu e foi removido (auditoria jun/2026, "8 bugs críticos" — ver `P1_1_ArtifactPersistence_CrossGoal.test.ts`). A arquitetura atual ("Strategy B") é deliberadamente descentralizada: cada camada resolve seu pedaço. Isso é contexto histórico relevante para a Sprint R2 — uma nova tentativa de centralização precisa entender por que a anterior falhou antes de repetir a abordagem.

---

## 10. Proposta inicial de oportunidades de simplificação (NÃO implementar ainda)

Estas são hipóteses para avaliar na Sprint R2, não decisões:

1. **Contrato mínimo de "artefato produzido"** para `exec_command`: um jeito estruturado (não regex/scan) de uma tool declarar "eu produzi o arquivo X", que `write` e `exec_command` (via convenção de output, ex. linha `ARTIFACT: <path>` capturada deterministicamente) alimentem igualmente. Isso substituiria a necessidade de inferir por `writtenPaths`/scan de workspace.
2. **Fonte única de "o que já existe e é válido"**: unificar `writtenPaths`/`artifactPaths` (validação) com `checkDeliverables` (scan por extensão) num único helper reutilizado tanto por `validateGoalCompletion` quanto por `deliverable_check` — hoje são duas implementações paralelas com o mesmo objetivo.
3. **Alinhar semântica de `SessionManager.deliveredArtifacts`** com `sentArtifacts` (ambos success-gated), ou renomear para refletir o que realmente é ("attemptedArtifacts").
4. **Alinhar `MessageBus.sendDocument` com `sendVoice`** (falhar explicitamente em vez de resolver silenciosamente).
5. **Reconciliar o `file_path` de um `send_document` pendente após um replan** de forma proativa (no momento do replan, não só reativamente na entrega, como o fix de hoje faz) — evita a janela onde o plano "esquece" o pivô de estratégia.

Qualquer uma dessas pode virar uma Sprint R2 independente e pequena — nenhuma exige tocar nas outras.

---

## 11. Respostas ao critério de conclusão

- **Quem cria um artefato?** `WriteTool` (texto) e `exec_command` (scripts externos → pptx/pdf/docx/mp4); `SendAudioTool` cria E entrega no mesmo tool call.
- **Quem o identifica?** Ninguém de forma centralizada. Identificação é reconstituída post-hoc por: `RiskAnalyzer` (sintático, tempo de plano), `writtenPaths`/`artifactPaths` (goal.attempts, tempo de validação), `checkDeliverables` (scan de workspace por extensão inferida do texto do usuário).
- **Quem o envia?** `SendDocumentTool`/`SendAudioTool` → `MessageBus` → Adapter do canal. Três pontos de disparo independentes: dispatch nativo do AgentLoop, DELIVERY-GUARD do AgentLoop, deferred sends do GoalExecutionLoop.
- **Quem confirma a entrega?** `onArtifactDelivered` callback (alimenta `sentArtifacts`, success-gated) — mas em paralelo `SessionManager.deliveredArtifacts` "confirma" no momento da chamada, não do sucesso (inconsistência, §4).
- **Quem registra sucesso?** `GoalStore.sentArtifacts` (por goal) e `SessionManager.deliveredArtifacts` (por sessão, semântica diferente).
- **Quem registra falha?** `GoalEvaluator.classifyError` → `GoalBlocker` em `goal.blockers`.
- **Como um replan altera o artefato?** O `GoalPlanner`/`RiskAnalyzer` geram um novo `currentPlan` com novos `PlanStep`, incluindo um novo `file_path` para `send_document` se o LLM decidir — sem qualquer reconciliação automática com o que foi de fato produzido nos ciclos anteriores. Essa é a lacuna que o fix de hoje fecha, mas só no momento do ENVIO, não no momento do REPLAN.
- **Onde o estado do artefato pode divergir da realidade?** (a) entre um `PlanStep.toolArgs.file_path` desatualizado e o artefato real após pivô de estratégia (fix de hoje); (b) entre `SessionManager.deliveredArtifacts` (call-time) e a entrega real (success-time); (c) dentro de um step `toolName='agentloop'`, cuja atividade interna é invisível para `writtenPaths`.

---

## Conclusão da Sprint R1

Mapeamento completo. Nenhum código alterado. Cinco achados concretos de inconsistência documentados (§9.1–9.5), mais o contexto histórico da tentativa de centralização revertida (§9.7). Cinco oportunidades de simplificação propostas (§10), nenhuma implementada.

**Pronto para definir o escopo da Sprint R2** — recomendação: começar pelo item de menor risco e maior valor isolado (§10.2 ou §10.3), não pela centralização completa, dado o histórico do `ArtifactDeliveryRegistry`.
