# RFC-007 — Resolução de Comando Multi-Candidato (quando "existe no PATH" não significa "funciona")

**Status:** PROPOSTA — aguardando revisão do usuário. Não implementado. Escrita seguindo a mesma
sequência da RFC-003 (documentação vira fonte de verdade antes de existir código), em resposta a
pedido explícito do usuário para generalizar o achado da issue 037.

**Autor:** Investigação assistida (Claude Code), campanha "sistema não utilizável", 22/09/2026.

**Tipo:** Arquitetura

**Categoria:** Resolução de ambiente / Runtime

---

# Resumo

Existem hoje, no NewClaw, **três implementações independentes e não-reaproveitadas** da mesma
pergunta: "este binário está presente no PATH E realmente funciona como esperado quando invocado —
ou é um nome que existe mas se comporta diferente do que o nome sugere?" Cada uma nasceu de um
incidente real, separado, e foi resolvida no local, sem generalizar.

Esta RFC propõe reconhecer essa pergunta como uma responsabilidade arquitetural explícita —
"resolução de comando", distinta tanto de "o binário existe?" (`ADR-008`) quanto de "a dependência
está instalada?" (`RFC-003`) — e consolidar as três implementações num único mecanismo reutilizável,
cujo resultado (não só um booleano, mas **qual nome específico funciona**) chega a quem gera o
comando (Planner, skills, `exec_command`), não só a quem decide se uma capability está disponível.

---

# Motivação

## Os três casos reais, em ordem cronológica

**1. `bash` no Windows (antes de 12/07/2026, `crossPlatform.ts:52-62`, `isBashFunctional()`).**
`where bash` encontra o launcher stub do WSL mesmo sem nenhuma distro instalada — `commandExists`
reporta presença, mas invocar falha com "WSL (10 - Relay) ERROR". Evidência real: o agente tentou
`bash scripts/html2pdf.sh` 4 vezes, sempre com esse erro, queimando um ciclo de replan inteiro antes
de trocar de estratégia. Corrigido com um probe de execução real bespoke, específico para `bash`.

**2. `python3`/`python`/`py -3` no Windows (RFC-003 Sprint C, `resolvePython3Runtime()`,
`crossPlatform.ts:264-291`).** Mesma classe de problema, mas resolvida de forma mais genérica desta
vez: uma lista de candidatos ordenada por plataforma (`defaultPython3Candidates()`), testados em
sequência via `probe()` injetável, parando no primeiro que realmente interpreta Python 3 (exit code
de um payload real, nunca parsing de texto). Essa função **já é estruturalmente genérica** —
`candidates: T[]` + `probe: (T) => Promise<boolean>` + short-circuit — só o payload de teste
(`import sys; ...`) e a lista de candidatos são específicos de Python.

**3. `python3` quebrado de novo, agora no caminho de execução (issue 037, hoje).** A causa raiz não
é ausência do resolver — é que ele só é consultado em UM lugar (`EnvironmentProbe.probe()`), e o
resultado é **colapsado para um booleano por nome**, perdendo qual candidato específico funcionou:

```ts
// EnvironmentProbe.ts:156-157
tools['python3'] = pythonRuntime !== null;
tools['python']  = pythonRuntime !== null;
```

Nesta máquina, `pythonRuntime.command === 'python'` (não `'python3'`) — mas `tools['python3']`
também vira `true`, porque o código só pergunta "Python 3 funciona de alguma forma?", nunca "com
qual nome?". O `CapabilityRegistry.getCapabilitySummary()` que chega ao Planner registra
"python3: disponível" — tecnicamente verdadeiro (Python 3 está disponível), mas enganoso para quem
vai ESCREVER `python3 script.py` literalmente, porque esse nome específico falha nesta máquina.

## Por que isso é um padrão, não três acidentes

As três implementações resolvem a MESMA pergunta ("qual nome, entre vários candidatos plausíveis,
realmente funciona aqui?") com formas diferentes de maturidade — de bespoke (`bash`) a
quase-genérica (`python3`) — e nenhuma delas expõe o resultado granular (o nome vencedor) para além
do ponto onde foi resolvida. É exatamente o padrão que
`docs/ARCHITECTURE/QUANDO_EXTRAIR_DUPLICACAO.md` qualifica como extraível: "pelo menos um sinal de
conhecimento compartilhado que pode divergir" (aqui, já divergiu — 3 formas diferentes da mesma
ideia) + "existe um módulo-folha neutro que os dois lados importam" (`crossPlatform.ts` já é esse
módulo, e já hospeda duas das três implementações).

