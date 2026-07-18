[← Painel Executivo](../MASTER_EXECUTION_PLAN.md) · [Backlog](../ARCHITECTURAL_BACKLOG.md)

# Sprint 2026-11-S26 ✅ Concluída (2026-07-18)
- **Número:** S26
- **Identificação Temporal:** 2026-11-S26 (executada 2026-07-18)
- **Fase:** Execução Arquitetural
- **Epic:** Decision Ownership
- **Card ARCH:** ARCH-015-Impl
- **Objetivo:** ~~Implementar a geração de validação/prompt de args obrigatórios a partir do schema~~ — **escopo reduzido pela RFC (S20):** implementar só a geração do TEXTO DE PROMPT (`requiredArgsHint` co-localizado por tool, agregado via `ToolRegistry`). A metade de VALIDAÇÃO (`detectMissingRequiredArgs`) não foi aprovada — ver `RFC_ARCH-015_SchemaGeneratedRequiredArgs.md`.
- **Arquivos afetados:** `src/loop/agentLoopTypes.ts` (`ToolExecutor.requiredArgsHint` novo), `src/loop/GoalPlanner.ts` (`buildRequiredArgsReference()` reescrita), `src/tools/*.ts` (campo novo por tool que hoje tem entrada em `buildRequiredArgsReference()`/`buildToolContracts()`).
- **Dependências:** S20 (aprovação da RFC) — cumprida, com escopo reduzido.
- **Checklist de execução:** padrão. Cumprido — `agentLoopTypes.ts` (campo novo), 7 tools (`edit`, `send_document`, `list_workspace`, `read`, `memory_write`, `crypto_analysis`, `web_navigate`) com `requiredArgsHint`, `GoalPlanner.buildRequiredArgsReference()` reescrita para agregar via `ToolRegistry.getEnabled()`.
- **Checklist de validação:** padrão. **Correção da premissa registrada em S25:** a nota "etapa 4 provavelmente dispensável" foi reavaliada no início da própria S26 (não presumida) — a Classificação do card é `Exige RFC` e a Definition of Done exige "Validação Progressiva completa" categoricamente (Regra Permanente #5), sem exceção para "geração de string". Etapa 4 executada normalmente, não dispensada.
- **Rollback:** reverter. Não exercido.
- **Critérios de Aceite:** definidos na RFC (S20) — escopo reduzido a texto de prompt. Atendidos.
- **Definition of Done:** Validação Progressiva completa (etapas aplicáveis ao escopo reduzido). Atendida nas 4 etapas.
- **Commit esperado:** 1 commit. Realizado: `314831b`.
- **Status:** 🟢 Concluída. tsc --noEmit limpo, build limpo, regressão 127/127 (126 + `S124` novo, 21/21 asserts), etapa 4 real em sandbox isolado (`D:/IA/newclaw-verify-s26`, LLM real `glm-5.2:cloud`) — goal real confirmou `send_document` recebendo `file_path` corretamente na 1ª tentativa, plano gerado com o hint agregado dinamicamente de `ToolRegistry`. Sandbox desmontado (processo finalizado, `data/` removido).

