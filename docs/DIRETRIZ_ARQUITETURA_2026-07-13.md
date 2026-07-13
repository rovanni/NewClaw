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

## Filosofia do projeto

Prioriza: simplicidade arquitetural, baixo acoplamento, conceitos universais, evolução incremental, decisões fundamentadas em evidências, documentação antes da implementação. Elegância arquitetural é mais importante que velocidade de implementação. Sempre preferir eliminar a causa estrutural em vez de corrigir sintomas isolados.
