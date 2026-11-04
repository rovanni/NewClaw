# Contrato do turno — versão 2

Data: 29/10/2026 (versão 1); 04/11/2026 (versão 2, ADR-033). Origem: ADR-030 (decisão D15, aprovada em 29/10/2026) e
ADR-031 (regra 7: "contrato antes do cliente"); a versão 2 é a ADR-033 (aprovada em 04/11/2026).
Conformidade: testes de regressão `S457` (versão 1) e `S474` (versão 2). Cliente público:
`src/dashboard/public/turn-client.js`, servido em `/turn-client.js`.

A versão 2 é **aditiva**: um cliente da versão 1 continua funcionando sem mudança. O que ela acrescenta está marcado
"(v2)" nas operações e resumido em "O que a versão 2 acrescenta", no fim das operações.

## Para que serve

Um **turno** é uma mensagem enviada ao NewClaw e tudo o que acontece até a resposta dela:
- aceitação;
- espera na fila ou classificação;
- execução (conversa ou objetivo);
- pedido de aprovação de ação perigosa;
- relatos de progresso;
- entrega.

Este documento é a definição pública de como um cliente acompanha um turno pela API HTTP do painel. Vale para o próprio
painel, integrações opcionais em repositório próprio (a voz, o suplemento do PowerPoint — ADR-031) e qualquer cliente futuro.

O contrato **descreve as rotas que já existem**, sem mudar o comportamento delas. A versão 1 só acrescentou ao servidor o
anúncio da versão em `GET /api/status`. Ele não sabe que cliente está do outro lado: nada aqui é específico de canal, de
interface ou de fornecedor de voz.

Fora do contrato: memória, roteamento de modelos, execução. O cliente não decide nada disso, só pede e acompanha.

## Versão e compatibilidade

- O servidor anuncia a versão em `GET /api/status` → `status.contracts.turn` (número inteiro; hoje `2`) e em
  `GET /api/chat/context` → `contrato` (v2).
- O cliente público declara a dele em `TURN_CONTRACT_VERSION`.
- **Campos novos** numa resposta não mudam a versão: o cliente ignora o que não conhece.
- **Mudança incompatível** (remover um campo, mudar o significado de um status ou de uma fase) exige versão nova, com o
  teste de conformidade atualizado junto.
- Servidor sem `status.contracts` é anterior a este contrato: as rotas existem, mas sem garantia documentada.

## Autenticação

| Forma | Quando usar |
|---|---|
| `Authorization: Bearer <token>` | Clientes de API e servidores intermediários (um harness). Isento da checagem de origem contra CSRF (o navegador não manda esse cabeçalho sozinho). |
| Cookie `newclaw_session` (`httpOnly`, `SameSite=Strict`) | Páginas servidas pelo próprio NewClaw. Requisição que altera estado com cookie precisa de `Origin`/`Referer` da mesma origem; senão, `403`. |

- **Token:** `POST /api/auth/login` com `{ "password": "..." }` → `{ success: true, token }`. Senha errada → `401`. Este limite
  é próprio: 10 tentativas a cada 15 min por IP.
- **Sem senha configurada:** não há autenticação, mas o servidor só atende pedidos endereçados a `127.0.0.1`, `localhost` ou
  `[::1]`; qualquer outro `Host` → `403`. O login responde `token: "no-auth-required"`.
- **Sem credencial válida:** `401 { error: "Unauthorized" }` em toda rota `/api/*`, menos no login. Os arquivos estáticos
  (`*.js`, `*.css`, `*.html`) são públicos, incluindo `/turn-client.js`.
- **Limitações do token atual:**
  - dá acesso a toda a API, não só ao chat;
  - não expira;
  - não se revoga sozinho (revogar exige trocar a senha).

  Um servidor intermediário deve guardar o token do lado dele, nunca no navegador. O servidor também aceita o token em
  `?token=`, mas um cliente não deve usar isso, porque a URL vai parar em logs.
- **Cookie devolvido no login:** o login também devolve o cookie `newclaw_session` do painel. Um cliente de API não deve
  guardá-lo nem reenviá-lo. Com cookie e sem `Origin`, a checagem contra CSRF recusa o pedido, inclusive o próximo login
  (achado da Etapa 4 da ADR-030: um cliente HTTP que guarda cookies por padrão passou a ter o segundo login recusado).

## Limites de requisição

| Rota | Limite por IP | Ao passar |
|---|---|---|
| `POST /api/chat` | 10 por minuto | `429 { error }` com `Retry-After` (segundos) |
| Todas as rotas | 120 por minuto (geral) | `429` |

