/**
 * sanitizePlanSteps — normaliza um PlanStep[] bruto vindo de um LLM (parse inicial do
 * GoalPlanner OU ajuste de risco do RiskAnalyzer) em steps executáveis com segurança.
 *
 * Extraído de GoalPlanner.parsePlanResponse() (Etapa 1 da consolidação — extract & redirect,
 * não move & clean): a lógica abaixo é a MESMA que já existia em GoalPlanner.ts, sem alteração
 * de comportamento, apenas parametrizada para poder ser redirecionada por outros chamadores
 * (GoalPlanner na Etapa 2, RiskAnalyzer na Etapa 3).
 *
 * A única substituição mecânica é `TOOL_ALIASES[rawToolName] ?? rawToolName` (inline) por
 * `resolveToolAlias(rawToolName)` (mesmo cálculo, extraído para toolAliasResolver.ts).
 *
 * O campo `mutations` no retorno é uma adição não-invasiva: acumula, para cada step
 * convertido para AgentLoop, o motivo e a tool original — nenhum comportamento existente lê
 * ou depende disso hoje. Existe para a Etapa 3 (RiskAnalyzer precisa saber quais steps
 * perderam args obrigatórios para decidir se rejeita o plano inteiro) sem precisar duplicar
 * a lógica de detecção outra vez.
 *
 * `detectMissingRequiredArgs` e `WRITE_CONTENT_STUB_PATTERNS` são recebidos por parâmetro em
 * vez de importados de GoalPlanner.ts: GoalPlanner.ts importa `sanitizePlanSteps` (Etapa 2),
 * então um import direto no sentido contrário criaria um ciclo — CommonJS resolveria com os
 * exports de GoalPlanner.ts ainda incompletos nesse ponto (as duas constantes são declaradas
 * depois do ponto do arquivo onde o ciclo seria disparado), quebrando em runtime.
 */

import { createLogger } from '../../shared/AppLogger';
import { PlanStep } from '../GoalTypes';
import { PLACEHOLDER_ARG_PATTERN } from '../../shared/placeholderPatterns';
import { resolveToolAlias } from './toolAliasResolver';

const log = createLogger('SanitizePlanSteps');

export type StepMutationReason = 'tool_not_found' | 'placeholder' | 'content_stub' | 'missing_args';

export interface StepMutation {
    stepId: string;
    /** Nome canônico da tool que o step tinha ANTES de ser convertido para AgentLoop. */
    originalTool: string;
    reason: StepMutationReason;
    detail: string;
    description: string;
}

export interface SanitizePlanStepsResult {
    steps: PlanStep[];
    /** Todo step que foi convertido para AgentLoop (toolName undefined), com o motivo. */
    mutations: StepMutation[];
}

/**
 * @param rawSteps     Steps brutos (já parseados do JSON do LLM, ainda não validados).
 * @param toolRegistry Precisa apenas de `.get(name)` — aceita o singleton ToolRegistry ou
 *                      qualquer instância/mock com o mesmo formato.
 * @param logPrefix    Prefixo de log, ex: "[GoalPlanner]" ou "[RiskAnalyzer]".
 * @param detectMissingRequiredArgs Validador de args obrigatórios por tool (de GoalPlanner.ts).
 * @param writeContentStubPatterns  Lista de regex de content-stub (de GoalPlanner.ts).
 */
