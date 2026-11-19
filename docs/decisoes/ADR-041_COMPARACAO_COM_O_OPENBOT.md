# ADR-041 — O que o OpenBot traz que vale para o NewClaw

Data: 18/11/2026. Status: **aceita** (18/11/2026). A operadora decidiu: D1 (a1), manter a ADR-018 sem reserva;
D2 recusada (b1), só corrigir o agendador; D3 (c1) e D4 (d1) recusadas por enquanto. Ela também mandou corrigir o
agendador na mesma hora (S489).

**Correção da premissa da D2 (18/11/2026).** A D2 foi aprovada primeiro como b2 e refeita no mesmo dia, ao conferir
o código para implementá-la. A tarefa agendada do NewClaw entrega a resposta no mesmo chat que a criou
(`AgentController.ts`, handler de `SCHEDULER_TRIGGER` → `sendToChat` com o `chatId` da tarefa). Não há publicação
para terceiros a aprovar, ao contrário do OpenBot. O risco de um turno sem ninguém olhando são as ações que ele
executa, e essas já passam pelo gate da ADR-005, conforme o modo global. Com a premissa corrigida, a operadora
escolheu b1.

Relacionadas: ADR-005 (gate de ação perigosa), ADR-018 (só os modelos escolhidos pelo usuário), ADR-027 (só para por
travamento), ADR-028 (memória: apagar só com confirmação), ADR-030 (canal de voz), ADR-035 (skills portáveis),
ADR-038 (contexto do turno por necessidade), `docs/ARCHITECTURE/SOBERANIA_DA_CONFIGURACAO.md`,
`docs/ARCHITECTURE/REUTILIZACAO_ANTES_DA_CRIACAO.md`.

## Fase 1 — Compreensão

### O pedido

A operadora (18/11/2026) viu o lançamento do OpenBot (`https://openbot.run/`) e avaliou que o NewClaw "ficou defasado".
Ela pediu uma comparação em forma de ADR, com o que vale trazer para cá.

### O que é o OpenBot (fontes lidas em 18/11/2026)

Fontes: `https://openbot.run/`, `https://openbot.run/pricing` e o README de `https://github.com/nightly-labs/openbot`.
Cerca de metade do README foi lida na íntegra; o resto veio resumido. Os documentos de arquitetura, Docker e
privacidade que o README cita **não foram lidos**.

- **O que é.** App de desktop (Electron; macOS, Windows e Linux) com "colegas de IA" persistentes. Cada agente tem nome,
  instruções, pasta de trabalho e conversa próprios. Há apps de iOS e Android que se conectam ao desktop ou a um
  servidor.
- **Quem faz.** Synthetify Labs (Polônia). Lançamento anunciado em 14/09/2026. O site diz que sai versão quase todo
  dia. O repositório tinha 8,9 mil estrelas em 18/11/2026.
- **Não tem agente próprio.** Ele coordena os CLIs de agente que já existem: Codex, Claude Code, Gemini, Grok, OpenCode,
  Cursor, Cline, Kimi, Copilot e outros, pelo CLI de cada fornecedor ou pelo protocolo ACP (Agent Client Protocol).
  Também aceita Ollama, LM Studio e qualquer endpoint compatível com OpenAI. Usa o login do CLI, ou seja, a assinatura
  que a pessoa já paga, em vez de cobrança por API.
- **Vários agentes juntos.** Agentes nomeados conversam entre si, passam tarefas e dividem arquivos em salas de chat
  ("channels") que também têm pessoas. Cada sala tem um dono da tarefa e controles de parar, retomar e reatribuir.
- **Troca de provedor sem perder a conversa.** Quando o plano acaba ou o provedor cai, o agente passa para um modelo
  reserva de outro provedor e mantém a conversa e a pasta de trabalho.
- **Fluxos agendados.** Sequências de passos com gatilho (o exemplo é "toda segunda às 9h") e etapa de aprovação humana
  antes de publicar. Fila de mensagens que sobrevive a falhas.
- **Memória.** Compactação automática do contexto antes de encher a janela do modelo. Nenhum sistema de memória geral
  é descrito.
- **Verificação do resultado.** Nenhuma, além da aprovação humana nos fluxos.
- **Segurança.** O README avisa que os agentes rodam com `danger-full-access` e `approvalPolicy: never`, isto é, sem
  pedir confirmação por ação. Só o navegador embutido roda em sandbox.
- **Canais.** Telegram, WhatsApp e voz **não aparecem** no que foi lido.
- **Licença.** PolyForm Noncommercial 1.0.0. Não é open source pela definição da OSI; uso comercial é pago. O resumo do
  README diz que as versões até a 0.1.11 eram Apache-2.0. **Isso não foi conferido** nas releases.

### O que o NewClaw tem (conferido no código do `main`, 947e2f1)

