# SKILL_SYSTEM_ARCHITECTURE — Arquitetura do Sistema de Skills

**Atualizado em:** Sprint 3.7A (2026-06-01)

---

## Visão Geral

Skills são **arquivos Markdown com frontmatter YAML** que injetam instruções comportamentais no prompt do LLM. Não são código executável — são diretrizes que guiam como o LLM planeja e executa tarefas especializadas.

```
skills/{nome}/SKILL.md
  ↓
SkillLoader.loadAll()
  ↓
Trigger match (léxico) + Capability match (tags normalizadas)
  ↓
Prompt do GoalPlanner / AgentLoop
  ↓
LLM usa as instruções ao planejar steps
```

---

## Frontmatter de uma Skill

```yaml
---
name: pptx-generator                            # identificador único
description: Converte apresentações para PPTX   # descrição curta (aparece no sumário)
version: "1.0"
triggers: powerpoint, pptx, slides editáveis    # palavras-chave léxicas (match substring)
tools: exec_command, write, send_document        # tools que esta skill prefere usar
tags: presentation, slides, export, office      # domínios de capacidade (Sprint 3.7A)
---
```

**Tags** são termos abstratos de domínio, em inglês, usados para matching por capacidade (ver seção Discovery). Skills sem tags continuam funcionando apenas por triggers.

**Seções TASK_ONLY:**
```markdown
<!-- TASK_ONLY_START -->
Referência detalhada (removida quando skill é secundária)
<!-- TASK_ONLY_END -->
```

---

## Componentes do Sistema

### SkillLoader (`src/skills/SkillLoader.ts`)

**Responsabilidade:** Hot-reload de skills do filesystem.

- Lê `./skills/*/SKILL.md` a cada chamada de `loadAll()`
- Parseia frontmatter YAML (suporta inline CSV e lista YAML para `tags`)
- Retorna `Skill[]` com `content` (completo) e `globalContent` (sem TASK_ONLY)
- **Não tem cache persistente** — cada `loadAll()` relê o disco

**Instâncias em produção:**
- `AgentLoop` → instância própria (passada via construtor)
- `GoalPlanner` → instância própria (`new SkillLoader()`)

> ⚠️ Duas instâncias com cache independente. Mudanças em SKILL.md podem ser vistas com latências diferentes. Consolidação planejada para Sprint 3.8.

---

### SkillDiscovery (`src/skills/SkillDiscovery.ts`) — Sprint 3.7A

**Responsabilidade:** Matching de skills por capacidade de domínio.

Separa a linguagem do usuário das capacidades disponíveis:

```
"criar apresentação para aula"   → capabilities: {criar, apresenta, aula}
tags pptx-generator: presentation, slides → normalized: {presentation, slide}
Intersecção: {apresenta ≈ presentation} → MATCH
```

**Funções exportadas:**
- `normalizeToken(t)` — remove acentos, lowercase, stemming leve PT-BR
- `inferCapabilities(text)` — extrai Set de tokens normalizados do objetivo
- `expandSkillCapabilities(skill)` — normaliza tags + tokens da descrição de uma skill
- `matchSkillByCapabilities(skill, caps)` — calcula score de match (0..1)
- `discoverSkills(skills, query)` — combina trigger match + capability match

**Critérios de design:**
- Zero dependências externas
- Zero chamadas LLM
- Zero regras hardcoded por domínio
- Skills sem `tags` → apenas trigger match (retrocompatível)

---

### SkillInstaller (`src/skills/SkillInstaller.ts`)

**Responsabilidade:** Instalação de skills externas.

- Clone via git, npm install, npx run
- Whitelist-based security (não blacklist)
- Timeout protection

---

### SkillLearner (`src/loop/SkillLearner.ts`)

**Responsabilidade:** Geração automática de skills por padrão de uso.

- SQLite: tabelas `auto_skills` + `skill_patterns`
- Registra cada execução de tool com userText, toolName, success, latency
- Propõe skills quando pattern atinge ≥3 sucessos, ≥80% taxa de sucesso
- Skills propostas ficam em status `'proposed'` até revisão manual
- **Universo separado do SkillLoader**: skills geradas ficam em SQLite, não em SKILL.md

---

## Fluxo de Injeção por Quadrante

### Q1 — Contextualização (Sprint 3.7A)

```typescript
// GoalExecutionLoop.contextualize()
const discovery = discoverSkills(availableSkills, goal.userIntent);
if (discovery.all.length > 0) {
    parts.push(`Skills especializadas disponíveis: ${names}. Priorize-as.`);
    log.info(`[SKILL-DISCOVERY] goal= capabilities= matched_skills= source=local`);
}
```

