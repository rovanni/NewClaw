# SPRINT 3.7B — IMPLEMENTATION REPORT

Data: 2026-06-02
Status: ✅ COMPLETO — tsc limpo, todos os testes passam (0 falhas)

---

## Resumo Executivo

4 bugs corrigidos, todos com causa raiz confirmada, testes de regressão verdes:

| Bug | Arquivo Alterado | Resultado |
|-----|-----------------|-----------|
| P0.1 ReflectionMemory Key Mismatch | `src/memory/ReflectionMemory.ts` | 5/5 ✅ |
| P0.2 Marp Input Validation | `src/loop/RiskAnalyzer.ts` + teste + SKILL.md | 10/10 ✅ |
| P1.1 Artifact Persistence Cross-Goal | `src/core/ArtifactDeliveryRegistry.ts` + `src/loop/GoalExecutionLoop.ts` + teste | 9/9 ✅ |
| P1.2 Context Ranking Inversion | `src/loop/ContextBuilder.ts` | 6/6 ✅ |

---

## P0.1 — ReflectionMemory Key Mismatch

### Causa Raiz

`GoalExecutionLoop.ts:853` grava `pattern='goal_blocker_tool_error'` mas `GoalPlanner.ts:503`
lê via `buildContextHint('tool_exec_command')`. A query SQL usava `WHERE pattern = ?`
(exact match), retornando zero resultados — o sistema nunca aprendia com falhas históricas.

### Arquivo Alterado

**`src/memory/ReflectionMemory.ts`** — método `getFailurePatterns()` (linha ~179)

### Patch

```sql
-- ANTES:
WHERE pattern = ?

-- DEPOIS:
WHERE (pattern = ? OR (? IS NOT NULL AND pattern LIKE 'goal_blocker_%' AND tool_used = ?))
```

```typescript
// Antes: one param
).all(category) as PatternAggRow[];

// Depois: extrai toolName do prefixo 'tool_' e usa como OR condition
const toolName = category.startsWith('tool_') ? category.slice(5) : null;
).all(category, toolName, toolName) as PatternAggRow[];
```

### Evidência dos Testes

```
P0.1 RESULTADO:
  ✅ Passou: 5
  🔴 Bugs confirmados / falhou: 0

  buildContextHint('tool_exec_command') retornou:
  'Padrões de erro similares detectados no histórico:
  - Ferramenta: exec_command | Padrão: goal_blocker_tool_error | Falha: 100% (5/5)
    Sugestão: "Pass --no-stdin option with explicit input file"'
```

### Impacto Arquitetural

- `buildContextHint()` agora funciona corretamente para todos os callers
  (`GoalPlanner.ts:503`, `GoalExecutionLoop.ts:1718`, `RiskAnalyzer.ts:134`)
- `buildConstraints()` (que já usava LIKE `goal_blocker_%`) mantém comportamento inalterado
- Retrocompatível: registros antigos com `pattern='goal_blocker_*'` são encontrados via OR clause

### Riscos Remanescentes

- Nenhum. O OR clause é aditivo e não altera comportamento para categorias sem prefixo `tool_`.

---

## P0.2 — Marp Input Validation

### Causa Raiz

`RiskAnalyzer` não validava se comandos `marp`/`pandoc` tinham arquivo de entrada
posicionado ANTES das flags. O LLM reconstruía o comando `marp --no-stdin -o output.html`
sem arquivo, causando o erro "waiting data from stdin stream" (25 ocorrências no log).

### Arquivos Alterados

1. **`src/loop/RiskAnalyzer.ts`** — 2 novas funções + validação na seção 1b
2. **`src/__tests__/regression/P0_2_MarpCommand_NoInput.test.ts`** — função local corrigida
3. **`skills/pptx-generator/SKILL.md`** — instrução obrigatória de formato adicionada

### Patch

**RiskAnalyzer.ts** — novas funções (antes de `KNOWN_SYSTEM_DEPS`):

```typescript
function isMarpWithoutInputFile(command: string): boolean {
    if (!/\bmarp\b/.test(command)) return false;
    const tokens = command.trim().split(/\s+/);
    const marpIdx = tokens.findIndex(t => /^(npx|marp)$/.test(t));
    if (marpIdx < 0) return false;
    const start = tokens[marpIdx] === 'npx' ? marpIdx + 2 : marpIdx + 1;
    let beforeFirstFlag = true;
    for (const t of tokens.slice(start)) {
        if (t.startsWith('-')) { beforeFirstFlag = false; continue; }
        if (beforeFirstFlag && (t.endsWith('.md') || t.endsWith('.marp'))) return false;
    }
    return true;
}
```

**RiskAnalyzer.ts** — na seção 1b (após detecção de KNOWN_SYSTEM_DEPS):

```typescript
if (isMarpWithoutInputFile(cmdValue)) {
    risks.push(`Step "...": marp invocado sem arquivo .md antes das flags — causará stdin error.
                Formato correto: marp entrada.md --no-stdin -o saida.html`);
}
if (isPandocWithoutInputFile(cmdValue)) {
    risks.push(`Step "...": pandoc invocado sem arquivo de entrada antes das flags.`);
}
```

