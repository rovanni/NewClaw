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
    /\bstep_\d+\b/i,
];
