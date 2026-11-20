# ADR-042 — Na conversa direta, a resposta sai antes do juiz contra a evidência (A3)

Data: 19/11/2026. Status: **aceita** (19/11/2026). A operadora aprovou a A3, que estava adiada desde 05/11, na forma
"com aviso", e decidiu os três detalhes abaixo (D1–D3).

Relacionadas: ADR-010 (barreira de groundedness), ADR-014 (motor único de juízes), ADR-027 (só para por travamento;
validação em segundo plano interrompida pelo pedido seguinte), A1-r (S479) e a parcial só com contradição (19/11/2026),
`docs/ARCHITECTURE/RESPONSABILIDADE_ANTES_DO_MECANISMO.md`, `docs/ARCHITECTURE/LOCALIDADE_DA_RECUPERACAO.md`.

## Fase 1 — Compreensão

### O pedido

"Como deixar o NewClaw mais rápido nas respostas?" (18/11/2026). Medição de 03 a 16/11 nas linhas `[LLM-CALL]` da
produção Windows: 41 turnos completos, mediana de 33 s e p90 de 353 s. Os juízes somam cerca de 66% do tempo de LLM, e
o juiz contra a evidência (`saida_contra_evidencia`) sozinho leva 37%, cerca de 30 s por chamada e 3,5 chamadas por
turno. Na conversa direta, ele fica entre a resposta pronta e a pessoa.

### O que já foi tentado

- **A1-r** (05/11): "não avaliável" sem contradição deixa de bloquear e sai com aviso.
- **A2, A4 e β** (05/11): recusadas. O raciocínio desligado perde contradições reais, e o modelo local perdeu as duas
  contradições reais da amostra.
- **Parcial só com contradição** (19/11): sem contradição apontada, a parcial e o 2º julgamento deixam de rodar.

A A3 ficou adiada em 05/11 ("com o juiz mais curto, a espera pode deixar de ser problema"). Com a A2 recusada, o juiz
não encurtou.

### O que existe e é reaproveitado

- `AgentLoop.validacoesPorConversa` (ADR-027): os `AbortController` das validações em segundo plano de cada conversa,
  interrompidos quando o próximo pedido do usuário nessa conversa começa.
- `AgentLoop.avisarUsuario(canal, chatId, texto)`: o caminho que o relato de progresso usa para falar com a pessoa fora
  da resposta do turno (`MessageBus.sendToChat`).
- `AgentLoop.comAvisoNaoConfirmado` e `liberavelComAviso` (A1-r), e as tabelas de aviso nos três idiomas.
- O veredito do juiz (`g.claims`, com `trecho` quando o juiz cita a fonte).

Nenhum canal do NewClaw edita uma mensagem já enviada (conferido em `src/channels/`). Por isso, o que o juiz tiver a
dizer depois chega como uma 2ª mensagem.

## Fase 2 — Responsabilidade antes do mecanismo

| | |
|---|---|
| **Pergunta** | A resposta afirma algo que os dados obtidos no turno não sustentam? |
| **Responsabilidade** | O juiz contra a evidência (inalterado). |
| **Evidência** | A mesma de hoje: a saída das ferramentas do turno e as evidências dos passos anteriores. |
| **Autoridade** | Muda o *momento* do veredito, não quem decide. Antes, o veredito barrava a entrega. Agora vira um aviso posterior. |
| **Estado** | Nenhum estado novo além do sinal de interrupção da conversa, que já existe (ADR-027). |
| **Consumidor** | A pessoa, por uma 2ª mensagem; o gravador de voo e a `ReflectionMemory`, como hoje. |

Motivos para NÃO fazer, e como cada um ficou:

1. **A pessoa lê, por um tempo, uma afirmação que depois é corrigida.** Esse é o custo aceito pela operadora. A marca
   da resposta diz que a conferência está em curso.
2. **O objetivo (goal) usa o veredito para replanejar** (`turnState.groundingBlock`). Por isso a A3 vale só para a
   conversa direta (sem `goalTrace`), e o passo de objetivo continua síncrono.
