# Investigação — Suplemento PowerPoint (testes de 2026-07-14)

Investigação forense dos problemas observados durante os testes do suplemento do PowerPoint,
conduzida segundo a Diretriz Permanente de Arquitetura (`docs/DIRETRIZ_ARQUITETURA_2026-07-13.md`).
Fontes: log de conversa do usuário, `newclaw-audit.log` do runtime de teste (referido aqui como
`<runtime>`), e código-fonte deste repositório. Nenhuma hipótese sem evidência de log ou de código.

---

## 1. Cronologia (conversa × audit log)

Sessão: `web:powerpoint-addin-<uuid>` (uma única sessão persistente do add-in, iniciada em 07/07).

| Quando | Evento | Evidência (audit log) |
|---|---|---|
| 07/07 10:11 | Usuário pede "aula passo a passo sobre DHCP…". Goal executa e entrega. | `message_received … channel=web userId=powerpoint-addin-…` |
| 07/07 23:46 | "consegue mudar o tema ?" — resposta via AgentLoop (sem goal). | `message_received consegue mudar o tema ?` |
| 08/07 00:55–01:00 | "consegue deixar os slides com fundo branco?", "o fundo esta com cor bege pastel queria branco!" | `message_received …` — o fundo bege é o tema `gaia` do Marp (ver §3.3) |
| 08/07 01:01 | "crie uma aula sobre o IPV4 e IPV6…" → goal falha. | `goal_1783483274477_kxlv0 source=goal_failure` |
| 08/07 01:07 | Usuário pede para **inserir** "Aula_IPv4_vs_IPv6.pptx" na apresentação; confirma com "sim". A inserção acontece no cliente (add-in), via `insertSlidesFromBase64`. | `message_received consegue deixar a aula ""Aula_IPv4_vs_IPv6.pptx" i…` |
| 09/07 21:30 | "Poderia criar slides sobre Segurança de redes…" → goal `ziomu` **usa Marp CLI (tema gaia)** e entrega `.pptx`. | `plan ok: … strategy="Criar slides … em Markdown Marp (tema gaia…) e converter para .pptx via Marp CLI"` |
| 14/07 20:02 | "Consegue melhorar a cores dos textos? … fundo escuro e texto escuro, queria fundo branco…" → goal `nxx12` planeja `list_workspace, memory_search, read, …` — **nunca considera powerpoint_control**. Falha após 5 replans (470 s). | `plan ok: steps=5 … tools=[list_workspace,memory_search,read,agentloop,send_document]` |
| 14/07 22:30 | Mesma mensagem reenviada → goal `1q551`, mesmo padrão, falha (509 s; blocker final: output de `pip install python-pptx` classificado como erro de caminho). | `blocker … desc="Caminho não encontrado ao executar 'exec_command': Defaulting to user installation … Requirement already satisfied: python-pptx"` |
| 14/07 23:02–23:07 | Perguntas rápidas ("Estou falando com você no powerpoint?…") respondidas em 1–4 s **pelo caminho AgentLoop** (que enxerga o contexto do suplemento). | `response_len=101/112/81 duration_ms≈1–4 s` |
| 14/07 23:08 | Usuário afirma explicitamente estar no PowerPoint com o arquivo aberto → goal `d65qd`: o planner **finalmente escolhe** `powerpoint_control` (3 steps) — e o step 1 falha com **"Ação 'undefined' não é suportada"**. Replaneja para python-pptx sobre o `.pptx` do workspace, recolore e envia; o add-in insere. | `blocker … desc="Erro em 'powerpoint_control': Erro: Ação 'undefined' não é suportada…"`; `REPLAN_DIFF prev_tools="powerpoint_control,powerpoint_control,powerpoint_control" new_tools="agentloop,exec_command,send_document"` |
| 14/07 23:10 | "Muito bem vi o arquivo inserido o problema é que ele não é editavel!…" → goal `n5xi0`: replans em cascata; um one-liner `python -c "from pptx import Presentation; p=Presentation('apresentacao.pptx')…"` explode (o arquivo tem **0 bytes** no workspace desde 02/07). Goal falha após 5 replans (237 s). | `Falha registrada: tool=exec_command … from pptx import Presentation; p=Presentation('apresentacao.pptx')`; listagens de workspace mostram `apresentacao.pptx (0B)` |

