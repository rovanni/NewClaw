# ADR-038 — Contexto do turno por necessidade: o que entra em cada chamada do agente

Data: 04/11/2026. Status: **encerrada sem mudança no código** (Revisão 3, 05/11/2026). D1 e D2 descartadas pela medição
da Revisão 1. D3 = β foi medida no D4 (modelo local e modelo de produção) e **não é ativada**. O juiz de suficiência segue
como está (ADR-015 intacta). Nada implementado.

Relacionadas: ADR-021 (catálogo de ferramentas sob demanda), ADR-015/029 (juiz de suficiência e pedido completo),
ADR-036 (skills oficiais, aprendidas e promovidas), `docs/ARCHITECTURE/INFORMACAO_COMPLETA_PARA_DECIDIR.md`,
`docs/ARCHITECTURE/RESPONSABILIDADE_ANTES_DO_MECANISMO.md` (regra de custo: substituir, nunca somar).

## Fase 1 — Compreensão

### O pedido

A operadora (04/11/2026): "verificar também a ingestão de contexto desnecessário no NewClaw, isso desperdiça tokens".

### Medição (VPS, log de produção, 01/10–03/11/2026, 96 turnos)

Fonte: linhas `[TOKENS-SOMBRA]` (contagem do servidor) e `[TOOLS-CATALOGO]`/`[SKILL]`/`SessionContext` do mesmo log.

| Componente | Chamadas | Entrada média | Parte da entrada |
|---|---:|---:|---:|
| `AgentLoop:loop` (o agente) | 223 | 11.938 | 64,2% |
| `ValidationEngine:saida_contra_evidencia` | 34 | 12.066 | 9,9% |
| `ValidationEngine:qualidade_da_resposta` | 15 | 12.790 | 4,6% |
| `UnifiedIntentRouter:classifier` | 93 | 2.068 | 4,6% |
| `ValidationEngine:suficiencia_do_pedido` | 36 | 4.866 | 4,2% |
| demais (planner, replan, passos, risco, extrator…) | — | — | 12,5% |

Total: 4,15 milhões de tokens de entrada (≈43 mil por turno) e 1,64 milhão de saída. As decisões antes do agente
(extrator, roteador, domínio, suficiência) somam ≈4,4 mil de entrada e ≈1,4 mil de saída por turno.

**O custo do agente é uma base fixa reenviada a cada volta do laço**, não o acúmulo de resultados de ferramenta. A primeira
chamada de um turno já leva 7–9,5 mil tokens; cada volta seguinte cresce ~200. Um turno de 53 voltas reenviou a base 53
vezes (≈600 mil tokens). A base, pelos tetos do `ContextBudget` (constantes, não medidos): prompt-mestre ≤1.500, estado
≤500, memória ≤1.000, skills ≤500, resumo ≤2.000, histórico ≤2.000, mais o esquema das ferramentas (mediana 10.704
caracteres, ≈3 mil tokens; até 17.957 quando o filtro não se aplica).

### O que dentro da base é desnecessário — ou falta

1. **Prompt-mestre monolítico, cortado sem aviso.** `buildMasterPrompt('execution')` tem 9.322 caracteres (≈2.673
   tokens): junta as regras de conteúdo acadêmico, áudio, infraestrutura/SSH, clima/mercado e visão para qualquer pedido
   da categoria. O `ContextBudget` corta em 1.500 tokens (5.242 caracteres) e acrescenta só `[...truncated]`. O que sai, em
   toda chamada de `execution` (177 das chamadas medidas), `code` (2.222 tokens) e `analysis` (2.386): as seções de
   conteúdo acadêmico e slides, áudio, SSH, clima, visão e o "FORMATO DE RESPOSTA OBRIGATÓRIO (JSON)". Paga-se por
   regras que não se aplicam ao pedido, e as que se aplicam podem ser as cortadas (no pedido da aula, 03/11, a regra de
   slides não chegou).
2. **Skills escolhidas por palavra-gatilho no texto.** `discoverSkills(...).byTrigger` sobre a mensagem: no pedido da
   aula (ementa de 1.584 caracteres com "internet", "redes sociais", "TikTok", "correio eletrônico"), 9 skills entraram
   como contexto — auditoria de porta de rede, SSH por senha, teste de servidor com curl, configuração de e-mail, dois
   padrões aprendidos automaticamente… — e a útil (`pptx-generator`) não. O bloco é cortado em 500 tokens, então o que sobra é o
   começo das primeiras. É heurística escolhendo o que o LLM vê (`INFORMACAO_COMPLETA_PARA_DECIDIR.md`, proibição 4).
