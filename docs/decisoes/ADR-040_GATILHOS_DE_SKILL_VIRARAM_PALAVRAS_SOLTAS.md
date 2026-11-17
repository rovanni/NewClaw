# ADR-040 — Escolha das skills do turno: gatilhos que viraram palavras soltas

Data: 17/11/2026. Status: **aceita em parte** (17/11/2026): D1, D2 (a) e D4 aprovadas pela operadora; D3 fica para
depois da medição da Etapa 2.

Relacionadas: ADR-017 (skills aprendidas com o que funcionou), ADR-021 (catálogo de ferramentas sob demanda),
ADR-035 (skills portáveis — formato do `SKILL.md`), ADR-036 (versionamento de skills), ADR-038 (contexto do turno por
necessidade — C.1 "skills sob demanda" descartada em 04/11), `docs/ARCHITECTURE/INFORMACAO_COMPLETA_PARA_DECIDIR.md`,
`docs/ARCHITECTURE/RESPONSABILIDADE_ANTES_DO_MECANISMO.md`.

## Fase 1 — Compreensão

### O pedido

A operadora (17/11/2026), depois da medição de tokens por componente: investigar por que até um "oi" manda ~9,5 mil
tokens de entrada, e desenhar a correção dos gatilhos pelas fases da Diretriz.

### O que foi medido

Fonte: `newclaw-audit.log` da produção Windows (linhas `[LLM-CALL]`, `[TOOLS-CATALOGO]`, `[SKILL]`), as 40 skills
instaladas, as transcrições de sessão (443 mensagens do usuário) e a tabela `auto_skills` (lida em modo somente leitura).

1. **Definições de ferramentas ≈ 47% dos caracteres da 1ª chamada do turno.** Mediana de 13–14 ferramentas completas
   (≈ 13 mil caracteres). Só as 7 do núcleo (`CORE_TOOLS`) mais o catálogo da ADR-021 dariam ≈ 8 mil.
2. **O que leva de 7 para 14 ferramentas são as skills casadas.** `AgentLoop.ts:3874`: o `tools:` de cada skill casada
   entra em `preferredTools`, e `buildToolDefs` manda essas ferramentas completas. Estimativa: ≈ 6,4 mil caracteres
   (≈ 1,9 mil tokens, contando 3,5 caracteres por token) a mais em **cada volta** do laço.
3. **Skills casadas por mensagem real do usuário** (regra atual, substring):

   | | p50 | p90 | máx | mensagens com ≥ 1 | com ≥ 5 |
   |---|---:|---:|---:|---:|---:|
   | skills | 1 | 8 | 18 | 296 de 443 | 121 |
   | ferramentas trazidas pelas skills | 3 | 9 | 13 | 296 | 189 |

   Os gatilhos que mais casam: `que` (396 mensagens), `aula` (246), `está` (92), `para` (81), `como` (74),
   `hoje` (69), `criar` (63), `pode` (45), `rea` (33, casa dentro de "área"), `das` (24), `não` (24), `dia` (20).
   As 14 skills mais casadas são todas aprendidas pela ADR-017.

   O pior caso do log (16/11, 15:53, 18 skills) nem era mensagem do usuário: era o texto de um passo de goal
   (`[GOAL STEP] Gravar relatório final…`), escrito pelo planejador, sobre o qual os gatilhos também rodam.
4. **O bloco de skills é cortado em 500 tokens sem aviso.** `ContextBuilder.ts:56` (`skillsMaxTokens: 500`) e `:174`
   (`truncateToTokens`). Com 18 skills casadas, chega ao modelo só o começo da primeira. Isso fere a proibição 2 de
   `INFORMACAO_COMPLETA_PARA_DECIDIR.md` (cortar contexto sem declarar).

### Causa raiz

O modelo que aprende a skill **propôs frases**. O `trigger` gravado em `auto_skills` mostra isso:

```text
consulta-agenda   "agenda compromissos eventos como está minha agenda o que tenho hoje próximos compromissos"
localizar-app     "onde fica instalado caminho do programa caminho para onde está o app localizar aplicativo …"
```

As frases se perdem em dois passos:

1. `SkillLearner.ts:859` — `trigger: p.gatilhos.join(' ')` junta a lista com espaço. A partir daí não se sabe onde
   cada frase começava ("como está minha agenda" e "o que tenho hoje" viram uma sequência de palavras).
2. `SkillLearner.ts:1041` — `extractTriggerKeywords` foi escrito para o formato antigo, em que `trigger` era uma
   **regex** (`"(clima|tempo|temperatura)"`). Ele apaga metacaracteres, quebra por espaço, guarda palavras com 3 letras
   ou mais e fica com as **10 primeiras**. As frases viram `como, está, minha, agenda, que, tenho, hoje…` no `SKILL.md`.

Depois, `SkillDiscovery.ts:157` (`matchSkillByTrigger`) casa cada palavra por `includes`, sem fronteira de palavra.

Três fatos agravam:

- **Duas fontes de verdade para o mesmo gatilho.** No banco, `trigger` é lido como regex (`SkillLearner.scoreSkillMatch`,
  só para skills com `file_exported = 0`). No arquivo, `triggers:` é lido como lista de palavras (`SkillLoader` →
  `discoverSkills`). Os formatos são incompatíveis e nenhum guarda as frases.
- **O exemplo do próprio prompt ensina palavras soltas.** `aprendizadoDeSkills.ts:179`:
  `"gatilhos": ["palavras", "que", "indicam", "o pedido"]`.
- **Os 10 padrões automáticos antigos** ("Padrão aprendido automaticamente: N usos…") herdaram gatilhos como
  `check|emails`, `skill|deploy`, `gmail|access`, `event:interaction|pattern`.

### Tentativas e decisões anteriores

- **S149** unificou o casamento do `AgentLoop` em `matchSkillByTrigger` (só `.byTrigger`). Unificou o mecanismo, não o
  corrigiu.
- **ADR-038 (04/11)** já apontou a seleção por palavra-gatilho como "heurística escolhendo o que o LLM vê" e propôs
  skills sob demanda (C.1). **A operadora descartou a C.1** depois da medição: a lista de nome e descrição custava
  ~+1.000 tokens **por chamada** do laço, sem economia. O problema (skill certa fora de alcance, corte silencioso) ficou
  registrado e "volta como correção do que o modelo recebe, com o custo declarado".
- `src/shared/keywordBoundary.ts` (`keywordBoundaryMatches`) já resolve casamento com fronteira de palavra em
  português. É usado por `DomainRegistry`, `ModelProfileRegistry` e `ContextBuilder` (S61, S62, S63).

## Fase 2 — Crítica da hipótese

**Hipótese inicial: casar com fronteira de palavra (`keywordBoundaryMatches`). Medida e refutada.** Com as mesmas 443
mensagens e os mesmos gatilhos de hoje:

| | p50 | p90 | máx | com ≥ 1 | com ≥ 5 |
|---|---:|---:|---:|---:|---:|
| substring (hoje) | 1 | 8 | 18 | 296 | 121 |
| fronteira de palavra | 1 | 8 | 16 | 247 | 106 |

`que`, `está`, `para` e `como` são palavras de verdade, e a fronteira não as barra. Ela só tira `rea`/"área" e afins.
**Trocar só o mecanismo de casamento, com o estado errado (frases perdidas), não resolve.** É a proibição "trocar apenas
o mecanismo" da `RESPONSABILIDADE_ANTES_DO_MECANISMO.md`.

Outras críticas:

- **Uma lista de palavras proibidas (`que`, `para`…) é receita e escalada.** Violaria a regra 1.5 do workspace e
  a "regra da escalada". Fica fora.
- **Frase com fronteira continua sendo palavra-chave escolhendo o que o LLM vê** (proibição 4). Ela reduz o erro, mas não
  muda quem decide. Só a mudança de responsável (Fase 3, C ou D) elimina a classe de defeito.
- **As 19 skills já aprendidas não têm as frases.** O `join(' ')` é irreversível; separar de novo à mão ou por regra
  seria adivinhar (`NUNCA_ADIVINHAR.md`).
- **Os gatilhos rodam também sobre o texto dos passos de goal.** Esse texto é escrito pelo planejador, não pelo usuário.
  Qualquer correção que mantenha gatilhos herda isso.
