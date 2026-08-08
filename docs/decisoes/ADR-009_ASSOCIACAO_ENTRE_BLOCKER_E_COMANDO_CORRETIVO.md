# ADR-009 — Associação entre um blocker e o comando que o resolveu

> **Status:** decisão tomada em 08/08/2026. Sprint 039.
>
> Escopo: **qual política associa um blocker ao comando que efetivamente o resolveu**, quando há
> mais de um candidato. Não altera o que é capturado, nem quando, nem o ciclo de confiança da
> `RFC-003`.
>
> **Decide o enquadramento do problema e os critérios que qualquer implementação deve satisfazer.**
> Não escolhe a mecânica — isso é a fase seguinte, deliberadamente.
>
> Base factual: `docs/analises-arquiteturais/INVESTIGACAO_S158_FONTES_DE_INSTABILIDADE_2026-08-07.md`
> §9. Código conferido em `e2f3527`.

## 1. Contexto

`OperationalKnowledge.captureFromGoal()` precisa responder a uma pergunta causal: **qual dos
comandos executados neste goal fez a dependência passar a existir?** O que ela usa hoje é uma
heurística de ordenação, declarada no próprio comentário do código: *"primeiro sucesso depois do
blocker"*.

```ts
const fixAttempt = goal.attempts.find(a =>
    a.toolName === 'exec_command' &&
    a.result === 'success' &&
    a.executedAt > blocker.detectedAt &&
    ...
    !isToolExistenceProbe(a.args.command as string, blocker.missingDependency!)
);
```

## 2. Evidência

Investigação de 07-08/08/2026, encerrando a instabilidade do `S158` com cadeia completa:

| Hipótese | Resultado |
|---|---|
| Estado aprendido persistido | refutada (`:memory:` nos dois bancos) |
| Contenção entre testes paralelos | refutada (runner sequencial) |
| Dedup da issue 020 bloqueando a 2ª verificação | **refutada** — 0 ativações em 30 rodadas, incluindo as 2 que falharam |
| Sondagem de ambiente (`which`) | descartada — as asserções que falham são de promoção de confiança |

**Causa confirmada, com correlação 30/30:** quando o comando corretivo executa **no mesmo
milissegundo** em que o blocker é detectado, o `>` estrito o descarta, e a busca cai no sucesso
seguinte — gravando o comando de **verificação** no lugar do de **instalação**. Dois comandos
distintos com um sucesso cada nunca chegam a `success_count=2`, e a promoção a `validated` não
ocorre.

Toda rodada que gravou o comando de verificação falhou; toda rodada que não gravou, passou. Sem
exceção nos dois sentidos.

## 3. O problema arquitetural

A pergunta deixou de ser *"por que o `S158` falha?"* e passou a ser:

> **Qual deve ser a política para associar um blocker ao comando que efetivamente o resolveu, quando
> existem múltiplos candidatos?**

Hoje essa política é implícita — não está nomeada em lugar nenhum, não tem documento, e é inferida
de duas condições dentro de um `find()`. É por isso que ela já foi revisada uma vez sem ser
discutida como política.

### 3.1 Isto não é conserto pontual, e há precedente

A `ADR-004` (*"verificar não é instalar"*) tratou **uma face deste mesmo defeito**: a Sprint G
observou, em execução real, o sistema aprender um `where` no lugar do comando de instalação. A
correção foi excluir **sondas de existência** da candidatura.

O caso atual passa por baixo dela: `echo verificando-…` não é sonda de existência. A `ADR-004`
corrigiu **qual comando pode ser candidato**; o que resta é a **heurística de ordenação que
escolhe entre os candidatos** — e ela erra sempre que a granularidade do relógio empata com a do
fluxo.

Duas revisões da mesma heurística, motivadas por dois defeitos da mesma família, sem que a política
subjacente tenha sido decidida uma vez. É esse padrão que esta ADR interrompe.

## 4. Decisão

**1. A associação blocker → comando corretivo passa a ser uma política explícita e nomeada**, com
documento próprio, e deixa de ser efeito colateral de condições dentro de um `find()`.

**2. Qualquer implementação dessa política deve satisfazer os cinco critérios abaixo.** Eles são o
conteúdo normativo desta ADR; a mecânica que os satisfaz é escolha da fase seguinte.

### 4.1 Critérios

