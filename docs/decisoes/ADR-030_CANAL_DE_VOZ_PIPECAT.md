# ADR-030 — Voz para o NewClaw pelo Pipecat do lab: o Jarvis é boca e ouvido, o cérebro é um só

Data: 28/10/2026. Status: **proposta** — só documento, nada implementado. Aguarda as decisões da operadora (seção
"Decisões que ficam com a operadora"). Entradas, tratadas como hipótese a criticar, não como decisão:

- `Idéias/Assistente voz newclaw.md` (conversa com o Thorial, 27/10/2026);
- `D:\IA\Projetos\jarvis-kit` (`JARVIS_BRIEFING.md`, preparado pelo Thorial em 28/10/2026), com o bot de voz que roda hoje
  em `https://10.0.0.5:8443/client/`.

O que ela quer, nas palavras dela: manter o chat normal como está e ter uma **janela separada** para conversar por voz, com
visual de Jarvis. O esboço de tela que ela mostrou é só referência de estilo — os quadros de infraestrutura dele não fazem
parte do escopo.

## Fase 1 — Compreensão

### O sistema de voz que já existe (jarvis-kit)

```text
Navegador (https://10.0.0.5:8443/client/)            ← cliente pronto do pacote pipecat_ai_prebuilt
   │ HTTPS + WebRTC (SmallWebRTC)
tls_proxy.py :8443 → bot.py :7860  (Pipecat, no Marte 10.0.0.5, units systemd pipecat-bot / pipecat-tls)
   │
   ├─ VAD: Silero (fim da fala, interrupção)
   ├─ STT: whisper-proxy  http://127.0.0.1:8200/v1  — API OpenAI /v1/audio/transcriptions (Whisper GPU no Sol)
   ├─ LLM: Ollama         http://127.0.0.1:11434/v1  — modelo de OLLAMA_MODEL, prompt de sistema "Você é a IAL…"
   ├─ TTS: Kokoro         http://10.0.0.1:8199/v1    — voz de KOKORO_VOICE (subclasse KokoroTTS tira o cabeçalho WAV)
   │
Navegador fala a resposta
```

O kit traz também `client-templates/react-vite` (o template de cliente que o briefing recomenda para o reskin) e
`client-current-dist/` (a página servida hoje, do pacote pip — não editável, um upgrade sobrescreve).

O plano do briefing tem três passos: (1) reskin do cliente como "Jarvis"; (2) manter o fluxo de voz; (3) trocar o LLM direto
por um "proxy LLM" que chama a API do NewClaw, com uma "camada de conversa na frente" (persona Jarvis, resposta rápida) e
uma variável `CANAL_DE_VOZ_PIPECAT=https://10.0.0.5:8443` no `.env` do NewClaw.

### O que o NewClaw já tem (conferido em `origin/main`, ab0f583)

| Necessidade | O que já existe | Onde |
|---|---|---|
| Camada de conversa + fila (Fase 1 da ideia) | Fila serial por conversa, ACK de fila ocupada, complemento a objetivo em andamento, objetivos longos em segundo plano | `MessageBus.processMessage` (`ConversationQueueManager`, `trySupplementActiveGoal`), `GoalOrchestrator` |
| Status visível | Relato de progresso determinístico (sem modelo, sem cota) a cada `RELATO_DE_PROGRESSO_MIN` (padrão 5 min), para objetivo e turno de conversa longo | ADR-027; `NormalizedResponse.progresso`; `AgentController.ts:345-352` |
| UI web (Fase 2 da ideia) | Painel com chat assíncrono: `POST /api/chat` → `202 {turnId}`; resposta em `GET /api/chat/outbox?turnId=`; progresso em `GET /api/chat/active?sessionId=&turnId=` | `dashboard/routes/chat.ts:93-340`, `WebChannelAdapter` |
| Cliente externo do canal web | O suplemento do PowerPoint fala com `POST /api/chat` por **Bearer** e marca a origem pelo prefixo do `sessionId` (`powerpoint-addin-` → `metadata.hostApp`) | `chat.ts:272-285`; `security.ts:163-166` (Bearer isento da checagem CSRF); `auth.ts:238-244` |
| Resposta guardada mesmo sem ninguém esperando | A resposta final é gravada na conversa (`recordAssistantMessage`) e, sem requisição viva, vai para a fila de entregas órfãs do canal web | `MessageBus.ts:593, 632`; `WebChannelAdapter` (nota de classe) |
| Transcrição | `transcribeAttachment`: áudio por `fileId`/`url`/`data`; servidor whisper em `WHISPER_API_URL` com rota **`/inference`** (formato whisper.cpp), ou `whisper` local com `--language pt` | `core/agentMediaHandlers.ts:150-290` |
| Kokoro | `send_audio` já fala com servidor TTS compatível com a API OpenAI (`KOKORO_TTS_URL`, `KOKORO_TTS_VOICE`, S311), sem padrão | `tools/send_audio.ts:194, 351-371` |
| Cancelar | `/cancelar`, `/cancel`, `/stop`, `/pare` — comando prioritário, fura a fila | `agentControllerCommands.ts:25-38`; `MessageBus.ts:374-388` |
| Modelo por perfil | `MODEL_CHAT`, `MODEL_LIGHT`, … e `PROVIDER_*`, declarados pela operadora; o código não escolhe modelo (issue 068) | `.env.example:90-104` |
| Chat com voz do navegador | O chat do painel já tem ditado (Web Speech API) e leitura em voz alta (`speechSynthesis`) | `dashboard/public/index.html:538-620` |

