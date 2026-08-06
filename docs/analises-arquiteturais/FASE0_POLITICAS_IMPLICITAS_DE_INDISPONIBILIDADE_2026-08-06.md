# Fase 0 — Levantamento das políticas implícitas de indisponibilidade

**Data:** 2026-08-06
**Objetivo:** mapear todos os pontos onde o NewClaw toma uma decisão automática diante da
indisponibilidade de um recurso, e classificar cada decisão, antes de escrever qualquer RFC.

**Origem:** requisito operacional formulado pelo operador — *"o NewClaw deve continuar plenamente
utilizável mesmo sem conexão com a Internet, desde que o usuário tenha escolhido modelos locais
para as funções que deseja utilizar"* — e o princípio candidato que dele decorre, **Soberania da
Configuração do Usuário**: o sistema nunca deve alterar silenciosamente a estratégia de execução
escolhida pelo usuário.

**Método:** varredura de `src/**` por caminhos de fallback, cadeias de provedores, `catch` que
continuam com um recurso alternativo e substituições automáticas de argumento/ferramenta. Cada
achado é classificado em uma de quatro categorias:

| Categoria | Significado |
|---|---|
| **A — Decisão de arquitetura** | Deliberada, documentada em ADR/RFC, com justificativa registrada |
| **H — Heurística de implementação** | Deliberada no código, sem documento normativo que a sustente |
| **L — Comportamento legado** | Existia antes de a questão ser formulada; ninguém decidiu manter |
| **X — Comportamento acidental** | Efeito colateral não pretendido por ninguém |

**Critério de aceitação de qualquer proposta futura**, formulado pelo operador:
*"Se a Internet cair agora, o usuário ainda consegue trabalhar da forma que configurou?"*

---

## 1. Modelos de linguagem — cadeia de provedores

| Ponto | Comportamento | Classe |
|---|---|---|
| `ProviderFactory.chatWithFallback` | Percorre `getFallbackOrder(preferred)` até alguém responder. A cadeia não distingue provedor **local** de **nuvem**, nem "escolha do usuário" de "substituto aceitável" | **H** |
| `CircuitBreaker` sobre provedor local | Trata "não respondeu" como avaria e abre o circuito. Um llamafile desligado acumula falhas como se estivesse quebrado | **X** |
| `getProviderWithModel` (`ADR-002`) | Provedor custom desconhecido caía no `OllamaProvider` final — corrigido; hoje há `case` explícito | **A** (já corrigido) |
| Modelo por categoria ausente (`issue 019`) | Deixou de escolher um modelo de nuvem por conta própria; passa a usar o que o provedor serve | **A** (já corrigido) |
| `resolveProfile` → `?? chat ?? profiles[0]` | Perfil ausente cai em outro perfil silenciosamente | **L** |

**Evidência de execução real (05/08/2026, produção):** o turno pediu `GLM-4.7-Flash` (local); o
llamafile não respondeu; o circuito abriu com `5/5 failures`; a resposta veio de `glm-5.2:cloud`.
O usuário recebeu resposta de nuvem tendo configurado modelo local, sem nenhum aviso. **Com a
Internet caída, esse mesmo caminho não degrada — ele falha por timeout.**

## 2. Busca na web — o caso que prova que isto não é sobre o llamafile

| Ponto | Comportamento | Classe |
|---|---|---|
| `web_search.searXNG` | Tenta `http://localhost:8888/search` e, se falhar, **`https://searx.be/search`** — um servidor público de terceiros | **X** |
| `web_search` (4 provedores) | `Promise.allSettled` sobre DuckDuckGo, Google e SearXNG; agrega o que responder | **H** |

O caso do SearXNG é o mais grave do levantamento e não tem nada a ver com modelos: o usuário sobe
uma instância local justamente para que suas buscas não saiam da máquina, e o sistema, ao encontrá-la
fora do ar, **envia a mesma consulta para um servidor público na Internet** — sem avisar. É a mesma
regra violada, noutro domínio, com implicação de privacidade em vez de disponibilidade.

## 3. Transcrição de voz (STT)

| Ponto | Comportamento | Classe |
|---|---|---|
| `transcribeAttachment` | API remota (`WHISPER_API_URL`, depois `WHISPER_API_FALLBACK`) e, esgotadas, `whisper` local | **H** |
| Endereço padrão embutido | Corrigido em 05/08: ausência de configuração passou a significar "transcrever localmente" | **A** (já corrigido) |

Aqui a cadeia vai de nuvem/rede **para** local — direção oposta à do caso 1, e a única do
levantamento que degrada na direção certa quando a Internet cai.

## 4. Síntese de voz (TTS)

| Ponto | Comportamento | Classe |
|---|---|---|
| `send_audio.generateAudio` | Piper (offline) → `node-edge-tts` (WebSocket Microsoft) → CLI Python `edge-tts` | **A** |

Documentado em `docs/Auditorias/2026-07-26/LIMITACAO_EDGE_TTS_PYTHON_2026-07-26.md`, com regra
explícita: Piper só é tentado se o operador baixou os modelos — *"presença dos arquivos É o sinal
de intenção"*. É o **melhor exemplo já existente no projeto** do princípio sendo respeitado sem
que ninguém o tivesse nomeado: a intenção do usuário é lida de um sinal explícito, e a ordem da
cadeia privilegia o offline.

## 5. Ferramentas e comandos

