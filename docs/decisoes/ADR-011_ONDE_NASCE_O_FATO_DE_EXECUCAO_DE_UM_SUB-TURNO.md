# ADR-011 — Onde nasce o fato de execução de um sub-turno

**Status:** aceita, com duas decisões declaradas em aberto (§7)
**Data:** 2026-08-09
**Contexto:** Sprint 043 / investigação da fronteira `AgentLoop → GoalExecutionLoop`
**Princípio aplicado:** `docs/ARCHITECTURE/RESPONSABILIDADE_ANTES_DO_MECANISMO.md`

---

## 1. A pergunta

Quando um step de goal é executado por um sub-turno do `AgentLoop` — e não por uma ferramenta
direta —, quem determina o que aconteceu naquela execução, com qual evidência, e que estado isso
produz?

## 2. O que acontece hoje

`GoalExecutionLoop.evaluateAgentStepSuccess()` recebe o **texto** produzido pelo sub-turno, olha os
primeiros 500 caracteres e emite `StepEvaluation { success: boolean }`, que governa o goal.

```text
AgentLoop.process()  ──prosa──▶  regex sobre 500 chars  ──boolean──▶  toolResult
                                                                          │
                                                    GoalEvaluator.evaluate()
                                                                          │
                                             blocker tool_error / replan / memória
```

Três propriedades desse desenho foram verificadas em código:

- o parâmetro `objective` é recebido e **ignorado** (`_objective`);
- o `ExecutionTrace` do sub-turno está disponível 28 linhas adiante e dele se extraem **apenas os
  nomes** das ferramentas (`subToolCalls`), descartando `tool_result.success`;
- como o sub-turno não é ferramenta, `toolResult.error` fica `undefined`, e `GoalEvaluator` reusa
  o `output` como se fosse erro — produzindo `Erro em 'unknown': <a própria resposta ao usuário>`.

## 3. O diagnóstico

`StepEvaluation.success: boolean` comprime **quatro perguntas** de naturezas e donos diferentes:

| pergunta | natureza | dono natural |
|---|---|---|
| alguma ferramenta do sub-turno falhou? | estrutural | `ExecutionTrace` |
| o sub-turno produziu resposta utilizável? | estrutural | forma/comprimento |
| a resposta cumpre a intenção do step? | semântica | `StepSemanticValidator` |
| a resposta é fiel à evidência? | semântica | grounding (`ADR-010`) |

A perda de informação é **anterior** a qualquer erro de julgamento: um booleano não distingue *"a
ferramenta quebrou"* de *"a ferramenta funcionou e o dado não existe"*. Mesmo um avaliador perfeito
seria obrigado a mentir, porque o tipo não tem como dizer a verdade.

## 4. A decisão

**O fato estrutural da execução de um sub-turno nasce no dispatch, é transportado como fato até o
`GoalAttempt`, e nenhum juízo é derivado dele nesta fronteira.**

Concretamente:

1. **`GoalAttempt` é o contrato do sub-turno** — não se cria um `SubTurnReport`. Ele já carrega
   `traceId`, `subToolCalls`, `output`, `error`, `evaluation` e nasceu na Sprint 0.10 exatamente
   para "decompor a caixa-preta agentloop". Estender é extensão; criar seria um segundo relatório
   do mesmo sub-turno, com o mesmo `traceId`, competindo com este.
2. **Um campo novo, irmão de `subToolCalls`, registra apenas as invocações que falharam**, cada
   uma com a identidade da ferramenta e o erro que ela própria reportou.
3. **Forma somente-falhas, não lista paralela.** Uma paralela criaria invariante de comprimento
   entre dois campos sustentado apenas por adjacência textual nos três dispatches — o dia em que
   divergir, o desalinhamento é silencioso e atribui o erro de uma ferramenta a outra.
4. **Sem ordinal**, por ora: nenhum consumidor demonstrado precisa localizar a falha na sequência.
   Incluí-lo hoje seria projetar para requisito hipotético.
5. **Sem enum e sem vocabulário novo de estado.** `CycleOutcome` (6 valores) e `AttemptOutcome`
   (3 valores) permanecem intocados; a decisão aqui é sobre fato, não sobre estado.

## 5. Contrato do campo

> Registro factual das invocações de ferramenta que **falharam** dentro deste sub-turno, com o
> motivo que cada uma reportou. Observação retrospectiva — não afirma nada sobre o step, a
> resposta, ou o que deve acontecer em seguida.

**Por falha:** identidade da ferramenta + texto de `ToolResult.error`, sem reescrita.

**Nunca contém `success`.** Não por redundância (a lista só tem falhas), mas porque `success` nomeia
um juízo sobre o step, de outro dono. O contrato precisa ser **incapaz de expressar aprovação** —
é essa incapacidade que garante a separação, não a disciplina de quem o consome.

**Lista vazia = "nenhuma falha observada entre as invocações registradas".** Silêncio, não aval.
Ela não distingue sozinha *nenhuma ferramenta rodou* de *todas funcionaram*: o denominador é
`subToolCalls`, e só a leitura conjunta produz sentido. Seguindo o precedente já testado em `S89.2`
(`[]` e `undefined` significam coisas diferentes em `subToolCalls`): **ausente** = não houve
observação; **vazio** = houve observação e nenhuma falha.

**Fronteiras com os campos vizinhos** — fato e juízo não compartilham campo, e nenhum campo responde
a pergunta de outro:

| campo | afirma |
|---|---|
| `subToolCalls` | o que foi tentado, em ordem — não diz desfecho |
| *campo novo* | o que falhou, e por quê |
| `output` | o entregável ao usuário — nunca prova de execução (`FERRAMENTAS_DE_ENTREGA`) |
| `evaluation` | o juízo (`confidence`, `reason`) — nunca recebe fato |
| `traceId` | procedência — referência, não substituto |

## 6. Por que a origem do erro é `ToolResult.error`

Verificado no produtor: as ferramentas retornam `{ success: false, output: '', error: '...' }` —
`crypto_analysis:272-273`, `api_request:52,64`, `edit_tool:84,88`, `cmi_inspect:180`, entre outras.
Em falha, **`output` é string vazia**; o motivo está inteiramente em `error`.

E os três dispatches gravam no trace `{ tool, success, output }`, **sem `error`**
(`AgentLoop:1396`, `:2092`, `:2415`). Portanto o trace registra que a ferramenta falhou e **perde
por completo o motivo**. O `ERROR: ...` visível nos logs é composto em `AgentLoop:2089` e `:2411` a
partir de `result.error`, que ali ainda existe em memória — é log, não trace.

Não há escolha a fazer: `ToolResult.error`, capturado no dispatch, é a única fonte existente. E é a
palavra da própria ferramenta — qualquer resumo ou normalização reintroduziria interpretação no
ponto exato em que ela está sendo removida.

## 7. Canal de transporte e nome do campo — decidido em 09/08/2026

**7.1 — O trace é o canal.** `ExecutionTrace.tool_result` passa a transportar também o erro
estruturado da ferramenta:

```text
ToolResult.error → dispatch do AgentLoop → ExecutionTrace.tool_result.error
                 → GoalExecutionLoop → GoalAttempt
```

A razão é arquitetural, não de conveniência: o trace **já é** o canal entre essas duas camadas, e o
`GoalExecutionLoop` já o consulta no mesmo ponto em que monta o attempt. A mudança é aditiva a um
contrato existente. A alternativa — mudar o retorno de `agentLoop.process()` — obrigaria todos os
chamadores a mudar para transportar um dado que interessa a um só deles.

Três invariantes do dado, que o transporte não pode violar:

- a origem é `ToolResult.error`, capturado no dispatch;
- **não** é derivado de `output` (que é string vazia em falha);
- **não** é derivado da resposta textual do agente.

**7.2 — O campo é `subToolFailures`**, irmão de `subToolCalls`, com `{ tool, error? }` por entrada.
O nome diz o que ele contém — falhas — e não sugere veredito sobre o step.

**7.3 — O C1 fica fora deste incremento.** Ele tem decisão semântica própria pendente (`claims=0`
com evidência presente) e não se mistura a esta mudança.

## 8. Escopo, e o que esta ADR não resolve

Transportar o fato **não muda comportamento**: nada lê o campo novo. O que corrige o produto é o
passo seguinte — `evaluateAgentStepSuccess` e `GoalEvaluator` decidirem sobre esse fato em vez de
sobre prosa. São dois incrementos de risco muito diferente: o primeiro é aditivo; o segundo mexe na
decisão que governa blocker, replan e memória.

Esta ADR decide **de onde vem o fato e como ele é transportado**. Não decide quem passa a consumi-lo,
nem se `evaluateAgentStepSuccess` sobrevive na forma atual.

## 9. Riscos e limitações

- A garantia de que todo `tool_call` tem `tool_result` correspondente é **por adjacência de código**
  nos três dispatches, não invariante declarado nem testado. Um `return` ou `throw` inserido entre
  as duas linhas romperia o par silenciosamente. A forma somente-falhas degrada com honestidade
  nesse cenário (lista vazia continua verdadeira); uma paralela afirmaria algo falso.
- O `ExecutionTrace` vive num buffer em memória podável — o próprio código já assume que pode sumir
  (*"trace pruned do buffer de 50 → campos ficam undefined"*). Por isso o fato precisa ser **copiado**
  para o `GoalAttempt` persistido; a referência sozinha não basta.
- A ausência de ordinal impede distinguir duas falhas da mesma ferramenta no mesmo sub-turno. Aceito
  conscientemente: nenhum consumidor demonstrado precisa disso hoje.
- **Falha de fast path é invisível a este mecanismo.** Descoberto ao implementar: dos três
  dispatches, o fast path (`AgentLoop:1384-1387`) retorna `null` quando a ferramenta falha —
  **antes** de gravar qualquer coisa no trace. Não há `tool_call` nem `tool_result` para essa
  invocação; o turno cai no loop de cognição e a ferramenta costuma ser chamada de novo por um dos
  outros dois caminhos, aí sim registrada. Portanto só dois dos três sítios de `addStep` mudam, e
  `subToolFailures` descreve as falhas **registradas no trace**, não necessariamente todas as
  ocorridas. Consistente com o contrato do campo (§5): lista vazia é silêncio, nunca aval.

## 10. Evidência

Incidente de origem: pergunta simples (`"Qual o valor da cripto River?"`) resultou em
`success=false cycles=12 replans=5 attempts=11 strategies=9`, ~11 minutos, nenhuma resposta ao
usuário. Uma resposta correta — *"não foi possível obter o preço"* — foi convertida em falha de
execução por regex, virou `blocker tool_error tool='unknown'` com a própria resposta como descrição
do erro, e o `ReflectionMemory` registrou o episódio como `pattern=tool_tool_error`: a memória de
falhas aprendeu com um acerto.

O mecanismo é anterior à Sprint 043 — `evaluateAgentStepSuccess` é de 23/05/2026 e `failurePattern`
de 26/05/2026. A auditoria de regressão de 09/08/2026 confirmou que os três dias anteriores não o
introduziram nem o reforçaram.
