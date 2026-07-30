# RFC-003 — Como um Agente Adquire Conhecimento Operacional

**Status:** Aprovada (2026-07-27) — decisão arquitetural consolidada. Alinhamento da documentação
derivada (`EVIDENCE_PROVIDER_PATTERN.md`, `PIPELINE_CURADORIA_DEPENDENCIAS.md`, `ADR-001`,
`RFC-001`) e implementação ficam para etapas seguintes, deliberadamente separadas desta — ver
"Impacto na Documentação Existente" e "Próximos Passos" ao final.

**Autor:** Luciano Rovanni do Nascimento

**Tipo:** Arquitetura

**Categoria:** Arquitetura Cognitiva

---

# Resumo

Esta RFC define os princípios arquiteturais que regem como um agente autônomo adquire novo conhecimento operacional.

Em vez de depender exclusivamente de conhecimento previamente codificado ou de catálogos mantidos manualmente, o agente deve ser capaz de descobrir, validar, aprender e reutilizar conhecimento operacional de forma autônoma, preservando segurança, reprodutibilidade e integridade arquitetural.

O objetivo desta RFC não é substituir o conhecimento curado, mas definir um ciclo seguro de aquisição de conhecimento que permita ao sistema evoluir continuamente sem comprometer o comportamento determinístico.

---

# Motivação

Ao longo de múltiplas gerações do projeto, um mesmo padrão arquitetural tem se repetido.

Sempre que o agente encontra um problema operacional desconhecido — como uma dependência ausente, um executável inexistente, um novo gerenciador de pacotes ou uma configuração específica de ambiente — a solução normalmente exige intervenção manual.

Os sintomas mais frequentes são:

* expansão contínua de catálogos estáticos;
* criação de novos casos especiais;
* inclusão de comandos específicos por plataforma;
* ajustes em heurísticas e expressões regulares;
* necessidade constante de codificar conhecimento operacional previamente inexistente.

Cada correção individual resolve o problema imediato.

Entretanto, a causa permanece inalterada:

> **o conhecimento operacional continua sendo inserido manualmente por desenvolvedores, em vez de ser adquirido pelo próprio agente.**

Esta RFC propõe transformar essa limitação em uma capacidade arquitetural explícita.

**Evidência de segunda instância**: este padrão foi observado de forma independente em uso real do
OpenClaw (projeto irmão já referenciado como precedente em `src/tools/exec_command.ts` e
`src/tools/send_audio.ts`), operado diariamente pelo autor desta RFC. O comportamento relatado —
"não tenho uma lista mágica, é pesquisa + teste" — segue essencialmente o mesmo ciclo proposto
aqui, o que eleva esta proposta de hipótese isolada a padrão com precedente validado em produção,
fora do NewClaw.

---

# Definição do Problema

O conhecimento atualmente disponível é extremamente eficiente para resolver problemas que já são conhecidos.

Entretanto, ele possui pouca capacidade de lidar com situações realmente novas.

Hoje o modelo pode ser resumido como:

```text
Conhecimento conhecido
        │
        ▼
Executar
```

O modelo proposto passa a ser:

```text
Problema desconhecido
        │
        ▼
Descobrir
        │
        ▼
Validar
        │
        ▼
Aprender
        │
        ▼
Reutilizar
```

A diferença é conceitual.

O agente deixa de depender exclusivamente de conhecimento previamente codificado e passa a ser capaz de adquirir novo conhecimento operacional.

---

# Princípio Fundamental

> **Conhecimento operacional não nasce da memorização.**

Ele é adquirido por meio de experiência validada.

A memorização representa apenas a etapa final do processo de aprendizagem.

---

# Princípio da Descoberta Antes da Codificação

O objetivo desta RFC é reduzir a dependência de conhecimento operacional codificado manualmente.

Portanto, mecanismos determinísticos como:

* expressões regulares;
* listas de exceções;
* tabelas de mapeamento;
* comandos codificados por plataforma;
* regras específicas para casos individuais;
* heurísticas baseadas em padrões conhecidos;

**não constituem o mecanismo primário de aquisição de conhecimento operacional** — no domínio
coberto por esta RFC (resolução de dependências e do ambiente de execução).

Esses mecanismos possuem papel exclusivamente complementar nesse domínio. Eles somente podem ser
utilizados quando:

