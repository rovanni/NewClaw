# ADR-013 — Responsabilidades de verificação da resposta (uma pergunta, um responsável)

> **Status:** **em investigação.** Implementado só o passo de observabilidade (D0, gravador de voo dos
> avaliadores). D1 (checklist) foi **testado e não confirmado** (§5); D2 e D3 aguardam dados do gravador.
> **Data:** 07/10/2026
> **Origem:** goal real de 07/10/2026 (`goal_1791409897176_dcpr2`, banco de questões ENADE) que
> produziu o arquivo pedido e foi abandonado porque o juiz de grounding não deu veredito em 240 s;
> pergunta do operador: *"para que serve o juiz? qual é o caminho de ponta a ponta?"* e proposta do
> operador: *"o juiz deveria ter um checklist — as IAs trabalham muito bem com checklist"*.
> **Relacionadas:** `ADR-010` (validação semântica de afirmações contra evidência — cria o juiz),
> `ADR-012` (contrato de modalidade de entrega), `RESPONSABILIDADE_ANTES_DO_MECANISMO.md`
> (questionário obrigatório; "não criar avaliadores para compensar avaliadores"; regra de custo),
> `NUNCA_ADIVINHAR.md`, `EVIDENCE_PROVIDER_PATTERN.md`.
> **Não revoga a ADR-010.** O objetivo dela — nunca entregar dado de ferramenta diferente do que a
> ferramenta devolveu — permanece; esta ADR muda **como** e **sobre o quê** o juiz decide.

---

## 1. Contexto — o caminho de uma resposta

Do pedido do usuário até a resposta, um goal passa por (medido no goal de 07/10, log de auditoria):

```
① canal → MessageBus (fila por conversa)
② UnifiedIntentRouter + DomainRegistry (LLM) — conversa ou objetivo?
③ GoalStore cria o goal (TTL 30 min — GOAL_LIMITS.MAX_GOAL_TTL_MS)
④ GoalPlanner (LLM) — plano
⑤ RiskAnalyzer (LLM) — revisão de risco do plano
⑥ execução por passo (ferramenta direta ou AgentLoop), com até QUATRO avaliações:
   A1  ObserverValidator.validate            "a resposta atende o pedido?"        LLM, só aconselha
   A2  ObserverValidator.validateResponseCommit "a ferramenta citada foi executada?" quase sempre determinístico
   A3  ObserverValidator.validateGrounding   "os dados batem com a evidência?"     LLM, FAIL-CLOSED (bloqueia)
   A4  StepSemanticValidator                 "o resultado serve ao passo?"        termos-chave + LLM, rebaixa a parcial
⑦ validateGoalCompletion — critérios de sucesso (determinístico)
⑧ entrega — envios adiados (send_document) liberados → canal
✗ bloqueio → replan (volta a ④); TTL estourado → abandona com mensagem de falha
```

Em outubro, por chamadas de LLM no log: `AgentLoop` 145, `UnifiedIntentRouter` 57, **juiz de
grounding 56**, `StepSemanticValidator` 39, `DomainRegistry` 35, `RiskAnalyzer` 30, `GoalPlanner` 38,
`contentStubClassifier` 11, **validador de qualidade 11**.

### 1.1 O que aconteceu em 07/10

| Hora | Evento |
|---|---|
| 18:51–18:53 | roteamento, plano, revisão de risco |
| 18:54–19:01 | primeira geração: 420 s só de raciocínio (111 mil caracteres, zero de resposta) — cortada pelo prazo |
| 19:01–19:24 | segunda tentativa: arquivo escrito (23 questões, até S18) |
| 19:24–19:28 | **A3 em 240 s sem veredito → UNVALIDATED → entrega bloqueada → replan** |
| 19:28 | replan correto ("ler o arquivo e enviar"), mas o TTL já estava estourado → **abandonado** |

O texto bloqueado tinha de fato um erro ("24 questões… S12–S19"; o arquivo tem 23, até S18) — o
bloqueio do **texto** estava certo. Mas o **arquivo**, correto, também não chegou ao usuário.

## 2. Base factual — o que o juiz recebeu e decidiu