| Tema | NewClaw | OpenBot |
|---|---|---|
| Agente | Laço próprio (`src/loop/AgentLoop.ts`, `GoalOrchestrator.ts`, `GoalPlanner.ts`) | Usa os CLIs de terceiros |
| Verificação do resultado | Juízes padronizados (`src/validation/motorPadrao.ts`, `ValidationEngine.ts`) | Nenhuma; só aprovação humana |
| Ação perigosa | Gate com aprovação pelo canal (ADR-005, `AuthorizationManager.ts`, `auth:approve`) | Nunca pede confirmação |
| Canais | Telegram, WhatsApp, Discord, Signal, web (`src/channels/`) e voz (ADR-030) | Desktop e apps de celular |
| Memória | Grafo, episódica, procedural, casos (`src/memory/`); apagar só com confirmação (ADR-028) | Compactação do contexto |
| Compactação | `SessionManager.maybeCompress` + `ContextCompressor.ts` | Automática por agente |
| Provedores | Ollama, OpenAI, Anthropic, Gemini, DeepSeek, Groq, OpenRouter e provedores próprios | CLIs, Ollama, LM Studio, OpenAI-compatível |
| Troca de provedor | **Não existe, por decisão** (ADR-018): `getFallbackOrder` devolve só o provedor declarado | Automática, para modelo reserva |
| Agendamento | `SchedulerService.ts` + `schedule_tool.ts`; cada disparo vira um turno com `[AGENDADO]` | Fluxos com gatilho e aprovação |
| Vários agentes | Não existe | Salas com agentes e pessoas |
| Skills | Aprendidas (ADR-017), portáveis (ADR-035) | Marketplace de plugins; skills só para agentes Hermes |

Leitura honesta: os dois resolvem problemas diferentes. O OpenBot é um **painel que coordena agentes de terceiros**; o
NewClaw é um **agente com juízes, memória e gate de segurança próprios**, que conversa pelos canais de mensagem. O
OpenBot está na frente em trabalho de vários agentes juntos, acabamento da interface, apps de celular e velocidade de
lançamento. O NewClaw está na frente em verificação, segurança, memória, canais e voz.

### Achado durante a comparação: o agendador interpreta errado as expressões cron

Ao conferir o agendamento para comparar com os fluxos do OpenBot, a leitura de `SchedulerService.ts` mostrou dois
defeitos. Eles foram **medidos** em 18/11/2026, às 13h30, chamando `parseTimeInput` e `msUntilNext` do próprio código:

| O que se pede | Cron gravado | Efeito |
|---|---|---|
| `0 9 * * 1` (segunda, 9h) | `0 0,1,9 * * *` | Dispara **todo dia** às 0h, 1h e 9h |
| `*/15 * * * *` (a cada 15 min) | `0 15 * * *` | Dispara **uma vez por dia**, às 15h |
| `30 8 * * *` (8h30) | `0 8,30 * * *` | Dispara às 8h00; "30h" não existe |
| `0 8,12,18 * * *` | `0 0,8,12,18 * * *` | Ganha um disparo extra à meia-noite |
| `8h, 12h, 18h` | `0 8,12,18 * * *` | Certo |
| `toda segunda 9h` | `0 9 * * *` | Dispara **todo dia**; o dia da semana some sem aviso |

As causas:

1. `parseTimeInput` (linha 74) só aceita uma expressão cron pronta se ela casar com `^[\d*/,-]+$`. O espaço entre os
   campos não está nessa lista, então nenhuma expressão cron passa. Ela cai no leitor de horários, que pega cada
   número como se fosse uma hora.
2. `msUntilNext` (linha 196) só lê os campos de minuto e hora. Dia do mês, mês e dia da semana são ignorados.

A descrição da ferramenta (`schedule_tool.ts:25`) oferece o formato cron ao modelo. Então o modelo pode pedir algo
certo e o agendador gravar outra coisa, sem avisar ninguém. É **defeito**, não decisão: a correção não depende das
decisões abaixo e é pré-requisito da D2.

## Fase 2 — Crítica das ideias candidatas

Cinco ideias do OpenBot foram examinadas. Para cada uma, o objetivo foi achar motivos para **não** trazê-la.

### A. Troca automática de provedor quando o atual falha

- **Conflito direto com a ADR-018**, aceita e validada em uso real: "nenhum modelo em código nem de reserva". A reserva
  automática foi removida de propósito, depois de tentativas registradas com um modelo que ninguém tinha escolhido.
- **Conflito com `SOBERANIA_DA_CONFIGURACAO.md`**, *exceto* se a troca for permitida por política declarada pela
  usuária **e** ficar visível no resultado entregue. Essa é a única forma compatível.
