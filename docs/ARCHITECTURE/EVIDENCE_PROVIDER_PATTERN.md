# Evidence Provider Pattern

> Documento normativo. Define um padrão arquitetural do NewClaw e as regras que todo
> componente de conhecimento — existente ou futuro — deve seguir.

## 1. Objetivo

Garantir que o julgamento estratégico do sistema permaneça concentrado em um único ponto de
decisão, mesmo quando múltiplas fontes de conhecimento especializado (ambiente, histórico de
falhas, capacidades disponíveis, skills aplicáveis) precisam influenciar esse julgamento. Um
Evidence Provider é a forma padrão pela qual conhecimento especializado chega até a decisão sem
se tornar, ele mesmo, um segundo decisor.

## 2. Motivação

Um sistema orientado a planejamento por LLM precisa de contexto rico para decidir bem — mas
cada fonte de contexto adicionada é também uma oportunidade de erosão do modelo de decisão: se
um componente de conhecimento passa a decidir por conta própria "o que fazer" em vez de apenas
"o que é verdade", o sistema deixa de ter um único lugar onde a estratégia é escolhida e passa a
ter vários, cada um capaz de divergir dos outros silenciosamente. O Evidence Provider Pattern
existe para que a expansão do conhecimento do sistema — em quantidade e em fontes — nunca
implique expansão do número de tomadores de decisão.

Resolve especificamente dois problemas: (1) impedir que um componente novo, adicionado para
resolver um caso concreto, se torne um decisor paralelo por conveniência de implementação; (2)
dar aos componentes de conhecimento já existentes uma forma comum, o que torna sua composição
previsível — vários Evidence Providers podem coexistir informando a mesma decisão sem competir
entre si.

## 3. Definição

Um **Evidence Provider** é um componente que:

- **Responsabilidade**: consulta uma fonte de conhecimento em seu próprio domínio, aplica um
  critério de relevância ou confiança definido internamente, e produz uma representação textual
  do que encontrou.
- **Entrada**: um contexto de consulta (o objetivo corrente, o step em execução, o blocker
  detectado, a lista de ferramentas disponíveis, ou combinação destes).
- **Saída**: texto — nunca uma instrução de controle de fluxo, nunca uma alteração direta do
  plano em execução. A saída pode estar vazia quando não há nada relevante a reportar.
- **Limite de responsabilidade**: um Evidence Provider decide o que é relevante o suficiente
  para ser dito. Não decide o que fazer a respeito. Essa segunda decisão pertence
  exclusivamente ao consumidor da evidência.

## 4. Fluxo arquitetural

```text
Evidence Source (banco local, probe de ambiente, arquivo de skill, histórico do goal)
        │
        ▼
Evidence Provider (filtro/threshold próprio do domínio)
        │
        ▼
Bloco de texto (evidência, não instrução)
        │
        ▼
GoalPlanner (agrega todos os blocos disponíveis no prompt)
        │
        ▼
LLM (pondera as evidências entre si e decide)
        │
        ▼
Plano
```

O ponto arquitetural central deste fluxo é que **nada entre "Evidence Source" e "GoalPlanner"
decide** — decisão só acontece depois que todas as evidências relevantes já foram agregadas e
apresentadas à camada de julgamento.

## 5. Responsabilidades

Um Evidence Provider **DEVE**:

- Aplicar seu próprio critério de relevância antes de produzir qualquer saída — silêncio
  (nenhuma evidência) é uma saída válida e esperada na maioria das consultas.
- Produzir saída em forma textual, interpretável pela camada de julgamento, nunca em forma de
  comando ou instrução de execução.
- Ser consultável de forma independente dos demais Evidence Providers — nenhum deve exigir o
  resultado de outro para funcionar.
- Degradar de forma segura quando sua fonte de dados está indisponível (retornar vazio, nunca
  lançar exceção que interrompa o fluxo de decisão).

Um Evidence Provider **NÃO DEVE**:

- Alterar o plano, a estratégia ou o fluxo de execução diretamente.
- Bloquear ou forçar a rejeição de uma alternativa sem que essa decisão passe pela camada de
  julgamento — mesmo quando o provider tem alta confiança de que uma alternativa é ruim.
- Depender do conteúdo específico de outro Evidence Provider para decidir se produz saída.
- Assumir, por conveniência de implementação, uma responsabilidade que pertence
  estruturalmente a outro tipo de conhecimento (ver Seção 9, Separação Distribuído × Aprendido).

## 6. Componentes atuais

| Componente | Origem da evidência | Consumidor | Responsabilidade |
|---|---|---|---|
| Memória de padrões de falha | Histórico de tentativas de tool calls, agregado por padrão de erro | Camada de planejamento | Reportar taxas de falha recorrentes por ferramenta/padrão, com threshold mínimo de ocorrências |
| Registro de capacidades do ambiente | Probe ativo do sistema operacional, ferramentas instaladas, rede | Camada de planejamento | Descrever o ambiente de execução real, sem prescrever o que fazer com essa informação |
| Memória semântica de contexto | Grafo de memória de longo prazo do usuário/domínio | Camada de planejamento | Recuperar contexto relevante ao objetivo corrente |
| Carregador de skills | Arquivos de skill com gatilhos textuais | Camada de planejamento | Disponibilizar instruções procedurais quando um gatilho é reconhecido no pedido do usuário |
| Guarda de diversidade de estratégia | Histórico de planos já tentados dentro do mesmo objetivo | Camada de planejamento | Sinalizar repetição de abordagem, sem impedir a repetição |
| Modelo de progresso do objetivo | Estado dos componentes concluídos/pendentes do objetivo corrente | Camada de planejamento | Descrever o que já foi alcançado e o que falta |

