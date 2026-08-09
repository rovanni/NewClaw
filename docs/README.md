# NewClaw — Documentação Técnica

Índice da documentação interna do projeto. Reorganizado em 2026-07-26 (histórico completo dessa
reorganização: [analises-arquiteturais/DOCUMENTATION_AUDIT_REPORT.md](./analises-arquiteturais/DOCUMENTATION_AUDIT_REPORT.md)
e [refatoracao-arquitetural-2026/PLANO_REORGANIZACAO_DOCUMENTAL.md](./refatoracao-arquitetural-2026/PLANO_REORGANIZACAO_DOCUMENTAL.md)
— este é o terceiro esforço de organização documental do projeto; se `docs/` voltar a ficar
bagunçado, comece lendo esses dois antes de propor uma estrutura nova).

**Nota:** parte de `docs/` é pública (rastreada pelo git, o que você vê aqui) e parte é privada
(local, nunca commitada — `docs/Auditorias/`, `docs/melhorias/`, `docs/issues/`, `docs/task.md`,
`docs/plano-correcao-bugs.md`, ver `.gitignore` linha 8). Este índice cobre as duas, mas só a
parte pública está em `git log`.

---

## Comece aqui

- [ARCHITECTURE.md](./ARCHITECTURE.md) — arquitetura de canais do NewClaw (Core vs. ChannelAdapters), carregado automaticamente pelo `CLAUDE.md`
- [DIRETRIZ_ARQUITETURA_2026-07-13.md](./DIRETRIZ_ARQUITETURA_2026-07-13.md) — processo obrigatório de 5 fases + Validação Progressiva para qualquer mudança arquitetural, carregado automaticamente pelo `CLAUDE.md`
- **[CONVENCOES_DOCUMENTAIS.md](./CONVENCOES_DOCUMENTAIS.md)** — onde colocar um documento novo em `docs/`. Consulte **antes** de criar um arquivo aqui — é o que faltou nas duas reorganizações anteriores.
- [ROADMAP.md](./ROADMAP.md) — roadmap estratégico do projeto
- [walkthrough.md](./walkthrough.md) — walkthrough da evolução da memória cognitiva

## Como encontrar algo aqui sem procurar à mão

Esta documentação passou de 160 arquivos. Achar "qual norma se aplica a X" lendo pasta por pasta
não escala, e foi assim que dois índices divergiram sem ninguém notar.

Existe um grafo semântico do repositório — nós são arquivos e diretórios, arestas são citações
reais entre documentos — construído pela ferramenta externa **cognitive-graph-builder**
(Python 3.10+, sem dependências, sem rede). Ela não faz parte do NewClaw e não é instalada com
ele: obtenha o repositório dela separadamente e aponte a variável `OPENCLAW_WORKSPACE` para a
raiz deste projeto.

```bash
# Construir ou reconstruir (leva menos de um minuto)
OPENCLAW_WORKSPACE=/caminho/para/newclaw python /caminho/para/cognitive-graph-builder/scripts/cognitive_graph_builder.py --all

# Onde mora a norma sobre X? (busca por tema, não pelo nome do arquivo)
OPENCLAW_WORKSPACE=/caminho/para/newclaw python .../cognitive_graph_builder.py --query "nunca adivinhar"

# Que normas a Diretriz cita, e quem cita este documento?
OPENCLAW_WORKSPACE=/caminho/para/newclaw python .../cognitive_graph_builder.py --related "docs/DIRETRIZ_ARQUITETURA_2026-07-13.md"
```

No Windows PowerShell, `$env:OPENCLAW_WORKSPACE = "<caminho>"` antes do comando.

`--query` e `--related` são somente leitura. `--related` é a mais útil das duas para norma: mostra
o que um documento cita **e quem o cita** — é como se descobre que um princípio recém-escrito
ainda não é alcançável a partir do índice.

O grafo fica em `system/graph/cognitive_graph.json` e os backups em `backups/GRAPH/`. Os dois são
**artefato derivado**, ignorados pelo git (`.gitignore`): reconstruíveis a qualquer momento com
`--all`, e embutem os caminhos absolutos da máquina que os gerou — não entram no repositório
público. Duas limitações que valem saber antes de confiar na resposta: o grafo é um **retrato**
(depois de mexer em documento, reconstrua, ou ele responde sobre o estado antigo) e indexa
**nomes, caminhos e estrutura, não significado** — ele diz onde a norma está e como ela se conecta,
não substitui lê-la.