| Ponto | Comportamento | Classe |
|---|---|---|
| `ProactiveRecovery` — `argMutators` | Reescreve argumentos do LLM para contornar erro semântico | **H** |
| `ProactiveRecovery` — `fallbackTools` | Troca a ferramenta por outra da cadeia declarada (ex.: `web_navigate` → `web_search`) | **H** |
| `exec_command` — `AUTO-FIX` | Reescreve o comando antes de executar: `wrap_powershell`, `add_marp_no_stdin`, `remove_pandoc_no_stdin`, `remap_foreign_workspace_paths` | **H** |
| `remap_foreign_workspace_paths` | Roda **sem log**, por decisão explícita de não introduzir uma linha nova | **L** |

Estes substituem decisões do **LLM**, não do usuário — fronteira diferente, mas a mesma família:
um componente determinístico alterando silenciosamente o que outra camada decidiu. O
`remap_foreign_workspace_paths` é o único que faz isso sem deixar rastro.

## 6. Dependências opcionais de build

| Ponto | Comportamento | Classe |
|---|---|---|
| `CognitiveKernelGate` → `newclaw-kernel-adapter` | Pacote não publicado (`file:../newclaw-kernel-adapter`) importado estaticamente; ausência quebrava `npm run build` | **X** (corrigido 06/08) |

Achado durante este levantamento, por um incidente real: `newclaw update` falhou numa segunda
máquina do operador com `TS2307: Cannot find module 'newclaw-kernel-adapter'`. O caminho relativo
só resolve onde os dois repositórios são irmãos — em qualquer clone do repositório público, não.

**É o caso mais instrutivo do levantamento inteiro**, porque a degradação graciosa já estava
escrita. O cabeçalho do arquivo prometia: *"qualquer exceção (Kernel quebrado, dependência
ausente) sempre cai em `{action:'proceed'}` — o Kernel nunca pode travar um Goal real por estar
indisponível"*, com circuit breaker e kill-switch implementados. Mas o `import` era estático: a
falha ocorre em tempo de compilação, onde nenhum `try/catch` de runtime existe ainda. **A proteção
era real, correta e inalcançável.**

Lição para a RFC-005: declarar a intenção de degradar não basta; é preciso verificar que o
mecanismo de degradação é alcançável no momento em que a indisponibilidade acontece. Um recurso
que falta em tempo de build precisa de tratamento em tempo de build.

Note também que `npm install` **não** reportou erro nessa máquina ("added 2 packages... found 0
vulnerabilities") — a falha só apareceu no `tsc`. O silêncio do instalador é a mesma classe de
problema que a RFC-004 tratou na ingestão: a ausência não foi comunicada a ninguém.

## 7. Classificação e roteamento

| Ponto | Comportamento | Classe |
|---|---|---|
| `UnifiedIntentRouter` / `DomainRegistry` | Classificação por LLM falha → cai para keyword scoring | **H** |
| `ModelProfileRegistry.resolveTextProfile` | Perfil `vision` substituído por `chat` em turno sem imagem | **A** (06/08, `S202`) |

A segunda linha é **minha própria correção de ontem**, e ela pertence a este levantamento por
honestidade: é uma substituição automática de configuração do usuário. A justificativa é que o
critério é objetivo e verificável — o turno não envia `images:[base64]`, então o perfil de visão
não tem função ali. Mas é precisamente o tipo de decisão que este levantamento existe para tornar
explícita em vez de deixar implícita no código.

---

## Conclusão do levantamento

**A hipótese do operador se confirma.** Os casos não compartilham só um padrão de implementação;
compartilham a mesma regra violada, em cinco domínios independentes: modelos de linguagem, busca
na web, transcrição, ferramentas e dependências de build. Uma RFC que tratasse apenas o fallback de
modelos deixaria de fora os dois achados mais graves — o SearXNG local caindo para um servidor
público e o pacote opcional derrubando o build de toda instalação que não a do autor.

Quatro observações que devem moldar a RFC-005:

1. **O projeto já acertou uma vez, sem nomear a regra.** A cadeia de TTS lê a intenção do usuário
   de um sinal explícito (modelos Piper presentes) e privilegia o offline. Ela é o modelo a
   generalizar, não um caso a corrigir.
2. **Duas fronteiras distintas convivem.** Substituir configuração do **usuário** (casos 1, 2, 3)
   é diferente de substituir decisão do **LLM** (caso 5). A RFC precisa dizer se a regra vale para
   as duas ou apenas para a primeira — a segunda já tem tratamento próprio no Evidence Provider
   Pattern e na Preservação do Raciocínio.
3. **A maioria é heurística (H), não arquitetura (A).** Dos catorze pontos levantados, quatro são
   decisões documentadas — e três desses quatro foram corrigidos nas últimas duas semanas, quando
   a questão apareceu isoladamente. O resto nunca foi decidido: apenas implementado.
4. **Declarar a intenção de degradar não basta.** O caso do `newclaw-kernel-adapter` mostra uma
   proteção correta, documentada e implementada que nunca podia ser executada, porque a
   indisponibilidade acontecia numa fase anterior àquela em que a proteção vivia. A RFC precisa
   exigir que o mecanismo de degradação seja alcançável no momento da falha — não apenas existir.

## Pergunta em aberto para a RFC-005

O documento de origem sugere oferecer "iniciar modelo local" como opção ao usuário, e ao mesmo
tempo afirma que o sistema não deve iniciar o llamafile automaticamente porque "GPU é um recurso do
usuário". A leitura provável é que a distinção esteja entre **iniciar sob pedido explícito** e
**iniciar por conta própria** — mas isso precisa ser confirmado antes de virar requisito, porque
define se o NewClaw pode ou não gerenciar o ciclo de vida do processo do llamafile.