Conclusão: **as Fases 1 e 2 do MVP da ideia já estão feitas no NewClaw, e a voz já está feita no lab.** Falta só ligar uma
coisa na outra.

### Correção de uma afirmação da ideia

A ideia diz que *"o frontend do NewClaw já existe em embrião — AgentController.js e AuditorService.js já estão
compilados"*. **Não é verdade.** Os `.js` são só a compilação de arquivos do Core:

- `src/core/AgentController.ts` é a **fachada do Core**: liga adapters, `MessageBus`, `AgentLoop`, `WorkflowEngine`,
  ferramentas e media handlers (`ARCHITECTURE.md`, "Componentes do Core").
- `src/services/auditor/AuditorService.ts` é o **autodiagnóstico interno** (`/audit`, só a dona). Não conversa com o
  usuário.

Os frontends do NewClaw são os canais (`src/channels/*Adapter.ts`) e o painel (`src/dashboard/`). O frontend de voz é o
cliente do jarvis-kit.

### Tentativas anteriores e decisões relacionadas

- Nenhuma tentativa anterior de voz em tempo real no repositório. Voz hoje é nota de voz (`transcribeAttachment`), áudio de
  saída (`send_audio`) e o ditado do chat do painel.
- `ARCHITECTURE.md` — "Como adicionar um canal novo" e "Dependências proibidas": canal é porta, não pensa.
- `RFC-008` — cliente externo identificado pelo prefixo do `sessionId`.
- `ADR-027` (progresso), `ADR-029` (o pedido é entendido pela conversa — o complemento falado passa por aí).
- `SOBERANIA_DA_CONFIGURACAO.md`, `NUNCA_ADIVINHAR.md` — nada de modelo, voz ou endereço escolhido pelo código.

## Fase 2 — Crítica da hipótese

Hipótese de partida: *"o Pipecat entra como um `ChannelAdapter` novo (só STT/TTS, sem LLM nem memória próprios), e com isso
memória única e relato de progresso já vêm do Core"*. Hipóteses do briefing: *"camada de conversa na frente (persona Jarvis,
resposta rápida)"* e *"`CANAL_DE_VOZ_PIPECAT` no `.env` do NewClaw"*.

### O que se sustenta

- **Sem LLM nem memória no Pipecat.** Se o Jarvis tiver LLM próprio conversando na frente, há dois cérebros com duas
  memórias — o "cadê meu pedido?" que a própria ideia quer evitar. O estágio `llm` do `bot.py` sai; no lugar entra a chamada
  ao NewClaw.
- **Memória de longo prazo já é única.** O grafo não é particionado por canal nem por usuário (`MemoryGraphRepository.ts`,
  `graphRepository.ts` sem `user_id`/canal).
- **Progresso já vem do Core**, por `GET /api/chat/active`.
- **Janela separada, chat normal intocado.** O cliente do Jarvis é outro programa, servido pelo Marte; o painel do NewClaw
  não muda.

### O que cai

1. **"ChannelAdapter novo" não passa no gate "Extensão antes de Criação".** O `WebChannelAdapter` já atende clientes
   externos por HTTP com fluxo assíncrono, progresso, entregas órfãs e Bearer — e já tem um segundo cliente (PowerPoint).
   Um `VoiceChannelAdapter` hoje seria tipo de canal, rota e outbox novos sem evidência de necessidade.
