# Mapa da informação das decisões do LLM — 08/10/2026

> **Pergunta do operador:** *"um LLM pensa como um ser humano — que dados a gente precisa ter para tomar uma
> decisão? Mapear todo lugar onde o LLM decide e ver se ele tem as informações necessárias, porque por isso ele
> fica travado em algumas etapas."*
>
> **Origem:** a investigação do juiz de grounding (ADR-013) achou que ele **não recebe o pedido do usuário** e,
> por isso, bloqueia respostas corretas que citam o pedido ("como você pediu, a aula é para o curso X").
>
> **Método:** leitura de cada ponto do código que chama o LLM para decidir algo (`chatWithFallback`/
> `classifyWithFallback`), anotando o que o prompt recebe de fato. Medição nos logs e no banco de produção
> quando havia como quantificar. Sem uso de modelo.
>
> É o item EVIDÊNCIA do questionário obrigatório (`RESPONSABILIDADE_ANTES_DO_MECANISMO.md`) — *"quais dados
> respondem à pergunta — e esse componente os recebe?"* — aplicado a todos os pontos de uma vez.

## 1. Tabela

| # | Componente | Pergunta que decide | O que recebe (código) | Falta para decidir como um humano | Situação |
|---|---|---|---|---|---|
| 1 | `UnifiedIntentRouter` | conversa, tarefa ou ferramenta direta? | mensagem inteira + conversa recente + última resposta do assistente (500 chars) | — | ✅ |
| 2 | `GoalExtractor` | vira goal? é ambíguo? é refinamento? qual o objetivo? | **mensagem cortada em 300 chars** (`GoalExtractor.ts:212`); contexto 300 chars por mensagem | o pedido inteiro | 🔴 |
| 3 | `DomainRegistry` | de que assunto é? | texto 400 chars | — (assunto cabe em 400) | ✅ |
| 4 | `ModelProfileRegistry.llmClassify` | que perfil de modelo usar? | mensagem 200 chars | — (categoria cabe em 200) | ✅ |
| 5 | `GoalPlanner` (plano inicial) | qual o plano? | objetivo + **pedido íntegro** (`INTENÇÃO ORIGINAL`) + ferramentas, skills, casos | — | ✅ |
| 6 | `GoalPlanner` (replanejamento) | qual a nova estratégia depois do bloqueio? | **só o objetivo resumido** (`GoalPlanner.ts:603`) + bloqueio + estratégias tentadas | o pedido íntegro | 🔴 |
| 7 | `RiskAnalyzer` | o plano tem passo faltando, ordem errada, dependência solta? | **só o objetivo resumido** (`goal.objective`) + passos (descrição) + nomes de ferramentas | o pedido íntegro | 🔴 |
| 8 | `contentStubClassifier` | o texto é conteúdo real ou molde que "descreve o processo em vez de responder ao pedido real"? | 800 chars do texto + nome da ferramenta — **sem o pedido** | o pedido | 🟡 |
| 9 | `StepSemanticValidator` | o resultado do passo serve ao passo? | descrição do passo + objetivo 200 chars + **600 chars do resultado escolhidos por palavras-chave** + fatos da execução | o resultado sem seleção por palavra-chave; o pedido inteiro | 🟡 |
| 10 | `ObserverValidator.validate` (qualidade) | a resposta atende o pedido? | pedido 500 chars (corte declarado) + **só a última ferramenta** 1000 chars (corte declarado) + resposta inteira (issue 067) | os resultados das outras ferramentas do turno | 🟡 |
| 11 | `ObserverValidator.validateGrounding` (juiz) | os dados da resposta batem com as ferramentas? | todas as evidências do turno e dos passos anteriores, inteiras + resposta inteira — **sem o pedido** | o pedido, marcado como contexto (não é dado de ferramenta) | 🔴 |
| 12 | `GoalExecutionLoop` (validador de conclusão) | o objetivo foi cumprido? | objetivo + pedido íntegro + passos + resultados + conteúdo dos arquivos gerados | — | ✅ |
| 13 | `GoalExecutionLoop` (mensagem de entrega) | como contar ao usuário o que foi feito? | objetivo + pedido íntegro + dificuldades + passos + resultados | — | ✅ |
| 14 | `AgentLoop` (evidence-check) | qual o valor exato de um parâmetro faltante? | nome/tipo/descrição do parâmetro + contexto do usuário + evidência da memória | — | ✅ |
| 15 | `AgentLoop` (turno) | o que fazer agora? | conversa, ferramentas, memória, resultados | — | ✅ |

