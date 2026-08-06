# RFC-005 — Políticas de Substituição de Recursos

**Status:** proposta
**Data:** 2026-08-06
**Origem:** `docs/analises-arquiteturais/FASE0_POLITICAS_IMPLICITAS_DE_INDISPONIBILIDADE_2026-08-06.md`
**Substitui/Complementa:** nada é revogado. `ADR-002` e `ADR-005` permanecem válidos integralmente.

## Decisões que destravaram esta RFC

A Fase 0 encerrou com quatro perguntas deliberadamente sem resposta proposta, para que a RFC não
nascesse escolhendo implicitamente por elas. O operador as respondeu em 06/08/2026:

| # | Pergunta | Decisão |
|---|---|---|
| 1 | Soberania da Configuração do Usuário vira princípio normativo? | **Sim.** Explica casos independentes (`ADR-002`, issue 019, fallback local→nuvem, `searXNG`) — é regra geral, não caso específico |
| 2 | Localidade da Recuperação vira princípio normativo? | **Sim.** É verificável e separa casos; o `newclaw-kernel-adapter` provou que política correta na camada errada é, na prática, inexistente |
| 3 | Taxonomia de indisponibilidade | **Definida por esta RFC**, não antes dela. A Fase 0 demonstrou a necessidade; modelar os estados é trabalho de solução, não de investigação |
| 4 | Escopo | **Conceitual geral, primeira aplicação restrita.** Os princípios valem para qualquer recurso substituível; a primeira implementação limita-se a providers/modelos |

A consequência da decisão 4 é o motivo de esta RFC não se chamar "RFC do llamafile": ela é sobre
políticas de substituição de recursos, e o llamafile é apenas o primeiro caso concreto.

---

# Resumo

O NewClaw substitui recursos indisponíveis por alternativas, silenciosamente, em pelo menos cinco
subsistemas independentes. Nenhuma dessas substituições é errada por existir — fallback é uma
técnica legítima e o projeto depende dela. O defeito é que a substituição acontece **sem
autoridade declarada e sem visibilidade**: o usuário configura um recurso, o sistema usa outro, e
nada na resposta indica que isso ocorreu.

Esta RFC formaliza dois princípios normativos (**Soberania da Configuração do Usuário** e
**Localidade da Recuperação**), define a **taxonomia de estados** que hoje não existe — o sistema
conhece um único estado, *falhou* — e estabelece a **política de substituição** que decorre dos
dois. A primeira aplicação prática cobre apenas providers/modelos.

O critério de aceitação, formulado pelo operador na Fase 0, permanece o mesmo:

> *"Se a Internet cair agora, o usuário ainda consegue trabalhar da forma que configurou?"*

---

# Motivação

A Fase 0 levantou catorze pontos de substituição automática em cinco domínios. Dez deles nunca
foram objeto de decisão: foram apenas implementados. O que os une não é um padrão de código — é a
mesma regra violada:

**Uma camada determinística altera a estratégia de execução escolhida por outra camada e não conta
a ninguém.**

Isso já foi diagnosticado neste projeto em dois outros contextos, com nomes próprios: o Evidence
Provider Pattern (componente de conhecimento decidindo pelo Planner) e a `RFC-004`, Princípio 2
(canal decidindo o que a IA vê). Esta RFC é a terceira instância do mesmo diagnóstico, aplicada à
fronteira entre a **configuração do usuário** e a **execução**.

---

# Evidência

Toda evidência abaixo é de execução real ou de código verificado em 06/08/2026 — nenhuma é
hipotética.

## E1 — Modelo local configurado, resposta de nuvem entregue (produção, 05/08/2026)

O turno pediu `GLM-4.7-Flash` (local); o llamafile não respondeu; o circuito abriu com
`5/5 failures`; a resposta veio de `glm-5.2:cloud`. O usuário recebeu resposta de nuvem tendo
configurado modelo local, **sem nenhum aviso**.

Com a Internet caída, esse mesmo caminho não degrada — falha por timeout. O fallback que hoje
mascara o problema é também o que impede o sistema de funcionar offline.

## E2 — A consulta do usuário sai da máquina (código, verificado)

[`src/tools/web_search.ts:252`](../../src/tools/web_search.ts):

```ts
const urls = ['http://localhost:8888/search', 'https://searx.be/search'];
```