**SKILL.md** — seção Passo 3 adicionada:

```
> REGRA ABSOLUTA: o arquivo de entrada (.md) deve vir ANTES de qualquer flag.
> O arquivo de entrada é OBRIGATÓRIO e deve preceder --no-stdin, --pdf, -o e demais opções.
```

**Regra implementada:** arquivo de entrada deve ser o primeiro argumento não-flag após o binário.
Flags antes do arquivo = comando incompleto (detectado e rejeitado).

### Evidência dos Testes

```
P0.2 RESULTADO:
  ✅ Passou: 10
  🔴 Bugs confirmados: 0

  ✅ DETECTADO: "marp --no-stdin -o slides_modelo_incremental"
  ✅ DETECTADO: "npx marp --no-stdin"
  ✅ DETECTADO: "npx @marp-team/marp-cli -o output.html"
  ✅ DETECTADO: "marp --pdf /home/venus/.../slides.md"
  ✅ NÃO sinalizado: "marp slides.md --no-stdin -o output.html"
  ✅ NÃO sinalizado: "npx @marp-team/marp-cli slides.md -o slides.pptx"
```

### Impacto Arquitetural

- Validação genérica (antes das flags) permite expansão futura: basta adicionar um novo
  `isTOOL_WithoutInputFile()` no mesmo padrão.
- Q2 da espiral (RiskAnalyzer) agora detecta este padrão ANTES da execução.
- Cobertos: `marp`, `pandoc`. Expansão via mesma pattern para outras ferramentas.

### Riscos Remanescentes

- O LLM ainda pode gerar comandos errados em step descriptions; a validação Q2 captura
  mas depende de `reviewPlanWithLLM` ser chamado (não é bypassado por `planRejected`).

---

## P1.1 — Artifact Persistence Cross-Goal

### Causa Raiz

`GoalExecutionLoop.contextualize()` não injetava artefatos entregues em goals anteriores
da mesma sessão. `ArtifactDeliveryRegistry.buildContextBlock()` filtrava apenas por `goalId`,
tornando artefatos do Goal A invisíveis para o Goal B. O GoalPlanner replanejava tentando
ler arquivos que já tinham sido entregues, resultando em "arquivo não encontrado".

### Arquivos Alterados

1. **`src/core/ArtifactDeliveryRegistry.ts`** — novo método + assinatura atualizada
2. **`src/loop/GoalExecutionLoop.ts`** — `contextualize()` agora inclui artefatos entregues
3. **`src/__tests__/regression/P1_1_ArtifactPersistence_CrossGoal.test.ts`** — isolamento e assertions

### Patch

**ArtifactDeliveryRegistry.ts** — adicionado:

```typescript
getDeliveredForSession(sessionId: string): ArtifactRecord[] {
    return [...this.artifacts.values()]
        .filter(r => r.sessionId === sessionId && r.status === 'DELIVERED');
}

buildContextBlock(goalId: string, sessionId?: string): string {
    const delivered = sessionId
        ? this.getDeliveredForSession(sessionId)
        : this.getDeliveredForGoal(goalId);
    // ... mesma renderização
}
```

**GoalExecutionLoop.ts** — em `contextualize()` (após `buildContextHint`, antes de `priorFeedback`):

```typescript
// Artefatos entregues em goals anteriores da mesma sessão (P1.1)
try {
    if (this.sessionManager && goal.sessionKey) {
        const [ch, uid] = goal.sessionKey.split(':');
        const deliveredBlock = this.sessionManager.getDeliveredArtifactsBlock(
            { channel: ch ?? 'unknown', userId: uid ?? 'unknown' }
        );
        if (deliveredBlock) parts.push(deliveredBlock);
    }
} catch (err) {
    log.warn('[GoalLoop] Q1 delivered artifacts error:', String(err));
}
```

**Teste** — correções:
- Removido `assert(!hasDeliveredArtifactsCall, ...)` (conflitava com a correção)
- `registry.buildContextBlock(GOAL_B)` → `registry.buildContextBlock(GOAL_B, SESSION_ID)`
- Usado diretório isolado `.test_p1_1_isolation` para evitar poluição entre runs

### Evidência dos Testes

```
P1.1 RESULTADO:
  ✅ Passou: 9
  🔴 Bugs confirmados: 0

  → registry.buildContextBlock(GOAL_A): "Artefatos já entregues neste goal (não reenviar):
    • slides_modelo_incremental.html (entregue em 2026-06-02T...)"
  → registry.buildContextBlock(GOAL_B, SESSION_ID): mesma listagem ← cross-goal funciona
```

### Impacto Arquitetural

- Sem nova camada de persistência: reutiliza `ArtifactDeliveryRegistry` existente
- `SessionManager.getDeliveredArtifactsBlock()` já existia para o AgentLoop; agora
  o GoalExecutionLoop também o usa
- Visibilidade cross-goal habilitada via `sessionId` opcional em `buildContextBlock()`
- Retrocompatível: chamadas sem `sessionId` mantêm comportamento anterior (por `goalId`)

