/**
 * ssh_exec — Execute commands on remote servers via SSH
 * Uses centralized server_config for host resolution and safety checks
 */

import { ToolExecutor, ToolResult } from '../loop/AgentLoop';
import { exec } from 'child_process';
import { resolveHost, isDestructive } from './server_config';

export class SshExecTool implements ToolExecutor {
    name = 'ssh_exec';
    description = 'Execute a command on a remote server via SSH. Available servers: sol (192.168.1.1, GPU), marte (localhost), atlas (192.168.1.9, Selenium), venus (192.168.1.10). Use for remote diagnostics, service management, and infrastructure tasks.';
    parameters = {
        type: 'object',
        properties: {
            host: {
                type: 'string',
                description: 'Target server: sol, marte, atlas, venus, or a custom user@host'
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

        // Build SSH command
        const sshCommand = `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no ${sshTarget} "${command.replace(/"/g, '\\"')}"`;

        try {
            const output = await new Promise<string>((resolve, reject) => {
                exec(sshCommand, { timeout }, (error, stdout, stderr) => {
                    if (error) {
                        const partial = (stdout ? stdout.toString() : '') + (stderr ? stderr.toString() : '');
                        if (partial.trim()) {
                            resolve(partial + '\n[exit code: ' + (error.code || 'unknown') + ']');
                        } else {
                            reject(error);
                        }
                    } else {
                        resolve(stdout + (stderr ? '\n' + stderr : ''));
                    }
                });
            });

            return { success: true, output: output.trim().slice(0, 8000) };
        } catch (error: any) {
            return { success: false, output: '', error: `SSH to ${sshTarget} failed: ${error.message}` };
        }
    }
}