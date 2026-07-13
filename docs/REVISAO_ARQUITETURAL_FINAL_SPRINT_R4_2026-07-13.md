# Sprint R4 — Revisão arquitetural final antes do piloto

**Data:** 2026-07-13
**Branch:** `experimental/artifact-pipeline-refactor`
**Escopo:** última revisão crítica antes de tocar código, aplicando Fase 2/3 (`docs/DIRETRIZ_ARQUITETURA_2026-07-13.md`) de novo sobre a proposta já aprovada condicionalmente na Sprint R3 (`docs/VALIDACAO_FASE5_ARTIFACTTRACE_SPRINT_R3_2026-07-13.md`). Nenhum código alterado.

Resultado resumido: **o piloto aprovado em R3 pode — e deve — ficar ainda menor.** `Event Log` + `Projection` não são necessários para o escopo já travado (§11/§12 da R2, hard gate da R3); e existe um mecanismo de identidade mais simples e mais alinhado à filosofia do Kernel do que UUID+log: **hash de conteúdo**, que por sinal já existe informalmente no próprio arquivo que o piloto vai tocar. Achado concreto, não hipotético — ver §3.

---

## 1. O piloto pode ser ainda menor?

Sim. O piloto de R3 tinha dois itens: (a) `exec_command` declara o artefato produzido; (b) `send_document` resolve `file_path` via `traceId`, com fallback para a heurística atual — ambos assumindo a existência de um novo mecanismo de identidade (`traceId` + log de eventos + projeção).

Reexaminando a causa raiz documentada em R1 §5: o problema não é falta de um mecanismo de identidade genérico — é que a inferência de `file_path` acontece em dois momentos diferentes com evidências diferentes (`RiskAnalyzer`, tempo de plano, sintático; `GoalExecutionLoop`, tempo de execução, evidência real em disco) e **não se comunicam**. O fix de hoje (`7d086d4`) já resolve isso corretamente no momento da entrega, usando evidência real (`goal.attempts`). O que falta não é uma estrutura nova — é o **mesmo padrão de evidência real** rodando também no momento do **replan**, não só na entrega final.

Isso reduz o piloto a: `exec_command` declara o artefato produzido (item a, mantido), e a resolução de `file_path` no replan passa a consultar `goal.attempts` (evidência real já persistida) em vez de inferir por proximidade sintática no JSON do plano — **sem precisar de `traceId`, sem log de eventos, sem projeção**. `GoalAttempt` já tem os campos necessários (`planStepId`, `discoveries?: string[]`, `id`) — falta só um campo estruturado de "artefato produzido" preenchido por `write`/`exec_command`, não uma abstração nova.

## 2. Event Log + Projection são realmente necessários já, ou existe algo mais simples?

Não são necessários no piloto. Servem para três coisas que R3 explicitamente excluiu do escopo aprovado:

- Reconciliar múltiplas versões concorrentes do mesmo artefato entre goals distintos (necessário só quando `SessionManager`/memória entrarem em escopo — fora do piloto).
- Buscar identidade por `path` entre sessões, para o caso "reenviar arquivo pré-existente" (R2 §12.1) — cross-goal, também fora do piloto.
- Dedup sob retry (R2 §12.3) — dentro de um único goal isso já é coberto por `goal.attempts` existente; não precisa de log separado.

Dentro do goal único que o piloto cobre, um campo simples em `GoalAttempt` (produzido por `write`/`exec_command`, lido por `RiskAnalyzer` no replan) resolve o problema com uma fração da superfície nova. **Event Log + Projection continuam sendo a resposta certa para a visão maior (R2 §11), mas justificam seu custo só quando o escopo realmente precisar de histórico cross-goal — o que, pela própria R3, ainda não está aprovado.** Adiar essa parte não é abandonar a ideia; é sequenciá-la corretamente.

## 3. Existe arquitetura conhecida mais elegante?

Sim — e o achado mais forte desta revisão é que **o projeto já usa, de forma ad hoc, o ingrediente certo**, sem ter formalizado isso como identidade.