- **ADR-036** mexe no mesmo carregador e nas skills aprendidas; a migração dos gatilhos tem de respeitar o versionamento
  dela (não sobrescrever sem histórico).

### Questionário (Responsabilidade antes do Mecanismo)

```text
PERGUNTA:     que procedimentos conhecidos (skills) servem a este pedido?
RESPONSÁVEL:  hoje, um includes() no AgentLoop; deveria ser quem entende o pedido (um LLM).
EVIDÊNCIA:    o pedido íntegro e o que cada skill é (nome + descrição). O includes() não tem a descrição
              e, nos passos de goal, nem tem o pedido do usuário.
AUTORIDADE:   decidir relevância é semântico → LLM. Determinismo pode validar a forma do gatilho
              (lista, tamanho, nada vazio) e casar texto literal, mas não decidir relevância.
ESTADO:       lista de skills do turno; deriva dela o bloco [HABILIDADES] e as ferramentas preferidas.
CONSUMIDOR:   o agente (lê o bloco como "procedimento que funcionou") e buildToolDefs (manda as ferramentas
              completas). Hoje o agente supõe que as 18 skills são relevantes, e não são.
MECANISMO:    ver Fase 3.
```

## Fase 3 — Alternativas

| | O quê | A favor | Contra |
|---|---|---|---|
| **A** | **Consertar o estado:** gatilho continua sendo frase do começo ao fim (prompt pede frases; banco e `SKILL.md` guardam a lista; casamento da frase inteira com `keywordBoundaryMatches`). Corte do bloco de skills declarado. | Pequeno, reversível; reusa `keywordBoundary`; elimina as duas fontes de verdade; nada de receita | Continua palavra-chave escolhendo o que o LLM vê (proibição 4), só que muito menos; ganho **não medido** (as frases das 19 skills se perderam) |
| **B** | Fronteira de palavra só | Uma linha | **Medido: não resolve** (p90 8 → 8) |
| **C** | **Roteador escolhe as skills:** o `UnifiedIntentRouter`, que já classifica o pedido com LLM em todo turno, recebe a lista nome + descrição e devolve as skills do turno. Gatilhos saem da escolha. | Quem decide é um LLM; **substitui** o includes (regra de custo); custo **uma vez por turno**, não por volta do laço (o que derrubou a C.1 da ADR-038) | +≈ 2,2 mil tokens no roteador por turno (lista das 40 skills = 7,6 mil caracteres, medido); o roteador vê menos conversa que o agente; muda um ponto de decisão registrado (S356) |
| **D** | Skills sob demanda no agente (C.1 da ADR-038) | O próprio agente decide, com a conversa inteira (padrão OpenClaw/Hermes/Agent Skills) | **Já recusada pela operadora** (+≈ 1 mil por chamada, em toda volta); hoje a lista custaria ≈ 2,2 mil |
| **E** | Ferramentas das skills pelo catálogo da ADR-021, e não completas | Corta o maior custo medido (≈ 1,9 mil tokens por volta) sem depender da escolha | Uma volta a mais quando a skill é usada; independe de A/C (pode somar a qualquer uma) |

**Gate Extensão antes de Criação:** nenhuma alternativa cria arquivo novo de código. A estende `SkillLearner`,
`aprendizadoDeSkills`, `SkillDiscovery` e `ContextBuilder`, e reusa `keywordBoundary`. C estende o
`UnifiedIntentRouter` (já tem `enrichWithSkillContext`). E reusa `carregar_ferramenta`.

**Fontes externas (17/11/2026):** a especificação Agent Skills, o Hermes Agent e o OpenClaw põem no prompt só o nome e a
descrição, e **quem escolhe é o modelo**. Nenhuma fonte encontrada descreve gatilho por palavra-chave como mecanismo de
escolha. As fontes desta busca são de terceiros; a leitura das docs oficiais está na ADR-038, Fase 1.

## Fase 4 — Síntese (recomendação)

**A agora, como correção do estado; C como mudança de responsável, só depois de medir A; E à parte, decidida pela
operadora.**

### Etapa 1 — A (correção pontual, reversível)

