# Separação Distribuído × Aprendido

> Documento normativo. Define a fronteira entre as duas categorias físicas de conhecimento que o
> NewClaw mantém, e as regras que todo componente de conhecimento novo deve respeitar ao decidir
> onde seus dados vivem.

## 1. Objetivo

Garantir que conhecimento validado pelo processo de revisão do projeto (código-fonte, versionado,
idêntico em qualquer clone) nunca se misture com conhecimento específico de uma instância em
produção (aprendido em runtime, único daquele ambiente). As duas categorias respondem perguntas
diferentes e têm garantias de confiabilidade diferentes — tratá-las como intercambiáveis
contaminaria a mais confiável com a menos confiável.

## 2. Motivação

Um sistema open source como o NewClaw roda em ambientes que o time de desenvolvimento nunca vê.
Parte do conhecimento que o sistema usa para agir (ex.: "para instalar `ffmpeg`, rode `sudo apt
install ffmpeg -y`") é estável o suficiente para ser decidido uma vez, revisado por PR, e
distribuído igual para todo mundo. Outra parte só existe porque uma instância específica, num
ambiente específico, encontrou uma solução que funcionou ali — e essa solução pode não generalizar
(rede específica, permissões elevadas de um operador em modo GOD, uma versão de pacote que só
aquele SO tem disponível).

Misturar as duas é o erro que esta separação existe para prevenir: um fato aprendido por acidente
numa única instância, se promovido automaticamente ao catálogo distribuído, se torna "verdade" para
todo clone do projeto — inclusive ambientes onde nunca foi validado. A investigação que originou
este documento (`docs/RFC-001_APRENDIZADO_OPERACIONAL.md`, pergunta 3) descartou explicitamente
qualquer desenho onde conhecimento aprendido localmente pudesse promover-se sozinho ao catálogo
estático, pela mesma razão.

## 3. Definição

**Conhecimento Distribuído** é todo fato que:

- Vive em código-fonte, versionado no repositório (ex.: `KNOWN_DEPS` em `GoalEvaluator.ts`).
- Passa por revisão de PR antes de chegar a qualquer usuário.
- É idêntico para toda instalação do projeto, em qualquer máquina, a partir do mesmo commit.
- Muda só por decisão humana explícita (um commit), nunca por comportamento do agente em runtime.

**Conhecimento Aprendido** é todo fato que:

- Vive em armazenamento local da instância (SQLite local — `ReflectionMemory`, `CaseMemory`,
  `OperationalKnowledge`), nunca em código-fonte.
- É específico daquele ambiente — outra instalação do projeto começa sem ele.
- Muda continuamente, em runtime, como resultado de execuções reais daquela instância.
- Nunca passa por revisão humana antes de influenciar decisões futuras da mesma instância.

## 4. Responsabilidades

Um componente de conhecimento **DEVE**:

- Declarar explicitamente, no momento do desenho, a qual das duas categorias pertence — nunca
  deixar isso implícito ou decidir caso a caso.
- Persistir conhecimento distribuído exclusivamente em código-fonte; conhecimento aprendido
  exclusivamente em armazenamento local da instância.
- Tratar as duas fontes como eixos estruturalmente diferentes de confiança: distribuído carrega a
  confiança de ter passado por revisão humana; aprendido carrega só a confiança do que já foi
  observado funcionar naquela instância específica.

Um componente de conhecimento **NÃO DEVE**:

- Promover automaticamente um fato aprendido localmente para o catálogo distribuído — essa
  travessia de categoria exige decisão humana (PR), nunca é uma ação que o próprio sistema executa
  sozinho.
- Fazer um componente de conhecimento aprendido reescrever ou sobrepor uma entrada do catálogo
  distribuído — as duas podem coexistir informando a mesma decisão (ver Evidence Provider Pattern),
  nunca uma substituindo a outra.
- Introduzir uma terceira categoria "híbrida" (ex.: um cache local que finge ser fonte de verdade
  distribuída) sem que isso seja uma decisão arquitetural nomeada e documentada.

## 5. Componentes atuais

| Componente | Categoria | Chave | Onde vive |
|---|---|---|---|
| `KNOWN_DEPS` | Distribuído | nome da ferramenta | `GoalEvaluator.ts` (código-fonte) |
| `ReflectionMemory` | Aprendido | (padrão de erro, tool) | SQLite local, tabela própria |
| `CaseMemory` | Aprendido | embedding do objetivo | SQLite local, tabela própria |
| `OperationalKnowledge` | Aprendido | (ferramenta, plataforma) | SQLite local, tabela própria |

`OperationalKnowledge` (Milestone M2) é o exemplo mais recente desta separação em prática: existe
precisamente porque `KNOWN_DEPS` (distribuído) não pode crescer por entrada individual sem virar
uma lista interminável de casos de uso únicos — a solução foi criar a metade aprendida da mesma
pergunta ("como resolver essa dependência ausente"), nunca misturar as duas na mesma estrutura.

## 6. Exceção — travessia de categoria

A única forma legítima de um fato aprendido virar conhecimento distribuído é promoção manual: um
humano revisa o que foi aprendido, decide que generaliza, e o adiciona ao catálogo via PR comum —
exatamente o mesmo processo que qualquer outra mudança de código-fonte já segue. Não existe, e não
deve existir, um caminho automatizado para essa travessia. `docs/ADR-001_BASELINE_ARQUITETURAL.md`
(seção 6) registra essa promoção como item deliberadamente adiado para `OperationalKnowledge` —
"adiada até o caminho informativo se provar útil em uso real", nunca implementada como atalho.

## 7. Benefícios

- **Confiabilidade previsível**: qualquer consumidor sabe, só pela categoria, o nível de confiança
  que pode atribuir a um fato — sem precisar inspecionar sua origem caso a caso.
- **Isolamento de falha entre instâncias**: um aprendizado incorreto numa instância nunca vaza para
  outra, porque as duas categorias não compartilham armazenamento.
- **Auditabilidade do catálogo distribuído**: toda entrada em `KNOWN_DEPS` tem um PR e um autor
  humano — o histórico de git é o registro de revisão.

## 8. Relação com outros princípios

- **Evidence Provider Pattern**: a categoria de origem (distribuída ou aprendida) é uma das
  dimensões que distingue Evidence Providers entre si — ver `EVIDENCE_PROVIDER_PATTERN.md`,
  Seção 9.
- **Preservação do Raciocínio**: a exceção nomeada de resolução determinística de dependências
  (`EVIDENCE_PROVIDER_PATTERN.md`, Seção 7, item 2) aplica-se apenas ao catálogo **distribuído**
  (`KNOWN_DEPS`) — nunca a conhecimento aprendido, que segue sempre o caminho informativo puro.
- **Nunca Adivinhar**: quando não há entrada nem distribuída nem aprendida para uma consulta, o
  comportamento correto é reportar ausência, nunca inferir um valor plausível a partir de nenhuma
  das duas fontes.

## 9. Checklist para novos componentes

Antes de implementar um novo componente que armazena conhecimento, responder:

- [ ] Este fato deveria ser igual em toda instalação do projeto (distribuído), ou é específico
      desta instância (aprendido)?
- [ ] Se distribuído: existe um PR revisável para cada mudança, ou o sistema poderia alterá-lo
      sozinho em runtime? (Se a segunda, o desenho está errado.)
- [ ] Se aprendido: o armazenamento é local à instância, sem nenhum caminho automático de
      promoção ao código-fonte?
- [ ] As duas categorias, se ambas relevantes à mesma decisão, coexistem como Evidence Providers
      separados — sem que uma sobrescreva a outra?
