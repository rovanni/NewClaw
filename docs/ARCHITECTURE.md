# Arquitetura de Canais do NewClaw

## Filosofia do sistema

O NewClaw **não é um bot de Telegram, WhatsApp, Discord ou um Dashboard web**. O NewClaw é um
**Core de IA** (memória, planejamento, ferramentas, execução) que se comunica através de canais.
Um canal é apenas uma porta de entrada/saída — nunca um lugar onde a IA "pensa".

## Princípios

1. Todo canal é apenas um adaptador (`ChannelAdapter`).
2. Toda lógica de IA pertence ao Core (`AgentLoop`, `GoalOrchestrator`, `WorkflowEngine`,
   `ToolRegistry`, `MemoryManager`, `agentMediaHandlers`).
3. Todo canal produz um `NormalizedMessage` na entrada e consome um `NormalizedResponse` na saída.
4. Todo canal entra pelo mesmo `MessageBus.processMessage()`.
5. Toda funcionalidade nova (OCR, um novo parser de documento, um novo modelo de visão etc.) é
   implementada uma única vez no Core e passa a valer automaticamente para todos os canais.
6. `ChannelAdapter`s não contêm regras de negócio de IA.
7. Diferenças entre adapters só existem para atender limitações específicas da API de cada
   plataforma (chunking de mensagem longa, markdown→HTML, emojis, formato de anexo).

## Fluxo oficial

```
Canal (Telegram/Discord/WhatsApp/Signal/Dashboard)
        │
        ▼
  ChannelAdapter          — traduz o formato da plataforma → NormalizedMessage
        │
        ▼
  MessageBus.processMessage()
        │  (dedup, fila por conversa, comandos, onboarding)
        ▼
  agentMediaHandlers      — whisper (voz), vision/OCR (foto/documento-imagem), salva
        │                    documentos no workspace
        ▼
  GoalOrchestrator / AgentLoop   — Core: planejamento, ferramentas, memória
        │
        ▼
  MessageBus → adapter.send(NormalizedResponse)
        │
        ▼
  ChannelAdapter          — traduz a resposta → formato da plataforma
        │
        ▼
Canal
```

### Diagrama por camadas

```text
┌──────────────────────────────────────┐
│          Canais de Comunicação        │
│ Telegram │ WhatsApp │ Discord │ Web   │
└──────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────┐
│          ChannelAdapters              │
└──────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────┐
│          MessageBus                   │
└──────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────┐
│             Core                      │
│ GoalOrchestrator                      │
│ AgentLoop                             │
│ Memory                                │
│ WorkflowEngine                        │
│ ToolRegistry                          │
│ agentMediaHandlers                    │
└──────────────────────────────────────┘
```

## Componentes do Core (nenhum adapter os conhece diretamente)

| Componente | Responsabilidade |
|---|---|
| `MessageBus` | Roteamento central: dedup por `messageId`, fila serial por conversa (`ConversationQueueManager`), comandos (`/clear` etc.), onboarding, dispara `agentMediaHandlers` e depois `GoalOrchestrator`/`AgentLoop`. |
| `AgentController` | Facade — instancia e conecta adapters, `MessageBus`, `AgentLoop`, `WorkflowEngine`, registra ferramentas e media handlers. |
| `agentMediaHandlers.ts` | `transcribeAttachment` (Whisper), `handleDocumentAttachment`/`handlePhotoAttachment` (Vision/OCR, salva no workspace). Aceita três origens de bytes: `fileId` (download via `adapter.downloadFile`), `attachment.url` (CDN direta, ex. Discord) ou `attachment.data` (base64 inline, ex. Dashboard web). |
| `GoalOrchestrator` / `AgentLoop` / `WorkflowEngine` | Planejamento, execução de ferramentas, memória, autorização de ações perigosas. |

Nenhum arquivo em `src/loop/` importa qualquer `*Adapter` — confirmado por auditoria (zero
referências). O Core não sabe que Telegram, Discord, WhatsApp, Signal ou o Dashboard existem.

## ChannelAdapters

Todos implementam a interface `ChannelAdapter` (`src/channels/ChannelAdapter.ts`):
`start()`, `stop()`, `send()`, `healthCheck()` são obrigatórios;
`sendToChat`, `sendTypingIndicator`, `downloadFile`, `sendVoice`, `sendDocument` são opcionais.

