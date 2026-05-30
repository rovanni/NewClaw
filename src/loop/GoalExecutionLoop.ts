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
import { RiskAnalyzer } from './RiskAnalyzer';
import { CapabilityRegistry } from '../core/CapabilityRegistry';
import { ProactiveRecovery, ToolExecutorLike } from './ProactiveRecovery';
import { ToolRegistry } from '../core/ToolRegistry';
import { ReflectionMemory } from '../memory/ReflectionMemory';
import { MemoryManager } from '../memory/MemoryManager';
import { ProviderFactory, LLMMessage } from '../core/ProviderFactory';
import { Goal, PlanStep, GoalAttempt, GoalBlocker, GoalResult, GoalProgressUpdate, CycleResult, StepCognitiveContext, StepEvaluation, createEmptyStepCognitiveContext, SuccessCriterion } from './GoalTypes';
import { GOAL_LIMITS } from './GoalLimits';
import { ChannelContext, ContextAwareTool } from './agentLoopTypes';
import type { SessionManager } from '../session/SessionManager';

const log = createLogger('GoalExecutionLoop');

export type ProgressCallback = (update: GoalProgressUpdate) => Promise<void>;

export class GoalExecutionLoop {
    private readonly evaluator = new GoalEvaluator();
    private readonly riskAnalyzer: RiskAnalyzer;
    private readonly capRegistry = CapabilityRegistry.getInstance();
    private readonly proactiveRecovery = new ProactiveRecovery();

    /** Contexto cognitivo acumulado durante a execução de um goal (resetado a cada novo goal). */
    private cognitiveContext: StepCognitiveContext = createEmptyStepCognitiveContext();

    /** SessionManager opcional — usado para telemetria de compressão concorrente e artefatos. */
    private sessionManager: SessionManager | null = null;

    /** Injeta SessionManager após construção para evitar dependência circular. */
    setSessionManager(sm: SessionManager): void {
        this.sessionManager = sm;
    }

    constructor(
        private readonly agentLoop: AgentLoop,
        private readonly goalStore: GoalStore,
        private readonly planner: GoalPlanner,
        private readonly reflectionMemory: ReflectionMemory,
        private readonly toolRegistry: typeof ToolRegistry,
        private readonly providerFactory: ProviderFactory,
        private readonly memory: MemoryManager,
    ) {
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

        // Reinicia o contexto cognitivo para este goal
        this.cognitiveContext = createEmptyStepCognitiveContext();

        // ── Q1: Contextualização ──────────────────────────────────────────
        // Enriquece o entendimento do objetivo com memória semântica antes de planejar
        const q1Context = await this.contextualize(goal, 1, undefined);

        // ── Capabilities summary — injetar no contexto do planner ──────────
        // Registry usa TTL por categoria; chamadas consecutivas são servidas do cache.
        const capSummary = await this.capRegistry.getCapabilitySummary();

        // ── Se for Construction, planeja o roadmap primeiro ──────────────────
        if (goal.isConstruction && (!goal.roadmap || goal.roadmap.length === 0)) {
            log.info(`[GoalLoop] goal=${goal.id} is classified as construction. Planning roadmap.`);
            await onProgress?.({
                goalId: goal.id,
                cycle: 0,
                event: 'replanning',
                message: 'Analisando o objetivo global e definindo o roadmap de desenvolvimento incremental...'
            });
            const roadmap = await this.planner.planRoadmap(goal, q1Context, capSummary);
            this.goalStore.update(goal.id, {
                roadmap,
                currentMilestoneIndex: 0
            });
            // Recarrega o goal atualizado do store
            goal = this.goalStore.getById(goal.id)!;

            await onProgress?.({
                goalId: goal.id,
                cycle: 0,
                event: 'replanning',
                message: `📍 *Roadmap de Construção Incremental Planejado:*\n\n${roadmap.map((m, i) => `*Marco ${i+1}:* ${m}`).join('\n')}`
            });
        }

        const activeMilestone = goal.isConstruction && goal.roadmap && goal.roadmap.length > 0
            ? goal.roadmap[goal.currentMilestoneIndex ?? 0]
            : undefined;

        // ── Planejamento inicial ───────────────────────────────────────────
        this.goalStore.update(goal.id, { status: 'replanning' });
        const planResult = await this.planner.plan(goal, q1Context ?? '', capSummary, activeMilestone);

        // Se o roadmap foi ajustado pelo planner durante o planejamento inicial
        if (goal.isConstruction && planResult.adjustedRoadmap && planResult.adjustedRoadmap.length > 0) {
            log.info(`[GoalLoop] roadmap adjusted during initial planning.`);
            this.goalStore.update(goal.id, { roadmap: planResult.adjustedRoadmap });
            goal = this.goalStore.getById(goal.id)!;
        }

        let rawPlan = planResult.steps;

        // Persiste os critérios de sucesso gerados no plano inicial.
        // São definidos UMA VEZ aqui e preservados entre replans (representam
        // "o que significa estar pronto", não "como fazer").
        if (planResult.successCriteria && planResult.successCriteria.length > 0) {
            this.goalStore.update(goal.id, { successCriteria: planResult.successCriteria });
            goal = this.goalStore.getById(goal.id)!;
            log.info(`[GoalLoop] successCriteria stored: ${planResult.successCriteria.map(c => `${c.id}(${c.check})`).join(', ')}`);
        }

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

        this.goalStore.update(goal.id, {
            currentPlan: initialPlan,
            status: 'executing',
            cycleFocus: planResult.strategy || undefined,
        });
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
        const q1Context = await this.contextualize(goal, cycleNumber, priorFeedback);

        // Capabilities summary no replan — registry serve do cache (TTL por categoria).
        const capSummary = await this.capRegistry.getCapabilitySummary();

        const activeMilestone = goal.isConstruction && goal.roadmap && goal.roadmap.length > 0
            ? goal.roadmap[goal.currentMilestoneIndex ?? 0]
            : undefined;

        // Replan com contexto enriquecido
        const planResult = await this.planner.replan(goal, blocker, q1Context ?? '', capSummary, activeMilestone);

        // Se o roadmap foi ajustado pelo planner durante o replanejamento
        if (goal.isConstruction && planResult.adjustedRoadmap && planResult.adjustedRoadmap.length > 0) {
            log.info(`[GoalLoop] roadmap adjusted during replanning.`);
            this.goalStore.update(goal.id, { roadmap: planResult.adjustedRoadmap });
            goal = this.goalStore.getById(goal.id)!;
        }

        let rawPlan = planResult.steps;

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

            // CR#3: Plano rejeitado por args inválidos — força novo replan com feedback estruturado
            if (riskReport.planRejected) {
                log.warn(`[GoalLoop] Q2 plan rejected goal=${goal.id} — injecting structured feedback for next replan`);
                this.goalStore.addStrategyTried(goal.id, `plan_rejected: ${(riskReport.rejectionReason ?? '').slice(0, 100)}`);
                // Injeta o rejectionReason como blocker para alimentar o próximo ciclo Q1
                this.goalStore.addBlocker(goal.id, {
                    kind: 'goal_incomplete',
                    description: riskReport.rejectionReason ?? 'Plano rejeitado por argumentos inválidos',
                    suggestedActions: [
                        'Incluir argumentos obrigatórios: path para read/write, oldText+newText para edit, file_path para send_document',
                    ],
                    detectedAt: Date.now(),
                });
                // Devolve plano vazio para forçar novo ciclo de replanning no runLoop
                this.goalStore.update(goal.id, {
                    currentPlan: [],
                    status: 'replanning',
                    replanBudget: Math.max(0, goal.replanBudget - 1),
                });
                return this.goalStore.getById(goal.id)!;
            }

            finalPlan = riskReport.planAdjusted ? riskReport.adjustedPlan : rawPlan;
            if (riskReport.risks.length > 0) {
                log.info(`[GoalLoop] Q2 risks (replan cycle=${cycleNumber} forced=${forceQ2}): ${riskReport.risks.join(' | ')}`);
            }
        } else {
            log.debug(`[GoalLoop] Q2 skipped (replan cycle=${cycleNumber} — simple plan)`);
        }

