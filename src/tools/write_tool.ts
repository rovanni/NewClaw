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

// H5: mesma lista de padrões usada em read_tool e GoalPlanner
const PATH_PLACEHOLDER_PATTERN =
    /\b(caminho_do|path_to|arquivo_identificado|the_file_path|nome_do_arquivo|your_file|nome_arquivo|caminho\/do)\b|\{[a-zA-Z_][a-zA-Z0-9_]{0,40}\}|\/path\/to\/|\/caminho\/do\//i;

// CONTENT-STUB-GATE: detecta placeholder no conteúdo — impede gravação de stubs silenciosa
// Esses padrões capturam os casos mais comuns gerados por LLMs ao criar planos com conteúdo
// extenso: a model escreve uma descrição do conteúdo em vez do conteúdo real.
const CONTENT_STUB_PATTERNS: RegExp[] = [
    /\.\.\.\s*\(.*?conteúdo/i,                         // "... (conteúdo completo da aula)"
    /\(conteúdo\s+(completo|da\s+aula|real)\b/i,        // "(conteúdo completo...)"
    /\[conteúdo\s*(completo|real|aqui|será|abrang)/i,   // "[Conteúdo completo abrangendo...]"
    /\[.*?completo.*?abrang/i,                          // "[...completo abrangendo...]"
    /<html>\s*<body>\s*\.\.\./i,                        // "<html><body>..."  (stub de HTML)
    /\[TODO[^\]]*\]/i,                                  // "[TODO: adicionar aqui]"
    /\[inserir\s+aqui\]/i,                              // "[inserir aqui]"
    /conteúdo será adicionado depois/i,                 // "conteúdo será adicionado depois"
    /\(em\s+construção\)/i,                             // "(em construção)"
    /HTML\s+Content\b|CSS\s+Content\b|JS\s+Content\b/i, // genéricos de template
    // LLM meta-placeholders — o modelo descreve o que DEVERIA gerar em vez de gerar
    /\[o\s+(modelo|agente|llm|sistema)\s+(irá|vai|deve|deverá)\s+(gerar|produzir|criar|escrever|completar)/i,
    /\[.*?(será\s+)?(gerado|produzido|criado|escrito|completado|preenchido)\s*(aqui|abaixo|posteriormente|depois|pelo\s+(modelo|agente|llm))/i,
    /\[.*?texto\s+(completo|real|será|do\s+discurso|do\s+conteúdo)/i,
    /\(o\s+(conteúdo|texto|html|slide|relatório)\s+(completo|real|será|aqui)/i,
    /será\s+preenchido\s+(depois|posteriormente|pelo\s+(modelo|agente))/i,
    /\[escrever\s+aqui\]|\[preencher\s+aqui\]|\[adicionar\s+aqui\]/i,
    /\[conteúdo\s+da\s+(aula|disciplina|curso|matéria)\]/i,
    /placeholder|PLACEHOLDER/,                          // literal "placeholder"
];

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
        const isPlaceholder = PATH_PLACEHOLDER_PATTERN.test(rawPath);
        const placeholderMatch = isPlaceholder ? (rawPath.match(PATH_PLACEHOLDER_PATTERN)?.[0] ?? '') : '';
        log.info(`[ARTIFACT-PATH] tool=write requested="${rawPath}" resolved="${filePath}" workspace_dir="${workspaceDir}" canonical=${filePath.startsWith(workspaceDir)} exists=${fs.existsSync(filePath)}`);
        // H5: sinaliza path placeholder — não bloqueia escrita mas registra para análise
        log.info(
            `[PATH-QUALITY] tool=write requested="${rawPath}" resolved="${filePath}"` +
            ` is_placeholder=${isPlaceholder} confidence=${isPlaceholder ? 'high' : 'ok'}` +
            (isPlaceholder ? ` matched_pattern="${placeholderMatch}"` : '')
        );
        // ITEM5: detecta placeholder para rastreamento de origem
        if (isPlaceholder) {
            log.warn(`[PLACEHOLDER-DETECTION] tool=write path="${rawPath}" matched_pattern="${placeholderMatch}"`);
        }
        if (pathError) {
            return { success: false, output: '', error: pathError };
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
                    return {
                        success: false,
                        output: '',
                        error:
                            `[DESTRUCTIVE-WRITE-BLOCK] Escrita bloqueada: o conteúdo seria reduzido de ` +
                            `${charsBefore} para ${chars} chars (−${reductionPct}%). ` +
                            `Use append=true para adicionar ao final, ou a ferramenta edit para modificações parciais.`,
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
            };
        } catch (error) {
            return { success: false, output: '', error: errorMessage(error) };
        }
    }
}