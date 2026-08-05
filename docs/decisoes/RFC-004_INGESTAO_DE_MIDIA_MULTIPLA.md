# RFC-004 — Ingestão de Mídia: Fatos em vez de Decisões no Limiar do Canal

**Status:** Proposta (2026-08-05) — aguardando aprovação. Alinhamento da documentação derivada
(`ARCHITECTURE.md`, `EVIDENCE_PROVIDER_PATTERN.md`) e implementação ficam para etapas seguintes,
deliberadamente separadas desta — ver "Impacto na Documentação Existente" e "Próximos Passos".

**Autor:** Luciano Rovanni do Nascimento

**Tipo:** Arquitetura

**Categoria:** Canais e Ingestão

---

# Resumo

Esta RFC trata de um incidente real e reprodutível: um usuário enviou 12 imagens por um canal e
pediu "Poderia explicar cada projeto?". O sistema analisou 4 imagens, perdeu 3 sem qualquer aviso,
respondeu 9 vezes de forma desconexa, levou 27 minutos e nunca respondeu à pergunta feita.

A investigação encontrou cinco defeitos distintos. Eles não são cinco bugs independentes: são
**duas causas estruturais** e três defeitos locais que só se tornaram visíveis porque as duas
primeiras estavam presentes.

As duas causas estruturais são:

1. **Objeto de configuração compartilhada tratado como valor** — o registro de perfis de modelo
   entrega a referência interna a quem lê, e um chamador a modificou. O perfil de visão deixou de
   existir em memória no meio da sessão, e o sistema ficou permanentemente cego para imagens sem
   emitir um único erro.
2. **O canal decide o que a IA vai ver, e responde no lugar dela** — o pré-processamento de anexos
   interrompe no primeiro anexo bem-sucedido e, em caso de falha, devolve uma mensagem pronta em
   português que encerra o turno antes do Core.

Esta RFC propõe dois princípios normativos que eliminam as duas classes, e aplica-os às cinco
correções.

---

# Motivação

O sintoma relatado pelo usuário foi "ele bugou". A investigação mostrou que essa é uma descrição
precisa: não houve exceção, não houve mensagem de erro, não houve travamento. O sistema continuou
funcionando e respondendo — apenas deixou de enxergar, sem avisar ninguém, e passou a responder
sobre imagens que nunca viu.

Esse é o tipo de falha mais caro que um sistema pode ter: silenciosa, tardia e plausível. Nenhuma
das cinco correções propostas aqui é difícil. O que justifica uma RFC é que corrigir os cinco casos
individualmente deixaria as duas causas intactas, e ambas voltarão a se manifestar em outro ponto,
com outro sintoma.

---

# Definição do Problema

## Causa A — Configuração compartilhada tratada como valor

`ModelProfileRegistry.getProfileByCategory()` é implementado como `this.config.profiles.find(...)`.
`find()` devolve **a referência ao objeto armazenado**, não uma cópia. Qualquer leitor pode,
portanto, reescrever a configuração global do sistema sem passar por nenhuma via de escrita.

Um chamador faz exatamente isso (`AgentLoop`, na etapa de override de modelo pelo roteador de
intenção):

```ts
const chatProfile = await this.profileRegistry.resolveProfile(userText);
if (chatProfile && intentDecision.modelCategory && intentDecision.confidence >= 0.8) {
    const intentProfile = this.profileRegistry.getProfileByCategory(intentDecision.modelCategory);
    if (intentProfile) {
        chatProfile.model    = intentProfile.model;
        chatProfile.category = intentProfile.category;   // ← reescreve o perfil do registro
```

Quando `resolveProfile()` devolve o perfil de **visão** e a intenção classificada é **execution**,
o perfil de visão passa a ter `category = 'execution'`. A partir desse instante,
`getProfileByCategory('vision')` devolve `undefined` — **o perfil de visão deixou de existir**, e
permanece inexistente até o processo ser reiniciado.

