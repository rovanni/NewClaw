/**
 * GoalEvaluator — Trata falhas de tool como estado, não como exceção.
 *
 * Classificação determinística de resultados de execução:
 *   success   → objetivo do step alcançado
 *   partial   → progresso parcial, retry pode funcionar
 *   blocked   → blocker identificado, replan necessário
 *   failed    → irrecuperável, budget esgotado
 *   needs_auth → autorização explícita requerida antes de prosseguir
 *
 * A classificação usa padrões de erro conhecidos antes de recorrer a LLM,
 * para garantir latência mínima na maioria dos casos.
 */

import { createLogger } from '../shared/AppLogger';
import { ToolResult } from './agentLoopTypes';
import { Goal, PlanStep, CycleResult, GoalBlocker, BlockerKind, DependencyInfo } from './GoalTypes';
import { extractMissingExecutable } from './planning/extractMissingExecutable';
import { computeToolInputKey } from './planning/computeToolInputKey';
import { ECONNRESET_PATTERN, ETIMEDOUT_PATTERN, TIMEOUT_PATTERN, NETWORK_PATTERN, RATE_LIMIT_PATTERN, HTTP_429_PATTERN, combineRegExp } from '../shared/transientErrorPatterns';

const log = createLogger('GoalEvaluator');

// ── Mapa de dependências instaláveis automaticamente ─────────────────────────
// Chave: nome do executável que aparece na mensagem de erro (lowercase)

