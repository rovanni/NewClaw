# SPRINT 3.7A — Implementation Report

**Data:** 2026-06-01  
**Status:** Implementado — TypeScript OK, 20/20 testes passando

---

## Resumo

Implementação da evolução do sistema de Skills conforme proposta arquitetural aprovada (CURRENT_STATE.md + SKILL_DISCOVERY_PROPOSAL.md). Nenhum novo subsistema, registry ou banco de dados criado.

---

## Arquivos Modificados

| Arquivo | Tipo | O que mudou |
|---|---|---|
| `src/skills/SkillDiscovery.ts` | **Novo** | Módulo de capability inference e matching |
| `src/skills/__tests__/SkillDiscovery.test.ts` | **Novo** | 20 testes automatizados |
| `src/skills/SkillLoader.ts` | Modificado | Campo `tags` na interface + parsing inline CSV e lista YAML |
| `src/loop/GoalPlanner.ts` | Modificado | Método `getAvailableSkills()` |
| `src/loop/AgentLoop.ts` | Modificado | `getSkillContextForQuery()` usa `discoverSkills()` + `[SKILL-MATCH]` |
| `src/loop/GoalExecutionLoop.ts` | Modificado | `contextualize()` com Q1 skill discovery + `[SKILL-DISCOVERY]` |
| `src/loop/RiskAnalyzer.ts` | Modificado | `analyze()` aceita `availableSkills` + `[SKILL-HINT]` em Q2 |
| `skills/pptx-generator/SKILL.md` | Modificado | Campo `tags` adicionado |
| `skills/html-pdf-converter/SKILL.md` | Modificado | Campo `tags` adicionado |
| `skills/content-validator/SKILL.md` | Modificado | Campo `tags` adicionado |
| `skills/skill-auditor/SKILL.md` | Modificado | Campo `tags` adicionado |
| `skills/skill-manager/SKILL.md` | Modificado | Campo `tags` adicionado |
| `skills/system-provisioner/SKILL.md` | Modificado | Campo `tags` adicionado |
| `docs/README.md` | **Novo** | Índice da documentação técnica |
| `docs/skills/SKILL_SYSTEM_ARCHITECTURE.md` | **Novo** | Arquitetura completa do sistema de Skills |
| `docs/CURRENT_STATE.md` | Movido (era raiz) | |
| `docs/SKILL_DISCOVERY_PROPOSAL.md` | Movido (era raiz) | |
| `docs/SPRINT_3_6D_EXECUTION_INTEGRITY.md` | Movido (era raiz) | |

---

## Fase 1 — Organização da Documentação

Criado `docs/README.md` com índice de toda a documentação técnica.

Movidos para `/docs`:
- `CURRENT_STATE.md`
- `SKILL_DISCOVERY_PROPOSAL.md`
- `SPRINT_3_6D_EXECUTION_INTEGRITY.md`

Criado `docs/skills/SKILL_SYSTEM_ARCHITECTURE.md` com arquitetura completa do sistema de Skills, fluxo por quadrante, logs de observabilidade, instâncias existentes e pontos de evolução futura.

---

## Fase 2 — Evolução das Skills

### Mudança 1 — Campo `tags` no SkillLoader

Interface `SkillMeta` agora inclui:
```typescript
tags?: string[];  // domínios de capacidade (genéricos, em inglês)
```

Parser suporta dois formatos:
```yaml
# Formato inline CSV (mais simples):
tags: presentation, slides, export, document-generation

# Formato lista YAML (mais legível):
tags:
  - presentation
  - slides
```

Skills sem `tags` continuam funcionando exatamente como antes — retrocompatibilidade total.

### Mudança 2 — SkillDiscovery (capability-based matching)

Módulo `src/skills/SkillDiscovery.ts` com funções puras:

```typescript
normalizeToken("apresentações")  → "apresentacao"
normalizeToken("slides")         → "slide"
normalizeToken("PDF")            → "pdf"
```

```typescript
inferCapabilities("criar slides html para aula")
  → Set{"criar", "slide", "html", "para", "aula"}
```

```typescript
discoverSkills(skills, "criar apresentação para aula")
  → {
      byTrigger: [],                           // nenhum trigger exato
      byCapability: [{                         // capability match
          skillName: 'pptx-generator',
          score: 0.33,
          matchedTerms: ['apresenta'],
          matchedBy: 'tag'
      }],
      all: [pptx-generator]
  }
```

**A separação linguagem→domínio funciona:**
- "criar apresentação" → normalizado → "apresenta"
- pptx-generator description: "apresentações" → normalizado → "apresentaca"  
- pptx-generator tags: "presentation" → normalizado → "presentation"
- Intersecção no espaço normalizado → match

### Mudança 3 — Skill Hint em Q1

