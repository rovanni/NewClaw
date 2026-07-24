# Diretriz Permanente de Arquitetura

A partir de 2026-07-13, toda mudança arquitetural neste projeto segue obrigatoriamente o processo abaixo antes de qualquer implementação. Objetivo: evitar que uma boa ideia seja implementada antes de ser suficientemente criticada.

Origem: Sprint R1/R2 (`docs/AUDITORIA_PIPELINE_ARTEFATOS_SPRINT_R1_2026-07-13.md`, `docs/ANALISE_ARQUITETURAL_COGNITIVE_ENVELOPE_SPRINT_R2_2026-07-13.md`).

## Princípio fundamental

Nunca implemente a primeira solução encontrada. Toda proposta arquitetural é apenas uma hipótese inicial — antes de implementar, tente prová-la errada. Se existir uma solução melhor, mais simples, mais elegante ou mais consistente com a arquitetura do Cognitive Kernel, ela deve ser preferida.

## Processo obrigatório

Aplica-se a qualquer mudança que introduza um novo conceito arquitetural, um novo objeto/serviço central, ou altere como múltiplas camadas se comunicam. Não se aplica a correções pontuais de bug isoladas (essas seguem [[feedback_correcoes_pontuais]] — mapear o entorno antes de mudar, mas sem exigir as 5 fases completas).

### Fase 1 — Compreensão
Antes de sugerir qualquer alteração:
- compreender completamente o problema e identificar sua causa raiz;
- verificar se já houve tentativa anterior semelhante (buscar no histórico do git e nas memórias do projeto);
- levantar decisões arquiteturais relacionadas;
- localizar bugs históricos que possam estar conectados.

Nenhuma solução deve ser proposta antes dessa análise.

### Fase 2 — Crítica da hipótese
Assuma que a proposta inicial pode estar errada. Procure deliberadamente:
- inconsistências, casos extremos, regressões possíveis;
- conflitos com decisões anteriores do projeto;
- aumento de complexidade, acoplamentos desnecessários;
- risco de criar um novo "God Object";
- alternativas mais elegantes.

O objetivo desta fase é encontrar motivos para NÃO implementar a ideia.

### Fase 3 — Pesquisa de alternativas
Responder sempre:
- Existe uma solução mais simples?
- Existe um padrão conhecido da engenharia de software (sistemas distribuídos, bancos de dados, compiladores, sistemas operacionais, redes, arquitetura orientada a eventos, DDD etc.) que resolve isso?
- Existe decisão anterior do projeto que torna a proposta inadequada?
- Existe solução que elimine uma classe inteira de bugs, em vez de corrigir um caso específico?

Apresentar todas as alternativas relevantes, com vantagens, desvantagens e trade-offs.

### Gate obrigatório — Extensão antes de Criação (Tool / Skill / Script)

Origem: auditoria "Self Review Visual" (2026-07-23). A primeira proposta arquitetural passou
pelas Fases 1-3 normalmente e mesmo assim propôs 3 arquivos novos (`scripts/screenshot.js`, uma
Tool nova, uma Skill nova). Numa segunda passada adversarial obrigatória, os três se revelaram
desnecessários: já existia uma versão quase completa de cada um no repositório
(`scripts/html2pdf.sh`, `processVision()` + `read_document.ts`, `skills/content-validator/SKILL.md`).
A pergunta "existe solução mais simples?" da Fase 3 já existia, mas respondida em abstrato não foi
suficiente — só funcionou quando aplicada arquivo por arquivo, de forma falseável.

Sempre que uma proposta incluir uma nova **Tool** (`ToolExecutor` em `src/tools/`), uma nova
**Skill** (`skills/*/SKILL.md`) ou um novo **Script** (`scripts/*.sh`/`.js` chamado por
`exec_command`), a Fase 3 só está completa depois de responder, para CADA arquivo novo proposto:

1. Este arquivo realmente precisa existir? (SIM/NÃO)
2. Existe alguma implementação já presente no NewClaw que resolve parte disso? Nomear o arquivo exato.
3. Existe uma extensão pequena em código/skill/script já existente que elimina a necessidade deste arquivo?
4. Se, mesmo assim, o arquivo for inevitável — provar por quê (o que ele faz que nenhuma extensão
   pequena de algo já existente conseguiria fazer).

Só prosseguir para a Fase 4 com os arquivos que sobrarem depois desse filtro. Arquivo eliminado
neste gate não entra em "arquivos afetados" como arquivo novo — vira edição de um arquivo existente.

**Por que isso importa mais do que parece:** é exatamente esse tipo de crescimento incremental —
cada capacidade nova ganhando sua própria Tool/Skill/Script "porque é o padrão", sem checar
primeiro o que já existe — que transforma um projeto com poucos componentes bem entendidos num
sistema com dezenas de arquivos quase-duplicados, cada um levemente diferente do outro, nenhum
claramente responsável por nada. Cada arquivo novo precisa justificar a própria existência.

