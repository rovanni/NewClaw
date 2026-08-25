# Quando Extrair Duplicação (Single Authoritative Knowledge)

> Documento normativo. Define o critério para decidir, diante de código duplicado, entre extrair
> uma abstração compartilhada e aceitar a duplicação — para qualquer camada do NewClaw, não só o
> Dashboard onde o caso que originou este documento apareceu. Confirmado como padrão recorrente
> por investigação dedicada (Seção 5) antes de ser registrado — não é generalização de um caso só.

**Nota sobre nomenclatura.** Uma revisão externa sugeriu batizar este documento "ARCH-017 —
Single Authoritative Knowledge". Verificado contra o repositório antes de aceitar (a mesma
disciplina que este documento exige de qualquer extração): `ARCH-017` já existe, ocupado por um
item concluído sem relação nenhuma com este assunto — e pior, o repositório tem **duas séries
`ARCH-XXX` que colidem entre si**, sem fonte autoritativa de identidade. Detalhes, evidência e o
que falta decidir: `docs/issues/024-arch-numbering-two-colliding-series.md` (registrado à parte de
propósito — resolver o sistema de identificação dos documentos arquiteturais é uma pergunta
diferente da desta campanha, e não deveria ganhar uma segunda representação aqui). Por ora, este
documento mantém o nome descritivo, mesmo padrão que os outros 9 documentos de
`docs/ARCHITECTURE/` já usam.

## 1. Objetivo

