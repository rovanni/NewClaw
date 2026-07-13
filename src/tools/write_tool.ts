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
import { resolvePath, selfEditError } from '../utils/crossPlatform';
import { errorMessage } from '../shared/errors';
import { createLogger } from '../shared/AppLogger';
import { PLACEHOLDER_ARG_PATTERN as PATH_PLACEHOLDER_PATTERN } from '../shared/placeholderPatterns';
import { CONTENT_STUB_PATTERNS } from '../shared/contentStubPatterns';

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

    async execute(args: Record<string, any>): Promise<ToolResult> {
        const rawPath = args.path as string;
        const content = (args.content as string) || '';

        if (!rawPath) {
            return { success: false, output: '', error: 'Parâmetro "path" é obrigatório' };
        }

        const workspaceDir = path.resolve(process.env.WORKSPACE_DIR ?? path.join(process.cwd(), 'workspace'));
        const { resolved: filePath, error: pathError } = resolvePath(rawPath);
        const selfErr = selfEditError(filePath);
        const isPlaceholder = PATH_PLACEHOLDER_PATTERN.test(rawPath);
        const placeholderMatch = isPlaceholder ? (rawPath.match(PATH_PLACEHOLDER_PATTERN)?.[0] ?? '') : '';
        log.info(`[ARTIFACT-PATH] tool=write requested="${rawPath}" resolved="${filePath}" workspace_dir="${workspaceDir}" canonical=${filePath.startsWith(workspaceDir)} exists=${fs.existsSync(filePath)}`);
        log.info(
            `[PATH-QUALITY] tool=write requested="${rawPath}" resolved="${filePath}"` +
            ` is_placeholder=${isPlaceholder} confidence=${isPlaceholder ? 'high' : 'ok'}` +
            (isPlaceholder ? ` matched_pattern="${placeholderMatch}"` : '')
        );
        if (isPlaceholder) {
            log.warn(`[PLACEHOLDER-DETECTION] tool=write path="${rawPath}" matched_pattern="${placeholderMatch}"`);
        }
        if (pathError) {
            return { success: false, output: '', error: pathError };
        }
        if (selfErr) {
            return { success: false, output: '', error: selfErr };
        }

        // CONTENT-STUB-GATE: falha rápido quando o conteúdo é um placeholder.
        // Sem este gate, o GoalExecutionLoop aceita o write como "sucesso" e gasta
        // todo o replanBudget tentando converter um arquivo inexistente (exec_command,
        // ssh_exec, Marp, etc.) antes de perceber que o artefato é inválido.
        const stubMatch = CONTENT_STUB_PATTERNS.find(p => p.test(content));
        if (stubMatch) {
            log.warn(`[CONTENT-STUB-GATE] path="${rawPath}" chars=${content.length} pattern="${stubMatch.source.slice(0, 60)}"`);
            return {
                success: false,
                output: '',
                error:
                    `[CONTENT-STUB] Conteúdo é um placeholder, não foi gravado (${content.length} chars detectados). ` +
                    `Para gerar documentos extensos (slides HTML, relatórios, código), OMITA 'toolName' no step — ` +
                    `o AgentLoop sintetizará o conteúdo REAL usando dados dos steps anteriores (web_search, read, etc.). ` +
                    `Não pré-gere o content no plano JSON quando ele depende de pesquisa ou síntese.`,
            };
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

            // H4: captura tamanho anterior para detectar sobrescrita destrutiva
            const existed = fs.existsSync(finalPath);
            const charsBefore = existed ? fs.readFileSync(finalPath, 'utf-8').length : 0;
            const chars = content.length;

            // H4: bloqueia sobrescrita que destruiria >50% do conteúdo existente.
            // Exceção: se o conteúdo EXISTENTE é ele próprio um stub/placeholder, não há conteúdo real
            // a proteger — a sobrescrita (mesmo com conteúdo menor) é sempre preferível a preservar um stub.
            if (existed && charsBefore > 0 && chars < charsBefore * 0.5) {
                const existingContent = fs.readFileSync(finalPath, 'utf-8');
                const existingIsStub = CONTENT_STUB_PATTERNS.some(p => p.test(existingContent))
                    || (charsBefore <= 300 && /^\[.*\]$/.test(existingContent.trim()));
                if (existingIsStub) {
                    log.info(
                        `[DESTRUCTIVE-WRITE-ALLOWED] path="${finalPath}"` +
                        ` chars_before=${charsBefore} chars_after=${chars}` +
                        ` reason=existing_content_is_stub`
                    );
                    // Continua para a escrita sem retornar erro
                } else {
                    const reductionPct = Math.round((1 - chars / charsBefore) * 100);
                    log.warn(
                        `[DESTRUCTIVE-WRITE-BLOCK] path="${finalPath}"` +
                        ` chars_before=${charsBefore} chars_after=${chars}` +
                        ` reduction_pct=${reductionPct}`
                    );
                    // L-M1: mensagem context-aware — quando o novo conteúdo é muito pequeno
                    // em relação ao arquivo existente (≥90% redução e < 2000 chars), o padrão
                    // típico é: GoalPlanner leu o arquivo como referência e tentou sobrescrevê-lo
                    // com conteúdo gerado parcialmente. O guia correto é criar um NOVO arquivo.
                    const likelyReferenceOverwrite = reductionPct >= 90 && chars < 2000;
                    const fileName = path.basename(finalPath);
                    const errorMsg = likelyReferenceOverwrite
                        ? `[DESTRUCTIVE-WRITE-BLOCK] Escrita bloqueada: o novo conteúdo (${chars} chars) é ${reductionPct}% menor que "${fileName}" (${charsBefore} chars). ` +
                          `CAUSA PROVÁVEL: "${fileName}" foi lido como referência, mas o novo conteúdo está sendo escrito NELE, destruindo o arquivo existente. ` +
                          `SOLUÇÃO OBRIGATÓRIA: crie um arquivo com NOME DIFERENTE para o novo conteúdo ` +
                          `(ex: se "${fileName}" é uma aula existente e você quer criar uma nova aula, grave em "nova_aula.html" ou similar). ` +
                          `NUNCA sobrescreva um arquivo de referência com conteúdo gerado.`
                        : `[DESTRUCTIVE-WRITE-BLOCK] Escrita bloqueada: o conteúdo seria reduzido de ` +
                          `${charsBefore} para ${chars} chars (−${reductionPct}%). ` +
                          `Use append=true para adicionar ao final, ou a ferramenta edit para modificações parciais.`;
                    return {
                        success: false,
                        output: '',
                        error: errorMsg,
                    };
                }
            }

            fs.writeFileSync(finalPath, content);
            const verb = existed ? 'Sobrescrito' : 'Criado';
            const lines = content.split('\n').length;

            // H4: [ARTIFACT-WRITE] — registra a operação para detectar sobrescrita destrutiva
            log.info(
                `[ARTIFACT-WRITE] path="${finalPath}" exists_before=${existed}` +
                ` chars_before=${charsBefore} chars_after=${chars}` +
                ` overwrite=${existed} append=false` +
                (existed && chars < charsBefore ? ` ⚠️ DESTRUTIVO chars_delta=${chars - charsBefore}` : '')
            );
            return {
                success: true,
                output: [
                    `${verb}: ${finalPath}`,
                    `Tamanho: ${chars} chars | ${lines} linhas`,
                    '',
                    '[ARTEFATO REGISTRADO] O arquivo existe e contém conteúdo.',
                    'Se o objetivo desta etapa foi gerar este arquivo, prossiga para a próxima ferramenta sem reescrever.',
                ].join('\n'),
                artifactPaths: [finalPath],
            };
        } catch (error) {
            return { success: false, output: '', error: errorMessage(error) };
        }
    }
}