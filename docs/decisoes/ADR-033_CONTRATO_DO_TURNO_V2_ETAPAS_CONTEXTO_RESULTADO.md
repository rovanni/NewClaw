# ADR-033 — Contrato do turno, versão 2: etapas, contexto e resultado

Data: 31/10/2026. Status: **aceita** (aprovada integralmente pela operadora em 04/11/2026, "Operação Zero Pendências").
Etapas 1 a 5 (servidor) implementadas em 04/11/2026: `src/shared/contratoDoTurno.ts`, rotas de `src/dashboard/routes/chat.ts`,
`turn-client.js` e `docs/CONTRATO_DO_TURNO.md` na versão 2; cobertura `S474` (e `S457` para a versão 1). Etapa 6 (clientes)
no mesmo PR, em commit próprio: o painel marca 🎙 pelo `cliente` (`S467`); a interface de voz (repositório `newclaw-ivox`,
commit `cd304a0`) manda `client`, mostra as etapas e o selo do resultado.

Decisões de implementação que a proposta deixava em aberto:
- **Modelo da última resposta (§4):** a chamada que é a resposta da conversa se marca em `diag.respostaDaConversa` (o turno
  do `AgentLoop` e o resumo da entrega do objetivo); juízes e planejador não se marcam. O registro é por chave da conversa
  (`canal:usuário`, que o turno passou a carregar). A resposta pelo caminho não-streaming não diz o modelo: o registro some.
- **`cliente` (§4):** gravado no `meta` da mensagem na transcrição; `/context` devolve o da primeira mensagem que o trouxe.
  O `MessageBus` o tira do `metadata` antes de entregar ao núcleo, e o `S474` confere que o núcleo recebe a mesma coisa com e
  sem ele.
- **Revisão (§2–§3):** cobre etapas, estado, plano e relatos; com `desdeRevisao` igual, `etapas` e `relatos` ficam de fora.
- **Aviso de fila (§5):** o relato do trabalho em curso não some quando sai o aviso `provisoria`; o `waitForTurn` do cliente
  público continua esperando a resposta final (o aviso vai para `onProvisional`).

Relacionadas: `docs/CONTRATO_DO_TURNO.md` (versão 1), ADR-027 (relato de progresso), ADR-030 (interface de voz), ADR-031
(experiências opcionais dependem só de contratos), `docs/ARCHITECTURE/EVIDENCE_PROVIDER_PATTERN.md`,
`docs/ARCHITECTURE/NUNCA_ADIVINHAR.md`, `docs/ARCHITECTURE/SOBERANIA_DA_CONFIGURACAO.md`.

## Fase 1 — Compreensão

### O pedido

A interface de voz mostra hoje, durante um trabalho longo, só uma fase (`accepted`, `running`, `awaiting_approval`,
`finished`) e o **último** relato de progresso. A operadora pediu que um cliente possa mostrar:

1. as etapas reais da execução (o que foi feito, o que está em andamento, o que falta);
2. eventos de progresso;
3. o contexto da sessão;
4. o canal de interação;
5. o modelo de linguagem usado, quando disponível;
6. o estado e o resultado das tarefas;

com limites claros do que é exposto, **sem** usar o `/api/status` como fonte e com um contrato genérico, que sirva a
qualquer cliente (painel, suplemento do PowerPoint, interface de voz, clientes futuros).

### O que já existe no núcleo (fonte de cada informação)

| Informação | Onde vive hoje | Exposta pelo contrato v1? |
|---|---|---|
| Etapas de um objetivo | `Goal.currentPlan: PlanStep[]`, com `status` `pending` / `executing` / `completed` / `skipped` / `failed` (`src/shared/domainTypes.ts`) | Não |
| Troca de plano | `Goal.planGeneration` (+1 a cada substituição total do plano) | Não |
| Estado do objetivo | `GoalStatus`: `active`, `executing`, `blocked`, `replanning`, `completed`, `failed`, `abandoned` | Só `active[].status` enquanto executa |
| Progresso | `progressoAtual(conversationId)` do `WebChannelAdapter` (ADR-027): último relato, substituído pelo próximo | Sim (`progresso`, só o último) |
| Modelo usado | `ProviderFactory`: `modelUsed` de cada tentativa, no log e na telemetria; **não** associado à conversa | Não |
| Canal | Prefixo da chave de sessão (`web:<sessionId>`, `telegram:<id>`; `SessionKeyFactory`) | Indiretamente (`id` do histórico) |
| Resultado do turno | Só o texto da entrega; falha chega como texto (contrato v1, "Comportamentos", item 4) | Não como dado |

