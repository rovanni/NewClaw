# ADR-030 — Jarvis: experiência de voz opcional (harness) sobre o NewClaw, com Pipecat como ouvido e boca

Data: 28/10/2026. Status: **Etapa 0 concluída** (provas e auditoria, nada no produto). **Decisões aprovadas em
29/10/2026** (seção "Decisões da operadora"); **Etapa 1 feita** só no núcleo — o contrato público do turno
(`docs/CONTRATO_DO_TURNO.md`). Princípio de fronteira: `ADR-031_EXPERIENCIAS_OPCIONAIS_NAO_IMPOEM_DEPENDENCIAS_AO_NUCLEO.md`.

## O pedido e o enquadramento

A operadora quer uma experiência Jarvis — interface própria, voz e acompanhamento de tarefas — que qualquer usuário do
NewClaw possa instalar e configurar, **sem que o núcleo dependa dela**. Em 28/10 ela definiu o enquadramento: o Jarvis é um
**harness opcional**. O harness usa o NewClaw; o NewClaw não depende do harness (ADR-031).

Requisitos que continuam valendo:

- **Única fonte de verdade:** o Cognitive Kernel segue como única fonte de memória, contexto, roteamento de modelos e
  execução.
- **Sem o lab no produto:** nenhum IP, token, serviço ou infraestrutura do laboratório.
- **Chat intocado:** o chat do painel não muda.
- **Instalação básica igual:** sem o harness, o NewClaw instala e funciona como hoje.
- **Itens tratados:**
  - autenticação;
  - cancelamento;
  - estados da interface;
  - falhas de conexão;
  - histórico;
  - ações sensíveis.

## Resumo da Etapa 0

| | |
|---|---|
| **Comprovado por teste** (Marte, instância temporária na porta 7861, só serviços locais, sem cota) | Texto → fala **sem LLM** por `client-message` → `TTSSpeakFrame`; interrupção pedida pelo cliente em ~15 ms; STT → evento `user-transcription` no navegador; servidor HTTP do processo de voz preso a `127.0.0.1` com a sinalização passando por um túnel (equivalente a um proxy) e o áudio WebRTC direto entre as máquinas |
| **Comprovado no código** (Pipecat 1.12.0 instalado no Marte; NewClaw `origin/main` ab0f583) | Rotas WebRTC do runner sem autenticação; CORS do runner refletindo qualquer origem com credenciais; STUN do Google só quando o cliente pede (`enableDefaultIceServers`, que o molde do kit liga); `Language` aceita `pt-BR`, `en-US`, `es-ES`; duas cópias do protocolo de turno no NewClaw (painel e suplemento) |
| **Medido** | TTS, STT, conexão WebRTC, tempo até a primeira fala e interrupção (tabela de latência). Linha de base do NewClaw a partir dos logs |
| **Achados que pedem decisão** | Binários **GPL** (`libx264`, `libx265`) dentro do pacote PyAV para Linux, que o WebRTC do Pipecat exige; LGPL em `soxr` e `num2words`; o Kokoro do lab não envia o áudio em partes (texto longo espera tudo e dispara um aviso de "contexto sem áudio" aos ~3 s) |
| **Não provado ainda** | Interrupção por voz real (precisa de microfone real; o protótipo dela já faz isso); pacotes do Pipecat no Windows; tempo de aceitação, de progresso e de polling no NewClaw (exige instância isolada do NewClaw) |
| **Decisões** | R1, L1, H1, H3, D1–D8 e D15 aprovadas e D9 adiada em 29/10 (seções "Decisões da operadora" e "Decisões D1–D8"); H2 aprovada pela D4; H4 segue proposta |

## Etapa 0 — Resultados por prioridade

### 1. Licenças e dependências reais

**Python** — árvore instalada pelo `pipecat-ai[webrtc,silero,openai,runner]` 1.12.0, lida de `importlib.metadata` no Marte:

| Licença | Pacotes |
|---|---|
| BSD-2-Clause | `pipecat-ai` 1.12.0, `pipecat-ai-prebuilt` 1.3.0 (cliente pronto — **não necessário** no harness) |
| BSD-3 / BSD | `aiortc` 1.15.0, `aioice`, `pylibsrtp`, `av` 17.1.0 (código), `numpy`, `protobuf`, `uvicorn`, `starlette`, `websockets`, `markdown`, `python-dotenv`, `numba`, `soundfile`, `sympy`, `click`, `idna`, `pycparser`, `httpx2`, `httpcore2` |
| MIT / MIT-0 / MIT-CMU | `fastapi`, `pydantic`, `loguru`, `onnxruntime`, `pyee`, `anyio`, `attrs`, `cffi`, `pillow`, `pyyaml`, `h11`, `truststore`, `ifaddr`, `loudness`, `sentencex`, `docstring-parser` |
| Apache-2.0 | `openai`, `aiohttp`, `aiofiles`, `yarl`, `multidict`, `frozenlist`, `propcache`, `aiosignal`, `flatbuffers`, `opentelemetry-api`, `google-crc32c`, `pyopenssl`, `opencv-python-headless` (código) |
| ISC / PSF | `resampy`, `dnspython`, `typing-extensions`, `aiohappyeyeballs` |
| **LGPL-2.1+** | `soxr` 1.0.0, `num2words` 0.5.14 |
| **Binários embutidos** | `av` 17.1.0 (Linux) traz FFmpeg **com `libx264` e `libx265` (GPL)** — confirmado por `av.codecs_available` e pelos arquivos em `av.libs/`; o `LICENSE.txt` do pacote só tem o texto BSD. `opencv-python-headless` traz FFmpeg sem x264. Modelos ONNX dentro do `pipecat-ai`: `silero_vad.onnx` e `smart-turn-v3.2-cpu.onnx` |