1. `aprendizadoDeSkills.ts`: o exemplo e a regra pedem **frases curtas que o usuário escreveria** (ex.:
   `["como está minha agenda", "o que tenho hoje"]`). A validação de forma continua determinística (lista, 2–40
   caracteres, até 12).
2. `SkillLearner`: guardar a lista como lista. No `SKILL.md`, `triggers:` com as frases separadas por vírgula
   (formato plano da ADR-035); gatilho com vírgula é recusado na validação. O `trigger` do banco vira a alternância
   das frases **escapadas** (`(?:frase 1|frase 2)`), para a leitura como regex continuar valendo. Uma fonte de verdade:
   a lista.
3. `extractTriggerKeywords` sai. Nada mais quebra frase em palavra.
4. `matchSkillByTrigger`: frase inteira com `keywordBoundaryMatches`. Mesmo helper, mesmo comportamento de plural.
5. `ContextBuilder`: o corte do bloco de skills passa a ser **declarado** (proibição 2). Quando não cabem todas, o
   bloco diz quantas skills e quais ficaram de fora.
6. Testes: S149 e S383 atualizados; casos novos que **reprovam o código de hoje** ("qual a capital da França?" não
   casa a watchlist de cripto; "como está o tempo hoje?" não casa as 6 de hoje; frase do gatilho casa).

**Migração das 19 skills aprendidas** (as frases se perderam): decisão D2.

### Etapa 2 — Medir

Por 2 semanas de uso real, as mesmas medidas desta ADR: skills por turno, ferramentas por chamada, entrada do
`AgentLoop:loop` (`[LLM-CALL]`), e as skills que ela esperava e não vieram (relato dela ou `faltou`).

### Etapa 3 — C, se a medição pedir

Se depois de A ainda entrarem skills irrelevantes, ou faltarem as relevantes, o roteador passa a escolher. Isso exige
uma revisão desta ADR com o custo medido (roteador antes/depois) e a entrada no mapa das decisões (S356).

### Riscos e hipóteses não comprovadas

- **Não comprovado:** que gatilhos em frase reduzem as skills por turno ao ponto de tirar as ferramentas extras. A
  frase "o que tenho hoje" ainda casa muita conversa da operadora; o efeito só aparece medindo.
- Skill útil que hoje casava por acaso (palavra solta) pode deixar de casar. Isso é o comportamento certo, mas vai
  parecer regressão. A medição da Etapa 2 olha para isso.
- O texto dos passos de goal continua passando pelos gatilhos (A não muda isso; C mudaria).

## Fase 5 — Validação

| Pergunta | Resposta |
|---|---|
| Baseada em evidência real? | Sim: log, transcrições e `auto_skills` da produção; a hipótese B foi medida e caiu |
| Estrutural ou sintoma? | A corrige o estado (frases perdidas, duas fontes de verdade); C corrigiria o responsável |
| Reduz complexidade? | Sim: tira `extractTriggerKeywords` e o formato duplo do gatilho |
| Elimina fontes de verdade duplicadas? | Sim: a lista de frases vira a única |
| Mantém a filosofia do Kernel? | A ainda deixa palavra-chave escolher o que o LLM vê (débito declarado); C resolve |
| Incremental? | Sim: A → medir → C; E independente |
| Reversível? | Sim: A e E são mudanças locais; a migração D2 grava antes um arquivo de reversão (campo e `SKILL.md`) |

## Decisões para a operadora

- **D1.** Aprovar a Etapa 1 (A: frases do começo ao fim, fronteira de palavra, corte declarado)?
- **D2.** As 19 skills aprendidas perderam as frases. Como migrar?
  - (a) O modelo configurado regenera só os gatilhos a partir do nome, da descrição e do procedimento de cada uma
    (19 chamadas; estimativa ≈ 1 mil tokens de entrada e ≈ 100 de saída cada, ≈ 25 mil no total), guardando o valor
    anterior para reversão.
  - (b) Ela revisa os gatilhos pelo painel.
  - (c) Ficam como estão até serem reaprendidas.
- **D3.** Depois da medição, o roteador passa a escolher as skills (C)? Ou volta a ser discutido só com os números?
- **D4.** As ferramentas trazidas pelas skills passam a vir pelo catálogo da ADR-021 (E), e não completas?

### Decididas pela operadora (17/11/2026)

