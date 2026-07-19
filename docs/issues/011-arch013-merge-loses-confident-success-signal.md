# ARCH-013 — Fundir `evaluateAgentStepSuccess`/`escalateStepEvalToLLM` em `StepSemanticValidator` sem ajuste perde o sinal de "sucesso confiante"

## Resolvido em 2026-07-18 (reabertura de S21, pós-encerramento do programa)

Este achado foi **resolvido**, não permanece como pendência. A alternativa desenhada abaixo
("Alternativa levantada") foi implementada, com 1 ajuste adicional encontrado durante a própria
implementação (o texto original propunha promover via `stepSuccessConfident` calculado ANTES de
`cycleResult` existir — inviável após S22/S24 terem separado dispatch de validação semântica em
fases distintas do loop; a implementação real usa correção retroativa do `GoalAttempt` já
persistido, via `GoalStore.promoteLastAttemptToSuccess()`, mesmo padrão de
`downgradeLastAttemptToPartial()`). Detalhe completo, threshold escolhido e validação em ambiente
real: `docs/refatoracao-arquitetural-2026/SPRINTS/S21-ARCH-013.md`. O texto abaixo é preservado
como registro histórico do achado original de julho — não reflete mais o estado atual do código.

## Contexto

Achado durante a Sprint `2026-09-S21` (ARCH-013, `MASTER_EXECUTION_PLAN.md`), na etapa de
reverificação de premissa (Fase 1/2 da `DIRETRIZ_ARQUITETURA_2026-07-13.md`) — antes de qualquer
linha de código ser tocada. Diferente dos achados anteriores deste programa (S14/S17/S18), aqui o
DIAGNÓSTICO do card está correto — a prescrição é tecnicamente viável, compila e roda — mas a
implementação literal, sem um ajuste específico, causaria uma mudança silenciosa de comportamento
observável não mencionada pelo card.

## O que os dois mecanismos realmente respondem (lido linha a linha)

- **`evaluateAgentStepSuccess`/`escalateStepEvalToLLM`** (`GoalExecutionLoop.ts`, dentro de
  `executeStep()`, roda ANTES de existir um `cycleResult`): "isso executou com sucesso ou falhou?"
  — regex de sinais explícitos de falha/sucesso primeiro (determinístico); só escala pra LLM na
  zona ambígua (resposta 15-200 chars, sem sinal claro).
- **`StepSemanticValidator`** (`StepSemanticValidator.ts`, chamado DEPOIS em `runLoopInternal()`,
  só quando `cycleResult.outcome === 'success'`): "o que voltou realmente ENDEREÇA a intenção do
  step?" — fast path por termos-chave; escala pra LLM quando o fast path é inconclusivo.

São perguntas diferentes (execução vs. relevância semântica) — mas a MESMA condição (resposta
curta/ambígua, poucos termos-chave extraíveis) tende a disparar escalação nos DOIS estágios pro
MESMO step, confirmando o problema real de latência/custo duplo que o card descreve.

## O que a fusão literal perde

Hoje, quando `escalateStepEvalToLLM` confirma sucesso com confiança, marca
`stepSuccessConfident=true` — esse sinal decide se `GoalAttempt.result` final vira `'success'` ou
só `'partial'` (`result: !toolResult.success ? 'failure' : (stepSuccessConfident ? 'success' :
'partial')`, `GoalExecutionLoop.ts` ~linha 1900). `StepSemanticValidator` hoje só tem um sinal
NEGATIVO (`shouldDowngradeToPartial`, quando `mismatch` com alta confiança) — nunca um sinal
POSITIVO equivalente.

Se a chamada de LLM da zona ambígua do primeiro estágio for simplesmente removida (como a
prescrição literal do card sugere: "mantendo só a extração determinística fora dele"), não sobra
nenhum mecanismo que promova um resultado ambíguo a `'success'` confiante — **todo step da zona
ambígua passaria a virar `'partial'` sempre**, mesmo quando genuinamente bem-sucedido. Isso muda
o comportamento observável de conclusão de goal (critérios de sucesso dependem de attempts
`'success'`, não `'partial'`; contagem de retry) de forma silenciosa — compila, passa em testes
que não cubram esse cenário específico, mas regride um comportamento real.

## Alternativa levantada (não implementada — Sprint adiada)

Dar ao `StepSemanticValidator` os dois sentidos do sinal: um veredito `'relevant'` com confiança
alta também promoveria `stepSuccessConfident=true` (não só `'mismatch'` rebaixando, como já
acontece hoje). Preserva o comportamento observável atual, reduz de 2 chamadas de LLM pra 1 no
caso em que ambos os estágios escalariam hoje.

## Decisão

Adiado por decisão do usuário — mesma linha de S14/S17/S18: quando a implementação literal de um
card, mesmo tecnicamente viável, teria uma consequência de comportamento não anunciada e só
visível rastreando a cadeia completa de efeitos (não por reverificar uma alegação factual pontual),
preferir adiar e documentar a corrigir pontualmente na mesma sessão.

## Diferença em relação aos achados anteriores (S14/S17/S18)

Nos casos anteriores, a PREMISSA do card estava factualmente errada (mecanismo inexistente,
equivalência semântica falsa, prescrição que não compila). Aqui a premissa está CORRETA — os dois
mecanismos de fato rodam em sequência desnecessária pro mesmo step em casos reais — e a prescrição
É implementável. O que falhou foi rastrear a CONSEQUÊNCIA COMPLETA da remoção proposta até o fim
(o sinal `stepSuccessConfident` que dependia da chamada removida). Catalogado como um modo de falha
novo (7º) em `RETROSPECTIVA_PREMISSAS_AUDITORIA.md`.

## Severidade

N/A — não é um bug em produção (nada foi implementado), é uma correção de design encontrada antes
da implementação. Registrado para que ARCH-013 não seja reproposto sem o ajuste de promoção de
confiança já desenhado aqui.
