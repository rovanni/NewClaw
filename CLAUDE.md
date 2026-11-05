@docs/DIRETRIZ_ARQUITETURA_2026-07-13.md
@docs/ARCHITECTURE.md
@docs/ARCHITECTURE/REUTILIZACAO_ANTES_DA_CRIACAO.md

## gstack

Este projeto tem o [gstack](https://github.com/garrytan/gstack) instalado (skill pack de
desenvolvimento para Claude Code, `~/.claude/skills/gstack`). Regras de uso:

- Para qualquer navegação web (abrir páginas, testar URLs, screenshot, QA visual), usar a skill
  `/browse` do gstack. Nunca usar as ferramentas `mcp__claude-in-chrome__*`.
- Rodar `/code-review` antes de cada push.
- Usar `/investigate` quando um teste real falhar.

Skills disponíveis: `/office-hours`, `/plan-ceo-review`, `/plan-eng-review`,
`/plan-design-review`, `/design-consultation`, `/design-shotgun`, `/design-html`, `/review`,
`/ship`, `/land-and-deploy`, `/canary`, `/benchmark`, `/browse`, `/connect-chrome`, `/qa`,
`/qa-only`, `/design-review`, `/setup-browser-cookies`, `/setup-deploy`, `/setup-gbrain`,
`/retro`, `/investigate`, `/document-release`, `/document-generate`, `/codex`, `/cso`,
`/autoplan`, `/plan-devex-review`, `/devex-review`, `/careful`, `/freeze`, `/guard`,
`/unfreeze`, `/gstack-upgrade`, `/learn`.
