/**
 * ServerConfig — Centralized server mapping and safety rules
 * Single source of truth for host aliases and destructive command blocking
 */

export const SERVER_MAP: Record<string, string> = {
    sol: 'admin@server1',       // GPU, primary-server
    marte: 'user@localhost',     // primary
    atlas: 'user@server3',     // remote testing
    venus: 'user@server4'     // bot-server
};

export const DESTRUCTIVE_COMMANDS = [
    'rm -rf /',
    'mkfs',
    'dd if=',
    ':(){:|:&};:',
    'shutdown',
    'reboot'
];

export function resolveHost(alias: string): string {
    return SERVER_MAP[alias] || alias;
}

export function isDestructive(command: string): boolean {
    return DESTRUCTIVE_COMMANDS.some(d => command.includes(d));
}