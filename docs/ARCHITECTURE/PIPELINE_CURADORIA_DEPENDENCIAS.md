# Pipeline de Curadoria de Dependências

> Documento normativo. Define o processo oficial pelo qual conhecimento sobre instalação
> cross-platform de dependências entra em `KNOWN_DEPS`, e a fronteira de responsabilidade entre
> pesquisa (Skill) e execução (Runtime) nesse processo.

## 1. Objetivo

Garantir que toda entrada em `KNOWN_DEPS` — o catálogo distribuído de dependências do NewClaw —
carregue evidência rastreável de onde seu comando de instalação veio, e que a decisão de
incorporá-la ao catálogo permaneça sempre humana. Este documento consolida, como decisão
arquitetural nomeada, um processo que já existia informalmente (uma Skill isolada) para que não
fique implícito nem dependente de alguém lembrar que ela existe.

## 2. Motivação

A Sprint 007 (`docs/Auditorias/2026-07-26/AUDITORIA_COBERTURA_CROSSPLATFORM_KNOWN_DEPS_2026-07-26.md`)
encontrou que 23 das 26 entradas de `KNOWN_DEPS` não têm comando de instalação para Windows/macOS
— não por decisão técnica, mas porque nunca existiu um processo repetível para pesquisar e validar
esses comandos antes de um commit os adicionar. A Sprint 008 respondeu a isso com uma Skill
(`dependency-curator`) que pesquisa e documenta, sem automatizar nada. Este documento resolve o
risco remanescente identificado ao final da Sprint 008: um processo que só existe dentro do texto
de uma Skill é fácil de contornar, esquecer, ou reimplementar de forma divergente em outro lugar do
projeto — precisa estar registrado como decisão arquitetural, com a mesma força que o Evidence
Provider Pattern, Nunca Adivinhar e Separação Distribuído × Aprendido já têm.

## 3. Definição

O Pipeline de Curadoria de Dependências é a sequência obrigatória entre "uma dependência precisa
de cobertura cross-platform" e "essa cobertura existe em `KNOWN_DEPS`, executável pelo Runtime":

```text
Nova dependência (ou entrada existente sem cobertura completa)
        │
        ▼
Dependency Curator (Skill) ── pesquisa fonte oficial, por plataforma
        │
        ▼
Validação (grau de confiança + situação, por plataforma)
        │
        ▼
Relatório estruturado (docs/Auditorias/dependencias/<nome>.md)
        │
        ▼
Revisão humana (decide se entra, decide se precisa de teste novo)
        │
        ▼
KNOWN_DEPS (PR revisado, GoalEvaluator.ts)
        │
        ▼
GoalEvaluator (classifica a dependência ausente, resolve a entrada do catálogo)
        │
        ▼
resolveInstallCommand (decide QUAL comando usar, dado o SO real detectado)
        │
        ▼
GoalExecutionLoop (executa o comando resolvido, via exec_command)
```

Duas metades estruturalmente distintas compõem este fluxo: tudo **antes** de "Revisão humana" é
pesquisa (Skill, assíncrona, fora do caminho de execução de qualquer goal); tudo **depois** é
execução de conhecimento já validado (Runtime, síncrono, dentro do caminho de execução de um
goal). Nenhum componente do lado Runtime pesquisa; nenhum componente do lado Skill executa ou
decide automaticamente.

## 4. Responsabilidades por componente

### 4.1 Dependency Curator (Skill — `skills/dependency-curator/SKILL.md`)

- **O que faz**: pesquisa, por plataforma (Linux/Windows/macOS), o comando de instalação de uma
  dependência a partir de fontes oficiais, usando `web_search`/`web_navigate`; atribui grau de
  confiança e situação (`validado` / `parcialmente validado` / `necessita testes` / `não
  encontrado`) a cada plataforma; produz um relatório estruturado com fonte citada para cada
  comando.
