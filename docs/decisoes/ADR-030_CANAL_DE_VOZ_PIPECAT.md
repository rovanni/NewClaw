# ADR-030 — Jarvis: interface de voz nativa do NewClaw, com Pipecat como ouvido e boca

Data: 28/10/2026. Status: **proposta técnica** — nada implementado. Aguarda o OK da operadora na proposta e nas decisões
da matriz antes de qualquer código. Nenhum deploy, nenhuma dependência da infraestrutura dela.

## O pedido

Transformar o protótipo JARVIS do lab numa **funcionalidade nativa do NewClaw**, distribuída no projeto open source, para
qualquer usuário instalar e configurar no próprio ambiente. Requisitos dela, resumidos:

1. Incorporar a interface React/Vite do protótipo ao repositório, seguindo as convenções do projeto.
2. O Cognitive Kernel continua a única fonte de verdade de memória, contexto, roteamento de modelos e execução.
3. Usar o código Pipecat e os componentes já validados no protótipo, adaptados à instalação de cada usuário.
4. Nenhum IP, domínio, token, serviço ou infraestrutura do lab dela no produto.
5. Chat convencional e funcionalidades existentes mantidos; o Jarvis não substitui o núcleo nem duplica a lógica dele.
6. Utilizável depois da instalação, com configuração documentada da voz, sem exigir os mesmos provedores ou modelos.
7. Autenticação, cancelamento, estados da interface, falhas de conexão, histórico e permissões tratados.
8. O NewClaw instala e funciona normalmente sem os componentes de voz configurados.

Entradas examinadas: este repositório (`origin/main` ab0f583), `D:\IA\Projetos\jarvis-kit` (`JARVIS_BRIEFING.md`), o bot
que roda no Marte (`~/pipecat-lab`, só leitura) e as versões anteriores desta ADR (histórico do branch).

## Resumo

| | |
|---|---|
| **Comprovado** | A API de chat do NewClaw já tem tudo o que o Jarvis precisa para conversar (tabela do contrato). O protótipo tem pipeline de voz funcionando com Pipecat **1.12.0**: VAD Silero, STT por API OpenAI, TTS Kokoro, transporte SmallWebRTC, e o protocolo RTVI com `user-transcription`, `bot-tts-text`, `client-message`, `server-message` e `send-text`. O repositório já tem precedentes para cada peça nova: subpacote com build próprio (`addins/powerpoint-addin`), processo auxiliar supervisionado (servidor de modelo local, `models.ts`), descoberta de Python multiplataforma (`resolvePython3Runtime`) e contrato de TTS igual ao do Kokoro (`KOKORO_TTS_URL`) |
| **Achado que muda o requisito 1** | **Não existe código-fonte de uma interface Jarvis.** O que roda hoje é o cliente pronto do pacote `pipecat_ai_prebuilt` (só o build). O `client-templates/react-vite` do kit é um molde do Pipecat CLI: importa `@/components/pipecat/console/console`, que não está no kit (os componentes vêm do registro `ui.pipecat.ai` na hora de gerar o projeto). O reskin Jarvis ainda não foi feito; procurei no PC e no Marte |
| **Hipótese, a provar na Etapa 0** | Se uma `client-message` do navegador consegue mandar o bot falar um texto (sem LLM no pipeline); se a sinalização WebRTC funciona atrás de um proxy do NewClaw; a licença dos componentes do registro; o custo de instalação do Pipecat em Windows e Linux limpos |
| **Medido** (logs existentes, sem cota) | Turno do NewClaw: mediana de ~70 s (Venus/web, 30 dias) a ~153 s (Windows/web). STT do protótipo: 1,1–2,1 s; Kokoro: 0,1–1,2 s até o primeiro áudio. Resposta em 1–2 s não sai de trocar a boca: o desenho é "aceito na hora, resposta depois" |
| **Depende dela** | Matriz de decisões D1–D15 e o OK para começar a Etapa 0 |

## Fase 1 — Compreensão

### O que o protótipo tem e o que é do lab