1. já existe conhecimento previamente validado (Conhecimento Distribuído ou Conhecimento
   Aprendido); ou
2. a aquisição de conhecimento operacional não é possível ou foi explicitamente esgotada.

Em particular:

* nunca se deve adicionar uma nova expressão regular apenas para evitar o ciclo de descoberta;
* nunca se deve criar uma nova exceção arquitetural quando o problema puder ser resolvido pelo
  processo de aquisição definido nesta RFC;
* a ausência de conhecimento não justifica ampliar continuamente regras determinísticas.

**Escopo explícito desta priorização — não se aplica a determinismo de segurança/correção.** Esta
regra rege apenas mecanismos que hoje codificam manualmente *conhecimento sobre como resolver uma
dependência ou característica de ambiente ausente* (o problema que esta RFC define). Ela não se
aplica, e não deveria ser lida como se se aplicasse, a determinismo cuja função é
segurança/correção estrutural, nunca descoberta de conhecimento — por exemplo:

* `isDestructive()`/bloqueio absoluto de padrões destrutivos (`EVIDENCE_PROVIDER_PATTERN.md` §7
  item 1) — é uma exceção de segurança nomeada à parte, nunca substituível por um ciclo de
  descoberta;
* traduções estruturais de comando (ex.: `wrapForWindowsPowerShell` e as tabelas de
  `exec_command.ts` que traduzem idioma POSIX para PowerShell) — resolvem uma diferença de
  sintaxe de shell já conhecida e estável, não uma lacuna de conhecimento operacional;
* as checagens estruturais de `sanitizePlanSteps.ts` (`TOOL_DEPENDENCY_ARG` e afins) — validam
  dependência *entre steps de um plano*, não conhecimento sobre o ambiente externo.

Sem esta ressalva, a regra normativa abaixo poderia ser lida como proibindo indevidamente
mecanismos de segurança/correção que nunca foram, e não deveriam se tornar, um caso de "aquisição
de conhecimento operacional".

## Justificativa Arquitetural

A expansão contínua de lógica determinística foi uma das principais causas de degradação
arquitetural em gerações anteriores do projeto.

Cada nova exceção resolve um caso específico, porém aumenta o acoplamento do sistema ao
conhecimento previamente codificado, reduzindo sua capacidade de adaptação a ambientes
desconhecidos.

A aquisição de conhecimento operacional existe precisamente para interromper esse ciclo.

Regex, tabelas estáticas e heurísticas permanecem válidas apenas como otimizações para
conhecimento já consolidado, nunca como substitutos do processo de descoberta — sempre dentro do
domínio desta RFC, conforme o escopo explicitado acima.

## Regra Normativa

Sempre que houver conflito, **dentro do domínio de resolução de dependências/ambiente**, entre:

* ampliar lógica determinística; ou
* permitir que o agente descubra, valide e aprenda uma nova estratégia,

a segunda alternativa deve ser priorizada.

A introdução de nova lógica determinística nesse domínio deverá ser considerada uma exceção
arquitetural e deverá ser justificada por evidências de que o ciclo de aquisição não pode resolver
o problema de forma segura ou determinística.

---

# Ciclo de Aquisição de Conhecimento Operacional

Sempre que o agente encontrar um problema operacional desconhecido, deverá seguir o mesmo ciclo de aquisição.

```text
Problema desconhecido
        │
        ▼
Identificar
        │
        ▼
Descobrir
        │
        ▼
Pesquisar
        │
        ▼
Formular hipótese
        │
        ▼
Executar
        │
        ▼
Validar objetivamente
        │
        ▼
Aprender
        │
        ▼
Reutilizar
```

O aprendizado sem validação objetiva é proibido.

---

# Identificação

O agente deve primeiro identificar exatamente qual é o problema.

Exemplos:

* executável ausente;
* biblioteca inexistente;
* ferramenta não instalada;
* serviço indisponível;
* comando desconhecido.

Um problema mal identificado produz hipóteses incorretas.

---

# Descoberta

A descoberta transforma um problema operacional desconhecido em uma hipótese concreta de solução.

A descoberta pode envolver:

