# Sprint R3 — Fase 5 (Validação) da proposta ArtifactTrace

**Data:** 2026-07-13
**Branch:** `experimental/artifact-pipeline-refactor`
**Escopo:** aplicar o checklist de Validação de `docs/DIRETRIZ_ARQUITETURA_2026-07-13.md` (Fase 5) à proposta `ArtifactTrace` (`docs/ANALISE_ARQUITETURAL_COGNITIVE_ENVELOPE_SPRINT_R2_2026-07-13.md`, §11-§12), antes de qualquer implementação. Nenhum código alterado.

As Fases 1-4 já foram cobertas: Compreensão e Crítica na Sprint R1, Pesquisa de Alternativas e Síntese na Sprint R2. Esta sprint fecha só a Fase 5.

---

## Checklist de Validação

### 1. Baseada em evidências reais ou apenas em hipótese?

**Mista — o problema é evidência real, a forma da solução é hipótese ainda não testada.**

Evidência real e confirmada:
- R1 §5/§9.5: duas heurísticas independentes de `file_path` (planejamento vs. execução) que não se comunicam.
- R1 §9.6: `exec_command` não declara o que produz — confirmado por leitura direta do código.
- Bugs de produção de 09/07 (`project_session_bugs_jul2026_ap`): goal de reenviar arquivo pré-existente travou o validador e o planner fabricou um substituto; `checkClaimsAgainstEvidence` aceitou um `.py` como prova de que um `.pptx` foi entregue. Ambos são instâncias reais, já vividas, da mesma causa raiz (nenhuma identidade estável liga "o que foi pedido" a "o que existe no disco" a "o que foi entregue").

Hipótese ainda não testada:
- Que a forma específica proposta (`traceId` + log de eventos apensado + projeção) é a melhor resposta a essa causa raiz. Nenhum protótipo rodou ainda. §7/§8 da R2 argumentam por analogia (tracing distribuído), não por medição.

### 2. Resolve um problema estrutural ou só um sintoma?

**Estrutural, mas só para uma fatia dos achados de R1.** Ataca diretamente §9.1, §9.5, §9.6 e os dois bugs de 09/07 — todos compartilham a mesma causa (falta de identidade). Não toca §9.2 (`SendDocumentTool` sem rota WhatsApp/Signal — bug de roteamento, causa diferente) nem §9.4 (`MessageBus.sendDocument` resolve silenciosamente — bug de tratamento de erro, causa diferente). Não é "a" solução estrutural do sistema; é a solução estrutural de uma classe específica e bem delimitada de bug.

### 3. Reduz a complexidade total do sistema?

**Não no curto prazo — e isso precisa ficar explícito, não escondido (Fase 4 exige transparência de limitação).** O desenho de §11 adiciona uma estrutura nova (tabela de eventos, função de projeção, campo `artifactTraceId` em `PlanStep`) **ao lado** das heurísticas existentes, que continuam como fallback (§5, coexistência deliberada). No piloto isolado, complexidade total sobe antes de descer. Ela só cai de fato se, depois do piloto provar valor, as heurísticas antigas forem efetivamente removidas — o que não está no escopo desta sprint nem do piloto proposto. Tratar isso como um investimento com retorno diferido, não como redução imediata.

### 4. Elimina múltiplas fontes de verdade?

**Só dentro do escopo do piloto — não das três fontes que R1 §4 documentou.** O piloto (contrato de `exec_command` + reconciliação de `file_path` em `send_document`) colapsa exatamente as duas heurísticas de §9.5 numa só. Não toca `sentArtifacts`, `SessionManager.deliveredArtifacts` nem o callback `onArtifactDelivered` — essas três continuam paralelas como estão hoje. A eliminação completa das fontes de verdade de R1 §4 é uma sprint futura, condicionada ao piloto ter dado certo.

### 5. Mantém a filosofia do Cognitive Kernel?

Por item da filosofia declarada em `docs/DIRETRIZ_ARQUITETURA_2026-07-13.md`:
- **Baixo acoplamento:** sim, se implementado como funções puras + tipo (não serviço central importado por toda camada) — condição já fixada em §11, não opcional.
- **Conceitos universais:** parcialmente, e de propósito — R2 §9 recomendou explicitamente **não** generalizar para memória/conversa/decisão agora, por falta de evidência de que sofrem do mesmo sintoma. Isso é consistente com a filosofia (evidência antes de abstração), não uma violação dela.
- **Evolução incremental:** sim — plano de coexistência em §5/§11.
- **Decisões fundamentadas em evidência:** sim para o problema (§1 acima), não ainda para a forma exata da solução — daí o piloto ser um teste, não um rollout.
- **Documentação antes da implementação:** sim — é o que R1/R2/R3 são.
- **Simplicidade arquitetural:** tensão real com o ponto 3. Aceitável apenas se o piloto ficar estritamente contido (ver riscos abaixo).

