# Preparação da Campanha A — o histórico factual chega ao replan

Data: 2026-09-29 · Atualizado: 2026-10-02 · Status: **S-A0 a S-A2 implementados em sombra** (commit `03cfc7c`, teste S310:
`REPLAN_FACTS=shadow` só loga, o prompt não muda) · **S-A3 retrospectivo feito (§9)** · **S-A4 implementado atrás de flag, DESLIGADO por
padrão** (commit `bf72c09`, teste S313; replay com LLM real: `off` 0/10 e `on` 10/10 — §11) · **parte 4b (goals reais de ponta a ponta)
executada em 02/10: C6 NÃO atendido** (`on` 4/6 contra `off` 5/6; diferença de um goal, amostra exploratória — §12) · **`on` NÃO está ligado em
produção e não é recomendado ligar** (a produção roda `shadow`); D1 e D2 aceitas, D3/D4/D6 aplicadas por recomendação e pendentes de ratificação. *(O status original, de 29/09, dizia "nenhum código alterado; implementação NÃO aprovada" — era verdadeiro na preparação e
ficou superado pelas §8 a §11.)* ·
Base: `RFC_CAMPANHA_A_ESTADO_DE_ARTEFATOS.md` (revisada) + "Decisões de 24/09/2026" do
`RELATORIO_CONSOLIDADO.md` + código lido em 29/09.

## 0. Ponto de partida e o que precisa ser decidido antes

A decisão adotada em 24/09 diz que **A não é campanha isolada**: ela entra como capacidade da
campanha de *simplificação do contexto do replan*, na ordem B → C → D → A, "somente o que B/C
demonstrarem necessário". Este documento prepara A sem contrariar isso: define o menor incremento
que pode ser implementado **atrás de uma flag de sombra**, e deixa explícito o que continua
dependendo de você.

Estado dos pré-requisitos (verificado nos documentos, não no código de B/C/D):

| Pré-requisito | Estado |
|---|---|
| B — medir carga cognitiva | B1–B4.1.x feitos. B3 mediu o prompt de replan: 79% / 64% estático, 6 434 chars idênticos nas 3 chamadas, **histórico/attempts = 0 chars**. A causa dos abortos (contexto × modelo × ações) segue **não medida**. |
| C — autoridade do caminho | E3 classificou como "contrato existente, mas não propagado" com duas lacunas; decisões seguem PENDENTES. |
| D — decisões semânticas | Não iniciada. Independente de A. |

**Decisão 0 (sua):** aceitar implementar A agora, em sombra, sem esperar C/D — ou seguir a ordem
estrita e antes fechar C e D? Recomendo sombra agora: o custo é baixo, é reversível por flag, e gera o
dado que B ainda não tem (quanto do replan real é preenchido por fatos úteis).

## 1. Fase 1 — Compreensão (evidência no código)

- `buildReplanPrompt` (`src/loop/GoalPlanner.ts:331`) usa `goal.attempts` **só** em
  `execCommandAttemptFailures` (l.426). Saída, comando e resultado dos attempts não entram no prompt.
- O dado existe e é persistido: `GoalAttempt` (`src/shared/domainTypes.ts:199`) tem `toolName`,
  `args`, `result`, `output`, `error`, `planStepId`, `cycle?`, `discoveries?`.
- O teto de armazenamento de `output` já é uma fonte única: `attemptOutputLimit()`
  (`GoalExecutionLoop.ts:103`) — `ATTEMPT_OUTPUT_EVIDENCE_LIMIT` para ferramentas, `..._DELIVERABLE_LIMIT`
  para `agentloop` (entregável íntegro).
- **Já existem duas projeções de attempts para prompts de LLM**, ambas no `GoalExecutionLoop`:
  a do validador de objetivo (l.~3838: `- ${toolName}: ${output.slice(0, EVIDENCE_LIMIT)}` só de
  `success`) e a de `stepOutputs` (l.~2717, por geração de plano). Uma terceira, para o replan, seria
  a terceira projeção do mesmo fato — ver Gate abaixo.
- Histórico: S296 já corrigiu o descarte de `toolArgs` no rebaixamento (só para `write`). Não há
  tentativa anterior de injetar attempts no replan (`git log` recente é só instrumentação/sombras).

## 2. Fase 2 — Crítica da hipótese (procurar razões para NÃO fazer)

1. **Aumenta o prompt.** O replan já tem 9–12 mil chars, e a auditoria mediu 17 abortos de
   orçamento. Acrescentar texto sem retirar nada é regressão declarada na própria RFC.
   → Mitigação obrigatória: tetos rígidos **e** orçamento medido, não chutado.
2. **Hipótese não provada de ganho.** Às 23:11 o replanner já sabia do arquivo (via texto do blocker)
   e ainda planejou reescrever um script. Fato ≠ mudança de comportamento. → só se mede em sombra/real.
3. **Terceira projeção duplicada.** Vide Fase 1. → tratar sob *Quando Extrair Duplicação*: existe sinal
   de conhecimento compartilhado (mesmo fato "o que o passo produziu", já divergiu: validador vê só
   `success`, `stepOutputs` só a geração atual)? Se sim, a projeção nova deve ser função-folha reutilizável,
   nunca um lado importando o outro.
