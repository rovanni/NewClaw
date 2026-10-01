# RFC-008 — Contexto de Aplicativo Hospedeiro (o Planner de goals precisa saber onde a conversa acontece)

**Status:** PROPOSTA — documentação apenas. **Nenhuma implementação aprovada.** Nenhum código foi
alterado por esta RFC.

**Autor:** Revisão assistida (Claude Code), 01/10/2026, a partir da investigação de 14/07/2026.

**Tipo:** Arquitetura

**Categoria:** Contexto de canal / Planner

**Origem:** `docs/analises-arquiteturais/INVESTIGACAO_POWERPOINT_ADDIN_2026-07-14.md` — investigação forense feita na
branch `fix/powerpoint-addin-goal-context` (commit `b27f2d2`), nunca publicada na `main`. Esta RFC
a reavalia contra a arquitetura **atual** da `main` (384 commits à frente do ponto de partida da
branch) e delimita o que ainda vale.

---

# Resumo

Quando uma conversa acontece **dentro** de outro aplicativo (hoje: o suplemento do PowerPoint),
o canal registra esse fato em `NormalizedMessage.metadata.hostApp` (+ `slideContext`). O caminho
`AgentLoop` o consome (`SessionContext.buildLLMMessages`). O caminho de **goal**
(`GoalOrchestrator → GoalExecutionLoop → GoalPlanner`) não o consome em lugar nenhum. Resultado
observado em produção: toda tarefa real vinda do suplemento, por ser classificada como goal,
é planejada às cegas.

Esta RFC propõe apenas levar **fatos observáveis** do host até o Planner, por uma fonte única,
reimplementada sobre a `main` atual. Não propõe cherry-pick nem merge da branch antiga.

---

# Estado de cada causa raiz da investigação, hoje

| Causa raiz (investigação 14/07) | Estado na `main` (01/10/2026) | Decisão desta RFC |
|---|---|---|
| **RC1** — o contexto do host não chega ao planner de goals | **ABERTO. É o problema principal.** | **Escopo desta RFC.** |
| **RC2** — o planner não conhece o schema de `powerpoint_control` / tools novas | **JÁ RESOLVIDO por outro caminho.** | **Fora de escopo. Não reimplementar.** |
| **RC3** — `.pptx` gerado via Marp não é editável | **Parcial.** | Depende do RC1; sem ação própria. |

## RC1 — aberto (evidência na `main` atual)

- `src/dashboard/routes/chat.ts` (~linha 267) preenche `metadata.hostApp = 'powerpoint'` e
  `metadata.slideContext`. ✔
- `ChannelContext.metadata` (`src/loop/agentLoopTypes.ts:121`) já existe e já chega a
  `GoalExecutionLoop.executeGoal(goal, channelContext, …)` (`GoalExecutionLoop.ts:218-220`). ✔
- `GoalExecutionLoop.ts`, `GoalOrchestrator.ts` e `GoalPlanner.ts`: **nenhuma referência** a
  `metadata`, `hostApp` ou `slideContext` (verificado por `grep`). ✘
- `GoalPlanner.plan(goal, runtimeContext?, capabilityContext?, activeMilestone?)`, `replan(...)` e
  `planRoadmap(...)` não têm parâmetro para contexto de host. ✘
- O bloco de host continua **inline** em `SessionContext.ts:108-140` — só o `AgentLoop` o enxerga.

Consequência (observada em 14/07, 5 goals): o planner "caça" a apresentação aberta como arquivo do
workspace, chega a executar código sobre um `apresentacao.pptx` de 0 bytes, e não considera
`powerpoint_control`.

## RC2 — já resolvido; não reimplementar

A investigação propunha gerar linhas de schema dinamicamente a partir de `tool.parameters` e um
fallback genérico em `detectMissingRequiredArgs()`. A `main` cobriu a mesma classe de bug por dois
caminhos independentes, posteriores:

- `a193852` (22/09/2026, issue 043): `validateToolArgs()` em `ToolRegistry.ts` valida
  `required`/`enum` de `tool.parameters` **antes do despacho**, para `AgentLoop` e
  `GoalExecutionLoop`. O erro `Ação 'undefined' não é suportada` (14/07, 23:08) passa a ser barrado
  com mensagem que lista os valores aceitos.
