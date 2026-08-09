# NewClaw — Architecture Knowledge Base (AKB)

Sprint 01. Engenharia reversa completa do repositório, sem nenhuma alteração funcional de
código. Objetivo: uma base navegável, baseada em evidências, para servir de fundação às
próximas sprints (que devem **refinar/enriquecer esta base, não reconstruí-la**).

## Documentos normativos

Esta pasta guarda duas coisas distintas: os **documentos normativos** abaixo — regras vigentes,
leitura obrigatória antes de propor componente novo — e o **retrato do repositório** gerado pela
Sprint 01 (`index.html` + os três JSONs), descrito no resto deste arquivo. O retrato é um
instantâneo datado; as normas são vivas.

| Documento | Pergunta que responde |
|---|---|
| `EVIDENCE_PROVIDER_PATTERN.md` | *O que* um componente de conhecimento pode decidir (nunca decidir pelo Planner) |
| `SEPARACAO_DISTRIBUIDO_APRENDIDO.md` | *Onde* mora conhecimento versionado vs. aprendido em runtime |
| `NUNCA_ADIVINHAR.md` | O que fazer diante de dado ausente (reportar, nunca inferir) |
| `FERRAMENTAS_DE_ENTREGA.md` | O que uma ferramenta de entrega devolve (conteúdo, nunca recibo) |
| `PIPELINE_CURADORIA_DEPENDENCIAS.md` | Como conhecimento de instalação entra em `KNOWN_DEPS` |
| `SOBERANIA_DA_CONFIGURACAO.md` | *Quem* decide qual recurso usar, e o que o usuário fica sabendo |
| `LOCALIDADE_DA_RECUPERACAO.md` | *Em que camada* uma política de recuperação deve viver |
| `RESPONSABILIDADE_ANTES_DO_MECANISMO.md` | *Quem* deve tomar uma decisão de avaliação, *com qual evidência*, e só então *por qual mecanismo* (estrutura → determinismo; significado → LLM) |

Os penúltimos dois foram formalizados pela `docs/decisoes/RFC-005_POLITICAS_DE_SUBSTITUICAO_DE_RECURSOS.md`
(06/08/2026); o último, pela auditoria arquitetural de regressão de 09/08/2026. Todos são citados
por `docs/DIRETRIZ_ARQUITETURA_2026-07-13.md`.

## Como abrir

Abra `index.html` diretamente no navegador (duplo-clique ou `file://.../docs/architecture/index.html`).
Não precisa de servidor, build, ou conexão de rede — todo CSS/JS está embutido no próprio
arquivo, e os três JSONs (`architecture.json`, `dependency-graph.json`, `metrics.json`) estão
embutidos inline como `<script type="application/json">` (necessário: `fetch()` de arquivo local
via `file://` é bloqueado por CORS na maioria dos navegadores, então "sem servidor" exige dado
embutido, não arquivos separados carregados em runtime).

Verificado headless (Chrome `--headless=new --dump-dom`) nas rotas `#/dashboard`, `#/layer/*`,
`#/component/*`, `#/graph`, `#/diagrams` e `#/flows` — todas renderizam dado real computado a
partir do JSON embutido (ex.: os cards do dashboard mostram 397/233/135/203, que só aparecem se
o JavaScript executou corretamente), sem erros de console em nenhuma rota.

## Arquivos

| Arquivo | Conteúdo |
|---|---|
| `index.html` | Página única navegável: dashboard, nav lateral por camada, página por componente, grafo interativo, diagramas Mermaid (fonte), fluxos textuais. |
| `architecture.json` | Um objeto por componente (397 no total) — responsabilidade, tipo, camada, dependências, riscos, confiança. |
| `dependency-graph.json` | `{ nodes, edges }` — grafo de dependências completo. |
| `metrics.json` | Totais, fan-in/out, God Objects, órfãos, ciclos, acoplamento. |

## Metodologia (como isto foi gerado, e o que isso significa para a confiança dos dados)

