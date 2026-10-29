# ADR-030 — Voz para o NewClaw pelo Pipecat do lab: a boca é um cliente do canal, não um segundo cérebro

Data: 28/10/2026. Status: **proposta** — só documento, nada implementado. Aguarda as decisões da operadora (seção
"Decisões que ficam com a operadora"). Entrada: `Idéias/Assistente voz newclaw.md` (conversa com o Thorial, 27/10/2026),
tratada como hipótese a criticar, não como decisão.

## Fase 1 — Compreensão

### O que se quer

Falar com o NewClaw em voz, usando o pipeline Pipecat que já funciona no lab (a "Alexa caseira": mic → Whisper → LLM →
Kokoro), sem construir um segundo agente. A ideia do Thorial propõe "persona na frente, execução atrás", com três cuidados
(memória única, fila com status visível, modelo leve na frente) e um MVP em três fases (divisão dentro do NewClaw → UI web →
voz pelo Pipecat).

### O que o código já tem (conferido em `origin/main`, ab0f583)

| Peça da ideia | O que já existe | Onde |
|---|---|---|
| "Camada de conversa + fila de tarefas" (Fase 1 da ideia) | Fila serial por conversa, ACK de fila ocupada, complemento a objetivo em andamento, objetivos longos em segundo plano | `MessageBus.processMessage` (`ConversationQueueManager`, `trySupplementActiveGoal`), `GoalOrchestrator` |
| "Status visível" | Relato de progresso determinístico (sem modelo, sem cota) a cada `RELATO_DE_PROGRESSO_MIN` (padrão 5 min), para objetivo e para turno de conversa longo | ADR-027; `NormalizedResponse.progresso`; `AgentController.ts:345-352` |
| "UI web" (Fase 2 da ideia) | Painel com chat assíncrono: `POST /api/chat` devolve `202 {turnId}`; a resposta sai por `GET /api/chat/outbox?turnId=`; o progresso por `GET /api/chat/active` | `dashboard/routes/chat.ts:230-340`, `WebChannelAdapter` |
| Cliente externo do canal web | O suplemento do PowerPoint já é exatamente isso: fala com `POST /api/chat` por **Bearer**, marca a origem pelo prefixo do `sessionId` (`powerpoint-addin-` → `metadata.hostApp`) | `chat.ts:272-285`, `security.ts:163-166` (Bearer isento da checagem CSRF), `auth.ts:240` |
| Transcrição (STT) | `transcribeAttachment`: aceita áudio por `fileId`, `url` ou `data` base64; converte com ffmpeg; usa `WHISPER_API_URL`/`WHISPER_API_FALLBACK` (servidor whisper com `/inference`) ou o `whisper` local | `core/agentMediaHandlers.ts:150-290` |
| Síntese (TTS) com Kokoro | `send_audio` já fala com servidor compatível com a API OpenAI (`KOKORO_TTS_URL`, `KOKORO_TTS_VOICE`, S311), sem endereço padrão | `tools/send_audio.ts:194, 351-371`; `.env.example:293-301` |
| Cancelar | `/cancelar`, `/cancel`, `/stop`, `/pare` — comando prioritário, fura a fila, cancela turno e objetivo | `agentControllerCommands.ts:25-38`; `MessageBus.ts:374-388` |
| "Modelo leve" | Perfis de modelo declarados pela operadora (`MODEL_CHAT`, `MODEL_LIGHT`, …, e `PROVIDER_*` por perfil); o código não escolhe modelo nenhum (issue 068) | `.env.example:90-104`; `index.ts:110` |
| Idioma | `buildLanguageDirective(config.language)` para o que o LLM escreve; textos fixos do Core saem em pt-BR (gap conhecido) | `ARCHITECTURE.md`, "Gaps conhecidos" |

Conclusão da Fase 1: **as Fases 1 e 2 do MVP da ideia já estão feitas.** O que falta é só a voz — e ela não exige uma
"camada de conversa" nova, porque essa camada é o próprio `MessageBus` + `GoalOrchestrator`.

### Correção de uma afirmação da ideia