| Peça | Arquivo | Reaproveitável? | Específico do lab (sai do produto) |
|---|---|---|---|
| Pipeline de voz | `server/bot.py` (Pipecat 1.12.0) | **Sim**, sem o estágio LLM | `Language.PT` fixo; modelo `glm-5.3-flash:cloud` como valor padrão; endereços `127.0.0.1:8200`, `127.0.0.1:11434`, `10.0.0.1:8199`; voz `pf_dora` como padrão; prompt "Você é a IAL, a assistente do Luciano" |
| Correções do Kokoro | `KokoroTTS` (remove o cabeçalho WAV, caminha os chunks até `data`) e a inclusão das vozes no `VALID_VOICES` | **Sim** — valem para qualquer servidor compatível com a API OpenAI que devolva WAV | Lista fixa de vozes (`pf_dora`, `pf_santa`…) — vira a voz que o usuário configurar |
| TLS para o microfone | `server/tls_proxy.py` (repasse TCP com TLS) | Não como está — o caminho do certificado é do usuário `rover` | `/home/rover/pipecat-lab/tls/...` |
| Serviços | `systemd/pipecat-bot.service`, `pipecat-tls.service` | Só como referência; o NewClaw usa PM2 nas duas plataformas | Usuário e caminhos `rover`; bot em `0.0.0.0:7860` sem autenticação |
| Interface | `client-current-dist/` (build pronto, não editável); `client-templates/react-vite` e `vanilla-js-vite` (moldes) | O molde React, sim — **depois de gerado** com os componentes do registro | `VITE_BOT_START_URL` apontando para o bot |

### O que o NewClaw já tem (reaproveitado como está)

**Contrato da API de chat** (comprovado no código; usado hoje pelo painel e pelo suplemento do PowerPoint):

| Capacidade | Como funciona | Evidência |
|---|---|---|
| Autenticação | Cookie `newclaw_session` (mesmo domínio) ou `Bearer`. Login em `POST /api/auth/login` | `auth.ts:238-283` |
| Sessão | `sessionId` = conversa; chave `web:<sessionId>`; mesmo `sessionId` = mesmo histórico, objetivo e fila | `chat.ts:256, 288-297`; `SessionKeyFactory.ts:28` |
| Enviar | `POST /api/chat` (`message`, `sessionId`, anexos) → `202 {turnId}` | `chat.ts:230-316` |
| Resposta | `GET /api/chat/outbox?turnId=` → `200` uma vez; `404` = ainda não pronta | `chat.ts:322-350` |
| Andamento | `GET /api/chat/active?sessionId=&turnId=` → `active[]` (com `elapsedMs`), `pending`, `pendingAuth[]`, `progresso` (ADR-027) | `chat.ts:93-182` |
| Cancelar | `POST /api/chat` com `/cancelar` no mesmo `sessionId` (o painel faz assim) | `agentControllerCommands.ts:25-38`; `index.html:1373-1383` |
| Aprovar ação perigosa | `POST /api/chat/auth-decision` | `chat.ts:195-228`; ADR-005 |
| Histórico | `GET /api/conversations`, `GET /api/conversations/:id/messages` | `conversations.ts:8-65` |
| Entrega tardia | Resposta sem ninguém esperando fica no outbox; entregas sem turno saem na próxima resposta da sessão | `WebChannelAdapter.ts:249-334` |
| Limites | `POST /api/chat` 10/min por IP; geral 120/min; login 10/15 min | `chat.ts:17-18`; `security.ts:75-86` |
| Limitações | Sem push para chat (`/api/stream` é de rastros, global); ACK de fila e "anotado" têm a mesma forma da resposta final | `traces.ts:4-33`; `ChannelAdapter.ts` |

**Precedentes para as peças novas:**

| Necessidade | Precedente no repositório |
|---|---|
| Interface com build próprio dentro do repositório | `addins/powerpoint-addin` (`package.json` e webpack próprios, instalador próprio, PM2) |
| Processo auxiliar supervisionado | Servidor de modelo local: `spawn` com log em arquivo, PID em disco, status no painel (`models.ts:600-640`); PM2 com `treekill: false` (`ecosystem.config.cjs`) |
| Achar o Python em Windows e Linux | `resolvePython3Runtime`, `defaultPython3Candidates` (`utils/crossPlatform.ts:312`) |
| TTS por API OpenAI, sem endereço padrão | `KOKORO_TTS_URL`, `KOKORO_TTS_VOICE` (`send_audio.ts:351-371`; `.env.example:293-301`) |
| STT | `WHISPER_API_URL` com rota `/inference` (formato whisper.cpp) ou `whisper` local com `--language pt` fixo (`agentMediaHandlers.ts:225-280`) |
| Idioma | `config.language` (pt-BR, en-US, es-ES) e `buildLanguageDirective` |
| Build do produto | `npm run build` = `tsc` + cópia de `src/dashboard/public` para `dist/`; os instaladores rodam `npm install` e `npm run build` (`install.ps1:543-546`, `install.sh:515`) |
| Licença | NewClaw: MIT. Pipecat: BSD-2-Clause (cabeçalho do `bot.py`); dependências do cliente pronto: MIT (`THIRD_PARTY_NOTICES.txt`) |

