# RFC — Campanha A (decisão revisada): o histórico factual chega ao replan

Data: 2026-09-24 · Status: **proposta revisada — nenhum código alterado, implementação adiada** ·
Substitui a versão anterior deste documento (que propunha `observedArtifacts`).
Processo: `docs/DIRETRIZ_ARQUITETURA_2026-07-13.md`. Insumos: `RELATORIO_CONSOLIDADO.md`
(auditoria de 24/09) e a investigação comparativa (Codex, OpenHands, OpenClaw, Aider, Cline).

## Decisão arquitetural atual da Campanha A

> **`GoalAttempt` continua sendo a fonte de verdade do que aconteceu durante a execução. O replan
> passa a consumir uma projeção factual, compacta e temporária, desse estado.**

Não se cria estado novo, campo novo, nem autoridade nova de artefatos.

### Abandonado por enquanto (sem evidência de necessidade)

`observedArtifacts` · filesystem watcher · scan de filesystem por passo · `ArtifactRegistry` ·
`ArtifactTrace` · UUID/hash/event log · reaproveitar `core_workspace` como lista de recentes.

### O que mudou e por quê

A versão anterior propunha observar o disco para descobrir que arquivo nasceu. A investigação
mostrou que **o fato já estava persistido**. Banco de produção, goal `goal_1790214597600_ov9eh`
(12 attempts, leitura somente):

| Attempt | Ferramenta | Resultado | Saída | Cita `extracao_aulas` |
|---|---|---|---|---|
| 6 | agentloop | success | 2 287 B — "…a extração já funcionou e produziu um arquivo real… `extracao_aulas.txt` (59,4 KB, 1.833 linhas)" | sim |
| 7 | exec_command | success | 67 B — `"Extração concluída: tmp/extracao_aulas.txt (9 arquivos processados)"` | sim |
| 11 | read | success | 300 B | sim |

`producedArtifactPaths` estava vazio em todos os 12 — e **não era necessário**: a saída do passo
já continha o caminho. O elo que falta é o **consumidor**: `buildReplanPrompt`
(`GoalPlanner.ts:331`) usa `goal.attempts` apenas para contar falhas de `exec_command` e detectar
loop; saídas, comandos e resultados não entram no prompt.

Padrão confirmado nos outros agentes (fatos documentados, ver relatório de investigação): o
estado é um **histórico estruturado e persistido** que volta ao modelo (Codex: rollout JSONL;
OpenHands: EventLog append-only; OpenClaw: sessão em SQLite). Nenhum tem registro de artefatos.

## Desenho (projeção, não estado)

```
GoalAttempt (persistido, inalterado)
        │  função pura, sem I/O
        ▼
projeção factual compacta ── só existe durante a montagem do prompt
        ▼
buildReplanPrompt() → LLM
```

Formato ilustrativo (o conteúdo exato é decisão de implementação):

```
FATOS DA EXECUÇÃO (do histórico do goal)
Passo 7 — exec_command — success
  comando: python extrator_aulas.py
  saída: Extração concluída: tmp/extracao_aulas.txt (9 arquivos processados)
Passo 11 — read — success
  saída: (primeiras N linhas)
```

### Limites rígidos (a ressalva central)

Não passar `goal.attempts` inteiro: a auditoria mede que o custo de raciocínio já é o problema
(17 abortos de orçamento; 76 chamadas LLM = 82% dos 25 min). Projeção deve ter, no mínimo:
teto de passos (mais recentes/relevantes primeiro), teto de caracteres por passo, teto total, e
**omitir passos sem informação** (saída vazia, falhas já descritas em blockers). Um replan com
prompt maior que hoje seria uma regressão, não uma correção.

## Critérios de sucesso (para quando for implementada)

1. Dado um goal com attempts como os do incidente, o prompt real de `buildReplanPrompt` contém o
   caminho `tmp/extracao_aulas.txt` proveniente da saída do attempt 7.
2. Sem attempts úteis, o prompt **não muda** (controle negativo).
3. O tamanho da projeção respeita os tetos, mesmo com 100 attempts (teste de limite).
4. Nenhuma alteração no schema/estado persistido.
5. Suíte completa sem regressão; validação real em instância isolada (etapa 4 da diretriz).

## Limites do que se afirma

- **Fato:** o dado estava nos attempts e não chegou ao replan.
- **Hipótese não provada:** que isso, sozinho, faria o goal de 23/09 concluir. Às 23:11 o
  replanner já sabia do arquivo (via texto de um blocker) e ainda planejou reescrever um script;
  as demais causas estão nas Campanhas B–D.
- **Hipótese em espera (plano B):** arquivo criado por script que **não** o cita na saída não
  apareceria no histórico. Não há incidente que demonstre isso; só então reabrir `observedArtifacts`.

## Decisão de processo

**Não implementar agora.** Primeiro consolidar as quatro frentes da auditoria (ver
`RELATORIO_CONSOLIDADO.md`, seção "Consolidação das campanhas") e decidir se a correção de A é
tão pequena que deve ser absorvida por uma simplificação maior do contexto do replan, em vez de
virar uma "Campanha A" isolada — para não repetir o padrão "cada problema gera uma abstração, que
gera outra camada, que gera outra exceção".
