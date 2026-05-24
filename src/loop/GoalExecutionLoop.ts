/**
 * GoalExecutionLoop — Ciclo iterativo de execução orientada a objetivos.
 *
 * Fluxo por ciclo:
 *   plan → execute → observe → evaluate → (replan | complete | fail)
 *
 * Estratégia de execução de steps:
 *   - Steps com toolName explícito: executa a tool diretamente via ToolRegistry
 *   - Steps sem toolName: chama AgentLoop com prompt focado no step
 *
 * Bounded autonomy:
 *   - maxCycles: máximo de ciclos totais
 *   - retryBudget: por step
 *   - replanBudget: por goal
 *   - TTL: enforced pelo GoalStore.expireStale()
 *   - Nenhum ciclo roda sem trigger explícito (user message ou auth callback)
 */

import { createLogger } from '../shared/AppLogger';
import { AgentLoop } from './AgentLoop';
import { GoalStore } from './GoalStore';
import { GoalPlanner } from './GoalPlanner';
import { GoalEvaluator } from './GoalEvaluator';
import { ToolRegistry } from '../core/ToolRegistry';
import { ReflectionMemory } from '../memory/ReflectionMemory';
import { Goal, PlanStep, GoalAttempt, GoalResult, GoalProgressUpdate, CycleResult } from './GoalTypes';
import { GOAL_LIMITS } from './GoalLimits';
import { ChannelContext } from './agentLoopTypes';

const log = createLogger('GoalExecutionLoop');

export type ProgressCallback = (update: GoalProgressUpdate) => Promise<void>;

export class GoalExecutionLoop {
    private readonly evaluator = new GoalEvaluator();

    constructor(
        private readonly agentLoop: AgentLoop,
        private readonly goalStore: GoalStore,
        private readonly planner: GoalPlanner,
        private readonly reflectionMemory: ReflectionMemory,
        private readonly toolRegistry: typeof ToolRegistry,
    ) {}

    /** Forwards skill context to the planner before planning begins. */
    setSkillContext(context: string): void {
        this.planner.setSkillContext(context);
    }

    // ── Ponto de entrada principal ────────────────────────────────────────────