3. **Memória de baixa relevância.** No mesmo turno, entrou um nó "lembrete diário" com relevância 0,052.
4. **Decisões em série antes de agir.** Para "Gera em PowerPoint editável": extrator (1.961 entrada / 2.347 saída, quase
   tudo raciocínio), roteador (1.045 / 168) e suficiência (5.721 / 1.855, 43 s). A suficiência recebe a lista inteira das
   ferramentas e das 32 skills instaladas — entre elas dezenas de padrões aprendidos automaticamente ("Padrão aprendido
   automaticamente: 3 usos bem-sucedidos com …").

### Como OpenClaw e Hermes Agent tratam isso (docs oficiais, lidas em 04/11/2026)

- **Skills sob demanda:** OpenClaw põe no prompt só nome e descrição; o `SKILL.md` é lido quando o modelo decide usá-la.
- **Arquivos de contexto com teto declarado:** OpenClaw `bootstrapMaxChars` 20.000 por arquivo, `bootstrapTotalMaxChars`
  60.000; Hermes `MEMORY.md` 2.200 e `USER.md` 1.375 caracteres, com erro ao estourar (não corte silencioso).
- **Prefixo estável para cache:** OpenClaw fixa o prompt de sistema da sessão e manda mudanças como mensagens; Hermes
  congela a memória no início da sessão para preservar o cache de prefixo.
- **Resultados antigos de ferramenta** saem do prompt (OpenClaw: poda em memória; Hermes: viram uma linha fora da cauda).
  No NewClaw os resultados não atravessam turnos (a transcrição repetida tem só usuário/assistente) — sem lacuna aqui.

## Fase 2 — Crítica

- Cortar seções do prompt pode remover regra que um pedido precisava. A seleção não pode ser por palavra-chave (mesmo
  defeito do item 2); tem de vir de quem já classifica o pedido (o roteador já devolve `category`/`topic`) ou do próprio
  modelo (sob demanda).
- Skills sob demanda acrescentam uma volta quando a skill é usada. ADR-021 já mediu esse custo para ferramentas e criou
  o critério ("compensa quando o catálogo passa do tamanho de uma chamada"); vale o mesmo critério.
- O ramo da ADR-036 (skills aprendidas fora do git) mexe no mesmo carregador: implementar depois dele, sem sobrepor.
- Não há medição de cache de prefixo no Ollama Cloud; nenhuma economia por cache é prometida aqui.

## Fase 3 — Alternativas

| | O quê | A favor | Contra |
|---|---|---|---|
| A | Subir os tetos do `ContextBudget` | nada mais é cortado | aumenta tokens em toda volta; não tira o irrelevante |
| B | Prompt-mestre em núcleo + seções por domínio, escolhidas pelo roteador | tira o irrelevante; nada é cortado | depende do acerto do roteador |
| C | Seções de domínio e skills sob demanda (só nome + descrição; o modelo carrega a que precisa), como o OpenClaw e a ADR-021 | quem decide é o modelo; uma regra para os dois | uma volta a mais quando usa |
| D | Tetos derivados da janela medida (`janelaMedida`), não constantes | segue a regra 1.5 da Diretriz | não reduz o irrelevante sozinho |

## Fase 4 — Recomendação

**C para skills e para as seções de domínio do prompt-mestre, com D para os tetos que sobrarem**, nesta ordem:

1. Skills: no prompt só `nome — descrição` das instaladas; o corpo entra quando o modelo pede (mesma ferramenta de carga
   da ADR-021, estendida, não uma nova). Sai a seleção por palavra-gatilho.
2. Prompt-mestre: núcleo fixo (identidade, proatividade, arquitetura da resposta, formato) que nunca é cortado; as regras
   de domínio viram itens carregáveis do mesmo jeito.
3. Corte do que restar: declarado, com o teto vindo da janela medida.
4. Medir antes/depois pelas mesmas linhas `[TOKENS-SOMBRA]` (base da 1ª chamada e entrada média do `AgentLoop:loop`).

Estimativa a confirmar na medição: a base da 1ª chamada cai do prompt de `execution` cortado (1.500) + skills (500) para
o núcleo + uma lista de nomes; o ganho real depende de quantas voltas usam uma skill ou regra.

## Revisão 1 (04/11/2026) — a estimativa da Fase 4 não se sustentou

A operadora aprovou D1 e D2 e escolheu o Bonsai/Strata para o teste (D4). Antes de implementar, as seções foram
medidas (`PROMPT_COMPONENTS`, mesma estimativa de tokens do `ContextBudget`):

| Seção | tokens | | Seção | tokens |
|---|---:|---|---|---:|
| IDENTITY | 511 | | ACADEMIC | 171 |
| PROACTIVE | 365 | | AUDIO | 117 |
| RESPONSE_ARCH | 102 | | INFRA | 116 |
| FILE_OPS | 481 | | ANALYSIS | 155 |
| PDF_CONVERT | 211 | | VISION | 180 |
| JSON_FORMAT | 263 | | | |

- As regras de domínio somam ~740 tokens. O núcleo de `execution` (identidade, proatividade, arquitetura, arquivos, PDF,
  formato) tem ~1.930 — **mais** que os 1.500 enviados hoje. "Núcleo nunca cortado" acrescenta ~430 por chamada.
- A lista de skills por nome e descrição (32 instaladas na VPS) dá ~1.100 tokens, contra o teto de 500 de hoje.

**C.1 e C.2 corrigem o que o modelo recebe (nada cortado em silêncio, a skill certa ao alcance), mas não economizam
tokens: somam ~+1.000 por chamada.** A economia prometida na Fase 4 era hipótese e caiu na medição. As alavancas reais,
medidas na Fase 1: o esquema das ferramentas (~3 mil por chamada, o maior bloco da base), o número de voltas do laço, os
juízes depois da resposta (`saida_contra_evidencia` 12 mil de entrada e 10 mil de saída por chamada) e o raciocínio das
decisões curtas (extrator: ~2,2 mil tokens de raciocínio para classificar uma frase).

### D3 — como os agentes tratam "falta um dado do usuário"

- **Hermes Agent:** ferramenta `clarify` no conjunto principal. O próprio agente, com a conversa inteira, decide pausar e
  perguntar (até 4 opções ou pergunta aberta). Sai dos conjuntos sem usuário (servidor de API).
- **Claude Code:** o mesmo papel (`AskUserQuestion`), chamado pelo agente.
- **OpenClaw:** sem ferramenta oficial; o agente pergunta na própria resposta.
- Nenhum põe um juiz separado antes do agente. A ADR-015 existe por pedido da operadora (09/10), depois de o agente
  inventar uma cidade; tirá-la desfaria essa decisão.

Opções:
- **α — ferramenta de esclarecimento (padrão Hermes/Claude Code) no lugar do juiz.** O agente pergunta quando falta
  dado; a origem do argumento continua conferida no despacho (`citacao_existe_na_fonte` do motor, aplicada aos
  argumentos de dado do usuário). Some uma chamada inteira por turno (~4,9 mil de entrada, ~1,9 mil de saída, 20–43 s) e
  some a classe de defeito "juiz com contexto diferente do agente" (o caso de 03/11).
- **β — juiz fica, vendo o mesmo catálogo que o agente** (lista de nomes e descrições da C.1, ferramentas do turno pelo
  catálogo da ADR-021). Economia parcial, nenhuma mudança de autoridade.

Medição de uso (VPS, 01/10–03/11): o juiz rodou 64 vezes; perguntou 11; dessas, pelo menos 3 foram efeito da conversa
perdida (corrigida no PR desta campanha).

## Decisões para a operadora (perguntas originais)

- **D1.** Aprovar skills sob demanda (C.1), depois da ADR-036 entrar no main?
- **D2.** Aprovar o prompt-mestre em núcleo + regras sob demanda (C.2)?
- **D3.** Os juízes antes do agente (suficiência) passam a receber só nome e descrição das ferramentas e skills, sem os
  esquemas inteiros — ou ficam como estão?
- **D4.** Autorizar o teste real antes/depois (instância isolada, nuvem): estimativa de ~40–60 chamadas ao modelo
  configurado, ou usar o Bonsai/Strata local.

## Revisão 2 (04/11/2026) — decisões depois da medição

Decidido pela operadora, com base na Revisão 1:

1. **D1 e D2 descartadas.** Motivo: a medição da Revisão 1 mostrou ~+1.000 tokens por chamada, e não economia. O problema
   que elas atacavam (regra cortada sem aviso, skill fora de alcance) continua registrado na Fase 1. Se voltar, volta
   como correção do que o modelo recebe, com o custo declarado, e não como economia.
2. **D3 = β, provisória.** O juiz de suficiência fica (ADR-015 intacta) e passa a ver o mesmo catálogo que o agente. A
   regra de custo é cumprida porque β substitui os esquemas inteiros pela lista de nomes e descrições, sem somar
   contexto. A α fica registrada como alternativa. Só volta à mesa com o custo total comparado (tokens, latência e taxa
   de pergunta indevida, medida depois da correção da conversa perdida), e não pela economia estimada.
3. **D4: teste real antes de qualquer mudança no caminho do agente.** Instância isolada com o Bonsai/Strata local, com
   aviso antes de ligar o modelo na GPU. Sem esse teste, β não é ativada.

A correção da conversa perdida (`fix/contexto-entre-conversas`) e o agrupamento de mensagens em sequência
(`feat/mensagens-em-sequencia`) não dependem de D3 nem de D4. Seguem pelos próprios PRs e só são publicados com o CI
verde.

**Próxima alavanca de custo**, pela Fase 1: os juízes depois da resposta (`saida_contra_evidencia`, ~12 mil de entrada
e ~10 mil de saída por chamada). Perguntas da próxima investigação:
- todos rodam em toda execução?
- validações independentes podem compartilhar o resultado?
- o mesmo contexto é reenviado entre elas?
- que parte é estrutural (determinismo) e que parte é semântica (LLM)?

## Revisão 3 (05/11/2026) — D4 medido: β não é ativada

**Como a β foi definida para o teste** (decisão da operadora, 05/11): a especificação original apontava para a C.1, que foi
descartada. Mediu-se a forma mais simples que sobra:
- a lista de ferramentas passa a ter só "nome: descrição", sem o `| exige: …`;
- as skills ficam como estão (já são "nome: descrição").

**Como foi medido:**
- 10 avaliações reais do `suficiencia_do_pedido` (produção Windows, 23/10–04/11): as 7 não aprovadas e 3 aprovadas.
- Cada uma reprocessada duas vezes, com a lista atual e com a β, no mesmo modelo, uma logo depois da outra.
- O prompt é o gravado pelo gravador de voo, palavra por palavra. A leitura e a conferência da citação usam as funções do
  motor (`lerSaidaDoModelo`, `citacaoExiste`, `agregarPorItens`).
- Nada foi gravado na produção.

| | Bonsai 27B local (GPU) | Modelo de produção (Ollama Cloud) |
|---|---|---|
| Mesmo veredito nas duas listas | 9 de 10 | 8 de 10 |
| Perguntaria ao usuário: atual → β | 4 → 3 | 3 → 4 |
| Tokens de entrada (total) | -9% | -9% |
| Tokens de saída (total) | -10% | **+47%** |
| Tempo (total) | -9% | **+35%** |
| Citação que confere: atual → β | 11/11 → 12/12 | 8/8 → **8/11** |

**O que mudou com a β:**
- **No Bonsai:** "Quais as novidades?" deixou de perguntar de onde vêm as novidades, pergunta que a produção também fazia.
- **No modelo de produção:** dois vereditos viraram "não avaliável". Num deles, "Romântica básica" deixa de perguntar, porque
  sem veredito o pedido segue (ADR-015).

**Decisão da operadora (05/11/2026): β não é ativada.**
- A economia de entrada é de cerca de 9% (uns 540 tokens por chamada).
- No modelo de produção, a β aumentou a saída e o tempo.
- As mudanças de decisão foram todas para pior.
- O `exige:` é justamente o que diz ao juiz quais dados cada ferramenta precisa.
- A α (ferramenta de esclarecimento no lugar do juiz) continua registrada como alternativa, com a mesma condição da Revisão
  2: só volta com o custo total comparado.

**Limitações:**
- Uma execução por caso.
- Com 10 casos, os números servem para recusar, não para aprovar.

O relatório completo, fora do repositório (tem conteúdo das conversas), traz também a medição dos juízes depois da resposta
(A2 e A4). Ali, raciocínio desligado e modelo local como juiz foram medidos e recusados.