### Fluxograma da execução (goals de 14/07)

```text
Add-in (taskpane) ──POST /api/chat {message, sessionId, slideContext}──▶ chat.ts
    │                                                    metadata.hostApp='powerpoint'
    ▼                                                    metadata.slideContext={…}
MessageBus.processMessage(msg)  ── channelCtx.metadata = msg.metadata ──▶
    │
    ├──▶ GoalExtractor.classify(…)  → isGoal=true (heurística)
    │
    ▼
GoalOrchestrator.process(…, context)          ⚠️ context.metadata NUNCA é lido aqui
    │
    ▼
GoalExecutionLoop.executeGoal(goal, channelContext)   ⚠️ nem aqui (zero referências)
    │
    ├── contextualize() → q1Context = memória semântica + keyword   (sem hostApp)
    ├── GoalPlanner.plan(goal, q1Context, capSummary)               (sem hostApp)
    │       └── buildToolContracts(): schemas hardcoded p/ 10 tools ⚠️ powerpoint_control fora
    │
    ├── steps: list_workspace / read / exec_command …  ← planner "caça" arquivos no disco
    └── (23:08) steps powerpoint_control sem 'action' → "Ação 'undefined'" → replan p/ longe
```

O caminho **AgentLoop** (mensagens não-goal) injeta o contexto corretamente:
`AgentLoop.run → SessionContext.buildLLMMessages(…, channelContext.metadata)` →
bloco `[CONTEXTO DO POWERPOINT ABERTO]`. Por isso as perguntas rápidas de 23:02–23:07
foram respondidas com consciência do suplemento, enquanto todos os goals planejaram cegos.

---

## 2. Causas raiz

### RC1 — O contexto do suplemento morre antes do GoalPlanner (problemas 1 e 5)

- `dashboard/routes/chat.ts:120-129` captura `hostApp` + `slideContext` em `msg.metadata`. ✔
- `MessageBus.processMessageCore` (linha ~469) repassa em `channelCtx.metadata`. ✔
- `SessionContext.buildLLMMessages` (linhas 108–143) injeta o bloco no prompt — **só no caminho AgentLoop**. ✔
- `GoalOrchestrator.ts`: **zero** referências a `metadata` (grep). ✘
- `GoalExecutionLoop.ts`: **zero** referências a `metadata` (grep). ✘

Consequência: para qualquer mensagem classificada como goal (todas as tarefas reais do
usuário), o planner não sabe que existe uma apresentação aberta, qual é o arquivo, nem que
`powerpoint_control` é o caminho natural. Ele então:
1. procura arquivos no workspace (`list_workspace`, `read`) — problema 1;
2. escolhe pelo nome genérico o `apresentacao.pptx` de 0 bytes (lixo de 02/07) e executa
   `Presentation('apresentacao.pptx')` → traceback — problema 5.

### RC2 — O planner não conhece o schema de `powerpoint_control` (agrava o problema 1)

- `GoalPlanner.buildToolContracts()` (linhas 49–95) documenta schemas **hardcoded** de 10 tools;
  `powerpoint_control` não está entre elas.
- `buildToolDescriptions()` injeta apenas a primeira frase da `description` — sem parâmetros.
- A tool declara `parameters` completos (JSON schema com `enum` de `action`,
  `src/tools/powerpoint_control.ts:9-39`), mas **nenhum código do planner lê `tool.parameters`**.
