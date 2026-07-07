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

// isDestructive: implementação real movida para shared/destructiveCommandPatterns.ts (fonte
// única, também usada por loop/AuthorizationManager.ts). Reexportado aqui com o mesmo nome pra
// não quebrar exec_command.ts/ssh_exec.ts, que já importam `isDestructive` deste módulo.
export { isDestructiveCommand as isDestructive } from '../shared/destructiveCommandPatterns';

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