Cada um destes aplica seu próprio critério de relevância antes de produzir saída, e nenhum altera
o plano diretamente — todos entregam texto à camada de julgamento.

## 7. Exceções

Fugir deste padrão só é legítimo quando há uma **exceção de segurança, integridade ou
conformidade explicitamente nomeada** — nunca por conveniência de implementação ou economia de
uma chamada à camada de julgamento. Duas classes de exceção comprovada existem hoje:

1. **Bloqueio absoluto de padrões destrutivos**: certas ações (destruição irreversível de dados,
   comandos que comprometem a integridade do sistema operacional) são recusadas
   incondicionalmente, em qualquer modo operacional, sem passar pela camada de julgamento. A
   justificativa é segurança absoluta, não estratégica.
2. **Resolução determinística de dependências catalogadas**: quando uma dependência ausente tem
   solução conhecida com alta confiança para o ambiente detectado, o sistema pode aplicar essa
   solução diretamente, sem consultar a camada de julgamento sobre aquele passo específico —
   restrito a um catálogo pequeno e nomeado, nunca a uma inferência livre, e sempre condicionado
   ao modo operacional configurado.

Fora dessas duas classes, qualquer componente que decida em vez de informar deve ser tratado como
desvio do padrão, não como uma terceira exceção implícita.

## 8. Benefícios

- **Um único ponto de decisão estratégica**: novas fontes de conhecimento aumentam a qualidade
  da decisão sem aumentar o número de lugares onde decisão acontece.
- **Composabilidade**: Evidence Providers podem ser adicionados, removidos ou combinados sem
  que um precise conhecer a existência dos outros.
- **Degradação previsível**: a ausência ou falha de uma fonte de evidência reduz a qualidade do
  contexto disponível, nunca interrompe o funcionamento do sistema.
- **Auditabilidade**: como toda evidência chega em forma textual à camada de julgamento, a
  decisão final é sempre rastreável até as evidências que a informaram.

## 9. Relação com outros princípios

- **Preservação do Raciocínio**: o Evidence Provider Pattern é o mecanismo concreto pelo qual a
  Preservação do Raciocínio se realiza — um Evidence Provider é, por definição, um componente
  determinístico que fornece fato em vez de substituir julgamento. As exceções descritas na
  Seção 7 deste documento são as mesmas exceções previstas por aquele princípio.
- **Gate de Extensão antes de Criação**: antes de introduzir um novo Evidence Provider, deve-se
  provar que nenhuma extensão de um provider existente resolve a necessidade — um novo
  componente de evidência só se justifica quando representa um tipo de conhecimento
  genuinamente distinto dos já existentes (ver critério de chave/polaridade/mutabilidade na
  Seção 10).
- **Separação Distribuído × Aprendido**: essa separação define a camada de persistência de onde
  um Evidence Provider extrai sua evidência — conhecimento distribuído com o projeto e
  conhecimento aprendido em runtime são fontes de evidência estruturalmente diferentes, e um
  Evidence Provider nunca deve misturar as duas dentro do mesmo componente.
- **Nunca Adivinhar**: quando um Evidence Provider não tem confiança suficiente para reportar
  algo, o comportamento correto é retornar silêncio, nunca inferir e apresentar uma suposição
  como se fosse fato observado. Este princípio protege a integridade do que chega à camada de
  julgamento como "evidência".

## 10. Checklist para novos componentes

Antes de implementar um novo componente que informe o sistema de planejamento, responder:

- [ ] Este componente apenas produz evidências, ou decide algum aspecto da estratégia?
- [ ] A saída dele é sempre texto interpretável, nunca uma instrução de controle de fluxo?
- [ ] Ele consegue retornar vazio com segurança quando não há evidência relevante?
- [ ] Ele opera de forma independente de qualquer outro Evidence Provider?
- [ ] O tipo de conhecimento que ele representa (chave de busca, polaridade, mutabilidade) é
      genuinamente distinto dos Evidence Providers já existentes — ou pode ser servido
      estendendo um deles?
- [ ] Ele introduz uma nova fonte de verdade, ou reutiliza uma camada de persistência já
      estabelecida (distribuída ou aprendida)?
- [ ] Caso ele decida algo sem passar pela camada de julgamento, existe uma justificativa de
      segurança, integridade ou conformidade explicitamente nomeável — e não apenas
      conveniência de implementação?

Se qualquer resposta indicar que o componente decide em vez de informar, sem que exista uma
exceção nomeável equivalente às da Seção 7, o desenho deve ser revisto antes da implementação.