O usuário sobe uma instância SearXNG local justamente para que suas buscas não saiam da máquina.
Encontrando-a fora do ar, o sistema **envia a mesma consulta a um servidor público de terceiros**,
sem avisar. É o caso mais grave do levantamento e não tem relação alguma com modelos — a
implicação é privacidade, não disponibilidade.

## E3 — Estado normal contabilizado como avaria (produção)

`CIRCUIT-OPEN: Skipping 'Modelo local' (failures: 72)`.

Um servidor de modelo local desligado pelo usuário é estado **normal, esperado e reversível com um
clique**. O `CircuitBreaker` não tem como distingui-lo de um provider avariado:
[`CircuitBreaker.ts:300`](../../src/core/CircuitBreaker.ts) (`onFailure`) incrementa
`consecutiveFailures` para qualquer erro, sem qualificação de causa. Setenta e duas falhas
registradas contra um recurso que nunca esteve quebrado.

## E4 — A proteção existia e era inalcançável (incidente, 06/08/2026)

`CognitiveKernelGate` prometia, no próprio cabeçalho, cair em `{action:'proceed'}` diante de
"dependência ausente", com circuit breaker e kill-switch implementados. Mas o `import` era
estático: a falha ocorria em **tempo de compilação**, onde nenhum `try/catch` de runtime existe
ainda. `npm run build` quebrava em toda máquina que não a do autor. Corrigido em `45d6365`,
cobertura `S203`.

## E5 — O melhor exemplo do projeto também falha, num eixo diferente (código, verificado)

A Fase 0 apontou a cadeia de TTS como o exemplo a generalizar: Piper (offline) é tentado primeiro,
e apenas quando o operador baixou os modelos — *"presença dos arquivos É o sinal de intenção"*.
Isso continua correto e continua sendo o modelo a seguir.

Mas [`send_audio.ts:199`](../../src/tools/send_audio.ts) mostra o que acontece quando o Piper
falha:

```ts
log.error('Piper failed, falling back to node-edge-tts:', errorMessage(piperErr));
```

O áudio passa a ser sintetizado por um serviço da Microsoft via WebSocket. O texto do usuário sai
da máquina. Isso é registrado no **log**, nunca comunicado ao usuário.

Esta evidência mostra que **autoridade e visibilidade falham separadamente**: a cadeia de TTS
acerta quem decide e erra quem fica sabendo. É por isso que a Soberania tem duas cláusulas em vez
de uma — e não, como se poderia supor, por que precise haver um princípio de Visibilidade
separado (ver 1.4).

---

# Princípio Normativo 1 — Soberania da Configuração do Usuário

> Quando o usuário declara explicitamente qual recurso o sistema deve usar para uma função, nenhum
> componente pode substituí-lo por outro sem que a substituição seja **(a)** permitida pela
> política declarada para aquele recurso e **(b)** visível no resultado entregue ao usuário.

## 1.1 O que conta como declaração

Soberania protege **escolha explícita**, não ausência. Um recurso está declarado quando o usuário
o selecionou, configurou ou instalou deliberadamente — um modelo escolhido na interface, uma
`WHISPER_API_URL` preenchida, os modelos do Piper baixados para `PIPER_MODELS_DIR`.

Ausência de configuração **não** é declaração e não invoca este princípio. Ela invoca `ADR-002`
§2.1 e `NUNCA_ADIVINHAR.md`: o sistema não preenche a lacuna com um padrão embutido, e o
comportamento diante da ausência é decidido por quem tem autoridade para isso.

## 1.2 Fronteiras de substituição

A regra não é "nunca substituir" — isso destruiria resiliência legítima e não é o que a evidência
pede. A regra depende do que a substituição **atravessa**:

| Fronteira | Atravessar significa |
|---|---|
| **Localidade** | o processamento sai da máquina do usuário (local → remoto) |
| **Custódia** | o dado passa a ser tratado por um terceiro que o usuário não escolheu |

**Substituição que não atravessa nenhuma fronteira é resiliência ordinária** e pode ser
silenciosa — dois provedores de nuvem equivalentes que o usuário listou lado a lado se cobrindo
mutuamente, por exemplo.

**Substituição que atravessa qualquer fronteira exige, no mínimo, anúncio.** O caso do `searXNG`
(E2) atravessa localidade *e* custódia em silêncio; o do TTS (E5) atravessa ambas e registra
apenas em log.

