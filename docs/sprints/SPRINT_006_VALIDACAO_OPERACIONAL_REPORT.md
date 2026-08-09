# Sprint 006 — Validação Operacional em Ambiente Real

Data: 2026-07-26. Validação da Sprint 005 (consolidação de catálogos de ferramentas —
`docs/Auditorias/2026-07-26/AUDITORIA_CATALOGOS_FERRAMENTAS_2026-07-26.md`). Nenhuma alteração de código foi feita
nesta Sprint — apenas execução e observação, via skill `verify`, de uma instância isolada real
do NewClaw (LLM real via Ollama/`glm-5.2:cloud`, DB/workspace/porta separados do ambiente de
produção).

---

## 1. Casos executados

| Caso | Objetivo enviado | sessionId |
|---|---|---|
| 1 — dependência instalada | "Rode o comando 'unzip -v' e me diga a versão instalada." | verify-caso1 |
| 2 — dependência conhecida ausente | "Rode o comando 'tesseract --version' e me diga a versão instalada." | verify-caso2 |
| 3 — dependência aprendida | Inspeção read-only de `operational_knowledge` (sem novo goal) | — |
| 4 — sem dependências externas | "Quanto é 342 vezes 17, menos 58?" | verify-caso4 |
| 5 — fluxo completo | "Me envie a previsão do tempo em São Paulo em áudio." | verify-caso5 |

`unzip` e `tesseract` foram escolhidos por serem, respectivamente, uma dependência real e
genuinamente ausente na máquina de teste (Windows, confirmado por `command -v` antes dos testes)
— não hipotéticas.

---

## 2-4. Evidências, logs e resultado de cada validação

### Caso 1 — `unzip` (presente)

- `EnvironmentProbe`: `probe ok: available=[python3,node,npm,convert,pdftotext,git,curl,unzip,npx,bash]`
  — `unzip` corretamente listado como disponível (adicionado a `TOOLS_TO_PROBE` na Sprint 5.2).
- Planner gerou 1 step (`exec_command`) — plano de 1 step pula o Q2/`RiskAnalyzer` por desenho
  pré-existente (comentário em `RiskAnalyzer.ts`), então `KNOWN_SYSTEM_DEP_KEYS` não foi exercido
  aqui — comportamento esperado, não é lacuna.
- Execução: sucesso direto (`UnZip 6.00 of 20 April 2009...`), sem nenhuma mensagem falsa de
  "dependência ausente".
- **Resultado: PASSOU.** `success=true`, `cycles=2`, `replans=0`.

### Caso 2 — `tesseract` (ausente)

- `GoalEvaluator`: `dep='tesseract-ocr' missing and installable — outcome=needs_dependency` —
  classificação correta via `KNOWN_DEPS` (agora exportado, única fonte).
- `GoalStore`: blocker `kind=missing_tool tool=exec_command dep=tesseract` registrado.
- `resolveInstallCommand` / `GoalExecutionLoop`: **`needs_dependency: sem comando de instalação
  seguro para este SO (dep=tesseract-ocr) — caminho manual/AgentLoop`** — confirmação ao vivo da
  regra de segurança (`resolveInstallCommand.ts`): como `tesseract` só tem `installCmd` legado
  (`sudo apt install ...`, Linux) e nenhuma entrada `installByPlatform.windows`, o sistema
  **corretamente recusou** rodar o comando Linux num host Windows e caiu no caminho manual —
  nenhuma tentativa de instalação insegura ocorreu.
- Resposta final ao usuário: instrução manual (`sudo apt install tesseract-ocr tesseract-ocr-por -y`).
- **Resultado: PASSOU** quanto aos componentes da Sprint 005 (`GoalEvaluator`,
  `resolveInstallCommand`, `EnvironmentProbe` via probe anterior já cacheado sem `tesseract`
  disponível). **Achado colateral, não atribuível à Sprint 005** (ver seção 5).

### Caso 3 — `OperationalKnowledge` (dependência aprendida)