2. **"Camada de conversa na frente" (briefing, item 2; ideia, cuidado c) contradiz três regras.** (a) Decidir quando
   "escalar" para o fundo seria um roteador semântico na frente do que já existe (`UnifiedIntentRouter`/`GoalExtractor`) —
   duas autoridades para a mesma decisão (`RESPONSABILIDADE_ANTES_DO_MECANISMO`, regra de custo). (b) Responderia "o
   trivial" com outra memória. (c) Exige nomear um modelo — hoje o `bot.py` já traz um modelo como padrão
   (`OLLAMA_MODEL` com valor embutido), o que no lado do NewClaw seria proibido. Tirar o estágio LLM resolve as três de
   uma vez. Se a conversa ficar lenta, o caminho é ela declarar o modelo do perfil de conversa no NewClaw.
3. **"Memória única" é só meia verdade.** Histórico e objetivo ativo são chaveados por `canal:usuário`
   (`SessionKeyFactory.ts:28`). A conversa do Jarvis é outra conversa que a do Telegram; "como está aquele pedido?" sobre
   um objetivo do Telegram depende da memória de longo prazo achar o assunto (decisão D5).
4. **O `LLMContext` do Pipecat não pode virar memória.** No `bot.py`, os agregadores acumulam a conversa inteira e a mandam
   ao LLM a cada turno. Ligado ao NewClaw, o processador manda **só a fala nova**; o histórico é do NewClaw. Mandar o
   contexto inteiro duplicaria a conversa no prompt e criaria uma segunda fonte de verdade.
5. **`CANAL_DE_VOZ_PIPECAT` no `.env` do NewClaw não serve ao fluxo.** Quem chama é o Pipecat → NewClaw, nunca o contrário;
   o Core não precisa saber onde a voz está. A variável só teria uso para um **botão no painel** que abre a janela do
   Jarvis — um link de interface, opcional (decisão D9).
6. **"Reconhecimento imediato" não é frase gerada.** Voz espera retorno em 1–2 s; um turno do NewClaw leva de segundos a
   minutos (692 s no caso medido em `RESPONSABILIDADE_ANTES_DO_MECANISMO`). O fato disponível é **"turno aceito"** (`202`
   com `turnId`); a janela o mostra como estado visual "pensando" (e, se ela quiser, um som). Nada a gerar, nenhum modelo,
   nenhum idioma.

### Casos extremos

- **Barge-in**, três níveis:
  1. Interromper a fala quando a pessoa volta a falar — nativo do Pipecat (Silero VAD), não toca o NewClaw.
  2. Falar de novo enquanto o NewClaw trabalha — já tratado: complemento do objetivo ativo ou fila com ACK.
  3. **Cancelar por voz** — aberto. Os comandos prioritários exigem `/` (`MessageBus.ts:375`); mapear "pare" falado para
     comando no Pipecat seria lista de palavras interpretando linguagem natural — proibido. A janela resolve sem
     interpretar: um **botão "Parar"** que manda `/cancelar` (controle de interface, como o botão de aprovação). Decisão D3.
- **Janela fechada no meio do trabalho.** `on_client_disconnected` cancela o pipeline do Pipecat, mas o turno no NewClaw
  continua; a resposta fica gravada na conversa (visível no painel) e na fila de órfãs do `sessionId`. O que o Jarvis faz
  ao reabrir (falar o que chegou, mostrar, ou nada) é decisão D10.
- **Textos fixos do Core falados** ("🧠 Estou concluindo…", "📎 Anotado…"): emoji e markdown saem antes do TTS (tradução
  de formato, princípio 7); o idioma fixo em pt-BR é o gap já conhecido.
- **Resposta longa** falada (decisão D4). Anexos de saída não são falados: ficam na conversa, no painel.
- **Limite de taxa**: 10 `POST /api/chat` por minuto por IP (`chat.ts:17-18`). O bot não pode reenviar em laço.
- **Progresso a cada 5 min** é longo para quem está esperando de pé; o valor é global (decisão D6).
- **Rede**: o bot roda no Marte (10.0.0.5) e o NewClaw de produção na Venus (10.0.0.10). Para o bot alcançar a API, o painel
  da Venus precisa escutar na rede (`DASHBOARD_HOST`), o que **obriga** `DASHBOARD_PASSWORD` (o painel se recusa a subir
  exposto sem senha, `isUnsafeExposedBoot`, `DashboardServer.ts:186`). O token Bearer sai do login do painel e não expira
  sozinho (`auth.ts:202-225`): revogar exige trocar o segredo. Decisão D1.

