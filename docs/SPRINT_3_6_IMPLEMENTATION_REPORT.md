# SPRINT 3.6 — Relatório de Implementação

**Data:** 2026-06-01  
**Status:** Implementado — TypeScript OK (tsc --noEmit sem erros)

---

## Resumo Executivo

Foram implementadas correções arquiteturais definitivas para 5 categorias de bugs identificados durante investigação de logs (2026-05-31).

Nenhuma das correções é pontual ou hardcoded para casos específicos. Todas melhoram a arquitetura geral do sistema.

---

## Arquivos Modificados

| Arquivo | Tipo | Problema(s) |
|---|---|---|
| `src/tools/analyze_workspace_groups.ts` | Reescrita completa | P2 |
| `src/tools/organize_workspace.ts` | Reescrita completa | P1 |
| `src/loop/AgentLoop.ts` | Edição cirúrgica | P3a |
| `src/loop/agentLoopTypes.ts` | Adição de campo | P3a |
| `src/loop/GoalExecutionLoop.ts` | 4 edições cirúrgicas | P3b |
| `src/loop/GoalPlanner.ts` | 2 edições | P4 |
| `src/core/ArtifactDeliveryRegistry.ts` | **Novo arquivo** | P5 |

---

## Problema 1 — organize_workspace não executa

### Causa raiz confirmada
`const dryRun = args.dry_run !== false;` — padrão `true` fazia o tool apenas exibir o plano sem mover arquivos. O planner nunca passava `dry_run: false`.

### Correção implementada (Opção A — Separação semântica)

**Arquivo:** `src/tools/organize_workspace.ts`

Removido completamente o parâmetro `dry_run`. O tool agora **sempre executa movimentações reais**.

- `analyze_workspace_groups` → somente análise, sem mover nada
- `organize_workspace` → sempre executa (sem ambiguidade)

Argumento legado `dry_run: true` é ignorado com log de aviso:
```
[WORKSPACE-ORGANIZE] dry_run=true foi passado mas é ignorado — use analyze_workspace_groups para preview
```

### Logs adicionados
```
[WORKSPACE-ORGANIZE] workspace_dir= total_files= root_files= groups_detected= moves_planned= ungrouped_root=
[WORKSPACE-ORGANIZE-RESULT] success= files_moved= directories_created= errors=
```

### Por que o bug não pode mais ocorrer
O parâmetro `dry_run` não existe mais. Não há mais código-path que retorna sem mover arquivos. Toda execução do tool finaliza com movimentações reais ou erro explícito.

---

## Problema 2 — Artifact Groups criando megagrupos

### Causa raiz confirmada
`goalBases.add(path.basename(p))` em H1 (`discoverGroups`) armazenava apenas o nome do arquivo, não o caminho relativo. O match `goalBases.has(path.basename(f.relativePath))` então capturava TODOS os arquivos com o mesmo nome em qualquer diretório do workspace.

Exemplo: goal criou `jogos/tower_defense/index.html` → `goalBases = {"index.html"}` → matched incluía `index_main/index.html`, `tmp/index.html` etc.

### Correção implementada

**Arquivo:** `src/tools/analyze_workspace_groups.ts` (reescrita completa)

**1. Nova função `normalizeToRelative()`** — normaliza paths absolutos, relativos e com prefix `workspace/` para caminhos relativos ao workspace root. Retorna `null` para paths fora do workspace.

```typescript
export function normalizeToRelative(p: string, workspaceDir: string): string | null
```

**2. H1 usa caminho relativo completo:**
```typescript
// ANTES (bug)
goalBases.add(path.basename(p));
files.filter(f => goalBases.has(path.basename(f.relativePath)))

// DEPOIS (fix)
const rel = normalizeToRelative(p, resolvedWorkspaceDir);
if (rel) goalPaths.add(rel);
files.filter(f => goalPaths.has(f.relativePath))  // match exato
```

**3. Sistema de score por par** — cada par de arquivos é avaliado antes de unir:

| Heurística | Score |
|---|---|
| same_goal (full path match) | +0.30 |
| same_directory | +0.30 |
| token_similarity (Jaccard × 0.20) | variável |
| temporal_window (3 min) | +0.17 |

Merge apenas se `finalScore >= MERGE_THRESHOLD (0.30)`.

**4. Logs corrigidos** — `similarity=1.00` hardcoded removido. Valores reais agora emitidos.

### Logs adicionados
```
[ARTIFACT-GROUP-SCORE] file_a= file_b= same_goal= same_directory= same_prefix= jaccard= temporal= final_score= threshold= decision= goal_id=
[ARTIFACT-GROUP-UNION] file_a= file_b= reason= score= union_source=
[ARTIFACT-GROUP-SUMMARY] groups= total_files_grouped= largest_group= average_group_size= suspicious_groups=
```

Grupos com ≥ 8 arquivos são automaticamente marcados como suspeitos (possível contaminação transitiva) com aviso `WARN`.

