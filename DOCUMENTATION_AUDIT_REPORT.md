# DOCUMENTATION_AUDIT_REPORT — Auditoria da Documentação

**Data:** 2026-06-01  
**Escopo:** Todos os arquivos `.md` do projeto (excluindo node_modules)  
**Objetivo:** Mapear convenções existentes antes de mover qualquer documento

---

## 1. Estrutura Documental Atual

### Raiz do projeto

| Arquivo | Linhas | Data | Finalidade |
|---|---|---|---|
| `README.md` | 230 | — | README principal do projeto |
| `README.es.md` | 230 | — | README em Espanhol |
| `README.pt-br.md` | 230 | — | README em Português |
| `SPRINT_3_7A_IMPLEMENTATION_REPORT.md` | 218 | 2026-06-01 | Relatório de implementação — Sprint 3.7A |

### /docs (raiz)

| Arquivo | Linhas | Data | Finalidade |
|---|---|---|---|
| `docs/README.md` | 35 | 2026-06-01 | Índice da documentação *(criado em Sprint 3.7A)* |
| `docs/ROADMAP.md` | 33 | 2026-04-27 | Roadmap estratégico do projeto |
| `docs/walkthrough.md` | 158 | 2026-04-17 | Walkthrough da evolução da memória cognitiva |
| `docs/task.md` | 44 | 2026-04-13 | Lista de tarefas do desenvolvimento cognitivo |
| `docs/plano-correcao-bugs.md` | 155 | 2026-05-20 | Plano de correção de 20 bugs identificados |
| `docs/CURRENT_STATE.md` | 238 | 2026-06-01 | Estado atual do sistema de Skills *(movido em Sprint 3.7A)* |
| `docs/SKILL_DISCOVERY_PROPOSAL.md` | 438 | 2026-06-01 | Proposta de Skill Discovery *(movido em Sprint 3.7A)* |
| `docs/SPRINT_3_6_IMPLEMENTATION_REPORT.md` | 331 | 2026-06-01 | Relatório de implementação — Sprint 3.6 |
| `docs/SPRINT_3_6D_EXECUTION_INTEGRITY.md` | 296 | 2026-06-01 | Relatório de implementação — Sprint 3.6D *(movido em Sprint 3.7A)* |

### /docs/Auditorias (pré-existente)

| Arquivo | Linhas | Data | Finalidade |
|---|---|---|---|
| `docs/Auditorias/01/ARCHITECTURE_REVIEW.md` | 391 | — | Revisão arquitetural completa — Parte 7 |
| `docs/Auditorias/01/AUDITORIA_ARQUITETURAL_COMPLETA.md` | 560 | — | Auditoria arquitetural consolidada |
| `docs/Auditorias/01/AUDIT_PART1.md` | 443 | — | Auditoria — Parte 1 |
| `docs/Auditorias/01/AUDIT_PART2.md` | 442 | — | Auditoria — Parte 2 |
| `docs/Auditorias/01/AUDIT_PART3.md` | 478 | — | Auditoria — Parte 3 |
| `docs/Auditorias/01/AUDIT_PART4.md` | 561 | — | Auditoria — Parte 4 |
| `docs/Auditorias/02/AUDIT_CHECKLIST_2026-05-15.md` | 130 | 2026-05-15 | Checklist de auditoria automatizada |

### /docs/issues (pré-existente)

| Arquivo | Linhas | Data | Finalidade |
|---|---|---|---|
| `docs/issues/001-llm-inconsistent-tool-selection.md` | 58 | 2026-04-16 | Issue: decisão inconsistente de tools pelo LLM |

### /docs/melhorias (pré-existente)

| Arquivo | Linhas | Data | Finalidade |
|---|---|---|---|
| `docs/melhorias/performance-e-latencia-2026-05-20.md` | 289 | 2026-05-20 | Diagnóstico de performance e latência |
| `docs/melhorias/Memoria_Melhorias/arquitetura_cognitiva_status.md` | 643 | 2026-05-19 | Status das melhorias de arquitetura cognitiva |

### /docs/skills (criado em Sprint 3.7A)

| Arquivo | Linhas | Data | Finalidade |
|---|---|---|---|
| `docs/skills/SKILL_SYSTEM_ARCHITECTURE.md` | 246 | 2026-06-01 | Arquitetura completa do sistema de Skills |

### /docs/sprints (criado em Sprint 3.7A — vazio)

```
docs/sprints/   ← diretório existe mas está vazio
```

### /docs/assets (pré-existente)

