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
import { Goal, PlanStep, CycleResult, GoalBlocker, BlockerKind } from './GoalTypes';

const log = createLogger('GoalEvaluator');

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
            'NÃO use pip install direto nem --break-system-packages — PEP 668 bloqueia em Debian/Ubuntu',
            'NÃO tente python3 -m venv sem verificar se ensurepip está disponível',
            'Usar pandoc para conversão direta: pandoc arquivo.md -o arquivo.pptx',
            'Usar Node.js/Marp para PPTX: npx @marp-team/marp-cli arquivo.md --pptx',
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

        // Classificar o tipo de falha
        const blocker = this.classifyError(error, toolName);

        log.info(`[GoalEvaluator] step=${planStep.id} tool=${toolName} blocker=${blocker.kind}`);

        // Auth requerida → pausa para confirmação
        if (blocker.kind === 'missing_permission') {
            return { outcome: 'needs_auth', confidence: 0.85, blocker };
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
            const match = error.match(matched.pattern)!;
            return {
                kind: matched.kind,
                toolName,
                description: matched.description(match, toolName),
                suggestedActions: matched.suggestedActions,
                detectedAt: Date.now(),
            };
        }

        // Fallback genérico
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