Duas fronteiras, não três. "Custo" (passar a consumir recurso cobrado onde havia gratuito) foi
considerada e **cortada**: nenhum dos catorze casos da Fase 0 se classifica por ela sozinha — no
caso do modelo local (E1), localidade já produz o mesmo veredito. Uma fronteira que nunca decide
nada por conta própria é estrutura sem evidência, e o sistema tampouco tem hoje sinal confiável de
quais providers são cobrados. Registrada aqui como descartada, para não voltar por hábito.

## 1.3 Políticas declaráveis

Cada recurso declarado carrega uma política, que responde "o que fazer quando ele não estiver
disponível":

| Política | Comportamento |
|---|---|
| `estrita` | Nunca substituir. A indisponibilidade é reportada ao usuário como resultado |
| `anunciada` | Substituir dentro das fronteiras permitidas; a substituição **aparece na resposta**, não só no log |
| `livre` | Substituir silenciosamente. **Só válida para substituição que não atravessa fronteira** |

**Padrão para recurso declarado: `anunciada`.** Não `estrita`, que seria disruptiva e vai além do
que a evidência exige; não `livre`, que é exatamente o defeito atual.

## 1.4 Quem verbaliza a substituição

Pela `RFC-004` e por `ARCHITECTURE.md` ("Gaps conhecidos"), o Core não tem sistema de tradução, e
o caminho escolhido pelo projeto é **reduzir o texto fixo que o Core emite**, não criar i18n novo.
Portanto: a substituição entra na resposta como **fato para o LLM verbalizar** — que já obedece a
`buildLanguageDirective` — nunca como string fixa concatenada pelo Core.

Isto é a `RFC-004`, Princípio 2, aplicada a outra camada: produzir fato, não decisão nem redação.

**Visibilidade é a cláusula (b) deste princípio, não um princípio próprio.** A Fase 0 mostrou que
autoridade e visibilidade podem falhar separadamente (E5), e essa distinção é útil como eixo de
análise — mas as duas protegem a mesma coisa (a escolha do usuário continua valendo, e ele sabe
quando não valeu) e não há evidência de que precisem de normas separadas. Promover visibilidade a
princípio autônomo fica **deliberadamente adiado**, até existir caso que uma cláusula classifique
e a outra não.

## 1.5 Exceções

Como todo princípio normativo deste projeto (`EVIDENCE_PROVIDER_PATTERN.md` §7,
`NUNCA_ADIVINHAR.md` §6), a Soberania tem fronteira declarada. Ela **não** se aplica a recusa ou
bloqueio por **segurança, integridade ou conformidade** — mesma exceção que a
`DIRETRIZ_ARQUITETURA` já reconhece para o Princípio da Preservação do Raciocínio.

Não são violações desta RFC, e permanecem intocados:

* `ToolRegistry.requiresAuthorization()` e a recusa *fail-closed* do executor comum (`ADR-005`
  §5.1) — negar execução por falta de autorização humana não é substituir um recurso declarado.
* `isDestructive()` / `RiskAnalyzer` — bloqueio absoluto de padrões catastróficos.

A distinção operacional: Soberania governa **trocar um recurso por outro**. Recusar executar não é
troca — é ausência de execução, e ela é sempre visível ao usuário por construção. Um componente
que invocasse esta exceção para *substituir* silenciosamente estaria violando o princípio, não
exercendo a exceção.

---

# Princípio Normativo 2 — Localidade da Recuperação

> As políticas de recuperação devem ser implementadas na mesma camada em que a falha pode ocorrer.

| Tipo de falha | Camada que deve tratá-la |
|---|---|
| Dependência ausente (import) | resolução de módulos / composição |
| Provider indisponível | `ProviderFactory` / `CircuitBreaker` |
| Modelo recusou a requisição | camada do provider |
| Ferramenta retornou erro | executor da ferramenta |
| Prompt inválido | Planner |

## 2.1 Corolário — alcançabilidade

Declarar a intenção de degradar não basta. **O mecanismo de degradação precisa ser alcançável no
instante em que a indisponibilidade acontece.** Um recurso que falta em tempo de build exige
tratamento em tempo de build; um `try/catch` de runtime não protege contra um `import` estático
que não resolve (E4).

## 2.2 Corolário — localidade do diagnóstico

