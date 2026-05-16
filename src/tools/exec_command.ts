/**
 * exec_command — Execute shell commands (modelo OpenClaw)
 * 
 * Acesso total ao shell com workspace como cwd padrão.
 * Bloqueia apenas comandos explicitamente destrutivos.
 * Suporta execução remota via ssh://host/command.
 */

import { ToolExecutor, ToolResult } from '../loop/AgentLoop';
import { exec } from 'child_process';
import { resolveHost, isDestructive } from './server_config';
import path from 'path';
import { errorMessage } from '../shared/errors';

export class ExecCommandTool implements ToolExecutor {
    name = 'exec_command';
    description = 'Execute shell commands. Workspace como cwd padrão. Suporta ssh://host/command para remoto. Timeout padrão: 30s.';
    parameters = {
        type: 'object',
        properties: {
            command: { type: 'string', description: 'Shell command. Use ssh://HOST/cmd para execução remota' },
            timeout: { type: 'number', description: 'Timeout em ms (padrão: 30000)' },
            workdir: { type: 'string', description: 'Diretório de trabalho (padrão: workspace)' }
        },
        required: ['command']
    };

    async execute(args: Record<string, any>): Promise<ToolResult> {
        let command = args.command as string;
        const timeout = (args.timeout as number) || 60000;
        const workdir = args.workdir as string;

        if (!command) {
            return { success: false, output: '', error: 'Command not provided' };
        }

        // Block destructive commands
        if (isDestructive(command)) {
            return { success: false, output: '', error: 'Comando destrutivo bloqueado por segurança' };
        }

        // Handle SSH remote execution: ssh://host/command
        if (command.startsWith('ssh://')) {
            const match = command.match(/^ssh:\/\/([a-zA-Z0-9_-]+)\/(.*)/);
            if (!match) {
                return { success: false, output: '', error: 'Formato SSH inválido. Use: ssh://host/command' };
            }
            const hostAlias = match[1];
            const remoteCmd = match[2];
            const sshTarget = resolveHost(hostAlias);
            command = `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new ${sshTarget} "${remoteCmd.replace(/"/g, '\\"')}"`;
        }

        // ── Path Resolution ──
        const workspaceDir = path.resolve(process.env.WORKSPACE_DIR || path.join(process.cwd(), 'workspace'));
        
        // Se workdir for absoluto, resolve em relação ao root; se relativo, em relação ao workspace
        const effectiveWorkdir = workdir ? path.resolve(workspaceDir, workdir) : workspaceDir;
        
        // FIX: Prevenir path duplication no comando
        if (!workdir) {
            command = command.replace(/\bworkspace\//g, '');
        }
        
        const execOptions: any = { timeout };
        execOptions.cwd = effectiveWorkdir;

        try {
            const output = await new Promise<string>((resolve, reject) => {
                exec(command, execOptions, (error, stdout, stderr) => {
                    if (error) {
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

            return { success: true, output: output.trim().slice(0, 16000) }; // Aumentado limite de output
        } catch (error) {
            return { success: false, output: '', error: errorMessage(error) };
        }
    }
}