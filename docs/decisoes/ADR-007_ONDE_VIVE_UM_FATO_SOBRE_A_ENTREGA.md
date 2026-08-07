# ADR-007 — Onde vive um fato sobre a entrega

> **Status:** decisão tomada em 07/08/2026. Sprint 026.
>
> Escopo: **por onde** um fato sobre a entrega chega ao usuário. Não altera o que conta como
> conteúdo, não altera o log, não decide a política de substituição de nenhuma ferramenta.
>
> **Decide localização, não implementa.** O código é trabalho de Sprint posterior.
>
> Base factual: `docs/analises-arquiteturais/INVESTIGACAO_TERMINO_DE_TURNO_E_FATOS_DE_ENTREGA_2026-08-07.md`
> (linhas conferidas em `696f791`).

## 1. Contexto

Ao aplicar a cláusula de visibilidade de `SOBERANIA_DA_CONFIGURACAO.md` §1.3(b) ao `send_audio` — o
Piper falha, o texto do usuário é sintetizado por um serviço da Microsoft, e isso só vira
`log.error` — a implementação foi interrompida antes de qualquer código.

O mecanismo da Sprint 022 (o fato entra no prompt, o LLM verbaliza) não se aplica: numa ferramenta
terminal **não há LLM depois**. O `output` da tool é a resposta final em três pontos do `AgentLoop`
(`:1620`, `:2072`, `:2163`).

## 2. O problema arquitetural

`FERRAMENTAS_DE_ENTREGA.md` §4 prevê duas categorias:

* **conteúdo** → `output`;
* **status operacional** → log.

"O seu texto foi sintetizado por um terceiro" não é nenhuma das duas. Não é o conteúdo entregue, e
não é telemetria. Colocá-lo no `output` reintroduz texto fixo em português no caminho do usuário —
exatamente o que o §5 daquele documento existe para remover, e que sairia igual para usuários en-US
e es-ES. Deixá-lo no log significa que o usuário nunca o vê.

**A lacuna é estrutural, não do TTS.** Hoje só o `send_audio` a exercita, porque é a única
ferramenta de entrega com cadeia de substituição de recurso — mas nada nela é específico de áudio.

**Assimetria relevante:** no caminho de goal existe uma chamada de LLM depois da entrega, só para
compor a mensagem final (`GoalExecutionLoop.ts:3606`), e o prompt dela já inclui um bloco
`RESULTADOS DAS FERRAMENTAS`. Ali existe onde verbalizar. No `AgentLoop`, não.

## 3. Alternativas consideradas

### A — Anexar o fato em prosa ao `output`
**Descartada.** Funciona (o `output` é a resposta), mas reintroduz texto fixo em português no
caminho do usuário. É a regressão direta do princípio que `FERRAMENTAS_DE_ENTREGA.md` §5 estabeleceu,
e o defeito que a `RFC-004` decidiu parar de produzir.

### B — Campo estruturado, e o Core redige a frase no encerramento
**Descartada.** Move o problema de lugar sem resolvê-lo: quem redige continua sendo o Core, e a
frase continua saindo em português para todo mundo.

### C — Campo estruturado, e o turno **não encerra** quando há fato a comunicar
**Escolhida.** Ver Seção 4.

### D — Resolver na camada de canal (`NormalizedResponse` + adapters)
**Descartada.** Cada adapter precisaria de tabela de tradução e de saber o que é uma substituição —
regra de negócio dentro de adapter, proibida por `ARCHITECTURE.md` ("Dependências proibidas"). Além
disso multiplicaria por cinco a implementação de algo que pertence ao Core.

### E — Manter no log (status quo)
**Descartada**, mas registrada: é o comportamento de hoje, e a razão de o `send_audio` constar como
não conforme no quadro de estado da Soberania.

## 4. Decisão

**1. `ToolResult` ganha uma terceira categoria explícita: fatos sobre a entrega.**

Campo opcional, estruturado, distinto de `output` (conteúdo) e do log (status). O contrato de
`FERRAMENTAS_DE_ENTREGA.md` passa de duas categorias para três.

**2. Critério de admissão — e é ele que impede a terceira categoria de virar depósito de status:**

> Um fato sobre a entrega é aquele que muda o entendimento do usuário sobre **o que foi feito com o
> conteúdo dele ou para onde ele foi** — custódia, localidade, fidelidade. Nunca sobre **se** a
> operação deu certo.

"Sintetizado por um serviço de terceiros" entra. "Enviado com sucesso", "pulado por debounce",
tempo de upload e tamanho do arquivo continuam sendo log, como o §4 já determina.