O princípio vale também para a informação que permite classificar a falha, não só para a reação a
ela. Se a camada que falha não alcança o sinal que distinguiria "desligado" de "quebrado", ela é
obrigada a adivinhar — e adivinhar é proibido por `NUNCA_ADIVINHAR.md`.

É exatamente a situação de E3: a informação existe (o Dashboard sabe qual modelo foi escolhido, em
que porta, e se o processo responde), mas mora numa camada de apresentação, fora do alcance de
`ProviderFactory`/`CircuitBreaker`, que são quem precisa dela.

## 2.3 Os dois princípios são ortogonais

A Fase 0 demonstrou isso testando ambos contra os catorze casos. Um caso pode acertar um e errar o
outro:

| | Camada certa | Camada errada |
|---|---|---|
| **Autoridade certa** | `ProactiveRecovery`, Whisper | — |
| **Autoridade errada** | `searXNG`, fallback local→nuvem, TTS (visibilidade) | `newclaw-kernel-adapter` (errava as duas) |

Manter os dois separados é o que impede a RFC de tratar casos distintos como se fossem o mesmo.

---

# Taxonomia de estados de indisponibilidade

Hoje o sistema tem **um** conceito: falhou. Esta é a lacuna que E3 mede em produção. A taxonomia
abaixo é a contribuição original desta RFC.

| Estado | Significado | Efeito no circuit breaker | Substituição |
|---|---|---|---|
| `disponivel` | Responde | — | não se aplica |
| `nao_declarado` | O usuário nunca escolheu este recurso | nenhum | livre — não há soberania a proteger |
| `parado_por_decisao` | Declarado, e não está em execução — porque ninguém o religou, e o sistema não religa sozinho (`ADR-002` §2.3) | **nenhum** | conforme a política declarada |
| `avariado` | Declarado, deveria estar de pé, não responde | conta como falha | conforme a política declarada |
| `indeterminado` | Não há sinal suficiente para classificar | **nenhum** | conforme a política declarada |

## Regra de classificação

Um recurso só é `avariado` quando há **evidência positiva de falha** *e* **evidência de que ele
deveria estar de pé**. Faltando a segunda, o estado é `indeterminado` — nunca `avariado`.

Isto é `NUNCA_ADIVINHAR.md` aplicado a um domínio novo. O comportamento atual — tratar ausência de
sinal como avaria — é literalmente inferir um valor plausível e apresentá-lo como fato: as
`72 failures` de E3 são setenta e duas suposições registradas como observações.

## O que significa "deveria estar de pé"

Depende de o recurso ter ou não ciclo de vida gerenciado:

* **Sem ciclo de vida gerenciado** (provider de nuvem com credencial declarada): declarar já
  implica esperar disponibilidade. Falha ⇒ `avariado`. **Comportamento idêntico ao atual.**
* **Com ciclo de vida gerenciado** (servidor de modelo local): "deveria estar de pé" **não** é a
  existência do registro — é o processo estar vivo *e* a porta responder, exatamente a dupla
  verificação que `models.ts` já faz para reencontrar um servidor sobrevivente (`ADR-002` §2.3).

| Sinal | Estado |
|---|---|
| Sem registro em `data/local-model-server.json` | `nao_declarado` |
| Registro presente; PID morto **ou** porta muda | `parado_por_decisao` |
| Registro presente; PID vivo **e** porta responde; requisição falha | `avariado` |
| Registro inalcançável por quem precisa classificar | `indeterminado` |

**Por que a segunda linha não pode ser `avariado`** — e este é o ponto onde uma leitura descuidada
recriaria o defeito que a RFC existe para corrigir: `ADR-002` §2.4 determina que o registro
**sobrevive à morte do processo**, porque ele é a única memória de qual modelo o usuário escolheu.
E §2.3 garante que ninguém religou aquele servidor por conta própria. Logo, registro presente com
processo morto é o estado esperado após qualquer reinício de máquina — normal, reversível com um
clique, e jamais uma avaria. Tratar a presença do registro como "deveria estar de pé" reproduziria
as `72 failures` de E3 com uma taxonomia nova por cima.

**Propriedade de desenho, deliberada:** o comportamento só muda onde existe sinal de ciclo de
vida. Onde não existe, tudo permanece exatamente como hoje. Isso torna a mudança incremental e
reversível — critérios da Fase 5 da diretriz.

## Por que `indeterminado` não pode ser colapsado