### Risco de God Object

Nenhum: nada entra no Core. Haveria risco se o Jarvis ganhasse persona e LLM próprios — aí ele seria um segundo `AgentLoop`
fora do repositório.

## Fase 3 — Pesquisa de alternativas

Padrão que se aplica: **cliente fino** sobre serviço com fila e entrega assíncrona (request-acknowledge-poll: `202 Accepted`
+ recurso de status). É o que o painel já faz.

### Como o Pipecat fala com o NewClaw

| # | Alternativa | Vantagens | Desvantagens |
|---|---|---|---|
| A | **Briefing como está**: LLM do Pipecat na frente (persona Jarvis), escalando ao NewClaw | Latência baixa no trivial | Dois cérebros e duas memórias; roteador semântico duplicado; modelo escolhido no código do bot |
| B | **Processador "NewClaw" no lugar do estágio `llm` do `bot.py`**, cliente HTTP do canal web existente (como o PowerPoint) | **Zero arquivo novo no NewClaw** no incremento 1; reusa fila, outbox, progresso, entregas órfãs, Bearer e conversa persistida no painel; reversível trocando de volta o estágio | Canal aparece como `web` (separável pelo prefixo do `sessionId`); latência de polling; limite de taxa do chat |
| B′ | NewClaw expõe uma rota **compatível com OpenAI** (`/v1/chat/completions`) e o `bot.py` só troca o `base_url` | Quase nenhuma linha no bot | Rota nova no NewClaw; o protocolo é síncrono e manda o histórico inteiro a cada turno (contradiz o item 4 da Fase 2); não tem lugar para progresso nem para "aceito" |
| C | **`VoiceChannelAdapter` novo** no NewClaw (`ChannelType 'voice'`), com WebSocket/SSE | Push; identidade própria nos logs | Tipo de canal, rota e outbox novos sem evidência medida; falha no gate hoje |
| D | Bot conversando com o NewClaw pelo Telegram | Nenhum código | Gambiarra: identidade de bot, ACL, latência da API do Telegram |

### Onde transcrever

| Opção | Vantagens | Desvantagens |
|---|---|---|
| S1. O Pipecat transcreve (como já faz) e manda **texto** | O pipeline do lab não muda; VAD e STT já afinados; sem upload nem ffmpeg | Duas configurações de STT (a do lab e a do Core); o fato "veio de voz" só chega se for em metadado |
| S2. O Pipecat manda o **áudio** do trecho; o Core transcreve | Uma transcrição só, a mesma das notas de voz | **Não funciona com o servidor do lab sem mudar o Core**: o whisper-proxy fala `/v1/audio/transcriptions` (API OpenAI) e o Core só fala `/inference` (whisper.cpp) ou o `whisper` local com `--language pt` embutido |

Com essa evidência, **S1** é a recomendada; S2 só faria sentido numa ADR que levasse o Core a falar a API OpenAI de
transcrição (ganho: um só servidor de STT para todos os canais).

### A janela

| Opção | Vantagens | Desvantagens |
|---|---|---|
| J1. **Reskin do cliente do jarvis-kit** (`client-templates/react-vite`), servido pelo Marte | É o que o briefing prevê; WebRTC e eventos de estado (ouvindo / pensando / falando) já vêm do cliente Pipecat; o painel não muda | Mais um endereço para abrir (resolvível com o botão de D9) |
| J2. Janela nova dentro do painel do NewClaw, ligada ao Pipecat por WebRTC | Um endereço só | Traz dependência de WebRTC/Pipecat para dentro do repositório do NewClaw; mistura o painel com o lab |
| J3. Janela no painel com a voz do navegador (o ditado e o `speechSynthesis` que o chat já tem) | Nenhum serviço extra | No Chrome, o ditado manda o áudio para servidores do Google, e a voz é a do sistema — contradiz "tudo local" do lab |

**J1** é a recomendada.

### Gate obrigatório — Extensão antes de Criação

Arquivos novos no **NewClaw**, um por um:

1. **`src/channels/VoiceChannelAdapter.ts`** — (1) precisa existir? **NÃO**, agora. (2) Já existe:
   `src/channels/WebChannelAdapter.ts` + `src/dashboard/routes/chat.ts`. (3) Nenhuma extensão é necessária — a origem é
   marcada pelo prefixo do `sessionId`, como em `chat.ts:274`. (4) Só volta a ser candidato se a medição do incremento 1
   reprovar o polling (C2), e aí a primeira tentativa é estender a rota de chat (SSE no mesmo `turnId`).