const KNOWN_DEPS: Record<string, DependencyInfo> = {
    pandoc:      { name: 'pandoc',                 installCmd: 'sudo apt install pandoc -y',                  manualInstructions: 'Instale com: sudo apt install pandoc -y',                       type: 'system' },
    ffmpeg:      { name: 'ffmpeg',                 installCmd: 'sudo apt install ffmpeg -y',                  manualInstructions: 'Instale com: sudo apt install ffmpeg -y',                       type: 'system' },
    convert:     { name: 'imagemagick',            installCmd: 'sudo apt install imagemagick -y',             manualInstructions: 'Instale com: sudo apt install imagemagick -y',                  type: 'system' },
    magick:      { name: 'imagemagick',            installCmd: 'sudo apt install imagemagick -y',             manualInstructions: 'Instale com: sudo apt install imagemagick -y',                  type: 'system' },
    libreoffice: { name: 'libreoffice',            installCmd: 'sudo apt install libreoffice -y',             manualInstructions: 'Instale com: sudo apt install libreoffice -y',                  type: 'system' },
    soffice:     { name: 'libreoffice',            installCmd: 'sudo apt install libreoffice -y',             manualInstructions: 'Instale com: sudo apt install libreoffice -y',                  type: 'system' },
    pdftotext:   { name: 'poppler-utils',          installCmd: 'sudo apt install poppler-utils -y',           manualInstructions: 'Instale com: sudo apt install poppler-utils -y',               type: 'system' },
    pdfimages:   { name: 'poppler-utils',          installCmd: 'sudo apt install poppler-utils -y',           manualInstructions: 'Instale com: sudo apt install poppler-utils -y',               type: 'system' },
    jq:          { name: 'jq',                     installCmd: 'sudo apt install jq -y',                      manualInstructions: 'Instale com: sudo apt install jq -y',                          type: 'system' },
    zip:         { name: 'zip',                    installCmd: 'sudo apt install zip -y',                     manualInstructions: 'Instale com: sudo apt install zip -y',                         type: 'system' },
    unzip:       { name: 'unzip',                  installCmd: 'sudo apt install unzip -y',                   manualInstructions: 'Instale com: sudo apt install unzip -y',                       type: 'system' },
    curl:        { name: 'curl',                   installCmd: 'sudo apt install curl -y',                    manualInstructions: 'Instale com: sudo apt install curl -y',                        type: 'system' },
    wget:        { name: 'wget',                   installCmd: 'sudo apt install wget -y',                    manualInstructions: 'Instale com: sudo apt install wget -y',                        type: 'system' },
    git:         { name: 'git',                    installCmd: 'sudo apt install git -y',                     manualInstructions: 'Instale com: sudo apt install git -y',                         type: 'system' },
    gs:          { name: 'ghostscript',            installCmd: 'sudo apt install ghostscript -y',             manualInstructions: 'Instale com: sudo apt install ghostscript -y',                 type: 'system' },
    ghostscript: { name: 'ghostscript',            installCmd: 'sudo apt install ghostscript -y',             manualInstructions: 'Instale com: sudo apt install ghostscript -y',                 type: 'system' },
    exiftool:    { name: 'libimage-exiftool-perl', installCmd: 'sudo apt install libimage-exiftool-perl -y', manualInstructions: 'Instale com: sudo apt install libimage-exiftool-perl -y',      type: 'system' },
    npm:         { name: 'npm',                    installCmd: 'sudo apt install npm -y',                     manualInstructions: 'Instale com: sudo apt install npm -y',                         type: 'node'   },
    npx:         { name: 'npm',                    installCmd: 'sudo apt install npm -y',                     manualInstructions: 'Instale npm (inclui npx): sudo apt install npm -y',            type: 'node'   },
    node:        { name: 'nodejs',                 installCmd: 'sudo apt install nodejs npm -y',              manualInstructions: 'Instale com: sudo apt install nodejs npm -y',                  type: 'node'   },
    // marp é a única entrada hoje cujo comando (npm install -g) já é genuinamente cross-platform
    // — migrada para installByPlatform explícito em vez de installCmd legado, para não depender
    // do fallback "só Linux" e não perder a instalação automática em Windows/macOS.
    marp:        { name: '@marp-team/marp-cli',    installByPlatform: { windows: 'npm install -g @marp-team/marp-cli', linux: 'npm install -g @marp-team/marp-cli', macos: 'npm install -g @marp-team/marp-cli' }, manualInstructions: 'Instale o marp-cli globalmente: npm install -g @marp-team/marp-cli', type: 'node' },
    pip:         { name: 'python3-pip',            installCmd: 'sudo apt install python3-pip -y',             manualInstructions: 'Instale com: sudo apt install python3-pip -y',                 type: 'python' },
    pip3:        { name: 'python3-pip',            installCmd: 'sudo apt install python3-pip -y',             manualInstructions: 'Instale com: sudo apt install python3-pip -y',                 type: 'python' },
    // edge-tts: SEM installCmd/installByPlatform de propósito nesta rodada. O execution loop
    // (GoalExecutionLoop.ts, needs_dependency) resolve o comando via resolveInstallCommand()
    // e o executa direto via exec_command sem antes checar se o runtime Python (python3/pip3)
    // está presente — declarar aqui um comando "python -m pip install edge-tts" apenas
    // moveria a falha para um segundo ENOENT (agora de 'python'), sem ganho real. Por ora,
    // edge-tts é reconhecido, classificado e vira needs_dependency com instrução manual;
    // auto-install fica para uma rodada futura que valide o runtime antes de auto-instalar.
    'edge-tts':  { name: 'edge-tts',               manualInstructions: 'Instale o edge-tts (requer Python 3 + pip) — Windows: python -m pip install edge-tts | Linux: python3 -m pip install edge-tts | macOS: python3 -m pip install edge-tts', type: 'python' },
};

// ── Padrões de classificação de erro ─────────────────────────────────────────

interface ErrorPattern {
    pattern: RegExp;
    kind: BlockerKind;
    description: (match: RegExpMatchArray, toolName: string) => string;
    suggestedActions: string[];
    isRetryable: boolean;
}

