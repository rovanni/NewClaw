# RFC-008 — Contexto de Aplicativo Hospedeiro (o Planner de goals precisa saber onde a conversa acontece)

**Status:** APROVADA (01/10/2026); **RC1 em implementação, modo sombra** — commit `77a533b`, teste
S312. `HOST_CONTEXT=shadow` apenas loga `[HOST-CONTEXT]`; o prompt do Planner **não** muda. O modo
`on` **não está aprovado**: depende da etapa S-B3 (logs reais acumulados; **em coleta passiva desde 02/10/2026**,
ver "Registro de execução — S-B3" no fim) e de decisão do usuário.
Critérios A3 e A10 só valem quando o modo `on` existir. Validação até aqui: S312 71/71, regressão
completa 311/311, execução real em instância isolada com LLM real. Esta RFC não cobre RC2 nem
`getPresentation`/`getSlide` (ver seções próprias).

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
observado em produção (4 goals em 14/07): toda mensagem do suplemento que é classificada como goal é
planejada às cegas. **Nem toda mensagem do suplemento vira goal** — a classificação depende do
pedido (ver, em "Crítica da proposta", o item "Pode ser desnecessária se o AgentLoop for o caminho usado"); o problema é real para as que viram.

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

Consequência (observada em 14/07, 4 goals): o planner "caça" a apresentação aberta como arquivo do
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
- **Pode ser desnecessária se o AgentLoop for o caminho usado.** → só em parte. Em 14/07, 4 goals
  vindos do suplemento (incluindo "melhorar as cores dos textos") foram planejados às cegas. Mas na
  validação real de 01/10 o mesmo tipo de pedido ("melhorar a cor dos textos dos slides") foi roteado
  para o `agentloop` (`route=agentloop`), que já enxerga o host, e só o pedido de criação ("crie uma
  aula… gere o .pptx") virou goal (`route=goal`). A rota varia com o pedido, com o classificador e com
  o modelo; **não há garantia de que toda tarefa real do suplemento vire goal**. O RC1 só afeta as que
  viram — por isso o problema é real, mas de alcance menor que o descrito na primeira versão desta RFC.
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

**Referência histórica (única cópia): `origin/fix/powerpoint-addin-goal-context`, tip `b27f2d2`.** A
branch local foi removida em 01/10/2026 (idêntica ao `origin`, nada se perdeu); **o remoto é hoje o
único lugar onde esse código existe** e **não deve ser apagado** enquanto esta RFC o referenciar. As
ações `getPresentation`/`getSlide` estão em `8913b9d` (`src/tools/powerpoint_control.ts` e
`addins/powerpoint-addin/src/taskpane/powerpoint.ts`; ausentes no commit anterior `9dc0ea4`). O mesmo
branch guarda, de forma independente desta RFC, a suíte `S114_TransportIntegrity` e 8 fixtures
`src/__tests__/fixtures/golden/*.json` (commit `118db00`), sem equivalente na `main` e ainda não
avaliados — assunto separado, fora do escopo desta RFC. Se o remoto for removido, a referência acima
quebra.

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

# Registro de execução — S-B3 (02/10/2026)

**Ação aplicada na produção.** `HOST_CONTEXT=shadow` foi ligada no `.env` da instância de produção (3 linhas ao final; arquivo só com LF) e a instância foi
reiniciada com **0 goals ativos**. O boot foi confirmado pelo horário da linha `Dashboard rodando` no log (02:33) e pelo PID dono da porta — *não* apenas por uma linha
qualquer do log: uma primeira verificação mostrou, por engano, a linha do reinício anterior (00:05), e foi corrigida. A instância roda um `dist` compilado em 01/10
que **contém** os dois ganchos de sombra (`REPLAN_FACTS` e `HOST_CONTEXT`; confirmado por busca no código compilado). Os dois só **logam**; o prompt do Planner não muda.

**Retrospectiva sobre a base existente** (cópia do banco de produção, somente leitura; só agregados):

| Medida | Resultado |
|---|---|
| Goals de sessões do suplemento PowerPoint | **9** (de 352 no banco), todos entre 07/07 e 14/07/2026, de **uma única sessão** |
| Status final | 4 `completed`, 5 `failed` |
| Usaram `powerpoint_control` | **1/9** |
| Usaram `exec_command` | 7/9 |
| Usaram `list_workspace` | 3/9 |
| Usaram python-pptx / `Presentation()` | 5/9 |
| Mencionam o arquivo `apresentacao.pptx` do workspace | 1/9 |
| Mais de um blocker | 4/9 (15 `tool_error` no total) |

**O que isto é e o que não é.**
- É **compatível** com o problema do RC1: o Planner raramente escolhe a ferramenta do PowerPoint e trabalha por arquivo e script.
- **Não é evidência independente.** O período (07 a 14/07) é o mesmo dos testes que originaram a investigação; os goals de 14/07 analisados lá estão incluídos aqui.
- **Não prova** que o contexto de host mudaria o plano: a sombra não altera o prompt, então só mostra o que o Planner fez **sem** o bloco.
- A contagem é por busca textual nos attempts, cujas saídas são guardadas com 300 chars (ver `PREPARACAO_CAMPANHA_A_2026-09-29.md`, §9.3), então tende a **subcontar**.
- "Mencionam `.pptx`" (9/9) é trivial — todas são tarefas de apresentação — e **não** foi usado como evidência.

**Lacuna de dados.** **Não há nenhum goal do suplemento desde 14/07** (≈ 11 semanas). A sombra só gera dado quando o suplemento for usado; até este registro, **0** linhas `[HOST-CONTEXT]`
(a instância acabou de ser reiniciada) e **0** `[REPLAN-FACTS]` (a instância não recebeu nenhum goal desde o reinício de 00:05). A S-B3 **não avança sozinha**.

**Critério proposto, ainda NÃO ratificado.** Decidir sobre o modo `on` apenas com **pelo menos 10 goals reais do suplemento com `[HOST-CONTEXT]` registrado**, analisando nesses goals se o Planner chamou
`powerpoint_control` ou caçou o deck como arquivo (`list_workspace`/`read`/`exec_command` sobre `.pptx`), comparado com a linha de base acima. Como a sombra não muda o plano, ela mede a **frequência e a forma
do problema**, não o efeito do bloco; o efeito só se mede com o modo `on` (que ainda não existe — critérios A3 e A10) ou com um replay com LLM real, como o da Campanha A (§11 do documento citado), com os mesmos limites daquele replay.

**Estado.** S-B3 em **coleta passiva**. O modo `on` do RC1 não existe e **nenhuma ação sobre ele deve ser tomada sem dados**. Pendente de decisão do usuário: ratificar o critério (≥ 10 goals) e/ou preparar o replay com LLM real.

# Plano do replay com LLM real — RC1 (PRÉ-REGISTRADO em 02/10/2026, **antes** de qualquer execução)

**Pergunta.** A informação que o bloco de host entrega ("a conversa acontece dentro do PowerPoint; a apresentação aberta existe no PowerPoint do usuário, não é um arquivo do workspace; todo `.pptx`
entregue é inserido nela") reduz, no **plano inicial**, o comportamento observado em 14/07 — o Planner **caçar o deck como arquivo**?

**Cenário.** O pedido canônico de 14/07, presente em dois goals da base com **texto idêntico** (verificado por comparação direta): `nxx12` e `1q551`. Em produção, **os dois** planos usaram
`list_workspace` e `exec_command` (conjuntos de ferramentas lidos do banco), e nenhum usou `powerpoint_control`. O texto do pedido não é reproduzido aqui nem em nenhum log do replay.

**Instrumento.** `instrumentos/replay_rc1.ts` (modos `--dry` e `--real`). **O modo `on` do RC1 não existe no código**; o braço `host` é simulado: o bloco é gerado pela função **real**
`buildHostAppContextBlock` e inserido no prompt por um wrapper de `chatWithFallback`, **imediatamente depois da linha `OBJETIVO GLOBAL`** (posição pré-fixada). Isto testa o efeito da **informação**,
não a integração (critérios A3/A10 desta RFC).

**Desenho.** N = **10 por braço** (`off` e `host`), ordem dos braços **alternada a cada rodada**; modelo do planner = `PLANNER_MODEL` atual da produção (`glm-5.3:cloud`); **as 22 ferramentas de produção**
registradas (verificado em `--dry`: 22/22); estado do goal **vazio** (só `objective`/`userIntent`; sem attempts, blockers, estratégias nem plano atual — nada posterior ao momento do plano); `slideContext`
**sintético** (o real de 14/07 não foi guardado). Em `--dry`: prompt `off` ≈ 13 206 chars, `host` ≈ 13 729 (+523 chars ≈ 150 tokens); o bloco não está no `off` e o prompt `off` não cita `apresentacao.pptx`.

**Métricas.** *Primária:* **`hunt_strict`** — o plano contém um passo que **abre/lê um `.pptx` existente** (`read` de `*.pptx`; `Presentation('x.pptx')` com argumento; `cat`/`type`/`unzip` de `*.pptx`) **ou** que
**descobre o workspace** (`list_workspace`/`refresh_workspace`) com descrição/args citando apresentação, slides ou `.pptx`. *Secundárias:* descobre o workspace (qualquer), usa `powerpoint_control`, gera `.pptx`
novo, envia documento, planos vazios, tamanho do prompt, tempo e chamadas abortadas. **Cada passo é logado e classificado** (`STEP ...`) para auditoria manual — a classificação é heurística.

**Critérios (propostos por mim, a ratificar; os limiares não derivam de dado).**

| # | Critério | Medida |
|---|---|---|
| R1 | **O replay discrimina:** o braço `off` reproduz o problema | `hunt_strict(off)` **≥ 5/10**. Se for menor, o replay **não reproduz** o comportamento neste cenário reconstruído, **nenhum efeito do bloco pode ser inferido** e o RC1 não ganha suporte por este caminho. |
| R2 | **Efeito:** o bloco reduz a caça | `hunt_strict(host)` ≤ `hunt_strict(off)` − 4 |
| R3 | **Sem dano:** | planos vazios do `host` ≤ os do `off`; abortos do planner (`[LLM-CALL] aborted=true`) do `host` não maiores que os do `off` |
| R4 | **Guardas:** | `promptHasHostBlock` verdadeiro em 10/10 `host` e falso em 10/10 `off`; 22/22 ferramentas |

**Como ler o resultado (pré-declarado).** Atender R1 a R4 mostra que a **informação** muda o plano **neste cenário**, com um modelo e prompt mais leve que o de produção — **não** que o RC1 resolve o problema em
produção. Uma redução de `hunt_strict` **não** é por si só um plano melhor (o `host` pode gerar um `.pptx` novo e enviá-lo, caminho legítimo que o bloco descreve); por isso `generates`/`send` são reportados e os
passos são auditados. R1 não atendido é um resultado **tão válido quanto** os demais e deve ser registrado como tal.

**Limites pré-declarados.** (1) Prompt mais leve que o de produção: faltam memória, `CapabilityRegistry` e reflexão (o replay inclui, ao contrário do da Campanha A, o conjunto completo de 22 ferramentas).
(2) Modelo atual do planner, possivelmente diferente do de 14/07. (3) `slideContext` sintético. (4) Uma única mensagem. (5) Na `main`, `powerpoint_control` só tem a ação `addTextBox`; `getPresentation`/`getSlide`
existem só no remoto (ver "Escopo opcional separado"), então o Planner de hoje **não pode** ler o deck por essa ferramenta — um plano que a use faz menos do que o de 14/07 fez na branch. (6) N = 10 por braço e
heurística de classificação. (7) Mede o **plano inicial**, não o resultado do goal.

**Procedimento.** Copiar o banco de produção (com `-wal`/`-shm`) para fora da árvore; rodar `--dry`; rodar `--real` com `OLLAMA_URL`, `OLLAMA_MODEL`, `PLANNER_MODEL` e `DEFAULT_PROVIDER` no ambiente, a partir da raiz do
repositório; não tocar na produção. Estimativa: 20 chamadas de `plan()`, **40 a 90 min** (cada chamada com raciocínio pode passar de 4 min, como no replay da Campanha A).

**Estado.** Instrumento pronto e verificado em `--dry`. **Ainda não executado.**

# Resultado do replay com LLM real — RC1 (02/10/2026): **R1 e R2 NÃO atendidos; achado sobre `powerpoint_control`**

Executado conforme o protocolo pré-registrado acima (commit `16df09f`, antes da execução): plano inicial do pedido de 14/07, N = 10 por braço com ordem alternada, `glm-5.3:cloud`, 22 ferramentas
de produção, estado do goal vazio, bloco gerado pela função real e inserido depois de `OBJETIVO GLOBAL`. **Os limiares R1/R2 eram propostas minhas e não foram ratificados**; foram aplicados como propostos.

### Execução 1 — N = 10 por braço (protocolo)

| | OFF | HOST |
|---|---|---|
| **Caça o deck como arquivo (`hunt_strict`, métrica primária)** | **4/10** | **1/10** |
| Descobre o workspace (qualquer) | 5/10 | 1/10 |
| Usa `powerpoint_control` | 2/10 | **7/10** |
| Gera `.pptx` novo / envia documento | 0/10 / 0/10 | 0/10 / 0/10 |
| Planos vazios | 0/10 | 0/10 |
| Chamadas de plano com `aborted=true` | 5/10 | 4/10 |
| Bloco no prompt (guarda) | 0/10 | 10/10 |
| Prompt | 13 206 chars | 13 729 chars (+523 ≈ 150 tokens) |

**Veredito pelos critérios pré-registrados:** **R1 NÃO atendido** (`hunt_strict(off)` = 4/10 < 5/10: o replay **não reproduz o problema o bastante**, e pelo protocolo **nenhum efeito do bloco pode ser inferido**);
**R2 NÃO atendido** (redução de 3, pedia ≥ 4); R3 atendido (0 planos vazios; abortos 4 ≤ 5); R4 atendido (guardas íntegras, 22/22 ferramentas). R1 falhou por **um plano**, e o limiar não é ajustado depois de ver o resultado.

### Auditoria complementar — N = 5 por braço (**posterior** ao resultado, exploratória)

Motivo: 7 dos 10 planos `host` usavam `powerpoint_control`, em geral em 4 passos seguidos, e na `main` essa ferramenta só aceita `addTextBox`. O harness passou a gravar **apenas o valor de `action`** (nunca o conteúdo
dos argumentos). Resultado: `hunt_strict` **4/5** em `off` e **0/5** em `host`; `powerpoint_control` em 1/5 e **5/5**; **`action` AUSENTE em todos os 22 passos de `powerpoint_control`** (4 em `off`, 18 em `host`).
Descritivamente, somando os dois lotes: `hunt_strict` 8/15 em `off` contra 1/15 em `host`; `powerpoint_control` 3/15 contra 12/15. **Esta soma NÃO é usada para dar o R1 por atendido** — seria parada opcional (estender a amostra depois de ver o resultado) —;
é só descrição. Os resumos de ambos os lotes estão em `instrumentos/resultados/rc1-exec1-resumo.txt` e `rc1-auditoria-resumo.txt`.

### O que os dados mostram (com a distinção entre medido e interpretado)

1. **Direção consistente, mas sem inferência permitida.** O bloco acompanha uma queda forte de `hunt_strict` nos dois lotes. Pelo protocolo, porém, o replay não discrimina (R1), e isto é registrado como resultado, não como detalhe.
2. **O bloco redireciona o Planner para `powerpoint_control`** (12/15 contra 3/15). *Medido.*
3. **Esses passos não são executáveis como escritos.** *Medido:* nenhum dos 22 passos traz `action`. *Verificado no código/prompt:* o prompt de plano só diz o **nome** da ferramenta e uma linha de descrição ("Executa comandos interativos na apresentação ativa
   do PowerPoint"); **não** diz que `action` é obrigatório nem que o único valor aceito é `addTextBox` (a ferramenta não declara `requiredArgsHint`, e o contrato fixo do prompt não a lista). Além disso, **`addTextBox` só insere uma caixa de texto** — não altera cores de um deck.
   *Inferido, não executado:* o replay mede o **plano**, não a execução; pela validação já existente (`validateToolArgs`, commit `a193852`) o passo seria barrado antes do despacho com a lista de valores aceitos, e o goal replanejaria — o mesmo padrão do erro `Ação 'undefined' não é suportada` de 14/07.
4. **Consequência para esta RFC.** Entregar **apenas** o fato do host pode empurrar o Planner para uma ferramenta que, hoje, **não consegue fazer o trabalho** — possivelmente **pior** do que o comportamento atual, não melhor. Isto é uma hipótese forte, **não comprovada**: falta executar esses planos.
5. **Correção ao que a RFC disse sobre o RC2.** A RFC afirma que o RC2 "já foi resolvido por outro caminho". Isso vale para a **validação** (`a193852`), mas esta evidência mostra que a **visibilidade do schema no prompt** continua aberta **para esta ferramenta**: o mecanismo `requiredArgsHint` (ARCH-015) cobre 7 tools e `powerpoint_control` não está entre elas.
   A extensão mínima, dentro de mecanismo existente, seria declarar `requiredArgsHint` no próprio arquivo da tool. **Não foi feita** e é decisão separada.

### Recomendação

**Não implementar o modo `on` do RC1 como está desenhado.** Antes, decidir (em ordem de menor para maior escopo, todas fora do que foi implementado):
(a) a tool declarar `requiredArgsHint` (RC2, visibilidade); (b) o bloco de host listar, **como fato derivado do schema da tool**, as ações que `powerpoint_control` suporta (hoje só `addTextBox`) — coerente com a nota opcional A5 desta RFC e com a regra de fatos, não instruções;
(c) decidir o escopo opcional `getPresentation`/`getSlide`, sem o qual o Planner não consegue ler o deck. Depois, **repetir o replay** (o mesmo instrumento) e **executar** os planos gerados. A sombra em produção (`HOST_CONTEXT=shadow`) **continua** e não tem risco: só loga.

### Limites

Os pré-declarados no protocolo, mais: **a auditoria foi posterior ao resultado e com amostra menor (N = 5)**; a classificação de `hunt_strict` é heurística e **não foi auditada passo a passo à mão** (os `STEP` estão nos resumos para quem quiser);
o replay mede o **plano inicial, não a execução nem o resultado do goal**; `slideContext` sintético; um modelo, um pedido; o prompt é mais leve que o de produção. Um achado sobre o **meu** processo: na primeira execução o harness não gravava os argumentos dos passos, e só por isso o problema de `action` ficou invisível até a auditoria.

### Estado

Replay com LLM real **executado**; **R1/R2 não atendidos**; achado sobre `powerpoint_control` **registrado, sem correção aplicada**. Modo `on` do RC1 **não implementado e não recomendado agora**. Pendente de decisão do usuário: (a), (b) e (c) acima, e se vale repetir o replay depois.
