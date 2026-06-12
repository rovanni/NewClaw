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
    marp:        { name: '@marp-team/marp-cli',    installCmd: 'npm install -g @marp-team/marp-cli',          manualInstructions: 'Instale o marp-cli globalmente: npm install -g @marp-team/marp-cli', type: 'node' },
    pip:         { name: 'python3-pip',            installCmd: 'sudo apt install python3-pip -y',             manualInstructions: 'Instale com: sudo apt install python3-pip -y',                 type: 'python' },
    pip3:        { name: 'python3-pip',            installCmd: 'sudo apt install python3-pip -y',             manualInstructions: 'Instale com: sudo apt install python3-pip -y',                 type: 'python' },
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
    // Ferramenta não encontrada (inclui exit code 127 = command not found no Unix)
    {
        pattern: /command not found|not found|no such file|ENOENT|which: no|cannot find|\[exit code: 127\]/i,
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
        pattern: /ECONNREFUSED|ECONNRESET|ETIMEDOUT|network|no route|getaddrinfo|fetch failed/i,
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
        pattern: /rate.?limit|too many requests|429|quota exceeded/i,
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
            'Criar ambiente virtual e instalar: python3 -m venv /tmp/venv && /tmp/venv/bin/pip install <pacote> && /tmp/venv/bin/python script.py',
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
        pattern: /timeout|timed out|exceeded.*time/i,
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
        // Compara (planStepId, toolName, args) para não bloquear replanos com
        // comandos diferentes ao mesmo step_id (ex: exec_command com caminhos distintos).
        const currentArgsStr = JSON.stringify(planStep.toolArgs ?? {});
        const alreadyFailed = goal.attempts.some(a =>
            a.planStepId === planStep.id &&
            a.toolName === toolName &&
            a.result === 'failure' &&
            JSON.stringify(a.args ?? {}) === currentArgsStr
        );
        if (alreadyFailed) {
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
            const missingCmd = this.extractMissingToolName(error) ?? '';
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
                const isCommandMissing = /command not found|which:\s*no|cannot find|\[exit code: 127\]/i.test(error);
                if (!isCommandMissing) {
                    return {
                        kind: 'tool_error',
                        toolName,
                        description: `Caminho não encontrado ao executar '${toolName}': ${error.slice(0, 200)}`,
                        suggestedActions: [
                            'Verificar se o caminho existe com list_workspace',
                            'Listar o diretório pai: exec_command ls /home/venus/newclaw/workspace',
                            'Corrigir o caminho no próximo passo',
                        ],
                        detectedAt: Date.now(),
                    };
                }
                // exec_command encontrou a shell, mas o BINÁRIO invocado não existe.
                // Extrair o nome real do binário para dar descrição acionável ao GoalPlanner,
                // em vez de "exec_command não encontrada" (que é um falso-positivo confuso).
                const missingBinary = this.extractMissingToolName(error);
                const binaryLabel = missingBinary ? `'${missingBinary}'` : 'o binário solicitado';
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
     * Extrai o nome do executável que não foi encontrado da mensagem de erro.
     * Exemplos:
     *   "bash: pandoc: command not found"  → "pandoc"
     *   "which: no ffmpeg in (...)"        → "ffmpeg"
     *   "pandoc: command not found"        → "pandoc"
     */
    private extractMissingToolName(error: string): string | undefined {
        // "bash: pandoc: command not found" / "sh: 1: pandoc: not found"
        const shellPrefix = error.match(/(?:bash|sh|zsh|dash|fish|cmd):\s*(?:\d+:\s*)?(\w[\w.-]*?):\s*(?:command\s+)?not found/i);
        if (shellPrefix) return shellPrefix[1];

        // "pandoc: command not found" (sem prefixo de shell)
        const plainNotFound = error.match(/^(\w[\w.-]*?):\s*command not found/im);
        if (plainNotFound) return plainNotFound[1];

        // "which: no pandoc in ..."
        const whichNo = error.match(/which:\s*no\s+(\w[\w.-]*?)\s+in/i);
        if (whichNo) return whichNo[1];

        // "cannot find 'pandoc'" ou "cannot find pandoc"
        const cannotFind = error.match(/cannot find ['"]?(\w[\w.-]*?)['"]?(?:\s|$)/i);
        if (cannotFind) return cannotFind[1];

        // ENOENT no caminho: /usr/bin/pandoc
        const enoent = error.match(/ENOENT[^']*'([^/']+)'/i);
        if (enoent) return enoent[1];

        return undefined;
    }

    /** Gera texto de explicação para o usuário quando goal falha */
    buildFailureExplanation(goal: Goal): string {
        const strategies = goal.strategiesTried.length > 0
            ? `Tentei: ${goal.strategiesTried.join(', ')}.`
            : '';
        const lastBlocker = goal.blockers[goal.blockers.length - 1];
        const blockerMsg = lastBlocker
            ? `Último bloqueio: ${lastBlocker.description}.`
            : '';

        return [
            `Não consegui completar: "${goal.userIntent.slice(0, 150)}"`,
            strategies,
            blockerMsg,
            'Você pode reformular o pedido ou fornecer mais informações para eu tentar de outra forma.',
        ].filter(Boolean).join(' ');
    }
}