### Linha de base (só logs existentes)

| Medida | Fonte | Valor |
|---|---|---|
| Turno do NewClaw, Venus/web, 30 dias | `processing_done` | n=13, p50 69,8 s, p90 112,6 s, 0% ≤ 2 s |
| Turno do NewClaw, Windows/web, 30 dias | `processing_done` | n=126, p50 152,7 s, p90 1.820 s, 3% ≤ 2 s |
| STT do protótipo (TTFB) | `bot.log`, 09/10/2026 | n=7, 1,07–2,10 s |
| Kokoro (TTFB) | `bot.log`, 09/10/2026 | n=8, 0,08–1,15 s |

Limites: o log do NewClaw mistura conversa e objetivo; o do bot é uma sessão só.

### Correção de uma afirmação da ideia original

`AgentController.js` e `AuditorService.js` não são um "frontend em embrião": são a compilação da fachada do Core
(`src/core/AgentController.ts`) e do autodiagnóstico `/audit` (`src/services/auditor/AuditorService.ts`).

## Fase 2 — Crítica

1. **Requisito 1 parte de algo que não existe.** Não há interface React do Jarvis para incorporar; há um molde e um
   cliente pronto. A Etapa 3 **cria** a interface a partir do molde gerado — não é migração.
2. **Python para todo mundo é caro.** O Pipecat traz `aiortc`, `onnxruntime` (Silero) e `numpy`. Exigir isso na instalação
   quebraria o requisito 8. A voz precisa ser **opcional de verdade**: sem Python e sem voz configurada, o NewClaw instala e
   funciona igual a hoje, e a janela Jarvis funciona **só em texto**.
3. **Microfone exige contexto seguro.** O navegador só libera o microfone em `https` ou em `localhost`. O NewClaw não tem TLS
   próprio (o painel serve HTTP). No próprio computador funciona; de outro aparelho da rede, o usuário precisa de HTTPS — é
   o que o `tls_proxy.py` resolve no lab (decisão D14).
4. **Não pode existir um segundo cérebro.** O bot do protótipo tem LLM, prompt de persona e contexto acumulado. No produto o
   estágio LLM sai: o processo de voz só ouve e fala (requisito 2).
5. **Duplicação do cliente da API.** O painel conhece o protocolo do turno (polling a cada 1,5 s, tolerância a falha, leitura
   do outbox, cancelamento) num script embutido em `index.html`. O Jarvis precisa do mesmo conhecimento.
   `QUANDO_EXTRAIR_DUPLICACAO.md` manda extrair quando o conhecimento pode divergir — e pode. Mas extrair agora mexe no chat
   do painel (requisito 5). Decisão D15.
6. **Duas configurações de STT.** O Core fala `/inference` (whisper.cpp); o Pipecat fala `/v1/audio/transcriptions` (API
   OpenAI). Ter duas variáveis para "onde está meu Whisper" é o tipo de duplicação que o projeto evita. Decisão D2.
7. **Nada de padrão escondido.** O protótipo tem modelo, voz, idioma e endereços com valores padrão; no produto, cada um
   vem da configuração do usuário ou fica ausente e reportado (`NUNCA_ADIVINHAR`, `SOBERANIA_DA_CONFIGURACAO`).
8. **Quem tem credencial.** Se o processo de voz chamar a API do NewClaw, precisa de um token com acesso à API inteira (não há
   token com escopo). Se só o navegador falar com o NewClaw, o processo de voz não precisa de credencial nenhuma.

**God Object:** evitado se o processo de voz não souber nada de conversa (só áudio ↔ texto) e o servidor do NewClaw só
servir a página e repassar a sinalização.

## Fase 3 — Alternativas

### Motor de voz

| # | Alternativa | Vantagens | Desvantagens |
|---|---|---|---|
| **V1** | **Processo de voz Pipecat opcional, no repositório** (o `bot.py` do protótipo sem o LLM) | Usa o que ela validou; interrupção, VAD e streaming de TTS maduros; WebRTC com cancelamento de eco | Python opcional na instalação; mais um processo |
| V2 | Voz sem Python: VAD no navegador, áudio enviado como anexo ao Core (`transcribeAttachment`), TTS do Core devolvido ao navegador | Tudo em Node; reusa o STT/TTS do Core | Não usa o Pipecat (contraria o requisito 3); exige rota nova de TTS e extrair o TTS de dentro da ferramenta `send_audio`; interrupção feita à mão |
| V3 | Voz do navegador (Web Speech API), como o ditado do chat | Nenhum serviço | No Chrome o áudio vai para servidores do Google; voz do sistema |

