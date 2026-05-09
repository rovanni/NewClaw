/**
 * ServerConfig — Centralized server mapping and safety rules
 * 
 * Configure hosts via environment variables. NO built-in defaults
 * to avoid leaking private infrastructure details in public repos.
 * 
 * Env vars:
 *   NEWCLAW_SSH_HOSTS = "alias:user@host,alias2:user@host2"
 *   Example: NEWCLAW_SSH_HOSTS="prod:admin@192.168.1.10,staging:dev@192.168.1.20"
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

/** Parse NEWCLAW_SSH_HOSTS env var into a host map */
function parseEnvHosts(): Record<string, string> {
    const env = process.env.NEWCLAW_SSH_HOSTS || '';
    const map: Record<string, string> = {};
    if (!env) return map;
    for (const entry of env.split(',')) {
        const [alias, target] = entry.trim().split(':');
        if (alias && target) {
            map[alias.trim()] = target.trim();
        }
    }
    return map;
}

/** Host map: populated exclusively from environment variables */
export const SERVER_MAP: Record<string, string> = parseEnvHosts();

export function resolveHost(alias: string): string {
    return SERVER_MAP[alias] || alias;
}

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
export function isDestructive(command: string): boolean {
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