/**
 * ServerConfig — Centralized server mapping and safety rules
 * 
 * For public/self-hosted use: configure hosts via environment variables.
 * Home Lab defaults are provided as examples but NOT hardcoded.
 * 
 * Env vars:
 *   NEWCLAW_SSH_HOSTS = "sol:admin@server1,marte:user@localhost,atlas:user@server3"
 *   NEWCLAW_SSH_DEFAULTS = "true"  (set to "false" to disable built-in defaults)
 */

export const DESTRUCTIVE_COMMANDS = [
    'rm -rf /',
    'mkfs',
    'dd if=',
    ':(){:|:&};:',
    'shutdown',
    'reboot'
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

/** Built-in defaults — only active if NEWCLAW_SSH_DEFAULTS !== "false" */
const BUILTIN_HOSTS: Record<string, string> = {
    sol: 'admin@server1',
    marte: 'user@localhost',
    atlas: 'user@server3',
    venus: 'user@server4'
};

/** Merged host map: env vars override built-in defaults */
export const SERVER_MAP: Record<string, string> = {
    ...((process.env.NEWCLAW_SSH_DEFAULTS !== 'false') ? BUILTIN_HOSTS : {}),
    ...parseEnvHosts()
};

export function resolveHost(alias: string): string {
    return SERVER_MAP[alias] || alias;
}

export function isDestructive(command: string): boolean {
    return DESTRUCTIVE_COMMANDS.some(d => command.includes(d));
}