* inspeção do ambiente de execução;
* identificação do sistema operacional;
* detecção da distribuição Linux;
* identificação do gerenciador de pacotes disponível;
* verificação de permissões;
* análise de ambientes virtuais;
* identificação de containerização;
* consulta a documentação oficial;
* consulta a repositórios oficiais;
* reutilização de conhecimento operacional previamente validado.

Descobrir não significa executar.

Descobrir significa produzir hipóteses fundamentadas.

**Rastreabilidade obrigatória da fonte.** Toda consulta a documentação externa (oficial ou não)
deve registrar de onde a informação veio (URL, changelog, release note, página do gerenciador de
pacotes). Uma hipótese sem fonte identificável não é uma hipótese fraca — é ausência de hipótese,
e deve ser tratada como tal (`docs/ARCHITECTURE/NUNCA_ADIVINHAR.md`): o ciclo segue para
"Formular hipótese" apenas com o que foi de fato encontrado e citável, nunca com uma suposição
plausível preenchendo a lacuna. Este é o mesmo padrão de disciplina já exigido da skill
`dependency-curator` (`skills/dependency-curator/SKILL.md`, Passo 2 e Passo 4) — esta RFC estende
essa disciplina do caminho assíncrono (Skill, revisão humana) para o caminho tático (dentro do
ciclo de execução do goal, gated por modo operacional — ver "Modos Operacionais" abaixo).

---

# Formulação da Hipótese

Com base nas evidências coletadas, o agente propõe uma estratégia operacional.

Exemplos:

* instalar via `apt`;
* instalar via `winget`;
* utilizar `brew`;
* executar instalação manual;
* utilizar ferramenta já existente no ambiente.

Hipóteses não representam conhecimento.

Representam possibilidades que ainda precisam ser verificadas.

Toda hipótese carrega consigo a fonte que a originou (ver "Descoberta"). Uma hipótese sem fonte
rastreável não avança para "Executar".

**Formular hipótese a partir de pesquisa nova é sempre mediado pelo `GoalPlanner`/LLM, nunca
decidido por um componente determinístico sozinho.** Quando a pesquisa produz mais de uma fonte
com comandos conflitantes (ex.: doc oficial recomenda `winget`, um README recomenda instalador
manual), a escolha entre candidatos é julgamento — exatamente o tipo de decisão que
`EVIDENCE_PROVIDER_PATTERN.md` reserva à camada de julgamento, nunca a um Evidence Provider. Um
componente determinístico que escolhesse sozinho entre fontes conflitantes estaria mais próximo de
"inferência livre" do que da exceção nomeada em §7 item 2 (que pressupõe alta confiança já
estabelecida, não uma escolha aberta entre resultados de busca). Ver a seção "Fronteira entre
Julgamento do Planner e Atalho Determinístico", adiante, para a regra completa — inclusive o único
caso em que um atalho determinístico é permitido (reutilização de conhecimento já validado).

---

# Execução

A hipótese é executada somente quando autorizada pelo modo operacional e pelas políticas de segurança vigentes.

A execução não valida a hipótese.

Ela apenas produz evidências.

Os bloqueios de segurança absolutos (`isDestructive()`/`RiskAnalyzer`, `EVIDENCE_PROVIDER_PATTERN.md`
§7 item 1) continuam se aplicando integralmente a esta execução, sem exceção — nenhum atalho
tático ou modo operacional bypassa checagem de segurança, apenas o julgamento estratégico do
Planner é que pode ser bypassado, e só nas condições descritas na próxima seção.

---

# Validação

A validação é a etapa central deste modelo.

Nenhuma hipótese pode ser considerada conhecimento operacional sem validação objetiva.

Exemplos de validação:

* o executável passou a existir;
* `ffmpeg -version` executa com sucesso;
* o serviço responde corretamente;
* o objetivo foi concluído;
* o comportamento esperado foi observado.

Validações heurísticas são insuficientes.

Conhecimento operacional exige evidências verificáveis.

**Nota de implementação (não normativa nesta RFC, registrada para a etapa seguinte):** o mecanismo
de captura hoje existente (`OperationalKnowledge.captureFromGoal()`) credita sucesso a partir do
primeiro `exec_command` bem-sucedido executado *depois* de um blocker `missing_tool` — o próprio
comentário do código já admite que isso "não é prova formal de causalidade". Essa heurística é
mais fraca do que a validação objetiva que esta RFC exige; fechar essa lacuna (um comando de
verificação explícito por dependência, não apenas "algo rodou depois e deu certo") é um requisito
de implementação desta RFC, não uma reabertura do princípio.