- Instância isolada nasce com DB vazio por desenho (novo `data/newclaw.db`) — conforme a própria
  Sprint instruiu ("não criar novos aprendizados"), nenhum goal foi usado para popular a tabela.
  Consulta read-only confirmou `operational_knowledge`: 0 linhas (schema presente e íntegro).
- Confirmado por `git diff --stat` que `src/memory/OperationalKnowledge.ts` e
  `src/loop/GoalPlanner.ts` (consumidor via `buildEvidenceHint()`) **não fazem parte do diff da
  Sprint 005** — nenhuma interferência estrutural possível.
- Tentativa de consulta read-only ao banco de **produção** (`<instalação de produção>/data/newclaw.db`)
  para checar entradas históricas reais foi bloqueada pelo classificador de permissões do Claude
  Code (acesso a dado fora do sandbox isolado) — respeitado, não contornado.
- **Resultado: PASSOU** (sem evidência de interferência; validação de entradas reais históricas
  não pôde ser completada por restrição de acesso a produção, registrado como limitação, não
  como falha).

### Caso 4 — sem dependências externas

- `342 * 17 - 58` → `5756` (correto). Fluxo direto via `exec_command`/`node -e`, sem nenhuma
  menção a `KNOWN_DEPS`/`TOOLS_TO_PROBE`/`RiskAnalyzer` nos logs — caminho completamente
  desacoplado dos catálogos, como esperado.
- **Resultado: PASSOU.**

### Caso 5 — fluxo completo ("previsão do tempo em áudio")

- `weather` executou com sucesso repetidas vezes (`421 chars`, dados reais de São Paulo).
- `GoalEvaluator`: `step=step_1 tool=send_audio blocker=missing_tool` → `dep='ffmpeg' missing and
  installable — outcome=needs_dependency` — mesma classificação correta via `KNOWN_DEPS`.
- `GoalExecutionLoop`: de novo, `needs_dependency: sem comando de instalação seguro para este SO
  (dep=ffmpeg) — caminho manual/AgentLoop` — mesma regra de segurança do Caso 2, funcionando
  identicamente para uma segunda dependência apt-only.
- O goal **falhou** (`success=false`, `cycles=12`, `replans=4`, `attempts=11`) — não por defeito
  dos catálogos, mas porque: (a) `ffmpeg` de fato não está instalado nesta máquina Windows; (b)
  `KNOWN_DEPS['ffmpeg']` não tem `installByPlatform.windows` (mesma lacuna pré-existente do
  Caso 2); (c) o LLM, em modo AgentLoop manual, tentou repetidamente comandos Linux-only
  (`apt-get install ffmpeg`) e, ao esgotarem as tentativas, decidiu "ignorar a dependência" e
  chamar `send_audio` mesmo assim — que voltou a falhar com `spawn ffmpeg ENOENT` até esgotar
  `MAX_CYCLES=12`.
- **Resultado: os componentes da Sprint 005 (`GoalEvaluator`, `resolveInstallCommand`,
  `EnvironmentProbe`) se comportaram exatamente como no Caso 2 — corretos e consistentes.** O
  goal em si não foi entregue, mas por uma causa fora do escopo da Sprint 005 (ver seção 5).

---

## 5. Comparação com o comportamento esperado / Divergências encontradas

Nenhuma divergência foi encontrada nos componentes que a Sprint 005 modificou
(`KNOWN_DEPS`/`GoalEvaluator.ts`, `KNOWN_SYSTEM_DEP_KEYS`/`RiskAnalyzer.ts`,
`TOOLS_TO_PROBE`/`EnvironmentProbe.ts`, teste `S154`). Em todos os 5 casos, esses componentes
produziram exatamente o comportamento esperado, incluindo o caso adversarial (Caso 5) onde duas
dependências (`ffmpeg`, via `send_audio`) precisaram ser classificadas e checadas quanto a
instalação segura por SO.

**Achado registrado, não corrigido nesta Sprint (conforme instrução explícita):**

- **Evidência**: Casos 2 e 5 — `KNOWN_DEPS['tesseract']` e `KNOWN_DEPS['ffmpeg']` têm apenas
  `installCmd` legado (`sudo apt install ... -y`, Linux) e nenhuma entrada `installByPlatform`
  para Windows/macOS — diferente de `marp`/`puppeteer`, que já têm `installByPlatform` completo
  para as 3 plataformas.
