[← Painel Executivo](../MASTER_EXECUTION_PLAN.md) · [Backlog](../ARCHITECTURAL_BACKLOG.md)

# Sprint 2026-09-S20 ✅ Concluída
- **Número:** S20
- **Identificação Temporal:** 2026-09-S20
- **Fase:** Execução Arquitetural
- **Epic:** Decision Ownership
- **Card ARCH:** ARCH-015-RFC
- **Objetivo:** Produzir a análise de Fase 1-5 (`DIRETRIZ_ARQUITETURA_2026-07-13.md`) para gerar validação de args obrigatórios + texto de prompt a partir do schema de cada tool. **Sem código.**
- **Arquivos afetados:** nenhum de produção — `docs/refatoracao-arquitetural-2026/RFC_ARCH-015_SchemaGeneratedRequiredArgs.md` (novo).
- **Dependências:** S06 (ARCH-025) — cumprida.
- **Premissa reverificada (Fase 1) — parcialmente corrigida:** os "5 lugares" citados pelo card nem cobrem o mesmo conjunto de tools (`memory_write` nunca aparece em `detectMissingRequiredArgs()`, confirmado por grep completo). Mais importante: a lógica de "obrigatório" não é um `required: string[]` plano pra pelo menos 3 tools (`web_navigate`/`crypto_analysis`: condicional a outro campo; `edit`: "uma de 3 combinações válidas") — gerar a VALIDAÇÃO a partir do schema atual perderia essa lógica silenciosamente. Só a metade de TEXTO DE PROMPT tem incidente real confirmado (S06/ARCH-025, drift real entre os 2 blocos).
- **Fase 2/3 (crítica + alternativas):** 4 opções avaliadas — codegen completo (validação+prompt) via schema condicional estendido; híbrido (só tools com `required` plano geradas); rejeitar; só o texto de prompt migra, co-localizado no arquivo de cada tool (`requiredArgsHint` novo em `ToolExecutor`).
- **Decisão (Fase 4/5):** aprovado com **escopo reduzido** — só a 4ª opção (texto de prompt). A metade de validação não foi aprovada nesta forma; fica candidata a uma RFC futura e distinta, condicionada a desenhar um dialeto de schema condicional primeiro. Documento completo: `RFC_ARCH-015_SchemaGeneratedRequiredArgs.md`.
- **Checklist de execução:** padrão, adaptado para análise.
- **Checklist de validação:** N/A (fase de análise).
- **Rollback:** N/A — nenhum código tocado.
- **Critérios de Aceite:** documento de Fase 1-5 completo, com decisão explícita — **atingido**.
- **Definition of Done:** RFC revisada e aprovada — **atingido**, com escopo reduzido em relação ao card original (só texto de prompt, não validação).
- **Commit esperado:** 1 commit contendo o documento de RFC.
- **Status:** 🟢 Concluída em 2026-07-18.