1. **Grafo de dependências**: extraído automaticamente via **TypeScript Compiler API** (AST real,
   não regex) sobre os 397 arquivos `.ts`/`.js` em `src/`, `scripts/` e `skills/`. Para cada
   arquivo: imports (resolvidos para caminho real do repo, quando relativos), exports (classes,
   interfaces, funções, consts, enums, incluindo `extends`/`implements`), comentário de topo
   (JSDoc), e ocorrências de `TODO`/`FIXME`/`HACK`. Isso é **alta confiança por construção** — é
   parsing de sintaxe real, não inferência.
2. **Camada e tipo**: atribuídos por convenção de diretório/nome de arquivo (ex.: `src/memory/*`
   → camada Memory; `*Adapter.ts` → tipo `adapter`). Mecânico e determinístico, mas pode
   classificar errado um arquivo com nome atípico — daí a importância de cada componente expor seu
   `path` real para conferência.
3. **Responsabilidade, fluxos e riscos**: para os ~101 componentes mais centrais (maior
   fan-in+fan-out, candidatos a God Object, e um arquivo-chave por camada), **8 agentes
   especializados leram o código-fonte completo** (não apenas assinaturas) e escreveram
   responsabilidade/fluxos/riscos com `confidence: high`, sempre ancorados no que o código
   realmente faz — nunca no que o nome do arquivo sugere. Os demais ~296 arquivos (utilitários,
   arquivos de tipos, os 147 testes de regressão, tools de cauda longa) têm responsabilidade
   inferida apenas do caminho/exports, marcada `confidence: "low"` e com o texto
   `"(confidence: low) ... conteúdo não lido em profundidade nesta sprint"` — por design, para não
   inventar comportamento não verificado (ver `docs/ARCHITECTURE/NUNCA_ADIVINHAR.md`).
4. **Tipos de aresta**: `imports`/`extends`/`implements` vêm direto do AST (alta confiança, cobre
   os 397 arquivos). `creates`/`registers`/`calls` existem apenas para um punhado de arestas já
   verificadas por leitura de código (ex.: `AgentController.registerSkills()` chamando
   `ToolRegistry.register()` para cada tool — confirmado lendo o método, não assumido pelo nome).
   **Não existem arestas `uses`/`reads`/`writes`** no grafo: essas relações não são verificáveis
   estaticamente em escala (397 arquivos) sem risco de inventar uma relação não confirmada — foram
   omitidas em vez de adivinhadas.

## Por que Mermaid não é renderizado ao vivo

O prompt original pedia diagramas Mermaid e "não utilizar dependências externas". As duas coisas
juntas exigiriam embutir o bundle inteiro do mermaid.js (alguns MB minificados) dentro do HTML só
para desenhar ~10 diagramas estáticos — isso infla o arquivo, embute uma biblioteca de terceiros
não auditada, e ainda assim não cobriria o requisito real de interatividade (zoom/pan/seleção),
que já é resolvido separadamente pelo grafo SVG feito à mão. A escolha foi: fonte Mermaid legível
e copiável em `#/diagrams` (cole em qualquer renderizador Mermaid — extensão do VS Code,
`mermaid-cli`, etc.) **+** um grafo interativo real em SVG/JS vanilla (`#/graph`), que é o que de
fato cumpre "zoom, pan, seleção de nós, destacar dependências/consumidores, detalhes ao clicar".

## Por que o grafo interativo não mostra os 397 componentes de uma vez

Um grafo com 397 nós e 1142 arestas desenhado de uma vez é ilegível — vira uma bola de pelo, não
uma ferramenta de análise. `#/graph` mostra por padrão uma camada por vez (7 a 36 componentes,
sempre legível), ou a **vizinhança direta** (dependências + consumidores) de qualquer componente
buscado pelo nome — que é o caso de uso real das perguntas que a Sprint pede para responder
("o que quebra se eu mudar X?"). Ver a nota na própria página.

## Achados principais desta sprint

Números (ver `metrics.json` para as listas completas):

- **397 componentes** analisados (135 classes, 233 interfaces exportadas, 203 funções exportadas).
- **2 dependências circulares**: `DomainRegistry ↔ DomainSummaryService ↔ MemoryFacade ↔
  MemoryManager` (memória) e `WorkflowEngine ↔ ProactiveRecovery ↔ AgentLoop` (loop de agente).
