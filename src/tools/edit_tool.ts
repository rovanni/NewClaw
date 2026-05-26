/**
 * edit — Editar arquivos via replace ou patch (modelo OpenClaw)
 *
 * Duas formas de edição:
 * - replace: substitui texto exato (oldText → newText), como o OpenClaw
 * - patch: substitui linhas por intervalo (startLine/endLine)
 * - append: adiciona conteúdo ao final do arquivo
 *
 * Princípio: Workspace = sandbox. Tudo dentro é permitido, nada fora é bloqueado.
 * Segurança: block self-editing + sandbox boundary.
 */

import { ToolExecutor, ToolResult } from '../loop/AgentLoop';
import fs from 'fs';
import path from 'path';
import { errorMessage } from '../shared/errors';

export class EditTool implements ToolExecutor {
    name = 'edit';
    description = 'Editar um arquivo existente: substituir texto exato (oldText→newText), patch por linhas, ou adicionar conteúdo ao final. Caminhos relativos são resolvidos a partir do workspace.';
    parameters = {
        type: 'object' as const,
        properties: {
            path: { type: 'string', description: 'Caminho do arquivo (relativo ao workspace ou absoluto)' },
            oldText: { type: 'string', description: 'Texto original a ser substituído (replace)' },
            newText: { type: 'string', description: 'Novo texto para substituição (replace)' },
            startLine: { type: 'number', description: 'Linha inicial para patch (1-indexed)' },
            endLine: { type: 'number', description: 'Linha final para patch (1-indexed, inclusive)' },
            content: { type: 'string', description: 'Conteúdo para patch (substitui linhas) ou append' },
            append: { type: 'boolean', description: 'Se true, adiciona conteúdo ao final do arquivo em vez de replace/patch' }
        },
        required: ['path']
    };

    /**
     * Resolve e valida caminho dentro do sandbox (workspace).
     * Multi-candidato: tenta absoluto, depois workspace-relativo.
     */
    private resolvePath(inputPath: string): { resolved: string; error?: string } {
        const workspaceDir = process.env.WORKSPACE_DIR || path.join(process.cwd(), 'workspace');
        const projectRoot = process.cwd();
        const homeDir = process.env.HOME || '/root';

        let expanded = Array.isArray(inputPath) ? String(inputPath[0] ?? '') : String(inputPath ?? '');

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

        // Construir lista de candidatos
        const candidates: string[] = [];

        if (path.isAbsolute(expanded)) {
            candidates.push(path.normalize(expanded));
            candidates.push(path.resolve(workspaceDir, expanded.slice(1)));
            if (expanded.startsWith('/workspace/')) {
                candidates.push(path.resolve(workspaceDir, expanded.slice(11)));
            }
        } else {
            candidates.push(path.resolve(workspaceDir, expanded));
        }

        // Fase 1: primeiro candidato permitido E existente no disco
        for (const candidate of candidates) {
            if (checkAllowed(candidate) && fs.existsSync(candidate)) {
                return this.checkSelfEdit(candidate, inputPath, projectRoot);
            }
        }

        // Fase 2: primeiro candidato permitido (para criação de arquivo)
        for (const candidate of candidates) {
            if (checkAllowed(candidate)) {
                return this.checkSelfEdit(candidate, inputPath, projectRoot);
            }
        }

        return {
            resolved: candidates[0] || inputPath,
            error: `⛔ Caminho fora do sandbox: ${inputPath} → tentados: ${candidates.join(', ')}. Allowed roots: ${allowedRoots.join(', ')}`
        };
    }

    /** Bloquear edição de código próprio do NewClaw */
    private checkSelfEdit(resolved: string, inputPath: string, projectRoot: string): { resolved: string; error?: string } {
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

        if (!rawPath) {
            return { success: false, output: '', error: 'Parâmetro "path" é obrigatório' };
        }

        const { resolved: filePath, error: pathError } = this.resolvePath(rawPath);
        if (pathError) {
            return { success: false, output: '', error: pathError };
        }

        const isAppend = args.append === true;

        try {
            // ── Append mode ──
            if (isAppend) {
                const content = (args.content as string) || '';
                if (!content) {
                    return { success: false, output: '', error: 'Parâmetro "content" é obrigatório para append' };
                }
                // Criar se não existe (como OpenClaw)
                const dir = path.dirname(filePath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                if (!fs.existsSync(filePath)) {
                    fs.writeFileSync(filePath, content);
                    return { success: true, output: `Arquivo criado: ${filePath}` };
                }
                fs.appendFileSync(filePath, '\n' + content);
                return { success: true, output: `Conteúdo adicionado: ${filePath}` };
            }

            // ── Replace mode (oldText → newText), como OpenClaw ──
            if (args.oldText !== undefined && args.newText !== undefined) {
                if (!fs.existsSync(filePath)) {
                    return { success: false, output: '', error: `Arquivo não encontrado: ${filePath}` };
                }
                const currentContent = fs.readFileSync(filePath, 'utf-8');
                if (!currentContent.includes(args.oldText as string)) {
                    return { success: false, output: '', error: `Texto alvo não encontrado: ${(args.oldText as string).slice(0, 100)}...` };
                }
                const newContent = currentContent.split(args.oldText as string).join(args.newText as string);
                fs.writeFileSync(filePath, newContent);
                return { success: true, output: `Substituição OK: ${filePath}` };
            }

            // ── Patch mode (startLine/endLine) ──
            if (args.startLine !== undefined && args.endLine !== undefined) {
                if (!fs.existsSync(filePath)) {
                    return { success: false, output: '', error: `Arquivo não encontrado: ${filePath}` };
                }
                const startLine = args.startLine as number;
                const endLine = args.endLine as number;
                const patchContent = (args.content as string) || '';
                if (startLine > endLine) {
                    return { success: false, output: '', error: '"startLine" deve ser ≤ "endLine"' };
                }
                const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
                if (startLine > lines.length) {
                    return { success: false, output: '', error: `"startLine" (${startLine}) > total de linhas (${lines.length})` };
                }
                const actualEnd = Math.min(endLine, lines.length);
                const newLines = patchContent.split('\n');
                lines.splice(startLine - 1, actualEnd - startLine + 1, ...newLines);
                fs.writeFileSync(filePath, lines.join('\n'));
                return { success: true, output: `Patch OK: linhas ${startLine}-${actualEnd} → ${newLines.length} linhas em ${filePath}` };
            }

            // ── Nenhum modo identificado ──
            return {
                success: false,
                output: '',
                error: 'Especifique o modo: (1) oldText+newText para replace, (2) startLine+endLine para patch, ou (3) append=true+content para adicionar ao final'
            };
        } catch (error) {
            return { success: false, output: '', error: errorMessage(error) };
        }
    }
}