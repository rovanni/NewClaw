# ADR-001 — Formalização da Baseline Arquitetural do NewClaw

> Registro de decisões arquiteturais tomadas durante a investigação de 23-24/07/2026, que
> culminou na RFC-001 e na Milestone M2. Documento normativo — descreve decisões já tomadas,
> não propõe mudanças.

## 1. Contexto

**Problemas que motivaram a investigação**: o NewClaw precisa concluir objetivos definidos pelo
usuário instalando dependências automaticamente em ambientes novos (sendo open source, sem
intervenção humana garantida) e, idealmente, aprender com o tempo a resolver esse tipo de
problema melhor — sem que essas capacidades corroam a arquitetura existente.

**Hipóteses consideradas e descartadas**: componentes determinísticos decidindo livremente
sempre que conveniente; `KNOWN_DEPS` crescendo indefinidamente por entrada; `CaseMemory`
ativado como mecanismo de aprendizado operacional (eixo de recuperação por objetivo,
incompatível); `ReflectionMemory` absorvendo todo conhecimento operacional aprendido (quebraria
a premissa de schema do componente).

**O que permaneceu**: o padrão Evidence Provider como modelo central; `GoalPlanner` como
decisor estratégico único, com exceção de segurança nomeada; separação física entre
conhecimento distribuído e aprendido; a RFC-001 como direção válida para a Milestone M2.

## 2. Decisões arquiteturais aprovadas

1. `GoalPlanner` permanece o único decisor estratégico, através da chamada de LLM em
   `plan()`/`replan()`.
2. Evidence Provider é um padrão arquitetural explícito — formalizado em
   `docs/ARCHITECTURE/EVIDENCE_PROVIDER_PATTERN.md`.
3. `ReflectionMemory` permanece especializado em aprendizagem baseada em falhas.
4. `CaseMemory` permanece especializado em sucesso relacionado a objetivo, em modo sombra.
5. `KNOWN_DEPS` continua como catálogo estático distribuído no código-fonte.
6. A separação entre conhecimento distribuído (código) e conhecimento aprendido (armazenamento
   local) é princípio oficial.
7. Autoinstalação via caminho determinístico (`KNOWN_DEPS`) + caminho genérico (replan via LLM)
   é o modelo oficial — validado pela Milestone M1 (144/144 testes na época).
8. Redução de autonomia do agente por componente determinístico só é legítima com justificativa
   de segurança/integridade/conformidade nomeada, respeitando Modos Operacionais.

## 3. Decisões rejeitadas

1. Embeddings de objetivo do usuário para recuperar conhecimento operacional.
2. `ReflectionMemory` como repositório genérico de conhecimento.
3. Componentes determinísticos substituindo livremente o julgamento estratégico.
4. `KNOWN_DEPS` crescendo indefinidamente por entrada individual.
5. Ativação imediata do `CaseMemory` como mecanismo de aprendizado operacional.

## 4. Dívidas arquiteturais reconhecidas — status atualizado

| Dívida | Status |
|---|---|
| `ReflectionMemory` com 2 gerações de API paralelas | **Resolvido** (ARCH-006, 24/07): `buildContextHint()`/`buildConstraints()` removidos, call site migrado para `findToolFailures()` |
| `patternToConstraint()` misturando fato de ambiente com estatística | **Resolvido** (ARCH-005, 24/07): separado em `environmentWorkaroundForPattern()`, chamado antes da lógica estatística |
| 4 blocos inline no `GoalPlanner` sem checar Modos Operacionais | **Resolvido** (ARCH-007, 24/07): condicionados a `permissionRegistry.can('bypass_reflection_constraints')` |
| Contradição interna da RFC-001 (Princípio 3 vs. resposta à pergunta 10) | **Resolvido** (ARCH-004, 24/07): Princípio 3 revisado para referenciar a exceção já nomeada em `EVIDENCE_PROVIDER_PATTERN.md` Seção 7 (item 2), em vez de deixá-la implícita só na análise crítica da pergunta 10. Nenhuma mudança de comportamento — só formulação; a implementação real já seguia o caminho informativo puro |
| "Separação Distribuído × Aprendido" sem documento próprio | **Resolvido** (ARCH-002, 24/07): `docs/ARCHITECTURE/SEPARACAO_DISTRIBUIDO_APRENDIDO.md` |
| "Nunca Adivinhar" sem documento próprio | **Resolvido** (ARCH-003, 24/07): `docs/ARCHITECTURE/NUNCA_ADIVINHAR.md` |
| 3 pontos de injeção de reflection sobrepostos | **Won't Fix** (ARCH-008, 24/07) — ver análise abaixo, Seção 4.1 |

