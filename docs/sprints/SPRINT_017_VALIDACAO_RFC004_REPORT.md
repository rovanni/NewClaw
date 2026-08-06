# Sprint 017 — Validação end-to-end da RFC-004

**Data:** 2026-08-05
**Escopo:** validar, em execução real, que o incidente que originou a
`docs/decisoes/RFC-004_INGESTAO_DE_MIDIA_MULTIPLA.md` não se reproduz.
**Ambiente:** instância isolada (porta 3207, banco/workspace próprios), LLM real, visão real
(modelo multimodal local), filesystem real. Nenhum mock.

---

## 1. O incidente original

04/08/2026, canal Telegram, 12 imagens enviadas de uma vez com a pergunta "Poderia explicar cada
projeto?".

| Métrica | Resultado |
|---|---|
| Imagens recebidas | 12 |
| Imagens efetivamente analisadas | 4 |
| Imagens salvas mas nunca analisadas | 5 |
| Imagens perdidas sem qualquer resposta | 3 |
| Respostas enviadas | 9, todas isoladas |
| Tempo total | 27 minutos |
| A pergunta foi respondida? | **Não** |

## 2. Cenário A — acima do teto de anexos (12 imagens)

```text
POST /api/chat  (12 arquivos)
HTTP=400  t=0.065s
{"success":false,"error":"too_many_files","max":10,"maxBytes":20971520}
```

Antes: `HTTP 500` com corpo `<!DOCTYPE html>…MulterError: Too many files…`, que a interface tentava
interpretar como JSON, exibindo "Unexpected token '<'" ao usuário.

Agora: código estável em 65 ms, traduzido no cliente nos três idiomas, com o limite viajando junto
para que a mensagem cite o número correto.

## 3. Cenário B — dentro do teto (10 imagens)

```text
POST /api/chat  (10 arquivos)
HTTP=200  t=265.6s

[MessageBus] message_received  Poderia explicar cada projeto?  type=photo    ← UMA mensagem
[MessageBus] attachments_processed  total=10 ok=10 falhou=0 excedente=0
[MessageBus] processing_done  Duration: 64837ms  responseLength=3985
workspace: 10 arquivos .jpeg
```

Resposta ao usuário: **nove projetos explicados**, um por slide, com tabela-resumo ao final
(projeto, estrelas, categoria). O agente ainda observou por conta própria:

> O projeto de número 5 não aparece entre as imagens enviadas. Se você tiver esse slide, posso
> explicar também!

A observação está correta — foram enviadas 10 das 12 imagens do conjunto original, e o slide 5
ficou de fora. O sistema percebeu a lacuna a partir do conteúdo, sem que ninguém a apontasse.

## 4. Comparação

| | Incidente (04/08) | Validação (05/08) |
|---|---|---|
| Imagens analisadas | 4 de 12 | **10 de 10** |
| Imagens perdidas em silêncio | 3 | **0** |
| Respostas | 9 desconexas | **1** |
| Tempo | 27 min | 4 min 25 s |
| Pergunta respondida | não | **sim** |

## 5. O que cada sprint contribuiu para este resultado

| Sprint | Contribuição observável nesta validação |
|---|---|
| 012 | A visão não morre no meio da sessão — as 10 análises usaram o mesmo perfil, sem `vision_not_configured` |
| 013 | `attachments_processed total=10 ok=10` — antes, o laço parava na primeira |
| 014 | Nenhuma perda por falha transitória de download |
| 015 | O cenário de 12 imagens devolve erro legível em vez de HTML |
| 016 | Uma única `message_received` — verificado por teste; no canal web o agrupamento já era nativo |

## 6. Limites desta validação

* **O agrupamento de álbum do Telegram (Sprint 016) não foi validado em canal real.** O Dashboard
  web já entrega N anexos numa única mensagem, então este teste não exercita o buffer por
  `media_group_id`. A cobertura da 016 é o `S200` (15 verificações, incluindo teto, `stop()` e
  isolamento entre chats) — mas a entrega fragmentada real do Telegram só se reproduz enviando um
  álbum de verdade ao bot. **Pendente de execução com canal real.**
* **Modelo de visão diferente do usado em produção.** A validação usou um modelo multimodal local;
  a instância de produção do operador estava configurada com um modelo sem suporte a visão no
  momento do incidente (achado registrado à parte).
* **Tempo dominado pela visão.** Dos 4 min 25 s, a maior parte foi inferência de visão sequencial
  (uma chamada por imagem). A `RFC-004` registra explicitamente que não trata disso: paralelizar
  N inferências de visão em hardware modesto trocaria um defeito por outro.

## 7. Conclusão

O incidente não se reproduz. As imagens chegam todas ao agente, nada é descartado em silêncio, o
excedente é comunicado com erro legível e a pergunta original é respondida uma única vez.

Suíte de regressão ao final desta sprint: **201 testes** (`S195`–`S201` acrescentados pela RFC-004).