```
docs/assets/
├── banner.png
├── architecture-flow.svg
├── install-flow.svg
├── newclaw-graph-2x.png
└── dashboard-graph.png
```

---

## 2. Convenções Identificadas

### Convenção A — Auditorias numeradas

**Padrão:** `docs/Auditorias/{NN}/`  
**Exemplo:** `docs/Auditorias/01/`, `docs/Auditorias/02/`  
**Nomenclatura de arquivos:** SCREAMING_SNAKE_CASE (`AUDIT_PART1.md`, `ARCHITECTURE_REVIEW.md`)  
**Conteúdo:** Deep dives arquiteturais, revisões completas de código, checklists  
**Maturidade:** Estabelecida (2 sessões, 7 arquivos, ~2900 linhas)

### Convenção B — Issues numeradas

**Padrão:** `docs/issues/{NNN}-{kebab-case}.md`  
**Exemplo:** `docs/issues/001-llm-inconsistent-tool-selection.md`  
**Nomenclatura:** Prefixo numérico + lowercase kebab-case  
**Conteúdo:** Bugs e problemas técnicos rastreados  
**Maturidade:** Estabelecida (1 arquivo — padrão claro)

### Convenção C — Melhorias por data

**Padrão:** `docs/melhorias/{nome}-{YYYY-MM-DD}.md`  
**Exemplo:** `docs/melhorias/performance-e-latencia-2026-05-20.md`  
**Nomenclatura:** lowercase kebab-case com data no sufixo  
**Conteúdo:** Análises de performance, diagnósticos, planos de melhoria  
**Maturidade:** Parcial (1 arquivo direto + 1 subpasta com convenção diferente)

### Convenção D — Sprint Reports (emergente, incompleta)

**Padrão desejado:** `docs/sprints/SPRINT_{version}_{name}.md`  
**Exemplo:** `SPRINT_3_6_IMPLEMENTATION_REPORT.md`, `SPRINT_3_6D_EXECUTION_INTEGRITY.md`  
**Nomenclatura:** SCREAMING_SNAKE_CASE  
**Status atual:** Arquivos estão em `docs/` root e em raiz do projeto. Pasta `docs/sprints/` existe mas está **vazia**.  
**Maturidade:** Intencionada (pasta criada) mas **não executada**

### Convenção E — Skills docs (emergente)

**Padrão:** `docs/skills/{NOME}.md`  
**Exemplo:** `docs/skills/SKILL_SYSTEM_ARCHITECTURE.md`  
**Status atual:** Apenas 1 arquivo. `CURRENT_STATE.md` e `SKILL_DISCOVERY_PROPOSAL.md` (também sobre Skills) estão em `docs/` root.  
**Maturidade:** Iniciada mas **incompleta**

---

## 3. Problemas Encontrados

### Problema 1 — `docs/sprints/` existe e está vazia

A Sprint 3.7A criou a pasta `docs/sprints/` mas não moveu nenhum relatório para ela. Resultado: pasta fantasma sem conteúdo. Os relatórios de sprint estão espalhados:

```
docs/SPRINT_3_6_IMPLEMENTATION_REPORT.md    ← deveria estar em docs/sprints/
docs/SPRINT_3_6D_EXECUTION_INTEGRITY.md     ← deveria estar em docs/sprints/
SPRINT_3_7A_IMPLEMENTATION_REPORT.md        ← deveria estar em docs/sprints/
```

### Problema 2 — Docs de Skills fragmentadas em duas localizações

Três documentos relacionados ao sistema de Skills estão em locais diferentes:

```
docs/CURRENT_STATE.md                       ← sobre Skills, mas em docs/ root
docs/SKILL_DISCOVERY_PROPOSAL.md            ← sobre Skills, mas em docs/ root
docs/skills/SKILL_SYSTEM_ARCHITECTURE.md    ← sobre Skills, na pasta correta
```

### Problema 3 — `docs/melhorias/Memoria_Melhorias/` usa PascalCase

Inconsistência de nomenclatura: todos os outros diretórios em `docs/melhorias/` seriam lowercase, mas `Memoria_Melhorias/` usa PascalCase com underscores.

```
docs/melhorias/performance-e-latencia-2026-05-20.md   ← lowercase kebab (ok)
docs/melhorias/Memoria_Melhorias/                      ← PascalCase (inconsistente)
```

### Problema 4 — `docs/task.md` é efêmero

