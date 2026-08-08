# RFC-006 — Procedência de Artefato de Workspace

**Status:** proposta
**Data:** 2026-08-08
**Origem:** incidente "River" — validação em execução real, Windows (`newclaw-audit.log`,
08/08/2026, 11:41–12:07). Quem atendeu os turnos foi o **Ollama local** (`localhost:11434`) com
`gemma4:e4b-it-qat`, e não o llamafile: `defaultProvider` estava em `llamafile`, mas os seis papéis
do roteador (`modelRouter.provider_chat` … `provider_execution`) apontavam para `ollama` — o log
confirma (`[req-…-ollama-0] START provider=ollama/gemma4:e4b-it-qat`).
**Relacionada:** `docs/ARCHITECTURE/NUNCA_ADIVINHAR.md` (estende o princípio para uma superfície
que ele hoje não cobre), Sprint 043 (corrigiu as duas causas adjacentes; esta ficou de fora
deliberadamente).
**Substitui/Revoga:** nada.

---

## Resumo

Um valor fabricado por um LLM foi gravado num arquivo do workspace e, 25 minutos depois, lido de
volta e apresentado ao usuário como **"registros internos de cotações"**. Entre a gravação e a
leitura, nada no sistema — nem no arquivo, nem no `read`, nem na resposta — indicava que aquele
conteúdo nunca tinha sido observado em fonte nenhuma.

O defeito não é o LLM ter errado; modelos erram, e a Sprint 043 tratou as duas causas que levaram
ao erro. O defeito é que **um artefato de workspace não carrega a procedência do que contém**, e
por isso um dado inventado se torna, na leitura seguinte, indistinguível de um dado apurado — e
ganha a autoridade extra de "está registrado em arquivo".

O `NUNCA_ADIVINHAR` já proíbe apresentar valor inferido como fato. Ele governa a **resposta**. Esta
RFC trata do caminho que passa por fora dele: o valor inferido vira **arquivo**, o arquivo vira
**evidência**, e a resposta seguinte é honesta sobre a sua fonte imediata (o arquivo) enquanto é
falsa sobre a origem do dado.

---

## Evidência

Cadeia completa, numa única conversa do canal web:

| Hora | Evento | Onde |
|---|---|---|
| 11:41:43 | `crypto_analysis` ✓ — `River (RIVER) | Preço: $2,8 | 24h: -6,62% | MCap: $54.87M | Vol: $4.66M` | log |
| 11:42:46 | resposta ao usuário: **"$0,7834 … alta de 5,2% … volume $12,5 milhão … capitalização ~$95 milhões"** | transcript seq=8 |
| 11:55:29 | `write` ✓ → `workspace/RVR_cotacao.md` (0.4KB) | log |
| 11:55:37 | `read` ✓ → `[Arquivo: RVR_cotacao.md | 0.4KB | hash=8ce192f58850]` | log |
| 12:06:40 | `read` ✓ mesmo arquivo, mesmo hash | log |
| 12:06:59 | resposta ao usuário: **"Com base nos registros internos de cotações (arquivo RVR_cotacao.md)… o preço atual aproximado da criptomoeda River é de $0,7834 USD"** | transcript seq=21 |

Os quatro números da resposta das 11:42 divergem dos quatro do resultado real da ferramenta, obtido
63 segundos antes. Os mesmos números reaparecem 24 minutos depois, agora com uma citação de fonte.

Dois agravantes que a evidência mostra e que valem registro:

1. **O `read` reporta integridade, não procedência.** A saída traz tamanho e `hash=8ce192f58850` —
   sinais que aumentam a confiança percebida no conteúdo, e que são verdadeiros: o arquivo é
   exatamente aquele. Nada disso diz de onde veio o que está escrito nele.
2. **A resposta final não mentiu sobre a fonte imediata.** O arquivo existe, o conteúdo é aquele.
   A falsidade está uma camada abaixo, e é justamente a camada que não é representada em lugar
   nenhum.

