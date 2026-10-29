# ADR-030 — Jarvis: voz para o NewClaw pelo Pipecat do lab (boca e ouvido; o cérebro é um só)

Data: 28/10/2026. Status: **proposta, em planejamento** — nada implementado, nada publicado. Aguarda as decisões da
operadora (matriz D1–D11). Entradas tratadas como hipótese, não como decisão: `Idéias/Assistente voz newclaw.md`
(conversa com o Thorial, 27/10), `D:\IA\Projetos\jarvis-kit` (`JARVIS_BRIEFING.md`, 28/10) e o bot que roda hoje em
`https://10.0.0.5:8443/client/`.

O pedido dela: manter o chat normal do painel como está e ter uma **janela separada** para conversar por voz, com visual de
Jarvis (o esboço de tela é só referência de estilo; quadros de infraestrutura estão fora do escopo).

## Resumo — o que está comprovado, o que falta medir, o que é dela

| | Itens |
|---|---|
| **Comprovado no código** (NewClaw `origin/main` ab0f583; jarvis-kit) | Envio assíncrono (`POST /api/chat` → `202 {turnId}`), resposta por outbox, progresso por `/api/chat/active`, cancelamento por `/cancelar`, continuidade pelo `sessionId`, conversa gravada e legível por `/api/conversations/:id/messages`, autenticação Bearer, limites de taxa. No kit: STT pelo whisper-proxy (API OpenAI), TTS Kokoro, VAD Silero, bot em `0.0.0.0:7860` |
| **Comprovado no ambiente** (leitura, 28/10) | Pipecat **1.12.0** no Marte, com `UserStarted/StoppedSpeakingFrame`, `BotStarted/StoppedSpeakingFrame`, `InterruptionFrame`, `TranscriptionFrame` e `RTVIServerMessageFrame`. Painel da Venus em `0.0.0.0:3090` com senha definida, **HTTP sem TLS**. `RELATO_DE_PROGRESSO_MIN` vazio na Venus (vale o padrão, 5 min) |
| **Medido** (logs existentes) | Duração do turno no NewClaw (`processing_done`) e tempos do STT/TTS do bot — ver "Linha de base" |
| **Hipótese, a medir** | Latência do caminho de voz completo; tempo até a aceitação; tempo até o primeiro progresso no canal web; comportamento do turno cancelado; leitura correta do outbox em fila ocupada; servir o cliente próprio pelo runner do Pipecat |
| **Depende dela** | D1–D11 (matriz abaixo), OK de cota para os testes com modelo, e qualquer ligação com produção |

## Fase 1 — Compreensão

### Sistema de voz que já existe (jarvis-kit)

```text
Navegador (https://10.0.0.5:8443/client/)        ← cliente pronto do pacote pipecat_ai_prebuilt (não editável)
   │ HTTPS + WebRTC (SmallWebRTC)
tls_proxy.py :8443 (repasse TCP com TLS) → bot.py :7860 (Pipecat 1.12.0, Marte, systemd pipecat-bot / pipecat-tls)
   ├─ VAD Silero (fim da fala, interrupção)
   ├─ STT  whisper-proxy http://127.0.0.1:8200/v1  — POST /v1/audio/transcriptions (API OpenAI), Language.PT
   ├─ LLM  Ollama        http://127.0.0.1:11434/v1  — OLLAMA_MODEL (o bot traz um modelo como valor padrão)
   └─ TTS  Kokoro        http://10.0.0.1:8199/v1    — KOKORO_VOICE; KokoroTTS remove o cabeçalho WAV
```

O briefing propõe: (1) reskin a partir de `client-templates/react-vite`; (2) manter o fluxo de voz; (3) trocar o LLM direto
por um "proxy LLM" que chama o NewClaw, com uma "camada de conversa na frente" (persona Jarvis) e uma variável
`CANAL_DE_VOZ_PIPECAT` no `.env` do NewClaw.

### Contrato real da API de chat do NewClaw (entrega 1)

Legenda: **C** = comprovado no código; **C+P** = comprovado no código e conferido em produção (só leitura); **H** = hipótese.