- `detectMissingRequiredArgs()` (GoalPlanner.ts:491-548) valida args obrigatórios por lista
  hardcoded — `powerpoint_control` fora ⇒ o step sem `action` passou pela sanitização e
  explodiu na tool: `Ação 'undefined' não é suportada` (23:08:57). O blocker empurrou o
  replan para longe do PowerPoint, exatamente na única vez em que o planner acertou a tool.

Classe do bug: *toda tool nova registrada fica invisível/inválida para o planner até alguém
lembrar de editar dois pontos hardcoded* — mesma classe já vista com `edge-tts`/KNOWN_DEPS.

### RC3 — Slides não editáveis e cores erradas (problemas 2, 3 e 4)

- **Como a inserção acontece (problema 2)**: no cliente, via Office.js
  `presentation.insertSlidesFromBase64(data, { formatting: useDestinationTheme, targetSlideId })`
  (`addins/powerpoint-addin/src/taskpane/powerpoint.ts:255-285`). A inserção é **estrutural e
  correta** — insere slides de verdade, não imagem/HTML/PDF.
- **Por que não é editável (problema 3)**: o `.pptx` de origem foi gerado em 09/07 pelo
  **Marp CLI** (`plan ok: … "Markdown Marp (tema gaia…) e converter para .pptx via Marp CLI"`).
  O export pptx do Marp rasteriza cada slide em **uma imagem de fundo** — não há shapes de
  texto. `insertSlidesFromBase64` insere fielmente esses slides-imagem ⇒ nada é editável.
  (Limitação já documentada em `skills/pptx-generator/SKILL.md`, mas o planner escolheu Marp
  porque o pedido dizia só "slides", sem saber que o destino era inserção no PowerPoint.)
- **De onde vêm as cores (problema 4)**: do **CSS do tema Marp** escolhido no plano
  (`gaia` = fundo bege; variantes dark = fundo escuro). Depois de rasterizado, nenhum script
  python-pptx consegue recolorir (o texto está dentro do PNG) — por isso os goals de
  "melhorar cores"/"fundo branco" nunca surtiram efeito visível. O
  `formatting: useDestinationTheme` da inserção só afeta slides estruturais; sobre
  slides-imagem é inócuo.

### Achados laterais (registrados, fora do escopo desta correção)

- `apresentacao.pptx` com 0 bytes no workspace desde 02/07 — lixo que atraiu o planner
  (nome genérico). Limpeza é operação de runtime, não de código.
- Blockers com texto de chain-of-thought ("O script está correto agora. Vou executá-lo…")
  e output benigno de `pip install` classificado como "Caminho não encontrado" — sintomas
  do replan-storm; a eliminação do storm (RC1/RC2) reduz a exposição.
- `powerpoint_control` cobre apenas `addTextBox/getPresentation/getSlide` — não há ação de
  edição de cores/texto do deck aberto. Gap de capacidade documentado: o fluxo viável hoje é
  ler a estrutura (`getPresentation`/`getSlide`), regenerar um `.pptx` editável via
  python-pptx e entregar via `send_document` (o add-in insere).

---

## 3. Processo da diretriz (Fases 2–5)

**Fase 2 — Crítica.** A primeira hipótese ("adicionar um if de PowerPoint no GoalPlanner")
foi descartada: seria tratamento especial de um canal dentro do Core, duplicaria o texto do
hint já existente em `SessionContext` (segunda fonte de verdade) e não fecharia a classe
RC2. Também foi descartado corrigir só o `powerpoint_control` no hardcode de schemas
(pontual; a próxima tool registrada repetiria o bug).

**Fase 3 — Alternativas.**
- RC1: (a) injetar metadata no `goal.objective` — polui o GoalStore e mistura intenção do
  usuário com ambiente; (b) chamar `SessionContext.buildLLMMessages` do planner — acopla o
  planner ao subsistema de sessão inteiro; (c) **extrair a formatação do bloco de host para
  função pura compartilhada e injetá-la no contexto Q1 do planner** — fonte única, sem
  acoplamento novo, funciona para qualquer `hostApp` futuro (Word, Excel). Escolhida (c).
