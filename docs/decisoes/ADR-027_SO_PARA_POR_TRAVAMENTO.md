# ADR-027 — O trabalho só para por travamento, nunca por relógio

Data: 23/10/2026. Status: **aceita** pela operadora ("não quero nenhum limite fixo; os limites são para verificar parada
(travamento) do sistema, não parar por tempo se o sistema está trabalhando corretamente"). Completa a ADR-023 (comando), a
ADR-024 (chamada do modelo em tokens) e a ADR-025 (trabalho não se perde).

## Fase 1 — Compreensão

**O que já parava só por travamento** (ADR-023/025): o comando (30 s sem nenhum sinal de saída, CPU ou disco/rede) e os
ciclos do objetivo (12 ciclos **sem avanço**; passo concluído não conta).

**O que ainda cortava trabalho em andamento:**

| Corte | Onde | Medido |
|---|---|---|
| Relógio do objetivo (30 min; no modo aviso, até 90 min) | `GoalExecutionLoop` (dois pontos) e `GoalStore.expireStale()`, que abandonava até o goal que estava executando | VPS, 22–23/10: o goal do Nether instalou o mod em ~10 min, seguiu verificando e foi encerrado aos 30 min como "não finalizei" |
| O mesmo relógio como teto de tudo dentro do objetivo | `executarComPrazo(expiresAt)` → `prazoDoTurno()`: teto das chamadas (`orcamentoPeloTrabalho`), dos juízes (`ValidationEngine`) e dos comandos (`exec_command`) | — |
| Teto fixo da chamada com streaming (`MAX_TIMEOUT`) e o timer de tentativa do `ProviderFactory` | `OllamaProvider.streamChat`, `ProviderFactory.chatWithFallbackImpl` | 58 cortes no Windows, 42 na VPS. VPS, 23/10 00:15: cortada aos 32,6 s com 866 pedaços de raciocínio chegando (9.357 caracteres descartados) |
| Juiz cortado no fim da "fatia" por ter passado do orçamento em tokens ou do teto do objetivo | `ValidationEngine.decidirNoPrazo` | CI Windows (22/10): o S431 mediu esse corte |
| Conferência da resposta (Q4) desiste aos 12 s e aprova | `AgentLoop` (`COMMIT_TIMEOUT_MS`) | 72 de 422 no Windows (17%), 24 de 282 na VPS (9%) |
| Juiz de qualidade abortado aos 60 s | `AgentLoop` (validação do observador) | — |
| Comando sem `timeout` explícito: teto de 30 min | `exec_command` (`PRAZO_PADRAO_MS`) | — |

**A detecção de travamento já existia** na chamada com streaming: `CONNECTION_TIMEOUT` (nenhum pedaço desde o início:
150–300 s, pelo tamanho do prompt, o tempo de leitura) e `ACTIVITY_TIMEOUT` (nenhum pedaço desde o último: 90 s). Na VPS,
a segunda agiu 77 vezes.

## Fase 2 — Crítica

- **Um modelo que gera para sempre.** Não é travamento: é trabalho que não termina. Quem o limita é o tamanho, não o
  tempo: o limite de tokens que o provedor já recebe dos juízes (`num_predict`, ADR-024) e a janela de contexto do modelo.
  O "Parar" e o `/cancelar` continuam valendo.
- **Um comando que trabalha para sempre** (`tail -f`, servidor em primeiro plano): também não é travamento. Sem o teto de
  30 min, só o usuário o encerra, ou o agente (`acompanhar` / `encerrar`). Por isso o relato de progresso (abaixo) faz
  parte desta decisão: quem espera precisa ver o que está acontecendo.
- **Provedor sem streaming** (o servidor compatível com OpenAI do modelo local; provedores nativos): não há sinal de
  progresso — "pensando" e "travado" são indistinguíveis enquanto duram. Ali o prazo pelo trabalho medido (ADR-024)
  continua. É a exceção declarada; sai quando o `OpenAIProvider` tiver streaming (já pedido na ADR-024/025).
- **Esperas pelo usuário** (aprovação de ação perigosa, 5 min; esclarecimento, 10 min; goal parado à espera) não são
  trabalho do sistema: continuam com prazo. A limpeza de goals vencidos passa a valer **só** para goal que não está
  executando.
- **Chamadas de rede das ferramentas** (busca, clima, página, Kokoro, embeddings) têm prazos próprios de conexão. Elas não
  informam progresso, e o prazo detecta rede parada. Ficam fora desta ADR, registradas como próximo passo.

## Fase 3 — Alternativas

1. **Prorrogar o relógio avisando** (ADR-024 etapa 6, o "modo aviso"): ainda corta no limite duro. Descartada pela
   operadora.
2. **Aumentar os números:** continua cortando, mais tarde. Descartada.
3. **Só travamento** (escolhida): reaproveita o que já existe (silêncio do streaming, sinal do comando, ciclos sem avanço,
   orçamento de replanejamentos), sem detector novo.

## Fase 4 — Decisão

1. **Chamada com streaming** (`OllamaProvider`): sai o `MAX_TIMEOUT`. Fica só o silêncio: `CONNECTION_TIMEOUT` (sem
   primeiro pedaço) e `ACTIVITY_TIMEOUT` (90 s sem pedaço; configurável, `SILENCIO_DO_MODELO_S`). O provedor declara que
   vigia o silêncio (`vigiaSilencio`), e o `ProviderFactory` não arma relógio próprio para ele. A refação sem streaming,
   que não tem sinal de progresso, segue com o prazo de quem chamou.
2. **Juízes** (`ValidationEngine`): no fim da fatia, o juiz só é interrompido se estiver em silêncio. Orçamento de tokens e
   teto do objetivo não interrompem mais; o limite de tokens continua indo ao provedor. O segundo modo de raciocínio é
   tentado quando o primeiro falha, sem depender do relógio.
3. **Objetivo:** sem relógio. Ele termina quando conclui, quando o usuário para, ou por travamento: 12 ciclos sem avanço,
   replanejamentos esgotados, ou silêncio nas chamadas e nos comandos. Saem o `executarComPrazo(expiresAt)`, as duas
   checagens de expiração e o modo aviso (`LIMITE_DO_OBJETIVO_COMO_AVISO`, `LIMITE_DURO_DO_OBJETIVO_MIN`). O
   `expires_at` passa a ser só o prazo de um goal **parado à espera**; `expireStale()` pula os goals em execução.
4. **Comando:** sem `timeout` explícito do agente, não há teto. Fica a tolerância sem atividade (30 s).
5. **AgentLoop:** a conferência da resposta (Q4) espera o juiz, e o juiz de qualidade deixa de ser abortado aos 60 s.
   Ambos já são protegidos pelo silêncio da chamada.
6. **Relato de progresso:** durante um objetivo, a cada `RELATO_DE_PROGRESSO_MIN` (padrão 5; `0` desliga), uma mensagem
   no mesmo canal diz há quanto tempo o objetivo roda, os passos concluídos desde o último relato e o passo atual. O texto
   é montado a partir de fatos (descrições do plano), sem chamada de modelo e sem cota. Valores do cofre são mascarados.

## Fase 5 — Validação

- Evidência real: os cortes medidos acima, em produção, nas duas máquinas.
- Problema estrutural: o relógio media duração, não travamento. Esta ADR troca a pergunta, não os números.
- Complexidade: diminui. Saem o teto fixo, o modo aviso, o limite duro e o teto do objetivo em quatro consumidores.
  Entra um relato determinístico.
- Reversível por commit. Testes: `S444` (chamada), `S445` (objetivo e relato). Reescritos para a regra nova: `S426`
  (agora "limite só para espera"), `S431`, `S349`, `S290`, `S283`, `S421`, `S423`, `S415`, `S438`, `S352`, `S376`,
  `S186`, `S156`, `S293`. Suíte completa: 433/440 com o código final, e os 5 restantes reescritos e passando.

**Decisões do code-review (23/10/2026, aprovadas pela operadora):**
- **Validação em segundo plano** (`tryValidateTool`): sem o abort de 60 s, ela podia disputar a GPU/fila com o pedido
  seguinte. Ela é interrompida quando o **próximo pedido do usuário na mesma conversa** começa (não no fim do turno: começa no
  meio dele e quase sempre termina depois da resposta; abortá-la ali apagaria o que grava na `ReflectionMemory`). Passos de
  objetivo não interrompem (eles se sucedem em segundos — quase nenhuma validação terminaria), nem uma chamada que será
  rejeitada como concorrente. Resultado de uma validação interrompida é descartado. Cobertura: `S447`.
- **Conferência Q4**: continua esperando o juiz (coerente com esta ADR). A acompanhar: a demora da resposta com ferramenta.
- **Turno de conversa longo** (fora de objetivo): também relata o progresso a cada `RELATO_DE_PROGRESSO_MIN`, com o status do
  turno (ferramenta em uso, pensando, montando a resposta). Turno que é passo de objetivo (`goalTrace`) não relata — o
  objetivo já relata. Cobertura: `S447`.

**Riscos que ficam (registrados, não resolvidos aqui):**
- **Espera na fila do provedor** (`taskQueue`, 15 vagas): sem o relógio de fora, uma chamada na fila espera a vez sem
  prazo. Só acontece com mais de 15 chamadas simultâneas; o "Parar" vale quando ela começa.
- **Relato em pt-BR:** é texto fixo do Core, como as outras mensagens fixas (débito de idioma já declarado em
  `ARCHITECTURE.md`, "Gaps conhecidos").
- **Classificação rápida** (`GoalExtractor`, `UnifiedIntentRouter`) desistia de propósito no prazo curto para cair na
  heurística. Agora ela espera o modelo terminar ou ficar em silêncio.

## Revisão 1 — todos os provedores (14/11/2026)

A exceção declarada na Fase 2 ("provedor sem streaming") saiu: `OpenAIProvider` (e os derivados OpenRouter, Groq e DeepSeek,
mais todo servidor compatível cadastrado, como o modelo local), `AnthropicProvider` e `GeminiProvider` passaram a fazer
streaming e declaram `vigiaSilencio`. O `ProviderFactory` não arma prazo de duração para nenhum deles.

**Pesquisa (14/11/2026).** O padrão atual do mercado são dois relógios, e só pedaço com conteúdo conta:
[Vercel AI SDK](https://ai-sdk.dev/v7/docs/ai-sdk-core/settings) (`timeout.firstChunkMs` e `chunkMs`; metadados, delta vazio
e atividade de transporte não reiniciam), [LangChain](https://reference.langchain.com/python/langchain-openai/chat_models/base/BaseChatOpenAI/stream_chunk_timeout)
(`stream_chunk_timeout`, 120 s; comentário de keepalive não reinicia), BAML (`idle_timeout_ms`) e o desenho de
[stream inactivity timeout do Qwen Code](https://qwenlm.github.io/qwen-code-docs/pt-BR/design/2026-06-24-stream-inactivity-timeout-design/).
Formatos conferidos nas fontes: o [OpenRouter](https://openrouter.ai/docs/api-reference/streaming) manda comentários SSE para
manter a conexão; a [Anthropic](https://platform.claude.com/docs/en/api/messages-streaming) intercala eventos `ping`; o
streaming OpenAI devolve `usage` num último pedaço sem `choices` com `stream_options.include_usage`.

**Decisão.**
1. Fonte única dos relógios: `src/core/streamVigiado.ts` (`VigiaDeSilencio`, `consumirStreamSSE`, `TelemetriaAoVivo`,
   `isChunkActive`). O `OllamaProvider` usa o mesmo vigia; antes, os relógios viviam só nele.
2. Só pedaço com conteúdo do modelo reinicia os relógios: texto, raciocínio, chamada de ferramenta, fim. Keepalive (comentário
   SSE, `ping`) e delta vazio não reiniciam.
3. Correção de `isChunkActive`: `candidates[0]` vazio (Gemini) e toda moldura de bloco (`content_block_start` de texto,
   `content_block_stop` da Anthropic) contavam como atividade.
4. Prazo do primeiro pedaço: a base de antes (150–300 s pelo tamanho do prompt). Quando o medidor tem a velocidade de leitura
   medida pelo servidor para o modelo (ADR-024), vale o maior entre a base e `tokens ÷ leitura × 1,5`, sem teto. Motivo: o
   modelo local lê a ~21 tokens/s (S440); com o OpenAI-compatível em streaming, um prompt grande passaria de 300 s calado.
5. Transporte sem prazo próprio (`headersTimeout`/`bodyTimeout` 0) em todos os provedores com streaming: o vigia decide.
6. A telemetria ao vivo (`pedacosAteAgora`, `ultimoPedacoEm`) passa a vir de todos os provedores — o juiz
   (`ValidationEngine.decidirNoPrazo`) depende dela para não cortar quem ainda gera.
7. Stream cortado: o texto já recebido vem marcado como interrompido (issue 060), mas a chamada de ferramenta incompleta é
   descartada — sem `finish_reason` (OpenAI-compatível) ou sem `content_block_stop` (Anthropic) os argumentos podem estar pela
   metade, e executá-la seria agir sobre um pedido que o modelo não terminou (achado do code-review; `S483-9`).
8. O limite de tokens chega à telemetria como `length` em todos os provedores (Anthropic `max_tokens`, Gemini `MAX_TOKENS`),
   o vocabulário que o medidor (`observacaoDaChamada`) já usa.

**Riscos que ficam.**
- Servidor compatível que ignora `stream: true` e responde o JSON inteiro: é lido como antes, mas sem sinal de progresso; o
  único limite passa a ser o prazo do primeiro pedaço.
- Primeira chamada de um modelo local lento com prompt muito grande, antes de qualquer medição: o prazo do primeiro pedaço é a
  base (até 300 s). O `return_progress` do llama-server daria progresso da leitura do prompt, mas é parâmetro fora do contrato
  OpenAI e não foi ligado.
- Servidor compatível estrito que recuse `stream_options` (parâmetro oficial da OpenAI) responderia erro HTTP — o erro diz o que
  o servidor respondeu.

Testes: `S483` (novo: silêncio corta nos quatro formatos; keepalive e delta vazio não reiniciam; geração longa e ativa com prazo
de 300 ms não é cortada; chamada de ferramenta em pedaços; telemetria ao vivo; `isChunkActive`; leitor SSE; prazo pela leitura
medida). Reescritos para a regra nova: `S444` (o OpenAIProvider agora vigia), `S438` (o transporte nunca tem prazo próprio) e
`S366-1` (o prazo de quem chamou não corta o servidor local gerando; o silêncio corta; nenhuma reserva). `S191`, `S192` e `S263`:
os servidores falsos ganharam o `content-type` que um `fetch` real sempre tem. Mutação: sete versões erradas do código
(ping como atividade, `candidates[0]` vazio como atividade, delta vazio como atividade, silêncio que não reinicia, Anthropic sem
`vigiaSilencio`, elo do sinal desligado depois dos cabeçalhos, argumentos do Gemini perdidos) — o `S483` reprova todas.
O próprio `S483` achou um defeito na primeira versão: o elo sinal → `fetch` era desligado depois dos cabeçalhos, e o corte do
vigia não chegava à leitura do corpo.
