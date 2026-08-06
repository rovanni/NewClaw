# Fase 0 — Levantamento das políticas implícitas de indisponibilidade

**Status:** **encerrada** em 06/08/2026. As quatro perguntas do critério final foram respondidas e
o trabalho seguiu para `docs/decisoes/RFC-005_POLITICAS_DE_SUBSTITUICAO_DE_RECURSOS.md` — ver
"Encerramento", ao final deste documento. Nada aqui foi revisado retroativamente: o levantamento
permanece como foi escrito, inclusive onde a RFC-005 chegou a conclusão diferente.

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

## Princípio candidato — Localidade da Recuperação

Formulado pelo operador ao ver o incidente do `newclaw-kernel-adapter`:

> **As políticas de recuperação devem ser implementadas na mesma camada em que a falha pode
> ocorrer.**

| Tipo de falha | Camada que deve tratá-la |
|---|---|
| Dependência ausente (import) | resolução de módulos / composição |
| Provider indisponível | `ProviderFactory` / Circuit Breaker |
| Modelo recusou a requisição | camada do provider |
| Ferramenta retornou erro | executor da ferramenta |
| Prompt inválido | Planner |

O objetivo é evitar recuperações **corretas porém inalcançáveis** — exatamente o que o
`CognitiveKernelGate` era.

### Teste do princípio contra os casos levantados

Um princípio só é útil se separar casos. Aplicado aos catorze pontos deste levantamento, ele
classifica assim:

| Caso | Camada da falha | Camada do tratamento | Veredito |
|---|---|---|---|
| `newclaw-kernel-adapter` | resolução de módulo (build) | runtime (`try/catch`) | ❌ violava — corrigido |
| Circuit breaker sobre provider local | transporte/provider | `CircuitBreaker` | ✅ camada certa |
| `chatWithFallback` | provider | `ProviderFactory` | ✅ camada certa |
| Whisper remoto → local | handler de mídia | mesmo handler | ✅ camada certa |
| TTS Piper → edge-tts | geração de áudio | `send_audio` | ✅ camada certa |
| `ProactiveRecovery` (args/tools) | execução de ferramenta | executor | ✅ camada certa |
| `exec_command` AUTO-FIX | execução de comando | executor | ✅ camada certa |
| Classificação LLM → keyword | classificador | classificador | ✅ camada certa |
| `resolveProfile ?? chat ?? [0]` | configuração de perfil | registry | ✅ camada certa |
| **`searXNG` local → público** | serviço de busca | método de busca | ⚠️ ver abaixo |

**O princípio isola exatamente um caso: o do `searXNG`.** E o que ele revela ali é instrutivo — a
camada está *certa* e o comportamento continua *errado*. Tratar "instância local fora do ar" dentro
do método de busca é apropriado; o que não pertence àquela camada é a decisão de **enviar a consulta
do usuário para um terceiro**. Isso não é recuperação técnica, é política de privacidade.

### O que o teste revelou: são dois eixos, não um

O princípio da Localidade responde **onde** a recuperação deve morar. O da Soberania responde
**quem** tem autoridade para decidir o que fazer. São perguntas independentes, e um caso pode
acertar uma e errar a outra:

| | Camada certa | Camada errada |
|---|---|---|
| **Autoridade certa** | Whisper, TTS, ProactiveRecovery | — |
| **Autoridade errada** | `searXNG`, fallback local→nuvem | `newclaw-kernel-adapter` (errava as duas) |

Essa separação é o resultado mais útil da Fase 0 para a RFC-005: ela impede que a RFC trate os
casos como se fossem todos do mesmo tipo. Um fallback pode estar no lugar certo e ainda assim
usurpar uma decisão do usuário; e uma decisão pode ser legítima e estar num lugar onde nunca será
executada.

### Convergência dos princípios existentes

Os três princípios já consolidados e este candidato são ortogonais, mas apontam para o mesmo
objetivo — **comportamento previsível, explícito e verificável**, com menos decisão implícita:

