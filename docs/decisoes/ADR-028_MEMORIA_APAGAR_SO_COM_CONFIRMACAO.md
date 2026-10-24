# ADR-028 — Apagar memória só com confirmação; o que mudou sempre chega à dona

Data: 23/10/2026. Status: **aceita** pela operadora ("apagar e mesclar nós só com minha confirmação, e sempre me contar o
que foi mudado, mesmo se a resposta for bloqueada"). Emenda a ADR-005 (o portão de ação perigosa).

## Fase 1 — Compreensão

**O incidente** (produção Windows, conversa `conv_1792797811212`, 23/10/2026 20:32–20:41). Pedido: "Consegue verificar sua
memória se possui dados, informações inúteis?". O agente leu a memória (estatísticas, órfãos, duplicatas, nós vazios, 8
inspeções) e, **sem perguntar**, mesclou 2 pares, atualizou 2 nós, criou 2 ligações e apagou `pref_workspace`. O juiz de
qualidade aprovou; o de sustentação marcou NÃO AVALIÁVEL (10 de 11 afirmações sustentadas, uma periférica — "criados 1 segundo
apartados" — não); a resposta parcial foi recusada na revalidação, e **a resposta inteira foi trocada pelo aviso de
bloqueio**. A dona nunca soube de nenhuma das mudanças. O conteúdo apagado (backup de 11/08): "Workspace principal do NewClaw
em /newclaw/workspace" — perda pequena, `core_workspace` continua; o problema é o mecanismo.

**Por que o portão não pegou:** `ToolRegistry.requiresAuthorization()` (ADR-005) é o ponto único, mas só olha a flag
`dangerous` (as ferramentas de memória não têm) e cede a `auto_approve_exec`, ligado em DEVELOPER e GOD — as duas produções
rodam em GOD. Além disso, `memory_admin cleanup` apaga nós em lote pelo mesmo caminho livre.

**Por que as mudanças sumiram:** o aviso de bloqueio (`groundingBlockedMessage`) é texto fixo sobre as afirmações; nada no
turno registrava "o que mudou" como fato separado da prosa do modelo.

## Fase 2 — Crítica

- **GOD não deveria pular tudo?** A Diretriz diz que o sistema não tira a autonomia final de quem escolheu mais risco. Aqui
  é a própria operadora quem escolhe: `auto_approve_exec` é sobre comandos; a memória é dela, e ela pediu confirmação em
  qualquer modo. Por isso a regra não passa pelo modo.
- **Uma lista fixa de ações perigosas no portão** ("memory_write + delete") seria receita espalhada: a próxima ferramenta que
  apaga algo ficaria de fora. Só a ferramenta sabe o que uma chamada remove — e o nome do que remove.
- **Perguntar demais:** criar, atualizar e ler não perguntam (ela pediu apagar e mesclar). Chamada que a execução vai recusar
  (nó inexistente ou protegido) também não — seria pedir confirmação para nada.
- **Uma confirmação por ação:** a aprovação executa só a ação aprovada e encerra (fluxo da ADR-005); uma limpeza com três
  ações pede três vezes. `merge` aceita vários nós numa chamada, e `cleanup` mostra a lista inteira numa só.
- **A lista "o que mudou" escrita pelo modelo** poderia ser bloqueada pelo mesmo juiz. Precisa ser fato do sistema, anexado
  **depois** do juiz.

## Fase 3 — Alternativas

1. **Marcar `memory_write`/`memory_admin` como `dangerous`.** Pergunta até para criar e ler, e GOD continua pulando.
   Descartada.
2. **Regra no `AgentLoop`.** Deixaria de fora o passo de objetivo e o caminho do atalho — exatamente a divergência que a
   ADR-005 eliminou. Descartada.
3. **(escolhida) A ferramenta declara; o portão único consulta.** `ToolExecutor.confirmacaoDoDono(args)` devolve o que a
   chamada apagaria (ou `null`); `ToolRegistry.requiresAuthorization()` pergunta isso antes do modo. O que mudou volta no
   próprio resultado (`ToolResult.alteracao`), escrito no instante da mudança — depois de apagar, só a ferramenta ainda sabe o
   nome do que apagou.

Gate de extensão antes de criação: nenhum arquivo novo de código. Estende `ToolExecutor`/`ToolResult` (campos opcionais, no
padrão de `requiredArgsHint` e `deliveryFacts`), o `ToolRegistry`, o `AuthorizationManager` e o `run()` do `AgentLoop`.
`descreverNo` mora em `MemoryFacade`, ao lado de `isProtectedNode`, que as duas ferramentas já usam.

## Fase 4 — Decisão

1. **Portão** (`ToolRegistry.requiresAuthorization`): se a ferramenta diz que a chamada apaga dado do usuário, pede
   confirmação **em todos os modos**. Falha ao descrever fecha o portão (pergunta com descrição genérica). A descrição é
   mascarada como a saída da execução (ADR-019).
2. **Quem declara:** `memory_write` (`delete`; `merge`, que apaga os nós absorvidos) e `memory_admin` (`cleanup`). A seleção
   do que a limpeza remove virou `MemoryGraphRepository.nosParaLimpeza()`, usada pela confirmação **e** pela execução — o que
   ela vê é o que sai.
3. **O pedido** (`AuthorizationManager.formatRequest` e o cartão do painel, `GET /api/chat/active`): nome, tipo e o começo
   do conteúdo de cada nó; no merge, o que fica e o que sai; aviso de que só volta restaurando um backup.
4. **O que mudou:** cada ação de memória preenche `ToolResult.alteracao` (pelo nome). O `AgentLoop` guarda no estado do
   turno e o `run()` anexa "📝 O que foi alterado neste turno" a **qualquer** resposta — a normal, a bloqueada pelo juiz, o
   pedido de confirmação. A resposta da aprovação (`resumeFromWorkflow`) traz o que a ação aprovada mudou. Fica de fora o
   passo de objetivo (o texto dele é material do objetivo) e a recusa de turno concorrente.

## Fase 5 — Validação

- Evidência real: o incidente acima (log de auditoria do Windows, 23/10 20:32–20:41).
- Estrutural: troca a pergunta do portão de "esta ferramenta é perigosa neste modo?" para também "esta chamada apaga dado
  dela?", respondida por quem sabe.
- Teste: `S448` (todos os modos, texto do pedido, aprovação e recusa, recibo, lista no `run()`, cartão do painel).
- Reversível por commit.

**Riscos e pendências (registrados, não resolvidos aqui):**
- **Protocolo de ação em JSON** (modelos sem chamada nativa de ferramenta): o portão no `ProactiveRecovery` recusa em vez de
  pedir confirmação — falha fechada, mas sem botões. Já valia para `exec_command` em SAFE. Os turnos reais usam o caminho
  nativo (`[TOOL]` no log).
- **Objetivo:** a confirmação vale (o passo para em `needs_auth`), mas a lista "o que mudou" de cada passo não chega à
  mensagem final do objetivo. Próximo passo.
- **`update` sobrescreve o conteúdo** sem guardar o anterior; não pede confirmação (fora do pedido). A lista mostra o texto
  novo.
- **Texto em pt-BR:** fixo do Core, mesmo débito de idioma do relato de progresso (ADR-027).
- **Inconsistência anterior:** `memory_admin cleanup` protege `pref_*`, `memory_write delete` não — foi assim que
  `pref_workspace` saiu. Com a confirmação, quem decide é a dona; a proteção não foi unificada aqui.