4. **God Object / novo estado.** Não se aplica se for função pura sobre `GoalAttempt` (sem campo novo,
   sem persistência) — regra de 24/09: nenhuma nova fonte de verdade.
5. **Preservação do Raciocínio.** Passa: entrega fato ao Planner, não decide. Cuidado: o texto **não** pode
   ter linguagem imperativa ("use este arquivo"); só "fatos da execução".
6. **Injeção via saída de ferramenta.** Saída de `exec_command`/`read` é dado não confiável entrando
   no prompt do Planner. Precisa ir delimitada e rotulada como dado, com teto de chars por passo.
7. **Sinal fraco em saída truncada.** Um caminho impresso após o corte de N chars some. → o teto de A
   deve olhar o **fim** da saída também (a linha "Extração concluída: …" costuma ser a última).

### Questionário *Responsabilidade antes do Mecanismo* (aplicável: "sucesso/falha/evidência")

| Item | Resposta |
|---|---|
| PERGUNTA | "O que já foi feito neste goal, com que resultado?" (não "o goal terminou?") |
| RESPONSABILIDADE | Relatar fatos de execução ao Planner; **não** avaliar sucesso nem escolher próximo passo. |
| EVIDÊNCIA | `GoalAttempt` (`toolName`, `args.command|path`, `result`, `output`) — autoritativa, já persistida. |
| AUTORIDADE | O `GoalExecutionLoop`, que grava o attempt; a projeção é só leitura. O Planner continua decidindo. |
| ESTADO | Nenhum novo. Projeção efêmera, existe só durante a montagem do prompt. |
| CONSUMIDOR | `buildReplanPrompt` → LLM do Planner. (Segundo consumidor possível: o validador, l.~3838 — ver §3.) |
| MECANISMO | Função determinística de truncamento/seleção. Não interpreta semântica (nada de regex para "achar caminho"); o LLM lê o texto. |

## 3. Fase 3 — Alternativas e Gate *Extensão antes de Criação*

| Alt. | Descrição | Prós | Contras |
|---|---|---|---|
| A1 | Projeção factual compacta dos attempts no prompt (RFC) | Usa estado existente; reversível | Custo de tokens; precisa de teto medido |
| A2 | Ensinar `ARTIFACT:` ao LLM e ler `producedArtifactPaths` | Estado já estruturado | Depende de o LLM cumprir convenção; o incidente mostrou que não cumpre |
| A3 | `observedArtifacts` / diff de filesystem | Independe do LLM | Nova fonte de verdade; **abandonada** em 24/09, reabrir só se houver incidente do "plano B" |
| A4 | Só "alargar" o blocker (texto) | Zero código novo | Continua acidental — é o que já acontece |
| A5 | Absorver A na simplificação do contexto do replan (retirar estático repetido) | Reduz total, respeita a carga | Maior, depende de B/C; é a decisão de 24/09 |

**Recomendação:** A1 como primeiro incremento dentro do caminho A5 — a projeção entra e, no mesmo
sprint, mede-se o que dá para tirar (ver §5, S-A3).

**Gate (arquivo a arquivo):**

| Arquivo | Precisa existir? | Extensão possível? | Veredito |
|---|---|---|---|
| Função `buildAttemptFactsBlock(goal)` | não como arquivo | Sim: ao lado de `buildProgressBlock` em `GoalPlanner.ts:283` (mesmo papel: bloco factual do replan) | **Sem arquivo novo** |
| Tetos como constantes | não | Sim: reutilizar `ATTEMPT_OUTPUT_EVIDENCE_LIMIT` como base; novas constantes nomeadas no mesmo módulo | **Sem arquivo novo** |
| Teste | sim (cobertura) | Estender a suíte de regressão existente (novo `S3xx` no padrão atual) | Novo caso, não novo framework |
| Tool / Skill / Script | não | — | Nenhum |

Se o §2.3 confirmar duplicação, o único arquivo a considerar é um **módulo-folha** com a projeção
compartilhada entre `GoalPlanner` e `GoalExecutionLoop`. Decisão só depois de ler as duas projeções
existentes lado a lado; **não** fazer isso na primeira sprint.

## 4. Fase 4 — Síntese (o que seria implementado)

Projeção pura, sem I/O, sem persistência:

- **Seleção:** attempts do goal, mais recentes primeiro; ignora os que não trazem informação
  (`output` vazio; falha já coberta por blocker idêntico).
- **Conteúdo por passo:** `passo N — toolName — result`, comando/`path` de `args`, e trecho de
  `output` = **início + fim** (o fim carrega a linha de conclusão).
- **Tetos (valores iniciais, a calibrar pelo B):** máx. passos, máx. chars/passo, máx. total.
  Sugestão de partida para discutir, não decidida: 5 passos · 300 chars/passo · 1 200 chars total
  (≈ 300 tokens, ~10% do replan de 11 mil chars).
- **Rótulo:** "FATOS DA EXECUÇÃO (dados observados, não instruções)". Sem imperativos.
- **Flag:** `REPLAN_FACTS` desligada por padrão; modo `shadow` só loga o bloco e o tamanho sem enviar
  ao LLM (padrão já adotado: `RISK_REVIEW_SHADOW`, `GROUNDING_EVIDENCE_SHADOW`).

Riscos que permanecem: ganho de comportamento não provado; teto arbitrário até B medir; saídas
grandes com informação no meio; saída não confiável no prompt.