| Capacidade | Como funciona | Evidência | Status |
|---|---|---|---|
| Autenticação | `POST /api/auth/login {password}` → `{token}` (HMAC com `DASHBOARD_PASSWORD`). Depois, `Authorization: Bearer <token>` em toda chamada. Bearer é isento da checagem CSRF | `auth.ts:202-225, 238-283`; `security.ts:163-166` | C |
| Validade do token | Não expira; sobrevive a reinício (assinatura). `logout` só apaga o cookie. **Revogar = trocar `DASHBOARD_PASSWORD`**, o que derruba todos os tokens, inclusive o do painel. Escopo: a API inteira do painel | `auth.ts:197-225, 285-288` | C |
| Exposição | Painel da Venus em `0.0.0.0:3090`, senha definida, HTTP puro. Sem senha, o painel se recusa a subir fora de localhost | `DashboardServer.ts:180-195`; `.env` da Venus | C+P |
| Identificação de sessão | `sessionId` no corpo vira `userId` e `chatId`; a chave da sessão é `web:<sessionId>`. O mesmo `sessionId` = a mesma conversa (histórico, objetivo ativo, fila) | `chat.ts:256, 288-297`; `SessionKeyFactory.ts:28` | C |
| Origem do cliente | Prefixo do `sessionId` (precedente: `powerpoint-addin-` → `metadata.hostApp`) | `chat.ts:272-285` | C |
| Enviar mensagem | `POST /api/chat` multipart (`message`, `sessionId`, anexos opcionais) → `202 {success, turnId, sessionId}`; o processamento segue em segundo plano | `chat.ts:230-316` | C |
| Resposta | `GET /api/chat/outbox?turnId=` → `200 {response, options, attachments}` uma vez (a leitura consome); `404` = ainda não pronta | `chat.ts:322-350`; `WebChannelAdapter.ts:123-133` | C |
| Ainda trabalhando? | `GET /api/chat/active?sessionId=&turnId=` → `{active[], pendingAuth[], pending, progresso?}`. `pending` cobre a janela entre o `202` e o turno existir; `active[].elapsedMs` = há quanto tempo | `chat.ts:93-182` | C |
| Tarefa longa | O turno espera o objetivo: `processing_done` chega a 3.729 s no Windows. Enquanto isso, `/active` mostra o turno/objetivo | `MessageBus.ts:598-610`; logs | C+P |
| Progresso | Último relato do ADR-027 em `progresso {texto, em}` no `/active`; some quando a resposta sai. Frequência: `RELATO_DE_PROGRESSO_MIN` (padrão 5 min, global) | `WebChannelAdapter.ts:111-119, 282-287`; ADR-027 | C (no canal web: **H**, não medido) |
| Cancelamento | `POST /api/chat` com `message=/cancelar` e o mesmo `sessionId`: fura a fila, cancela turno e objetivo; a confirmação sai no outbox do turno do cancelamento. É o que o painel faz | `agentControllerCommands.ts:25-38`; `MessageBus.ts:374-388`; `index.html:1373-1383` | C (o que o turno cancelado devolve: **H**) |
| Fala durante o trabalho | Texto comum com objetivo ativo vira complemento: o outbox do **turno novo** recebe "📎 Anotado…"; a resposta final sai no turno original | `MessageBus.ts:390-410` | C |
| Fila ocupada | O outbox do turno recebe primeiro o ACK ("🧠 Estou concluindo…") e, quando o turno roda, a resposta final é gravada **de novo no mesmo `turnId`** | `MessageBus.ts:449-458`; `WebChannelAdapter.ts:217-251` | C (leitura correta pelo cliente: **H**) |
| Entrega tardia | Resposta sem ninguém esperando fica no outbox; entregas sem turno (aviso de skill, anexo) viram órfãs e saem coladas na **próxima** resposta da sessão, com o prefixo "📎 Entrega pendente…" | `WebChannelAdapter.ts:249-251, 291-334` | C |
| Histórico gravado | Toda resposta final é gravada na conversa; `GET /api/conversations` lista (com `sessionId`), `GET /api/conversations/:id/messages` lê | `MessageBus.ts:632`; `conversations.ts:8-65` | C |
| Ação perigosa | Objetivo bloqueado aparece em `pendingAuth`; aprovação por `POST /api/chat/auth-decision` | `chat.ts:195-228`; ADR-005 | C |
| Limites de taxa | `POST /api/chat`: 10/min por IP. Geral: 120/min por IP. Login: 10 a cada 15 min | `chat.ts:17-18`; `security.ts:75-86` | C |
| Push | **Não existe para chat.** `/api/stream` (SSE) é de rastros de execução, global, sem `turnId` — não serve para entrega e mostraria outras conversas | `traces.ts:4-33` | C |
| Marca estrutural de ACK/complemento | **Não existe**: ACK, complemento e resposta final têm a mesma forma | `ChannelAdapter.ts` (`NormalizedResponse`) | C (limitação) |

### Linha de base (só logs existentes, sem cota)

**Duração do turno no NewClaw** — `processing_done` do `MessageBus` (da entrada no Core até a resposta, incluindo objetivo).
Extraído em 28/10 de `~/.pm2/logs/newclaw-out.log` + `~/newclaw/logs/newclaw.log` (Venus) e `C:\Users\lucia\.pm2\logs\newclaw-out.log`
(Windows).