- ARCH-015 (`docs/refatoracao-arquitetural-2026/RFC_ARCH-015_SchemaGeneratedRequiredArgs.md`):
  `buildRequiredArgsReference()` agrega `requiredArgsHint` das próprias tools. A metade de
  "validação a partir do schema" **foi deliberadamente recusada** naquela RFC e depois entregue,
  com incidente real, pelo `a193852`.

Reimplementar o RC2 duplicaria o `a193852` e reabriria uma decisão já tomada.

## RC3 — parcial

A skill `skills/pptx-generator/SKILL.md` na `main` já contém o aviso "o `.pptx` do Marp CLI NÃO é
editável" e manda usar python-pptx/pptxgenjs quando o pedido exige texto editável. O que **falta**
é o planner saber, de forma determinística, que o destino do `.pptx` é uma apresentação aberta — o
pedido do usuário continuava sendo só "slides". Isso é uma consequência do RC1: com o fato do host
presente, a skill e o planner têm o que ponderar. **Não há ação própria para o RC3.**

## Estado divergente entre a investigação histórica e a `main` atual

A investigação de 14/07 está preservada **verbatim** (cópia byte a byte do original da branch,
verificada com `cmp`) e **não foi alterada**. Ela contém uma afirmação sobre o estado de
`powerpoint_control` que **não corresponde à `main` verificada em 01/10/2026**:

| Fonte | O que diz / o que se verifica |
|---|---|
| Investigação, "Achados laterais" | "`powerpoint_control` cobre apenas `addTextBox/getPresentation/getSlide`", e descreve `getPresentation`/`getSlide` como parte do fluxo viável (ler a estrutura, regenerar um `.pptx` editável, entregar via `send_document`). |
| Merge-base da branch (`3cec0b5`, 13/07) | `enum: ['addTextBox']`. As ações de leitura **não existiam**. |
| Ponta da branch `fix/powerpoint-addin-goal-context` | `enum: ['addTextBox', 'getPresentation', 'getSlide']`; o add-in trata as três ações. |
| `main` (01/10/2026) | `enum: ['addTextBox']`; o add-in trata só `addTextBox`. |

Leitura desta RFC: a investigação descreve o estado do código **da branch de trabalho** em que foi
escrita, não o da `main`. As ações `getPresentation`/`getSlide` nunca chegaram à `main`. Esta é uma
divergência de **estado**, não um erro de evidência — os logs de 14/07 (incluindo o erro
`Ação 'undefined' não é suportada`) continuam válidos como prova do RC1. Mas **qualquer trecho da
investigação que assuma essas ações como existentes não vale para a `main`** e não deve ser lido
como estado atual. Isso reforça a decisão de mantê-las como escopo opcional separado (seção
própria, abaixo) e de **não** tratá-las como pré-requisito do RC1.

---

# Princípio de desenho: `hostAppContext` transmite fatos, não estratégia

A branch antiga deixou em `HOST_APP_HINTS` frases como "NUNCA procure a apresentação aberta como
arquivo", "NUNCA gere via Marp" e "PRECISA ser estrutural e editável". São **instruções
estratégicas** em linguagem de regra dura embutidas num componente determinístico. Isso viola o
**Princípio da Preservação do Raciocínio** (`docs/DIRETRIZ_ARQUITETURA_2026-07-13.md`) e repete o
débito já registrado ali para `pipVenvLoopDirective`/`execCommandBanDirective`. Não há aqui
justificativa de segurança, integridade ou conformidade que dê ao componente o direito de decidir.

Regra desta RFC — o bloco deve conter **apenas** o que é observável e verdadeiro:

| Pode entrar (fato observável) | Não pode entrar (estratégia) |
|---|---|
| A conversa vem do suplemento Microsoft PowerPoint (`metadata.hostApp`). | "NUNCA procure a apresentação como arquivo." |
| A apresentação aberta existe no PowerPoint do usuário, **não é um arquivo do workspace**. | "NUNCA gere via Marp." / "use python-pptx." |
| Dados do `slideContext` recebido: título, slide ativo, total, textos do slide ativo. | "Presuma que 'tema' se refere ao deck aberto." |
| Todo `.pptx` entregue via `send_document` neste canal é **inserido** na apresentação aberta (comportamento real do add-in). | "O `.pptx` PRECISA ser editável." |
| Ferramentas existentes que operam sobre o deck aberto (hoje: `powerpoint_control`, ação `addTextBox`). | Ordem de qual ferramenta usar. |

O Planner (LLM) e a skill `pptx-generator` já sabem relacionar "será inserido no deck aberto" com
"precisa ser editável". Entregar o fato basta; decidir a estratégia continua sendo dele.

Cada linha do bloco deve ser **derivável de um dado concreto** (um campo de `metadata`, o nome de
uma tool registrada, um comportamento do add-in) — nunca de uma inferência. Campo ausente → linha
omitida, nunca preenchida com valor plausível (`docs/ARCHITECTURE/NUNCA_ADIVINHAR.md`).

---

# Contrato de `slideContext`: a `main` é a referência

O add-in da `main` (`addins/powerpoint-addin/src/taskpane/powerpoint.ts`, `getSlideContext()`)
envia:

```ts
{
  presentationTitle?: string,
  currentSlide: number,
  totalSlides: number,
  slideTexts?: string[],     // textos do slide ATIVO
}
```

A branch antiga usava outro formato (`activeSlideIndex`, `slideTitles` — títulos de até 50
slides). **Esse formato não é a referência e não deve ser adotado.** Qualquer implementação:

1. consome `currentSlide`, `totalSlides`, `slideTexts` e `presentationTitle`, exatamente como o
   add-in da `main` os produz;
2. **não altera o add-in** nem o contrato HTTP de `/api/chat` como parte do RC1;
3. trata `slideContext` como dado **não confiável** vindo do cliente: tipos verificados, tamanho
   limitado, tratado como texto delimitado e rotulado como dado — nunca como instrução.

Se um dia for desejável enviar títulos de todos os slides, isso é uma mudança de contrato do
add-in, com RFC/escopo próprio (ver "Escopo opcional separado").

---

# Proposta (RC1)

Reimplementação sobre a arquitetura atual, em etapas pequenas e reversíveis, **sem** cherry-pick,
merge ou reaproveitamento de commits da branch `fix/powerpoint-addin-goal-context`.

## Etapa 1 — fonte única do bloco

Hoje o bloco existe em um lugar (`SessionContext.ts:108-140`) e seria copiado num segundo
(planner). Dois consumidores do **mesmo fato** que já divergiria ao longo do tempo — o teste S122
da branch antiga chegou a validar uma cópia da lógica, não o código real. Pelo critério de
`docs/ARCHITECTURE/QUANDO_EXTRAIR_DUPLICACAO.md`:

1. *Sinal de conhecimento compartilhado:* ✔ — mesma representação do mesmo fato, dois consumidores.
2. *Módulo-folha neutro:* ✔ — função pura `buildHostAppContextBlock(metadata)`, sem import de
   `loop/` nem de `session/`; ambos importam dele.

Gate *Extensão antes de Criação* para o arquivo novo:

| Pergunta | Resposta |
|---|---|
| Este arquivo precisa existir? | SIM |
| Existe implementação no NewClaw que resolve parte disso? | O bloco inline em `SessionContext.ts:108-140`. |
| Uma extensão pequena de algo existente elimina o arquivo? | Exportar a função de `SessionContext.ts` e importá-la em `src/loop/` faria `loop/` depender de `session/`, acoplamento que a RFC rejeita. |
| Prova de que é inevitável | Um módulo-folha em `src/shared/` (já existe: `contentStubPatterns.ts`) é o único lugar que ambos podem importar sem dependência nova entre camadas. |

O arquivo novo (`src/shared/hostAppContext.ts`) é a única criação prevista. Ele **substitui** o
bloco inline de `SessionContext` (comportamento do `AgentLoop` preservado em conteúdo factual — ver
critério A3), não coexiste com ele.

