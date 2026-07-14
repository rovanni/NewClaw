# NewClaw — Documentação Técnica

Índice da documentação interna do projeto.

---

## Arquitetura & Estado Atual

- [ROADMAP.md](./ROADMAP.md) — Roadmap estratégico de evolução do projeto
- [walkthrough.md](./walkthrough.md) — Walkthrough da evolução da memória cognitiva
- [plano-correcao-bugs.md](./plano-correcao-bugs.md) — Plano de correção de bugs
- [DIRETRIZ_ARQUITETURA_2026-07-13.md](./DIRETRIZ_ARQUITETURA_2026-07-13.md) — Diretriz permanente de arquitetura
- [architecture/provider_pipeline_transport.md](./architecture/provider_pipeline_transport.md) — Arquitetura de transporte entre Tool Layer e Providers

## Architecture Decisions (ADR)

Os ADRs registram decisões arquiteturais permanentes e suas motivações (o *porquê*), enquanto os documentos de arquitetura descrevem a implementação (o *como*) e os testes garantem sua conformidade contínua (a *validação*).

*   [Decisões Arquiteturais (ADRs)](./architecture/decisions/) — Histórico de registros de decisões arquiteturais do projeto.
    - [ADR 0001 — Sanitização do Histórico e Integridade do Transporte](./architecture/decisions/0001-provider-pipeline-transport-integrity.md) — Motivação para a sanitização estrutural e conformidade de hashes.

## Skills

- [skills/CURRENT_STATE.md](./skills/CURRENT_STATE.md) — Estado atual do sistema de Skills: fluxos, lacunas, duplicações
- [skills/SKILL_DISCOVERY_PROPOSAL.md](./skills/SKILL_DISCOVERY_PROPOSAL.md) — Proposta arquitetural de Skill Discovery
- [skills/SKILL_SYSTEM_ARCHITECTURE.md](./skills/SKILL_SYSTEM_ARCHITECTURE.md) — Arquitetura detalhada do sistema de Skills

## Sprints & Implementações

- [sprints/SPRINT_3_6_IMPLEMENTATION_REPORT.md](./sprints/SPRINT_3_6_IMPLEMENTATION_REPORT.md) — P1–P5: organize_workspace, artifact groups, deferred send, observabilidade
- [sprints/SPRINT_3_6D_EXECUTION_INTEGRITY.md](./sprints/SPRINT_3_6D_EXECUTION_INTEGRITY.md) — Execution Integrity: anti-alucinação, validação baseada em evidências
- [sprints/SPRINT_3_7A_IMPLEMENTATION_REPORT.md](./sprints/SPRINT_3_7A_IMPLEMENTATION_REPORT.md) — Skill Discovery Evolution + organização da documentação

## Auditorias

- [Auditorias/01/](./Auditorias/01/) — Auditoria arquitetural v1
- [Auditorias/02/](./Auditorias/02/) — Checklist de auditoria 2026-05-15
- [DOCUMENTATION_AUDIT_REPORT.md](./DOCUMENTATION_AUDIT_REPORT.md) — Auditoria da estrutura de documentação (2026-06-01)

## Investigações & Melhorias

- [AI_ARTIFACTS.md](./AI_ARTIFACTS.md) — Padronização de organização de artefatos de IA e relatórios
- [issues/](./issues/) — Issues técnicos documentados
- [melhorias/](./melhorias/) — Análises de performance e melhorias
