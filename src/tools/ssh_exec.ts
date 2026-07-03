/**
 * ssh_exec — Execute commands on remote servers via SSH
 * Uses centralized server_config for host resolution and safety checks
 * 
 * Security: Uses BatchMode=yes to prevent password prompts (fail fast instead).
 *           Uses -i to specify the SSH key explicitly.
 */

import { ToolExecutor, ToolResult } from '../loop/AgentLoop';
import { exec } from 'child_process';
import { resolveHost, isDestructive } from './server_config';
import { createLogger } from '../shared/AppLogger';
import { errorMessage } from '../shared/errors';

const log = createLogger('SshExecTool');

/** Default SSH key path (ed25519 preferred, falls back to rsa) */
function getDefaultKey(): string {
    const { existsSync } = require('fs');
    const home = process.env.HOME || process.env.USERPROFILE || '/root';
    if (existsSync(`${home}/.ssh/id_ed25519`)) return `${home}/.ssh/id_ed25519`;
    if (existsSync(`${home}/.ssh/id_rsa`)) return `${home}/.ssh/id_rsa`;
    return `${home}/.ssh/id_ed25519`; // default path, will fail if not present
}

export class SshExecTool implements ToolExecutor {
    name = 'ssh_exec';
    description = 'Execute a command on a remote server via SSH. Configure servers via NEWCLAW_SSH_HOSTS env var (e.g. "prod:admin@host"). Use alias or user@host directly.';
    parameters = {
        type: 'object',
        properties: {
            host: {
                type: 'string',
                description: 'Target server alias (configured in .env) or a custom user@host'
            },
            command: {
                type: 'string',
                description: 'Shell command to execute on the remote server'
            },
            timeout: {
                type: 'number',
                description: 'Timeout in ms (default: 30000)'
            }
        },
        required: ['host', 'command']
    };

    async execute(args: Record<string, any>): Promise<ToolResult> {
        const hostAlias = args.host as string;
        const command = args.command as string;
        const timeout = (args.timeout as number) || 30000;

        if (!hostAlias || !command) {
            return { success: false, output: '', error: 'Parameters "host" and "command" are required' };
        }

        // Block destructive commands (centralized list)
        if (isDestructive(command)) {
            return { success: false, output: '', error: 'Destructive command blocked for safety' };
        }

        // Resolve host alias to SSH target (centralized)
        const sshTarget = resolveHost(hostAlias);
        const sshKey = getDefaultKey();

        // Build SSH command with:
        //   - BatchMode=yes: fail fast instead of prompting for password
        //   - StrictHostKeyChecking=accept-new: auto-accept new hosts
        //   - ConnectTimeout=5: fail fast on unreachable hosts
        //   - -i <key>: explicit key file
        //   - ServerAliveInterval=15: detect dead connections
        const escapedCommand = command.replace(/"/g, '\\"').replace(/'/g, "'\\''");
        const sshCommand = `ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15 -i "${sshKey}" ${sshTarget} '${escapedCommand}'`;

        log.info(`[SSH] Executing on ${sshTarget}: ${command.slice(0, 80)}${command.length > 80 ? '...' : ''}`);

        try {
            const output = await new Promise<string>((resolve, reject) => {
                exec(sshCommand, { timeout, windowsHide: true }, (error, stdout, stderr) => {
                    if (error) {
                        const partial = (stdout ? stdout.toString() : '') + (stderr ? stderr.toString() : '');
                        if (partial.trim()) {
                            resolve(partial + `\n[exit code: ${error.code || 'unknown'}]`);
                        } else {
                            reject(error);
                        }
                    } else {
                        resolve(stdout + (stderr ? '\n' + stderr : ''));
                    }
                });
            });

            return { success: true, output: output.trim().slice(0, 8000) };
        } catch (error) {
            const msg = errorMessage(error) || String(error);
            
            // Friendly error messages
            if (msg.includes('Permission denied')) {
                return { 
                    success: false, 
                    output: '', 
                    error: `SSH authentication failed for ${sshTarget}. Check if the SSH key is configured and authorized on the target server. Key tried: ${sshKey}` 
                };
            }
            if (msg.includes('Connection timed out') || msg.includes('ConnectTimeout')) {
                return { 
                    success: false, 
                    output: '', 
                    error: `SSH connection timed out for ${sshTarget}. The server may be unreachable.` 
                };
            }
            if (msg.includes('Connection refused')) {
                return { 
                    success: false, 
                    output: '', 
                    error: `SSH connection refused for ${sshTarget}. The SSH service may not be running.` 
                };
            }
            
            return { success: false, output: '', error: `SSH to ${sshTarget} failed: ${msg}` };
        }
    }
}