`src/loop/GoalExecutionLoop.ts` já calcula `crypto.createHash('sha1').update(content).digest('hex')` em três pontos independentes (`~2345`, `~2943`, `~3048`) — tags de log `[ARTIFACT-STATE]`, `[VALIDATION-ARTIFACT]`, `[VALIDATION-FILE]` — para comparar "hash no momento da leitura" com "hash atual em disco" e detectar drift. Ou seja: **hash de conteúdo já é o sinal prático usado hoje para responder "isto ainda é o mesmo artefato?"** — só que de forma duplicada (3 call sites recalculando a mesma coisa, o mesmo padrão de fonte-múltipla-de-verdade que R1 documentou para `file_path`) e nunca promovido a identidade formal.

Comparando os padrões conhecidos levantados na pergunta:

| Padrão | O que resolve bem | Por que se encaixa (ou não) aqui |
|---|---|---|
| **Git (content-addressing)** | Identidade derivada do conteúdo, não de um nome/path atribuído | Encaixa diretamente: resolve "identidade nunca deve depender de path" (R1 §4, achado central) de forma mais forte que UUID — não é atribuída, é *derivada*, então nunca pode ficar "errada" por dessincronia de bookkeeping. Já existe precedente direto no código (acima). |
| **Digital Asset Management (Asset vs. Rendition)** | Separa identidade lógica ("a apresentação sobre segurança de redes") de representações físicas (`.pptx`, `.pdf` exportado, thumbnail) | Responde diretamente à ambiguidade que o próprio documento de continuação levanta (§161-181 do log): "Artifact" hoje tenta ser identidade + representação + histórico ao mesmo tempo. DAM já resolveu essa separação há décadas com vocabulário testado — não precisa ser reinventado agora. |
| **Distributed Tracing / Event Sourcing** | Reconstruir histórico operacional (quem tocou o quê, em que ordem, através de retries/replans) | Continua sendo o modelo certo para a camada de **histórico**, não para a camada de **identidade**. Ver §2 — correto para a visão maior, prematuro para o piloto. |
| **Build systems (Bazel/Nix)** | Identidade de artefato = hash das entradas (build determinístico) | Relacionado, mas resolve um problema mais amplo (reprodutibilidade) que não está em pauta aqui. Não descartar para o futuro, fora de escopo agora. |
| **Compiladores (IR/symbol table)** | Uma unidade lógica referenciada por símbolo, múltiplas representações (AST, bytecode, binário) | Mesma forma do problema do DAM, vocabulário menos natural para este domínio. DAM comunica melhor para quem for ler o código depois. |

**Síntese do achado:** a pergunta do documento de continuação ("Artifact talvez esteja representando conceitos diferentes ao mesmo tempo — identidade lógica, representação física, histórico operacional") não é uma dúvida em aberto — é o diagnóstico certo. `ArtifactTrace` (R2) tentava fazer as três coisas num objeto só. A resposta mais elegante é **não fazer isso**: usar hash de conteúdo pra identidade (Git), reservar o conceito de "múltiplas representações do mesmo lógico" pra quando ele for realmente necessário (DAM, ainda não — nenhuma evidência hoje de artefato com múltiplas representações no fluxo real), e reservar log de eventos pra histórico operacional cross-goal (tracing, adiado por §2).

## 4. Como preservar a separação futura entre identidade lógica e representação física sem aumentar complexidade agora?

Escolhendo hash de conteúdo como identidade do piloto, essa separação sai de graça, sem precisar construir Asset/Rendition agora: dois arquivos com o mesmo conteúdo byte-a-byte **são o mesmo artefato** por definição (não por bookkeeping), e um arquivo que muda de conteúdo (nova versão) naturalmente gera um hash novo — o equivalente a um "commit" apontando pra um "pai", se um dia for preciso modelar linhagem como DAG (a própria suspeita levantada no documento de continuação, §111 do log, "Lineage talvez seja DAG, não cadeia linear" — hash-parent é exatamente como Git resolve isso, sem precisar decidir a modelagem completa agora).