**Navegador** — necessários ao harness (`npm view`, 28/10):

| Licença | Pacotes |
|---|---|
| BSD-2-Clause | `@pipecat-ai/client-js` 1.15.0, `@pipecat-ai/client-react` 1.10.0, `@pipecat-ai/small-webrtc-transport` 1.11.1 (depende de `@daily-co/daily-js`, BSD-2) |
| MIT / ISC / Apache-2.0 | `react`, `react-dom`, `vite`, `@vitejs/plugin-react`, `tailwindcss`, `@tailwindcss/vite`, `@base-ui/react`, `tailwind-merge`, `react-resizable-panels`, `lucide-react` (ISC), `class-variance-authority` (Apache-2.0) |
| OFL-1.1 | `@fontsource-variable/geist` (fonte) |
| Molde e componentes | Pipecat CLI (molde `react-vite`): BSD-2 (`pipecat-ai/pipecat-cli`). Registro `ui.pipecat.ai`: os itens não declaram licença, mas a fonte é `pipecat-ai/pipecat-ui`, BSD-2 (API do GitHub) |
| Não necessários | O cliente pronto de hoje embute também LiveKit, Daily, MoQ e `@libav.js/variant-opus-af` (**LGPL-2.1**). Nada disso entra se o harness usar só o transporte SmallWebRTC |

**O que isso significa** (análise técnica, não parecer jurídico):

- Todo o **código** a reaproveitar (Pipecat, molde, componentes, cliente) é BSD-2 ou MIT, compatível com o MIT do NewClaw.
  Basta manter os avisos de copyright.
- Os pontos sensíveis são **binários de terceiros**: o FFmpeg com x264/x265 (GPL) no PyAV e as bibliotecas LGPL. Eles só
  pesam quando alguém **redistribui os binários**. Se o harness distribuir só código-fonte e o usuário instalar as
  dependências do PyPI e do npm, quem distribui os binários é o próprio PyPI e o npm.
- Empacotar um ambiente Python pronto, um instalador com wheels ou uma imagem de contêiner muda isso, e exigiria cumprir a
  GPL (decisão L1).
- **Não conferido:** os pacotes do PyAV para Windows (podem ter outro conjunto de codecs); a licença dos dois modelos ONNX
  dentro do `pipecat-ai` (o pacote não traz arquivo de licença próprio para eles).

### 2. Texto até resposta falada

**Mecanismo (código do Pipecat 1.12):**
- `send-text` **não serve**: põe o texto no contexto do LLM (`LLMMessagesAppendFrame`) e não passa pelo TTS sem LLM.
- `client-message` serve: vira um `RTVIClientMessageFrame` no pipeline e dispara o evento `on_client_message`
  (`rtvi/processor.py:496-507`). Um processador do harness transforma `{t: "falar", d: {texto}}` em
  `TTSSpeakFrame(texto, append_to_context=False)`.
- `rtvi.interrupt_bot()` interrompe a fala.

**Pipeline da prova:** `transport.input → VADProcessor(Silero) → Controle → STT → TTS → transport.output`. Não tem LLM, nem
contexto, nem credencial.

| Prova | Resultado |
|---|---|
| Frase curta (48 car.) → primeira fala no navegador | 1,67 s / 1,15 s / 1,08 s (envio da `client-message` → `bot-started-speaking`) |
| Texto longo (231 car.) | Primeira fala em ~4,9 s. Aviso não fatal do Pipecat aos ~3 s: "TTS context … completed with no audio". O Kokoro do lab devolve o WAV inteiro de uma vez, e o Pipecat desiste de esperar aos ~3 s |
| Interrupção pedida pelo cliente durante a fala | O bot parou ~15 ms depois; a fala seguinte saiu normal |
| Interrupção antes de o áudio começar | O áudio pendente foi descartado; a fala seguinte saiu normal |
| STT → `user-transcription` (fala de ~3 s injetada no lugar do microfone) | Evento final no navegador 1,79 s depois; texto "Qual é a previsão do tempo para **manhã** em São Paulo?" (o original dizia "amanhã") |

**Consequências para a Etapa 2:**
- Mandar ao TTS **uma frase por vez**, para começar a falar mais cedo e evitar o aviso de ~3 s. A divisão é por pontuação:
  forma do texto, não significado.
- Provar a interrupção por voz real (VAD → interrupção). O protótipo dela já faz isso com o agregador do LLM; sem o LLM, o
  harness precisa do próprio gatilho.

### 3. Autenticação e segurança da conexão WebRTC