A verificação por `grep` em todo `src/**/*.ts` mostra que essas duas linhas são **o único ponto do
projeto** que modifica um perfil obtido do registro. Não é um padrão disseminado; é uma porta aberta
atravessada uma vez.

## Causa B — O canal decide o que a IA vê

`MessageBus.processAttachments()` percorre os anexos, mas interrompe no primeiro que é processado
com sucesso:

```ts
for (const attachment of msg.attachments || []) {
    const handler = this.mediaHandlers.get(attachment.type);
    if (handler) {
        const result = await handler(msg, attachment);
        if (result === null) {
            // Handler processed successfully (e.g., voice transcribed → msg.text set)
            // Continue to text processing pipeline
            return null;            // ← o comentário diz "continue", o código faz "return"
        }
        if (result !== null) return result;
    }
}
```

O histórico explica a origem: `git log -L 622,644:src/channels/MessageBus.ts` aponta o commit
`cef60c7` (*"fix: voice transcription not reaching AgentLoop"*), que **adicionou exatamente essas
cinco linhas**. A intenção documentada no próprio comentário era sair do laço para o pipeline de
texto; o `return` foi o meio escolhido. Para voz funciona — o Telegram entrega um áudio por
mensagem — e o caso de N anexos nunca foi exercido. O `if (result !== null) return result` logo
abaixo já cobria o caminho de erro; o bloco inteiro é redundante além de incorreto.

O segundo aspecto da mesma causa: quando um anexo falha, o handler devolve uma **string pronta para
o usuário** (`"⚠️ Falha ao baixar a imagem do canal telegram."`), que o `MessageBus` envia crua e
encerra o turno. Isso significa que:

* o canal decide que a conversa acabou, sem consultar o Core;
* a mensagem sai **sempre em português**, para qualquer usuário, porque o Core não possui sistema
  de tradução — o único mecanismo de idioma é `buildLanguageDirective(config.language)`, que
  instrui o **LLM** a responder em pt-BR/en-US/es-ES. Texto fixo emitido pelo canal nunca passa
  por esse mecanismo.

Ambos os comportamentos contrariam o que `docs/ARCHITECTURE.md` estabelece — "um canal é apenas uma
porta de entrada/saída — nunca um lugar onde a IA pensa" — e o Princípio da Preservação do
Raciocínio do `CLAUDE.md`.

---

# Evidência

Todas as evidências abaixo vêm de execução real, não de hipótese. Endereços de rede, identificadores
de usuário e caminhos de máquina foram mascarados — este documento é público.

## E1 — O perfil de visão sendo destruído (log de produção, 04/08/2026)

```text
10:29:19  [ModelProfileRegistry] Deterministic profile resolution: vision → <modelo-de-visao>
10:29:19  [UNIFIED-ROUTER] Overriding model: execution → <modelo-de-texto>
          ↑ o objeto do perfil de VISÃO acabou de receber category = "execution"

10:32:47  [VisionHandler] vision_not_configured  Perfil de visão não encontrado no ModelProfileRegistry.
10:33:25  [VisionHandler] vision_not_configured
10:33:50  [VisionHandler] vision_not_configured
10:34:29  [VisionHandler] vision_not_configured
10:35:15  [VisionHandler] vision_not_configured
```

As quatro primeiras imagens foram analisadas normalmente. A partir da quinta, o sistema salvou o
arquivo e respondeu sem nunca ter olhado para a imagem.

## E2 — Contabilidade completa do incidente

| Métrica | Valor |
|---|---|
| Imagens recebidas | 12 |
| Imagens efetivamente analisadas | 4 |
| Imagens salvas mas nunca analisadas | 5 |
| Imagens perdidas sem nenhuma resposta | 3 |
| Respostas enviadas | 9, todas isoladas |
| Tempo total | 27 minutos (10:08 → 10:35) |

As 3 imagens perdidas correspondem a três falhas consecutivas de download
(`telegram_photo_download_failed: fetch failed` / `Network request for 'getFile' failed!`). O
handler de foto tenta **uma única vez**; o handler de áudio, no mesmo arquivo, tenta três vezes com
backoff.