### Quem fala com o Core

| # | Alternativa | Vantagens | Desvantagens |
|---|---|---|---|
| **P1** | **O navegador conversa com o NewClaw**; o processo de voz só transcreve (manda `user-transcription`) e fala o que o navegador mandar (`client-message`) | Processo de voz **sem credencial e sem conversa**; autenticação é o cookie do painel; uma máquina de estados só, no navegador | Depende de uma `client-message` fazer o bot falar (hipótese da Etapa 0) |
| P2 | O processo de voz chama a API do NewClaw (como na versão anterior desta ADR) | Navegador mais simples | Token com acesso total guardado no processo de voz; estado dividido entre dois lugares |

### Onde mora e como é construída a interface

| # | Alternativa | Vantagens | Desvantagens |
|---|---|---|---|
| **U1** | **Subpacote `jarvis/` com build Vite próprio**, gerado do molde, servido pelo painel em `/jarvis` | Mesmo padrão do `addins/powerpoint-addin`; React e Vite não entram nas dependências do NewClaw; mesmo domínio do painel (cookie) | Mais um build no `npm run build` |
| U2 | Página em JavaScript puro dentro de `src/dashboard/public` | Sem build | Perde o molde React e os componentes do Pipecat; contraria o requisito 1 |
| U3 | Interface servida pelo processo de voz, como hoje | Nada no painel | Outro endereço e outra autenticação; não é nativa |

### Transporte de áudio

| # | Alternativa | Vantagens | Desvantagens |
|---|---|---|---|
| **T1** | **SmallWebRTC (validado)**, com a sinalização passando por uma rota autenticada do NewClaw | O que ela testou; áudio direto entre o navegador e o processo de voz | Precisa de portas UDP entre os dois (na rede de casa, normal) |
| T2 | WebSocket de áudio passando pelo servidor do NewClaw | Uma porta só, um TLS só | Não validado; mais carga no processo do NewClaw |

### Como o processo de voz sobe

| # | Alternativa | Vantagens | Desvantagens |
|---|---|---|---|
| **S1** | **Entrada condicional no PM2** (`ecosystem.config.cjs`) quando a voz está configurada | Mesmo padrão do suplemento do PowerPoint; reinício automático; nenhum código novo de supervisão | Ligar ou desligar exige `pm2` |
| S2 | O NewClaw inicia e para o processo (como o servidor de modelo local) | Liga e desliga pelo painel | Módulo novo de supervisão no servidor |

### Gate — Extensão antes de Criação

| Arquivo novo proposto | Precisa existir? | O que já existe | Extensão que o elimina | Por que fica |
|---|---|---|---|---|
| `voz/bot.py` (+ `voz/requirements.txt`) | SIM | `jarvis-kit/server/bot.py` (fora do repo) | Nenhuma no NewClaw: não há nada em Node que faça WebRTC + VAD + STT/TTS em streaming | É o código validado, trazido sem o LLM e sem o que é do lab |
| `jarvis/` (subpacote da interface) | SIM | Molde `client-templates/react-vite`; o chat em `index.html` | Um "modo voz" em `index.html` (U2) — descartado pelo requisito 1 | Interface nova, com build próprio, como o suplemento |
| Rota `POST /api/voz/offer` (repasse da sinalização) | SIM | Nenhuma rota repassa para outro processo | Expor a porta do processo de voz ao navegador — descartado (outra autenticação, CORS e TLS) | Só repassa a oferta WebRTC, com o cookie do painel |
| Status da voz | **NÃO** | `GET /api/status` | Campo aditivo `voz` em `/api/status` | — |
| Supervisor do processo de voz em TypeScript | **NÃO** (com S1) | `ecosystem.config.cjs`; precedente do suplemento | Entrada condicional no PM2 | — |
| Tela de configuração da voz | A decidir na Etapa 4 | Telas em `dashboard/public/config/views/` (ex.: `ModelosView.js`) | Seção nova numa tela existente | Só vira arquivo novo se não couber em nenhuma |
| `docs/VOZ.md` (guia do usuário) | SIM | README trilíngue | — | Documentação da configuração (requisito 6) |