export function sanitizePlanSteps(
    rawSteps: Array<Record<string, unknown>>,
    toolRegistry: { get(name: string): unknown },
    logPrefix: string,
    detectMissingRequiredArgs: (tool: string, args: Record<string, unknown>) => string | null,
    writeContentStubPatterns: RegExp[],
): SanitizePlanStepsResult {
    const mutations: StepMutation[] = [];

    const steps: PlanStep[] = rawSteps.map((s: Record<string, unknown>, i: number) => {
        const rawToolName = s.toolName ? String(s.toolName) : undefined;

        // Resolve alias antes de validar (ex: provide_file → send_document)
        const canonicalName = rawToolName
            ? resolveToolAlias(rawToolName)
            : undefined;

        // Valida se a tool existe no ToolRegistry.
        let resolvedTool = canonicalName && toolRegistry.get(canonicalName)
            ? canonicalName
            : undefined;

        if (rawToolName && !resolvedTool) {
            log.warn(`${logPrefix} tool '${rawToolName}' não existe no ToolRegistry — step será tratado sem tool`);
            mutations.push({
                stepId: String(s.id ?? `step_${i + 1}`),
                originalTool: rawToolName,
                reason: 'tool_not_found',
                detail: `'${rawToolName}' não existe no ToolRegistry`,
                description: String(s.description ?? 'Execute step'),
            });
        } else if (canonicalName && canonicalName !== rawToolName) {
            log.info(`${logPrefix} tool alias '${rawToolName}' → '${canonicalName}'`);
        }

        // Item 8: Detectar placeholder paths em toolArgs.
        // Se algum argumento é um placeholder (caminho_do_*, <path>, {file}),
        // remove toolName/toolArgs para forçar AgentLoop a resolver o caminho real.
        let toolArgs: Record<string, unknown> | undefined = resolvedTool && s.toolArgs && typeof s.toolArgs === 'object'
            ? s.toolArgs as Record<string, unknown>
            : undefined;

        if (resolvedTool && toolArgs) {
            const placeholderEntry = Object.entries(toolArgs).find(
                ([, v]) => typeof v === 'string' && PLACEHOLDER_ARG_PATTERN.test(v)
            );
            if (placeholderEntry) {
                log.warn(`${logPrefix} step ${i + 1} has placeholder arg ${placeholderEntry[0]}="${String(placeholderEntry[1]).slice(0, 80)}" — converting to AgentLoop step`);
                mutations.push({
                    stepId: String(s.id ?? `step_${i + 1}`),
                    originalTool: resolvedTool,
                    reason: 'placeholder',
                    detail: `${placeholderEntry[0]}="${String(placeholderEntry[1]).slice(0, 80)}"`,
                    description: String(s.description ?? 'Execute step'),
                });
                resolvedTool = undefined;
                toolArgs = undefined;
            }
        }

        // WRITE-CONTENT-STUB: detecta write steps com conteúdo placeholder e converte para AgentLoop.
        // Quando o model gera {"toolName":"write","content":"<82-char-stub>"}, a execução
        // "succeeds" mas grava lixo — o GoalExecutionLoop gasta todo o replanBudget em
        // exec_command/ssh_exec antes de perceber que o artefato é inválido.
        // A conversão para AgentLoop faz o LLM sintetizar o conteúdo REAL em runtime,
        // com acesso ao output dos steps anteriores (web_search, read, etc.).
        if (resolvedTool === 'write' && toolArgs?.content) {
            const contentStr = String(toolArgs.content);
            const stubMatch = writeContentStubPatterns.find(p => p.test(contentStr));
            if (stubMatch) {
                log.warn(
                    `${logPrefix} step ${i + 1}: write content stub detectado ` +
                    `(${contentStr.length} chars, pattern="${stubMatch.source.slice(0, 50)}") ` +
                    `— convertendo para AgentLoop step`
                );
                mutations.push({
                    stepId: String(s.id ?? `step_${i + 1}`),
                    originalTool: resolvedTool,
                    reason: 'content_stub',
                    detail: `${contentStr.length} chars, pattern="${stubMatch.source.slice(0, 50)}"`,
                    description: String(s.description ?? 'Execute step'),
                });
                resolvedTool = undefined;
                toolArgs = undefined;
            }
        }

        // Valida args obrigatórios de ferramentas que falham silenciosamente
        // quando chamadas sem os parâmetros corretos. Converte para AgentLoop
        // (sem toolName) para que o LLM resolva com contexto completo, em vez
        // de deixar a tool explodir com erro de parâmetro obrigatório.
        // Validate required args even when toolArgs is absent (e.g. send_document without file_path).
        // Previously the check was skipped when toolArgs was undefined, letting invalid steps
        // pass through to the RiskAnalyzer instead of being caught here.
        if (resolvedTool) {
            const missing = detectMissingRequiredArgs(resolvedTool, toolArgs ?? {});
            if (missing) {
                log.warn(`${logPrefix} step ${i + 1}: '${resolvedTool}' ${missing} — converting to AgentLoop step`);
                mutations.push({
                    stepId: String(s.id ?? `step_${i + 1}`),
                    originalTool: resolvedTool,
                    reason: 'missing_args',
                    detail: missing,
                    description: String(s.description ?? 'Execute step'),
                });
                resolvedTool = undefined;
                toolArgs = undefined;
            }
        }

        return {
            id: String(s.id ?? `step_${i + 1}`),
            description: String(s.description ?? 'Execute step'),
            toolName: resolvedTool,
            toolArgs,
            fallbackSteps: [],
            status: 'pending' as const,
        };
    });

    return { steps, mutations };
}
