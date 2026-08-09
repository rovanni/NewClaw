# Responsabilidade antes do mecanismo

Documento normativo. Leitura obrigatória antes de propor qualquer decisão de avaliação,
classificação, sucesso, falha, relevância, intenção, grounding ou recuperação — em código novo,
correção, refatoração, componente novo, guardrail novo, fluxo novo de AgentLoop, e em qualquer
ADR/RFC ou investigação arquitetural futura.

Esta regra não pertence a um caso. Ela existe para impedir uma classe de erro que já paralisou
projetos: a arquitetura ser progressivamente decidida pelo mecanismo mais próximo da mão, em vez
de pela responsabilidade que deveria deter a decisão.

## O princípio

> **Antes de escolher COMO uma decisão será implementada, defina QUAL responsabilidade
> arquitetural tem autoridade para tomá-la.**

Ordem obrigatória:

```text
PERGUNTA  →  RESPONSABILIDADE  →  EVIDÊNCIA  →  AUTORIDADE  →  ESTADO/EFEITO  →  MECANISMO
```

Ordem proibida:

```text
PROBLEMA → regex/heurística/LLM → nova regra → exceção → outra regra
```

O mecanismo é a **última** decisão, nunca a primeira.

## O questionário obrigatório

Toda decisão nova de avaliação precisa responder, nesta ordem:

```text
PERGUNTA:       o que exatamente estamos tentando determinar?
RESPONSÁVEL:    qual componente possui essa responsabilidade?
EVIDÊNCIA:      quais dados respondem à pergunta — e esse componente os recebe?
AUTORIDADE:     esse componente pode tomar essa decisão?
ESTADO:         qual estado deve ser produzido?
CONSUMIDOR:     quem utilizará esse estado, e ele significa o que o consumidor supõe?
MECANISMO:      por que determinismo, LLM ou composição é apropriado?
```

**Se os seis primeiros pontos não estiverem demonstrados, não implementar.** Não é uma
formalidade: cada um deles corresponde a uma falha real já observada neste repositório.

## Passo 6 — determinismo valida, LLM interpreta

Só depois de fixados pergunta, responsável, evidência, autoridade e estado é que se escolhe o
mecanismo. E aí vale a distinção:

### Determinismo responde perguntas sobre propriedades objetivas

| pergunta | por quê |
|---|---|
| Este JSON tem a estrutura esperada? | forma verificável |
| Este campo existe? Tem o tipo certo? | propriedade objetiva |
| Este valor pertence a este enum? | conjunto fechado |
| Este ID existe? Este estado é `VALIDATED`? | identidade e estado |
| Este `exitCode` é 127? | sinal emitido pela máquina |
| Este timeout expirou? Este texto cabe no contexto? | comparação numérica |
| Qual estado resulta desta precedência? | álgebra sobre enum |
| Este step tem `id` prefixado `verify_`? | rótulo produzido pelo próprio sistema |

Também: invariantes, ordenação, controle de fluxo, presença/ausência objetiva de campo.

### LLM responde perguntas sobre significado

| pergunta | por quê |
|---|---|
| A ferramenta respondeu à pergunta? | pertinência é semântica |
| Esta resposta está sustentada pela evidência? | groundedness é semântica |
| O resultado da ferramenta significa que a operação deu certo? | sucesso não é forma |
| O agente está dizendo que **não encontrou o dado** ou que a ferramenta **falhou**? | são coisas diferentes, e a diferença está no significado |
| Esta resposta atende à intenção? | intenção é semântica |
| O agente realmente executou a ação que afirma ter executado? | alegação é semântica |

**Determinismo não é proibido, e "LLM para tudo" não é a regra.** A regra é usar o mecanismo
adequado à natureza da pergunta.

## Proibição — regex como interpretador semântico

Regex, `includes`, `startsWith`, busca textual, listas de palavras e heurísticas equivalentes
**não podem** interpretar significado de linguagem natural quando essa interpretação determina
estado, sucesso, falha, bloqueio, replanejamento ou qualquer outra decisão arquitetural.

> A presença de uma expressão em um texto não prova o significado do texto.

## Proibição — trocar apenas o mecanismo

Substituir regex por LLM **não** corrige uma decisão que já estava no componente errado, ou que
produz um estado que não corresponde à realidade.

```text
regex → tool_error          NÃO deve virar automaticamente          LLM → semantic_mismatch
```

se nenhum dos dois estados representa corretamente a pergunta que deveria ter sido respondida.
Antes de trocar o mecanismo, demonstre que **a decisão pertence àquele componente** e que **o
estado produzido é semanticamente correto**.

