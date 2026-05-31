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
import { errorMessage } from '../shared/errors';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('WriteTool');

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

    /**
     * Resolve e valida caminho dentro do sandbox (workspace).
     * Multi-candidato: tenta absoluto, depois workspace-relativo.
     * Para escrita, retorna o primeiro candidato permitido (arquivo pode não existir ainda).
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

        // FIX #3: Normalização canônica — /workspace/* → WORKSPACE_DIR/*
        // Previne gravação em /workspace/ literal quando WORKSPACE_DIR aponta para outro caminho.
        if (expanded.startsWith('/workspace/')) {
            expanded = path.join(workspaceDir, expanded.slice('/workspace/'.length));
        } else if (expanded === '/workspace') {
            expanded = workspaceDir;
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
        const content = (args.content as string) || '';

        if (!rawPath) {
            return { success: false, output: '', error: 'Parâmetro "path" é obrigatório' };
        }

        const workspaceDir = process.env.WORKSPACE_DIR || path.join(process.cwd(), 'workspace');
        const { resolved: filePath, error: pathError } = this.resolvePath(rawPath);
        log.info(`[ARTIFACT-PATH] tool=write requested="${rawPath}" resolved="${filePath}" workspace_dir="${workspaceDir}" canonical=${filePath.startsWith(workspaceDir)} exists=${fs.existsSync(filePath)}`);
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
            const chars = content.length;
            const lines = content.split('\n').length;
            return {
                success: true,
                output: [
                    `${verb}: ${finalPath}`,
                    `Tamanho: ${chars} chars | ${lines} linhas`,
                    '',
                    '[ARTEFATO REGISTRADO] O arquivo existe e contém conteúdo.',
                    'Se o objetivo desta etapa foi gerar este arquivo, prossiga para a próxima ferramenta sem reescrever.',
                ].join('\n'),
            };
        } catch (error) {
            return { success: false, output: '', error: errorMessage(error) };
        }
    }
}