- **O que não faz**: não instala nada (`exec_command` não está entre suas tools); não edita
  `KNOWN_DEPS` nem qualquer outro arquivo de código-fonte; não decide se uma dependência entra no
  catálogo — isso é sempre decisão humana, via PR.
- **Quando deve ser utilizada**: acionada por um humano/operador, de forma assíncrona, antes de
  propor uma nova entrada em `KNOWN_DEPS` ou de completar `installByPlatform` de uma entrada
  existente. Nunca como reação automática a uma dependência ausente durante a execução de um goal
  — esse caminho reativo já existe e continua sendo `GoalEvaluator`/`resolveInstallCommand`
  (Seções 4.3-4.4), inalterado por este pipeline.
- **Evidências que produz**: um documento por dependência
  (`docs/Auditorias/dependencias/<nome>.md`) com fonte (URL) por comando, situação por
  plataforma, requisitos (privilégios administrativos, dependências adicionais) e uma
  recomendação final que nunca se auto-aprova.

### 4.2 KNOWN_DEPS (`src/loop/GoalEvaluator.ts`)

- **Papel como catálogo oficial**: única fonte de verdade, versionada em código-fonte, para
  metadados de dependência de SO — nome do pacote, comando de instalação (legado ou por
  plataforma) e instruções manuais. Consolidado como fonte única na Sprint 005
  (`docs/Auditorias/2026-07-26/AUDITORIA_CATALOGOS_FERRAMENTAS_2026-07-26.md`) — nenhum outro
  componente mantém cópia própria destes dados (`RiskAnalyzer.ts` deriva de `KNOWN_DEPS`, nunca
  duplica).
- **Critérios para inclusão de novas entradas** (formalizados por este documento, a partir do
  processo que já operava informalmente): uma entrada — ou uma expansão de `installByPlatform`
  para uma entrada já existente — só é incorporada via PR revisado por humano, com evidência de
  origem rastreável (idealmente um relatório do Dependency Curator, mas qualquer fonte
  verificável e citável serve). Situação `necessita testes` ou `não encontrado` no relatório da
  Skill não bloqueiam a entrada de existir, mas bloqueiam a alegação de que ela é confiável —
  ficam registradas como tal (comentário na entrada, como já é o padrão para `edge-tts`/
  `tesseract`).
- **Relação com a Skill de Curadoria**: a Skill é a via de pesquisa recomendada, não a única
  possível — o critério de aceitação é a evidência em si (fonte citada, revisão humana), não o
  mecanismo que a produziu. Nunca o inverso: a Skill nunca escreve diretamente em `KNOWN_DEPS`.

### 4.3 OperationalKnowledge (`src/memory/OperationalKnowledge.ts`)

Não substitui o catálogo. `OperationalKnowledge` aprende, por instância e em runtime, **qual
comando resolveu** uma dependência específica naquele ambiente específico — características
observadas do ambiente onde a instância roda, não conhecimento validado sobre instalação oficial.
É Conhecimento Aprendido, não Distribuído (`docs/ARCHITECTURE/SEPARACAO_DISTRIBUIDO_APRENDIDO.md`,
Seção 3) — nasce de uma execução real, único daquela instância, nunca passa por revisão humana
antes de influenciar a mesma instância de novo, e nunca é promovido automaticamente a
`KNOWN_DEPS`. O Dependency Curator, em contraste, produz Conhecimento Distribuído em potencial
(vira `KNOWN_DEPS` só depois de PR humano) a partir de fontes oficiais, não de execução real —
as duas metades resolvem a mesma pergunta ("como instalar X") por processos estruturalmente
distintos, sem um substituir o outro (mesma relação já documentada entre `KNOWN_DEPS` e
`OperationalKnowledge`, `SEPARACAO_DISTRIBUIDO_APRENDIDO.md`, Seção 5).

### 4.4 resolveInstallCommand (`src/loop/planning/resolveInstallCommand.ts`)

Função pura de consumo, não de conhecimento. Documentado explicitamente por este pipeline:

- **Apenas consome o catálogo**: lê um `DependencyInfo` já resolvido (vindo de `KNOWN_DEPS`) e o
  `OSCapabilities.platform` real detectado — nunca busca, nunca complementa o dado que recebe.
- **Não pesquisa comandos**: nenhuma chamada de rede, nenhuma consulta a documentação — toda a
  informação já precisa estar em `KNOWN_DEPS` antes desta função ser chamada.
- **Não aprende**: não persiste nada, não tem estado entre chamadas — puro, mesma entrada sempre
  produz a mesma saída.
- **Não decide**: quando não há `installByPlatform` para a plataforma detectada, retorna
  `undefined` (nunca infere, nunca cai no fallback Linux fora de Linux) — a decisão sobre o que
  fazer diante dessa ausência pertence ao `GoalExecutionLoop` (caminho manual) e, em última
  instância, ao usuário. Comportamento comprovado em produção pela Sprint 006 (Casos 2 e 5,
  `docs/sprints/SPRINT_006_VALIDACAO_OPERACIONAL_REPORT.md`).

### 4.5 EnvironmentProbe (`src/core/EnvironmentProbe.ts`)

Documentado explicitamente por este pipeline:

- **Apenas verifica disponibilidade**: roda `where`/`command -v` (ou equivalente) sobre uma
  lista fixa de binários (`TOOLS_TO_PROBE`) para responder "isto já está instalado neste
  ambiente?" — uma pergunta factual sobre o estado atual da máquina, não sobre como instalar algo
  que falta.
- **Não identifica métodos de instalação**: não tem, e nunca deve ter, nenhuma lógica de
  `installCmd`/`installByPlatform` — essa informação vive exclusivamente em `KNOWN_DEPS`.
  `TOOLS_TO_PROBE` e `KNOWN_DEPS` compartilham nomes de ferramenta (protegido por teste de
  paridade, `S154_CatalogConsistency_KnownDepsToolsToProbeParity.test.ts`), nunca comandos.
- **Não produz conhecimento**: seu resultado é um Evidence Provider clássico
  (`docs/ARCHITECTURE/EVIDENCE_PROVIDER_PATTERN.md`, Seção 6) — texto factual ("disponível" /
  "indisponível") entregue ao `GoalPlanner`, nunca uma decisão nem uma tentativa de descobrir
  como resolver a ausência.

## 5. Princípios arquiteturais

- **Evidências antes de automação**: nenhuma entrada chega a `KNOWN_DEPS` sem uma fonte
  rastreável — automatizar a instalação de uma dependência é sempre posterior, nunca simultâneo,
  a validar que o comando existe e funciona.
- **Nunca adivinhar comandos** (`docs/ARCHITECTURE/NUNCA_ADIVINHAR.md`): tanto o Dependency
  Curator (que registra `não encontrado` em vez de propor um comando sem fonte) quanto
  `resolveInstallCommand` (que retorna `undefined` em vez de estender um comando por analogia
  entre plataformas) seguem o mesmo princípio, em pontos diferentes do pipeline.
- **O Runtime não pesquisa documentação**: `GoalEvaluator`, `resolveInstallCommand` e
  `EnvironmentProbe` nunca fazem uma requisição de busca ou leitura de página externa para
  descobrir como instalar algo — essa responsabilidade é exclusiva da Skill, fora do caminho de
  execução de goals.
- **O Runtime apenas executa conhecimento previamente validado**: tudo que o `GoalExecutionLoop`
  executa no fluxo `needs_dependency` já passou por `KNOWN_DEPS` — nunca por uma pesquisa feita
  na hora.
- **Pesquisa e execução são responsabilidades distintas**: a Skill nunca tem `exec_command` (não
  instala o que pesquisa); o Runtime nunca tem `web_search`/`web_navigate` no caminho de
  `needs_dependency` (não pesquisa o que executa). Nenhum componente faz as duas coisas.