| Produção / canal | Período | n | p50 | p90 | máx | ≤ 2 s | ≤ 10 s | > 60 s |
|---|---|---|---|---|---|---|---|---|
| Venus / web | 30 dias | 13 | 69,8 s | 112,6 s | 178 s | 0% | 7% | 53% |
| Venus / telegram | 30 dias | 72 | 75,3 s | 531,0 s | 2.133 s | 0% | 5% | 61% |
| Windows / web | 30 dias | 126 | 152,7 s | 1.820,2 s | 3.729 s | 3% | 12% | 65% |
| Windows / telegram | 30 dias | 26 | 663,4 s | 1.747,4 s | 2.400 s | 0% | 0% | 92% |
| Venus / todos os canais | desde 16/05 | 786 | — | — | — | 5–7% | 10–11% | 46–51% |

Limites dessa medida: (1) mistura conversa simples e objetivo — o log não diz qual foi; (2) o Windows inclui sessões de
teste; (3) não mede fila nem polling.

**Tempos do bot de voz** — `bot.log` do Marte (`enable_metrics=True`), uma única sessão com métricas (09/10/2026):

| Estágio | n | mínimo | máximo |
|---|---|---|---|
| STT (TTFB do `OpenAISTTService`) | 7 | 1,07 s | 2,10 s |
| TTS (TTFB do `KokoroTTS`) | 8 | 0,08 s | 1,15 s |
| LLM atual do bot (TTFB) | 10 | 0,07 s | 0,63 s |

**Conclusão:** a resposta da Alexa caseira é rápida porque o LLM dela responde em menos de 1 s. O NewClaw responde em
~1 minuto ou mais na mediana. Responder em 1–2 s **não é possível** trocando só a boca; o desenho precisa de reconhecimento
imediato + entrega depois, e a decisão de deixar o turno de conversa mais rápido é dela (D8), não de um LLM na frente.

### Correção de uma afirmação da ideia

`AgentController.js` e `AuditorService.js` **não são um "frontend em embrião"**: são a compilação de `src/core/AgentController.ts`
(fachada do Core: liga adapters, `MessageBus`, `AgentLoop`, `WorkflowEngine`) e de `src/services/auditor/AuditorService.ts`
(autodiagnóstico `/audit`, só a dona). Os frontends do NewClaw são os canais e o painel; o frontend de voz é o cliente do
jarvis-kit.

### Decisões relacionadas

`ARCHITECTURE.md` ("Como adicionar um canal novo", "Dependências proibidas"), RFC-008 (cliente externo por prefixo de
`sessionId`), ADR-005 (ação perigosa), ADR-027 (progresso), ADR-029 (pedido entendido pela conversa),
`SOBERANIA_DA_CONFIGURACAO.md`, `NUNCA_ADIVINHAR.md`. Nenhuma tentativa anterior de voz em tempo real no repositório.

## Fase 2 — Crítica da hipótese

Hipótese de partida: *o Pipecat entra como um `ChannelAdapter` novo, só STT/TTS, e memória e progresso vêm do Core.*

**Se sustenta:** sem LLM nem memória no Pipecat (senão são dois cérebros); memória de longo prazo já única (o grafo não tem
`user_id` nem canal); progresso já vem do Core; o chat do painel não precisa mudar.

**Cai:**

1. **`ChannelAdapter` novo** não passa no gate "Extensão antes de Criação": o `WebChannelAdapter` já atende clientes externos
   (PowerPoint) com tudo o que a voz precisa (tabela do contrato).
2. **"Camada de conversa na frente"** (briefing, item 2): roteador semântico duplicado (`UnifiedIntentRouter`/`GoalExtractor`),
   outra memória e um modelo escolhido no código. A linha de base mostra o motivo real da demora (o turno), que um LLM na
   frente só esconderia respondendo com outra memória.
3. **"Memória única" é só meia verdade:** histórico e objetivo são por `canal:usuário`; o Jarvis é outra conversa que a do
   Telegram (D5).
4. **O `LLMContext` do Pipecat não pode virar memória:** hoje ele acumula a conversa e a manda inteira a cada turno. Ligado ao
   NewClaw, só a fala nova sai do bot.
5. **`CANAL_DE_VOZ_PIPECAT` no `.env` do NewClaw não serve ao fluxo** (quem chama é o bot); só serviria a um botão no painel
   (D9).
6. **"Reconhecimento imediato" não é frase gerada:** o fato disponível é "turno aceito" (`202`), mostrado como estado.

**Casos extremos** (todos tratados mais abaixo): interrupção da fala × cancelamento do trabalho; fala durante o trabalho;
janela fechada; rede caindo; fila ocupada (ACK e final no mesmo `turnId`); entrega órfã colada na próxima resposta; ação
perigosa pendente; resposta longa; textos fixos do Core com emoji e sempre em pt-BR; limites de taxa.