A ideia diz que *"o frontend do NewClaw já existe em embrião — AgentController.js e AuditorService.js já estão
compilados"*. **Não é verdade.** Os `.js` são só a compilação de arquivos do Core:

- `src/core/AgentController.ts` é a **fachada do Core**: instancia e liga adapters, `MessageBus`, `AgentLoop`,
  `WorkflowEngine`, ferramentas e media handlers (`ARCHITECTURE.md`, "Componentes do Core").
- `src/services/auditor/AuditorService.ts` é o **autodiagnóstico interno** (`/audit`, só a dona): analisa código, runtime e
  dados, com pipeline de correção automática. Não conversa com o usuário.

Os "frontends" do NewClaw são os canais (`src/channels/*Adapter.ts`) e o painel (`src/dashboard/`). Nenhum dos dois
arquivos citados é base para uma camada de conversa.

### Tentativas anteriores e decisões relacionadas

- Não há tentativa anterior de voz em tempo real no repositório (nenhuma menção a Pipecat em `docs/` ou `src/`). Voz hoje é
  só **nota de voz** (Telegram/Discord/painel → `transcribeAttachment`) e **áudio de saída** (`send_audio`).
- `ARCHITECTURE.md` — "Como adicionar um canal novo" e "Dependências proibidas": canal é porta, não pensa.
- `RFC-008` — contexto de aplicativo hospedeiro (precedente do cliente externo identificado por prefixo de `sessionId`).
- `ADR-027` — relato de progresso; `ADR-029` — o pedido é entendido pela conversa (o complemento falado durante um objetivo
  passa por aí).
- `SOBERANIA_DA_CONFIGURACAO.md` e `NUNCA_ADIVINHAR.md` — nenhum modelo, voz ou endereço é escolhido pelo código.

## Fase 2 — Crítica da hipótese

Hipótese de partida: *"o Pipecat entra como um `ChannelAdapter` novo (só STT/TTS, sem LLM nem memória próprios), e com isso
memória única e relato de progresso já vêm do Core"*.

### O que se sustenta

- **Sem LLM nem memória no Pipecat.** É o ponto central e está certo. Se o Pipecat mantiver o próprio LLM conversando "na
  frente", passa a haver dois cérebros com duas memórias — exatamente o "cadê meu pedido?" que a ideia quer evitar. O
  estágio LLM do pipeline sai; no lugar dele entra a chamada ao NewClaw.
- **Memória de longo prazo já é única.** O grafo de memória não é particionado por canal nem por usuário
  (`MemoryGraphRepository.ts`/`graphRepository.ts` não têm `user_id` nem canal). O que a voz aprender ou consultar é o mesmo
  que o Telegram vê.
- **Progresso já vem do Core.** O relato do ADR-027 chega a qualquer canal pelo `sendToChat` com `progresso: true`; no canal
  web, fica disponível em `GET /api/chat/active`.

### O que cai

1. **"ChannelAdapter novo" não passa no gate "Extensão antes de Criação".** Já existe um adapter feito para clientes
   externos que falam HTTP: o `WebChannelAdapter`, com fluxo assíncrono (`202` + outbox), progresso, fila de entregas
   órfãs e autenticação por Bearer — e já tem um segundo cliente além do painel (o suplemento do PowerPoint). Um
   `VoiceChannelAdapter` hoje seria: um `ChannelType` novo, uma rota nova, um segundo mecanismo de outbox. Nada disso tem
   evidência de necessidade **antes** de medir o caminho existente (ver Fase 3, gate).
2. **"Memória única" é só meia verdade.** O histórico da conversa e o objetivo ativo são chaveados por `canal:usuário`
   (`composeSessionKey`, `SessionKeyFactory.ts:28`). Uma conversa por voz é **outra conversa** que a do Telegram: perguntar
   por voz "como está aquele pedido?" sobre um objetivo aberto no Telegram depende da memória de longo prazo achar o
   assunto — não do histórico. Unificar identidade entre canais é um conceito novo, fora desta ADR (decisão D5).