        this.goalStore.update(goal.id, {
            currentPlan: finalPlan,
            status: 'executing',
            cycleFocus: planResult.strategy || undefined,
        });
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
        // Telemetria: registra goal ativo para detectar compressão concorrente
        const [goalChannel, goalUserId] = goal.sessionKey.split(':');
        const goalSessionKey = { channel: goalChannel ?? 'unknown', userId: goalUserId ?? 'unknown' };
        this.sessionManager?.setActiveGoal(goalSessionKey, goal.id);

        try {
        return await this.runLoopInternal(goal, channelContext, onProgress, initialCycles, initialReplans, initialFeedback);
        } finally {
            this.sessionManager?.clearActiveGoal(goalSessionKey);
        }
    }

    private async runLoopInternal(
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

                const activeMilestone = currentGoal.isConstruction && currentGoal.roadmap && currentGoal.roadmap.length > 0
                    ? currentGoal.roadmap[currentGoal.currentMilestoneIndex ?? 0]
                    : undefined;

                const validation = await this.validateGoalCompletion(currentGoal, activeMilestone);

                if (validation.achieved) {
                    if (currentGoal.isConstruction && currentGoal.roadmap && (currentGoal.currentMilestoneIndex ?? 0) < currentGoal.roadmap.length - 1) {
                        const prevMilestone = currentGoal.roadmap[currentGoal.currentMilestoneIndex ?? 0];
                        const nextIndex = (currentGoal.currentMilestoneIndex ?? 0) + 1;
                        const nextMilestone = currentGoal.roadmap[nextIndex];
                        log.info(`[GoalLoop] milestone ${currentGoal.currentMilestoneIndex} achieved: "${prevMilestone}". Advancing to milestone ${nextIndex}: "${nextMilestone}"`);

                        await onProgress?.({
                            goalId: currentGoal.id,
                            cycle: totalCycles,
                            event: 'replanning',
                            message: `✅ *Marco Concluído:* ${prevMilestone}\n\n👉 *Próximo Marco:* ${nextMilestone}`
                        });

                        // Avança o marco e limpa o plano atual para forçar replanejamento para o novo marco
                        this.goalStore.update(currentGoal.id, {
                            currentMilestoneIndex: nextIndex,
                            currentPlan: [],
                        });
                        currentGoal = this.goalStore.getById(currentGoal.id)!;

                        // Planeja os steps para o próximo marco
                        const q1Context = await this.contextualize(currentGoal, totalCycles, undefined);
                        const capSummary = await this.capRegistry.getCapabilitySummary();

                        const planResult = await this.planner.plan(currentGoal, q1Context ?? '', capSummary, nextMilestone);
                        
                        // Permite atualizar o roadmap se o planner retornou um ajustado
                        if (currentGoal.isConstruction && planResult.adjustedRoadmap && planResult.adjustedRoadmap.length > 0) {
                            log.info(`[GoalLoop] roadmap adjusted during milestone planning transition.`);
                            this.goalStore.update(currentGoal.id, { roadmap: planResult.adjustedRoadmap });
                            currentGoal = this.goalStore.getById(currentGoal.id)!;
                        }

                        let initialPlan = planResult.steps;

                        // Q2: Análise de Riscos para o novo plano
                        if (this.isComplexPlan(initialPlan)) {
                            const riskReport = await this.riskAnalyzer.analyze(currentGoal, initialPlan);
                            if (riskReport.blocked) {
                                log.warn(`[GoalLoop] Q2 BLOCKED milestone goal=${currentGoal.id}: ${riskReport.blockReason}`);
                                this.goalStore.setStatus(currentGoal.id, 'failed');
                                return this.buildResult(currentGoal, false, totalCycles, totalReplans,
                                    riskReport.blockReason ?? 'Plano inviável detectado para o marco.');
                            }
                            initialPlan = riskReport.planAdjusted ? riskReport.adjustedPlan : initialPlan;
                        }

                        this.goalStore.update(currentGoal.id, {
                            currentPlan: initialPlan,
                            status: 'executing',
                            cycleFocus: planResult.strategy || undefined,
                        });
                        currentGoal = this.goalStore.getById(currentGoal.id)!;
                        continue;
                    } else {
                        // Se não for construção, ou se for o último marco
                        this.goalStore.setStatus(currentGoal.id, 'completed');
                        log.info(`[GoalLoop] goal=${currentGoal.id} validated as complete`);
                        return this.buildResult(currentGoal, true, totalCycles, totalReplans, validation.summary);
                    }
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
                        const foundFiles = await this.checkDeliverables(expectedExts, currentGoal.createdAt);
                        if (foundFiles.length > 0) {
                            log.info(`[GoalLoop] deliverable_check: ${foundFiles.length} arquivo(s) no workspace — injetando send steps`);
                            this.goalStore.addStrategyTried(currentGoal.id, 'deliverable_check_done');
                            currentGoal = this.goalStore.getById(currentGoal.id)!;

                            const sendSteps: PlanStep[] = foundFiles.slice(0, 2).map((filePath, i) => ({
                                id: `send_del_${Date.now()}_${i}`,
                                description: `Enviar ao usuário arquivo encontrado no workspace: ${filePath}`,
                                toolName: 'send_document',
                                toolArgs: { file_path: filePath },
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

            const cycleResult = await this.executeStep(currentGoal, pendingStep, channelContext, totalCycles);

            // Recarrega o goal — pode ter sido abandonado durante o step (nova mensagem do usuário)
            currentGoal = this.goalStore.getById(currentGoal.id)!;
            if (currentGoal.status === 'abandoned') {
                log.info(`[GoalLoop] goal=${currentGoal.id} foi abandonado durante execução do step — saindo do loop`);
                return this.buildResult(currentGoal, false, totalCycles, totalReplans,
                    'Goal interrompido: nova mensagem do usuário recebida durante execução.');
            }

            // ── Avaliar resultado ──────────────────────────────────────
            switch (cycleResult.outcome) {

                case 'success': {
                    this.markStepDone(currentGoal, pendingStep, cycleResult.output ?? '');
                    this.updateCognitiveContext(pendingStep, cycleResult.output ?? '');
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
                    this.recordFailedStrategy(pendingStep, cycleResult.blocker.description, currentGoal.id);
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
                    this.recordFailedStrategy(pendingStep, cycleResult.output ?? 'step falhou', currentGoal.id);
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
            const activeMilestone = currentGoal.isConstruction && currentGoal.roadmap && currentGoal.roadmap.length > 0
                ? currentGoal.roadmap[currentGoal.currentMilestoneIndex ?? 0]
                : undefined;
            const validation = await this.validateGoalCompletion(currentGoal, activeMilestone);
            if (validation.achieved) {
                const isLastMilestone = !currentGoal.isConstruction || !currentGoal.roadmap || (currentGoal.currentMilestoneIndex ?? 0) === currentGoal.roadmap.length - 1;
                if (isLastMilestone) {
                    this.goalStore.setStatus(currentGoal.id, 'completed');
                    return this.buildResult(currentGoal, true, totalCycles, totalReplans, validation.summary);
                } else {
                    log.warn(`[GoalLoop] goal=${currentGoal.id} completed step but ran out of cycles before final milestone`);
                }
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
        channelContext: ChannelContext,
        cycle = 0,
    ): Promise<CycleResult> {
        const startMs = Date.now();

        try {
            // NOTA: a verificação de authorizationScope foi removida daqui.
            // O motivo: quando esse check bloqueava um step, ele retornava `needs_auth`
            // sem criar uma transação no WorkflowEngine e sem `authOptions`, deixando
            // o goal permanentemente preso com `pendingTxnId = undefined` e nenhum
            // botão de autorização enviado ao usuário.
            // A autorização real de ferramentas perigosas (exec_command, etc.) é gerida
            // corretamente pelo WorkflowEngine via AgentLoop — não precisa deste pre-flight.

            let toolResult: { success: boolean; output: string; error?: string };
            let stepMutations: import('./GoalTypes').ToolMutation[] | undefined;
            let stepEvalForAttempt: { confidence: number; reason?: string } | undefined;

            if (step.toolName && step.toolArgs) {
                // Execução via ToolRegistry com ProactiveRecovery (mutação de args + fallback)
                if (!this.toolRegistry.get(step.toolName)) {
                    toolResult = { success: false, output: '', error: `command not found: ${step.toolName}` };
                } else {
                    const getTool = (name: string): ToolExecutorLike | undefined =>
                        this.toolRegistry.get(name) as ToolExecutorLike | undefined;
                    const toolInstance = this.toolRegistry.get(step.toolName);
                    if (typeof (toolInstance as unknown as ContextAwareTool).setContext === 'function' && channelContext) {
                        (toolInstance as unknown as ContextAwareTool).setContext(channelContext.chatId, channelContext.channel);
                    }
                    const recoveryResult = await this.proactiveRecovery.execute(
                        step.toolName, step.toolArgs as Record<string, unknown>, getTool, new Set<string>()
                    );
                    toolResult = recoveryResult.result;
                    if (recoveryResult.recovered && recoveryResult.recoveryNote) {
                        const kind = recoveryResult.mutationKind ?? 'arg_mutation';
                        log.info(
                            `[MUTATION] tool_mutation:\n  tool: ${recoveryResult.originalToolName ?? step.toolName}\n  kind: ${kind}\n` +
                            `  original: ${JSON.stringify(recoveryResult.originalArgs ?? {})}\n` +
                            `  modified: ${JSON.stringify(recoveryResult.finalArgs)}`
                        );
                        stepMutations = [{
                            originalTool: recoveryResult.originalToolName ?? step.toolName,
                            finalTool: recoveryResult.finalToolName,
                            originalArgs: recoveryResult.originalArgs ?? step.toolArgs as Record<string, unknown>,
                            finalArgs: recoveryResult.finalArgs,
                            kind,
                        }];
                    }
                }
            } else {
                // Sem tool específica → chama AgentLoop com prompt focado no step
                const cognitiveBlock = this.buildIncrementalExecutionContext(goal, step);
                const focusLine = goal.cycleFocus
                    ? `\nFoco do ciclo: ${goal.cycleFocus}`
                    : '';
                const targetFile = this.extractTargetFileFromStep(step, goal);
                const reflectionLine = targetFile
                    ? `\n[REFLEXÃO] Arquivo alvo desta tarefa: ${targetFile}\nAntes de usar qualquer ferramenta, confirme que o arquivo corresponde ao alvo acima.`
                    : '';
                const stepPrompt = [
                    `[GOAL STEP] ${this.sanitizeStepDescription(step.description)}`,
                    `\nContexto do objetivo: ${goal.objective}`,
                    focusLine,
                    reflectionLine,
                    cognitiveBlock ? `\n${cognitiveBlock}` : '',
                ].join('');
                const [goalCh, sessionUserId] = goal.sessionKey.split(':');
                const stepSessionKey = { channel: goalCh ?? 'unknown', userId: sessionUserId ?? goal.conversationId };
                this.sessionManager?.resetTurnToolCounts(stepSessionKey);
                const response = await this.agentLoop.process(
                    goal.conversationId,
                    stepPrompt,
                    sessionUserId ?? goal.conversationId,
                    channelContext
                );
                const text = typeof response === 'string' ? response : response.text;
                const respOptions = typeof response === 'string' ? undefined : response.options;

                // Guarda de saída: step-name usado como path de arquivo (CR#5)
                const invalidPath = this.detectStepNameAsPath(text);
                if (invalidPath) {
                    log.warn(`[GoalStep] step-name-as-path detected: "${invalidPath}" step=${step.id} — marking failure`);
                    const errorMsg = `Path inválido na resposta: "${invalidPath}" é um identificador de step, não um arquivo.`;
                    this.goalStore.addAttempt(goal.id, {
                        id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
                        planStepId: step.id,
                        toolName: 'agentloop',
                        args: {},
                        result: 'failure',
                        output: text.slice(0, 300),
                        error: errorMsg,
                        durationMs: Date.now() - startMs,
                        executedAt: Date.now(),
                        cycle,
                    });
                    return this.evaluator.evaluate(goal, step, { success: false, output: text, error: errorMsg });
                }

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
                        cycle,
                    });
                    return { outcome: 'needs_auth' as const, confidence: 0.9, output: text, authOptions: authOpts };
                }

                // Heurística determinística avalia se o step teve sucesso
                const stepEval = this.evaluateAgentStepSuccess(step, goal.objective, text);
                let finalSuccess = stepEval.success;
                if (stepEval.shouldEscalateToLLM) {
                    log.info(`[GoalStep] heuristic inconclusive (conf=${stepEval.confidence.toFixed(2)}) — escalating to LLM`);
                    finalSuccess = await this.escalateStepEvalToLLM(step, goal.objective, text);
                }
                stepEvalForAttempt = { confidence: stepEval.confidence, reason: stepEval.reason };
                toolResult = { success: finalSuccess, output: text };
            }

            // Registrar attempt com auditoria completa (cycle, mutations, evaluation)
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
                cycle,
                mutations: stepMutations,
                evaluation: stepEvalForAttempt,
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
                cycle,
            };
            this.goalStore.addAttempt(goal.id, attempt);

            const cycleResult = this.evaluator.evaluate(goal, step, { success: false, output: '', error: errorMsg });
            log.warn(`[GoalStep] goal=${goal.id} step=${step.id} tool=${step.toolName ?? 'unknown'} EXCEPTION durationMs=${durationMs} error="${errorMsg.slice(0, 100)}"`);
            return cycleResult;
        }
    }

    // ── Step success evaluator (heurística + LLM escalation) ───────────────────

    /**
     * Avalia via heurística determinística se a resposta do AgentLoop indica sucesso.
     * Retorna StepEvaluation com confidence e flag de escalation.
     *
     * Escalation para LLM ocorre SOMENTE quando:
     *   - confidence < 0.6 (sinal ambíguo — output misto de erro e sucesso)
     *   - ferramenta desconhecida sem sinal claro
     *
     * Ordem de precedência:
     *  1. Sinais explícitos de falha → success=false, conf=0.95
     *  2. Sinais explícitos de sucesso → success=true, conf=0.90
     *  3. Resposta substancial sem sinal claro → success=true, conf=0.50 → escalation
     *  4. Resposta vazia/curta → success=false, conf=0.85
     */
    private evaluateAgentStepSuccess(
        step: PlanStep,
        _objective: string,
        response: string,
    ): StepEvaluation {
        const text = response.slice(0, 500);

        // Sinais explícitos de falha (alta confiança)
        const failurePattern = /\b(erro|falhou|não consegui|não foi possível|failed|error:|cannot|não pude|sem sucesso|bloqueado|não encontr[ao]d[ao]|command not found|ENOENT|Traceback|permission denied|exit code: [^0])\b/i;
        if (failurePattern.test(text)) {
            log.debug(`[GoalLoop] step-heuristic: failure signal tool=${step.toolName ?? 'agentloop'}`);
            return { success: false, confidence: 0.95, reason: 'failure_signal_detected' };
        }

        // Sinais explícitos de sucesso (alta confiança)
        const successPattern = /\b(conclu[íi]d[ao]|✓|✅|criado|gerado|enviado|salvo|feito|pronto|sucesso|executado|funcionou|ok\b|done\b)\b/i;
        if (successPattern.test(text)) {
            log.debug(`[GoalLoop] step-heuristic: success signal tool=${step.toolName ?? 'agentloop'}`);
            return { success: true, confidence: 0.90, reason: 'success_signal_detected' };
        }

        // Resposta vazia ou muito curta (provavelmente falha silenciosa)
        if (response.trim().length < 15) {
            log.debug(`[GoalLoop] step-heuristic: empty/short response tool=${step.toolName ?? 'agentloop'}`);
            return { success: false, confidence: 0.85, reason: 'empty_response' };
        }

        // Zona ambígua — resposta substancial sem sinal claro
        // Escalation para LLM só quando: output >= 15 chars mas sem sinal direto
        const isAmbiguous = response.trim().length >= 15 && response.trim().length < 200;
        if (isAmbiguous) {
            log.debug(`[GoalLoop] step-heuristic: ambiguous (${response.trim().length} chars) → escalation tool=${step.toolName ?? 'agentloop'}`);
            return { success: false, confidence: 0.50, reason: 'ambiguous_output', shouldEscalateToLLM: true };
        }

        // Resposta longa sem sinal de falha → assume progresso (conservador)
        log.debug(`[GoalLoop] step-heuristic: long response — assuming success tool=${step.toolName ?? 'agentloop'}`);
        return { success: true, confidence: 0.70, reason: 'substantial_response' };
    }

    /**
     * Escalation path: usado apenas quando a heurística retorna confidence < 0.6.
     * Chama LLM com prompt compacto (sem system prompt completo) para decidir sucesso/falha.
     * Fail-safe: qualquer erro → assume success=true (conservador, evita loops de replan).
     */
    private async escalateStepEvalToLLM(
        step: PlanStep,
        objective: string,
        agentResponse: string,
    ): Promise<boolean> {
        const prompt = `Avalie se o seguinte output indica SUCESSO ou FALHA na execução desta tarefa.

TAREFA: ${step.description.slice(0, 200)}
OBJETIVO: ${objective.slice(0, 150)}
OUTPUT: ${agentResponse.slice(0, 400)}

Responda APENAS com JSON: {"success": true} ou {"success": false}`;

        try {
            const result = await this.providerFactory.chatWithFallback(
                [{ role: 'user', content: prompt }] as LLMMessage[],
                undefined,
                undefined,
                15_000,
            );
            if (result.status !== 'success') return true;
            const cleaned = result.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const parsed = JSON.parse(cleaned);
            log.info(`[GoalStep] LLM escalation result: success=${parsed.success} step=${step.id}`);
            return Boolean(parsed.success);
        } catch {
            log.warn(`[GoalStep] LLM escalation failed — defaulting to success=true step=${step.id}`);
            return true;
        }
    }

    // ── CR#5: Proteção contra step-name-as-path ───────────────────────────────

    /**
     * Remove tokens que parecem IDs de step da descrição antes de enviar ao AgentLoop.
     * Evita que "identificar_no_step_1" seja interpretado como argumento de ferramenta.
     */
    private sanitizeStepDescription(description: string): string {
        return description
            .replace(/\b(identificar|verificar|analisar|executar|criar|enviar)_no_step_\d+\b/gi, '')
            .replace(/\bARQUIVO_(ENCONTRADO|ATUAL|ALVO|TARGET)\b/gi, '')
            .replace(/\bstep_id[:=]\s*\S+/gi, '')
            .trim();
    }

    /**
     * Extrai o arquivo alvo do step para injetar como reflexão no prompt (CR#6).
     * Tenta toolArgs primeiro, depois padrão de extensão na description,
     * e como fallback o último write/edit registrado nas attempts do goal.
     */
    private extractTargetFileFromStep(step: PlanStep, goal: Goal): string | null {
        if (step.toolArgs?.path) return String(step.toolArgs.path);
        if (step.toolArgs?.file_path) return String(step.toolArgs.file_path);

        const fileMatch = step.description.match(/[\w\-/.]+\.(html|js|ts|py|json|css|md|txt|pptx|pdf)/i);
        if (fileMatch) return fileMatch[0];

        const lastWrite = [...goal.attempts]
            .reverse()
            .find(a => (a.toolName === 'write' || a.toolName === 'edit') && a.result === 'success');
        if (lastWrite?.args?.path) return String(lastWrite.args.path);

        return null;
    }

    /**
     * Guarda de saída: detecta quando o AgentLoop usou um nome de step como path de arquivo.
     * Retorna o token problemático se encontrado, null caso contrário.
     */
    private detectStepNameAsPath(agentResponse: string): string | null {
        const STEP_PATH_PATTERNS: RegExp[] = [
            /Arquivo não encontrado:[^\n]*\/(identificar_\w+)(?!\.[a-z]{2,4})/i,
            /Arquivo não encontrado:[^\n]*\/(ARQUIVO_[A-Z_]+)(?!\.[a-z]{2,4})/i,
            /Arquivo não encontrado:[^\n]*\/(step_\d+)(?!\.[a-z]{2,4})/i,
            /Arquivo não encontrado:[^\n]*\/(goal_\w+)(?!\.[a-z]{2,4})/i,
            /ENOENT[^\n]*\/(identificar_\w+)(?!\.[a-z]{2,4})/i,
        ];
        for (const pattern of STEP_PATH_PATTERNS) {
            const match = agentResponse.match(pattern);
            if (match?.[1]) return match[1];
        }
        return null;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private markStepDone(goal: Goal, step: PlanStep, output: string): void {
        const updatedPlan = goal.currentPlan.map(s =>
            s.id === step.id ? { ...s, status: 'completed' as const, result: output.slice(0, 200), executedAt: Date.now() } : s
        );
        this.goalStore.update(goal.id, { currentPlan: updatedPlan });

        // Após instalação bem-sucedida de dependência, invalida tools + execution
        // para que o próximo replan detecte a ferramenta recém-instalada.
        if (step.id.startsWith('install_')) {
            this.capRegistry.invalidate('tools');
            this.capRegistry.invalidate('execution');
            log.info(`[GoalLoop] dep install step=${step.id} completed — capability cache invalidated`);
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

    // ── Contexto cognitivo persistente (P15 → P16) ───────────────────────────

    /**
     * Deriva o contexto cognitivo diretamente de `goal.attempts` e `goal.strategiesTried`,
     * eliminando a dependência do StepCognitiveContext in-memory.
     *
     * Vantagem sobre buildPreviousStepsContext: sobrevive a restarts do processo,
     * pois tudo é derivado do estado persistido no GoalStore (SQLite).
     *
     * Mapeamento de toolName → categoria:
     *   file_read / read_document → filesRead
     *   write / edit              → filesModified
     *   send_document / audio     → generatedArtifacts
     *   exec_command              → executedCommands
     *   goal.strategiesTried      → failedStrategies
     *   attempt.discoveries       → discoveries (ProactiveRecovery + step)
     */
    private buildIncrementalExecutionContext(goal: Goal, currentStep: PlanStep): string {
        const attempts = goal.attempts;

        // ── Derivar categorias a partir de goal.attempts ─────────────────────
        const filesRead: Array<{ path: string; summary?: string }> = [];
        const filesModified: string[] = [];
        const generatedArtifacts: string[] = [];
        const executedCommands: string[] = [];
        const importantOutputs: string[] = [];
        const discoveries: string[] = [];

        const seenPaths = new Set<string>();

        for (const attempt of attempts) {
            if (attempt.result === 'failure') continue; // só attempts bem-sucedidos para contexto positivo

            const pathArg = String(attempt.args['path'] ?? attempt.args['file_path'] ?? '');

            if (['file_read', 'read_document'].includes(attempt.toolName)) {
                if (pathArg && !seenPaths.has(`read:${pathArg}`)) {
                    seenPaths.add(`read:${pathArg}`);
                    filesRead.push({ path: pathArg, summary: attempt.output?.slice(0, 100).replace(/\n/g, ' ') });
                }
            } else if (['write', 'edit'].includes(attempt.toolName)) {
                if (pathArg && !seenPaths.has(`mod:${pathArg}`)) {
                    seenPaths.add(`mod:${pathArg}`);
                    filesModified.push(pathArg);
                }
            } else if (['send_document', 'send_audio'].includes(attempt.toolName)) {
                if (pathArg && !seenPaths.has(`art:${pathArg}`)) {
                    seenPaths.add(`art:${pathArg}`);
                    generatedArtifacts.push(pathArg);
                }
            } else if (attempt.toolName === 'exec_command') {
                const cmd = String(attempt.args['command'] ?? '');
                if (cmd && !executedCommands.includes(cmd.slice(0, 120))) {
                    executedCommands.push(cmd.slice(0, 120));
                }
            }

            // Outputs relevantes de attempts recentes bem-sucedidos
            if (attempt.output && attempt.output.length > 30) {
                importantOutputs.push(attempt.output.slice(0, 200).replace(/\n+/g, ' '));
            }

            // Descobertas anotadas explicitamente (campo novo do GoalAttempt)
            if (attempt.discoveries?.length) {
                for (const d of attempt.discoveries) {
                    if (!discoveries.includes(d)) discoveries.push(d);
                }
            }
        }

        // ── Montar bloco de contexto ──────────────────────────────────────────
        const completedSteps = goal.currentPlan
            .filter(s => s.status === 'completed' && s.result && s.id !== currentStep.id)
            .slice(-3);

        const lines: string[] = ['[CONTEXTO COGNITIVO — leia antes de executar]'];

        if (goal.isConstruction && goal.roadmap && goal.roadmap.length > 0) {
            lines.push('\n🚧 MODO CONSTRUÇÃO INCREMENTAL ATIVO 🚧');
            lines.push('Roadmap do projeto:');
            for (let i = 0; i < goal.roadmap.length; i++) {
                const marker = i === goal.currentMilestoneIndex ? '👉' : (i < (goal.currentMilestoneIndex ?? 0) ? '✓' : ' ');
                lines.push(`  ${marker} Marco ${i + 1}: ${goal.roadmap[i]}`);
            }
            const activeMilestone = goal.roadmap[goal.currentMilestoneIndex ?? 0];
            lines.push(`\nFoco atual (MARCO ${ (goal.currentMilestoneIndex ?? 0) + 1 }): ${activeMilestone}`);
        }

        if (goal.cycleFocus) {
            lines.push(`\nFoco do ciclo atual: ${goal.cycleFocus}`);
        }

        if (completedSteps.length > 0) {
            lines.push('\nSteps já executados:');
            for (const s of completedSteps) {
                lines.push(`  ✓ ${s.description}: ${(s.result ?? '').slice(0, 150)}`);
            }
        }

        if (filesRead.length > 0) {
            lines.push('\nArquivos já lidos (NÃO reler sem necessidade):');
            for (const f of filesRead.slice(-8)) {
                lines.push(`  • ${f.path}${f.summary ? ` — ${f.summary}` : ''}`);
            }
        }

        if (filesModified.length > 0) {
            lines.push('\nArquivos modificados nesta sessão:');
            for (const f of filesModified.slice(-5)) {
                lines.push(`  • ${f}`);
            }
        }

        if (generatedArtifacts.length > 0) {
            lines.push('\nArtefatos já gerados (verificar antes de regenerar):');
            for (const a of generatedArtifacts.slice(-5)) {
                lines.push(`  • ${a}`);
            }
        }

        if (goal.strategiesTried.length > 0) {
            lines.push('\nEstratégias que falharam (NÃO repetir):');
            for (const f of goal.strategiesTried.slice(-4)) {
                lines.push(`  ✗ ${f}`);
            }
        }

        if (importantOutputs.length > 0) {
            lines.push('\nOutputs relevantes dos steps anteriores:');
            for (const o of importantOutputs.slice(-3)) {
                lines.push(`  → ${o}`);
            }
        }

        if (executedCommands.length > 0) {
            lines.push('\nComandos executados com sucesso:');
            for (const c of executedCommands.slice(-5)) {
                lines.push(`  $ ${c}`);
            }
        }

        if (discoveries.length > 0) {
            lines.push('\nDescobertas automáticas (recovery / mutations):');
            for (const d of discoveries.slice(-4)) {
                lines.push(`  ℹ ${d}`);
            }
        }

        // Log de observabilidade: mede reuso de contexto
        const ctxItems = filesRead.length + filesModified.length + generatedArtifacts.length + executedCommands.length;
        if (ctxItems > 0) {
            log.debug(`[GoalLoop] ctx_reuse goal=${goal.id} step=${currentStep.id} reads=${filesRead.length} mods=${filesModified.length} artifacts=${generatedArtifacts.length} cmds=${executedCommands.length} strategies=${goal.strategiesTried.length}`);
        }

        if (lines.length === 1) return '';

        lines.push('\n[FIM DO CONTEXTO COGNITIVO]');
        return lines.join('\n');
    }

    /**
     * Atualiza o cognitiveContext com os resultados de um step concluído.
     * Extrai via pattern matching: arquivos lidos, comandos, artefatos.
     */
    private updateCognitiveContext(step: PlanStep, output: string): void {
        const ctx = this.cognitiveContext;
        const text = output.slice(0, 800);

        // Arquivos lidos (via file_read tool ou padrões no output)
        if (step.toolName === 'file_read' || step.toolName === 'read_document') {
            const pathArg = step.toolArgs?.path ?? step.toolArgs?.file_path;
            if (typeof pathArg === 'string' && pathArg) {
                const alreadyTracked = ctx.filesRead.some(f => f.path === pathArg);
                if (!alreadyTracked) {
                    const summary = text.slice(0, 100).replace(/\n/g, ' ');
                    ctx.filesRead.push({ path: pathArg, summary: summary || undefined });
                }
            }
        }

        // Arquivos modificados (write/edit)
        if (step.toolName === 'write' || step.toolName === 'edit') {
            const pathArg = step.toolArgs?.path ?? step.toolArgs?.file_path;
            if (typeof pathArg === 'string' && pathArg && !ctx.filesModified.includes(pathArg)) {
                ctx.filesModified.push(pathArg);
            }
        }

        // Artefatos gerados (send_document, arquivos com extensão conhecida no output)
        if (step.toolName === 'send_document' || step.toolName === 'send_audio') {
            const pathArg = step.toolArgs?.path ?? step.toolArgs?.file_path;
            if (typeof pathArg === 'string' && pathArg && !ctx.generatedArtifacts.includes(pathArg)) {
                ctx.generatedArtifacts.push(pathArg);
            }
        }

        // Extrai caminhos de arquivos mencionados no output (ex: "criou /workspace/foo.pdf")
        const artifactMatches = text.matchAll(/(?:criou|gerou|salvo|saved|created?|written?)\s+[`'"]?(\/?[\w./\\-]+\.\w{2,5})[`'"]?/gi);
        for (const m of artifactMatches) {
            if (!ctx.generatedArtifacts.includes(m[1])) {
                ctx.generatedArtifacts.push(m[1]);
            }
        }

        // Comandos executados
        if (step.toolName === 'exec_command') {
            const cmd = step.toolArgs?.command;
            if (typeof cmd === 'string' && cmd && !ctx.executedCommands.includes(cmd)) {
                ctx.executedCommands.push(cmd.slice(0, 120));
            }
        }

        // Outputs importantes (sucesso com conteúdo útil)
        if (text.length > 30) {
            const shortOutput = text.slice(0, 200).replace(/\n+/g, ' ');
            ctx.importantOutputs.push(shortOutput);
            // Limitar a 6 outputs
            if (ctx.importantOutputs.length > 6) ctx.importantOutputs.shift();
        }

        // Leitura de arquivos via exec_command (cat, head, etc.)
        if (step.toolName === 'exec_command') {
            const catMatch = (step.toolArgs?.command as string | undefined)?.match(/\bcat\s+([^\s|;&]+)/);
            if (catMatch?.[1] && !ctx.filesRead.some(f => f.path === catMatch[1])) {
                ctx.filesRead.push({ path: catMatch[1] });
            }
        }
    }

    /**
     * Q1 — Contextualização espiral: enriquece o entendimento do objetivo antes de cada
     * ciclo de planejamento, consultando memória semântica e padrões de reflexão.
     * (Inlined de GoalContextualizer para reduzir fragmentação.)
     */
    private async contextualize(goal: Goal, cycleNumber: number, priorFeedback?: string): Promise<string> {
        const parts: string[] = [];

        // Memória semântica relevante ao objetivo
        try {
            const nodes = await this.memory.semanticSearch(goal.userIntent, 3);
            const relevant = nodes.filter(n => n.content && n.content.trim().length > 10);
            if (relevant.length > 0) {
                const lines = relevant.map(n => `- [${n.type}] ${String(n.content).slice(0, 150)}`);
                parts.push(`Contexto da memória (relevante ao objetivo):\n${lines.join('\n')}`);
            }
        } catch (err) {
            log.warn('[GoalLoop] Q1 memory search error:', String(err));
        }

        // Padrões de falha conhecidos (tools já tentadas)
        const failureHints = goal.toolsTried
            .map(t => this.reflectionMemory.buildContextHint(`tool_${t}`))
            .filter(Boolean);
        if (failureHints.length > 0) {
            parts.push(`Histórico de execuções com ferramentas já usadas:\n${failureHints.join('\n')}`);
        }

        // Feedback do ciclo anterior (Q4 → Q1)
        if (priorFeedback && cycleNumber > 1) {
            parts.push(
                `Análise do ciclo ${cycleNumber - 1} (o que não funcionou):\n` +
                `${priorFeedback}\n` +
                `→ Ajuste a estratégia para resolver especificamente este problema.`
            );
        }

        const context = parts.join('\n\n');
        if (context) {
            log.info(`[GoalLoop] Q1 cycle=${cycleNumber} context_len=${context.length}`);
        }
        return context;
    }

    /**
     * Registra uma estratégia que falhou para evitar repetição nos próximos steps.
     * Persiste em goalStore.strategiesTried (SQLite) para sobreviver a restarts.
     * O cognitiveContext.failedStrategies é mantido como cache in-memory (compatibilidade).
     */
    private recordFailedStrategy(step: PlanStep, reason: string, goalId?: string): void {
        const strategy = step.toolName
            ? `${step.toolName}: ${step.description.slice(0, 80)}`
            : step.description.slice(0, 100);
        const entry = `${strategy} — ${reason.slice(0, 80)}`;

        // Persiste no GoalStore (durável, read-by buildIncrementalExecutionContext)
        if (goalId) {
            this.goalStore.addStrategyTried(goalId, entry);
        }

        // Cache in-memory para a sessão atual (compatibilidade com código legado)
        if (!this.cognitiveContext.failedStrategies.includes(entry)) {
            this.cognitiveContext.failedStrategies.push(entry);
            if (this.cognitiveContext.failedStrategies.length > 6) {
                this.cognitiveContext.failedStrategies.shift();
            }
        }
    }

    /**
     * Pergunta ao LLM se o objetivo foi realmente atingido após todos os steps concluírem.
     * Fallback conservador: assume achieved=true em caso de erro (evita loop infinito).
     */
    /**
     * Avalia cada critério do checklist deterministicamente contra os attempts do goal.
     * Retorna os critérios com status atualizado e um indicador global:
     *   - 'all_met'       → todos cumpridos, sem precisar de LLM
     *   - 'some_pending'  → pelo menos 1 pendente que não pôde ser determinado
     *   - 'clearly_unmet' → pelo menos 1 critério visivelmente não cumprido
     */
    private evaluateCriteria(goal: Goal): {
        result: 'all_met' | 'some_pending' | 'clearly_unmet';
        updated: SuccessCriterion[];
        metCount: number;
        summary: string;
    } {
        if (!goal.successCriteria || goal.successCriteria.length === 0) {
            return { result: 'some_pending', updated: [], metCount: 0, summary: '' };
        }

        const updated: SuccessCriterion[] = goal.successCriteria.map(c => ({ ...c }));
        const successAttempts = goal.attempts.filter(a => a.result === 'success');

        for (const criterion of updated) {
            if (criterion.status === 'met') continue; // já confirmado anteriormente

            const relevant = criterion.tool
                ? successAttempts.filter(a => a.toolName === criterion.tool)
                : successAttempts;

            switch (criterion.check) {
                case 'tool_succeeded': {
                    if (relevant.length > 0) {
                        criterion.status = 'met';
                        criterion.metAt = Date.now();
                        criterion.evidence = relevant[relevant.length - 1].output?.slice(0, 120);
                    } else {
                        criterion.status = 'unverifiable';
                    }
                    break;
                }
                case 'output_contains': {
                    const match = relevant.find(a => a.output?.includes(criterion.value ?? ''));
                    if (match) {
                        criterion.status = 'met';
                        criterion.metAt = Date.now();
                        criterion.evidence = match.output?.slice(0, 120);
                    } else if (relevant.length > 0) {
                        // Há attempts mas nenhum contém o valor esperado — critério não cumprido
                        criterion.status = 'unverifiable'; // aguarda mais execução
                    } else {
                        criterion.status = 'unverifiable';
                    }
                    break;
                }
                case 'output_not_contains': {
                    // Precisa de pelo menos um attempt com output para avaliar
                    const withOutput = relevant.filter(a => a.output && a.output.trim().length > 0);
                    if (withOutput.length > 0) {
                        const lastOutput = withOutput[withOutput.length - 1].output ?? '';
                        if (!lastOutput.includes(criterion.value ?? '')) {
                            criterion.status = 'met';
                            criterion.metAt = Date.now();
                            criterion.evidence = `"${criterion.value}" não encontrado no output`;
                        } else {
                            criterion.status = 'unverifiable'; // ainda presente
                        }
                    } else {
                        criterion.status = 'unverifiable';
                    }
                    break;
                }
                case 'file_exists': {
                    // exec_command com output não-vazio = arquivo encontrado
                    const found = relevant.find(a => a.output && a.output.trim().length > 0);
                    if (found) {
                        criterion.status = 'met';
                        criterion.metAt = Date.now();
                        criterion.evidence = found.output?.slice(0, 80);
                    } else {
                        criterion.status = 'unverifiable';
                    }
                    break;
                }
            }
        }

        const metCount = updated.filter(c => c.status === 'met').length;
        const allMet = metCount === updated.length;
        const metLabels = updated
            .map(c => `${c.id}:${c.status === 'met' ? '✅' : '⏳'}`)
            .join(' ');

        log.info(`[GoalLoop] criteria evaluation: ${metLabels} (${metCount}/${updated.length} met)`);

        return {
            result: allMet ? 'all_met' : 'some_pending',
            updated,
            metCount,
            summary: updated
                .filter(c => c.status === 'met')
                .map(c => c.description)
                .join('; '),
        };
    }

    private async validateGoalCompletion(goal: Goal, activeMilestone?: string): Promise<{
        achieved: boolean;
        summary?: string;
        reason?: string;
        suggestions?: string[];
    }> {
        // ── 1. Verificação determinística via checklist (sem LLM) ─────────────────
        const criteriaEval = this.evaluateCriteria(goal);
        if (criteriaEval.result === 'all_met' && criteriaEval.metCount > 0) {
            // Persiste o estado atualizado dos critérios no store
            this.goalStore.update(goal.id, { successCriteria: criteriaEval.updated });
            log.info(`[GoalLoop] LLM validation: todos os critérios cumpridos — achieved=true sem LLM`);
            return { achieved: true, summary: criteriaEval.summary || 'Todos os critérios do checklist foram satisfeitos.' };
        }
        // Persiste atualizações parciais (critérios recém-marcados como met)
        if (criteriaEval.updated.length > 0) {
            this.goalStore.update(goal.id, { successCriteria: criteriaEval.updated });
        }

        const stepsContext = goal.currentPlan
            .filter(s => s.status === 'completed')
            .map(s => `- ${s.description}: ${s.result || '(sem output)'}`)
            .join('\n');

        const attemptsContext = goal.attempts
            .filter(a => a.result === 'success')
            .map(a => `- ${a.toolName}: ${a.output || '(sem output)'}`)
            .join('\n');

        const validationTarget = activeMilestone
            ? `MARCO ATUAL A SER VALIDADO: ${activeMilestone}\n(Objetivo Global do Projeto: ${goal.objective})`
            : `OBJETIVO: ${goal.objective}`;

        const prompt = `Você é um validador de tarefas de software. Verifique se o objetivo especificado foi COMPLETAMENTE concluído.

ALVO DE VALIDAÇÃO:
${validationTarget}

INTENÇÃO ORIGINAL DO USUÁRIO: ${goal.userIntent}

STEPS EXECUTADOS RECENTEMENTE:
${stepsContext || '(nenhum)'}

RESULTADOS DAS FERRAMENTAS:
${attemptsContext || '(nenhum)'}

IMPORTANTE — INTERPRETAÇÃO DE OUTPUTS:
- Comandos de edição in-place (sed -i, python3 -c com open().write(), etc.) produzem SAÍDA VAZIA quando bem-sucedidos. Output vazio = SUCESSO para esses comandos.
- Se o resultado de uma ferramenta exec_command está vazio e não há mensagem de erro, assuma que o comando foi bem-sucedido.
- Se alguma leitura posterior (read, exec_command grep) mostra o conteúdo modificado, isso confirma a edição.

Análise crítica: o objetivo ou marco atual foi atingido E o resultado/entregável esperado foi produzido com sucesso?
Se for um marco de desenvolvimento, verifique se os arquivos/funcionalidades desse marco foram realmente criados e testados.

Responda APENAS com JSON válido (sem markdown):
{"achieved": true, "summary": "resumo do que foi feito e entregue neste marco/objetivo"}
OU
{"achieved": false, "reason": "o que está faltando para concluir este marco/objetivo", "suggestions": ["ação 1", "ação 2"]}`;

        let llmResult: Awaited<ReturnType<typeof this.providerFactory.chatWithFallback>> | undefined;
        try {
            llmResult = await this.providerFactory.chatWithFallback(
                [{ role: 'user', content: prompt }] as LLMMessage[],
                undefined,
                undefined,
                45_000,
            );

            if (llmResult.status !== 'success') {
                log.warn('[GoalLoop] LLM validation failed — assuming achieved');
                return { achieved: true };
            }

            const cleaned = llmResult.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const parsed = JSON.parse(cleaned);
            log.info(`[GoalLoop] LLM validation: achieved=${parsed.achieved}${parsed.reason ? ` reason="${parsed.reason}"` : ''}`);
            return {
                achieved: Boolean(parsed.achieved),
                summary: parsed.summary,
                reason: parsed.reason,
                suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : undefined,
            };
        } catch (err) {
            // LLM respondeu em texto livre (ex: thinking recovered de timeout) → não confirma sucesso
            if (err instanceof SyntaxError && llmResult?.status === 'success' && llmResult.content.length > 50) {
                log.warn('[GoalLoop] validation response not JSON — treating as goal_incomplete');
                return { achieved: false, reason: 'LLM de validação não retornou JSON válido' };
            }
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
        // Imagens só são entregáveis se o objetivo explícito for produzir imagens.
        // Excluir quando o intent contém marcadores de VisionHandler ("[IMAGEM RECEBIDA:")
        // ou quando o intent menciona slides/pptx (foto enviada como feedback, não entregável).
        const isImageDeliveryIntent =
            /png|jpg|jpeg|imagem|image/i.test(lower) &&
            !lower.includes('[imagem recebida:') &&
            !/slides?|pptx|apresenta|powerpoint/i.test(lower);
        if (isImageDeliveryIntent) exts.push('.png', '.jpg', '.jpeg');
        return exts;
    }

    /**
     * Busca arquivos criados APÓS o início do goal com as extensões esperadas.
     * goalCreatedAt garante que arquivos pré-existentes no workspace não sejam
     * enviados como entregáveis do goal atual (ex: imagens promocionais do sistema).
     */
    private async checkDeliverables(extensions: string[], goalCreatedAt: number): Promise<string[]> {
        const execTool = this.toolRegistry.get('exec_command');
        if (!execTool) return [];

        // Calcula a idade do goal em minutos + 1 min de buffer para clock skew
        const ageMinutes = Math.max(1, Math.ceil((Date.now() - goalCreatedAt) / 60_000) + 1);
        const nameTests = extensions.map(e => `-name "*${e}"`).join(' -o ');
        // -mmin -N: modificado nos últimos N minutos — só arquivos criados durante este goal
        const cmd = `find /tmp /workspace . -maxdepth 4 -mmin -${ageMinutes} \\( ${nameTests} \\) 2>/dev/null | head -5`;

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
            (goal.cycleFocus ? ` focus="${goal.cycleFocus}"` : '') +
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