**Responsabilidade:** Informar o planner sobre skills relevantes antes de planejar.

---

### Q2 — Análise de Riscos (Sprint 3.7A)

```typescript
// RiskAnalyzer.analyze()
// [SKILL-HINT] quando exec_command é coberto por skill instalada
log.info(`[SKILL-HINT] goal= step= skill= reason=exec_command_covered_by_skill`);
```

**Responsabilidade:** Detectar quando o plano usa exec_command para algo que uma skill já cobre com instruções melhores. **Apenas observabilidade — não bloqueia.**

---

### Q3 — Execução

```typescript
// AgentLoop.getSkillContextForQuery()
const discovery = discoverSkills(skills, query);
// Trigger match → content completo (se isPrimary) ou globalContent
// Capability match → globalContent
log.info(`[SKILL-MATCH] query= skill= matched_by=trigger|tag score= terms=`);
```

**Responsabilidade:** Injetar instruções das skills relevantes no prompt do AgentLoop durante execução de steps.

```typescript
// GoalPlanner.plan() / replan()
// Recebe skillContext como "INSTRUÇÕES DE SKILL ATIVAS"
const skillBlock = skillContext
    ? `\nINSTRUÇÕES DE SKILL ATIVAS (siga rigorosamente):\n${skillContext}\n`
    : '';
```

---

### Q4 — Validação (Sprint 3.6D)

```typescript
// GoalExecutionLoop.runSkillValidators()
// content-validator skill pode ser invocada programaticamente
// via ToolRegistry para validar artefatos antes de aceitar achieved=true
log.info(`[SKILL-VALIDATOR] goal= skill= file= passed=`);
```

**Responsabilidade:** Verificação de qualidade de artefatos gerados. Hook registrado em `SKILL_VALIDATORS` map.

---

## Logs de Observabilidade

| Log | Emitido por | Significado |
|---|---|---|
| `[SKILLLOAD]` | SkillLoader | Skills carregadas do disco |
| `[SKILL-MATCH]` | AgentLoop | Query fez match com skill |
| `[SKILL-DISCOVERY]` | GoalExecutionLoop | Skills descobertas em Q1 |
| `[SKILL-HINT]` | RiskAnalyzer | exec_command coberto por skill em Q2 |
| `[SKILL-VALIDATOR]` | GoalExecutionLoop | Skill validou artefato em Q4 |
| `[SKILL-CONTEXT]` | GoalPlanner | Skills injetadas no prompt |

---

## Ciclo de Vida de uma Skill

```
1. Criação manual: skills/{nome}/SKILL.md com frontmatter
2. Carregamento: SkillLoader.loadAll() (hot-reload)
3. Discovery: trigger match + capability match (SkillDiscovery)
4. Injeção Q1: contextualize() → hint para o planner
5. Injeção Q3: getSkillContextForQuery() → instruções no prompt
6. Verificação Q4: runSkillValidators() → validação de artefatos
```

Skills auto-geradas seguem outro ciclo:
```
SkillLearner: pattern detectado → skill proposta (SQLite)
Admin: revisão manual → status 'active'
→ injetado via UnifiedIntentRouter (não via SkillLoader)
```

---

## Pontos de Evolução Futuros

### Sprint 3.8 — Consolidação de instâncias

Eliminar as duas instâncias de SkillLoader em produção. Proposta:

```typescript
// SkillLoader singleton com TTL configurável
const skillLoader = SkillLoader.getInstance({ ttlMs: 60_000 });
```

Benefício: cache único, consistência garantida, 1 disk read por TTL.

### Sprint 3.9 — SkillLearner + SkillLoader unificados

Auto-skills aprovadas pelo admin deveriam gerar automaticamente um arquivo SKILL.md no diretório de skills, entrando no hot-reload do SkillLoader. Hoje são universos separados.

### Sprint 3.10 — External Discovery

Quando nenhuma skill local faz match, informar o usuário: *"Nenhuma skill local para este domínio. O skill-manager pode buscar em catálogos externos."* Sem chamada automática de rede no caminho crítico.

---

## Critérios para Nova Skill

Para que uma nova skill seja automaticamente descobrível:

1. Criar `skills/{nome}/SKILL.md` com frontmatter válido
2. Definir `tags` como termos abstratos de domínio em inglês
3. Definir `triggers` como palavras-chave em português e inglês
4. O sistema detecta na próxima chamada a `loadAll()` (hot-reload, sem restart)

Nenhuma alteração de código necessária.