### 6. Pode ser implementada incrementalmente?

**Sim.** Escopo do piloto já definido em R2 §11/§12: só `exec_command` (declarar artefato produzido) e a resolução de `file_path` de `send_document` via `traceId` com fallback para a heurística atual. Não exige tocar `sentArtifacts`, `SessionManager`, memória, conversa ou qualquer canal de envio.

### 7. Pode ser revertida facilmente caso falhe?

**Sim, se e somente se o escopo do piloto for respeitado.** Sendo aditiva (nova tabela + campo opcional, heurística antiga preservada como fallback), reverter significa parar de popular `traceId` e remover a tabela — baixo raio de impacto.

**Mas este é o ponto onde a tentativa anterior morreu, não no design.** O `ArtifactDeliveryRegistry` original (`1dafdab`) foi integrado em 4 arquivos (`RiskAnalyzer`, `GoalExecutionLoop`, `ContextBuilder`, `ReflectionMemory`) no mesmo commit em que foi criado — sem fase de piloto isolado. Quando deu problema, não havia mais um "reverter" limpo: virou código morto entranhado que precisou de remoção forçada 11 dias depois (`a7862d3`), com 8 bugs já causados. A causa da morte anterior foi disciplina de escopo durante a integração, não a ideia de ter identidade centralizada. Reversibilidade desta proposta depende de um gate explícito impedindo a mesma expansão prematura.

---

## Veredito

**Liberado para implementação, condicionalmente.** Todos os sete critérios respondem de forma satisfatória para o **piloto estritamente escopado** (contrato `exec_command` + reconciliação de `file_path`). Nenhum critério é satisfeito para uma versão que já nasça tocando `sentArtifacts`/`SessionManager.deliveredArtifacts`/memória/conversa — essa versão maior não está validada e não deve ser implementada agora.

### Condição de escopo (hard gate, não sugestão)

O piloto só pode tocar:
1. `exec_command` — contrato estruturado para declarar artefato produzido.
2. `RiskAnalyzer`/`GoalExecutionLoop` — resolução de `file_path` de `send_document` via `traceId`, com fallback para a heurística sintática atual.

Qualquer extensão além disso (tocar `sentArtifacts`, `SessionManager`, `agentloop`, memória) exige voltar à Fase 1 para essa extensão especificamente — não herda a aprovação desta validação.

### Critério de sucesso / gatilho de parada

Sucesso: um teste de regressão equivalente ao `S109` passando via herança de `traceId` no replan, mensuravelmente mais simples que a correção reativa atual (`7d086d4`).
Parada: se, ao final do piloto, esse teste não ficar mais simples do que já está — o conceito não pagou seu custo (ver §3 acima) e não deve se expandir para além do piloto. Nesse caso, decidir explicitamente entre reverter ou congelar o escopo no que já foi feito, em vez de expandir por inércia.

### Riscos que permanecem (não escondidos)

- Complexidade sobe antes de baixar (§3) — aceito como custo do piloto, não deve virar justificativa para acelerar a expansão antes de medir o retorno.
- A forma exata da solução (event log + projeção) ainda não foi testada contra carga real — pode se mostrar sobre-engenheirada para o tamanho real do problema, ou insuficiente em algum caso extremo não antecipado (ex.: dois goals concorrentes criando o mesmo `traceId` — não coberto em detalhe em R2 §12).
- Disciplina de escopo é responsabilidade humana/de processo, não algo que o desenho técnico garanta sozinho — é o fator que causou a morte da tentativa anterior e pode se repetir independente de quão bom for o design desta vez.

### Hipóteses ainda não comprovadas

- Que `traceId` resolve o caso "reenviar arquivo pré-existente" (R2 §12.1) sem introduzir uma nova ambiguidade quando o mesmo path físico é legitimamente recriado por goals diferentes com conteúdo diferente (índice reverso `path → traceId` pode retornar o `traceId` errado se o path for reutilizado).
- Que a idempotência de `emit()` (R2 §12.3) é suficiente com a chave proposta (`traceId + type + cycle`) sem colisão em cenários de retry mais complexos que os já vistos.

Essas duas hipóteses devem ser verificadas durante a implementação do piloto, não antes — não bloqueiam o início, mas devem ser critério explícito de revisão ao final dele.
