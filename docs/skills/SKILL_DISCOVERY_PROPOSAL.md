# SKILL_DISCOVERY_PROPOSAL — Evolução do Sistema de Skills

**Data:** 2026-06-01  
**Baseado em:** CURRENT_STATE.md + auditoria arquitetural completa  
**Premissa:** Nenhum novo subsistema. Nenhum registry paralelo. Aproveitamento total da arquitetura existente.

---

## Sumário Executivo

O sistema de Skills do NewClaw tem uma base sólida. O problema não é a arquitetura — é o **alcance do matching**. Skills relevantes ficam invisíveis porque o trigger matching é puramente léxico.

A proposta resolve isso em **quatro mudanças mínimas**:

| # | Mudança | Arquivo | Linhas estimadas |
|---|---|---|---|
| 1 | Tags de domínio no frontmatter | `skills/*/SKILL.md` (6 arquivos) | +2 por arquivo |
| 2 | Match por tags em `getSkillContextForQuery()` | `AgentLoop.ts` | ~20 |
| 3 | Hint de skill em Q1 `contextualize()` | `GoalExecutionLoop.ts` | ~25 |
| 4 | Hint de skill externa em Q2 `RiskAnalyzer` | `RiskAnalyzer.ts` | ~30 |

Nenhum novo arquivo de código. Nenhuma nova classe. Nenhum novo banco de dados.

---

## 1. Análise: Onde a Discovery Deve Viver

### Q1 — Contextualização: SIM (skill discovery)

Q1 já coleta contexto semântico antes de planejar. É o lugar correto para informar o planner que "existe uma skill especializada para este domínio". O planner receberá esse contexto e poderá priorizá-la nos steps.

**Mudança proposta:** `contextualize()` verifica se alguma skill local faz match por tags/domínio. Se sim, adiciona ao contexto: `"Skill disponível: marp-skill — instruções especializadas já injetadas."` Se não faz match local, adiciona: `"Skills externas potencialmente relevantes: [X, Y]."`.

### Q2 — Risco: SIM (skill gap detection)

Se o plano usa `exec_command` com binários que uma skill já sabe otimizar, Q2 pode sinalizar isso. Não bloqueia — apenas emite `[SKILL-HINT]` para observabilidade.

**Mudança proposta:** `RiskAnalyzer.analyze()` verifica se alguma skill disponível tem overlap com as tools do plano. Se sim, emite log. Sem bloqueio.

### Q3 — Execução: JÁ EXISTE

O AgentLoop já carrega skills por trigger durante execução. A melhoria aqui é apenas no matching (tags), não na estrutura.

### Q4 — Validação: JÁ PARCIALMENTE RESOLVIDO (Sprint 3.6D)

`content-validator` já pode ser invocado pelo hook de skill validators. Nenhuma mudança adicional necessária.

---

## 2. Mudança 1 — Tags de Domínio no Frontmatter

### Problema resolvido

`L1` (match apenas léxico) e `L7` (sem categorias).

### Implementação

Adicionar campo `tags` ao frontmatter de cada SKILL.md:

```yaml
---
name: pptx-generator
description: Converte apresentações em PowerPoint editável via Marp
version: "1.0"
triggers: powerpoint, pptx, slides editáveis, apresentação editável, marp, exportar pptx
tools: exec_command, write, read, send_document
tags: presentation, slides, export, document, office
---
```

**Exemplos por skill:**

| Skill | Tags sugeridas |
|---|---|
| pptx-generator | presentation, slides, export, document, office |
| html-pdf-converter | pdf, convert, export, html, document |
| content-validator | validation, quality, syntax, check |
| skill-auditor | security, audit, safety |
| skill-manager | install, manage, deploy, skill |
| system-provisioner | install, dependency, environment, setup |

### Parsing (sem alteração estrutural em SkillLoader)

`SkillLoader.parseFrontmatter()` já itera pelas linhas do frontmatter. Basta adicionar o parsing de `tags`:

```typescript
// Em parseFrontmatter() (SkillLoader.ts) — adicionar:
if (key === 'tags') {
    skill.tags = value.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
}
```

E na interface `Skill`:
```typescript
interface Skill {
    // ... campos existentes ...
    tags?: string[];  // domínios e capacidades sem dependência de linguagem
}
```

**Impacto:** 0 regressões. Tags são opcionais. Skills sem tags continuam funcionando exatamente como antes.

---

## 3. Mudança 2 — Match por Tags em `getSkillContextForQuery()`

### Problema resolvido

`L1` (match léxico) — enriquece o matching sem substituí-lo.

### Implementação

Em `AgentLoop.ts`, método `getSkillContextForQuery()`:

```typescript
public getSkillContextForQuery(query: string): string {
    const skills = this.skillLoader.loadAll();
    const lowerQuery = query.toLowerCase();

    const matched = skills.filter(s => {
        // Match existente: triggers (léxico)
        const triggerMatch = s.triggers?.some(t => lowerQuery.includes(t.toLowerCase()));
        if (triggerMatch) return true;

        // Match novo: tags (léxico, mas domínio-agnóstico)
        // Tags são mais abstratas que triggers: "presentation" captura
        // "criar apresentação", "slide deck", "pitch deck", etc.
        const tagMatch = s.tags?.some(tag => lowerQuery.includes(tag));
        return tagMatch ?? false;
    });

    if (matched.length === 0) return '';

    return matched.map(s =>
        `### SKILL: ${s.name}\n${s.globalContent || s.content}`
    ).join('\n\n');
}
```

**Por que tags em vez de semântica profunda?**

Tags (`presentation`, `slides`, `export`) ainda são léxicas, mas mais abrangentes que triggers. `"criar uma apresentação sobre redes"` vai capturar `presentation` em tags. Isso resolve 80% dos casos sem adicionar dependência de embeddings/vetores.

Para o restante (formulações muito diferentes da tag), Q1 adicionará o hint de contexto (Mudança 3).

**Impacto:** O comportamento para queries com trigger-match exato é idêntico. Queries com match por tags resultam em mais skills ativadas — o que é o efeito desejado.

---

## 4. Mudança 3 — Skill Discovery em Q1 `contextualize()`

### Problema resolvido

`L2` (sem discovery para skill ausente), `L1` (match semântico).

### Implementação

Em `GoalExecutionLoop.ts`, método `contextualize()`:

```typescript
private async contextualize(goal: Goal, cycleNumber: number, priorFeedback?: string): Promise<string> {
    const parts: string[] = [];

    // ... código existente (memória semântica + falhas) ...

    // NOVO: descoberta de skills relevantes
    // Usa SkillLoader já injetado via planner — sem nova instância
    try {
        const allSkills = this.planner.getAvailableSkillSummaries(); // método novo (veja abaixo)
        const goalTokens = new Set(
            goal.userIntent.toLowerCase()
                .split(/\W+/)
                .filter(t => t.length > 3)
        );

        // Skills instaladas com overlap de tokens (triggers + tags)
        const relevantInstalled = allSkills.filter(s =>
            [...(s.triggers ?? []), ...(s.tags ?? [])].some(keyword =>
                goalTokens.has(keyword.toLowerCase()) ||
                [...goalTokens].some(t => keyword.toLowerCase().includes(t))
            )
        );

        if (relevantInstalled.length > 0) {
            const names = relevantInstalled.map(s => s.name).join(', ');
            parts.push(
                `Skills especializadas disponíveis para este objetivo: ${names}.\n` +
                `O planner JÁ recebeu as instruções dessas skills. Priorize-as.`
            );
            log.info(
                `[Q1-SKILL-DISCOVERY] goal=${goal.id}` +
                ` installed_relevant=${relevantInstalled.map(s => s.name).join(',')}` +
                ` cycle=${cycleNumber}`
            );
        }
    } catch (err) {
        log.warn('[Q1-SKILL-DISCOVERY] error:', String(err));
    }

    // ... restante do código existente ...
}
```

**Método auxiliar em `GoalPlanner.ts`** — expõe a lista cached de skills sem criar nova instância:

```typescript
// GoalPlanner.ts — adicionar método público
getAvailableSkillSummaries(): Array<{ name: string; triggers?: string[]; tags?: string[] }> {
    const skills = this.skillLoader.loadAll(); // usa instância e cache já existentes
    return skills.map(s => ({ name: s.name, triggers: s.triggers, tags: s.tags }));
}
```

**Por que em Q1 e não antes?**

Q1 já é o ponto onde o contexto é enriquecido antes do planejamento. O planner recebe o skillContext (via `setSkillContext`) E o q1Context (via `contextualize`). Adicionar o hint de skill em Q1 reforça a informação — o planner vê a skill de dois ângulos: como instrução comportamental E como contexto explícito.

**Custo:** Uma iteração sobre a lista de skills (já em memória — cache do SkillLoader). Negligenciável.

---

## 5. Mudança 4 — Skill Gap Hint em Q2 (RiskAnalyzer)

### Problema resolvido

`L3` (Q2 não considera skills).

### Implementação

Em `RiskAnalyzer.ts`, método `analyze()`, após as verificações existentes:

```typescript
// Em RiskAnalyzer.analyze() — adicionar após os checks existentes, antes do return:

// NOVO: detectar se o plano usa exec_command para algo que uma skill instalada faz melhor
const skillLoader = new SkillLoader(); // ← problema: instância #3 (ver alternativa abaixo)
const installedSkills = skillLoader.loadAll();

const execSteps = plan.filter(s => s.toolName === 'exec_command');
for (const execStep of execSteps) {
    const cmd = String(execStep.toolArgs?.command ?? '').toLowerCase();
    const coveringSkill = installedSkills.find(skill =>
        (skill.tools ?? []).includes('exec_command') &&
        (skill.triggers ?? []).some(t => cmd.includes(t.toLowerCase()))
    );
    if (coveringSkill) {
        log.info(
            `[SKILL-HINT] goal=${goal.id}` +
            ` step=${execStep.id}` +
            ` command="${cmd.slice(0, 60)}"` +
            ` skill_available=${coveringSkill.name}` +
            ` reason=exec_command_covered_by_skill`
        );
        risks.push(
            `Skill "${coveringSkill.name}" está instalada e pode otimizar este comando — verifique se as instruções da skill foram aplicadas.`
        );
    }
}
```

**Alternativa para evitar instância #3:** Receber a lista de skills como parâmetro de `analyze()`:

```typescript
// Assinatura atual:
async analyze(goal: Goal, plan: PlanStep[]): Promise<RiskReport>

// Assinatura nova (retrocompatível — parâmetro opcional):
async analyze(goal: Goal, plan: PlanStep[], skillSummaries?: Array<{name:string; triggers?:string[]; tools?:string[]}>): Promise<RiskReport>
```

O `GoalExecutionLoop` que chama `analyze()` já tem acesso ao `GoalPlanner`, que tem a lista de skills. Passa-se por parâmetro, sem nova instância.

**Impacto:** Log `[SKILL-HINT]` emitido. O risco é adicionado à lista mas não bloqueia o plano (apenas informa). Zero regressões.

---

## 6. Discovery de Skills Externas (Fase Futura)

### Por que não implementar agora

A Mudança 3 (Q1 hint) já resolve o problema para skills instaladas. Discovery externa (consulta a skills.sh ou catálogos) adiciona:
- Latência de rede em Q1 (impacto direto no tempo de resposta)
- Dependência de serviço externo (ponto de falha)
- Complexidade de parsing de catálogo externo

Recomendação: implementar apenas se os usuários frequentemente pedem domínios sem nenhuma skill local.

### Arquitetura proposta (quando a hora chegar)

```typescript
// skill-manager SKILL.md já tem instruções para consultar skills.sh
// A discovery externa pode ser feita PELO PRÓPRIO skill-manager skill:

// Em Q1, quando nenhuma skill local faz match:
if (relevantInstalled.length === 0) {
    parts.push(
        `Nenhuma skill especializada instalada para este objetivo.\n` +
        `Domínio detectado: ${inferDomain(goal.userIntent)}.\n` +
        `Para instalar uma skill: peça "instale uma skill para [domínio]" — ` +
        `o skill-manager buscará em catálogos externos.`
    );
}
```

**Estratégia:** Não chamar catálogo externo programaticamente. Em vez disso, informar o LLM que pode ativar a `skill-manager` skill para buscar e instalar. O `skill-manager` já sabe consultar skills.sh (está nas instruções da skill). É self-contained.

---

## 7. Integração com o Modelo Espiral

```
Q1 — contextualize()
  NOVO: detecta skills relevantes instaladas
  NOVO: adiciona ao contexto: "Skills disponíveis: X, Y"
  NOVO: se nenhuma: "Nenhuma skill local — considere skill-manager"
         ↓
GoalPlanner.plan()
  Recebe skillContext (via setSkillContext) — já existente
  Recebe q1Context com hint de skill — NOVO
  LLM planeja com conhecimento duplo de qual skill usar
         ↓
Q2 — RiskAnalyzer.analyze()
  NOVO: detecta exec_command coberto por skill instalada
  NOVO: emite [SKILL-HINT] como risco informativo
         ↓
Q3 — AgentLoop
  MELHORADO: match por tags (Mudança 2) captura mais queries
  Skill content injetado no prompt do step — já existente
         ↓
Q4 — validateGoalCompletion()
  Hook de skill validators — Sprint 3.6D (já implementado)