3. **"Modelo leve na frente" contradiz três regras do projeto.** (a) A escolha de quando "escalar" para o modelo forte
   seria um roteador semântico na frente do roteador que já existe (`UnifiedIntentRouter`/`GoalExtractor`) — avaliador
   encadeado e duas autoridades para a mesma decisão (`RESPONSABILIDADE_ANTES_DO_MECANISMO`, regra de custo). (b) Ele
   responderia "o trivial" com outra memória. (c) Exigiria nomear um modelo, e o código não escolhe modelo. Se a operadora
   quiser respostas de conversa mais rápidas, o caminho já existe: ela declara o modelo do perfil (`MODEL_CHAT`,
   `PROVIDER_CHAT`). Sem declaração, nada muda — não há padrão a sugerir.
4. **"Reconhecimento imediato" não pode ser uma frase gerada.** Voz espera retorno em 1–2 s; um turno do NewClaw leva de
   segundos a minutos (no caso real medido em `RESPONSABILIDADE_ANTES_DO_MECANISMO`, 692 s, 94,7% inferência). Gerar
   "anotado, já estou fazendo" com um LLM na frente é o item 3. Usar texto fixo do Core reabre o gap de idioma. O fato
   objetivo disponível é **"o turno foi aceito"** (`202` com `turnId`) — e um fato se sinaliza com **som**, não com fala
   (como a luz da Alexa ou o `sendTypingIndicator` dos outros canais).

### Casos extremos

- **Barge-in** tem três níveis, e só um é novo:
  1. Interromper a fala do TTS quando a pessoa volta a falar — nativo do Pipecat (VAD), local, não toca o NewClaw.
  2. Falar de novo enquanto o NewClaw trabalha — já tratado: vira complemento do objetivo ativo
     (`trySupplementActiveGoal`) ou entra na fila com ACK. Nada a fazer.
  3. **Cancelar por voz** — aberto. Os comandos prioritários exigem `/` no começo (`MessageBus.ts:375`); a transcrição de
     "pare" não começa com `/`. Mapear frase falada para comando no Pipecat seria lista de palavras interpretando linguagem
     natural — proibido. Opções na decisão D3.
- **Textos fixos falados.** Os ACKs do `MessageBus` ("🧠 Estou concluindo a tarefa anterior…", "📎 Anotado…") chegariam
  ao TTS com emoji e sempre em pt-BR. Remover emoji/markdown antes de falar é tradução de formato (princípio 7, como o
  `stripMarkdown` dos outros adapters); o idioma é o gap já conhecido.
- **Resposta longa.** Ler em voz uma resposta de 2.000 palavras ou um passo a passo é ruim. Encurtar no canal perde
  conteúdo; pedir "resposta falável" ao Core é conceito novo (parecido com o `hostApp` da RFC-008, que ainda está em
  sombra). Decisão D4.
- **Anexos de saída** (PPTX, PDF): voz não entrega arquivo. Eles continuam persistidos na conversa (`sessionId` da voz) e
  visíveis no painel; o canal fala só o texto.
- **Limite de taxa**: `POST /api/chat` aceita 10 por minuto por IP (`chat.ts:17-18`). Conversa falada normal fica abaixo,
  mas o Pipecat não pode reenviar em laço.
- **Polling**: o tempo até a resposta inclui o intervalo de consulta ao outbox. Com polling de ~0,5 s o acréscimo é
  pequeno perto da inferência, mas é hipótese — medir (critério C2).
- **Progresso a cada 5 min** (padrão do ADR-027) é longo para quem está de pé na cozinha esperando. O valor é global, não
  por canal. Decisão D6.

### Risco de God Object

Nenhum, na recomendação: nada entra no Core. Haveria risco se o Pipecat ganhasse "persona" própria (aí ele viraria um
segundo `AgentLoop` fora do repositório).

## Fase 3 — Pesquisa de alternativas

Padrão conhecido que se aplica: **"thin client / terminal burro"** sobre um serviço com fila e entrega assíncrona
(request-acknowledge-poll, o mesmo do `202 Accepted` + recurso de status do HTTP). O reconhecimento imediato é o `202`; a
entrega é o recurso consultado depois. É o que o painel já faz.