### 4.1 — ARCH-008: por que "consolidar" seria o fix errado

Investigação (Fase 1-3 do processo obrigatório da DIRETRIZ_ARQUITETURA): os 3 pontos de injeção
de fato consultam `ReflectionMemory` de forma aparentemente sobreposta — `GoalExecutionLoop.
contextualize()` (`findToolFailures()` por tool já tentada, alimenta `runtimeContext`),
`GoalPlanner.plan()` (`findHardConstraints()` para todas as tools disponíveis, bloco
"EVIDÊNCIA HISTÓRICA" próprio) e `RiskAnalyzer.analyzeRisk()` (`findHardConstraints()` + `find
ToolFailures()` por step, DEPOIS que o plano já existe). Os três chamam a mesma classe, às vezes
o mesmo método, sobre dados que podem se sobrepor.

**Por que não consolidar**: os três rodam em estágios diferentes do pipeline (antes do plano
existir vs. depois), com objetivos diferentes (evidência textual fraca para a LLM ponderar vs.
enforcement duro que efetivamente poda steps do plano) e escopos de tool diferentes (tools já
tentadas vs. tools disponíveis vs. tools do plano final). Forçar um ponto único de consulta
exigiria que `RiskAnalyzer` (que roda depois do plano) dependesse do resultado que `GoalPlanner`
já buscou (antes do plano) — criando acoplamento novo entre dois consumidores que hoje são
independentes por design. Isso violaria diretamente o próprio Evidence Provider Pattern que
motivou a investigação (`EVIDENCE_PROVIDER_PATTERN.md`, Seção 5, DEVE: "ser consultável de forma
independente dos demais Evidence Providers — nenhum deve exigir o resultado de outro para
funcionar"). A "sobreposição" observada é o padrão correto (múltiplos consumidores independentes
do mesmo Evidence Provider), não duplicação de lógica — os dois níveis de confiança
(`findToolFailures` = geral, `findHardConstraints` = só ≥90%) já são o desenho intencional de
dois tiers, não um acidente. Precedente: mesma categoria de decisão que ARCH-009 (Won't Fix,
risco baixo e antecipatório — ver `docs/RFC-001_APRENDIZADO_OPERACIONAL.md`/histórico do
projeto). Reabrir só se, no futuro, evidência real mostrar que os 3 blocos de texto estão
confundindo a camada de julgamento (ex.: LLM citando informação contraditória entre eles) — não
antecipar.

## 5. Princípios oficiais da arquitetura

- **Evidence Provider Pattern** — `docs/ARCHITECTURE/EVIDENCE_PROVIDER_PATTERN.md` (salvo).
- **Princípio da Preservação do Raciocínio** — `docs/DIRETRIZ_ARQUITETURA_2026-07-13.md` (salvo).
- **Gate de Extensão antes de Criação** — `docs/DIRETRIZ_ARQUITETURA_2026-07-13.md` (salvo).
- **Separação Distribuído vs. Aprendido** — `docs/ARCHITECTURE/SEPARACAO_DISTRIBUIDO_APRENDIDO.md`
  (salvo, ARCH-002).
- **"Nunca Adivinhar"** — `docs/ARCHITECTURE/NUNCA_ADIVINHAR.md` (salvo, ARCH-003).

Todos os 5 princípios estão referenciados em `docs/DIRETRIZ_ARQUITETURA_2026-07-13.md`, Seção
"Princípios formalizados (Milestone C1)".

## 6. Itens deliberadamente adiados

- ~~Extensão tática do `OperationalKnowledge` (atalho determinístico tipo `needs_dependency`,
  exigiria injetar dependências novas em `GoalEvaluator`) — adiada até o caminho informativo se
  provar útil em uso real.~~ **Não é mais adiado (2026-07-27)**: a condição definida acima foi
  satisfeita — uso real (fricção recorrente relatada pelo operador, ao longo de ~3 gerações do
  projeto) mais um precedente de segunda instância (OpenClaw, já referenciado como precedente em
  `src/tools/exec_command.ts`/`src/tools/send_audio.ts`) juntos motivaram
  `docs/decisoes/RFC-003_AQUISICAO_CONHECIMENTO_OPERACIONAL.md`, que formaliza esta extensão.
  Este item deixa de estar "adiado" e passa a ser rastreado como decisão aprovada, com
  implementação ainda pendente (ver RFC-003, seção "Próximos Passos").