**God Object:** nenhum — nada entra no Core.

## Fase 3 — Alternativas

| # | Como o Pipecat fala com o NewClaw | Vantagens | Desvantagens |
|---|---|---|---|
| A | LLM do Pipecat na frente, escalando ao NewClaw (briefing) | Latência baixa no trivial | Dois cérebros e duas memórias; roteador duplicado; modelo no código |
| **B** | **Processador "NewClaw" no lugar do estágio `llm`**, cliente HTTP do canal web (como o PowerPoint) | Zero arquivo novo no NewClaw; reusa fila, outbox, progresso, órfãs, Bearer, conversa no painel; reversível | Canal aparece como `web`; polling; limites de taxa |
| B′ | Rota compatível com OpenAI (`/v1/chat/completions`) no NewClaw | Bot quase sem mudança | Rota nova; protocolo síncrono que manda o histórico inteiro; sem lugar para progresso e "aceito" |
| C | `VoiceChannelAdapter` com WebSocket/SSE | Push; identidade própria | Tipo de canal, rota e outbox novos sem evidência medida |
| D | Bot falando com o NewClaw pelo Telegram | Nenhum código | Gambiarra de identidade e latência |

| Onde transcrever | Decisão |
|---|---|
| **S1 — no Pipecat, manda texto** | **Recomendada.** O whisper-proxy fala `/v1/audio/transcriptions`; o Core só fala `/inference` (whisper.cpp) ou o `whisper` local com `--language pt` (`agentMediaHandlers.ts:225-280`). Mandar áudio exigiria mudar o Core |
| S2 — áudio para o Core | Só com ADR própria que leve o Core à API OpenAI de transcrição |

| A janela | Decisão |
|---|---|
| **J1 — reskin do cliente do kit (`react-vite`), servido pelo Marte** | **Recomendada.** WebRTC e eventos de estado já vêm do cliente Pipecat; o painel não muda |
| J2 — página no painel ligada ao Pipecat | Traz WebRTC/Pipecat para o repositório do NewClaw |
| J3 — página no painel com a voz do navegador | O ditado do Chrome manda áudio ao Google; contradiz "tudo local" |

**Gate — Extensão antes de Criação (arquivos novos no NewClaw):** `VoiceChannelAdapter.ts` — NÃO (o `WebChannelAdapter`
serve; só volta a ser candidato se o polling reprovar M5/M6). Rota OpenAI (B′) — NÃO. Tool/Skill/Script de voz — NÃO. Página
de voz no painel — NÃO. **Sobram zero arquivos novos no NewClaw.** O código novo fica no jarvis-kit (seção "Sprints").

## Fase 4 — Síntese

Recomendação: **B + S1 + J1.** O Jarvis (cliente do kit + `bot.py`) é boca e ouvido; o NewClaw é o único núcleo de
conversa, memória e execução.

### Estratégia de conversação (entrega 2)

- **Continuidade = `sessionId` fixo por dispositivo** (`jarvis-<dispositivo>`, na configuração do bot). O NewClaw já monta o
  histórico da sessão `web:jarvis-<dispositivo>`; o bot manda **só a transcrição nova**.
- **Nada de histórico no bot:** o processador não usa o contexto acumulado do Pipecat para nada além de saber que há uma fala
  nova; o contexto local é esvaziado a cada turno e nada dele sai do bot. Sem `assistant_aggregator` gravando respostas.
- **A conversa é visível no painel** (`/api/conversations`), sem mudar o painel.
- **A API atual basta para a continuidade.** Duas limitações registradas, sem extensão proposta agora:
  1. **ACK/complemento sem marca estrutural** — o cliente não sabe, pela forma da resposta, se ela é final. Regra do cliente
     (sem ler o texto): um `turnId` continua aberto enquanto `/active` mostrar a conversa ocupada; quando ela fica livre, faz
     a última leitura do outbox de cada `turnId` aberto e os fecha; o que faltar está em `/api/conversations/:id/messages`.
     Se o teste T11 reprovar essa regra, a menor extensão é um campo aditivo em `NormalizedResponse` (como `progresso`),
     com ADR curta própria.
  2. **Sem push** — resolvido por polling (o painel faz a cada 1,5 s). Só se M5 reprovar, estender a rota de chat (SSE por
     `turnId`), com nova passada do gate.

### Fluxo ponta a ponta (entrega 3)

