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
        const candidates: string[] = [];

        if (path.isAbsolute(expanded)) {
            // 1. Caminho absoluto como fornecido
            candidates.push(path.normalize(expanded));
            // 2. Fallback: tratar como relativo ao workspace (strip leading /)
            //    "/uenp" → "WORKSPACE_DIR/uenp"
            candidates.push(path.resolve(workspaceDir, expanded.slice(1)));
            // 3. Fallback para /workspace/ prefix:
            //    "/workspace/tmp/x" → "WORKSPACE_DIR/tmp/x"
            if (expanded.startsWith('/workspace/')) {
                candidates.push(path.resolve(workspaceDir, expanded.slice(11)));
            }
        } else {
            // Relativo: resolver a partir do workspace
            candidates.push(path.resolve(workspaceDir, expanded));
        }

        // Fase 1: encontrar o primeiro candidato que é permitido E existe no disco
        for (const candidate of candidates) {
            if (checkAllowed(candidate) && fs.existsSync(candidate)) {
                return { resolved: candidate };
            }
        }

        // Fase 2: nenhum existe — retornar o primeiro candidato permitido
        // (necessário para operações de escrita onde o arquivo ainda não existe)
        for (const candidate of candidates) {
            if (checkAllowed(candidate)) {
                return { resolved: candidate };
            }
        }

        // Nenhum candidato é permitido
        return {
            resolved: candidates[0] || inputPath,
            error: `⛔ Caminho fora do sandbox: ${inputPath} → tentados: ${candidates.join(', ')}. Allowed roots: ${allowedRoots.join(', ')}`
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