É tentador tratá-lo como `avariado` ("na dúvida, assuma quebrado") ou como `parado_por_decisao`
("na dúvida, não penalize"). Ambos são adivinhação. `indeterminado` é um estado de primeira
classe, e a diferença é observável: é o estado que diz *"o diagnóstico não alcança este recurso"*
— sintoma da violação descrita em 2.2, e portanto um indicador de dívida arquitetural que deve
ficar visível, não mascarado.

---

# Teste dos princípios contra o levantamento

Um princípio só é útil se separar casos. Aplicados aos achados da Fase 0:

| Caso | Soberania | Localidade | Veredito |
|---|---|---|---|
| `newclaw-kernel-adapter` | — | ❌ → ✅ | Corrigido (`S203`) antes desta RFC |
| Whisper remoto → local | ✅ | ✅ | Conforme |
| `ProactiveRecovery` (args/tools) | fora de escopo (decisão do LLM) | ✅ | Conforme |
| Classificação LLM → keyword | fora de escopo | ✅ | Conforme |
| TTS Piper → edge-tts | ⚠️ autoridade ✅, visibilidade ❌ | ✅ | Não conforme em 1.2 |
| `chatWithFallback` local→nuvem | ❌ | ✅ | Não conforme — alvo primário |
| `CircuitBreaker` sobre local | ❌ (taxonomia) | ⚠️ diagnóstico fora de alcance | Não conforme — alvo primário |
| `resolveProfile ?? chat ?? [0]` | ❌ | ✅ | Não conforme — legado |
| `searXNG` local → público | ❌ (localidade + custódia) | ✅ | Não conforme — o mais grave |

Os princípios classificam os nove casos sem empate e sem forçar nenhum. Note que quatro saem
**conformes** — uma norma que reprovasse tudo não estaria separando nada.

---

# Escopo

## Nesta RFC (conceitual)

Os princípios valem para **qualquer recurso substituível**: providers, modelos, busca web, STT,
TTS, e os que vierem.

## Na primeira implementação (prática)

Apenas **providers/modelos** — `ProviderFactory`, `CircuitBreaker`, e o sinal de ciclo de vida do
runtime local. É o subsistema com evidência de produção mais forte (E1, E3) e o único onde a
taxonomia tem efeito imediato.

## Aplicações posteriores — registradas, não implementadas

TTS (visibilidade, E5), `resolveProfile ?? chat ?? [0]`, STT. Cada uma vira trabalho próprio, sob
os mesmos princípios.

**Uma exceção decidida a este recorte** (operador, 06/08/2026): o caso `searXNG` (E2) entra já,
como Sprint 023. Justificativa: é vazamento de privacidade confirmado em código, a correção é a
remoção de uma URL de uma linha, e não depende de nada que esta RFC vá construir — não há o que
esperar. Manter um vazamento conhecido aberto por disciplina de escopo seria o trade-off errado.

Fica registrada como desvio **explícito** do recorte, e não como caso de providers/modelos que ela
não é. As demais aplicações posteriores continuam fora: nenhuma delas reúne as três condições
acima.

---

# Alternativas descartadas

## A1 — Tratar apenas o fallback de modelos

**Descartada.** Deixaria de fora os dois achados mais graves da Fase 0 (`searXNG` e o pacote
opcional derrubando o build). A Fase 0 mostrou a mesma regra violada em cinco domínios
independentes — tratar um seria corrigir sintoma, contra a filosofia do projeto.

## A2 — Remover todos os fallbacks

**Descartada.** Fallback é técnica legítima e o projeto depende dela; quatro casos do levantamento
já são conformes. A evidência não pede o fim da substituição, pede autoridade e visibilidade.

## A3 — Modo de Operação global (Online / Offline / Híbrido)

Proposto pelo operador, registrado como questão aberta #5 da Fase 0. **Descartado como
primitivo**, por três razões:

1. **Não resolve o pior caso.** O `searXNG` (E2) é privacidade, não conectividade: um usuário com
   Internet plena continua não querendo sua consulta em `searx.be`. Um modo baseado em
   conectividade não alcança esse caso.
2. **Granularidade insuficiente.** Não consegue expressar "use o modelo local, mas busca na nuvem
   está ok" — combinação legítima e provavelmente comum.
3. **Segunda fonte de verdade.** Conviveria com a política por recurso, e as duas poderiam
   discordar — o defeito que a `RFC-004`, Princípio 1, já tratou noutro contexto.

