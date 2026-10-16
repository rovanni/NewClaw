# ADR-021 — Catálogo de ferramentas com carregamento sob demanda

Status: **aceita** (16/10/2026, "Sim. Pode fazer tudo. Divida em sprints!"). Fase 1 implementada (ver "Implementação").

## Contexto em uma frase

O agente recebia, a cada turno, só as ferramentas que uma **tabela fixa no código** escolhia pela categoria do pedido — e quando a
tabela errava, a ferramenta certa simplesmente não existia para ele.

## Fase 1 — Compreensão

**Incidente (Windows, 15/10/2026, 23:46):** pedido "Consegue passar os próximos feriados do documento [PDF do calendário]?". O roteador
classificou como `vision`; `AgentLoop.buildToolDefs` montou a lista pela tabela `CATEGORY_TOOLS` + skill preferida: 9 de 22
ferramentas — **sem `read_document` e sem `exec_command`**. O agente tentou `read` (texto puro) no PDF, procurou arquivos de uma
tentativa anterior e respondeu que não conseguia ler o documento. A correção da leitura de PDF (S410) estava no ar e não pôde ser
usada: a ferramenta não foi oferecida.

**Medição nos registros reais (Windows):** em ~450 de ~460 turnos o agente recebeu de 9 a 13 das 22 ferramentas; só 11 receberam
todas. A restrição é a regra, não a exceção.

**Custo medido:** nas últimas 400 chamadas do agente, a diferença entre o prompt estimado (mensagens) e o processado pelo servidor
foi de ~4.100 tokens — as definições das ~11 ferramentas enviadas (com parâmetros). Enviar as 22 sempre custaria ~8 mil tokens por
chamada (+35% sobre ~11,3 mil). A lista do painel (`/api/tools`) não traz parâmetros e subestimava o custo (~1.800).

**Como funciona hoje:** `buildToolDefs(intent)` → `CORE_TOOLS` (8 sempre) + `CATEGORY_TOOLS[categoria]` + `preferredTools` da skill;
categoria desconhecida ou confiança < 0,65 → todas. A lista é um array montado em `setupTurn` e passado a cada chamada do turno —
pode crescer no meio do turno sem refazer nada. Os passos de um goal rodam como sub-turnos do `AgentLoop` com um `ChannelContext`
montado por passo em `GoalExecutionLoop`.

**Decisões relacionadas:** Princípio da Preservação do Raciocínio (componente determinístico entrega fatos, não decide pelo LLM,
exceto por segurança); Informação Completa para Decidir; regra 11 do AGENTS.md (medir, sem receita no código). A segurança das
ferramentas perigosas (`exec_command`, `ssh_exec`) é do modo de operação e da aprovação (ADR-005) — não de esconder a ferramenta.

## Fase 2 — Crítica

- **A tabela decide pelo modelo sem motivo de segurança** — viola a Preservação do Raciocínio. E é uma receita fixa (regra 11):
  envelhece a cada ferramenta nova.
- **Mandar todas sempre** resolve a omissão mas custa ~4 mil tokens a mais por chamada, inclusive num "oi".
- **Árvore de categorias navegada pelo modelo** (proposta da usuária, "painel de controle"): cada nível é uma chamada a mais, e cada
  chamada reenvia o contexto inteiro (~11,3 mil tokens) — com 22 ferramentas, abrir dois níveis custa ~90× o catálogo plano (~250
  tokens). Só compensa com centenas de ferramentas.
- **Cache de prefixo:** as definições de ferramentas ficam no começo do prompt. Trocar o conjunto a cada turno quebra o cache do
  servidor (medido em 15/10: a 2ª chamada com o mesmo texto de 108 mil tokens foi 4–5× mais rápida no Ollama Cloud). O conjunto deve
  ser estável dentro do goal e só crescer quando o agente pedir.
- **Risco:** modelos menores podem não usar bem uma meta-ferramenta. Por isso a seleção atual fica como base (nada piora quando ele
  não pede), e o uso é medido.

## Fase 3 — Alternativas

| | Todas sempre | Tabela fixa (hoje) | **Catálogo + sob demanda** |
|---|---|---|---|
| Tokens de ferramentas/chamada | ~8 mil | ~4 mil | ~4 mil + o catálogo (~250–600) |
| O agente sabe que a ferramenta existe | sim | não | sim |
| Pode usar qualquer ferramenta | sim | não | sim (+1 volta, rara) |
| Quem decide | modelo | código | modelo |
| Tabela para manter | não | sim | só como dica de economia |

Árvore hierárquica: descartada agora (custo de voltas); prevista para quando o catálogo crescer (ver Fase 4, item 5).

**Gate Extensão antes de Criação:** nenhuma Tool, Skill ou Script novo. A "meta-ferramenta" não é um `ToolExecutor` registrado —
é uma definição montada pelo `AgentLoop` e interceptada por ele (mesmo padrão do envio adiado de `send_document`).

## Fase 4 — Proposta

1. **Catálogo gerado do registro**, sem tabela: para cada ferramenta registrada que NÃO está na lista do turno, uma linha com o
   nome e a primeira frase da própria descrição (resumo declarado — a definição completa vem ao carregar).