Não é necessário desenhar `Asset`/`Rendition` como tabelas ou classes hoje. É necessário só uma decisão de nomenclatura: o campo que `write`/`exec_command` preenche em `GoalAttempt` deve se chamar algo como `producedArtifactHash` (identidade), não `producedArtifactPath` (que seria representação física) — nome errado agora cristalizaria a confusão que o documento de continuação já identificou. Path continua existindo como um **atributo** do artefato (onde ele está agora), não como sua identidade.

## 5. Existe risco estrutural ainda não identificado?

Quatro pontos que nem R2 nem R3 tinham coberto:

1. **Custo de hashear arquivos grandes.** `.mp4`/`.pptx` grandes têm custo de I/O+CPU para hash completo a cada `write`/`exec_command`. Os 3 call sites existentes já fazem isso hoje (`readFileSync` + hash síncrono) sem problema reportado — mas valem um fast-path (`mtime`+`size` antes do hash completo) se o piloto tocar arquivos de mídia grandes, não só texto.
2. **Hash idêntico entre goals diferentes não é bug — é o modelo correto.** Se dois goals distintos produzirem conteúdo byte-idêntico (ex.: dois textos padrão), eles são legitimamente "o mesmo artefato" sob identidade por conteúdo. O modelo de dados não pode assumir 1 artefato = 1 goal; precisa suportar N attempts (de goals possivelmente diferentes) apontando para o mesmo hash. Não é um problema a resolver agora, é uma suposição a **não** fazer ao implementar.
3. **Identidade não é validade.** Hash garante "é o mesmo conteúdo de antes", não "o conteúdo é válido". Um `.pptx` corrompido ou vazio ainda hasheia normalmente. `WriteTool` já tem `CONTENT-STUB-GATE` pra texto; `exec_command` não tem nada equivalente pra binários gerados por script (R1 §9.6, já documentado como gap, mas vale reforçar que hash não fecha esse gap sozinho — são preocupações ortogonais).
4. **Vantagem lateral não pedida, mas relevante:** identidade por hash é imune à classe inteira de bugs de path/encoding que este projeto já sofreu repetidas vezes no Windows (`resolvePath` unificado, ADS de NTFS com `:` em filename — ver histórico em memória de julho/2026). Path nunca entra na comparação de identidade, então bug de normalização de path não pode mais causar "achei o artefato errado" — só pode causar "não encontrei o arquivo no disco", que já é um erro claro e não silencioso.

---

## Síntese — piloto revisado (substitui o desenho de identidade da R2/R3, mantém o resto)

O que muda em relação ao hard gate da R3:

| | R3 (aprovado condicionalmente) | R4 (revisão) |
|---|---|---|
| Identidade | `traceId` (UUID, atribuído) | hash de conteúdo (derivado) — já usado ad hoc em 3 pontos de `GoalExecutionLoop.ts` |
| Estrutura | Event log apensado + projeção | Campo novo em `GoalAttempt` existente (ex. `producedArtifactHash`) |
| Persistência | Nova tabela | Nenhuma tabela nova — reusa a transação de `GoalAttempt` já existente |

O que **não** muda (continua valendo o hard gate de R3): escopo travado em `exec_command` (declarar artefato) + resolução de `file_path` no replan; não tocar `sentArtifacts`, `SessionManager`, memória, `agentloop`, conversas.

Critério de sucesso permanece o mesmo de R3: teste equivalente ao `S109` passando via identidade estável no replan, mensuravelmente mais simples que o fix reativo atual — com a régua ainda mais alta agora, porque a barra de "mais simples" subiu (a alternativa de comparação já não é só o fix de hoje, é também o desenho de R2/R3 com event log).

**Hipóteses ainda não comprovadas** (herdadas de R3, sem mudança): que a chave de dedup evita colisão em retries complexos; que reverse-lookup por conteúdo (não mais por path) resolve de fato o caso "reenviar arquivo pré-existente" sem ambiguidade quando o conteúdo muda entre pedidos — ambas continuam sendo critério de revisão *durante* a implementação do piloto, não bloqueio para começá-lo.

Nenhum código foi alterado nesta sprint.