- Ativação plena do `CaseMemory` (roadmap próprio, S5).
- Coordenação dos 3 pontos de injeção de reflection — **Won't Fix**, não "adiado" (ver Seção 4.1):
  decisão definitiva, não pendência.

## 7. Critérios para encerrar a baseline

Todos satisfeitos em 24/07/2026:

- (a) ✅ Texto da RFC-001 atualizado — contradição do Princípio 3 resolvida (ARCH-004), status
  do documento reflete a implementação real.
- (b) ✅ Os 2 princípios sem documento próprio formalizados (ARCH-002, ARCH-003) e referenciados
  na DIRETRIZ_ARQUITETURA.
- (c) ✅ Milestone M2 (primeira fatia, `OperationalKnowledge`) validada em ambiente real —
  Windows (instância isolada, LLM real, 2 goals com restart de processo entre eles) e Linux
  (VPS real, clone isolado, produção nunca tocada) — ambos confirmando captura/recuperação de
  conhecimento pela dependência real (`yq`), nunca pela tool que falhou.

## 8. Baseline B1.1 — publicada

Escrita e aprovada em 24/07/2026, persistida no repositório na mesma data. Baseline B1.1
formalmente encerrada nesta mesma data, após ARCH-001 a ARCH-010 (Milestones C1-C4) resolvidos
ou explicitamente marcados Won't Fix — nenhum item pendente sem decisão registrada. Milestone M2
(`OperationalKnowledge`, primeira fatia) foi implementada e validada **antes** deste fechamento
formal da baseline, fora da ordem que o roadmap original prescrevia (M2 depende de C1-C4
concluídas) — registrado aqui como desvio consciente de sequência, não como erro: o trabalho de
M2 foi fundamentado em evidências e validado de forma independente por si só (145/145 testes,
validação E2E ao vivo duas vezes, VPS Linux real), e fechar C1-C4 retroativamente não invalidou
nada do que M2 já tinha implementado — só formalizou documentação que já era verdade na prática.

## 9. Baseline B2.0 — Operational Knowledge Acquisition — publicada

Escrita e aprovada em 2026-07-27, persistida no repositório na mesma data. Origem:
`docs/decisoes/RFC-003_AQUISICAO_CONHECIMENTO_OPERACIONAL.md` — passou por consolidação (Fase 1),
segunda auditoria crítica adversarial (Fase 1b, 3 achados corrigidos: fronteira Planner×atalho
determinístico, lista de impacto documental, condição de parada do ciclo) e alinhamento de toda a
documentação normativa consequente (Fase 2: `EVIDENCE_PROVIDER_PATTERN.md`,
`PIPELINE_CURADORIA_DEPENDENCIAS.md`, este ADR §6, `RFC-001`). Fase 3 (auditoria de impacto no
código, `docs/analises-arquiteturais/AUDITORIA_IMPACTO_RFC003_AQUISICAO_CONHECIMENTO_2026-07-27.md`)
concluída na mesma data.

A partir desta baseline:

- RFC-003 = aprovada e consolidada;
- documentos normativos = alinhados entre si (nenhuma contradição textual conhecida);
- arquitetura = **congelada** para fins de implementação — qualquer mudança de arquitetura durante
  os Sprints de implementação (ver auditoria de impacto, Seção 3, Sprints A-G) é tratada como
  exceção a ser registrada numa ADR/RFC futura, nunca incorporada diretamente ao código sem
  documentação prévia. Isso preserva a mesma disciplina que produziu esta baseline: a
  implementação não deve "contaminar" de volta a arquitetura recém-estabilizada.

Nenhum código foi alterado para esta baseline — só documentação. A implementação em si (Sprints
A-G da auditoria de impacto) começa a partir daqui como trabalho separado e explicitamente
solicitado, não incluído neste fechamento.

## 10. Baseline B2.1 — Ingestão de Mídia (Sprints 010-017) — versão 2.3.1

Escrita em 2026-08-05. Origem: `docs/decisoes/RFC-004_INGESTAO_DE_MIDIA_MULTIPLA.md`, aprovada na
mesma data após análise em cinco fases de um incidente real — 12 imagens enviadas numa conversa
produziram 4 análises, 3 perdas silenciosas e 9 respostas desconexas em 27 minutos.

**Estado:** todas as sete sprints implementadas, cobertas por teste e validadas; branch integrada à
`main` por merge `--no-ff`. Encerramento documentado em `docs/sprints/RFC-004_CLOSING_REPORT.md`.
Uma pendência nomeada permanece — ver "Validação" abaixo.

