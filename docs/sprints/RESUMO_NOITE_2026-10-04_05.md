# Resumo da noite de 04→05/10/2026 — confiabilidade dos goals

Ponto de partida: levantamento dos 26 goals de produção dos últimos 30 dias (14 concluídos,
7 abandonados, 5 falhos). As issues detalhadas estão em `docs/issues/049` a `053` (pasta só local,
ignorada pelo git por convenção do projeto).

## O que foi feito

| Issue | Problema | Correção | Commit | Em produção? |
|---|---|---|---|---|
| 049 | Bloqueio do juiz de grounding virava o output do step (32% das etapas `agentloop`); o validador semântico relia a frase e o retry recomeçava às cegas | `ProcessedResult.groundingBlock`; o goal registra falha sem output e passa as afirmações não confirmadas ao retry | `b211b44` | sim (deploy 04/10 23:34) |
| 050 | Step concluído que agendou envio de arquivo voltava a `pending` e rodava de novo (4 goals; PDF entregue 2×) | reload do goal após `markStepDone` | `b211b44` | sim |
| 051 | Juiz recebia cada evidência cortada em 2.000 chars (20 de 55 "não avaliável" vinham disso) | evidência inteira; corte só acima do orçamento de 60 mil | `e55ebd4` | sim |
| 052 S1 | Trava `same_tool_limit` cortava 4 chamadas produtivas da mesma ferramenta | conta só chamadas improdutivas (falha ou saída repetida) | `7e9eff8` | **não** |
| 052 S2 | Travas de contexto (2,5× / +16 mil chars) cortavam turnos com ~1/3 da janela | teto derivado de `OLLAMA_NUM_CTX` (~73,7 mil chars) | `99422e0` | **não** |
| 053 | Falha do provedor (ex.: HTTP 429) registrada como sucesso do step; goal queimava 12 ciclos em 1,3 s | `ProcessedResult.providerFailure`; retry uma vez, depois encerra com mensagem honesta | `9e64404` | **não** |

Testes novos: S320–S325. Regressão completa passando em cada commit.

## Validações em execução real

- 049, 051, 053: validadas em instância isolada com LLM real.
- 050: só por teste (o caminho não ocorreu nas execuções reais).
- 052 S1: o sub-turno fez 5 `exec_command` sem trava (antes cortaria no 4º); o goal completo não foi
  validado por causa do 429.
- 052 S2: só por teste.

## Atenção

1. **Cota da nuvem do Ollama esgotada** ("Pro 5-hour limit") desde ~23:50 de 04/10. É a mesma conta da
   produção. Consumo da noite: execuções de validação + as duas sombras de grounding em produção.
2. **Sugestão (não aplicada, depende de você):** desligar `GROUNDING_EVIDENCE_SHADOW` no `.env` da
   produção — depois da 051 ela mede algo já corrigido e cada julgamento passa a custar mais uma
   chamada ao juiz `glm-5.3`. Backup do `.env` anterior: `.env.bak-antes-evidence-shadow-20261004`.
3. **Pendente de você:** push e deploy de `7e9eff8`, `99422e0` e do commit da 053.

## Achados não corrigidos (candidatos às próximas issues)

- **Uso offline:** com o Bonsai 27B local (~32 tokens/s) o planejador não responde dentro do limite de
  300 s do `fetch` não-streaming; chamadas auxiliares têm prazo de 30 s; `ModelProfileRegistry.ts:77-78`
  fixa `kimi-k2.6:cloud` nos perfis `analysis`/`execution` mesmo com provedor só-local.
- O StepSemanticValidator julga só o texto da resposta e não vê as ferramentas usadas (1 caso em
  produção + 1 na validação).
- A mensagem final de falha sugere "reformular o pedido" mesmo quando a causa é indisponibilidade.
- Issue 052, Sprint 3: decidido medir em produção antes de implementar.
