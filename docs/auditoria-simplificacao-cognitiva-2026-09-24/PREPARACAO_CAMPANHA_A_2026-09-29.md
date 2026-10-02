# Preparação da Campanha A — o histórico factual chega ao replan

Data: 2026-09-29 · Atualizado: 2026-10-01 · Status: **S-A0 a S-A2 implementados em sombra** (commit `03cfc7c`, teste S310:
`REPLAN_FACTS=shadow` só loga, o prompt não muda) · **S-A3 retrospectivo feito (§9)** · **S-A4 (`REPLAN_FACTS=on`) é proposta,
NÃO aprovada (§10)**; decisões D1 a D6 pendentes. *(O status original, de 29/09, dizia "nenhum código alterado; implementação
NÃO aprovada" — era verdadeiro na preparação e ficou superado pelas §8 a §10.)* ·
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