2. **Meta-ferramenta `carregar_ferramenta({ nomes })`**: só existe no turno quando há ferramentas fora da lista; a descrição dela
   traz o catálogo. Chamada pelo agente → o `AgentLoop` valida que os nomes existem, acrescenta as definições completas à lista do
   turno e responde quais foram carregadas (e quais não existem). Disponíveis a partir da próxima resposta do modelo.
3. **Carregada fica carregada:** as ferramentas carregadas num passo de um goal continuam na lista dos passos seguintes do mesmo goal
   (memória do goal, em processo; um reinício só custa pedir de novo).
4. **A seleção atual vira dica de economia**, não proibição. A troca dela pelo próprio roteador (que já é uma chamada ao modelo)
   escolhendo pelo catálogo fica para depois de medir quantas vezes `carregar_ferramenta` é usada: se o agente pede muito, a seleção
   está ruim e vale trocá-la; se quase nunca, a economia atual basta.
5. **Árvore hierárquica:** quando o catálogo passar do custo de uma volta extra (tamanho do catálogo em tokens > tamanho típico de uma
   chamada do agente, ambos medidos), as categorias passam a abrir sob demanda. Não implementado agora — nada a medir com 22.

## Fase 5 — Validação

- É baseada em evidência real (incidente das 23:46 e medição de 460 turnos)? Sim.
- Resolve a causa (ferramenta inexistente para o agente) e não o sintoma? Sim.
- Reduz complexidade? Remove a proibição; a tabela continua só como dica até ser medida.
- Mantém o Cognitive Kernel e a Preservação do Raciocínio? Sim — o código entrega o catálogo (fato), o modelo decide.
- Incremental e reversível? Sim: sem a meta-ferramenta, o comportamento é o de hoje.

**Critérios de sucesso:** teste de regressão (catálogo gerado do registro; carregar acrescenta a definição completa; nome inexistente
é recusado; carregada persiste no goal) e validação real: o pedido dos feriados com o PDF chega a usar `read_document`.

## Implementação e resultados das sprints (16/10/2026)

- **Sprint 2 — catálogo + sob demanda:** `AgentLoop.buildToolDefs` (seleção vira dica; catálogo de uma linha na meta-ferramenta
  `carregar_ferramenta`, gerado de `definicaoDoCatalogo(registro, naLista)`), interceptação nos dois caminhos de chamada (nativo e
  ação em JSON), `carregarFerramentas` (valida, acrescenta a definição completa, atualiza o catálogo, registra
  `[TOOLS] carregar_ferramenta pedidas=… carregadas=… inexistentes=…` — a medição do item 4), `ChannelContext.ferramentasCarregadas`
  e `GoalExecutionLoop.ferramentasCarregadasDoGoal` (mesmo conjunto em todos os passos). Teste `S413`.
- **Sprint 3 — dicas sem receita:** os três avisos de leitura binária ("use exec_command com pdftotext/pandoc/python-pptx") passam a
  dizer o fato e apontar `read_document` quando ela lê o formato (`tools/formatosDeDocumento.ts`, fonte única). Teste `S414`.
  Fora do escopo, anotado: a tabela de alternativas de `PromptComposer` (`pandoc: ['python-pptx', 'pptxgenjs', 'html']`) é do mesmo
  tipo (regra 11) e merece revisão própria.
- **Sprint 4 — cache medido nos registros (sem cota):** tempo até o 1º pedaço da resposta, por mil tokens de prompt, chamadas que
  continuam a anterior × chamadas frias: glm-5.3-flash:cloud 165 × 296 ms (−44%; prompts das continuações ~2× maiores e ainda assim
  respondendo antes), glm-5.3:cloud 317 × 412 (−23%), glm-5.2:cloud 188 × 233 (−19%), gemma4 local 342 × 409 (−16%). Sinal
  consistente de reaproveitamento do prefixo; parte do tempo é fixa (rede, fila), então o número é aproximado. O efeito na COTA do
  Ollama Cloud não é informado por chamada — continua desconhecido.
- **Sprint 5 — "memória velha":** os nomes de arquivo que o agente procurou (`calendario_uenp_2026_texto.txt`) vieram do HISTÓRICO
  da conversa (scripts da tentativa anterior, que falharam antes de gravar), não do banco de memória; o agente conferiu se existiam
  (duas leituras rápidas) antes de refazer — comportamento razoável. O caminho `-p\…` veio de uma pasta `-p` de verdade no
  workspace (sobra de um `mkdir -p` de julho), removida para a Lixeira. Nada a corrigir.
- **Sprint 6 — árvore hierárquica:** não implementada; critério por medição no item 5 da Fase 4, **medido a cada turno** no log
  `[TOOLS-CATALOGO] completas=… completas_chars=… fora_da_lista=… catalogo_chars=… contexto_chars=… arvore_compensaria=…` (pedido da
  usuária: "senão não tem como a gente medir e comparar"). `arvore_compensaria=true` aparecendo com frequência = hora de implementá-la.