Consultas a cada 1,5 s usam 40 por minuto. Atrás de um servidor intermediário, todos os usuários dele saem do mesmo IP e
dividem esse limite.

## Operações

### 1. Enviar — `POST /api/chat`

Corpo em JSON `{ message, sessionId }`, ou `multipart/form-data` com `message`, `sessionId` e até
`MessageBus.MAX_ATTACHMENTS_PER_MESSAGE` arquivos no campo `files`.

| Resposta | Significado |
|---|---|
| `202 { success: true, turnId, sessionId }` | Aceito. O processamento segue em segundo plano. |
| `400 { error }` | Sem texto e sem anexo. |
| `400 { success: false, error: "too_many_files" \| "file_too_large" \| "upload_failed", max, maxBytes }` | Anexo recusado. |
| `429 { error }` + `Retry-After` | Limite de envio. |
| `500 { error }` | Agente não inicializado ou falha inesperada. |

- `sessionId` é o id da conversa do ponto de vista do cliente. Omitido, vale `web-session`.
- (v2) `client` (opcional): o nome do cliente, até 64 caracteres de `[a-z0-9._-]` (ex.: `newclaw-ivox`). Fica gravado na
  mensagem e aparece em `GET /api/chat/context`. **Só informativo:** nenhuma decisão do núcleo depende dele. Fora do
  formato, é ignorado.
- O mesmo `sessionId` é o `conversationId` de `/active` e o `sessionId` de `pendingAuth` e de `auth-decision`.
- O histórico **não** usa o `sessionId` como chave; ver a operação 7.

### 2. Estado — `GET /api/chat/active?sessionId=<conversa>&turnId=<turno>`

Leitura em memória, feita para consulta periódica.

```json
{
  "success": true,
  "active":     [{ "conversationId": "…", "elapsedMs": 1234, "kind": "turn" | "goal", "status": "executing" }],
  "pendingAuth":[{ "txnId": "…", "tool": "exec_command", "detail": "…", "createdAt": 1730000000000 }],
  "pending":    true,
  "progresso":  { "texto": "…", "em": 1730000000000 }
}
```

- **`active`:** o trabalho em execução de **todas** as conversas. Cada item traz:
  - `elapsedMs`: o tempo de espera do usuário (num objetivo, é a idade do objetivo, não a do passo atual);
  - `status`: aparece em `kind: "goal"`.

  Um objetivo parado esperando decisão não aparece aqui.
- **`pendingAuth`:** as ações perigosas desta conversa esperando decisão. Em `detail` vem o comando ou a descrição do que
  seria feito, nunca o conteúdo inteiro dos parâmetros. A lista fica vazia sem `sessionId`.
- **`pending`:** o `turnId` foi aceito e ainda não recebeu entrega nenhuma. Cobre a janela entre o `202` e o trabalho
  aparecer em `active` (classificação, fila). É `false` sem `turnId`.
- **`progresso`:** o último relato de progresso desta conversa (ADR-027). Cada relato substitui o anterior, e ele some quando
  a resposta final sai. O campo fica ausente quando não há relato.
- (v2) **`trabalho`:** só quando esta conversa tem um objetivo em andamento (conversa simples não tem etapas inventadas).

  ```json
  "trabalho": { "tipo": "objetivo", "estado": "executando", "revisao": 17, "plano": 2,
                "etapas": [{ "id": "s1", "descricao": "Coletar os logs de hoje", "estado": "concluida" }] }
  ```

  - `estado`: `executando` | `aguardando_aprovacao` | `replanejando` | `concluido` | `falhou` | `cancelado`.
  - `etapas[].estado`: `pendente` | `executando` | `concluida` | `pulada` | `falhou`. `descricao` é o texto que o
    planejador escreveu para a etapa, inteiro.
  - `plano`: quando muda, o plano foi substituído e o cliente descarta as etapas que tinha.
  - `revisao`: cresce a cada mudança de etapa, estado, plano ou relato. Com `&desdeRevisao=<revisao>` igual à atual, o
    servidor omite `etapas` e `relatos`. A revisão vive na memória do servidor: depois de reiniciar, recomeça, e o cliente
    trata um número menor como plano novo.
- (v2) **`relatos`** e **`relatosOmitidos`:** os últimos 20 relatos desta conversa, `{ texto, em }`, do mais antigo ao mais
  novo; `relatosOmitidos` conta os mais antigos que saíram. Somem junto com `progresso`, quando a resposta final sai.