const ERROR_PATTERNS: ErrorPattern[] = [
    // ENOENT de operação de arquivo/diretório (fs: open/scandir/stat/...), NÃO de processo.
    // Precisa vir ANTES do padrão de missing_tool: "ENOENT: no such file or directory, open
    // 'input.mp3'" contém tanto "ENOENT" quanto "no such file" — sem esta exclusão explícita,
    // TODO ENOENT de fs (arquivo de entrada ou diretório ausente) seria confundido com
    // executável ausente. O shape do Node distingue os dois: erro de spawn é "spawn <cmd>
    // ENOENT" (ENOENT no final, sem vírgula); erro de fs é "ENOENT: no such file or directory,
    // <syscall> '<path>'" (ENOENT no início, com o verbo de syscall depois da vírgula).
    {
        pattern: /ENOENT:\s*no such file or directory,\s*(?:open|scandir|lstat|stat|access|unlink|mkdir|rmdir|readdir|rename|copyfile|realpath)/i,
        kind: 'tool_error',
        description: (_, tool) => `Arquivo ou diretório não encontrado ao executar '${tool}'`,
        suggestedActions: [
            'Verificar se o caminho existe com list_workspace',
            'Corrigir o caminho no próximo passo',
        ],
        isRetryable: false,
    },
    // Ferramenta não encontrada (inclui exit code 127 = command not found no Unix e o
    // texto literal do cmd.exe no Windows quando um executável não existe no PATH)
    {
        pattern: /command not found|not found|no such file|ENOENT|which: no|cannot find|\[exit code: 127\]|is not recognized as an internal or external command/i,
        kind: 'missing_tool',
        description: (_, tool) => `Ferramenta '${tool}' não encontrada no sistema`,
        suggestedActions: [
            'Instalar a ferramenta via gerenciador de pacotes',
            'Buscar ferramenta alternativa com a mesma função',
            'Usar abordagem que não dependa desta ferramenta',
        ],
        isRetryable: false,
    },
    // Permissão negada
    {
        pattern: /permission denied|EACCES|access denied|unauthorized|forbidden|403/i,
        kind: 'missing_permission',
        description: (_, tool) => `Permissão negada ao executar '${tool}'`,
        suggestedActions: [
            'Solicitar autorização explícita do usuário',
            'Verificar permissões de arquivo ou diretório',
            'Usar alternativa com permissões adequadas',
        ],
        isRetryable: false,
    },
    // Sem conexão / rede
    {
        pattern: combineRegExp([/ECONNREFUSED/i, ECONNRESET_PATTERN, ETIMEDOUT_PATTERN, NETWORK_PATTERN, /no route/i, /getaddrinfo/i, /fetch failed/i]),
        kind: 'environment_limit',
        description: () => 'Falha de conectividade de rede',
        suggestedActions: [
            'Verificar conexão de internet',
            'Tentar novamente após alguns segundos',
            'Usar fonte local como alternativa',
        ],
        isRetryable: true,
    },
    // Rate limit / quota
    {
        pattern: combineRegExp([RATE_LIMIT_PATTERN, /too many requests/i, HTTP_429_PATTERN, /quota exceeded/i]),
        kind: 'environment_limit',
        description: () => 'Limite de requisições atingido',
        suggestedActions: [
            'Aguardar e tentar novamente',
            'Usar provider ou API alternativa',
        ],
        isRetryable: true,
    },
    // Arquivo protegido / criptografado
    {
        pattern: /encrypted|protected|password.?protected|cannot decrypt/i,
        kind: 'context_insufficient',
        description: () => 'Arquivo protegido por senha ou criptografado',
        suggestedActions: [
            'Usar ferramenta de OCR como fallback',
            'Solicitar senha ao usuário',
            'Tentar extração parcial de texto visível',
        ],
        isRetryable: false,
    },
    // python3-venv não instalado (ensurepip ausente) — venv não pode ser criado
    {
        pattern: /ensurepip is not available|python3-venv|ensurepip/i,
        kind: 'environment_limit',
        description: () => 'python3-venv não instalado — criação de venv bloqueada (ensurepip ausente)',
        suggestedActions: [
            'NÃO tente python3 -m venv — ensurepip não está disponível neste sistema',
            'Usar pandoc para conversão direta: pandoc arquivo.md -o arquivo.pptx',
            'Usar Node.js/Marp para PPTX: npx @marp-team/marp-cli arquivo.md --pptx',
            'Instalar python3-venv: sudo apt install python3-venv (requer sudo)',
        ],
        isRetryable: false,
    },
    // Python PEP 668 — pip bloqueado pelo sistema operacional
    {
        pattern: /externally-managed-environment|PEP 668|This environment is externally managed/i,
        kind: 'environment_limit',
        description: () => 'Python protegido pelo sistema (PEP 668) — pip install bloqueado',
        suggestedActions: [
            'Criar ambiente virtual e instalar: python3 -m venv venv && venv/bin/pip install <pacote> && venv/bin/python script.py',
            'Usar pandoc para conversão direta (sem Python): pandoc arquivo.md -o arquivo.pptx',
            'Usar pipx para ferramentas globais: pipx install <ferramenta>',
        ],
        isRetryable: false,
    },
    // Disco cheio
    {
        pattern: /ENOSPC|no space left|disk full/i,
        kind: 'environment_limit',
        description: () => 'Espaço em disco insuficiente',
        suggestedActions: [
            'Limpar arquivos temporários',
            'Usar diretório alternativo com mais espaço',
        ],
        isRetryable: false,
    },
    // Timeout
    {
        pattern: combineRegExp([TIMEOUT_PATTERN, /timed out/i, /exceeded.*time/i]),
        kind: 'tool_error',
        description: (_, tool) => `Timeout na execução de '${tool}'`,
        suggestedActions: [
            'Tentar com um subconjunto menor dos dados',
            'Aumentar timeout se configurável',
            'Dividir a tarefa em partes menores',
        ],
        isRetryable: true,
    },
    // Conteúdo placeholder gravado no write — blocker content_stub
    // Captura o prefixo emitido pelo CONTENT-STUB-GATE do WriteTool.
    // Orienta o GoalPlanner a usar AgentLoop (sem toolName) no lugar de write+content fixo.
    {
        pattern: /\[CONTENT-STUB\]/,
        kind: 'content_stub',
        description: (_, tool) => `Step '${tool}' gerou conteúdo placeholder — usar AgentLoop para síntese real`,
        suggestedActions: [
            'OMITA toolName no step de síntese — o AgentLoop gerará o conteúdo REAL com os dados dos steps anteriores',
            'Estrutura correta: {"description": "Gere o HTML completo de slides..."} (sem toolName, sem toolArgs)',
            'Não pré-gere content no plano JSON quando ele depende de pesquisa ou síntese',
        ],
        isRetryable: false,
    },
];