## Condição de Parada do Ciclo

O ciclo de aquisição **não introduz orçamento próprio**. Ele consome exatamente o mesmo
`retryBudget`/`replanBudget` que `GoalExecutionLoop` já mantém por goal hoje — mecanismo
existente, não uma adição desta RFC. Cada falha de validação conta como uma tentativa dentro desse
orçamento já existente; voltar de "Validar" para "Descobrir" com uma nova hipótese só é permitido
enquanto houver orçamento restante no goal.

Quando o orçamento se esgota — em qualquer ponto do ciclo: durante a pesquisa, a execução ou a
validação — o ciclo termina e o fluxo cai no caminho manual já existente hoje (perguntar ao
usuário / instrução manual), exatamente como já acontece quando `KNOWN_DEPS` não tem comando
resolvido para o SO detectado. Nenhuma hipótese pode ser tentada fora desse orçamento. Isso
elimina, por construção, a possibilidade de laço infinito: o ciclo está estruturalmente limitado
pelo mesmo mecanismo que já limita qualquer replan de goal — não por um contador novo e paralelo
que precisaria ser mantido em sincronia com o primeiro.

---

# Aprendizagem

Somente estratégias objetivamente validadas tornam-se elegíveis para aprendizagem.

O conhecimento aprendido deve registrar, sempre que possível:

* ferramenta;
* plataforma;
* contexto operacional;
* estratégia utilizada;
* evidência da validação;
* nível de confiança.

Conhecimento aprendido nunca altera automaticamente conhecimento distribuído.

**Definição formal do nível de confiança.** Esta RFC não introduz um modelo de confiança novo —
reutiliza o já definido em `docs/decisoes/RFC-001_APRENDIZADO_OPERACIONAL.md` (pergunta 2, mesmo
padrão de dois níveis já usado por `ReflectionMemory`):

- **Evidência fraca** (1 sucesso validado): vira texto informativo para o `GoalPlanner` ponderar
  (Evidence Provider puro) — nunca decide sozinha, nunca vira atalho automático.
- **Conhecimento elegível a atalho tático** (≥2 sucessos confirmados, sem falha recente registrada
  para a mesma chave `(ferramenta, plataforma)`): mesmo nível de confiança que `KNOWN_DEPS` já tem
  hoje para acionar instalação automática — sujeito às mesmas condições (modo operacional,
  `permissionRegistry.can('install_dependencies')`).

Qualquer implementação desta RFC deve referenciar esse modelo em vez de redefinir "nível de
confiança" localmente — duas RFCs do mesmo projeto não devem divergir no mesmo conceito.

---

# Reutilização

Em execuções futuras, o agente deve priorizar conhecimento previamente validado.

A ordem de utilização deve ser:

1. Conhecimento distribuído (curado).
2. Conhecimento aprendido localmente.
3. Novo ciclo de descoberta — **somente quando o modo operacional permitir** (ver "Modos
   Operacionais"); fora disso, o sistema recorre ao caminho manual já existente (perguntar ao
   usuário / instrução manual), nunca pesquisa por conta própria.

Repetir continuamente o mesmo processo de descoberta caracteriza ineficiência arquitetural.

---

# Fronteira entre Julgamento do Planner e Atalho Determinístico

Esta seção elimina, de forma explícita e exaustiva, a ambiguidade entre as etapas do ciclo e o
Evidence Provider Pattern — para cada etapa, quem decide e por quê:

