# 🐛 Deriva de nome de arquivo entre plano e execução real

## Status

**PENDENTE — não investigado.** Registrado como achado de teste ao vivo em 14/07/2026.
Aguardando abertura formal do ciclo de 5 fases (compreensão → crítica → pesquisa → síntese →
validação) — diretriz permanente do projeto — quando houver disponibilidade de cota/sessão para
conduzir a investigação completa. Nenhuma hipótese abaixo foi verificada contra o código ainda.

## Descrição

Um step do plano de um goal referenciava um nome de arquivo específico
(`siglas_traducoes.pptx`) que **nunca foi gerado**. O arquivo realmente produzido pela execução
tinha outro nome (ex.: `seguranca_redes_siglas_senac.pptx`). O step de verificação
("Verificar a existência e o caminho exato do arquivo...") ficou repetindo a mesma checagem,
recebendo "output irrelevante" por não encontrar o nome exato esperado, até esgotar o
`replan_budget` e reportar um bloqueio final ao usuário.

Distinto da investigação TOOL-DEDUP/Fix C (`docs/INVESTIGACAO_TOOL_DEDUP_2026-07-13.md`): não é
repetição de `send_document` nem problema de FSM — é o **plano/replan referenciando um nome de
arquivo que diverge do que a execução de fato produziu**.

## Comportamento Observado (evidência real, não hipotética)

Goal `goal_1783997432824_ttbe2` (Telegram, prompt: "Gere em formato pptx, como no máximo 10
linhas por slides..."), rastreado em `C:\Users\lucia\NewClaw\logs\newclaw-audit.log`,
13-14/07/2026, ~23:53 a 00:17:

- Múltiplos replans consecutivos (`replan_budget` caindo de 5 para 3+) tentando gerar o PPTX,
  cada um batendo em um blocker diferente: `tool_error` (exec_command, caminho não encontrado),
  `tool_error` (ferramenta "unknown"), `missing_tool`, `semantic_mismatch`.
- O sistema **não travou indefinidamente**: o `replan_budget` se esgotou e o goal retornou ao
  usuário com um relatório parcial honesto — comportamento correto do SAFETY-GUARD/orçamento de
  replan, não um bug em si.
- Resultado final reportado ao usuário: `tmp/seguranca_redes_senac.pptx` foi gerado e enviado
  com sucesso, mas um step subsequente ficou preso procurando por
  `tmp/siglas_traducoes.pptx` — nome que não corresponde a nenhum arquivo real gerado durante a
  execução (o arquivo real tinha outro nome, ex. `seguranca_redes_siglas_senac.pptx`).

## Comportamento Esperado

- Um step de verificação de arquivo deveria usar o nome real gerado pela execução anterior (via
  evidência persistida — `producedArtifactPaths`/`ToolResult.artifactPaths`, mecanismo já
  existente do ciclo R1→R7), não um nome assumido/hardcoded pelo Planner numa etapa anterior.
- Se o nome divergir, o sistema deveria detectar isso rapidamente (1 tentativa, não esgotar todo
  o replan budget) e já replanejar usando o nome correto, em vez de repetir a mesma checagem
  malsucedida.

## Hipóteses a investigar (não verificadas)

1. O `GoalPlanner`, ao planejar/replanejar, pode estar "inventando" ou assumindo um nome de
   arquivo (`siglas_traducoes.pptx`) sem consultar evidência real de execução anterior — mesma
   classe de problema que a Sprint R1→R7 endereçou para resolução de `file_path`
   (`resolveArtifactPathFromEvidence`, `inferExpectedExtensions`). Vale checar se esse mecanismo
   já existente cobre nomes de arquivo gerados por scripts Python custom (não só write/tools
   nativas) — pode ser uma lacuna de cobertura, não uma ausência total do mecanismo.
2. Verificar se o step de verificação usa `list_workspace`/`exec_command` com o nome hardcoded
   do texto do step (string literal), em vez de resolver dinamicamente contra os artefatos
   realmente produzidos no ciclo.

## Contexto

- Goal: `goal_1783997432824_ttbe2`, canal Telegram, usuário 8071707790.
- Log de origem: `C:\Users\lucia\NewClaw\logs\newclaw-audit.log`, janela 13/07/2026 23:53 —
  14/07/2026 00:17.
- Relacionado (mas não idêntico) a: Sprint R1→R7 (`resolveArtifactPathFromEvidence`),
  `docs/INVESTIGACAO_TOOL_DEDUP_2026-07-13.md`.