## E3 — Só o primeiro anexo é processado (reprodução em instância isolada, 05/08/2026)

Instância isolada, LLM real, três imagens numa única mensagem:

```text
[VisionHandler] photo_saved   ...imagem-1.jpeg
[VisionHandler] vision_start  Analisando imagem-1.jpeg
(nada para imagem-2, nada para imagem-3)
```

O workspace ao final continha um único arquivo. As outras duas imagens nunca chegaram a nenhum
handler.

## E4 — Mais de cinco anexos derrubam a requisição

Mesma instância, doze imagens, resposta em 45 ms:

```text
HTTP 500
MulterError: Too many files
```

A resposta é uma página HTML de erro. O front executa `res.json()` sobre ela e cai no `catch`,
exibindo uma mensagem sem relação com a causa.

## E5 — Fragmentação de álbum no Telegram

```text
10:08:25  message_received "Poderia explicar cada projeto?"  type=photo
10:08:25  message_received (sem texto)                        type=photo
10:08:25  message_received (sem texto)                        type=photo
          … 12 mensagens no mesmo segundo
```

O adapter trata `message:photo` uma a uma e não observa `media_group_id`. Como o Telegram anexa a
legenda apenas à primeira foto de um álbum, **a pergunta do usuário chegou junto de uma imagem e as
outras onze chegaram sem pergunta nenhuma** — cada uma abrindo seu próprio objetivo, do zero.

## E6 — Endereço de rede privada como padrão de fábrica

A mesma variável possui três valores padrão divergentes no repositório:

| Local | Padrão | Situação |
|---|---|---|
| `agentMediaHandlers.ts` | `http://<endereço-de-rede-privada>:8177` | é o que executa |
| `TelegramAdapter.ts` | `http://localhost:8177` | nunca lido — campo morto |
| `.env.example`, `install.ps1`, `install.sh` | vazio | garante que o padrão do código prevaleça |

Como os instaladores gravam a variável **vazia** e o código usa `process.env.X || '<padrão>'`
(string vazia é *falsy*), **toda instalação nova do NewClaw sai apontando para um endereço de rede
privada específico**. Em uma rede doméstica típica esse endereço é o roteador. O efeito prático é
que o áudio de voz de um usuário qualquer é enviado por POST a um host arbitrário da LAN dele.

Os campos `whisperApiUrl`, `whisperApiFallback`, `whisperPath` e `whisperModel` do
`TelegramAdapter` são declarados e preenchidos, mas **nunca lidos** — resquício de quando a
transcrição vivia dentro do adapter. Um deles, `whisperPath`, tem valor padrão em caminho Unix
absoluto, incompatível com Windows; o caminho vivo, em `agentMediaHandlers`, usa o executável pelo
`PATH`, que funciona nos três sistemas.

O achado já constava de auditoria anterior (`docs/ARCHITECTURE/architecture.json`), classificado
como *"an internal IP baked into public OSS source, borderline violation of the project's own 'no
sensitive data in repo' guidance"*. Permaneceu como observação e nunca virou correção.

---

# Princípios Normativos

## Princípio 1 — Configuração compartilhada é imutável para quem lê

> Todo componente que mantém configuração compartilhada entrega **cópias** a quem lê e concentra a
> escrita em métodos explícitos. Nenhum leitor pode alterar o estado global por efeito colateral.

O registro de perfis passa a devolver cópia defensiva nos métodos de leitura, com tipo de retorno
`Readonly<ModelProfile>` — o que transfere a detecção da violação para o compilador, a custo zero em
tempo de execução. A escrita continua existindo por `setProfile()`, que é a via usada pelo Dashboard.

Este princípio não é específico de perfis de modelo: aplica-se a qualquer registro de configuração
que venha a existir no projeto.

## Princípio 2 — Pré-processamento de mídia produz fatos, nunca decisões

> O pré-processamento de anexos observa **todos** os anexos, registra o que conseguiu e o que não
> conseguiu como **fato textual** na mensagem normalizada, e entrega ao Core. Ele nunca encerra o
> turno, nunca escolhe o que a IA vai ver e nunca redige a resposta ao usuário.