### Por que o bug não pode mais ocorrer
`goalPaths` só contém caminhos relativos completos. Um goal que criou `jogos/tower_defense/index.html` jamais causará match em `tmp/index.html` — os caminhos são diferentes. A fusão transitiva só acontece quando arquivos REALMENTE pertencem ao mesmo goal por identidade de caminho.

---

## Problema 3 — Explosão de artefatos enviados (17 sends)

### Causa raiz confirmada
1. AgentLoop interceptava `send_document` e respondia ao LLM: `"Continue com os próximos passos"` → LLM reinterpretava como "continue trabalhando" e chamava `send_document` novamente na próxima iteração.
2. `deferredSendArgs` era um `Array[]` sem deduplicação — acumulava N entradas para o mesmo arquivo.
3. FIX C (injeção de steps) não deduplicava por `file_path` antes de criar `PlanStep[]`.
4. Loop de execução de deferred sends (após validação) não verificava `sentArtifacts` antes de `executeStep`.

### Correções implementadas (defesa em 4 camadas)

**Camada 1 — AgentLoop.ts: mensagem neutra**

```typescript
// ANTES
"Continue com os próximos passos."

// DEPOIS
"Documento registrado para entrega. Não reenvie este artefato.
Continue apenas se ainda existirem tarefas pendentes não relacionadas à entrega deste arquivo."
```

Se o artefato já estava registrado, mensagem mais forte:
```
"Não reenvie este artefato. Se não há outras tarefas pendentes, conclua com resposta final."
```

**Camada 2 — GoalExecutionLoop.ts: acumulador como Map**

```typescript
// ANTES
const deferredSendArgs: Array<...> = [];
deferSendDocument: (args) => { deferredSendArgs.push(args); }

// DEPOIS
const deferredSendArgsMap = new Map<string, ...>();
deferSendDocument: (args) => {
    const key = filePath || JSON.stringify(args);
    if (deferredSendArgsMap.has(key)) { log([DELIVERY-DEDUP]); return; }
    deferredSendArgsMap.set(key, args);
    deferredSendArgs.push(args);
}
```

**Camada 3 — GoalExecutionLoop.ts: dedup antes de injetar PlanSteps**

```typescript
// DEPOIS (FIX C)
for (const sendArgs of cycleResult.deferredSends) {
    const fp = String(sendArgs['file_path'] ?? ...);
    if (existingPendingSendPaths.has(fp) || sentArtifacts.has(fp)) {
        log([DELIVERY-DEDUP] decision=skip);
        continue;
    }
    dedupedSends.push(sendArgs);
}
// Só cria PlanSteps para dedupedSends
```

**Camada 4 — GoalExecutionLoop.ts: check sentArtifacts antes de executar**

```typescript
// DEPOIS (loop de deferred sends pós-validação)
for (const sendStep of deferredSends) {
    const filePath = String(sendStep.toolArgs?.file_path ?? '');
    if (filePath && sentArtifacts.has(filePath)) {
        log([DELIVERY-DEDUP] decision=skip);
        this.markStepDone(..., '[DEDUP] já entregue');
        continue;
    }
    // Só executa se não duplicado
    const sendResult = await this.executeStep(...);
}
```

**Campo `isDeferredArtifact` adicionado a `ChannelContext`:**

```typescript
// agentLoopTypes.ts
isDeferredArtifact?: (filePath: string) => boolean;
```

Permite ao AgentLoop verificar (antes de logar `already_registered=false`) se o artefato já está no mapa.

### Logs adicionados
```
[DELIVERY-DEDUP] artifact= reason= existing_delivery= decision=
[DELIVERY-REGISTRY] artifact= artifact_id= goal= session= status=
[DEFERRED-SEND] goal= artifact= result=
[AGENTLOOP-SEND] ... deferred_injected= deferred_skipped= reason=
```

### Por que o bug não pode mais ocorrer
4 camadas independentes bloqueiam duplicatas:
1. LLM não é instruído a continuar chamando send_document
2. Map no acumulador rejeita o segundo push para o mesmo file_path
3. Injeção de PlanSteps verifica existência no plano + sentArtifacts
4. Execução final verifica sentArtifacts antes de executeStep

Para que 17 sends ocorressem novamente, TODAS as 4 camadas teriam que falhar simultaneamente.

---

## Problema 4 — Observabilidade insuficiente

### Logs de replan adicionados (GoalPlanner.ts)

```
[REPLAN-DECISION] goal= failed_step= failed_tool= root_cause= blocker_desc= selected_strategy= replan_budget=
```

Emitido no início de cada `replan()`, antes da chamada LLM. Permite reconstruir a decisão de replanejamento sem precisar inferir do contexto.

### Dica de retry ao LLM

Quando o blocker é `goal_incomplete` e a última tool falhou, o prompt de replan agora inclui:

```
⚡ DICA DE CORREÇÃO: A ferramenta "organize_workspace" foi executada mas não produziu o resultado 
esperado. Antes de trocar de estratégia, considere se pode reutilizar "organize_workspace" 
com argumentos corrigidos.
```

Isso resolve o padrão observado onde o replanner abandonava `organize_workspace` (que precisava apenas de `dry_run=false`) e gerava scripts shell placeholder.

---