- **"Manter a conversa" já é de graça no NewClaw.** A sessão, a memória e a pasta de trabalho pertencem ao NewClaw, não
  ao provedor. O OpenBot precisa disso porque cada CLI guarda o próprio estado; aqui esse problema não existe.
- Risco: os juízes têm perfil por modelo (`perfilDoJuiz.ts`). Uma troca no meio do turno muda quem julga.

### B. Fluxo agendado com etapa de aprovação antes de publicar

- O NewClaw já tem as duas metades: o agendador (cada disparo vira um turno normal) e o gate de aprovação pelo canal
  (`createWorkflowCallback`, `auth:approve:<txnId>`). Nada novo precisa existir.
- Hoje o gate só pede aprovação para ação **perigosa** (ADR-005). ~~"Aprovar antes de enviar" um relatório agendado
  é outra pergunta: o turno agendado roda sem ninguém olhando, e o envio é o que sai para fora.~~ **Errado** (ver a
  correção no topo): o envio vai para o próprio chat de quem agendou; não sai para fora.
- Risco: aprovação que ninguém responde. Ela precisa de um destino quando expira, sem disparar nada sozinha.
- Não vale nada enquanto o agendador gravar o horário errado (achado acima).

### C. Vários agentes nomeados numa sala compartilhada

- É um conceito central novo: identidade por agente, roteamento entre agentes, dono da tarefa. Risco alto de criar um
  objeto que faz tudo, contra a filosofia de "poucos componentes bem entendidos".
- **Não há evidência de necessidade.** Nenhuma medição, issue ou pedido da operadora mostra um caso que um agente só,
  com goals e sub-turnos, não atenda.
- O custo de tokens multiplica: cada agente na sala lê a conversa. A medição de 17/11 já mostra o contexto como a maior
  alavanca de custo.

### D. Usar os CLIs de agente (Codex, Claude Code) como provedor, pela assinatura

- Atraente pelo custo: assinatura em vez de API.
- Mas um CLI de agente **é outro agente**, com ferramentas, laço e regras de parada próprios. Chamá-lo como "provedor"
  passaria por cima do gate da ADR-005 (as ferramentas são dele, não do NewClaw), dos juízes (o resultado chega pronto)
  e da ADR-027 (o laço dele tem prazos próprios).
- Os termos de uso de cada assinatura sobre uso automatizado não foram conferidos.

### E. App de celular

- Telegram e WhatsApp já são o "app de celular" do NewClaw, e a voz (ADR-030) cobre o uso sem tela. Um app próprio
  duplicaria canais que já funcionam.

### O que não trazer de jeito nenhum

- **Agente sem pedir confirmação** (`danger-full-access`, `approvalPolicy: never`). É o oposto da ADR-005.
- **Código do OpenBot atual.** A licença PolyForm Noncommercial não permite. Ideias podem ser estudadas e reimplementadas.
  Se um dia for preciso código, só das versões Apache-2.0, depois de conferir a licença na release e dando o crédito.

## Fase 3 — Alternativas

| Ideia | Alternativas | Escolha proposta |
|---|---|---|
| A | (a1) não fazer; (a2) reserva **declarada pela usuária no painel**, desligada por padrão, anunciada na resposta; (a3) reserva automática como no OpenBot | a1 ou a2; a3 recusada (ADR-018) |
| B | (b1) só corrigir o agendador; (b2) corrigir + opção "aprovar antes de enviar" por tarefa, reusando o gate do `WorkflowEngine`; (b3) motor de fluxos com vários passos | b1 (escolhida depois da correção da premissa); b3 recusada (cria motor novo) |
| C | (c1) não fazer; (c2) "persona" por canal ou por conversa, com um agente só; (c3) vários agentes como no OpenBot | c1 |
| D | (d1) não fazer; (d2) CLI de agente como **ferramenta** chamada pelo NewClaw, sob o gate da ADR-005; (d3) CLI como provedor | d1 agora; d2 só com caso real |
| E | (e1) não fazer; (e2) app próprio | e1 |

Gate de Extensão antes de Criação (para a correção do agendador, a única que muda código):

1. Precisa de arquivo de produção novo? **Não.** A leitura do cron fica dentro de `SchedulerService.ts`.
2. Já existe biblioteca de cron nas dependências? **Não** (conferido em `package.json` e `node_modules`). Uma nova
   dependência para ~60 linhas de leitura de cron não se paga.
3. Arquivos mudados: `SchedulerService.ts` e `schedule_tool.ts` (descrição do formato e mensagem de recusa). Arquivo
   novo só o teste `S489`.

## Fase 4 — Síntese e decisões para a operadora

**Correção, não decisão:** corrigir o agendador, com teste de regressão que reprove o código antigo nos casos da
tabela da Fase 1. Feito em 18/11/2026 (`S489`, 43 verificações; contra o código antigo, 17 falham antes de o teste
quebrar):

