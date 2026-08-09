# ADR-010 — Validação semântica de afirmações contra evidência

> **Status:** decisão arquitetural **aceita**. Implementação **não realizada**.
> **Data:** 2026-08-09
> **Origem:** Gate MECANISMO (investigação de 08-09/08/2026), a partir dos incidentes "River"
> (08/08/2026) e "Weather" (08/08/2026).
> **Relacionada:** `NUNCA_ADIVINHAR.md` (informação insuficiente se reporta, não se preenche) ·
> `EVIDENCE_PROVIDER_PATTERN.md` (componente de conhecimento fornece fato, não decide) ·
> `RFC-006` (procedência de artefato de workspace — escopo distinto).
> **Não revoga nada.** O contrato de alucinação de ação de `ObserverValidator` permanece íntegro.

---

## 1. Contexto

O agente pode produzir uma resposta factual que não corresponde ao conteúdo efetivamente
devolvido pelas ferramentas. Isso não é hipótese: ocorreu em execução real, por caminhos
diferentes, e passou por todas as barreiras existentes.

**Incidente River (08/08/2026).** `crypto_analysis` devolveu `Preço: $2,80`. O usuário recebeu
`$0,7834`, além de variação, volume e capitalização — quatro números sem origem em resultado
algum. O valor fabricado foi depois gravado em arquivo do workspace e, 25 minutos mais tarde,
lido de volta e apresentado como "registros internos de cotações" (esse último elo é objeto da
`RFC-006`, não desta ADR).

**Incidente Weather (08/08/2026).** `weather` devolveu `Nublado | 24.9°C | Umidade: 74%`. O
usuário recebeu `"Sol com algumas nuvens, entre 24°C e 31°C, umidade de 70%, sem previsão de
chuva"` — condição invertida, máxima inexistente, umidade alterada, previsão inventada.

**Por que nada barrou.** A investigação localizou quatro causas independentes:

- **`KNOWN_GOOD_TOOLS` aprova por forma.** As regras verificam que o *output da ferramenta* tem o
  aspecto esperado e que a *resposta* tem comprimento mínimo. Nenhuma compara os dois. Aplicadas
  aos casos de falsificação, aprovaram 7 de 7 — incluindo os quatro que deveriam falhar.
- **A verificação por LLM alcançável pergunta outra coisa.** O prompt do observer avalia se *"a
  resposta atende plenamente à solicitação"* — qualidade, não fidelidade — e nunca bloqueia.
- **`lastToolExecution` entrega evidência inadequada.** O validador recebe apenas a última
  execução do turno. No River, a resposta falava de um ativo cujo dado veio de uma chamada
  anterior; o validador comparou contra outra execução.
- **Tool-call vazada promovida a resposta final.** `semanticRecovery` classificava como
  `final_answer` um bloco JSON que era, estruturalmente, uma chamada de ferramenta — encerrando o
  turno e descartando o resultado correto já obtido. Corrigido em `6399420` (S216); é a única das
  quatro já resolvida.

**Ausência de vínculo afirmação → evidência.** Busca no código por qualquer estrutura com função
de `parent`, `source`, `dependsOn`, `usedResult` ou `causedBy`: nenhuma ocorrência. O sistema
preserva **ordem e histórico**, não causalidade. O identificador de chamada de ferramenta é
transporte — escrito e repassado ao provider, nunca lido de volta para correlacionar.

---

## 2. A responsabilidade

> **Uma resposta que contenha afirmações factuais derivadas de ferramentas somente pode ser
> entregue quando essas afirmações estiverem adequadamente fundamentadas na evidência
> disponível.**

O domínio é a **relação entre afirmação e evidência**, nunca uma ferramenta específica. Nenhuma
regra desta ADR menciona ferramenta, provider, idioma, formato de saída ou sistema operacional.
Os incidentes entram como instâncias de falsificação, jamais como regra.

### Proveniência ≠ grounding semântico

Esta distinção é o núcleo da decisão e foi a descoberta que reorientou toda a investigação:

```
existência da evidência       fato verificável        ExecutionTrace
seleção da evidência          declaração              quem seleciona
declaração de que sustenta    asserção                quem declara
verificação de que sustenta   comparação semântica    ← objeto desta ADR
```

A existência de uma ferramenta, de um `tool_result` ou de um `evidence_id` **não constitui prova
de que a afirmação é sustentada**. Um `claim → evidence_id` produzido por um LLM tem o mesmo
estatuto epistêmico da afirmação original: se o gerador pode fabricar um valor, o extrator pode
fabricar uma relação de suporte.

Aceitar proveniência declarada como grounding seria repetir, com outro nome, o erro de
`KNOWN_GOOD_TOOLS` — tomar um sinal estrutural por veredito semântico.

**Instância que fecha a questão** (caso real, 03/08/2026): evidência com `agora: 16.1°C` e
`amanhã: 14.6–25.2°C`; afirmação `"hoje: mínima 16°C, máxima 25°C"`. Os valores existem na
evidência, o `evidence_id` estaria correto, a proveniência seria honesta — e a afirmação é falsa.
O erro é **relacional, não lexical**.

---

## 3. Decisão

> **A validação semântica será realizada por um LLM Judge, recebendo as afirmações da resposta e
> as evidências candidatas do turno, e produzindo um veredito estruturado por afirmação.**

Determinismo **não** foi eliminado. A separação decidida é:

```
determinístico  →  schema, JSON, tipos, IDs, estados permitidos, invariantes,
                   timeout, controle de fluxo
LLM             →  interpretação semântica  afirmação ↔ evidência
```

Código determinístico continua integralmente responsável pela estrutura e pelo controle. O que
esta ADR rejeita é usá-lo como **camada de interpretação semântica** de afirmações e evidências.

### Critério arquitetural permanente — teste `foo`

> Se uma ferramenta nova `foo` for adicionada, sem alterar o validador, o contrato continua
> aplicável?

Qualquer mecanismo que dependa de lista de ferramentas, formato de saída específico ou vocabulário
de idioma **falha** nesse teste. O LLM Judge passa por construção.

---

## 4. Representação da evidência

**Não foi encontrada infraestrutura semântica estruturada reutilizável.** Busca por
`mimetype`, `contentType`, `resultSchema`, `outputSchema`, `structuredOutput`, `normalizeResult`,
`toolMetadata` e `semanticType`: todas as ocorrências são de anexos de canal, nenhuma de resultado
de ferramenta.

`ToolResult` é `{ success, output: string, error?, artifactPaths?, exitCode?, deliveryFacts? }`.
Os três campos estruturados descrevem a **execução** (arquivos produzidos, código de processo,
fatos de entrega) — nenhum carrega o **conteúdo factual**. `output` continua sendo texto livre.

**Evidência disponível hoje:** `ExecutionTrace.steps`, com pares `tool_call` / `tool_result`
contendo `id`, `tool`, `input`, `output`, ordem e `timestamp`. É o conjunto candidato de
evidências, e é canônico — as demais estruturas (`cycleHistory`, `loopMessages`,
`usedToolOutputs`) são vistas parciais.

**Estrutura que a implementação ainda precisará materializar:** `commitResponse` **não recebe** o
trace hoje. Sua assinatura é `(response, userText, traceId, conversationId, signal,
toolFailureCount)`. O objeto está em escopo em todos os pontos que a chamam — a lacuna é de
fiação, não de infraestrutura.

**Nenhum `EvidenceSet` existe no código.** Esta ADR não o cria nem pressupõe que exista.

---

## 5. Contrato do juiz

### SUPPORTED

> **Somente quando a evidência determina positivamente a proposição.**
>
> **Ausência de contradição NÃO é suficiente para `SUPPORTED`.**

Esta regra existe por causa dos falsos `VALIDATED` observados em E6/E8, todos do mesmo tipo: um
valor aparecia na evidência e o juiz tratou "não contradiz" como "sustenta", quando a evidência
não determinava a proposição.