**Evidência de que isso NÃO é um problema geral de "todo comando pode estar quebrado"**: rastreei
o `newclaw-audit.log` de produção (histórico completo, não só hoje) por padrões de erro de
`exec_command` — de ~30 padrões distintos, só os relacionados a `python3` (9 ocorrências) mostram
esse sintoma específico (nome presente, comportamento errado). Isso não enfraquece a proposta —
reforça que ela deve ser **um mecanismo genérico, mas aplicado deliberadamente só onde há candidatos
plausíveis conhecidos** (python, bash — a lista cresce por incidente real, nunca especulativamente),
não um probe universal em todo `exec_command`.

---

# Gate obrigatório — Extensão antes de Criação

Para cada arquivo/estrutura que este RFC poderia introduzir:

| Candidato | Precisa existir? | O que já existe | Decisão |
|---|---|---|---|
| Motor de resolução multi-candidato (candidates + probe, short-circuit) | **Não** | `resolvePython3Runtime()` já é essa função, só com nome/tipo específicos de Python (`Python3Runtime`) | Generalizar tipo e assinatura no lugar; sem novo arquivo |
| Probe de comando por execução real (não `which`/`where`) | **Não** | `runPython3Check()` (execFile, array de args, decide por exit code) já é o padrão certo | Reaproveitar a forma, parametrizar o payload/args |
| `isBashFunctional()` | Não precisa mudar de lugar | Já existe, já correto | Pode virar uma chamada fina ao motor generalizado (não obrigatório — ver "Alternativas") |
| Exposição do nome resolvido ao Planner (não só booleano) | **Não, é extensão de dado existente** | `CapabilityRegistry.getCapabilitySummary()` já entrega texto ao Planner; `EnvironmentProbe.probe()` já calcula `pythonRuntime.command` — só não repassa | Adicionar o campo ao objeto que já existe |
| Tool/Skill/Script novo | **Não** | Nada disso é necessário — é lógica interna de `crossPlatform.ts`/`EnvironmentProbe.ts`, nunca exposta como capability separada | — |

**Nenhum arquivo novo em `src/tools/`, `skills/` ou `scripts/`.** Toda a mudança é extensão de
`src/utils/crossPlatform.ts` (onde o motor já mora) e `src/core/EnvironmentProbe.ts` (onde ele já é
consumido) — e, no consumidor final, do texto que chega ao ponto que gera/executa comandos.

---

# Alternativas consideradas

### A — Deixar cada caso bespoke (não fazer nada, corrigir só a issue 037 pontualmente)

Resolve o sintoma de hoje (expor `pythonRuntime.command` para o Planner). Não resolve a causa: a
próxima vez que um candidato alternativo divergir (ex.: uma distro Linux onde `python` é Python 2 e
só `python3` é Python 3 — o inverso exato do caso Windows), alguém vai reimplementar o mesmo padrão
pela quarta vez. Rejeitada como solução única — mas é o **subconjunto mínimo obrigatório** de
qualquer alternativa escolhida (sem ele, a issue 037 não fecha).

### B — Generalizar `resolvePython3Runtime` só para Python (não para `bash`/futuros casos)

Menos invasivo que C, mas deixa `isBashFunctional()` como está (funciona, não é urgente) e não cria
o "módulo-folha neutro" para o próximo caso. Acomoda a issue 037 sozinha. Fraqueza:
`QUANDO_EXTRAIR_DUPLICACAO.md` já mostra 2 instâncias reais e divergentes — o padrão é típico o
bastante para não valer a pena resolver de novo isoladamente.

### C — Motor genérico único em `crossPlatform.ts`, todos os casos existentes migram para ele

`resolveWorkingCommand<T>(candidates: T[], probe: (T) => Promise<boolean>): Promise<T | null>` —
literalmente a assinatura que `resolvePython3Runtime` já tem, só sem o nome/tipo amarrados a
Python. `resolvePython3Runtime()` e `isBashFunctional()` viram wrappers finos sobre ele (mesmo
padrão que `probeCommand()`/`commandExists()` já demonstram no arquivo: uma função central,
wrappers específicos por cima). **Escolhida.**