// ── GoalEvaluator ─────────────────────────────────────────────────────────────

export class GoalEvaluator {

    evaluate(goal: Goal, planStep: PlanStep, toolResult: ToolResult): CycleResult {
        if (toolResult.success) {
            log.debug(`[GoalEvaluator] step=${planStep.id} success`);
            return { outcome: 'success', confidence: 1.0, output: toolResult.output };
        }

        const toolName = planStep.toolName ?? 'unknown';
        const error = toolResult.error ?? toolResult.output ?? '';

        // Item 9: Immediate replan on dedup — se este step+tool+args já falhou antes,
        // bloquear imediatamente sem retry para evitar loop de tentativas idênticas.
        if (this.hasIdenticalFailedAttempt(goal, planStep, toolName)) {
            log.warn(`[GoalEvaluator] dedup step=${planStep.id} tool=${toolName} — replan imediato`);
            return {
                outcome: 'blocked',
                confidence: 0.2,
                blocker: {
                    kind: 'repeated_tool_call',
                    toolName,
                    description: `'${toolName}' já falhou neste step — mesma chamada não vai produzir resultado diferente`,
                    suggestedActions: [
                        'Usar tool diferente para atingir o mesmo objetivo',
                        'Reformular os argumentos da tool',
                        'Dividir o step em passos menores',
                    ],
                    detectedAt: Date.now(),
                },
            };
        }

        // Classificar o tipo de falha
        const blocker = this.classifyError(error, toolName);

        log.info(`[GoalEvaluator] step=${planStep.id} tool=${toolName} blocker=${blocker.kind}`);

        // Auth requerida → pausa para confirmação
        if (blocker.kind === 'missing_permission') {
            return { outcome: 'needs_auth', confidence: 0.85, blocker };
        }

        // Dependência ausente → perguntar ao usuário / tentar instalar
        if (blocker.kind === 'missing_tool') {
            const missingCmd = extractMissingExecutable(error) ?? '';
            log.debug(`[GoalEvaluator] missing_tool extracted="${missingCmd || '(not extracted)'}" from error="${error.slice(0, 80)}"`);
            const dep = KNOWN_DEPS[missingCmd.toLowerCase()];
            if (dep) {
                const installKey = `install_dep_${dep.name}`;
                if (goal.strategiesTried.some(s => s.includes(installKey))) {
                    // Já tentamos instalar e a falha persiste → instrução manual
                    const msg = `'${dep.name}' não pôde ser instalado automaticamente.\n${dep.manualInstructions}`;
                    log.warn(`[GoalEvaluator] dep=${dep.name} install already tried — escalating to failed`);
                    return {
                        outcome: 'failed',
                        confidence: 0.1,
                        output: msg,
                        blocker: { ...blocker, description: msg, suggestedActions: [dep.manualInstructions] },
                        depInfo: dep,
                    };
                }
                log.info(`[GoalEvaluator] dep='${dep.name}' missing and installable — outcome=needs_dependency`);
                return { outcome: 'needs_dependency', confidence: 0.8, blocker, depInfo: dep };
            }
        }

        // Erro retryável E ainda tem retry budget → partial (tenta de novo)
        const matchedPattern = this.findMatchedPattern(error);
        if (matchedPattern?.isRetryable && goal.retryBudget > 0) {
            return { outcome: 'partial', confidence: 0.5, blocker };
        }

        // Sem retry budget ou erro irrecuperável → bloqueado, precisa replan
        if (goal.replanBudget > 0) {
            return { outcome: 'blocked', confidence: 0.35, blocker };
        }

        // Sem budget de nenhum tipo → falha definitiva
        return { outcome: 'failed', confidence: 0.1, blocker };
    }