- `proximoDisparo(cron, depoisDe)`: lê os cinco campos (`*`, número, `a-b`, `/n`, listas; dia da semana 0–7; dia do
  mês **ou** dia da semana quando os dois estão restritos) e devolve `null` para expressão inválida ou sem data nos
  próximos 5 anos.
- `parseTimeInput`: expressão cron válida é gravada como veio. Lista de horários só é aceita se for **só** horários,
  com o mesmo minuto. Qualquer outra palavra recusa a entrada inteira, em vez de sumir.
- `createTask` recusa expressão inválida. `startAll` não agenda tarefa antiga com expressão inválida: registra o fato
  no log.
- O teto de 24 h do `setTimeout` agora só recalcula; antes disparava a tarefa ao chegar nele.
- `describeCron` diz o dia da semana ("9h às segundas"). Quando a expressão não cabe nessa forma, mostra a própria
  expressão e o próximo disparo.
- `schedule_tool` recusa campo fora do esquema, dizendo quais e onde a informação cabe. Achado na execução real
  abaixo: o modelo mandou `frequency: "weekly"` e `day: "monday"`, que eram ignorados sem aviso.

Execução em ambiente real (18/11/2026, instância isolada: pasta, banco e porta 3191 próprios, sem canal de mensagem;
modelo Bonsai 27B local em todos os papéis; pedidos pelo chat web):

| Pedido | Código | O que aconteceu |
|---|---|---|
| "Crie um agendamento: toda segunda-feira às 9h…" | sem a recusa de campo | O modelo mandou `frequency`/`day`/`time: "09:00"`; gravou `0 9 * * *`. O juiz do passo viu "9h todo dia" na saída nova e acusou a diferença. O replanejamento trocou para `memory_write`, e a resposta final disse que o agendamento semanal foi criado (falso) |
| O mesmo pedido | com a recusa de campo | Gravou `0 9 * * 1`; resposta "toda segunda-feira às 9h" |
| "…cotação do bitcoin todo dia às 8:30 e às 12h" | com a recusa | Não chegou ao agendador: o plano `[schedule, schedule, read]` foi rejeitado por `response_contract_without_answer_step`; o replanejamento derivou para o Agendador de Tarefas do Windows por `exec_command`, que parou no gate da ADR-005 |

Os dois desvios das linhas 1 e 3 (juiz de conclusão aprovando o que o passo anterior acusou; plano rejeitado por
contrato de resposta) são do laço de objetivos e dos juízes, anteriores a esta correção, e ficam registrados para
tratamento próprio.

Fica para o deploy: as tarefas já gravadas nas produções podem ter expressões deformadas pelo código antigo. As
inválidas (ex.: `0 8,30 * * *`) deixam de disparar e aparecem no log; as válidas mas erradas (ex.: `0 0,1,9 * * *`
no lugar de `0 9 * * 1`) seguem disparando como estão gravadas. É preciso conferir a tabela `scheduled_tasks` das duas
produções antes de publicar.

| # | Pergunta | Opções | Recomendação |
|---|---|---|---|
| D1 | Reserva de provedor? | (a1) não; (a2) reserva declarada no painel, desligada por padrão, anunciada na resposta | a1. A ADR-018 está validada e não há medição de quanto se perde hoje quando o provedor cai. Se ela quiser a2, primeiro medir as quedas no `newclaw-audit.log` |
| D2 | Aprovar antes de enviar no agendado? | (b1) só corrigir o agendador; (b2) corrigir + opção por tarefa | b1 (refeita; ver a correção da premissa no topo) |
| D3 | Vários agentes? | (c1) não; (c2) persona por conversa | c1. Sem evidência de necessidade |
| D4 | CLIs de agente? | (d1) não; (d2) como ferramenta sob o gate | d1. Revisitar com um caso real e com os termos de uso conferidos |

Riscos que continuam: a comparação usa o que foi lido em 18/11; o OpenBot muda quase todo dia. Os documentos de
arquitetura dele não foram lidos, então detalhes internos (como a fila e a compactação funcionam) não estão
comparados.

## Fase 5 — Validação

- **Baseada em evidência?** Sim para o NewClaw (código conferido e agendador medido). Para o OpenBot, no que o site e o
  README dizem, sem rodar o produto.
- **Estrutural ou sintoma?** A correção do agendador é estrutural (o formato de entrada inteiro estava errado). D1–D4
  são de produto.
- **Reduz a complexidade?** Nenhum componente novo; a correção fica dentro do `SchedulerService`.
- **Elimina fontes de verdade múltiplas?** Não se aplica; nenhuma nova é criada.
- **Mantém a filosofia do Cognitive Kernel?** Sim: o gate e os juízes continuam onde estão.
- **Incremental e reversível?** Sim: a correção do agendador é local a dois arquivos.