## Regra de evidência

> Nenhum componente pode tomar uma decisão semântica sem possuir as evidências que respondem à
> pergunta.

Portanto `LLM + evidência insuficiente` não é solução arquitetural — não é melhor que
`regex + evidência insuficiente`, é o mesmo erro com custo maior. Quando o componente responsável
não tem a evidência, o que está errado é o **fluxo de informação**, e é ele que deve ser corrigido
— não se acrescenta outro avaliador.

## Regra — não criar avaliadores para compensar avaliadores

Evitar:

```text
Avaliador 1 → Avaliador 2 → Avaliador 3 → LLM para corrigir o 3 → regex para proteger o LLM
```

Quando esse encadeamento aparecer, trate-o como sintoma de **responsabilidade mal atribuída**, não
como necessidade de mais uma camada. A preferência é sempre:

```text
pergunta bem definida → um responsável → evidência adequada → uma decisão semântica
```

## Regra de custo

Uma avaliação semântica deve **substituir** a decisão determinística equivalente, nunca somar-se a
ela. `regex + LLM` para a mesma pergunta duplica custo, aumenta latência e cria duas autoridades
competindo pela mesma decisão.

Composição só se justifica quando os componentes respondem **perguntas diferentes**.

Precedente: `ARCH-013` removeu uma segunda chamada de LLM em `evaluateAgentStepSuccess` justamente
porque duplicava o `StepSemanticValidator` (`GoalExecutionLoop:2578-2588`). Medição que dá tamanho
ao risco: num turno real de 692 s, **94,7% foi inferência** — arquitetura correta que ignora custo
também paralisa o produto.

## Regra da escalada

> **Se uma solução determinística começa a exigir exceções para exceções, pare e questione a
> abstração em vez de acrescentar outra regra.**

O ciclo a evitar:

```text
regex ruim → mais regras → exceções → regras para exceções → mais heurísticas → LLM para compensar
```

Quando ele aparecer, a investigação volta à pergunta **"quem deveria estar tomando essa
decisão?"**.

Exemplo real neste repositório, e de como a escalada foi quebrada:

```text
ADR-003  regra:    "o primeiro exec_command bem-sucedido após o blocker é o corretivo"
   ↓ exceção real: aprendeu um `where` (sonda) no lugar da instalação
ADR-004  2ª regra: isToolExistenceProbe() — exclui where/which/command -v      [texto]
   ↓ exceção real: `echo verificando-...` não é sonda e passava
ADR-009  3ª regra: !planStepId.startsWith('verify_')                           [estrutural]
```

A terceira não empilhou mais uma condição sobre o texto: **trocou a fonte do sinal** por um rótulo
estrutural que o próprio sistema injeta. É esse o movimento correto.

## Pré-filtro determinístico — permitido, sob suspeita

Um atalho determinístico antes do LLM é legítimo quando elimina apenas casos **objetivamente**
fora de escopo (ex.: output vazio ou com menos de 15 caracteres). Deixa de ser legítimo quando
decide por semelhança textual e pode descartar um caso que o LLM classificaria de outro jeito.

Pergunta obrigatória para qualquer pré-filtro:

> **Este filtro pode eliminar justamente um caso que o LLM classificaria de outro jeito?**

Se sim, ele não é pré-filtro: é a decisão tomada por determinismo, com o LLM de fachada.

## Zona cinzenta — string de máquina em canal de prosa

`ENOENT`, `Traceback`, `command not found`, `permission denied` são strings de máquina, não
linguagem natural. Mas procurá-las **dentro de um texto escrito por um LLM** volta a ser
interpretação: o modelo pode citá-las ao explicar o que aconteceu, sem que nada tenha falhado
agora.

Quando existir o sinal estrutural equivalente (`exitCode`, código de erro, campo do `ToolResult`,
`tool_result.success` no `ExecutionTrace`), ele é a fonte correta. Procurar em prosa é sintoma de
que o sinal se perdeu no caminho — e o que se corrige é o caminho.

## Regra contra raciocínio por mecanismo

Em qualquer investigação futura, **não comece perguntando** *"devemos usar regex ou LLM?"*.

```text
1.  Que decisão precisa ser tomada, e quem deve tomá-la?
2.  Essa decisão é estrutural ou semântica?
3.  Só então: qual mecanismo é adequado?
```

## Exemplo canônico — River, 09/08/2026

Registrado como **exemplo da regra**, não como sua justificativa: a regra vale independentemente
deste caso.

