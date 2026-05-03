/**
 * file_ops — Operações de arquivo no modelo OpenClaw
 * 
 * Princípio: Workspace = sandbox. Tudo dentro é permitido, nada fora é bloqueado.
 * Path resolution: caminhos relativos resolvidos a partir do workspace.
 * Segurança: block self-editing + sandbox boundary.
 */

import { ToolExecutor, ToolResult } from '../loop/AgentLoop';
import fs from 'fs';
import path from 'path';

export class FileOpsTool implements ToolExecutor {
    name = 'file_ops';
    description = 'Operações com arquivos: criar, ler, mover, listar, deletar, substituir, adicionar, patch. Caminhos relativos são resolvidos a partir do workspace.';
    parameters = {
        type: 'object',
        properties: {
            action: { 
                type: 'string', 
                enum: ['create', 'read', 'move', 'list', 'delete', 'replace', 'append', 'patch'],
                description: 'Ação a executar' 
            },
            path: { type: 'string', description: 'Caminho do arquivo ou diretório (relativo ao workspace ou absoluto)' },
            content: { type: 'string', description: 'Conteúdo para criar, escrever ou adicionar' },
            target: { type: 'string', description: 'Texto original a ser substituído (ação replace)' },
            replacement: { type: 'string', description: 'Novo texto para substituição (ação replace)' },
            startLine: { type: 'number', description: 'Linha inicial para patch (1-indexed)' },
            endLine: { type: 'number', description: 'Linha final para patch (1-indexed, inclusive)' },
            destination: { type: 'string', description: 'Destino para mover' }
        },
        required: ['action', 'path']
    };