## Princípios arquiteturais normativos — `ARCHITECTURE/`

Documentos que a Diretriz cita como leitura obrigatória antes de propor componentes novos de
conhecimento ou decisão:

- [ARCHITECTURE/EVIDENCE_PROVIDER_PATTERN.md](./ARCHITECTURE/EVIDENCE_PROVIDER_PATTERN.md) — componentes de conhecimento produzem texto para o Planner ponderar, nunca decidem por ele
- [ARCHITECTURE/SEPARACAO_DISTRIBUIDO_APRENDIDO.md](./ARCHITECTURE/SEPARACAO_DISTRIBUIDO_APRENDIDO.md) — conhecimento versionado em código vs. aprendido em runtime são categorias físicas distintas
- [ARCHITECTURE/NUNCA_ADIVINHAR.md](./ARCHITECTURE/NUNCA_ADIVINHAR.md) — diante de um dado não observado, reportar ausência, nunca inferir
- [ARCHITECTURE/PIPELINE_CURADORIA_DEPENDENCIAS.md](./ARCHITECTURE/PIPELINE_CURADORIA_DEPENDENCIAS.md) — processo pelo qual conhecimento de instalação entra em `KNOWN_DEPS`
- [ARCHITECTURE/README.md](./ARCHITECTURE/README.md) + `architecture.json`/`dependency-graph.json`/`metrics.json`/`index.html` — snapshot gerado da arquitetura do repositório (Architecture Knowledge Base)

## Decisões formais — `decisoes/`

ADRs (Architecture Decision Record) e RFCs (Request for Comments) — decisões pontuais registradas
formalmente, distintas de um programa inteiro de Sprints:

- [decisoes/ADR-001_BASELINE_ARQUITETURAL.md](./decisoes/ADR-001_BASELINE_ARQUITETURAL.md)
- [decisoes/ADR-002_SERVIDOR_MODELO_LOCAL.md](./decisoes/ADR-002_SERVIDOR_MODELO_LOCAL.md)
- [decisoes/ADR-003_APRENDIZADO_POR_EVIDENCIA_DE_AMBIENTE.md](./decisoes/ADR-003_APRENDIZADO_POR_EVIDENCIA_DE_AMBIENTE.md) — decisão de 03/08/2026, implementada; pendente a Sprint G (validação em execução real)
- [decisoes/ADR-004_SELECAO_DO_COMANDO_APRENDIDO.md](./decisoes/ADR-004_SELECAO_DO_COMANDO_APRENDIDO.md) — escopo estreito: um probe (`where X`) não pode ser eleito "comando que resolveu X"
- [decisoes/RFC-001_APRENDIZADO_OPERACIONAL.md](./decisoes/RFC-001_APRENDIZADO_OPERACIONAL.md)
- [decisoes/RFC-002_ATIVACAO_CASEMEMORY.md](./decisoes/RFC-002_ATIVACAO_CASEMEMORY.md)
- [decisoes/RFC-003_AQUISICAO_CONHECIMENTO_OPERACIONAL.md](./decisoes/RFC-003_AQUISICAO_CONHECIMENTO_OPERACIONAL.md)
- [decisoes/DECISAO_CANAL_UPDATE_UX_2026-07-13.md](./decisoes/DECISAO_CANAL_UPDATE_UX_2026-07-13.md)

## Análises arquiteturais avulsas — `analises-arquiteturais/`

Documentos que seguem o processo formal da Diretriz (Fases 1-5) para uma mudança específica, sem
constituir um programa de Sprints inteiro — inclui as auditorias que motivaram este próprio
reorganização de `docs/`:

- [analises-arquiteturais/ANALISE_ARQUITETURAL_MODEL_REGISTRY_2026-07-22.md](./analises-arquiteturais/ANALISE_ARQUITETURAL_MODEL_REGISTRY_2026-07-22.md) — redesign do Model Registry & Discovery
- [analises-arquiteturais/INVESTIGACAO_TOOL_DEDUP_2026-07-13.md](./analises-arquiteturais/INVESTIGACAO_TOOL_DEDUP_2026-07-13.md) — loop de repetição pós-entrega diferida
- [analises-arquiteturais/AUDITORIA_ADVERSARIAL_2026-07-12.md](./analises-arquiteturais/AUDITORIA_ADVERSARIAL_2026-07-12.md) + [PLANO_SPRINTS_CORRECAO_2026-07-12.md](./analises-arquiteturais/PLANO_SPRINTS_CORRECAO_2026-07-12.md) — auditoria adversarial do codebase + plano de sprints de correção
- [analises-arquiteturais/DOCUMENTATION_AUDIT_REPORT.md](./analises-arquiteturais/DOCUMENTATION_AUDIT_REPORT.md) — primeira auditoria de organização documental (2026-06-01)

## Programa Sprints R1-R7 — `sprints-r1-r7-2026-07-13/`

O programa que originou a própria `DIRETRIZ_ARQUITETURA_2026-07-13.md` (pipeline de artefatos +
cognitive envelope). Ordem de leitura: R1 (auditoria) → R2 (cognitive envelope) → R3 (validação
Fase 5) → R4 (revisão final) → R5 → R6 → R7.

- [sprints-r1-r7-2026-07-13/AUDITORIA_PIPELINE_ARTEFATOS_SPRINT_R1_2026-07-13.md](./sprints-r1-r7-2026-07-13/AUDITORIA_PIPELINE_ARTEFATOS_SPRINT_R1_2026-07-13.md)
- [sprints-r1-r7-2026-07-13/ANALISE_ARQUITETURAL_COGNITIVE_ENVELOPE_SPRINT_R2_2026-07-13.md](./sprints-r1-r7-2026-07-13/ANALISE_ARQUITETURAL_COGNITIVE_ENVELOPE_SPRINT_R2_2026-07-13.md)
- [sprints-r1-r7-2026-07-13/VALIDACAO_FASE5_ARTIFACTTRACE_SPRINT_R3_2026-07-13.md](./sprints-r1-r7-2026-07-13/VALIDACAO_FASE5_ARTIFACTTRACE_SPRINT_R3_2026-07-13.md)
- [sprints-r1-r7-2026-07-13/REVISAO_ARQUITETURAL_FINAL_SPRINT_R4_2026-07-13.md](./sprints-r1-r7-2026-07-13/REVISAO_ARQUITETURAL_FINAL_SPRINT_R4_2026-07-13.md)
- [sprints-r1-r7-2026-07-13/REVISAO_ARQUITETURAL_SPRINT_R5_2026-07-13.md](./sprints-r1-r7-2026-07-13/REVISAO_ARQUITETURAL_SPRINT_R5_2026-07-13.md)
- [sprints-r1-r7-2026-07-13/REVISAO_ARQUITETURAL_SPRINT_R6_2026-07-13.md](./sprints-r1-r7-2026-07-13/REVISAO_ARQUITETURAL_SPRINT_R6_2026-07-13.md)
- [sprints-r1-r7-2026-07-13/REVISAO_ARQUITETURAL_SPRINT_R7_2026-07-13.md](./sprints-r1-r7-2026-07-13/REVISAO_ARQUITETURAL_SPRINT_R7_2026-07-13.md)

## Programa de Refatoração Arquitetural (2026) — `refatoracao-arquitetural-2026/`

Concluído em 2026-07-18, 27 Sprints (ARCH-001 a ARCH-026) + 5 Checkpoints. **Comece por
[refatoracao-arquitetural-2026/README.md](./refatoracao-arquitetural-2026/README.md)** — é o
índice do próprio programa (resultado final, guia de leitura, lições).

- `ARCHITECTURAL_BACKLOG.md` — o quê/por quê de cada uma das 26 mudanças
- `MASTER_EXECUTION_PLAN.md` — índice/dashboard operacional
- `SPRINTS/` (27 arquivos) — uma Sprint por arquivo
- `CHECKPOINTS/` (5 arquivos)
- `METRICAS.md` — tabela comparável de todas as Sprints
- `RETROSPECTIVA_PREMISSAS_AUDITORIA.md` / `DEPENDENCIAS_ORDEM_IMPLICITA.md` / `EXECUCAO_DECISOES_DE_DESIGN.md` — catálogos cumulativos de conhecimento
- `RFC_ARCH-012_UnifiedDeliveryProof.md`, `RFC_ARCH-015_SchemaGeneratedRequiredArgs.md`, `RFC_ARCH-024_DeliveryTrackingContext.md` — RFCs específicas do programa
- `REVISAO_CONSOLIDADA_TIPOS_PENDENTE.md`, `PLANO_REORGANIZACAO_DOCUMENTAL.md` — auxiliares