É a aplicação, à camada de ingestão, do mesmo princípio que `EVIDENCE_PROVIDER_PATTERN.md` já
estabelece para componentes de conhecimento: fornecer evidência para o Planner ponderar, em vez de
decidir por ele.

Consequência direta e não acidental: falhas de anexo passam a ser comunicadas **pelo LLM**, que já
obedece à diretiva de idioma. Os três idiomas suportados passam a funcionar nesse caminho sem
nenhuma tabela de tradução nova — e quatro mensagens fixas em português saem do caminho do usuário
em vez de novas serem acrescentadas.

---

# Correções Propostas

## Correção 0 — Nenhum endereço de rede como padrão no código

* Remover o endereço padrão de `WHISPER_API_URL`. Ausência de valor passa a significar "API remota
  não configurada": o código segue direto para o `whisper` local, que já existe como fallback, e
  registra uma linha de log técnico informando a ausência.
* Remover os quatro campos `whisper*` mortos do `TelegramAdapter` — com eles sai também o caminho
  Unix absoluto incompatível com Windows.
* Documentar a variável no `.env.example` com exemplo neutro (`http://localhost:8177`) e explicação
  de que vazio significa transcrição local.

Ambientes que usam uma API remota passam a declará-la no próprio `.env`, que é onde dado de ambiente
pertence e que o `.gitignore` já protege.

## Correção 1 — Cópia defensiva no registro de perfis

Aplicação do Princípio 1. Isoladamente, esta correção já devolve a visão ao sistema.

## Correção 2 — Contrato de ingestão de anexos

Aplicação do Princípio 2:

```text
hoje:      1º anexo bem-sucedido → return (os demais são descartados em silêncio)
           1º anexo com falha    → mensagem pronta em pt-BR, turno encerrado

proposta:  percorre TODOS os anexos
           sucesso → o fato é concatenado à mensagem (comportamento atual dos handlers)
           falha   → o fato da falha é concatenado à mensagem
           sempre  → segue para o Core, que responde no idioma configurado
```

Com limite de sanidade configurável (`MAX_ATTACHMENTS_PER_MESSAGE`), cujo excedente é registrado
como **fato** — "N anexos não processados" — e nunca descartado em silêncio. Precedente existente
no projeto: `CONV_QUEUE_MAX_PENDING`, em `ConversationQueueManager`.

## Correção 3 — Política única de retry no download de anexos

A política de três tentativas com backoff já existe para áudio, no mesmo arquivo em que foto e
documento tentam uma única vez. Extrair a política para um auxiliar interno e usá-la nos três
caminhos. Foi essa assimetria que perdeu três imagens do incidente.

## Correção 4 — Agrupamento de álbum no Telegram

Buffer por `media_group_id` no `TelegramAdapter`, com janela curta, emitindo **uma** mensagem
normalizada com N anexos, preservando o `messageId` da primeira para que a deduplicação continue
válida.