    /** Resolve e valida caminho dentro do sandbox (workspace) */
    private resolvePath(inputPath: string): { resolved: string; error?: string } {
        const workspaceDir = process.env.WORKSPACE_DIR || path.join(process.cwd(), 'workspace');
        const projectRoot = process.cwd();

        // Expandir ~ e @prefix
        let expanded = inputPath;
        if (expanded.startsWith('~/')) {
            expanded = (process.env.HOME || '/root') + expanded.slice(1);
        } else if (expanded.startsWith('@')) {
            expanded = expanded.slice(1);
        }

        // Resolver caminho relativo a partir do workspace
        let resolved: string;
        if (path.isAbsolute(expanded)) {
            resolved = path.normalize(expanded);
        } else {
            resolved = path.resolve(workspaceDir, expanded);
        }

        // Verificar sandbox: permitir workspace, /tmp, e project root
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

        // Block self-editing — não modificar código-fonte do NewClaw
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

    /** Valida caminho de destino (para move) */
    private resolveDestination(inputPath: string): { resolved: string; error?: string } {
        return this.resolvePath(inputPath);
    }

    async execute(args: Record<string, any>): Promise<ToolResult> {
        const action = args.action as string;
        const rawPath = args.path as string;

        if (!action) {
            return { success: false, output: '', error: 'Parâmetro "action" é obrigatório. Use: create, read, list, move, delete, replace, append, patch' };
        }
        if (!rawPath) {
            return { success: false, output: '', error: 'Parâmetro "path" é obrigatório' };
        }

        // Resolver caminho
        const { resolved: filePath, error: pathError } = this.resolvePath(rawPath);
        if (pathError) {
            return { success: false, output: '', error: pathError };
        }

        // Auto-fix: HTML files em /sites/ sem extensão
        let finalPath = filePath;
        if (action === 'create' && !path.extname(finalPath) && !finalPath.endsWith('/')) {
            const content = (args.content as string) || '';
            if (content.trim().toLowerCase().startsWith('<!doctype') || 
                content.trim().toLowerCase().startsWith('<html') || 
                finalPath.includes('/sites/')) {
                finalPath = finalPath + '.html';
            }
        }

        try {
            switch (action) {
                case 'create': {
                    const content = (args.content as string) || '';
                    // Criar diretórios pai automaticamente (como OpenClaw)
                    const dir = path.dirname(finalPath);
                    if (!fs.existsSync(dir)) {
                        fs.mkdirSync(dir, { recursive: true });
                    }
                    // Se arquivo já existe, sobrescrever (como OpenClaw faz com write)
                    fs.writeFileSync(finalPath, content);
                    const verb = fs.existsSync(finalPath) ? 'Sobrescrito' : 'Criado';
                    return { success: true, output: `${verb}: ${finalPath}` };
                }

                case 'read': {
                    if (!fs.existsSync(finalPath)) {
                        return { success: false, output: '', error: `Arquivo não encontrado: ${finalPath}` };
                    }
                    // Se é diretório, listar ao invés de ler
                    const stat = fs.statSync(finalPath);
                    if (stat.isDirectory()) {
                        const entries = fs.readdirSync(finalPath);
                        const formatted = entries.map(e => {
                            const eStat = fs.statSync(path.join(finalPath, e));
                            return `${eStat.isDirectory() ? '📁' : '📄'} ${e}`;
                        }).join('\n');
                        return { success: true, output: formatted || 'Diretório vazio' };
                    }
                    const content = fs.readFileSync(finalPath, 'utf-8');
                    return { success: true, output: content };
                }

                case 'list': {
                    const listPath = fs.existsSync(finalPath) ? finalPath : path.dirname(finalPath);
                    if (!fs.existsSync(listPath)) {
                        return { success: false, output: '', error: `Diretório não encontrado: ${listPath}` };
                    }
                    const stat = fs.statSync(listPath);
                    if (!stat.isDirectory()) {
                        return { success: true, output: `📄 ${path.basename(listPath)} (${stat.size} bytes)` };
                    }
                    const entries = fs.readdirSync(listPath);
                    const formatted = entries.map(e => {
                        const eStat = fs.statSync(path.join(listPath, e));
                        if (eStat.isDirectory()) return `📁 ${e}/`;
                        return `📄 ${e} (${eStat.size}B)`;
                    }).join('\n');
                    return { success: true, output: formatted || 'Diretório vazio' };
                }

                case 'move': {
                    const rawDest = args.destination as string;
                    if (!rawDest) return { success: false, output: '', error: 'Parâmetro "destination" é obrigatório para move' };
                    const { resolved: destPath, error: destError } = this.resolveDestination(rawDest);
                    if (destError) return { success: false, output: '', error: destError };
                    if (!fs.existsSync(finalPath)) {
                        return { success: false, output: '', error: `Arquivo não encontrado: ${finalPath}` };
                    }
                    // Criar diretório de destino se não existe
                    const destDir = path.dirname(destPath);
                    if (!fs.existsSync(destDir)) {
                        fs.mkdirSync(destDir, { recursive: true });
                    }
                    fs.renameSync(finalPath, destPath);
                    return { success: true, output: `Movido: ${finalPath} → ${destPath}` };
                }

                case 'delete': {
                    if (!fs.existsSync(finalPath)) {
                        return { success: false, output: '', error: `Arquivo não encontrado: ${finalPath}` };
                    }
                    // Usar trash se disponível (como OpenClaw)
                    const trashDir = path.join(process.env.HOME || '/tmp', '.local/share/Trash/files');
                    if (fs.existsSync(trashDir)) {
                        const trashPath = path.join(trashDir, path.basename(finalPath));
                        fs.renameSync(finalPath, trashPath);
                        return { success: true, output: `Movido para lixeira: ${finalPath}` };
                    }
                    const stat = fs.statSync(finalPath);
                    if (stat.isDirectory()) {
                        fs.rmSync(finalPath, { recursive: true });
                    } else {
                        fs.unlinkSync(finalPath);
                    }
                    return { success: true, output: `Removido: ${finalPath}` };
                }

                case 'replace': {
                    if (!fs.existsSync(finalPath)) {
                        return { success: false, output: '', error: `Arquivo não encontrado: ${finalPath}` };
                    }
                    const target = args.target as string;
                    const replacement = args.replacement as string;
                    if (target === undefined || replacement === undefined) {
                        return { success: false, output: '', error: 'Parâmetros "target" e "replacement" são obrigatórios para replace' };
                    }
                    const currentContent = fs.readFileSync(finalPath, 'utf-8');
                    if (!currentContent.includes(target)) {
                        return { success: false, output: '', error: `Texto alvo não encontrado: ${target.slice(0, 100)}...` };
                    }
                    const newContent = currentContent.split(target).join(replacement);
                    fs.writeFileSync(finalPath, newContent);
                    return { success: true, output: `Substituição OK: ${finalPath}` };
                }

                case 'append': {
                    const content = (args.content as string) || '';
                    if (!content) {
                        return { success: false, output: '', error: 'Parâmetro "content" é obrigatório para append' };
                    }
                    // Criar se não existe (como OpenClaw)
                    const dir = path.dirname(finalPath);
                    if (!fs.existsSync(dir)) {
                        fs.mkdirSync(dir, { recursive: true });
                    }
                    if (!fs.existsSync(finalPath)) {
                        fs.writeFileSync(finalPath, content);
                        return { success: true, output: `Arquivo criado: ${finalPath}` };
                    }
                    fs.appendFileSync(finalPath, '\n' + content);
                    return { success: true, output: `Conteúdo adicionado: ${finalPath}` };
                }

                case 'patch': {
                    if (!fs.existsSync(finalPath)) {
                        return { success: false, output: '', error: `Arquivo não encontrado: ${finalPath}` };
                    }
                    const startLine = args.startLine as number;
                    const endLine = args.endLine as number;
                    const patchContent = (args.content as string) || '';
                    if (!startLine || !endLine) {
                        return { success: false, output: '', error: 'Parâmetros "startLine" e "endLine" são obrigatórios para patch (1-indexed)' };
                    }
                    if (startLine > endLine) {
                        return { success: false, output: '', error: '"startLine" deve ser ≤ "endLine"' };
                    }
                    const lines = fs.readFileSync(finalPath, 'utf-8').split('\n');
                    if (startLine > lines.length) {
                        return { success: false, output: '', error: `"startLine" (${startLine}) > total de linhas (${lines.length})` };
                    }
                    const actualEnd = Math.min(endLine, lines.length);
                    const newLines = patchContent.split('\n');
                    lines.splice(startLine - 1, actualEnd - startLine + 1, ...newLines);
                    fs.writeFileSync(finalPath, lines.join('\n'));
                    return { success: true, output: `Patch OK: linhas ${startLine}-${actualEnd} → ${newLines.length} linhas em ${finalPath}` };
                }

                default:
                    return { success: false, output: '', error: `Ação desconhecida: ${action}. Use: create, read, list, move, delete, replace, append, patch` };
            }
        } catch (error: any) {
            return { success: false, output: '', error: error.message };
        }
    }
}