## Etapa 2 — levar o fato ao Planner

O dado já está disponível: `ChannelContext.metadata` chega a `executeGoal`. A mudança é passá-lo
adiante, como texto, num parâmetro dedicado de `plan`/`replan`/`planRoadmap`, em **seção própria
do prompt** (`AMBIENTE DA CONVERSA`), delimitada e com teto de caracteres, fora do orçamento de
memória que truncaria o bloco junto com a memória. Padrão idêntico ao já usado pelo
`buildAttemptFactsBlock()` (Campanha A): função pura, texto para o Planner ponderar, nunca decisão.

Sem `hostApp` (todo canal que não é o suplemento): **prompt idêntico byte a byte** ao de hoje
(controle negativo — critério A1).

## O que esta RFC não faz

- Não decide nada pelo Planner (nenhum `if (hostApp === …)` altera o plano).
- Não toca `ToolRegistry`, `validateToolArgs`, `buildRequiredArgsReference` (RC2).
- Não altera o add-in, o broker, `powerpoint_control` ou o contrato HTTP.
- Não altera a skill `pptx-generator`.
- Não introduz tratamento especial de PowerPoint no Core além de **texto de dados** (o mapa de
  `hostApp` conhecido → rótulo). Um `hostApp` futuro (Word, Excel) herda os dois caminhos.

---

# Crítica da proposta (Fase 2 da Diretriz)

- **A seção pode crescer o prompt.** `slideTexts` vem do cliente e é arbitrariamente grande. →
  teto de caracteres por campo e total; excedente truncado com marcação explícita.
