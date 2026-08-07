# Soberania da Configuração do Usuário

> Documento normativo. Define quando um componente pode substituir um recurso que o usuário
> escolheu explicitamente, e o que ele deve ao usuário quando o faz.
>
> Origem: `docs/decisoes/RFC-005_POLITICAS_DE_SUBSTITUICAO_DE_RECURSOS.md`, derivado do
> levantamento `docs/analises-arquiteturais/FASE0_POLITICAS_IMPLICITAS_DE_INDISPONIBILIDADE_2026-08-06.md`.

## 1. Objetivo

Garantir que a estratégia de execução escolhida pelo usuário continue valendo — e que, quando não
puder valer, ele saiba. O sistema pode substituir um recurso indisponível por outro; o que ele não
pode é fazer isso **sem autoridade declarada** e **em silêncio**.

O critério de aceitação, formulado pelo operador, é a forma curta do princípio:

> *"Se a Internet cair agora, o usuário ainda consegue trabalhar da forma que configurou?"*

## 2. Motivação

O NewClaw substitui recursos indisponíveis em pelo menos cinco subsistemas independentes
(modelos, busca web, transcrição, síntese de voz, ferramentas). Nenhuma dessas substituições é
errada por existir — fallback é técnica legítima e o projeto depende dela. O defeito é o silêncio.

Dois casos reais mostram o custo:

* **Modelo local trocado por nuvem** (produção, 05/08/2026): o turno pediu `GLM-4.7-Flash` local,
  o llamafile não respondeu, e a resposta veio de `glm-5.2:cloud`. O usuário recebeu resposta de
  nuvem tendo configurado modelo local, sem nenhum aviso. Com a Internet caída, esse mesmo caminho
  não degrada — falha por timeout.
* **Busca local trocada por servidor público** (`src/tools/web_search.ts`): o usuário sobe uma
  instância SearXNG local justamente para que suas buscas não saiam da máquina; encontrando-a fora
  do ar, o sistema envia a mesma consulta a `searx.be`. Aqui a implicação é privacidade, não
  disponibilidade — o que prova que o princípio não é sobre modelos.

## 3. Definição

> Quando o usuário declara explicitamente qual recurso o sistema deve usar para uma função, nenhum
> componente pode substituí-lo por outro sem que a substituição seja **(a)** permitida pela
> política declarada para aquele recurso e **(b)** visível no resultado entregue ao usuário.

As duas cláusulas falham separadamente, e é por isso que são duas. A cadeia de TTS
(`src/tools/send_audio.ts`) satisfaz (a) — só tenta o Piper offline quando o operador baixou os
modelos, lendo intenção de um sinal explícito — e viola (b): quando o Piper falha, o texto passa a
ser sintetizado por um serviço da Microsoft, e isso vira `log.error`, nunca chega ao usuário.

## 4. O que conta como declaração

Soberania protege **escolha explícita**, não ausência.

| Situação | Invoca este princípio? |
|---|---|
| Modelo escolhido na interface, `WHISPER_API_URL` preenchida, modelos do Piper baixados | **Sim** |
| Campo vazio, variável não definida, recurso nunca configurado | **Não** |

Ausência de configuração invoca outra regra: `NUNCA_ADIVINHAR.md` e `ADR-002` §2.1 — o sistema não
preenche a lacuna com um padrão embutido, e o comportamento diante da ausência é decidido por quem
tem autoridade para isso. Um padrão de fábrica não é escolha do usuário, e não há soberania a
proteger sobre ele.

## 5. Fronteiras de substituição

A regra não é "nunca substituir". Ela depende do que a substituição **atravessa**:

| Fronteira | Atravessar significa |
|---|---|
| **Localidade** | o processamento sai da máquina do usuário (local → remoto) |
| **Custódia** | o dado passa a ser tratado por um terceiro que o usuário não escolheu |

* **Substituição que não atravessa fronteira é resiliência ordinária** e pode ser silenciosa —
  dois provedores de nuvem equivalentes que o usuário listou lado a lado se cobrindo mutuamente.
* **Substituição que atravessa qualquer fronteira exige, no mínimo, anúncio.**

Uma terceira fronteira, "custo", foi considerada e descartada na `RFC-005`: nenhum caso conhecido
se classifica por ela sozinha, e o sistema não tem sinal confiável de quais providers são cobrados.

## 6. Políticas declaráveis

Cada recurso declarado carrega uma política, que responde "o que fazer quando ele não estiver
disponível":

| Política | Comportamento |
|---|---|
| `estrita` | Nunca substituir. A indisponibilidade é reportada ao usuário como resultado |
| `anunciada` | Substituir dentro das fronteiras permitidas; a substituição **aparece na resposta**, não só no log |
| `livre` | Substituir silenciosamente. Só válida para substituição que não atravessa fronteira |

Padrão para recurso declarado: **`anunciada`**.

> **Estado de implementação (Sprint 021, 06/08/2026).** A política existe em código como valor de
> domínio (`SubstitutionPolicy`, `src/core/providerTypes.ts`), declarável por provider
> (`CustomProviderConfig.substitutionPolicy`) ou globalmente (`SUBSTITUTION_POLICY`), com padrão
> `anunciada`.
>
> * `estrita` — **implementada por inteiro** para providers/modelos, nos dois caminhos de
>   substituição do `chatWithFallback`. Cobertura: `S207`.
> * `anunciada` — existe como valor e **ainda se comporta como `livre`**: o mecanismo de anúncio é a
>   Sprint 022. Limitação temporária, declarada aqui, no `.env.example` e em `S207-4`.
> * `livre` — comportamento histórico, preservado.
>
> Fora de providers/modelos (busca, STT, TTS) a política ainda não é consultada. Este documento
> descreve a norma; a Seção 9 descreve a realidade.