### D — Além do motor, um catálogo declarativo de "candidatos conhecidos por capability" (`python`, `bash`, futuros)

Reaproveita a ideia de `KNOWN_DEPS` (catálogo curado, versionado em código) mas para NOMES de
comando em vez de comandos de instalação — ex.: `KNOWN_COMMAND_ALIASES = { python: [...],
bash: [...] }`. **Descartada nesta RFC, registrada como extensão futura, não decidida agora**: o
gate "Extensão antes de Criação" já é satisfeito sem ela (2 entradas — python, bash — não
justificam um catálogo novo ainda; `defaultPython3Candidates()` já cumpre esse papel para Python
sozinho). Se um terceiro caso real aparecer, revisitar.

---

# Decisão proposta

1. **Generalizar o motor em `crossPlatform.ts`.** Renomear/generalizar
   `Python3Runtime`/`resolvePython3Runtime` para um tipo e função genéricos (`CommandCandidate` =
   `{command: string, argsPrefix: string[]}`, `resolveWorkingCommand<T>(candidates, probe)`).
   `resolvePython3Runtime(candidates)` continua existindo como uma chamada fina (compatibilidade
   com os 2 call sites atuais, sem quebrar `S34`).

2. **`EnvironmentProbe.probe()` para de colapsar o nome vencedor num booleano por nome.** Em vez de
   `tools['python3'] = tools['python'] = pythonRuntime !== null`, o objeto de capabilities passa a
   carregar também **qual nome específico funciona** (ex.: `resolvedCommands: { python: 'python' }`
   — chave é a "família", valor é o nome real a usar). `CapabilityRegistry.getCapabilitySummary()`
   passa essa informação ao Planner como fato ("Python 3 disponível como `python` — NÃO use
   `python3`, esse nome falha nesta máquina"), nunca como decisão — Evidence Provider Pattern
   (`EVIDENCE_PROVIDER_PATTERN.md`), mesmo padrão que toda a seção "Indisponíveis" já segue hoje.

3. **`isBashFunctional()` opcionalmente migra para o motor genérico** (candidato único `bash`, probe
   `execFile('bash', ['-c','exit 0'])`) — comportamento observável idêntico, só reaproveitando o
   short-circuit em vez de reimplementá-lo. Não obrigatório para fechar a issue 037; incluído aqui
   porque é o teste real de que a generalização não é só para Python.

4. **Escopo explicitamente fora desta RFC**: ensinar o sistema a DESCOBRIR novos candidatos
   sozinho (isso seria juntar-se ao ciclo de Pesquisa da RFC-003 — categoricamente diferente:
   RFC-003 aprende comandos de *instalação* para dependências *ausentes*; esta RFC resolve o nome
   certo para uma capability *já presente*). Se o padrão se mostrar recorrente o bastante para
   justificar aprendizado automático de candidatos, é um RFC novo, não uma extensão desta.

---

# Fronteira entre determinismo e julgamento do Planner

Aplicando `RESPONSABILIDADE_ANTES_DO_MECANISMO.md`:

- **PERGUNTA:** "este nome de comando, invocado nesta máquina agora, produz o comportamento
  esperado?" — checagem por exit code de um payload real (`import sys; raise SystemExit(...)`,
  `exit 0`). Propriedade objetiva, verificável por execução — não interpretação de linguagem.
- **RESPONSÁVEL:** o motor de resolução (determinismo) — mesma categoria que `probeCommand()` já
  ocupa hoje (`ADR-008`: "este exitCode é 0?").
- **EVIDÊNCIA:** o próprio subprocesso, síncrono à checagem — não há adivinhação de plataforma
  (`crossPlatform.ts` já proíbe isso na sua filosofia de implementação, linha 1-30 do arquivo).
- **AUTORIDADE:** determinismo decide "qual nome funciona" (estrutural). NÃO decide "o que o
  Planner deve fazer com essa informação" — isso seria violar o Princípio da Preservação do
  Raciocínio (DIRETRIZ_ARQUITETURA). O resultado vira texto/fato no prompt, nunca uma reescrita
  automática e silenciosa do comando que o LLM gerou.
- **ESTADO:** um mapa `{família: nome_resolvido}` — não um booleano, não uma string de erro.
- **CONSUMIDOR:** `CapabilityRegistry`/`PromptComposer` (texto pro Planner) e, opcionalmente,
  `EnvironmentProbe`'s already-existing "Indisponíveis" pattern.