### NOT_SUPPORTED

> Quando a evidência pertinente e suficiente **determina que a proposição é falsa ou não
> sustentada**.

### NOT_EVALUABLE

> Quando a evidência disponível **não determina** a proposição.

Casos já demonstrados: dimensão factual ausente · evidência ambígua · evidência conflitante ·
evidência não pertinente.

**Ausência de evidência não é falsidade.** Isso é a aplicação direta de `NUNCA_ADIVINHAR.md`:
*"relatar a ausência, nunca preencher a lacuna com uma suposição plausível"*.

### Fato adicional — a distinção descoberta no E8

Fato adicional não tem estado único; depende do que a ausência na evidência significa:

| evidência | ausência é informativa? | estado |
|---|---|---|
| **enumerativa / fechada** — o conjunto é explicitamente completo | sim | `NOT_SUPPORTED` |
| **parcial / aberta** — não enumera a dimensão relevante | não | `NOT_EVALUABLE` |

Instâncias testadas, únicas usadas para ilustrar:

- Evidência `A = 10 / B = 20`, afirmação `"A = 10 e C = 30"` → **`NOT_SUPPORTED`**. O conjunto é
  fechado e enumerado; se `C` existisse, estaria lá.
- Evidência `Nublado | 24.9°C | Umidade: 74%`, afirmação `"não há previsão de chuva
  significativa"` → **`NOT_EVALUABLE`**. A evidência não enumera tudo que existe; a ausência de
  menção a chuva não informa nada sobre chuva.

---

## 6. Afirmações múltiplas

> **O juiz opera no nível da resposta, podendo avaliar múltiplas afirmações numa única chamada.**

Medição E7(b), com quatro afirmações (duas sustentadas, uma com valor errado, uma sobre dimensão
ausente) e três evidências candidatas:

```
1 chamada / 4 afirmações   ≈ 13,1 s
4 chamadas separadas       ≈ 22,0 s
```

O custo **não** é `N × latência-de-um-par`. A saída veio estruturada, com veredito e evidência por
afirmação, e a opinião presente na resposta foi corretamente ignorada — a etapa de aplicabilidade
ocorreu dentro da mesma chamada.

```
uma resposta → múltiplas afirmações → um julgamento → veredito por afirmação
```

A decomposição em afirmações é feita pelo próprio juiz. Não há etapa determinística separada, e
isso é decisão, não omissão: decompor texto livre em afirmações é trabalho semântico.

---

## 7. Evidências candidatas

Medição E7(a) — latência do juiz variando apenas o volume de evidência, com afirmação e tarefa
constantes:

```
52 chars    → p50 ≈ 5,5 s
240 chars   → p50 ≈ 5,0 s
522 chars   → p50 ≈ 6,0 s
992 chars   → p50 ≈ 5,0 s
1932 chars  → p50 ≈ 5,1 s
3812 chars  → p50 ≈ 6,4 s
```

> Dentro da faixa testada, a latência não apresentou crescimento proporcional ao tamanho da
> evidência; o custo foi dominado pela geração.

**Não generalizar além da faixa testada.** Dentro dela, a consequência arquitetural é que enviar
o conjunto de evidências candidatas do turno é barato — o que remove o argumento operacional que
sustentaria um pré-filtro determinístico de seleção.

---

## 8. Orçamento

> **O orçamento do juiz será derivado por `getBudgetAuxiliar`, reutilizando a infraestrutura
> existente.**

Perfil decidido: **`validacao`**, com os parâmetros atuais do mecanismo —
`fator ×4 · mínimo 15 s · máximo 120 s · padrão 45 s`.

Esses são os **valores atuais** de `shared/auxTimeout.ts`. A implementação deve **reutilizar** o
mecanismo, não duplicá-lo nem redefinir os parâmetros.

O orçamento é derivado da latência típica observada do provedor
(`CircuitBreaker.getLatenciaTipicaMs()`, alimentada por `recordSuccess(duration)` a cada chamada
bem-sucedida). Sem medição, o mecanismo devolve o padrão do perfil **e declara**
`origem: 'padrao'` — nunca inventa um número.

