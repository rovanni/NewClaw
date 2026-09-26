# Campanha: conclusão do objetivo e latência (RFC-007 → Sprint 5) — 22–26/09/2026

**Status:** ENCERRADA. Seis commits, oito testes de regressão novos, suíte em **306/306**.
**Método:** evidência antes de correção; instrumento em modo sombra antes de mudar comportamento; uma sprint
por vez, cada uma com teste unitário (com controle negativo), regressão completa e validação em execução real.

> Registro de trabalho detalhado (com todas as medições e correções de diagnóstico) em
> `docs/issues/048-…` (pasta ignorada pelo git, existe só no disco de quem rodou a campanha). Este documento
> é a versão versionada.

---

## 1. Ponto de partida

Um pedido simples ("crie o programa e me envie o `.py`") levou **29,8 min** e terminou com o goal abandonado
por cancelamento do usuário, embora o arquivo já tivesse sido entregue em **4,4 min**. O restante foi trabalho
que ninguém pediu (teste, "harness", relatório), travado no juiz de grounding e em dois replans.

## 2. Linha do tempo (commits)

| Commit | Sprint | O que entrega | Teste |
|---|---|---|---|
| `2bc013d` | RFC-007 | Motor genérico `resolveWorkingCommand`; `EnvironmentProbe` dá a `python3`/`python` o veredito de cada nome; o fato chega ao Planner (`commands_validated`), sem reescrever comandos | S300 (15) |
| `666af6f` | S-D / S-E | Observabilidade: modo sombra do revisor de plano; `[GROUNDING-TRACE]`, `[PLAN-TRACE]`, `[GOAL-INTENT]` | S301 (22), S302 (21) |
| `f3e0c43` | Sprint 1 | Pedido do usuário gravado íntegro; conversa apagada não derruba a mensagem seguinte | S303 (7), S304 (7) |
| `a645fc0` | Sprint 2 | `response_produced` não é exigido quando o plano já entrega um artefato | S305 (14) |
| `b3f3903` | Sprint 3 | Sombra do juiz com evidência ampliada | S306 (18) |
| `2c5fbe2` | Sprint 5 | Sombra de modelo do juiz (pesado × leve) | S307 (19) |