## Fase 4 — Síntese

### Arquitetura recomendada: V1 + P1 + U1 + T1 + S1

```text
                        ┌────────────── servidor NewClaw (Node, como hoje) ──────────────┐
 navegador  ──HTTP────▶ │ /jarvis ............ página estática (build de jarvis/)          │
 (janela    ──cookie──▶ │ /api/chat, /active, /outbox, /cancelar, /auth-decision,         │
  Jarvis)               │ /api/conversations .. EXISTENTES, sem mudança                    │
            ──HTTP────▶ │ /api/voz/offer ...... NOVA: repassa a oferta WebRTC (autenticada)│
            ──HTTP────▶ │ /api/status ......... + campo "voz" (configurada, no ar, erro)  │
                        └───────────────┬──────────────────────────────────────────────────┘
                                        │ localhost
                        ┌───────────────▼──────── processo de voz (Python, OPCIONAL) ──────┐
 navegador ◀─WebRTC───▶ │ VAD Silero → STT (URL do usuário) → evento user-transcription     │
                        │ client-message {falar: texto} → TTS (KOKORO_TTS_URL) → áudio      │
                        │ SEM LLM, SEM histórico, SEM credencial do NewClaw, só em 127.0.0.1 │
                        └───────────────────────────────────────────────────────────────────┘
```

Responsabilidades:

| Componente | Faz | Não faz |
|---|---|---|
| Janela Jarvis (navegador) | Máquina de estados; envia a transcrição ao `/api/chat`; acompanha `/active`; lê o outbox; manda o bot falar; cancelar; aprovar por clique; histórico; modo texto quando a voz não está disponível | Não decide nada de IA; não guarda memória além do `sessionId` |
| Servidor NewClaw | Serve `/jarvis`; repassa a sinalização; informa o status da voz | Nada muda no Core (`MessageBus`, `GoalOrchestrator`, `AgentLoop`, memória) |
| Processo de voz | Áudio ↔ texto; interrupção da fala | Não conversa, não tem LLM, não chama o NewClaw |
| Core | Continua a única fonte de verdade (requisito 2) | Não fica sabendo que a voz existe |

### Configuração (requisitos 4, 6 e 8)

| O quê | Variável | Regra |
|---|---|---|
| TTS | `KOKORO_TTS_URL`, `KOKORO_TTS_VOICE` (**já existem**) | Mesmo contrato (API OpenAI `/v1/audio/speech`), sem endereço padrão. Vazio = sem fala |
| STT | Decisão D2 | Sem endereço padrão. Vazio = sem escuta |
| Idioma | `config.language` (**já existe**) | Passado ao STT e mostrado na janela; nada fixo em português |
| Python | descoberto por `resolvePython3Runtime` | Ausente = voz indisponível, reportado no status |
| Porta local do processo de voz | `VOZ_PORTA` (nova) | Só `127.0.0.1` |

Ligar a voz = declarar STT e TTS (a declaração é a intenção, como em `KOKORO_TTS_URL`). Faltando qualquer peça, o status diz
qual falta e a janela funciona em texto. Nenhum modelo entra no caminho da voz.

### Estratégia de conversa

- `sessionId` por aparelho, guardado no navegador (como o painel faz); a conversa aparece na lista do painel.
- O navegador manda **só a fala nova**; o histórico é o da sessão no NewClaw. O processo de voz não guarda contexto.
- "Turno terminado" sem ler texto: um `turnId` fica aberto enquanto `/active` mostrar a conversa ocupada; ao ficar livre,
  a janela faz a última leitura do outbox de cada `turnId` aberto e completa o que faltar por
  `/api/conversations/:id/messages`. Se o teste de fila ocupada reprovar, a menor extensão é um campo aditivo em
  `NormalizedResponse` (como `progresso`), com ADR própria.

### Máquina de estados da janela

