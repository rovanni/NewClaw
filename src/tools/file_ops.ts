/**
 * file_ops — Operações de arquivo (criar, ler, mover, listar)
 */

import { ToolExecutor, ToolResult } from '../loop/AgentLoop';
import fs from 'fs';
import path from 'path';

export class FileOpsTool implements ToolExecutor {
    name = 'file_ops';
    description = 'Operações com arquivos: criar, ler, mover, listar, deletar';
    parameters = {
        type: 'object',
        properties: {
            action: { 
                type: 'string', 
                enum: ['create', 'read', 'move', 'list', 'delete', 'replace', 'append', 'patch'],
                description: 'Ação a executar. Use "replace" para trocar texto exato, "patch" para trocar por número de linha, "append" para adicionar ao final' 
            },
            path: { type: 'string', description: 'Caminho do arquivo ou diretório' },
            content: { type: 'string', description: 'Conteúdo para criar, escrever ou adicionar' },
            target: { type: 'string', description: 'Texto original a ser substituído (apenas para ação replace)' },
            replacement: { type: 'string', description: 'Novo texto para substituir o original (apenas para ação replace)' },
            startLine: { type: 'number', description: 'Linha inicial para ação patch (1-indexed)' },
            endLine: { type: 'number', description: 'Linha final para ação patch (1-indexed, inclusive)' },
            destination: { type: 'string', description: 'Destino para mover' }
        },
        required: ['action', 'path']
    };