Fonte: todos os registros `[GROUNDING-TRACE]` do log de auditoria de produção (desde 30/09, quando o
registro foi criado) e `[GROUNDING]` (bloqueios, desde agosto). Instrumento:
`docs/analises-arquiteturais/instrumentos-2026-10-07/`.

### 2.1 Tempo e desfecho (29 julgamentos iniciais, 30/09–07/10, juiz `glm-5.3:cloud`)

- tempo típico **75–317 s** (máximo 764 s), mesmo com prompt de 3 mil caracteres;
- **9 de 29 (31%) sem veredito** (`UNVALIDATED`) — cada um bloqueou uma entrega;
- 4 a 23 afirmações por resposta, sem teto; 534 afirmações no total;
- o tamanho não explica sozinho: o caso de 07/10 19:28 tinha evidências de ~2 mil caracteres cada.

Contraste: nos 19 casos sintéticos curtos da issue 065, o **mesmo** modelo com o **mesmo** prompt
levou mediana de 4,7 s. O custo está na tarefa aberta, não no modelo.

### 2.2 Sobre o que o juiz decide (534 afirmações, classificação aproximada)

| Tipo | Exemplo real | Qtde | Não aprovadas |
|---|---|---|---|
| A. conteúdo de arquivo gerado | "o banco contempla Máquina de Turing", "os gabaritos estão no final" | 193 (36%) | 26 |
| B. ação do próprio sistema | "o arquivo foi enviado", "os comandos retornaram sucesso" | 91 (17%) | 22 |
| C. dado externo de ferramenta | chance de chuva, preço, temperatura | 73 (14%) | 3 |
| D. outros | explicação, diagnóstico, conhecimento geral | 177 (33%) | 31 |

O juiz nasceu (ADR-010, incidentes River e Clima) para o **tipo C** — 14% do que ele julga hoje.

### 2.3 Erros reais que o juiz pegou

Todos do tipo A, conferidos contra os arquivos do workspace: "gabaritos reunidos no final" (vêm após
cada questão); "questão de turnaround médio" e "formação geral" (ausentes); "24 questões, S12–S19"
(23, até S18). Um caso ambíguo: "contempla Máquina de Turing" (o arquivo trata de Turing; a
evidência que o juiz recebeu era um resumo).

### 2.4 O modelo leve não substitui o desenho

O modo sombra (`gemma4`, 1–4 s) aprovou 6 respostas que o `glm-5.3` reprovou — entre elas a dos
gabaritos. Trocar o modelo do juiz, sozinho, deixaria passar erros reais. (Isto corrige a
recomendação anterior, baseada só nos 19 casos sintéticos, em que os dois concordavam.)

### 2.5 A análise de risco tem o mesmo defeito, em dose maior

Levantamento de todas as chamadas de LLM de outubro por componente (`[LLM-CALL]`): a `RiskAnalyzer`
falhou em **22 de 30 (73%)**, mediana 70 s — quando falha, o plano segue sem revisão (custo sem efeito).
O prompt dela mistura duas tarefas: **revisar** (4 perguntas: falta passo? dependência não capturada? ordem?
vai ser entregue?) e **reescrever o plano inteiro** em JSON com schemas de ferramenta, até 5 passos. Quando
termina, reescreve o plano em 8 de 19 casos — um segundo planejador sobre o primeiro, o que a regra "não criar
avaliadores para compensar avaliadores" proíbe. A pergunta 4 já é verificada deterministicamente desde a issue
059 (`rejectPlanWithoutAnswerStep`). O teto de 5 passos conflita com planos maiores.

Os demais avaliadores estão saudáveis em tempo (roteador, domínio, validador do passo, validador de conclusão,
classificador de conteúdo-esqueleto: 2–8 s) — o validador de qualidade (18 s) tem tarefa aberta, mas só aconselha.

Proposta para a análise de risco (**PENDENTE**, depende dos dados do gravador): revisar sem reescrever — os
riscos voltam ao planejador como fato, e ele decide; a pergunta da entrega sai dela. Não implementar antes de
saber, pelo gravador, onde ela gasta os 60 s.

## 3. Questionário (RESPONSABILIDADE_ANTES_DO_MECANISMO)

Três perguntas diferentes hoje se misturam nos avaliadores A1–A4. Cada uma:

**P1 — "A ação que a resposta relata aconteceu?"** (enviado, salvo, comando executado)
- RESPONSÁVEL: o registro de execução do próprio sistema (attempts, `DELIVERY-REGISTRY`, status das ferramentas).
- EVIDÊNCIA: status estruturado de cada ferramenta — o sistema já o tem; o juiz recebe só texto.
- AUTORIDADE: o sistema é a fonte primária do que ele mesmo fez; um LLM lendo texto é fonte secundária.
- ESTADO: fato (`executado | falhou | adiado | não registrado`).
- CONSUMIDOR: A2 (`validateResponseCommit`) já faz essa pergunta.
- MECANISMO: determinístico. Não é pergunta semântica.

**P2 — "Os dados que a resposta atribui a ferramentas/arquivos batem com a evidência?"**
- RESPONSÁVEL: juiz de grounding (A3).
- EVIDÊNCIA: saídas de ferramenta e conteúdo de arquivo gerado — já recebe.
- AUTORIDADE: sim — é a razão de existir da ADR-010; continua FAIL-CLOSED para o texto.
- ESTADO: `VALIDATED | REJECTED | NOT_EVALUABLE | UNVALIDATED` (sem mudança).
- CONSUMIDOR: AgentLoop/GoalExecutionLoop (bloqueio, replan, mensagem ao usuário).
- MECANISMO: composição — **LLM interpreta** (quais dados, qual trecho os decide), **determinismo
  valida** (o trecho citado existe literalmente na evidência).

**P3 — "O resultado atende o pedido/o passo?"**
- RESPONSÁVEL: hoje dois — A1 (qualidade, só aconselha, grava ReflectionMemory) e A4 (relevância do
  passo, rebaixa a parcial, com pré-filtro por contagem de termos-chave).
- Problema: duas autoridades para a mesma pergunta, uma delas com heurística (`N/M termos-chave`)
  decidindo ponto semântico — contraria a regra de custo e a proibição de regex como interpretador.
- Fora do escopo de implementação desta ADR (ver §6) — registrado para não ficar implícito.

## 4. Decisões

### D0 — Gravador de voo dos avaliadores (implementado, 07/10/2026)

O experimento da §5 mostrou que sem registro completo não dá para responder por que o juiz demora: o log
cortava a evidência em 2000 caracteres, não ligava a chamada ao julgamento e **descartava o raciocínio** de
uma geração abortada. Decisão do operador: *"melhorar os logs para entender cada detalhe — antes, durante e
depois"*. Implementado em `src/shared/evaluatorFlightRecorder.ts` (cobertura `S352`):

- **antes** — avaliador, modelo, versão do prompt (hash do modelo de prompt), orçamento, fatos da entrada;
  com `TRACE_CONTENT=true`, o prompt exato e a evidência **inteira**;
- **durante** — por tentativa (`CallTelemetry`, preenchida pelo `ProviderFactory`/`OllamaProvider`): tempo
  até o primeiro trecho e até o primeiro conteúdo, raciocínio e conteúdo acumulados a cada 15 s, motivo do
  fim, tokens; com `TRACE_CONTENT=true`, o **texto do raciocínio, inclusive de geração abortada**;
- **depois** — desfecho, estado, duração; com `TRACE_CONTENT=true`, saída bruta e itens julgados; e o
  **efeito**: resposta liberada/bloqueada/parcial (AgentLoop), step repetido ou goal replanejando (GoalExecutionLoop).

Um JSONL por avaliador e dia em `<pasta do LOG_FILE>/avaliadores/`; só grava com `LOG_FILE` definido;
retenção `EVALUATOR_LOG_RETENTION_DAYS` (padrão 14). O `[GROUNDING-TRACE]` do log de auditoria continua
sendo o resumo — este é o detalhe. Cobre juiz de grounding, validador de qualidade e análise de risco.

### D1 — O juiz de grounding trabalha com checklist e citação literal (**testado, não confirmado**)

Substituir a tarefa aberta ("ache todas as afirmações, classifique em três vereditos") por:

1. listar **no máximo 8** itens que sejam dado obtido de ferramenta ou conteúdo de arquivo, com
   prioridade para números, nomes e conteúdo de arquivo;
2. para cada item, **copiar o trecho literal** da evidência que o decide e marcar `sim | nao | sem_evidencia`;
3. lista explícita do que **não** checar (explicação, conhecimento geral, pedido do usuário, o mero
   fato de ter feito/salvo/enviado — mas números e nomes dentro dessas frases são dados).