### Achado relacionado (a corrigir junto)

Em 30/10/2026, para o painel mostrar 🎙 nas conversas faladas, a lista do painel passou a reconhecer o prefixo `voz-` do
`sessionId`, uma convenção da interface de voz. Funciona, mas é conhecimento de um cliente dentro de outro. É o mesmo
problema do item 4 acima: o contrato não diz por qual cliente a conversa chegou.

## Fase 2 — Crítica da hipótese

A hipótese inicial seria "expor o objetivo inteiro". Motivos para **não** fazer isso:

- **Vazamento operacional.** `PlanStep.toolArgs` traz comandos, caminhos e conteúdo de arquivos; `result` traz saídas de
  comando; as tentativas trazem vereditos de juízes e raciocínio. Nada disso é necessário para mostrar progresso, e parte
  pode conter segredos lidos de arquivos.
- **Acoplamento ao formato interno.** `PlanStep` e `GoalStatus` mudam com o motor (ARCH-007 acrescentou
  `lastAttemptOutcome`; `replanning` e `blocked` são estados internos). Expor o tipo cru congela a implementação.
- **O cliente passaria a decidir.** Com `lastAttemptOutcome`, um cliente poderia "concluir" sucesso ou falha por conta
  própria. Pelo Evidence Provider Pattern, quem decide o resultado é o núcleo; o cliente mostra.
- **Troca de plano.** Um replanejamento substitui as etapas. Um cliente que guarda etapas antigas mostraria um plano que
  não existe mais.
- **Modelo "configurado" no lugar de "usado".** Ler o modelo da configuração seria adivinhar (`NUNCA_ADIVINHAR`): o
  `ProviderFactory` pode ter trocado de provedor numa falha (RFC-005). Só vale o que de fato respondeu.
- **`/api/status`** traz nome da máquina, pid e memória do processo; por isso a interface de voz já não o repassa. Usá-lo
  como fonte de contexto reabriria essa exposição.
- **Custo.** O `/active` é consultado a cada 1,5 s por cliente. Mandar o plano inteiro em toda consulta multiplica o
  tráfego sem mudança nenhuma.

Questionário de `RESPONSABILIDADE_ANTES_DO_MECANISMO.md`:

| Ponto | Resposta |
|---|---|
| Pergunta | "Em que ponto está o trabalho desta conversa, e com que resultado terminou?" |
| Responsabilidade | O motor de objetivos (estado e etapas) e o `ProviderFactory` (modelo que respondeu). O contrato só publica. |
| Evidência | `Goal.currentPlan`, `Goal.status`, `planGeneration`, a tentativa bem-sucedida do `ProviderFactory`. |
| Autoridade | O núcleo. O cliente nunca infere estado ou resultado a partir do texto. |
| Estado | Já existe, exceto "modelo usado por conversa", que é um registro novo, só de leitura. |
| Consumidor | Qualquer cliente do contrato; o primeiro é a interface de voz, o segundo é o painel. |

## Fase 3 — Alternativas

| # | Alternativa | Vantagem | Desvantagem |
|---|---|---|---|
| A | Expor o `Goal` cru | Nada a desenhar | Vazamento, acoplamento, cliente decidindo (Fase 2) |
| B | Ampliar o `/active` com tudo | Uma rota só | Payload grande a cada 1,5 s, mistura dado vivo com dado de sessão |
| C | **Visão pública própria** (projeção do estado interno), com **revisão** para só mandar o que mudou, e rota separada de contexto | Pequena, estável, sem detalhe operacional | Uma projeção para manter |
| D | Eventos por SSE/WebSocket | Sem consulta periódica | Novo canal, reconexão, outro caminho de autenticação; o polling atual mede 16 ms por consulta |

**Escolhida: C**, com D registrada como evolução possível. O polling atual é barato (contrato v1, "Validação") e todos os
clientes já o usam.

## Fase 4 — Decisão (proposta)

### 1. Versão e descoberta

- O contrato passa a **versão 2**. Tudo é **aditivo**: um cliente da versão 1 continua funcionando sem mudança.
- A versão vai em `GET /api/chat/context` (abaixo), além de `status.contracts.turn`. Um cliente não precisa mais do
  `/api/status` para saber a versão.

### 2. Etapas reais — `trabalho` em `GET /api/chat/active`

Campo novo, só quando há um objetivo desta conversa (`sessionId` informado):