### 3. Fases do turno (derivadas de `/active`)

O cliente público calcula a fase nesta ordem (`phaseFromActive`); quem não usar o módulo deve seguir a mesma ordem:

| # | Condição | Fase | Significado |
|---|---|---|---|
| 1 | `pendingAuth` não vazio | `awaiting_approval` | Parado, esperando um clique de aprovar ou rejeitar. Não é "processando". |
| 2 | Há item em `active` com `conversationId === sessionId` | `running` | Turno ou objetivo em execução. |
| 3 | `pending === true` | `accepted` | Aceito, ainda sem nada rastreável. |
| 4 | Nenhuma das anteriores | `finished` | A entrega está na outbox, ou no histórico se já foi retirada. |

A conversa é casada pelo id exato. Trabalho de outra conversa não é sinal deste turno.

`accepted` não é sinal de que o turno está para começar: enquanto a classificação espera o modelo, o turno continua nessa
fase. Na instância isolada, com um provedor que não respondia, ficou 4 s inteiros em `accepted` até ser cancelado. Quem
mostra o estado ao usuário deve tratar `accepted` e `running` como "trabalhando".

A fase **nunca** é decidida pelo texto da resposta.

### 4. Retirar a resposta — `GET /api/chat/outbox?turnId=<turno>`

| Resposta | Significado |
|---|---|
| `200 { success: true, response, options?, attachments?, resultado?, provisoria? }` | A entrega deste turno. `attachments[]` segue `serializeAttachment` (nome, tipo, dados em base64). |
| `404 { success: false, error: "not_ready_or_not_found" }` | Ainda não pronta, **já retirada** ou `turnId` desconhecido. Os três casos não se distinguem. |
| `400` | Sem `turnId`. |
| `503` | Agente não inicializado. |

**A leitura consome:** a segunda leitura do mesmo `turnId` dá `404`. Se duas abas acompanham o mesmo turno, só uma recebe a
entrega. A outra deve ler o histórico.

- (v2) **`resultado`:** quando a entrega vem de um objetivo,
  `{ "estado": "concluido" | "falhou" | "cancelado" | "parcial", "etapas": { "total": 4, "concluidas": 3 } }`. É o que o
  núcleo já decidiu (`parcial`: concluído com alguma etapa de confiança baixa). O cliente mostra; não decide.
- (v2) **`provisoria: true`:** a entrega é o aviso de fila ("Comportamentos", item 1). A resposta final ainda vem, com o mesmo
  `turnId`.

### 5. Cancelar — `POST /api/chat` com `message: "/cancelar"`

- **Quais comandos:** `/cancelar`, `/cancel`, `/stop` e `/pare` são comandos prioritários. Não entram na fila nem passam pelo
  modelo.
- **O que fazem:** interrompem o turno ou objetivo da conversa e descartam as mensagens que esperavam na fila.
- **A confirmação:** o cancelamento é um turno próprio, com `turnId` próprio. A confirmação (`⏹ Operação cancelada.` ou
  `⏹ Nada em andamento para cancelar.`) chega na outbox desse turno.
- **O turno cancelado:** recebe a própria entrega de interrupção. Isso foi conferido em instância isolada; ver "Validação".

### 6. Decidir uma aprovação — `POST /api/chat/auth-decision`

- **Corpo:** `{ sessionId, txnId, decision: "approved" | "rejected" }`. O `txnId` vem de `pendingAuth`.
- **Respostas:**
  - `200 { success: true, response, attachments }`: o texto que a decisão produziu. A rota espera por ele até 10 min.
  - `400`: falta campo ou a decisão é inválida.
  - `503`: agente não inicializado.
  - `500`: falha.
- Não existe outro caminho para aprovar. Por voz ou por texto livre, não aprova.

### 6a. (v2) Contexto da conversa — `GET /api/chat/context?sessionId=<conversa>`

```json
{ "success": true, "contrato": 2,
  "conversa": { "sessionId": "…", "id": "web:…", "criadaEm": "2026-11-04T12:00:00.000Z", "mensagens": 55 },
  "canal": "web", "cliente": "newclaw-ivox",
  "modelo": { "nome": "…", "provedor": "ollama", "em": "2026-11-04T12:05:00.000Z" } }
```

- **`canal`:** lido da chave da conversa no servidor; o cliente não deduz.
- **`cliente`:** o `client` da primeira mensagem que o trouxe. Ausente quando nenhuma mensagem trouxe, ou quando a
  compactação da conversa já tirou essas mensagens da transcrição.