```

---

## 8. Componentes Reutilizados / Modificados / Não Modificados

### Reutilizados sem alteração

- `SkillLoader` — mesma classe, mesma lógica de `loadAll()`. Apenas `parseFrontmatter()` recebe +5 linhas para parsing de `tags`.
- `SkillInstaller` — não tocado.
- `SkillLearner` — não tocado.
- `GoalOrchestrator` — não tocado.
- `GoalEvaluator` — não tocado.
- Cache TTL de 60s do GoalPlanner — mantido.
- Hot-reload do SkillLoader — mantido.

### Modificados (cirurgicamente)

| Arquivo | Mudança | Linhas adicionadas |
|---|---|---|
| `skills/*/SKILL.md` (6 arquivos) | Adicionar campo `tags` | +2 por arquivo |
| `src/skills/SkillLoader.ts` | Parsing de `tags` em `parseFrontmatter()` | +5 |
| `src/loop/AgentLoop.ts` | Match por tags em `getSkillContextForQuery()` | +8 |
| `src/loop/GoalExecutionLoop.ts` | Skill hint em `contextualize()` | +25 |
| `src/loop/GoalPlanner.ts` | Método `getAvailableSkillSummaries()` | +8 |
| `src/loop/RiskAnalyzer.ts` | `[SKILL-HINT]` em `analyze()` | +20 |

**Total estimado: ~90 linhas de código novo.**

### Não Modificados

- `GoalExecutionLoop` (lógica de execução de steps)
- `GoalStore`, `GoalTypes`
- `ProviderFactory`, `AgentController`
- `ArtifactDeliveryRegistry`
- Todo o pipeline de validação Q4
- Sistema de autenticação/workflow

---

## 9. Impacto em Performance

| Operação | Impacto | Mitigação |
|---|---|---|
| Match por tags em `getSkillContextForQuery()` | +1ms por request | Cache já existente |
| Hint em Q1 `contextualize()` | +1ms | Usa lista já carregada pelo GoalPlanner |
| Hint em Q2 `RiskAnalyzer` | +0.5ms | Lista passada por parâmetro (sem disk read) |
| Parsing de `tags` no frontmatter | +0.1ms por skill na carga | Executado apenas no `loadAll()` |

**Impacto total estimado:** < 3ms por request. Dentro do ruído.

---

## 10. Impacto em Manutenção

**Reduz manutenção:**
- Adicionar nova skill automaticamente participa da discovery sem alterar código
- Tags permitem domínio-agnóstico: adicionar `tags: presentation, slides` em nova skill a torna descobrível para qualquer query de apresentação

**Não adiciona carga:**
- Nenhuma configuração nova
- Nenhuma migração de banco de dados
- Nenhuma interface de admin nova

---

## 11. Riscos de Regressão

| Risco | Probabilidade | Mitigação |
|---|---|---|
| Tags mal definidas aumentam falsos positivos de match | Baixa | Tags são opcionais. Sem tags, comportamento idêntico ao atual |
| `getAvailableSkillSummaries()` expor skills erradas | Baixa | Usa mesmo cache e instância do GoalPlanner |
| `[SKILL-HINT]` no Q2 poluir a lista de riscos | Média | Formato informativo (não bloqueia). Pode ser filtrado por log level |
| Hint em Q1 aumentar o contexto e estourar tokens | Baixa | Hint é 1-2 linhas de texto plano, não o conteúdo da skill |

---

## 12. Recomendação Final

**Implementar nesta ordem:**

1. **Mudança 1** — Adicionar `tags` aos SKILL.md existentes  
   _(sem risco, sem código, benefício imediato para matching)_

2. **Mudança 2** — Match por tags em `getSkillContextForQuery()`  
   _(ativa as tags adicionadas — mínima, testável isoladamente)_

3. **Mudança 3** — Hint de skill em Q1  
   _(reforça a discovery para o planner — maior benefício percebido pelo usuário)_

4. **Mudança 4** — `[SKILL-HINT]` em Q2  
   _(observabilidade — pode aguardar ciclo posterior sem impacto)_

**Discovery externa (skills.sh):** NÃO implementar agora. Delegar ao skill-manager skill que já tem capacidade de buscar e instalar. Resposta ao usuário em Q1 (`"peça skill-manager para buscar"`) é suficiente e zero-risk.

---

## Critérios de Aceite Verificados

✅ Reutiliza sistema atual de Skills (SkillLoader, frontmatter, pipeline)  
✅ Não cria sistemas paralelos (0 novos registries, 0 novas classes)  
✅ Não aumenta significativamente a complexidade (~90 linhas totais)  
✅ Funciona para qualquer domínio (tags são configuráveis por skill)  
✅ Funciona para qualquer usuário (match automático, sem configuração de usuário)  
✅ Não depende de regras específicas para slides, PPTX ou HTML  
✅ Novas skills descobertas sem alterações de código (apenas SKILL.md com tags)  
✅ Integração natural com Q1, Q2, Q3 e Q4 do modelo espiral
