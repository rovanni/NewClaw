# RFC ARCH-015 — Gerar validação + texto de prompt de args obrigatórios a partir do schema da tool

**Sprint:** 2026-09-S20. **Status:** Documento de Fase 1-5 completo, per `DIRETRIZ_ARQUITETURA_2026-07-13.md`. **Sem código nesta Sprint** — decisão de implementar (parcialmente) registrada abaixo.

## Card original (`ARCHITECTURAL_BACKLOG.md`)

> "Quais argumentos são obrigatórios" é declarado em 5 lugares independentes: `parameters.required` de cada tool, `detectMissingRequiredArgs()` (hardcoded), o guard interno de cada `execute()`, `buildToolContracts()` e os blocos de prompt do Planner. Gerar validação + texto de prompt a partir do schema elimina a sincronização manual.

---

## Fase 1 — Compreensão

### Os 4-5 lugares, lidos linha a linha (`GoalPlanner.ts` + amostra de `src/tools/*.ts`)

1. **`parameters.required: string[]`** — schema de cada tool (`weather.ts`, `web_navigate.ts`, `memory_write.ts` lidos como amostra). Formato JSON-Schema-ish (`type`, `properties`, `required`), mas o tipo TypeScript do campo é `Record<string, unknown>` (`agentLoopTypes.ts`, `ToolExecutor.parameters`) — sem contrato de compilação, só convenção.
2. **`detectMissingRequiredArgs()`** (`GoalPlanner.ts:559-616`) — `if` por tool, chamado como pre-flight ANTES do dispatch real.
3. **Guard interno de cada `execute()`** — validação em runtime, dentro da própria tool.
4. **`buildToolContracts()`** (`GoalPlanner.ts:49-96`) — bloco de prompt com schemas + avisos `⚠️`, 100% texto hand-written.
5. **`buildRequiredArgsReference()`** (`GoalPlanner.ts:237-250`) — segundo bloco de prompt, também 100% hand-written, fonte única desde ARCH-025 (S06) mas ainda um texto solto, não gerado de nada.

### Achado 1 — os 4-5 lugares nem cobrem o mesmo conjunto de tools

`memory_write` tem `parameters.required: ['action']` (1) e um guard real dentro de `execute()` (3) — mas **não aparece em `detectMissingRequiredArgs()` (2) nenhuma vez**, confirmado por grep completo da função. O texto do prompt (`buildToolContracts()`, linha 86) afirma "memory_write SEM action... será bloqueado automaticamente pelo sistema" — verdade, mas só na camada 3 (a própria tool rejeita em runtime), não na 2 (pre-flight do Planner, que É o mecanismo que intercepta ANTES do dispatch para os outros ~9 tools cobertos). Achado por si só não é um bug confirmado (a tool acaba rejeitando de qualquer forma), mas prova que os "5 lugares" já divergem em COBERTURA, não só em manutenção — uma unificação real precisa decidir isso também, não só "gerar texto".

### Achado 2 — a lógica de "obrigatório" não é uniformemente um `required: string[]` plano

`web_navigate` (`web_navigate.ts`) tem `parameters.required: ['action']` — só isso. Mas dentro de `execute()` e dentro de `detectMissingRequiredArgs()`, EXISTE lógica condicional real, replicada independentemente nos dois lugares: `action==='search'` exige `query`; `action==='open'` exige `url`; `action==='follow_link'` exige `url`+`link_text`. Mesmo padrão em `crypto_analysis` (`type==='detail'` exige `symbol`, com validação extra de que `symbol` não contenha múltiplas moedas). `edit` tem uma terceira forma de não-trivialidade: "obrigatório" não é uma lista de campos, é "uma de 3 combinações válidas" (`oldText+newText` OU `startLine+endLine+content` OU `append+content`).

**Isso não é modelável por um `required: string[]` plano.** Um `required: [...]` só expressa "campo X sempre obrigatório, incondicionalmente" — não expressa "obrigatório SE outro campo tiver valor Y" nem "um de N grupos válidos". Gerar `detectMissingRequiredArgs()` inteiro a partir de `parameters.required` de forma ingênua **perderia** essa lógica condicional para pelo menos 3 tools (`web_navigate`, `crypto_analysis`, `edit`) — uma REGRESSÃO de validação, não uma simplificação, a menos que o formato do schema em si seja estendido para um dialeto condicional (ex.: `if`/`then`/`oneOf` do JSON Schema real) — um trabalho de modelagem bem maior do que "Risco: Médio" (estimativa do card) sugere, e que precisaria ser feito tool a tool, sem garantia de que a lógica condicional de cada uma se encaixe limpamente no dialeto escolhido.