O **código** confere se cada trecho citado existe na evidência; citação que não existe vira
`sem_evidencia` (não decide nada). Agregação igual à atual: algum `nao` → REJECTED; algum
`sem_evidencia` → NOT_EVALUABLE; todos `sim` → VALIDATED; nenhum item → NOT_APPLICABLE.

### D2 — Ações do sistema saem do juiz

"Enviado", "salvo", "comando executado" (tipo B, 17% das afirmações, 22 reprovações) passam a ser
respondidas pelo registro de execução (P1), não pelo LLM. O prompt do checklist já as exclui; a
conferência determinística delas é um passo separado, sobre a mesma fonte que A2 já usa.

### D3 — (decisão do operador) bloqueio do texto não precisa bloquear o arquivo

Em 07/10 o texto estava errado e o arquivo estava certo; os dois ficaram retidos. Opção a decidir:
quando A3 bloqueia o **texto**, liberar o envio adiado do **arquivo** já produzido e validado pelos
critérios de ⑦, com uma mensagem neutra no lugar do texto bloqueado. **PENDENTE** — muda o contrato
da ADR-010 §(entrega) e da ADR-012; não implementar sem aprovação explícita.

## 5. Experimento (07/10/2026)

Instrumento: `docs/analises-arquiteturais/instrumentos-2026-10-07/juiz_checklist.ts`. Mesmo modelo
(`glm-5.3:cloud`), mesmo orçamento (240 s), 19 casos sintéticos da issue 065 + 9 casos reais de produção
com evidência reconstruída do workspace (8 rotulados à mão contra os arquivos, 1 ambíguo). Os casos reais
contêm dado do usuário e não estão no repositório.

| | Juiz atual | Checklist (D1) |
|---|---|---|
| sintéticos (19) — corretos | **18** | 17 (2 respostas certas bloqueadas: listou conteúdo didático como dado) |
| sintéticos — mediana | **3 s** | 7 s |
| reais (8 rotulados) — corretos | **4** | 3 |
| reais — sem veredito em 240 s | 3 | 4 |
| reais — mediana | 207 s | 231 s |

Erros reais: "gabaritos no final" — o atual pegou (102 s), o checklist bloqueou por outro motivo;
"24 questões / S12–S19" — o checklist pegou (183 s), o atual não terminou; "turnaround / formação geral"
— nenhum terminou.

**Conclusão:** o formato do pedido não é a causa da lentidão. O mesmo modelo responde em segundos nos casos
curtos e em 2–4 min nos reais, para os dois prompts; o que muda é o tamanho da evidência (20–37 mil
caracteres). Hipótese principal, **não comprovada**: o raciocínio do modelo cresce com o material — numa
sondagem pequena, o mesmo pedido levou 12,7 s com raciocínio e 1,7 s com `think: false`, com resposta
correta nos dois. D1 não é adotada. Próximo passo: medir com o gravador (D0) e testar o raciocínio desligado
nos mesmos 28 casos.

## 6. Fora do escopo (registrado)

- **P3 com dois responsáveis** (A1 e A4) e pré-filtro por termos-chave em A4 — candidato a ADR própria.
- **TTL de 30 min** abandonando o goal um segundo depois de um replan correto e barato.
- **Mensagem de falha** que incluiu memória sem relação com o pedido ("slides de aula").
- **Primeira geração de 420 s só de raciocínio** — o corte pelo prazo agiu certo; o custo foi do modelo.

## 7. Riscos e hipóteses não comprovadas

- Teto de 8 itens: uma resposta com mais de 8 dados terá parte não verificada. Mitigação: prioridade
  explícita para números e conteúdo de arquivo; medir quantos itens os casos reais produzem.
- Citação literal falha com reformatação legítima (tabela → frase, unidade convertida). A conferência
  normaliza espaços, ênfase markdown e aspas; o `sim` com conversão continua sendo julgamento do LLM
  sobre um trecho que existe.
- Amostra pequena de casos reais com conteúdo completo (9, desde 06/10, quando `TRACE_CONTENT` foi
  ligado). Os 19 sintéticos cobrem as armadilhas River/Clima.
