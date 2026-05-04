/**
 * read — Ler arquivos e listar diretórios (modelo OpenClaw)
 *
 * Duas formas de leitura:
 * - Ler arquivo: retorna conteúdo
 * - Listar diretório: retorna entradas com ícones
 *
 * Princípio: Workspace = sandbox. Tudo dentro é permitido, nada fora é bloqueado.
 * Segurança: block self-editing + sandbox boundary.
 */

import { ToolExecutor, ToolResult } from '../loop/AgentLoop';
import fs from 'fs';
import path from 'path';

export class ReadTool implements ToolExecutor {
    name = 'read';
    description = 'Ler conteúdo de um arquivo ou listar entradas de um diretório. Se o caminho for um diretório, lista automaticamente. Caminhos relativos são resolvidos a partir do workspace.';
    parameters = {
        type: 'object' as const,
        properties: {
            path: { type: 'string', description: 'Caminho do arquivo ou diretório (relativo ao workspace ou absoluto)' },
            offset: { type: 'number', description: 'Linha inicial para leitura parcial (1-indexed)' },
            limit: { type: 'number', description: 'Número máximo de linhas para leitura parcial' }
        },
        required: ['path']
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

        return { resolved };
    }

    async execute(args: Record<string, any>): Promise<ToolResult> {
        const rawPath = args.path as string;

        if (!rawPath) {
            return { success: false, output: '', error: 'Parâmetro "path" é obrigatório' };
        }

        const { resolved: filePath, error: pathError } = this.resolvePath(rawPath);
        if (pathError) {
            return { success: false, output: '', error: pathError };
        }

        try {
            if (!fs.existsSync(filePath)) {
                return { success: false, output: '', error: `Arquivo não encontrado: ${filePath}` };
            }

            const stat = fs.statSync(filePath);

            // Se é diretório, listar
            if (stat.isDirectory()) {
                const entries = fs.readdirSync(filePath);
                const formatted = entries.map(e => {
                    const eStat = fs.statSync(path.join(filePath, e));
                    if (eStat.isDirectory()) return `📁 ${e}/`;
                    return `📄 ${e} (${eStat.size}B)`;
                }).join('\n');
                return { success: true, output: formatted || 'Diretório vazio' };
            }

            // Se é arquivo, ler conteúdo
            let content = fs.readFileSync(filePath, 'utf-8');

            // Suporte a offset e limit (como OpenClaw)
            if (args.offset || args.limit) {
                const lines = content.split('\n');
                const startLine = (args.offset as number) || 1;
                const lineLimit = (args.limit as number) || lines.length;
                const selectedLines = lines.slice(startLine - 1, startLine - 1 + lineLimit);
                content = selectedLines.join('\n');
                return { success: true, output: content };
            }

            return { success: true, output: content };
        } catch (error: any) {
            return { success: false, output: '', error: error.message };
        }
    }
}