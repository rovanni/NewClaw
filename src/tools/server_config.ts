/**
 * ServerConfig — Centralized server mapping and safety rules
 *
 * Configure hosts via environment variables. NO built-in defaults
 * to avoid leaking private infrastructure details in public repos.
 *
 * Env vars:
 *   NEWCLAW_SSH_HOSTS = "alias:user@host,alias2:user@host2"
 *   Example: NEWCLAW_SSH_HOSTS="prod:admin@203.0.113.10,staging:dev@203.0.113.20"
 *
 * Os endereços de exemplo vêm do bloco 203.0.113.0/24, reservado pela RFC 5737 exatamente para
 * documentação. Exemplos com faixas privadas reais (192.168.x, 10.x) são indistinguíveis de
 * configuração de alguém vazada e falham em S195 — ver RFC-004, Correção 0.
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
