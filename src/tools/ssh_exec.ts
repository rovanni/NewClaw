/**
 * ssh_exec — Execute commands on remote servers via SSH
 * Supports the Home Lab infrastructure (Sol, Marte, Atlas, Venus)
 */

import { ToolExecutor, ToolResult } from '../loop/AgentLoop';
import { exec } from 'child_process';

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

    private readonly hostMap: Record<string, string> = {
        sol: 'admin@server1',
        marte: 'user@localhost',
        atlas: 'user@server3',
        venus: 'user@server4'
    };

    async execute(args: Record<string, any>): Promise<ToolResult> {
        const hostAlias = args.host as string;
        const command = args.command as string;
        const timeout = (args.timeout as number) || 30000;

        if (!hostAlias || !command) {
            return { success: false, output: '', error: 'Parameters "host" and "command" are required' };
        }

        // Block destructive commands
        const destructive = ['rm -rf /', 'mkfs', 'dd if=', ':(){:|:&};:', 'shutdown', 'reboot'];
        if (destructive.some(d => command.includes(d))) {
            return { success: false, output: '', error: 'Destructive command blocked for safety' };
        }

        // Resolve host alias to SSH target
        const sshTarget = this.hostMap[hostAlias] || hostAlias;

        // Build SSH command
        const sshCommand = `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no ${sshTarget} "${command.replace(/"/g, '\\"')}"`;

        try {
            const output = await new Promise<string>((resolve, reject) => {
                exec(sshCommand, { timeout }, (error, stdout, stderr) => {
                    if (error) {
                        reject(error);
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