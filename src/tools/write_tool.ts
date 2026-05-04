/**
 * write — Criar ou sobrescrever arquivos (modelo OpenClaw)
 *
 * Princípio: Workspace = sandbox. Tudo dentro é permitido, nada fora é bloqueado.
 * Path resolution: caminhos relativos resolvidos a partir do workspace.
 * Segurança: block self-editing + sandbox boundary.
 */

import { ToolExecutor, ToolResult } from '../loop/AgentLoop';
import fs from 'fs';
import path from 'path';

export class WriteTool implements ToolExecutor {
    name = 'write';
    description = 'Criar ou sobrescrever um arquivo. Cria diretórios pais automaticamente. Caminhos relativos são resolvidos a partir do workspace.';
    parameters = {
        type: 'object' as const,
        properties: {
            path: { type: 'string', description: 'Caminho do arquivo (relativo ao workspace ou absoluto)' },
            content: { type: 'string', description: 'Conteúdo a escrever no arquivo' }
        },
        required: ['path', 'content']
    };

    /** Resolve e valida caminho dentro do sandbox (workspace) */
    private resolvePath(inputPath: string): { resolved: string; error?: string } {
        const workspaceDir = process.env.WORKSPACE_DIR || path.join(process.cwd(), 'workspace');
        const projectRoot = process.cwd();

        let expanded = inputPath;
        if (expanded.startsWith('~/')) {
            expanded = (process.env.HOME || '/root') + expanded.slice(1);
        } else if (expanded.startsWith('@')) {
            expanded = expanded.slice(1);
        }

        let resolved: string;
        if (path.isAbsolute(expanded)) {
            resolved = path.normalize(expanded);
        } else {
            resolved = path.resolve(workspaceDir, expanded);
        }

        const allowedRoots = [
            workspaceDir,
            '/tmp',
            path.join(projectRoot, 'workspace'),
            path.join(projectRoot, 'logs'),
            path.join(projectRoot, 'data')
        ];

        const isAllowed = allowedRoots.some(root => {
            const rel = path.relative(root, resolved);
            return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
        }) || resolved === workspaceDir || allowedRoots.includes(resolved);

        if (!isAllowed) {
            return {
                resolved,
                error: `⛔ Caminho fora do sandbox: ${inputPath}. Workspace: ${workspaceDir}`
            };
        }

        const blockedPaths = [
            path.join(projectRoot, 'src'),
            path.join(projectRoot, 'dist'),
            path.join(projectRoot, 'bin'),
            path.join(projectRoot, '.env')
        ];
        const isSelfEdit = blockedPaths.some(p => resolved.startsWith(p));
        if (isSelfEdit) {
            return {
                resolved,
                error: `⛔ BLOCKED: Não pode modificar código próprio do NewClaw (${inputPath})`
            };
        }

        return { resolved };
    }

    async execute(args: Record<string, any>): Promise<ToolResult> {
        const rawPath = args.path as string;
        const content = (args.content as string) || '';

        if (!rawPath) {
            return { success: false, output: '', error: 'Parâmetro "path" é obrigatório' };
        }

        const { resolved: filePath, error: pathError } = this.resolvePath(rawPath);
        if (pathError) {
            return { success: false, output: '', error: pathError };
        }

        // Auto-fix: HTML files em /sites/ sem extensão
        let finalPath = filePath;
        if (!path.extname(finalPath) && !finalPath.endsWith('/')) {
            if (content.trim().toLowerCase().startsWith('<!doctype') ||
                content.trim().toLowerCase().startsWith('<html') ||
                finalPath.includes('/sites/')) {
                finalPath = finalPath + '.html';
            }
        }

        try {
            // Criar diretórios pai automaticamente
            const dir = path.dirname(finalPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            const existed = fs.existsSync(finalPath);
            fs.writeFileSync(finalPath, content);
            const verb = existed ? 'Sobrescrito' : 'Criado';
            return { success: true, output: `${verb}: ${finalPath}` };
        } catch (error: any) {
            return { success: false, output: '', error: error.message };
        }
    }
}