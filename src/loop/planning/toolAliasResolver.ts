/**
 * toolAliasResolver — nomes de tool que LLMs inventam → nome real no ToolRegistry.
 *
 * Extraído de GoalPlanner.ts (única implementação existente) para ser reusado também por
 * RiskAnalyzer.ts, que reconstrói o plano de forma independente depois do LLM de risco e,
 * antes desta extração, NÃO resolvia aliases — se o LLM de risco inventasse um alias como
 * 'ls' ou 'cat_file', o step era descartado achando que a tool "não existe".
 */

export const TOOL_ALIASES: Record<string, string> = {
    provide_file: 'send_document',
    deliver_file: 'send_document',
    download_file: 'send_document',
    upload_file: 'send_document',
    send_file: 'send_document',
    file_send: 'send_document',
    send: 'send_document',
    run_command: 'exec_command',
    execute: 'exec_command',
    execute_command: 'exec_command',
    shell: 'exec_command',
    bash: 'exec_command',
    search_web: 'web_search',
    browse: 'web_navigate',
    read_file: 'read',
    open_file: 'read',
    cat_file: 'read',
    get_file: 'read',
    list_files: 'list_workspace',
    ls: 'list_workspace',
};

/** Resolve um nome de tool bruto do LLM para o nome canônico no ToolRegistry (ou devolve o mesmo nome, se não houver alias). */
export function resolveToolAlias(rawName: string): string {
    return TOOL_ALIASES[rawName] ?? rawName;
}