| Fato | Evidência |
|---|---|
| `POST /start`, `POST/PATCH /api/offer` **sem autenticação** | `runner/run.py:682, 1000, 1031`; teste: `/start` respondeu `200` sem credencial |
| CORS do runner reflete **qualquer origem**, com credenciais, se `--allowed-origins` não for passado | `run.py:603-609`; teste: `Origin: http://atacante.example` voltou em `Access-Control-Allow-Origin` |
| HTTP preso a `127.0.0.1` funciona (a rede não alcança a porta) | teste: `10.0.0.5:7861` recusado |
| O áudio usa UDP efêmero na interface da rede (`10.0.0.5:55805`) e o mDNS (5353) | `ss -lunp` durante a sessão |
| Mídia WebRTC é sempre cifrada (DTLS-SRTP); só quem recebeu as credenciais ICE pela sinalização consegue conversar com aquela porta | padrão WebRTC; `aiortc` / `pylibsrtp` |
| STUN do Google só entra se o cliente pedir `enableDefaultIceServers: true` — **o molde do kit pede** | `run.py:752-758`; `config.ts.jinja2` do molde |
| O bot do lab hoje escuta em `0.0.0.0:7860`, sem TLS nem autenticação | `systemd/pipecat-bot.service` |
| O NewClaw só aceita cookie da mesma origem; a única exceção é a do suplemento, uma regra de CORS feita sob medida no núcleo | `security.ts` (`isTrustedOrigin`, `ADDIN_ORIGIN`) |

**Desenho recomendado (H1):** um processo de harness que atende uma origem só.

- Serve a interface.
- Faz o login no NewClaw pela rota pública (`/api/auth/login`) e guarda o token **no servidor do harness**, num cookie
  `httpOnly` e `SameSite=Strict` da própria origem.
- Repassa as chamadas da API de chat ao NewClaw com `Bearer`. O NewClaw vê um cliente de API comum, como hoje: **nenhuma
  regra nova de CORS ou CSRF no núcleo** (ADR-031, regra 7).
- Atende a sinalização WebRTC localmente, com checagem de origem própria.
- O motor de voz fica em `127.0.0.1`, com `--allowed-origins` restrito e sem credencial do NewClaw.
- STUN e TURN só se o usuário declarar; nenhum servidor público por padrão.

**Limitações que ficam:**
- **Token com acesso total:** o token do NewClaw dá acesso à API inteira e não expira; revogar exige trocar a senha. Token com
  escopo seria uma interface nova do núcleo, com ADR própria.
- **Microfone fora do próprio computador:** só com HTTPS. O harness pode terminar TLS com certificado do usuário (como o
  `tls_proxy.py` faz no lab) — decisão H3.

### 4. Configuração de voz portável

Sem nenhum valor do lab. Vazio = recurso desligado e reportado, nunca adivinhado.

| Variável (prefixo do harness) | Para quê | Padrão |
|---|---|---|
| `NEWCLAW_URL` | Endereço do NewClaw que o harness usa | nenhum (obrigatório) |
| `VOZ_STT_URL`, `VOZ_STT_MODELO`, `VOZ_STT_CHAVE` | Transcrição compatível com a API OpenAI (`/v1/audio/transcriptions`) | nenhum. Sem URL = janela só em texto |
| `VOZ_TTS_URL`, `VOZ_TTS_MODELO`, `VOZ_TTS_VOZ`, `VOZ_TTS_CHAVE` | Síntese compatível com a API OpenAI (`/v1/audio/speech`) | nenhum. Sem URL = sem fala |
| `VOZ_IDIOMA` | Idioma do STT (`pt-BR`, `en-US`, `es-ES` — valores que o `Language` do Pipecat aceita) | se vazio, o idioma configurado no NewClaw (lido pela API); se o NewClaw também não informar, ausência reportada |
| `VOZ_ICE_SERVIDORES` | STUN/TURN | nenhum (rede local não precisa) |
| `HARNESS_PORTA`, `HARNESS_TLS_CERT`, `HARNESS_TLS_CHAVE` | Endereço local e HTTPS opcional | só a porta tem padrão local |

O conserto do Kokoro (cabeçalho WAV) e a inclusão da voz configurada na lista de vozes aceitas valem para qualquer servidor
compatível. A lista fixa de vozes do lab (`pf_dora`…) sai.

### 5. Latência por etapa (medida, sem cota)

| Etapa | Medida | Fonte |
|---|---|---|
| Conexão WebRTC (clique → pronto) | 2,33 s | prova, navegador |
| STT direto, fala de ~3 s | mediana 1,26 s (n=5; 1,26–1,29) | prova, `whisper-proxy` do lab |
| STT dentro do pipeline → evento no navegador | 1,79 s (n=1) | prova |
| TTS direto, primeiro byte = total | curto (15 car.) 0,32 s · médio (71 car.) 0,97 s · longo (234 car.) 3,39 s (n=5 cada) | prova, Kokoro do lab |
| `client-message` → primeira fala | 1,08–1,67 s (curto, n=3); ~4,9 s (longo, n=2) | prova, navegador |
| Interrupção | ~15 ms | prova |
| Turno do NewClaw até a resposta | Venus/web 30 d: p50 69,8 s, p90 112,6 s (n=13); Windows/web 30 d: p50 152,7 s (n=126) — mistura conversa e objetivo | `processing_done` dos logs |
| Aceitação (`202`), primeiro progresso, polling | **não medidos** — exigem uma instância isolada do NewClaw. A aceitação e o polling dá para medir sem cota usando `/cancelar` (comando sem modelo) | — |