- **65 componentes órfãos** (sem import de entrada/saída no grafo estático) — a maioria é
  esperada (entrypoints, arquivos `.js` do dashboard carregados via `<script src>`, scripts
  chamados por `exec_command`), mas vale conferir item a item em `metrics.json:orphanComponents`.
- **God Objects mais evidentes**: `GoalExecutionLoop.ts` (3954 linhas), `AgentLoop.ts` (3574
  linhas), `AgentController.ts` (67 imports de saída — o maior fan-out do repo).
- **Arquivos mais centrais**: `AppLogger.ts` (122 consumidores internos), `errors.ts` (60),
  `GoalTypes.ts`/`agentLoopTypes.ts` (definições de tipo compartilhadas por todo o `loop/`).

Riscos concretos encontrados pelos agentes de leitura profunda (cada um com arquivo/linha em
`architecture.json`, campo `risks` do componente correspondente):

- **`MemoryGovernor.resolveConflicts()`** (`src/memory/MemoryGovernor.ts:358-462`) decide sozinha
  qual de duas preferências conflitantes do usuário "vence" (arquiva/reduz confiança) por
  heurística de metadado, sem LLM e sem justificativa de segurança/conformidade nomeada — candidato
  a violação do princípio "Preservação do Raciocínio" (`docs/DIRETRIZ_ARQUITETURA_2026-07-13.md`).
- **`SessionLearner.ts`** ainda usa o padrão antigo `.replace(':', '_')` para IDs, o exato
  anti-padrão que `SessionKeyFactory` foi criado para eliminar (bug histórico documentado em
  memória do projeto).
- **`SignalAdapter.ts`**: comentário diz "não aguardamos isso" sobre `receive --timeout 3600`, mas
  o código aguarda; e o timeout de 30s do `execFile` sempre aborta antes dos 3600s — valor morto.
- **`DashboardServer.ts`**: `cors()` sem opções (default `Access-Control-Allow-Origin: *`) numa
  instalação nova sem senha ainda configurada.
- **`routes/config.ts`**: `persistConfigToEnv()` grava campos livres (`SYSTEM_PROMPT`) em `.env`
  via regex sem escape — um valor multi-linha shaped como `...\nKEY=value` pode corromper outras
  variáveis no próximo save.
- Todos os 6 provedores LLM implementam `ILLMProvider` (`src/core/providerTypes.ts`), mas
  `OpenAIProvider`/`DeepSeekProvider`/`GroqProvider` duplicam quase verbatim a mesma lógica de
  request OpenAI-compatible em vez de compartilhar uma implementação.

Nenhum desses itens foi corrigido nesta sprint (fora de escopo — "não realizar nenhuma alteração
funcional"). Registrados aqui e no `risks` de cada componente para as próximas sprints avaliarem.

## Fora de escopo desta sprint

`bin/` (launcher CLI), `prompts/*.yaml` (templates de prompt consumidos por `PromptRegistry`),
`addins/powerpoint-addin/` (sub-projeto separado do add-in do PowerPoint) e `specs/` não foram
analisados em profundidade — não apareceram na árvore `src/`/`scripts/`/`skills/` que o prompt
original delimitou como escopo do AKB. Se uma sprint futura precisar deles, tratar como extensão
desta base, não reconstrução.

## Nota sobre o nome da pasta

O prompt original pediu `docs/architecture/` (minúsculo). Este repositório já tinha
`docs/ARCHITECTURE/` (maiúsculo, com os documentos normativos citados em `CLAUDE.md` — três à
época desta sprint, sete hoje; ver "Documentos normativos" acima). No
Windows/NTFS (case-insensitive, case-preserving) os dois nomes apontam para a mesma pasta física,
e o Git deste repositório já rastreia o caminho em maiúsculo — por isso os arquivos desta sprint
foram gravados ali (`git status` confirma: `docs/ARCHITECTURE/architecture.json` etc.), e não em
uma pasta duplicada. Em um clone Linux (case-sensitive) isso permanece uma única pasta
`docs/ARCHITECTURE/` — nenhuma ação foi necessária, só o registro aqui para não ficar implícito.