`docs/task.md` é uma lista de tarefas de desenvolvimento (checklists de features já concluídas). Não é documentação técnica permanente — é um artefato de trabalho histórico. Não pertence a `docs/` da mesma forma que documentação arquitetural.

### Problema 5 — Raiz de `docs/` acumulou arquivos que têm pastas específicas

Após as criações de `docs/skills/` e `docs/sprints/`, a raiz de `docs/` ainda carrega:
- 2 sprint reports (deveriam estar em `docs/sprints/`)
- 2 docs de Skills (deveriam estar em `docs/skills/`)

### Problema 6 — Sem Índice Adequado

O `docs/README.md` foi criado em Sprint 3.7A mas aponta para arquivos em localizações que serão movidas. Precisará ser atualizado após a reorganização.

---

## 4. Estruturas Duplicadas

| Categoria | Localização A | Localização B | Conflito |
|---|---|---|---|
| Sprint Reports | `docs/SPRINT_3_6*.md` | `docs/sprints/` (vazia) | Pastas concorrentes |
| Skills Docs | `docs/CURRENT_STATE.md`, `docs/SKILL_DISCOVERY_PROPOSAL.md` | `docs/skills/` | Docs da mesma categoria em lugares diferentes |

---

## 5. Plano de Reorganização

**Princípio:** Completar as convenções já iniciadas, sem criar novas taxonomias.

### 5.1 Categorização de cada documento

| Documento | Categoria | Destino proposto | Justificativa |
|---|---|---|---|
| `SPRINT_3_7A_IMPLEMENTATION_REPORT.md` (raiz) | Sprint report | `docs/sprints/` | Convenção D iniciada em Sprint 3.7A |
| `docs/SPRINT_3_6_IMPLEMENTATION_REPORT.md` | Sprint report | `docs/sprints/` | Convenção D iniciada em Sprint 3.7A |
| `docs/SPRINT_3_6D_EXECUTION_INTEGRITY.md` | Sprint report | `docs/sprints/` | Convenção D iniciada em Sprint 3.7A |
| `docs/CURRENT_STATE.md` | Skills docs | `docs/skills/` | Mesma categoria que SKILL_SYSTEM_ARCHITECTURE.md |
| `docs/SKILL_DISCOVERY_PROPOSAL.md` | Skills docs | `docs/skills/` | Mesma categoria que SKILL_SYSTEM_ARCHITECTURE.md |
| `docs/melhorias/Memoria_Melhorias/` | Melhoria | renomear para `docs/melhorias/memoria/` | Consistência de nomenclatura lowercase |
| `docs/README.md` | Índice | atualizar links | Após movimentações, links mudarão |
| `docs/ROADMAP.md` | Estratégia | manter em `docs/` | Documento top-level correto |
| `docs/walkthrough.md` | Tutorial | manter em `docs/` | Documento de onboarding, nível root |
| `docs/plano-correcao-bugs.md` | Plano técnico | manter em `docs/` | Não é um issue rastreável, é um plano |
| `docs/task.md` | Efêmero | manter ou arquivar | Lista histórica de tasks concluídas |
| `README.md`, `README.es.md`, `README.pt-br.md` | README público | manter na raiz | Convenção universal de projetos Open Source |

### 5.2 Mapeamento origem → destino

```
SPRINT_3_7A_IMPLEMENTATION_REPORT.md
  → docs/sprints/SPRINT_3_7A_IMPLEMENTATION_REPORT.md

docs/SPRINT_3_6_IMPLEMENTATION_REPORT.md
  → docs/sprints/SPRINT_3_6_IMPLEMENTATION_REPORT.md

docs/SPRINT_3_6D_EXECUTION_INTEGRITY.md
  → docs/sprints/SPRINT_3_6D_EXECUTION_INTEGRITY.md

docs/CURRENT_STATE.md
  → docs/skills/CURRENT_STATE.md

docs/SKILL_DISCOVERY_PROPOSAL.md
  → docs/skills/SKILL_DISCOVERY_PROPOSAL.md

docs/melhorias/Memoria_Melhorias/
  → docs/melhorias/memoria/
```

### 5.3 Estrutura resultante

