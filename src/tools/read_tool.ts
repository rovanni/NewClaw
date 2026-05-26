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
import { errorMessage } from '../shared/errors';

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

    /**
     * Resolve e valida caminho dentro do sandbox (workspace).
     *
     * Estratégia multi-candidato:
     * 1. Resolver o caminho como fornecido (absoluto ou relativo ao workspace)
     * 2. Se absoluto e não existir no disco, tentar como relativo ao workspace
     *    Exemplo: "/uenp" → tenta "/uenp", depois "WORKSPACE_DIR/uenp"
     * 3. Retornar o primeiro candidato que (a) é permitido E (b) existe no disco
     * 4. Se nenhum existir, retornar o primeiro permitido (para operações de escrita)
     */
    private resolvePath(inputPath: string): { resolved: string; error?: string } {
        const workspaceDir = process.env.WORKSPACE_DIR || path.join(process.cwd(), 'workspace');
        const projectRoot = process.cwd();
        const homeDir = process.env.HOME || '/root';

        let expanded = inputPath;
        
        // Normalizar APENAS prefixo relativo 'workspace/' (sem barra inicial).
        if (!expanded.startsWith('/') && expanded.startsWith('workspace/')) {
            expanded = expanded.slice(10);
        }

        if (expanded.startsWith('~/')) {
            expanded = homeDir + expanded.slice(1);
        } else if (expanded.startsWith('@')) {
            expanded = expanded.slice(1);
        }

        // Roots permitidas (Sandbox)
        const allowedRoots = [
            workspaceDir,
            '/tmp',
            '/workspace',
            path.join(projectRoot, 'workspace'),
            path.join(projectRoot, 'logs'),
            path.join(projectRoot, 'data'),
            homeDir,
        ];

        const checkAllowed = (p: string): boolean => {
            return allowedRoots.some(root => {
                const rel = path.relative(root, p);
                if (rel === '') return true;
                return !rel.startsWith('..') && !path.isAbsolute(rel);
            });
        };

        // Construir lista de candidatos (ordem de prioridade)
        // IMPORTANT: Most specific/direct paths first, then fallbacks.
        // Avoid nested workspace/workspace/ paths by preferring direct paths.
        const candidates: string[] = [];

        if (path.isAbsolute(expanded)) {
            // 1. Absolute path as-is (highest priority)
            //    But skip if it's under WORKSPACE_DIR/workspace/ (nested, likely wrong)
            const directPath = path.normalize(expanded);
            const nestedWorkspace = path.join(workspaceDir, 'workspace');
            if (!directPath.startsWith(nestedWorkspace + path.sep) && directPath !== nestedWorkspace) {
                candidates.push(directPath);
            }
            
            // 2. Fallback: treat as relative to workspace (strip leading /)
            //    /uenp → WORKSPACE_DIR/uenp
            const relativeToWorkspace = path.resolve(workspaceDir, expanded.slice(1));
            candidates.push(relativeToWorkspace);
            
            // 3. Fallback for /workspace/ prefix:
            //    /workspace/tmp/x → WORKSPACE_DIR/tmp/x (not WORKSPACE_DIR/workspace/tmp/x)
            if (expanded.startsWith('/workspace/')) {
                candidates.push(path.resolve(workspaceDir, expanded.slice(11)));
            }
        } else {
            // Relative: resolve from workspace
            candidates.push(path.resolve(workspaceDir, expanded));
        }

        // De-duplicate candidates (preserve order)
        const seen = new Set<string>();
        const uniqueCandidates = candidates.filter(c => {
            if (seen.has(c)) return false;
            seen.add(c);
            return true;
        });

        // Phase 1: find the first candidate that is allowed AND exists on disk
        for (const candidate of uniqueCandidates) {
            if (checkAllowed(candidate) && fs.existsSync(candidate)) {
                return { resolved: candidate };
            }
        }

        // Phase 2: no candidate exists — return the first allowed candidate
        // (needed for write operations where the file doesn't exist yet)
        for (const candidate of uniqueCandidates) {
            if (checkAllowed(candidate)) {
                return { resolved: candidate };
            }
        }

        // No candidate is allowed
        return {
            resolved: uniqueCandidates[0] || inputPath,
            error: `⛔ Caminho fora do sandbox: ${inputPath} → tentados: ${uniqueCandidates.join(', ')}. Allowed roots: ${allowedRoots.join(', ')}`
        };
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

        // Binary file extensions that should never be read as text
        const BINARY_EXTENSIONS = new Set([
            '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
            '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
            '.mp3', '.mp4', '.wav', '.ogg', '.avi', '.mkv', '.mov',
            '.zip', '.tar', '.gz', '.rar', '.7z',
            '.exe', '.bin', '.dll', '.so', '.dylib',
            '.db', '.sqlite', '.sqlite3',
        ]);

        const ext = path.extname(rawPath).toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) {
            return { success: false, output: '', error: `Arquivos binários (${ext}) não podem ser lidos como texto. Para PDF/DOC use exec_command com ferramentas como pdftotext ou pandoc.` };
        }

        // Max readable size: 200 KB — larger files flood the context
        const MAX_READ_BYTES = 200 * 1024;

        try {
            if (!fs.existsSync(filePath)) {
                // Lista a pasta pai do arquivo ausente (mais útil que listar o workspace raiz)
                let hint = '';
                try {
                    const parentDir = path.dirname(filePath);
                    if (fs.existsSync(parentDir)) {
                        const entries = fs.readdirSync(parentDir).slice(0, 30);
                        hint = entries.length > 0
                            ? ` Arquivos em ${parentDir}: ${entries.join(', ')}.`
                            : ` Diretório ${parentDir} está vazio.`;
                    } else {
                        const workspaceDir = process.env.WORKSPACE_DIR || path.join(process.cwd(), 'workspace');
                        if (fs.existsSync(workspaceDir)) {
                            const entries = fs.readdirSync(workspaceDir).slice(0, 20);
                            hint = entries.length > 0
                                ? ` Arquivos no workspace: ${entries.join(', ')}.`
                                : ' O workspace está vazio.';
                        }
                    }
                } catch { /* ignore listing errors */ }
                return { success: false, output: '', error: `Arquivo não encontrado: ${filePath}.${hint} Se o arquivo ainda não foi criado, use a ferramenta write primeiro.` };
            }

            const stat = fs.statSync(filePath);

            // Guard against huge files before reading
            if (!stat.isDirectory() && stat.size > MAX_READ_BYTES && !args.offset && !args.limit) {
                const kb = Math.round(stat.size / 1024);
                return { success: false, output: '', error: `Arquivo muito grande (${kb} KB) para leitura completa. Use os parâmetros offset e limit para leitura parcial, ou exec_command para processar o arquivo.` };
            }

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

            const filename = path.basename(filePath);
            const sizeKb = (stat.size / 1024).toFixed(1);

            // Suporte a offset e limit (como OpenClaw)
            if (args.offset || args.limit) {
                const lines = content.split('\n');
                const startLine = (args.offset as number) || 1;
                const lineLimit = (args.limit as number) || lines.length;
                const totalLines = lines.length;
                const selectedLines = lines.slice(startLine - 1, startLine - 1 + lineLimit);
                content = selectedLines.join('\n');
                const header = `[Arquivo: ${filename} | ${sizeKb}KB | linhas ${startLine}–${startLine + selectedLines.length - 1} de ${totalLines} — use offset/limit para ler outras partes]\n`;
                return { success: true, output: header + content };
            }

            const header = `[Arquivo: ${filename} | ${sizeKb}KB | Conteúdo completo — NÃO releia, use este conteúdo para executar a tarefa]\n`;
            return { success: true, output: header + content };
        } catch (error) {
            return { success: false, output: '', error: errorMessage(error) };
        }
    }
}