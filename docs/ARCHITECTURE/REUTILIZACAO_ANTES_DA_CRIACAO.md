# ARCH-REUSE-001 — Reutilização Antes da Criação

**Status:** Aprovada e ativa (incorporada à Regra 12 de AGENTS.md)  
**Escopo:** Todos os agentes, tarefas de correção, manutenção, refatoração e desenvolvimento do NewClaw / Cognitive Kernel.

## 1. Princípio fundamental

Nenhum agente deve criar um novo componente, serviço, módulo, mecanismo, abstração ou sistema para resolver um problema sem antes investigar as soluções existentes e avaliar sua adequação.

A ordem de preferência é:

1. Reutilizar uma solução existente e validada.
2. Adaptar uma solução existente quando necessário.
3. Refatorar ou substituir uma implementação inadequada, mediante justificativa técnica.
4. Desenvolver uma solução nova quando as alternativas anteriores forem insuficientes ou quando uma alternativa superior for demonstrada por evidências.

A novidade, isoladamente, não constitui justificativa técnica.

## 2. Investigação obrigatória

Antes de implementar uma solução, o agente deve investigar, conforme a relevância para o problema:

- O código existente no repositório.
- Os serviços, módulos, interfaces e abstrações já disponíveis.
- As soluções utilizadas por outros agentes do próprio sistema.
- O histórico de alterações, incidentes e correções semelhantes.
- A documentação arquitetural, os ADRs, os RFCs e as diretrizes vigentes.
- Soluções consolidadas em projetos externos, documentação oficial e literatura técnica, quando pertinentes.

A investigação deve priorizar fontes relevantes e evidências verificáveis, sem exigir pesquisas externas desnecessárias para problemas já resolvidos internamente.

## 3. Comparação de alternativas

Para cada alternativa relevante, avaliar:

- Correção funcional.
- Compatibilidade com a arquitetura existente.
- Segurança e confiabilidade.
- Complexidade adicionada.
- Custo de manutenção.
- Reutilização e interoperabilidade.
- Cobertura de testes e evidências de funcionamento.
- Restrições de licença e atribuição de autoria, quando aplicáveis.

O agente não deve presumir que uma solução é melhor apenas porque é mais recente, mais sofisticada ou foi desenvolvida por ele próprio.

## 4. Condições para criar uma solução nova

Uma nova implementação é permitida quando o agente demonstrar pelo menos uma justificativa concreta:

- Não existe solução existente adequada.
- A solução atual não atende a um requisito comprovado.
- A solução existente apresenta falhas, limitações ou riscos relevantes.
- Uma alternativa oferece melhoria mensurável sem comprometer requisitos essenciais.
- Uma mudança arquitetural é necessária para corrigir um problema estrutural.

Sempre que viável, a comparação deve utilizar testes reproduzíveis, benchmarks, análise de complexidade ou evidências equivalentes.

Se não houver evidências suficientes para demonstrar superioridade, o agente deve preferir a solução existente que atende aos requisitos, ou registrar a incerteza antes de propor uma mudança de maior impacto.

## 5. Reutilização sem plágio

Reutilizar conhecimento não significa copiar indiscriminadamente código ou documentação.

O agente deve:

- Compreender a solução de origem antes de aplicá-la.
- Identificar a autoria e as condições de licença quando utilizar código externo.
- Respeitar direitos autorais, atribuições e obrigações de distribuição.
- Adaptar a solução às interfaces, convenções e requisitos do NewClaw.
- Preservar a autoria e a proveniência dos componentes.
- Registrar a origem das ideias ou implementações relevantes.

A implementação própria deve demonstrar compreensão e adequação técnica, não apenas reproduzir superficialmente uma solução encontrada.

## 6. Proteção contra duplicação

Antes de criar um novo componente, o agente deve verificar se outro componente já oferece a mesma responsabilidade ou uma capacidade equivalente.

Se houver sobreposição, deve preferir reutilização, extensão ou consolidação, salvo justificativa documentada para manter componentes distintos (ver critério formal de extração vs. aceitação em `docs/ARCHITECTURE/QUANDO_EXTRAIR_DUPLICACAO.md`).

Nenhum novo serviço, registro, camada de abstração ou mecanismo de memória deve ser criado apenas para contornar uma dificuldade local quando uma solução existente puder resolver o problema com menor complexidade.

## 7. Registro obrigatório da decisão

Toda alteração relevante deve registrar:

- Problema identificado.
- Soluções existentes investigadas.
- Alternativas consideradas.
- Solução escolhida e justificativa.
- Evidências, testes e limitações.
- Componentes reutilizados ou modificados.
- Novos componentes introduzidos e motivo de sua necessidade.
- Impactos arquiteturais e riscos de regressão.

Correções triviais podem utilizar um registro proporcional ao seu impacto, sem produzir documentação burocrática.

## 8. Critério de conclusão

Uma correção não está concluída apenas porque o erro imediato desapareceu.

O agente deve verificar os testes pertinentes, avaliar regressões, confirmar a compatibilidade com a arquitetura e registrar o aprendizado necessário para evitar a repetição do problema.

Quando uma solução reutilizável for descoberta, o agente deve avaliar se ela merece ser incorporada à documentação, aos padrões compartilhados ou aos recursos disponíveis para os demais agentes.

## 9. Regra de precedência

Esta diretriz complementa as políticas de segurança, os contratos de interface, as decisões arquiteturais aprovadas e os requisitos funcionais do projeto.

Ela não autoriza ignorar controles de segurança, alterar contratos incompatíveis ou substituir componentes aprovados sem a validação exigida pelo projeto.

## 10. Princípio final

**Investigue antes de criar. Reutilize antes de duplicar. Adapte antes de substituir. Demonstre antes de declarar superioridade. Documente para que o próximo agente não precise começar do zero.**