### Fase 4 — Síntese
Após criticar as alternativas, apresentar uma recomendação: por que foi escolhida, por que as demais foram descartadas, quais riscos permanecem, quais hipóteses ainda não foram comprovadas. Não esconder limitações.

### Fase 5 — Validação
Antes de implementar, responder:
- A proposta é baseada em evidências reais do projeto ou apenas em hipótese?
- Resolve um problema estrutural ou só um sintoma?
- Reduz a complexidade total do sistema?
- Elimina múltiplas fontes de verdade?
- Mantém a filosofia do Cognitive Kernel?
- Pode ser implementada incrementalmente?
- Pode ser revertida facilmente caso falhe?

Só implementar se todas as respostas forem satisfatórias.

## Implementação

Só começar quando: nenhuma alternativa significativamente melhor tiver sido encontrada; a arquitetura estiver suficientemente amadurecida; os riscos estiverem documentados; existir plano incremental de migração; existirem critérios objetivos de sucesso. Havendo dúvida arquitetural relevante, interromper a implementação e continuar a investigação.

## Validação Progressiva

Para toda mudança arquitetural relevante (mesmo critério de escopo da Fase 1), a validação segue quatro etapas obrigatórias, nesta ordem, antes de considerar a mudança pronta para merge:

1. **Testes unitários** — funções isoladas, sem I/O real.
2. **Testes de regressão** — suíte completa do projeto (`npm run test:regression`), incluindo os casos novos que cobrem a mudança.
3. **Testes end-to-end sintéticos** — fluxo completo do componente, com dependências externas (LLM, HTTP, filesystem) mockadas.
4. **Execução em ambiente real** — app real rodando, LLM real, HTTP real, planner real, filesystem real. Numa instância isolada (porta/DB/workspace separados de qualquer processo em uso), nunca contra dado de produção.

Só considerar uma mudança validada depois da etapa 4. Etapas 1-3 continuam necessárias — não são substituídas pela 4, são complementares (guarda contra regressão futura; a etapa 4 sozinha não é repetível/barata o suficiente para rodar a cada mudança pequena no futuro).

**Por que a etapa 4 é obrigatória, não opcional:** duas evidências concretas, não hipotéticas, do próprio histórico deste projeto:
- `SessionTranscript.migrateLegacyColonPath` (`project_session_bugs_jul2026_am`, memória): passou em teste de regressão e `tsc --noEmit`, mas falhava de verdade em runtime (`fs.renameSync` retorna `EINVAL` ao mover de uma NTFS Alternate Data Stream no Windows) — só descoberto rodando contra uma cópia de dado real.
- `resolveArtifactPathFromEvidence` (Sprint R1-R7, piloto de resolução de `file_path`, 13/07/2026): passou 100% num teste de regressão com LLM mockado à mão — mas o mock foi escrito pela mesma pessoa que escreveu o fix, com a extensão de arquivo já certa. Rodando a app real contra um LLM real (Ollama), um replan real e espontâneo expôs que o código escolhia um script-fonte (`.py`) em vez do arquivo pedido (`.txt`).

Em ambos os casos, a causa nunca foi falta de rigor no teste — foi que o teste testava a implementação do jeito que o autor a entendia, não o comportamento real do sistema (SO, filesystem, LLM) sob o qual ela roda. Mock e código compartilham o mesmo ponto cego.

**Como aplicar:** ao terminar a implementação de uma mudança arquitetural relevante, antes de declarar concluído ou abrir PR — subir a app de verdade (`ts-node src/index.ts` ou equivalente) numa instância isolada, dirigir via HTTP/CLI real o fluxo que a mudança afeta, com o LLM real configurado (não mockado), e observar o resultado real. A skill `verify` do Claude Code é o mecanismo indicado para isso quando disponível.

## Princípio da Preservação do Raciocínio

Origem: auditoria do padrão "Evidence Providers" (2026-07-23) — mapeamento de todos os
componentes que alimentam `GoalPlanner` (`CapabilityRegistry`, `SkillLoader`, `MemoryManager`,
`ReflectionMemory`, `StrategyDiversityGuard`, `GoalProgressModel`, e o caso pendente `CaseMemory`).

**Componentes determinísticos devem fornecer fatos, restrições e garantias ao agente, mas nunca
substituir seu processo de raciocínio — exceto quando houver requisito explícito de segurança,
integridade ou conformidade.**

### O que isso significa na prática