| De | Evento | Para | Comportamento |
|---|---|---|---|
| OCIOSO | VAD: começou a falar | OUVINDO | onda reage ao microfone |
| OUVINDO | VAD: parou | TRANSCREVENDO | "entendendo…" |
| TRANSCREVENDO | `user-transcription` final com texto / vazio | ENVIANDO / OCIOSO | mostra o texto |
| ENVIANDO | `202 {turnId}` / erro | PENSANDO / ERRO | turno aceito (som opcional, D7) |
| PENSANDO | progresso novo | FALANDO → PENSANDO | fala o relato uma vez |
| PENSANDO | `pendingAuth` | PENSANDO | botões Aprovar/Rejeitar (clique, nunca voz) |
| PENSANDO | começou a falar | OUVINDO | fala nova vira complemento ou fila; o `turnId` anterior continua aberto |
| PENSANDO | conversa livre + outbox `200` | FALANDO | fala a resposta (texto limpo de markdown e emoji) |
| FALANDO | começou a falar | OUVINDO | **interrupção**: corta o áudio; o trabalho não é cancelado |
| FALANDO | terminou, com/sem `turnId` aberto | PENSANDO / CONCLUÍDO | — |
| qualquer um com `turnId` aberto | botão Parar | CANCELANDO → CONCLUÍDO | `/cancelar`; fala a confirmação |
| ERRO | Tentar de novo / conexão volta | estado anterior | relê os `turnId` abertos |

**Desconexão:**
- **Janela fechada:** o trabalho continua no NewClaw. Ao reabrir, a janela mostra (sem falar) o que chegou (D10).
- **Processo de voz caiu:** a janela passa a funcionar em texto e avisa.
- **NewClaw caiu:** depois de 3 falhas seguidas de consulta (a mesma regra do painel), a janela vai para ERRO e mantém os
  `turnId` abertos.

### Segurança

- **Página e API do NewClaw:** a autenticação e a proteção CSRF do painel valem para `/jarvis` e para `/api/voz/offer`. Nada
  de token no navegador nem no processo de voz.
- **Processo de voz:**
  - só em `127.0.0.1`, sem credencial nenhuma;
  - a única porta de entrada é a sinalização repassada pelo NewClaw, já autenticada;
  - o áudio WebRTC usa portas UDP negociadas — documentar no `docs/VOZ.md`.
- **Ação perigosa:** aprovação só por clique na janela, com a mesma rota do painel; nunca por voz (D11).
- **Acesso remoto:** exige HTTPS para o microfone (D14); sem HTTPS, a janela funciona em texto.

### Riscos

- **Peso da instalação opcional do Pipecat**, sobretudo no Windows (`aiortc`, `onnxruntime`).
- **A hipótese da `client-message`.** Se ela falhar, cai para P2, com token interno, e esta ADR volta para revisão.
- **Licença dos componentes do registro `ui.pipecat.ai`**, ainda não conferida.
- **Duplicação do protocolo do turno entre painel e Jarvis** (D15).
- **Latência:** a conversa continua levando o tempo do turno do NewClaw. A janela deixa a espera visível, mas não a encurta (D8).
- **Tamanho do build:** o `npm run build` passa a gerar também a interface. Quanto tempo acrescenta é medido na Etapa 3.

## Matriz de decisões

| # | Decisão | Recomendação | Por quê | Risco | Como validar |
|---|---|---|---|---|---|
| D1 | Motor de voz | **V1** (Pipecat opcional) | Requisito 3 e componentes validados | Peso da instalação | Etapa 5 em Windows e Linux limpos |
| D2 | Configuração do STT | **Uma variável só para o Whisper do usuário**, usada pelo Core e pelo processo de voz: estender o Core para também falar a API OpenAI de transcrição (benefício para as notas de voz de todos os canais) | Evita duas configurações para a mesma coisa | Mexe no Core (pequeno, com teste próprio) | Teste de transcrição nos dois formatos |
| D3 | Cancelar | Botão **Parar** → `/cancelar` | Igual ao painel, sem interpretar fala | Pessoa espera que "pare" falado cancele | T6 |
| D4 | Resposta longa | Falar o texto inteiro limpo e mostrar o texto | Não perde conteúdo | Monólogo | T3 + opinião dela |
| D5 | Conversa | Uma por aparelho, visível no painel | Contrato atual | Separada da do Telegram (memória de longo prazo compartilhada) | T2, T13 |
| D6 | Frequência do progresso | Manter `RELATO_DE_PROGRESSO_MIN`; a janela mostra "pensando há N min" pelo `elapsedMs` | O valor é global | Silêncio de até 5 min | M3 |
| D7 | Som de "aceito" e voz | Só o estado visual; som opcional. Voz = `KOKORO_TTS_VOICE` do usuário | Nenhuma escolha no código | — | Escolha dela |
| D8 | Modelo de conversa | Nada muda | O Core decide pelos perfis que o usuário declara | Parecer lento | M4 |
| D9 | Acesso pela navegação do painel | Um link "Jarvis" no menu do painel (única mudança visível no painel) | Descoberta da funcionalidade | Toca o `index.html` | T12 |
| D10 | Respostas que chegaram com a janela fechada | Mostrar sem falar | Rota existente | Entrega órfã falada na resposta seguinte | T7, T8, T10 |
| D11 | Ação perigosa | Botões na janela; nunca por voz | ADR-005; clique é intencional | — | T14 |
| D12 | Como o processo de voz sobe | **S1**, PM2 condicional | Precedente do suplemento; sem código de supervisão | Ligar/desligar pelo `pm2` | Etapa 4 |
| D13 | Transporte | **T1**, SmallWebRTC | Validado | Portas UDP | Etapa 0 e T9 |
| D14 | HTTPS para acesso remoto | Documentar o uso de proxy reverso do próprio usuário; sem TLS embutido no NewClaw nesta ADR | TLS no produto é decisão à parte | Microfone só em `localhost` sem proxy | Guia em `docs/VOZ.md` |
| D15 | Protocolo do turno no navegador | Cliente pequeno e tipado dentro de `jarvis/`; extração para módulo comum com o painel numa etapa separada, com teste do chat | Não mexer no chat agora | Duas cópias do mesmo conhecimento até a extração | Etapa 6 |