| Princípio | Pergunta que responde | Origem |
|---|---|---|
| Ingestão produz fatos, não decisões | *o que* uma camada pode decidir | `RFC-004` |
| Ferramentas de entrega devolvem conteúdo | *o que* a resposta deve conter | `RFC-004` |
| Soberania da Configuração do Usuário | *quem* decide | `ADR-002`, issue 019, este levantamento |
| Localidade da Recuperação | *onde* a recuperação vive | incidente do adapter, 06/08 |

Nenhum deles é sobre "tratar erro melhor". Todos são sobre reduzir a quantidade de coisas que o
sistema decide sozinho e não conta a ninguém — que é a mesma classe de defeito que a `RFC-004`
encontrou na ingestão de mídia, replicada em outras camadas.

## Achado — a capacidade de ciclo de vida do runtime existe, na camada errada

A pergunta original ("o NewClaw pode iniciar o llamafile?") foi reformulada pelo operador para uma
forma arquitetural: **o gerenciamento do ciclo de vida do runtime é responsabilidade do Core, ou é
uma capacidade oferecida por um Runtime Adapter?** A investigação mostrou que a resposta de facto
hoje não é nenhuma das duas.

**Esta investigação não escolhe entre elas.** "Runtime Adapter" aparece aqui como uma das
alternativas da pergunta, não como solução preferida — nenhuma das duas foi avaliada, comparada ou
adotada. O que está confirmado é apenas o achado descrito abaixo: a capacidade existe, no Dashboard,
e não é alcançável pelas camadas que precisam dela. Decidir onde ela deveria viver é trabalho da
RFC-005.

**A capacidade não está ausente — está implementada e validada.** `src/dashboard/routes/models.ts`
já faz, com cobertura do `S171`:

* `spawn` do servidor local (desacoplado, `detached` + `unref`);
* `kill` sob pedido explícito;
* estado persistido em `data/local-model-server.json`;
* reencontro de um servidor sobrevivente após restart do NewClaw (confere PID **e** porta viva);
* validação do modelo pedido contra a listagem real da pasta configurada.

O problema não é funcional; é de localização. A capacidade pertence ao domínio de **Runtime**, mas
está acoplada ao **Dashboard** — uma camada de apresentação. Verificado por `grep`: nenhum arquivo
de `src/core/` ou `src/loop/` a consome, e não poderia consumi-la sem inverter a arquitetura de
canais que `docs/ARCHITECTURE.md` protege. O único consumidor externo é outra rota do próprio
Dashboard (`routes/providers.ts`).

### Consequência observada

`ProviderFactory`/`CircuitBreaker` não conseguem distinguir:

* **runtime desligado pelo usuário** — estado normal, esperado, reversível com um clique;
* **runtime realmente avariado** — falha que justifica abrir o circuito.

Por isso tratam ambos como falha e acumulam erros indevidamente (observado em produção:
`CIRCUIT-OPEN: Skipping 'Modelo local' (failures: 72)` e, num único turno, `Circuit CLOSED → OPEN —
5/5 failures`). A informação necessária para a distinção **existe** — o Dashboard sabe qual modelo
foi escolhido, em que porta, e se o processo responde — mas está fora do alcance de quem precisa
dela.

É o princípio da Localidade da Recuperação lido ao contrário: aqui não é a recuperação que está na
camada errada, é o **diagnóstico**. A falha ocorre na camada do provider; o que permite entendê-la
mora na camada de apresentação.

### As políticas já estão decididas — e não são o que falta

`ADR-002` fixou o comportamento, e essas decisões independem de onde o código mora:

* **§2.2** o servidor roda desacoplado do processo do NewClaw (nasceu de um incidente real: o
  "Salvar & Reiniciar" da própria interface matava o modelo junto);
* **§2.3** o NewClaw nunca religa o modelo sozinho — *"um servidor de modelo local ocupa a placa de
  vídeo; quem reiniciou o computador pode estar querendo usá-la para outra coisa. Religar
  automaticamente não seria apenas inconveniente, seria errado"*;
* **§2.4** o registro do modelo escolhido só é apagado por decisão explícita.

Isso responde à pergunta que estava em aberto neste documento sobre "iniciar sob pedido versus
iniciar por conta própria": **§2.3 já decidiu, com argumento registrado.** O que falta não é
política — é a capacidade ser alcançável por quem precisa dela.

### Status desta investigação

