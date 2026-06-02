# CURRENT_STATE — Sistema de Skills do NewClaw

**Data:** 2026-06-01  
**Baseado em:** Auditoria arquitetural completa do código-fonte

---

## 1. Arquitetura Atual do Sistema de Skills

### 1.1 Componentes

```
skills/
├── pptx-generator/SKILL.md
├── html-pdf-converter/SKILL.md
├── content-validator/SKILL.md
├── skill-auditor/SKILL.md
├── skill-manager/SKILL.md
└── system-provisioner/SKILL.md

src/skills/
├── SkillLoader.ts       — carregamento e parsing
└── SkillInstaller.ts    — instalação via git/npm

src/loop/
└── SkillLearner.ts      — geração automática de skills por padrão
```

### 1.2 Estrutura de uma Skill

Arquivo: `skills/{nome}/SKILL.md`

```yaml
---
name: pptx-generator
description: Converte apresentações para PowerPoint
version: "1.0"
triggers: powerpoint, pptx, slides editáveis, apresentação editável, marp
tools: exec_command, write, read, send_document
---

# Conteúdo da skill (instruções para o LLM)
...
<!-- TASK_ONLY_START -->
# Referência detalhada (removida quando skill é secundária)
...
<!-- TASK_ONLY_END -->
```

**Interface Skill:**
```typescript
interface Skill {
    name: string;         // identificador único
    description: string;  // descrição curta (usada no sumário do planner)
    version?: string;
    triggers?: string[];  // palavras-chave para match
    tools?: string[];     // tools que a skill prefere usar
    content: string;      // conteúdo completo (com TASK_ONLY)
    globalContent: string;// conteúdo sem TASK_ONLY (para uso secundário)
}
```

---

## 2. Fluxo Atual de Execução

### 2.1 Pipeline de Injeção

```
Mensagem do usuário
        ↓
GoalOrchestrator.process()
        ↓
agentLoop.getSkillContextForQuery(userMessage)
        ↓
SkillLoader.loadAll()          ← lê ./skills/*/SKILL.md (hot-reload)
        ↓
Filter por triggers            ← substring match, case-insensitive
"powerpoint" in triggers?  →  match
"pptx" in triggers?        →  match
        ↓
Para cada skill matched:
  - isPrimary? (confidence ≥ 0.75 && único match) → injetar content completo
  - Caso contrário → injetar globalContent (sem TASK_ONLY)
        ↓
Concatenar: "### SKILL: {name}\n{content}"
        ↓
GoalExecutionLoop.setSkillContext(skillContext)
        ↓
GoalPlanner.setSkillContext(skillContext)
        ↓
buildPlanPrompt / buildReplanPrompt / buildRoadmapPrompt:
  "INSTRUÇÕES DE SKILL ATIVAS (siga rigorosamente):\n{skillContext}"
```

### 2.2 Participação por Quadrante

| Quadrante | Participação Atual | Como |
|---|---|---|
| **Q1** (Contextualização) | ✅ Indireta | skillContext é setado antes da contextualização, está disponível no planner |
| **Q2** (Risco) | ❌ Nenhuma | RiskAnalyzer não consulta skills |
| **Q3** (Execução) | ✅ Direta | AgentLoop carrega skills por trigger durante execução de steps |
| **Q4** (Validação) | ❌ Nenhuma | validateGoalCompletion não usa skills |

### 2.3 Dois Pontos de Carregamento Independentes

**Ponto A — GoalOrchestrator (pré-goal):**
```typescript
// Para injetar no GoalPlanner via setSkillContext()
const skillContext = agentLoop.getSkillContextForQuery(message);
executionLoop.setSkillContext(skillContext);
```

**Ponto B — AgentLoop (durante step):**
```typescript
// Carregamento direto por trigger no loop interno
const manualSkills = this.skillLoader.loadAll();
const matched = manualSkills.filter(s =>
    s.triggers?.some(t => userText.toLowerCase().includes(t.toLowerCase()))
);
```

**GoalPlanner também tem seu próprio SkillLoader:**
```typescript
// GoalPlanner.ts linha ~390
private readonly skillLoader = new SkillLoader();
private loadSkillsSummary(): string {
    // Cache de 60 segundos — instância independente
    const skills = this.skillLoader.loadAll();
    return skills.map(s => `  - ${s.name}: ${s.description}`).join('\n');
}
```

**Resultado:** 3 instâncias de SkillLoader em execução simultânea. Todas leem o mesmo diretório. Cache TTL independente por instância.

---

## 3. Lacunas Encontradas

### L1 — Match apenas léxico, não semântico