| Etapa | Quem decide | Por quê |
|---|---|---|
| Identificar | Determinístico (`GoalEvaluator`, classificação de erro) | Fato observável — mesmo papel que já tem hoje, sem mudança |
| Descobrir (ambiente) | Determinístico (`CapabilityRegistry`/`EnvironmentProbe`) | Evidence Provider clássico — só relata fatos, nunca decide |
| Pesquisar | Determinístico só na *coleta* (busca com fonte citada) | Produz candidatos, não escolhe entre eles |
| **Formular hipótese** (a partir de pesquisa nova) | **Sempre o `GoalPlanner`/LLM** | Escolher entre candidatos — especialmente com fontes conflitantes — é julgamento, não fato; decidir isso deterministicamente seria "inferência livre", proibida por `EVIDENCE_PROVIDER_PATTERN.md` §7 |
| Executar (hipótese nova) | Segue a decisão do Planner, como qualquer step de plano | Sem exceção — `RiskAnalyzer`/`sanitizePlanSteps` se aplicam integralmente |
| Validar | Determinístico (comando de verificação objetivo) | Fato observável, sem julgamento |
| Aprender | Determinístico (persistência em `OperationalKnowledge`) | Só grava evidência já validada, sem julgamento |
| **Reutilizar** (conhecimento já validado, confiança suficiente) | **Atalho determinístico permitido** — único ponto de bypass do Planner neste ciclo | Reutilizar um fato já confirmado nesta instância não é inferência, é replay de evidência — mesma exceção nomeada que `KNOWN_DEPS` já usa hoje (`EVIDENCE_PROVIDER_PATTERN.md` §7 item 2) |

**Regra geral, sem exceção:** a primeira vez que uma hipótese é formulada a partir de pesquisa
nova, ela é sempre proposta como evidência ao Planner, que decide se e como executá-la — mesmo
fluxo que qualquer outro Evidence Provider já usa hoje. **Somente a reutilização de uma hipótese
já validada e persistida em `OperationalKnowledge`, com confiança suficiente** (ver "Aprendizagem"
→ "Definição formal do nível de confiança"), **herda o atalho tático** que hoje já existe para
`KNOWN_DEPS` — o Planner é bypassado apenas nesse caso específico, exatamente como já acontece
quando `KNOWN_DEPS` resolve uma dependência conhecida. Bloqueios de segurança absolutos
(`isDestructive()`) nunca são bypassados por nenhum dos dois caminhos.

## Débito conhecido, não corrigido (Sprint F — Integração, 2026-07-29)

A auditoria de integração da Sprint F (`src/__tests__/regression/S158_RFC003_SprintF_FullCycleIntegration.test.ts`,
caso S158.1) encontrou, com evidência de um teste de ponta a ponta real (não leitura de código
isolada), que a etapa "Aprender" desta tabela **nunca é alcançada pelo caminho "Pesquisar"** —
apesar de a tabela acima descrevê-las como estágios sequenciais do mesmo ciclo.

Causa raiz: `OperationalKnowledge.captureFromGoal()` (Sprint D) só credita aprendizado quando
existe um `GoalAttempt` cujo `planStepId` começa com `'verify_'` — prefixo gerado
exclusivamente por `GoalExecutionLoop.handleNeedsDependencyOutcome()`, código exclusivo do
outcome `needs_dependency` (caminho Distribuído/determinístico). O outcome `blocked` que a etapa
"Pesquisar" produz (`GoalEvaluator.ts`, ramo de dependência totalmente desconhecida) nunca passa
por esse método — o plano que eventualmente resolve o problema vem inteiro de
`GoalPlanner.replan()`, com ids de step atribuídos por `sanitizePlanSteps.ts`
(`s.id ?? step_N`), nunca `'verify_*'` a menos que o próprio LLM escolha esse nome, o que nada no
prompt hoje instrui.

Efeito prático: o conhecimento que a etapa "Pesquisar" foi desenhada para primeiro *adquirir*
(dependências fora de `KNOWN_DEPS`, o caso central que motivou esta RFC) nunca chega a
"Reutilização futura" — só chega lá conhecimento que já tinha, desde o início, uma entrada
Distribuída completa (`installByPlatform` + `verifyCmd`), categoria que hoje não existe de forma
real em `KNOWN_DEPS` (a única entrada com `verifyCmd`, `ffmpeg`, não tem `installByPlatform` — só
resolve via `installCmd` legado, e só em Linux).