```text
 mic ─▶ [cliente Jarvis] ─WebRTC─▶ [bot.py, Marte]
                                    1 VAD: UserStartedSpeaking ............ estado OUVINDO
                                    2 VAD: UserStoppedSpeaking ............ estado TRANSCREVENDO   (M1 começa)
                                    3 STT whisper-proxy → TranscriptionFrame (texto vazio → OCIOSO) (M1 termina)
                                    4 POST /api/chat {message, sessionId} ── estado ENVIANDO       (M2 começa)
                                    5 202 {turnId} ......................... estado PENSANDO       (M2 termina)
                                    6 a cada 1,5 s: GET /api/chat/active
                                        - progresso novo → fala o relato (FALANDO) e volta a PENSANDO   (M3)
                                        - pendingAuth → mostra "aprovação pendente no painel" (não aprova)
                                        - elapsedMs → "pensando há N min" (só visual)
                                    7 conversa livre → GET /api/chat/outbox?turnId  (200)          (M4)
                                    8 remove markdown/emoji → Kokoro → BotStartedSpeaking ... FALANDO (M5)
                                    9 BotStoppedSpeaking, sem turnId aberto ...... CONCLUÍDO → OCIOSO
 alto-falante ◀─WebRTC─ [cliente Jarvis] ◀─ áudio + RTVIServerMessageFrame {estado, texto}
```

A **máquina de estados mora no bot** (uma fonte de verdade) e chega ao cliente por `RTVIServerMessageFrame`; o cliente só
desenha.

### Segurança e rede (entrega 5)

| Tema | Hoje (comprovado) | Proposta |
|---|---|---|
| Acesso à janela | Bot em `0.0.0.0:7860` sem TLS nem autenticação (unit `pipecat-bot.service`); `tls_proxy` em `:8443` | Bot em `127.0.0.1:7860` (só o proxy fica exposto). Restringir a janela à rede de casa (D1). A chave pública do cliente (`VITE_BOT_START_PUBLIC_API_KEY`) vai no código do navegador — **não é segredo** e não conta como proteção |
| Token do NewClaw | Bearer da API inteira do painel, sem expiração, revogável só trocando a senha | Fica **só no servidor do bot** (arquivo de ambiente com permissão 600, fora do git e do cliente). Obtido uma vez por login. Rotação: trocar `DASHBOARD_PASSWORD` e refazer o login do bot e do painel (procedimento escrito no Sprint 4). Token com escopo restrito não existe — seria conceito novo, só com ADR própria |
| Transporte Marte → Venus | Painel da Venus em HTTP puro na rede | **Túnel SSH** (encaminhamento local, unit systemd no Marte) para cifrar o token sem mudar o NewClaw. Alternativa: aceitar HTTP na rede de casa, como o painel já usa hoje (D1) |
| Ação perigosa | Modo SAFE pede aprovação (`pendingAuth`) | O Jarvis **nunca aprova** por voz; diz que há aprovação pendente no painel (D11) |
| Falha de conectividade | — | `401` → estado ERRO "token inválido" (sem tentar de novo em laço); `429` → espera o `Retry-After`; rede caída → depois de 3 falhas seguidas no polling, ERRO "NewClaw inalcançável", mas os `turnId` continuam abertos e são lidos quando a rede volta (o trabalho no NewClaw não para) |
| Validação | — | Instância isolada (porta, banco e workspace próprios), nunca a produção, até o Sprint 4 com OK dela |

### Máquina de estados da janela (entrega 6)

| De | Evento | Para | O que a janela mostra/faz |
|---|---|---|---|
| OCIOSO | `UserStartedSpeaking` | OUVINDO | onda reage ao microfone |
| OUVINDO | `UserStoppedSpeaking` | TRANSCREVENDO | "entendendo…" |
| TRANSCREVENDO | transcrição com texto | ENVIANDO | mostra o texto transcrito |
| TRANSCREVENDO | transcrição vazia | OCIOSO | nada é enviado |
| ENVIANDO | `202 {turnId}` | PENSANDO | turno aceito (som opcional, D7) |
| ENVIANDO | `401`/`429`/`5xx`/rede | ERRO | motivo curto, sem reenviar em laço |
| PENSANDO | progresso novo no `/active` | FALANDO | fala o relato; depois volta a PENSANDO |
| PENSANDO | `pendingAuth` | PENSANDO | "aprovação pendente no painel" |
| PENSANDO | `UserStartedSpeaking` | OUVINDO | fala nova vira complemento ou fila (novo `turnId`, o anterior continua aberto) |
| PENSANDO | conversa livre + outbox `200` | FALANDO | fala a resposta |
| FALANDO | `UserStartedSpeaking` | OUVINDO | **interrupção**: corta só o áudio; o trabalho não é cancelado |
| FALANDO | `BotStoppedSpeaking`, sem `turnId` aberto | CONCLUÍDO | — |
| FALANDO | `BotStoppedSpeaking`, com `turnId` aberto | PENSANDO | — |
| qualquer um com `turnId` aberto | botão **Parar** | CANCELANDO | `POST /api/chat` `/cancelar` |
| CANCELANDO | `/active` livre | CONCLUÍDO | fala a confirmação do outbox |
| CONCLUÍDO | alguns segundos | OCIOSO | — |
| ERRO | botão "Tentar de novo" ou rede volta | estado anterior | relê os `turnId` abertos |

