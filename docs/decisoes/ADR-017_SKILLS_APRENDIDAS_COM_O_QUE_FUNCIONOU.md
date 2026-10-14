# ADR-017 — Skills aprendidas com o que funcionou (aprendizado no estilo Hermes)

Status: aceita (14/10/2026) — incremento 1 implementado; validação em ambiente real pendente (etapa 4).
Origem: pedido da mantenedora ("adicionar automaticamente as Skills, somente avisar o usuário que aprendeu algo novo,
como o Hermes Agent faz") e a investigação dos logs de 11–13/10/2026 (Windows × Linux).

## Fase 1 — Compreensão

**O que existe.** O `SkillLearner` conta (padrão × ferramenta) a cada execução de ferramenta; com 3 sucessos e ≥ 80% de
acerto cria uma PROPOSTA (`status='proposed'`) que só vira `SKILL.md` quando aprovada no painel. O conteúdo de padrões
fora do catálogo é um molde fixo: *"Quando detectar este padrão, use <ferramenta> para processar a solicitação."*

**O que os dados mostram** (bancos de produção, 14/10/2026, somente leitura):

- A aprovação não é o gargalo: Windows tem 19 skills aprendidas ativas e 1 proposta; Linux, 27 ativas e 1 proposta.
- O conteúdo é: `Gmail Access` (374 bytes), `Email Access` (338 bytes) — o molde acima, repetido em variantes por
  ferramenta (`Email Access`, `Email Access (edit)`, `Email Access (memory_search)`).
- A skill que fez diferença, `gmail-himalaya` (6,9 KB, 9 seções, configuração validada), foi escrita pelo AGENTE a pedido
  da mantenedora (11/10 08:47, ferramenta `write`) — no workspace, pasta que o `SkillLoader` não lê; foi copiada para
  `skills/` à mão no dia seguinte.

**Decisões anteriores que se aplicam.** RFC-001 (conhecimento aprendido é Evidence Provider, o Planner decide, nada de regra
imperativa escondida); Separação Distribuído × Aprendido (aprendido fica local, nunca vira código); Informação Completa
para Decidir (o LLM recebe o que um humano precisaria); Responsabilidade antes do Mecanismo; regra de custo (substituir,
nunca somar). `CaseMemory` já responde "esta trajetória tem evidência de que funcionou?" (modo sombra).

## Fase 2 — Crítica (motivos para NÃO fazer)

| Risco | Tratamento |
|---|---|
| Ativar sozinho espalha moldes inúteis (o que já acontece) | O que se aprende muda: o PROCEDIMENTO que funcionou, escrito pelo LLM a partir da trajetória; o molde genérico deixa de ser gerado quando o aprendizado automático está ligado (substitui, não soma) |
| Segredo vazar para um arquivo persistente (já houve senha de app no chat) | O LLM não recebe saídas de ferramentas; validação determinística rejeita a skill se contiver segredo conhecido: valores de variáveis de ambiente sensíveis, argumentos sensíveis da trajetória, formatos de credencial |
| Injeção de instruções persistente (texto de e-mail ou página virando regra) | Saídas de ferramentas não entram no prompt — só o pedido, as AÇÕES do próprio agente (ferramenta + argumentos) e erros curtos |
| Procedimento inventado | Só goals validados como concluídos (critério cumprido ou veredito "aprovado" do juiz de conclusão); o prompt exige usar apenas ações que deram certo; a skill declara de onde veio |
| Skill de Windows usada no Linux (e vice-versa) | A plataforma vai no texto da skill e na descrição |
| Custo/latência | Uma chamada por goal concluído com ≥ 2 ações bem-sucedidas, FORA do caminho da resposta (depois que o usuário já recebeu) |
| Regra escondida | A skill é um `SKILL.md` visível, listada no painel, com origem declarada; o usuário é avisado e pode desativar |

## Fase 3 — Alternativas

1. **Só aprovar automaticamente as propostas atuais** — descartada: ativaria os moldes de 350 bytes (Fase 1).
2. **Promover os casos do `CaseMemory` a skills** — descartada como mecanismo único: o portão dele (critério cumprido ou
   entrega confirmada) deixa de fora tarefas operacionais sem arquivo (medido: 7 de 22 goals concluídos no Windows desde
   01/10; o caso do Gmail ficaria de fora). O critério de evidência foi reaproveitado em espírito: goal validado.
3. **Novo componente "SkillWriter"** — descartada (Extensão antes de Criação): o `SkillLearner` já é dono do ciclo de vida
   (tabela `auto_skills`, exportação, ativação, desativação, painel). Estende-se o `SkillLearner`; as funções puras ficam num
   módulo-folha testável (`src/loop/aprendizadoDeSkills.ts`).
4. **Revisão por um juiz antes de ativar** — adiada: somaria uma chamada a cada aprendizado; a mitigação escolhida é
   estrutural (não ver saídas) + determinística (segredos) + humana a posteriori (aviso com desfazer). Reavaliar com dados.

## Fase 4 — Síntese (o que foi feito)

Questionário de Responsabilidade antes do Mecanismo:

| | |
|---|---|
| PERGUNTA | Esta trajetória bem-sucedida ensinou um procedimento reutilizável? Qual? |
| RESPONSABILIDADE | `SkillLearner` (dono das skills aprendidas) |
| EVIDÊNCIA | Pedido íntegro, objetivo, plataforma, idioma, ações na ordem (ferramenta + argumentos + deu certo/erro), inclusive as de dentro dos sub-turnos (rastro de execução), e a lista das skills existentes (nome + descrição) |
| AUTORIDADE | O LLM decide se vale aprender e escreve o procedimento (semântico); o determinismo valida forma, tamanho, nome, ausência de segredo e o portão estrutural (goal validado, ≥ 2 ações bem-sucedidas) |
| ESTADO | Linha `auto_skills` (`status='active'`, `source_pattern='trajetoria'`) + `SKILL.md` em `skills/<nome>/` |
| CONSUMIDOR | `SkillLoader`/`SkillDiscovery` (já existentes) → contexto do Planner (Evidence Provider) |
| MECANISMO | Uma chamada ao LLM com o modelo do planejador escolhido pelo usuário, depois da resposta; aviso no mesmo canal |

Configuração: `APRENDIZADO_DE_SKILLS=automatico` (padrão) | `proposta` (comportamento anterior) | `desligado`.
Desfazer: `/skill_desativar <nome>` no chat, ou o painel de Skills.

Riscos que permanecem: procedimento correto para aquela máquina mas frágil em outra; skills aprendidas não são atualizadas
(o Hermes corrige a skill quando ela falha — incremento 2); o LLM pode julgar "vale aprender" com generosidade (o aviso e o
desfazer são a contenção).

## Fase 5 — Validação

- Baseada em evidência real (bancos e logs de produção), não hipótese.
- Ataca a causa (conteúdo sem valor), não o sintoma (aprovação manual).
- Reduz complexidade líquida: o molde genérico deixa de ser gerado; nenhum componente novo com estado próprio.
- Uma fonte de verdade: a tabela `auto_skills` + o `SKILL.md` exportado por ela.
- Mantém o Cognitive Kernel: a skill é evidência para o Planner, nunca decisão.
- Incremental e reversível: `APRENDIZADO_DE_SKILLS=proposta` volta ao comportamento anterior; cada skill se desativa sozinha.
- Validação progressiva: etapas 1–3 (S393); etapa 4 (app real, LLM real) pendente de autorização de cota.