## Skills — `skills/`

- [skills/SKILL_SYSTEM_ARCHITECTURE.md](./skills/SKILL_SYSTEM_ARCHITECTURE.md) — arquitetura completa do sistema de Skills
- [skills/CURRENT_STATE.md](./skills/CURRENT_STATE.md) — estado atual: fluxos, lacunas, duplicações
- [skills/SKILL_DISCOVERY_PROPOSAL.md](./skills/SKILL_DISCOVERY_PROPOSAL.md) — proposta arquitetural de Skill Discovery

## Sprints & Implementações — `sprints/`

Relatórios de implementação de Sprints numeradas (3.6, 3.7A/B, validações operacionais):

- [sprints/SPRINT_006_VALIDACAO_OPERACIONAL_REPORT.md](./sprints/SPRINT_006_VALIDACAO_OPERACIONAL_REPORT.md)
- [sprints/SPRINT_3_6_IMPLEMENTATION_REPORT.md](./sprints/SPRINT_3_6_IMPLEMENTATION_REPORT.md)
- [sprints/SPRINT_3_6D_EXECUTION_INTEGRITY.md](./sprints/SPRINT_3_6D_EXECUTION_INTEGRITY.md)
- [sprints/SPRINT_3_7A_IMPLEMENTATION_REPORT.md](./sprints/SPRINT_3_7A_IMPLEMENTATION_REPORT.md)
- [sprints/SPRINT_3_7B_IMPLEMENTATION_REPORT.md](./sprints/SPRINT_3_7B_IMPLEMENTATION_REPORT.md)

## Issues técnicas — `issues/`

Convenção do projeto inteiro (não de um programa específico): `docs/issues/{NNN}-{kebab-case}.md`,
achados fora do escopo da Sprint atual, registrados para correção futura.

**Estado misto, achado nesta reorganização (2026-07-26):** `docs/issues/` está no `.gitignore`,
mas 6 arquivos (`001`, `002`, `008`, `009`, `010`, `011`) foram commitados *antes* dessa regra
existir (21/05/2026) e continuam públicos — `.gitignore` só bloqueia arquivos NOVOS, nunca
"destrackeia" o que já foi commitado. Os outros 16 itens (`003`-`007`, `012`-`016`, e toda a
subpasta [issues/seguranca-codeql-2026-07-20/](./issues/seguranca-codeql-2026-07-20/)) são locais,
mesma pasta, mesma convenção de nome — não dá para saber pelo nome do arquivo se é público sem
rodar `git ls-files`. Não decidi nada sobre isso (nem tornar os 16 públicos, nem "consertar" os
6 já públicos) — é uma escolha deliberada sobre o que vai para o GitHub público, não uma
inconsistência para eu corrigir sozinho.

---

## Área privada (local, nunca commitada — ver `.gitignore`)

Regra do `.gitignore` (linha 8, comentário original: "apenas assets, ROADMAP e walkthrough são
públicos"): `Auditorias/`, `melhorias/`, `issues/`, `task.md`, `plano-correcao-bugs.md` ficam fora
do repositório — com a ressalva de `issues/` acima (parcialmente público por herança histórica).

- `Auditorias/` — auditorias técnicas locais, subpastas `01/`, `02/`, datadas (`2026-06-28/`,
  `2026-07-26/`) — mesma convenção de subpasta-por-data/número do resto de `docs/`
- `melhorias/` — diagnósticos de performance e melhorias
- `issues/` — ver seção "Issues técnicas" acima (estado misto, não totalmente privado)
- `task.md`, `plano-correcao-bugs.md` — artefatos de trabalho históricos

Se algo aqui parecer que deveria ser público, é uma decisão a tomar deliberadamente (editar
`.gitignore`), nunca uma correção automática — o comentário original no `.gitignore`
("apenas assets, ROADMAP e walkthrough são públicos") indica que isso foi intencional.

## Assets — `assets/`

Imagens e diagramas usados no `README.md` da raiz do projeto (`banner.png`,
`architecture-flow.svg`, `install-flow.svg`, `newclaw-graph-2x.png`, `dashboard-graph.png`).