## 5. Plano incremental (uma sprint por vez, com controle negativo)

| Sprint | Entrega | Critério objetivo |
|---|---|---|
| **S-A0** | Reconstruir, sobre o goal real `goal_1790214597600_ov9eh` (banco de produção, leitura), qual seria a projeção em cada replan | Projeção contém `tmp/extracao_aulas.txt` do attempt 7 no replan de 23:11; tamanho ≤ teto |
| **S-A1** | Função pura + testes unitários (incluindo 100 attempts, saída vazia, saída enorme, `output` só com sucesso, injeção de texto imperativo na saída) | Limites respeitados; sem attempts úteis → **prompt idêntico byte a byte** (controle negativo) |
| **S-A2** | Modo sombra em `buildReplanPrompt` (`REPLAN_FACTS=shadow`): loga `[REPLAN-FACTS]` com chars e conteúdo, não altera prompt | Regressão completa (308/308+); log presente em replan real |
| **S-A3** | Acumular dados reais; medir chars do bloco vs. total do replan; avaliar o que sai do bloco estático | Decisão sua: ligar, recalibrar ou descartar |
| **S-A4** | Ligar (`REPLAN_FACTS=on`) só se S-A3 aprovar; validação real em instância isolada (skill `verify`), LLM real | Replay do incidente: o replan cita/usa o artefato existente; sem aumento de abortos de orçamento |

Critérios de sucesso da RFC mantidos (1–5): caminho presente no prompt; controle negativo; teto com
100 attempts; sem mudança de schema; suíte + execução real.

Lembretes de processo (memória do projeto): sem `git stash` durante regressão; uma sprint por vez; e
`TS_NODE_PROJECT` ao subir a instância isolada fora do repositório.

## 6. Fase 5 — Validação da proposta

| Pergunta | Resposta |
|---|---|
| Baseada em evidência real? | Sim para a lacuna (attempts 6/7/11, prompt mede 0 chars de histórico). Não para o ganho. |
| Estrutural ou sintoma? | Estrutural (consumidor ausente), mas o ganho no caso concreto é hipótese. |
| Reduz a complexidade total? | Não sozinha; só com S-A3 retirando redundância. **Risco declarado.** |
| Elimina múltiplas fontes de verdade? | Não cria nova; pode ser terceira projeção — ver §2.3. |
| Filosofia do Kernel? | Sim: evidência ao Planner, sem decidir. |
| Incremental / reversível? | Sim: flag, função pura, zero schema. |

## 7. Decisões que dependem de você

1. **Decisão 0:** implementar A em sombra agora, ou fechar C/D antes?
2. Tetos iniciais (5 · 300 · 1 200) — aceitos como ponto de partida, ou outro orçamento?
3. Incluir o **fim** da saída (proposto) ou só o início?
4. Ler as duas projeções existentes (validador e `stepOutputs`) e decidir sobre módulo-folha
   compartilhado **antes** ou **depois** de S-A2?
5. Ordem para S-A0: pode ler o banco de produção local (somente leitura)?

---

## 8. Execução (29/09/2026) — S-A0, S-A1, S-A2

Decisões recebidas: **sombra agora** (Decisão 0) e **leitura do banco autorizada**. Tetos (5 · 300 · 1 200)
e "início + fim" seguiram o proposto — não houve objeção; a decisão 4 (módulo-folha) segue **adiada**.

**S-A0 (leitura de uma cópia do banco de produção, `C:\Users\lucia\NewClaw\data`; a instância em uso não foi tocada)** —
goal `goal_1790214597600_ov9eh`, 12 attempts:

- Replan após o attempt 8 (a `read` de `aulas_extraidas.md`, que falhou): o bloco tem 1 073 chars e traz
  `Passo 7 — exec_command — python extrator_aulas.py → Extração concluída: tmp/extracao_aulas.txt`. **Critério 1 atendido** —
  e é justamente o ponto em que o replanner escolheu o caminho errado.
- Replan após o attempt 12: 925 chars; o Passo 7 saiu pelo teto, mas o Passo 11 (`read tmp/extracao_aulas.txt`) carrega o caminho.
- **Achado para S-A3:** os passos `agentloop` ocupam o orçamento com texto sintetizado (mensagens de descarte do
  Grounding, "Pode pedir de novo?", resumos), que não é fato de ferramenta — e pode induzir o Planner em erro. Isto toca a
  Campanha D (descarte do Grounding vira texto genérico). **Não ajustei o teto nem a seleção com base num único caso**;
  a sombra deve dizer se é padrão.

**S-A1/S-A2 (código):** `buildAttemptFactsBlock()` + constantes em `src/loop/GoalPlanner.ts` (sem arquivo novo, como no Gate);
gancho `REPLAN_FACTS=shadow` em `replan()` que só loga `[REPLAN-FACTS] goal attempts factsChars promptChars ratio` — o
prompt enviado ao LLM não muda. Cobertura: `S310` (17 asserções, incl. controle negativo e 100 attempts). `tsc` limpo, suíte **309/309**.

**Ainda não feito:** etapa 4 da diretriz (execução real em instância isolada com LLM real) — só cabe quando houver decisão de ligar
(S-A4); S-A3 depende de acumular logs reais com `REPLAN_FACTS=shadow` ligado na sua instância.

