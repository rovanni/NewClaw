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
            // Aspas simples impedem TODA expansão de shell local ($(), backticks, $VAR).
            // Aspas duplas só escapavam ", mas $() continuava sendo interpretado localmente.
            // Se remoteCmd contém ', usamos o idioma '"'"' para escape dentro de single-quote.
            const escapedCmd = remoteCmd.replace(/'/g, "'\\''");
            command = `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new ${sshTarget} '${escapedCmd}'`;
        }

        // ── Path Resolution ──
        const workspaceDir = path.resolve(process.env.WORKSPACE_DIR || path.join(process.cwd(), 'workspace'));

        // Se workdir for absoluto, resolve em relação ao root; se relativo, em relação ao workspace
        const effectiveWorkdir = workdir ? path.resolve(workspaceDir, workdir) : workspaceDir;

        // Strip "workspace/" apenas quando aparece no INÍCIO do comando (path relativo),
        // nunca no meio de caminhos absolutos (ex: /home/user/newclaw/workspace/jogos).
        // A regex anterior usava \b que fazia match em /…/workspace/ causando truncamento.
        if (!workdir) {
            command = command.replace(/(?:^|\s)workspace\//g, (m) => m.replace('workspace/', ''));
        }
        
        const execOptions: { timeout: number; cwd?: string } = { timeout };
        execOptions.cwd = effectiveWorkdir;

        // Comandos de busca retornam exit code 1 quando não há resultados — isso é um
        // resultado válido ("nenhum match"), não um erro. grep, rg, find -quit, etc.
        const isSearchCommand = /^\s*(grep|rg|find)\b/.test(command.replace(/^ssh[^\s]+\s+/, ''));

        try {
            const output = await new Promise<string>((resolve, reject) => {
                exec(command, execOptions, (error, stdout, stderr) => {
                    const combined = (stdout ? stdout.toString() : '') + (stderr ? stderr.toString() : '');
                    if (error) {
                        const exitCode = error.code ?? 'unknown';
                        // Exit code 1 em comandos de busca = "nenhum resultado encontrado" (válido).
                        // Apenas exit code 2+ indica erro real no grep/rg/find.
                        if (isSearchCommand && exitCode === 1) {
                            resolve('Nenhum resultado encontrado.');
                            return;
                        }
                        // Non-zero exit is a failure — reject so the caller sees success: false.
                        // Preserve stdout/stderr in combinedOutput so GoalEvaluator can classify it.
                        const fullOutput = (combined.trim() || error.message) + `\n[exit code: ${exitCode}]`;
                        reject(Object.assign(error, { combinedOutput: fullOutput.trim() }));
                    } else {
                        resolve(combined);
                    }
                });
            });

            return { success: true, output: output.trim().slice(0, 16000) };
        } catch (err) {
            const e = err as NodeJS.ErrnoException & { combinedOutput?: string };
            const msg = (e.combinedOutput || errorMessage(err)).slice(0, 16000);
            return { success: false, output: msg, error: msg };
        }
    }
}