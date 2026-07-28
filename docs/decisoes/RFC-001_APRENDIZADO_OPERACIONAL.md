# RFC-001 — Arquitetura do Aprendizado Operacional do NewClaw

> Status (atualizado 2026-07-27): primeira fatia da Milestone M2 (`OperationalKnowledge`) já
> implementada e validada em ambiente real (Windows e Linux) — estritamente o caminho
> informativo descrito na pergunta 5 (Evidence Provider puro). A extensão tática discutida na
> pergunta 10 **deixou de estar adiada** — `docs/decisoes/RFC-003_AQUISICAO_CONHECIMENTO_OPERACIONAL.md`
> (2026-07-27) formaliza essa extensão, reutilizando integralmente o modelo de confiança definido
> na pergunta 2 abaixo, e adiciona os passos que antecedem a cadeia original desta RFC
> (Identificar → Descobrir → Pesquisar → Formular hipótese, cobrindo o caso "não sei como
> resolver, preciso pesquisar" que esta RFC não cobria) — ver "Adendo (RFC-003)" ao final deste
> documento. Implementação de código ainda pendente (RFC-003, seção "Próximos Passos").
> Origem: investigação arquitetural de 2026-07-23/24, decorrente da Milestone M1
> (Self-Healing de Dependências — `docs/DIRETRIZ_ARQUITETURA_2026-07-13.md`).

## Contexto

A Milestone M1 fortaleceu o caminho de autoinstalação existente (`KNOWN_DEPS`, classificação
de `blocker.kind`, `resolveInstallCommand()`) sem alterar sua filosofia. Durante essa
investigação ficou estabelecido que o verdadeiro problema não é mais "instalar dependências" —
é: **como transformar uma resolução operacional bem-sucedida em conhecimento reutilizável sem
violar os princípios arquiteturais do NewClaw?**

## Princípios obrigatórios (restrições já estabelecidas)

1. `GoalPlanner` continua sendo o único decisor estratégico.
2. Nenhum novo mecanismo pode reduzir a autonomia do agente fora dos casos já considerados
   determinísticos.
3. Todo conhecimento aprendido deve funcionar como um Evidence Provider — com a mesma exceção,
   já nomeada e pré-existente a esta RFC, formalizada em
   `docs/ARCHITECTURE/EVIDENCE_PROVIDER_PATTERN.md` (Seção 7, item 2): resolução determinística
   de dependência catalogada, restrita a um catálogo pequeno e nomeado, nunca a inferência livre.
   Essa exceção se aplica hoje só ao catálogo **distribuído** (`KNOWN_DEPS`) — nunca a
   conhecimento **aprendido** (ver pergunta 3 e `docs/ARCHITECTURE/SEPARACAO_DISTRIBUIDO_APRENDIDO.md`).
   A análise crítica da pergunta 10 (abaixo) detalha por que esta formulação, sem a ressalva, era
   forte demais; a implementação real desta fatia optou por não usar a exceção — ver caminho
   informativo (pergunta 5).
4. O Planner continua decidindo se utilizará ou não qualquer conhecimento aprendido.
5. O aprendizado nunca deve introduzir regras imperativas escondidas.

## 1 — Qual é a unidade de conhecimento operacional?

Nem "um comando" isolado, nem "ambiente completo" — o próprio código já demonstra a
granularidade certa: **(ferramenta ausente × plataforma) → comando que resolve**. Evidência
direta: `DependencyInfo.installByPlatform` (já usado por `marp` e, desde a M1, por `puppeteer`)
é literalmente um mapa `{windows, linux, macos} → comando` — a arquitetura já assume que
"ferramenta" sozinha não é granularidade suficiente. Ir mais fundo (versão de pacote, distro
específica) não tem precedente em nenhuma das ~22 entradas atuais de `KNOWN_DEPS` e contradiria
o princípio já formalizado de não criar taxonomia maior que o necessário (mesma decisão já
tomada pela Sprint do `CaseMemory` ao recusar granularidade extra em `classifyOperation()`).

A unidade **não inclui** o objetivo do usuário que motivou a instalação — acoplar a isso
reproduziria o eixo errado que já invalidou `CaseMemory` para esse fim.

## 2 — Quando uma resolução pode ser considerada conhecimento confiável?

| Critério | Precedente existente | Trade-off |
|---|---|---|
| Um único sucesso | Nenhum dos 3 componentes atuais promove em 1 evento | Rápido de aprender, arrisca promover acidente de contexto único |
| Múltiplos sucessos | `ReflectionMemory` exige `total>=2` antes de qualquer constraint | Mais seguro, mas atrasa reuso exatamente no caso que motivou a investigação |
| Sucesso por plataforma | Já obrigatório, herdado de `installByPlatform` | Não é alternativa — é dimensão não-opcional |
| Sucesso por versão | Sem precedente no projeto | Provável over-engineering |
| Condicionado a contexto | Parcial (`ReflectionMemory` usa janela de tempo) | Precisa de escopo definido (SO), senão fragmenta o conhecimento até ficar inútil |

Achado relevante: `ReflectionMemory` já tem dois níveis de confiança para o mesmo dado bruto —
`buildContextHint()` a partir de 30% de falha (sugestão fraca) e `buildConstraints()` só a
partir de 90% (regra forte). Precedente direto para não tratar "confiável" como binário aqui:
um sucesso isolado pode virar evidência textual fraca de imediato (baixo custo de errar — nunca
decide sozinho); só um padrão mais robusto deveria ser elegível a virar atalho determinístico no
mesmo nível de confiança que `KNOWN_DEPS` hoje tem (alto custo de errar ali).

## 3 — Separar conhecimento distribuído (KNOWN_DEPS) de conhecimento aprendido localmente?

Deve existir, por motivo estrutural: `KNOWN_DEPS` é código-fonte — versionado, revisado por PR,
distribuído identicamente para qualquer clone (open source). Conhecimento aprendido localmente é
específico da instância. Misturar as duas coisas arriscaria um fato válido só num ambiente
contaminar o catálogo que todo mundo recebe igual. A separação já existe fisicamente no
projeto — é a mesma fronteira que já separa `KNOWN_DEPS` (arquivo) de
`ReflectionMemory`/`CaseMemory` (SQLite local). Conhecimento operacional aprendido deveria
ocupar a mesma categoria física que esses dois já ocupam.

## 4 — Como evitar que o agente aprenda soluções incorretas?

- **Comandos temporários/workarounds**: só promover a partir de evidência de nível de GOAL
  (`successCriteria` cumprido ou artefato entregue confirmado), nunca de tool call isolada —
  mesmo padrão que rejeitou `goal.status==='completed'` sozinho no desenho do `CaseMemory`.
- **Soluções inseguras**: `isDestructive()`/`RiskAnalyzer` já se aplicam a qualquer
  `exec_command`, inclusive um candidato a virar conhecimento.
- **Específicas de um ambiente**: coberto pelo eixo plataforma (pergunta 1).
- **Risco adicional**: um comando aprovado manualmente por operador em modo GOD pode refletir
  particularidade daquele ambiente (permissões elevadas, rede específica) que não generaliza —
  reforça por que conhecimento local nunca deveria ser promovido automaticamente ao catálogo
  distribuído (pergunta 3).

## 5 — Como esse conhecimento deve ser consultado?

| Momento | Precedente | Avaliação |
|---|---|---|
| Antes do GoalPlanner | `KNOWN_DEPS` hoje | Só seguro se restrito a atalho de altíssima confiança, condicionado a modo |
| **Durante o planejamento, como bloco de evidência** | `reflectionBlock`, `capBlock`, `skillBlock`, `evidenceBlock`/`findHardConstraints()` (GoalPlanner.ts:711-716) | Mais alinhado aos 5 princípios — mesma forma dos outros Evidence Providers |
| Após o planejamento | `RiskAnalyzer`/`sanitizePlanSteps` | Serve para corrigir erro certo, não para sugerir estratégia nova |
| Só quando KNOWN_DEPS falhar | Já é assim por fallthrough natural | Perderia reforço em replans onde o blocker nem chega a `missing_tool` |

A opção mais consistente é a segunda — mesma forma física dos outros Evidence Providers.

## 6 — Quem valida um novo aprendizado?

O mesmo componente que já valida para o `CaseMemory`: `GoalExecutionLoop.validateGoalCompletion()`
seguido de um critério equivalente a `determineEvidenceTier()`. Não deveria ser um componente
novo. `GoalEvaluator` não é o lugar certo (classifica resultado imediato de tool call, não se o
objetivo inteiro foi atingido). `GoalPlanner` também não (validar é avaliação, não julgamento
estratégico — misturar as duas já foi identificado como risco de acúmulo de responsabilidade).

## 7 — Como esse conhecimento envelhece?

- **Revisão**: `ReflectionMemory` já usa janela de tempo na consulta (`-7 days`/`-30 days`).
- **Invalidação**: `ReflectionMemory.getHardFailurePatterns()` já suprime constraint antiga
  quando há sucesso recente (`-3 hours`) — o espelho aqui seria falha recente suprimindo a
  confiança de um registro positivo específico.
- **Obsolescência/atualização de ferramentas**: sem precedente em nenhum dos 3 componentes —
  risco em aberto, não resposta pronta.
- **Conflitos entre soluções**: nenhum componente resolve isso deterministicamente — todos
  empurram para o Planner decidir.
- **Mudança de SO**: coberto pelo eixo plataforma.

## 8 — ReflectionMemory, CaseMemory e Conhecimento Operacional: mesmo modelo, ou diferentes?

Os dois ao mesmo tempo, em níveis diferentes. No nível da **forma**: um modelo único (dado +
filtro próprio → bloco de texto → GoalPlanner → LLM decide). No nível do **conteúdo**: 4 células
distintas de uma matriz (chave × polaridade × mutabilidade):

| | Chave | Polaridade | Mutabilidade |
|---|---|---|---|
| `ReflectionMemory` | (padrão, tool) | só falha | aprendida em runtime |
| `CaseMemory` | embedding do objetivo | só sucesso | aprendida em runtime |
| `KNOWN_DEPS` | nome da ferramenta | fato a priori | estática |
| **Conhecimento Operacional** | (ferramenta, plataforma) | só sucesso | aprendida em runtime |

Conhecimento Operacional é estruturalmente mais parecido com `KNOWN_DEPS` (mesma chave) do que
com `CaseMemory`/`ReflectionMemory` — é a metade aprendida que falta no papel que `KNOWN_DEPS`
já ocupa hoje, só de forma estática.

## 9 — Ciclo de vida do conhecimento operacional

```
Problema observado (blocker classificado)
        ↓
Diagnóstico (blocker.kind + nome da ferramenta extraído)
        ↓
Existe conhecimento aprendido pra (ferramenta, plataforma)? ──NÃO──→ tentativa livre, como hoje
        │ SIM
        ↓
Vira evidência textual — nunca decide sozinho (Evidence Provider)
        ↓
Planner decide se usa
        ↓
Tentativa
        ↓
Validação de GOAL completo (não de tool call isolada)
        ↓
   SUCESSO → reforça a confiança daquele registro (ferramenta, plataforma)
   FALHA (reusando conhecimento existente) → enfraquece só aquele registro específico
        ↓
Persistência (mesma camada física de ReflectionMemory/CaseMemory)
        ↓
Consultado no PRÓXIMO blocker equivalente — por (ferramenta, plataforma), nunca por objetivo
        ↓
"Esquecimento" = decaimento de peso por janela de tempo na consulta, nunca exclusão da linha
```

Dois pontos corrigidos em relação ao fluxo linear original: (1) "Validação" precisa de dois
níveis — resultado imediato de tool call não basta, só validação de goal completo é forte o
bastante para virar conhecimento; (2) "Revalidação"/"Evolução"/"Esquecimento" não são etapas
separadas — são o mesmo ciclo se repetindo.

## 10 — Análise crítica do princípio-guia

> "O conhecimento operacional não deve competir com o GoalPlanner. Seu papel é reduzir o custo
> de resolver novamente problemas já compreendidos, preservando o julgamento estratégico do
> agente."

**Contra**: hoje, quando `permissionRegistry.can('install_dependencies')` é verdadeiro e
`KNOWN_DEPS` tem entrada resolvida, `GoalExecutionLoop.ts:906` injeta `toolName: 'exec_command'`
programaticamente, sem o Planner decidir aquele step — tecnicamente já é conhecimento competindo
com o Planner.

**A favor**: essa competição só acontece dentro de limites já auditados e aceitos (pequena,
nomeada, condicionada a modo operacional) e nunca decide estratégia, só tática de recuperação
mecânica sem ambiguidade.

**Conclusão**: a afirmação está certa na intenção, forte demais na letra. Formulação mais fiel:
*o conhecimento operacional não deve competir com o julgamento ESTRATÉGICO do Planner — mas
pode, nos mesmos limites que `KNOWN_DEPS` já demonstra, substituir uma decisão TÁTICA mecânica
sem ambiguidade.*

**Resolução (ARCH-004, 24/07/2026)**: o Princípio 3 (acima) foi revisado para incorporar esta
ressalva explicitamente, em vez de deixá-la implícita só nesta análise crítica — apontando para a
mesma exceção já nomeada em `EVIDENCE_PROVIDER_PATTERN.md`, Seção 7, item 2. A contradição era
entre o texto do Princípio 3 (absoluto) e este achado (que mostra uma exceção já em produção);
não era uma contradição na prática — `GoalExecutionLoop.ts:906` já operava dentro do limite
descrito aqui antes mesmo desta RFC existir. A implementação real da primeira fatia de M2
(`OperationalKnowledge`) não usa essa exceção — segue o caminho informativo puro (pergunta 5) —,
então nenhuma mudança de comportamento foi necessária para fechar esta contradição, só a
formulação do princípio.

## Síntese

O modelo que emerge das evidências: unidade de conhecimento chaveada por (ferramenta,
plataforma) — nunca por objetivo —, dois níveis de confiança (evidência fraca desde o primeiro
sucesso validado a nível de goal; atalho determinístico só após confirmação mais forte),
consultada como mais um Evidence Provider dentro de `GoalPlanner.plan()`/`replan()`, validada
pelo mesmo mecanismo que já valida `CaseMemory`, envelhecendo por decaimento de peso na consulta,
persistida na mesma camada física que já separa conhecimento aprendido de conhecimento
distribuído no código.

**Riscos em aberto, não resolvidos por esta RFC:** critério de decaimento por versão de
ferramenta (sem precedente no projeto); limite de confiança explícito e quantificado para a
promoção de tática determinística (aqui só comparado qualitativamente).

## Adendo (RFC-003, 2026-07-27)

Esta RFC assumia, do início ao fim, que o agente **já sabe** improvisar uma correção (via
`exec_command` espontâneo, tentativa e erro do LLM) — a cadeia original nunca cobriu o caso "não
sei como resolver isto, preciso descobrir". `docs/decisoes/RFC-003_AQUISICAO_CONHECIMENTO_OPERACIONAL.md`
fecha essa lacuna, adicionando um ciclo que antecede a captura descrita aqui:

```text
Problema desconhecido
        │
        ▼
Identificar               ── novo (RFC-003)
        │
        ▼
Descobrir (ambiente)       ── novo (RFC-003)
        │
        ▼
Pesquisar (fonte citada)   ── novo (RFC-003)
        │
        ▼
Formular hipótese          ── novo (RFC-003) — sempre mediado pelo GoalPlanner/LLM
        │
        ▼
Executar                   ┐
        │                  │  cadeia original desta RFC-001,
        ▼                  │  inalterada — captureFromGoal(),
Validar objetivamente      │  buildEvidenceHint(), modelo de
        │                  │  confiança da pergunta 2
        ▼                  │
Aprender/Reutilizar        ┘
```

O que a RFC-003 reutiliza integralmente desta RFC-001, sem redefinir:

- **Unidade de conhecimento** (pergunta 1): `(ferramenta, plataforma)`, nunca por objetivo.
- **Modelo de confiança em dois níveis** (pergunta 2): 1 sucesso validado = evidência fraca;
  sucessos confirmados repetidos, sem falha recente = elegível a atalho tático. RFC-003 não
  introduz um terceiro nível nem redefine os dois existentes.
- **Separação Distribuído × Aprendido** (pergunta 3): conhecimento adquirido pelo novo ciclo de
  descoberta continua sendo Aprendido, nunca escreve em `KNOWN_DEPS` automaticamente — a origem do
  fato (LLM improvisou vs. pesquisa mediada pelo Planner) não muda a categoria física onde ele
  vive.
- **Validação em nível de goal** (pergunta 4/6): a "Validação" que a RFC-003 exige é a mesma
  validação de nível de goal já definida aqui — RFC-003 apenas torna mais rigoroso o mecanismo de
  captura hoje existente (`captureFromGoal()`), que credita sucesso por uma heurística mais fraca
  do que o exigido (ver RFC-003, seção "Validação").
- **Resolução da pergunta 10** (extensão tática): deixa de ser hipótese — é a decisão formalizada
  por RFC-003, com uma fronteira explícita (seção "Fronteira entre Julgamento do Planner e Atalho
  Determinístico" da RFC-003) que esta RFC-001 não havia detalhado: a formação de hipótese **nova**
  é sempre mediada pelo Planner; só a **reutilização** de conhecimento já validado herda o atalho
  determinístico.

Nada do que esta RFC-001 já definia foi revertido — a RFC-003 estende a cadeia por cima,
cobrindo a etapa que faltava.
