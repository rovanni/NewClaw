/**
 * CONTENT_STUB_PATTERNS — detecta quando um LLM escreve uma DESCRIÇÃO do conteúdo em vez do
 * conteúdo real (ex: "[Conteúdo completo abrangendo...]", "[TODO: adicionar aqui]").
 *
 * Usado tanto no parse do plano (GoalPlanner/RiskAnalyzer — converte o step para AgentLoop
 * antes mesmo de tentar escrever) quanto em runtime (WriteTool — última linha de defesa,
 * bloqueia a gravação se o conteúdo já não foi pego antes). Consolidado aqui em shared/ (fonte
 * única) — antes eram 2 listas quase-idênticas (write_tool.ts tinha 8 padrões de "LLM
 * meta-placeholder" que GoalPlanner.ts não tinha) que já tinham divergido de verdade.
 */
export const CONTENT_STUB_PATTERNS: RegExp[] = [
    /\.\.\.\s*\(.*?conteúdo/i,                         // "... (conteúdo completo da aula)"
    /\(conteúdo\s+(completo|da\s+aula|real)\b/i,        // "(conteúdo completo...)"
    /\[conteúdo\s*(completo|real|aqui|será|abrang)/i,   // "[Conteúdo completo abrangendo...]"
    /\[.*?completo.*?abrang/i,                          // "[...completo abrangendo...]"
    /<html>\s*<body>\s*\.\.\./i,                        // "<html><body>..."  (stub de HTML)
    /\[TODO[^\]]*\]/i,                                  // "[TODO: adicionar aqui]"
    /\[inserir\s+aqui\]/i,                              // "[inserir aqui]"
    /conteúdo será adicionado depois/i,                 // "conteúdo será adicionado depois"
    /\(em\s+construção\)/i,                             // "(em construção)"
    /HTML\s+Content\b|CSS\s+Content\b|JS\s+Content\b/i, // genéricos de template
    // LLM meta-placeholders — o modelo descreve o que DEVERIA gerar em vez de gerar
    /\[o\s+(modelo|agente|llm|sistema)\s+(irá|vai|deve|deverá)\s+(gerar|produzir|criar|escrever|completar)/i,
    /\[.*?(será\s+)?(gerado|produzido|criado|escrito|completado|preenchido)\s*(aqui|abaixo|posteriormente|depois|pelo\s+(modelo|agente|llm))/i,
    /\[.*?texto\s+(completo|real|será|do\s+discurso|do\s+conteúdo)/i,
    /\(o\s+(conteúdo|texto|html|slide|relatório)\s+(completo|real|será|aqui)/i,
    /será\s+preenchido\s+(depois|posteriormente|pelo\s+(modelo|agente))/i,
    /\[escrever\s+aqui\]|\[preencher\s+aqui\]|\[adicionar\s+aqui\]/i,
    /\[conteúdo\s+da\s+(aula|disciplina|curso|matéria)\]/i,
    /placeholder|PLACEHOLDER/,                          // literal "placeholder"
    // Reproduzido ao vivo (VPS, 01/07): "[Conteúdo do resumo gerado a partir do texto lido no
    // step_1]" escapava de todos os padrões acima (nenhum casava "gerado a partir de/do").
    /\[.*?gerado\s+a\s+partir/i,                        // "[X gerado a partir de/do Y]"
    // Referência a um step_N interno do plano vazando pro conteúdo final é sempre um sinal de
    // que o LLM descreveu o processo em vez de produzir o resultado — nunca conteúdo legítimo.
    // "step[_\s-]?\d+" cobre step_1/step-1 (formato interno) E "step 1" em prosa livre —
    // reproduzido ao vivo (04/07/2026): um step de send_audio.text gerado pelo RiskAnalyzer
    // (revisão Q2) escapou do padrão antigo (só "step_1", com underscore obrigatório) porque a
    // frase gerada dizia "obtidos no step 1" (com espaço) — foi direto pro TTS e o usuário
    // recebeu um áudio incompreensível em vez do conteúdo real da previsão do tempo.
    /\bstep[_\s-]?\d+\b/i,
    // Todos os padrões de meta-placeholder acima (linhas 22-29, 33) pressupõem que o LLM
    // envolve a descrição em colchetes ("[conteúdo será gerado...]") — mas nada garante isso.
    // Reproduzido ao vivo (04/07/2026, mesma sessão): send_audio.text = "conteúdo será gerado
    // em um time com base nos dados de memória recuperados", em prosa solta, SEM colchete
    // nenhum — escapou de toda a lista acima e foi direto pro TTS. Este padrão cobre a mesma
    // classe semântica (substantivo do que deveria existir + futuro passivo "será/vai ser
    // gerado/criado/produzido") independente de colchetes.
    // Sem "\b" antes do grupo: "\b" no JS (sem flag "u") só reconhece [A-Za-z0-9_] como
    // caractere de palavra — "á" de "áudio" não conta, então "\báudio\b" nunca casa o início
    // de "áudio" (não há transição \w↔\W entre o espaço e o "á", ambos tratados como \W).
    /(conteúdo|texto|resposta|áudio|resultado)\s+(será|vai\s+ser)\s+(gerado|gerada|criado|criada|produzido|produzida)\b/i,
    // Reproduzido ao vivo (05/07/2026): RiskAnalyzer (Q2) reescreveu um step de send_audio.text
    // como "Os preços e variações coletados nas etapas anteriores devem ser inseridos aqui..." —
    // foi direto pro TTS e o usuário recebeu um áudio incompreensível. Escapou de TODOS os
    // padrões acima porque usa vocabulário diferente dos já cobertos: "etapas anteriores" (não
    // "step_N"/"step N") e modal "devem ser" + verbo "inseridos" (não "será/vai ser" +
    // "gerado/criado/produzido"). Dois padrões novos, mesma classe semântica de sempre —
    // descrição do processo em vez do resultado real:
    /\betapas?\s+anterior(es)?\b|\bpassos?\s+anterior(es)?\b|\bfases?\s+anterior(es)?\b/i,
    /(deve[m]?)\s+ser\s+(inserid[oa]s?|preenchid[oa]s?|adicionad[oa]s?|colocad[oa]s?)\b/i,
    // Reproduzido ao vivo (05/07/2026): send_audio.text = "conteúdo gerado pelo assistente." —
    // foi direto pro TTS e o usuário ouviu essa frase em vez da previsão do tempo real. Escapou
    // de TODOS os padrões acima por dois motivos ao mesmo tempo: (1) sem colchetes, sem "será/vai
    // ser" — é uma oração elíptica sem verbo auxiliar, só "[substantivo] [particípio] pelo [X]";
    // (2) a palavra usada foi "assistente", que não está na lista fechada (modelo|agente|llm)
    // do padrão da linha 24/47. Este padrão cobre a mesma classe semântica (algo descrito como
    // produzido por uma entidade de IA, em vez de SER o conteúdo) independente de tempo verbal,
    // colchetes, ou qual palavra é usada pra a entidade (assistente/modelo/agente/sistema/IA/bot):
    /\b(gerad[oa]|produzid[oa]|criad[oa]|escrit[oa])\s+pel[oa]\s+(assistente|modelo|agente|sistema|llm|ia|bot)\b/i,
    // Reproduzido ao vivo (06/07/2026): RiskAnalyzer (Q2) reescreveu send_audio.text ANTES do
    // step de weather rodar (mesma causa-raiz do incidente de 05/07 acima) como "Previsão do
    // tempo para amanhã em Belo Horizonte, inserir dados reais obtidos no passo 1." —
    // foi direto pro TTS. Escapou do padrão "step[_\s-]?\d+" (linha acima) porque o LLM usou a
    // palavra PORTUGUESA "passo" em vez de "step" — natural num sistema com Language: pt-BR, mas
    // não coberto porque o padrão de referência a step numerado só cobria o termo em inglês.
    // Não basta acrescentar "passo"/"etapa"/"fase" como alternativa livre de "step[_\s-]?\d+":
    // diferente de "step N", essas palavras são cabeçalhos legítimos e comuns em receitas/tutoriais
    // reais que este bot gera ("Passo 1: pré-aqueça o forno a 180°C") — um padrão genérico
    // "passo\d+"/"etapa\d+" sem mais contexto bloquearia conteúdo real como falso-positivo.
    // Por isso este padrão exige também o verbo+preposição que caracteriza REFERÊNCIA a uma
    // etapa do plano como FONTE de dados (não um cabeçalho de conteúdo): particípio de
    // obter/coletar/retornar/extrair/recuperar/gerar + "no/na/nos/nas/do/da/dos/das" +
    // step/passo/etapa/fase + número — mesma classe semântica de sempre, agora cobrindo o
    // português além do inglês, sem repetir o risco de falso-positivo em conteúdo legítimo:
    /\b(obtid[oa]s?|coletad[oa]s?|retornad[oa]s?|extraíd[oa]s?|recuperad[oa]s?|gerad[oa]s?)\s+(n[ao]s?|d[ao]s?)\s+(step|passo|etapa|fase)[_\s-]?\d+\b/i,
    // Reproduzido ao vivo (09/07/2026): send_audio.text = "Resumo do mercado de criptomoedas de
    // hoje: [resultado_do_passo_1]" — foi direto pro TTS (o usuário reportou "áudio falando
    // errado, repetindo letras": exatamente o efeito de um engine de TTS tentando pronunciar um
    // identificador em snake_case). Escapou de TODOS os padrões acima, incluindo o de
    // "step[_\s-]?\d+"/"passo...\d+" (linhas 41 e 86): aqui "passo_1" está GRUDADO em
    // "resultado_do_" como um único token de identificador (sem verbo/preposição isolando um
    // "passo N" reconhecível) — é a 6ª variação da mesma classe de bug (colchetes referenciando
    // resultado de step) escapando por usar uma forma sintática ainda não coberta: identificador
    // de código, não frase. Prosa real em português NUNCA usa snake_case dentro de colchetes —
    // isso só existe como nome de variável de template vazando sem substituição. Cobre a classe
    // inteira (qualquer nome_de_variável, não só "passo"/"step") em vez de mais uma string:
    /\[[a-zà-öø-ÿ][a-zà-öø-ÿ0-9]*(?:_[a-zà-öø-ÿ0-9]+)+\]/i,
];