Leitura: a voz acrescenta ~2–3 s (STT + primeira frase do TTS); o tempo dominante continua sendo o do turno do NewClaw.

### 6. Acompanhamento de tarefas compartilhado, sem duplicação permanente

**Evidência:** o protocolo do turno já existe em duas cópias:
- **Painel:** `index.html` (`startTurnPolling`, `fetchAndRenderOutbox`, `nextPollHealth`, `cancelMessage`).
- **Suplemento:** `addins/powerpoint-addin/src/taskpane/turnPolling.ts`.

O Jarvis seria a terceira.

| Opção | Vantagens | Desvantagens |
|---|---|---|
| a. Cada cliente com sua cópia | Nada muda no núcleo | Três cópias que divergem (já há diferenças entre as duas atuais) |
| **b. Contrato público do turno no núcleo + um cliente público desse contrato** (módulo neutro, sem dependências, servido pelo NewClaw) | Uma definição só; serve painel, suplemento, Jarvis e qualquer cliente futuro; é interface genérica, não "para o Jarvis" (ADR-031, regra 7) | Uma etapa no núcleo antes do harness; migrar o painel e o suplemento depois, com regressão |
| c. Só o contrato documentado, com teste de conformidade, sem cliente comum | Sem código novo de cliente | A duplicação continua, só que vigiada |

**Recomendação: b**, em duas partes:
1. Contrato documentado + teste de conformidade + módulo cliente (núcleo).
2. O Jarvis usa o módulo desde o início; painel e suplemento migram depois, cada um numa etapa com a suíte do chat.

O módulo decide "terminou?" por sinais estruturais (`/active` livre, outbox), nunca lendo o texto da resposta.

### 7. Revisão da D2 (STT sem acoplar o núcleo)

**Antes:** estender o Core para falar também a API OpenAI de transcrição, com uma variável só.

**Agora:** **o Core não muda.** Motivos:
- O harness é dono da própria escuta (ADR-031, regra 1).
- A transcrição em tempo real é do harness, enquanto a nota de voz dos canais é do Core: são perguntas diferentes.
- Ensinar um segundo formato ao Core para servir ao harness seria o núcleo se moldando a um cliente.

O harness fala só a API OpenAI de transcrição, que muitos servidores locais oferecem. O custo é o usuário configurar a
transcrição em dois lugares, se quiser as duas coisas. Unificar fica para uma ADR própria do Core, se um dia o próprio Core
precisar de mais de um formato.

## Arquitetura revisada

```text
                         ┌──────────── harness Jarvis (opcional, outro processo) ─────────────┐
 navegador ──HTTPS?───▶  │ interface (build React/Vite)                                         │
 (uma origem)            │ login → POST {NEWCLAW_URL}/api/auth/login → token guardado no servidor│
                         │ /newclaw/* → repasse com Bearer para a API pública do NewClaw         │
                         │ /api/offer → sinalização WebRTC (checagem de origem)                  │
                         │ motor de voz Pipecat em 127.0.0.1: VAD → STT → user-transcription;    │
                         │                         client-message "falar" → TTS (frase a frase)  │
 navegador ◀─WebRTC──▶   │ sem LLM · sem histórico · sem persona · sem execução                 │
                         └───────────────┬───────────────────────────────────────────────────────┘
                                         │ HTTP + Bearer (só rotas públicas)
                         ┌───────────────▼─────────── NewClaw (núcleo, inalterado) ─────────────┐
                         │ API de chat: /api/chat, /active, /outbox, /cancelar, /auth-decision,  │
                         │ /api/conversations, /api/status · contrato do turno + cliente público │
                         │ Core: memória, contexto, roteamento de modelos, execução              │
                         └───────────────────────────────────────────────────────────────────────┘
```

**Máquina de estados** (no navegador, com o módulo cliente do turno):
- Estados: ocioso → ouvindo → transcrevendo → enviando → pensando → falando → concluído, mais cancelando e erro.
- **Interrupção** só corta o áudio; **Parar** manda `/cancelar`.
- **Ação perigosa:** só por clique, pela rota pública `auth-decision`.
- **Janela fechada:** o trabalho continua no núcleo; ao reabrir, a janela mostra o que chegou, pelo histórico.

## Repositório (R1) — evidência para a decisão

| | Mesmo repositório (`harnesses/jarvis/`) | **Repositório separado** (`newclaw-jarvis`) |
|---|---|---|
| Licenças | A distribuição do NewClaw passa a incluir o harness e o inventário dele | Inventário, avisos e eventuais obrigações ficam só no harness |
| Pilhas | Python + React dentro de um projeto TypeScript; CI e instaladores do núcleo crescem | Cada projeto com a própria CI |
| ADR-031, regra 1 | Verificável por `grep`, mas a pasta convive com o núcleo | Garantida pela fronteira do repositório |
| Compatibilidade | Mesma versão sempre | O harness checa a versão do NewClaw (`/api/status` já expõe `version`) e a do contrato do turno |
| Conveniência | Uma clonagem | Duas |

**Recomendação: repositório separado**, MIT, só com código-fonte e dependências declaradas. Motivos:
- os binários GPL e LGPL que vêm de terceiros;
- a pilha diferente;
- a regra 1 da ADR-031.

**Aprovada em 29/10/2026** (R1).

## Decisões

