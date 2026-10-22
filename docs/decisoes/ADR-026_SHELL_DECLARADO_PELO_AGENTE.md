# ADR-026 — O shell é declarado por quem escreve o comando

Data: 21/10/2026. Status: **proposta** — aguarda a decisão da operadora (nada implementado).
Relaciona-se à regra 9 do AGENTS.md (determinismo valida, LLM interpreta) e à regra 11 (medir; nunca escrever receitas).

## Fase 1 — Compreensão

**O problema.** No Windows, o agente escreve ora PowerShell, ora cmd, ora comandos de Unix (`grep`, `sed`, `tail`, `ls -la`).
O `exec_command` **adivinha** a linguagem e **traduz**:
- `needsPowerShellWrap` decide por regex (cmdlet Verbo-Substantivo; `powershell` explícito) se embrulha a linha no
  `powershell.exe`;
- uma pilha de traduções fixas age sobre o texto: `&&`/`||` → `; if ($?)`, `2>/dev/null` → `$null`, flags de `ls`,
  `head`/`tail`, `wc -l` (`translate*ForPowerShell`).

**Evidência (produção Windows, 01–21/10/2026):** 363 execuções, 84 falhas. Cerca de 17 (≈ 20% das falhas, ≈ 5% das
execuções) são desencontro de shell:
- ferramenta de Unix rodando no PowerShell: `grep` ×5, `sed`, `uname`, `ls -la` → `Get-ChildItem -la` ×2;
- sintaxe de PowerShell rodando no cmd: `'$h' não é reconhecido` ×2, `'Select-Object' não é reconhecido`;
- erro de análise do PowerShell (`No linha:N caractere:N`) ×5.

Histórico do mesmo tema: S409 (ambiente medido por sondas), S429 (`powershell` explícito não reembrulha), memória de 15–16/10
("shell bash no Windows (tail, &&) ainda quebra — ADR pendente"). Cada correção acrescentou uma regra; as falhas seguem nos
casos que nenhuma regra cobre.

**Causa.** Quem sabe em que linguagem o comando foi escrito é quem o escreveu. O código tenta deduzir isso do texto — uma
decisão semântica por regex (regra 9) — e corrige o texto com receitas fixas por versão de shell (regra 11).

## Fase 2 — Crítica da hipótese

- *"O ambiente medido (S409) já basta."* Não bastou: as sondas dizem quais shells existem, mas o agente não diz em qual
  escreveu, e o código segue adivinhando.
- *"Mais traduções resolvem."* Não: cada uma cobre um caso; `grep`/`sed`/`uname` não têm tradução segura.
- Risco de declarar: o modelo pode declarar errado. Hoje o erro já acontece, só que escondido pela tradução; com a declaração,
  a resposta do shell é o fato que volta ao agente, sem reinterpretação.

## Fase 3 — Alternativas

| | Como | Prós | Contras |
|---|---|---|---|
| **(a) Shell declarado** | Parâmetro `shell` no `exec_command` (`powershell`, `pwsh`, `cmd`, `bash`, `sh`), vindo da lista MEDIDA pelas sondas. Declarado → roda exatamente nele, sem tradução. Sem declarar → comportamento atual (transição). | Tira a adivinhação; erro do shell volta como fato; vale para Linux e macOS | Um campo a mais para o modelo; período de transição com dois caminhos |
| (b) Sempre PowerShell no Windows | Toda linha vai ao `powershell.exe` | Simples | Quebra o cmd que o agente escreve; mantém as traduções |
| (c) Mais regras de tradução | Acrescentar `grep`→`Select-String` etc. | Nenhuma mudança de contrato | Exatamente o que as regras 9 e 11 proíbem; nunca termina |

## Fase 4 — Recomendação: (a), em etapas

1. Parâmetro `shell` opcional; quando declarado, sem tradução; descrição da ferramenta lista os shells que as sondas mediram.
   Linha `[EXEC-SHELL] declarado=… medido=…` no log para acompanhar.
2. Período de medição: quantos comandos chegam com `shell` declarado e quantos falham por shell.
3. Com a declaração estável, as traduções `translate*ForPowerShell` e `needsPowerShellWrap` passam a valer só para chamada sem
   declaração — e são removidas quando ela deixar de acontecer.

## Fase 5 — Validação

- Baseada em evidência do projeto (contagem acima); resolve a causa (quem decide a linguagem), não o sintoma.
- Reduz complexidade ao fim da etapa 3; incremental e reversível (etapa 1 só acrescenta um caminho).
- Hipótese não comprovada: o modelo declara o shell corretamente na maioria das vezes — a etapa 2 mede.

## Decisão pendente

A operadora decide se adota (a) e autoriza a etapa 1.
