# Velocidade do planejador e do juiz de grounding — experimentos de 02-03/10/2026

**Status:** registro de execução. Duas mudanças de configuração aplicadas na produção (reversíveis, ver §6); nenhuma mudança de código além da correção do add-in (`b078d40`).
**Origem:** o primeiro uso real do add-in do PowerPoint (02/10/2026) levou ~28 min para responder a um pedido de aula (goal `goal_1790993802223_d5umm`).
**Instrumentos e resultados brutos:** `docs/analises-arquiteturais/instrumentos-2026-10-03/`.

## 1. Problema

O goal levou ~28 min (23:16 → 23:44:40) e o add-in desistiu aos 20 min, deixando a resposta (106 caracteres) na outbox do servidor. Duas causas independentes:

1. **Add-in:** limite de espera de 20 min e nenhuma forma de retomar. Corrigido em `b078d40` (45 min + botão "Verificar resposta"; S317, 37 asserções).
2. **Lentidão do LLM:** o raciocínio do `glm-5.3:cloud` estourava o teto (`OllamaProvider.ts`, 8.000 caracteres × 4 para `reasoningIntensive` = 32.000 caracteres / 240 s), caindo no fallback sem streaming.

## 2. O teto de 32 mil caracteres: aumentar resolveria?

**Não.** Experimento sem teto (`planner_sem_teto.ts`; prompt real do planejador, 13.545 caracteres, N=4):

| Execução | Raciocínio | Tempo |
|---|---|---|
| 1 | 207.383 caracteres | 482 s |
| 2 | 75.592 | 216 s |
| 3 | 42.082 | 109 s |
| 4 | 27.482 | 77 s |

Três de quatro passam de 32 mil; a variação é enorme. Subir o teto troca um estouro por uma espera mais longa. Nos logs de produção (desde 26/09) o planejador teve 11 chamadas com estouro e fallback (raciocínio descartado ≈ 31.990 caracteres em todas) e 4 chamadas rápidas (20 a 46 s).

## 3. Escolha do modelo do planejador

Velocidade (`planner_modelos.ts`, mesmo prompt, N=3 por modelo, sem teto):

| Modelo | Tempo | Raciocínio | JSON válido |
|---|---|---|---|
| `glm-5.3:cloud` (antes) | 77 a 482 s | 27 a 207 mil | sim |
| `glm-5.3-flash:cloud` | 53 a 64 s | 15 a 38 mil | sim |
| `glm-5.3:cloud` com `think:false` | 161 a 379 s | zero | **não** (despeja 65 a 179 mil caracteres) |
| `gemma4:cloud` | ~4 s | zero | sim |
| `kimi-k2.7-code:cloud` | 6 a 42 s | 1 a 14 mil | sim |
| `glm-5.2:cloud` | 6 a 12 s | < 1 mil | sim |

Qualidade (`replay_qualidade.sh` → `replay_rc1.ts`, plano inicial do pedido de 14/07, N=10 por braço, com e sem contexto do PowerPoint; referência do `glm-5.3` vem dos replays de 02/10):

| Modelo | Tempo mediano sem/com contexto | Usa `powerpoint_control` com contexto | Ações usadas |
|---|---|---|---|
| `glm-5.3:cloud` | 143–223 s / 52–223 s | 2 a 7 de 10 | — |
| `glm-5.2:cloud` | 9 s / 38 s | 7 de 10 | só `getPresentation` (8) e `getSlide` (5), existentes |
| `kimi-k2.7-code:cloud` | 64 s / 32 s | 7 de 10 | **10 ações inventadas** (`setTextColor`, `setBackgroundColor`, `setSlideBackground`) |

Conclusão: `glm-5.2:cloud` escolhido; `kimi-k2.7-code:cloud` descartado (ações inexistentes falhariam na execução). Com contexto, o `glm-5.2` gerou um `.pptx` novo em 5 de 10 planos (o 5.3: 0 a 3) — sinal a vigiar, não falha comprovada.

**Limites:** mediu-se só o plano inicial, não a execução completa; "plano parece certo" não prova resultado final bom; replan e outras chamadas (RiskAnalyzer, juiz) continuam no `glm-5.3`.

## 4. Onde está o tempo (logs de produção desde 26/09)

| Chamada | n | Mediana | Abortadas | Total |
|---|---|---|---|---|
| ObserverValidator, grounding | 14 | 231 s | 12 | 47 min |
| GoalPlanner, replan | 10 | 124 s | 7 | 23 min |
| RiskAnalyzer | 12 | 69 s | 12 (todas) | 13 min |
| AgentLoop, loop de código | 14 | 15 s | 6 | 11 min |
| GoalPlanner, plan | 5 | 153 s | 4 | 11 min |

