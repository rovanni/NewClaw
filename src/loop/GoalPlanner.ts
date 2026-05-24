/**
 * GoalPlanner — Decomposição de goals em planos executáveis.
 *
 * Dois modos:
 *   plan()   — plano inicial a partir do objetivo do usuário
 *   replan() — novo plano após blocker, consultando memória de reflexão
 *
 * A memória de reflexão (ReflectionMemory) informa o LLM sobre padrões de
 * falha passados, para que replans evitem repetir erros conhecidos.
 *
 * Output: PlanStep[] — lista de steps com toolName, toolArgs e fallbackSteps.
 */

import { createLogger } from '../shared/AppLogger';
import { ProviderFactory, LLMMessage } from '../core/ProviderFactory';
import { ReflectionMemory } from '../memory/ReflectionMemory';
import { ToolRegistry } from '../core/ToolRegistry';
import { Goal, GoalBlocker, PlanStep } from './GoalTypes';

const log = createLogger('GoalPlanner');

// ── Prompt templates ─────────────────────────────────────────────────────────

function buildPlanPrompt(goal: Goal, skillContext?: string, runtimeContext?: string): string {
    const skillBlock = skillContext
        ? `\nINSTRUÇÕES DE SKILL ATIVAS (siga rigorosamente):\n${skillContext}\n`
        : '';
    const contextBlock = runtimeContext
        ? `\nCONTEXTO (memória + feedback de ciclos anteriores):\n${runtimeContext}\n`
        : '';

    return `Você é um planejador de tarefas. Decomponha o objetivo abaixo em steps executáveis com ferramentas.

OBJETIVO: ${goal.objective}
INTENÇÃO ORIGINAL: ${goal.userIntent}
${skillBlock}${contextBlock}
Ferramentas disponíveis: exec_command, read, write, edit, web_search, web_navigate, memory_search, read_document, list_workspace, send_document, send_audio

Responda APENAS com JSON válido (sem markdown):
{
  "steps": [
    {
      "id": "step_1",
      "description": "descrição curta do que este step faz",
      "toolName": "nome_da_ferramenta",
      "toolArgs": { "argumento": "valor" },
      "fallbackSteps": []
    }
  ],
  "strategy": "descrição de 1 linha da estratégia geral"
}

Regras:
- Máximo 4 steps por plano
- Cada step usa UMA ferramenta
- toolArgs deve ser um objeto com os argumentos da ferramenta
- Se não precisar de ferramenta específica, omita toolName e toolArgs`.trim();
}

function buildReplanPrompt(goal: Goal, blocker: GoalBlocker, reflectionHint: string, runtimeContext?: string): string {
    const strategiesBlock = goal.strategiesTried.length > 0
        ? `\nEstratégias já tentadas: ${goal.strategiesTried.join('; ')}\n`
        : '';

    const blockersBlock = goal.blockers.length > 0
        ? `\nBlockers anteriores: ${goal.blockers.map(b => `${b.kind}: ${b.description}`).join('; ')}\n`
        : '';

    const reflectionBlock = reflectionHint
        ? `\nHistórico de erros similares:\n${reflectionHint}\n`
        : '';

    const contextBlock = runtimeContext
        ? `\nCONTEXTO (memória + feedback):\n${runtimeContext}\n`
        : '';

    return `Você é um planejador de tarefas. Um blocker foi detectado. Proponha uma NOVA estratégia.

OBJETIVO: ${goal.objective}
BLOCKER ATUAL: ${blocker.description} (tipo: ${blocker.kind})
AÇÕES SUGERIDAS PELO SISTEMA: ${blocker.suggestedActions.join('; ')}
${strategiesBlock}${blockersBlock}${reflectionBlock}${contextBlock}
IMPORTANTE: Não repita estratégias já tentadas. Proponha abordagem genuinamente diferente.

Responda APENAS com JSON válido (sem markdown):
{
  "steps": [
    {
      "id": "step_1",
      "description": "descrição curta",
      "toolName": "nome_da_ferramenta",
      "toolArgs": { "argumento": "valor" }
    }
  ],
  "strategy": "descrição de 1 linha da nova estratégia"
}

Máximo 3 steps. Se o blocker for 'missing_tool', inclua step de instalação como primeiro step.`.trim();
}

// ── GoalPlanner ───────────────────────────────────────────────────────────────

export class GoalPlanner {
    private skillContext: string | undefined;

    constructor(
        private readonly providerFactory: ProviderFactory,
        private readonly reflectionMemory: ReflectionMemory,
    ) {}

    /** Injeta skill context que será incluído no prompt de planejamento. */
    setSkillContext(context: string): void {
        this.skillContext = context || undefined;
    }