| # | Decisão | Recomendação | Status |
|---|---|---|---|
| R1 | Onde mora o harness | Repositório separado | **aprovada** (29/10) |
| L1 | Binários GPL/LGPL de terceiros | Distribuir só código-fonte; nunca empacotar ambiente Python, wheels ou contêiner sem análise própria; listar no inventário | **aprovada com ressalvas** (29/10) |
| H1 | Forma do harness | Um processo: interface + login + repasse + sinalização + motor de voz | **aprovada** (29/10) — subprocesso permitido se uma dependência exigir |
| H2 | Frase a frase no TTS | Sim (por pontuação) | **aprovada** pela D4 (29/10) |
| H3 | HTTPS para acesso remoto | O harness termina TLS com certificado do usuário, opcional; sem ele, só `localhost` com microfone | **aprovada com critérios** (29/10) |
| H4 | STUN/TURN | Nenhum por padrão; `enableDefaultIceServers: false` | proposta |
| D1 | Onde o Pipecat roda | Na infraestrutura que o usuário configurar, de preferência junto ao harness; nenhuma máquina nem sistema como requisito | **aprovada** (29/10) |
| D2 | STT | Em tempo real, no harness/Pipecat, com provedor configurável; o texto vai ao NewClaw pela API existente; o Core não muda | **aprovada** (29/10) |
| D3 | Cancelar | Botão Parar, separando "interromper o áudio" de "cancelar a tarefa" (esta com confirmação); comando de voz depois | **aprovada** (29/10) |
| D4 | Resposta longa | Texto aparece aos poucos; fala sintetizada em blocos por frase; resposta completa no histórico | **aprovada** (29/10) |
| D5 | Identidade e sessões | Identidade e memória do NewClaw; sessões explícitas; nenhuma memória no Pipecat; continuar conversas só no que a API oferece | **aprovada** (29/10) |
| D6 | Progresso | Só eventos significativos confirmados pelo backend; nada repetitivo nem fictício | **aprovada** (29/10) |
| D7 | Som e voz | Sinal curto, independente do TTS, quando o pedido é aceito; Kokoro como opção inicial, voz e idioma configuráveis; sem TTS, modo texto | **aprovada** (29/10) |
| D8 | Modelo | Roteamento do Cognitive Kernel preservado; nenhum modelo fixo no harness; mudança só depois de medir por etapa | **aprovada** (29/10) |
| D9 | Link no painel | Nenhum link específico do Jarvis no painel | **adiada** (29/10) — o harness é acessado diretamente |
| D10 | Ao reabrir | Mostrar sem falar, pelo histórico (com o `id` que a lista de conversas dá para o `sessionId`) | mantida, alinhada à D5 |
| D11 | Ação perigosa | Só por clique; nunca por voz (coerente com a D3: nada de efeito por comando de voz nesta fase) | mantida |
| D12–D13 | Supervisão e transporte | O harness cuida de si (sem PM2 do núcleo); SmallWebRTC | revistas |
| D15 | Protocolo do turno | Contrato público + cliente público no núcleo (opção b) | **aprovada e prioritária** (29/10) |

## Decisões da operadora (29/10/2026)

- **R1 — repositório separado.** O Jarvis é um harness opcional noutro repositório. Ele depende do NewClaw por contratos
  documentados; o núcleo não depende dele. O harness não duplica memória, roteamento de modelos nem execução. A estratégia
  de distribuição definitiva respeita a auditoria de licenças.
- **L1 — código-fonte, com ressalvas.** Na primeira versão, nada de ambiente Python pronto nem contêiner com as dependências
  do harness: só o código-fonte e os arquivos de dependências que reproduzem a instalação. Antes de publicar, o harness tem
  de:
  - auditar as licenças diretas e transitivas;
  - verificar os binários de fato instalados, incluindo PyAV/FFmpeg, os pacotes para Windows e os modelos ONNX;
  - documentar versões, avisos e obrigações de redistribuição.

  Distribuir só o código não elimina por si as obrigações das dependências instaladas, e o harness não declara conformidade
  jurídica sem evidência suficiente.
- **H1 — um processo principal.** Simplifica iniciar, configurar, diagnosticar e encerrar. Não obriga tudo na mesma thread,
  e um subprocesso fica permitido se alguma dependência exigir; estabilidade e segurança vêm antes do processo único.
- **H3 — acesso remoto com critérios de segurança:**
  - em `localhost`, uso simples, sem certificado manual;
  - acesso remoto documentado e protegido por HTTPS com certificado confiável;
  - o serviço de voz nunca exposto direto à Internet por padrão;
  - autenticação, autorização e proteção dos tokens valem com ou sem HTTPS;
  - a documentação diz as limitações do token atual do NewClaw: acesso amplo e sem expiração automática.
- **D2 — transcrição no harness.** O STT em tempo real é do harness, e o Core mantém a entrada de voz atual. O Core não muda só
  para compartilhar a configuração de transcrição, e a documentação avisa que o usuário pode precisar configurar o STT nos dois
  recursos.
- **D15 — contrato público de turnos, aprovado e prioritário.** O contrato:
  - nasce das APIs e dos estados reais;
  - evita a duplicação entre painel, suplemento e clientes futuros;
  - preserva os consumidores existentes e tem testes de conformidade;
  - é independente do Jarvis e de qualquer fornecedor de voz;
  - não mexe em memória, roteamento de modelos nem execução.
