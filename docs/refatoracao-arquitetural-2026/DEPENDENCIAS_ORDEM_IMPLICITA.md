# Dependências de Ordem Implícita — Catálogo

**Data:** 2026-07-17. **Motivo:** durante a Sprint `2026-08-S12` (ARCH-023, `exec_command.ts`),
a decisão de NÃO consolidar os fixups num loop único (preservar os pontos de chamada exatos)
foi tomada porque um comentário no código avisava que a ordem entre um gate de validação e um
fixup importava. O usuário pediu para isso virar prática permanente: sempre que uma Sprint
encontrar lógica cujo comportamento correto depende de UMA ORDEM DE EXECUÇÃO ou DE DADOS que só
está documentada num comentário solto (não reforçada por tipo, estrutura ou teste), documentar
aqui — porque esse é exatamente o tipo de coisa que um refactor bem-intencionado (humano ou LLM)
quebra sem perceber.

Este documento é **cumulativo**, como `RETROSPECTIVA_PREMISSAS_AUDITORIA.md` (que
cataloga um problema relacionado, mas diferente: premissas de auditoria que descrevem O QUE o
código faz incorretamente; este cataloga COMO uma sequência específica de execução/dados é
exigida para o código funcionar direito).

## Catálogo

### 1. `GoalEvaluator.ts` — `ERROR_PATTERNS`, padrão de ENOENT de arquivo antes de "tool ausente"
- **Onde:** `src/loop/GoalEvaluator.ts`, array `ERROR_PATTERNS` (índice 0 vs. índice 1).
- **Por que a ordem importa:** `findMatchedPattern()` itera o array e retorna o PRIMEIRO padrão
  que casar. Uma mensagem como `"ENOENT: no such file or directory, open 'input.mp3'"` contém a
  substring `ENOENT`, que também apareceria no padrão genérico de "ferramenta não encontrada"
  (índice 1, que inclui `ENOENT` bare na alternação). Se o padrão específico de ENOENT-de-arquivo
  (índice 0) não viesse primeiro, TODO erro de arquivo/diretório ausente seria misclassificado
  como "executável ausente".
- **O que impede reordenar por engano:** só o comentário (linhas 74-80). Nenhum teste de
  regressão prende explicitamente a ORDEM do array (testes existentes verificam o resultado da
  classificação para casos individuais, não a posição relativa das entradas).
- **Status:** verificado em 17/07/2026 (durante a Sprint `S12`) — ordem intacta. A Sprint `S04`
  (ARCH-014, mesma sessão) editou o CONTEÚDO de 3 entradas mais abaixo no mesmo array
  (rede/timeout/rate-limit) sem tocar a posição relativa dessas duas — confirmado por não usar
  reordenação, só troca de `pattern:` via edição pontual.

### 2. `planning/extractMissingExecutable.ts` — mesma classe de risco, já consolidada
- **Onde:** `src/loop/planning/extractMissingExecutable.ts`, `FS_ENOENT_PATTERN` checado antes
  de qualquer padrão de executável ausente (mesmo raciocínio do item 1 — é o mesmo bug de
  classificação, numa função diferente, já extraída/consolidada por uma auditoria anterior à
  deste programa).
- **Por que a ordem importa:** idêntico ao item 1 — sem essa ordem, `ENOENT` bare de operação de
  arquivo seria confundido com processo/binário ausente.
- **O que impede reordenar por engano:** só o comentário (linhas 22-27).

