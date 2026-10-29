# ADR-032 — A resposta final do objetivo é escrita para o usuário, não descrita para o sistema

Data: 29/10/2026. Status: **proposta** — aguarda a decisão da operadora. O incremento 0 (áudio, S462) já está implementado
porque não depende desta decisão (ver "Incremento 0").

Origem: issue 066, achado **D** (testes reais de 17–19/10/2026) — quarta ocorrência da classe registrada em `S175`.

## Fase 1 — Compreensão

### Os fatos

| Caso | O que o usuário recebeu | De onde veio |
|---|---|---|
| River (Linux, 17–19/10), resposta em áudio | "Objetivo concluído: obtida a cotação… A resposta final foi entregue ao usuário em texto claro…" | parecer do avaliador como nota do áudio |
| Voice Studio (Windows, 19/10) | "Entregue o caminho confirmado…" | parecer do avaliador; o plano só tinha `exec_command`/`web_navigate`/`memory_write` |
| Aula 13 (Windows, 19/10) | relato do script de coleta da geração 1 | a aula (`Plano_de_Aula_13.md`) foi feita na geração 0 e nunca citada nem enviada |

### A causa, no código

`GoalExecutionLoop.buildResult()` escolhe o texto final nesta ordem:

1. o `resumo` do avaliador de conclusão (`descritorConclusaoDoObjetivo`, campo extra `resumo` — "resumo do que foi feito e
   entregue"), quando há entrega separada ou o objetivo falhou;
2. `pickBestAvailableContent()`: o último passo com texto legível (`agentloop`, `weather`, `crypto_analysis`) **da geração
   atual do plano**;
3. o resultado do último passo concluído, ou o próprio resumo.

Três defeitos estruturais, um por caso:

- **(a)** a sentinela do áudio contava como entrega separada → o resumo virava a nota (River). **Corrigido no incremento 0.**
- **(b)** sem passo de texto na geração atual, o resumo vence — e o resumo é uma DESCRIÇÃO para o sistema ("foi entregue"),
  não a resposta (Voice Studio).
- **(c)** só a geração atual concorre — o entregável de uma geração anterior se perde (Aula 13). A restrição é deliberada
  (Sprint de Provenance: `step_1` se repete entre gerações, e uma estratégia abandonada não pode vencer).

### Tentativas anteriores

`S48` (resumo genérico), `S175` (resumo apagando a explicação de "scaffolding"), o filtro de `AUTO_DELIVERY_IDS` ("Entrega
confirmada via send_audio") e `S230` (provenance). Cada uma tratou a STRING que vazou; a regra "um texto escrito PARA O
SISTEMA pode virar a mensagem ao usuário" continua de pé.

## Fase 2 — Crítica (Responsabilidade antes do Mecanismo)

- **PERGUNTA:** o que o usuário deve ler ao fim do objetivo?
- **RESPONSABILIDADE:** escrever a resposta ao pedido, com o que foi feito e entregue — no idioma do usuário.
- **EVIDÊNCIA:** os resultados de TODAS as gerações e o conteúdo real dos arquivos (`artifactContentEvidence` já existe).
- **AUTORIDADE:** um LLM — redigir é interpretação. Hoje quem escreve é o avaliador, mas a pergunta dele é OUTRA ("foi
  concluído?"), e o campo `resumo` foi pedido como relatório.
- **ESTADO:** o texto final do objetivo (`GoalResult.finalOutput`).
- **CONSUMIDOR:** o usuário, pelo canal.

Motivos para NÃO fazer:

- uma chamada nova de LLM no fim de todo objetivo viola a regra de custo (substituir, nunca somar);
- deixar a geração anterior concorrer em `pickBestAvailableContent` desfaz a proteção de provenance;
- o avaliador não recebe a diretiva de idioma — o texto dele sai em pt-BR para um usuário en-US/es-ES (já registrado em
  `buildResult`).

## Fase 3 — Alternativas

| | Alternativa | Custo | Problema |
|---|---|---|---|
| A | Trocar o campo `resumo` do avaliador por `resposta_ao_usuario` ("escreva ao usuário, no idioma dele, a resposta ao pedido com o que foi feito e entregue"), com a diretiva de idioma e a evidência de todas as gerações | zero chamada nova (mesmo juiz, campo extra — padrão do ADR-029) | o avaliador passa a ter duas tarefas na mesma chamada; precisa ver o conteúdo inteiro (Informação Completa) |
| B | Chamada nova de redação no fim do objetivo | +1 chamada por objetivo | regra de custo |
| C | Deixar gerações anteriores concorrerem em `pickBestAvailableContent` | zero | reabre o defeito de provenance |
| D | Mais um caso especial por string | zero | quinta ocorrência da mesma classe |

## Fase 4 — Proposta

**Alternativa A**, em dois incrementos:

1. **Campo `resposta_ao_usuario`** no lugar de `resumo` em `descritorConclusaoDoObjetivo`, com `buildLanguageDirective` no
   prompt do avaliador. `buildResult` usa esse texto quando não há passo de texto legível na geração atual (caso b) e como
   nota de arquivo entregue (no lugar do relatório atual). O texto de um passo `agentloop` continua vencendo quando existe
   — ele é o entregável em si.
2. **Evidência de todas as gerações** na entrada `artefatos` do avaliador: arquivos produzidos em qualquer geração e ainda
   não entregues entram com o conteúdo (`producedArtifactPaths` + `artifactContentEvidence`, que já existem), para a
   resposta poder citar ou oferecer o que foi feito antes do replanejamento (caso c). Sem mexer na regra de provenance de
   `pickBestAvailableContent`.

Riscos que ficam: o avaliador pode escrever uma resposta pior que a do passo de texto (mitigado: o passo de texto continua
vencendo); prompt maior no fim do objetivo (medir tokens antes e depois).

## Fase 5 — Validação (a fazer, com OK de cota)

- Regressão: S175, S230, S48, S462 + teste novo para os três casos reais.
- Real (nuvem, cota a combinar): repetir os três pedidos (River em áudio, Voice Studio, Aula 13 com replanejamento) e
  conferir o texto final e o idioma.

## Incremento 0 — áudio (já implementado, S462)

O texto falado É a resposta (FERRAMENTAS_DE_ENTREGA): a sentinela do áudio deixou de contar como entrega separada, e o
output de `send_audio` (o texto falado) passou a ser candidato em `pickBestAvailableContent`. Arquivo entregue continua
usando o parecer como nota (comportamento de S175).