**Por que no adapter, e não no Core:** Discord e Web já entregam N anexos em uma única mensagem. O
Telegram é a única plataforma que fragmenta um álbum em N atualizações. Agrupar é tradução do
formato da plataforma para o idioma comum — exatamente a diferença que `ARCHITECTURE.md` autoriza
ao adapter ("diferenças entre adapters só existem para atender limitações específicas da API de cada
plataforma"). Resolver no `MessageBus` imporia uma janela de coalescência a todos os canais e também
a mensagens de texto, alterando a semântica da conversa inteira para corrigir a peculiaridade de um
canal.

**Depende da Correção 2.** Sem ela, agrupar doze anexos em uma mensagem faria o `MessageBus`
processar um e descartar onze.

## Correção 5 — Limite de anexos único e erro legível no Dashboard

* Limite de arquivos em uma única constante, hoje duplicada entre a rota de upload e a interface.
* `MulterError` traduzido para JSON estruturado (`{ error: 'too_many_files', max: N }`) em vez de
  página HTML de erro.
* Front traduz o código com as chaves de i18n nos três idiomas. Inclui corrigir o alerta de limite
  de anexos da interface, hoje fixo em português dentro de um arquivo que possui sistema de
  tradução — o teste `S147` garante paridade de chaves, mas não detecta texto que nunca virou chave.

---

# Alternativas Descartadas

| Alternativa | Por que foi descartada |
|---|---|
| Clonar o perfil apenas no chamador | Corrige o sintoma e mantém a porta aberta: o próximo `getProfileByCategory(...).model = x` reabre a mesma falha, cujo sintoma aparece vinte minutos depois, sem erro. |
| `Object.freeze` nos perfis | Elimina a classe, mas falha em tempo de execução — silenciosamente em modo não-estrito. `Readonly` + cópia falha em tempo de compilação, que é onde deve falhar. |
| Trocar `return` por `continue` e parar por aí | Processa os doze anexos e mantém intacto o problema maior: o canal continua encerrando o turno e redigindo resposta fixa em um idioma só. |
| Elevar o limite de anexos de 5 para 12 | Escolhe um número novo sem critério, mantém o limite duplicado em dois arquivos e não corrige o que de fato quebra a interface — o erro chegar como HTML. |
| Coalescência genérica de mensagens no `MessageBus` | Imporia janela temporal a todos os canais e a mensagens de texto, alterando a semântica de conversa de todo o sistema para resolver uma peculiaridade do Telegram. |
| Não agrupar álbuns; deixar o agente correlacionar | Mantém doze objetivos independentes, de seis a onze minutos cada, e a pergunta do usuário continua chegando junto de apenas uma das imagens. |
| Paralelizar as chamadas de visão | Reduziria o tempo total, mas o projeto roda em Windows, Linux e Mac com hardware muito variado; disparar N inferências de visão simultâneas em uma máquina modesta troca um defeito por outro. Registrado como medição futura, não como correção. |

## Gate "Extensão antes de Criação"

Nenhuma das correções cria Tool, Skill ou Script novo. Todas são edições de arquivos existentes:
`ModelProfileRegistry.ts`, `AgentLoop.ts`, `MessageBus.ts`, `agentMediaHandlers.ts`,
`TelegramAdapter.ts`, `dashboard/routes/chat.ts`, `dashboard/public/index.html` e
`.env.example`/instaladores. Os únicos arquivos novos são testes de regressão, que são o padrão
obrigatório do repositório.

---

# Portabilidade e Idiomas

**Windows, Linux e Mac.** Nenhuma correção introduz caminho absoluto, separador de diretório
literal, dependência de shell ou binário específico de plataforma. A Correção 0 **remove** o único
caminho Unix absoluto envolvido. A Correção 4 usa apenas temporizador de JavaScript, cujo
comportamento é idêntico nos três sistemas.

**Português, inglês e espanhol.** A Correção 2 retira quatro mensagens fixas em português do caminho
do usuário, substituindo-as por fatos que o LLM verbaliza no idioma configurado. A Correção 5 leva
uma mensagem hoje fixa em português para o sistema de tradução do Dashboard, nos três idiomas. As
Correções 0, 1, 3 e 4 não acrescentam nenhum texto destinado ao usuário — apenas linhas de log
técnico, que não são traduzidas por decisão já vigente no projeto.

---

# Riscos e Hipóteses Não Comprovadas

* **`Readonly<ModelProfile>` pode gerar erros de compilação em chamadores legítimos.** Verificável em
  minutos com `tsc --noEmit`. Se ocorrer, a alternativa é manter a cópia defensiva sem o `Readonly`,
  preservando a proteção em tempo de execução e perdendo apenas a detecção em tempo de compilação.
* **A Correção 2 gasta uma chamada de LLM para comunicar falhas** que hoje são respondidas de graça
  por uma string fixa. É um custo aceitável e deliberado: é o preço de responder no idioma correto e
  de manter a decisão no Core.
* **A Correção 4 introduz estado e janela temporal em um adapter** — a única das seis que faz isso.
  Riscos conhecidos: grupo que nunca é fechado (mitigado por TTL), ordenação dos anexos e interação
  com a deduplicação por `messageId`.
* **Tempo total permanece alto para muitas imagens.** Mesmo com tudo corrigido, doze imagens exigem
  doze inferências de visão sequenciais. O incidente registra de vinte a trinta e cinco segundos por
  imagem. Esta RFC não resolve isso; apenas garante que o resultado seja correto.

---

# Impacto na Documentação Existente

* **`docs/ARCHITECTURE.md`** — a seção "Exceções arquiteturais documentadas" ganha o agrupamento de
  álbum do Telegram como exceção legítima e justificada. A seção "Gaps conhecidos" deve registrar
  que o Core não possui sistema de tradução para texto emitido fora do LLM.
* **`docs/ARCHITECTURE/EVIDENCE_PROVIDER_PATTERN.md`** — o Princípio 2 estende o padrão para a
  camada de ingestão; cabe referência cruzada.
* **`docs/ARCHITECTURE/architecture.json`** — a observação sobre o endereço de rede embutido deixa de
  ser observação e passa a ter correção associada.
* **`.env.example`, `install.ps1`, `install.sh`** — documentação da variável de transcrição.

---

# Validação

Ordem obrigatória, conforme a Validação Progressiva do `CLAUDE.md`:

1. **Testes unitários** das funções isoladas alteradas.
2. **Suíte de regressão completa** (194 testes hoje) antes e depois de cada commit. Testes com maior
   probabilidade de reagir: `S14` e `S29` (entrega de anexos), `S187`/`S188` (autorização no canal
   web), `S192` (imagem chegando ao provedor), `S193`.
3. **Testes novos**, um por correção, no padrão do repositório: perfil não é modificado pelo
   roteador; N anexos resultam em N handlers executados; anexo com falha não encerra o turno; álbum
   do Telegram resulta em uma mensagem normalizada; limite excedido devolve JSON.
4. **Execução em ambiente real**, instância isolada: reenviar exatamente as doze imagens do incidente
   e confirmar que a pergunta original é respondida.

---

# Não Objetivos

* Não é objetivo introduzir sistema de tradução no Core. O caminho escolhido é o oposto — reduzir a
  quantidade de texto que o Core emite diretamente.
* Não é objetivo otimizar o tempo de análise de múltiplas imagens.
* Não é objetivo alterar o comportamento de canais que já entregam múltiplos anexos corretamente
  (Discord, Web).
* Não é objetivo corrigir o débito conhecido de i18n do validador de objetivos, registrado em
  `GoalExecutionLoop`.

---

# Próximos Passos — Sprints

A numeração segue em 010 porque as letras A-G pertencem à RFC-003 e os números 005-009 ao Pipeline
de Curadoria de Dependências.

| # | Sprint | Correção | Depende de | Risco |
|---|---|---|---|---|
| 010 | Alinhamento de documentação dos princípios | — | RFC aprovada | Nulo |
| 011 | Higiene de configuração de rede | 0 | — | Baixo |
| 012 | Integridade do registro de perfis | 1 | — | Baixo |
| 013 | Contrato de ingestão de anexos | 2 | — | Médio |
| 014 | Política única de retry de download | 3 | 013 | Baixo |
| 015 | Dashboard: limite único, erro legível, i18n | 5 | — | Baixo |
| 016 | Agrupamento de álbum no Telegram | 4 | 013 | Alto |
| 017 | Validação end-to-end do incidente | — | todas | — |

As Correções 0, 1, 3 e 5 são pontuais no sentido da diretriz de correções pontuais: mapear o entorno
e alterar. A Correção 2 estabelece um princípio normativo e a Correção 4 introduz estado em um
adapter — ambas dependem da aprovação desta RFC.

## Sprint 010 — Alinhamento de documentação

Somente documentação, nenhum código, conforme o fluxo RFC → alinhamento → implementação. Registra os
dois princípios normativos em `ARCHITECTURE.md` e a referência cruzada em
`EVIDENCE_PROVIDER_PATTERN.md`. A exceção arquitetural do agrupamento de álbum **não** entra aqui —
vai na Sprint 016, junto com o código, para que a documentação nunca descreva algo que ainda não
existe.

## Sprint 011 — Higiene de configuração de rede

Primeira do código por ser a única com implicação de segurança pública e por não tocar no pipeline de
execução. Remove o endereço de rede como valor padrão, apaga os quatro campos `whisper*` mortos do
`TelegramAdapter` — o que leva junto o caminho Unix absoluto — e documenta a variável nos três
instaladores.

**Teste novo `S195`:** varredura de `src/` por endereços de rede privada literais. É guarda
permanente contra a recorrência da classe inteira, não apenas deste caso.

**Critério de conclusão:** boot real sem a variável definida, confirmando que o fluxo cai no whisper
local e registra a ausência em log.

## Sprint 012 — Integridade do registro de perfis

Sprint que devolve a visão ao sistema. Cópia defensiva nos métodos de leitura e tipo de retorno
`Readonly<ModelProfile>`.

**Teste novo `S196`:** reproduz o incidente — resolve o perfil de visão, aplica override de
`execution` e verifica que `getProfileByCategory('vision')` continua existindo.

**Critério de conclusão:** `tsc --noEmit` limpo — é aqui que a hipótese sobre `Readonly` se confirma
ou cai — mais suíte de regressão completa.

## Sprint 013 — Contrato de ingestão de anexos

Núcleo da RFC e maior superfície de alteração: percorrer todos os anexos, transformar falha em fato
textual, nunca encerrar o turno no canal.

**Testes novos:** `S197` (N anexos resultam em N handlers executados), `S198` (anexo com falha não
encerra o turno e o fato entra na mensagem), `S199` (excedente do limite vira fato, não descarte).

**Critério de conclusão:** execução real com três imagens em uma mensagem — as três descritas, uma
única resposta.

## Sprint 014 — Política única de retry

Posterior à 013 deliberadamente: com o contrato novo, o retry esgotado já vira fato em vez de
mensagem fixa. Extrai a política de três tentativas que já existe para áudio e aplica a foto e
documento.

**Teste novo `S200`:** download que falha duas vezes e é bem-sucedido na terceira.

## Sprint 015 — Dashboard

Independente das demais; pode ser executada em paralelo. Limite em constante única, `MulterError`
convertido em JSON estruturado, front traduzindo nos três idiomas — incluindo o alerta de limite de
anexos, hoje fixo em português.

**Testes novos:** `S201` (JSON em vez de HTML) e extensão do `S147` para as chaves novas.

**Critério de conclusão:** doze imagens pelo Dashboard devolvem mensagem clara e traduzida, em vez de
erro de interpretação de resposta.

## Sprint 016 — Agrupamento de álbum no Telegram

Última por dois motivos: depende da 013 para fazer sentido e é a única que introduz estado e janela
temporal em um adapter.

**Testes novos:** `S202` (N atualizações com o mesmo `media_group_id` resultam em uma mensagem
normalizada), `S203` (TTL de grupo que nunca fecha; deduplicação preservada).

**Critério de conclusão:** exige canal real — não há como simular a entrega fragmentada de álbum do
Telegram sem enviar um álbum de verdade ao bot.

## Sprint 017 — Validação end-to-end

Reenviar exatamente as doze imagens do incidente e confirmar que a pergunta original é respondida uma
única vez. Relatório em `docs/sprints/`, no padrão de `SPRINT_006_VALIDACAO_OPERACIONAL_REPORT.md`.

## Observações sobre o encadeamento

* As Sprints 011 e 012 são pequenas e independentes entre si — podem ser executadas na mesma sessão.
* A maior parte do valor está em **012 → 013**: com essas duas, as imagens chegam todas ao agente e a
  visão deixa de morrer no meio da sessão. As demais são qualidade de borda.