    /**
     * ARCH-010: responde "esta chamada exata (step, tool, args) já falhou antes neste goal?"
     * por consulta nomeada, em vez de lógica de dedup recomputada inline em `evaluate()`.
     * Chave de args via `computeToolInputKey` (mesma função usada pelo dedup de
     * `AgentLoop.usedToolInputs`) em vez de `JSON.stringify` bruto — evita que duas variações
     * cosméticas do mesmo `send_document` (legenda diferente, mesmo `file_path`) escapem do
     * dedup por terem JSON diferente, o mesmo padrão de bug que `computeToolInputKey` já
     * corrigiu na camada de `AgentLoop` (ver S90).
     */
    private hasIdenticalFailedAttempt(goal: Goal, planStep: PlanStep, toolName: string): boolean {
        const currentKey = computeToolInputKey(toolName, planStep.toolArgs ?? {});
        return goal.attempts.some(a =>
            a.planStepId === planStep.id &&
            a.toolName === toolName &&
            a.result === 'failure' &&
            computeToolInputKey(a.toolName, a.args ?? {}) === currentKey
        );
    }

    /** Avalia se o goal ainda tem progresso real entre ciclos */
    evaluateProgress(goal: Goal): 'progressing' | 'stalled' | 'regressing' {
        const attempts = goal.attempts;
        if (attempts.length < 2) return 'progressing';

        const recent = attempts.slice(-3);
        const hasPositive = recent.some(a => a.result === 'success' || a.result === 'partial');

        // Verifica tendência: todos os recentes falharam?
        const allFailed = recent.every(a => a.result === 'failure');

        if (allFailed && recent.length >= 2) return 'stalled';
        if (!hasPositive && attempts.length > 5) return 'regressing';
        return 'progressing';
    }

    private classifyError(error: string, toolName: string): GoalBlocker {
        const matched = this.findMatchedPattern(error);

        if (matched) {
            // exec_command: distingue entre "exec_command ausente" (exit 127 = shell não achou o
            // binário) e "PATH do argumento não existe" (exit 2 = o arquivo/dir não foi encontrado).
            // Sem esta distinção, o GoalPlanner acredita que a ferramenta exec_command em si está
            // faltando e gera replans que evitam exec_command — mas o problema real é o binário interno.
            if (matched.kind === 'missing_tool' && toolName === 'exec_command') {
                // extractMissingExecutable() é a mesma função usada no lookup de KNOWN_DEPS logo
                // abaixo (em evaluate()) — antes desta unificação, este branch usava uma regex
                // local própria que não reconhecia "is not recognized as an internal or external
                // command" (texto do cmd.exe no Windows para um binário ausente do PATH),
                // reclassificando incorretamente esse caso como "caminho não encontrado" em vez
                // de "binário ausente".
                const missingBinary = extractMissingExecutable(error);
                if (!missingBinary) {
                    return {
                        kind: 'tool_error',
                        toolName,
                        description: `Caminho não encontrado ao executar '${toolName}': ${error.slice(0, 200)}`,
                        suggestedActions: [
                            'Verificar se o caminho existe com list_workspace',
                            'Listar o workspace: list_workspace',
                            'Corrigir o caminho no próximo passo',
                        ],
                        detectedAt: Date.now(),
                    };
                }
                // exec_command encontrou a shell, mas o BINÁRIO invocado não existe.
                const binaryLabel = `'${missingBinary}'`;
                return {
                    kind: 'missing_tool',
                    toolName,
                    description: `Binário ${binaryLabel} não encontrado no sistema (chamado via exec_command). Instale-o ou use uma abordagem alternativa que não dependa dele.`,
                    suggestedActions: [
                        missingBinary ? `Instalar ${missingBinary} via gerenciador de pacotes` : 'Instalar a dependência ausente',
                        'Verificar capabilities disponíveis com EnvironmentProbe',
                        'Usar ferramenta nativa do NewClaw em vez de binário externo',
                    ],
                    detectedAt: Date.now(),
                };
            }

            const match = error.match(matched.pattern)!;
            const description = matched.description(match, toolName);
            log.debug(`[GoalEvaluator] classify: tool=${toolName} kind=${matched.kind} pattern=/${matched.pattern.source.slice(0, 60)}/ retryable=${matched.isRetryable}`);
            return {
                kind: matched.kind,
                toolName,
                description,
                suggestedActions: matched.suggestedActions,
                detectedAt: Date.now(),
            };
        }

        // Fallback genérico — sem padrão reconhecido
        log.debug(`[GoalEvaluator] classify: tool=${toolName} kind=tool_error (no pattern matched) error="${error.slice(0, 100)}"`);
        return {
            kind: 'tool_error',
            toolName,
            description: `Erro em '${toolName}': ${error.slice(0, 200)}`,
            suggestedActions: [
                'Tentar com argumentos diferentes',
                'Buscar ferramenta alternativa',
                'Verificar logs para mais detalhes',
            ],
            detectedAt: Date.now(),
        };
    }

