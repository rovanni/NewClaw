/**
 * Detecta se o pedido do usuário é de análise/leitura (resumir, revisar, avaliar...) em vez
 * de uma ação que exige modificação (escrever, editar, executar). Um turno que só leu um
 * arquivo e não escreveu nada é uma alucinação de sucesso quando o pedido era "edite X" — mas
 * é o resultado ESPERADO quando o pedido era "resuma X" ou "analise X". Sem essa distinção,
 * guardas de falso-sucesso bloqueiam respostas legítimas de leitura/resumo.
 *
 * Definido uma única vez aqui — antes vivia duplicado 2x dentro de AgentLoop.ts (mesmo regex,
 * copiado inline) e ObserverValidator.ts não tinha a checagem nenhuma (ver
 * project_session_bugs_jul2026_d.md).
 */
export const ANALYSIS_INTENT_PATTERN =
    /analis|revis|avali|verifi|checar|conferir|melhorar|melhoria|ordem|estrutura|revisar|feedback|resumo|resumir|review/i;
