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
import { GoalContextualizer } from './GoalContextualizer';
import { RiskAnalyzer } from './RiskAnalyzer';
import { EnvironmentProbe } from './EnvironmentProbe';
import { ToolRegistry } from '../core/ToolRegistry';
import { ReflectionMemory } from '../memory/ReflectionMemory';
import { MemoryManager } from '../memory/MemoryManager';
import { ProviderFactory, LLMMessage } from '../core/ProviderFactory';
import { Goal, PlanStep, GoalAttempt, GoalBlocker, GoalResult, GoalProgressUpdate, CycleResult } from './GoalTypes';
import { GOAL_LIMITS } from './GoalLimits';
import { ChannelContext } from './agentLoopTypes';

const log = createLogger('GoalExecutionLoop');

export type ProgressCallback = (update: GoalProgressUpdate) => Promise<void>;

export class GoalExecutionLoop {
    private readonly evaluator = new GoalEvaluator();
    private readonly contextualizer: GoalContextualizer;
    private readonly riskAnalyzer: RiskAnalyzer;
    private readonly envProbe = new EnvironmentProbe();

    constructor(
        private readonly agentLoop: AgentLoop,
        private readonly goalStore: GoalStore,
        private readonly planner: GoalPlanner,
        private readonly reflectionMemory: ReflectionMemory,
        private readonly toolRegistry: typeof ToolRegistry,
        private readonly providerFactory: ProviderFactory,
        memory: MemoryManager,
    ) {
        this.contextualizer = new GoalContextualizer(memory, reflectionMemory);
        this.riskAnalyzer = new RiskAnalyzer(providerFactory, toolRegistry, reflectionMemory);
    }

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
        log.info(`[GoalLoop] start goal=${goal.id} replanBudget=${goal.replanBudget}`);

        // ── Q1: Contextualização ──────────────────────────────────────────
        // Enriquece o entendimento do objetivo com memória semântica antes de planejar
        const q1Context = await this.contextualizer.contextualize(goal, 1, undefined);

        // ── Item 10: Capabilities probe — injetar no contexto do planner ──
        // O probe é cacheado 5 minutos; não adiciona latência em goals consecutivos.
        const envCaps = await this.envProbe.probe();
        const envContext = envCaps.summary ? `\n${envCaps.summary}` : '';

        // ── Planejamento inicial ───────────────────────────────────────────
        this.goalStore.update(goal.id, { status: 'replanning' });
        const rawPlan = await this.planner.plan(goal, (q1Context ?? '') + envContext);

        // ── Q2: Análise de Riscos (apenas planos complexos) ──────────────
        // Planos simples passam direto; Q2 só vale a latência em tarefas com
        // dependências entre steps (ex: exec cria arquivo → send_document envia)
        let initialPlan = rawPlan;
        if (this.isComplexPlan(rawPlan)) {
            const riskReport = await this.riskAnalyzer.analyze(goal, rawPlan);
            if (riskReport.blocked) {
                log.warn(`[GoalLoop] Q2 BLOCKED goal=${goal.id}: ${riskReport.blockReason}`);
                this.goalStore.setStatus(goal.id, 'failed');
                return this.buildResult(goal, false, 0, 0,
                    riskReport.blockReason ?? 'Plano inviável detectado antes da execução.');
            }
            initialPlan = riskReport.planAdjusted ? riskReport.adjustedPlan : rawPlan;
            if (riskReport.risks.length > 0) {
                log.info(`[GoalLoop] Q2 risks (initial): ${riskReport.risks.join(' | ')}`);
            }
        } else {
            log.debug('[GoalLoop] Q2 skipped — simple plan');
        }

        this.goalStore.update(goal.id, { currentPlan: initialPlan, status: 'executing' });
        const currentGoal = this.goalStore.getById(goal.id)!;