Um componente determinístico está OK quando entrega texto/dado para a chamada de LLM ponderar,
sem decidir por ela — é o que os 6 componentes acima já fazem hoje: cada um aplica seu próprio
filtro/threshold internamente (ex: `ReflectionMemory.buildContextHint()` só surge com
`failure_rate >= 0.30`), mas o resultado sempre vira um bloco de texto concatenado no prompt —
nunca um `if` em TypeScript que decide o rumo do plano. `CaseMemory.ts:432` e `:477` documentam
essa fronteira quase literalmente: *"NÃO gera plano, NÃO define estratégia... NÃO filtra, NÃO
reordena, NÃO combina score em score único"*.

Um componente determinístico está violando o princípio quando decide sozinho, sem passar pela
chamada de LLM, "o que fazer" diante de uma situação ambígua — mesmo que a decisão pareça
razoável — sem que exista uma justificativa de segurança/integridade/conformidade nomeável.

### Exceção legítima — quando um componente PODE decidir sozinho

Só por segurança/integridade/conformidade, nunca por conveniência ou para economizar uma chamada
de LLM. Precedentes reais já existentes no projeto:

- `RiskAnalyzer`/`isDestructive()` (`server_config.ts`) — bloqueio absoluto de padrões
  catastróficos (`rm -rf /`, `shutdown`, `mkfs`), em todos os modos, sem exceção. Decisão binária
  de segurança, não de estratégia.
- `ReflectionMemory.buildConstraints()` — falha recente ≥90% vira proibição dura, não sugestão.
  Mesmo aqui a decisão tem um escape hatch: em GOD mode a constraint é registrada mas marcada
  `[CONSTRAINT-BYPASSED]`, sem enforcement — o sistema nunca tira a autonomia final do operador
  que escolheu explicitamente mais risco.

A linha entre "constraint dura por segurança" e "decisão estratégica que deveria ficar com o
Planner" nem sempre é óbvia — `buildConstraints()` já mistura os dois motivos (parte é segurança
real, como PEP 668; parte é "essa tool falhou muito, evite", que é mais estratégico que de
segurança). Essa é uma tensão aceitável, registrada aqui para não ficar implícita — não é motivo
para reescrever nada agora.

### Violação já identificada, não corrigida (débito conhecido)

A mesma auditoria encontrou que parte de `GoalPlanner.ts` (`buildReplanPrompt`) já viola este
princípio: `pipVenvLoopDirective`, `execCommandBanDirective`, `contentStubDirective`,
`implementDirective` são heurísticas regex embutidas diretamente no Planner (não um componente
separado com threshold nomeado), com linguagem de regra dura ("será bloqueado automaticamente",
"será descartado automaticamente") — nem fato para o LLM ponderar, nem constraint de segurança
explícita como PEP 668. Registrado aqui como débito conhecido, fora do escopo desta diretriz
corrigir agora.

### Como aplicar

Na Fase 2 (Crítica da hipótese) de qualquer proposta que introduza um componente determinístico
influenciando o comportamento do agente, perguntar explicitamente: **esse componente está
fornecendo evidência para o Planner decidir, ou está decidindo por ele?** Se está decidindo,
existe uma justificativa de segurança/integridade/conformidade explícita e nomeável (como
`isDestructive()` ou o corte de 90% do `ReflectionMemory`)? Se não houver, a proposta deve ser
redesenhada para devolver fato/texto em vez de decisão.

## Princípios formalizados (Milestone C1)

Três princípios nascidos das auditorias de 2026-07-23/24 têm documento normativo próprio em
`docs/ARCHITECTURE/` — leitura obrigatória antes de propor qualquer componente novo de
conhecimento ou decisão:

- **Evidence Provider Pattern** (`docs/ARCHITECTURE/EVIDENCE_PROVIDER_PATTERN.md`) — mecanismo
  concreto pelo qual o Princípio da Preservação do Raciocínio (acima) se realiza: componentes de
  conhecimento produzem texto para o Planner ponderar, nunca decidem por ele, exceto as duas
  exceções nomeadas ali (Seção 7).
- **Separação Distribuído × Aprendido** (`docs/ARCHITECTURE/SEPARACAO_DISTRIBUIDO_APRENDIDO.md`)
  — conhecimento versionado em código-fonte (`KNOWN_DEPS`) e conhecimento aprendido em runtime
  (`ReflectionMemory`, `CaseMemory`, `OperationalKnowledge`) são categorias físicas distintas;
  travessia de uma para outra exige revisão humana (PR), nunca é automática.
- **Nunca Adivinhar** (`docs/ARCHITECTURE/NUNCA_ADIVINHAR.md`) — diante de um dado necessário que
  não foi observado ou configurado explicitamente, o comportamento correto é reportar ausência,
  nunca inferir um valor plausível e apresentá-lo como fato.

## Filosofia do projeto

Prioriza: simplicidade arquitetural, baixo acoplamento, conceitos universais, evolução incremental, decisões fundamentadas em evidências, documentação antes da implementação. Elegância arquitetural é mais importante que velocidade de implementação. Sempre preferir eliminar a causa estrutural em vez de corrigir sintomas isolados.