| # | Alternativa | Vantagens | Desvantagens |
|---|---|---|---|
| A | **Ideia como está**: Pipecat com LLM próprio na frente, escalando para o NewClaw | Latência baixa no trivial; a "Alexa" atual quase não muda | Dois cérebros e duas memórias; roteador semântico duplicado; exige nomear um modelo no Pipecat; contradiz `RESPONSABILIDADE_ANTES_DO_MECANISMO` e a regra de modelos |
| B | **Pipecat como cliente HTTP do canal web existente** (como o suplemento do PowerPoint): troca o estágio LLM por "envia ao NewClaw, toca um som de aceito, consulta progresso e resposta, fala" | **Zero arquivo novo no NewClaw** no primeiro incremento; reusa fila, outbox, progresso, entregas órfãs, Bearer, persistência da conversa no painel; reversível desligando o Pipecat | Canal aparece como `web` (separável pelo prefixo do `sessionId`, como o PowerPoint); latência de polling; o limite de taxa do chat vale para ele |
| C | **`VoiceChannelAdapter` novo** no NewClaw (`ChannelType 'voice'`), com WebSocket/SSE para o Pipecat | Push em vez de polling; identidade própria do canal nos logs; `sendTypingIndicator` vira o som de "pensando" | Tipo de canal novo, rota nova, segundo mecanismo de outbox — sem evidência medida de que B não basta; falha no gate hoje |
| D | Pipecat falando com o NewClaw **pelo Telegram** (como se fosse um usuário) | Nenhum código | Gambiarra: ACL, formatação e identidade de bot; latência da API do Telegram; impossível separar a origem |
| E | Só a saída: `send_audio` tocar no alto-falante do lab | Pequeno | Não é conversa; não resolve a entrada |

### STT: onde transcrever

| Opção | Vantagens | Desvantagens |
|---|---|---|
| S1. O Pipecat transcreve (como já faz) e manda **texto** | O pipeline do lab não muda; a transcrição em streaming dele já está afinada; menos latência (sem upload, sem ffmpeg) | Duas configurações de STT (a do Pipecat e a do Core); o fato "veio de voz" se perde, a não ser que vá em metadado |
| S2. O Pipecat manda o **áudio** do trecho de fala como anexo; o Core transcreve (`transcribeAttachment`) | Uma transcrição só (a do Core), mesma de nota de voz em todos os canais; se `WHISPER_API_URL` apontar para o mesmo servidor whisper do lab, é um servidor e uma configuração | Upload + ffmpeg + inferência no caminho; o fallback local do Core força `--language pt` (`agentMediaHandlers.ts:273`), um idioma embutido |

Nenhuma das duas é claramente melhor sem medir; S1 é o menor passo (o pipeline já funciona) e S2 é o "um padrão só". Decisão
D2.

### Gate obrigatório — Extensão antes de Criação

Arquivos novos propostos no NewClaw pela hipótese de partida, um por um:

1. **`src/channels/VoiceChannelAdapter.ts`** — (1) precisa existir? **NÃO**, agora. (2) Já existe:
   `src/channels/WebChannelAdapter.ts` + `src/dashboard/routes/chat.ts` (fluxo `202`/outbox, progresso, Bearer).
   (3) Extensão pequena que elimina o arquivo: nenhuma — o caminho existente serve como está; a origem é marcada pelo
   prefixo do `sessionId`, como em `chat.ts:274`. (4) Só volta a ser candidato se a medição do incremento 1 mostrar que o
   polling não cumpre o critério C2 — e aí a primeira tentativa é estender a rota de chat (ex.: SSE no mesmo `turnId`),
   não criar adapter.
2. **Tool/Skill/Script de voz** — **NÃO**. O TTS de saída já está em `send_audio` (`KOKORO_TTS_URL`) para quem quiser
   áudio nos outros canais; no canal de voz quem fala é o próprio Pipecat.
3. **Rota nova para o Pipecat** — **NÃO**. `POST /api/chat`, `GET /api/chat/active`, `GET /api/chat/outbox` cobrem envio,
   progresso e entrega.

Sobram **zero** arquivos novos no NewClaw para o incremento 1. O código novo fica no repositório do Pipecat do lab: um
processador no lugar do estágio LLM (fora deste repositório e desta ADR).

