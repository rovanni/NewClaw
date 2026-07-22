# Análise Arquitetural — Redesign da Página de Modelos (Model Registry & Discovery)

> Processo seguido conforme `docs/DIRETRIZ_ARQUITETURA_2026-07-13.md` — o pedido introduz um novo
> serviço central (`ModelRegistryService`) e muda como Dashboard, `ProviderFactory` e
> `ModelProfileRegistry` se comunicam, portanto está sujeito às 5 fases obrigatórias.
>
> Origem: pedido de Sprint registrado em `C:\Users\lucia\Downloads\log_conversa_newclaw.txt`
> (22/07/2026) — redesign completo da página Config → Modelos.

## Contexto

O pedido descreve um redesign completo da página Config → Modelos: Provider Overview, Model
Registry (catálogo pesquisável com cards), Model Router (matriz visual) e Health & Capabilities,
com discovery automático (`GET /v1/models` para OpenAI-Compatible, `GET /api/tags` para Ollama),
detecção de capacidades, validação de compatibilidade e recomendação automática quando um modelo
configurado desaparece — tudo atrás de um `ModelRegistryService` dedicado. Motivação declarada:
hoje a página é baseada em selects estáticos, sem descoberta de modelos reais, sem validação de
capacidades e sem feedback quando um modelo configurado deixa de existir no provider.

Esta é apenas a etapa de análise — nenhum código de implementação foi escrito nesta rodada
(decisão do usuário). O objetivo é decidir *o quê* construir e *como*, antes de codificar.

---

## Fase 1 — Compreensão

**O que já existe hoje** (lido diretamente do código, não por suposição):

