# ADR-029 — O objetivo nasce do pedido entendido pela conversa, não do texto cru

Data: 24/10/2026. Status: **aceita** — incremento 1 aprovado pela operadora, implementado (S449; afetados 266/266) e
**validado em teste real na nuvem** (ver Fase 5). Pedido dela: "ele está com problema de contexto
entre as conversas", "não quero reinventar a roda: analise como os agentes atuais funcionam e resolvem isso".

## Fase 1 — Compreensão

### O que aconteceu (VPS, Telegram, 24/10/2026)

| Hora | Conversa | O que o NewClaw fez |
|---|---|---|
| 11:24 | "Conhece o aplicativo camscanner?" → explicou | — |
| 11:26 | "Eu queria criar uma versão desse programa, utilizando Rust e HTML é possível?" → disse que sim | — |
| 11:32 | **"Pode fazer?"** | Objetivo gravado: `"Pode fazer?"`. Plano: "redigir a resposta de confirmação de capacidades"; os passos mexeram com **rustscan** (cargo, rustc). 9 min. |
| 11:51 | "Quando falei de pode fazer estava me referindo a criar uma versão tipo camscanner…" | Ela teve de corrigir; aí fez o CamScanner. |
| 12:05 | **"Essa porta é muito comum, consegue verificar nas redes 10.0.0.0/24 e 192.168.3.0/24?"** | O plano começou pela **porta 30000 do Luanti** (assunto de dias antes); 3 replanejamentos até a 8080. 24 min. |

### A causa, medida

1. **O sistema entendeu o pedido — e jogou o entendimento fora.** O juiz de suficiência (ADR-015), que já roda em todo
   pedido com ferramenta ou objetivo e já recebe a conversa recente, escreveu no log:
   - 11:32: *"A ação implícita (construir a versão do CamScanner em Rust+HTML) é definida pela conversa recente"*;
   - 12:05: resolveu *"Porta a ser verificada = 8080"* (*"do CamScanner Axum, está na conversa recente"*).

   O consumidor (`GoalOrchestrator`) usa só `acao` (seguir/perguntar). O entendimento não chega a lugar nenhum.
2. **O objetivo é o texto cru.** `goal.objective = classification.objective || message` (`GoalOrchestrator.ts:574`). No
   caminho heurístico do `GoalExtractor` (`usedLLM=false` — os dois casos), `objective` é a própria mensagem. Nos últimos
   30 dias, 16 de 23 objetivos da VPS nasceram com o objetivo igual ao texto cru.
3. **O planejador não recebe a conversa.** `GoalPlanner` monta o prompt com `OBJETIVO GLOBAL` e `INTENÇÃO ORIGINAL` (os
   dois "Pode fazer?") e um bloco "CONTEXTO (memória…)" buscado na memória **pelo texto do objetivo**. Com "Pode fazer?",
   a busca por palavra-chave trouxe Nether/VM17, servidor Luanti e auditoria do portal — foi por aí que o assunto antigo
   entrou. Os passos do agente (`AgentLoop`) veem o histórico da sessão, mas executam o plano já errado.
4. **O contexto do objetivo anterior entra só na classificação** (`recent goal context injected for classification`) —
   decide se é objetivo, não diz qual é.

**Não foi a compressão da sessão:** no "Pode fazer?", ela resumiu mensagens antigas (Nether) e manteve literais as últimas
6 (`maxContextMessages`), inclusive as do CamScanner — o mesmo padrão da OpenAI (manter os últimos N turnos, resumir o
resto). Registrado abaixo como risco menor.

### Tentativas anteriores no projeto
- `CONTENT_REF_PATTERN` (`GoalPlanner.ts:163`): regex que detecta "esse conteúdo"/"o que eu enviei" e manda o planejador
  buscar na memória — avisa que há referência, não diz qual; e é regex interpretando significado
  (`RESPONSABILIDADE_ANTES_DO_MECANISMO`, proibido).
- "Sugestão 3" (`recentCompletedGoals`): injeta o goal anterior na **classificação**.
- ADR-015 (suficiência): já resolve o referente — é a peça que falta ligar.

## Como os agentes atuais resolvem (pesquisa, 24/10/2026)

