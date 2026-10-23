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
