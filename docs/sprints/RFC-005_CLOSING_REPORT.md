# RFC-005 — Relatório de Encerramento

> Série concluída em 06-07/08/2026. Sete Sprints (018-024), a partir da investigação
> `docs/analises-arquiteturais/FASE0_POLITICAS_IMPLICITAS_DE_INDISPONIBILIDADE_2026-08-06.md`.
>
> Documento de registro: descreve o que foi entregue, o que a implementação mudou em relação à
> hipótese, e as evidências da validação em execução real. Não propõe trabalho novo.

## 1. Origem

Um requisito operacional do operador: *"o NewClaw deve continuar plenamente utilizável mesmo sem
conexão com a Internet, desde que o usuário tenha escolhido modelos locais para as funções que
deseja utilizar"*. O critério de aceitação derivado, que atravessou toda a série:

> *"Se a Internet cair agora, o usuário ainda consegue trabalhar da forma que configurou?"*

O incidente concreto (produção, 05/08/2026): o turno pediu `GLM-4.7-Flash` (local), o llamafile não
respondeu, o circuito abriu com `5/5 failures`, e a resposta veio de `glm-5.2:cloud` — sem nenhum
aviso. Em paralelo, `CIRCUIT-OPEN: Skipping 'Modelo local' (failures: 72)`: setenta e duas falhas
acumuladas contra um recurso que nunca esteve com defeito, apenas desligado.

## 2. O que foi entregue

| Sprint | Entrega | Commit | Cobertura |
|---|---|---|---|
| 018 | Dois princípios normativos + alinhamento (`ARCHITECTURE/README`, diretriz, nota na `ADR-002`, encerramento da Fase 0) | `c4879a2` | — |
| 019 | `ADR-006` — onde vive o ciclo de vida do runtime local | `1257d1c` | — |
| 020 | Taxonomia de estados; diagnóstico movido para `src/core/localRuntimeState.ts` | `f363051` | `S204`, `S205` |
| 021 | Política de substituição por recurso; `estrita` completa | `fee5c15` | `S207` |
| 022 | Substituição que atravessa fronteira vira fato verbalizado pelo LLM | `091024f` | `S208` |
| 023 | `searXNG`: remoção do espelho público da cadeia | `70c0de2` | `S206` |
| 024 | Medição em execução real (etapa 4) | este documento | — |

A ordem de execução não seguiu a numeração: a **023** foi feita logo após a 018, por depender apenas
dela e por ser o único item cuja pendência era vazamento de privacidade confirmado.

## 3. Dois princípios normativos

* **Soberania da Configuração do Usuário** (`docs/ARCHITECTURE/SOBERANIA_DA_CONFIGURACAO.md`) —
  substituir recurso declarado exige política que permita **e** visibilidade no resultado.
* **Localidade da Recuperação** (`docs/ARCHITECTURE/LOCALIDADE_DA_RECUPERACAO.md`) — política de
  recuperação vive na camada da falha e precisa ser alcançável no instante dela; vale também para o
  diagnóstico.

## 4. O que a implementação mudou em relação à hipótese

Quatro pontos em que o código contradisse o documento, e o documento cedeu:

1. **A cadeia de TTS não era o exemplo íntegro que a Fase 0 supôs.** `send_audio.ts:199` cai do
   Piper para o serviço da Microsoft registrando apenas `log.error`. Acerta *quem decide*, erra
   *quem fica sabendo* — foi essa evidência que fez a Soberania nascer com duas cláusulas.
2. **A presença do registro de modelo local não significa "deveria estar de pé".** A primeira
   taxonomia classificava assim; a revisão contra `ADR-002` §2.4 mostrou que isso recriaria o
   próprio defeito das 72 falhas, porque o registro sobrevive à morte do processo.
3. **Ausência de registro não é indeterminação, é ausência de gerenciamento.** Contradição interna
   da RFC, corrigida antes da Sprint 020: a redação original teria desligado o circuito de quem sobe
   o llamafile à mão, fora do dashboard.
4. **A fronteira de "custo" foi cortada.** Nenhum dos catorze casos da Fase 0 se classificava por
   ela sozinha.

## 5. Achados fora da hipótese original

* **`chatWithFallback` tem dois caminhos de substituição, não um.** Além da ordem de fallback, o
  bloco não-streaming troca o provider preferido pelo Ollama incondicionalmente. Gatear apenas o
  primeiro deixaria `estrita` decorativa — mesmo padrão que a `ADR-005` §5.1 registrou.
* **Duas perguntas distintas sobre "local".** "É runtime gerenciado por nós?" (alimenta o
  diagnóstico de ciclo de vida) e "roda na máquina do usuário?" (alimenta a fronteira) precisam de
  métodos separados: unificá-las faria um JSON corrompido impedir o circuito do Ollama de abrir.
* **Seis dos sete pontos de chamada de `chatWithFallback` passam `undefined` como provider
  preferido.** A fronteira da declaração separaria sozinha o turno do usuário das chamadas
  estruturadas — mas o opt-in do anúncio foi feito explícito mesmo assim, para não depender de uma
  coincidência que uma chamada nova pode desfazer em silêncio.
