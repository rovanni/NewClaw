# Plano de Sprints de Correção — NewClaw

**Base:** `docs/AUDITORIA_ADVERSARIAL_2026-07-12.md` (2 Críticos, 4 Altos, 4 Médios, 3 Baixos)
**Data:** 2026-07-12

## Princípios de sequenciamento

1. **Quick wins de alta severidade primeiro** — correções triviais que fecham risco crítico/alto (C2, A2, A3) não devem esperar refatoração.
2. **Fundação antes do refactor** — A1 (serializar gravações de transcript + callback de workflow) reduz a janela de corrida de C1 e remove a concorrência que torna M3 explorável; portanto vem antes deles.
3. **Refatoração pesada isolada** — C1 (estado por-turno no `AgentLoop` singleton) tem risco de regressão médio e superfície ampla; ganha um sprint dedicado, sem competir por atenção com outras mudanças.
4. **Cada item entrega com teste de regressão** — o projeto já tem o padrão `Sxx_*.test.ts`; cada correção adiciona o seu, seguindo a numeração existente (próximo livre: `S95+`).

---

## Sprint 1 — Contenção imediata (segurança + resiliência de boot)

**Objetivo:** eliminar exposição de canal e a falha de auto-recuperação com o menor código possível. Nenhum destes exige refatoração.

| Item | Achado | Sev. | Esforço | Risco regressão |
|------|--------|------|---------|-----------------|
| Unificar allowlist como fail-closed (vazio = negar) em WhatsApp/Signal/Discord | C2 | Crítico | S | Baixo* |
| Limpar WAL/SHM em `autoRecoverDatabase` (helper compartilhado com o restore) | A2 | Alto | S | Baixo |
| Dedup: marcar `messageId` como processado só no sucesso (estado in_flight/done/failed) | A3 | Alto | M | Médio |

**Detalhamento**
- **C2:** extrair `isAllowed(id, allowlist)` em `channels/` e aplicá-lo nos 4 adapters; lista vazia → nega. Logar aviso alto no boot quando um canal habilitado estiver sem allowlist. *Muda comportamento observável — instalações que rodavam "abertas" pararão até configurar; destacar no CHANGELOG.
- **A2:** criar `replaceDatabaseFile(src, dest)` que faz `unlink` de `-wal`/`-shm` antes do `copyFileSync`; usar tanto em `dbRecovery.ts` quanto em `index.ts` (hoje divergentes).
- **A3:** substituir o `Set` marcado na admissão por um `Map<key, 'in_flight'|'done'>`; promover a `done` após `processMessageCore` concluir; **remover** a chave no `catch` para permitir reprocessamento de reentrega legítima.

**Critério de aceitação:** canal com allowlist vazia rejeita 100% das mensagens; reboot com `-wal` stale + backup válido recupera sem "disk image malformed"; mensagem cujo turno lançou exceção é reprocessada na reentrega.

**Testes novos:** `S95_ChannelAllowlist_FailClosed`, `S96_AutoRecover_StaleWalCleanup`, `S97_MessageDedup_ReprocessOnFailure`.

---

## Sprint 2 — Integridade de sessão (concorrência de transcript)

**Objetivo:** garantir que toda gravação de sessão seja serializada e que caminhos fora da fila não corram com turnos em voo. Fundação para o Sprint 3.

| Item | Achado | Sev. | Esforço | Risco regressão |
|------|--------|------|---------|-----------------|
| Todas as gravações de transcript sob o mesmo mutex por-sessão (ou via `appendAsync`) | A1 | Alto | M | Médio |
| Encaminhar callback de workflow (auth) pela fila serial da sessão | A1 | Alto | M | Médio |
| Tirar a compressão LLM de dentro da seção crítica; timeout do mutex vira rede anti-deadlock (falha, não "prossegue") | A4 | Alto | M | Médio |

**Detalhamento**
- **A1a:** trocar `transcript.append` por `appendAsync` (ativa o `writeMutex` hoje morto) em `recordToolCall`/`recordToolResult`/`recordSystemMessage`, **ou** envolvê-los em `withMutex`. Ajustar call sites que consomem o `seq` retornado para `await`.
- **A1b:** o callback `auth:*` (Telegram/Discord/WhatsApp/Signal) deve adquirir o mesmo mutex/fila da sessão antes de `recordAssistantMessage`, em vez de bypass total.
- **A4:** computar o resumo de compressão **sem** lock; adquirir o lock só para o `append` do checkpoint (operação rápida). Elevar o timeout do mutex acima do teto real e tratar estouro como erro devolvido ao usuário, não como "prossiga concorrente".

**Critério de aceitação:** turno em execução gravando tool_call + clique de "Aprovar" simultâneo produzem `seq` únicos e offsets de checkpoint corretos; compressão de 12s não libera operação concorrente na mesma sessão.

**Testes novos:** `S98_Transcript_ConcurrentWriteOrdering`, `S99_WorkflowCallback_SerializedWithTurn`, `S100_Compression_OutsideCriticalSection`.

**Dependência:** nenhuma; **habilita** M3 (Sprint 4) a fechar a janela concorrente restante.

---

## Sprint 3 — Isolamento de estado do AgentLoop (o crítico grande)

**Objetivo:** eliminar contaminação cruzada entre conversas. Sprint dedicado por causa da superfície.

| Item | Achado | Sev. | Esforço | Risco regressão |
|------|--------|------|---------|-----------------|
| Mover `cognitiveWorkspace`, `lastToolExecution`, `pendingObserverFeedback` para estado por-turno | C1 | Crítico | L | Médio |