- **D1: aprovada.** Etapa 1 num ramo próprio, com testes que reprovam o código de hoje, e PR. Sem publicar.
- **D2: (a).** O modelo configurado regenera os gatilhos das 19 skills. As frases são mostradas a ela antes de gravar,
  e o valor anterior (campo e `SKILL.md`) fica num arquivo de reversão. A ADR-036 não tem histórico por skill; a
  reversão é do próprio script.
- **D3:** só depois da medição da Etapa 2.
- **D4: aprovada.** Entra no mesmo PR da Etapa 1, com medição antes/depois.

## Implementação (17/11/2026, ramo `feat/gatilhos-de-skill-em-frase`)

| Onde | O quê |
|---|---|
| `SkillDiscovery.ts` | `gatilhoCasa`: frase inteira, `keywordBoundaryMatches`, sem diferença de acento (forma, não significado). `campoDeGatilhos` / `frasesDoCampoDeGatilhos`: o formato do campo `trigger` (frases escapadas, separadas por `\|`; continua regex válida). Regex antiga escrita à mão continua virando palavras, como antes |
| `aprendizadoDeSkills.ts` | `REGRA_DOS_GATILHOS` no pedido (o exemplo de palavras soltas saiu); `gatilhosValidos` (forma: 2–40 caracteres, sem vírgula nem quebra de linha); `montarPedidoDeGatilhos` / `interpretarGatilhos` para a regeração (D2) |
| `SkillLearner.ts` | grava `campoDeGatilhos(p.gatilhos)`; o `SKILL.md` sai de `frasesDoCampoDeGatilhos`; `extractTriggerKeywords` saiu; `trocarGatilhos` e `skillsAprendidasPorTrajetoria` para a migração |
| `ContextBuilder.ts` | `blocoDeSkillsNoLimite`: o corte do bloco de skills diz quanto foi mostrado e o nome das skills cortadas ou fora do limite |
| `AgentLoop.ts` (D4) | as ferramentas do `tools:` das skills não entram mais em `preferredTools`; as que não vieram completas são nomeadas no topo do bloco de skills, para `carregar_ferramenta` |
| `RiskAnalyzer.ts`, `migracaoDePortabilidade.ts` | usam a mesma regra e o mesmo formato (antes: `includes` próprio; linha crua do `triggers:` no banco) |
| `scripts/regerar-gatilhos-de-skills.ts` | D2: `--previa` (chama o modelo do planejador, não grava), `--aplicar` (grava a prévia revisada, com reversão antes), `--reverter` |

Testes: S488 (novo; reprova o `includes` antigo: medido trocando a regra de volta, 2 falhas) e S149 (a referência
passou a ser a regra nova).

### Medição com a prévia da D2 (17/11/2026)

Prévia gerada numa cópia da produção Windows: 19 chamadas ao `PLANNER_MODEL`, 19 propostas na forma. Com as frases
propostas para as 19 aprendidas (as outras 21 skills com os gatilhos de hoje) e a regra nova, nas mesmas 443 mensagens:

| | p50 | p90 | máx | com ≥ 1 | com ≥ 5 |
|---|---:|---:|---:|---:|---:|
| skills por mensagem — hoje | 1 | 8 | 18 | 296 | 121 |
| skills por mensagem — ADR-040 | 0 | 1 | 3 | 82 | 0 |
| ferramentas trazidas — hoje | 3 | 9 | 13 | 296 | 189 |
| ferramentas citadas — ADR-040 (agora no catálogo, D4) | 0 | 1 | 6 | 82 | 9 |

**O risco agora é o oposto.** `consulta-agenda` casava 151 mensagens e passa a casar 4. A maior parte das 151 era
ruído ("que", "como", "está"), mas um pedido de agenda com outras palavras ("tenho algo amanhã?") também deixa de
trazer a skill. Isso não se decide por mais gatilhos: é o que a Etapa 2 mede e o que a C (roteador escolhe) resolveria.
O corte de 500 tokens continua (teto constante; ADR-038 alternativa D), agora declarado.

`--aplicar` e `--reverter` foram rodados na mesma cópia: 19 de 19 `SKILL.md` com os gatilhos da prévia; depois da
reversão, o arquivo de `consulta-agenda` ficou idêntico ao original (mesmo hash).

