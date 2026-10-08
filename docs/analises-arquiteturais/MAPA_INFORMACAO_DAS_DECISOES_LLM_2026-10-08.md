# Mapa da informação das decisões do LLM — 08/10/2026

> **Registro vigente** do princípio `docs/ARCHITECTURE/INFORMACAO_COMPLETA_PARA_DECIDIR.md`: a tabela §1 deve
> listar todo ponto do código em que o LLM decide, com a pergunta e o que recebe. O teste `S356` falha quando uma
> chamada nova ao LLM entra no código sem entrar aqui. Ao corrigir uma violação, atualize a linha (situação ✅).

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
| 2 | `GoalExtractor` | vira goal? é ambíguo? é refinamento? qual o objetivo? | **mensagem inteira**; contexto recente em trechos de 300 chars, **corte declarado** | — (Sprint V2, `S358`) | ✅ |
| 3 | `DomainRegistry` | de que assunto é? | texto 400 chars | — (assunto cabe em 400) | ✅ |
| 4 | `ModelProfileRegistry.llmClassify` | que perfil de modelo usar? | mensagem 200 chars | — (categoria cabe em 200) | ✅ |
| 5 | `GoalPlanner` (plano inicial) | qual o plano? | objetivo + **pedido íntegro** (`INTENÇÃO ORIGINAL`) + ferramentas, skills, casos | — | ✅ |
| 6 | `GoalPlanner` (replanejamento e retry minimal) | qual a nova estratégia depois do bloqueio? | objetivo + **pedido íntegro** (`INTENÇÃO ORIGINAL`) + bloqueio + estratégias tentadas | — (Sprint V1, `S357`) | ✅ |
| 7 | `RiskAnalyzer` | o plano tem passo faltando, ordem errada, dependência solta? | objetivo + **pedido íntegro** + passos (descrição) + nomes de ferramentas | — (Sprint V1, `S357`) | ✅ |
| 8 | `contentStubClassifier` | o texto é conteúdo real ou molde que "descreve o processo em vez de responder ao pedido real"? | **texto inteiro** + nome da ferramenta + **pedido do usuário** (pelo planejador e pela análise de risco) | — (Sprint V4, `S360`) | ✅ |
| 9 | `StepSemanticValidator` | o resultado do passo serve ao passo? | descrição do passo + **pedido íntegro** + **resultado inteiro** (sem seleção por palavra-chave; acima de `DECISION_PROMPT_MAX_CHARS` → não avaliável) + fatos da execução | — (Sprint V5, `S361`). O atalho por contagem de termos continua — ver ADR-013 P3 | ✅ |
| 10 | `ObserverValidator.validate` (qualidade) | a resposta atende o pedido? | **pedido íntegro** + **todas as ferramentas do turno** (trechos de 2000 chars, corte declarado) + resposta inteira; acima de `DECISION_PROMPT_MAX_CHARS` → não avaliável | — (Sprint V6, `S362`) | ✅ |
| 11 | `ObserverValidator.validateGrounding` (juiz) | os dados da resposta batem com as ferramentas? | todas as evidências inteiras + resposta inteira + **pedido do usuário como contexto** (seção própria, nunca evidência; também na revalidação parcial) | — (Sprint V3, `S359`; medição ao vivo pendente da cota) | ✅ |
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

## 5. Validação ao vivo (Sprint E, 08/10/2026 — Bonsai 27B local)

Instância isolada, provedor `bonsai` (llama-server local), todos os `MODEL_*` vazios; pergunta de leigo "Qual a
previsão do tempo em Curitiba hoje?" enviada numa conversa antiga (que tinha um pedido de exercícios de sub-redes).

- **Sem modelo, a chamada não sai (issue 068b):** o roteador estourou 30 s no Bonsai, caiu no Ollama (sem modelo
  escolhido nesta configuração) e o log registrou "Nenhum modelo foi escolhido…" — nenhum pedido sem modelo saiu.
- **Roteamento degradado:** com o roteador fora do prazo, a heurística classificou o pedido como conversa; a
  ferramenta de clima não foi chamada, e o agente — com o contexto antigo da conversa — **regravou o arquivo de
  sub-redes** antes de qualquer avaliação.
- **O campo "faltou" funcionou na primeira chamada real:** o validador de qualidade reprovou a resposta e escreveu
  *"Faltou registro de consulta a uma fonte de previsão do tempo para validar os valores informados na resposta."*
  — exatamente o que aconteceu.
- **O juiz bloqueou a entrega:** 240 s sem veredito no Bonsai → UNVALIDATED → o usuário recebeu "Não consegui
  confirmar se a resposta é sustentada pelos dados obtidos nesta tentativa. Pode pedir de novo?". Efeito gravado.

Pendências que o teste revelou:

1. **Ação antes do julgamento:** o arquivo foi regravado antes de o juiz decidir; o bloqueio impede a resposta, não
   o efeito colateral já feito. Questão de arquitetura, não de informação — registrar como item próprio.
2. **Gravador de voo com provedor OpenAI-compatível:** a parte "durante" (primeiro trecho, raciocínio a cada 15 s)
   só é preenchida pelo leitor do Ollama; no Bonsai ficaram só desfecho e duração.
3. **Strata 120B não testado:** o Windows bloqueou o motor (`strata.exe`) pelo Controle Inteligente de Aplicativos
   (Smart App Control). Liberar é decisão do operador (configuração de segurança do sistema).