**Detalhamento**
Replicar o padrão já validado em `GoalExecutionState` (`GoalExecutionLoop.ts:74-77`): criar um `TurnState` local a `runWithTools` (ou `Map<conversationId, TurnState>` com ciclo de vida atrelado a `activeTurns`), propagado por parâmetro pelos métodos privados que hoje leem esses campos (`commitResponse`, drain do observer, `add()` do workspace). O `CognitiveWorkspace` passa a ser instanciado por turno, não por `AgentLoop`.

**Critério de aceitação:** dois turnos concorrentes de `conversationId` distintos (com `generationQueue` concurrency=2) não compartilham workspace, `lastToolExecution` nem feedback do observer — verificado por teste que injeta dois turnos entrelaçados e checa isolamento.

**Testes novos:** `S101_AgentLoop_CrossConversationIsolation` (dois turnos paralelos, asserção de não-contaminação).

**Nota de rollout:** manter atrás de revisão cuidadosa; considerar rodar a suíte `S1..S100` completa antes do merge, pois `commitResponse`/observer tocam muitos caminhos.

---

## Sprint 4 — Integridade de memória e persistência (Médios)

**Objetivo:** fechar inconsistências de estado e o gargalo de embeddings.

| Item | Achado | Sev. | Esforço | Risco regressão |
|------|--------|------|---------|-----------------|
| `GoalStore`: read-modify-write de JSON em `db.transaction(...)` | M3 | Médio | S | Baixo |
| Unificar `removeNode` com a limpeza de `deleteNodeFull` (embeddings/métricas) | M2 | Médio | S | Baixo |
| `EmbeddingService`: checagem de dimensão em `search`/`cosineSimilarity` (fail-closed) | M1 | Médio | S | Baixo |
| `EventBus.onAny`: retornar unsubscribe + teardown no `AgentController.stop()` | M4 | Médio | S | Baixo |

**Detalhamento**
- **M3:** envolver `addAttempt`/`addBlocker`/`addToolTried`/`updateLastAttempt` em transação (better-sqlite3, já usado em `snapshotRepository.ts`). Com A1b resolvido, a janela concorrente principal já some; a transação fecha o resto.
- **M2:** `removeNode` delega para um `deleteNodeCascade` privado (superset já existente em `deleteNodeFull`).
- **M1:** persistir `dim` junto do embedding; em `search`, descartar/rejeitar vetores de dimensão diferente da query em vez de calcular cosine sobre lixo. (Índice ANN fica como item de escala futuro, fora do escopo de correção.)
- **M4:** `onAny` devolve função de remoção que desanexa de todos os tipos; `AgentController` guarda e chama no `stop()`.

**Critério de aceitação:** dois updates ao mesmo goal não perdem `attempt`; nó deletado não deixa embedding órfão; troca de modelo de embedding não corrompe ranking; segundo `AgentController` (caminho de auto-recovery) não duplica handlers de scheduler.

**Testes novos:** `S102_GoalStore_TransactionalAppend`, `S103_RemoveNode_CascadeCleanup`, `S104_Embedding_DimensionGuard`, `S105_EventBus_OnAnyUnsubscribe`.

---

## Sprint 5 — Robustez e coordenação (Baixos + polimento)

**Objetivo:** reduzir acoplamentos arriscados e alinhar comportamento com o documentado.

| Item | Achado | Sev. | Esforço | Risco regressão |
|------|--------|------|---------|-----------------|
| Adapters com supervisor interno sinalizam `selfHealing` → bus não agenda reconexão redundante | B1 | Baixo | S | Baixo |
| `uncaughtException`: distinguir transitório (continuar) de invariante violada (reiniciar controlado) | B2 | Baixo | M | Médio |
| Alinhar comentário "sem descarte" do `ConversationQueueManager` com o backpressure real (ou persistir excedente) | B3 | Baixo | S | Baixo |

**Nota:** B1 tem dano concreto não comprovado (hipótese na auditoria) — tratar como redução de acoplamento, não como correção de bug. B2 é decisão de política de disponibilidade: alinhar com o time antes de mudar.

---

## Visão geral de dependências

```
Sprint 1 (C2, A2, A3)  ─ independentes, quick wins
        │
Sprint 2 (A1, A4) ─── habilita ──► Sprint 4 (M3 fecha janela concorrente)
        │
Sprint 3 (C1) ─────── recomendado após A1 (janela de corrida menor)
        │
Sprint 4 (M1, M2, M3, M4)
        │
Sprint 5 (B1, B2, B3)
```

## Recomendações transversais

- **Congelar a suíte de regressão como gate:** nenhum sprint fecha sem `S1..S94` + os novos `Sxx` passando.
- **Feature flag para C2:** permitir rollout gradual do fail-closed, com aviso alto por 1-2 releases antes de tornar padrão, dado que muda comportamento de instalações existentes.
- **Verificação de alto risco via revisão dupla:** C1 e A1 mexem em caminhos centrais — vale um par de revisores e execução da suíte completa antes do merge.
- **Áreas não auditadas** (RiskAnalyzer, CMI, MemoryCurator, rotas do dashboard, Baileys/Signal-cli, SkillLearner — ver seção final da auditoria): agendar uma **passagem de auditoria dedicada** antes ou em paralelo ao Sprint 4, pois podem revelar itens que reordenam este plano.
