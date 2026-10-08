# Informação Completa para Decidir

> Documento normativo. Define o que toda chamada em que o LLM **decide** precisa receber: a informação que um humano
> competente precisaria para tomar a mesma decisão. Decisão sem essa informação não é decisão — é palpite, e o
> sistema passa a confiar num palpite como se fosse julgamento.
>
> Origem: pedido do operador, 08/10/2026 — *"um LLM pensa como um ser humano: que dados a gente precisa ter para
> tomar uma decisão? Sempre que o LLM decide, é obrigatório ele receber todas as informações para decidir."*

## 1. Objetivo

Garantir que nenhuma decisão do LLM — classificar, planejar, revisar, validar, julgar — seja tomada às cegas sobre
uma parte do que precisaria ver, e que essa garantia seja **verificada**, não só escrita.

## 2. Motivação — o que acontecia sem a regra

O mapeamento de 08/10/2026 (`docs/analises-arquiteturais/MAPA_INFORMACAO_DAS_DECISOES_LLM_2026-10-08.md`) examinou
os 15 pontos do código em que o LLM decide. Em quatro, faltava informação que um humano exigiria:

- **O juiz de grounding julgava sem o pedido do usuário.** Bloqueou uma resposta correta que citava o curso
  informado pelo usuário, porque não tinha como saber de onde aquilo vinha (experimento de 07/10).
- **O replanejamento e a análise de risco recebiam um resumo no lugar do pedido** — resumo escrito pelo
  `GoalExtractor` a partir dos **300 primeiros caracteres** da mensagem. Em outubro: 22 replanejamentos e 30
  revisões de risco sobre esse resumo.
- **O validador do passo via 600 caracteres do resultado escolhidos por palavra-chave** — uma heurística decidindo o
  que o LLM podia ver.
- **O validador de qualidade via só a última ferramenta** de um turno com várias.

E um precedente que mostra o tamanho do problema: até 06/08/2026, o próprio banco gravava o pedido do usuário cortado
em 300 caracteres (41 goals, um deles vindo de uma mensagem de 4.094). O corte não tinha motivo registrado; foi
corrigido num ponto e sobreviveu em outro. Sem uma regra, cada componente decidia sozinho quanto do mundo o LLM via.

Quando o LLM decide sem a informação, ele não diz "não sei" — ele responde mesmo assim. O validador de qualidade,
na primeira chamada real com o campo de observação (Sprint C, 08/10), escreveu exatamente o que faltava: *"Faltou
registro de consulta a uma fonte de previsão do tempo para validar os valores informados na resposta."*

## 3. Definição

Toda chamada em que o LLM **decide** recebe, conforme a pergunta que ela responde:

1. **A pergunta, explícita** — o que exatamente está sendo decidido.
2. **O objeto da decisão, inteiro** — a resposta que está sendo julgada, o plano que está sendo revisado, o texto
   que está sendo classificado. **Nunca cortado.**
3. **A fonte de verdade contra a qual se decide, inteira** — as evidências de ferramenta, o conteúdo do arquivo, os
   resultados dos passos. Todas as que se aplicam, não só a primeira ou a última.
4. **O pedido do usuário, íntegro**, sempre que a pergunta dependa dele — toda decisão do tipo "atende?", "serve?",
   "foi cumprido?", "o plano cobre?", "o que fazer agora?". Marcado como contexto do usuário quando não for, ele
   próprio, a fonte de verdade.
5. **O contexto da decisão**, quando ele muda a resposta — o que já foi tentado, o que falhou, o que já foi entregue.

**Critério de suficiência** (o que torna "todas as informações" verificável): *um humano competente, recebendo
apenas este prompt, conseguiria tomar esta decisão com segurança?* Se a resposta for "não, precisaria ver X", então
X falta.

"Todas as informações" **não** é "tudo o que existe". É tudo o que a pergunta precisa. Mandar o banco inteiro a cada
decisão viola a regra de custo de `RESPONSABILIDADE_ANTES_DO_MECANISMO.md` e torna o julgamento mais lento e pior.

