# Organização de Artefatos de Investigação e Relatórios de IA

Este documento descreve a padronização definitiva para o local de armazenamento de relatórios, auditorias, experimentos e análises produzidos por Inteligência Artificial (ou durante investigações) no repositório do NewClaw.

O objetivo é manter a raiz do repositório limpa e organizar todo o material produzido de maneira escalável.

---

## Estrutura de Diretórios

```
newclaw/
├── docs/
│   ├── ai/
│   │   ├── gemini/
│   │   │   └── 2026-07-14_1430_provider_pipeline_audit.md   <-- Relatório/Auditoria permanente
│   │   ├── chatgpt/
│   │   ├── claude/
│   │   └── shared/
├── tmp/
│   └── transport_integrity_report.md                       <-- Relatório temporário de execução (ignorado no Git)
```

---

## Regras de Padronização

### 1. Raiz do Repositório Limpa
A raiz do repositório deve conter apenas arquivos estruturais e de configuração do projeto. Nenhum relatório (`*.md`, `*.txt`, `*.json`, `*.log`) deve ser gerado automaticamente ou manualmente na raiz.

### 2. Documentação Permanente (Versionada)
Todos os relatórios permanentes gerados por investigações manuais ou análises de IA devem ser salvos dentro de `docs/ai/` sob a pasta correspondente à origem/provedor:
- `docs/ai/gemini/`
- `docs/ai/chatgpt/`
- `docs/ai/claude/`
- `docs/ai/shared/` (para relatórios neutros de provedores)

#### Nomenclatura Padronizada:
Os relatórios permanentes devem seguir a estrutura temporal:
`YYYY-MM-DD_HHMM_nome_do_relatorio.md`

Exemplos:
- `docs/ai/gemini/2026-07-14_1430_provider_pipeline_audit.md`
- `docs/ai/shared/2026-07-14_1725_transport_integrity_report.md`

### 3. Artefatos Temporários de Execução (Não Versionados)
Qualquer relatório ou dump dinâmico gerado por suítes de testes automatizados (como a suíte `S114`) deve ser tratado como um artefato temporário de execução:
- Deve ser gravado na pasta `tmp/` (já adicionada ao `.gitignore`).
- Não deve ser versionado em Git.
