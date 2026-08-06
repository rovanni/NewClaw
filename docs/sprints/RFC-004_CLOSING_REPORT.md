# RFC-004 — Relatório de Encerramento

**Período:** 05/08/2026 (ciclo completo em um dia)
**RFC:** `docs/decisoes/RFC-004_INGESTAO_DE_MIDIA_MULTIPLA.md`
**Baseline:** B2.1 — Ingestão de Mídia (`docs/decisoes/ADR-001_BASELINE_ARQUITETURAL.md`, §10)
**Branch:** `rfc-004-ingestao-midia` → `main` (merge `--no-ff`)
**Suíte:** 194 → **201 testes**

---

## 1. Origem

Um usuário enviou 12 imagens por Telegram com a pergunta "Poderia explicar cada projeto?" e relatou
apenas que "bugou". A descrição era exata: não houve exceção, não houve travamento, não houve
mensagem de erro. O sistema continuou funcionando e respondendo — apenas deixou de enxergar, sem
avisar ninguém, e passou a responder sobre imagens que nunca viu.

| Métrica do incidente | Valor |
|---|---|
| Imagens recebidas | 12 |
| Analisadas | 4 |
| Salvas mas nunca analisadas | 5 |
| Perdidas sem qualquer resposta | 3 |
| Respostas | 9, isoladas |
| Tempo | 27 minutos |
| Pergunta respondida | não |

## 2. O que foi entregue

| Sprint | Entrega | Cobertura |
|---|---|---|
| 010 | Alinhamento documental dos princípios | — |
| 011 | Nenhum endereço de rede embutido no código ou instaladores | `S195` |
| 012 | Registro de perfis entrega cópia, nunca a referência interna | `S196` |
| 013 | Ingestão percorre todos os anexos; falha vira fato, não resposta | `S197` |
| 014 | Política única de retry de download para os três tipos de mídia | `S198` |
| 015 | Limite de anexos com fonte única e erro traduzível no Dashboard | `S199` |
| 016 | Álbum do Telegram vira uma única mensagem com N anexos | `S200` |
| 017 | Validação end-to-end do incidente | relatório |
| — | Ferramentas de entrega devolvem conteúdo, não recibo | `S201` |

Saldo em código de produção: **+459 / −118 linhas** em 12 arquivos. Nenhuma Tool, Skill ou Script
novo — o gate "Extensão antes de Criação" eliminou todos os candidatos. Os únicos arquivos novos de
código são os sete testes de regressão.

## 3. Três princípios normativos

Mais duráveis que as correções, porque valem para código que ainda não existe:

1. **Configuração compartilhada é imutável para quem lê** — `ADR-001` §10.
2. **Pré-processamento de mídia produz fatos, nunca decisões** — `docs/ARCHITECTURE.md`, princípio 8
   e seção "Ingestão de mídia".
3. **Ferramentas de entrega devolvem o conteúdo entregue** —
   `docs/ARCHITECTURE/FERRAMENTAS_DE_ENTREGA.md`.

## 4. O que a investigação mudou em relação à hipótese inicial

Três correções de rumo, registradas porque documentar só o que deu certo produz um histórico
enganoso:

* **A deduplicação de áudio estava correta.** A suspeita inicial era de que ela disparava
  indevidamente. O log de steps mostrava `step_2 = send_audio`, mas o primeiro envio acontecera
  dentro do `agentloop` do `step_1`, sem aparecer como step próprio — era mesmo o segundo envio. O
  defeito era outro, e maior: **os três** caminhos do `send_audio` devolviam recibo, inclusive o de
  sucesso.
* **`Readonly<T>` não barra a mutação sozinho.** A RFC afirmava que transferia a detecção para o
  compilador. TypeScript considera `Readonly<T>` atribuível a `T`, então o chamador que anota a
  variável como `ModelProfile` volta a compilar a mutação. Quem garante a invariante é a cópia
  defensiva em runtime; por isso `S196` inclui guarda estática contra a reintrodução do padrão.
* **A tentativa anterior criou o bug.** `git log -L` sobre `processAttachments` apontou o commit
  `cef60c7` ("fix: voice transcription not reaching AgentLoop") como autor exato das cinco linhas
  do defeito — o comentário dizia "Continue to text processing pipeline" e o código fazia `return`.

## 5. Achados fora da hipótese original

Dois defeitos que ninguém procurava e que apareceram porque a investigação foi até o arquivo:

* **Endereço de rede privada como padrão de fábrica.** `WHISPER_API_URL` tinha o endereço da
  máquina de um usuário específico embutido no código de um projeto público. Como os instaladores
  gravam a variável vazia e string vazia é *falsy*, **toda instalação nova saía apontando para
  aquele host** — em rede doméstica, tipicamente o roteador do próprio usuário. O achado já constava
  de auditoria anterior como observação e nunca virara correção.
* **Segundo aliasing no `ModelProfileRegistry`.** O construtor fazia `{ ...DEFAULT_CONFIG }` — cópia
  rasa que compartilha o array de perfis com a constante do módulo. Um registro construído com
  configuração contaminava os padrões de qualquer outro criado depois no mesmo processo.

## 6. Validação em execução real

Instância isolada, LLM real, visão real, filesystem real
(`docs/sprints/SPRINT_017_VALIDACAO_RFC004_REPORT.md`):

| | Incidente (04/08) | Validação (05/08) |
|---|---|---|
| Imagens analisadas | 4 de 12 | **10 de 10** |
| Perdidas em silêncio | 3 | **0** |
| Respostas | 9 desconexas | **1** |
| Tempo | 27 min | 4 min 25 s |
| Pergunta respondida | não | **sim** |

A resposta explicou nove projetos, montou tabela-resumo e observou por conta própria que o slide 5
não estava entre as imagens enviadas — o que era verdade.

## 7. Pendências que saem deste ciclo

| Item | Onde está registrado |
|---|---|
| Álbum do Telegram não validado em canal real | `ADR-001` §10, "Validação" |
| `S158` instável — dedup (issue 020) × ciclo de verificação do RFC-003 | `docs/issues/021` |
| Suíte não isola estado entre testes | `docs/issues/021`, achado secundário |
| Core sem sistema de tradução (ACK de fila, validador de objetivos) | `docs/ARCHITECTURE.md`, "Gaps conhecidos" |
| Tempo de visão sequencial com muitas imagens | `RFC-004`, "Riscos" — deliberadamente não tratado |

## 8. Nota sobre o método

O ciclo seguiu o processo de cinco fases da diretriz de arquitetura. O que mais rendeu não foi
nenhuma fase isolada, mas a insistência em **reproduzir antes de propor**: o incidente foi
reconstruído a partir do log real da instância de produção, e cada correção foi verificada contra
execução real, não apenas contra teste. Foi assim que apareceram os dois achados da Seção 5 e as
três correções de rumo da Seção 4 — nenhum deles era visível na leitura do código.
