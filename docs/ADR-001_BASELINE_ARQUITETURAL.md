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
| Contradição interna da RFC-001 (Princípio 3 vs. resposta à pergunta 10) | **Pendente** — a versão salva em `docs/RFC-001_APRENDIZADO_OPERACIONAL.md` ainda contém a formulação original, não revisada. A implementação real (Milestone M2, primeira fatia) já resolveu isso NA PRÁTICA (só caminho informativo, extensão tática explicitamente adiada) — falta só atualizar o texto do documento para refletir isso |
| 3 pontos de injeção de reflection sobrepostos | **Não resolvido** — baixa prioridade, adiável com segurança |

## 5. Princípios oficiais da arquitetura

- **Evidence Provider Pattern** — `docs/ARCHITECTURE/EVIDENCE_PROVIDER_PATTERN.md` (salvo).
- **Princípio da Preservação do Raciocínio** — `docs/DIRETRIZ_ARQUITETURA_2026-07-13.md` (salvo).
- **Gate de Extensão antes de Criação** — `docs/DIRETRIZ_ARQUITETURA_2026-07-13.md` (salvo).
- **Separação Distribuído vs. Aprendido** — descrito nesta ADR e na RFC-001, **ainda não tem
  documento próprio**.
- **"Nunca Adivinhar"** — descrito na RFC-001 e citado no docstring de `resolveInstallCommand()`,
  **ainda não tem documento próprio**.

## 6. Itens deliberadamente adiados

- Extensão tática do `OperationalKnowledge` (atalho determinístico tipo `needs_dependency`,
  exigiria injetar dependências novas em `GoalEvaluator`) — adiada até o caminho informativo se
  provar útil em uso real.
- Ativação plena do `CaseMemory` (roadmap próprio, S5).
- Coordenação dos 3 pontos de injeção de reflection.
- Documentos formais para "Separação Distribuído vs. Aprendido" e "Nunca Adivinhar".

## 7. Critérios para encerrar a baseline

Ainda não satisfeitos integralmente: falta (a) atualizar o texto da RFC-001 para remover a
contradição já resolvida na prática, (b) formalizar os 2 princípios sem documento próprio, (c)
validar a Milestone M2 em ambiente real (etapa 4 da Validação Progressiva — próximo passo em
andamento).

## 8. Estado desta ADR

Escrita e aprovada em 24/07/2026, persistida no repositório na mesma data — a versão original
existiu só em conversa por um intervalo desta mesma investigação; corrigido ao preparar o
handoff para a continuação do trabalho.