    async executeGoal(
        goal: Goal,
        channelContext: ChannelContext,
        onProgress?: ProgressCallback
    ): Promise<GoalResult> {
        let currentGoal = goal;
        let totalCycles = 0;
        let totalReplans = 0;

        log.info(`[GoalLoop] start goal=${goal.id} replanBudget=${goal.replanBudget}`);

        // ── Planejamento inicial ───────────────────────────────────────────
        this.goalStore.update(goal.id, { status: 'replanning' });
        const initialPlan = await this.planner.plan(currentGoal);
        this.goalStore.update(goal.id, { currentPlan: initialPlan, status: 'executing' });
        currentGoal = this.goalStore.getById(goal.id)!;

        // ── Loop de ciclos ────────────────────────────────────────────────
        while (totalCycles < GOAL_LIMITS.MAX_CYCLES) {
            totalCycles++;

            await onProgress?.({
                goalId: currentGoal.id,
                cycle: totalCycles,
                event: 'cycle_start',
            });

            const pendingStep = currentGoal.currentPlan.find(s => s.status === 'pending');

            if (!pendingStep) {
                // Todos os steps completados com sucesso
                this.goalStore.setStatus(currentGoal.id, 'completed');
                log.info(`[GoalLoop] goal=${currentGoal.id} all steps completed`);
                return this.buildResult(currentGoal, true, totalCycles, totalReplans);
            }

            // ── Executar o step atual ──────────────────────────────────
            await onProgress?.({ goalId: currentGoal.id, cycle: totalCycles, event: 'tool_executing', message: pendingStep.description });

            const cycleResult = await this.executeStep(currentGoal, pendingStep, channelContext);

            currentGoal = this.goalStore.getById(currentGoal.id)!;

            // ── Avaliar resultado ──────────────────────────────────────
            switch (cycleResult.outcome) {

                case 'success': {
                    this.markStepDone(currentGoal, pendingStep, cycleResult.output ?? '');
                    currentGoal = this.goalStore.getById(currentGoal.id)!;
                    await onProgress?.({ goalId: currentGoal.id, cycle: totalCycles, event: 'tool_completed' });
                    break;
                }

                case 'partial': {
                    // Retryável — diminui retry budget mas não troca de step
                    this.goalStore.update(currentGoal.id, {
                        retryBudget: Math.max(0, currentGoal.retryBudget - 1),
                    });
                    currentGoal = this.goalStore.getById(currentGoal.id)!;
                    break;
                }

                case 'needs_auth': {
                    // Pausa goal — WorkflowEngine callback vai retomar
                    await onProgress?.({ goalId: currentGoal.id, cycle: totalCycles, event: 'blocked', message: 'Aguardando autorização' });
                    this.goalStore.update(currentGoal.id, { status: 'blocked' });
                    return this.buildResult(currentGoal, false, totalCycles, totalReplans,
                        'Aguardando sua autorização para prosseguir.');
                }

                case 'blocked': {
                    if (!cycleResult.blocker) break;

                    this.goalStore.addBlocker(currentGoal.id, cycleResult.blocker);
                    currentGoal = this.goalStore.getById(currentGoal.id)!;

                    await onProgress?.({ goalId: currentGoal.id, cycle: totalCycles, event: 'replanning', message: cycleResult.blocker.description });

                    // Registra falha na ReflectionMemory para aprendizado futuro
                    this.reflectionMemory.record({
                        userInput: currentGoal.userIntent,
                        intent: currentGoal.objective.slice(0, 100),
                        toolUsed: pendingStep.toolName ?? 'unknown',
                        approved: false,
                        reason: cycleResult.blocker.description,
                        confidence: cycleResult.confidence,
                        pattern: `goal_blocker_${cycleResult.blocker.kind}`,
                        suggestedFix: cycleResult.blocker.suggestedActions[0],
                    });

                    // Verificar se ainda tem replan budget
                    if (currentGoal.replanBudget <= 0) {
                        this.goalStore.setStatus(currentGoal.id, 'failed');
                        const explanation = this.evaluator.buildFailureExplanation(currentGoal);
                        await onProgress?.({ goalId: currentGoal.id, cycle: totalCycles, event: 'failed', message: explanation });
                        return this.buildResult(currentGoal, false, totalCycles, totalReplans, explanation);
                    }

                    // Stall detection — sem progresso real?
                    const progress = this.evaluator.evaluateProgress(currentGoal);
                    if (progress === 'regressing') {
                        log.warn(`[GoalLoop] goal=${currentGoal.id} regressing — aborting`);
                        this.goalStore.setStatus(currentGoal.id, 'failed');
                        const explanation = this.evaluator.buildFailureExplanation(currentGoal);
                        return this.buildResult(currentGoal, false, totalCycles, totalReplans, explanation);
                    }

                    // Replan
                    this.goalStore.update(currentGoal.id, {
                        status: 'replanning',
                        replanBudget: currentGoal.replanBudget - 1,
                    });
                    this.goalStore.addStrategyTried(currentGoal.id,
                        pendingStep.description + (pendingStep.toolName ? ` via ${pendingStep.toolName}` : ''));

                    const newPlan = await this.planner.replan(currentGoal, cycleResult.blocker);
                    this.goalStore.update(currentGoal.id, { currentPlan: newPlan, status: 'executing' });
                    currentGoal = this.goalStore.getById(currentGoal.id)!;
                    totalReplans++;
                    break;
                }

                case 'failed': {
                    this.goalStore.setStatus(currentGoal.id, 'failed');
                    const explanation = this.evaluator.buildFailureExplanation(currentGoal);
                    await onProgress?.({ goalId: currentGoal.id, cycle: totalCycles, event: 'failed', message: explanation });
                    return this.buildResult(currentGoal, false, totalCycles, totalReplans, explanation);
                }
            }

            // Verificar TTL após cada ciclo
            if (Date.now() > currentGoal.expiresAt) {
                this.goalStore.setStatus(currentGoal.id, 'abandoned');
                return this.buildResult(currentGoal, false, totalCycles, totalReplans,
                    'Objetivo expirou por tempo limite.');
            }
        }

        // Max cycles atingido
        this.goalStore.setStatus(currentGoal.id, 'failed');
        const explanation = this.evaluator.buildFailureExplanation(currentGoal);
        return this.buildResult(currentGoal, false, totalCycles, totalReplans, explanation);
    }

    // ── Execução de um step ───────────────────────────────────────────────────