**Não descartado como conveniência.** Se um Modo de Operação for adicionado depois, deve ser um
*preset* que escreve as políticas por recurso — nunca uma fonte de verdade paralela consultada em
tempo de execução.

## A4 — Expor o estado do runtime via HTTP do Dashboard para o Core

**Descartada.** Inverteria a arquitetura de canais que `ARCHITECTURE.md` protege: o Core passaria
a depender de uma camada de apresentação. Resolveria o sintoma (o dado chega) piorando a estrutura
(a dependência inverte).

---

# Gate obrigatório — Extensão antes de Criação

Nenhum arquivo novo de Tool, Skill ou Script é proposto por esta RFC. Nenhuma capacidade nova de
runtime é criada — a de ciclo de vida **já existe, madura e testada** (`S171`), em
`src/dashboard/routes/models.ts`. O trabalho é de localização e de contrato, não de construção.

| Candidato | Precisa existir? | O que já existe | Decisão |
|---|---|---|---|
| Serviço de ciclo de vida do runtime | **A decidir em ADR** | `src/dashboard/routes/models.ts` (spawn/kill/reencontro por PID+porta, `S171`) | Não é arquivo novo: é a mesma capacidade, possivelmente noutra camada |
| Classificador de estado de recurso | Não | `CircuitBreaker` já é o objeto de estado por provider e já recebe cada desfecho | Extensão de `CircuitBreaker` |
| Registro de política por recurso | Não | Configuração de provider/perfil já existe | Campo novo na configuração existente |

**Onde deve viver a capacidade de ciclo de vida do runtime é a questão aberta #4 da Fase 0, e esta
RFC não a decide.** Precedente: a localização do gate de ação perigosa recebeu ADR própria
(`ADR-005`) em vez de ser decidida de passagem por uma RFC de escopo maior. O mesmo tratamento se
aplica aqui — ver Sprint 019.

---

# Riscos e hipóteses não comprovadas

1. **A política por recurso pode ser configuração demais.** Três políticas × N recursos é
   superfície de configuração que ninguém pediu. Mitigação: o padrão (`anunciada`) é aplicado sem
   o usuário declarar nada; a política só aparece para quem quiser mudá-la. **Não comprovado** —
   se na prática todo mundo precisar mexer, o padrão está errado.
2. **"Anunciar" pode virar ruído.** Se toda substituição aparecer na resposta, o usuário aprende a
   ignorar. Mitigação: só atravessar fronteira anuncia; substituição interna permanece silenciosa.
   **Não comprovado** em uso real.
3. **A taxonomia depende de um sinal que hoje não é alcançável.** Enquanto a questão #4 não for
   decidida, todo runtime local cai em `indeterminado`. Isso é degradação correta (não penaliza,
   não adivinha), mas não entrega o benefício de E3 até a Sprint 019 concluir.
4. **`indeterminado` pode mascarar avaria real.** Um provider genuinamente quebrado cujo sinal de
   ciclo de vida seja inalcançável nunca abre o circuito, e cada turno paga o timeout inteiro.
   Risco real, aceito conscientemente: pagar timeout é preferível a acusar de avaria um recurso
   que o usuário desligou. Mitigável por teto de tentativas independente do circuito — **não
   proposto agora** por falta de evidência de que o caso ocorra.
5. **O sinal de ciclo de vida só foi exercitado no Windows.** `ADR-002` §3 declara esse limite
   para si mesma, e a taxonomia desta RFC herda-o inteiro: `parado_por_decisao` depende de
   `process.kill(pid, 0)` e da checagem de porta, multiplataforma no Node mas verificadas em um só
   sistema operacional. Fora do Windows, o estado provável é `indeterminado` — degradação correta,
   porém sem o benefício de E3. Não é regressão; é o limite herdado, dito em voz alta.

---

# Não objetivos

* **Não** introduzir Modo de Operação global (ver A3).
* **Não** criar sistema de tradução no Core — segue a `RFC-004`: reduzir texto fixo, não traduzi-lo.
* **Não** reabrir `ADR-002` §2.3. O NewClaw continua não religando o modelo local sozinho; esta RFC
  decide o que fazer **no lugar** disso, lacuna que a `ADR-002` deixou explicitamente aberta.