- **D9 — adiada.** Nenhum link do Jarvis no painel agora. Uma integração futura pode vir por um mecanismo genérico de
  extensões, sem o núcleo depender do Jarvis.

**Etapa 1 autorizada** só para o contrato público de turnos no repositório do NewClaw, sem push nem deploy, sem Pipecat, React
ou dependência do harness no Core, e sem migrar painel nem suplemento. Resultado: `docs/CONTRATO_DO_TURNO.md`.

## Decisões D1–D8 da operadora (29/10/2026): evidência e limitações

As oito decisões foram aprovadas como proposta, sem implementação além da Etapa 1. As instruções que acompanham as decisões:
- conferir as APIs antes de implementar;
- decisão que dependa do que não foi provado → registrar a limitação e propor a menor alteração;
- não tocar a produção nem usar nada do laboratório;
- o Jarvis continua harness opcional (ADR-031).

**D1 — Onde o Pipecat roda.** Na infraestrutura que o usuário configurar, de preferência junto ao harness. Nenhuma máquina
nem sistema operacional é requisito universal.
- **Evidência:**
  - O harness alcança o NewClaw só pelo endereço configurado (`NEWCLAW_URL`, tabela 4) e pelo contrato do turno (HTTP com
    `Bearer`), sem nada de rede local.
  - A Etapa 0 já rodou o motor de voz numa máquina e o NewClaw noutra.
- **Limitação:** os pacotes do Pipecat para Windows não foram verificados, incluindo o PyAV e os codecs que ele traz.
- **Menor alteração proposta:** na Etapa 2, provar o motor de voz em Windows e em Linux. Se um deles não servir, a
  documentação diz isso em vez de restringir o desenho.

**D2 — Transcrição no harness.** STT em tempo real no harness/Pipecat, com provedor configurável. O texto vai ao NewClaw
pela API existente.
- **Evidência:**
  - `POST /api/chat` aceita texto (contrato, operação 1), então o Core não muda.
  - A prova da Etapa 0 gerou o evento `user-transcription` com `OpenAISTTService`, configurado só por ambiente
    (`VOZ_STT_URL`, `VOZ_STT_MODELO`, `VOZ_STT_CHAVE`).
- **Limitação:** o usuário configura a transcrição em dois lugares, se quiser também a nota de voz dos canais (já aprovado
  assim).

**D3 — Cancelar.** Primeiro o botão Parar, separando duas ações:

| Ação | Como | Evidência |
|---|---|---|
| Interromper o áudio | Local, no harness (`rtvi.interrupt_bot()`); o turno segue no NewClaw | Parou em ~15 ms (Etapa 0) |
| Cancelar a tarefa | Com confirmação na interface; depois, `/cancelar` pelo contrato (operação 5) | Na instância isolada: confirmação em 34 ms e o turno cancelado entregue em 220 ms (`⏹ Pedido interrompido.`) |

- **Comando de voz:** fica para uma etapa posterior.
- **Limitação:** nenhuma no núcleo. A confirmação é só da interface.

**D4 — Resposta longa.** O texto aparece aos poucos; a fala é sintetizada em blocos por frase; a resposta completa fica no
histórico.
- **Evidência:**
  - O histórico guarda a resposta inteira (instância isolada: `assistant "⏹ Pedido interrompido."` sob `web:<sessionId>`).
  - Frase a frase (H2) evita o aviso de ~3 s do Pipecat com texto longo (Etapa 0).
- **Limitação:** o NewClaw entrega a resposta **de uma vez**; a outbox não tem fluxo parcial (contrato, operação 4). "Aos
  poucos" só pode ser apresentação: o harness revela o texto frase a frase, no ritmo da fala.
- **Menor alteração proposta:** nenhuma no núcleo agora. Um fluxo parcial de verdade seria uma versão nova do contrato, com
  ADR própria, e só se a medição mostrar necessidade.

**D5 — Identidade e sessões.** Usam a identidade e a memória do NewClaw. As sessões são explícitas, e o Pipecat não guarda
memória.
- **O que a API oferece hoje** (conferido):
  - **Nova conversa:** basta um `sessionId` novo em `POST /api/chat`.
  - **Continuar uma conversa do chat web:** `GET /api/conversations` lista `{ id, sessionId }`; o harness reenvia aquele
    `sessionId` e lê o histórico pelo `id`.
  - **Memória de longo prazo:** é do NewClaw e vale para qualquer canal.
- **Limitações:**
  - A lista só traz conversas do canal web (`provider = 'web'`, `DashboardMemoryRepository.listWebConversations`), então
    continuar uma conversa do Telegram ou do Discord não é possível pela API.
  - O histórico usa `web:<sessionId>`, não o `sessionId` (achado da Etapa 1; com o `sessionId`, volta vazio, sem erro).
- **Menor alteração proposta:** nada no núcleo. O Jarvis usa sessões do canal web, e "continuar" vale para as conversas que
  a lista mostra. Unir conversas entre canais é conceito novo, com ADR própria.

**D6 — Progresso.** Só eventos significativos confirmados pelo backend; nada repetitivo nem fictício.