- RC2: (a) hardcode da linha do powerpoint_control — pontual, rejeitada; (b) tool-calling
  nativo no planner — mudança grande demais, outro risco; (c) **gerar as linhas de schema
  dinamicamente a partir de `tool.parameters` (JSON schema que toda tool já declara) e usar
  o mesmo schema como fallback genérico em `detectMissingRequiredArgs`** — elimina a classe.
  Escolhida (c).
- RC3: gate de canal dentro do pipeline pptx violaria a separação Core/canal por vocabulário;
  a informação determinística (`hostApp`) já viaja no metadata — a instrução "o .pptx será
  inserido na apresentação aberta ⇒ gere estrutural/editável (python-pptx), nunca Marp" entra
  no próprio bloco de host compartilhado (RC1), valendo para planner e AgentLoop de uma vez.

**Fase 4 — Síntese.** Correção em três movimentos, todos incrementais e reversíveis:
1. `src/shared/hostAppContext.ts` — `buildHostAppContextBlock(metadata)` (fonte única do
   bloco de host, com a orientação de editabilidade); `SessionContext` passa a usá-la.
2. `GoalExecutionLoop.contextualize()` ganha o `ChannelContext` e prepõe o bloco ao contexto
   do planner (plan, replan e roadmap ganham juntos).
3. `GoalPlanner`: schemas dinâmicos a partir de `tool.parameters` em `buildToolContracts()` +
   fallback genérico em `detectMissingRequiredArgs()` (required + enum), preservando os
   casos hardcoded existentes (semântica especial, ex.: alternativas do `edit`).

Riscos remanescentes: prompts do planner crescem alguns tokens por tool com schema declarado
(mitigado: só tools fora da lista já documentada); a instrução de editabilidade depende de o
LLM segui-la (mitigado: é o mesmo mecanismo de hint já validado no caminho AgentLoop).

**Fase 5 — Validação.** Baseado em evidência real (logs de 5 goals + código), resolve a causa
estrutural (contexto e contratos), elimina duas fontes de verdade (bloco de host duplicado no
teste S122; schemas duplicados entre tool e prompt), não cria God Object, é incremental e
reversível (3 arquivos de produção). Cross-platform e independente de idioma do usuário: o
sinal é `metadata.hostApp` (determinístico), nunca vocabulário.

## 4. Implementação

| Arquivo | Mudança |
|---|---|
| `src/shared/hostAppContext.ts` (novo) | `buildHostAppContextBlock(metadata)` — fonte única do bloco de host; hint orienta `powerpoint_control` (getPresentation/getSlide), proíbe caçar a apresentação aberta como arquivo e exige `.pptx` estrutural via python-pptx (nunca Marp), porque todo `.pptx` enviado é inserido no deck aberto. |
| `src/session/SessionContext.ts` | Bloco inline substituído pela função compartilhada (mesma formatação, zero mudança de comportamento no caminho AgentLoop). |
| `src/loop/GoalExecutionLoop.ts` | `executeGoal`/`planWithSpiral`/replan de marco derivam `hostContext` de `channelContext.metadata` e passam a `plan/replan/planRoadmap` como parâmetro dedicado. |
| `src/loop/GoalPlanner.ts` | (a) seção própria `AMBIENTE DA CONVERSA` (`buildHostContextSection`, budget de 2000 chars, fora do `enforceMemoryBudget` de 1600 que truncaria o bloco junto com a memória); preservada também no retry minimal (mesma classe do S121); (b) `buildDynamicSchemaLines()` — schema (required + enum) de QUALQUER tool registrada, gerado de `tool.parameters`, injetado em `buildToolContracts`; (c) `detectMissingRequiredArgs` ganhou fallback genérico required+enum dirigido pelo mesmo schema. |
| `docs/ARCHITECTURE.md` | Nova seção "Contexto de aplicativo hospedeiro (`metadata.hostApp`)". |
| Testes | `S123_PowerPointPlannerHostContext.test.ts` (novo, 27 asserções); `S122` refatorado para consumir a função real (antes duplicava a lógica copiada de SessionContext e validava a cópia, não o código). |