**Desconexão:**
- **Janela fechada** (`on_client_disconnected`): o bot encerra a sessão de voz e não guarda nada; os turnos continuam no
  NewClaw e as respostas ficam gravadas na conversa.
- **Ao reabrir:** recupera pelo histórico (D10).
- **Bot ↔ NewClaw cai:** estado ERRO com os `turnId` preservados enquanto a sessão de voz estiver aberta.

## Matriz de decisões D1–D11 (entrega 4)

| # | Decisão | Recomendação | Justificativa | Riscos | Como validar |
|---|---|---|---|---|---|
| D1 | Qual NewClaw e como alcança | **Testes:** instância isolada do NewClaw no Marte, ao lado do bot (localhost). **Produção (só no Sprint 4, com OK):** Venus por túnel SSH | Diretriz exige instância isolada; localhost dispensa rede nos testes; túnel cifra o token sem mudar o NewClaw | Marte precisa de um checkout do NewClaw (não verificado); túnel é mais uma peça que pode cair | T9 (rede) e T12; túnel derrubado de propósito → ERRO e recuperação |
| D2 | Onde transcrever | **S1**, no Pipecat | Contrato do whisper do lab incompatível com o do Core | Duas configurações de STT | M1; T1 e T2 com fala real |
| D3 | Cancelar | **Botão "Parar"** → `/cancelar` (mesmo do painel); interromper a fala só corta o áudio | Controle de interface, sem interpretar linguagem; o painel já faz igual | Pessoa espera que "pare" falado cancele | T6; T5 confirma que interrupção não cancela |
| D4 | Resposta longa | **Falar o texto inteiro limpo, mostrando o texto na janela**; interrupção corta | Não perde conteúdo e não muda o Core. O painel corta em 500 caracteres na leitura em voz alta (`index.html:1193`) — opção que fica com ela | Monólogo longo | T3 com resposta longa; opinião dela |
| D5 | Identidade entre canais | **Conversa própria por dispositivo** (`jarvis-<dispositivo>`), visível no painel; unificar só com ADR própria | Funciona com o contrato atual; unificar é conceito novo | "Cadê meu pedido do Telegram?" depende da memória de longo prazo | T2 e T13 |
| D6 | Frequência do progresso | **Manter 5 min** no piloto; a janela mostra "pensando há N min" pelo `elapsedMs` | O valor é global; mudar afeta todos os canais | Silêncio de até 5 min | M3; na instância isolada, testar com valor baixo |
| D7 | Som de "aceito" e voz | **Só o estado visual**; som opcional. Voz: a `KOKORO_VOICE` que ela já declarou no lab | Nenhuma escolha nova no código | — | Escolha dela |
| D8 | Modelo de conversa | **Nada muda no piloto.** Com a linha de base separada (Sprint 0), ela decide se declara outro modelo no perfil de conversa | Mediana de ~70 s na Venus vem do turno; nenhum modelo é sugerido aqui | Piloto pode parecer lento | M4 por tipo de turno |
| D9 | Botão no painel | **Não no piloto** (o chat fica intocado); abrir pelo endereço ou favorito | Restrição "chat do painel inalterado" | — | C7 |
| D10 | Respostas que chegaram com a janela fechada | **Ao reabrir, mostrar (sem falar)** as mensagens novas da conversa, lidas de `/api/conversations/web:<sessionId>/messages`; falar só se ela pedir | Usa rota existente | Órfãs saem coladas na próxima resposta com "📎 Entrega pendente…" e serão faladas | T7, T8, T10 |
| D11 | Aprovar ação perigosa por voz | **Nunca**; avisar que há aprovação no painel | Aprovação por voz é fácil de disparar sem querer; ADR-005 | Objetivo fica parado até ela abrir o painel | T14 |

## Testes de aceitação (entrega 7)

Todos na instância isolada, com o modelo que ela escolher e **só depois do OK de cota** (estimativa no Sprint 1).