## Etapas de implementação

Toda etapa termina com a suíte completa (`npm run test:regression`) passando, mais os testes próprios. Nenhuma toca a
produção. Push e PR só com OK dela, etapa a etapa.

| Etapa | O que entrega | Arquivos | Testes / pronto quando |
|---|---|---|---|
| **0 — Provas** (sem código no produto) | Prova da `client-message` → fala sem LLM; sinalização atrás de proxy; licença dos componentes do registro; instalação do Pipecat em Windows e Linux limpos | Nenhum no repositório (rascunho fora dele) | As quatro hipóteses respondidas e registradas aqui; se a primeira falhar, revisar P1 antes de seguir |
| **1 — Processo de voz** | `voz/` com o pipeline do protótipo: sem LLM, sem histórico, configurado só por ambiente, idioma de `config.language`, `KokoroTTS` aproveitado, só `127.0.0.1`, aviso de licença BSD-2 | `voz/bot.py`, `voz/requirements.txt` (versão fixa do Pipecat), `voz/README.md`, `voz/tests/` | Testes Python das funções puras (cabeçalho WAV, leitura de configuração); sobe sozinho com STT/TTS de teste; sem nenhuma configuração, sai com mensagem clara |
| **2 — Integração no servidor** | Rota `POST /api/voz/offer` (repasse autenticado); campo `voz` em `/api/status`; `/jarvis` servido como página estática; variáveis documentadas | `src/dashboard/routes/voz.ts` (nova), `src/dashboard/DashboardServer.ts`, `src/dashboard/routes/status.ts`, `.env.example` | Regressão nova: rota exige autenticação; voz ausente → status "não configurada" e `503` limpo; páginas e rotas existentes iguais. Suíte completa passando |
| **3 — Janela Jarvis** | Projeto gerado do molde, componentes do registro incluídos no repositório, visual Jarvis, os estados da tabela, modo texto, Parar, aprovação por clique, histórico, reabertura | `jarvis/` (subpacote), `package.json` raiz (o script `build` passa a gerar também a janela) | Testes da máquina de estados e do cliente da API (sem rede); build reproduzível; janela abre em modo texto sem voz |
| **4 — Instalação e distribuição** | Passo opcional de voz nos instaladores (ambiente Python + `voz/requirements.txt`), entrada condicional no PM2, atualização, guia | `install.sh`, `install.ps1`, `update.sh`, `update.ps1`, `ecosystem.config.cjs`, `docs/VOZ.md`, READMEs (3 idiomas), avisos de terceiros | Instalação limpa **sem voz** em Windows e Linux: NewClaw idêntico ao de antes; **com voz**: processo sobe e status "no ar" |
| **5 — Validação real** (etapa 4 da diretriz) | Instância isolada, STT/TTS reais configurados como um usuário qualquer configuraria, LLM real (só com OK de cota) | Nenhum | T1–T14 passam; M1–M6 registrados |
| **6 — Condicionais** (cada um com ADR própria) | Módulo comum do protocolo do turno (D15), marca estrutural de ACK, push por SSE, HTTPS embutido, identidade entre canais | — | Só se a medição ou ela pedir |

A extensão do STT de D2, se aprovada, entra na Etapa 2, com teste próprio:
- `src/core/agentMediaHandlers.ts`;
- `.env.example`;
- teste de regressão novo da transcrição nos dois formatos.