A Sprint 4 foi **medição, sem código** (seção 5). Além dos commits: 4 alertas do CodeQL (#104, #108, #109,
#110) dispensados no GitHub com justificativa técnica; code-scanning ficou com **0 abertos**.

## 3. Problemas encontrados e destino

| # | Problema | Evidência | Destino |
|---|---|---|---|
| 1 | `tools.python3` era `true` mesmo com o stub da Microsoft Store (só `python` funcionava) | `where python3` × exit code; issue 037 | **Corrigido** (RFC-007) |
| 2 | `GoalStore` gravava `user_intent` cortado em **300** chars (desde o 1º commit); todo replan relê o goal do banco | Banco: pedido de 1.509 chars terminava em "…O que o programa deve"; `intentChars=300` nos replans | **Corrigido** (Sprint 1) |
| 3 | "Erro ao processar mensagem" após "Limpar Histórico": a sessão em cache pulava `ensureConversation` e a gravação falhava com `FOREIGN KEY` | Log: conversa criada 22:37, apagada no painel, mensagem 22:50 falhou no mesmo processo | **Corrigido** (Sprint 1) |
| 4 | `response_produced` injetado para `creation` mesmo com entrega no plano; manteve o goal 25 min a mais | `[PLAN-TRACE]`: 3 critérios `source=auto`; entrega em 4,4 min | **Corrigido** (Sprint 2) |
| 5 | Juiz de grounding devolve `NOT_EVALUABLE` para (a) conteúdo autorado num `write` (args cortados em 200), (b) afirmações sobre o pedido do usuário, (c) ações pendentes ("foi enviado em anexo") | `[GROUNDING-TRACE]` com `TRACE_CONTENT` | **Instrumentado** (Sprint 3): a ampliação reduziu 2→1 `NOT_EVALUABLE`; (c) segue sem tratamento |
| 6 | Aborto por orçamento de raciocínio + refação sem streaming: 27% do tempo de LLM no caminho real | 263 chamadas / 12 execuções | **Medido** (Sprint 4); decisão pendente |
| 7 | Revisor semântico de plano: expira (~78 s) com o modelo de produção e, quando funciona, introduz defeitos estruturais que o sanitizer conserta | 139 execuções no log de produção; 3 controles | **Instrumentado** (S-D); decisão pendente |
| 8 | 4 alertas CodeQL | GitHub | **Dispensados** (controle existente verificado) |

**Fora do escopo (só registrados):** JSON cru e `$$` duplicado na conversa do River (a conversa certa não foi
analisada); cabeçalho "Entrega pendente de uma tarefa anterior" fixo em português (`WebChannelAdapter`);
`AgentLoop` entrega arquivos de apoio que ele mesmo cria (o harness de teste); `PlanStep` sem campo de origem.

## 4. Instrumentos (todos opt-in e desligados por padrão, exceto onde indicado)

| Flag | Efeito | Custo |
|---|---|---|
| — (sempre ligado) | `[GROUNDING-TRACE]` estrutural, `[PLAN-TRACE]`, `intent_chars` no ciclo de vida do goal, `[LLM-CALL]` (S299) | nenhum (só log) |
| `TRACE_CONTENT=true` | Acrescenta texto da resposta, evidência exata como o juiz a viu, saída crua do juiz, texto entregue e `[GOAL-INTENT]` com o pedido integral | log maior; **contém conteúdo do usuário** |
| `RISK_REVIEW_SHADOW=true` | Revisor de plano roda em segundo plano, **não é aplicado**, e vira `[RISK-SHADOW]` (plano antes/proposta/diff/reparos do sanitizer) | 1 chamada de LLM por plano complexo (a mesma de hoje, fora do caminho crítico) |
| `GROUNDING_EVIDENCE_SHADOW=true` | Juiz roda de novo com evidência ampliada + pedido do usuário como `U1` → `[GROUNDING-SHADOW]` | +1 chamada ao juiz por julgamento |
| `GROUNDING_SHADOW_MODEL=<modelo>` | Mesmo julgamento com outro modelo → `[GROUNDING-SHADOW-MODEL]` (estado, contagens, tempo dos dois) | +1 chamada ao juiz por julgamento |

Garantias comuns: o resultado real é devolvido **antes** da sombra e nada dela o altera; falha da sombra é
engolida; nenhuma sombra dispara outra; o texto do pedido não vai para o log (só o tamanho).

## 5. O que a medição mostrou (Sprint 4)

- 263 chamadas no caminho real, 6.302 s de LLM: **1.675 s (27%) descartados em abortos**. Maiores: juiz de
  grounding 542 s, planejador 534 s, perfil de execução do `AgentLoop` 237 s (66% do seu tempo), qualidade 168 s.
- Todo o fallback ocorreu no `glm-5.3:cloud` (43 de 250 chamadas); `glm-5.3-flash` 0/5 e `kimi-k2.6` 0/8.
- **Contrafactual** (prompt real do juiz, sem limite, 3 rodadas por modelo):

  | Modelo | Tempo (mín / mediana / máx) | Raciocínio | Estado agregado |
  |---|---|---|---|
  | `glm-5.3:cloud` | 305 / **383** / 392 s | 132–171 mil chars | NOT_EVALUABLE ×3 |
  | `glm-5.3-flash:cloud` | 52 / **102** / 260 s | 17–70 mil chars | NOT_EVALUABLE ×3 |

  **Deixar o streaming terminar não é mais rápido** (os 229 s observados em produção ficam abaixo dos 305–392 s
  naturais). O custo é o **volume de raciocínio do modelo pesado em tarefas de julgamento**. O leve concordou
  no estado nas 6 rodadas, mas decompõe a resposta em outro número de afirmações (19–25 × 12–19): equivalência
  por estado, não por afirmação.
- Sprint 5, tráfego real (n=2): pesado e leve concordaram no estado nos dois julgamentos.

## 6. Correções de diagnóstico feitas durante a campanha

Registradas para não repetir o erro:
- "O aborto custa pouco" só vale com o orçamento de 8.000 chars; com 32.000 cada aborto descarta 38–94 s.
- A opção `reasoningIntensive` para o roteador foi **refutada por desenho** (elevaria o teto duro para 240 s no
  caminho fail-fast de 30 s) e não comportaria os ~50.000 chars do revisor.
- O erro `FOREIGN KEY` de 22:50 **não** veio de apagar o banco; veio de a conversa ser apagada no painel.
- O caso da Calculadora **não** é evidência de que o revisor de plano atrapalhou (a sombra o "confirmou") nem de
  que "o Grounding impediu o pedido": o pedido já estava cumprido; o trabalho extra travou.
- `truncar a 2.000 chars` foi testado como causa do bloqueio e **não** foi (as afirmações rejeitadas não dependiam
  da evidência cortada).

## 7. Decisões pendentes (do usuário — nada implementado)

1. **Revisor semântico de plano** (`RiskAnalyzer.reviewPlanWithLLM`): manter com modelo/timeout adequados, rodar só
   com sinais estruturais de risco, ou desativar? Falta acumular `[RISK-SHADOW]` em uso real.
2. **Modelo do juiz de grounding:** trocar o pesado pelo leve? Falta acumular `[GROUNDING-SHADOW-MODEL]`.
3. **Afirmações sobre ações pendentes / sobre o pedido do usuário:** o que o juiz deve receber como evidência?
   (a sombra da Sprint 3 mostrou o efeito parcial).
4. **Política de raciocínio** (teto no fallback sem streaming, o S72): decisão de política, depende de 1 e 2.
5. Se o `AgentLoop` deve entregar arquivos de apoio que ele mesmo cria; se `PlanStep` deve ter campo de origem.

## 8. Limites conhecidos

- Medições vêm de uma máquina e, no agregado, de um único modelo pesado; o contrafactual é n=3 por modelo.
- O log de produção é anterior a `[LLM-CALL]`; a atribuição por componente vem das execuções isoladas.
- O prompt do Planner não é logado: não se sabe se o fato `commands_validated` chegou ao plano inicial que
  escreveu `python3` (os dois replans seguintes usaram `py -3`).
- O juiz não devolve justificativa por afirmação; a única justificativa disponível é a saída crua (`judgeRaw`).
