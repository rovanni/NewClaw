# Inventário de Duplicidades de Código — Classificação (2026-08-24)

> Produto da campanha "Consolidation — Single Authoritative Knowledge", etapa 1 (Inventário +
> Classificação). **Nenhuma alteração de código foi feita nesta etapa** — só levantamento,
> classificação segundo `QUANDO_EXTRAIR_DUPLICACAO.md` e recomendação. A decisão sobre quais casos
> avançam para extração real é uma etapa separada, posterior, condicionada à revisão deste
> documento — não decidida aqui.

## Método

Ponto de partida: os 6 casos confirmados + 1 candidato pendente + 6 casos já consolidados
preventivamente, listados na Seção 5 de `QUANDO_EXTRAIR_DUPLICACAO.md` (investigação dedicada de
24/08/2026). Para não confiar só nessa lista, uma busca adicional dirigida (`grep` por
`getProviderWithModel(` em todo `src/`) encontrou um caso novo (D-08, abaixo) que a investigação
original não cobriu, porque procurava especificamente por "duplicação que já divergiu", não por
"mesmo anti-padrão repetido em vários consumidores". Isso não é uma varredura exaustiva nova —
é o padrão de busca dirigida que a própria doutrina recomenda (Seção 4: "quem encontra código
duplicado..."), aplicado uma segunda vez com um filtro diferente.

Cada caso é classificado com os testes de `QUANDO_EXTRAIR_DUPLICACAO.md` Seção 3: **Teste 0**
(conhecimento vs. implementação), **Teste 1** (algum dos seis sinais de conhecimento
compartilhado presente?), **Contra-teste de acoplamento** (a extração cria acoplamento pior que o
problema?). **Decisão** é sempre uma de: `EXTRAIR` / `MANTER INTENCIONALMENTE` / `INVESTIGAR` /
`FORA DO ESCOPO`.

---

## Parte 1 — Casos que passam pela classificação completa

### D-01 — Lista de modelos locais carregáveis

| Campo | Valor |
|---|---|
| Arquivo A | `src/dashboard/public/config/components/LocalModelWizard.js` |
| Arquivo B | `src/dashboard/public/config/components/ConfigWizard.js` |
| Trecho/regra duplicada | Loop de renderização da lista de modelos `.gguf` carregáveis (linha por modelo + botão "Usar este modelo") |
| Tipo de duplicação | Comportamento de UI compartilhado (mesma decisão de layout tomada em dois lugares) |
| Fonte autoritativa atual | `src/dashboard/public/config/components/LocalModelPickList.js` (extraído) |
| Evidência de divergência | Bug visual real: zebra striping corrigido só num dos dois wizards; usuário reportou a inconsistência ao vivo (24/08/2026) |
| Risco de divergência | Alto antes da extração (dois loops copiados evoluindo sem sincronização) |
| Teste 0 | Conhecimento (regra de apresentação compartilhada, não helper trivial — decisão confirmada pelo próprio bug observado) |
| Teste 1 | Sinal presente: divergência já observada |
| Contra-teste de acoplamento | Passa — `LocalModelPickList.js` é módulo-folha neutro, nenhum wizard importa o outro; independência dos dois preservada (Seção 6 do doc) |
| **Decisão** | **EXTRAIR — concluído em 24/08/2026.** Nenhuma ação pendente. |

### D-02 — Retry com backoff em anexos de mídia

| Campo | Valor |
|---|---|
| Arquivo A | `src/core/agentMediaHandlers.ts` — `transcribeAttachment` (tinha retry×3) |
| Arquivo B | `src/core/agentMediaHandlers.ts` — `handlePhotoAttachment`/`handleDocumentAttachment` (não tinham) |
| Trecho/regra duplicada | Política de resiliência de download de anexo (quantas tentativas antes de desistir) |
| Tipo de duplicação | Regra de negócio compartilhada (garantia de entrega, não implementação) |
| Fonte autoritativa atual | Retry unificado dentro do próprio `agentMediaHandlers.ts` |
| Evidência de divergência | Incidente real 04/08/2026 (RFC-004 Correção 3): 3 de 12 imagens enviadas na mesma conversa nunca produziram resposta |
| Risco de divergência | Confirmado, já materializado |
| Teste 0 | Conhecimento (garantia de entrega é regra de negócio, não helper) |
| Teste 1 | Sinal presente: divergência já observada + necessidade de manutenção conjunta |
| Contra-teste de acoplamento | Passa — mesmo arquivo, sem import cruzado entre módulos |
| **Decisão** | **EXTRAIR — concluído.** Coberto por `S198_MediaHandlers_DownloadRetryParity.test.ts`. |

### D-03 — Catálogos de dependências (`KNOWN_DEPS` / `TOOLS_TO_PROBE`)

| Campo | Valor |
|---|---|
| Arquivo A | `src/loop/GoalEvaluator.ts` — `KNOWN_DEPS` |
| Arquivo B | `src/core/EnvironmentProbe.ts` — `TOOLS_TO_PROBE` |
| Trecho/regra duplicada | Quais dependências o sistema conhece / quais são checadas no ambiente |
| Tipo de duplicação | Catálogo — representação do mesmo conhecimento (quais ferramentas existem), em duas estruturas de dados com propósitos distintos |
| Fonte autoritativa atual | Nenhuma fonte única — **guarda de paridade automatizada** (`S154_CatalogConsistency_KnownDepsToolsToProbeParity.test.ts`) substitui a unificação |
| Evidência de divergência | Auditoria 26/07/2026: `puppeteer`/`tesseract` ausentes de `TOOLS_TO_PROBE` por 2+ dias; `edge-tts` levou 2 commits/~11h pra existir nos dois catálogos |
| Risco de divergência | Médio, mitigado — terceiro catálogo (`KNOWN_SYSTEM_DEPS`) já foi eliminado (Sprint 005/5.1); os dois catálogos remanescentes têm formas de dados diferentes (`DependencyInfo` completo vs. lista de nomes para probing) |
| Teste 0 | Conhecimento (catálogo) |
| Teste 1 | Sinal presente: divergência já observada |
| Contra-teste de acoplamento | **Não passa para unificação total** — `GoalEvaluator` (curadoria/instalação) e `EnvironmentProbe` (sondagem de ambiente) são responsabilidades diferentes por design (ver `PIPELINE_CURADORIA_DEPENDENCIAS.md`); fundir os dois catálogos acoplaria dois módulos que a arquitetura mantém separados de propósito |
| **Decisão** | **MANTER INTENCIONALMENTE — com guarda automatizada.** A duplicação estrutural (dois catálogos, formatos diferentes) fica; o risco de divergência silenciosa já está coberto por `S154` (falha o teste se uma entrada nova em `KNOWN_DEPS` não tiver contrapartida em `TOOLS_TO_PROBE`/exceção documentada). Isso é o próprio critério do Teste 2 funcionando — a alternativa (fonte única) teria custo de acoplamento maior que o problema. |

### D-04 — "Posso entregar isto cru?" (`DIRECT_DELIVERABLE_TOOLS`)

| Campo | Valor |
|---|---|
| Arquivo A | `src/core/ToolRegistry.ts` — `DIRECT_DELIVERABLE_TOOLS`, consultado por `AgentLoop` |
| Arquivo B | `src/loop/GoalExecutionLoop.ts` — `buildResult()`, que não consultava a mesma lista |
| Trecho/regra duplicada | Quais ferramentas produzem saída que pode ir direto ao usuário sem resumo do LLM |
| Tipo de duplicação | Regra de negócio compartilhada, consultada só de um lado |
| Fonte autoritativa atual | `ToolRegistry.DIRECT_DELIVERABLE_TOOLS`, agora também consultado por `GoalExecutionLoop` |
| Evidência de divergência | Goal real `goal_1786759205879_fmpwq` (14/08/2026): dump de diagnóstico de `web_navigate` entregue ao usuário como se fosse resposta final |
| Risco de divergência | Confirmado, já materializado |
| Teste 0 | Conhecimento (contrato de entrega) |
| Teste 1 | Sinal presente: divergência já observada + comportamento compartilhado |
| Contra-teste de acoplamento | Passa — `GoalExecutionLoop` já depende de `ToolRegistry` por outros motivos; não é acoplamento novo |
| **Decisão** | **EXTRAIR — concluído em 14/08/2026.** |

### D-05 — Regex de comando destrutivo

| Campo | Valor |
|---|---|
| Arquivo A | `src/core/server_config.ts` — `isDestructive()` (fonte real de bloqueio) |
| Arquivo B | `src/core/AuthorizationManager.ts` — cópia só para compor o texto do aviso ao usuário |
| Trecho/regra duplicada | Padrões regex de comando perigoso (`rm -rf`, `format`, `shutdown` etc.) |
| Tipo de duplicação | Regra de segurança compartilhada |
| Fonte autoritativa atual | `src/shared/destructiveCommandPatterns.ts` |
| Evidência de divergência | A cópia sem word-boundary casava `"format"` dentro de `"informação"`/`"informativo"` — falso positivo no texto do aviso |
| Risco de divergência | Confirmado; impacto ficou restrito ao texto do aviso, nunca abriu brecha de bloqueio (a fonte real em `server_config.ts` nunca teve o bug) |
| Teste 0 | Conhecimento (regra de segurança — maior prioridade de correção da doutrina) |
| Teste 1 | Sinal presente: divergência já observada + regra de segurança compartilhada |
| Contra-teste de acoplamento | Passa — módulo-folha `shared/destructiveCommandPatterns.ts`, ambos os consumidores importam, nenhum importa o outro |
| **Decisão** | **EXTRAIR — concluído.** Consolidado em `destructiveCommandPatterns.ts`. |

### D-06 — Prefixo `$` duplicado em `crypto_analysis`

| Campo | Valor |
|---|---|
| Arquivo A | `detail()` (2 ocorrências) |
| Arquivo B | `analiseSangrando()` |
| Trecho/regra duplicada | Formatação de valores monetários com prefixo `$` |
| Tipo de duplicação | Formatação — mas com regra de composição compartilhada (quem já prefixa vs. quem prefixa de novo) |
| Fonte autoritativa atual | Consolidado dentro do próprio arquivo, ponto único de prefixação |
| Evidência de divergência | Goal real `goal_1786759359533_um60t` (14/08/2026): resposta mostrou `Market Cap: $$1.26T` |
| Risco de divergência | Confirmado, já materializado |
| Teste 0 | Fronteira — parece implementação (formatação), mas o Teste 1 revelou que era regra de composição compartilhada (quem formata primeiro) |
| Teste 1 | Sinal presente: divergência já observada |
| Contra-teste de acoplamento | Passa — mudança interna ao mesmo arquivo, sem import novo |
| **Decisão** | **EXTRAIR — concluído.** Coberto por `S232_CryptoAnalysis_NoDuplicateDollarSign.test.ts`. |

### D-07 — Lógica de request OpenAI-compatible *(reclassificado em 25/08/2026 — investigação direcionada concluída, ver Parte 5)*

| Campo | Valor |
|---|---|
| Arquivo A | `src/core/OpenAIProvider.ts` |
| Arquivo B | `src/core/DeepSeekProvider.ts` e `src/core/GroqProvider.ts` |
| Trecho/regra duplicada | Parsing de resposta, tratamento de erro HTTP, interpretação de streaming, **conversão de mensagens com imagem para o formato multimodal** — os três consomem uma API compatível com o formato OpenAI |
| Tipo de duplicação | Regra de negócio compartilhada (não implementação trivial) |
| Fonte autoritativa atual | `OpenAIProvider` já serve como classe-base real para um 4º provider do mesmo formato: `OpenRouterProvider extends OpenAIProvider` (`OpenAIProvider.ts:281-290`), herdando `chat()` inteiro sem reescrevê-lo |
| Evidência de divergência | **Encontrada nesta investigação, ainda não incidentada em produção**: `OpenAIProvider.toOpenAIContent()`/`sniffImageMime()` convertem `LLMMessage.images` (base64) para o formato multimodal `image_url` que a API exige — sem isso, imagem é silenciosamente ignorada e o modelo "inventa" o que vê (bug real documentado, `S192`, corrigido 04/08/2026). `DeepSeekProvider.chat()`/`GroqProvider.chat()` fazem `JSON.stringify({model, messages, tools})` com `messages` cru — **sem essa conversão**. `visionProfile.provider` (`agentMediaHandlers.ts:369-371`) é livremente configurável pelo operador via `ModelProfileRegistry`; nada no código impede escolher `deepseek` ou `groq` como provedor de visão (a Groq já expõe modelos `llama-3.2-*-vision` no catálogo OpenAI-Compatible). Se isso acontecer, é a MESMA classe de bug do S192, silenciosamente reintroduzida em dois arquivos que nunca a tiveram corrigida |
| Risco de divergência | Alto, e concreto — não é "pode divergir algum dia", é "a correção de um bug real (S192) não se propagou aos dois arquivos irmãos porque nunca houve uma fonte única" |
| Teste 0 | Conhecimento (regra de negócio: como interpretar a resposta de um provider, incluindo multimodal) |
| Teste 1 | Sinal presente e reforçado: regra de negócio compartilhada **+ divergência já observada** (o bug já existe, replicado, mesmo sem ter dado erro nestes dois arquivos especificamente ainda — mesmo padrão de evidência que elevou D-08) |
| Contra-teste de acoplamento | **Favorável.** `OpenRouterProvider` já prova, no próprio arquivo, que um 4º provider OpenAI-Compatible pode herdar de `OpenAIProvider` sem reescrever `chat()` e sem quebrar nada — não é uma abstração nova e arriscada, é o mesmo padrão já em produção, aplicado a mais dois candidatos com a mesma forma (baseUrl fixo, API OpenAI-Compatible). Diferenças reais que a migração precisaria preservar (Seção 6): mensagem de erro (`DeepSeek API error: ${status}` vs. formato mais rico com corpo da resposta do `OpenAIProvider`), ausência atual do probe de liveness/`CONNECT_TIMEOUT_MS` (inofensivo para APIs de nuvem confiáveis — o mecanismo foi desenhado para servidor local lento, não para timeout de rede), e a proteção SSRF (inerte para os dois, já que `baseUrl` é fixo, não escolhido pelo usuário — mas também não prejudica nada mantê-la) |
| **Decisão** | **EXTRAIR (recomendado) — reclassificado de `INVESTIGAR` para `EXTRAIR` nesta investigação direcionada.** A pergunta que faltava responder ("existe evidência de risco real, e o contra-teste de acoplamento é favorável?") tem agora duas respostas concretas: sim, e sim — via o mesmo padrão que `OpenRouterProvider` já usa. Ainda **não implementado nesta etapa** (sem alteração de código). |

### D-08 — `getProviderWithModel()` sem fallback fora do `ObserverValidator` *(caso novo, não listado na Seção 5 original; investigação direcionada concluída em 25/08/2026, ver Parte 5)*

| Campo | Valor |
|---|---|
| Arquivo A (já corrigido) | `src/loop/ObserverValidator.ts` — `validate()`/`validateGrounding()`, migrado para `chatWithFallback()` nesta mesma campanha |
| Arquivo B, C, D (ainda no anti-padrão) | `src/loop/RiskAnalyzer.ts:500`, `src/shared/contentStubClassifier.ts:66`, `src/loop/StepSemanticValidator.ts:234` — todos chamam `providerFactory.getProviderWithModel(<model>)` sem `providerName`, sem fallback |
| Trecho/regra duplicada | "Como chamar o provider certo com resiliência" — `getProviderWithModel()` sem `providerName` explícito sempre cai em `this.defaultProvider` (comentário em `ProviderFactory.ts:151` já documenta isso), ignorando o modelo dedicado configurado (`RISK_MODEL`, `CLASSIFIER_MODEL`, `VALIDATOR_MODEL`) sempre que o provider padrão do usuário mudar, e sem nenhum fallback se essa única chamada falhar |
| Tipo de duplicação | Anti-padrão de resiliência repetido — não é duplicação textual entre A e B, é o MESMO padrão de chamada replicado em 4 pontos independentes, 1 já corrigido |
| Fonte autoritativa atual | `ProviderFactory.chatWithFallback()` **já existe e já é usada** por `GoalPlanner` (S222), `ObserverValidator` (S258, corrigido nesta campanha) — os outros 3 não a usam ainda |
| Evidência de divergência | Direta, no MESMO mecanismo: incidente real de entrega de clima (16:11/17:45/19:12) causado exatamente por este padrão em `ObserverValidator` — resolvido em `validate()`/`validateGrounding()` nesta campanha, mas os 3 arquivos abaixo ainda carregam o padrão idêntico, cada um com um comentário próprio já reconhecendo o risco ("provedor ativo — via `getProviderWithModel()` sem modelo. Um nome de modelo de NUVEM como padrão...") sem correção |
| Risco de divergência | Alto — é o mesmo mecanismo que já falhou, ainda ativo em 3 lugares. Verificado via busca em log (sessão anterior desta campanha): nenhum dos 3 call sites específicos tinha disparado falha observável no dia investigado — por isso não foi corrigido junto com `ObserverValidator`, seguindo a regra do projeto de não corrigir sem evidência de falha atual naquele ponto específico |
| Teste 0 | Conhecimento (política de resiliência de chamada a LLM, regra de negócio, não helper) |
| Teste 1 | Sinal presente, forte: "risco concreto de divergência" (as 4 cópias evoluem independente) + "representação do mesmo conhecimento" (como chamar um provider com segurança) — mais forte que D-07 porque já existe prova de que o padrão falha, só não nestes 3 pontos específicos ainda |
| Contra-teste de acoplamento | Passa — migrar para `chatWithFallback()` não é criar módulo novo nem acoplar dois módulos-irmãos; é trocar uma chamada direta por uma chamada à fonte autoritativa que **já existe e já é usada em 2 lugares** (linha 6 da tabela de ação do revisor: "Fonte autoritativa já existe → Fazer consumidores reutilizarem essa fonte") |
| **Decisão** | **EXTRAIR (recomendado) — mas registrado como recomendação, não corrigido nesta etapa.** É o caso com risco mais concreto dos dois ainda não corrigidos: a fonte autoritativa já existe, o padrão já provou que falha, e a única razão para não ter sido corrigido junto com `ObserverValidator` foi a ausência de evidência de disparo NESTES 3 pontos específicos no dia investigado — não ausência de risco. Fica marcado para decisão do usuário, não corrigido automaticamente aqui. |

**Prova de preservação de contrato** (pergunta específica levantada na revisão: *"os três consumidores restantes realmente representam o mesmo conhecimento que `chatWithFallback`, e a migração preservaria seus contratos atuais sem criar acoplamento pior?"*) — respondida por leitura direta dos três arquivos:

| Consumidor | Modelo (env var, hoje default `''`) | Timeout hoje | Contrato de falha hoje (try/catch em volta da 1 chamada) | Preservável com `chatWithFallback`? |
|---|---|---|---|---|
| `RiskAnalyzer.callRiskLLM` | `RISK_MODEL` | `timeoutMs` recebido por parâmetro | `catch` → `{status:'timeout'\|'error', content:''}` | Sim — troca `catch(err)` por `if (result.status !== 'success')`, mesmo shape aplicado em `ObserverValidator` (S258) |
| `contentStubClassifier.makeContentStubClassifier` | `CONTENT_STUB_CLASSIFIER_MODEL` | `providerFactory.getBudgetAuxiliar('classificacao')` (adaptativo — mesmo helper que `ObserverValidator` usa) | Fail-**closed** explícito: qualquer erro/timeout/JSON inválido → `isStub:true` (documentado no cabeçalho do arquivo: "falso positivo é aceitável; falso negativo não é") | Sim — a política fail-closed vive no `catch`/branch do CONSUMIDOR, não dentro do provider; `chatWithFallback` só muda COMO a falha chega (`status` em vez de exceção), nunca decide a política |
| `StepSemanticValidator.llmValidate` | `SEMANTIC_VALIDATOR_MODEL` | `TIMEOUT_MS = 8_000` fixo (não usa `getBudgetAuxiliar` — diferença preexistente entre os 3, não introduzida por esta migração) | Fail-**soft**: erro → `{result:'unverifiable', confidence:0.5, ...}` (estado intermediário tratado à parte pelo chamador, não é nem sucesso nem bloqueio) | Sim — mesmo raciocínio: a política de "unverifiable" fica no consumidor |

Ponto de atenção real para a migração (não um bloqueio, mas precisa ser deliberado, não acidental): `chatWithFallback` tenta MÚLTIPLOS providers com até 1 retry cada e backoff de ~10-13s entre tentativas — um perfil de latência de pior caso bem maior que "uma chamada, um timeout fixo, falha". Isso já foi resolvido no precedente `ObserverValidator`/S258 passando o mesmo `timeoutMs` (ou orçamento adaptativo) que hoje delimita a chamada única — `chatWithFallback` respeita esse teto por tentativa, então o caminho feliz (primeiro provider responde) não muda de latência; só o caminho de falha passa a tentar mais alternativas antes de desistir, que é o comportamento desejado, não um efeito colateral.

**Contra-teste de acoplamento, refeito para D-08 especificamente**: migrar não introduz NENHUMA dependência nova — os três arquivos já seguram uma referência a `providerFactory: ProviderFactory` (é dela que vem `getProviderWithModel` hoje) e `chatWithFallback` é outro método público do MESMO objeto. Nenhum import novo, nenhum acoplamento novo — mais limpo que o contra-teste de D-07 (que envolve herança entre classes).

---

## Parte 2 — Já consolidados preventivamente (sem incidente, extração já feita)

Não requerem decisão — listados para registro de que já passaram pelo mesmo critério (Seção 3,
"Extração preventiva") antes de qualquer bug. Nenhuma ação pendente.

| Caso | Fonte autoritativa | Motivo (Teste 1) |
|---|---|---|
| Catálogo de provedores/labels | `CLOUD_PROVIDERS`/`PROV_LABELS`/`LOCAL_PROVIDER_LABEL` (`ModelosView.js:64-81`), recebido por referência em `ConfigWizard.js` | Conhecimento óbvio compartilhado (qual provider existe) antes de qualquer divergência |
| Regex de intenção de análise | `src/shared/analysisIntentPattern.ts` | Antes duplicado 2× dentro de `AgentLoop.ts`, ausente em `ObserverValidator.ts` |
| Padrões de erro transitório | `src/shared/transientErrorPatterns.ts` (ARCH-014) | Regra de retry compartilhada entre chamadores |
| Callback de aprovação de ação perigosa | `AgentController.createWorkflowCallback()` | Antes 4× quase idêntico por canal (Telegram/Discord/WhatsApp/Signal) |
| Tamanho mínimo de entregável | `src/loop/planning/artifactContract.ts` (`MIN_DELIVERABLE_SIZE`) | Contrato compartilhado entre validação e entrega |
| Descoberta de modelos locais | `OllamaProvider.discoverModels()` | Ponto único de verdade sobre quais modelos o Ollama expõe |

---

## Parte 3 — Fora de escopo deste inventário (categoria adjacente, não duplicação de conhecimento)

| Caso | Por que não entra | Decisão |
|---|---|---|
| `ClassificationMemory.hash()` / `UnifiedIntentRouter.hashInput()` | Mesmo defeito (CodeQL loop-bound-injection) replicado nas duas cópias — não é divergência ENTRE cópias, é o mesmo bug multiplicado. Coberto por `S134_BoundedHash_LoopBoundInjection.test.ts` | FORA DO ESCOPO |
| Limpeza de propostas duplicadas (`SkillLearner.ts`) | Duplicação de dados em banco, não de lógica/código | FORA DO ESCOPO |
| Paridade de chaves i18n (`S147_DashboardI18n_KeyParity.test.ts`) | Paridade de tradução, não duplicação de comportamento — já é preventiva por natureza (teste trava a lacuna antes de virar bug visível) | FORA DO ESCOPO |
| Prefixo duplo de sessão (`S189_ConversationIdentity_NoDoublePrefix.test.ts`) | Cliente e servidor reimplementando o mesmo CONTRATO de forma incompatível, não duas cópias do mesmo código-fonte | FORA DO ESCOPO |

---

## Parte 4 — Síntese e priorização

Seguindo a ordem de prioridade sugerida (duplicação que já causou bug > alto risco concreto sem
correção > trivial > abstração pioraria acoplamento):

1. **Já causou bug, já corrigido**: D-01, D-02, D-04, D-05, D-06 — nenhuma ação pendente.
2. **Alto risco concreto, ainda sem correção** — candidatos reais a próxima ação, ambos agora com
   evidência de divergência real e contra-teste de acoplamento favorável (atualizado em 25/08/2026,
   ver Parte 5):
   - **D-08** (`getProviderWithModel()` sem fallback em `RiskAnalyzer`/`contentStubClassifier`/
     `StepSemanticValidator`) — mesmo mecanismo já provado defeituoso (incidente real via
     `ObserverValidator`), fonte autoritativa (`chatWithFallback`) já existe e já é usada em 2
     lugares, contra-teste de acoplamento é o mais limpo dos dois (zero import novo). `EXTRAIR`.
   - **D-07** (OpenAI-compatible providers) — investigação direcionada encontrou o MESMO bug já
     corrigido em `OpenAIProvider` (S192, conversão de imagem para formato multimodal) ainda
     ausente em `DeepSeekProvider`/`GroqProvider`, e um precedente de extração já em produção
     (`OpenRouterProvider extends OpenAIProvider`). `EXTRAIR`.
3. **Estrutural, mantida por decisão deliberada, risco mitigado por outro mecanismo**: D-03
   (catálogos de dependências — guarda de paridade automatizada substitui fonte única).
4. **Abstração pioraria acoplamento**: nenhum caso encontrado nesta rodada se encaixa aqui —
   todos os casos com sinal do Teste 1 presente passaram no contra-teste de acoplamento, nenhum
   foi reprovado.

**Nenhum código foi alterado nas etapas de inventário e investigação direcionada** (Parte 5) — só
depois delas, com aprovação explícita do usuário para implementar, D-08 e D-07 foram de fato
codificados, testados e validados; ver Parte 6.

## Parte 5 — Investigação direcionada D-07 + D-08 (conclusão consolidada, 25/08/2026)

Executada em lote, sem parada de confirmação entre os dois casos, conforme pedido. Nenhum código
foi alterado; só leitura de `OpenAIProvider.ts`, `DeepSeekProvider.ts`, `GroqProvider.ts`,
`ProviderFactory.ts` (D-07) e `RiskAnalyzer.ts`, `contentStubClassifier.ts`,
`StepSemanticValidator.ts` (D-08).

**D-07** — a pergunta pendente era "existe divergência real, e o contra-teste de acoplamento é
favorável?". As duas vieram positivas: `DeepSeekProvider`/`GroqProvider` carecem da conversão de
imagem que corrigiu o bug real `S192` em `OpenAIProvider` (risco silencioso, já que
`visionProfile.provider` é livremente configurável pelo operador), e `OpenRouterProvider extends
OpenAIProvider` já prova, em produção, que herdar `chat()` inteiro de `OpenAIProvider` funciona
para um provider de baseUrl fixo do mesmo formato. Reclassificado de `INVESTIGAR` para `EXTRAIR`.

**D-08** — a pergunta pendente era "os três consumidores restantes representam o mesmo
conhecimento que `chatWithFallback`, preservando contrato, sem acoplamento pior?". Confirmado por
leitura direta: os três já isolam sua própria política de falha (fail-error simples em
`RiskAnalyzer`, fail-closed explícito em `contentStubClassifier`, fail-soft/"unverifiable" em
`StepSemanticValidator`) num `catch` em volta de UMA chamada — migrar para `chatWithFallback` só
troca COMO a falha chega (`status` em vez de exceção), nunca decide a política, exatamente o
padrão já aplicado em `ObserverValidator` (S258). Contra-teste de acoplamento: nenhuma dependência
nova — os três já seguram `providerFactory`, `chatWithFallback` é outro método do mesmo objeto.
Mantido em `EXTRAIR`, agora com a prova de preservação de contrato que faltava.

**Diferença entre os dois**: D-08 tem o caso mais forte e mais barato de implementar (troca de
método numa referência já existente, zero import novo); D-07 exige uma decisão de herança entre
classes (ainda de baixo risco, dado o precedente `OpenRouterProvider`, mas uma mudança estrutural
maior que D-08). Nenhum dos dois foi implementado nesta rodada da investigação — a implementação
efetiva, aprovada explicitamente pelo usuário na sequência D-08 → testes → regressão → D-07 →
testes → regressão → QA → auditoria → Security → diff review, está registrada na Parte 6.

## Parte 6 — Implementação (25/08/2026)

Executada como uma única campanha, sem parada de confirmação entre D-08 e D-07, na ordem pedida.

**D-08** — `RiskAnalyzer.callRiskLLM`, `contentStubClassifier.makeContentStubClassifier` e
`StepSemanticValidator.llmValidate` migraram de `getProviderWithModel().chat()` para
`providerFactory.chatWithFallback(...)`, passando o modelo configurado como `modelOverride`, sem
`preferredProvider` — mesmo shape que `ObserverValidator` (S258). A política de falha de cada
consumidor continua decidida localmente (troca de `catch(err)` por
`if (result.status !== 'success')`, nunca uma decisão do `ProviderFactory`). Teste novo dedicado:
`S262_ProviderResilience_D08_FallbackChainConsumers.test.ts` (19 asserções — estrutural + prova de
que cada política de falha local sobrevive). Testes existentes que mockavam `getProviderWithModel`
para estes 3 consumidores foram atualizados para mockar `chatWithFallback` (S12, S27, S77, S85,
S111, S115, S119, S126) — em 3 deles (S85, S115, S119) o mesmo `chatWithFallback` agora atende
tanto `StepSemanticValidator` quanto `ObserverValidator` (goal completion) no mesmo teste, e o mock
passou a distinguir pelo conteúdo do prompt qual dos dois está perguntando, em vez de responder
sempre a mesma coisa.

*Ponto de atenção mantido, não corrigido — decisão consciente*: `RiskAnalyzer.callRiskLLM` roda no
caminho de revisão do plano, antes de CADA execução — mais crítico em termos de posição no fluxo
que `ObserverValidator` (roda uma vez, ao final). O trade-off latência-pior-caso-maior por
resiliência-maior (linha 166 acima) já é aceito nos dois precedentes existentes (`ObserverValidator`
S258, `GoalPlanner` S222); manter `RiskAnalyzer` consistente com eles — em vez de lhe dar um
comportamento de fallback mais restrito só por rodar num ponto mais cedo do fluxo — evita uma
quarta variação do mesmo mecanismo, que é exatamente o problema que este documento existe para
prevenir.

**D-07** — `DeepSeekProvider`/`GroqProvider` passaram a `extends OpenAIProvider` (mesmo padrão de
`OpenRouterProvider`), herdando `chat()`/`discoverModels()` inteiros. Teste novo dedicado:
`S263_OpenAICompatibleProviders_D07_SharedHierarchy.test.ts` (21 asserções — `instanceof`,
ausência de `fetch()`/`chat()` próprios, imagem chegando no formato multimodal para os dois
providers, endpoint/modelo-default/name/label preservados, formato de erro mais rico e
documentado como mudança intencional).

**Validação progressiva completa** (`docs/DIRETRIZ_ARQUITETURA_2026-07-13.md`):
1. Unitário/estrutural: 40 asserções novas (S262+S263), 100% verde isoladamente.
2. Regressão completa: `npm run test:regression` → 261/261 (259 pré-existentes + 2 novos),
   `tsc --noEmit` limpo, após D-08 e novamente após D-07.
3. Ambiente real (instância isolada, `.claude/skills/verify`, Ollama real, sem mocks): dois goals
   reais dirigidos via HTTP disparam `ContentStubClassifier` (2x) e `StepSemanticValidator` (2x)
   pelo `chatWithFallback` migrado, ambos com resultado correto e o goal completando com sucesso —
   confirma que a migração funciona contra o provider real, não só contra os dublês dos testes.
   `RiskAnalyzer` não disparou LLM review nos dois goals usados (não é toda execução que aciona
   essa revisão) — coberto pelos regression tests dedicados (S262, S12, S27, S111) em vez de
   forçar um terceiro goal artificial só para exercitá-lo ao vivo.
4. Revisão de segurança (escopo manual nos 5 arquivos alterados, dado que o diff completo da
   árvore de trabalho inclui mudanças de sessões/campanhas anteriores já revisadas à parte):
   nenhum achado com confiança ≥80% de vulnerabilidade NOVA introduzida por este diff. Nota
   registrada, não uma vulnerabilidade: `chatWithFallback` pode rotear os 3 consumidores para um
   provider de fallback sem anunciar a substituição — mas é o MESMO mecanismo, com a mesma
   ausência de anúncio, que `ObserverValidator` (S258) e `GoalPlanner` (S222) já usam; consistente
   com o precedente, não uma superfície nova.
5. Revisão de código (`/code-review high`, escopo nos arquivos desta campanha): 3 achados —
   (a) este documento ainda dizia "não implementado" depois da implementação — corrigido nesta
   mesma edição; (b) latência pior-caso do `RiskAnalyzer` — tratado acima, decisão consciente de
   manter consistência com os precedentes; (c) o wrapper "chamar chatWithFallback → checar status
   → extrair JSON → aplicar política de falha" está repetido de forma quase idêntica em 4 pontos
   agora (`ObserverValidator`, `RiskAnalyzer`, `contentStubClassifier`, `StepSemanticValidator`) —
   registrado como **D-09** abaixo, não corrigido nesta campanha (fora do escopo aprovado; a regra
   "não corrigir duplicidade simplesmente porque ela existe" se aplica aqui tanto quanto se aplicou
   aos 6 casos originais).

### D-09 — wrapper de chamada a `chatWithFallback` repetido em N consumidores *(investigação em lote concluída, 25/08/2026 — sem código alterado)*

Achado inicial pela revisão de código da implementação D-07/D-08 (25/08/2026), aprofundado por
investigação em lote dedicada no mesmo dia — mapeamento completo, não amostragem.

**Mapeamento completo — são 8 pontos de chamada em 6 arquivos, não 4:**

| Consumidor | Model override | Timeout | Extração de JSON | Política de falha |
|---|---|---|---|---|
| `GoalPlanner.callPlannerLLM` | `this.model` | parâmetro | nenhuma — devolve `content` cru | `{status, content}` cru |
| `ObserverValidator.validate` | `observerModel` | adaptativo (`'validacao'`) | **parser robusto** (`extractApprovedJson`) — contagem de chaves, tolera aninhamento/aspas | `approved:false` |
| `ObserverValidator.validateGrounding` | `observerModel` | adaptativo | fence-strip + `.match(/\{[\s\S]*\}/)` | `UNVALIDATED` (nunca aprova) |
| `RiskAnalyzer.callRiskLLM` | `this.model` | parâmetro | nenhuma — devolve `content` cru | `{status:'timeout'\|'error'}` |
| `contentStubClassifier` | `CLASSIFIER_MODEL` | adaptativo (`'classificacao'`) | fence-strip + regex simples | `isStub:true` (fail-closed) |
| `StepSemanticValidator.llmValidate` | `VALIDATOR_MODEL` | fixo 8000ms | fence-strip + regex simples | `unverifiable` (fail-soft) |
| `GoalExecutionLoop.composeDeliverySummaryAfterFriction` | nenhum | fixo 30000ms | nenhuma — texto puro | `undefined` silencioso |
| `GoalExecutionLoop.validateGoalCompletion` | nenhum | fixo 45000ms | fence-strip + `JSON.parse` direto (nem regex) | `achieved:false` explícito |

**Teste 0**: chamar+checar status é implementação (forma correta de usar um método já existente,
não regra de negócio); a política de falha É regra de negócio, e já está corretamente
descentralizada por consumidor (Evidence Provider Pattern). A extração de JSON fica no meio —
segue para o Teste 1.

**Teste 1 — sinal concreto, não hipotético, encontrado nesta investigação**: `ObserverValidator.validate()`
precisou de um parser por contagem de chaves (`extractApprovedJson`) porque o regex simples
quebrava com objeto aninhado ou aspas dentro de `"reason"` (motivo documentado no próprio código).
Esse fix real **nunca se propagou** para os outros 4 pontos que ainda fazem parsing — incluindo
`validateGrounding()`, método **irmão na MESMA classe** que `validate()`. `validateGoalCompletion`
usa uma terceira variante, ainda mais frágil (nem regex — `JSON.parse` direto sobre o texto após
tirar as cercas de markdown). Três níveis de robustez diferentes para o mesmo problema, uma
correção real que não chegou aos demais — divergência já observada, não risco abstrato.

**Contra-teste de acoplamento, duas perguntas separadas**:
- *Wrapper inteiro* (chamada + status + parse + política, como a campanha original propôs):
  reprovado. Os 5 eixos que variam (model override, timeout, provider preferido, parsing, política
  de falha) variam por razão arquitetural legítima — cada consumidor decide sua própria política de
  falha, que é exatamente o que o Evidence Provider Pattern exige. Forçar um wrapper único acoplaria
  consumidores que devem evoluir de forma independente — mesmo risco que a "Guarda contra abstração
  prematura" (Seção 3) adverte.
- *Só a extração de JSON* (fence-strip + parser tolerante a aninhamento/aspas): passa. É uma
  função-folha pura (`texto → objeto | null`), sem estado, sem decidir política — os pontos que hoje
  fazem parsing importariam um módulo novo, nenhum importando o outro.

**Decisões:**

| Alvo | Decisão |
|---|---|
| Wrapper completo (chamada+status+parse+política) | **MANTER INTENCIONALMENTE** — não criar um `chatWithFallbackAndParseAndHandleError()` ou equivalente só pra eliminar repetição; a variação entre os 8 pontos é correta, não acidental. |
| Extração de JSON de resposta de LLM (fence-strip + parser tolerante) | **EXTRAIR (recomendado), escopo estreito** — evidência de divergência real já observada (não hipotética), contra-teste de acoplamento favorável (função-folha pura). **Não implementado nesta etapa** — fica registrado como correção futura caracterizada, fora do escopo da campanha seguinte (Security/CORS+`.env`), pra não misturar investigações. |

## Relação com outros documentos

- `docs/ARCHITECTURE/QUANDO_EXTRAIR_DUPLICACAO.md` — doutrina normativa; este inventário é a
  aplicação prática dela, não uma segunda fonte de critério. A Seção 5 daquele documento mantém o
  resumo original (6 casos); este documento é a versão expandida e classificada, com D-07 e D-08
  adicionados.
- `docs/issues/024-arch-numbering-two-colliding-series.md` — achado durante a mesma campanha,
  registrado à parte de propósito (fora do escopo de duplicação de código).