**Por que não foi corrigido na própria Sprint F:** fechar esta lacuna exige decidir *como* um
plano gerado por Planner/LLM sinaliza "este step é a verificação objetiva do anterior" — uma
extensão do contrato entre o prompt de replan e `OperationalKnowledge`, portanto uma decisão de
responsabilidade, não uma correção de wiring. O escopo da Sprint F (`docs/decisoes/
RFC-003_AQUISICAO_CONHECIMENTO_OPERACIONAL.md`, ver instruções da própria Sprint) restringe
explicitamente: "não introduzir novas arquiteturas"; "qualquer ideia descoberta... deve virar
futura ADR/RFC, nunca implementada diretamente". Candidatos de design a avaliar nessa ADR/RFC
futura (não decidido aqui): (a) o Planner passar a nomear explicitamente, no JSON do plano, qual
step é a verificação (`"role": "verify"` ou convenção equivalente, em vez de depender de um
prefixo de id); (b) `GoalExecutionLoop` inferir a verificação heuristicamente (ex.: o último step
bem-sucedido do ciclo de replan que motivou o blocker) — heurística mais fraca, provavelmente
incompatível com "validação objetiva" que esta RFC exige na seção "Validação"; (c) aceitar que o
caminho Pesquisa nunca alimenta `OperationalKnowledge` diretamente e, em vez disso, depender de um
humano promover manualmente um caso de sucesso repetido a uma entrada de `KNOWN_DEPS` (mantém a
Separação Distribuído×Aprendido, mas descarta o valor de aprendizado automático que motivou a
Sprint E).

---

# Camadas de Conhecimento

A arquitetura passa a reconhecer explicitamente dois domínios distintos de conhecimento — a
mesma separação já formalizada em `docs/ARCHITECTURE/SEPARACAO_DISTRIBUIDO_APRENDIDO.md`, que esta
RFC não redefine, apenas aplica ao novo ciclo de aquisição.

## Conhecimento Distribuído

Características:

* revisado por humanos;
* determinístico;
* versionado;
* compartilhado por todas as instalações.

Exemplos:

* `KNOWN_DEPS` (`src/loop/GoalEvaluator.ts`);
* catálogos arquiteturais;
* mapeamentos oficiais.

---

## Conhecimento Aprendido

Características:

* local;
* adquirido em tempo de execução;
* validado objetivamente;
* específico da instância;
* nunca promovido automaticamente ao conhecimento distribuído.

Exemplos:

* `OperationalKnowledge` (`src/memory/OperationalKnowledge.ts`);
* estratégias operacionais aprendidas.

Esta RFC não se estende a `ReflectionMemory` nem a `CaseMemory` — ambos permanecem exatamente como
já desenhados (`RFC-001`, `RFC-002`); o ciclo de aquisição aqui definido é específico do par
`KNOWN_DEPS`/`OperationalKnowledge`.

---

# Modos Operacionais

A aquisição autônoma de conhecimento depende do modo operacional (`src/core/CapabilityMode.ts`,
capability `install_dependencies` — verificado contra o código real em 2026-07-27):

* **SAFE**: `install_dependencies = false` → descoberta autônoma desabilitada. Caminho manual
  atual (perguntar ao usuário) permanece inalterado.
* **DEVELOPER**: `install_dependencies = true` → descoberta permitida.
* **GOD**: `install_dependencies = true` → descoberta permitida com autonomia máxima.

O modo operacional define o nível aceitável de experimentação. A validação objetiva (seção
"Validação") é universal e não varia por modo — nenhum modo, incluindo GOD, dispensa a validação
antes de aprender.

---

# Princípios Arquiteturais Preservados

Esta RFC **não substitui** os princípios atuais da arquitetura.

Ela os estende.

Permanecem obrigatórios, pelos documentos normativos que já os definem:

* `docs/ARCHITECTURE/NUNCA_ADIVINHAR.md` — nenhuma hipótese sem fonte rastreável vira dado, muito
  menos conhecimento aprendido;
* `docs/ARCHITECTURE/EVIDENCE_PROVIDER_PATTERN.md` — o ciclo de aquisição só decide taticamente
  (pula a camada de julgamento) dentro da mesma exceção nomeada já usada por `KNOWN_DEPS` (Seção 7,
  item 2), nunca como uma terceira exceção implícita;
* `docs/ARCHITECTURE/SEPARACAO_DISTRIBUIDO_APRENDIDO.md` — conhecimento aprendido nunca escreve em
  conhecimento distribuído automaticamente;
* `docs/decisoes/RFC-001_APRENDIZADO_OPERACIONAL.md` — modelo de confiança em dois níveis,
  validação em nível de goal, decaimento por falha recente;
* `docs/DIRETRIZ_ARQUITETURA_2026-07-13.md` (Validação Progressiva) — toda mudança decorrente desta
  RFC segue as 4 etapas obrigatórias (unitário → regressão → e2e sintético → ambiente real) antes
  de ser considerada concluída;
