# Revisão Consolidada — Tipos Compartilhados, Fronteiras `loop/↔shared/` e Evolução de Abstrações

**Criado:** 2026-07-17, na Sprint `2026-08-S14`, por decisão explícita do usuário — em vez de
decidir isoladamente a forma final do tipo compartilhado que o ARCH-009 propunha (achado:
`docs/issues/008-arch009-extends-toolresult-breaks-typing-and-boundary.md`), consolidar esse tema
com os demais achados correlatos do programa numa revisão dedicada única, futura, tratada de forma
sistêmica em vez de pontual Sprint a Sprint.

**Não é uma Sprint agendada** — este documento é um backlog de temas candidatos a uma futura
Sprint/RFC (padrão já usado por ARCH-012/015/024 neste programa: `Exige RFC`, Fase 1-5 completa
antes de qualquer código). Quando o programa chegar ao ponto de abrir essa revisão, começar por
aqui, não pelo card original do backlog — os achados abaixo já corrigem premissas que o texto
original do `ARCHITECTURAL_BACKLOG.md` não tinha.

## Por que consolidar em vez de resolver pontualmente

O padrão já é visível na `RETROSPECTIVA_PREMISSAS_AUDITORIA.md` (8 de 12 Sprints executadas até
aqui tiveram premissa corrigida na prática) — mas os temas abaixo especificamente compartilham uma
causa comum: **decisões sobre COMO tipos devem ser compartilhados entre `loop/` e `shared/`, e
sobre a forma de contratos/callbacks entre camadas, tomadas uma de cada vez, cada Sprint sem
visibilidade das outras.** Resolver ARCH-009 sem olhar para ARCH-024 (mesma classe de problema —
"campos acumulados sem dono claro", só que em `ChannelContext` em vez de `ToolResult`) arrisca
duas soluções estruturalmente diferentes para o mesmo tipo de decisão.

## Temas candidatos

### 1. ARCH-009 — Campo `output`/`error` redeclarado em `ToolResult`/`CycleResult`/`GoalAttempt`
- **Card original:** `ARCHITECTURAL_BACKLOG.md`, Epic B (Single Source of Truth).
- **Achado que motivou o adiamento:** `docs/issues/008-arch009-extends-toolresult-breaks-typing-and-boundary.md`.
- **Resumo:** a prescrição literal do card (`extends ToolResult`) não compila (obrigatoriedade de
  `output` incompatível entre os 3 tipos) e, se forçada via mudança de tipo, reintroduziria a
  violação de fronteira `shared/→loop/` que ARCH-004 (S02) já corrigiu — porque `GoalAttempt` mora
  em `shared/domainTypes.ts` e `ToolResult` mora em `loop/agentLoopTypes.ts`.
- **Direção provável (a confirmar na revisão):** extrair um tipo-base mínimo (`{ output?: string;
  error?: string }`) para `shared/domainTypes.ts` (camada neutra, 0 imports hoje), com `ToolResult`
  estreitando `output` para obrigatório ao estendê-lo de `loop/` — preserva a direção
  `loop/ → shared/` já estabelecida.

### 2. ARCH-024 — `DeliveryTrackingContext` (RFC já agendada, S19/S23)
- **Card original:** Epic D (Structural Simplification), já classificado `Exige RFC`.
- **Por que pertence a esta lista:** mesmo padrão estrutural do ARCH-009 — campos acumulados em
  `ChannelContext` (`agentLoopTypes.ts`) um a um, cada um resolvendo um bug pontual de entrega, sem
  dono conceitual único. Qualquer decisão de design tomada para ARCH-009 (ex.: "campos
  relacionados migram para uma interface nomeada em vez de se acumularem soltos no tipo pai")
  deveria ser a MESMA regra aplicada a `ChannelContext`/`DeliveryTrackingContext` — inconsistência
  entre as duas seria uma nova fonte de divergência, exatamente o que estes ARCH existem para
  evitar.
- **Já tem Sprint própria no plano** (S19 RFC, S23 implementação condicional) — não precisa de
  Sprint nova, só que a RFC de S19 leia este documento e a decisão de ARCH-009 antes de ser escrita.

### 3. `docs/issues/004-duplicate-extracttext-functions.md` — 2 funções `extractText` com o mesmo nome
- **Origem:** achado colateral da S09 (ARCH-003), não corrigido por *No Opportunistic Refactoring*.
- **Por que pertence a esta lista:** é uma colisão de nome entre um tipo/função em `shared/` e outro
  em `loop/` — mesma família de problema ("duas coisas com o mesmo nome/forma em camadas
  diferentes, sem fonte única"), ainda que não seja sobre `output`/`error` especificamente.
- **Não precisa de RFC própria** — candidato a ser resolvido como parte da mesma revisão, não como
  ARCH novo isolado, se a revisão decidir que vale a pena.

## Não incluídos aqui (avaliados e descartados como pertencentes a esta lista)

- `docs/issues/003` (barrel `core/index.ts` possivelmente morto) — é sobre código morto, não sobre
  modelagem de tipo compartilhado. Fora de escopo desta consolidação.
- `docs/issues/005` (regex desatualizada) e `docs/issues/006` (4 detectores de loop) — já
  resolvidos/decididos nas próprias Sprints que os encontraram (S10/S11); não são pendências
  abertas.
- ARCH-012 (RFC `successCriteria`/`CLAIM_RULES`) e ARCH-015 (RFC schema de args) — já são RFCs
  agendadas no plano (S27, S20) tratando de unificação de DECISÃO/VALIDAÇÃO, não de modelagem de
  TIPO compartilhado entre camadas. Categoria diferente da desta lista.

## Quando abrir esta revisão

Não há Sprint numerada no `MASTER_EXECUTION_PLAN.md` reservada para isto ainda — decisão
deliberada, para não comprometer uma data antes de o programa decidir a prioridade. Candidatos
naturais para reavaliar isto: junto do checkpoint `2026-08-CP02` (revisão de indicadores já
agendada) ou como parte da RFC de `ARCH-024` (S19), dado o tema #2 acima. Quem reabrir este
documento decide o momento; até lá, ARCH-009 permanece `⏸ Adiado` no Painel Executivo.

## Impacto nas dependências do plano

Três Sprints já agendadas citam ARCH-009/S14 como dependência de "tipos consolidados primeiro":
`S21` (ARCH-013), `S22` (ARCH-022), `S24` (ARCH-020). Nenhuma delas fica bloqueada — a dependência
citada era uma recomendação de sequenciamento para reduzir churn (per o próprio card: "reduz
churn nos refactors maiores"), não uma dependência funcional obrigatória. Podem prosseguir usando
a forma atual (não consolidada) de `ToolResult`/`CycleResult`/`GoalAttempt` sem risco — ver nota
adicionada em cada uma dessas Sprints no `MASTER_EXECUTION_PLAN.md`.