* **Não** alterar o comportamento de providers de nuvem sem ciclo de vida gerenciado.
* **Não** estender a regra à substituição de decisões do **LLM** (`ProactiveRecovery`,
  `exec_command` AUTO-FIX). É fronteira distinta, já coberta por `EVIDENCE_PROVIDER_PATTERN.md` e
  pela Preservação do Raciocínio. Questão aberta #7 da Fase 0 permanece aberta.

---

# Impacto na documentação existente

| Documento | Mudança |
|---|---|
| `docs/ARCHITECTURE/` | Dois documentos normativos novos: `SOBERANIA_DA_CONFIGURACAO.md` e `LOCALIDADE_DA_RECUPERACAO.md` |
| `docs/ARCHITECTURE/README.md` | Índice dos dois princípios |
| `CLAUDE.md` (diretriz) | Seção "Princípios formalizados" ganha as duas entradas |
| `ADR-002` | Nota apontando que a lacuna do §2.3 ("o que fazer no lugar de religar") é resolvida aqui |
| Fase 0 | Marcado como **encerrado**, com ponteiro para esta RFC |

---

# Validação

Segue a Validação Progressiva da diretriz — as quatro etapas, em ordem, com a etapa 4 obrigatória.

1. **Unitários** — classificação de estado a partir de sinais sintéticos; matriz política ×
   fronteira.
2. **Regressão** — suíte completa. Casos novos cobrindo: `parado_por_decisao` não incrementa o
   circuito; ausência de sinal produz `indeterminado`, nunca `avariado`; provider de nuvem
   preserva o comportamento atual.
3. **E2E sintético** — turno completo com provider local declarado e parado, LLM mockado,
   verificando que a substituição aparece como fato na resposta.
4. **Execução real** — instância isolada (`skill verify`), modelo local declarado, servidor
   desligado deliberadamente, LLM real. Critério: a resposta informa a substituição, e o contador
   de falhas do recurso local permanece em zero.

A etapa 4 é a que importa aqui. As duas evidências que tornaram essa etapa obrigatória na diretriz
(`migrateLegacyColonPath` e `resolveArtifactPathFromEvidence`) são exatamente deste tipo: mock e
código compartilhando o mesmo ponto cego. Um teste de "servidor local desligado" escrito por quem
implementa a taxonomia tem alta chance de mockar o sinal do jeito que o código espera encontrá-lo.

---

# Próximos passos — Sprints

Encadeamento deliberado: documentação antes de implementação, e a decisão de localização antes do
código que depende dela.

| Sprint | Conteúdo | Depende de |
|---|---|---|
| **018** | Documentos normativos dos dois princípios + alinhamento (`ARCHITECTURE/README`, `CLAUDE.md`, nota na `ADR-002`, encerramento da Fase 0) | esta RFC aprovada |
| **019** | **ADR-006** — onde vive a capacidade de ciclo de vida do runtime (questão aberta #4). Decisão, não implementação | 018 |
| **020** | Taxonomia de estados em `CircuitBreaker`: `parado_por_decisao` e `indeterminado` deixam de contar como falha | 019 |
| **021** | Política por recurso (`estrita`/`anunciada`/`livre`) na configuração de providers; padrão `anunciada` | 020 |
| **022** | Substituição atravessando fronteira vira **fato na resposta**, verbalizado pelo LLM | 021 |
| **023** | *(fora do escopo primário — ver "Escopo")* `searXNG`: remover o servidor público da cadeia | 018 |
| **024** | Validação em execução real (etapa 4) e relatório de fechamento | 020-022 |

A Sprint 019 é uma ADR e não produz código de propósito: decidir a localização enquanto se
implementa é como o `newclaw-kernel-adapter` acabou com uma proteção inalcançável.

---

# Critérios objetivos de sucesso

1. Servidor de modelo local desligado pelo usuário: contador de falhas permanece **zero** após N
   turnos (hoje: 72).
2. Substituição que atravessa fronteira **nunca** ocorre sem aparecer na resposta ao usuário.
3. Provider de nuvem sem ciclo de vida gerenciado: comportamento **byte-idêntico** ao atual.
4. Com a Internet caída e modelo local declarado e em execução, o turno completa. Se o modelo
   estiver parado, o usuário é informado disso — nunca recebe silenciosamente resposta de nuvem.
5. Reversibilidade: cada Sprint isolada pode ser revertida sem quebrar as anteriores.
