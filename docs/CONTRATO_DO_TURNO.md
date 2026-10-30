# Contrato do turno — versão 1

Data: 29/10/2026. Origem: ADR-030 (decisão D15, aprovada em 29/10/2026) e ADR-031 (regra 7: "contrato antes do cliente").
Conformidade: teste de regressão `S457`. Cliente público: `src/dashboard/public/turn-client.js`, servido em `/turn-client.js`.

## Para que serve

Um **turno** é uma mensagem enviada ao NewClaw e tudo o que acontece até a resposta dela:
- aceitação;
- espera na fila ou classificação;
- execução (conversa ou objetivo);
- pedido de aprovação de ação perigosa;
- relatos de progresso;
- entrega.

Este documento é a definição pública de como um cliente acompanha um turno pela API HTTP do painel. Vale para o próprio
painel, o suplemento do PowerPoint, harnesses opcionais (ADR-031) e qualquer cliente futuro.

O contrato **descreve as rotas que já existem**, sem mudar o comportamento delas. A versão 1 só acrescentou ao servidor o
anúncio da versão em `GET /api/status`. Ele não sabe que cliente está do outro lado: nada aqui é específico de canal, de
interface ou de fornecedor de voz.

Fora do contrato: memória, roteamento de modelos, execução. O cliente não decide nada disso, só pede e acompanha.

## Versão e compatibilidade

- O servidor anuncia a versão em `GET /api/status` → `status.contracts.turn` (número inteiro; hoje `1`).
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
| `200 { success: true, response, options?, attachments? }` | A entrega deste turno. `attachments[]` segue `serializeAttachment` (nome, tipo, dados em base64). |
| `404 { success: false, error: "not_ready_or_not_found" }` | Ainda não pronta, **já retirada** ou `turnId` desconhecido. Os três casos não se distinguem. |
| `400` | Sem `turnId`. |
| `503` | Agente não inicializado. |

**A leitura consome:** a segunda leitura do mesmo `turnId` dá `404`. Se duas abas acompanham o mesmo turno, só uma recebe a
entrega. A outra deve ler o histórico.

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
   - A versão 1 não tem campo que diga "esta entrega é provisória". Quem precisar da resposta final deve conferir o histórico
     depois de a conversa sair de `active`.
2. **Complemento de objetivo:**
   - Texto enviado enquanto um objetivo da conversa executa é incorporado a ele.
   - A entrega deste `turnId` é a nota "Anotado"; o resultado vem na entrega do turno que criou o objetivo.
3. **Entregas atrasadas:** a resposta de uma tarefa anterior que perdeu o turno dela vem mesclada no início da próxima
   entrega da mesma conversa, com anexos e opções.
4. **Falha do turno:** não há campo de erro na entrega. Falhas chegam como texto da resposta, escrito pelo próprio NewClaw.
5. **Outbox sem expiração:** entrega nunca retirada fica na memória do servidor até ele reiniciar. Reiniciar descarta a
   outbox, mas não o histórico.

## Consumidores existentes

| Consumidor | Como acompanha hoje | Diferenças para este contrato |
|---|---|---|
| Painel (`index.html`: `startTurnPolling`, `fetchAndRenderOutbox`) | `/active` a cada 1,5 s; depois a outbox, com 5 tentativas a cada 500 ms; avisa perda de conexão após 3 falhas seguidas | Na falta da própria conversa em `active`, usa a primeira conversa ativa que houver |
| Suplemento do PowerPoint (`turnPolling.ts`) | Só a outbox, a cada 3 s, até 45 min | Não lê `active`, então não vê aprovação pendente nem progresso |
| Cliente público (`turn-client.js`) | `/active` a cada 1,5 s; depois a outbox, com 3 novas tentativas; até 45 min | Implementa este documento |

O painel e o suplemento continuam como estão. Cada migração para o cliente público é uma etapa própria (ADR-030, etapa 7),
com a regressão do respectivo consumidor. O `S457` roda o cliente do suplemento contra as rotas reais e confere que os campos
que o painel lê existem na resposta. Assim, uma mudança no servidor que quebre um deles quebra o teste.

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
  acima, inclusive com o cliente do suplemento e com o cliente público.
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