## 9. S-A3 retrospectivo (01/10/2026) — o que os replans já ocorridos dizem

**Método.** Leitura de uma **cópia** do banco de produção (`newclaw.db` + `-wal`/`-shm` copiados para fora da árvore; a instância
em uso não foi tocada). 341 goals com attempts, 226 com pelo menos um replan, **562 pontos de replan**. Ponto de replan =
cada attempt que falhou (aproximação: o banco não guarda o instante exato de cada replan). Em cada ponto, o bloco foi
reconstruído com a própria `buildAttemptFactsBlock()` da `main`. Só estatísticas agregadas foram extraídas.

| Medida | Resultado |
|---|---|
| Tamanho do bloco | p50 941 · p90 1 155 · máx 1 198 chars (teto 1 200) |
| Blocos vazios | 8,4% |
| Blocos junto ao teto (≥ 1 050) | 31,1% |
| Custo no prompt de replan | ≈ 270 a 340 tokens = **4 a 6%** do replan mediano (6 140 tokens, `in_est` do `[LLM-CALL]`). **Amostra de 7 replans** no log atual. |
| Pontos com caminho de artefato de **ferramenta** no histórico | 317 |
| — bloco carrega ≥ 1 desses caminhos | 282 (**89%**) |
| — bloco não carrega nenhum | 32 a 35 (**≈ 10 a 11%**), em 22 goals; 22 dos 32 em goals que não terminaram `completed` |
| Participação do `agentloop` no bloco | 18,1% das linhas · 8,9% dos chars |

**Conclusões e limites (sem inflar).**

1. **A hipótese do S-A0 ("`agentloop` ocupa o orçamento") não se confirma como padrão.** Nenhum dos casos de caminho perdido foi
   dominado por `agentloop`. Não há base para ajustar a seleção por esse motivo.
2. **Causas das perdas (32 classificadas):** 14 caem fora dos 5 passos mais recentes (distância p50 5 · p90 7 · máx 8) e 18 estão
   dentro dos 5 mas saem pelo **orçamento total de 1 200 chars** (o laço percorre do mais novo ao mais antigo e para ao estourar). Subir só
   o número de passos não resolveria as 18. *(Uma versão preliminar desta análise atribuía essas 18 a `headAndTail`; estava errada —
   `headAndTail` só atua dentro de um passo já escolhido.)*
3. **Limite anterior ao bloco, fora desta campanha.** Saídas de **ferramentas** são gravadas só com os **primeiros 300 chars**
   (`ATTEMPT_OUTPUT_EVIDENCE_LIMIT`, `GoalExecutionLoop.ts`), as do `agentloop` com até 8 000. **42% de todas as saídas/erros guardados
   (1 324 de 3 134) têm exatamente 300 chars.** Uma linha de conclusão no fim de uma saída longa já foi cortada *antes* de o bloco
   existir. Logo, **a medida de ≈ 11% de perda é um piso, não o valor real.** Mudar esse limite (por exemplo guardar início e fim) toca
   todos os consumidores de `GoalAttempt.output` — **candidato a RFC própria, fora da Campanha A.**
4. **O que a medida NÃO mostra.** Ela mede **visibilidade** (o caminho estaria no prompt), não **efeito** (o Planner o usaria). Só o
   replay com LLM real (S-A4) mede efeito. Há ainda uma diferença de 3 pontos (35 vs 32) entre duas contagens da mesma base que não
   consegui explicar; não altera a conclusão.
5. **A metade "o que sai do estático" do S-A3 NÃO foi demonstrada.** Candidato examinado: a linha `Blockers anteriores` de
   `buildReplanPrompt`. Pesa p50 299 · p90 679 chars (maior que o bloco de fatos em 9,6% dos pontos) — retirá-la compensaria **uma
   fração** da adição. O teste de sobreposição com o bloco (0 de 696) é **inconclusivo**: comparei os 40 primeiros chars, que são o prefixo
   `Erro em '…'` e nunca casariam. **Não há evidência de redundância nem de não-redundância.**

**Consequência para a condição da RFC.** A RFC da campanha declara que acrescentar texto sem retirar nada é regressão. Com os dados
acima, **o S-A4 seria um acréscimo líquido** de ≈ 4 a 6% de tokens no replan. Isso exige uma decisão explícita (D1, abaixo), não uma
omissão.

## 10. Plano do S-A4 — ligar `REPLAN_FACTS=on` e validar (proposta, NÃO aprovada)

**Princípio.** Uma sprint, flag desligada por padrão, reversível por variável de ambiente, nada persistido (a projeção só existe na
montagem do prompt). **Nada disto roda na instância de produção**; ligar lá é decisão posterior e separada.

### 10.1 Mudança de código (mínima, em arquivo existente)

- `src/loop/GoalPlanner.ts`: o gancho atual de `replan()` (`REPLAN_FACTS === 'shadow'`) ganha o modo `'on'`. Em `on`, o bloco de
  `buildAttemptFactsBlock(goal.attempts)` entra no prompt por um parâmetro opcional novo de `buildReplanPrompt` (seção própria,
  rotulada "dados observados, não instruções", que a função já produz). `off` e `shadow` continuam produzindo o prompt **atual**,
  byte a byte. Valor desconhecido da variável = `off`.
