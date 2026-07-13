# Investigação — Loop de repetição pós-entrega diferida (TOOL-DEDUP)

**Data:** 2026-07-13
**Branch:** `experimental/artifact-pipeline-refactor`
**Escopo:** ciclo arquitetural independente do R1-R7 (pipeline de artefatos, já encerrado e em PR). Segue o mesmo processo formal (`docs/DIRETRIZ_ARQUITETURA_2026-07-13.md`). Nenhum código alterado — só análise, conforme solicitado.

Achado por observação direta em duas execuções reais (validações ao vivo desta mesma sessão): depois de um `write`+`send_document` (diferido) bem-sucedido dentro de um step `agentloop`, o LLM continuava propondo os MESMOS dois tool calls nos ciclos seguintes, sendo bloqueado repetidamente (`[TOOL-DEDUP] Blocked repeated native call: write/send_document`, `block #1`, `#2`, `#3`) até o turno ser abortado por segurança (`abortReason=send_document`) e cair num fallback de síntese.

---

## Fase 1 — Compreensão

### O que o dedup já resolve

`computeToolInputKey()` (`src/loop/planning/computeToolInputKey.ts`) já tem um comentário de uma sessão anterior documentando exatamente esta classe de sintoma: `send_document` é chaveado por `file_path` (não pelo JSON completo dos args) especificamente porque tentativas repetidas variam legenda/args não essenciais — sem isso, o dedup "duro" nunca disparava pra essa ferramenta. Esse fix já está em produção e funciona: nas duas execuções observadas, os blocks #1/#2/#3 disparam corretamente, e **nenhuma chamada real duplicada chega a executar** (nem `write` nem `send_document` re-executam de fato).

Ou seja: **o dedup detecta e bloqueia corretamente.** O problema não é falta de detecção.

### Onde a informação "já satisfeito" para de influenciar o planejamento

Rastreando o fluxo completo (`src/loop/AgentLoop.ts`):

1. **`write` executa de verdade** (sucesso real, `cycleHistory.push(...)`, linha ~1964/2290).
2. **`send_document` é interceptado** pelo branch de goal-execution (linha 1804-1829): `channelContext.deferSendDocument(...)` registra o artefato pra entrega pós-validação, e uma mensagem `tool`-role é devolvida ao LLM: *"[DIFERIDO] Documento registrado para entrega após validação. Não reenvie este artefato. Continue apenas se ainda existirem tarefas pendentes não relacionadas à entrega deste arquivo."*
3. **`continue`** — este branch NUNCA chama `cycleHistory.push(...)`. É estrutural: os únicos 3 call sites de `cycleHistory.push` no arquivo inteiro (linhas 1964, 2290, 2634) ficam todos no caminho de execução NORMAL de tool, não no de defer.
4. **FSM: `TOOL_COMPLETED` → sempre `THINKING`** (`src/loop/AgentFSM.ts:40`) — incondicional, não importa QUAL foi a tool nem QUAL foi o resultado semântico dela. O código pergunta ao LLM "o que fazer agora?" de novo, exatamente como perguntaria depois de qualquer tool call comum.
5. O LLM recebe o histórico completo (confirmado: não há truncamento de `loopMessages` no meio do loop — só há trim no FINAL, pós-abort, linhas 2753/2816) — a mensagem "[DIFERIDO] ... Não reenvie" ESTÁ visível — mas decide propor os mesmos dois tool calls de novo.

**A causa raiz:** o código *sabe* estruturalmente que o artefato foi corretamente registrado para entrega (`channelContext.isDeferredArtifact`/o próprio ato do defer) — mas essa informação só é comunicada ao LLM como **texto em linguagem natural dentro de uma mensagem `tool`-role**, nunca como um **sinal estrutural que o FSM ou o loop usem para decidir não perguntar de novo**. A fronteira entre "o sistema sabe que terminou" e "o LLM decide o que fazer a seguir" depende inteiramente da capacidade do modelo de interpretar e agir sobre uma frase — sem nenhum mecanismo determinístico de parada além do dedup reativo (que já existe, mas só age DEPOIS de detectar a repetição, não a PREVINE).

### Achado secundário (confirmado por leitura de código, não confirmado ao vivo com certeza)