    private async executeStep(
        goal: Goal,
        step: PlanStep,
        channelContext: ChannelContext
    ): Promise<CycleResult> {
        const startMs = Date.now();

        try {
            // Verifica se a tool está na authorization scope (se scope definido)
            if (step.toolName && goal.authorizationScope.length > 0) {
                if (!goal.authorizationScope.includes(step.toolName)) {
                    return {
                        outcome: 'needs_auth',
                        confidence: 0.9,
                        blocker: {
                            kind: 'missing_permission',
                            toolName: step.toolName,
                            description: `Tool '${step.toolName}' não está no escopo autorizado`,
                            suggestedActions: ['Solicitar autorização para esta ferramenta'],
                            detectedAt: Date.now(),
                        },
                    };
                }
            }

            let toolResult: { success: boolean; output: string; error?: string };

            if (step.toolName && step.toolArgs) {
                // Execução direta via ToolRegistry
                const tool = this.toolRegistry.get(step.toolName);
                if (!tool) {
                    toolResult = { success: false, output: '', error: `command not found: ${step.toolName}` };
                } else {
                    toolResult = await tool.execute(step.toolArgs);
                }
            } else {
                // Sem tool específica → chama AgentLoop com prompt focado no step
                const stepPrompt = `[GOAL STEP] ${step.description}\n\nContexto do objetivo: ${goal.objective}`;
                const response = await this.agentLoop.process(
                    goal.conversationId,
                    stepPrompt,
                    undefined,
                    channelContext
                );
                const text = typeof response === 'string' ? response : response.text;
                // Heurística de sucesso: resposta sem indicadores de erro
                const isError = /erro|falhou|não consegui|não foi possível|failed|error/i.test(text) && text.length < 200;
                toolResult = { success: !isError, output: text };
            }

            // Registrar attempt
            const attempt: GoalAttempt = {
                id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
                planStepId: step.id,
                toolName: step.toolName ?? 'agentloop',
                args: step.toolArgs ?? {},
                result: toolResult.success ? 'success' : 'failure',
                output: toolResult.output?.slice(0, 300),
                error: toolResult.error,
                durationMs: Date.now() - startMs,
                executedAt: Date.now(),
            };
            this.goalStore.addAttempt(goal.id, attempt);

            if (step.toolName) {
                this.goalStore.addToolTried(goal.id, step.toolName);
            }

            return this.evaluator.evaluate(goal, step, toolResult);

        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            const attempt: GoalAttempt = {
                id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
                planStepId: step.id,
                toolName: step.toolName ?? 'unknown',
                args: step.toolArgs ?? {},
                result: 'failure',
                error: errorMsg,
                durationMs: Date.now() - startMs,
                executedAt: Date.now(),
            };
            this.goalStore.addAttempt(goal.id, attempt);

            return this.evaluator.evaluate(goal, step, { success: false, output: '', error: errorMsg });
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private markStepDone(goal: Goal, step: PlanStep, output: string): void {
        const updatedPlan = goal.currentPlan.map(s =>
            s.id === step.id ? { ...s, status: 'completed' as const, result: output.slice(0, 200), executedAt: Date.now() } : s
        );
        this.goalStore.update(goal.id, { currentPlan: updatedPlan });

        // Registra sucesso na ReflectionMemory
        this.reflectionMemory.record({
            userInput: goal.userIntent,
            intent: goal.objective.slice(0, 100),
            toolUsed: step.toolName ?? 'agentloop',
            toolOutput: output.slice(0, 200),
            approved: true,
            reason: 'step completed successfully',
            confidence: 0.9,
            pattern: step.toolName ? `tool_${step.toolName}_success` : 'goal_step_success',
        });
    }

    private buildResult(
        goal: Goal,
        success: boolean,
        totalCycles: number,
        totalReplans: number,
        overrideOutput?: string
    ): GoalResult {
        const lastSuccess = [...goal.attempts].reverse().find(a => a.result === 'success');
        const finalOutput = overrideOutput
            ?? lastSuccess?.output
            ?? (success ? 'Objetivo concluído.' : this.evaluator.buildFailureExplanation(goal));

        return {
            goal,
            success,
            finalOutput,
            totalCycles,
            totalAttempts: goal.attempts.length,
            totalReplans,
        };
    }
}