```json
"trabalho": {
  "tipo": "objetivo",
  "estado": "executando",
  "revisao": 17,
  "plano": 2,
  "etapas": [
    { "id": "s1", "descricao": "Coletar os logs de hoje", "estado": "concluida" },
    { "id": "s2", "descricao": "Analisar os registros de erro", "estado": "executando" },
    { "id": "s3", "descricao": "Consolidar o diagnóstico", "estado": "pendente" }
  ]
}
```

- **`estado` do trabalho:** `executando` | `aguardando_aprovacao` | `replanejando` | `concluido` | `falhou` |
  `cancelado`. É uma projeção estável de `GoalStatus`; `active` e `blocked` sem aprovação viram `executando`.
- **`estado` da etapa:** `pendente` | `executando` | `concluida` | `pulada` | `falhou`, de `PlanStep.status`.
- **`descricao`:** o texto que o planejador escreveu para a etapa, inteiro. Nunca `toolName`, `toolArgs`, `result`,
  tentativas, vereditos ou raciocínio.
- **`plano`:** `planGeneration`. Quando muda, o cliente descarta as etapas que tinha: o plano foi substituído.
- **`revisao`:** número que só cresce, alterado a cada mudança de etapa, estado ou plano. Com
  `GET /api/chat/active?...&desdeRevisao=17`, o servidor omite `etapas` se nada mudou. Isso mantém a consulta de 1,5 s
  leve.
- **Conversa simples** (sem objetivo): `trabalho` ausente. O contrato não inventa etapas para quem não tem plano.

### 3. Eventos de progresso

- O `progresso` da versão 1 continua (último relato, ADR-027).
- Campo novo `relatos`: os **últimos 20** relatos desta conversa, `{ texto, em }`, do mais antigo ao mais novo, com a
  mesma `revisao` para não repetir. Mais de 20: os antigos saem, e a resposta diz `relatosOmitidos: N` (corte declarado).
- O texto do relato continua sendo do núcleo, como hoje (a mesma origem do ADR-027).

### 4. Contexto da sessão e canal — `GET /api/chat/context?sessionId=<conversa>`

```json
{
  "success": true,
  "contrato": 2,
  "conversa": { "sessionId": "voz-633dc7d7", "id": "web:voz-633dc7d7", "criadaEm": "…", "mensagens": 55 },
  "canal": "web",
  "cliente": "newclaw-ivox",
  "modelo": { "nome": "glm-5.3-flash:cloud", "provedor": "ollama", "em": "…" }
}
```

- **`canal`:** o adaptador por onde a conversa entra (`web`, `telegram`, `discord`, `whatsapp`, `signal`), lido da chave de
  sessão pelo `SessionKeyFactory`, nunca deduzido pelo cliente.
- **`cliente`:** campo novo e **opcional** em `POST /api/chat` (`client`: até 64 caracteres, `[a-z0-9._-]`), gravado na
  conversa na primeira mensagem. **É só informativo:** nenhuma decisão do núcleo pode depender dele (teste de
  conformidade). Resolve o achado da Fase 1: o painel mostra 🎙 por `cliente`, sem conhecer convenção de outro cliente.
- **`modelo`:** o modelo e o provedor da **última chamada que respondeu** num turno desta conversa (a resposta final, não
  os juízes), com a hora. Ausente quando não se sabe (`NUNCA_ADIVINHAR`): conversa nova, servidor reiniciado. Nunca o
  modelo configurado. Exige um registro novo, só de leitura: `conversa → última tentativa bem-sucedida`, alimentado pelo
  `ProviderFactory`. Fica em memória: reiniciar o servidor apaga.
- Sem `sessionId` válido: `404`.

### 5. Estado e resultado da tarefa — `resultado` na outbox

`GET /api/chat/outbox` ganha, quando a entrega vem de um objetivo:

```json
"resultado": { "estado": "concluido" | "falhou" | "cancelado" | "parcial", "etapas": { "total": 4, "concluidas": 3 } }
```

- O `estado` é o que o núcleo já decidiu: `GoalStatus` final mais o `lastAttemptOutcome` das etapas (`parcial` quando
  terminou com etapa de confiança baixa). O cliente mostra o selo; não decide.
- A entrega do aviso de fila (contrato v1, item 1) ganha `provisoria: true`, e o cliente sabe que a resposta final ainda
  vem.

### 6. Limites de exposição (regra do contrato, com teste)

**Pode** sair pelo contrato: textos que o núcleo escreveu para a pessoa (descrição de etapa, relato, resposta), estados,
contagens, horários, nome do modelo e do provedor.