- **Causa provável**: lacuna de cobertura pré-existente em `KNOWN_DEPS` (`GoalEvaluator.ts`),
  não introduzida nem tocada pela Sprint 005 — confirmado por `git diff` (Sprint 005 só adicionou
  a palavra-chave `export` a `KNOWN_DEPS`, nenhum valor de `DependencyInfo` foi alterado).
- **Impacto**: em ambiente Windows sem esses binários, um goal que dependa deles (ex.: OCR via
  `read_document`, `send_audio` com pipeline que exige `ffmpeg`) recebe corretamente a
  informação "não instalável automaticamente aqui" (comportamento seguro, não incorreto) mas
  falha em entregar o resultado final — o usuário recebe uma instrução manual em formato
  apt/Linux, que não se aplica à própria máquina Windows onde está rodando. Consequência
  observada ao vivo no Caso 5: 4 replans, 11 attempts, `MAX_CYCLES` atingido, goal `failed`.
- **Componente responsável**: `KNOWN_DEPS` (`src/loop/GoalEvaluator.ts`) — faltam entradas
  `installByPlatform.windows`/`.macos` para `tesseract` e `ffmpeg` (e possivelmente outras
  entradas `type: 'system'` com apenas `installCmd`). Correção pertence a uma Sprint futura
  dedicada a cobertura cross-platform de `KNOWN_DEPS`, não a esta Sprint de validação nem à
  Sprint 005 (que tinha escopo explicitamente restrito a eliminar duplicação entre catálogos).
- **Achado secundário, mesmo componente responsável, fora do escopo de correção aqui**: quando
  não há `installByPlatform` para a plataforma atual, o `manualInstructions` devolvido ao usuário
  também é o texto apt-only (`GoalEvaluator.ts`) — não há uma instrução condicional por SO no
  texto manual, então um usuário Windows recebe um comando que não pode executar diretamente.

Nenhuma das duas causas acima é uma regressão da Sprint 005: reproduzido o mesmo padrão para
duas dependências diferentes (`tesseract` no Caso 2, `ffmpeg` no Caso 5), ambas pré-existentes,
ambas fora dos arquivos tocados pela Sprint 005.

---

## 6. Conclusão

**A Sprint 005 está apta para merge.** Todos os critérios de aceitação desta Sprint 006 foram
atendidos:

- ✅ Não houve regressão em relação ao comportamento anterior (validado nos 5 casos).
- ✅ Nenhum falso positivo novo apareceu no probe (`unzip` detectado corretamente disponível;
  `tesseract`/`ffmpeg` corretamente detectados ausentes).
- ✅ Nenhuma ferramenta deixou de ser detectada por causa da consolidação dos catálogos —
  `KNOWN_DEPS` (via `GoalEvaluator`) continuou resolvendo `tesseract` e `ffmpeg` corretamente
  mesmo depois de `RiskAnalyzer.ts` parar de manter sua própria cópia (`KNOWN_SYSTEM_DEPS`).
- ✅ `KNOWN_SYSTEM_DEPS` continua ausente do código (`grep` sem resultados).
- ✅ `TOOLS_TO_PROBE` permanece consistente com o teste `S154` (suíte de regressão roda limpa,
  150/154 — as 4 falhas são ambientais e pré-existentes, documentadas em sessão anterior).

**Bloqueador operacional identificado, não relacionado à Sprint 005**: cobertura Windows/macOS
incompleta em `KNOWN_DEPS` para `tesseract` e `ffmpeg` (ausência de `installByPlatform`), que
causou falha real de entrega no Caso 5. Recomenda-se abrir uma Sprint específica futura para
mapear todas as entradas `type: 'system'` de `KNOWN_DEPS` sem `installByPlatform` e decidir,
entrada por entrada, se existe um comando Windows/macOS seguro e validável para cada uma (mesmo
padrão já usado em `marp`/`puppeteer`) — fora do escopo desta Sprint de validação.