**Correção registrada:** o RiskAnalyzer **não** é uma pergunta fechada — revisa o plano e pode devolver um plano inteiro corrigido (`RiskAnalyzer.reviewPlanWithLLM`). Não é candidato a um modelo de decisão tipada. O juiz de grounding é de veredito fechado por afirmação (`SUPPORTED|NOT_SUPPORTED|NOT_EVALUABLE`).

## 5. Juiz de grounding

**Teste rotulado** (`juiz_grounding_rotulado.ts`): o juiz real de produção (`ObserverValidator.validateGrounding`, via `limits.model`), 10 casos escritos à mão (5 corretos, 5 com valor errado, item inventado ou dado ausente):

| Modelo | Acertos | Mediana | Máximo |
|---|---|---|---|
| `glm-5.2:cloud` | 10/10 | 8,7 s | 18,7 s |
| `gemma4:cloud` | 10/10 | 0,5 s | 0,9 s |
| `glm-5.3-flash:cloud` | 10/10 | 2,9 s | 5,0 s |
| `glm-5.3:cloud` (atual) | 10/10 | 6,7 s | 9,3 s |

**Leitura honesta:** os casos são curtos e fáceis; **todos** os modelos, inclusive o atual, acertam 10/10 e o atual leva 6,7 s. Logo o teste **não discrimina qualidade** e mostra que a mediana de 231 s em produção vem de prompts reais pesados (muitas afirmações, evidência de até 2.000 caracteres), não do modelo ser lento em casos simples. Só o teste em tráfego real (modo sombra) responde se o `gemma4:cloud` serve.

**Jev (TypeSafe AI, lançado 15/09/2026; suportado pelo Ollama 0.35 via `/v1/systemone`)** foi levantado pelo usuário como candidato a decisões tipadas rápidas. Fontes lidas: resultados de busca (blogs, InfoQ, post do Ollama) — **não foi testado**; velocidade e qualidade em português não verificadas. Seria candidato apenas ao juiz de grounding, não ao planejador nem ao RiskAnalyzer. Pendente: versão do Ollama local, disponibilidade do modelo, avaliação em sombra.

## 6. Mudanças aplicadas na produção (`C:\Users\lucia\NewClaw\.env`)

| Variável | Antes | Depois | Backup | Desfazer |
|---|---|---|---|---|
| `PLANNER_MODEL` | `glm-5.3:cloud` | `glm-5.2:cloud` | `.env.bak-antes-planner-5.2` | restaurar a linha e reiniciar `newclaw` |
| `GROUNDING_SHADOW_MODEL` | ausente | `gemma4:cloud` | `.env.bak-antes-shadow-grounding` | apagar a linha e reiniciar `newclaw` |

O modo sombra (`ObserverValidator.runLightModelShadow`) refaz o julgamento real com o modelo da sombra em segundo plano e registra `[GROUNDING-SHADOW-MODEL]`; **nenhum veredito é alterado**. Custo: uma chamada extra por julgamento. `OBSERVER_MODEL`, `RISK_MODEL` e demais continuam em `glm-5.3:cloud`.

## 7. Teste pelo navegador (03/10/2026, 01:16)

Dashboard `http://127.0.0.1:3090`, nova conversa, pergunta "Qual é o clima em Curitiba agora?" (usa `weather`). Captura: `img-teste-dashboard-03-10.png`.

- Resposta entregue em 16,8 s, sem erros no console do navegador.
- Juiz real (`glm-5.3:cloud`): 11,0 s, 7 afirmações, `VALIDATED`.
- Sombra (`gemma4:cloud`): **1,2 s**, 7 afirmações, `VALIDATED`; `stateAgrees=true`, contagens idênticas.
- Roteador de intenção com `glm-5.2:cloud`: 1,8 e 2,2 s.

**É um único ponto de dado.** Não prova equivalência; mostra que o mecanismo funciona de ponta a ponta e que o juiz real levou 11 s neste caso leve.

## 8. Pendências

- Comparar sombra × real quando houver ~10 julgamentos reais (`grep GROUNDING-SHADOW-MODEL logs/newclaw-audit.log`); só então decidir trocar `OBSERVER_MODEL`.
- Refazer o pedido da aula no add-in e comparar o tempo total com os 28 min de antes (validação do `PLANNER_MODEL=glm-5.2:cloud` com o goal completo).
- Replan, RiskAnalyzer, loop de código e `synthesis` seguem estourando o teto de 8 mil caracteres; não tratados.
- Ainda abertos da sessão: Etapa 2 da RFC-009 (edição), validação manual E6 da Etapa 1, decisões D3/D4/D6 da Campanha A.
- O alerta do Dependabot `84` apareceu no push de `b078d40`; não investigado.