        return this.runLoop(currentGoal, channelContext, onProgress, 0, 0);
    }

    /**
     * Retoma execução após autorização aprovada via WorkflowEngine.
     * Marca o step bloqueado como concluído com o output do workflow e continua o loop
     * a partir do próximo step pendente, sem replanejar.
     */
    async resumeGoal(
        goal: Goal,
        channelContext: ChannelContext,
        authStepOutput: string,
        onProgress?: ProgressCallback
    ): Promise<GoalResult> {
        log.info(`[GoalLoop] resuming goal=${goal.id} after auth`);

        // Marca o step que estava aguardando auth como concluído
        const blockedStep = goal.currentPlan.find(s => s.status === 'pending');
        if (blockedStep) {
            this.markStepDone(goal, blockedStep, authStepOutput);
        }

        this.goalStore.update(goal.id, { status: 'executing', pendingTxnId: undefined });
        const currentGoal = this.goalStore.getById(goal.id)!;

        return this.runLoop(currentGoal, channelContext, onProgress, 0, 0);
    }

    // ── Detecção de complexidade ──────────────────────────────────────────────

    /**
     * Um plano é "complexo" quando tem dependências de artefato entre steps
     * (ex: exec_command cria arquivo → send_document envia)
     * ou quando tem 3+ steps. Nesses casos Q2 vale a latência extra.
     */
    private isComplexPlan(plan: PlanStep[]): boolean {
        if (plan.length >= 3) return true;
        const hasExec = plan.some(s => s.toolName === 'exec_command');
        const hasDelivery = plan.some(s => ['send_document', 'send_audio', 'write', 'edit'].includes(s.toolName ?? ''));
        return hasExec && hasDelivery;
    }

    // ── Helper espiral: Q1+Q2 envolvem cada replan ────────────────────────────

    /**
     * Executa Q1 (contextualização) + replan + Q2 (análise de riscos) para um ciclo.
     * Centraliza a lógica de replanejamento com espiral para evitar duplicação.
     */
    /**
     * @param forceQ2 - true quando chamado após Q4 falhar: Q2 sempre roda,
     *                  independente da complexidade do plano.
     */
    private async planWithSpiral(
        goal: Goal,
        blocker: GoalBlocker,
        priorFeedback: string | undefined,
        cycleNumber: number,
        forceQ2 = false,
    ): Promise<Goal> {
        // Q1: Contextualização — memória + feedback do ciclo anterior
        const q1Context = await this.contextualizer.contextualize(goal, cycleNumber, priorFeedback);

        // Item 10: Capabilities probe — incluído em cada replan para que o planner
        // saiba quais ferramentas estão (e não estão) disponíveis após possíveis instalações.
        const envCaps = await this.envProbe.probe();
        const envContext = envCaps.summary ? `\n${envCaps.summary}` : '';

        // Replan com contexto enriquecido
        const rawPlan = await this.planner.replan(goal, blocker, (q1Context ?? '') + envContext);

        // Q2: Análise de Riscos
        // Ativo quando: plano complexo (dependências entre steps)
        //           OU: forçado após Q4 falhar (objetivo não foi entregue)
        let finalPlan = rawPlan;
        if (forceQ2 || this.isComplexPlan(rawPlan)) {
            const riskReport = await this.riskAnalyzer.analyze(goal, rawPlan);
            if (riskReport.blocked) {
                // Replan também pode ser bloqueado — propaga como goal bloqueado para o loop
                log.warn(`[GoalLoop] Q2 BLOCKED replan goal=${goal.id}: ${riskReport.blockReason}`);
                this.goalStore.update(goal.id, {
                    status: 'replanning',
                    replanBudget: Math.max(0, goal.replanBudget - 1),
                });
                this.goalStore.addBlocker(goal.id, {
                    kind: 'environment_limit',
                    description: riskReport.blockReason ?? 'Plano bloqueado por análise de riscos',
                    suggestedActions: ['Usar abordagem alternativa sem as ferramentas bloqueadas'],
                    detectedAt: Date.now(),
                });
            }
            finalPlan = riskReport.planAdjusted ? riskReport.adjustedPlan : rawPlan;
            if (riskReport.risks.length > 0) {
                log.info(`[GoalLoop] Q2 risks (replan cycle=${cycleNumber} forced=${forceQ2}): ${riskReport.risks.join(' | ')}`);
            }
        } else {
            log.debug(`[GoalLoop] Q2 skipped (replan cycle=${cycleNumber} — simple plan)`);
        }

        this.goalStore.update(goal.id, { currentPlan: finalPlan, status: 'executing' });
        return this.goalStore.getById(goal.id)!;
    }

    // ── Loop de ciclos (compartilhado entre executeGoal e resumeGoal) ─────────

    private async runLoop(
        goal: Goal,
        channelContext: ChannelContext,
        onProgress: ProgressCallback | undefined,
        initialCycles: number,
        initialReplans: number,
        initialFeedback?: string,
    ): Promise<GoalResult> {
        let currentGoal = goal;
        let totalCycles = initialCycles;
        let totalReplans = initialReplans;
        // Feedback do Q4 → Q1: razão pela qual o objetivo não foi atingido no ciclo anterior
        let priorFeedback: string | undefined = initialFeedback;

        while (totalCycles < GOAL_LIMITS.MAX_CYCLES) {
            totalCycles++;

            await onProgress?.({
                goalId: currentGoal.id,
                cycle: totalCycles,
                event: 'cycle_start',
            });

            const pendingStep = currentGoal.currentPlan.find(s => s.status === 'pending');

            if (!pendingStep) {
                // Todos os steps concluídos — LLM valida se o objetivo foi realmente atingido
                log.info(`[GoalLoop] goal=${currentGoal.id} all steps completed — running LLM validation`);
                await onProgress?.({ goalId: currentGoal.id, cycle: totalCycles, event: 'tool_completed', message: 'Validando conclusão...' });

                const validation = await this.validateGoalCompletion(currentGoal);

                if (validation.achieved) {
                    this.goalStore.setStatus(currentGoal.id, 'completed');
                    log.info(`[GoalLoop] goal=${currentGoal.id} validated as complete`);
                    return this.buildResult(currentGoal, true, totalCycles, totalReplans, validation.summary);
                }

                // LLM diz que o objetivo ainda não foi atingido
                log.info(`[GoalLoop] goal=${currentGoal.id} not yet complete: ${validation.reason}`);
                await onProgress?.({ goalId: currentGoal.id, cycle: totalCycles, event: 'replanning', message: validation.reason });

                // ── Item 2: Deliverable Check ──────────────────────────────
                // Antes de replanejar, verifica se já existe output no workspace.
                // Evita o cenário onde 3 arquivos .pptx existem mas o sistema
                // continua tentando regenerar em vez de enviar o que já tem.
                if (!currentGoal.strategiesTried.includes('deliverable_check_done')) {
                    const expectedExts = this.inferExpectedExtensions(currentGoal.userIntent);
                    if (expectedExts.length > 0) {
                        const foundFiles = await this.checkDeliverables(expectedExts);
                        if (foundFiles.length > 0) {
                            log.info(`[GoalLoop] deliverable_check: ${foundFiles.length} arquivo(s) no workspace — injetando send steps`);
                            this.goalStore.addStrategyTried(currentGoal.id, 'deliverable_check_done');
                            currentGoal = this.goalStore.getById(currentGoal.id)!;

                            const sendSteps: PlanStep[] = foundFiles.slice(0, 2).map((filePath, i) => ({
                                id: `send_del_${Date.now()}_${i}`,
                                description: `Enviar ao usuário arquivo encontrado no workspace: ${filePath}`,
                                toolName: 'send_document',
                                toolArgs: { path: filePath },
                                status: 'pending' as const,
                                fallbackSteps: [],
                            }));

                            const updatedPlan: PlanStep[] = [
                                ...currentGoal.currentPlan.filter(s => s.status === 'completed'),
                                ...sendSteps,
                            ];
                            this.goalStore.update(currentGoal.id, { currentPlan: updatedPlan, status: 'executing' });
                            currentGoal = this.goalStore.getById(currentGoal.id)!;
                            continue;
                        }
                    }
                }

                if (currentGoal.replanBudget <= 0) {
                    this.goalStore.setStatus(currentGoal.id, 'failed');
                    const explanation = validation.reason ?? this.evaluator.buildFailureExplanation(currentGoal);
                    await onProgress?.({ goalId: currentGoal.id, cycle: totalCycles, event: 'failed', message: explanation });
                    return this.buildResult(currentGoal, false, totalCycles, totalReplans, explanation);
                }

                const blocker: GoalBlocker = {
                    kind: 'goal_incomplete',
                    description: validation.reason ?? 'Objetivo não verificado como concluído pelo validador',
                    suggestedActions: validation.suggestions ?? ['Verificar se o resultado foi entregue ao usuário'],
                    detectedAt: Date.now(),
                };
                this.goalStore.addBlocker(currentGoal.id, blocker);
                currentGoal = this.goalStore.getById(currentGoal.id)!;

                this.goalStore.update(currentGoal.id, {
                    status: 'replanning',
                    replanBudget: currentGoal.replanBudget - 1,
                });
                this.goalStore.addStrategyTried(currentGoal.id,
                    `completed all steps but goal_incomplete: ${(validation.reason ?? '').slice(0, 100)}`);

                // Q4 → Q1: feedback da validação alimenta o próximo ciclo espiral
                // forceQ2=true: se o objetivo não foi entregue, Q2 sempre revisa o plano
                priorFeedback = validation.reason;
                currentGoal = await this.planWithSpiral(currentGoal, blocker, priorFeedback, totalReplans + 1, true);
                totalReplans++;

                if (Date.now() > currentGoal.expiresAt) {
                    this.goalStore.setStatus(currentGoal.id, 'abandoned');
                    return this.buildResult(currentGoal, false, totalCycles, totalReplans, 'Objetivo expirou por tempo limite.');
                }
                continue;
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
                    // Extrai txnId dos botões para vincular ao goal (permite retomada via resumeGoal)
                    const txnId = cycleResult.authOptions
                        ?.find(o => o.value?.startsWith('auth:'))
                        ?.value?.split(':').slice(2).join(':');

                    await onProgress?.({ goalId: currentGoal.id, cycle: totalCycles, event: 'blocked', message: 'Aguardando autorização' });
                    this.goalStore.update(currentGoal.id, {
                        status: 'blocked',
                        pendingTxnId: txnId,
                    });
                    const goalResult = this.buildResult(currentGoal, false, totalCycles, totalReplans,
                        cycleResult.output || 'Aguardando sua autorização para prosseguir.');
                    return { ...goalResult, authOptions: cycleResult.authOptions };
                }

                case 'needs_dependency': {
                    const depInfo = cycleResult.depInfo!;
                    const installKey = `install_dep_${depInfo.name}`;

                    // Registra tentativa de instalação antes de injetar o step
                    // (previne loop: se o install falhar, GoalEvaluator retornará 'failed' com manual instructions)
                    this.goalStore.addStrategyTried(currentGoal.id, installKey);
                    currentGoal = this.goalStore.getById(currentGoal.id)!;

                    const installStepId = `install_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
                    const installStep: PlanStep = {
                        id: installStepId,
                        description: `Instalar '${depInfo.name}' necessário para continuar: ${depInfo.installCmd}`,
                        // Sem toolName → AgentLoop processa → chama exec_command → WorkflowEngine pede auth ao usuário
                        status: 'pending',
                        fallbackSteps: [],
                    };

                    // Reconstrói o plano: steps já concluídos + installStep + step que falhou + resto
                    const updatedPlan: PlanStep[] = [
                        ...currentGoal.currentPlan.filter(s => s.status === 'completed'),
                        installStep,
                        pendingStep,
                        ...currentGoal.currentPlan.filter(s => s.status === 'pending' && s.id !== pendingStep.id),
                    ];

                    this.goalStore.update(currentGoal.id, { currentPlan: updatedPlan });
                    currentGoal = this.goalStore.getById(currentGoal.id)!;

                    log.info(`[GoalLoop] dep='${depInfo.name}' missing — injected install step=${installStepId}`);
                    await onProgress?.({
                        goalId: currentGoal.id,
                        cycle: totalCycles,
                        event: 'replanning',
                        message: `Dependência '${depInfo.name}' não encontrada — vou instalar antes de continuar`,
                    });
                    break;
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

                    // Replan com Espiral (Q1 + Q2 envolvem cada replanejamento)
                    this.goalStore.update(currentGoal.id, {
                        status: 'replanning',
                        replanBudget: currentGoal.replanBudget - 1,
                    });
                    this.goalStore.addStrategyTried(currentGoal.id,
                        pendingStep.description + (pendingStep.toolName ? ` via ${pendingStep.toolName}` : ''));

                    priorFeedback = cycleResult.blocker?.description;
                    currentGoal = await this.planWithSpiral(currentGoal, cycleResult.blocker!, priorFeedback, totalReplans + 1);
                    totalReplans++;
                    break;
                }

                case 'failed': {
                    this.goalStore.setStatus(currentGoal.id, 'failed');
                    // cycleResult.output tem prioridade quando contém mensagem rica (ex: dep install falhou → instrução manual)
                    const explanation = cycleResult.output ?? this.evaluator.buildFailureExplanation(currentGoal);
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

        // Max cycles atingido — mas se todos os steps completaram, ainda roda a validação final.
        // Sem esta verificação, o goal falha mesmo quando o último step termina com sucesso
        // no mesmo ciclo em que MAX_CYCLES é atingido (a iteração de validação nunca roda).
        const allStepsDone = !currentGoal.currentPlan.find(s => s.status === 'pending');
        if (allStepsDone) {
            log.info(`[GoalLoop] goal=${currentGoal.id} MAX_CYCLES=${GOAL_LIMITS.MAX_CYCLES} reached but all steps done — running final validation`);
            const validation = await this.validateGoalCompletion(currentGoal);
            if (validation.achieved) {
                this.goalStore.setStatus(currentGoal.id, 'completed');
                return this.buildResult(currentGoal, true, totalCycles, totalReplans, validation.summary);
            }
            log.info(`[GoalLoop] goal=${currentGoal.id} final validation failed at MAX_CYCLES: ${validation.reason}`);
        }
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
                const [, sessionUserId] = goal.sessionKey.split(':');
                const response = await this.agentLoop.process(
                    goal.conversationId,
                    stepPrompt,
                    sessionUserId ?? goal.conversationId,
                    channelContext
                );
                const text = typeof response === 'string' ? response : response.text;
                const respOptions = typeof response === 'string' ? undefined : response.options;

                // Se o AgentLoop retornou botões de auth, propaga como needs_auth
                const authOpts = respOptions?.filter(o => o.value?.startsWith('auth:'));
                if (authOpts && authOpts.length > 0) {
                    this.goalStore.addAttempt(goal.id, {
                        id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
                        planStepId: step.id,
                        toolName: 'agentloop',
                        args: {},
                        result: 'failure',
                        output: text.slice(0, 300),
                        durationMs: Date.now() - startMs,
                        executedAt: Date.now(),
                    });
                    return { outcome: 'needs_auth' as const, confidence: 0.9, output: text, authOptions: authOpts };
                }

                // LLM avalia se o AgentLoop executou o step com sucesso
                const success = await this.evaluateAgentStepSuccess(step.description, goal.objective, text);
                toolResult = { success, output: text };
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

            const cycleResult = this.evaluator.evaluate(goal, step, toolResult);
            const durationMs = Date.now() - startMs;
            log.info(`[GoalStep] goal=${goal.id} step=${step.id} tool=${step.toolName ?? 'agentloop'} outcome=${cycleResult.outcome} durationMs=${durationMs}${cycleResult.blocker ? ` blocker=${cycleResult.blocker.kind}` : ''}`);
            return cycleResult;

        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            const durationMs = Date.now() - startMs;
            const attempt: GoalAttempt = {
                id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
                planStepId: step.id,
                toolName: step.toolName ?? 'unknown',
                args: step.toolArgs ?? {},
                result: 'failure',
                error: errorMsg,
                durationMs,
                executedAt: Date.now(),
            };
            this.goalStore.addAttempt(goal.id, attempt);

            const cycleResult = this.evaluator.evaluate(goal, step, { success: false, output: '', error: errorMsg });
            log.warn(`[GoalStep] goal=${goal.id} step=${step.id} tool=${step.toolName ?? 'unknown'} EXCEPTION durationMs=${durationMs} error="${errorMsg.slice(0, 100)}"`);
            return cycleResult;
        }
    }

    // ── LLM step success evaluator ────────────────────────────────────────────

    /**
     * Usa o LLM para avaliar se a resposta do AgentLoop indica sucesso no step.
     * Substitui a heurística de regex frágil por julgamento semântico.
     * Fallback conservador para regex se o LLM falhar.
     */
    private async evaluateAgentStepSuccess(
        stepDescription: string,
        objective: string,
        response: string,
    ): Promise<boolean> {
        const prompt = `Avalie se o resultado abaixo indica SUCESSO no cumprimento da tarefa.

TAREFA: ${stepDescription}
OBJETIVO: ${objective.slice(0, 200)}
RESULTADO: ${response.slice(0, 600)}

Responda APENAS com JSON válido, sem texto adicional:
{"success": true} se a tarefa foi concluída ou progrediu substancialmente.
{"success": false} se houve erro, incapacidade de executar, ou pedido de informação bloqueante.`;

        try {
            const result = await this.providerFactory.chatWithFallback(
                [{ role: 'user', content: prompt }] as LLMMessage[],
                undefined,
                undefined,
                30_000,
            );

            if (result.status !== 'success') {
                log.warn('[GoalLoop] LLM step eval failed, using regex fallback');
                return !/(erro|falhou|não consegui|não foi possível|failed|error)/i.test(response);
            }

            const cleaned = result.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const parsed = JSON.parse(cleaned);
            log.debug(`[GoalLoop] LLM step eval: success=${parsed.success}`);
            return Boolean(parsed.success);
        } catch {
            return !/(erro|falhou|não consegui|não foi possível|failed|error)/i.test(response);
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private markStepDone(goal: Goal, step: PlanStep, output: string): void {
        const updatedPlan = goal.currentPlan.map(s =>
            s.id === step.id ? { ...s, status: 'completed' as const, result: output.slice(0, 200), executedAt: Date.now() } : s
        );
        this.goalStore.update(goal.id, { currentPlan: updatedPlan });

        // Item 10: Após instalação bem-sucedida de dependência, invalida o cache do
        // EnvironmentProbe para que o próximo replan detecte a ferramenta recém-instalada.
        if (step.id.startsWith('install_')) {
            EnvironmentProbe.invalidateCache();
            log.info(`[GoalLoop] dep install step=${step.id} completed — envProbe cache invalidated`);
        }

        // Registra attempt de sucesso para que buildResult() encontre o output real
        // (sem isso, resumeGoal() marca o step como concluído mas goal.attempts fica vazio
        // e buildResult() cai no fallback genérico "Objetivo concluído.")
        this.goalStore.addAttempt(goal.id, {
            id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
            planStepId: step.id,
            toolName: step.toolName ?? 'agentloop',
            args: step.toolArgs ?? {},
            result: 'success',
            output: output.slice(0, 300),
            durationMs: 0,
            executedAt: Date.now(),
        });

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

    /**
     * Pergunta ao LLM se o objetivo foi realmente atingido após todos os steps concluírem.
     * Fallback conservador: assume achieved=true em caso de erro (evita loop infinito).
     */
    private async validateGoalCompletion(goal: Goal): Promise<{
        achieved: boolean;
        summary?: string;
        reason?: string;
        suggestions?: string[];
    }> {
        const stepsContext = goal.currentPlan
            .filter(s => s.status === 'completed')
            .map(s => `- ${s.description}: ${s.result || '(sem output)'}`)
            .join('\n');

        const attemptsContext = goal.attempts
            .filter(a => a.result === 'success')
            .map(a => `- ${a.toolName}: ${a.output || '(sem output)'}`)
            .join('\n');

        const prompt = `Você é um validador de tarefas. Verifique se o objetivo foi COMPLETAMENTE concluído.

OBJETIVO: ${goal.objective}
INTENÇÃO DO USUÁRIO: ${goal.userIntent}

STEPS EXECUTADOS:
${stepsContext || '(nenhum)'}

RESULTADOS DAS FERRAMENTAS:
${attemptsContext || '(nenhum)'}

Análise crítica: o objetivo foi atingido E o resultado entregue ao usuário?
Exemplo: converter um arquivo e enviar ao usuário são duas coisas distintas — apenas converter não basta.

Responda APENAS com JSON válido (sem markdown):
{"achieved": true, "summary": "resumo do que foi feito"}
OU
{"achieved": false, "reason": "o que está faltando", "suggestions": ["ação 1", "ação 2"]}`;

        try {
            const result = await this.providerFactory.chatWithFallback(
                [{ role: 'user', content: prompt }] as LLMMessage[],
                undefined,
                undefined,
                45_000,
            );

            if (result.status !== 'success') {
                log.warn('[GoalLoop] LLM validation failed — assuming achieved');
                return { achieved: true };
            }

            const cleaned = result.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const parsed = JSON.parse(cleaned);
            log.info(`[GoalLoop] LLM validation: achieved=${parsed.achieved}${parsed.reason ? ` reason="${parsed.reason}"` : ''}`);
            return {
                achieved: Boolean(parsed.achieved),
                summary: parsed.summary,
                reason: parsed.reason,
                suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : undefined,
            };
        } catch (err) {
            log.warn('[GoalLoop] validation error — assuming achieved:', String(err));
            return { achieved: true };
        }
    }

    // ── Deliverable Check helpers (Item 2) ───────────────────────────────────

    /**
     * Infere extensões esperadas a partir das palavras-chave do userIntent.
     * Retorna lista vazia se não há tipo de arquivo identificável.
     */
    private inferExpectedExtensions(userIntent: string): string[] {
        const lower = userIntent.toLowerCase();
        const exts: string[] = [];
        if (/pptx|apresenta|slides?|powerpoint/i.test(lower))  exts.push('.pptx', '.ppt');
        if (/pdf/i.test(lower))                                 exts.push('.pdf');
        if (/docx?|word|documento/i.test(lower))               exts.push('.docx', '.doc');
        if (/xlsx?|excel|planilha/i.test(lower))               exts.push('.xlsx', '.xls');
        if (/mp4|vídeo|video/i.test(lower))                    exts.push('.mp4', '.avi', '.mkv');
        if (/mp3|áudio|audio/i.test(lower))                    exts.push('.mp3', '.ogg', '.wav');
        if (/html|página|pagina/i.test(lower))                 exts.push('.html');
        if (/zip|comprim/i.test(lower))                        exts.push('.zip');
        if (/png|jpg|jpeg|imagem|image/i.test(lower))          exts.push('.png', '.jpg', '.jpeg');
        return exts;
    }

    /**
     * Busca arquivos com as extensões esperadas em diretórios comuns do workspace.
     * Usa exec_command com find; retorna lista de caminhos absolutos (até 5).
     */
    private async checkDeliverables(extensions: string[]): Promise<string[]> {
        const execTool = this.toolRegistry.get('exec_command');
        if (!execTool) return [];

        const nameTests = extensions.map(e => `-name "*${e}"`).join(' -o ');
        const cmd = `find /tmp /workspace . -maxdepth 4 \\( ${nameTests} \\) -newer /proc/1 2>/dev/null | head -5`;

        try {
            const result = await execTool.execute({ command: cmd });
            if (!result.success || !result.output) return [];
            return result.output.split('\n').map((l: string) => l.trim()).filter(Boolean);
        } catch {
            return [];
        }
    }

    private buildResult(
        goal: Goal,
        success: boolean,
        totalCycles: number,
        totalReplans: number,
        overrideOutput?: string
    ): GoalResult {
        const lastSuccess = [...goal.attempts].reverse().find(a => a.result === 'success');
        // Fallback extra: resultado armazenado no plan step (via markStepDone)
        const lastCompletedStep = [...goal.currentPlan].reverse().find(s => s.status === 'completed');
        // Usa || para tratar string vazia como ausente (exec_command com outputLen=0)
        const finalOutput = overrideOutput
            ?? (lastSuccess?.output || undefined)
            ?? lastCompletedStep?.result
            ?? (success ? 'Tarefa concluída com sucesso.' : this.evaluator.buildFailureExplanation(goal));

        // ── Goal Audit Summary — log estruturado único para forense ──────────
        // Uma linha que responde: "o que aconteceu neste goal?"
        const durationMs = goal.completedAt
            ? goal.completedAt - goal.createdAt
            : Date.now() - goal.createdAt;
        const toolsUsed = [...new Set(goal.attempts.map(a => a.toolName))].join(',');
        const blockerKinds = goal.blockers.map(b => b.kind).join(',');
        const lastError = [...goal.attempts].reverse().find(a => a.result === 'failure')?.error?.slice(0, 100) ?? '';
        log.info(
            `[GoalAudit] id=${goal.id} success=${success}` +
            ` cycles=${totalCycles} replans=${totalReplans} attempts=${goal.attempts.length}` +
            ` tools=[${toolsUsed || 'none'}] blockers=[${blockerKinds || 'none'}]` +
            ` durationMs=${durationMs}` +
            (lastError ? ` lastError="${lastError}"` : '') +
            ` intent="${goal.userIntent.slice(0, 80)}"`
        );

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