| Evento | Sinal do backend (contrato, operações 2 e 3) |
|---|---|
| Aceito | `202` com `turnId` |
| Fase mudou | `accepted`, `running`, `awaiting_approval` ou `finished` |
| Relato novo | `progresso` com `em` diferente do anterior (ADR-027, `RELATO_DE_PROGRESSO_MIN`, padrão 5 min) |
| Resposta | Entrega na outbox |

- **Regra:** o harness fala ou mostra só quando um desses sinais muda.
- **Limitação:** entre relatos não há sinal nenhum, e `accepted` pode durar enquanto o modelo classifica (4 s na instância
  isolada, sem relato). A interface mostra "trabalhando" e o tempo (`elapsedMs`), sem inventar etapas.

**D7 — Som e voz.**
- **Sinal de aceito:** curto, quando chega o `202`, gerado pela própria interface e independente do TTS.
- **Kokoro:** pode ser a opção inicial, como exemplo documentado de servidor compatível com a API OpenAI de síntese. Voz e
  idioma vêm de `VOZ_TTS_VOZ` e `VOZ_IDIOMA`. Vazios, a ausência é reportada: nenhuma voz é escolhida no código.
- **Sem TTS:** sem `VOZ_TTS_URL`, a janela funciona em modo texto (tabela 4).
- **Evidência:** a Etapa 0 provou a fala via `client-message` → `TTSSpeakFrame`, com o conserto do cabeçalho WAV, que serve
  a qualquer servidor compatível.
- **Limitação:** a lista de vozes e de idiomas aceitos depende do servidor de TTS do usuário.

**D8 — Modelo.** O roteamento do Cognitive Kernel é preservado e o harness não tem modelo fixo.
- **Evidência:**
  - A prova da Etapa 0 roda sem LLM nenhum no pipeline.
  - A resposta vem só do NewClaw, pelos perfis dele.
  - O contrato acrescenta milissegundos: aceitação 6 ms e consulta 16 ms de mediana (Etapa 1).
  - O tempo dominante é o do turno: Venus p50 69,8 s; Windows p50 152,7 s (Etapa 0).
- **Limitação:** a latência por tipo de turno com modelo real não foi medida numa instância isolada (precisa de OK de cota).
- **Próximo passo:** medir na Etapa 6, por etapa, antes de qualquer proposta de mudança.

**Alinhamento com a matriz:**
- **D1:** volta à tabela, com o sentido novo.
- **H2:** aprovada pela D4.
- **D10:** passa a usar o `id` que a lista dá ao `sessionId`.
- **D11:** coerente com a D3 (nada de efeito por comando de voz nesta fase).
- **D9, D12–D13 e D15:** não mudam.

## Etapa 1 — resultado (29/10/2026)

**Menor alteração compatível.** O contrato descreve as rotas que já existem, e nenhuma delas mudou de comportamento. No
núcleo, a etapa entregou:

| O quê | Onde | Por quê |
|---|---|---|
| Documento do contrato, versão 1 | `docs/CONTRATO_DO_TURNO.md` | A definição pública: operações, fases, comportamentos reais, consumidores |
| `TURN_CONTRACT_VERSION = 1` | `src/dashboard/routes/chat.ts` | A versão mora junto das rotas que a cumprem |
| `status.contracts.turn` | `src/dashboard/routes/status.ts` | O cliente confere a versão antes de usar (ADR-031, regra 5). Campo aditivo |
| Cliente público | `src/dashboard/public/turn-client.js` | A implementação única do protocolo, servida em `/turn-client.js` (estático, como `shared.js`) |
| Teste de conformidade | `src/__tests__/regression/S457_ContratoDoTurno_Conformidade.test.ts` | Impede o documento e o servidor de divergirem |

O cliente público é um módulo ES sem dependências e sem DOM, com `fetch` injetável. Ele decide a fase só por sinais
estruturais e não conhece cliente, canal nem fornecedor de voz; o `S457` confere isso no código.

**Gate "extensão antes de criação":**
- O cliente público é arquivo novo, porque nenhuma das duas cópias serve como ele.
  - A do suplemento mora fora do núcleo, que não pode depender dela (ADR-031, regra 1), e só lê a outbox.
  - A do painel está dentro do script da página.
- O teste é novo porque nenhum teste existente sobe as rotas reais com os dois clientes.
- A versão e o campo de status são extensões de arquivos que já existiam.

**Achados que o contrato registra (comportamento real, não alterado):**
- **Aviso de fila:**
  - Com a conversa ocupada, o aviso de fila é a primeira entrega do `turnId`, e a resposta final sai depois com o mesmo
    `turnId`.
  - Se ninguém tiver retirado o aviso, a resposta final o substitui na outbox.
  - Não há campo que marque a entrega como provisória.
- **Complemento de objetivo:** a mensagem enviada durante um objetivo recebe só a nota "Anotado".
- **A fase `accepted` pode durar:** enquanto a classificação espera o modelo, o turno não aparece em `active` (na instância
  isolada, 4 s inteiros).
- **O histórico não usa o `sessionId`:** a chave é `web:<sessionId>`, e ela vem da lista de conversas. Com o `sessionId`, a
  lista volta vazia, sem erro.
- **O painel usa uma reserva:** sem a própria conversa em `active`, ele usa "a primeira conversa ativa". O cliente público
  casa pelo id exato.

