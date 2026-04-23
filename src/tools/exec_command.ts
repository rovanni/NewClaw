/**
 * exec_command — Executar comandos shell
 */

import { ToolExecutor, ToolResult } from '../loop/AgentLoop';
import { exec } from 'child_process';

export class ExecCommandTool implements ToolExecutor {
    name = 'exec_command';
    description = 'Executa um comando no terminal e retorna a saída';
    parameters = {
        type: 'object',
        properties: {
            command: { type: 'string', description: 'Comando shell para executar' },
            timeout: { type: 'number', description: 'Timeout em ms (padrão: 30000)' }
        },
        required: ['command']
    };

    async execute(args: Record<string, any>): Promise<ToolResult> {
        const command = args.command as string;
        const timeout = (args.timeout as number) || 30000;

        if (!command) {
            return { success: false, output: '', error: 'Comando não fornecido' };
        }

        // Bloquear comandos destrutivos
        const destructive = ['rm -rf /', 'mkfs', 'dd if=', ':(){:|:&};:'];
        if (destructive.some(d => command.includes(d))) {
            return { success: false, output: '', error: 'Comando destrutivo bloqueado por segurança' };
        }

        try {
            const output = await new Promise<string>((resolve, reject) => {
                exec(command, { timeout }, (error, stdout, stderr) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve(stdout + stderr);
                    }
                });
            });

            return { success: true, output: output.trim().slice(0, 4000) };
        } catch (error: any) {
            return { success: false, output: '', error: error.message };
        }
    }
}