- **`modelo`:** o modelo e o provedor da última chamada que **respondeu** num turno desta conversa (a resposta, não os juízes
  nem o planejador), com a hora. Ausente quando não se sabe: conversa nova ou servidor reiniciado. Nunca o modelo
  configurado.
- `404 { success: false, error: "conversa_nao_encontrada" }`: sem `sessionId`, ou conversa ainda sem mensagem gravada.

### O que a versão 2 acrescenta

| Onde | Campo |
|---|---|
| `POST /api/chat` | `client` |
| `GET /api/chat/active` | `trabalho` (etapas, `plano`, `revisao`), `relatos`, `relatosOmitidos`; parâmetro `desdeRevisao` |
| `GET /api/chat/outbox` | `resultado`, `provisoria` |
| `GET /api/chat/context` | rota nova |

**Limites de exposição (ADR-033 §6, cobrados pelo `S474`):** pelo contrato saem textos escritos para a pessoa (descrição de
etapa, relato, resposta), estados, contagens, horários, nome do modelo e do provedor. Nunca saem parâmetros de ferramenta,
saídas de comando, conteúdo de arquivo lido, vereditos ou raciocínio de juízes, prompts, endereço de provedor, chaves,
nome da máquina nem dados de outra conversa (exceto o `active` da versão 1, mantido como está).

### 7. Histórico (fonte de verdade da conversa)

- `GET /api/conversations` → `{ success, conversations: [{ id, sessionId, … }] }`.
  - `id` é a chave interna da conversa (hoje `web:<sessionId>`).
  - `sessionId` é o que o cliente manda em `POST /api/chat`.
- `GET /api/conversations/:id/messages` → `{ success, messages: [{ role, content, … }] }`. O `:id` é o **`id` da lista**,
  nunca o `sessionId`. Com o `sessionId`, a lista vem vazia, sem erro.

O cliente acha a conversa pelo `sessionId` na lista e usa o `id` dela, sem compor a chave por conta própria: a regra de
composição é interna e pode mudar.

Esta versão não congela o resto do formato dessas rotas, só o papel delas: quando a outbox não tem a entrega (retirada por
outro cliente, servidor reiniciado), é aqui que a resposta está. Na instância isolada, o turno cancelado ficou gravado como
`user "Olá, tudo bem?"` seguido de `assistant "⏹ Pedido interrompido."`.

## Comportamentos que o cliente precisa conhecer

São comportamentos reais da versão 1, cobertos pelo `S457`. Não são erros do cliente.

1. **Aviso de fila:** com a conversa ocupada, uma mensagem nova recebe primeiro, como entrega do próprio `turnId`, o aviso de
   que entrou na fila.
   - A resposta final dela sai depois, **com o mesmo `turnId`**, e também fica no histórico.
   - Se ninguém tiver retirado o aviso, a resposta final o substitui na outbox.
   - A versão 1 não tinha campo que dissesse "esta entrega é provisória". Na versão 2, o aviso vem com `provisoria: true`, e
     o `waitForTurn` do cliente público continua esperando a resposta final (o aviso vai para `onProvisional`).
2. **Complemento de objetivo:**
   - Texto enviado enquanto um objetivo da conversa executa é incorporado a ele.
   - A entrega deste `turnId` é a nota "Anotado"; o resultado vem na entrega do turno que criou o objetivo.
3. **Entregas atrasadas:** a resposta de uma tarefa anterior que perdeu o turno dela vem mesclada no início da próxima
   entrega da mesma conversa, com anexos e opções.
4. **Falha do turno:** não há campo de erro na entrega. Falhas chegam como texto da resposta, escrito pelo próprio NewClaw.
   Na versão 2, a entrega de um objetivo traz `resultado.estado` (`falhou`, `cancelado`…).
5. **Outbox sem expiração:** entrega nunca retirada fica na memória do servidor até ele reiniciar. Reiniciar descarta a
   outbox, mas não o histórico.

## Consumidores existentes

| Consumidor | Como acompanha hoje | Diferenças para este contrato |
|---|---|---|
| Painel (`index.html`: `startTurnPolling`, `fetchAndRenderOutbox`) | `/active` a cada 1,5 s; depois a outbox, com 5 tentativas a cada 500 ms; avisa perda de conexão após 3 falhas seguidas | Na falta da própria conversa em `active`, usa a primeira conversa ativa que houver |
| Suplemento do PowerPoint (`turnPolling.ts`, repositório newclaw-powerpoint desde 04/11/2026) | Só a outbox, a cada 3 s, até 45 min | Não lê `active`, então não vê aprovação pendente nem progresso |
| Cliente público (`turn-client.js`) | `/active` a cada 1,5 s; depois a outbox, com 3 novas tentativas; até 45 min | Implementa este documento |