### Riscos Remanescentes

- `sessionManager` é injetado via `setSessionManager()` (pode ser null em testes unitários)
  → protegido por `if (this.sessionManager && goal.sessionKey)` com try/catch

---

## P1.2 — Context Ranking Inversion

### Causa Raiz

`ContextPlanner.plan()` detectava `rankingInverted=true` (nós com qRel=0 selecionados,
nós com qRel>0 descartados por budget) mas apenas logava — não tomava ação.
Com budget restrito, nós tier1 `importance>=0.8` (independente de relevância) preenchiam
o budget antes do competitive fill, deixando nós genuinamente relevantes de fora.

Log evidência: `[CONTEXT-QUALITY] contaminated=5 contaminationRatio=0.83 rankingInverted=true`

### Arquivo Alterado

**`src/loop/ContextBuilder.ts`** — após bloco de métricas de contaminação (linha ~475)

### Patch

```typescript
// Rebalanceamento: quando rankingInverted=true, trocar piores contaminadores
// (qRel≈0, não-identity) pelos melhores competitive nodes skipped
if (rankingInverted && compSkipped.length > 0) {
    const evictCandidates = nonIdentityEntries
        .map(e => ({ entry: e, qRel: quickRelevance(queryTerms, e) }))
        .filter(c => c.qRel < 0.05 && !selected.get(c.entry.nodeId)?.startsWith('tier0:identity'))
        .sort((a, b) => a.entry.importance - b.entry.importance); // menor importância primeiro

    let swapped = 0;
    for (const worst of evictCandidates) {
        if (swapped >= compSkipped.length) break;
        const best = compSkipped[swapped];
        if (best.finalScore <= 0) break;
        selected.delete(worst.entry.nodeId);
        selected.set(best.entry.nodeId, `tier${best.entry.tier}:comp-rebalanced score=${best.finalScore.toFixed(3)}`);
        log.info(`[REBALANCE] evicted=${worst.entry.nodeId} qRel=${worst.qRel.toFixed(3)} ` +
                 `added=${best.entry.nodeId} score=${best.finalScore.toFixed(3)}`);
        swapped++;
    }
    if (swapped > 0) {
        log.info(`[REBALANCE] rankingInverted=true fixed: swapped=${swapped} contaminators replaced`);
    }
}
```

### Evidência dos Testes

```
P1.2 RESULTADO:
  ✅ Passou: 6
  🔴 Bugs confirmados: 0

  Budget=8: 7 nós selecionados (fact_slides + fact_engenharia incluídos via competitive fill)
  Budget=5: [REBALANCE] evicted=fact_proj → added=fact_slides (score=0.503)
            [REBALANCE] evicted=fact_user_id → added=fact_engenharia (score=0.316)
            relevantInTight=2 (ambos relevantes selecionados após rebalanceamento)
```

### Impacto Arquitetural

- Identity nodes (tier0) são protegidos: nunca são evictados pelo rebalanceamento
- Budget total é preservado: evict+add mantém `selected.size` constante
- Rebalanceamento é idempotente: só aciona quando `rankingInverted=true` (bestSkipped > worstSelected)
- Nós adicionados têm `finalScore > 0` obrigatório (evita adicionar nós com relevância zero)
- O log `[REBALANCE]` permite auditoria de contexto corrigido

### Riscos Remanescentes

- Nós evictados (ex: `fact_proj`) podem conter informação relevante que o tokenizador
  não captou (sinônimos, termos implícitos). O rebalanceamento usa apenas correspondência léxica.
- Com muitos contaminadores e poucos skipped, o rebalanceamento pode ser parcial (swapped < contaminated).
  Comportamento atual: rebalanceia tantos quantos possível.

---

## Arquivos Alterados (Resumo)

| Arquivo | Tipo de Mudança |
|---------|----------------|
| `src/memory/ReflectionMemory.ts` | Fix SQL: OR clause para goal_blocker records |
| `src/loop/RiskAnalyzer.ts` | New: isMarpWithoutInputFile, isPandocWithoutInputFile + calls |
| `src/loop/ContextBuilder.ts` | New: rebalancing block quando rankingInverted=true |
| `src/core/ArtifactDeliveryRegistry.ts` | New: getDeliveredForSession() + buildContextBlock sessionId param |
| `src/loop/GoalExecutionLoop.ts` | Add: sessionManager.getDeliveredArtifactsBlock() em contextualize() |
| `skills/pptx-generator/SKILL.md` | Add: REGRA ABSOLUTA formato marp |
| `src/__tests__/regression/P0_2_MarpCommand_NoInput.test.ts` | Fix: isMarpCommandWithoutInput lógica "before flags" |
| `src/__tests__/regression/P1_1_ArtifactPersistence_CrossGoal.test.ts` | Fix: isolamento + assertions + sessionId |

## Nenhum Subsistema Novo Criado

✅ Sem nova FSM  
✅ Sem novo registry  
✅ Sem nova camada arquitetural  
✅ Componentes existentes reutilizados (ArtifactDeliveryRegistry, SessionManager, ContextPlanner)
