# Investigação — Término de turno e fatos sobre a entrega

**Data:** 2026-08-07
**Estado do código investigado:** `696f791`
**Natureza:** investigação (Fases 1-2 da `DIRETRIZ_ARQUITETURA_2026-07-13.md`). **Não é RFC, não é
ADR, não contém proposta de desenho.**

> Este documento registra achados e evidências. Não recomenda implementação, não escolhe entre
> alternativas e não decide nada. Serve como base caso se decida abrir uma ADR — e como registro
> histórico caso se decida não alterar a arquitetura.

## 1. Objetivo

Responder se a lacuna encontrada ao tentar aplicar a cláusula de visibilidade da
`SOBERANIA_DA_CONFIGURACAO.md` §1.3(b) ao `send_audio` é **específica daquela ferramenta** ou
**estrutural do protocolo de encerramento de turno**.

**Origem.** O quadro de estado de `docs/ARCHITECTURE/SOBERANIA_DA_CONFIGURACAO.md` §9 lista como
não conforme: *"`send_audio` — queda para edge-tts: atravessa localidade e custódia, só registra em
log"*. Ao iniciar essa correção, a implementação foi interrompida antes de qualquer código, porque o
mecanismo usado na Sprint 022 (o fato entra no prompt e o LLM verbaliza) não se aplica ali.

## 2. Metodologia

Fases 1 e 2 da diretriz, sem código:

* leitura dos pontos de retorno do `AgentLoop` e do `GoalExecutionLoop`;
* `grep` por `terminalTools`, `TERMINAL_TOOLS`, `earlyReturn`, `terminalOutput`;
* verificação da existência real dos arquivos das ferramentas listadas;
* leitura da cadeia de fallback de cada ferramenta de entrega existente;
* confronto com os documentos normativos vigentes (`FERRAMENTAS_DE_ENTREGA.md`,
  `SOBERANIA_DA_CONFIGURACAO.md`).

Nenhuma execução foi necessária: todos os achados são verificáveis por leitura.

## 3. Evidências

### 3.1 O `output` de uma ferramenta terminal é a resposta final, sem LLM

Três pontos distintos do `AgentLoop` encerram o turno devolvendo `result.output` diretamente:

| Ponto | Caminho |
|---|---|
| [`AgentLoop.ts:1620`](../../src/loop/AgentLoop.ts) | delivery guard, dentro de `runWithTools` |
| [`AgentLoop.ts:2072`](../../src/loop/AgentLoop.ts) | JSON-action, tool atômica |
| [`AgentLoop.ts:2163`](../../src/loop/AgentLoop.ts) | batch nativo, via `terminalBatchResult`, alimentado pelo `terminalOutput` de `:2531` |

O terceiro tem uma etapa a mais (`continueFor` com `terminalOutput`, para processar o resto do
batch), mas converge no mesmo contrato: **tool terminal com sucesso encerra o turno, e o `output` é
a resposta que chega ao canal**.

Isto não é novidade para o projeto — `FERRAMENTAS_DE_ENTREGA.md` §2 já o afirma: *"quando a
ferramenta é o último passo do objetivo, aquele `output` **é** a resposta que chega ao canal"*.

### 3.2 Assimetria entre os dois fluxos centrais

No caminho de goal existe uma chamada de LLM **depois** da entrega confirmada, cuja única tarefa é
compor a mensagem final: [`GoalExecutionLoop.ts:3606`](../../src/loop/GoalExecutionLoop.ts)
(*"A entrega deste objetivo já foi CONFIRMADA... Sua única tarefa é compor a MENSAGEM FINAL"*), com
a chamada em `:3623`. O prompt dessa composição já inclui um bloco `RESULTADOS DAS FERRAMENTAS`.

No caminho do `AgentLoop`, não existe etapa equivalente para tool terminal.

**Consequência observável:** o mesmo fato produzido pela mesma ferramenta tem um lugar por onde
chegar ao usuário num fluxo e nenhum no outro.

Nota adicional, verificada: a chamada de composição do goal (`:3623`) passa `undefined` como
`preferredProvider`, portanto não é governada pela política de substituição da `RFC-005`.

### 3.3 `terminalTools` está duplicada quatro vezes, com conteúdo divergente

| Local | Conteúdo |
|---|---|
| [`AgentLoop.ts:1605`](../../src/loop/AgentLoop.ts), `:2065`, `:2518` | `send_audio`, `send_document`, `send_image`, `send_video` |
| [`CMIBuffer.ts:24`](../../src/memory/conversational/CMIBuffer.ts) | `send_document`, `send_audio`, `send_image`, `write_tool`, `write`, `edit`, `edit_tool` |

A quarta inclui `write`/`edit` e omite `send_video`. As três primeiras são literais idênticos
repetidos no mesmo arquivo.

### 3.4 Duas das quatro ferramentas listadas não existem

