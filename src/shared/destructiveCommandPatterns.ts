/**
 * isDestructiveCommand — detecta comandos de shell genuinamente destrutivos (rm -rf /, mkfs,
 * shutdown, drop table...), resistente a técnicas básicas de evasão (aspas vazias, espaços
 * escapados/duplicados, subshells).
 *
 * Extraído de tools/server_config.ts (implementação original, ainda a única CHAMADA de verdade
 * pra bloquear execução em exec_command.ts/ssh_exec.ts) pra shared/ — camada sem dependência de
 * loop/ nem tools/, mesmo padrão já usado em shared/contentStubPatterns.ts,
 * shared/placeholderPatterns.ts e shared/keywordBoundary.ts nesta sessão — porque
 * loop/AuthorizationManager.ts (mensagem de confirmação antes de rodar exec_command) tinha sua
 * PRÓPRIA regex divergente (`/rm\s+-rf|drop\s+table|mkfs|format/i`, sem boundary — "format"
 * casava como substring de "informação"/"informativo") só pra decidir o TEXTO do aviso
 * ("risco alto" vs "risco médio"), nunca de fato bloqueando nada — a divergência nunca abriu um
 * buraco de segurança (o bloqueio real sempre usou esta função), mas é exatamente o tipo de
 * lógica duplicada que este projeto já consolidou várias vezes. server_config.ts reexporta esta
 * função com o mesmo nome — nenhum import existente (exec_command.ts, ssh_exec.ts) precisou
 * mudar.
 */

/** Exact destructive command patterns (checked after normalization) */
const DESTRUCTIVE_PATTERNS: string[] = [
    'rm -rf /',
    'rm -rf /*',
    'rm -rf ~',
    'mkfs',
    'dd if=',
    ':(){:|:&};:',
    'shutdown',
    'reboot',
    'init 0',
    'init 6',
    'halt',
    'poweroff',
    '> /dev/sda',
    'chmod -r 777 /',
    'chown -r',
];

/** Regex patterns for shell injection / subshell evasion */
const DESTRUCTIVE_REGEX: RegExp[] = [
    /\$\(.*rm\s/i,            // $(rm ...)
    /`.*rm\s/i,               // `rm ...`
    /\|\s*xargs\s.*rm/i,      // | xargs rm
    /;\s*rm\s+-rf\s/i,        // ; rm -rf
    /&&\s*rm\s+-rf\s/i,       // && rm -rf
    /\|\|\s*rm\s+-rf\s/i,     // || rm -rf
    />\s*\/dev\/[sh]d/i,      // > /dev/sda
    /rm\s+(-[a-z]*f[a-z]*\s+)?\/($|\s)/i,  // rm -rf / (flexible flags)
];

/**
 * Normalize a command string to defeat basic evasion techniques:
 * - Collapse whitespace (rm  -rf → rm -rf)
 * - Strip shell quoting tricks (r""m → rm, r''m → rm)
 * - Lowercase for consistent matching
 */
function normalizeCommand(command: string): string {
    return command
        .replace(/[""'']/g, '')    // Strip inserted empty quotes
        .replace(/\\\s/g, ' ')     // Unescape escaped spaces
        .replace(/\s+/g, ' ')      // Collapse multiple spaces
        .trim()
        .toLowerCase();
}

/**
 * Check if a command is destructive.
 * Uses normalized string matching AND regex patterns to resist
 * common bypass techniques (quoting, subshells, whitespace padding).
 */
export function isDestructiveCommand(command: string): boolean {
    const normalized = normalizeCommand(command);

    // Check exact patterns against normalized command
    if (DESTRUCTIVE_PATTERNS.some(d => normalized.includes(d.toLowerCase()))) {
        return true;
    }

    // Check regex patterns against ORIGINAL command (preserves structure)
    if (DESTRUCTIVE_REGEX.some(r => r.test(command))) {
        return true;
    }

    return false;
}