**C1 — Não pode depender da resolução do relógio.** Uma política cuja resposta muda conforme dois
eventos caiam no mesmo milissegundo ou em milissegundos distintos não é uma política causal; é uma
corrida. É o defeito medido.

**C2 — Deve distinguir corrigir de verificar, de forma geral.** A `ADR-004` estabeleceu o princípio
para sondas de existência. O critério aqui é o princípio, não a lista: um comando cujo propósito é
*observar* o estado não pode ser creditado por *ter mudado* esse estado, qualquer que seja a forma
dele.

**C3 — Deve falhar para o lado de não aprender.** Diante de ambiguidade irredutível, a política
registra nada e diz por quê. Aprender o comando errado é pior que não aprender: o conhecimento
errado é reutilizado com confiança crescente. Coerente com `ADR-003` (*"silêncio em vez de
chute"*) e com `NUNCA_ADIVINHAR.md`.

**C4 — Deve ser observável quando não associa.** Hoje, quando o `find()` não encontra candidato, o
código faz `continue` em silêncio. Uma política que decide não aprender precisa dizer isso, ou o
próximo a investigar repete esta investigação.

**C5 — Não pode exigir que o plano ou o LLM rotulem o passo corretivo.** `ADR-003` §4 já avaliou e
**descartou** os três candidatos desse tipo, e escolheu deliberadamente que a validação objetiva
fosse o **estado do ambiente**, não a autodeclaração do plano. Uma solução baseada em marcação
explícita reabre uma decisão publicada — o que é possível, mas exige emendar a `ADR-003`, não
contorná-la.

## 4.2 Emenda de 08/08/2026 — o relógio nunca foi necessário

Esta emenda **substitui** uma versão anterior, escrita no mesmo dia, que afirmava duas coisas
erradas: que a independência do relógio não era alcançável com a informação disponível, e que a
assimetria entre os caminhos de execução era um limite estrutural. As duas conclusões vinham de
observar o comportamento do `S158` sem verificar o fluxo de produção.

### O que a validação por leitura de código estabeleceu

A pergunta era: *todo blocker `missing_tool` tem um attempt de falha registrado antes?* A resposta é
**sim, em produção** — e não por coincidência de três caminhos independentes, mas por construção:

| Elo | Verificação |
|---|---|
| `GoalEvaluator.classifyError` é a **única** origem de `kind: 'missing_tool'` | `grep` em `src/**`: três ocorrências, duas dentro dela, uma é entrada de tabela |
| `evaluate()` é o **único** chamador de `classifyError` | um único sítio, `GoalEvaluator.ts:299` |
| Os três sítios de `evaluate()` gravam o attempt falho **antes** | `:2473` (`result: 'failure'` em `:2461`) → `:2493`; `:2110` → `:2115`; `:2396` → `:2397` |

Isto é afirmação sobre a **arquitetura**, não sobre uma amostra de 30 execuções.

### Consequências

**1. A dependência do relógio é herança, não necessidade estrutural.** A âncora posicional está
universalmente disponível no fluxo real. A comparação temporal existia porque ninguém havia mapeado
o sinal que já estava lá.

**2. O caso "blocker sem attempt falho" não pertence à produção.** Ele é introduzido por
`makeSyntheticCycleResult()` no próprio `S158`
(`src/__tests__/regression/S158_RFC003_SprintF_FullCycleIntegration.test.ts:291`), que injeta
`outcome: 'needs_dependency'` direto para isolar `handleNeedsDependencyOutcome`, sem passar por
`evaluate()` nem por `recordFailedAttempt`.

O fallback temporal que permaneceu na implementação atual **acomoda esse cenário sintético**, não um
caminho real. Removê-lo depende de decidir o que fazer com o teste — ver Seção 4.3.

**3. O `install_` muda de papel.** Deixa de ser a informação *necessária* para eliminar o relógio e
passa a ser o sinal *semanticamente correto*: identifica o passo corretivo por papel, sem depender de
ordem nenhuma. Continua sendo o refinamento mais forte disponível, por outro motivo.

### Estado dos critérios

| Critério | Estado |
|---|---|
| **C1** — não depender da resolução do relógio | **Alcançável integralmente.** A âncora posicional cobre todo o fluxo de produção. O modo temporal remanescente serve ao cenário sintético do teste, e sua remoção está condicionada à Seção 4.3 |
| **C2** — corrigir ≠ verificar, de forma geral | **Pleno.** Exclusão por papel (`verify_`), não por texto de comando. É a parte estrutural da correção do defeito medido |
| **C3** — falhar para o lado de não aprender | **Validado na prática.** Impediu duas implementações defeituosas de gravar conhecimento sem âncora: falhas ruidosas, zero conhecimento incorreto persistido |
| **C4** — observável quando não associa | **Validado na prática.** O `[OPKNOW-SKIP]` apontou a causa de cada implementação defeituosa na primeira linha do log |
| **C5** — sem rótulo do plano ou do LLM | **Pleno.** `install_`/`verify_` são gerados por `GoalExecutionLoop`, código determinístico |

### Enquadramento que a investigação produziu

A pergunta útil deixou de ser *"qual heurística substitui o relógio?"* e passou a ser:

> **Qual fato cada produtor de blocker já fornece para correlacionar blocker e remediação?**

É a mesma forma do Evidence Provider Pattern aplicada à causalidade: o produtor fornece o fato, o
consumidor aplica a política — em vez de o consumidor reconstruir a causalidade por inferência.

## 4.3 Dívida descoberta — o `S158` sintetiza um estado que produção não produz

Registrada aqui porque foi esta investigação que a encontrou, e porque uma decisão futura sobre o
`fallback` temporal depende dela.

`makeSyntheticCycleResult()` fabrica um `CycleResult` com `outcome: 'needs_dependency'` e o injeta
diretamente, para exercitar `handleNeedsDependencyOutcome()` sem montar o fluxo completo. O efeito
colateral é um goal com blocker e **sem nenhum attempt falho** — estado que o pipeline real não
alcança.

Isso **não** significa que o teste esteja errado: isolar uma unidade é legítimo. Significa que uma
conclusão arquitetural tirada do comportamento dele pode não valer para produção — como aconteceu
aqui, e como a emenda anterior demonstrou ao errar por isso.

Duas saídas, nenhuma decidida: evoluir o teste para atravessar `evaluate()`/`recordFailedAttempt`, ou
mantê-lo sintético com a simplificação documentada. Fora do escopo desta ADR.

## 5. O que esta ADR NÃO decide

Deliberadamente em aberto, para a fase de desenho:

* trocar `>` por `>=`, desempatar por ordem de inserção no array, usar contador monotônico,
  correlacionar por `planStepId`, ou qualquer combinação — **nenhuma foi escolhida aqui**;
* se a política deve ser capaz de associar **mais de um** comando a um blocker;
* se o conhecimento já gravado sob a heurística antiga deve ser invalidado ou reavaliado.

Registrar essas opções não é endossá-las. Elas aparecem aqui para que a fase seguinte não precise
redescobri-las, e cada uma terá de ser testada contra C1-C5.

## 6. Gate obrigatório — Extensão antes de Criação

Nenhuma Tool, Skill ou Script novo. A política vive onde a pergunta já é feita
(`OperationalKnowledge.captureFromGoal`), e o documento normativo, se houver, entra em
`docs/ARCHITECTURE/` junto dos demais princípios. Esta ADR não cria nem propõe arquivo de código.

## 7. Consequências

* **O `S158` deixa de ser um teste instável e passa a ser um detector.** Ele falha exatamente quando
  a política erra; enquanto a política não for corrigida, a intermitência de ~7% permanece, e é
  informação, não ruído.
* **A `issue 021` pode ser encerrada** — a cadeia de evidências está completa para as ocorrências
  inspecionáveis, e o que resta é decisão de desenho, não investigação.
* **A `ADR-004` permanece válida.** Ela decidiu corretamente sobre a candidatura; esta ADR trata da
  seleção entre candidatos, que é outra pergunta.

## 8. Limites conhecidos

* **A correlação 30/30 é de um cenário sintético.** No `S158`, blocker e correção acontecem a 1-3 ms
  de distância — proximidade anormal. **Não foi observado** se o mesmo empate ocorre em uso real,
  onde uma instalação de verdade leva segundos. A Sprint G mostra que a *família* do defeito
  aparece em produção; este empate específico, não.
* **A terceira ocorrência conhecida não pôde ser confirmada.** A falha do `S158` durante a série
  RFC-005 é compatível com o mecanismo, mas o runner preserva apenas 15 linhas de saída e o detalhe
  necessário ficou fora.
* Esta ADR trata da associação **dentro de um goal já concluído**. Não diz nada sobre goals em que a
  dependência foi resolvida fora do NewClaw.
