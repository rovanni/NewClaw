# SPRINT 3.6D — Execution Integrity Report

**Data:** 2026-06-01  
**Status:** Implementado — TypeScript OK (tsc --noEmit sem erros)

---

## Problema resolvido

O sistema afirmava "A estrutura foi verificada e apresentada ao usuário" sem que nenhuma listagem real houvesse sido executada. O GoalValidator aceitava narrativa do LLM como equivalente a execução de ferramenta.

---

## Princípio arquitetural implementado

```
Alegação textual do LLM ≠ Evidência de execução
```

Toda claim observável ("foi apresentado", "foi enviado", etc.) precisa de attempt correspondente em `goal.attempts` com ferramenta real.

---

## Arquivos alterados

| Arquivo | Correção |
|---|---|
| `src/loop/RiskAnalyzer.ts` | C3: `[STEP-MUTATION]` |
| `src/tools/organize_workspace.ts` | C4: output self-contained |
| `src/loop/GoalExecutionLoop.ts` | C2: diretiva no AgentLoop + C1/C5/C6: validação baseada em evidências |

**Nenhum novo arquivo criado. Nenhuma nova entidade persistente. Usa arquitetura existente.**

---

## Correção 1 — GoalValidator baseado em evidências (C1/C5)

### Arquivo: `src/loop/GoalExecutionLoop.ts`

### Novo método: `checkClaimsAgainstEvidence(goal, llmSummary)`

Após o LLM retornar `achieved=true`, o sistema verifica se as claims presentes no summary têm evidência em `goal.attempts`.

**Regras (genéricas — funcionam para qualquer tool futura):**

| Padrão detectado | Ferramentas aceitas como evidência |
|---|---|
| `foi apresentado/exibido/mostrado/listado` | `list_workspace`, `read`, `read_document`, `exec_command`, `organize_workspace` (com output não-vazio) |
| `foi enviado/entregue` | `send_document`, `send_audio` |
| `foi exportado/convertido` | `exec_command`, `write`, `send_document` |
| `foi organizado/reorganizado` | `organize_workspace`, `exec_command` |
| `foi criado/gerado` | `write`, `exec_command` |

**Comportamento quando claim sem evidência:**
```
[UNVERIFIED-CLAIM] goal=... claim="apresentação/listagem de dados reais"
  missing_evidence="list_workspace" llm_said=achieved_true decision=override_to_false
→ achieved=false
→ replan com blocker: "Alegação não comprovada"
→ sistema executa ferramenta real antes de concluir
```

### Fluxo antes/depois

**Antes:**
```
LLM: "A estrutura foi apresentada."
GoalValidator: achieved=true  ✗ (sem verificação)
Goal: completed
Usuário: não recebeu estrutura
```

**Depois:**
```
LLM: "A estrutura foi apresentada."
checkClaimsAgainstEvidence: detecta claim "foi apresentada"
→ busca attempt [list_workspace|read|exec_command] com output > 10 chars
→ NÃO encontrado
[UNVERIFIED-CLAIM] decision=override_to_false
GoalValidator: achieved=false
replan: "Execute list_workspace para produzir dados antes de afirmar resultado"
→ list_workspace executado
→ LLM repete claim com evidência real
→ checkClaimsAgainstEvidence: evidência encontrada em list_workspace
→ achieved=true  ✓
```

---

## Correção 2 — AgentLoop não pode inventar resultados (C2)

### Arquivo: `src/loop/GoalExecutionLoop.ts`

Quando um step AgentLoop tem descrição contendo intenção observável:
- `mostrar`, `listar`, `apresentar`, `exibir`, `visualizar`, `enviar`, `exportar`, `gerar arquivo`

O sistema injeta no `stepPrompt`:

```
[REGRA DE EXECUÇÃO] Esta tarefa exige ação observável com dados reais.
Chame obrigatoriamente uma ferramenta (list_workspace, read, exec_command,
send_document, etc.) antes de responder.
Não descreva o resultado sem executar a ferramenta que o produz.
```