**Sobre o número de versão:** publicada como `2.3.1`. O ciclo é majoritariamente corretivo, mas
inclui três mudanças de comportamento observável pelo usuário — o teto de anexos por mensagem passou
de 5 para 10 (`MAX_ATTACHMENTS_PER_MESSAGE`), a resposta de uma entrega por áudio passou a conter o
texto falado em vez do recibo, e um álbum do Telegram passou a produzir uma resposta em vez de N.
Registrado aqui para que a escolha de `patch` em vez de `minor` seja uma decisão explícita, não um
descuido.

### Princípios normativos adicionados

1. **Configuração compartilhada é imutável para quem lê** — um componente que mantém configuração
   compartilhada entrega cópias e concentra a escrita em métodos explícitos. Nenhum leitor altera
   estado global por efeito colateral.
2. **Pré-processamento de mídia produz fatos, nunca decisões** — a camada de ingestão observa todos
   os anexos, registra o que conseguiu e o que não conseguiu como fato textual, e entrega ao Core.
   Não encerra o turno, não escolhe o que a IA vê, não redige a resposta ao usuário. É o Evidence
   Provider Pattern aplicado à ingestão (`docs/ARCHITECTURE/EVIDENCE_PROVIDER_PATTERN.md`, §9).
3. **Ferramentas de entrega devolvem o conteúdo entregue**
   (`docs/ARCHITECTURE/FERRAMENTAS_DE_ENTREGA.md`) — diagnóstico operacional pertence ao log, nunca
   à resposta final. Nasceu de uma entrega por áudio cuja resposta textual era a mensagem interna do
   mecanismo de deduplicação; quem não pudesse ouvir ficava sem resposta. Vale para `send_audio`,
   `send_document`, `send_image` e qualquer ferramenta futura cujo sucesso signifique "o usuário
   recebeu algo".

### Estado consolidado

| Sprint | Entrega | Cobertura |
|---|---|---|
| 010 | Alinhamento documental dos dois princípios | — |
| 011 | Nenhum endereço de rede embutido no código-fonte ou instaladores | `S195` |
| 012 | Registro de perfis entrega cópia, nunca a referência interna | `S196` |
| 013 | Ingestão percorre todos os anexos; falha vira fato, não resposta | `S197` |
| 014 | Política única de retry de download para os três tipos de mídia | `S198` |
| 015 | Limite de anexos com fonte única e erro traduzível no Dashboard | `S199` |
| 016 | Álbum do Telegram vira uma única mensagem com N anexos | `S200` |
| 017 | Validação end-to-end do incidente | relatório |
| — | Ferramentas de entrega devolvem conteúdo, não recibo | `S201` |

Suíte de regressão: **201 testes** (194 antes desta baseline, mais os sete acima).

### Validação

Execução real em instância isolada (LLM real, visão real, filesystem real), documentada em
`docs/sprints/SPRINT_017_VALIDACAO_RFC004_REPORT.md`:

| | Incidente (04/08) | Validação (05/08) |
|---|---|---|
| Imagens analisadas | 4 de 12 | 10 de 10 |
| Perdidas em silêncio | 3 | 0 |
| Respostas | 9 desconexas | 1 |
| Tempo | 27 min | 4 min 25 s |
| Pergunta respondida | não | sim |

**Pendência nomeada:** o agrupamento de álbum da Sprint 016 **não foi validado em canal real**. O
Dashboard já entrega N anexos numa única mensagem, então a validação end-to-end não exercita o
buffer por `media_group_id`; a cobertura é o `S200` (15 verificações). Reproduzir a entrega
fragmentada exige enviar um álbum de verdade ao bot do Telegram.

### Débitos e achados registrados nesta baseline

- **`S158` instável** (`docs/issues/021`): duas de três rodadas isoladas passam. Hipótese
  registrada — o dedup de chamada repetida (issue `020`) pode estar bloqueando a segunda
  verificação que o ciclo do `RFC-003` precisa repetir para promover conhecimento a `validated`.
  Duas regras publicadas que se contradizem; a fronteira entre elas exige decisão própria.
- **A suíte não isola estado entre testes** — `S158` depende de conhecimento persistido e muda de
  resultado conforme o histórico de execuções. Achado secundário da mesma investigação.
- **Resposta textual vira mensagem de deduplicação quando o goal entrega por áudio** — observado na
  validação real da Sprint 013. Quem não puder ouvir o áudio fica sem resposta. Área distinta.
- **O Core continua sem sistema de tradução** — a `RFC-004` reduz o texto fixo emitido pelo Core em
  vez de introduzir um; o débito permanece para ACK de fila e validador de objetivos
  (`docs/ARCHITECTURE.md`, "Gaps conhecidos").