## Fase 4 — Síntese

### Recomendação

**Alternativa B, com o Pipecat como terminal de voz do canal web.** O Pipecat perde o estágio LLM e passa a ser só boca e
ouvido:

```text
mic ─▶ VAD/STT (Pipecat) ─▶ POST /api/chat  {message, sessionId: "voz-<dispositivo>"}   (Bearer)
                                 │
                                 ├─ 202 {turnId} ──▶ som de "aceito" (local, ~imediato, sem palavra)
                                 │
                 GET /api/chat/active?sessionId&turnId  ──▶ progresso (ADR-027) ──▶ fala o relato novo
                 GET /api/chat/outbox?turnId            ──▶ resposta final
                                 │
                         remove markdown/emoji ─▶ Kokoro (TTS do Pipecat) ─▶ alto-falante
```

Por que esta e não as outras:

- **Hipótese de partida, parte derrubada:** "um `ChannelAdapter` novo" — não precisa; o adapter certo já existe.
- **Hipótese de partida, parte confirmada:** "só STT/TTS, sem LLM nem memória" — memória de longo prazo, fila, complemento,
  cancelamento, progresso e entrega tardia vêm do Core sem uma linha nova.
- **A** é descartada por criar um segundo cérebro; **C** por não ter evidência (fica como incremento condicional);
  **D** e **E** não resolvem o problema.
- **Reconhecimento imediato** = som tocado pelo Pipecat ao receber o `202`. Sinaliza um fato estrutural (turno aceito), não
  interpreta nada, não gasta modelo, não tem idioma.

### Riscos que ficam

- **Latência de resposta simples** depende do modelo que a operadora declarou para conversa e do caminho do turno (roteador,
  juiz de suficiência). **Não medida** para o canal web — é o primeiro número a coletar (C2). Se ficar ruim, a resposta é
  configuração dela ou uma ADR sobre o caminho do turno de conversa, nunca um LLM na frente.
- **Conversa separada da do Telegram** (D5).
- **Cancelar por voz** sem solução decidida (D3).
- **Resposta longa falada** (D4).
- **Textos fixos do Core** falados sempre em pt-BR (gap conhecido, `ARCHITECTURE.md`).
- **Exposição do painel na rede**: o Pipecat precisa alcançar a API do painel de outra máquina, com token. Com
  autenticação desligada o painel se recusa a subir fora de localhost (`isUnsafeExposedBoot`, `DashboardServer.ts:186`) —
  ou seja, sem auth ligada o Pipecat precisa rodar na mesma máquina.
- **Mistura nos logs** de canal `web` entre painel, PowerPoint e voz — separável pelo prefixo do `sessionId`, mas não pelo
  campo `channel`.

### Hipóteses não comprovadas

- Que o polling cumpre a latência (C2).
- Que o complemento falado durante um objetivo é entendido como tal (ADR-029) com a pontuação de uma transcrição.
- Que a transcrição do Pipecat em pt-BR é boa o bastante para o roteador do NewClaw (hoje ela alimenta um LLM do lab, que
  perdoa mais).

## Fase 5 — Validação

- **Evidência real ou hipótese?** A arquitetura proposta é toda sobre código existente e citado. Os números de latência
  ainda são hipótese e viram critério medido.
- **Estrutural ou sintoma?** Estrutural: a voz entra como mais um cliente do canal, sem segundo cérebro.
- **Reduz a complexidade?** Sim, em relação à ideia (A) e à hipótese de partida (C): zero componente novo no NewClaw; no
  Pipecat, um estágio (o LLM) é **trocado**, não somado.
- **Elimina múltiplas fontes de verdade?** Sim: uma memória, uma fila, um roteador, um juiz. A única duplicação que sobra é
  o STT (D2).
- **Mantém a filosofia do Cognitive Kernel?** Sim — canal é porta; o Core não fica sabendo que a voz existe.
- **Incremental?** Sim (plano abaixo).
- **Reversível?** Sim: desligar o Pipecat (ou revogar o token) desfaz tudo; o NewClaw não muda no incremento 1.

## Plano incremental