## 2. Achados

### 2.1 A cadeia do resumo — o pedido se perde depois do primeiro plano

1. O `GoalExtractor` vê **300 caracteres** da mensagem e escreve um **resumo** (`objective`).
2. O plano inicial recebe o resumo **e** o pedido íntegro — está bem.
3. Mas a **análise de risco** e o **replanejamento** recebem **só o resumo**.

Ou seja: quando o plano falha e o NewClaw precisa de outra estratégia — o momento em que ele mais precisa entender
o que foi pedido —, ele trabalha a partir de um resumo feito de um pedaço do pedido.

Medição (banco de produção, tabela `goals`): de 365 pedidos, 96 passam de 200 caracteres. Até 06/08/2026 o próprio
banco cortava o pedido em 300 (41 goals com exatamente 300 caracteres; um deles vinha de uma mensagem de 4.094) —
corrigido em `GoalStore.create` ("O pedido do usuário é gravado ÍNTEGRO"). O corte do `GoalExtractor` é o mesmo
defeito, num ponto que aquela correção não alcançou.

Em outubro: 22 replanejamentos e 30 análises de risco com o resumo no lugar do pedido.

### 2.2 Avaliadores sem o pedido

O juiz de grounding (#11) e o detector de molde (#8) julgam uma resposta/texto **sem ver o pedido**. No juiz, isso
produziu bloqueio de resposta correta no experimento de 07/10 (caso `r2-contexto-do-pedido`): a resposta citava
o curso informado pelo usuário e o juiz não tinha como confirmar. A regra atual é uma instrução no prompt ("o que
vem do pedido do usuário, não inclua") — o juiz precisa adivinhar o que veio do pedido sem ter o pedido.

### 2.3 Seleção por palavra-chave do que o LLM vê

O `StepSemanticValidator` (#9) recorta 600 caracteres do resultado **escolhidos por coincidência de palavras-chave**
(`extractRelevantSnippet`) antes de perguntar ao LLM se o resultado serve. A heurística decide o que o LLM vê —
o LLM não pode julgar o que não recebeu. Mesmo padrão já registrado no pré-filtro "N/M termos-chave" (ADR-013 §3, P3).

### 2.4 O validador de qualidade vê uma ferramenta só

O validador de qualidade (#10) recebe apenas o resultado da **última** ferramenta. Num turno com várias
ferramentas, ele julga se a resposta "atende" sem ver o que as outras devolveram. O juiz de grounding já recebe
todas (ADR-010, `priorStepEvidence`) — o validador de qualidade não acompanhou.

## 3. Prioridade proposta

| Prioridade | Correção | Por quê |
|---|---|---|
| 1 | Replanejamento (#6) e análise de risco (#7) recebem o **pedido íntegro** ao lado do objetivo | é o momento de maior necessidade; o dado já está no goal (`userIntent`) — só não é passado |
| 2 | `GoalExtractor` (#2) recebe a mensagem inteira (com teto de orçamento declarado, como o juiz) | é a origem do resumo; mesma correção que o `GoalStore` recebeu em agosto |
| 3 | Juiz (#11) recebe o pedido como **contexto do usuário**, separado das evidências | medir antes com o modo sombra `GROUNDING_EVIDENCE_SHADOW` (já existe) e o gravador de voo |
| 4 | Detector de molde (#8) recebe o pedido | pergunta dele cita o pedido |
| 5 | Validador do passo (#9): resultado sem seleção por palavra-chave | entra na ADR própria de P3 (ADR-013 §6) |
| 6 | Validador de qualidade (#10): todas as ferramentas do turno | idem |

As prioridades 1, 2 e 4 não mudam o que o LLM decide — só dão a ele o dado que falta. A 3 muda o comportamento do
juiz e passa por medição antes.

## 4. Como confirmar com dados (próximo passo)

O campo de observação dos avaliadores (Sprint C, 08/10/2026) pede ao próprio LLM que diga o que faltou para decidir,
gravado pelo gravador de voo — sem afetar a decisão. Se este mapa estiver certo, as observações vão apontar os mesmos
lugares; se apontarem outros, o mapa está incompleto.