**Decisão deliberada que fica registrada aqui**: esta RFC NÃO propõe reescrever automaticamente
`python3` → `python` dentro do comando que o LLM já escreveu (isso seria um determinismo decidindo
por semântica de comando shell arbitrário — risco real de reescrever algo que não devia, ex. um
argumento que contém a substring "python3" por acaso). A informação vai como **fato no prompt antes
do plano ser gerado** (mesmo padrão que já funciona hoje para "Indisponíveis: X, Y, Z") — o Planner
decide o que escrever, com o fato correto disponível. Se, mesmo assim, o LLM escrever `python3` e
falhar, o comportamento de replan já existente continua sendo a rede de segurança.

---

# Validação exigida (Validação Progressiva)

1. **Unitário**: `resolveWorkingCommand<T>` genérico com probe fake — mesmos 10 casos que `S34` já
   cobre para `resolvePython3Runtime`, generalizados; controle negativo (nenhum candidato funciona
   → `null`).
2. **Regressão**: `S34` (Python3RuntimeResolution) continua passando sem alteração de comportamento
   observável — a generalização não pode mudar o resultado de `defaultPython3Candidates()` em
   nenhuma plataforma. Novo teste cobrindo o caso real: candidatos onde só um nome entre vários
   funciona, e o `CapabilityRegistry`/texto de summary reflete o nome certo, não um booleano cego.
3. **E2E sintético**: `EnvironmentProbe.probe()` com `execFile` mockado simulando exatamente o
   cenário desta máquina (`py` ausente, `python` funciona, `python3` falha) — confirma que o texto
   de capabilities final menciona `python`, nunca afirma `python3` como seguro.
4. **Execução real** (obrigatória antes de fechar): reproduzir o MESMO pedido de PPTX desta
   investigação (`goal` real, LLM real, esta máquina Windows) e confirmar que o plano gerado usa
   `python` (ou não usa Python nenhum, se o Planner preferir `pptxgenjs`) — sem cair no erro do
   alias da Microsoft Store.

---

# Limites conhecidos / débitos explicitamente não resolvidos aqui

- **Não cobre o caso inverso** (um nome que funciona só às vezes, ou que resolve para uma versão
  errada sem falhar — ex. `python` apontando para Python 2 num Linux antigo). O probe atual decide
  por `sys.version_info[0] == 3`, o que já cobre esse sub-caso especificamente para Python — mas o
  motor genérico não impõe isso a outros candidatos; cada `probe()` continua sendo responsabilidade
  de quem o define.
- **Não decide se isso deveria alimentar `OperationalKnowledge`** (RFC-003, camada Aprendida) para
  não reprovar a cada boot. Hoje `EnvironmentProbe.probe()` já roda uma vez por boot e o resultado
  vive pelo tempo de vida do processo — suficiente para o problema evidenciado. Fica como pergunta
  aberta para uma RFC futura, não decidida aqui.
- **O bug do `cd workspace` duplicado** (achado na mesma investigação, 3 ocorrências reais no
  audit.log) é uma causa raiz DIFERENTE (assunção de diretório errada em prompt/skill, não
  resolução de nome de comando) — fora do escopo desta RFC, candidato a issue própria.

---

# Relacionado
- `docs/issues/037-exec-command-python3-cru-nao-usa-resolver-cross-platform.md`
- `docs/decisoes/RFC-003_AQUISICAO_CONHECIMENTO_OPERACIONAL.md` (categoricamente diferente: instala
  quando ausente, não resolve nome quando presente-mas-errado)
- `docs/decisoes/ADR-008_CONTRATO_DA_SONDAGEM_DE_BINARIO.md` (categoricamente diferente: existência,
  não comportamento)
- `docs/ARCHITECTURE/QUANDO_EXTRAIR_DUPLICACAO.md`
- `docs/ARCHITECTURE/RESPONSABILIDADE_ANTES_DO_MECANISMO.md`
- `src/utils/crossPlatform.ts` (`resolvePython3Runtime`, `isBashFunctional`, `probeCommand`)
- `src/core/EnvironmentProbe.ts:148-157`
- `src/__tests__/regression/S34_Python3RuntimeResolution.test.ts`
