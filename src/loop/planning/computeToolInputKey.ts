/**
 * computeToolInputKey — chave de deduplicação de chamadas de ferramenta repetidas
 * (usedToolInputs/blockedKeyCount em AgentLoop.ts, caminhos nativo e json_action).
 *
 * Extraído de AgentLoop.ts pra ser testável isoladamente sem instanciar a classe inteira
 * (mesmo padrão de sanitizePlanSteps/toolAliasResolver neste diretório).
 *
 * Por padrão a chave é `tool:JSON(args)` — repetição exata dos argumentos. `send_document` é
 * um caso estrutural à parte: cada tentativa costuma variar a legenda/args não essenciais
 * mesmo reenviando o MESMO arquivo, então a chave por JSON completo nunca colide e o dedup
 * "duro" (bloqueia após 3 repetições, ver AgentLoop.ts) nunca disparava para essa ferramenta —
 * só o guard semântico de deferSendDocument (por file_path) percebia a repetição, e ele só
 * pede educadamente pro modelo parar, sem cortar o loop. Resultado observado ao vivo
 * (10-11/07/2026): send_document repetido por vários ciclos até um SAFETY-GUARD de OUTRA
 * ferramenta (exec_command) cortar por acidente. Chaveando por file_path para esta ferramenta
 * especificamente, a 2ª tentativa já cai no dedup duro existente, sem precisar de nenhum
 * mecanismo novo.
 */
export function computeToolInputKey(toolName: string, args: unknown): string {
    if (toolName === 'send_document') {
        const a = args as Record<string, unknown> | undefined;
        const filePath = a?.['file_path'] ?? a?.['path'];
        if (typeof filePath === 'string' && filePath.length > 0) {
            return `send_document:${filePath}`;
        }
    }
    return `${toolName}:${JSON.stringify(args)}`;
}
