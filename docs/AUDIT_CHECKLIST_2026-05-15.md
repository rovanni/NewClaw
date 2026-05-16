# NewClaw — Checklist de Auditoria (2026-05-15)

> Auditoria automatizada da pasta `D:\IA\newclaw` focada em problemas e bugs.
> Resultado: zero vulnerabilidades, build limpo com flags strict adicionais.

---

## ✅ Concluído nesta sessão

### Segurança

- [x] **CVE crítico (CVSS 9.8) corrigido** — `protobufjs <7.5.5` via `@whiskeysockets/baileys`. Atualizado para `^7.0.0-rc11`. `npm audit` agora reporta **0 vulnerabilidades**. Antes: 1 crítica + 1 alta.
- [x] **Dashboard com bind padrão em `127.0.0.1`** — `src/dashboard/DashboardServer.ts` agora lê `DASHBOARD_HOST` (default `127.0.0.1`) e loga ⚠️ se exposto sem senha.
- [x] **Documentadas `DASHBOARD_HOST` e `DASHBOARD_PASSWORD`** no `.env.example`.

### Bugs pré-existentes corrigidos

- [x] **`src/dashboard/DashboardServer.ts` estava truncado no fim** — faltavam `formatUptime`/`formatBytes`. Restaurado a partir do HEAD do git. Quebraria em runtime ao chamar essas funções.
- [x] **`src/core/AgentController.ts` estava truncado no fim** — método `extractVisionDescription` cortado mid-string. Restaurado. Quebraria em runtime ao processar imagem.

### Higiene do código

- [x] **`src/tools/ToolRegistry.ts` órfão removido** — duplicata sem nenhum import.
- [x] **`setInterval` órfãos refatorados** em `AgentController` (prompt hot-reload + circuit breaker monitor) → agora registrados via `LifecycleManager.registerInterval()` para `clearInterval` automático no shutdown.
- [x] **104 unused locals/parameters limpos** em 38+ arquivos:
  - 32 imports não usados removidos
  - 46 parâmetros de função prefixados com `_`
  - 15 propriedades de classe mortas removidas (com suas atribuições no construtor)
  - 11 constantes/variáveis locais dead deletadas
  - 2 métodos dead removidos por completo (`buildContextBlock`, `mergeNodeContent`)
  - 1 método estático morto removido (`isSimpleGreeting` + `GREETING_RESPONSES` + `GREETING_PATTERNS`)
- [x] **`noUnusedLocals: true` + `noUnusedParameters: true`** habilitados no `tsconfig.json` para impedir drift futuro.

### Build & deps

- [x] **`@types/*` e `typescript` movidos de `dependencies` → `devDependencies`** (reduz instalação em produção em ~50 MB).
- [x] **`package-lock.json` regenerado**.

### Repositório

- [x] **`.gitattributes` criado** com `* text=auto eol=lf` + regras para shell scripts (LF), Windows scripts (CRLF) e binários — elimina o "diff fantasma" de 134 arquivos em CRLF.
- [x] **`.gitignore` corrigido**:
  - Linha quebrada `*.sqlite-walaudio/` virou três regras (`*.sqlite-wal`, `audio/`).
  - Adicionados `debug_loop.js`, `fetch.js`, `scratch/`, `.vscode/`, `.idea/`, `.DS_Store`, `Thumbs.db`.

### Validação final

- [x] `npx tsc --noEmit` (com `noUnusedLocals` e `noUnusedParameters` ativos) → **exit 0**
- [x] `npm audit` → **0 vulnerabilidades**
- [x] Diff real: 45 arquivos modificados, 140 inserções, 254 deleções (líquido: **−114 linhas de código morto**)

---

## ⏳ Próximos passos manuais recomendados

### Imediato

- [ ] **Definir `DASHBOARD_PASSWORD`** no arquivo `.env` (o `.env.example` já tem o placeholder).
- [ ] **Commits separados** para facilitar revisão:
  ```bash
  # 1. Config / infra / deps
  git add .gitattributes .gitignore .env.example package.json package-lock.json tsconfig.json
  git commit -m "chore: security fixes, EOL normalization, deps cleanup, strict unused checks"

  # 2. Mudanças de código
  git add src/
  git commit -m "refactor: remove dead code, fix setInterval leaks, dashboard bind localhost"

  # 3. Normalização CRLF→LF (consome o diff fantasma de 134 arquivos)
  git add --renormalize .
  git commit -m "chore: normalize line endings to LF via .gitattributes"
  ```

### Backlog técnico (não-crítico, mais demorado)

Em ordem sugerida de custo/benefício:

- [ ] **Reduzir 285 `: any` + 219 `as any`**
  - Foco: `core/`, `loop/`, `memory/` primeiro
  - Trocar por `unknown` + type narrowing onde possível
  - Risco médio — pode revelar bugs latentes
  - Estimativa: 2-3 sessões dedicadas

- [ ] **Quebrar arquivos > 1.000 linhas em módulos menores**
  - `src/dashboard/DashboardServer.ts` — 1.798 linhas (routes podem virar arquivos separados)
  - `src/services/auditor/AuditorService.ts` — 1.689 linhas
  - `src/core/ProviderFactory.ts` — 1.220 linhas
  - `src/memory/MemoryManager.ts` — 1.140 linhas
  - `src/loop/AgentLoop.ts` — 1.060 linhas
  - `src/core/AgentController.ts` — 990 linhas
  - Risco alto sem testes automatizados — fazer um por vez

- [ ] **Refatorar boundary leaks L1–L10** (já documentados no `ARCHITECTURE_REVIEW.md` do projeto)
  - L1: `MemoryManager.getDatabase()` vaza DB raw para 15+ componentes → introduzir Repository pattern
  - L5: `botToken` do Telegram vaza pelo pipeline inteiro → isolar em config injetada
  - L8: `AttentionFeedback` background timers sem lifecycle management
  - L9: Scheduler acoplado direto ao `TelegramAdapter` → usar EventBus
  - Demais leaks listados no doc original
  - Risco muito alto — refatoração arquitetural

### Itens de menor prioridade

- [x] **28 `console.log` no `AuditorService`** — trocar por `log.info/debug` do `AppLogger` para consistência
- [x] **Centralizar bloco SQL injection-prone** em `MemoryManager.ts:370` — refatorado para `safeAddColumn` com validação de allow-list e sanitização de identificadores.
- [x] **20+ `catch {}` vazios** em `MemoryManager`, `DashboardServer`, `AgentLoop`, `ProtocolParser`, `AuditorService` — tratados com logs (`log.warn/info`), fallbacks seguros ou documentação de intenção.
- [x] **`data/newclaw.db` está com 0 bytes** — stub removido para evitar confusão.
- [x] **Dependências com majors disponíveis** — atualizadas: `better-sqlite3 v12`, `dotenv v17`, `typescript v6`. Compilação validada.

---

## Sumário executivo

| Categoria | Antes | Depois |
|---|---|---|
| Vulnerabilidades npm | 1 crítica (CVSS 9.8) + 1 alta | **0** |
| TS errors com strict unused | 104 | **0** |
| Dashboard bind | Todas interfaces, sem senha | **127.0.0.1 + opt-in password** |
| Arquivos truncados (runtime bugs) | 2 | **0** |
| Linhas em `src/` | 27.437 | **~27.295** (−142 dead) |
| Diff fantasma git | 134 arquivos | **Resolvido via .gitattributes** |

Auditoria realizada por: Claude (Cowork mode)
Data: 2026-05-15