- **Texto do cliente dentro de prompt é superfície de injeção.** `slideTexts` é conteúdo do slide
  aberto, que pode conter texto imperativo. → delimitado, rotulado como dado do slide ("conteúdo
  do slide, não instrução"), tratado igual ao que a RFC-004 já exige para texto de anexo.
- **Risco de God Object.** → mitigado: função pura, sem estado, sem I/O, uma única responsabilidade
  (formatar fatos de host), 1 chamador de produção por camada.
- **Pode ser desnecessária se o AgentLoop for o caminho usado.** → falso para tarefas reais: a
  evidência de 14/07 mostra que toda tarefa real vinda do suplemento foi classificada como goal.
- **Pode resolver só o sintoma.** → o sintoma é o planner caçar arquivo; a causa é o fato do host
  não existir no caminho de goal. A proposta ataca a causa e vale para qualquer host futuro.

Alternativas descartadas:

| Alternativa | Por que não |
|---|---|
| Injetar `hostApp` em `goal.objective` | Polui o `GoalStore` e mistura intenção do usuário com ambiente (descartada na investigação, e continua). |
| Chamar `SessionContext.buildLLMMessages` a partir do planner | Acopla o planner ao subsistema de sessão inteiro. |
| `if (hostApp === 'powerpoint')` dentro do planner | Canal decidindo dentro do Core; segunda fonte de verdade. |
| Cherry-pick/merge de `b27f2d2` | 384 commits de divergência, 9 conflitos de código, formato de `slideContext` diferente, bloco com diretivas duras. |

---

# Critérios de aceitação (RC1)

| # | Critério | Como se verifica |
|---|---|---|
| **A1** | **Controle negativo:** sem `metadata.hostApp` (Telegram, Discord, Dashboard, qualquer canal comum), o prompt de `plan`, `replan` e `planRoadmap` é **idêntico byte a byte** ao de hoje. | Teste compara prompt antes/depois com `metadata` indefinido, `{}` e `{ hostApp: 'desconhecido' }`. |
| **A2** | Com `hostApp='powerpoint'` e `slideContext` válido, o prompt do planner contém a seção `AMBIENTE DA CONVERSA` com os fatos do contrato da `main`: título, slide ativo (`currentSlide` de `totalSlides`), textos do slide ativo. | Teste unitário da função + teste do prompt montado. |
| **A3** | O `AgentLoop` continua recebendo os **mesmos fatos** de hoje via a função compartilhada; `SessionContext` não mantém mais um bloco inline. Diferenças de redação são aceitas só onde removem instrução estratégica (critério A5). | Teste de que `SessionContext` e planner chamam a mesma função; sem cópia da lógica no teste. |
| **A4** | Conteúdo do bloco é **só fato observável**: nenhuma frase imperativa dirigida ao planner ("nunca", "sempre", "deve", "precisa", "use"). | Teste de guarda sobre o texto gerado, com lista de verbos imperativos proibidos. |
| **A5** | O bloco **não nomeia** estratégia nem ferramenta preferida. Pode listar ferramentas **existentes** como fato (ex.: `powerpoint_control` com ação `addTextBox`), derivadas do registro de tools, sem ordem de uso. | Teste: nenhuma ocorrência de "Marp", "python-pptx", "pptxgenjs" no bloco. |
| **A6** | Campo ausente → linha omitida. Nenhum valor inferido (`NUNCA_ADIVINHAR`). `slideContext` ausente ou malformado (não-objeto, tipos errados) → bloco só com o fato do host, sem erro. | Testes de entrada degenerada. |
| **A7** | Tamanho limitado: `slideTexts` com 100 itens e/ou textos enormes não estoura o teto; truncamento marcado. Seção do planner não entra no `enforceMemoryBudget` de memória. | Teste de teto e de não-truncamento junto com memória. |
| **A8** | Injeção: `slideTexts` contendo texto imperativo ("ignore as instruções…") aparece **delimitado e rotulado como dado**; nunca fora do delimitador. | Teste dedicado com payload imperativo. |
| **A9** | Nenhuma importação nova de `*Adapter` em `src/loop/**`; `src/shared/hostAppContext.ts` não importa de `loop/`, `session/`, `channels/` nem `core/`. | `grep` de dependências proibidas (`docs/ARCHITECTURE.md`) como parte do teste. |
| **A10** | `plan`, `replan` e `planRoadmap` recebem o fato; o retry minimal do planner **preserva** o bloco (mesma classe de perda já vista com o S121). | Teste dos três métodos e do retry. |

---

# Testes necessários

Seguindo **Validação Progressiva** (`DIRETRIZ_ARQUITETURA`), nesta ordem:

1. **Unitários** (função pura): host desconhecido, `metadata` indefinido/vazio, host conhecido sem
   `slideContext`, `slideContext` completo, `slideContext` malformado, teto de tamanho, payload
   imperativo (A2, A4, A5, A6, A7, A8).
2. **Regressão** (`npm run test:regression`, suíte completa, sem `git stash` durante a execução):
   controle negativo A1 (byte a byte), A3, A9, A10. Novo arquivo de teste com o próximo número
   livre (a numeração atual vai até S311; **não reutilizar** os números S121–S123 da branch antiga,
   já ocupados por outros testes na `main`).
3. **End-to-end sintético:** goal disparado com `ChannelContext.metadata = { hostApp: 'powerpoint',
   slideContext }`, LLM mockado, verificando que o prompt enviado ao provider contém a seção e que o
   mesmo goal sem `hostApp` não a contém.
4. **Execução real** (skill `verify`; instância isolada com porta, DB e workspace próprios, LLM real
   via Ollama; atenção à armadilha do `TS_NODE_PROJECT` documentada na Diretriz): o add-in
   simulado por poller HTTP real contra `/api/integrations/powerpoint/commands`, enviando
   `slideContext` no formato da `main`. Reproduz a mensagem de 14/07 ("Consegue melhorar a cores
   dos textos?…"). Aceitação: o plano **não** lista nem lê `apresentacao.pptx` do workspace como se
   fosse a apresentação aberta, **ou**, se o fizer, o log `[PLAN-TRACE]` mostra que o bloco de host
   estava no prompt (a decisão continua sendo do planner; o objetivo é eliminar a **cegueira**, não
   impor um plano). Mock e código compartilham o mesmo ponto cego — por isso a etapa 4 não é
   opcional.

Primeira sprint recomendada: **sombra**, no mesmo padrão da Campanha A — função pura + log que
registra o bloco que seria injetado, sem alterar o prompt; só depois de evidência real, ligar.

---

# Escopo opcional separado — `getPresentation` / `getSlide`

**Não faz parte do RC1 e não deve ser misturado com ele.** Na `main`, `powerpoint_control` aceita
só `addTextBox` (`enum: ['addTextBox']`) e o add-in só trata `addTextBox`. A branch antiga adicionou
as ações de leitura `getPresentation` (lista slides com IDs e títulos) e `getSlide` (shapes, textos
e tabelas de um slide), com round-trip pelo broker.

Fica como **proposta separada, a decidir depois do RC1**, porque:

- é **capacidade nova**, não correção de cegueira: muda o add-in (Office.js), o broker e a tool;
- tem superfície própria de segurança (conteúdo do deck do usuário entrando no contexto do LLM);
- o RC1 já entrega valor sem ela (o planner passa a saber o que está aberto); a leitura estrutural
  completa só melhora a qualidade das respostas.

Se aprovada, exige RFC/escopo próprio, com teste do broker (`scripts/testes/test_powerpoint_broker.ts`
já existe como base), e gate *Extensão antes de Criação* aplicado às ações novas. O contrato de
`slideContext` não muda por causa dela.

---

# Riscos remanescentes e hipóteses não comprovadas

- **Hipótese não comprovada:** que o bloco factual (sem as diretivas duras) é suficiente para o
  planner deixar de caçar o deck como arquivo. A branch antiga validou o bloco **com** as
  diretivas ("NUNCA procure…"). Remover as diretivas pode reduzir a eficácia. É exatamente o que a
  sombra e a etapa 4 de validação devem medir antes de ligar — e, se insuficiente, o caminho não é
  voltar à diretiva dura, e sim melhorar o fato apresentado.
- **Modelos mais fracos** (a validação de julho já registrou que o planner da instância isolada era
  mais fraco que o de produção) podem ignorar o bloco. A RFC não promete plano correto, só
  planejamento **informado**.
- **O 0 bytes `apresentacao.pptx`** é lixo de runtime (02/07), não de código; fora de escopo.

# Fora de escopo (registrado para não ficar implícito)

RC2 (resolvido); mudanças no add-in; novas ações de `powerpoint_control`; alteração da skill
`pptx-generator`; tradução do bloco (o Core ainda não tem sistema de tradução — ver
`docs/ARCHITECTURE.md`, "Gaps conhecidos"; o bloco segue em português como o restante do prompt do
planner); limpeza de branches (decisão separada, posterior à decisão sobre esta RFC).

# Relação com outras decisões

- `docs/DIRETRIZ_ARQUITETURA_2026-07-13.md` — Princípio da Preservação do Raciocínio; Gate
  Extensão antes de Criação; Validação Progressiva.
- `docs/ARCHITECTURE/EVIDENCE_PROVIDER_PATTERN.md` — o bloco é um *evidence provider*.
- `docs/ARCHITECTURE/NUNCA_ADIVINHAR.md` — campo ausente = linha omitida.
- `docs/ARCHITECTURE/QUANDO_EXTRAIR_DUPLICACAO.md` — justificativa do módulo-folha.
- `docs/decisoes/RFC-004_INGESTAO_DE_MIDIA_MULTIPLA.md` — texto vindo do cliente é dado, não
  instrução.
- `docs/refatoracao-arquitetural-2026/RFC_ARCH-015_SchemaGeneratedRequiredArgs.md` e o commit
  `a193852` — por que o RC2 não é reaberto.
- `docs/auditoria-simplificacao-cognitiva-2026-09-24/PREPARACAO_CAMPANHA_A_2026-09-29.md` — padrão
  de sombra e de bloco factual para o Planner (`buildAttemptFactsBlock`).

# Decisões que dependem do usuário

1. Aprovar (ou não) a implementação do RC1 nesta forma, **em modo sombra primeiro**.
2. Confirmar que o contrato `slideContext` da `main` é a referência (esta RFC assume que sim).
3. Decidir se `getPresentation`/`getSlide` viram proposta própria agora ou ficam arquivadas.