Trigger matching é `string.includes()`:
```typescript
s.triggers?.some(t => query.toLowerCase().includes(t.toLowerCase()))
```

**Problema:** `"criar apresentação para aula"` NÃO ativa a skill `pptx-generator` se os triggers forem `powerpoint, pptx, slides editáveis`. O usuário precisaria dizer exatamente uma das palavras configuradas.

**Impacto:** Skills relevantes são invisíveis para formulações naturais que não coincidem com os triggers.

---

### L2 — Sem descoberta para "skill ausente"

Quando nenhuma skill local faz match, o sistema não:
- Sabe que poderia existir uma skill para aquele domínio
- Consulta fontes externas (skills.sh, catálogos configurados)
- Informa o usuário sobre capacidades potencialmente disponíveis

**Impacto:** Pedidos especializados são tratados como genéricos. O LLM inventa uma abordagem ad-hoc em vez de usar uma skill otimizada que poderia ser instalada.

---

### L3 — RiskAnalyzer não considera skills (Q2)

O plano pode conter passos de `exec_command` que fariam a mesma coisa que uma skill disponível faria melhor. O Q2 não detecta isso.

**Exemplo:** Plano com `exec_command: "pandoc slides.md -o slides.pptx"` quando `pptx-generator` está instalada e tem instruções mais detalhadas. O RiskAnalyzer valida apenas args e dependências, não considera coverage de skills.

---

### L4 — Validação Q4 não usa skills

O `content-validator` existe como skill, mas Q4 (`validateGoalCompletion`) não a invoca automaticamente. Depende do planner ter incluído um step de validação no plano.

---

### L5 — Três instâncias de SkillLoader

- `AgentLoop` → instância própria (via construtor)
- `GoalPlanner` → instância própria (via `new SkillLoader()`)
- `SkillLearner` → gerencia SQLite separado (auto-skills)

Cada instância tem cache independente. Mudança em arquivo SKILL.md pode ser vista com latências diferentes por cada componente.

---

### L6 — SkillLearner não integra com SkillLoader

Skills auto-aprendidas ficam em SQLite (`auto_skills` table). Skills manuais ficam em filesystem (`./skills/*/SKILL.md`). Os dois sistemas não se conversam diretamente.

Um padrão que o SkillLearner detectou e aprovou não resulta automaticamente em um arquivo SKILL.md. São universos paralelos.

---

### L7 — Tags/categorias ausentes no frontmatter

O frontmatter atual tem: `name`, `description`, `version`, `triggers`, `tools`.

Não há: `domain`, `category`, `tags`, `capabilities`. Isso limita qualquer abordagem de matching por domínio ou capacidade.

---

## 4. Duplicações Identificadas

| Duplicação | Componentes | Impacto |
|---|---|---|
| 3× SkillLoader instances | AgentLoop, GoalPlanner, (inicialização) | Cache incoerente, 3 disk reads por evento |
| Skill trigger match em 2 lugares | `getSkillContextForQuery()` + loop interno AgentLoop | Mesmo match feito duas vezes por request |
| `skillsSummary` duplicado | GoalPlanner (lista names+descriptions) e AgentLoop (full skill content) | Dois formatos diferentes da mesma informação |

---

## 5. Riscos Identificados

### R1 — Trigger collision
Dois skills com o mesmo trigger: ambas são injetadas. Prompts conflitantes podem confundir o LLM.

### R2 — Skill content muito longo
Uma skill com conteúdo extenso injeta ~500-2000 tokens no prompt. Múltiplas skills ativas simultaneamente podem estourar o budget de contexto do planner.

### R3 — Hot-reload em produção
`loadAll()` relê o disco a cada chamada. Em high-throughput, isso pode ser lento. O cache do GoalPlanner (60s TTL) mitiga parcialmente mas não no AgentLoop.

### R4 — SKILL.md malformada
Frontmatter inválido ou TASK_ONLY markers não fechados causam comportamento silencioso (skill carregada sem triggers ou com conteúdo incorreto). Não há validação na carga.

---

## 6. O Que Funciona Bem

✅ **Hot-reload real** — adicionar SKILL.md funciona sem restart  
✅ **Separação clara** — skills são instruções de comportamento, não código executável  
✅ **Scoping por confiança** — content vs globalContent evita prompt bloating  
✅ **SkillLearner** — aprendizado autônomo a partir de padrões (pipeline sólido)  
✅ **SkillInstaller** — instalação segura com whitelist e timeout  
✅ **Integração natural com GoalPlanner** — skillContext no prompt do planner é o lugar certo  
✅ **skill-manager skill** — o sistema pode instalar skills via skill (meta-capability)