Evitar as duas falhas simétricas que a citação que motivou este documento já nomeava como
"cuidados" do princípio DRY (*Don't Repeat Yourself*, Hunt & Thomas, *The Pragmatic Programmer*):
duplicação que diverge silenciosamente ao longo do tempo (um bug corrigido só numa cópia), e
abstração prematura que acopla módulos que deveriam ficar independentes só para eliminar uma
duplicação pequena demais para justificar o custo. Nenhum dos dois é o padrão correto sozinho — a
decisão precisa de critério, não de reflexo.

A formulação mais precisa não é "não repita código" — é:

> **Conhecimento que pode divergir semanticamente entre cópias deve ter uma representação
> autoritativa única (Single Authoritative Knowledge). Duplicação estrutural pequena e
> deliberadamente independente pode ser mantida quando não representa conhecimento compartilhado e
> extraí-la introduziria acoplamento desnecessário.**

Não é sobre economizar linhas. É sobre nunca ter **duas fontes diferentes para o mesmo
conhecimento** — porque duas fontes podem responder perguntas diferentes com o tempo, e nada no
sistema avisa quando isso acontece.

| DRY tradicional (leitura comum) | Single Authoritative Knowledge (este documento) |
|---|---|
| Eliminar duplicação de código. | Eliminar duplicação de *conhecimento* — código parecido não é necessariamente conhecimento duplicado. |
| Foco em linhas de código. | Foco em comportamento e fonte de verdade. |
| Abstração frequentemente antecipada ("pode precisar depois"). | Abstração só quando reduz divergência real ou já observada (Seção 3, Teste 1). |
| Não distingue utilitário de regra de negócio. | Distingue explicitamente (Seção 3, Teste 0). |
| Acoplamento é efeito colateral, raramente avaliado. | Acoplamento é critério explícito da decisão (Seção 3, Teste 2 / contra-teste). |

## 2. Motivação

Achado ao vivo (2026-08-24): `LocalModelWizard.js` ("Assistente de Configuração Rápida") e
`ConfigWizard.js` ("Assistente de Configuração" completo) — dois componentes React-like
independentes, montados na mesma tela do Dashboard — renderizavam a mesma lista de modelos locais
carregáveis com código quase idêntico, copiado. Um bug visual real (a lista de 10+ arquivos `.gguf`
sem nenhuma separação entre linhas, difícil saber qual botão "Usar este modelo" correspondia a
qual nome) foi corrigido primeiro só visualmente (uma classe CSS aplicada nos dois lugares); o
usuário apontou, corretamente, que isso deixava os dois blocos de JavaScript dependendo de alguém
lembrar de mudar os dois juntos na próxima vez — exatamente o risco que motiva DRY.

A mesma investigação, porém, encontrou o CONTRAEXEMPLO já registrado no próprio código, escrito
antes deste incidente: `formatBytes()`, uma função pura de 4 linhas, existe **duplicada por valor**
nos dois mesmos arquivos, com o comentário explícito: *"Duplicar um utilitário de 4 linhas sem
lógica de negócio não é a duplicação que a diretriz do projeto veta; importar do outro componente é
que criaria um acoplamento sem necessidade real entre os dois wizards."* Os dois wizards são
mantidos como máquinas de estado deliberadamente independentes (ver cabeçalho de `ConfigWizard.js`,
Incremento 4: *"LocalModelWizard.js NÃO foi tocado nem substituído... continua montado e funcional
como está"*) — importar um wizard de dentro do outro para reaproveitar 4 linhas destruiria essa
independência por um ganho mínimo.

Antes de registrar este documento como regra definitiva, uma investigação dedicada varreu o
repositório inteiro atrás de outros casos reais (não hipotéticos) de duplicação que já causou
divergência — para confirmar se isto é um padrão recorrente ou generalização de dois exemplos. A
Seção 5 lista o resultado: **6 casos adicionais confirmados**, com data, incidente e evidência
citável, em camadas bem diferentes do sistema (mídia, catálogo de dependências, entrega de goal,
segurança, formatação de resposta) — acima do limiar de 3 usado para considerar um padrão
recorrente, não peculiaridade do Dashboard.

## 3. Definição

Diante de dois ou mais trechos de código que fazem a mesma coisa, a pergunta não é "isto está
duplicado?" — quase sempre está, em algum grau. A pergunta é: **esta duplicação específica atende
ao Teste 1 e ao Teste 2 abaixo?** Só quando os dois respondem "sim" a duplicação deve ser extraída;
caso contrário, mantê-la é a escolha correta, não um débito técnico pendente.

**Teste 0 — Conhecimento ou implementação? (pré-filtro rápido, não substitui o Teste 1)** Antes de
gastar tempo nos testes completos, uma triagem rápida já descarta a maioria dos casos:

- **Conhecimento** (candidato a extração — segue para o Teste 1): regras de negócio, políticas,
  capacidades, contratos, estados compartilhados, catálogos (de providers, de modelos, de
  dependências), permissões.
- **Implementação** (normalmente pode ficar duplicada, sem precisar do Teste 1 completo): helpers
  locais, formatação, CSS específico, renderização simples, conversões pequenas sem semântica
  compartilhada.

Isto é um atalho, não um segundo critério independente — mesma ressalva que
`RESPONSABILIDADE_ANTES_DO_MECANISMO.md` já aplica a qualquer pré-filtro determinístico: só é
legítimo enquanto elimina apenas casos *objetivamente* fora de escopo. A pergunta obrigatória antes
de confiar nele: **este pré-filtro pode estar descartando um caso que o Teste 1 classificaria de
outro jeito?** Em caso de dúvida (um "helper" que na verdade decide algo, uma "formatação" que
esconde uma regra), pular o Teste 0 e ir direto ao Teste 1 completo.

**Teste 1 — Existe conhecimento/comportamento compartilhado que pode divergir?** O código
duplicado carrega pelo menos um destes sinais — não apenas semelhança sintática:

- comportamento compartilhado (a mesma decisão, tomada em dois lugares);
- regra de negócio compartilhada;
- divergência já observada (uma cópia mudou, a outra não);
- risco concreto de divergência (as duas cópias são candidatas naturais a mudar independente,
  mesmo que ainda não tenham divergido);
- necessidade real de manutenção conjunta (mudar uma exige, por regra, mudar a outra junto);
- representação do mesmo conhecimento (o mesmo fato do domínio, expresso duas vezes).

Similaridade textual sozinha **não** é um desses sinais. `formatBytes()` falha este teste (é só
formatação, sem nenhum dos seis sinais acima); a lógica de request HTTP dos três providers
OpenAI-compatible passa (regra de negócio compartilhada: como tratar erro, como interpretar
streaming).

**Teste 2 — Extração não acopla o que deveria ficar independente?** O ponto de extração é um
módulo-folha neutro que os dois lados importam (mesma categoria de `Toast.js`, já importado por
ambos os wizards antes deste incidente) — nunca um dos dois lados importando o outro diretamente.
Se a única forma de eliminar a duplicação é fazer módulo A depender de módulo B (ou vice-versa), e
A e B precisam continuar evoluíveis de forma independente, a duplicação vale mais que o
acoplamento. Formulado como pergunta única: **a abstração reduz divergência sem criar acoplamento
arquitetural pior do que o problema que resolve?** Se a resposta for "não" ou "incerto", a
duplicação pode ser intencional — não extrair.

### Guarda contra abstração prematura

Este documento não autoriza extrair código só porque duas partes dele são parecidas. Sem pelo
menos um dos seis sinais do Teste 1, duas ocorrências de `const timeout = 30000;` em arquivos
diferentes não viram um `SharedConstantsService` — isso substitui uma "duplicação" de uma linha por
um módulo, um import, e uma dependência nova, sem nenhum ganho real. O Teste 1 existe
especificamente para barrar esse movimento.

### Extração preventiva (diferente de abstração prematura)

Nem toda extração espera um bug de divergência acontecer primeiro. Quando já existe uma única
fonte de verdade claramente identificável e mais de um consumidor real e independente, extrair
antes do primeiro incidente é legítimo — a diferença para "abstração prematura" é que aqui o
conhecimento compartilhado (Teste 1) já existe e é óbvio, só a extração ainda não tinha sido feita.

Exemplo real já no código, anterior a este documento: `CLOUD_PROVIDERS`, `PROV_LABELS` e
`LOCAL_PROVIDER_LABEL` (`ModelosView.js:64-81`) são o catálogo de provedores/labels que TODO o
Dashboard usa. Em vez de `ConfigWizard.js` (Incremento 4) recriar sua própria cópia desses três
catálogos, ele os recebe por referência no `mount()` — ver comentário no cabeçalho do arquivo:
*"são as MESMAS constantes/funções que as abas antigas (e o wizard antigo) já usam, referenciadas,
não duplicadas."* Nenhum bug de divergência precisou acontecer primeiro; o conhecimento
compartilhado (qual provedor existe, qual label mostrar) já era óbvio o bastante para justificar
não duplicar desde o início.

## 4. Responsabilidades

Quem encontra código duplicado, ou está prestes a copiar um trecho existente, **DEVE**:

- Aplicar os testes da Seção 3 (0, 1 e 2) antes de decidir — nunca extrair só porque "duplicação é
  sempre ruim", nem manter duplicado só porque "extrair dá trabalho agora".
- Quando extrair, criar (ou reutilizar) um módulo-folha sem estado de negócio próprio — a extração
  deve poder ser descrita como "os dois lados importam X", nunca "um lado importa o outro".
- Preservar, ao extrair, qualquer diferença de comportamento real entre os usos (ver Seção 6) —
  extração não é desculpa para forçar os dois casos a se comportarem identicamente se eles não
  deveriam.
- Registrar, no comentário do módulo extraído, POR QUE a duplicação anterior falhou o Teste 1 ou o
  Teste 2 (qual bug ela já causou, ou qual acoplamento ela evitaria) — o mesmo padrão que
  `LocalModelPickList.js` e o comentário de `formatBytes()` já seguem.

Quem encontra código duplicado **NÃO DEVE**:

- Extrair um trecho só por semelhança textual, sem nenhum dos seis sinais do Teste 1 presente —
  ver "Guarda contra abstração prematura" acima.
- Deixar uma duplicação que já causou um bug real de divergência (Teste 1 confirmado) sem extrair,
  só porque "sempre foi assim" — duplicação com histórico de divergência é a duplicação mais cara,
  não a mais barata. Os 6 casos da Seção 5 mostram o custo real: cada um levou a um incidente
  datado, não a um risco abstrato.
- Criar uma abstração compartilhada "para o caso de precisar de novo" sem um segundo uso real —
  ver `docs/DIRETRIZ_ARQUITETURA_2026-07-13.md` (gate de Extensão antes de Criação): o mesmo
  princípio vale ao contrário — não criar módulo compartilhado antes de haver dois consumidores
  reais.

## 5. Casos reais no repositório

Levantamento por investigação dedicada (2026-08-24), não por amostragem — cada linha abaixo tem
arquivo, data e evidência citável no próprio repositório.

**Inventário completo e classificado** (com Teste 0/1/contra-teste de acoplamento aplicados a
cada caso, incluindo dois casos não listados aqui — D-07, D-08):
`docs/ARCHITECTURE/INVENTARIO_DUPLICACAO_2026-08-24.md`. Esta seção mantém só o resumo original;
o inventário é a fonte autoritativa para classificação/decisão caso a caso — evita duas listas que
podem divergir sobre o mesmo conjunto de casos, exatamente o problema que este documento define.

### 5.1 Confirmados — duplicação que já causou divergência observada

| # | Caso | Sinal do Teste 1 | Decisão / estado |
|---|---|---|---|
| 1 | Lista de modelos locais (`LocalModelWizard.js` / `ConfigWizard.js`) | Divergência já observada — bug visual real (zebra striping corrigido só num dos dois) | Extraído para `LocalModelPickList.js` (2026-08-24) |
| 2 | Retry com backoff em anexos (`agentMediaHandlers.ts`) — `transcribeAttachment` tinha retry×3; `handlePhotoAttachment`/`handleDocumentAttachment` não | Divergência já observada — incidente 04/08/2026 (RFC-004 Correção 3): 3 de 12 imagens enviadas nunca produziram resposta | Corrigido — ver `S198_MediaHandlers_DownloadRetryParity.test.ts` |
| 3 | Catálogos de dependências (`KNOWN_DEPS` / `TOOLS_TO_PROBE` / `KNOWN_SYSTEM_DEPS`) | Divergência já observada — auditoria 26/07/2026: `puppeteer`/`tesseract` ausentes de `TOOLS_TO_PROBE` por 2+ dias; `edge-tts` levou 2 commits/~11h pra existir nos dois catálogos | Parcialmente corrigido (`KNOWN_SYSTEM_DEPS` eliminado, Sprint 005/5.1) — ver `S154_CatalogConsistency_KnownDepsToolsToProbeParity.test.ts` |
| 4 | "Posso entregar isto cru?" (`ToolRegistry.DIRECT_DELIVERABLE_TOOLS`) — só `AgentLoop` consultava; `GoalExecutionLoop.buildResult()` não | Divergência já observada — goal real `goal_1786759205879_fmpwq` (14/08/2026): dump de diagnóstico de `web_navigate` entregue ao usuário como se fosse resposta final | Corrigido (14/08/2026) |
| 5 | Regex de comando destrutivo (`server_config.ts` real vs. `AuthorizationManager.ts`, cópia só p/ texto do aviso) | Divergência já observada — a cópia sem word-boundary casava "format" dentro de "informação"/"informativo" | Consolidado em `destructiveCommandPatterns.ts` — impacto foi só o texto do aviso, nunca abriu brecha de bloqueio |
| 6 | Prefixo `$` duplicado em `crypto_analysis` (`detail()` ×2 vs. `analiseSangrando()`) | Divergência já observada — goal real `goal_1786759359533_um60t` (14/08/2026): resposta mostrou `Market Cap: $$1.26T` | Corrigido — ver `S232_CryptoAnalysis_NoDuplicateDollarSign.test.ts` |

### 5.2 Candidato pendente — sinal presente, extração ainda não avaliada formalmente

| Caso | Sinal do Teste 1 | Estado |
|---|---|---|
| Lógica de request OpenAI-compatible (`OpenAIProvider`/`DeepSeekProvider`/`GroqProvider`) | Regra de negócio compartilhada (parsing de resposta, erro, streaming) — sem divergência observada ainda | Registrado como risco (Sprint 01, `docs/ARCHITECTURE/README.md`), não corrigido; Teste 2 não avaliado formalmente |

### 5.3 Duplicação já consolidada preventivamente (sem esperar o incidente)

Casos em que a extração já aconteceu por outro motivo, sem um bug de divergência já ter ocorrido —
não contam para o veredito de "padrão recorrente" da Seção 2, mas mostram o mesmo critério da
"Extração preventiva" (Seção 3) aplicado antes do primeiro incidente: `CLOUD_PROVIDERS`/
`PROV_LABELS`/`LOCAL_PROVIDER_LABEL` (catálogo único de `ModelosView.js`, recebido por referência
em `ConfigWizard.js` — exemplo detalhado na Seção 3), `analysisIntentPattern.ts` (regex de
intenção de análise, antes duplicado 2× dentro de `AgentLoop.ts` e ausente em
`ObserverValidator.ts`), `transientErrorPatterns.ts` (ARCH-014), `AgentController.
createWorkflowCallback` (antes 4× quase idêntico por canal), `artifactContract.ts`
(`MIN_DELIVERABLE_SIZE`), `OllamaProvider.discoverModels()`.

### 5.4 Fora de escopo deste documento (categorias adjacentes, não confundir)

- **Mesmo defeito replicado, não divergência entre cópias**: `ClassificationMemory.hash()` e
  `UnifiedIntentRouter.hashInput()` duplicavam a mesma fórmula (djb2) e **as duas** carregavam o
  mesmo bug (CodeQL loop-bound-injection) — é duplicação que multiplicou um defeito, não duas
  cópias que divergiram uma da outra. Ver `S134_BoundedHash_LoopBoundInjection.test.ts`.
- **Duplicação de dados, não de lógica**: limpeza de propostas duplicadas no banco
  (`SkillLearner.ts`) é sobre registros, não código.
- **Paridade de tradução preventiva**: `S147_DashboardI18n_KeyParity.test.ts` trava paridade de
  chaves entre 3 idiomas; a única lacuna encontrada foi corrigida dentro da mesma campanha, antes
  de virar bug visível — preventivo, não um incidente já consumado.
- **Contrato implícito mal reimplementado, não duplicação de código**: o bug de prefixo duplo de
  sessão (`S189_ConversationIdentity_NoDoublePrefix.test.ts`, 04/08/2026) veio de cliente e servidor
  reimplementando o mesmo contrato de forma incompatível — padrão adjacente (contrato sem
  representação única compartilhada), não duas cópias do mesmo código-fonte.

## 6. O que a extração NÃO apaga

Extrair a duplicação identificada por este documento nunca deve apagar diferença de comportamento
que já existia antes da extração. No caso `LocalModelPickList.js`: os dois wizards continuam com
reações diferentes ao clique em "usar este modelo" — `LocalModelWizard.js` escreve um cronômetro no
próprio botão clicado; `ConfigWizard.js` transiciona para uma tela nova com seu próprio loop de
`render()`. Essa diferença é a razão real pela qual os dois wizards são máquinas de estado
independentes, e continua inteira do lado de cada `onPick` que o chamador passa ao módulo
extraído — o módulo extraído só sabe renderizar a lista e disparar o callback, nunca decide o que
acontece depois do clique.

## 7. Exceções

Nenhuma exceção aos dois testes da Seção 3. O que existe é a possibilidade de os dois testes
darem respostas diferentes em momentos diferentes para o MESMO par de trechos — como aconteceu com
a lista de modelos locais: a duplicação existia desde antes, e só passou a falhar o Teste 1 no
momento em que efetivamente divergiu (o bug visual). Isso não é uma exceção ao critério; é o
critério funcionando como esperado — duplicação sem nenhum dos seis sinais do Teste 1 é tratada
como aceitável até um deles aparecer de fato.

## 8. Benefícios

- **Menos acoplamento acidental**: módulos que deveriam evoluir independente (como os dois
  wizards) continuam podendo, sem um import cruzado nascido só para economizar 4 linhas.
- **Menos divergência silenciosa**: lógica real com histórico de duplicação-que-já-quebrou não
  fica esperando o segundo incidente para ser extraída — os 6 casos da Seção 5.1 mostram que, sem
  esse critério aplicado cedo, o padrão se repete em camadas diferentes do sistema, não só uma vez.
- **Decisão registrada, não implícita**: o comentário no módulo extraído (ou no utilitário mantido
  duplicado) deixa rastreável POR QUE aquela escolha específica foi feita — a próxima pessoa que
  encontrar o mesmo padrão não precisa redescobrir o raciocínio do zero.

## 9. Relação com outros princípios

- **`docs/DIRETRIZ_ARQUITETURA_2026-07-13.md`** (gate de Extensão antes de Criação): mesmo
  princípio de fundo aplicado em duas direções — não criar Tool/Skill/Script novo sem checar o que
  já existe; e, simetricamente, não criar módulo compartilhado novo sem um segundo uso real e sem
  confirmar que a extração não acopla módulos que deveriam ficar independentes.
- **`RESPONSABILIDADE_ANTES_DO_MECANISMO.md`**: também estrutura uma decisão em critérios
  explícitos antes do mecanismo (aqui: extrair vs. manter, antes de qualquer refatoração de
  código) — a ordem importa nos dois documentos.
- **`NUNCA_ADIVINHAR.md`**: os dois compartilham a mesma preocupação de fundo — evitar duas fontes
  divergentes de verdade sobre o mesmo fato (lá, entre "verificado" e "suposto"; aqui, entre duas
  cópias do mesmo conhecimento).

## 10. Checklist antes de extrair (ou de decidir não extrair)

- [ ] Teste 0: é conhecimento (regra/política/catálogo/contrato) ou implementação (formatação/CSS/
      helper local)? Se implementação e sem dúvida razoável, pode parar aqui — duplicação aceitável.
- [ ] Teste 1: pelo menos um dos seis sinais está presente (comportamento/regra de negócio
      compartilhados, divergência já observada, risco concreto de divergência, necessidade real de
      manutenção conjunta, ou representação do mesmo conhecimento) — ou é só semelhança textual?
- [ ] Teste 2: se for extrair, o módulo resultante é uma folha neutra, ou um dos dois lados vai
      importar o outro? A abstração reduz divergência sem criar acoplamento pior que o problema?
- [ ] Diferenças de comportamento reais entre os usos atuais foram preservadas fora do módulo
      extraído (Seção 6), em vez de forçadas a convergir?
- [ ] O comentário do módulo (extraído, ou mantido duplicado) registra o motivo da escolha, com o
      incidente/caso real que motivou, não só a regra abstrata?

### Checklist de revisão de PR (quando o diff introduz ou remove duplicação)

- [ ] Existe duplicação nova sendo introduzida, ou duplicação existente sendo removida?
- [ ] Se nova: passa no Teste 0 (é conhecimento, não só implementação)?
- [ ] Se é conhecimento: passa no Teste 1 (algum dos seis sinais, não só semelhança textual)?
- [ ] Se a resposta for extrair: o módulo criado é uma folha neutra (Teste 2), não um lado
      importando o outro?
- [ ] Existe evidência da necessidade (caso real, não hipotético) — ou é abstração antecipada?
- [ ] Nenhuma heurística de texto/regex nova decidindo algo semântico só para "unificar" dois
      comportamentos que na verdade são diferentes (ver `RESPONSABILIDADE_ANTES_DO_MECANISMO.md`).
