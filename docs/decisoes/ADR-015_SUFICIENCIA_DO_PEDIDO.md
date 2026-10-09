# ADR-015 — Suficiência do pedido: validar a pergunta antes de agir

> **Status:** aprovado pelo operador como **prioridade 0** (09/10/2026) — implementado na mesma campanha (ver
> "Registro de implementação").
> **Data:** 09/10/2026
> **Origem:** operador — *"temos que colocar um juiz depois da pergunta para validar a pergunta"*; *"caso a memória não
> responda a dúvida, é obrigatório perguntar ao usuário"*; *"continuar com informações parciais ou faltando atrapalha
> mais, leva tempo, desperdiça tokens"*.
> **Relacionadas:** `ADR-014` (motor único de validação — este é o primeiro tipo novo nascido nele),
> `NUNCA_ADIVINHAR.md`, `INFORMACAO_COMPLETA_PARA_DECIDIR.md`, `RESPONSABILIDADE_ANTES_DO_MECANISMO.md`, issue 069.

---

## Fase 1 — Compreensão

### O caso

Produção, 09/10/2026, modelo local: *"Vai chover amanhã de manhã?"* foi respondida com a previsão de uma cidade que
ninguém informou — nem o usuário, nem a memória. A preferência "Clima padrão: <cidade>" existia, mas não chegou ao
modelo (corrigido na issue 069). Sem o dado, **o modelo preencheu a cidade por conta própria**, a ferramenta rodou, o
juiz aprovou (a resposta batia com o que a ferramenta devolveu) e o usuário recebeu uma resposta errada.

### Onde a pergunta "tenho o que preciso?" existe hoje

| Peça | O que faz | Por que não bastou |
|---|---|---|
| `GoalExtractor` → `isAmbiguous` | pede esclarecimento quando o pedido é ambíguo | só roda no caminho de **goal**; o "Vai chover?" foi pelo caminho direto. E no caso real o extrator nem chamou o LLM (`heuristic_negative`) |
| `AgentLoop.resolveMissingParameterFromEvidence` | parâmetro obrigatório vazio → consulta a memória | só no atalho (fast path), e só quando o campo vem **vazio** — no caso real ele veio **inventado** |
| `validateToolArgs` (issue 043) | barra campo obrigatório vazio antes do despacho | não consulta a memória nem pergunta; e os 18 casos do log são campos técnicos (`action`, `content`) que não se pergunta ao usuário |
| Juiz de grounding | confere a resposta contra as evidências | roda **depois** da resposta; não pergunta de onde veio um argumento |
| Prompt do agente (issue 069) | "se não estiver no pedido nem na memória, pergunte" | depende de o modelo obedecer |

### A pergunta (questionário de RESPONSABILIDADE_ANTES_DO_MECANISMO)

- **PERGUNTA:** "Para executar o que foi pedido, falta algum dado que só o usuário pode dar? Se falta, a memória/
  preferências/conversa respondem?"
- **RESPONSABILIDADE:** validar a SUFICIÊNCIA do pedido — antes de qualquer ferramenta rodar.
- **EVIDÊNCIA:** o pedido inteiro, as preferências salvas, a memória próxima do pedido, a conversa recente e as
  ferramentas disponíveis (com os parâmetros que cada uma exige).
- **AUTORIDADE:** o LLM interpreta ("que dados a ação exige?", "isto responde?"); o determinismo valida o que é
  objetivo — o trecho citado como origem do valor **existe literalmente** no pedido, nas preferências, na memória ou
  na conversa (pré-verificação `citacao_existe_na_fonte` do motor).
- **ESTADO:** suficiente | falta um dado e a memória tem (segue, origem registrada) | falta e ninguém tem (pergunta
  obrigatória).
- **CONSUMIDOR:** o `GoalOrchestrator`, no ponto por onde **toda** mensagem passa, antes da divisão goal/agente.