O padrão consolidado tem nome: **reescrever a pergunta de acompanhamento como pergunta autônoma** ("standalone / condensed
question"), usando o histórico, **antes** de buscar e de planejar.

- **LangChain** — `create_history_aware_retriever` (substituto do `ConversationalRetrievalChain`): um passo de prompt
  *"formulate a standalone question which can be understood without the chat history"*, com a instrução *"Do NOT answer
  the question, just reformulate it if needed and otherwise return it as is"*. A pergunta reescrita — não a crua, nem a
  conversa inteira — vai para a busca: só a nova pergunta "pode não ter o contexto"; a conversa inteira "distrai".
- **LlamaIndex** — `CondenseQuestionChatEngine` / `CondensePlusContextChatEngine`: a cada mensagem, condensa histórico +
  mensagem numa pergunta autônoma, busca com ela e só então responde.
- **OpenAI Agents SDK** (cookbook de memória de sessão): histórico com corte dos últimos N turnos + resumo do restante.
- **Anthropic** (Effective context engineering): compactação só perto do limite da janela, preservando decisões e
  detalhes, descartando saídas redundantes; busca "just-in-time".
- **Letta/MemGPT**: mensagens recentes em contexto; as antigas viram resumo recursivo, com busca no histórico completo.
- **LangGraph** (plan-and-execute): o planejador lê o estado compartilhado, que inclui as mensagens.

O NewClaw já tem as partes de histórico (últimas 6 literais + resumo; busca na memória). Falta a primeira etapa do padrão:
**o pedido autônomo**, usado no objetivo e na busca.

## Fase 2 — Crítica (Responsabilidade antes do Mecanismo)

| | |
|---|---|
| **Pergunta** | O que, exatamente, o usuário está pedindo — entendido sem a conversa? |
| **Responsabilidade** | Interpretar o pedido à luz da conversa recente (semântica → LLM, nunca regex). |
| **Evidência** | O pedido + a conversa recente + preferências/memória — exatamente as entradas que o juiz de suficiência já recebe. |
| **Autoridade** | O juiz de suficiência (ADR-015): já é quem decide "o pedido basta?", e para isso já resolve o referente (log de 11:32 e 12:05). |
| **Estado** | `goal.objective` (campo que já existe; hoje = texto cru). `goal.userIntent` continua sendo o texto literal. |
| **Consumidor** | `GoalPlanner` (OBJETIVO GLOBAL), a busca de memória do plano (`objective + userIntent`), replanejador e validadores que já leem `goal.objective`. |

Motivos para NÃO fazer, e a resposta:
- **O modelo pode reescrever errado (inventar).** O texto literal continua no prompt do planejador (`INTENÇÃO ORIGINAL`); a
  instrução proíbe acrescentar o que não está escrito; os dois vão para o log. Nos 3 pedidos reais de hoje o juiz
  resolveu certo.
- **Custo.** Nenhuma chamada nova: um campo a mais na resposta de uma chamada que já existe (dezenas de tokens de saída).
  Regra de custo do projeto: substituir, nunca somar.
- **Juiz novo?** Não — estende o tipo existente (`camposExtras`, o mesmo mecanismo de `pergunta_ao_usuario`).
- **E quando o juiz não roda** (`sem_veredito`, `VALIDACAO_SUFICIENCIA=off`, pedido sem ferramenta)? Fica o comportamento
  de hoje — sem regressão.

## Fase 3 — Alternativas

1. **(recomendada) Pedido completo pelo juiz de suficiência.** Campo extra `pedido_completo` no tipo
   `suficiencia_do_pedido`; o `GoalOrchestrator` grava-o em `goal.objective`. É o padrão da LangChain/LlamaIndex,
   implementado na chamada que já resolve o referente. Zero chamada nova.
2. **Chamada própria de reescrita** (o desenho literal da LangChain). Funciona, mas soma uma chamada por mensagem e um
   segundo juiz para a mesma pergunta. Descartada pela regra de custo e de juiz único.
3. **Dar a conversa recente ao planejador** (estilo LangGraph). Ajuda, mas não conserta a busca de memória (que continua
   com "Pode fazer?"), engorda todo prompt de plano/replanejamento e espalha a mesma responsabilidade por vários
   consumidores. Fica como complemento possível, se a medição mostrar que o objetivo resolvido não basta.
4. **Sempre usar o LLM no `GoalExtractor`.** Ele produz `objective` quando roda, mas é mais uma chamada nos casos em que a
   heurística decide — e é uma segunda autoridade sobre a mesma pergunta.
5. **Regex de referência** (ampliar `CONTENT_REF_PATTERN`). Proibido: regex interpretando significado.

## Fase 4 — Proposta

**Incremento 1 (o conserto):**
- `suficienciaDoPedido.ts`: campo extra `pedido_completo` — "Reescreva o pedido do usuário como um pedido completo,
  entendível sem a conversa: substitua referências ('isso', 'pode fazer?', 'essa porta') pelo que está ESCRITO na
  conversa recente. Não acrescente nada que não esteja escrito; não responda ao pedido. Se ele já é completo, copie igual."
  O adaptador devolve `pedidoCompleto` na decisão.
- `GoalOrchestrator`: `objective = decisao.pedidoCompleto || classification.objective || message`; `userIntent` continua o
  texto literal. Log `[PEDIDO-COMPLETO] cru="…" completo="…"`.
- Teste de regressão novo (S449): os dois casos de hoje como entrada; o objetivo sai resolvido; sem veredito → texto cru;
  o prompt do planejador traz os dois (completo e literal).
- Teste real: na instância isolada, repetir a sequência das 11:24–12:05 (CamScanner → "Pode fazer?" → "Essa porta…").

**Incremento 2 (só se a medição pedir):** usar o pedido completo também como consulta de memória do turno de conversa
(caminho sem objetivo), hoje feita com o texto cru.

**Achado paralelo (decisão separada):** o resumo da compressão é extrativo e pobre (guarda a primeira linha das mensagens
do usuário; perdeu "criar uma versão em Rust e HTML" no checkpoint das 12:05). As 6 últimas mensagens literais cobrem os
casos de hoje; vale medir antes de mexer.

**Riscos que ficam:** reescrita errada (mitigada pelo texto literal no prompt e pelo log); texto em pt-BR conforme o idioma
do pedido (o juiz escreve no idioma da mensagem).

## Fase 5 — Validação

- Evidência real: 2 incidentes no mesmo dia, com o entendimento correto já presente no log do juiz.
- Estrutural: liga o entendimento que existe ao estado que o consome; elimina a lacuna "classificação entende, plano não".
- Complexidade: um campo extra e uma linha no consumidor; nenhum componente novo.
- Reversível por commit; sem veredito → comportamento de hoje.

**Teste real no Strata (24/10/2026, instância isolada) — não conclusivo para esta correção.** A sequência CamScanner →
"criar em Rust e HTML" → "Pode fazer?" foi repetida duas vezes. Na segunda (sessão limpa, modo DEVELOPER), o juiz de
suficiência entendeu "desse programa" = CamScanner, mas no "Pode fazer?" o **roteador foi cortado pelo prazo fixo do provedor
sem streaming** (30 s, `cortada_pelo_relogio` — 9 vezes na sessão), caiu na rota por palavras-chave ("conversa") e o pedido
não passou pelo juiz nem virou objetivo: o caminho desta correção não foi exercitado. É o limite já registrado na ADR-027
(streaming no `OpenAIProvider`). Sem veredito, o comportamento foi o de antes, como previsto. O teste real que vale fica para
um modelo com streaming (nuvem, com cota autorizada) ou depois do streaming no provedor local.

**Teste real na nuvem (24/10/2026, `glm-5.3-flash:cloud` em todos os `MODEL_*`, instância isolada, modo DEVELOPER, cota
autorizada pela operadora; 42 chamadas) — passou.** A mesma sequência da produção:

| Mensagem | Pedido completo (`[PEDIDO-COMPLETO]`) | Plano |
|---|---|---|
| "Pode fazer?" (depois do CamScanner em Rust e HTML) | "Pode criar uma versão do aplicativo CamScanner, utilizando Rust e HTML?" | verificar o Rust → gerar o projeto `camscanner` → compilar → subir e testar o servidor → empacotar → entregar |
| "Essa porta é muito comum, consegue verificar nas redes 10.0.0.0/24 e 192.168.3.0/24." (depois de a conversa fixar a 8080) | "A porta 8080 é muito comum, consegue verificar nas redes 10.0.0.0/24 e 192.168.3.0/24." | script de varredura da **8080** nas duas redes → executar → identificar o serviço |

Na produção, os mesmos pedidos viraram "redigir a confirmação de capacidades" (com rustscan) e a auditoria da porta 30000.
Os dois objetivos foram cancelados logo depois do plano para poupar cota (a varredura não chegou a rodar). `userIntent`
continuou o texto literal; 0 erros no log.

**Achados do teste, fora do escopo (registrados):**
- A mensagem de objetivo cancelado ("Não consegui completar: …") cita o texto literal ("Pode fazer?"), não o pedido
  completo — poderia citar `objective`.
- Recusar pelo botão a autorização de um passo de objetivo não limpa a pendência do `AuthorizationManager`: a mensagem
  seguinte ("Pode fazer?") foi tratada como aprovação por texto da transação recusada — nada executou (`[WF] not_found`),
  mas o pedido da usuária foi consumido como aprovação.
- No Strata, uma resposta saiu como o JSON cru do protocolo de ação (`{"thought": …, "action": {"type": "final_answer" …}}`).

## Fontes
- LangChain — [ConversationalRetrievalChain / create_history_aware_retriever](https://reference.langchain.com/python/langchain-classic/chains/conversational_retrieval/base/ConversationalRetrievalChain)
- LlamaIndex — [Condense Plus Context Chat Engine](https://developers.llamaindex.ai/python/examples/chat_engine/chat_engine_condense_plus_context/), [Condense Question](https://developers.llamaindex.ai/python/framework-api-reference/chat_engines/condense_question)
- OpenAI — [Agents SDK: session memory (trimming e compressão)](https://developers.openai.com/cookbook/examples/agents_sdk/session_memory)
- Anthropic — [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Letta — [Agent memory & architecture](https://docs.letta.com/guides/agents/architectures/memgpt)