### 3. `RiskAnalyzer.ts` — resolução de `file_path` antes de CR#3 (rejeição por args faltando)
- **Onde:** `src/loop/RiskAnalyzer.ts`, linha ~594-602.
- **Por que a ordem importa:** resolver `file_path` de `send_document` precisa acontecer ANTES de
  contar quantos tool-steps têm argumentos obrigatórios faltando (CR#3). Rodar na ordem inversa
  rejeitava de cara qualquer replan de 1 step só ("reenviar o que já existe" — só `send_document`,
  sem `write` no mesmo lote): 1 tool-step, 1 "inválido" (porque `file_path` ainda não tinha sido
  resolvido), 100% > 50%, plano rejeitado antes mesmo de tentar resolver o path.
- **Histórico real:** o comentário confirma que essa JÁ FOI a ordem original, e JÁ CAUSOU esse
  bug — corrigido na Sprint R5-R7 (`docs/REVISAO_ARQUITETURAL_SPRINT_R7_2026-07-13.md`). Não é
  hipotético, é um bug real de produção que uma reordenação silenciosa reintroduziria.
- **O que impede reordenar por engano:** só o comentário.

### 4. `SkillDiscovery.ts` — stemming PT-BR, sufixo específico antes de sufixo genérico
- **Onde:** `src/skills/SkillDiscovery.ts`, linha ~53-61 (cadeia de `.replace()`).
- **Por que a ordem importa:** sufixos que se sobrepõem (`-ções` termina em `-ões`) precisam ser
  tratados do mais específico pro mais genérico — `coes$` antes de `oes$`, senão o primeiro
  `.replace()` já consome o sufixo mais genérico e o mais específico nunca dispara.
- **Severidade:** menor que os itens 1-3 (afeta ranking de matching de skill por similaridade de
  texto, não correção binária sucesso/falha) — incluído por completude, mesmo padrão de risco.

### 5. `exec_command.ts` — gates de validação e fixups (achado durante a própria Sprint `S12`)
- **Onde:** `src/tools/exec_command.ts`, `execute()`.
- **5a. `isMarpWithoutInputFile` antes de `isMarpWithoutNoStdin`:** comentário original em
  `isMarpWithoutNoStdin` (linha ~230, antes da Sprint): "Deve ser verificado APÓS
  isMarpWithoutInputFile (que cobre o caso mais grave)". Analisado durante o `ARCH-023`: na
  prática, os dois predicados são mutuamente exclusivos na precondição (`addMarpNoStdin` só
  transforma quando existe um token `.md`/`.marp`, exatamente a mesma condição que faria
  `isMarpWithoutInputFile` ser `false`) — reordenar não mudaria o resultado observável neste caso
  específico, mas o comentário original claramente expressava intenção de ordem, então o
  refactor da Sprint preservou a posição relativa exata mesmo assim (ver decisão de design no
  card `ARCH-023`, `MASTER_EXECUTION_PLAN.md`).
- **5b. `wrap_powershell` precisa ser o ÚLTIMO fixup, depois de `isSearchCommand` ser calculado:**
  esta SIM tem impacto real comprovado — `isSearchCommand` testa se o comando começa com
  `grep`/`rg`/`find` para tratar exit code 1 como "sem resultados" (não erro). Se
  `wrap_powershell` rodasse antes, o comando já estaria embrulhado em PowerShell/Base64 quando
  `isSearchCommand` o inspecionasse, nunca mais reconhecendo os binários originais — quebrando
  essa distinção especificamente em comandos de busca no Windows.
- **O que mudou:** a Sprint `S12` NÃO consolidou os 4 fixups num loop único justamente por causa
  do item 5b — os `applyFixup()` continuam nos mesmos 4 pontos textuais exatos que os `if`s
  antigos ocupavam. A "estrutura de dados explícita" pedida pelo card ARCH-023 é a DEFINIÇÃO de
  cada step (nome/condição/transformação), não necessariamente a ORDEM DE EXECUÇÃO, que continua
  garantida pela posição do `applyFixup()` no código-fonte de `execute()` — mesmo mecanismo de
  antes (posição textual), só sem a lógica duplicada de log/transform.

## Síntese — por que isso continua acontecendo

Em nenhum dos 5 casos a ordem correta é reforçada por tipo, estrutura de dados ou teste dedicado
— só por um comentário. Isso significa que:
1. Um refactor (humano ou LLM) que não lê os comentários com atenção pode reordenar sem que
   `tsc`, o linter, ou a suíte de regressão acusem nada — a menos que exista um teste que cubra
   especificamente o CASO que a ordem errada quebraria (nem sempre existe: os itens 1, 2 e 4
   deste catálogo não têm teste dedicado a essa ordem específica).
2. O item 3 (`RiskAnalyzer.ts`) prova que isso não é hipotético — já aconteceu, gerou um bug real
   de produção, e só foi corrigido quando alguém teve que investigar por quê replans de 1 step
   "reenviar arquivo" estavam falhando.

**Não é recomendação deste documento reestruturar os 5 casos agora** (fora do escopo de
qualquer Sprint atual, seria "correção pontual" pela política *No Opportunistic Refactoring*) —
é um catálogo para consulta rápida antes de mexer em qualquer um desses arquivos no futuro, e um
lembrete de que "ordem importa, só documentado em comentário" é um padrão real e recorrente
neste código, não um caso isolado.

## Ação — o que muda no processo a partir de agora

Adicionado à Checklist de Execução — padrão (`MASTER_EXECUTION_PLAN.md`): ao tocar em
qualquer trecho de código com um comentário do tipo "roda antes/depois de", "ordem importa",
"precisa ser checado antes/depois" — tratar isso como um invariante a preservar explicitamente
(não só evitar quebrar por acidente, mas registrar aqui se for uma instância nova encontrada
numa Sprint futura).