`src/tools/` contém apenas `send_audio.ts` e `send_document.ts`. `grep` por `'send_image'` /
`'send_video'` em registro de ferramentas não retorna ocorrência. As duas aparecem apenas dentro das
listas de `terminalTools`.

### 3.5 Só uma ferramenta de entrega substitui recurso hoje

* `send_audio` — cadeia Piper (offline) → `node-edge-tts` (WebSocket Microsoft) → CLI Python
  `edge-tts`. A queda do Piper é registrada em [`send_audio.ts:199`](../../src/tools/send_audio.ts)
  com `log.error` e nunca chega ao usuário. Atravessa localidade e custódia.
* `send_document` — não tem cadeia de fallback de recurso; seus `catch` tratam erro de envio, não
  troca de provedor.

### 3.6 O contrato vigente tem duas categorias; o fato não cabe em nenhuma

`FERRAMENTAS_DE_ENTREGA.md` §4 estabelece:

* **conteúdo** → `output`;
* **status operacional** → log ("enviado", "pulado por debounce", tempo de upload, tamanho).

"O seu texto foi sintetizado por um serviço de terceiros" não é conteúdo entregue, e também não é
telemetria operacional. Colocá-lo no `output` reintroduz texto fixo em português no caminho do
usuário — exatamente o que o §5 daquele documento existe para remover, e que sairia igual para
usuários en-US e es-ES. Colocá-lo no log significa que o usuário nunca o vê.

## 4. Classificação dos achados

| # | Achado | Classe |
|---|---|---|
| 1 | Categoria semântica sem representação: "fato sobre a entrega" não é conteúdo nem status | **L — lacuna estrutural** |
| 2 | Três pontos de encerramento de turno com o mesmo contrato implícito | **E — comportamento estrutural (não é defeito por si)** |
| 3 | Assimetria `AgentLoop` × `GoalExecutionLoop` quanto a existir onde verbalizar | **A — assimetria entre fluxos** |
| 4 | `terminalTools` duplicada 4× com conteúdo divergente | **D — duplicação de fonte de verdade** |
| 5 | `send_image` e `send_video` listadas e inexistentes | **R — referência a algo que não existe** |
| 6 | `send_audio` é hoje a única instância que exercita a lacuna | **I — instância única de um problema geral** |

Os achados **4** e **5** são independentes do achado **1**: existem como defeito mesmo que a lacuna
de visibilidade nunca seja tratada.

O achado **6** reproduz uma configuração que o projeto já registrou duas vezes — capacidade que
nasce com um consumidor quando já se sabe de outro que precisará dela (`ADR-005`;
`ModelProfileRegistry.resolveTextProfile`, `S202`). Registrar a semelhança **não** é escolher
desfecho.

## 5. Limites da investigação

O que **não** foi analisado, e portanto não está afirmado neste documento:

* como os canais (`ChannelAdapter`) tratam a resposta final — a investigação parou na fronteira do
  Core;
* se `write`/`edit` (presentes só na lista do `CMIBuffer`) deveriam ou não ser terminais;
* o efeito da divergência entre as listas sobre a memória conversacional (`CMIBuffer` usa a sua para
  decidir corte de chunk, propósito diferente do encerramento de turno);
* se `send_image`/`send_video` já existiram e foram removidos, ou nunca existiram — não houve
  arqueologia de histórico;
* qualquer ferramenta de entrega futura (`send_email` etc.) — o `FERRAMENTAS_DE_ENTREGA.md` §1 as
  antecipa, mas não há código a examinar;
* o caminho de erro: toda a investigação trata de entrega **bem-sucedida** com um fato a comunicar;
  `success: false` já tem tratamento próprio e não foi objeto de análise.

## 6. Conclusão factual

A lacuna que impediu a aplicação da cláusula de visibilidade ao `send_audio` **não é específica
daquela ferramenta**. Ela decorre de duas propriedades do sistema, ambas verificáveis por leitura:

1. o `output` de uma ferramenta terminal é a resposta final ao usuário em três caminhos do
   `AgentLoop`, sem etapa de verbalização por LLM;
2. o contrato de saída das ferramentas de entrega prevê duas categorias — conteúdo e status
   operacional — e um fato sobre a entrega não pertence a nenhuma delas.

Hoje apenas o `send_audio` exercita essa lacuna, porque é a única ferramenta de entrega com cadeia
de substituição de recurso.

Qualquer alteração que resolva a lacuna deixa de ser uma mudança localizada em `send_audio` e passa
a modificar um contrato arquitetural compartilhado (`FERRAMENTAS_DE_ENTREGA.md`) e o protocolo de
encerramento de turno em três pontos.

**Nenhuma recomendação de implementação é feita neste documento.** A decisão de abrir uma ADR, de
tratar os achados 4 e 5 separadamente, ou de não alterar nada, permanece em aberto.
