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

import { ToolExecutor, ToolResult } from '../loop/agentLoopTypes';
import fs from 'fs';
import path from 'path';
import { resolvePath, selfEditError } from '../utils/crossPlatform';
import { errorMessage } from '../shared/errors';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('EditTool');

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

    async execute(args: Record<string, any>): Promise<ToolResult> {
        const rawPath = args.path as string;

        if (!rawPath) {
            return { success: false, output: '', error: 'Parâmetro "path" é obrigatório' };
        }

        const workspaceDir = path.resolve(process.env.WORKSPACE_DIR ?? path.join(process.cwd(), 'workspace'));
        const { resolved: filePath, error: pathError } = resolvePath(rawPath);
        const selfErr = selfEditError(filePath);
        log.info(`[ARTIFACT-PATH] tool=edit requested="${rawPath}" resolved="${filePath}" workspace_dir="${workspaceDir}" canonical=${filePath.startsWith(workspaceDir)} exists=${fs.existsSync(filePath)}`);
        if (pathError) {
            return { success: false, output: '', error: pathError };
        }
        if (selfErr) {
            return { success: false, output: '', error: selfErr };
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