### Achado 3 — evidência real de que a duplicação do TEXTO DE PROMPT já causou drift (diferente da validação)

`ARCH-025` (S06, já concluído) achou que os dois blocos de prompt (`buildRequiredArgsReference` no plano inicial vs. replan) tinham divergido de fato — o bloco de replan listava só 3 dos 5 tipos de nó de `memory_write`. Essa é evidência REAL de bug de manutenção causado pela fragmentação do TEXTO — diferente da fragmentação da VALIDAÇÃO (`detectMissingRequiredArgs`), que não tem nenhum incidente real documentado até hoje.

---

## Fase 2 — Crítica da hipótese

1. **Gerar a VALIDAÇÃO (`detectMissingRequiredArgs`) inteira a partir do schema tem risco real de regressão silenciosa** — para os tools com lógica condicional (`web_navigate`, `crypto_analysis`, `edit`), uma migração ingênua perderia checks que hoje existem, sem que `tsc`/testes de tipo acusem nada (a lógica perdida é semântica, não estrutural).
2. **O "Risco: Médio" do card subestima o problema real** — o gargalo não é "schema pouco tipado" de forma genérica, é especificamente a ausência de um dialeto condicional no formato de schema usado hoje. Resolver isso de verdade exige desenhar esse dialeto primeiro (fora do escopo desta RFC — seria a sua própria RFC).
3. **Gerar o TEXTO DE PROMPT a partir do schema tem risco muito menor** — mas só se o "schema" usado pra gerar o texto for mais rico que `parameters.required` sozinho (precisa de uma descrição textual por campo, guidance de UX como "use uma chamada de crypto_analysis por moeda", que hoje só existe como prosa solta em `buildRequiredArgsReference()`). Gerar a partir de `required: string[]` puro produziria um texto mecânico e pior que o atual (perderia toda a orientação de UX hoje presente).
4. Não há incidente de produção documentado motivando a VALIDAÇÃO duplicada (diferente de ARCH-005/ARCH-018, que tinham bug real confirmado) — só o TEXTO DE PROMPT tem um incidente real confirmado (S06/ARCH-025). Isso muda a urgência relativa das duas metades do card.

---

## Fase 3 — Pesquisa de alternativas

| Alternativa | Escopo | Risco | Evidência de valor real |
|---|---|---|---|
| **A — Codegen completo (validação + prompt) a partir de schema estendido** | Redesenhar o dialeto de `parameters` (suportar condicionais), migrar ~9+ tools, regenerar os 4 lugares | Alto — pode perder validação condicional silenciosamente durante a migração; esforço de modelagem grande | Nenhum incidente real motivando a metade de validação |
| **B — Híbrido: só tools com `required` PLANO são geradas; tools condicionais continuam hand-written, isoladas e marcadas** | Gera `detectMissingRequiredArgs` + trecho de prompt só pra ~6 de ~9 tools (read, write, send_document, send_audio, weather, read_document) | Médio — ainda exige decidir/implementar a geração, só reduz o escopo | Reduz duplicação real, sem tocar os casos de risco |
| **C — Rejeitar, manter como está** | Nenhuma mudança | Nenhum | Sem ganho, mas sem risco — acumula a mesma fricção de manutenção de sempre |
| **D — Só o TEXTO DE PROMPT migra, co-localizado no arquivo de cada tool (novo campo opcional `requiredArgsHint` em `ToolExecutor`)** | `buildRequiredArgsReference()` deixa de ser um bloco hardcoded em `GoalPlanner.ts` — passa a iterar `ToolRegistry.getEnabled()` e concatenar `tool.requiredArgsHint` de cada uma. Validação (`detectMissingRequiredArgs`, guards internos) **não muda**. | Baixo — é geração de STRING a partir de um campo novo opcional, sem lógica condicional envolvida, sem tocar nenhum caminho de validação real | Ataca diretamente o incidente real confirmado (S06/ARCH-025, drift de texto) — `ToolRegistry` já é importável como singleton, sem mudança de contrato de construtor no `GoalPlanner` |

---

## Fase 4 — Síntese