* `docs/ARCHITECTURE/PIPELINE_CURADORIA_DEPENDENCIAS.md` — o caminho assíncrono de curadoria
  (Skill, relatório, PR humano) continua existindo e inalterado para a promoção ao catálogo
  distribuído; o ciclo tático definido aqui é um caminho complementar, não um substituto.

---

# Mudança Arquitetural

A principal mudança introduzida por esta RFC é reconhecer formalmente uma nova capacidade do agente.

O agente deixa de ser apenas um consumidor de conhecimento operacional.

Ele passa a ser também um **adquirente de conhecimento operacional**.

Essa aquisição é sempre:

* fundamentada em evidências, com fonte rastreável;
* objetivamente validada;
* armazenada apenas na camada local;
* condicionada ao modo operacional;
* incapaz de alterar automaticamente conhecimento compartilhado.

---

# Impacto na Documentação Existente

Esta seção registra, sem executar, as consequências documentais desta decisão — deliberadamente
adiadas para uma etapa própria de alinhamento (ver "Próximos Passos"), para preservar
rastreabilidade entre "o que mudou" (esta RFC) e "o que foi ajustado por causa disso":

Lista revisada (2026-07-27) após segunda auditoria crítica — os itens 2 e 4 abaixo são achados
novos desta revisão, não estavam na primeira versão desta seção:

1. **`docs/ARCHITECTURE/EVIDENCE_PROVIDER_PATTERN.md`, Seção 7, item 2** — a exceção nomeada hoje
   diz *"restrito a um catálogo pequeno e nomeado"*, redação que cobre apenas `KNOWN_DEPS`.
   Precisa ser ampliada para cobrir explicitamente também conhecimento aprendido-e-validado
   taticamente (`OperationalKnowledge`, sob esta RFC), condicionado a modo operacional — e para
   citar a seção "Fronteira entre Julgamento do Planner e Atalho Determinístico" desta RFC como a
   definição precisa de onde essa exceção começa e termina.
2. **`docs/ARCHITECTURE/EVIDENCE_PROVIDER_PATTERN.md`, Seção 6 (Componentes atuais)** — *achado
   novo*: a tabela de Evidence Providers hoje não lista `OperationalKnowledge` como linha, mesmo
   já sendo um Evidence Provider real (modo informativo) desde a Milestone M2. Precisa ganhar uma
   linha própria, e essa linha precisa deixar explícito que a mesma fonte de evidência tem hoje
   dois papéis: informativo (sempre) e tático/determinístico (só na condição de confiança
   definida por esta RFC + `RFC-001`).
3. **`docs/ARCHITECTURE/PIPELINE_CURADORIA_DEPENDENCIAS.md`, Seção 5** — *"O Runtime não pesquisa
   documentação"* precisa de escopo explícito: a proibição protege o catálogo **distribuído**
   (`KNOWN_DEPS`), não pesquisa em si — o ciclo tático desta RFC pesquisa, mas nunca escreve no
   catálogo distribuído.
4. **`docs/ARCHITECTURE/PIPELINE_CURADORIA_DEPENDENCIAS.md`, Seção 6 (Limites)** — *achado novo,
   contradição direta não capturada na primeira revisão*: esta seção afirma textualmente que o
   pipeline "não define QUANDO uma dependência deve ser pesquisada... não por um gatilho
   automático dentro do Runtime". O ciclo tático desta RFC É um gatilho automático dentro do
   Runtime — precisa de um adendo explícito distinguindo os dois caminhos de pesquisa que passam a
   coexistir: o caminho assíncrono da Skill `dependency-curator` (acionado por humano, produz
   relatório, alimenta `KNOWN_DEPS` via PR — inalterado por esta RFC) e o caminho tático desta
   RFC-003 (acionado automaticamente dentro de `needs_dependency`, gated por modo operacional,
   aprende só em `OperationalKnowledge`, nunca em `KNOWN_DEPS`). Sem esse adendo, os dois
   documentos normativos se contradizem entre si.
5. **`docs/decisoes/ADR-001_BASELINE_ARQUITETURAL.md`, Seção 6** — o item "extensão tática do
   `OperationalKnowledge`... adiada até uso real provar valor" deixa de estar adiado; esta RFC é o
   registro de que a condição foi satisfeita.