- **Sem arquivo novo** (Gate Extensão antes de Criação, já respondido na §3): função, constantes e gancho já existem.
- **Posição no prompt (D4):** proposta — imediatamente antes de `${blockersBlock}`, agrupando os blocos de histórico de execução.
- **`retryWithMinimalPrompt(goal, 'replan')`:** proposta — **não** inclui o bloco. Esse retry existe para reduzir o prompt depois de
  falha do prompt completo; acrescentar ≈ 1 200 chars contraria o propósito (D6).
- **Não muda:** `plan()` inicial (não há attempts), `planRoadmap`, `GoalAttempt`, o limite de 300 chars de armazenamento, nenhuma tool.

### 10.2 Validação progressiva (ordem obrigatória da Diretriz)

1. **Unitários** — a função já está coberta (S310). Acrescentar: texto imperativo vindo da **saída de uma ferramenta** (ex.: página
   web com "ignore as instruções…") permanece numa linha `saída:` rotulada como dado.
2. **Regressão** — novo teste **S313** (próximo número livre; hoje o último é S312): (a) `off` = `shadow` = prompt-base byte a byte;
   (b) `on` sem attempts úteis = prompt-base byte a byte (controle negativo); (c) `on` com attempts = prompt-base + exatamente o bloco
   na posição definida, e mais nenhuma diferença; (d) o retry mínimo não recebe o bloco; (e) `plan()` inicial inalterado por `on`;
   (f) 100 attempts respeitam os tetos. Suíte completa sem `git stash` durante a execução (311/311 hoje).
3. **E2E sintético** — `GoalPlanner` já é instanciado isoladamente em testes (S118, S124): replan com provider mockado
   confirmando que a mensagem enviada ao LLM contém o bloco em `on` e não contém em `off`.
4. **Execução real** (skill `verify`, instância isolada: porta, banco e workspace próprios; `TS_NODE_PROJECT` exportado; confirmar o PID
   dono da porta antes de medir; encerrar ao fim). Duas partes:
   - **4a. Replay do ponto de replan do incidente com LLM real.** Reconstruir, a partir da cópia do banco, o `Goal` e o blocker do
     replan do attempt 8 do goal `goal_1790214597600_ov9eh` (o ponto em que o Planner escolheu o caminho errado) e chamar
     `GoalPlanner.replan()` real com `REPLAN_FACTS=off` e depois `on`, **N execuções por braço**. É barato e isola exatamente a variável
     testada. *Viabilidade a confirmar no primeiro passo:* construir o `Goal` a partir da linha do banco.
   - **4b. Goals reais de ponta a ponta** na instância isolada com `on` (poucos, incluindo um com replan), para confirmar que o fluxo
     completo não regride (conclusão, entrega, tempo).

### 10.3 Critérios de aceitação (numéricos propostos — D3 pede sua ratificação)

| # | Critério | Medida |
|---|---|---|
| C1 | **Efeito:** o plano do replay cita/usa `tmp/extracao_aulas.txt` | N = 10 por braço. Registrar primeiro a linha de base `off`. **`on` ≥ 7/10 e estritamente maior que `off`.** Se `off` já ≥ 7/10, o benefício **não está demonstrado** e a recomendação passa a ser não ligar. |
| C2 | **Custo:** acréscimo de tokens no replan | `in_est` `on` − `off` ≤ ≈ 400 tokens (o bloco no teto vale ≈ 343) |
| C3 | **Sem piora de abortos:** fração de `aborted=true` nos `[LLM-CALL]` de `component=GoalPlanner phase=replan` | `on` não pior que `off` **na mesma amostra**. A linha de base de hoje é alta (**4 de 7** replans com `aborted=true`, `reasoning_chars ≈ 32 000`); com N pequeno isto prova só **ausência de piora observável**, não ausência de efeito. |
| C4 | **Controle negativo** | S313(b): prompt idêntico sem attempts úteis |
| C5 | **Regressão completa** | 100% da suíte (311+) |
| C6 | **E2E** | os goals de 4b concluem como antes, sem novo bloqueio |

### 10.4 Reversão

`REPLAN_FACTS` desligada ou removida volta ao prompt atual. Commit isolado, só `GoalPlanner.ts` + o teste S313 (nenhum arquivo novo
de produção). Nenhum dado persistido muda.

### 10.5 Fora de escopo (registrado)

Alterar o limite de 300 chars de armazenamento (§9.3); ajustar tetos/seleção por `agentloop` (§9.1, sem base); retirar texto do prompt
estático (§9.5, não demonstrado); ligar na produção; Campanhas B, C e D.

### 10.6 Decisões que dependem do usuário

- **D1 — Acréscimo líquido.** Aceitar ≈ +4 a 6% de tokens como **exceção declarada, sob flag, para medir**, ou exigir uma compensação
  (por exemplo baixar o teto de 1 200 para ≈ 800 chars e remedir a perda de caminhos). *Recomendação:* aceitar a exceção sob flag; é
  reversível e é a única forma de medir efeito, que é o que a retrospectiva não mede.
- **D2 — Sombra ao vivo em paralelo.** Ligar `REPLAN_FACTS=shadow` na sua instância (exige editar o `.env` e reiniciar) para
  acumular a razão bloco/prompt **real**, já que a amostra de custo hoje é de 7 replans. *Recomendação:* sim, é independente do S-A4.
  Seu `dist` já contém o código.
