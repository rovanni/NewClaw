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

- Extensão tática do `OperationalKnowledge` (atalho determinístico tipo `needs_dependency`,
  exigiria injetar dependências novas em `GoalEvaluator`) — adiada até o caminho informativo se
  provar útil em uso real.
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