    private findMatchedPattern(error: string): ErrorPattern | null {
        for (const pattern of ERROR_PATTERNS) {
            if (pattern.pattern.test(error)) return pattern;
        }
        return null;
    }

    /**
     * Gera texto de explicação para o usuário quando goal falha.
     *
     * Usa goal.toolsTried (nomes de ferramenta limpos), NÃO goal.strategiesTried:
     * strategiesTried guarda descrições de step já enriquecidas com hints internos
     * de replanning (ex: "[ATENÇÃO — tentativa anterior com X retornou output
     * irrelevante: ... Use abordagem diferente...]", ver GoalExecutionLoop.ts
     * mismatchHint) — texto escrito para o PRÓPRIO LLM replanejador consumir no
     * próximo ciclo, não para o usuário final. Juntar essas entradas aqui vazava
     * jargão interno (nomes de step truncados, marcadores [ATENÇÃO —) direto na
     * resposta do Telegram.
     */
    buildFailureExplanation(goal: Goal): string {
        const strategies = goal.toolsTried.length > 0
            ? `Tentei: ${goal.toolsTried.join(', ')}.`
            : '';
        const lastBlocker = goal.blockers[goal.blockers.length - 1];
        const blockerMsg = lastBlocker
            ? `Último bloqueio: ${lastBlocker.description}.`
            : '';

        // goal.sentArtifacts registra arquivos REALMENTE entregues ao usuário durante a
        // execução deste goal (trackArtifact, disparado só após send_document/DELIVERY-GUARD
        // confirmarem o envio) — um goal pode entregar arquivos válidos e só DEPOIS esbarrar
        // num step adicional (ex: uma tentativa de sobrescrita bloqueada, ou um replan que
        // expira o reasoning budget) que o derruba para failed. Sem checar isso aqui, o usuário
        // recebe "Não consegui completar" como se nada tivesse sido feito, mesmo tendo acabado
        // de receber os arquivos corretos segundos antes. Reproduzido ao vivo (09/07 19:32):
        // goal entregou 2 .pptx válidos (19:28, 19:29) e ainda assim reportou falha total no
        // rodapé, sem mencionar os arquivos já enviados.
        const sentArtifacts = goal.sentArtifacts ?? [];
        const deliveredMsg = sentArtifacts.length > 0
            ? `Consegui gerar e enviar: ${sentArtifacts.join(', ')}. Porém não finalizei o restante do pedido.`
            : '';

        return [
            deliveredMsg || `Não consegui completar: "${goal.userIntent.slice(0, 150)}"`,
            strategies,
            blockerMsg,
            'Você pode reformular o pedido ou fornecer mais informações para eu tentar de outra forma.',
        ].filter(Boolean).join(' ');
    }
}