0. **Decisões dela** (abaixo) e **linha de base sem cota**: tempo do turno de conversa simples no canal web, tirado dos logs
   que já existem nas produções (só leitura de log, nenhuma chamada de modelo).
1. **Pipecat como cliente** (repositório do lab, não este): estágio LLM trocado pelo processador "NewClaw"; som de aceito
   no `202`; consulta de progresso e outbox; limpeza de markdown/emoji antes do Kokoro; `sessionId` com prefixo próprio;
   log de auditoria do lado do Pipecat com `turnId` e os tempos (fim da fala → `202` → primeiro progresso → resposta →
   início da fala). **Nenhum arquivo do NewClaw muda.** Validação em ambiente real (diretriz, etapa 4) numa instância
   isolada do NewClaw, com o modelo que ela escolher e só com o OK dela para a cota.
2. **Condicional, só se a medição pedir:** push em vez de polling (primeiro estendendo a rota de chat, depois — só com nova
   passada do gate — adapter próprio); `ChannelType 'voice'` se a mistura nos logs atrapalhar.
3. **Condicionais, cada um com ADR própria:** identidade única entre canais (D5), resposta falável (D4), cancelar por voz
   se a escolha de D3 exigir código, STT único (D2-S2).

## Critérios de sucesso

- **C1 — Reconhecimento:** som de aceito em até 1 s após o fim da fala, em 100% dos turnos aceitos (medido no log do
  Pipecat).
- **C2 — Resposta:** o acréscimo de latência do caminho de voz (polling + limpeza + início do TTS) sobre o tempo do turno
  no NewClaw fica abaixo de um valor que **ela** define depois da linha de base.
- **C3 — Nada se perde:** todo turno aceito termina em resposta falada, em relato de progresso falado ou em erro falado;
  zero turnos sem retorno (conferido cruzando `turnId` do Pipecat com o outbox).
- **C4 — Uma memória:** a conversa por voz aparece no painel (mesmo `sessionId`); um fato dito por voz é encontrado depois
  pelo Telegram via memória de longo prazo.
- **C5 — Nenhum modelo escolhido pelo código** do NewClaw ou do processador do Pipecat; sem modelo declarado, o NewClaw
  responde como hoje (ausência reportada), nunca escolhe.
- **C6 — Zero arquivo novo no NewClaw** no incremento 1 (`git diff` vazio no repositório).

## Decisões que ficam com a operadora

- **D1 — Onde o Pipecat roda e qual NewClaw ele usa:** Windows (`C:\Users\lucia\NewClaw`) ou VPS (`~/newclaw`), na mesma
  máquina ou pela rede. Pela rede exige auth do painel ligada e um token para o Pipecat. **Não sei onde o Pipecat do lab
  roda hoje** — preciso que ela diga.
- **D2 — STT:** S1 (Pipecat transcreve e manda texto) ou S2 (manda áudio; o Core transcreve, idealmente com
  `WHISPER_API_URL` no mesmo servidor whisper do lab).
- **D3 — Cancelar por voz:** botão/tecla no dispositivo que envia `/cancelar` (controle de interface, como o botão de
  aprovação); ou dizer "barra cancelar" literalmente; ou deixar "pare" ir como complemento e o Core entender (não verificado
  que funcione); ou sem cancelamento por voz no incremento 1.
- **D4 — Resposta longa:** falar tudo; falar e avisar que o texto completo está no painel; ou abrir ADR para "resposta
  falável" pedida ao Core.
- **D5 — Identidade entre canais:** aceitar que a voz é uma conversa à parte (memória de longo prazo compartilhada) ou abrir
  ADR para unificar a conversa por pessoa entre canais.
- **D6 — Frequência do progresso:** manter `RELATO_DE_PROGRESSO_MIN` (5 min, global) ou mudar o valor (vale para todos os
  canais).
- **D7 — Som de aceito e voz do Kokoro:** quais ela quer — o código não escolhe voz (`KOKORO_TTS_VOICE` vazio = o servidor
  decide).
- **D8 — Modelo de conversa:** se a latência medida não agradar, qual modelo ela declara para o perfil de conversa. Nenhum é
  sugerido aqui.
