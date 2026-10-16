# ADR-022 — A ferramenta consertada não herda as falhas da versão anterior

Data: 16/10/2026. Status: implementada (`S418`).

## Fase 1 — Compreensão

**Evidência 1 (Windows, 15/10/2026).** Depois do conserto do `read_document` (d2705e8: PDF lido pelo Python que de fato
funciona), o planejador escreveu: "read_document tem 100% de falha histórica". E evitou a ferramenta. Todas as falhas
contadas eram da versão de **antes** do conserto.

**Evidência 2 (Windows, 16/10/2026, `goal_1792128547107_ogo6t`).** O `npm install` foi cortado pelo prazo do
`exec_command` e a ReflectionMemory gravou isso como falha do `exec_command`. É a mesma estatística que alimenta o
`[BLOCK-HINT]` "exec_command com 100% de falha histórica" (`RiskAnalyzer`) e as restrições duras
(`findHardConstraints`, ≥ 90%). Na mesma campanha, o `exec_command` mudou de código (S415).

**Causa raiz.** A pergunta "esta ferramenta costuma falhar?" agrupa por `tool_used` numa janela de 7 dias, sem saber
**qual código** falhou. Um registro de falha é evidência sobre o código que rodou naquele momento. Apresentá-lo como fato
sobre o código atual é um fato falso entregue ao planejador. Isso viola `NUNCA_ADIVINHAR.md` e
`INFORMACAO_COMPLETA_PARA_DECIDIR.md`.

## Fase 2 — Crítica da hipótese

- **"Mudou o código" não prova "a falha sumiu".** Correto, e a decisão não diz que sumiu. Ela diz que não há evidência
  sobre a versão nova. A versão nova reaprende com 2 falhas: o limite das consultas segue `total >= 2`.
- **Falhas do ambiente, não da ferramenta** (ex.: PEP 668). Também se perdem numa troca de versão. O custo é 2 falhas
  para reaprender. Os fatos de ambiente hoje são **medidos** (sondas, regra 11) e não dependem desta estatística.
- **Versão escrita à mão.** Descartada: alguém esquece de subir o número, e é "receita no código". A versão é **medida**:
  hash do arquivo do módulo que exporta a classe da ferramenta. É o arquivo realmente carregado (.ts ou .js compilado).
- **Dependências fora do arquivo da ferramenta** (um helper em outro módulo) não mudam a versão. É uma limitação
  aceita: o arquivo da ferramenta é a melhor fronteira medível sem um grafo de dependências. A falha de um helper
  continua contando até a ferramenta mudar.

## Fase 3 — Alternativas

- (a) Versão global do app (commit/pacote). Descartada: toda atualização apagaria o aprendizado de todas as ferramentas,
  inclusive das que não mudaram.
- (b) Apagar as anotações da ferramenta no deploy. Descartada: destrói dado. O histórico continua no banco para relatório
  (`getTopFailurePatterns`) e auditoria.
- (c) Mostrar as falhas antigas marcadas como "de versão anterior". Descartada por ora: o texto é lido por regex
  (`compressReflection`), e a restrição dura (≥ 90%) decide sem LLM. Somar evidência de outro código ali é justamente o
  defeito.
- (d) **Coluna `tool_version` e consultas por ferramenta restritas à versão atual.** Escolhida.

Gate de extensão: nenhum arquivo novo. `ToolRegistry` (quem conhece as ferramentas) ganha `versao(nome)`, e a
`ReflectionMemory` ganha uma coluna e um filtro.

## Fase 4 — Decisão

- `ToolRegistry.versao(nome)`: o hash (sha256, 12 caracteres) do arquivo do módulo que exporta a classe, memorizado por
  processo. Sem achar o módulo, vale o hash do texto da classe ou da função. Ferramenta inexistente: `undefined`.
- `ReflectionMemory.record()` grava `tool_version`.
- `findToolFailures` e `findHardConstraints` (e `findBlockerLessons` com ferramenta) contam só os registros da versão
  atual. Isso vale também para `top_fix`, o tipo de falha recente e o padrão recente.
- Sem versão medida (ferramenta não registrada, `agentloop`, testes antigos): nada é filtrado, como antes.
- Registros antigos (sem versão) **não** valem para uma ferramenta com versão medida. Não se sabe de que código eram.

## Fase 5 — Validação

- Baseada em duas evidências reais.
- Elimina a classe inteira "conserto não reconhecido pelo aprendizado", não só o caso do `read_document`.
- Incremental, coluna anulável. Reverte removendo o filtro `@versao`.
- Não decide pelo planejador: entrega a estatística certa, sobre o código certo.
- Cobertura: `S418`, real `better-sqlite3` em memória. `S16` passa inalterado.
- **Hipótese não comprovada:** a frequência com que ferramentas mudam de versão faz o reaprendizado custar pouco. Medir
  com o log `[REFLECT]` depois de algumas atualizações.