### Execução real (etapa 4, 17/11/2026)

Instância isolada: cópia do banco e das skills da produção Windows com os gatilhos da prévia aplicados, porta 3190, sem
nenhum canal externo, todos os modelos no Bonsai 27B local (`llama-server`, raciocínio desligado; escolha da operadora).
Três mensagens pela API do painel:

| Mensagem | Antes (regra de hoje) | Com a ADR-040 |
|---|---|---|
| "qual a capital da França?" | 1 skill (`status-watchlist-criptomoedas`, por "cap") | nenhuma skill; 11 ferramentas pela categoria; entrada do agente 5.054 tokens |
| "o que tenho hoje na agenda?" | — | `consulta-agenda` pela frase; a ferramenta dela (`schedule`) ficou no catálogo com o aviso no bloco de skills; o agente pediu `carregar_ferramenta schedule` e seguiu (D4 de ponta a ponta) |
| "como está a semana? não sei para que lado ir, tenho que criar a aula de hoje" | 16 skills e 10 ferramentas (medido com a mesma regra) | 1 skill e 1 ferramenta citada; no uso real o juiz de suficiência perguntou disciplina e tema antes do agente (ADR-015), então o agente não rodou |

Limitação: o corte declarado do bloco de skills é coberto pelo S488; o texto do prompt não sai no log, então não foi
conferido na execução real.

### Revisão de código (17/11/2026)

Corrigido no mesmo ramo, com cobertura no S488:
- `trocarGatilhos` regerava o `SKILL.md` inteiro a partir do banco: perdia edição feita no disco e apagava o
  `SKILL.md.revisar` de uma importação pendente; e uma falha ao gravar o arquivo era só registrada no log, com o banco
  já trocado. Agora muda só a linha `triggers:` (`comLinhaDeGatilhos`) e grava o arquivo ANTES do banco; falha lança.
  Na cópia: 19 de 19 arquivos com só essa linha mudada; depois de reverter, 19 de 19 idênticos ao original.
- O estouro do contexto inteiro (`ContextBudget`, prioridade) ainda cortava o bloco de skills com `[...truncated]`:
  agora também declara.
- Regex antiga: os membros sem metacaractere escapavam do filtro de antes (3+ letras, até 10); agora o campo inteiro
  segue a regra antiga.
- A mensagem passa a ser normalizada uma vez para todas as skills, não uma vez por gatilho.
- O script grava a prévia mesmo que uma skill lance exceção, e o `--aplicar` informa e sai com erro quando uma skill
  não é gravada.

Os três pontos que ficariam para depois também foram resolvidos no ramo (a operadora: "nunca deixa erro para trás"):
- **Planejador (D5, decidida pela operadora em 17/11):** `discoverSkills(...).all` também incluía skills por palavra
  de etiqueta e de descrição (`byCapability`, Sprint 3.7A). Medido nas 443 mensagens: até 26 skills por mensagem (p90 6),
  puxadas por "quando" (185 mensagens), "arquivo" (99), "para" (54). O planejador já recebe o catálogo inteiro (nome +
  descrição). Decisão: só frase, como o agente. Saíram `inferCapabilities`, `expandSkillCapabilities`,
  `matchSkillByCapabilities`, `normalizeToken` e as etiquetas derivadas do nome (`deriveTagsFromSkill`), que só serviam
  a esse casamento; `discoverSkills` devolve as skills casadas por gatilho. O texto ao planejador virou fato ("Skills
  cujos gatilhos aparecem no pedido: …") no lugar de ordem ("Priorize-as"). S383 reescrito: os casos de etiqueta da
  Sprint 3.7A agora verificam que a skill não vem sem o gatilho.
- **Caminho do banco:** `scoreSkillMatch` usa `campoCasa` — formato novo pela mesma regra de frase do arquivo; regex
  escrita à mão (skills antigas só no banco) continua regex.
- **Painel:** conferido que nenhuma tela lê o campo `trigger` (`SkillsView.js` mostra nome, descrição, prioridade,
  ferramentas e situação; o `/skills` também não o mostra). O achado não se confirmou; nada a mudar.
