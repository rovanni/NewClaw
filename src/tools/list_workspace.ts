import { ToolExecutor, ToolResult } from '../loop/AgentLoop';
import fs from 'fs';
import path from 'path';

const WORKSPACE = process.env.WORKSPACE_DIR || './workspace';
const MAX_LINES = 200;

function humanSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function listDir(dir: string, prefix: string, depth: number, maxDepth: number, pattern: string, lines: string[]): void {
    if (depth > maxDepth || lines.length >= MAX_LINES) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
    });

    entries.forEach((entry, i) => {
        if (lines.length >= MAX_LINES) return;
        if (pattern && !entry.name.toLowerCase().includes(pattern.toLowerCase())) {
            if (entry.isDirectory()) listDir(path.join(dir, entry.name), prefix + '    ', depth + 1, maxDepth, pattern, lines);
            return;
        }
        const isLast = i === entries.length - 1;
        const connector = isLast ? '└── ' : '├── ';
        const childPrefix = prefix + (isLast ? '    ' : '│   ');

        if (entry.isDirectory()) {
            lines.push(`${prefix}${connector}${entry.name}/`);
            listDir(path.join(dir, entry.name), childPrefix, depth + 1, maxDepth, pattern, lines);
        } else {
            try {
                const stat = fs.statSync(path.join(dir, entry.name));
                lines.push(`${prefix}${connector}${entry.name}  (${humanSize(stat.size)}, ${stat.mtime.toISOString().slice(0, 10)})`);
            } catch {
                lines.push(`${prefix}${connector}${entry.name}`);
            }
        }
    });
}

export class ListWorkspaceTool implements ToolExecutor {
    name = 'list_workspace';
    description = 'Lista arquivos e pastas do workspace. Use para encontrar arquivos antes de lê-los ou quando o usuário perguntar o que há no workspace. Nunca carrega o conteúdo dos arquivos — apenas nomes, tamanhos e datas.';
    parameters = {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'Subpasta dentro do workspace para listar (ex: "contratos" ou "contratos/2025"). Omita para listar a raiz.',
            },
            pattern: {
                type: 'string',
                description: 'Filtro de nome: lista apenas entradas cujo nome contenha este texto (ex: "pdf", "relatorio", "jan"). Case-insensitive.',
            },
            depth: {
                type: 'number',
                description: 'Profundidade máxima de subpastas a mostrar (padrão: 2, máximo: 4).',
            },
        },
        required: [],
    };

    async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const subPath = ((args.path as string) || '').replace(/\.\./g, '').trim();
        const pattern = (args.pattern as string) || '';
        const depth = Math.min(Math.max(Number(args.depth) || 2, 1), 4);

        const targetDir = subPath ? path.join(WORKSPACE, subPath) : WORKSPACE;

        if (!fs.existsSync(targetDir)) {
            return { success: false, output: '', error: `Pasta "${subPath || 'workspace'}" não encontrada.` };
        }

        const lines: string[] = [];
        const header = subPath ? `${WORKSPACE}/${subPath}/` : `${WORKSPACE}/`;
        lines.push(header);
        listDir(targetDir, '', 0, depth, pattern, lines);

        if (lines.length === 1) {
            lines.push('  (vazio)');
        } else if (lines.length >= MAX_LINES) {
            lines.push(`\n⚠️ Resultado limitado a ${MAX_LINES} entradas. Use o parâmetro "path" para navegar subpastas específicas.`);
        }

        return { success: true, output: lines.join('\n') };
    }
}