Pergunta de usuário: *"Qual o valor da cripto River?"*. O agente produziu uma resposta correta,
que a barreira de groundedness aprovou como `VALIDATED` — porque era fiel à evidência: as
ferramentas realmente haviam falhado.

```text
"…informo que não foi possível obter o preço atual ou Market Cap em tempo real para…"
        ↓  regex sobre os primeiros 500 chars
success = false
        ↓  o `output` vira `error`
blocker kind=tool_error tool='unknown'  desc="Erro em 'unknown': <a própria resposta>"
        ↓
replan → nova estratégia → as mesmas ferramentas falham → resposta honesta de novo → …
```

Resultado: 12 ciclos, 5 replans, ~11 minutos, `success=false`, nenhuma resposta ao usuário. O
`ReflectionMemory` registrou o episódio como falha — a memória aprendeu com um acerto.

As cinco falhas arquiteturais, e a regra que cada uma viola:

| # | falha | regra violada |
|---|---|---|
| 1 | pergunta semântica tratada como determinística | determinismo valida, LLM interpreta |
| 2 | resposta de AgentLoop tratada como resultado de ferramenta | responsabilidade / estado |
| 3 | estado produzido (`tool_error`, `tool='unknown'`) não correspondia à realidade | ESTADO do questionário |
| 4 | evidência estrutural do `ExecutionTrace` disponível e descartada | regra de evidência |
| 5 | decisão posterior operando sobre estado incorreto | CONSUMIDOR do questionário |

O erro não foi "a regex estava errada". Foi que a pergunta nunca foi decomposta, o responsável
nunca foi definido, e a evidência que responderia à parte estrutural estava a poucas linhas de
distância, descartada.

## Relação com os outros princípios

- **`EVIDENCE_PROVIDER_PATTERN.md`** — responde *o que* um componente de conhecimento pode
  decidir (fornecer fato, nunca decidir pelo Planner). Este documento responde *quem* deve
  responder a pergunta e *com qual evidência*. São ortogonais.
- **`NUNCA_ADIVINHAR.md`** — proíbe inferir dado ausente. Irmã desta: transformar ausência de
  sinal em conclusão semântica também é adivinhar.
- **Princípio da Preservação do Raciocínio** (na diretriz) — proíbe o componente determinístico de
  decidir o rumo no lugar do Planner. Aqui a fronteira se estende à avaliação: não basta não
  decidir o rumo; não se deve **interpretar** por conta própria o que só o significado responde.
- **`LOCALIDADE_DA_RECUPERACAO.md`** — política de recuperação vive onde a falha ocorre e precisa
  ser alcançável ali. Correlato: o responsável semântico precisa ser alcançável no ponto em que a
  pergunta surge, e não atrás da resposta de outro avaliador.

## Esta regra não vira código

Ela orienta decisão humana e arquitetural **antes** da implementação. Não deve ser transformada em
framework, classe, validador, middleware ou verificador automático — isso seria criar mais uma
camada exatamente onde a regra manda reduzir camadas.

## Retrato em 09/08/2026 (não é lista de tarefas)

Mecanismos que hoje interpretam linguagem natural por meio determinístico. Registrados para não
ficarem implícitos; converter todos de uma vez seria a mesma pressa que a regra existe para evitar.

| componente | pergunta que responde |
|---|---|
| `GoalExecutionLoop:2605` `failurePattern` | esta resposta indica execução malsucedida? |
| `GoalExecutionLoop:2612` `successPattern` | este step deu certo? |
| `AgentLoop:744-783` (três detectores) | o agente alegou ação que não realizou? |
| `SkillLearner:471-472` | qual a intenção do usuário? |
| `StepSemanticValidator:104` `fastPathCheck` | o output é pertinente ao step? (pré-filtro) |
| `planning/inferExpectedExtensions.ts:42-56` | que tipo de artefato foi pedido? |
| `ModelProfileRegistry:294` | que perfil de modelo usar? |
| `GoalPlanner` — 4 diretivas por regex | débito já declarado na diretriz |

Contra-exemplos legítimos, **preservar**: `ProtocolParser.looksLikeLeakedToolCall` (forma de JSON
já parseado, nunca substring), `parseGroundingOutput` (schema e enum), `aggregateGrounding`
(precedência sobre enum), `TERMINAL_DELIVERY_TOOLS.includes()` (pertinência a conjunto),
`OperationalKnowledge` com âncora posicional e prefixo `verify_` (sinal estrutural que substituiu
heurística temporal), `contentStubClassifier` (S77 trocou regex por LLM).