    async execute(args: Record<string, any>): Promise<ToolResult> {
        // Validate required parameters
        const action = args.action as string;
        let filePath = args.path as string;
        
        if (!action) {
            return { success: false, output: '', error: 'Parâmetro "action" é obrigatório. Use: create, read, list, move, delete, replace' };
        }
        if (!filePath) {
            return { success: false, output: '', error: 'Parâmetro "path" é obrigatório' };
        }

        // Auto-fix: ensure HTML files have .html extension
        // If path ends with a name that looks like an HTML page (contains HTML content or is in sites/),
        // and has no extension, add .html
        if (action === 'create' && !path.extname(filePath) && !filePath.endsWith('/')) {
            const content = (args.content as string) || '';
            if (content.trim().toLowerCase().startsWith('<!doctype') || content.trim().toLowerCase().startsWith('<html') || filePath.includes('/sites/')) {
                filePath = filePath + '.html';
            }
        }

        // Block self-editing — NewClaw must not modify its own source code
        const projectRoot = process.cwd();
        const blockedPaths = ['/opt/newclaw/src/', path.join(projectRoot, 'src')];
        const isSelfEdit = blockedPaths.some(p => filePath.startsWith(p)) && ['create', 'delete', 'move', 'replace'].includes(action);
        if (isSelfEdit) {
            return { success: false, output: `⛔ BLOCKED: Cannot modify NewClaw's own source code (${filePath}).` };
        }

        // Restrict write operations to allowed directories
        const workspaceDir = process.env.WORKSPACE_DIR || '/newclaw/workspace';
        const allowedWriteDirs = [workspaceDir, '/tmp/newclaw/', '/home/venus/newclaw/workspace/', path.join(projectRoot, 'workspace')];
        const isWriteOp = ['create', 'delete', 'move', 'replace'].includes(action);
        if (isWriteOp) {
            const isAllowed = allowedWriteDirs.some(d => filePath.startsWith(d));
            if (!isAllowed) {
                return { success: false, output: '', error: `⛔ Caminho não permitido para escrita: ${filePath}. Diretórios permitidos: ${allowedWriteDirs.join(', ')}` };
            }
        }

        try {
            switch (action) {
                case 'create': {
                    const content = args.content as string || '';
                    // BLOCK: Se o arquivo já existe, NÃO sobrescrever — forçar uso de replace
                    if (fs.existsSync(filePath)) {
                        return { success: false, output: "", error: "ARQUIVO JA EXISTE: " + filePath + ". Para modificar, use action=replace com target e replacement." };
                    }
                    const dir = path.dirname(filePath);
                    if (!fs.existsSync(dir)) {
                        fs.mkdirSync(dir, { recursive: true });
                    }
                    fs.writeFileSync(filePath, content);
                    return { success: true, output: `Arquivo criado: ${filePath}` };
                }

                case 'read': {
                    if (!fs.existsSync(filePath)) {
                        return { success: false, output: '', error: `Arquivo não encontrado: ${filePath}` };
                    }
                    const content = fs.readFileSync(filePath, 'utf-8');
                    return { success: true, output: content };
                }

                case 'list': {
                    if (!fs.existsSync(filePath)) {
                        return { success: false, output: '', error: `Diretório não encontrado: ${filePath}` };
                    }
                    const entries = fs.readdirSync(filePath);
                    const formatted = entries.map(e => {
                        const stat = fs.statSync(path.join(filePath, e));
                        return `${stat.isDirectory() ? '📁' : '📄'} ${e}`;
                    }).join('\n');
                    return { success: true, output: formatted || 'Diretório vazio' };
                }

                case 'move': {
                    const dest = args.destination as string;
                    if (!dest) return { success: false, output: '', error: 'Destino não fornecido' };
                    if (!fs.existsSync(filePath)) {
                        return { success: false, output: '', error: `Arquivo não encontrado: ${filePath}` };
                    }
                    fs.renameSync(filePath, dest);
                    return { success: true, output: `Movido: ${filePath} → ${dest}` };
                }

                case 'delete': {
                    if (!fs.existsSync(filePath)) {
                        return { success: false, output: '', error: `Arquivo não encontrado: ${filePath}` };
                    }
                    // Usar trash se disponível, senão rm
                    const trashDir = path.join(process.env.HOME || '/tmp', '.local/share/Trash/files');
                    if (fs.existsSync(trashDir)) {
                        const trashPath = path.join(trashDir, path.basename(filePath));
                        fs.renameSync(filePath, trashPath);
                        return { success: true, output: `Movido para lixeira: ${filePath}` };
                    }
                    fs.unlinkSync(filePath);
                    return { success: true, output: `Arquivo removido: ${filePath}` };
                }

                case 'replace': {
                    if (!fs.existsSync(filePath)) {
                        return { success: false, output: '', error: `Arquivo não encontrado: ${filePath}` };
                    }
                    const target = args.target as string;
                    const replacement = args.replacement as string;
                    if (target === undefined || replacement === undefined) {
                        return { success: false, output: '', error: 'Parâmetros "target" e "replacement" são obrigatórios para a ação replace' };
                    }
                    const currentContent = fs.readFileSync(filePath, 'utf-8');
                    if (!currentContent.includes(target)) {
                        return { success: false, output: '', error: `Texto alvo não encontrado no arquivo: ${target.slice(0, 100)}...` };
                    }
                    const newContent = currentContent.split(target).join(replacement);
                    fs.writeFileSync(filePath, newContent);
                    return { success: true, output: `Substituição realizada com sucesso em: ${filePath}` };
                }

                case 'append': {
                    if (!fs.existsSync(filePath)) {
                        // If file doesn't exist, create it
                        const content = args.content as string || '';
                        const dir = path.dirname(filePath);
                        if (!fs.existsSync(dir)) {
                            fs.mkdirSync(dir, { recursive: true });
                        }
                        fs.writeFileSync(filePath, content);
                        return { success: true, output: `Arquivo criado: ${filePath}` };
                    }
                    const content = args.content as string || '';
                    if (!content) {
                        return { success: false, output: '', error: 'Parâmetro "content" é obrigatório para append' };
                    }
                    fs.appendFileSync(filePath, '\n' + content);
                    return { success: true, output: `Conteúdo adicionado ao final de: ${filePath}` };
                }

                case 'patch': {
                    if (!fs.existsSync(filePath)) {
                        return { success: false, output: '', error: `Arquivo não encontrado: ${filePath}` };
                    }
                    const startLine = args.startLine as number;
                    const endLine = args.endLine as number;
                    const patchContent = args.content as string || '';
                    if (!startLine || !endLine) {
                        return { success: false, output: '', error: 'Parâmetros "startLine" e "endLine" são obrigatórios para patch. Use números de linha (1-indexed)' };
                    }
                    if (startLine > endLine) {
                        return { success: false, output: '', error: '"startLine" deve ser menor ou igual a "endLine"' };
                    }
                    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
                    if (startLine > lines.length) {
                        return { success: false, output: '', error: `"startLine" (${startLine}) é maior que o número de linhas do arquivo (${lines.length})` };
                    }
                    const actualEnd = Math.min(endLine, lines.length);
                    const removedLines = lines.slice(startLine - 1, actualEnd).join('\n');
                    const newLines = patchContent.split('\n');
                    lines.splice(startLine - 1, actualEnd - startLine + 1, ...newLines);
                    fs.writeFileSync(filePath, lines.join('\n'));
                    return { success: true, output: `Patch aplicado: linhas ${startLine}-${actualEnd} substituídas por ${newLines.length} linhas em ${filePath}` };
                }

                default:
                    return { success: false, output: '', error: `Ação desconhecida: ${action}. Use: create, read, list, move, delete, replace, append, patch` };
            }
        } catch (error: any) {
            return { success: false, output: '', error: error.message };
        }
    }
}