```
/                               ← projeto root
├── README.md                   (manter)
├── README.es.md                (manter)
├── README.pt-br.md             (manter)
│
docs/
├── README.md                   (atualizar links após movimentação)
├── ROADMAP.md                  (manter)
├── walkthrough.md              (manter)
├── plano-correcao-bugs.md      (manter)
├── task.md                     (manter)
│
├── assets/                     (manter como está)
│
├── Auditorias/                 (manter como está)
│   ├── 01/ (6 arquivos)
│   └── 02/ (1 arquivo)
│
├── issues/                     (manter como está)
│   └── 001-llm-inconsistent-tool-selection.md
│
├── melhorias/                  (atenção: renomear subpasta)
│   ├── performance-e-latencia-2026-05-20.md
│   └── memoria/                ← renomear de "Memoria_Melhorias"
│       └── arquitetura_cognitiva_status.md
│
├── skills/                     (consolidar aqui os docs de Skills)
│   ├── CURRENT_STATE.md        ← mover de docs/
│   ├── SKILL_DISCOVERY_PROPOSAL.md  ← mover de docs/
│   └── SKILL_SYSTEM_ARCHITECTURE.md (já aqui)
│
└── sprints/                    (completar o que Sprint 3.7A iniciou)
    ├── SPRINT_3_6_IMPLEMENTATION_REPORT.md   ← mover de docs/
    ├── SPRINT_3_6D_EXECUTION_INTEGRITY.md    ← mover de docs/
    └── SPRINT_3_7A_IMPLEMENTATION_REPORT.md  ← mover da raiz
```

---

## 6. Justificativa Arquitetural

**Por que `docs/sprints/` e não outro nome?**  
A pasta `docs/sprints/` já existe (criada em Sprint 3.7A). Usar outro nome criaria exatamente o problema que a spec proíbe: duas estruturas concorrentes. O correto é completar o que foi iniciado.

**Por que `docs/skills/` consolida os três documentos de Skills?**  
`CURRENT_STATE.md` e `SKILL_DISCOVERY_PROPOSAL.md` são sobre o sistema de Skills. `SKILL_SYSTEM_ARCHITECTURE.md` já está em `docs/skills/`. Agrupar por assunto é mais fácil para navegar do que agrupar por tipo (state vs proposal vs architecture).

**Por que não criar `docs/architecture/`?**  
`docs/Auditorias/` já existe e cobre o papel de revisões arquiteturais profundas. Criar `docs/architecture/` seria uma estrutura paralela.

**Por que `ROADMAP.md`, `walkthrough.md` e `plano-correcao-bugs.md` ficam na raiz de `docs/`?**  
São documentos de referência geral do projeto — não pertencem a nenhuma categoria específica como sprints ou skills. A raiz de `docs/` é o nível correto para eles.

**Por que renomear `Memoria_Melhorias/` para `memoria/`?**  
Consistência. Todos os outros arquivos em `docs/melhorias/` usam lowercase kebab-case. `Memoria_Melhorias/` usa PascalCase por inconsistência histórica, não por convenção intencional.

---

## 7. O Que NÃO Será Movido

| Documento | Motivo |
|---|---|
| `README.md`, `README.es.md`, `README.pt-br.md` | Convenção universal Open Source — devem estar na raiz |
| `docs/ROADMAP.md` | Documento estratégico top-level, nível correto |
| `docs/walkthrough.md` | Tutorial de onboarding, nível correto |
| `docs/plano-correcao-bugs.md` | Plano técnico genérico, não é um issue rastreável |
| `docs/task.md` | Artefato histórico, baixo impacto em reorganizar |
| `docs/Auditorias/` | Convenção estabelecida e coerente |
| `docs/issues/` | Convenção estabelecida e coerente |
| `docs/assets/` | Assets visuais, sem reorganização necessária |

---

## 8. Operações Pendentes de Aprovação

Antes de executar qualquer movimentação, confirme o plano acima.

As operações propostas são:

```bash
# 1. Completar docs/sprints/ (pasta já existe, vazia)
mv SPRINT_3_7A_IMPLEMENTATION_REPORT.md docs/sprints/
mv docs/SPRINT_3_6_IMPLEMENTATION_REPORT.md docs/sprints/
mv docs/SPRINT_3_6D_EXECUTION_INTEGRITY.md docs/sprints/

# 2. Consolidar docs/skills/
mv docs/CURRENT_STATE.md docs/skills/
mv docs/SKILL_DISCOVERY_PROPOSAL.md docs/skills/

# 3. Corrigir nomenclatura em melhorias/
mv docs/melhorias/Memoria_Melhorias docs/melhorias/memoria

# 4. Atualizar docs/README.md com novos links
```

**Total de movimentações:** 6 arquivos + 1 renomeação de diretório + 1 atualização de links  
**Arquivos que permanecem na raiz do projeto:** README.md, README.es.md, README.pt-br.md  
**Novas pastas criadas:** Nenhuma (todas já existem)