Log emitido:
```
[AGENTLOOP-EVIDENCE-CHECK] step=step_4 task="apresentar a nova estrutura..."
  requires_tool=true reason=observable_action_in_step_description
```

**Efeito:** O LLM recebe instrução explícita antes de executar. Em vez de gerar prosa, tenderá a chamar a ferramenta apropriada. Se ainda assim não chamar, C1 (GoalValidator) vetará `achieved=true`.

**Dois mecanismos independentes:** C2 é preventivo (impede a geração de narrativa), C1 é corretivo (veta o resultado mesmo se C2 falhar). Defesa em profundidade.

---

## Correção 3 — RiskAnalyzer rastreia mutações de steps (C3)

### Arquivo: `src/loop/RiskAnalyzer.ts`

Quando o RiskAnalyzer converte um step de `toolName` para `agentloop` (por falta de args obrigatórios), emite:

```
[STEP-MUTATION] step=step_4 created_by=risk_analyzer
  original_tool=send_document new_tool=agentloop
  reason="sem 'file_path' obrigatório"
  description="apresente a estrutura ao usuário..."
```

**Impacto:** Torna visível toda divergência entre o plano do Planner e o plano executado. Antes, a conversão era silenciosa além do WARN original.

---

## Correção 4 — organize_workspace self-contained (C4)

### Arquivo: `src/tools/organize_workspace.ts`

O output de `organize_workspace` agora inclui a estrutura top-level do workspace:

```
✅ Organização concluída: 22 arquivo(s) movido(s) em 5 grupo(s).

📁 slides_afn_afd/ — 8 arquivo(s) movido(s)
📁 aula/ — 4 arquivo(s) movido(s)
📁 docs/ — 3 arquivo(s) movido(s)
...

📂 Estrutura atual do workspace (top-level):
   📁 slides_afn_afd/  (8 arquivo(s))
   📁 aula/  (6 arquivo(s))
   📁 docs/  (5 arquivo(s))
   📄 README.md
   ...
```

**Efeito eliminado:** O validator LLM agora vê dados reais no `attemptsContext` (output de organize_workspace). Se o LLM diz "a estrutura foi apresentada", há evidência real (organize_workspace com output não-vazio). C1 aceita a claim.

**Passo de AgentLoop narrativo eliminado:** Não é mais necessário um step `"informar ao usuário e apresentar a nova estrutura"` após organize_workspace. O tool já entrega o resultado completo.

Log novo:
```
[WORKSPACE-ORGANIZE-SUMMARY] files_moved=22 directories_created=4 groups=5 top_level_entries=12
```

---

## Correção 6 — Observabilidade (C6)

### `[GOAL-COMPLETION-REASON]`

Emitido após cada validação LLM:
```
[GOAL-COMPLETION-REASON] goal=goal_xxx achieved=true
  reason="Os arquivos foram movidos e a estrutura foi apresentada."
  supporting_tools="list_workspace,organize_workspace,analyze_workspace_groups"
```

### `[GOAL-EVIDENCE-SUMMARY]`

Emitido após verificação de evidências:
```
[GOAL-EVIDENCE-SUMMARY] goal=goal_xxx
  claims_detected=2 evidence_found=2 missing_evidence=none decision=accept
```

Ou quando falta evidência:
```
[GOAL-EVIDENCE-SUMMARY] goal=goal_xxx
  claims_detected=1 evidence_found=0
  missing_evidence=list_workspace decision=reject
```

---

## Cenários de teste

### Cenário 1 — Bug original (organize + narrativa)

**Input:** `organize a pasta workspace`

**Fluxo esperado com correções:**
```
organize_workspace → executa + retorna estrutura top-level no output ✓
AgentLoop (se existir) → recebe [REGRA DE EXECUÇÃO] → chama list_workspace ✓
validateGoalCompletion → LLM diz "estrutura apresentada"
checkClaimsAgainstEvidence → encontra organize_workspace com output > 10 chars ✓
[GOAL-EVIDENCE-SUMMARY] decision=accept
achieved=true ✓  (com evidência real)
```