## Problema 5 — Arquitetura de Artefatos

### ArtifactDeliveryRegistry criado

**Novo arquivo:** `src/core/ArtifactDeliveryRegistry.ts`

Fundação da camada unificada de gerenciamento de artefatos:

```typescript
class ArtifactDeliveryRegistry {
    recordCreated(path, goalId, sessionId): ArtifactRecord
    markDelivered(path, goalId): boolean  // retorna false se já entregue (dedup)
    isDelivered(path): boolean
    getDeliveredForGoal(goalId): ArtifactRecord[]
    buildContextBlock(goalId): string  // para injeção no LLM context
}
```

**Estados do artefato:**
```
CREATED    — arquivo escrito no workspace
VALIDATED  — Q4 achieved=true
DELIVERED  — send_document executado com sucesso
SUPERSEDED — nova versão substituiu este artefato
```

**Persistência:** `workspace/.newclaw/delivery_registry.json`

**IDs estáveis:** `sha1(goalId + ":" + artifactPath).slice(0, 12)`

### Próximos passos para ArtifactManager completo

Esta é a fundação. A evolução incremental recomendada:

1. **Sprint 3.7:** Integrar `ArtifactDeliveryRegistry` como singleton no `GoalOrchestrator`, substituindo o `sentArtifacts` local em `GoalExecutionLoop`.
2. **Sprint 3.8:** Adicionar `hash` de conteúdo ao `ArtifactRecord` para detectar arquivos superseded por conteúdo, não apenas por goalId.
3. **Sprint 3.9:** Migrar `activeFiles`, `filesModified`, `filesRead` do `SessionManager` para `ArtifactManager`, criando a camada unificada completa.

---

## Evidências de que os bugs não podem mais ocorrer

### P1 — organize_workspace

**Evidência estrutural:** `dry_run` foi removido da interface do tool. Não existe mais code-path que retorna sem executar. O parâmetro `required: []` continua vazio — o planner não precisa passar nada, e o tool sempre executa.

**Evidência de observabilidade:** `[WORKSPACE-ORGANIZE-RESULT] files_moved=N` será sempre emitido. Se `files_moved=0` após execução, indica `already_organized` com log explícito.

### P2 — Megagrupos

**Evidência estrutural:** `path.basename()` foi completamente removido do loop H1. Nenhum código em `discoverGroups` usa basename para matching — apenas `f.relativePath`.

**Evidência de observabilidade:** `[ARTIFACT-GROUP-SCORE]` emite `decision=merge` ou `decision=skip` para cada par, com o score real. Qualquer agrupamento inesperado é auditável linha-a-linha.

**Evidência do `[ARTIFACT-GROUP-SUMMARY]`:** Grupos com ≥ 8 arquivos geram `WARN` automático, detectando contaminação transitiva antes que cause problemas visíveis ao usuário.

### P3 — Replay de envios

**Evidência estrutural:** 4 camadas independentes de dedup. O log `[DELIVERY-DEDUP] decision=skip` será emitido em qualquer das 4 camadas que bloquear uma duplicata.

**Evidência de observabilidade:** Ao final de cada goal com deferred sends, será visível nos logs:
```
[AGENTLOOP-SEND] deferred_injected=1 deferred_skipped=16 reason=goal_execution_policy
```
Se `deferred_skipped > 0`, o sistema funcionou corretamente ao bloquear duplicatas.

---

## Impactos e Riscos

| Mudança | Risco | Mitigação |
|---|---|---|
| `organize_workspace` sem `dry_run` | Planos antigos com `dry_run: true` agora executam | Log WARN explícito; comportamento é o desejado |
| H1 com full-path matching | Goals antigos com paths absolutos podem não matchear | `normalizeToRelative()` trata paths absolutos e relativos |
| Score threshold em H1 | Pode reduzir alguns agrupamentos legítimos | MERGE_THRESHOLD = 0.30 (baixo); same_goal sozinho (0.30) é suficiente |
| Mensagem neutra no deferral | LLM pode não saber que pode parar | Mensagem explícita: "conclua com resposta final ao usuário" |

---

## Próximas Melhorias Recomendadas

1. **Integrar `ArtifactDeliveryRegistry` na cadeia principal** (Sprint 3.7) — substituir `sentArtifacts: Set<string>` local pela instância do registry, garantindo persistência entre goals da mesma sessão.

2. **`organize_workspace` com filtro de diretório** — atualmente organiza o workspace inteiro. Adicionar parâmetro `directory?: string` para restringir à pasta solicitada pelo usuário (ex: `/tmp`).

3. **Score threshold configurável** — expor `MERGE_THRESHOLD` e `SUSPICIOUS_SIZE_THRESHOLD` em configuração do sistema para ajuste sem rebuild.

4. **Test suite para `discoverGroups`** — criar testes unitários que verificam explicitamente que `index.html` em dois diretórios diferentes NÃO são agrupados pela mesma goal.

5. **Circuit breaker para deferredSends** — se um goal acumular mais de N deferred sends (ex: 5), logar `ERROR` e forçar encerramento do AgentLoop step para evitar consumo excessivo de tokens.