**Validação:**
- **Linha de base antes da mudança:** 449/451 (2 ignorados, 0 falhas).
- **Depois da mudança:** 450/452 — o `S457` novo passou, sem falhas, inconsistências nem timeouts. Os 2 ignorados são os mesmos de antes.
- **`S457`:** 61/61, em quatro execuções seguidas.
- **Tipos e build:** `tsc --noEmit` e o build (`tsc`) passaram.
- **Instância isolada, com um provedor local que não responde:** os números estão em `docs/CONTRATO_DO_TURNO.md`,
  seção "Validação".
  - A versão anunciada foi 1, igual à do cliente.
  - A aceitação levou 6 ms de mediana, e uma consulta a `/active`, 16 ms.
  - O cancelamento confirmou em 34 ms; o turno cancelado recebeu `⏹ Pedido interrompido.` em 220 ms, e as duas mensagens
    ficaram no histórico.
- Nenhuma chamada a modelo e nenhuma cota usada.

**Limitações que ficam:**
- **Token:** dá acesso total e não expira.
- **Entrega provisória:** o aviso de fila não tem marcação estrutural; distinguir exigiria um campo novo, que viria numa
  versão nova do contrato, com decisão própria.
- **Histórico:** o formato das rotas não foi congelado.
- **Migrações:** o painel e o suplemento ainda têm as próprias cópias, e migrá-los é a etapa 7.
- **Fluxo com modelo real:** não foi exercitado (precisa de OK de cota); o `S457` cobre as entregas pelas mesmas chamadas que
  o `MessageBus` faz ao adapter.

## Etapas seguintes (cada uma só com autorização)

| Etapa | Onde | O que entrega | Pronto quando |
|---|---|---|---|
| 1 — Contrato público do turno (**feita em 29/10**, seção "Etapa 1 — resultado") | núcleo (único ponto do núcleo) | Contrato documentado e versionado; teste de conformidade na suíte; módulo cliente neutro servido pelo NewClaw; aceitação e polling medidos sem cota (via `/cancelar`) numa instância isolada | Teste de conformidade e suíte completa passando; nenhum comportamento do chat muda |
| 2 — Motor de voz | harness | Pipeline da prova, com frase a frase, interrupção por VAD real, configuração da tabela 4, sem LLM | Testes das funções puras; interrupção por voz real provada; sem configuração, sai com aviso claro |
| 3 — Servidor do harness | harness | Login, repasse com Bearer, sinalização com checagem de origem, TLS opcional, verificação de requisitos e de versão | Testes de segurança: sem login → 401; outra origem → recusada; motor de voz inalcançável pela rede |
| 4 — Janela Jarvis | harness | Interface React a partir do molde, só com o transporte SmallWebRTC; estados; modo texto; Parar; aprovação por clique; histórico | Testes da máquina de estados; build reproduzível; inventário de licenças gerado |
| 5 — Instalação e documentação | harness | Ativação que verifica requisitos; guia; avisos de terceiros | Instalação limpa em Windows e Linux; NewClaw sem harness idêntico |
| 6 — Validação real | ambos | Instância isolada, LLM real só com OK de cota | Os testes de aceitação (T1–T15 das versões anteriores) |
| 7 — Migrações opcionais | núcleo | Painel e suplemento passam a usar o cliente público | Suíte do chat e do suplemento iguais |

## Fase 5 — Validação da proposta

- **Evidência:** todas as afirmações desta revisão vêm de teste ou de leitura de código; o que falta está nomeado.
- **Estrutural:** o núcleo ganha só uma interface pública genérica; o Jarvis vive fora dele.
- **Complexidade:** o núcleo não cresce com Python, React nem exceções de CORS; a duplicação do protocolo do turno passa de
  duas cópias (e uma terceira a caminho) para uma.
- **Reversível:** remover o harness não muda nada no NewClaw.

## Achados laterais (registrados, não corrigidos)

- Outbox sem expiração (`WebChannelAdapter.ts:121-133`).
- Token do painel sem revogação individual e com acesso total (`auth.ts:202-225`).
- Acoplamentos do suplemento do PowerPoint dentro do núcleo (exceção de CORS, prefixo de sessão, broker) — candidatos à
  migração para o contrato público.
- STT local do Core com `--language pt` fixo (`agentMediaHandlers.ts:273`).
- Bot do lab em `0.0.0.0:7860` sem TLS nem autenticação (infraestrutura dela).

## Como a Etapa 0 foi feita (rastro)

- **Leitura:**
  - **Marte:** pacotes do ambiente Python e código do Pipecat instalado.
  - **Venus e Windows:** logs.
  - **npm e GitHub:** só metadados de licença.
- **Prova:**
  - **Motor de voz:** script temporário no Marte (porta 7861, `127.0.0.1`), usando o Whisper e o Kokoro locais do lab só
    como os "serviços do usuário".
  - **Cliente de teste no PC:** `@pipecat-ai/client-js` 1.15.0 e `small-webrtc-transport` 1.11.1, com a sinalização por
    túnel SSH.

  Ao terminar, processo, túnel e pasta temporária foram removidos. Os serviços `pipecat-bot` e `pipecat-tls` seguiram
  ativos e intocados.
- **Nenhuma** chamada a modelo de nuvem, **nenhuma** mudança no NewClaw nem nas produções.
