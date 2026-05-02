# 🪐 IAL Auditor — Self-Diagnosis Agent

> Módulo PRIVADO de auto-diagnóstico do NewClaw via LLM local

## ⚠️ PRIVADO — NÃO COMMITAR

Este módulo está no `.gitignore` e **não deve ser enviado ao repositório público**.

## Comandos (Owner-Only — só Luciano)

| Comando | Descrição |
|---------|-----------|
| `/audit` | Auditoria completa (código + runtime + dados + integração) |
| `/audit code` | Só análise de código fonte |
| `/audit runtime` | Só análise de logs e padrões de erro |
| `/audit data` | Só validação do banco SQLite |
| `/audit integration` | Só testes de integração (Ollama, Telegram, disco) |
| `/audit history` | Últimos 10 relatórios de auditoria |
| `/audit fix` | **Pipeline de correção automática segura** |

## Arquitetura

```
/audit → AuditorService
           ├── auditCode()        → LLM analisa código fonte (10 arquivos)
           ├── auditRuntime()     → LLM analisa logs + padrões estáticos
           ├── auditData()        → Valida SQLite (órfãos, tamanho, consistência)
           └── auditIntegration() → Testa Ollama, Telegram API, disco, Node.js

/audit fix → Auto-Fix Pipeline
              ├── generatePatch()       → LLM gera patch (before/after)
              ├── validatePatch()       → 3 agentes LLM validam (code_reviewer, bug_detector, safety_checker)
              ├── buildConsensus()      → agreement >= 0.75 AND confidence >= 0.8
              ├── validatePatchSafety() → Validação determinística (arquivo existe, before encontrado, tamanho ok, sem destruição)
              ├── applyPatch()         → Backup .bak + substituição + restore on error
              └── markFindingFixed()    → UPDATE audit_findings SET fixed = 1
```

## Auto-Fix Pipeline (v2)

### Fluxo Completo

```
/audit fix
  │
  ├── SELECT findings WHERE auto_fixable=1 AND fixed=0 AND risk_level='low'
  │
  ├── Para cada finding:
  │   │
  │   ├── [1] generatePatch(finding)
  │   │         → LLM gera {file, before, after, confidence, summary}
  │   │         → Rejeita se confidence < 0.5 ou before==after
  │   │
  │   ├── [2] validatePatch(patch, finding)
  │   │         → code_reviewer:  approve? confidence? reason?
  │   │         → bug_detector:   approve? confidence? reason?
  │   │         → safety_checker: approve? confidence? reason?
  │   │
  │   ├── [3] buildConsensus(opinions)
  │   │         → agreement = approvals / total
  │   │         → confidence = avg(all confidences)
  │   │         → approved = agreement >= 0.75 AND confidence >= 0.8
  │   │
  │   ├── [4] validatePatchSafety(patch)
  │   │         → validSyntax:   "before" encontrado no arquivo
  │   │         → fileExists:    arquivo existe no filesystem
  │   │         → changeSizeOk:  ratio < 5x, after < 2000 chars
  │   │         → riskyChange:   não remove imports fs/path, classes, exports
  │   │         →                não adiciona eval, child_process, rm -rf
  │   │         → safe = ALL true
  │   │
  │   ├── [5] applyPatch(patch)
  │   │         → Cria backup .bak
  │   │         → content.replace(before, after)
  │   │         → Em caso de erro: restaura do .bak
  │   │
  │   └── [6] markFindingFixed(id)
  │             → UPDATE audit_findings SET fixed = 1
  │
  └── Retorna FixReport (applied/rejected/errors por item)
```

### Regras de Segurança

| Condição | Resultado |
|----------|-----------|
| `risk_level != 'low'` | ❌ Não entra no pipeline |
| `confidence < 0.5` | ❌ Patch rejeitado na geração |
| `agreement < 0.75` | ❌ Consenso insuficiente |
| `confidence média < 0.8` | ❌ Confiança insuficiente |
| Arquivo não existe | ❌ Safety check falha |
| `before` não encontrado | ❌ Safety check falha |
| Mudança muito grande | ❌ Safety check falha |
| Remove bloco crítico | ❌ Safety check falha |
| Adiciona eval/rm -rf | ❌ Safety check falha |
| Erro ao aplicar | 🔄 Restaura backup automaticamente |

### Funções do Pipeline

| Função | Input | Output |
|--------|-------|--------|
| `generatePatch(finding)` | Finding do DB | `{file, before, after, confidence, summary}` ou `null` |
| `validatePatch(patch, finding)` | Patch + Finding | `{opinions: [{agent, approve, confidence, reason}]}` |
| `buildConsensus(opinions)` | Array de opiniões | `{agreement, confidence, approved}` |
| `validatePatchSafety(patch)` | Patch | `{validSyntax, fileExists, changeSizeOk, riskyChange, safe, reasons}` |
| `applyPatch(patch)` | Patch | `boolean` (true = sucesso) |
| `markFindingFixed(id)` | Finding ID | Atualiza DB |
| `runFixPipeline()` | — | `FixReport` (resultado completo) |
| `formatFixReport(report)` | FixReport | String formatada para Telegram |

### Log de Correções

```
~/newclaw/data/auditor/logs/fixes.log
```

Formato: `[timestamp] finding=#ID result=applied|rejected reason="..."`

## Risk Level

| Nível | Quando | Auto-aplicável? |
|-------|--------|-----------------|
| `low` | Missing null check, typo, pequena lógica | ✅ Sim (via /audit fix) |
| `medium` | Adicionar try/catch, reestruturar função | ❌ Não — só sugestão |
| `high` | Mudança de arquitetura, múltiplos arquivos | ❌ Não — manual only |

## Segurança

- **Owner-only**: Apenas o chat_id do Luciano pode disparar
- **LLM local**: Usa Ollama, nenhum dado sai do servidor
- **Logs locais**: Relatórios ficam no SQLite + fixes.log
- **gitignore**: Todo o diretório `src/services/auditor/` está no .gitignore
- **Backup**: Todo patch cria .bak antes de modificar
- **Fallback**: Erro na aplicação = restauração automática do backup

## Modelos Recomendados

| Uso | Modelo | Velocidade |
|-----|--------|------------|
| Análise profunda | `deepseek-v3.2:cloud` | Lento (~60s) |
| Audit parcial | `glm-5:cloud` | Médio (~30s) |
| Audit rápido | `qwen3.5:cloud` | Rápido (~15s) |

## Persistência

Tabelas no SQLite (`newclaw.db`):
- `audit_reports` — Histórico de relatórios
- `audit_findings` — Achados detalhados (severity, category, risk_level, suggestion, auto_fixable, fixed)

## Arquivos

```
src/services/auditor/
├── AuditorService.ts    — Motor de auditoria (4 categorias + auto-fix pipeline)
├── auditCommand.ts      — Comando /audit (Grammy, owner-only)
└── README.md            — Este arquivo (referência rápida)
```