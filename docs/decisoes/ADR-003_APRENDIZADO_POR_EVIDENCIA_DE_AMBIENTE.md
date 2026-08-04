# ADR-003 — Aprendizado operacional por evidência de estado do ambiente

> **Status:** decisão tomada em 03/08/2026 e **implementada no mesmo dia** (`OperationalKnowledge.
> captureFromGoal()`, dois call sites em `GoalExecutionLoop`, cobertura em `S158.1`/`S158.1b`).
> Duas passagens desta ADR foram corrigidas *depois* de escrever o código, para que o documento
> continue sendo a fonte de verdade: §4.4 (a função nova prevista era desnecessária —
> `commandExists()` já existia) e §6.4 (a captura não precisou virar assíncrona). Falta a
> **Sprint G** — Validação Progressiva formal, etapa 4 (execução real), §6.5.
>
> Diferente de ADR-001 e
> ADR-002 (que registram decisões já implementadas), este documento decide antes de codificar,
> como exige a Baseline B2.0 (`ADR-001` §9) para o débito registrado em `RFC-003`.
>
> Origem: o débito "Pesquisa → Aprender" registrado em
> `RFC-003_AQUISICAO_CONHECIMENTO_OPERACIONAL.md` (seção "Débito conhecido, não corrigido — Sprint
> F"), reaberto em 03/08/2026 a pedido do operador, com investigação nova do código real.

## 1. Contexto

### 1.1 O que a RFC-003 se propôs a fazer

A RFC-003 define um ciclo de aquisição de conhecimento operacional com cinco etapas —
**Descobrir → Pesquisar → Validar → Aprender → Reutilizar** — para dependências que o
conhecimento Distribuído (`KNOWN_DEPS`, versionado em código-fonte) não resolve. As Sprints A-F
implementaram o ciclo: consulta tática (`getTacticalCommand`), ramo de Pesquisa no
`GoalEvaluator`, step de verificação injetado, modelo de confiança (`computeConfidenceLevel`) e
uma auditoria de integração ponta a ponta.

A etapa **Validar** existe por uma razão nomeada na própria RFC: aprendizado só é creditado
mediante *fato observável*, nunca mediante julgamento — nem do LLM, nem de heurística. É o que
separa `OperationalKnowledge` (conhecimento Aprendido, local, validado objetivamente) de um cache
de palpites.

### 1.2 O que a Sprint F já havia encontrado

A Sprint F (`S158_RFC003_SprintF_FullCycleIntegration.test.ts`, caso S158.1) provou, com teste de
ponta a ponta, que a etapa **Aprender** nunca é alcançada pelo caminho **Pesquisar**: a captura
exige um step com id prefixado `verify_`, e esse prefixo só nasce no caminho determinístico
(`needs_dependency`). O plano que o LLM gera depois de pesquisar recebe ids `step_N` de
`sanitizePlanSteps.ts:363` — nada no prompt pede outra coisa.

A Sprint F deliberadamente não corrigiu: fechar a lacuna exige decidir *como* um plano sinaliza
"este step é a verificação objetiva", o que é decisão de responsabilidade, não conserto de fiação.
Esta ADR é essa decisão.

### 1.3 Investigação de 03/08/2026

Antes de escolher entre os candidatos que a Sprint F registrou, o mecanismo atual foi lido de
ponta a ponta no código real. O resultado mudou o tamanho do problema — ver Achados.

## 2. Achados

### 2.1 O gate `verify_`

`OperationalKnowledge.captureFromGoal()` ([`src/memory/OperationalKnowledge.ts:187`](../../src/memory/OperationalKnowledge.ts))
só credita aprendizado quando encontra, depois do `fixAttempt`, um attempt bem-sucedido cujo
`planStepId` começa com `'verify_'` (linhas 201-205). Sem isso, a captura é pulada com log
`[OPKNOW-CAPTURE] ... sem step de verificação bem-sucedido depois`.

### 2.2 O prefixo depende de `verifyCmd` estar declarado

O único ponto do sistema que gera esse prefixo é
`GoalExecutionLoop.handleNeedsDependencyOutcome()`
([`src/loop/GoalExecutionLoop.ts:957`](../../src/loop/GoalExecutionLoop.ts)), e ele só injeta o
step quando `autoInstall && depInfo.verifyCmd`.

### 2.3 `verifyCmd` existe em uma única entrada do catálogo

`KNOWN_DEPS` tem ~26 entradas; exatamente **uma** declara `verifyCmd`: `ffmpeg`
([`src/loop/GoalEvaluator.ts:53`](../../src/loop/GoalEvaluator.ts)). Isso é correto e deliberado —
a Sprint D aplicou "Nunca Adivinhar" e não inventou comando de verificação para as demais.

### 2.4 A única entrada com `verifyCmd` só resolve instalação no Linux

`ffmpeg` **não** tem `installByPlatform` (ausência também deliberada, para não reproduzir o
anti-padrão que motivou a RFC). `resolveInstallCommand()`
([`src/loop/planning/resolveInstallCommand.ts:28-33`](../../src/loop/planning/resolveInstallCommand.ts))
só recorre ao `installCmd` legado quando `os.platform === 'linux'`. Em Windows e macOS o comando
resolve para `undefined` → `autoInstall === false` → nenhum step `verify_` é injetado.

### 2.5 Conclusão: o mecanismo está praticamente inativo

Encadeando 2.1 → 2.4, `captureFromGoal()` consegue creditar aprendizado hoje em **uma única
combinação**: Linux + `ffmpeg`. Em Windows e macOS, nenhuma dependência, por nenhum caminho.

Isso reenquadra o débito. Ele não é "o caminho Pesquisa não aprende, enquanto o caminho
Distribuído aprende". É: **a etapa Aprender está desligada em quase todo cenário real**, e o
caminho Pesquisa — o caso central que motivou a RFC-003 — é apenas onde isso é mais visível.

## 3. Problema arquitetural

### 3.1 Aprendizado baseado em caminho, não em fato

O gate atual pergunta *"por qual ramo de código este goal passou?"* (o prefixo `verify_` é um
carimbo de origem: só existe se o outcome foi `needs_dependency`). A RFC exige perguntar *"a
dependência ficou disponível?"*. São perguntas diferentes, e a primeira não implica a segunda: um
goal pode instalar a dependência de verdade e não aprender nada (caminho Pesquisa), e o mesmo
fato objetivo — a dependência passou a existir — é creditado ou ignorado dependendo de qual código
o produziu.

### 3.2 Acoplamento ao Planner

Os candidatos registrados na Sprint F que preservam o gate empurram o problema para o Planner:
seria preciso o LLM nomear, no JSON do plano, qual step é a verificação. Isso faz um componente de
memória depender do formato de saída do Planner e obriga a estender o contrato de plano
(`PlanStep` em [`src/shared/domainTypes.ts:103`](../../src/shared/domainTypes.ts),
`sanitizePlanSteps.ts`, prompt de plano e prompt de replan) para servir a essa memória.

### 3.3 Violação do princípio de evidência objetiva

Um rótulo `"role": "verify"` produzido pelo LLM é uma **afirmação de quem escreveu o step de
instalação** sobre o próprio trabalho. O código de saída do comando continuaria sendo objetivo,
mas *qual* comando conta como prova passaria a ser decidido por julgamento — exatamente o que a
etapa Validar da RFC-003 existe para impedir, e o que
`docs/ARCHITECTURE/NUNCA_ADIVINHAR.md` proíbe como fonte de fato.

## 4. Alternativas consideradas

### 4.1 Rotular steps (candidato (a) da Sprint F)

O Planner declara no JSON qual step é a verificação (`"role": "verify"` ou convenção equivalente).

* **A favor:** mantém o mecanismo de captura atual quase intacto; funciona para qualquer tipo de
  dependência, não só binários no PATH.
* **Contra:** §3.2 e §3.3 — acopla memória a Planner, estende o contrato de plano para todos os
  planos por causa de um caso, e transforma prova em autocertificação.
* **Descartada.**

### 4.2 Heurísticas (candidato (b))

`GoalExecutionLoop` infere a verificação — por exemplo, "o último step bem-sucedido do ciclo de
replan que motivou o blocker".

* **A favor:** não muda contrato nenhum.
* **Contra:** a própria RFC-003 já registra que isso é incompatível com a exigência de validação
  objetiva; troca uma prova por uma correlação temporal.
* **Descartada.**

### 4.3 Promoção manual para `KNOWN_DEPS` (candidato (c))

Aceitar que o caminho Pesquisa nunca alimenta `OperationalKnowledge` e depender de um humano
promover casos repetidos ao catálogo via PR.

* **A favor:** preserva integralmente a Separação Distribuído × Aprendido; custo zero de
  implementação.
* **Contra:** descarta o aprendizado automático que as Sprints A-F construíram, e — à luz do
  Achado 2.5 — não é "manter o que existe", é assumir que a etapa Aprender nunca funcionará em
  Windows/macOS. Continua disponível como caminho complementar, não como resposta ao débito.
* **Descartada como solução única.**

### 4.4 Verificação objetiva do ambiente (escolhida)

Não perguntar qual step foi a verificação; perguntar diretamente ao sistema operacional se a
dependência existe agora. A tripla de evidência fica:

1. **ausente em T0** — o blocker `missing_tool` nasceu de um erro real de "não encontrado";
2. **algum `exec_command` teve sucesso em T1 > T0** — já registrado hoje (`fixAttempt`);
3. **presente em T2 > T1** — probe do ambiente.

* A primitiva do item 3 **já existe**: `commandExists()`
  ([`src/utils/crossPlatform.ts:88`](../../src/utils/crossPlatform.ts)) — `where.exe` no Windows,
  `which` no Unix, veredito pelo próprio sucesso da chamada, sem shell e sem parsing de saída.
* **Descartado no caminho:** a primeira leitura mirou `probeToolCmd()` (linha 96 do mesmo arquivo),
  que o `EnvironmentProbe` usa. Ela **não serve** como veredito: sempre sai com código 0
  (`... || echo MISSING:<tool>`), porque foi escrita para ser *parseada* por linha. Um step de
  verificação construído sobre ela "passaria" enquanto imprime `MISSING`. Chegou-se a planejar uma
  função irmã com veredito por exit code — desnecessária: `commandExists()` já é exatamente isso,
  duas funções acima no mesmo arquivo.
* **Gate "Extensão antes de Criação" (Diretriz, Fase 3):** nenhuma Tool nova, nenhuma Skill nova,
  nenhum script novo, nenhum arquivo novo — e, depois da segunda passada acima, **nenhuma função
  nova**. Só um parâmetro a mais em `captureFromGoal()`.
* **Contra (declarado, não escondido):** responde apenas "binário no PATH" — ver §5.4 e §6.3.

## 5. Decisão

### 5.1 O aprendizado passa a depender de evidência do estado do ambiente

`captureFromGoal()` deixa de exigir o prefixo `verify_` como prova. A prova passa a ser o
resultado de um probe objetivo do ambiente, executado depois do `fixAttempt`, confirmando que a
dependência está disponível. O gate vale igualmente para os dois caminhos (Distribuído e
Pesquisa) — o aprendizado deixa de depender de por qual ramo de código o goal passou.

### 5.2 O step `verify_` permanece, com outro papel

O step injetado pela Sprint D **não é removido**. Ele continua útil como sinal *mid-goal*: falha
de verificação logo após a instalação alimenta o replan com informação correta antes de o goal
prosseguir. O que muda é que ele deixa de ser o **único** gatilho de captura — passa a ser um dos
caminhos pelos quais a evidência pode aparecer, não a definição do que conta como evidência.

### 5.3 O probe roda no loop; a memória continua sem I/O

A capacidade de observar o ambiente é **injetada pelo `GoalExecutionLoop`** nos dois call sites de
captura que já existem ([`GoalExecutionLoop.ts:1371`](../../src/loop/GoalExecutionLoop.ts) e
[`:1981`](../../src/loop/GoalExecutionLoop.ts)), ambos já condicionados a "goal genuinamente
concluído": `captureFromGoal(goal, commandExists)`. `OperationalKnowledge` decide *se* precisa da
resposta e a consome — nunca importa `child_process`, nunca executa comando por conta própria.

Duas razões, ambas verificadas no código:

* **Fronteira de componente:** `OperationalKnowledge` é componente de conhecimento
  (`EVIDENCE_PROVIDER_PATTERN.md`); dar-lhe execução de comando o transformaria em outra coisa.
* **Superfície de falha:** a alternativa — injetar mais um step de verificação no plano — faria um
  step que falha entrar nos contadores de falha consecutiva e no `SAFETY-GUARD`. Verificar no
  momento da captura não altera o plano nem cria caminho novo de falha para o goal.

### 5.4 Só binário no PATH é capturado; o resto continua em silêncio

O probe responde "existe um executável com este nome no PATH". Para dependências que são pacote
Python ou módulo Node (`probeVia: 'node-require'` no catálogo), essa é a pergunta errada e a
resposta seria um falso `MISSING`. Nesses casos **não há captura** — silêncio, não chute
(`NUNCA_ADIVINHAR.md`). Isso não é regressão: hoje esses casos também não capturam.

### 5.5 O que a decisão não muda

O elo causal continua sendo heurístico: `fixAttempt` é o *primeiro* `exec_command` bem-sucedido
depois do blocker, e o probe prova o **estado**, não a **causalidade**. Essa limitação já existe
hoje, já está documentada no próprio `captureFromGoal()`, e esta ADR não a resolve nem a agrava.
Registrada aqui para não ser lida como resolvida.

**Atualização de 04/08/2026 — esta limitação deixou de ser abstrata.** A Sprint G (§6.5, etapa 4)
observou, em execução real, o primeiro caso concreto: o LLM rodou `where sprintg-tool3 || echo
"NOT FOUND"` antes do comando que de fato criou o binário, e a heurística gravou o **diagnóstico**
como conhecimento operacional (`[OPKNOW-CAPTURE] ... command="where sprintg-tool3 ..."
evidence=environment_state`). Com repetição, um registro assim atingiria `validated` e viraria
atalho tático — um "comando de instalação" que não instala nada. A fraqueza é anterior a esta ADR
(vem da RFC-001/Sprint D), mas foi esta ADR que a tornou alcançável, ao destravar o aprendizado
fora de Linux + `ffmpeg`. Uma classe desse defeito foi fechada em
`ADR-004_SELECAO_DO_COMANDO_APRENDIDO.md` (um probe da própria dependência deixa de ser elegível
a `fixAttempt`). O restante do problema de causalidade **permanece aberto**: a ADR-004 remove um
falso-positivo observado, não prova que o comando creditado seja o que instalou.

## 6. Consequências

### 6.1 O Planner permanece inalterado

Nenhuma mudança em `GoalPlanner`, no prompt de plano, no prompt de replan, em `PlanStep`
(`domainTypes.ts`) ou em `sanitizePlanSteps.ts`. O LLM não passa a ter obrigação de bookkeeping
para um componente de memória, e o contrato de plano não cresce.

### 6.2 Menor acoplamento

A captura deixa de depender de qual ramo do `GoalExecutionLoop` produziu o step, do formato do id
de step, e de `verifyCmd` estar preenchido no catálogo. Depende de um fato do sistema operacional.
Efeito colateral direto do Achado 2.5: a etapa Aprender passa a poder ocorrer em Windows e macOS,
onde hoje é estruturalmente impossível.

### 6.3 Extensibilidade futura

O `EnvironmentProbe` já possui as outras duas formas de verificação —
`runPython3Import()` e `probeNodeRequire()` ([`src/core/EnvironmentProbe.ts`](../../src/core/EnvironmentProbe.ts)).
Quando houver evidência real de necessidade, o mesmo desenho aceita escolher a forma de probe pelo
`type`/`probeVia` da dependência, sem mudar o gate nem o contrato de captura. **Fora do escopo
desta ADR** — registrado como extensão prevista, não como trabalho aprovado.

### 6.4 Custos aceitos

* A captura passa a poder rodar `where.exe`/`which` (ordem de dezenas de milissegundos, teto de
  3s embutido em `which()`) por dependência candidata, apenas em goals já concluídos que tiveram
  blocker `missing_tool` — não é caminho quente. `commandExists()` é síncrono, então essa chamada
  bloqueia o event loop enquanto dura; foi aceito por ser raro, curto e não estar em caminho de
  requisição. **A previsão original desta ADR (§6.4, antes da implementação) era tornar
  `captureFromGoal()` assíncrono** — não foi necessário: o probe só é consultado quando a
  evidência já registrada no goal não basta, e mantê-lo síncrono evitou propagar `async` para dois
  call sites e para os testes. Se algum dia o custo aparecer em medição, trocar por uma variante
  assíncrona é mudança local.
* **Falso positivo conhecido, herdado do probe:** no Windows, `where.exe` encontra os *App
  Execution Alias* da Microsoft Store (stub de `python3` sem Python instalado) — limitação já
  documentada em `EnvironmentProbe.ts` para esse caso específico. Uma dependência nessa situação
  poderia ser creditada como presente. Não é mitigado aqui: mitigar exigiria probe por runtime
  (§6.3), e o caso já era falso positivo em todo o resto do sistema antes desta decisão.
* Um segundo mecanismo de verificação passa a coexistir com o step `verify_` da Sprint D. É
  deliberado (§5.2), mas é complexidade real: dois lugares onde "verificação" acontece, com
  propósitos distintos (replan × captura). Devem permanecer nomeados de forma distinta no código
  para que ninguém os confunda depois.

### 6.5 Como será validado

Validação Progressiva (`DIRETRIZ_ARQUITETURA_2026-07-13.md`), as quatro etapas:

1. **Unitário** — a nova função de probe (veredito por exit code) em Windows e Unix.
2. **Regressão** — suíte completa, incluindo `S142`, `S141`, `S158` (que hoje documenta a lacuna
   em S158.1 e precisará refletir a decisão) e um caso novo cobrindo captura pelo caminho
   Pesquisa.
3. **End-to-end sintético** — ciclo `blocked` (Pesquisa) → replan → instalação → captura, com LLM
   e filesystem mockados.
4. **Execução real** — instância isolada (skill `verify`), LLM real, dependência genuinamente
   ausente do sistema. Para simular ausência, renomear o diretório do binário real e restaurar em
   seguida — **nunca** filtrar o `PATH` do processo (quebra a resolução do `cmd.exe`; lição
   registrada no teste ao vivo de 28/07/2026).

### 6.6 Reversibilidade

A mudança é reversível de forma trivial: o gate de captura volta a exigir o prefixo `verify_`. Não
há migração de esquema, não há dado persistido em formato novo — `operational_knowledge` continua
com as mesmas colunas. Registros aprendidos enquanto a decisão esteve ativa permanecem válidos e
continuam sendo lidos pelo mesmo `computeConfidenceLevel()`.