**Recomendação: Alternativa D, escopo reduzido em relação ao card original.**

- **Por que não A/B agora:** a metade de VALIDAÇÃO do card (`detectMissingRequiredArgs()`) tem lógica condicional real para pelo menos 3 tools, sem incidente de produção documentado motivando a urgência de mexer nela, e com risco real de regressão silenciosa se migrada sem um dialeto de schema mais rico (trabalho de modelagem que mereceria sua própria RFC, não deveria ser bundlado aqui). Não há evidência de que valha o risco agora.
- **Por que D:** ataca a metade do card que TEM evidência real de causar bug (S06/ARCH-025, drift do texto de prompt), com o menor risco de todas as opções — não toca nenhuma lógica de validação, só move ONDE o texto descritivo de cada tool é declarado (do bloco solto em `GoalPlanner.ts` para um campo no próprio arquivo da tool, onde um maintainer adicionando/mudando um arg obrigatório está com o código na tela e é mais provável de lembrar de atualizar).
- **Desenho da implementação (se aprovada Sprint própria):**
  ```ts
  // agentLoopTypes.ts — ToolExecutor ganha campo novo opcional
  export interface ToolExecutor {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
      /** Texto curto (1 linha) explicando args obrigatórios/condicionais para o prompt do
       *  Planner. Ausente = tool não aparece na seção "ARGS OBRIGATÓRIOS" (schema autoexplicativo). */
      requiredArgsHint?: string;
      execute(args: Record<string, unknown>): Promise<ToolResult>;
  }
  ```
  `buildRequiredArgsReference()` passa a ser `ToolRegistry.getEnabled().map(t => t.requiredArgsHint).filter(Boolean).join('\n')` em vez do template literal hardcoded. Cada tool que hoje tem uma linha em `buildRequiredArgsReference()`/`buildToolContracts()` ganha seu `requiredArgsHint` movido pro próprio arquivo.
- **Fora de escopo, registrado para uma RFC futura separada (não deste ARCH):** unificar `detectMissingRequiredArgs()`/guards internos/`parameters.required` exigiria primeiro desenhar um dialeto de schema condicional — proposta a ser levantada como um ARCH novo, não decidida aqui.

---

## Fase 5 — Validação

- **Baseada em evidência real do projeto, não hipótese?** Sim — os 5 lugares lidos linha a linha, achado o gap de cobertura real (`memory_write` fora de `detectMissingRequiredArgs`) e a lógica condicional real (`web_navigate`/`crypto_analysis`/`edit`) que uma geração ingênua perderia.
- **Resolve um problema estrutural ou só um sintoma?** Resolve o problema estrutural que TEM evidência real (drift de texto, S06) — deliberadamente não resolve a fragmentação de validação, por falta de evidência de urgência e risco real de regressão.
- **Reduz a complexidade total do sistema?** Sim para o escopo D — move a declaração do texto pra perto do código que ela descreve (Decision Ownership, a própria categoria do card), sem introduzir uma camada de geração de schema condicional.
- **Elimina múltiplas fontes de verdade?** Elimina 1 das 2 fontes de texto de prompt hoje soltas (`buildRequiredArgsReference` deixa de ser fonte, vira agregador). Não elimina a fragmentação de validação (fora de escopo, ver acima).
- **Mantém a filosofia do Cognitive Kernel?** Sim.
- **Pode ser implementada incrementalmente?** Sim — tool por tool, campo opcional, sem quebrar nada que não declare `requiredArgsHint`.
- **Pode ser revertida facilmente?** Sim — reverter o commit, `buildRequiredArgsReference()` volta a ser hardcoded.

## Decisão

**Aprovada para implementação com escopo reduzido** (Alternativa D — só o texto de prompt, via `requiredArgsHint` co-localizado por tool). A metade de VALIDAÇÃO do card original (`detectMissingRequiredArgs()`, guards internos, `parameters.required`) **não é recomendada para implementação nesta forma** — fica registrada como candidata a uma RFC futura e distinta, condicionada a desenhar primeiro um dialeto de schema que suporte requisitos condicionais, e a uma reavaliação de urgência (nenhum incidente de produção real motivando hoje, ao contrário do texto de prompt).

**Riscos residuais:** nenhum para o escopo D aprovado. **Hipóteses não comprovadas:** se um dialeto de schema condicional valeria o esforço de modelagem para a metade de validação — não avaliado aqui, proposital.