**Não criar** `JUDGE_TIMEOUT_MS`, `CLAIM_TIMEOUT_MS` ou qualquer constante nova de timeout. O
`COMMIT_TIMEOUT_MS = 12_000` hoje literal em `AgentLoop` é a última constante fixa nesse caminho e
deve ceder lugar ao orçamento derivado.

Justificativa da escolha do perfil: a chamada é julgamento sobre texto maior, não rótulo de uma
linha — mesma natureza que os demais consumidores de `validacao`. Com a latência medida nos
experimentos, o piso de 15 s já cobre o caso de par único, e o multi-afirmação fica folgado.

---

## 9. Timeout sem veredito

```
LLM Judge concluiu                        → veredito
LLM Judge não concluiu no orçamento       → UNVALIDATED
UNVALIDATED                               → NÃO COMMIT
```

**Timeout nunca é convertido em `REJECTED` nem em `NOT_EVALUABLE`**, porque não constitui
conclusão epistemológica: não houve achado de falsidade nem constatação de que a evidência é
insuficiente. Houve ausência de conclusão.

A distinção tem consequência prática: `UNVALIDATED` é o único estado **revalidável** — mesma
resposta, nova tentativa, sem gerar nada. Colapsá-lo nos outros dois faria o sistema regenerar
resposta correta por causa de uma falha de infraestrutura.

As demais causas que produzem `UNVALIDATED`: erro de execução, abort, resposta do juiz sem
estrutura válida, modelo indisponível, provider indisponível.

---

## 10. Relação com o commit

```
VALIDATED       → pode entregar
REJECTED        → não entregar · recuperação definida pela camada superior
NOT_EVALUABLE   → não entregar · recuperação definida pela camada superior
UNVALIDATED     → não entregar · pode ser revalidado
NOT_APPLICABLE  → C1 não se aplica · segue o fluxo normal
```

`NOT_APPLICABLE` (a resposta não contém afirmação apresentada como derivada de evidência) é
distinto de `VALIDATED`: o primeiro afirma que não havia o que verificar; o segundo afirma que se
verificou. Conflatá-los faria qualquer política sobre `VALIDATED` governar também os casos em que
nada foi verificado.

**Esta ADR decide a barreira de entrega, não a política de recuperação.** A estratégia de
recuperação para `REJECTED` e `NOT_EVALUABLE` pertence à camada superior e não está decidida aqui.
O que está decidido é que nenhum desses estados autoriza entrega.

---

## 11. Evidência experimental

Seção separada deliberadamente: **experimentos não são garantias**.

### E6 — viabilidade

```
48 julgamentos · 85% corretos · 1 falso VALIDATED observado · 0 UNVALIDATED
```

### E8 — generalização/adversarial

```
88 julgamentos · 83% corretos · 2 falsos VALIDATED observados · 0 UNVALIDATED
46/46 afirmações não sustentadas não foram aprovadas
```

Casos em domínios não usados anteriormente (servidor, estoque, catálogo, agenda, documentos,
arquivos), cobrindo valor, papel, entidade, relação invertida, temporalidade, unidade, negação,
composição, e os três idiomas suportados. Prompt idêntico ao do E6, sem ajuste.

### Total observado

```
136 julgamentos · 3 falsos VALIDATED observados
```

> Foram observados 3 falsos `VALIDATED` em 136 julgamentos experimentais.

Nenhuma taxa é inferida a partir desses números. Eles descrevem o que foi observado nas amostras
descritas, não uma propriedade do mecanismo.

---

## 12. Limitações conhecidas

- Um único modelo local (`gemma4:e4b-it-qat`).
- Um único avaliador.
- Casos construídos pelo investigador.
- Amostra pequena; sem garantia estatística de confiabilidade.
- A decomposição em afirmações é feita pelo próprio juiz, sem segundo avaliador.
- Falsos `VALIDATED` observados em E6 e E8, todos por evidência que não determina a proposição —
  o risco que a regra de `SUPPORTED` nomeia, e que a regra **não elimina**.