- **D3 — Critérios C1 a C3.** N = 10, limiar 7/10 e a regra "`off` ≥ 7/10 ⇒ não ligar" são propostas minhas, não derivadas de dado.
- **D4 — Posição do bloco** (antes de `Blockers anteriores`).
- **D5 — Limite de 300 chars:** abrir RFC própria depois (candidato), ou deixar de lado.
- **D6 — Retry mínimo sem o bloco.**

## 11. S-A4 — execução (02/10/2026)

**Decisões recebidas.** **D1 aceita:** o acréscimo líquido de ≈ 4 a 6% de tokens entra como **exceção declarada à regra "acrescentar sem retirar",
sob flag, para medir efeito**. **D2 aceita e aplicada:** `REPLAN_FACTS=shadow` foi ligada na instância de produção (3 linhas ao final do
`.env`, PM2 reiniciado com a instância ociosa — nenhum goal ativo, 0 reinícios anteriores). **D3, D4 e D6 não foram respondidas
explicitamente:** foram aplicadas as recomendações da §10 (limiares C1–C3, bloco antes de "Blockers anteriores", retry mínimo sem o
bloco), que seguem **pendentes de ratificação**. D5 (limite de 300 chars de armazenamento) continua fora da campanha.

**Código (commit `bf72c09`).** `src/loop/GoalPlanner.ts`: `REPLAN_FACTS=on` passa o bloco a `buildReplanPrompt` por um parâmetro opcional novo
(`attemptFacts`, no fim da lista), em seção própria antes de `Blockers anteriores`. `off`, `shadow` e qualquer outro valor produzem o prompt
atual byte a byte; sem attempts úteis o prompt também é idêntico; `retryWithMinimalPrompt` e `plan()` não mudam. **Desligado por padrão.**
Sem arquivo novo de produção. A linha de log passou a incluir `mode=`.

**Testes.** `S313` (38 asserções) dirige `replan()` de verdade com provider falso. **Teste de mutação:** quebrei o código de propósito de duas
formas (o bloco passando a entrar em `shadow`; a posição trocada) e o S313 reprovou ambas. Duas asserções estruturais de testes existentes
foram **atualizadas deliberadamente**, e a regressão completa as encontrou:
- `S310 [7]` fixava "a projeção só é consumida pela sombra"; o modo `on` a torna obsoleta por construção. O comportamento da sombra
  (prompt idêntico) passa a ser verificado em `S313 [1]`.
- `S142` exigia `operationalHint` como **último** argumento de `buildReplanPrompt`; a intenção do teste é a **propagação**, não a posição.
  A primeira regressão completa falhou nesse arquivo (311 OK, 1 FAIL); após o ajuste, **312/312**.

**Replay do incidente com LLM real (etapa 4a).** Goal `goal_1790214597600_ov9eh`, replan após o attempt 8, modelo `glm-5.3:cloud` (o
`PLANNER_MODEL` real), banco **copiado** (somente leitura), N = 10 por braço com a ordem dos braços **alternada a cada rodada**.

| | OFF | ON |
|---|---|---|
| Plano **consome** o artefato existente (critério estrito) | **0/10** | **10/10** |
| Cita o nome (critério fraco) | 0/10 | 10/10 |
| Prompt continha o artefato (guarda de contaminação) | 0/10 | 10/10 |
| Tamanho do prompt | 8 907 chars | 9 982 chars (**+1 075 ≈ 308 tokens**) |
| Chamadas de replan com `aborted=true` | 10/10 | 6/10 |

**Critérios.** **C1 atendido** (`on` 10/10 ≥ 7/10 e estritamente maior que `off`; `off` não está em 7+, logo o benefício está demonstrado *neste
cenário*). **C2 atendido** (+308 tokens, teto ≈ 400). **C3 atendido** (6/10 contra 10/10, mesma amostra). **C4/C5 atendidos** (controle negativo
no S313; regressão 312/312). **C6 (goals reais de ponta a ponta, parte 4b): NÃO executado.**

**Correções de rota registradas (por honestidade metodológica).**
1. **A primeira versão do replay estava contaminada por anacronismo.** O `strategiesTried` e o `current_plan` finais do goal (posteriores ao
   replan reconstruído; a estratégia nº 6 cita o artefato) vazavam para o prompt `off`, e o artefato aparecia nos dois braços. Foi
   corrigido (só as 2 estratégias que existiam naquele momento; `currentPlan` vazio) antes de qualquer medida válida, e a guarda
   `promptHasArtifact` passou a ser registrada em cada execução.
2. **O critério C1 foi apertado depois de ver UMA execução.** A regex fraca (`extracao_aulas` em qualquer passo) casou com um plano `off` que
   propunha reextrair do zero, não usar o arquivo existente. O critério estrito (passo `read` com o caminho, ou `exec_command` que o cita sem
   escrevê-lo) foi definido antes de qualquer resultado agregado, mas **motivado por esse caso**. Os dois critérios foram mantidos e coincidem
   (0/10 e 10/10). A primeira execução (v1) foi descartada.
3. **Auditoria da heurística:** nos 10 planos `on`, o consumo aparece em passo `read` em 9; em 1 é só `exec_command` (classificado como
   não-escrita e **não auditado à mão**). Descontando-o, `on` fica em 9/10. Nenhum passo, em nenhum braço, mencionou **e** escreveu o artefato.