2. **Rota compatível com OpenAI (B′)** — **NÃO**: protocolo errado para turnos longos (Fase 3, tabela).
3. **Tool/Skill/Script de voz** — **NÃO**: no Jarvis quem fala é o Pipecat; `send_audio` segue servindo os outros canais.
4. **Página de voz no painel (J2/J3)** — **NÃO**: a janela é o cliente do jarvis-kit.

Sobram **zero** arquivos novos no NewClaw no incremento 1. O código novo fica no jarvis-kit: o processador "NewClaw" no
`bot.py` e o reskin do cliente.

## Fase 4 — Síntese

### Recomendação

**B + S1 + J1.** O Jarvis (cliente do jarvis-kit + `bot.py`) é boca e ouvido; o NewClaw é o único cérebro.

```text
Janela Jarvis (navegador)  ⇄ WebRTC ⇄  bot.py no Marte
                                         │ Silero VAD → STT (whisper-proxy do lab)
                                         │
                                         ▼ processador "NewClaw" (no lugar do estágio llm)
                     POST /api/chat {message: <só a fala nova>, sessionId: "jarvis-<dispositivo>"}   (Bearer)
                                         │
                                         ├─ 202 {turnId} ─────────────▶ janela: estado "pensando" (+ som, se ela quiser)
                     GET /api/chat/active?sessionId&turnId ──────────▶ progresso novo → falado e mostrado
                     GET /api/chat/outbox?turnId ────────────────────▶ resposta final
                                         │
                                         ▼ remove markdown/emoji → Kokoro (TTS do lab) → janela fala
```

Por que esta:

- **Hipótese de partida, parte derrubada:** "um `ChannelAdapter` novo" — o adapter certo já existe.
- **Parte confirmada:** "só STT/TTS, sem LLM nem memória" — memória, fila, complemento, cancelamento, progresso e entrega
  tardia vêm do Core sem uma linha nova.
- **Do briefing, ficam:** o reskin (passo 1) e o fluxo de voz (passo 2). **Muda:** o passo 3 deixa de ter "camada de
  conversa na frente" — o processador só repassa. **Sai:** `CANAL_DE_VOZ_PIPECAT` como configuração do Core (só como link
  de botão, se ela quiser).
- O estado "pensando" sinaliza um fato estrutural (turno aceito), sem interpretar nada.

### Riscos que ficam

- **Latência de resposta simples** depende do modelo que ela declarou para conversa e do caminho do turno (roteador, juiz de
  suficiência). **Não medida** — primeiro número a coletar (C2). Se ficar ruim, a resposta é configuração dela ou uma ADR
  sobre o caminho do turno de conversa, nunca um LLM na frente.
- **Conversa separada da do Telegram** (D5); **cancelar** (D3); **resposta longa** (D4).
- **Exposição do painel da Venus na rede**, com token que não expira sozinho (D1).
- **Textos fixos do Core** falados sempre em pt-BR (gap conhecido).
- **Mistura nos logs** do canal `web` (painel, PowerPoint, Jarvis) — separável pelo prefixo do `sessionId`.
- **Marte não é produção.** O bot roda lá; o NewClaw que ele chama é decisão dela (D1).

### Hipóteses não comprovadas

- Que o polling cumpre a latência (C2).
- Que o complemento falado durante um objetivo é entendido como tal (ADR-029) com a pontuação de uma transcrição.
- Que a transcrição do lab em pt-BR é boa o bastante para o roteador do NewClaw (hoje ela alimenta um LLM que perdoa mais).

## Fase 5 — Validação

- **Evidência real ou hipótese?** A arquitetura é toda sobre código existente e citado (NewClaw e jarvis-kit). Os números de
  latência ainda são hipótese e viram critério medido.
- **Estrutural ou sintoma?** Estrutural: a voz entra como mais um cliente do canal, sem segundo cérebro.
- **Reduz a complexidade?** Sim: zero componente novo no NewClaw; no bot, um estágio (o LLM) é **trocado**, não somado.
- **Elimina múltiplas fontes de verdade?** Sim: uma memória, uma fila, um roteador. Sobram duas configurações de STT (S1).
- **Mantém a filosofia do Cognitive Kernel?** Sim — canal é porta; o Core não fica sabendo que a voz existe.
- **Incremental?** Sim (plano abaixo).
- **Reversível?** Sim: voltar o estágio `llm` no `bot.py` (ou revogar o token) desfaz tudo; o NewClaw não muda.