## 4. Proibições

1. **Cortar o objeto da decisão.** O que está sendo julgado vai inteiro (precedente: issue 067 — o validador de
   qualidade reprovava como "truncada" uma resposta completa que ele recebia cortada em 500 caracteres).
2. **Cortar contexto sem declarar.** Corte de contexto só é permitido com teto de orçamento nomeado e com o corte
   **declarado no próprio prompt** ("trecho: primeiros N de M caracteres — o corte é do sistema, não do dado").
   Sem a declaração, o LLM não distingue "o dado acaba aqui" de "o prompt cortou aqui".
3. **Resumo no lugar do original, quando o original existe.** Um resumo pode acompanhar o original; nunca
   substituí-lo. O resumo é a leitura de outro LLM sobre o pedido — decidir sobre ele é decidir sobre uma leitura.
4. **Heurística escolhendo o que o LLM vê.** Seleção por palavra-chave, por posição ou por pontuação decide, sem
   declarar, o que o julgamento pode considerar. Ordenar ou priorizar é permitido; esconder não é.
5. **Julgar o pedaço como se fosse o todo.** Se a informação necessária não cabe no orçamento, o resultado é
   **"não avaliável"**, nunca um veredito sobre a parte que coube (precedente: `GROUNDING_MAX_PROMPT_CHARS` →
   `UNVALIDATED`, `ObserverValidator`).

## 5. Como a regra é verificada

1. **Registro obrigatório (recenseamento).** Toda chamada de decisão ao LLM (`chatWithFallback`/`classifyWithFallback`)
   precisa constar no registro vigente — a tabela do mapa da informação
   (`docs/analises-arquiteturais/MAPA_INFORMACAO_DAS_DECISOES_LLM_2026-10-08.md`, §1) — com a pergunta que decide e
   o que recebe. O teste `S356` varre `src/` e falha se um arquivo com chamada de decisão não estiver no registro:
   quem cria uma decisão nova é obrigado a declarar o que ela vê.
2. **Termômetro no uso real.** O campo opcional `faltou` dos avaliadores (gravador de voo,
   `src/shared/evaluatorFlightRecorder.ts`) registra quando o próprio modelo diz que faltou informação. O relatório
   `docs/analises-arquiteturais/instrumentos-2026-10-08/observacoes_dos_avaliadores.js` mostra as mais repetidas —
   onde a regra está sendo violada na prática.
3. **Na revisão de proposta.** No questionário obrigatório (`RESPONSABILIDADE_ANTES_DO_MECANISMO.md`), o item
   EVIDÊNCIA ("esse componente os recebe?") é respondido com o critério de suficiência do §3, citando o que o prompt
   recebe — não com "sim".

## 6. Relação com os outros princípios

- **Responsabilidade antes do Mecanismo** pergunta *se* o componente recebe a evidência; este documento define *o
  que* precisa receber e *como* isso é cobrado.
- **Nunca Adivinhar** proíbe o componente determinístico de inventar um dado ausente. Este é o lado do LLM: um LLM
  sem a informação responde mesmo assim — adivinha sem avisar. Dar a informação é o que impede o palpite; o campo
  `faltou` é o que torna o palpite visível quando a informação ainda falta.
- **Evidence Provider Pattern** diz que componentes de conhecimento fornecem fatos ao Planner; este documento exige
  que os fatos necessários de fato cheguem.

## 7. Retrato em 08/10/2026 (não é lista de tarefas)

Violações conhecidas no registro (§1 do mapa), em ordem de prioridade: replanejamento e análise de risco sem o
pedido íntegro; `GoalExtractor` com a mensagem cortada em 300 caracteres; juiz de grounding sem o pedido; detector de
molde sem o pedido; validador do passo com seleção por palavra-chave; validador de qualidade com uma ferramenta só.
