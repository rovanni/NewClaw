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

/** Host map: populated exclusively from environment variables */
export const SERVER_MAP: Record<string, string> = parseEnvHosts();

export function resolveHost(alias: string): string {
    return SERVER_MAP[alias] || alias;
}

export function isDestructive(command: string): boolean {
    return DESTRUCTIVE_COMMANDS.some(d => command.includes(d));
}