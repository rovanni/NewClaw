# ADR-005 — Onde vive o gate de ação perigosa

> **Status:** decisão tomada em 04/08/2026. Origem: defeito observado em execução real durante a
> validação da Sprint 1 (Dashboard aprova ação perigosa), instância isolada em modo SAFE.
>
> Escopo: **onde** a pergunta "esta chamada precisa de autorização humana?" é feita. Não altera o
> que é considerado perigoso, nem o modelo de modos operacionais (`CapabilityMode`), nem o
> `WorkflowEngine`.

## 1. Contexto

O NewClaw tem dois caminhos de execução de ferramenta:

* **AgentLoop** — turno conversacional; decide chamar uma tool a partir da resposta do LLM;
* **GoalExecutionLoop** — executa um plano; um step com `toolName` explícito é despachado
  diretamente (`dispatchToolStep`).

O modo SAFE promete confirmação humana obrigatória para `exec_command` e instalações. Esse gate
existe hoje em um único ponto: `AgentLoop.executeAndRecord()`
([`src/loop/AgentLoop.ts`](../../src/loop/AgentLoop.ts)), que combina três condições —
`ToolRegistry.isDangerous(tool)`, o comando não estar na lista de leitura-apenas
(`isSafeExecCommand`, método privado do próprio AgentLoop) e o modo não ter `auto_approve_exec`.

## 2. Achado (execução real, 04/08/2026)

Instância isolada, modo SAFE confirmado por API (`auto_approve_exec: false`). Pedido:
*"Execute no terminal exatamente este comando: mkdir sprint1-auth-test"*.

```
[GOAL-ROUTING]  route=goal_orchestrator
[TOOL-DISPATCH] step=step_1 requested_tool=exec_command args_provided=true
[GoalStep]      outcome=success durationMs=78
[GoalAudit]     blockers=[none]
```

O diretório foi criado. Nenhuma `AuthTransaction`, nenhum botão, nenhum bloqueio — reproduzido
duas vezes, com comandos diferentes. `mkdir` **não** está na lista de comandos de leitura-apenas:
pelo caminho do AgentLoop o mesmo comando teria sido barrado.

A causa está declarada no próprio código
([`GoalExecutionLoop.executeStep`](../../src/loop/GoalExecutionLoop.ts)): o pre-flight de
autorização foi removido de lá **de propósito**, com justificativa correta — ele devolvia
`needs_auth` *sem criar transação no WorkflowEngine e sem `authOptions`*, deixando o goal preso
para sempre, sem botão nenhum. A nota que ficou no lugar assume que "a autorização real é gerida
pelo WorkflowEngine via AgentLoop". Essa premissa não vale para step de plano com `toolName`
explícito — que é justamente o formato normal de um `exec_command` planejado.

## 3. Problema arquitetural

A promessa do modo SAFE é do **sistema**, mas a checagem pertence a **um caminho**. Enquanto a
pergunta "isto precisa de autorização?" for feita dentro do AgentLoop, qualquer caminho de
execução que não passe por ele nasce sem gate — e nada no código impede que apareçam outros.
Não é um `if` faltando: é a pergunta morando no lugar errado.

O corolário prático apareceu junto: a Sprint 1 (Dashboard aprovando ação perigosa) **não tinha
como ser validada ao vivo**, porque pelo painel nenhuma autorização chega a ficar pendente.

## 4. Alternativas consideradas

1. **Repetir a checagem em `dispatchToolStep`.** Resolve o sintoma e cria duas cópias da mesma
   regra, em módulos diferentes, para divergirem na primeira mudança. É a origem desta classe de
   bug, não a saída. Descartada.
2. **Reverter o pre-flight de `authorizationScope`.** Traz de volta o defeito documentado: goal
   preso, sem transação e sem botão. Descartada.
3. **Gate dentro de cada tool perigosa.** Cada tool decidiria se pede autorização. Espalha
   política de segurança por N arquivos e deixa a decisão na mão de quem escreve tool nova —
   exatamente o oposto de um ponto único obrigatório. Descartada.
4. **Uma única pergunta, dois consumidores** (escolhida). A regra vira um predicado no
   `ToolRegistry` — que já é o dono de "esta tool é perigosa" (`isDangerous`) — e os dois
   caminhos de execução perguntam a ele. O caminho de goal, ao receber "sim", faz o que faltava
   em 2023: cria a transação real e devolve `authOptions`, alimentando o handler de `needs_auth`
   que **já existe** e já sabe bloquear o goal com `pendingTxnId`.

## 5. Decisão

* `ToolRegistry.requiresAuthorization(toolName, args)` passa a ser a **única** resposta para
  "precisa de autorização humana?", usada por `AgentLoop` e por `GoalExecutionLoop`.
* O conhecimento sobre quais invocações de `exec_command` são leitura-apenas sai de um método
  privado do `AgentLoop` e passa a ser exportado por `src/tools/exec_command.ts` — o módulo que
  já é dono da semântica desses comandos.
* Quando o caminho de goal barra um step, ele **cria a `AuthTransaction`** e devolve
  `authOptions` no formato `auth:<approve|reject>:<txnId>` — o mesmo que os 4 canais de
  mensageria já reconhecem, o mesmo que a rota do Dashboard (`ADR-005` + Sprint 1) usa, e o mesmo
  que a aprovação por texto (`GoalOrchestrator`, "sim"/"não") já consome via `pendingTxnId`.
  Um mecanismo, quatro formas de dizer sim.

**Sem novo arquivo, nova tool ou nova skill** (Gate "Extensão antes de Criação"): um predicado no
registro que já classifica tools perigosas, uma função exportada de um módulo que já existe, e o
handler de `needs_auth` que já estava escrito e sem quem o alimentasse pelo caminho de goal.

## 6. Consequências

* **Modo SAFE passa a valer nos dois caminhos.** Um plano com `exec_command` não-trivial para e
  espera decisão, em vez de executar. Isso muda comportamento observável de instalações em SAFE —
  é a correção, não um efeito colateral.
* **A Sprint 1 fica validável ao vivo**: goal bloqueia → o painel lista a pendência → aprovar
  retoma pelo mesmo callback dos outros canais.
* **Multiplataforma e independente de idioma por construção**: a decisão usa nome de tool,
  `dangerous` do registro, modo operacional e análise estrutural do comando — nunca texto de
  interface, nunca mensagem de erro traduzida.
* **Limitação de plataforma, declarada e travada por teste (S188.5):** um comando cujo caminho
  contém espaço — `C:\Program Files\nodejs\node --version`, comuníssimo no Windows — não é
  reconhecido como leitura-apenas, porque o primeiro token vira `C:/Program`. O efeito é **pedir
  autorização a mais, nunca a menos**: o gate erra para o lado seguro. Corrigir exigiria tokenizar
  respeitando aspas, o que muda o que conta como seguro — decisão própria, não ajuste de
  passagem. Comportamento anterior à ADR-005, preservado deliberadamente.
* **Limitação declarada, não corrigida aqui:** os rótulos dos botões em
  `AuthorizationManager.formatRequest()` continuam fixos em português para os canais de
  mensageria (o Dashboard usa `t()` e já fala pt/en/es). Traduzir as mensagens que o Core emite é
  trabalho próprio, de escopo bem maior que esta ADR.
* **Reversível**: o predicado tem um único ponto de definição; remover a chamada no caminho de
  goal restaura o comportamento anterior.
* **Validação exigida**: unitário + regressão + execução real do cenário exato deste documento
  (`mkdir` em SAFE pelo painel deve parar e esperar).