## Fase 2 — Crítica da hipótese

- **Custo (regra "substituir, nunca somar").** É mais uma chamada ao modelo (~5 s no modelo local) por pedido que vai
  usar ferramenta. Contra: o operador mediu o custo do contrário — cidade errada entregue; 7 min de replanejamento por
  interpretação errada; 5 consultas refeitas por falta de dado. Parar cedo e perguntar é o caminho barato. E a peça
  **substitui** a autoridade de `isAmbiguous` (quando o tipo novo rodou, ele decide se pergunta — uma autoridade só).
  A absorção completa da resolução de parâmetro do fast path fica para a fase 2 (abaixo).
- **Perguntar demais.** Um validador nervoso transforma cada pedido em interrogatório. Mitigação: o checklist pede só
  dados **específicos do usuário que nenhuma ferramenta descobre** (cidade da previsão, qual arquivo, para quem
  enviar) — nunca cotação, notícias, conteúdo de arquivo já indicado. Saudação e conversa não passam pelo validador
  (só pedidos que o roteador marcou como de ferramenta/planejamento).
- **Falha de infraestrutura (prazo, modelo fora do ar).** Bloquear o pedido por isso trocaria um defeito por outro.
  Decisão: não avaliável por infraestrutura **não bloqueia** — segue como antes e fica registrado. Só bloqueia o que o
  modelo afirmou que falta, ou um valor cuja origem citada não existe.
- **Origem inventada.** O modelo pode dizer "a cidade está na preferência" sem estar. A pré-verificação de citação
  barra isso de forma objetiva: o trecho citado tem de existir literalmente nas fontes; se não existe, o item vira
  "sem evidência" e conta como falta.
- **Idioma.** A pergunta ao usuário é escrita pelo modelo, no idioma do pedido — o Core não emite texto fixo
  (RFC-004).

## Fase 3 — Alternativas

| Alternativa | Por que não |
|---|---|
| Só reforçar o prompt do agente | já feito (069); depende de obediência — o operador pediu garantia |
| Checar a origem de cada argumento na hora da chamada da ferramenta | precisaria declarar no schema de cada ferramenta quais parâmetros vêm do usuário, e a comparação de valores ("Curitiba" × "Curitiba, PR") escorrega para heurística. A citação literal no momento da pergunta resolve o mesmo com o mecanismo que já existe |
| Ampliar `isAmbiguous` do `GoalExtractor` | o extrator é pulado por heurística e só vale no caminho de goal |
| Juiz depois da resposta | tarde: a ferramenta já rodou com o valor errado |

## Fase 4 — Síntese (decisão)

1. **Tipo novo no motor do ADR-014:** `suficiencia_do_pedido`, descritor declarativo (sem código de domínio no motor).
   Entradas: pedido (**objeto**); preferências salvas, memória próxima do pedido e conversa recente (**fontes de
   verdade**); ferramentas disponíveis com os parâmetros obrigatórios (**contexto da execução**). Agregação por itens:
   um item por dado do usuário que a ação exige; `sim` exige o trecho literal de onde o valor vem.
2. **O pedido também vale como fonte da citação** (o valor pode estar no próprio pedido). Extensão genérica do
   contrato: `fontesDaCitacao` (padrão: só `fonte_de_verdade`).
3. **Campo extra da saída**, genérico no contrato: `camposExtras` — aqui, `pergunta_ao_usuario`, escrita pelo modelo
   no idioma do pedido.
4. **Encaixe:** `GoalOrchestrator.process`, logo após o roteador, para todo pedido marcado como de ferramenta ou de
   planejamento — antes da divisão goal/agente. Reprovado → guarda o pedido em `pendingClarifications` (mecanismo que
   já existe) e devolve a pergunta; a resposta do usuário volta junta com o pedido original.
5. **Autoridade única de "perguntar ou não":** quando o tipo novo rodou, `isAmbiguous` do `GoalExtractor` não pergunta
   de novo (registrado no log).