**Limites (o resultado é um limite superior, não uma promessa de produção).**
- **O prompt do replay é mais leve que o de produção** (≈ 8,9 mil contra ≈ 21 mil chars; o banco não guarda memória, contexto de capacidades nem
  reflexão do replan original). Tende a **superestimar** o efeito.
- **Mede a passagem de informação, não o resultado do goal.** O bloco põe o caminho no prompt e o planner o usa — resultado quase esperado.
  **Não prova que o goal conclui melhor de ponta a ponta;** isso é a parte 4b.
- **Um cenário, um modelo, N = 10, um único ponto de replan.**
- **Abortos fora do padrão:** `off` 10/10 no replay contra ≈ 4/7 em produção. Hipótese **não testada**: sem a informação o modelo "raciocina mais" e
  estoura o orçamento de ≈ 32 000 chars. Não é causa comprovada.
- **Tempos confundidos** (p50 `off` ≈ 167 s, `on` ≈ 104 s) pelos abortos/fallback e por uma regressão completa rodando em paralelo durante parte
  da execução. A alternância dos braços reduz o viés, mas não o elimina. **Não usar como evidência de ganho de latência.**

**Estado.** Código em `main` **desligado por padrão**; a produção segue em `shadow`, **sem `on`**. **Falta:** parte 4b (C6); ratificar D3/D4/D6;
decidir se o `on` vai para a produção (decisão posterior e separada, só depois da 4b).

## 12. S-A4 / parte 4b — goals reais de ponta a ponta (02/10/2026) — **C6 NÃO atendido**

**Objetivo.** Responder ao critério C6 da §10.3: com `REPLAN_FACTS=on`, goals reais de ponta a ponta concluem "como antes, sem novo bloqueio"?
A §11 mediu a *passagem de informação* (o plano usa o artefato); a 4b mede o *resultado do goal*.

### 12.1 Protocolo (definido antes da execução, gravado no cabeçalho do script)

- **Dois braços simultâneos**, cada um numa instância isolada (porta, `data/`, `workspace/`, `logs/` e uma **cópia** de `skills/` próprios — a cópia evita
  que o aprendizado de skills escreva no repositório): `off` na porta 3198, `on` (`REPLAN_FACTS=on`) na 3199. LLM real: Ollama local, `glm-5.3:cloud` em
  todas as roles do planner, `developer` mode via API (sem isso `exec_command` trava em aprovação humana). A produção (porta 3090) não foi tocada.
- **Boot verificado:** o orquestrador confere que o PID dono de cada porta é o processo que ele criou (a armadilha da instância órfã, registrada na skill `verify`).
- **3 cenários × 2 repetições por braço = 12 goals**, mesma ordem nos dois braços; o `workspace` é apagado e **re-semeado antes de cada goal**
  (`aulas/aula1..5.txt`, cada uma com um token único `AULA-n-TOKEN` e duas frases de redes, sintéticas):
  - **A (controle):** "Crie o arquivo `notas.txt` no workspace com a palavra teste e me envie." Verificação: `notas.txt` existe e contém "teste".
  - **B (padrão do incidente):** extrair os 5 arquivos de `aulas/` com um script Python para `tmp/extracao_aulas.txt`, executar, ler esse arquivo e enviar um resumo
    de 5 linhas. Verificação: `tmp/extracao_aulas.txt` existe e contém os 5 tokens.
  - **C (handoff de arquivo):** listar `aulas/`, salvar em `tmp/lista.txt` um nome por linha, contar as linhas e informar. Verificação: `tmp/lista.txt` tem exatamente 5 linhas não vazias.
- **Sucesso de um goal** = terminou com `status=completed` dentro de **15 min** **e** a verificação por **arquivo** passou (o status sozinho não basta).
- **Métricas por goal:** status, ciclos, replans, nº de attempts, duração, chamadas de replan do planner e quantas abortadas (`[LLM-CALL] component=GoalPlanner phase=replan`),
  linhas `[REPLAN-FACTS]`.
- **C6 (pré-registrado):** `on` não conclui menos goals que `off` e não gera bloqueio novo. Com 6 goals por braço, a amostra é **exploratória, não estatística**.

### 12.2 Resultados (12/12 goals executados; instâncias encerradas; portas 3198/3199 livres; repositório com 0 alterações)

| Cenário · rep | OFF (resultado, tempo) | ON (resultado, tempo, replans) |
|---|---|---|
| A · 1 | completed, 0,9 min | completed, 3,5 min |
| A · 2 | completed, 4,9 min | completed, 3,6 min |
| B · 1 | **timeout** (15,0 min, `executing`) | **timeout** (15,0 min, `replanning`; 2 chamadas de replan, 2 abortadas) |
| B · 2 | completed, 12,6 min | **timeout** (15,1 min, `replanning`; 1 chamada de replan, abortada) |
| C · 1 | completed, 7,2 min | completed, 5,8 min |
| C · 2 | completed, 3,8 min | completed, 3,1 min — **1 replan com o bloco, sem aborto** |
| **Placar (critério pré-registrado)** | **5/6** | **4/6** |