**Nunca** sai: `toolArgs`, saídas de comando, conteúdo de arquivo lido, caminhos internos de dados, vereditos e raciocínio
de juízes, prompts, endereço/host/porta de provedor, chaves de API, nome da máquina, pid, memória do processo, dados de
outra conversa (exceto o `active` da versão 1, mantido como está).

O teste de conformidade monta um objetivo com `toolArgs`, `result` e tentativas cheios de marcadores e confere que nenhum
marcador aparece em `/active`, `/context` ou na outbox.

### 7. Autenticação

A mesma da versão 1. O token continua dando acesso a toda a API (limitação já registrada no contrato v1); um token só de
chat é outra decisão, fora desta ADR.

## Fase 5 — Validação da proposta

| Pergunta | Resposta |
|---|---|
| Baseada em evidência real? | Sim: tipos e campos citados existem hoje; o custo do polling foi medido na versão 1. |
| Estrutural ou sintoma? | Estrutural: dá ao contrato as informações que hoje só existem dentro do núcleo, e tira do painel a convenção `voz-`. |
| Reduz complexidade? | Para os clientes, sim (não inferem nada). No núcleo, acrescenta uma projeção e um registro de leitura. |
| Elimina fontes de verdade múltiplas? | Sim: canal, cliente e resultado passam a ter uma fonte só, o núcleo. |
| Mantém a filosofia do Kernel? | Sim: o contrato fornece fatos; quem decide é o núcleo. |
| Incremental? | Sim, em etapas independentes (abaixo). |
| Reversível? | Sim: tudo é aditivo; remover um campo novo volta à versão 1. |

## Plano incremental (depois da aprovação)

| Etapa | Entrega | Teste |
|---|---|---|
| 1 | `trabalho` com etapas, `plano` e `revisao` em `/active` | Conformidade das etapas, troca de plano, `desdeRevisao`, marcadores que não podem vazar |
| 2 | `resultado` e `provisoria` na outbox | Objetivo concluído, falho, cancelado, parcial; aviso de fila |
| 3 | `GET /api/chat/context` com canal e `cliente` | `cliente` não muda decisão nenhuma; canal pela chave |
| 4 | Registro "modelo da última resposta" | Modelo ausente quando não se sabe; troca de provedor mostra o que respondeu |
| 5 | `relatos` (últimos 20, corte declarado) | Ordem, corte, revisão |
| 6 | Clientes: interface de voz (etapas, contexto, resultado); painel troca o prefixo `voz-` por `cliente` | Regressões de cada cliente |

Cada etapa segue a Validação Progressiva da diretriz, inclusive a execução real em instância isolada, e é publicada só
com o OK da operadora.

## Riscos e hipóteses não comprovadas

- **Achado na rodada de testes (05/11/2026): o painel não pode citar a integração pelo nome** (ADR-031, regra 1, cobrada pelo
  `S465`). A marca das conversas vem do próprio manifesto da integração (campo opcional `icone`; a voz declara 🎙), lida do
  catálogo pelo `cliente`. O validador do manifesto recusa campo desconhecido: o manifesto da voz só ganha `icone` **depois**
  de as duas produções terem este NewClaw. Até lá, o prefixo `voz-` das conversas antigas mantém o 🎙.
- **Achado na implementação (04/11/2026): a interface de voz exigia a versão EXATA.** A janela recusava um `turn-client.js`
  com `TURN_CONTRACT_VERSION !== 1`: publicar o NewClaw na versão 2 a teria derrubado, contra a promessa "um cliente da
  versão 1 continua funcionando". Correção, sem mudança irreversível: a janela passa a exigir a versão 1 **ou maior**
  (`newclaw-ivox` `cd304a0`, que funciona com os dois servidores) e é publicada **antes** do NewClaw da versão 2. Regra para
  clientes futuros, registrada no contrato: conferir versão mínima, nunca igualdade.

- **Descrições de etapa** são texto do planejador. Podem sair em outro idioma ou citar um caminho. A regra só garante que
  `toolArgs` não sai; o que o planejador escreve na descrição continua sendo dele. A medir na etapa 1, com objetivos reais.
- **Modelo da última resposta** depende de associar a tentativa do `ProviderFactory` à conversa. Se o caminho não
  carregar a conversa até lá, a etapa 4 precisa de um ajuste maior; nesse caso, volto com a medição antes de seguir.
- **Revisão em memória:** reiniciar o servidor zera a revisão; o cliente trata número menor como plano novo.
- **Eventos por SSE** ficam fora. Se o polling ficar caro com muitos clientes, é uma ADR própria.