```typescript
// GoalExecutionLoop.contextualize()
[SKILL-DISCOVERY] goal=xxx capabilities=slide,html matched_skills=pptx-generator source=local cycle=1
```

O contexto de Q1 agora inclui: `"Skills especializadas disponíveis: pptx-generator. O planner já recebeu as instruções dessas skills. Priorize-as."`

O planner recebe esse hint pelo q1Context E as instruções da skill pelo skillContext. Dois vetores de informação independentes.

### Mudança 4 — Skill Hint em Q2

```typescript
// RiskAnalyzer.analyze()
[SKILL-HINT] goal=xxx step=step_3 skill=pptx-generator reason=exec_command_covered_by_skill command="marp slides.md -o slides.pptx"
```

Apenas observabilidade — não bloqueia, não modifica o plano.

---

## Logs Novos

```
[SKILL-MATCH]      skill= matched_by=trigger|tag score= terms=
[SKILL-DISCOVERY]  goal= capabilities= matched_skills= source=local cycle=
[SKILL-HINT]       goal= step= skill= reason= command=
```

---

## Testes Automatizados

**Arquivo:** `src/skills/__tests__/SkillDiscovery.test.ts`

**Executar:** `npx ts-node src/skills/__tests__/SkillDiscovery.test.ts`

**Resultado:** 20/20 passaram

| Caso | Input | Resultado |
|---|---|---|
| Normalização | "apresentações", "slides", "PDF" | tokens normalizados corretos |
| inferCapabilities | "criar slides html para aula" | {slide, html, ...} sem tokens curtos |
| Caso 1 | "criar slides html" | pptx-generator descoberta por capability |
| Caso 2 | "criar apresentação para aula" | pptx-generator descoberta sem mencionar PPTX |
| Caso 3 | "gerar documento PDF" | html-pdf-converter descoberta |
| Caso 4 | "temperatura em são paulo" | nenhuma descoberta, sem erro |
| Caso 5 | skill sem tags + trigger exato | trigger ainda funciona |

---

## Evidências de Funcionamento

### Cenário: "criar apresentação para aula" (sem trigger exato)

**Antes da Sprint 3.7A:**
```
getSkillContextForQuery: trigger match → []
skillContext = ''
GoalPlanner: sem instrução especializada
→ LLM usa abordagem genérica
```

**Depois:**
```
discoverSkills("criar apresentação para aula")
  byCapability: [{pptx-generator, score: 0.33, terms: ['apresenta']}]
[SKILL-MATCH] skill=pptx-generator matched_by=tag score=0.33 terms=apresenta

contextualize():
[SKILL-DISCOVERY] matched_skills=pptx-generator source=local
→ contexto inclui: "Skills especializadas: pptx-generator. Priorize-as."

GoalPlanner:
  skillContext = "### SKILL: pptx-generator\n..."
  q1Context += "Skills especializadas: pptx-generator..."
→ LLM planeja usando Marp, steps especializados
```

### Cenário: "qual a temperatura amanhã" (sem skill)

```
discoverSkills: byTrigger=[], byCapability=[]
[SKILL-DISCOVERY] matched_skills=none note=no_local_skill_for_domain
→ sem alteração no fluxo
```

---

## Riscos e Limitações

| Item | Detalhe |
|---|---|
| False positives de capability | Score mínimo 0.15 filtra ruído. Pode ser ajustado em `discoverSkills(skills, q, { minScore: X })` |
| Tags em inglês vs texto em PT | Normalização de diacríticos resolve maioria dos casos. "apresentação" → "apresentacao" pode não bater com "presentation" mas bate com description da skill |
| Duas instâncias de SkillLoader | Não resolvido nesta sprint. Planejado para Sprint 3.8 |
| SkillLearner isolado | Auto-skills não entram no capability matching. Planejado para Sprint 3.9 |

---

## Próximas Evoluções Recomendadas

1. **Sprint 3.8 — SkillLoader Singleton:** Eliminar as duas instâncias independentes. Singleton com TTL configurável compartilhado entre AgentLoop e GoalPlanner.

2. **Sprint 3.8 — Tags do SkillLearner:** Skills auto-geradas pelo SkillLearner deveriam ter tags inferidas automaticamente pelo padrão detectado. Ativar capability matching para auto-skills.

3. **Sprint 3.9 — External Discovery (passivo):** Quando `matched_skills=none` e objetivo for complexo, adicionar ao contexto Q1: "Nenhuma skill local — use skill-manager para buscar em catálogos externos." Sem chamada de rede no caminho crítico.

4. **Sprint 3.10 — Score threshold por domínio:** Permitir configuração de `minScore` por categoria de domínio. Ex: domains de segurança exigem score mais alto para evitar ativação acidental.
