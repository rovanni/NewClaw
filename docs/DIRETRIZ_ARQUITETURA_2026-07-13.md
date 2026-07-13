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

## Filosofia do projeto

Prioriza: simplicidade arquitetural, baixo acoplamento, conceitos universais, evolução incremental, decisões fundamentadas em evidências, documentação antes da implementação. Elegância arquitetural é mais importante que velocidade de implementação. Sempre preferir eliminar a causa estrutural em vez de corrigir sintomas isolados.