### Proteção do que já existe

- **Chat, roteamento de modelos e memória:** a suíte completa de regressão roda em toda etapa. As únicas mudanças no Core são
  a extensão opcional de D2; o resto é rota nova e página nova.
- **T12, "chat intocado":** o `index.html` só muda com D9 (um link), e conversar pelo painel e pelo Telegram continua igual.
- **Sem voz configurada:** um teste de regressão garante que o NewClaw sobe, que `/api/status` diz "voz não configurada" e
  que nenhum processo Python é chamado.

## Testes de aceitação (Etapa 5)

| # | Cenário | Passa quando |
|---|---|---|
| T1 | Conversa simples | Pergunta falada → resposta falada; conversa visível no painel |
| T2 | Continuidade | Segunda fala dependente da primeira respondida certo; só a fala nova foi enviada |
| T3 | Tarefa longa | PENSANDO durante o objetivo, resposta falada no fim |
| T4 | Progresso | Com relato frequente na instância isolada, cada relato novo falado uma vez |
| T5 | Interrupção | Falar durante FALANDO corta o áudio sem cancelar o trabalho |
| T5b | Complemento | Falar durante PENSANDO → "Anotado"; a resposta do turno original chega |
| T6 | Cancelar | Parar → CANCELANDO → confirmação; `/active` livre |
| T7 | Janela fechada | Resposta gravada na conversa |
| T8 | Reabrir | A resposta aparece (D10) |
| T9 | Falhas | Processo de voz parado → modo texto; NewClaw parado → ERRO e recuperação; sessão expirada → volta ao login |
| T10 | Entrega órfã | Falada na resposta seguinte, sem duplicar |
| T11 | Fila ocupada | ACK e resposta final do mesmo `turnId`, nenhuma perdida |
| T12 | Chat intocado | Suíte de regressão; conversa normal no painel e no Telegram igual |
| T13 | Memória compartilhada | Fato dito ao Jarvis encontrado depois por outro canal |
| T14 | Ação perigosa | Botões de aprovação na janela; nada é aprovado por voz |
| T15 | Sem voz | Instalação sem Python/STT/TTS: NewClaw normal; janela Jarvis em modo texto |

## Métricas

| # | Métrica | De → até | Linha de base |
|---|---|---|---|
| M1 | Transcrição | fim da fala → `user-transcription` | 1,07–2,10 s (protótipo, n=7) |
| M2 | Aceitação | transcrição → `202` | a medir |
| M3 | Primeiro progresso | `202` → primeiro `progresso` | a medir (padrão: relato a cada 5 min) |
| M4 | Primeira resposta | `202` → outbox `200` | p50 69,8 s (Venus/web) a 152,7 s (Windows/web), misturando conversa e objetivo |
| M5 | Primeiro áudio | outbox `200` → início da fala | 0,08–1,15 s (Kokoro, n=8) |
| M6 | Custo do polling | resposta pronta → outbox lido | a medir (esperado ≤ 1,5 s; hipótese) |

As metas ficam com ela depois da Etapa 0.

## Fase 5 — Validação

- **Evidência real?** Sim: contrato, precedentes e protótipo conferidos no código e no Marte; linha de base dos logs. O que
  falta está nomeado como hipótese da Etapa 0.
- **Estrutural?** Sim: voz entra como interface e processo de áudio, sem segundo cérebro.
- **Reduz complexidade?** Em relação ao protótipo, sim: sai o LLM do bot, sai o token, sai o endereço fixo. Entram uma rota,
  uma página e um processo opcional.
- **Uma fonte de verdade?** Memória, contexto, roteamento e execução só no Core; estado da janela só no navegador. Com D2,
  uma configuração de STT.
- **Filosofia do Cognitive Kernel?** Mantida: o Core não sabe que a voz existe.
- **Incremental e reversível?** Sim: cada etapa funciona sozinha; tirar a entrada do PM2 e o link do menu desliga tudo.

## Achados laterais (registrados, não corrigidos aqui)

- Outbox sem expiração (`WebChannelAdapter.ts:121-133`).
- Token do painel sem revogação individual e com acesso total (`auth.ts:202-225`).
- Bot do lab em `0.0.0.0:7860` sem TLS nem autenticação (infraestrutura dela, fora do produto).
- `processing_done` não diz se o turno foi conversa ou objetivo.
- STT local do Core com `--language pt` fixo (`agentMediaHandlers.ts:273`), independente de `config.language`.