O painel e o suplemento continuam como estão. Cada migração para o cliente público é uma etapa própria (ADR-030, etapa 7),
com a regressão do respectivo consumidor. O `S457` confere que os campos que o painel lê existem na resposta. O suplemento do
PowerPoint saiu do núcleo em 04/11/2026: a conformidade do cliente dele contra as rotas reais é do repositório dele, como a da
voz.

## Cliente público — `turn-client.js`

Módulo ES sem dependências e sem DOM; o `fetch` pode ser injetado.

```js
import { createTurnClient } from '/turn-client.js';
const turnos = createTurnClient({ baseUrl: '', headers: { Authorization: 'Bearer <token>' } });
```

| Função | Faz |
|---|---|
| `send({ sessionId, message, files? })` | `POST /api/chat` → `{ kind: 'accepted', turnId, sessionId }` ou `{ kind: 'rejected', status, error, retryAfterSec? }` |
| `state({ sessionId, turnId })` | Uma consulta a `/active` → `{ phase, elapsedMs, work, approvals, progress }` |
| `result(turnId)` | Retira a outbox → `{ kind: 'delivered', text, attachments, options }` ou `{ kind: 'none' }` |
| `cancel({ sessionId })` | Envia `/cancelar` (resposta igual a `send`) |
| `decide({ sessionId, txnId, decision })` | `POST /api/chat/auth-decision` → `{ kind: 'decided', text, attachments }` ou `{ kind: 'rejected', … }` |
| `waitForTurn({ sessionId, turnId, onState?, signal?, … })` | Acompanha até o fim (ver abaixo) |

Resultados de `waitForTurn`:

| Resultado | Significado |
|---|---|
| `finished` com `delivery` | A entrega retirada da outbox. |
| `finished` com `delivery: null` | A outbox não tinha a entrega; leia o histórico. |
| `timeout` | Passou do tempo de espera. O turno continua no servidor e a espera pode ser retomada com o mesmo `turnId`. |
| `unreachable` | Falhas seguidas demais (rede, `5xx`, `429`). Também dá para retomar. |
| `rejected` | `400`, `401` ou `403`. |
| `aborted` | Quem chamou desistiu. Fechar a janela **não** cancela o turno; para isso existe `cancel`. |

## Validação

- **Regressão:** `S457_ContratoDoTurno_Conformidade` sobe as rotas reais (`createChatRouter`, `createStatusRouter`,
  `authMiddleware`, `csrfOriginCheck`, arquivos estáticos) com o `WebChannelAdapter` real e confere cada linha das seções
  acima, inclusive com o cliente público (o do suplemento foi conferido aqui até 04/11/2026, quando o suplemento saiu do núcleo).
- **Instância isolada (29/10/2026):**
  - **Montagem:** NewClaw do branch desta etapa, porta e pasta de dados próprias, senha própria. O provedor era um servidor
    local que aceita a conexão e não responde, então nenhum modelo foi chamado e nenhuma cota foi usada.
  - **O que rodou:** o cliente público, baixado da própria instância em `/turn-client.js`, sem alteração.
  - **Resultados:**

    | Medida | Resultado |
    |---|---|
    | Versão anunciada | `status.contracts.turn = 1`, igual à do cliente |
    | Aceitação (`POST` → `202`) | mediana 6 ms (2,7–15,6 ms; n=6) |
    | Ciclo completo de um `/cancelar` sem nada rodando (envio → entrega retirada) | mediana 32 ms (9–44 ms; n=6) |
    | Uma consulta a `/active` | mediana 16 ms (2,5–17,5 ms; n=20) |
    | Uma consulta à outbox vazia (`404`) | mediana 15 ms (1,4–15,8 ms; n=20) |

  - **Cancelamento de um turno preso no provedor:**
    - fases vistas: `accepted` aos 36 ms e `finished` aos 4,24 s;
    - confirmação `⏹ Operação cancelada.` 34 ms após o pedido;
    - entrega do turno cancelado `⏹ Pedido interrompido.` 220 ms após o pedido;
    - histórico com as duas mensagens sob o `id` `web:<sessionId>`.

  O tempo dominante de um turno real continua sendo o do modelo, na casa dos minutos (ADR-030, tabela de latência).