| Adapter | `downloadFile` | `sendVoice`/`sendDocument` | Como entrega bytes de anexo |
|---|---|---|---|
| Telegram | ✅ | ✅ | `fileId` → `bot.api.getFile` + download |
| Discord | ❌ | ❌ | `attachment.url` (CDN pública) |
| Web (Dashboard) | ❌ | ❌ | `attachment.data` (base64 inline, via `multipart/form-data`) |
| WhatsApp | ❌ | ❌ | ⚠️ nenhum — ver "Gaps conhecidos" |
| Signal | ❌ | ❌ | ⚠️ nenhum — ver "Gaps conhecidos" |

A diferença é **necessária**: cada plataforma entrega bytes de um jeito distinto (Telegram exige
um segundo request autenticado por `fileId`; Discord expõe CDN pública; o Dashboard não tem
"canal" real, então envia o arquivo já no corpo da requisição). `agentMediaHandlers` já sabe lidar
com as três formas — não há necessidade de forçar todo adapter a implementar `downloadFile`.

### Regras de negócio dentro de adapters?

Auditoria (`grep` por `AgentLoop|GoalOrchestrator|ToolRegistry|MemoryManager|WorkflowEngine` nos 5
adapters): **nenhuma ocorrência**. O que existe dentro de cada adapter é só:

* ✔ conversão de anexos (mimetype → `photo`/`audio`/`document`/`video`)
* ✔ conversão de markdown/emoji (`stripHtml`, `stripMarkdown`, `mdToTelegramHTML`)
* ✔ conversão de IDs (`fileId`, `jid`, `chatId`)
* ✔ limitações da API do canal (chunking de mensagem > 4096/2000 chars, confirmação de mídia)
* ✔ ACL por canal (`allowedUserIds`/`allowedJids`/`allowedNumbers`) — uma decisão binária de
  permitir/negar a entrada, não uma decisão de IA

Não há Planner, Skills, Memória, Prompt Engineering ou Ferramentas dentro de nenhum adapter.

## Dependências proibidas

Regra arquitetural verificável por `grep` — se aparecer, é bug de arquitetura, não estilo:

```text
src/loop/**  (GoalOrchestrator, AgentLoop, WorkflowEngine, GoalPlanner, ...)

    NUNCA importa

    TelegramAdapter, DiscordAdapter, WhatsAppAdapter, SignalAdapter, WebChannelAdapter
```

```text
src/channels/*Adapter.ts  (qualquer ChannelAdapter, incluindo futuros)

    NUNCA importa

    AgentLoop, GoalOrchestrator, WorkflowEngine, ToolRegistry, MemoryManager,
    PromptRegistry, SkillLoader
```

Um adapter só pode conhecer: `ChannelAdapter`/`NormalizedMessage`/`NormalizedResponse`/
`ChannelAttachment` (o "idioma comum"), `MessageBus` (para onde ele manda a mensagem normalizada)
e bibliotecas específicas da própria plataforma (grammY, discord.js, Baileys, signal-cli).

## Filosofia de reutilização

Antes de implementar uma funcionalidade nova, nessa ordem:

1. **Existe API nativa do Node/runtime que já resolve isso?** Use-a.
2. **Já existe implementação equivalente no Core** (`agentMediaHandlers`, uma tool, um serviço)?
   Reaproveite — não crie um segundo caminho.
3. **Já existe implementação em outro adapter** que resolve um problema parecido (ex: chunking de
   mensagem longa, download por URL)? Generalize/extraia em vez de copiar.
4. Só então, se nada acima resolve, escreva código novo — e escreva-o no Core, nunca dentro de um
   adapter específico (ver "Princípios de Evolução" abaixo).

## Princípios de Evolução

Quando uma nova capacidade surgir (análise de Excel, DWG, CAD, um novo parser, um novo modelo de
visão, um novo tipo de anexo):

```text
❌ Não implemente no Telegram.
❌ Não implemente no Dashboard.
❌ Não implemente no WhatsApp.
✔ Implemente no Core (agentMediaHandlers, uma tool nova, ou o serviço correspondente).

Os canais apenas passam a utilizá-la — nenhuma linha nova em nenhum adapter.
```

Se uma funcionalidade exige alterar mais de um `*Adapter.ts` para "funcionar em todo canal", isso
é sinal de que ela foi colocada no lugar errado — deveria estar em uma única linha do Core.

## Contexto de aplicativo hospedeiro (`metadata.hostApp`)

Alguns canais rodam DENTRO de outro aplicativo (hoje: o suplemento do PowerPoint; possíveis
futuros: Word, Excel). O canal declara isso populando `NormalizedMessage.metadata.hostApp`
(+ dados extras, ex.: `slideContext` com arquivo aberto/slide ativo/títulos). Esse metadata
viaja pelo `MessageBus` até o `ChannelContext` e é formatado por UMA função —
`shared/hostAppContext.ts: buildHostAppContextBlock()` — consumida pelos DOIS caminhos de
raciocínio:

* `SessionContext.buildLLMMessages()` — turnos do AgentLoop;
* `GoalExecutionLoop` → `GoalPlanner.plan/replan/planRoadmap` — planejamento de goals, como
  seção própria do prompt (`AMBIENTE DA CONVERSA`), fora do orçamento de memória semântica.

Regra: nenhum consumidor duplica a formatação, e nenhum código decide comportamento por
vocabulário do usuário — o sinal é sempre o `hostApp` declarado pelo canal (determinístico,
independente de idioma). Origem: investigação 2026-07-14
(`docs/INVESTIGACAO_POWERPOINT_ADDIN_2026-07-14.md`), na qual o GoalPlanner planejava cego ao
PowerPoint aberto porque só o caminho AgentLoop injetava esse contexto.

## Exceções arquiteturais documentadas

Nem todo desvio da regra "tudo passa pelo `MessageBus`" é um bug. Quando uma exceção legítima
existir (a de hoje, e outras que provavelmente surgirão), ela deve ser **documentada aqui**, não
deixada implícita no código — é isso que diferencia uma exceção arquitetural de uma gambiarra.

### workflowCallback — aprovação de ações perigosas

Os quatro adapters de mensageria (Telegram/Discord/WhatsApp/Signal) reconhecem o padrão de texto
`auth:<approve|reject>:<txnId>` (clique em botão de aprovação de ação perigosa) e chamam
`workflowCallback` diretamente — **sem passar por `MessageBus.processMessage()`**.

Isso é intencional, não um descuido: aprovar/rejeitar uma transação já pendente é uma ação de UI
binária, não uma mensagem de chat que precise ser interpretada pelo LLM. Rotear isso pelo pipeline
completo (fila, GoalOrchestrator, LLM) seria overhead desnecessário e semanticamente errado.

O que a auditoria encontrou de errado não foi o bypass em si, mas a **duplicação**: os quatro
canais tinham o mesmo bloco de ~30 linhas copiado (resume da transação, checagem de goal
pendente, envio da resposta, registro na sessão). Isso foi consolidado em
`AgentController.createWorkflowCallback(adapter, channel, format)` — um único ponto de
implementação parametrizado pelo adapter/canal/formato de saída.

## Gaps conhecidos (não corrigidos nesta rodada — fora do escopo original)

**WhatsApp e Signal não conseguem processar anexos hoje.** Ambos os adapters populam
`ChannelAttachment.fileId` mas nunca implementam `downloadFile()` nem preenchem `.data`/`.url`.
Como `agentMediaHandlers` só sabe obter bytes via `fileId`+`downloadFile` (só Telegram tem),
`.url` (só Discord) ou `.data` (Web), uma foto/áudio/documento enviado por WhatsApp ou Signal cai
no branch de erro (`"⚠️ Falha ao baixar o arquivo do canal ..."`) sem nunca chegar à IA.

Correção real exigiria, por canal:
* **WhatsApp**: usar `downloadMediaMessage` do Baileys para baixar o buffer no momento do
  recebimento (ou implementar `downloadFile` no adapter).
* **Signal**: `signal-cli` já grava o anexo em disco localmente — o adapter precisa ler esse
  arquivo local e popular `attachment.data`.

Isso não foi implementado agora porque é uma mudança em dois canais de produção que não há como
testar neste ambiente (sem sessão WhatsApp/Signal ativa) — ver com o operador antes de mexer.

## Como adicionar um canal novo

1. Criar `MeuNovoChannelAdapter implements ChannelAdapter`.
2. Na entrada: traduzir o evento da plataforma para `NormalizedMessage` e chamar
   `messageBus.processMessage(msg)`.
3. Na saída: implementar `send(response: NormalizedResponse, context)` traduzindo para a API da
   plataforma (chunking, formatação, anexos).
4. Registrar em `AgentController`: `messageBus.registerAdapter(new MeuNovoChannelAdapter(...))`.
5. Nada mais. Goals, ferramentas, memória, visão, OCR, whisper — tudo já funciona, porque tudo
   isso vive no Core e nunca no adapter.

Foi exatamente esse o caminho seguido para o Dashboard web: antes ele tinha um método próprio
(`AgentController.handleWebMessage`) que ia direto ao `AgentLoop`, sem fila, sem anexos, sem
`GoalOrchestrator`. Hoje `WebChannelAdapter` implementa a interface normal e o Dashboard é só mais
um canal — o upload de arquivo, visão e leitura de documento no chat web vieram de graça, sem
nenhuma lógica nova de IA, só reaproveitando o que Telegram/Discord já tinham.