---

## Por que não foi corrigido na Sprint 043

A Sprint 043 corrigiu o que era assimetria ou perda de informação em código já existente:

- a síntese de info-retrieval passou a proibir explicitamente fabricar valores (a proibição
  simétrica já existia no ramo irmão, para fabricar *falhas*);
- o rebaixamento de step para AgentLoop passou a preservar qual ferramenta o plano pretendia usar
  e qual argumento faltava.

Ambas são correções locais, sem conceito novo. **Procedência não é.** Introduzir a noção de "este
dado foi observado / este dado foi produzido sem observação" cria um eixo de metadados que
atravessa `write_tool`, `read_tool`, `read_document`, o workspace, e potencialmente a memória —
exatamente o tipo de mudança que a Diretriz Permanente de Arquitetura manda submeter às cinco fases
antes de qualquer linha de código.

Registrar agora, implementar depois, é a escolha deliberada — não um esquecimento.

---

## Perguntas em aberto (a serem respondidas ANTES de propor solução)

Deliberadamente sem resposta proposta aqui, no mesmo espírito da Fase 0 que destravou a `RFC-005`:

1. **Onde vive a procedência?** Metadado lateral (arquivo irmão, índice no DB), cabeçalho dentro do
   próprio artefato, ou atributo do sistema de arquivos? Cada opção falha de um jeito diferente
   quando o arquivo é movido, copiado, editado à mão ou enviado ao usuário.
2. **Quem a atribui?** O `write_tool` não sabe se o conteúdo que recebeu veio de um `crypto_analysis`
   ou da imaginação do modelo — no momento da gravação, é só uma string. A informação existe no
   `GoalExecutionLoop`/`AgentLoop` (que viu quais tools rodaram antes). Isso sugere que a
   procedência é atribuída em cima, não na tool — o que precisa ser confrontado com a regra de que
   o Core não deve crescer estado novo sem necessidade provada.
3. **É determinismo ou evidência?** Marcar um arquivo como "não verificado" e **impedir** que ele
   seja citado seria um componente determinístico decidindo pelo Planner — precisaria de uma
   justificativa de segurança/integridade nomeável (`EVIDENCE_PROVIDER_PATTERN`, Seção 7). Entregar
   a marca como **fato no contexto**, deixando o Planner ponderar, é o padrão vigente. A segunda
   opção é mais consistente com a arquitetura; a primeira protege mais. A tensão é real e precisa
   ser decidida, não resolvida por omissão.
4. **Qual o alcance?** Só workspace, ou também memória (`memory_write`), transcript e artefatos
   enviados por `send_document`/`send_audio`? Um dado fabricado gravado na memória de longo prazo é
   pior que um gravado em arquivo, e o mecanismo de contaminação é o mesmo.
5. **O que acontece com artefatos que já existem?** Todo arquivo do workspace anterior à mudança não
   tem procedência. "Ausente" precisa significar *desconhecido*, nunca *confiável* — mas tratar
   todo arquivo legado como suspeito degrada o uso normal. Precisa de política explícita.

---

## Critério de aceitação (proposto)

Formulado para ser falseável na etapa 4 da Validação Progressiva (execução real), não em teste com
mock:

> Reproduzido o incidente — um turno grava em arquivo um valor que nenhuma ferramenta produziu, e um
> turno posterior lê esse arquivo — a resposta ao usuário **não** apresenta o valor como apurado.
> Ou o sistema informa que a origem do dado é desconhecida, ou não usa o arquivo como fonte.

---

## Fora de escopo

- Impedir que o LLM fabrique dado na resposta. Isso é a Sprint 043 (síntese) e o
  `NUNCA_ADIVINHAR`; esta RFC assume que a fabricação pode acontecer mesmo assim e trata a
  **propagação**.
- Verificar a veracidade do conteúdo contra a fonte externa. Procedência responde *"de onde veio"*,
  não *"está certo"*.