## Plano incremental

0. **Decisões dela** (abaixo) e **linha de base sem cota**: tempo do turno de conversa simples no canal web, tirado dos logs
   que já existem (só leitura de log, nenhuma chamada de modelo).
1. **Reskin do cliente** (jarvis-kit, J1) com o `bot.py` como está — não depende do NewClaw e pode andar em paralelo.
2. **Processador "NewClaw"** no `bot.py` (jarvis-kit): manda só a fala nova, mostra "pensando" no `202`, fala os relatos de
   progresso novos e a resposta final, limpa markdown/emoji antes do Kokoro, botão "Parar" → `/cancelar`. Log de auditoria
   do lado do bot com `turnId` e os tempos (fim da fala → `202` → primeiro progresso → resposta → início da fala).
   **Nenhum arquivo do NewClaw muda.** Validação em ambiente real (diretriz, etapa 4) contra uma instância isolada do
   NewClaw, com o modelo que ela escolher e só com o OK dela para a cota.
3. **Condicional, só se a medição pedir:** push em vez de polling (primeiro estendendo a rota de chat; adapter próprio só
   com nova passada do gate); `ChannelType 'voice'` se a mistura nos logs atrapalhar.
4. **Condicionais, cada um com ADR própria:** identidade única entre canais (D5), resposta falável (D4), STT único (S2).

## Critérios de sucesso

- **C1 — Reconhecimento:** estado "pensando" na janela em até 1 s após o fim da fala, em 100% dos turnos aceitos (log do
  bot).
- **C2 — Resposta:** o acréscimo de latência do caminho de voz (polling + limpeza + início do TTS) sobre o tempo do turno no
  NewClaw fica abaixo de um valor que **ela** define depois da linha de base.
- **C3 — Nada se perde:** todo turno aceito termina em resposta, relato de progresso ou erro, falado ou guardado na conversa;
  zero turnos sem retorno (cruzando `turnId` do bot com o outbox e a conversa).
- **C4 — Uma memória:** a conversa do Jarvis aparece no painel (mesmo `sessionId`); um fato dito por voz é encontrado depois
  pelo Telegram via memória de longo prazo.
- **C5 — Nenhum modelo escolhido pelo código** do NewClaw nem do processador "NewClaw"; o estágio LLM e seu modelo padrão
  saem do caminho do Jarvis.
- **C6 — Zero arquivo novo no NewClaw** nos incrementos 1 e 2 (`git diff` vazio no repositório).
- **C7 — Chat normal intocado:** o painel e os outros canais se comportam igual antes e depois (suíte de regressão).

## Decisões que ficam com a operadora

- **D1 — Qual NewClaw o Jarvis usa e como alcança:** o bot roda no Marte (10.0.0.5); o NewClaw de produção na Venus
  (10.0.0.10) ou no Windows. Chamar pela rede exige `DASHBOARD_HOST` na rede + `DASHBOARD_PASSWORD` e um token Bearer para o
  bot (que não expira sozinho). Para a validação, a diretriz pede instância isolada.
- **D2 — STT:** S1 (recomendada pela evidência) ou abrir ADR para S2.
- **D3 — Cancelar:** botão "Parar" na janela (recomendado); ou sem cancelamento no piloto.
- **D4 — Resposta longa:** falar tudo; falar o começo e mostrar o resto na janela; ou ADR para "resposta falável".
- **D5 — Identidade entre canais:** Jarvis como conversa à parte (memória de longo prazo compartilhada) ou ADR para unificar
  a conversa por pessoa.
- **D6 — Frequência do progresso:** manter `RELATO_DE_PROGRESSO_MIN` (5 min, global) ou mudar (vale para todos os canais).
- **D7 — Som de "aceito" e voz:** se quer som além do estado visual, e qual voz (`KOKORO_VOICE` do lab é dela).
- **D8 — Modelo de conversa:** se a latência medida não agradar, qual modelo ela declara no perfil de conversa. Nenhum é
  sugerido aqui.
- **D9 — Botão no painel:** se o chat normal ganha um link "Jarvis" que abre a janela (aí `CANAL_DE_VOZ_PIPECAT` entra só
  como endereço desse link).
- **D10 — Reabrir a janela:** o que o Jarvis faz com respostas que chegaram enquanto estava fechado (falar, mostrar ou nada).