- **Verificação por arquivo: 12/12 passaram em ambos os braços**, inclusive nos três goals que estouraram o tempo — o produto final existia; o que faltou foi o goal chegar a um estado terminal.
- **Linhas `[REPLAN-FACTS]` no braço `on`: 4** (uma por chamada de replan, nos goals B1, B2 e C2); **0** no `off`, como esperado. **Nenhum goal ficou `blocked`/`needs_auth`.**
- **Replans:** o braço `off` teve **0 chamadas de replan** nos 6 goals; o braço `on` teve **4**, em 3 goals (3 abortadas, `aborted=true`).
- **Estado final no banco** (lido depois que o orquestrador encerrou as instâncias): `B·1` terminou `abandoned` nos dois braços (31,5 min em `off`, 38,3 min em `on`), com blockers
  `goal_incomplete`/`semantic_mismatch`; `B·2` em `off` terminou `completed` (12,5 min); `B·2` em `on` ficou `replanning`, **sem atualização depois dos 15,6 min** (indeterminado: a instância foi
  encerrada com uma chamada de replan possivelmente ainda em andamento; uma chamada abortada com fallback leva ≈ 4 min).

### 12.3 Veredito

**C6 não foi atendido como pré-registrado:** `on` concluiu 4/6 contra 5/6 de `off`. **Não redefino o critério depois de ver o resultado.** A leitura honesta é:

1. **A diferença é de um goal** (`B·2`) e a amostra é de 6 por braço; não há como separar o efeito da flag da variância (teste exato de Fisher sobre 4/6 × 5/6: p = 1,0).
2. **A comparação não é pareada pelo evento que a flag altera.** O `on` só muda o prompt **do replan**. No braço `off` **nenhum goal chegou a replanejar**, então ele nunca exercitou o código em questão; no `on`, três goals replanejaram. Quem replaneja paga o custo de uma chamada lenta
   (abortada + fallback ≈ 4 min), independentemente da flag — o replay da §11 mostrou `aborted=true` em 10/10 chamadas do `off` e 6/10 do `on`.
3. **Sinal positivo no único caso comparável:** `C·2` (`on`) fez um replan com o bloco, **sem aborto**, e concluiu em 3,1 min.
4. **O que a 4b NÃO mostra:** nenhuma melhora de conclusão ponta a ponta. O ganho de §11 (informação no prompt) **não se traduziu em evidência de resultado melhor**; também não há evidência de dano além do custo do replan.

**Recomendação:** **não ligar `on` na produção com base nesta evidência.** O código segue desligado por padrão e a produção segue em `shadow`.

### 12.4 Defeitos do método (registrados; não invalidam o resultado, mas limitam a leitura)

- **Timeout de 15 min curto demais para o cenário B:** mesmo o único B concluído em `off` levou 12,6 min; os demais ficaram censurados (observações cortadas pelo limite, não falhas comprovadas).
- **Interferência entre goals:** um goal que estoura o tempo **continua executando** na mesma instância e no mesmo workspace enquanto o orquestrador passa ao cenário seguinte (`B·1` rodou
  até 31,5/38,3 min, sobreposto a `C·1`; e o workspace é re-semeado com `rm -rf` antes de cada goal). O efeito é simétrico entre os braços (o `B·1` estourou nos dois), mas **não é controlado**.
- **`abandoned` sem causa verificada:** não investiguei o que marcou `B·1` como `abandoned` (os blockers sugerem validação de conclusão, mas não está provado).
- **Cenários A e C quase não provocam replans** (1 em 8 goals); só o B os provoca, e é justamente o que sofre com o timeout.
- **Hipótese não testada** (herdada da §11): sem a informação do artefato o modelo "raciocina mais" e estoura o orçamento de ≈ 32 000 chars de raciocínio.
- **Mesma cota de modelo compartilhada** pelos dois braços e pela produção (Ollama local), o que pode ter distorcido tempos.

### 12.5 Como reexecutar, e o que falta para uma resposta decisiva

- **Artefatos:** os dois instrumentos — o replay (`replay.ts`, §11) e o orquestrador da 4b (`run4b.cjs`, com o protocolo acima no cabeçalho) — estão no **scratchpad da sessão, fora do repositório**,
  portanto **não reproduzíveis a partir da `main`** enquanto não forem preservados (decisão pendente: onde guardá-los). O resultado bruto desta execução (`results.json`, `progress.log`) também está só lá.
- **Procedimento:** copiar o banco de produção para fora da árvore (replay) ou semear o workspace (4b); subir cada instância com `TS_NODE_PROJECT` e `TS_NODE_TRANSPILE_ONLY`, confirmar o PID dono da porta, ligar `developer` mode, rodar, encerrar.
- **Desenho para uma resposta decisiva (não executado):** (a) **forçar o replan** (falha injetada no mesmo ponto nos dois braços) para comparar o que a flag realmente altera; (b) **um goal por vez e encerrar goals pendentes entre as rodadas**
  (ou um workspace por goal); (c) timeout de 30 a 40 min no cenário B e tratar os cortes como censura; (d) N maior que 2 por célula.

### 12.6 Estado

Código `on` em `main` (commit `bf72c09`), **desligado por padrão**; produção em `shadow`. **C6 não atendido; parte 4b executada com limites; ligar `on` em produção: não recomendado agora.**
Pendentes: ratificar D3/D4/D6; decidir onde preservar os instrumentos; decidir se vale o desenho da §12.5 para uma resposta decisiva.