### Cenário 2 — LLM afirma "apresentado" sem execução

**Situação:** LLM summary = "A estrutura foi apresentada ao usuário." mas nenhum tool de listagem foi executado.

```
checkClaimsAgainstEvidence:
  pattern "foi apresentada" → match
  busca attempts [list_workspace|read|exec_command] → NOT FOUND
[UNVERIFIED-CLAIM] decision=override_to_false
achieved=false
replan: "Execute list_workspace..."
→ list_workspace executado → achieved=true na próxima validação
```

### Cenário 3 — LLM afirma "enviado" sem send_document

**Situação:** LLM summary = "O documento foi enviado ao usuário." mas send_document não está em attempts.

```
checkClaimsAgainstEvidence:
  pattern "foi enviado" → match
  busca attempts [send_document|send_audio] → NOT FOUND
[UNVERIFIED-CLAIM] decision=override_to_false
achieved=false → replan
```

### Cenário 4 — Goal legítimo sem claims ("arquivos movidos")

**Situação:** LLM summary = "Os arquivos foram movidos com sucesso." — sem padrão de claim observável.

```
checkClaimsAgainstEvidence:
  nenhum padrão matched
  claimsChecked=0
[GOAL-EVIDENCE-SUMMARY] claims_detected=0 decision=accept
achieved=true ✓  (sem bloqueio — claim não exige evidência adicional)
```

### Cenário 5 — RiskAnalyzer muta step

**Situação:** Planner gera send_document sem file_path → RiskAnalyzer converte para AgentLoop.

```
[STEP-MUTATION] step=step_4 created_by=risk_analyzer
  original_tool=send_document new_tool=agentloop
  reason="sem 'file_path' obrigatório"
```

Rastreabilidade completa. Investigações futuras não precisam inferir quem criou cada step.

---

## Garantias obtidas

| Garantia | Mecanismo |
|---|---|
| "foi apresentado" exige `list_workspace` ou equivalent com output real | C1: `checkClaimsAgainstEvidence` |
| "foi enviado" exige `send_document` | C1: `checkClaimsAgainstEvidence` |
| AgentLoop com tarefa observável recebe instrução de usar ferramenta | C2: `evidenceDirective` no stepPrompt |
| organize_workspace entrega estrutura completa sem step extra | C4: `listTopLevelStructure()` no output |
| Toda mutação de step pelo RiskAnalyzer é rastreável | C3: `[STEP-MUTATION]` |
| Decisão de conclusão de goal é auditável | C6: `[GOAL-COMPLETION-REASON]` + `[GOAL-EVIDENCE-SUMMARY]` |

---

## Impacto em futuras tools

O `checkClaimsAgainstEvidence` é extensível sem modificação de código existente. Para adicionar uma nova tool com evidência, basta que:

1. A tool registre attempt com `result: 'success'` (já feito pelo fluxo atual)
2. O `toolName` apareça em `CLAIM_RULES.requiredTools` quando relevante

Novas tools como `export_pdf`, `generate_pptx`, `delete_file` são automaticamente cobertas pelas regras genéricas existentes (`exec_command` cobre a maioria dos casos de exportação/conversão).

---

## Limitações conhecidas

1. **Padrões de claim são em português:** `checkClaimsAgainstEvidence` detecta padrões em PT-BR. Se o LLM responder em inglês ("was shown"), o check não detecta. Mitigação: o sistema já força linguagem em português via `languageDirective`.

2. **C2 é preventivo, não garantido:** O AgentLoop pode ignorar a `[REGRA DE EXECUÇÃO]` se o modelo for menos capaz ou estiver sob alta carga. C1 serve como veto final.

3. **organize_workspace lista apenas top-level (30 entradas):** Para workspaces com muitas pastas raiz, pode truncar. Mitigação: limite configurável no código (`limit = 30`).

4. **Falsos positivos no claim check:** Frases como "o arquivo já foi criado anteriormente" podem matchear o padrão "foi criado". O check verifica `goal.attempts` — se `write` foi executado em algum momento do goal, a claim passa. Edge case raro mas possível.