| # | Cenário | Passa quando |
|---|---|---|
| T1 | Conversa simples | Pergunta curta → resposta falada; a conversa aparece no painel com o mesmo `sessionId` |
| T2 | Continuidade | Segunda fala que depende da primeira ("e o segundo?") é respondida certo; o bot mandou só a fala nova (conferido no log de auditoria do bot) |
| T3 | Tarefa longa | Pedido que vira objetivo: PENSANDO durante todo o objetivo, resposta falada no fim |
| T4 | Progresso | Com `RELATO_DE_PROGRESSO_MIN` baixo na instância isolada, cada relato novo é falado uma vez |
| T5 | Interrupção | Falar durante FALANDO corta o áudio; o turno não é cancelado |
| T5b | Complemento | Falar durante PENSANDO → "Anotado" e a resposta final do turno original ainda chega |
| T6 | Cancelar | Parar durante PENSANDO → CANCELANDO → confirmação; `/active` livre; registrar o que o turno cancelado devolve |
| T7 | Janela fechada | Fechar durante PENSANDO; a resposta fica gravada na conversa |
| T8 | Reconexão | Reabrir depois de T7 → a resposta aparece (D10) |
| T9 | Erros da API | Token errado → ERRO sem laço; NewClaw parado → ERRO e recuperação quando volta; `429` respeita `Retry-After` |
| T10 | Resposta tardia/órfã | Entrega órfã é falada na resposta seguinte, sem duplicar |
| T11 | Fila ocupada | Duas falas seguidas: ACK e resposta final do mesmo `turnId`, ambas recebidas, nenhuma perdida |
| T12 | Chat intocado | Suíte de regressão do NewClaw passa; conversa normal no painel igual a antes |
| T13 | Memória compartilhada | Fato dito ao Jarvis é encontrado depois pelo Telegram (memória de longo prazo) |
| T14 | Ação perigosa | Pedido que exige aprovação → aviso "aprovação pendente no painel"; nada é aprovado pelo Jarvis |

## Métricas (entrega 8)

Uma linha JSON por evento no log de auditoria do bot, com `turnId`, `sessionId` e horário. Nenhum número abaixo é meta
inventada: cada uma tem linha de base medida ou fica "a medir".

| # | Métrica | De → até | Fonte | Linha de base |
|---|---|---|---|---|
| M1 | Latência de transcrição | `UserStoppedSpeaking` → `TranscriptionFrame` | log do bot | TTFB do STT 1,07–2,10 s (n=7, 09/10) |
| M2 | Tempo até a aceitação | transcrição → `202` | log do bot | **a medir** |
| M3 | Tempo até o primeiro progresso | `202` → primeiro `progresso` novo | log do bot | **a medir** (o relato sai a cada 5 min por padrão; no canal web nunca medido) |
| M4 | Tempo até a primeira resposta | `202` → outbox `200` | log do bot; `processing_done` no NewClaw | Venus/web 30d p50 69,8 s, p90 112,6 s (n=13); Windows/web 30d p50 152,7 s (n=126) — mistura conversa e objetivo |
| M5 | Tempo até o primeiro áudio | outbox `200` → `BotStartedSpeaking` | log do bot | TTFB do Kokoro 0,08–1,15 s (n=8) |
| M6 | Custo do polling | (resposta pronta no NewClaw) → outbox `200` | log do bot × `processing_done` | **a medir** (esperado ≤ 1,5 s pelo intervalo; hipótese) |

As metas de M2–M6 ficam com ela, depois do Sprint 0.

## Sprints (entrega 9)

Nenhuma sprint mexe na produção. Push, PR e deploy só com OK dela, sprint a sprint.

### Sprint 0 — Linha de base e decisões (sem código, sem cota)
- Separar, nos logs existentes, conversa simples × objetivo (cruzar `processing_done` com os registros do `GoalOrchestrator`
  pelo horário e pela sessão) e refazer a tabela de M4 por tipo.
- Conferir no Marte: se o runner do Pipecat 1.12 serve um cliente próprio no lugar do `pipecat_ai_prebuilt` (necessário para
  J1); se há checkout do NewClaw para a instância isolada.
- Ela decide D1–D11 e as metas de M2–M6.
- **Arquivos:** só esta ADR. **Pronto quando:** tabela de M4 separada por tipo, as duas conferências respondidas, decisões
  registradas aqui.

### Sprint 1 — Instância isolada e teste de contrato
- Subir o NewClaw isolado no Marte (porta, banco e workspace próprios; modelo que ela escolher).
- Cliente HTTP do NewClaw no kit + teste de contrato que exercita login, envio, `/active`, outbox, cancelamento, fila
  ocupada e entrega órfã.
- Estimar a cota antes e pedir OK.
- **Arquivos (jarvis-kit):** `server/newclaw_client.py` (novo), `server/tests/test_contrato_newclaw.py` (novo),
  `server/env.example`. **NewClaw:** nenhum.
- **Pronto quando:** cada linha da tabela do contrato marcada com "H" vira comprovada ou refutada, com o log do teste; se T11
  reprovar, abrir a ADR curta da marca estrutural antes de seguir.

