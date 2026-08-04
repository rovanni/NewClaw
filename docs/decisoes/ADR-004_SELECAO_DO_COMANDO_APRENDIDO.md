# ADR-004 — Seleção do comando aprendido: um probe não pode ser uma instalação

> **Status:** decisão tomada em 04/08/2026, escopo estreito — trata **apenas** de qual
> `GoalAttempt` pode ser eleito como "o comando que resolveu a dependência"
> (`fixAttempt`). Não reabre a `ADR-003` nem o modelo de confiança da `RFC-001`.
>
> Origem: defeito observado em execução real durante a Sprint G da `ADR-003` (03/08/2026), não em
> leitura de código nem em teste mockado.

## 1. Contexto

A `ADR-003` tornou o aprendizado operacional alcançável fora da combinação Linux + `ffmpeg`: a
captura passou a aceitar, como validação objetiva, a evidência de que a dependência **está
presente no ambiente** ao fim do goal.

O que a `ADR-003` deliberadamente **não** mudou (registrado lá em §5.5): a escolha de *qual*
comando é creditado. Essa escolha vem da `RFC-001`/Sprint D e é uma heurística —
`OperationalKnowledge.captureFromGoal()` credita o **primeiro `exec_command` bem-sucedido depois
do blocker**. A ADR-003 registrou em abstrato que o probe prova o *estado*, não a *causalidade*.

## 2. Achado (Sprint G, execução real)

Instância isolada, LLM real (`glm-5.2:cloud`), commit `e0a9260`. Goal em que `sprintg-tool3`
genuinamente não existia, passou a existir por um `exec_command` real, e foi capturado:

```
[OPKNOW-CAPTURE] dependency=sprintg-tool3 command="where sprintg-tool3 || echo "NOT FOUND""
                 ... evidence=environment_state
```

O comando gravado é um **diagnóstico**, não a instalação. O LLM rodou um `where` de checagem antes
do comando que de fato criou o binário; a heurística "primeiro sucesso depois do blocker" elegeu o
`where`.

Impacto potencial, e o motivo de não adiar: com repetição, o registro atinge `validated`
(`computeConfidenceLevel()`) e vira **atalho tático** (`getTacticalCommand()`) — o Planner
receberia, com a confiança de conhecimento validado, um "comando de instalação" que não instala
nada. A fraqueza é anterior à ADR-003; foi a ADR-003 que a tornou alcançável.

## 3. Problema

A heurística trata todo `exec_command` bem-sucedido como candidato igualmente plausível a "causa
da correção". Mas existe uma classe de comandos que, por definição, **não pode** ter causado a
correção: os que apenas perguntam se a dependência existe. `where X`, `which X`, `command -v X`
não instalam X — verificar não é instalar.

## 4. Alternativas consideradas

1. **Creditar o último sucesso em vez do primeiro.** Troca um comando arbitrário por outro: o
   último costuma ser o *retry do step original*, ainda menos relacionado à instalação. Descartada.
2. **Exigir que o comando seja "de mudança de estado".** Indecidível no geral; na prática exigiria
   uma lista de gerenciadores de pacote conhecidos — exatamente o conhecimento embutido que a
   RFC-003 existe para evitar. Descartada.
3. **Perguntar ao LLM qual comando instalou.** Reintroduz a autocertificação já descartada em
   `ADR-003` §4.1. Descartada.
4. **Não capturar quando houver mais de um `exec_command` bem-sucedido** (ambiguidade → silêncio).
   Quebraria o caminho determinístico da Sprint D, onde instalação e verificação são dois
   `exec_command` por construção. Descartada.
5. **Excluir da candidatura os comandos que são probe da própria dependência** (escolhida).

## 5. Decisão

Um comando cujo propósito é **verificar a existência da dependência D** nunca é elegível a
`fixAttempt` de D. Continua valendo tudo o mais: entre os candidatos restantes, o primeiro sucesso
depois do blocker segue sendo o escolhido, e a captura segue exigindo a evidência objetiva da
`ADR-003`.

O reconhecedor fica ao lado de quem gera esses comandos
(`probeToolCmd`/`commandExists`, `src/utils/crossPlatform.ts`): se a forma do probe mudar, gerador
e reconhecedor mudam juntos, no mesmo arquivo.

**Por que esta regra não é "mais uma heurística":** o erro dela é assimétrico. Se excluir demais,
o sistema apenas **não aprende** (silêncio — o default do projeto, `NUNCA_ADIVINHAR.md`). Ela não
tem como fazer o sistema aprender algo falso, que é o dano que motivou esta ADR. Nenhuma das
alternativas 1-3 tem essa propriedade.

## 6. Consequências

* Um goal em que o único `exec_command` bem-sucedido após o blocker é um probe deixa de capturar
  — resultado correto: não há evidência de qual comando resolveu.
* Nada muda no caminho determinístico (Sprint D): `install` e `verify_` seguem elegíveis, pois o
  `verifyCmd` de uma entrada de `KNOWN_DEPS` não é um probe de existência genérico (ex.:
  `ffmpeg -version` executa o próprio binário) — e, de todo modo, o step de instalação vem antes.
* Limite que permanece, declarado: a causalidade continua **não provada**. Esta ADR remove uma
  classe de falso-positivo observada, não estabelece que o comando creditado seja o que instalou.
  A `ADR-003` §5.5 continua valendo como limitação conhecida.
* Reversível: remover o filtro restaura o comportamento anterior. Sem mudança de esquema.
## 7. Estado da validação (04/08/2026)

* **Unitário/regressão: feito.** `S142` ganhou 4 casos (37 → 44), incluindo a string de comando
  exata que o LLM produziu no mundo real (`where sprintg-tool3 || echo "NOT FOUND"`), o caso de
  silêncio (só probe como candidato), o caso `winget install yq && where yq` (instalar-e-conferir
  continua elegível — o que decide é o que a linha começa fazendo) e o caso de probe de outra
  dependência. Suíte completa: 185/186 (a falha é `S37`, ambiente).
* **Execução real: NÃO reexercitada.** Três tentativas de reproduzir a condição do defeito (probe
  bem-sucedido entre o blocker e a correção) com LLM real falharam — não por erro do sistema, mas
  porque o LLM não repetiu a sequência: numa rodada criou o arquivo antes de tentar o comando
  (sem blocker `missing_tool`, nada a capturar); noutra travou no retry do comando ausente sem
  chegar a corrigir; noutra não gerou blocker de dependência. A condição que dispara a guarda
  apareceu espontaneamente **uma vez** (a rodada que expôs o defeito) e não voltou.
* **Consequência declarada:** a `ADR-004` está coberta por teste determinístico, não por
  observação em execução real. Isso é mais fraco que o padrão da Validação Progressiva (etapa 4) e
  fica registrado como tal — não como etapa cumprida. O defeito que ela corrige, esse sim, foi
  observado em execução real (§2). Se a condição reaparecer numa verificação futura, é o momento
  de confirmar.