## 7. Responsabilidades

Um componente que escolhe qual recurso usar **DEVE**:

- Tratar a escolha explícita do usuário como a opção preferida, sempre tentada primeiro.
- Verificar, antes de substituir, se a substituição atravessa localidade ou custódia.
- Quando atravessar, **devolver o fato da substituição junto do resultado** — em estrutura que
  chegue a quem redige a resposta, não apenas ao log.
- Ler intenção de sinais explícitos quando existirem (presença de arquivos, registro de escolha),
  em vez de inferir preferência a partir do que respondeu mais rápido.

Um componente **NÃO DEVE**:

- Embutir no código um endereço, host ou serviço de terceiro como destino alternativo — em
  particular quando o recurso declarado é local (`ADR-002` §2.1 e o caso `searx.be`).
- Tratar "log registrou" como equivalente a "usuário foi informado". O log serve a quem depura, não
  a quem conversa.
- Redigir ele mesmo a mensagem de substituição ao usuário. O Core não tem sistema de tradução; a
  substituição entra como **fato para o LLM verbalizar**, que já obedece a `buildLanguageDirective`
  (ver `RFC-004` e `ARCHITECTURE.md`, "Gaps conhecidos").
- Reordenar ou reinterpretar a preferência do usuário por conveniência de implementação — ex.:
  colocar o provider custom por último na cadeia porque ele "costuma ser mais lento".

## 8. Exceções

Este princípio **não** se aplica a recusa ou bloqueio por **segurança, integridade ou
conformidade** — a mesma exceção que `DIRETRIZ_ARQUITETURA_2026-07-13.md` já reconhece para o
Princípio da Preservação do Raciocínio.

Não são violações, e permanecem intocados:

* `ToolRegistry.requiresAuthorization()` e a recusa *fail-closed* do executor comum (`ADR-005`
  §5.1) — negar execução por falta de autorização humana não é substituir um recurso declarado.
* `isDestructive()` / `RiskAnalyzer` — bloqueio absoluto de padrões catastróficos.

**A distinção operacional:** Soberania governa **trocar um recurso por outro**. Recusar executar
não é troca — é ausência de execução, e ela é visível ao usuário por construção. Um componente que
invocasse esta exceção para *substituir* silenciosamente estaria violando o princípio, não
exercendo a exceção.

## 9. Estado atual

Conforme a `RFC-005`, a primeira aplicação prática cobre apenas providers/modelos. Este quadro é a
realidade em 06/08/2026 — não a norma:

| Ponto | Situação |
|---|---|
| `transcribeAttachment` (STT) | ✅ Conforme — ausência de configuração significa transcrever localmente |
| `ADR-002` §2.1 (pasta de modelos) | ✅ Conforme — nunca um caminho plausível embutido |
| `send_audio` — escolha do Piper | ✅ Cláusula (a): presença dos modelos é o sinal de intenção |
| `send_audio` — queda para edge-tts | ❌ Cláusula (b): atravessa localidade e custódia, só registra em log |
| `ProviderFactory.chatWithFallback` | ⚠️ Parcial (Sprint 021): com `estrita`, não substitui e diz por quê. No padrão `anunciada`, ainda substitui em silêncio — o anúncio é a Sprint 022 |
| `web_search.searXNG` | ✅ Conforme desde 06/08/2026 (Sprint 023, `S206`) — só consulta a instância declarada em `SEARXNG_URL`; sem configuração, a fonte não é usada |
| `resolveProfile ?? chat ?? profiles[0]` | ❌ Perfil ausente cai em outro sem aviso — legado |

Violações listadas aqui são **débito conhecido e datado**, não permissão. Código novo nasce
conforme.

## 10. Relação com outros princípios

- **Localidade da Recuperação** (`LOCALIDADE_DA_RECUPERACAO.md`): ortogonal. Soberania responde
  *quem* tem autoridade para decidir; Localidade responde *onde* a recuperação mora. Um fallback
  pode estar na camada certa e ainda assim usurpar uma decisão do usuário.
- **Nunca Adivinhar** (`NUNCA_ADIVINHAR.md`): a fronteira entre os dois é a ausência de
  configuração. Onde o usuário não declarou nada, não há soberania — há um dado ausente, e a regra
  é reportar a ausência.
- **Evidence Provider Pattern** (`EVIDENCE_PROVIDER_PATTERN.md`): mesma família de defeito noutra
  camada. Lá, um componente determinístico decide pelo Planner; aqui, decide pelo usuário.
- **`RFC-004`, Princípio 2**: a cláusula (b) usa o mesmo mecanismo — produzir fato para o LLM
  verbalizar, nunca texto fixo emitido pelo Core.

## 11. Checklist para novos componentes

Antes de implementar um componente que escolhe entre recursos alternativos:

- [ ] O recurso que este componente pode substituir foi **declarado explicitamente** pelo usuário,
      ou é um padrão de fábrica?
- [ ] A substituição atravessa **localidade** ou **custódia**?
- [ ] Se atravessa, o fato da substituição chega a quem redige a resposta ao usuário — ou só ao log?
- [ ] Existe algum endereço, host ou serviço de terceiro **embutido no código** como alternativa?
- [ ] Com a Internet caída, este componente ainda permite trabalhar da forma configurada?
