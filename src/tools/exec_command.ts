/**
 * exec_command — Executar comandos shell
 */

import { ToolExecutor, ToolResult } from '../loop/AgentLoop';
import { exec } from 'child_process';

export class ExecCommandTool implements ToolExecutor {
    name = 'exec_command';
    description = 'Execute a shell command and return the output. Supports local commands and remote execution via ssh://host prefix (e.g. ssh://sol ls /tmp). Timeout default: 30s.';
    parameters = {
        type: 'object',
        properties: {
            command: { type: 'string', description: 'Shell command to execute. Use ssh://HOST/ prefix for remote execution (e.g. ssh://sol systemctl status whisper-api)' },
            timeout: { type: 'number', description: 'Timeout in ms (default: 30000)' },
            workdir: { type: 'string', description: 'Working directory for the command' }
        },
        required: ['command']
    };

    private readonly hostMap: Record<string, string> = {
        sol: 'admin@server1',
        marte: 'user@localhost',
        atlas: 'user@server3',
        venus: 'user@server4'
    };

    async execute(args: Record<string, any>): Promise<ToolResult> {
        let command = args.command as string;
        const timeout = (args.timeout as number) || 30000;
        const workdir = args.workdir as string;

        if (!command) {
            return { success: false, output: '', error: 'Command not provided' };
        }

        // Block destructive commands
        const destructive = ['rm -rf /', 'mkfs', 'dd if=', ':(){:|:&};:'];
        if (destructive.some(d => command.includes(d))) {
            return { success: false, output: '', error: 'Destructive command blocked for safety' };
        }

        // Handle SSH remote execution: ssh://host/command
        if (command.startsWith('ssh://')) {
            const match = command.match(/^ssh:\/\/([a-zA-Z0-9_-]+)\/(.*)/);
            if (!match) {
                return { success: false, output: '', error: 'Invalid SSH format. Use: ssh://host/command' };
            }
            const hostAlias = match[1];
            const remoteCmd = match[2];
            const sshTarget = this.hostMap[hostAlias] || hostAlias;
            command = `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no ${sshTarget} "${remoteCmd.replace(/"/g, '\\"')}"`;
        }

        const execOptions: any = { timeout };
        if (workdir) {
            execOptions.cwd = workdir;
        }

        try {
            const output = await new Promise<string>((resolve, reject) => {
                exec(command, execOptions, (error, stdout, stderr) => {
                    if (error) {
                        // Include partial output even on error
                        const partialOutput = (stdout ? stdout.toString() : '') + (stderr ? stderr.toString() : '');
                        if (partialOutput.trim()) {
                            resolve(partialOutput + '\n[exit code: ' + (error.code || 'unknown') + ']');
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
            return { success: false, output: '', error: error.message };
        }
    }
}