6. **Infraestrutura não bloqueia;** desligável por `VALIDACAO_SUFICIENCIA=off` (padrão: ligado).
7. **Modelo:** `CLASSIFIER_MODEL` (mesma classe de decisão pré-ação); vazio = modelo padrão do provedor.
   **Raciocínio:** desligado (resposta curta e estruturada).

### Fase 2 desta decisão (não implementada nesta campanha)

- Entregar ao agente os valores resolvidos com a origem ("cidade = X, da preferência salva") e absorver
  `resolveMissingParameterFromEvidence`.
- Absorver de vez a pergunta de ambiguidade do `GoalExtractor` (hoje só perde a autoridade quando o tipo novo roda).

## Fase 5 — Validação

- **Evidência real?** Sim — 09/10, cidade inventada; e o mapa da Fase 1, com o caminho direto sem checagem nenhuma.
- **Estrutura ou sintoma?** Estrutura: o ponto por onde toda mensagem passa ganha a pergunta, com a origem do valor
  conferida pelo código.
- **Reduz complexidade?** Junta a autoridade de "perguntar ou não" num lugar; nasce no motor único, sem código novo de
  prompt/leitura/falha.
- **Fontes de verdade múltiplas?** Diminui: preferências da fonte única (069), autoridade única de esclarecimento.
- **Incremental e reversível?** Sim — `VALIDACAO_SUFICIENCIA=off` desliga; nada mais muda de comportamento.

### Riscos que permanecem

- Perguntas desnecessárias (falso positivo). Medido pelo gravador de voo (`validacao_suficiencia_do_pedido`): cada
  pergunta feita fica registrada com os itens e as fontes.
- Latência de uma chamada a mais por pedido de ferramenta no modelo local.

## Registro de implementação

- **09/10/2026 — implementado.** Tipo `suficiencia_do_pedido` (`src/validation/tipos/suficienciaDoPedido.ts`),
  registrado em `src/validation/motorPadrao.ts`; extensões genéricas do contrato `fontesDaCitacao` e `camposExtras`
  (`contratoDeValidacao.ts`, `ValidationEngine.ts`); encaixe em `GoalOrchestrator.verificarSuficiencia` (antes da
  divisão goal × agente); `MemoryManager.memoriaProximaDoPedido` (fonte única da "memória do pedido", também usada pelo
  fast path). Teste `S368`.
- **Achado na navegação e corrigido na mesma campanha:** o esclarecimento guardava só o pedido; a resposta chegava como
  `[RESPOSTA DO USUÁRIO]: Florianópolis` e o agente respondeu "a cidade já estava salva na memória" sem consultar o
  tempo. Agora `pendingClarifications` guarda também a pergunta feita (`guardarEsclarecimento`, nos quatro pontos de
  esclarecimento) e a mensagem combinada diz o que foi perguntado e manda atender o pedido original.
- **Achado na medição e corrigido:** com a mesma pergunta, o modelo uma vez resolveu "a cidade da minha mãe" com a
  preferência "cidade padrão" (o trecho existia, mas respondia a outro dado). Item novo no checklist: o valor tem de
  responder EXATAMENTE ao dado pedido; preferência genérica não vale quando o pedido especifica outra coisa.
- **Medição (modelo local, 3 execuções por caso, entradas reais):** 12/12 decisões corretas — "cidade da minha mãe" →
  pergunta; "Vai chover amanhã de manhã?" → segue com a cidade da preferência; criptomoedas → segue sem perguntar;
  "Mande o relatório para o meu chefe" → pergunta o arquivo e o e-mail. 3,4–15 s por chamada.
- **Navegação como leigo:** "Vai chover amanhã na cidade da minha mãe?" → "Qual é o nome da cidade de sua mãe?" →
  "Florianópolis" → previsão de Florianópolis.