* **O espelho público de busca não era um fallback raro.** Como `localhost:8888` quase nunca está no
  ar, `searx.be` era na prática o provedor SearXNG efetivo da maior parte das instalações.

## 6. Validação em execução real (Sprint 024)

Etapa 4 da Validação Progressiva. Instância isolada (cwd temporário, registro de runtime próprio),
LLM real (Ollama, `gemma4:e4b-it-qat`), 5 execuções. Provider declarado `Modelo local`
(`127.0.0.1:8080`) com registro de PID morto — desligado pelo usuário. Política `anunciada`, opt-in
igual ao que o `AgentLoop` passa. Provider substituto endereçado por hostname, para que a fronteira
de localidade fosse verdadeira sem chave de nuvem (não há `.env` na instalação de teste). O
substituto foi envolvido num espião de passagem, que registra as mensagens recebidas sem alterá-las.

**Resultado determinístico — idêntico nas 5 execuções:**

| Verificação | Resultado |
|---|---|
| Cadeia de tentativas | `Modelo local:error → Modelo local:error → ollama:error → Provedor remoto:success` |
| `LLMResult.substitution` | `{"declared":"Modelo local","used":"Provedor remoto","announced":true}` |
| `[FATO DO SISTEMA]` nas mensagens do substituto | presente (verificado no espião, não inferido) |
| Anúncio presente na resposta | 5/5 |
| `CircuitBreaker` do recurso declarado | `falhas=0`, `CLOSED` — apesar de 10 falhas reais |

**Resultado probabilístico — a redação do aviso:**

| Classificação | Ocorrências |
|---|---|
| Fiel | 2/5 |
| Parcial (nomeia o substituto, omite o recurso declarado) | 2/5 |
| Acrescentou justificativa ausente do fato | 1/5 |
| Omitido por completo | 0/5 |

Exemplo fiel: *"Este aviso é gerado por um provedor remoto, pois o recurso de modelo local não
respondeu."* Exemplo com acréscimo: *"Minha resposta foi gerada por um provedor remoto **para
garantir a disponibilidade da informação**"* — a justificativa não estava no fato.

**Observação factual:** o fato injetado afirma que o substituto está *"fora da máquina do usuário"*.
Nenhuma das 5 respostas mencionou isso; todas mencionaram apenas a troca de provedor.

**Escopo da medição:** um modelo, 5 execuções, um idioma, turnos sem chamada de ferramenta,
substituto endereçado por hostname. Não cobre outros modelos, outros idiomas, turnos com
tool-calling, nem provider de nuvem real.

**Leitura do operador, registrada:** a decisão e a comunicação **estruturada** da substituição são
determinísticas; a **forma textual** dessa comunicação permanece responsabilidade probabilística do
modelo. Não há evidência de bug, regressão ou necessidade de revisar as ADRs ou a RFC.

## 7. Pendências que saem deste ciclo

Registradas para não serem absorvidas por proximidade temática:

* **Questões que a RFC não fechou, de propósito:** #5 Modo de Operação (descartado como *primitivo*,
  não como conveniência futura) e #7 substituição de decisões do LLM.
* **Aplicações posteriores dos princípios**, listadas na Seção 9 de
  `SOBERANIA_DA_CONFIGURACAO.md`: TTS (cláusula de visibilidade) e STT.
  * `resolveProfile ?? chat ?? [0]` **saiu desta lista em 07/08/2026**: a investigação mostrou que
    não é violação de Soberania nem caso ativo de adivinhação, e sim código defensivo inalcançável
    pelos caminhos de construção existentes. Evidências e limites em
    `SOBERANIA_DA_CONFIGURACAO.md` §9.1. O código não foi alterado.
* **Fidelidade da verbalização.** Medida, não tratada. Torná-la determinística implicaria texto fixo
  emitido pelo Core — que é o débito de i18n que a `RFC-004` decidiu reduzir, não aumentar.
* **`S158` instável** (issue 021). Falhou uma vez em cinco execuções da suíte durante a série.
  Verificado que não é consequência desta RFC: o teste injeta um `ProviderFactory` falso e nunca
  executa o `chatWithFallback` real.

## 8. Nota sobre o método

Duas coisas desta série valeram mais do que o código que produziram.

A primeira: a Fase 0 terminou **sem propor solução**, com quatro perguntas explicitamente sem
resposta, porque qualquer RFC escrita antes delas teria escolhido implicitamente por elas — que é a
classe de decisão implícita que a investigação existia para tornar visível.

A segunda: três dos quatro pontos da Seção 4 só apareceram quando o documento foi confrontado com o
código — dois deles ao escrever os testes, não ao escrever a implementação. A revisão final contra
`ADR-002` e `ADR-005`, pedida antes de commitar a RFC, encontrou uma contradição que teria recriado
o defeito original com uma taxonomia nova por cima.