**3. Uma ferramenta de entrega que devolve fato NÃO encerra o turno.**

O encerramento antecipado existe como otimização: evita uma ida a mais ao LLM quando não há nada a
dizer além do conteúdo. Quando há fato a comunicar, essa ida é exatamente o que falta. O turno segue
pelo caminho ordinário, o resultado da tool volta ao contexto do modelo (`AgentLoop.ts:1592`,
`:1983`) e **o LLM verbaliza** — no idioma da conversa, sob a diretiva que já está no system prompt.

É o mesmo mecanismo da Sprint 022, alcançado por não desligar o caminho que já existe, em vez de
construir um segundo.

**4. O caminho de goal não muda.** `GoalExecutionLoop.ts:3606` já compõe a mensagem final por LLM e
já recebe os resultados das ferramentas; o fato só precisa viajar até lá pelo mesmo campo.

### 4.1 A regra que a decisão cria

> O Core transporta o fato. Quem o transforma em frase é sempre o LLM.

## 5. Gate obrigatório — Extensão antes de Criação

**Nenhum arquivo novo.** Nenhuma Tool, Skill ou Script.

| Candidato | Precisa existir? | O que já existe | Decisão |
|---|---|---|---|
| Canal para o fato | Não | `ToolResult` já carrega dados estruturados ao lado do `output` (`artifactPaths`, `exitCode`) | Campo novo em interface existente |
| Mecanismo de verbalização | Não | O caminho não-terminal já devolve o resultado da tool ao LLM | Deixar de pular esse caminho |
| Entrega no fluxo de goal | Não | `GoalExecutionLoop.ts:3606` já compõe mensagem final com os resultados das ferramentas | Nada a construir |

O terceiro campo estruturado de `ToolResult` segue o precedente dos dois que já existem: dado que o
`output` não deveria carregar, entregue ao lado dele.

## 6. O que esta ADR NÃO muda

* **O contrato de conteúdo.** `output` continua sendo o conteúdo entregue
  (`FERRAMENTAS_DE_ENTREGA.md` §4, `S201`).
* **O log.** Status operacional continua onde está.
* **A política de substituição do TTS.** Se o `send_audio` deve poder recusar a queda para um
  serviço remoto (`estrita`) é decisão de outra Sprint; esta só garante que, havendo substituição, o
  fato tem por onde chegar.
* **O caminho de erro.** `success: false` com `error` descritivo permanece intocado.
* **O encerramento de turno quando não há fato.** Sem fato, a ferramenta terminal continua
  encerrando o turno como sempre — o custo extra só existe onde há algo a dizer.

## 7. Consequências

* **Uma inferência a mais, apenas quando há fato.** É o custo de o usuário ficar sabendo. Como fato
  sobre a entrega é raro por construção (critério da §4.2), o caso comum não muda.
* **Risco de o modelo repetir a entrega** ao ver o resultado da tool e decidir reenviar. Os guardas
  já existem e são anteriores a esta decisão: `send_audio-already-sent` (`AgentLoop.ts:2542`),
  `__send_audio_delivered__` (`:1954`, `:2521`) e a deduplicação interna do próprio `send_audio`.
  A Sprint de implementação precisa confirmá-los em execução, não assumi-los.
* **`S201` continua válido** — ele verifica que o `output` é conteúdo, e o fato não vai no `output`.
* **Reversibilidade:** alta. Sem fato preenchido, o comportamento é byte-idêntico ao atual; remover
  o campo e a checagem restaura o estado anterior.

## 8. Validação exigida

Validação Progressiva completa. O cenário de execução real que esta decisão precisa ver funcionando:
Piper declarado (modelos presentes) que falha, entrega por áudio bem-sucedida via serviço remoto, e
**a resposta textual do turno mencionando a substituição**, no idioma da conversa — sem que o áudio
seja entregue duas vezes.

A medição da Sprint 024 é o precedente de método: verificar que o fato **chega** não é verificar que
ele é **dito**.

## 9. Limites conhecidos

* **A fidelidade da verbalização continua probabilística.** A Sprint 024 mediu 2 fiéis, 2 parciais e
  1 com acréscimo, em 5 execuções. Esta ADR não altera isso — apenas dá ao fato um caminho até o
  LLM onde hoje não existe nenhum.
* **Só o `send_audio` exercita a lacuna hoje.** `send_document` não tem cadeia de substituição de
  recurso. A terceira categoria nasce com um consumidor.
* **Não foi analisado** como os canais tratam a resposta final, nem o efeito sobre ferramentas de
  entrega futuras (`send_email` etc.) — ver a Seção 5 do documento de investigação.