| Peça | Arquivo | O que faz |
|---|---|---|
| Fábrica de providers | `src/core/ProviderFactory.ts` | Mapa fixo de 6 providers (gemini, deepseek, groq, openrouter, anthropic, ollama), troca dinâmica, fallback com circuit breaker (`circuitRegistry`, `CircuitBreaker.ts`) |
| Contratos | `src/core/providerTypes.ts` | `ILLMProvider { name, chat(), setModel() }` — **sem** método de listagem/descoberta de modelos |
| Provider genérico OpenAI | `src/core/OpenAIProvider.ts` | Já aceita `baseUrl` customizada no construtor (linha 13); `OpenRouterProvider` só especializa a URL. Reutilizável para LM Studio/vLLM/OpenAI oficial/custom sem nova classe |
| Roteamento por categoria | `src/loop/ModelProfileRegistry.ts` | Mapeia `category → ModelProfile` (chat/code/vision/light/analysis/execution), resolução determinística + LLM fallback. **Cego** a se o modelo realmente existe no provider |
| Rota de providers | `src/dashboard/routes/providers.ts` | `GET /api/providers` já faz discovery ad hoc — **só para Ollama** (`/api/tags`, linha 16) — mais uma lista hardcoded de `knownCloudModels` (linha 25) |
| Persistência de config | `src/dashboard/routes/config.ts` (`persistConfigToEnv`) | Escreve tudo em `.env`; já tem `customModels`, overrides de provider por categoria, e 3 modelos internos (`plannerModel`/`riskModel`/`observerModel` — usados por GoalPlanner/RiskAnalyzer/ObserverValidator) |
| UI — Providers | `src/dashboard/public/config/views/ProvidersView.js` | Cards de API key por provider, único health check real é Ollama (`testOllama()`) |
| UI — Modelos | `src/dashboard/public/config/views/ModelosView.js` | **Já implementa boa parte do "Model Router" pedido**: pipeline visual (linha 51-87), matriz categoria→modelo com dropdown (linha 89-102), override de provider por categoria (linha 165-179), painel de diagnóstico de roteamento ao vivo (linha 201-212, alimentado pelo evento `newclaw-routing-decision`), e `updateModelStatus()` (linha 439) já pinta um "dot" local/cloud/**ausente** por modelo configurado |
| Estado reativo | `state.js` / `app.js` | `providersStore` (pub/sub) hoje só guarda `{models, ollamaOnline, ollamaModelCount}`, populado 1x por `loadProviders()` |

**Git log**: nenhuma tentativa anterior idêntica a "ModelRegistryService"/discovery unificado — o
que existe é evolução orgânica em commits anteriores (`d701c30` model profile registry,
`86f983d`/`87ffdca` provider management + ModelosView, `9c36897` Anthropic). Não há RFC ou item
ARCH-xxx passado sobre isso nas memórias do projeto.

**Achado importante — a premissa do pedido está desatualizada**: o log descreve a tela atual como
"apenas alguns selects". Isso não é mais verdade — `ModelosView.js` já tem pipeline visual,
diagnóstico de roteamento ao vivo e indicador de modelo ausente. O que falta de fato é mais
estreito do que o pedido original sugere (ver Fase 4).

**Não existe em lugar nenhum do código**: metadados de capacidade por modelo (vision/tool-calling/
context window) — confirmado por grep (`capabilit|supportsVision|toolCalling` → 0 resultados
relevantes; `CapabilityRegistry.ts`/`CapabilityProbe.ts` existentes são sobre capacidades de
ambiente/ferramentas do sistema — whisper, python, ffmpeg — **não relacionado**, não reaproveitável
aqui, e o nome não deve colidir).

---

## Fase 2 — Crítica da hipótese

1. **Risco de God Object**: o diagrama original embute Discovery + Adapters + Cache + Health +
   Capability Detection + Compatibility Validation + Recommendation Engine + Catalog numa única
   caixa `ModelRegistryService`. Se virar uma classe só, é exatamente o "God Object" que a diretriz
   do projeto veta. Precedente correto já existe no próprio código: `ProviderFactory` **não** embute
   circuit breaking — delega para `CircuitBreaker`/`circuitRegistry` como colaborador externo
   (`ProviderFactory.ts:32,162-168`). O novo serviço deve seguir o mesmo padrão: fachada fina +
   adapters pequenos, não uma classe de centenas de linhas.

2. **Fonte de verdade duplicada**: hoje "quais modelos existem" já é resolvido de 3 formas
   independentes e incompletas — (a) `routes/providers.ts` faz fetch inline só de Ollama, (b)
   `ModelosView.js` mistura `ollamaModels + knownCloudModels + userModels + customModels` no
   frontend, (c) `ModelProfileRegistry` nunca consulta nada, aceita qualquer string. Adicionar um
   catálogo novo **sem aposentar essas três** só cria uma quarta fonte de verdade — pior, não melhor.

3. **Explosão de adapters**: o diagrama original pede 5 adapters nomeados (OpenAI Compatible, LM
   Studio, Ollama, OpenAI, vLLM) — só Ollama tem protocolo realmente diferente (`/api/tags`,
   `/api/generate`). LM Studio, vLLM, OpenAI oficial e qualquer endpoint "custom" implementam o
   mesmo `GET /v1/models` + `POST /v1/chat/completions`. Construir 4 classes quase idênticas viola
   o próprio requisito do pedido de "evitar duplicação de lógica".

4. **Raio de impacto em produção**: `ProvidersView.js` e `ModelosView.js` estão fiadas em
   `persistConfigToEnv` (grava `.env` direto em disco) e em 3 modelos internos que
   GoalPlanner/RiskAnalyzer/ObserverValidator usam de verdade em produção (VPS via PM2). Esse
   pipeline de config já teve bugs sutis antes (env var vazia mascarada por `??` vs `||`). Um
   rewrite "big bang" das duas páginas de uma vez é um risco desnecessário — fatiar reduz o raio de
   explosão de cada entrega.

5. **"Capability detection automática" é uma promessa maior do que os dados disponíveis
   sustentam**: a maioria dos servidores (`/api/tags`, `/v1/models`) não devolve capacidades — só
   nome/tamanho de contexto quando muito. Prometer detecção automática completa nesta fase seria
   construir sobre hipótese não verificada.

---

## Fase 3 — Pesquisa de alternativas

- **A. Colocar discovery dentro do `ModelProfileRegistry`.** Rejeitada — mistura uma
  responsabilidade de hot-path síncrono (resolver categoria→perfil a cada mensagem) com I/O de rede
  para N providers remotos (lento, cacheável, com falhas de rede próprias). Violação de
  responsabilidade única.
- **B. Manter tudo dentro da rota Express, só adicionar mais `if (provider === 'x')`.** Rejeitada —
  é o que já existe hoje em miniatura (`routes/providers.ts`) e não escala: fica preso à camada
  HTTP, inacessível para `ModelProfileRegistry` ou qualquer lógica do Core decidir com base em
  modelos reais disponíveis.
- **C. `ModelRegistryService` dedicado em `src/core/`, peer do `ProviderFactory` (não dentro dele),
  composto por adapters pequenos injetados.** **Recomendada.** Seguindo o padrão já usado no
  projeto (injeção de colaborador, visto em `ModelProfileRegistry` recebendo `ProviderFactory` no
  construtor — `ModelProfileRegistry.ts:98`).
- **Sobre adapters**: em vez de 1 classe por nome de produto, **1 adapter genérico
  `OpenAICompatibleProvider`** (evolução do `OpenAIProvider.ts` existente) parametrizado por
  `baseUrl`/`label`, com presets no dashboard (OpenAI, LM Studio local, vLLM local) mas aceitando
  qualquer URL custom. Ollama continua com adapter dedicado (protocolo realmente diferente).
- **Sobre capability detection**: em vez de "detecção automática" (não sustentada pelos dados
  disponíveis), começar com heurística declarada — mapa estático de padrões de nome (`*-vl`,
  `llava`, `gemma3`, etc. → `vision`) documentado como heurística, não como fato garantido — e
  evoluir com feedback real de uso, não como promessa de dia 1.

---

## Fase 4 — Síntese (recomendação)

Decisão confirmada com o usuário: **fatiar a implementação** (uma primeira fatia + roadmap
documentado), **adapter único genérico** para OpenAI-Compatible/LM Studio/vLLM/OpenAI, e
**unificar `ProvidersView.js` + `ModelosView.js`** numa página só "Modelos".

### Fatia 1 (primeira entrega de código, sessão futura de implementação)
1. `src/core/ModelRegistryService.ts` — fachada fina: `discoverAll()`, `getCatalog()`, cache TTL
   simples (Map + timestamp, sem nova abstração de cache).
2. Adapter Ollama: mover o fetch de `/api/tags` que hoje está duplicado entre `OllamaProvider` (uso
   interno) e `routes/providers.ts:16` (inline) para um único método `discoverModels()` em
   `OllamaProvider`.
3. `src/core/OpenAICompatibleProvider.ts` — evolução de `OpenAIProvider.ts`, com
   `discoverModels()` batendo em `GET {baseUrl}/models`. Cobre OpenAI oficial, LM Studio, vLLM,
   custom.
4. `routes/providers.ts` (ou uma nova `routes/models.ts`) passa a delegar para o serviço em vez de
   ter lógica de discovery inline.
5. Config: `NewClawConfig`/`persistConfigToEnv` ganha `customProviders: {label, baseUrl, apiKey}[]`,
   análogo ao `customModels` já existente (`config.ts:36`) — aditivo, sem quebrar schema.
6. UI: página "Modelos" única — Provider Overview (generalizando `ProvidersView.js` para N
   providers, não só Ollama) + Model Registry (cards com busca/filtro, substituindo os inputs de
   texto livre) + Model Router (o que já existe em `ModelosView.js`, agora filtrando dropdowns por
   capability) + Health básico (reaproveita `providersStore`/dot pattern já existente).

### Roadmap (ver `docs/issues/014-model-registry-roadmap-fatias-2-4.md`)
- Recommendation engine para modelo removido.
- Health avançado (latência/memória).
- Capability auto-detection além da heurística por nome.

---

## Fase 5 — Validação

- **Baseada em evidência real?** Sim — código lido diretamente (arquivos acima) + `git log`
  conferido; nenhuma tentativa anterior encontrada para reaproveitar ou evitar repetir.
- **Resolve problema estrutural ou só sintoma?** Estrutural — hoje "quais modelos existem" é
  respondido de 3 formas incompletas e divergentes; a Fatia 1 consolida em uma fonte, **desde que
  os 3 pontos de duplicação da Fase 2 sejam de fato substituídos, não somados**.
- **Reduz complexidade total?** Sim, condicionado ao ponto acima.
- **Elimina múltiplas fontes de verdade?** Sim.
- **Mantém a filosofia do Cognitive Kernel?** Sim — vive em `src/core`, é consumido por Dashboard e
  por `ModelProfileRegistry` via injeção; nenhum `ChannelAdapter` precisa saber que isso existe.
- **Pode ser implementada incrementalmente?** Sim — Fatia 1 é standalone e reversível (rota nova,
  classes novas, sem mudar comportamento de runtime dos providers existentes).
- **Pode ser revertida facilmente?** Sim na Fatia 1. Risco cresce nas fatias futuras que tocarem o
  fluxo de persistência de config (`persistConfigToEnv`) — motivo a mais para não fazer tudo de uma
  vez.
- **Hipóteses ainda não comprovadas** (registrar, não esconder): (a) heurística de capability por
  nome de modelo é "boa o suficiente" sem validação com uso real; (b) instâncias reais de LM
  Studio/vLLM do usuário expõem `/v1/models` sem particularidade de auth — só testável rodando
  contra uma instância real (Etapa 4 da Validação Progressiva) quando disponível.

---

## Próximos passos

1. Abrir uma sessão de implementação para a Fatia 1 quando o usuário decidir priorizá-la.
2. Seguir a Validação Progressiva completa (unitário → regressão → e2e mockado → ambiente real, via
   skill `verify`) antes de considerar a Fatia 1 pronta para merge.