O `DELIVERY-GUARD` (linha ~2539-2616, mecanismo irmão que roda **uma vez, incondicionalmente, logo após o loop principal terminar**) calcula `sentFile` a partir de `cycleHistory.some(h => tool in [send_document,...] && status==='success')`. Como o branch de defer nunca escreve em `cycleHistory` (achado acima), `sentFile` fica `false` mesmo depois de um defer bem-sucedido. Se o `DELIVERY-GUARD` chegar a rodar depois de um `dedupAbort` causado por `send_document`, ele recalcularia `wroteFile && !sentFile` como verdadeiro e reinjetaria *"[ENTREGA PENDENTE] ... USE send_document para entregar AGORA"* — reabrindo o mesmo padrão por um caminho diferente. Não instrumentei o código pra confirmar com certeza se isso aconteceu nas duas execuções observadas (nos logs que capturei, o abort caiu direto em `[FALLBACK] Generating final synthesis`, sem `[DELIVERY-GUARD]` visível) — mas a lacuna em si (`cycleHistory` cego a defers) é real e verificável por leitura direta do código, independente de ter disparado nessas duas execuções específicas.

### Onde NÃO está o problema (descartado por evidência)

- **Memória** — não envolvida neste fluxo.
- **Estado do Goal** — `GoalStore`/`DELIVERY-REGISTRY` registram corretamente (`status=deferred_registered` → `status=delivered`, confirmado nos logs das duas execuções).
- **Representação de contexto enviada ao LLM** — `loopMessages` acumula corretamente, sem truncamento prematuro; a mensagem de defer está presente no histórico enviado em cada chamada subsequente.
- **Detecção de repetição** — funciona (dedup por `file_path`, block #1/#2/#3 disparam corretamente).

---

## Fase 2 — Crítica da hipótese

**"É só um modelo fraco (gemma4:31b-cloud/glm-5.2:cloud via Ollama) não seguindo instrução?"** Parcialmente verdade, mas não é a causa corrigível: mesmo um modelo melhor eventualmente vai interpretar mal uma instrução em linguagem natural — a própria existência de TOOL-DEDUP, `MAX_SAME_TOOL_CALLS`, `context_growth` (SAFETY-GUARD) já prova que o projeto não parte do princípio de confiar 100% em compliance do LLM. Depender de o modelo "entender direito" uma frase pra decidir parar é o tipo de fragilidade que o resto da arquitetura já foi desenhada pra não depender.

**"Reduzir o threshold de block (3→1) resolve?"** Reduz o desperdício de ciclos, mas não ataca a causa — o loop continuaria tentando pelo menos uma vez a mais do que o necessário, e não fecha a lacuna do `DELIVERY-GUARD`/`cycleHistory` (achado secundário), que é ortogonal ao threshold.

**"A amostra é pequena (2 execuções) pra generalizar?"** A CAUSA ESTRUTURAL (FSM sem short-circuit semântico, `cycleHistory` cego a defer) é verificada por leitura direta do código-fonte — não é uma inferência estatística sobre os logs. As duas execuções mostraram o mesmo padrão (mesmo par de tools, mesma progressão block#1→#2→#3, mesmo abort), consistente com a causa estrutural identificada, mas a causa em si não depende de mais amostras pra ser válida.

---

## Fase 3 — Pesquisa de alternativas

| Alternativa | Descrição | Veredito |
|---|---|---|
| **A — reduzir threshold** | `blockCount>=3` → `>=1` | Rejeitada: trata sintoma (desperdício de ciclos), não causa. Não resolve o achado secundário. |
| **B — flag de estado nova** | `turnObjectiveSatisfied: boolean` checado no topo do `while` | Rejeitada explicitamente pela diretriz desta investigação ("não propor... flags... estados extras"). Também replicaria a mesma classe de bug que a Sprint R1-R7 inteira existiu pra eliminar: mais uma fonte paralela e concorrente de "isso já foi entregue?" (a pipeline de artefatos já tinha 3+ mecanismos rastreando "entregue" antes do piloto R1-R7; não faz sentido adicionar um 4º aqui). |
| **C — transição de FSM semântica** | `TOOL_COMPLETED`, quando o resultado da tool é "objetivo do turno satisfeito" (defer de `send_document`/`send_audio`/`send_image` bem-sucedido), dispara `SYNTHESIS_REQUIRED` em vez de `THINKING` | Generaliza um mecanismo que já existe (a FSM já tem múltiplos eventos/transições, `AgentFSM.ts`) em vez de inventar um novo. Não introduz estado paralelo — usa o resultado que a tool JÁ retorna. |
| **D — padrão de indústria (orquestração determinística)** | Workflow engines (Temporal, LangGraph) tratam resultado de tool como EVENTO que dispara transição explícita de estado no grafo, não como "mais uma mensagem pro LLM decidir" | Não é uma alternativa nova, é o enquadramento que valida a Alternativa C: condicionar a transição da FSM ao resultado semântico da tool é exatamente esse padrão — controle determinístico de quando parar, não delegado inteiramente ao julgamento do modelo a cada turno. |
| **E — consolidar `cycleHistory`** | Fazer o branch de defer também escrever em `cycleHistory` (com um status que represente "diferido", não "success" pleno, pra não confundir com envio confirmado) | Fix pequeno, isolado, resolve o achado secundário (DELIVERY-GUARD cego a defer) sem depender de C. Reusa a estrutura de dados que já existe — não cria nada novo. |

---

## Fase 4 — Síntese

**Recomendação:** combinar **E + C**, nesta ordem.

- **E primeiro** (menor risco, escopo isolado): `cycleHistory` passa a registrar o defer, alinhando-o com o que `channelContext.isDeferredArtifact` já sabe. Fecha a lacuna do `DELIVERY-GUARD` sem tocar no loop principal.
- **C depois** (escopo maior, precisa de mais cautela): a FSM ganha uma transição condicional de `TOOL_COMPLETED` — quando a tool executada é de entrega (`send_document`/`send_audio`/`send_image`) E o resultado indica sucesso/defer, o próximo evento é `SYNTHESIS_REQUIRED` em vez do genérico `THINKING`.

**Por que esta ordem, e não só C:** C sozinho resolve o loop dentro do loop principal, mas não fecha a lacuna do `DELIVERY-GUARD` — que roda DEPOIS, com sua própria checagem independente. Corrigir só C deixaria uma classe de bug irmã intocada, esperando pra reaparecer por outro caminho (exatamente o padrão que a Sprint R7 já viu 2x com "agentloop opaco" antes de virar prioridade de fix).

**Riscos que permanecem, não escondidos:**
- C precisa ser escopado com cuidado pra não cortar turnos legítimos onde o usuário pediu MAIS DE UMA COISA (ex.: "envie o arquivo e depois me dê um resumo em texto") — nesse caso, `TOOL_COMPLETED` de um `send_document` bem-sucedido NÃO deveria pular pra síntese, porque ainda há trabalho real pendente. A tool call sozinha não carrega essa informação — precisaria checar se há mais instrução pendente no turno (ex.: comparar contra o plano do step, não só o resultado da tool isolada).
- Não tenho evidência de quantos OUTROS lugares no código assumem que `TOOL_COMPLETED` sempre leva a `THINKING` — mudar essa transição é uma mudança de comportamento da FSM, não um ajuste local, e merece uma leitura mais ampla de `AgentFSM.ts`/todos os call sites de `move(...)` antes de implementar.
- E é evidência-baseada e de baixo risco, mas ainda não testada — a hipótese de que ela é suficiente sozinha (sem C) pra resolver o loop OBSERVADO nas duas execuções não está confirmada, porque nas duas vezes o `DELIVERY-GUARD` não chegou a disparar visivelmente.

---

## Fase 5 — Validação

- **Baseada em evidência real ou hipótese?** O diagnóstico (Fase 1) é evidência — leitura direta de código, com linhas citadas, mais duas execuções ao vivo consistentes com ele. A escolha específica de E+C como correção é uma proposta a validar antes de implementar, não uma certeza.
- **Resolve causa estrutural ou só sintoma?** Estrutural — ataca exatamente o ponto onde "o sistema sabe" para de influenciar "o que o LLM faz a seguir", em vez de só encurtar o número de tentativas repetidas (Alternativa A, rejeitada por isso).
- **Reduz complexidade total?** Sim — C generaliza um mecanismo existente (FSM) em vez de somar um novo; E alinha uma estrutura de dados já existente em vez de criar uma nova.
- **Elimina múltiplas fontes de verdade?** Parcialmente — E alinha `cycleHistory` com `channelContext`'s registro de defer (hoje divergentes), sem introduzir uma terceira.
- **Mantém a filosofia do Cognitive Kernel?** Sim — evidência antes de abstração, sem flags/heurísticas novas (a diretriz desta investigação pedia exatamente isso).
- **Pode ser implementada incrementalmente?** Sim — E é independente e testável isoladamente; C pode vir depois, com seu próprio ciclo de Fase 1-5 se o escopo (turnos com múltiplas tarefas) exigir mais investigação.
- **Pode ser revertida facilmente?** Sim, ambas são aditivas/pontuais.

**Veredito:** análise suficiente para considerar E pronta para implementação (baixo risco, escopo isolado, evidência direta). C precisa de uma investigação adicional focada especificamente em "como distinguir turno-com-mais-trabalho-pendente de turno-satisfeito" antes de ser implementada — não é uma mudança de uma linha, é uma mudança de comportamento da FSM que merece seu próprio ciclo de crítica.

Nenhum código foi alterado nesta investigação.