3. **Sem canal para falar depois** (contexto sem canal ou sem `chatId`, chamada interna): sem para onde mandar a
   correção, o juiz continua na frente, como hoje.
4. **O pedido seguinte disputa o modelo com o juiz.** Fica resolvido pela D3.

## Decisões da operadora (19/11/2026)

- **D1 — Quando o juiz aprova, nada mais chega.** A marca da resposta diz que a conferência está em curso e que vem um
  aviso só se houver problema.
- **D2 — Quando o juiz acha problema, a 2ª mensagem traz os pontos e o trecho da fonte, sem chamada nova de modelo.**
  Contradição (`REJECTED` ou item apontado como contradição): os pontos que não conferem e, quando o juiz citou, o trecho
  da fonte. "Não avaliável" sem contradição: o aviso da A1-r com os pontos não confirmados. Juiz que não concluiu
  (`UNVALIDATED` ou falha antes do julgamento): uma linha dizendo que a resposta não pôde ser conferida.
- **D3 — Pedido novo durante a conferência interrompe o juiz**, pelo mesmo sinal da ADR-027, e uma linha curta diz que
  a resposta anterior ficou "não conferida".

## Fase 4 — Síntese

Na conversa direta com canal conhecido, a resposta sai na hora com a marca. O mesmo julgamento de hoje roda em segundo
plano, preso ao sinal da conversa, e o desfecho segue D1–D3. O texto do aviso e da marca fica nas tabelas de três
idiomas, como os avisos que já existem.

Riscos que ficam:
- No canal web, a 2ª mensagem chega pela fila de entregas do contrato do turno (outbox), não como uma bolha na hora.
  Isso será conferido na execução real.
- A `ReflectionMemory` passa a gravar o veredito depois que a resposta saiu. O conteúdo gravado é o mesmo.

## Fase 5 — Validação

- Baseada em medição real (37% do tempo de LLM), não em hipótese.
- Não soma mecanismo: reaproveita o sinal da ADR-027 e o aviso ao usuário do relato de progresso.
- Reverter é tirar um `if`: o caminho síncrono continua no código e é usado quando a A3 não se aplica.
- Critério de sucesso: na conversa direta, o tempo até a resposta deixa de incluir o juiz. Medir a mediana e o p90 de
  `message_received → processing_done` por duas semanas e comparar com 03–16/11.

## Revisão de 19/11/2026 (noite) — a conferência da conversa vira opção, desligada por padrão

Testando a produção, a operadora achou que a marca "Conferindo esta resposta…" deveria ser opcional, e decidiu:

- **Sem a marca, sem o juiz.** A opção desliga a conferência inteira da conversa direta: não há marca, não há juiz contra
  a evidência, nem antes nem depois da entrega, e não chega correção depois. Ela recusou deixar o juiz rodando sem a marca,
  porque uma correção que chega sem aviso surpreende.
- **No painel**, em Configurações → Validadores: "Conferir as respostas da conversa". Vale na hora, para todos os canais, e
  fica gravada no `.env` como `CONFERENCIA_DA_CONVERSA=ligada|desligada`.
- **Desligada por padrão.** Sem a variável, a conversa direta não é conferida. Ligada, o comportamento é o das D1–D3 acima.
- **O passo de objetivo continua sempre conferido**: o veredito alimenta o replanejamento, e a opção não o alcança.
- **A tarefa agendada segue a opção**, porque chega ao `AgentLoop` como turno direto, sem passo de objetivo (achado do
  code-review). O texto do painel diz isso.

Responsabilidade: é escolha da operadora (`docs/ARCHITECTURE/SOBERANIA_DA_CONFIGURACAO.md`). O NewClaw não troca a escolha
sozinho, e o caminho desligado grava `[GROUNDING-TRACE]` com `path: conversation_check_off`, para a medição separar os
turnos que não foram conferidos.

`JUIZ_DEPOIS_DA_ENTREGA=desligado` não muda: com a conferência ligada, põe o juiz de volta na frente da resposta.