6. **`docs/decisoes/RFC-001_APRENDIZADO_OPERACIONAL.md`** — ganha um adendo cobrindo os passos que
   antecedem sua cadeia original (Identificar → Descobrir → Pesquisar → Formular hipótese), já que
   a RFC-001 assumia conhecimento de "como resolver" já disponível via improviso do LLM, nunca o
   caso "não sei, preciso pesquisar".

Confirmação da auditoria: revisei também `docs/ARCHITECTURE/NUNCA_ADIVINHAR.md` e
`docs/ARCHITECTURE/SEPARACAO_DISTRIBUIDO_APRENDIDO.md` por completo — nenhum dos dois precisa de
edição. O primeiro já é respeitado pela exigência de rastreabilidade de fonte que esta RFC
incorpora; o segundo já é respeitado porque conhecimento aprendido nesta RFC nunca escreve em
`KNOWN_DEPS` automaticamente — nenhuma das garantias que esses dois documentos definem é alterada.

---

# Benefícios Esperados

* Redução da manutenção manual de catálogos.
* Menor dependência de heurísticas específicas.
* Menor necessidade de codificar exceções.
* Maior autonomia operacional.
* Melhor adaptação a novos ambientes.
* Evolução contínua baseada em experiência validada.
* Redução da intervenção humana em problemas recorrentes.

---

# Não Objetivos

Esta RFC não propõe:

* eliminar o conhecimento distribuído;
* substituir revisão humana;
* modificar automaticamente o KNOWN_DEPS;
* permitir experimentação irrestrita;
* remover mecanismos de segurança existentes;
* generalizar o ciclo para outros tipos de conhecimento (serviços, variáveis de ambiente, APIs,
  versões) — extensão possível no futuro, mas sem um segundo caso evidenciado hoje (mesmo
  critério de Regra de Três já aplicado a `TOOL_DEPENDENCY_ARG`,
  `docs/issues/017-tool-dependency-arg-declarative-contracts-trigger.md`).

Essas garantias permanecem obrigatórias.

---

# Considerações Finais

Um agente verdadeiramente autônomo não deve apenas executar aquilo que já conhece.

Ele deve ser capaz de adquirir novo conhecimento operacional por meio de observação, descoberta, experimentação controlada, validação objetiva e aprendizagem.

Esta RFC formaliza essa capacidade como um princípio arquitetural de primeira classe.

O objetivo não é reduzir o determinismo do sistema.

O objetivo é tornar **autônoma a aquisição de conhecimento operacional determinístico**.

Em outras palavras:

> **O conhecimento operacional não deve ser programado sempre que possível; deve ser adquirido sempre que seguro, validado sempre que necessário e compartilhado somente quando comprovadamente confiável.**

---

# Próximos Passos

1. ✅ **Fase 1 — Consolidar a RFC** (primeira revisão): rastreabilidade de fontes, nível de
   confiança formalizado, referências a documentos reais, impacto documental explicitado.
2. ✅ **Fase 1b — Segunda auditoria crítica** (esta revisão): princípio de descoberta-antes-da-
   codificação com escopo explícito (não se aplica a segurança/correção estrutural); fronteira
   Planner×atalho determinístico definida por etapa; condição de parada do ciclo amarrada ao
   orçamento já existente de `GoalExecutionLoop` (sem contador paralelo); lista de impacto
   documental corrigida de 4 para 6 itens (2 contradições novas encontradas: tabela de
   componentes do Evidence Provider Pattern e a Seção 6 do Pipeline de Curadoria).
3. ⏳ **Fase 2 — Alinhamento da documentação**: aplicar as 6 mudanças listadas em "Impacto na
   Documentação Existente" — `EVIDENCE_PROVIDER_PATTERN.md` (2 pontos),
   `PIPELINE_CURADORIA_DEPENDENCIAS.md` (2 pontos), `ADR-001`, `RFC-001` — como etapa própria,
   separada desta RFC.
4. ⏳ **Fase 3 — Auditoria de impacto e implementação**: só após a Fase 2 concluída, seguindo
   integralmente a Validação Progressiva (`docs/DIRETRIZ_ARQUITETURA_2026-07-13.md`).