## 5. Relatório de testes (Validação Progressiva)

1. **Compilação TypeScript** — `npx tsc --noEmit`: limpa, zero erros.
2. **Testes unitários/regressão dirigidos** — S123: 27/27 ✅; S122: 19/19 ✅ (formatação
   idêntica + broker round-trip getPresentation/getSlide/unsupported).
3. **Suíte de regressão completa** — `npm run test:regression`: ver seção 7.
4. **Execução em ambiente real** — instância isolada (porta 3097, `data/`/`workspace/`/DB
   próprios, zerados), LLM real via Ollama local, add-in simulado por um poller HTTP real
   contra `/api/integrations/powerpoint/commands` (poll + ACK — o único componente simulado é
   o PowerPoint em si, impossível headless). Mensagem enviada: exatamente a que falhou em
   produção em 14/07 ("Consegue melhorar a cores dos textos?…"), com `slideContext` real.
   Observado ao vivo:
   - plano inicial (1º ciclo, sem replan): estratégia *"Recriar a apresentação utilizando
     python-pptx … mantendo a editabilidade"* — a orientação do bloco de host foi seguida;
   - `powerpoint_control` steps 1 e 2 (`getPresentation`, `getSlide`) despachados com args
     válidos e **outcome=success** com round-trip real pelo broker (~1,2 s cada; o poller
     ACKou os dois) — o erro "Ação 'undefined'" não ocorreu;
   - nenhuma tentativa de localizar a apresentação aberta no workspace; nenhum acesso a
     `apresentacao.pptx`;
   - artefato real gerado por python-pptx no workspace isolado:
     `aula_seguranca_redes_v2.pptx` (31 KB, estrutural/editável), com conteúdo derivado da
     leitura real dos slides via broker.
   - Observações ambientais (não relacionadas ao fix, registradas por honestidade): a
     instância isolada rodou com os modelos default (planner gemma4:31b-cloud, mais fraco que
     o glm-5.2 de produção) e o `exec_command` sofreu erro de path do Python específico do
     cwd temporário profundo da instância isolada — ambos pré-existentes e fora do escopo
     desta correção; o goal seguiu replanejando por causa deles.

## 6. Auditoria pós-implementação

- **Invariantes de canal preservadas**: nenhum adapter tocado; nenhuma importação nova entre
  `src/loop/**` e `*Adapter`; o sinal continua sendo `metadata` do `NormalizedMessage`
  (contrato já existente do MessageBus).
- **Sem solução pontual**: nada específico de PowerPoint fora do texto do hint (dados);
  o mecanismo (bloco de host + schemas dinâmicos + validação genérica) vale para qualquer
  hostApp e qualquer tool futura. Nenhum regex de vocabulário de usuário; sinal
  determinístico (`metadata.hostApp`), independente de idioma (pt/en/es) e de SO.
- **Sem hardcode de caminhos/dados pessoais**: revisado; docs usam `<runtime>`/placeholders.
- **Fontes de verdade reduzidas**: bloco de host 3→1 (SessionContext + cópia no S122 →
  `shared/hostAppContext.ts`); schema de tools 2→1 para tools novas (a tool declara,
  o planner consome).
- **Reversibilidade**: parâmetros novos são todos opcionais; remover o arquivo novo e os
  call sites restaura o comportamento anterior.

## 7. Resultado da suíte completa

`npm run test:regression` (gate S4.5 — passa/falha pelo exit code de cada subprocesso):
**119/119 arquivos OK, 0 falhas** (inclui S121, S122 refatorado e S123 novo). Execução limpa,
sem interferência externa.