## 6. Limites — o que este pipeline não cobre

- Não substitui o caminho reativo existente (`GoalEvaluator` classifica uma falha real →
  `KNOWN_DEPS` → `resolveInstallCommand` → instalação automática quando segura) — esse caminho
  continua existindo e inalterado; o pipeline de curadoria só melhora a *cobertura* dos dados que
  ele consome.
- Não promove automaticamente relatórios do Dependency Curator para `KNOWN_DEPS` — mesma regra de
  travessia manual que já vale para `OperationalKnowledge`
  (`docs/ARCHITECTURE/SEPARACAO_DISTRIBUIDO_APRENDIDO.md`, Seção 6): sempre PR humano.
- Não define QUANDO uma dependência deve ser pesquisada — isso é acionado por um humano/operador
  identificando uma lacuna (como a Sprint 007 fez), não por um gatilho automático dentro do
  Runtime.

## 7. Benefícios

- **Processo único e nomeado**: futuras contribuições que queiram expandir `KNOWN_DEPS` têm um
  caminho documentado a seguir, em vez de reinventar pesquisa ad-hoc a cada dependência nova.
- **Rastreabilidade**: toda entrada nova (ou expandida) em `KNOWN_DEPS` pode apontar para um
  relatório de curadoria com fonte citada — decisão de PR deixa de depender de memória ou
  confiança implícita no autor.
- **Sem novo acoplamento**: nenhum componente de Runtime foi alterado para este pipeline existir
  — a Skill orquestra tools já existentes (`web_search`, `web_navigate`, `read`, `write`), e o elo
  entre pesquisa e catálogo continua sendo o mesmo processo de PR humano que já regia toda
  mudança em `KNOWN_DEPS`.

## 8. Relação com outros princípios

- **Evidence Provider Pattern**: a exceção nomeada "Resolução determinística de dependências
  catalogadas" (`EVIDENCE_PROVIDER_PATTERN.md`, Seção 7, item 2) só permanece legítima enquanto
  `KNOWN_DEPS` for "um catálogo pequeno e nomeado" com alta confiança por entrada — este pipeline
  é o processo que sustenta essa confiança ao longo do tempo, à medida que o catálogo cresce.
- **Separação Distribuído × Aprendido**: este pipeline é o caminho formal de pesquisa que
  antecede a travessia manual de conhecimento para a categoria Distribuída — nunca gera
  Conhecimento Aprendido (isso continua sendo só `OperationalKnowledge`, Seção 4.3).
- **Nunca Adivinhar**: aplicado nas duas pontas do pipeline (Skill e `resolveInstallCommand`),
  ver Seção 5.
- **Gate de Extensão antes de Criação** (`docs/DIRETRIZ_ARQUITETURA_2026-07-13.md`): a Sprint 008
  aplicou este gate antes de criar a Skill — nenhuma Tool nova foi introduzida; o pipeline reusa
  inteiramente `web_search`/`web_navigate`/`read`/`write`, já existentes.

## 9. Checklist para novas dependências

Antes de propor uma entrada nova (ou expandida) em `KNOWN_DEPS`, responder:

- [ ] Existe um relatório de curadoria (Dependency Curator ou equivalente) com fonte citada para
      cada plataforma proposta?
- [ ] Toda plataforma sem fonte confiável está marcada `não encontrado`, não preenchida por
      analogia com outra plataforma?
- [ ] A entrada tem um autor humano e um PR — nenhuma parte do processo escreveu em
      `GoalEvaluator.ts` automaticamente?
- [ ] Se a situação de alguma plataforma é `necessita testes`, existe um teste novo cobrindo essa
      entrada real (não uma cópia sintética) antes do PR ser aprovado — mesmo padrão de `S141`?
- [ ] `TOOLS_TO_PROBE` (`EnvironmentProbe.ts`) foi revisado para incluir a nova ferramenta, se
      aplicável — ver teste de paridade `S154`?