Registrada como **achado**, não como proposta. Nesta rodada, deliberadamente:

* não se propõe implementação;
* não se move código;
* não se abre RFC.

O que fica registrado é que a investigação identificou **uma capacidade existente, madura e
testada, porém localizada numa camada inadequada para reutilização**.

### Padrão recorrente no projeto

O NewClaw já apresentou esse padrão anteriormente: uma capacidade nasce próxima do seu primeiro
consumidor e, quando passa a servir múltiplos consumidores, torna-se candidata a um serviço
compartilhado de domínio.

* `ToolRegistry.requiresAuthorization()` — o gate de ação perigosa existia no caminho do
  `AgentLoop`; quando `GoalExecutionLoop` passou a executar `exec_command` por conta própria, em
  modo SAFE, executava sem gate nenhum (reproduzido ao vivo em 04/08/2026). A capacidade virou
  ponto único de decisão consumido pelos dois caminhos — `ADR-005`.
* `ModelProfileRegistry.resolveTextProfile()` — a regra "turno sem imagem não usa perfil de visão"
  seria natural no chamador; foi colocada no registry justamente para valer para qualquer
  consumidor futuro que envie apenas texto (`S202`, 06/08/2026).

O ciclo de vida do runtime apresenta a mesma configuração inicial dessa classe: hoje tem um
consumidor (o Dashboard) e já se sabe de um segundo que precisa dele e não pode alcançá-lo
(`ProviderFactory`). Registrar a semelhança de padrão não é escolher o desfecho — nos dois
precedentes a capacidade virou serviço de domínio, mas isso foi decidido caso a caso, com ADR
própria no caso do gate de autorização.

## Pergunta que estava em aberto — respondida durante a investigação

Este documento registrava uma dúvida: o material de origem sugeria oferecer "iniciar modelo local"
como opção ao usuário e, ao mesmo tempo, afirmava que o sistema não deve iniciar o llamafile
automaticamente porque "GPU é um recurso do usuário". A leitura proposta era que a distinção
estivesse entre **iniciar sob pedido explícito** e **iniciar por conta própria**.