    async plan(goal: Goal, runtimeContext?: string): Promise<PlanStep[]> {
        log.info(`[GoalPlanner] planning goal=${goal.id}`);

        const messages: LLMMessage[] = [{ role: 'user', content: buildPlanPrompt(goal, this.skillContext, runtimeContext) }];

        try {
            const result = await this.providerFactory.chatWithFallback(
                messages,
                undefined,
                undefined,
                45_000
            );

            if (result.status !== 'success') {
                log.warn(`[GoalPlanner] LLM plan failed status=${result.status}`);
                return this.fallbackPlan(goal);
            }

            const parsed = this.parsePlanResponse(result.content);
            if (parsed.steps.length === 0) {
                return this.fallbackPlan(goal);
            }

            log.info(`[GoalPlanner] plan=${parsed.steps.length} steps strategy="${parsed.strategy}"`);
            return parsed.steps;
        } catch (err) {
            log.warn('[GoalPlanner] plan error:', String(err));
            return this.fallbackPlan(goal);
        }
    }

    async replan(goal: Goal, blocker: GoalBlocker, runtimeContext?: string): Promise<PlanStep[]> {
        log.info(`[GoalPlanner] replan goal=${goal.id} blocker=${blocker.kind}`);

        // Consulta memória de reflexão para evitar erros já conhecidos
        const reflectionHint = this.reflectionMemory.buildContextHint(
            blocker.toolName ? `tool_${blocker.toolName}` : blocker.kind
        );

        const messages: LLMMessage[] = [{
            role: 'user',
            content: buildReplanPrompt(goal, blocker, reflectionHint, runtimeContext)
        }];

        try {
            const result = await this.providerFactory.chatWithFallback(
                messages,
                undefined,
                undefined,
                45_000
            );

            if (result.status !== 'success') {
                log.warn(`[GoalPlanner] LLM replan failed status=${result.status}`);
                return this.emergencyFallback(goal, blocker);
            }

            const parsed = this.parsePlanResponse(result.content);
            if (parsed.steps.length === 0) {
                return this.emergencyFallback(goal, blocker);
            }

            log.info(`[GoalPlanner] replan=${parsed.steps.length} steps strategy="${parsed.strategy}"`);
            return parsed.steps;
        } catch (err) {
            log.warn('[GoalPlanner] replan error:', String(err));
            return this.emergencyFallback(goal, blocker);
        }
    }

    // ── Parsing ───────────────────────────────────────────────────────────────

    private parsePlanResponse(content: string): { steps: PlanStep[]; strategy: string } {
        try {
            const cleaned = content
                .replace(/```json\n?/g, '')
                .replace(/```\n?/g, '')
                .trim();

            const parsed = JSON.parse(cleaned);
            const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : [];

            const steps: PlanStep[] = rawSteps.slice(0, 4).map((s: Record<string, unknown>, i: number) => {
                const rawToolName = s.toolName ? String(s.toolName) : undefined;

                // Valida se a tool realmente existe no ToolRegistry.
                // Se não existe, o step vai para o AgentLoop diretamente (sem toolName),
                // evitando que o GoalEvaluator classifique como missing_tool e esgote o budget.
                const resolvedTool = rawToolName && ToolRegistry.get(rawToolName)
                    ? rawToolName
                    : undefined;

                if (rawToolName && !resolvedTool) {
                    log.warn(`[GoalPlanner] tool '${rawToolName}' não existe no ToolRegistry — step será tratado sem tool`);
                }

                return {
                    id: String(s.id ?? `step_${i + 1}`),
                    description: String(s.description ?? 'Execute step'),
                    toolName: resolvedTool,
                    toolArgs: resolvedTool && s.toolArgs && typeof s.toolArgs === 'object'
                        ? s.toolArgs as Record<string, unknown>
                        : undefined,
                    fallbackSteps: [],
                    status: 'pending' as const,
                };
            });

            return { steps, strategy: String(parsed.strategy ?? '') };
        } catch {
            return { steps: [], strategy: '' };
        }
    }

    // ── Fallbacks sem LLM ─────────────────────────────────────────────────────

    private fallbackPlan(goal: Goal): PlanStep[] {
        // Plano minimalista: passa o objetivo direto para o AgentLoop sem decomposição
        return [{
            id: 'step_direct',
            description: `Executar diretamente: ${goal.objective.slice(0, 100)}`,
            status: 'pending',
            fallbackSteps: [],
        }];
    }

    private emergencyFallback(goal: Goal, blocker: GoalBlocker): PlanStep[] {
        // Se o blocker é missing_tool, tenta uma instalação genérica
        if (blocker.kind === 'missing_tool' && blocker.toolName) {
            return [
                {
                    id: 'step_install',
                    description: `Instalar ${blocker.toolName}`,
                    toolName: 'exec_command',
                    toolArgs: { command: `which ${blocker.toolName} || echo "NOT FOUND"` },
                    status: 'pending',
                    fallbackSteps: [],
                },
                {
                    id: 'step_retry',
                    description: `Tentar novamente após verificação`,
                    status: 'pending',
                    fallbackSteps: [],
                },
            ];
        }

        // Fallback genérico: tenta o objetivo com instrução diferente
        return [{
            id: 'step_fallback',
            description: `Abordagem alternativa para: ${goal.objective.slice(0, 100)}`,
            status: 'pending',
            fallbackSteps: [],
        }];
    }
}