- O novo orçamento não foi medido em produção.
- `ResponseCommit` não possui hoje estado explícito para "não concluído".
- Correlação de erro: numa instalação com modelo único, gerador e juiz são o mesmo modelo. Nesse
  caso a garantia é declaradamente mais fraca, e isso deve ser observável.
- **A implementação ainda não existe.**

---

## 13. Alternativas consideradas

**A — heurísticas/regex determinísticas como mecanismo semântico. Rejeitada.**
Nos casos testados cobriu apenas a fração em que o valor afirmado não ocorre na evidência — 2 de 6
violações. Não alcançou papel, categoria, fato adicional nem ambiguidade. O LLM tratou essas e
também as duas que o determinístico alcançava. Adicionaria complexidade sem cobertura própria.

**B — LLM Judge. Escolhida.**

**C — combinação determinístico + LLM.**
Não necessária como requisito epistemológico. Pode existir futuramente como **otimização de
custo**, e nesse caso o determinístico só poderá emitir `NOT_SUPPORTED` ou "não resolvido" —
nunca `SUPPORTED` por ausência de contradição, que reproduziria `KNOWN_GOOD_TOOLS`. Uma
otimização futura não é componente obrigatório desta arquitetura.

**D — LLM monolítico sem vínculo por afirmação. Descartada.**
Não materializa `afirmação → evidência` de forma auditável. Medição em log real: 38% dos turnos
executam mais de uma ferramenta (79% dos turnos que usam ferramenta), então o caso de múltiplas
evidências é dominante, não excepcional.

---

## 14. Consequências

**Positivas**
- Elimina regras semânticas específicas por ferramenta — satisfaz o teste `foo`.
- Reutiliza o contexto de execução já disponível (`ExecutionTrace`).
- Permite múltiplas afirmações numa chamada, a custo menor que uma chamada por afirmação.
- Mantém determinismo onde ele é forte: estrutura, tipos, invariantes, controle.
- Cria uma barreira explícita entre evidência e entrega, onde hoje há um booleano que significa
  seis coisas diferentes.

**Custos e riscos**
- Latência adicional em todo turno com afirmação derivada de ferramenta.
- Dependência do modelo disponível na instalação.
- Falsos positivos e falsos negativos, observados nos experimentos.
- Necessidade de validar a estrutura da saída do juiz.
- Necessidade de orçamento dinâmico em vez de constante.
- Necessidade de um estado `UNVALIDATED` que hoje não existe no tipo.

---

## 15. Não fazer

Conhecimento negativo produzido pela investigação — cada linha corresponde a um erro real
encontrado no código ou nos experimentos:

```
não usar regex para determinar suporte semântico
não aprovar por presença de valor
não aprovar por ausência de contradição
não considerar proveniência como grounding
não transformar timeout em aprovação
não transformar ausência de evidência em falsidade
não confundir "a ferramenta é conhecida" com "a resposta é sustentada"
não comparar a resposta contra a última execução por omissão
```

---

## 16. Status

```
DECISÃO ARQUITETURAL:  ACEITA
IMPLEMENTAÇÃO:         NÃO REALIZADA
PRÓXIMO PASSO:         IMPLEMENTAR C1 CONFORME ESTA ADR
```

### Questões deliberadamente deixadas em aberto — nenhuma bloqueia a implementação

- **Política de recuperação** para `REJECTED` e `NOT_EVALUABLE`. A barreira de entrega não
  depende dela; a implementação pode negar entrega antes que a recuperação exista.
- **Visibilidade ao usuário** de que uma resposta não foi validada. A barreira funciona sem isso.
- **Proveniência registrada** (em oposição a inferida pelo juiz). Fora do escopo; a inferência
  a posteriori é o que esta ADR decide.
- **Segundo modelo para reduzir correlação de erro.** Depende da instalação; o contrato funciona
  com um modelo, com garantia declaradamente mais fraca.