**A leitura estava correta, e a decisão já existia**: `ADR-002` §2.3, com argumento registrado.
Nada a decidir aqui — a pergunta era sobre política, e a política estava tomada desde 02/08/2026.
O que a investigação encontrou no lugar foi um problema diferente: a política é boa, está
implementada, e não alcança quem precisa dela (ver "Achado — a capacidade de ciclo de vida do
runtime existe, na camada errada").

---

# Balanço final da Fase 0

Releitura integral de `ADR-002`, `ADR-005`, `RFC-004` e deste documento, para separar o que já foi
decidido do que permanece aberto. **Objetivo: garantir que a RFC-005 trate apenas de lacunas reais,
sem reabrir decisões consolidadas.**

## 1. Decisões já tomadas — não rediscutir

### Ciclo de vida do runtime local (`ADR-002`, 01-02/08/2026)

| § | Decisão | Justificativa registrada |
|---|---|---|
| 2.1 | A pasta de modelos nunca tem valor padrão no código | Projeto OSS multiplataforma; caminho embutido vazaria o ambiente de quem o escreveu |
| 2.2 | O servidor roda desacoplado do processo (`detached` + `unref`) | Incidente real: "Salvar & Reiniciar" da própria interface matava o modelo junto |
| 2.3 | **O NewClaw nunca religa o modelo sozinho** | A GPU é recurso do usuário; religar por conta própria "não seria apenas inconveniente, seria errado" |
| 2.4 | O registro do último modelo só é apagado por decisão explícita | É a única memória de qual modelo o usuário escolheu |
| 2.5 | O cliente informa o nome do modelo; caminho e argumentos são do servidor | A rota executa um binário da máquina |
| 2.6 | A porta é configurável (`LOCAL_SERVER_PORT`) | Duas instâncias na mesma máquina disputavam a mesma porta |
| 2.7 | Escolher um modelo escolhe também o provedor | Falha adiada (404 só no restart seguinte) é pior que falha imediata |

### Gate de ação perigosa (`ADR-005`, 04-05/08/2026)

* `ToolRegistry.requiresAuthorization()` é a **única** resposta para "precisa de autorização
  humana?".
* O gate vive no **executor comum** (`ProactiveRecovery.execute`), não em cada caminho de execução.
  A emenda de 05/08 registra por quê: contar caminhos à mão falhou — a própria ADR contou dois
  quando eram cinco.
* Quem não passa pelo gate antes recebe **recusa**: falha fechada, nunca execução silenciosa.
* Probes determinísticos internos não passam pelo gate — ele existe para tool que o **modelo**
  pediu.

### Princípios normativos consolidados

1. Configuração compartilhada é imutável para quem lê (`RFC-004`, Princípio 1).
2. Pré-processamento de mídia produz fatos, nunca decisões (`RFC-004`, Princípio 2).
3. Ferramentas de entrega devolvem o conteúdo entregue (`FERRAMENTAS_DE_ENTREGA.md`).
4. Turno que envia somente texto não usa o perfil de visão (`S202`).
5. Dependência opcional não pode quebrar o build (`S203`).

### Não-objetivos já declarados (`RFC-004`)

* Não introduzir sistema de tradução no Core — o caminho escolhido é reduzir o texto que o Core
  emite diretamente.
* Não paralelizar inferências de visão — hardware muito variado; trocaria um defeito por outro.
* Não alterar canais que já entregam múltiplos anexos corretamente (Discord, Web).

### Limitações declaradas e deliberadamente preservadas

* `ADR-002`: validado apenas no Windows; um servidor por vez; capacidade do modelo inferida do nome
  do arquivo.
* `ADR-005`: comando cujo caminho contém espaço não é reconhecido como leitura-apenas — o gate
  **erra pedindo autorização a mais, nunca a menos**.

## 2. Questões arquiteturais ainda em aberto

### Sem decisão alguma

1. **Soberania da Configuração do Usuário** — formulada e evidenciada, **ainda candidata**. Não há
   documento normativo; `ADR-002` e a issue 019 são aplicações dela em casos isolados, sem a regra
   geral nomeada.
2. **Localidade da Recuperação** — idem: formulada em 06/08, testada contra os catorze casos deste
   levantamento, ainda candidata.
3. **Taxonomia de indisponibilidade.** O sistema tem um único conceito: falhou. Não existe
   "desligado pelo usuário" como estado de primeira classe. Consequência medida em produção:
   `72 failures` acumuladas tratando estado normal como avaria.
4. **Onde deve viver a capacidade de ciclo de vida do runtime.** Permanece aberta. O que esta
   investigação acrescentou é apenas que hoje ela vive no Dashboard e não é alcançável por
   `ProviderFactory`/`CircuitBreaker` — nenhuma alternativa foi escolhida.
5. **Modo de Operação (Online / Offline / Híbrido).** Conceito proposto pelo operador; nada
   decidido. Hoje a configuração diz *qual modelo por perfil*, mas não *o que fazer quando ele não
   estiver disponível* — não existe forma de expressar "não troque".
6. **`searXNG` local → servidor público.** Nenhuma decisão existe. Único caso do levantamento em que
   a camada está certa e o comportamento continua errado; implicação é privacidade, não
   disponibilidade.
7. **A regra alcança também a substituição de decisões do LLM?** `ProactiveRecovery` reescreve
   argumentos e troca ferramentas; `exec_command` reescreve comandos. É fronteira distinta da
   configuração do usuário, já coberta por Evidence Provider Pattern e Preservação do Raciocínio.

### Decisões parciais que deixaram lacuna

8. **O que fazer quando o runtime escolhido está parado.** `ADR-002` §2.3 decidiu o que **não**
   fazer (religar sozinho); não decidiu o que fazer no lugar. Comportamento atual: fallback
   silencioso para nuvem.
9. **`resolveProfile ?? chat ?? profiles[0]`** — perfil ausente cai em outro sem aviso.
   Classificado como legado (L); nunca foi objeto de decisão.
10. **`remap_foreign_workspace_paths`** roda sem log, por decisão explícita de não acrescentar uma
    linha nova. É a única substituição do sistema que não deixa rastro.

## 3. Débitos conhecidos — fora do escopo da RFC-005

Registrados aqui para que **não** sejam absorvidos por proximidade temática. Só entram no escopo se
surgir evidência de dependência arquitetural direta:

| Débito | Onde está registrado | Por que fica fora |
|---|---|---|
| **`S158` instável / issue 021** | `docs/issues/021` | Conflito entre a issue 020 (não repetir chamada que falhou) e o ciclo de verificação do `RFC-003` (repetir para confirmar aprendizado). Duas decisões publicadas que se contradizem — exige decisão própria, provavelmente uma ADR, em investigação separada |
| **i18n do texto que o Core emite** | `ARCHITECTURE.md` "Gaps conhecidos"; `ADR-005` §6 | `RFC-004` decidiu não resolver e reduziu o problema removendo sete mensagens fixas do caminho do usuário. O que resta (ACK de fila, validador de objetivos, rótulos de autorização) é trabalho de escopo próprio |
| **Suíte não isola estado entre testes** | `docs/issues/021`, achado secundário | Qualidade da suíte, não arquitetura de indisponibilidade |

# Critério para iniciar a RFC-005

A RFC só deve começar depois de decidirmos:

1. se **Soberania da Configuração do Usuário** vira princípio normativo;
2. se **Localidade da Recuperação** vira princípio normativo;
3. qual **taxonomia** distingue indisponibilidade intencional de falha;
4. qual é o **escopo da política**: apenas modelos/providers, ou recursos substituíveis em geral.

Estes quatro pontos ficam deliberadamente **sem resposta proposta** neste documento. Enquanto não
forem decididos, qualquer RFC nasceria escolhendo implicitamente por eles — que é exatamente a
classe de decisão implícita que esta investigação existiu para tornar visível.

---

# Encerramento

O operador respondeu os quatro pontos em 06/08/2026:

| # | Decisão |
|---|---|
| 1 | Soberania da Configuração do Usuário → **princípio normativo** |
| 2 | Localidade da Recuperação → **princípio normativo** |
| 3 | Taxonomia → **definida dentro da RFC-005**, por ser trabalho de solução, não de investigação |
| 4 | Escopo → **conceitual geral, primeira aplicação prática restrita a providers/modelos** |

A investigação foi encerrada e o trabalho seguiu para
`docs/decisoes/RFC-005_POLITICAS_DE_SUBSTITUICAO_DE_RECURSOS.md`.

## O que a RFC-005 concluiu diferente deste levantamento

Registrado aqui para quem chegar a este documento primeiro:

* **A cadeia de TTS não é integralmente o exemplo a generalizar.** Este documento a apresentou como
  o melhor caso existente do princípio respeitado. Verificando o código, a RFC-005 encontrou que
  `send_audio.ts:199` cai do Piper para o serviço da Microsoft registrando apenas `log.error` — o
  usuário nunca é informado de que o texto saiu da máquina. A cadeia acerta **quem decide** e erra
  **quem fica sabendo**; é essa evidência que fez a Soberania nascer com duas cláusulas.
* **A presença do registro de modelo local não indica que o servidor deveria estar de pé.** Uma
  primeira versão da taxonomia classificaria assim, e a revisão contra `ADR-002` §2.4 mostrou que
  isso recriaria o próprio defeito das `72 failures` — o registro sobrevive à morte do processo por
  ser a única memória da escolha do usuário.

## Questões deste levantamento que a RFC-005 **não** fechou

Permanecem abertas, e não devem ser tratadas como resolvidas por proximidade:

* ~~**#4 — onde vive a capacidade de ciclo de vida do runtime.**~~ **Fechada** em 06/08/2026 por
  `docs/decisoes/ADR-006_ONDE_VIVE_O_CICLO_DE_VIDA_DO_RUNTIME_LOCAL.md`: diagnóstico desce para o
  domínio, atuação permanece fora do Core.
* **#5 — Modo de Operação (Online/Offline/Híbrido).** Descartado como *primitivo* pela RFC-005
  (alternativa A3), não como conveniência futura.
* **#7 — a regra alcança a substituição de decisões do LLM?** Segue aberta; fronteira distinta, já
  coberta por `EVIDENCE_PROVIDER_PATTERN.md` e pela Preservação do Raciocínio.
* Os três débitos da Seção 3 continuam fora de escopo, pelos motivos ali registrados.