### Sprint 2 — Bot ligado ao NewClaw
- Estágio `llm` do `bot.py` trocado pelo processador "NewClaw".
  - Sai do caminho do Jarvis o modelo embutido como valor padrão: `OLLAMA_MODEL` sem valor padrão, se ela quiser manter o
    modo Ollama.
  - Máquina de estados no bot, publicada ao cliente por `RTVIServerMessageFrame`.
  - Limpeza de markdown/emoji antes do Kokoro.
  - Log de auditoria JSON (M1–M6).
- **Arquivos (jarvis-kit):** `server/bot.py`, `server/newclaw_client.py`, `server/env.example`. **NewClaw:** nenhum.
- **Pronto quando:** T1, T2, T3, T5, T5b, T6, T9 e T11 passam na instância isolada, com o cliente atual (sem reskin).

### Sprint 3 — Janela Jarvis (reskin)
- Cliente a partir de `client-templates/react-vite`, nome e visual Jarvis.
  - Os nove estados.
  - Botão Parar.
  - Texto transcrito e da resposta.
  - Recuperação ao reabrir (D10).
  - Aviso de aprovação pendente (D11).
- **Arquivos (jarvis-kit):** diretório novo do cliente gerado do template (ex.: `client-jarvis/`); a forma de servir depende
  do achado do Sprint 0. **NewClaw:** nenhum.
- **Pronto quando:** T4, T7, T8, T10 e T14 passam; todos os estados aparecem na tela.

### Sprint 4 — Segurança e ligação com produção (só com OK dela)
- Bot em `127.0.0.1`.
- Túnel SSH Marte → Venus (ou a escolha dela em D1).
- Token em arquivo 600 e procedimento de rotação escrito.
- Teste T9 com o túnel derrubado.
- Só então apontar para a Venus, **por ela ou com o OK explícito dela**.
- **Arquivos (jarvis-kit):** `systemd/pipecat-bot.service`, `systemd/` unit nova do túnel, `server/env.example`,
  procedimento de rotação (documento do kit). **NewClaw:** nenhum (a Venus já está em `0.0.0.0:3090` com senha; com túnel,
  nem isso muda).
- **Pronto quando:** T1–T14 passam contra a produção escolhida, com M1–M6 registrados.

### Sprint 5 — Condicional (cada item com ADR própria, só se a medição pedir)
Push por SSE na rota de chat (se M6 reprovar); `ChannelType 'voice'` (se a mistura nos logs atrapalhar); identidade única
entre canais (D5); resposta falável (D4); marca estrutural de ACK (se T11 reprovar); STT único (S2).

**Arquivos do NewClaw alterados nos Sprints 0–4:** somente esta ADR.

## Critérios de sucesso

- **C1:** estado TRANSCREVENDO visível assim que o VAD detecta o fim da fala, e PENSANDO no `202`, em 100% dos turnos.
- **C2:** M2–M6 dentro das metas que ela definir no Sprint 0.
- **C3:** zero turnos sem retorno (cruzando `turnId` do bot com outbox e conversa).
- **C4:** a conversa do Jarvis aparece no painel; T13 passa.
- **C5:** nenhum modelo escolhido pelo código do NewClaw nem pelo caminho do Jarvis.
- **C6:** zero arquivo novo ou alterado no código do NewClaw nos Sprints 0–4.
- **C7:** chat do painel e demais canais iguais (T12).

## Fase 5 — Validação

- **Evidência real?** Sim: contrato conferido linha a linha no código, ambiente lido no Marte e na Venus, linha de base dos
  logs. O que não foi medido está marcado como hipótese.
- **Estrutural ou sintoma?** Estrutural: a voz é mais um cliente do canal, sem segundo cérebro.
- **Reduz complexidade?** Sim: no NewClaw nada é criado; no bot, um estágio é trocado, não somado.
- **Uma fonte de verdade?** Uma memória, uma fila, um roteador; a máquina de estados da janela mora só no bot. Sobram duas
  configurações de STT (S1, consciente).
- **Filosofia do Cognitive Kernel?** Mantida — o Core não sabe que a voz existe.
- **Incremental e reversível?** Sim: cada sprint para em si; voltar o estágio `llm` do `bot.py` desfaz tudo.

## Achados laterais (registrados, não corrigidos aqui)

- **Outbox sem expiração:** resposta nunca lida fica para sempre na memória do processo (`WebChannelAdapter.ts:121-133`).
- **Token do painel sem revogação individual e com escopo total** (`auth.ts:202-225`).
- **Bot do lab em `0.0.0.0:7860` sem TLS nem autenticação** (`systemd/pipecat-bot.service`); tratado no Sprint 4.
- **`processing_done` não diz o tipo do turno** (conversa × objetivo); a linha de base precisa de cruzamento manual.
- **Resposta sem marca de ACK/complemento** (limitação 1 da estratégia de conversação).
