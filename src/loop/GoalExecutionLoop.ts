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

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { createLogger } from '../shared/AppLogger';
import { AgentLoop } from './AgentLoop';
import { traceManager } from '../core/ExecutionTrace';
import { GoalStore } from './GoalStore';
import { GoalPlanner } from './GoalPlanner';
import { GoalEvaluator } from './GoalEvaluator';
import { RiskAnalyzer } from './RiskAnalyzer';
import { CapabilityRegistry } from '../core/CapabilityRegistry';
import { ProactiveRecovery, ToolExecutorLike } from './ProactiveRecovery';
import { ToolRegistry } from '../core/ToolRegistry';
import { ReflectionMemory } from '../memory/ReflectionMemory';
import { CaseMemory } from '../memory/CaseMemory';
import { permissionRegistry } from '../core/PermissionRegistry';
import { MemoryManager } from '../memory/MemoryManager';
import { MultiLayerRetriever } from '../memory/MultiLayerRetriever';
import { ProviderFactory, LLMMessage } from '../core/ProviderFactory';
import { Goal, PlanStep, GoalAttempt, GoalBlocker, GoalResult, GoalProgressUpdate, CycleResult, StepCognitiveContext, StepEvaluation, createEmptyStepCognitiveContext, SuccessCriterion, GoalProgressModel, ProgressComponent, AttemptOutcome } from './GoalTypes';
import { StepSemanticValidator } from './StepSemanticValidator';
import { GracefulDeliveryOrchestrator } from './GracefulDeliveryOrchestrator';
import { StrategyDiversityGuard } from '../shared/StrategyDiversityGuard';
import { resolvePath } from '../utils/crossPlatform';
import { ensureDeliverySuccessCriteria, AUTO_DELIVERY_CRITERION_IDS } from './planning/ensureDeliverySuccessCriteria';
import { resolveInstallCommand } from './planning/resolveInstallCommand';
import { inferExpectedExtensions } from './planning/inferExpectedExtensions';
import { MIN_DELIVERABLE_SIZE } from './planning/artifactContract';
import { GOAL_LIMITS } from './GoalLimits';
import { ChannelContext, ContextAwareTool } from './agentLoopTypes';
import type { SessionManager } from '../session/SessionManager';
import { parseSessionKey } from '../session/SessionKeyFactory';

const log = createLogger('GoalExecutionLoop');

// Fallback quando nenhum critério "de conteúdo" (não auto-delivery) foi satisfeito — usado em
// validateGoalCompletion() E checado em buildResult() (mesma constante, não duplicar o literal)
// para preferir a saída real da última tool bem-sucedida quando disponível. Evidência real
// (05/07/2026, goal_1783273986121_ptyfp e goal_1783274167642_xqep6): usuário recebeu
// literalmente esta frase genérica como resposta a dois pedidos diferentes (análise de cripto
// com áudio, previsão do tempo com áudio) — nenhuma informação sobre o que foi de fato
// entregue, mesmo a tool (send_audio) já tendo retornado uma mensagem legível
// ("🔊 Áudio enviado com sucesso!").
const GENERIC_CRITERIA_SUMMARY = 'Todos os critérios do checklist foram satisfeitos.';

export type ProgressCallback = (update: GoalProgressUpdate) => Promise<void>;

/**
 * Estado cognitivo/de progresso de UMA execução de goal — criado localmente em `runLoop()`
 * (ponto de entrada compartilhado por `executeGoal`/`resumeGoal`) e propagado explicitamente
 * pela cadeia de chamadas, nunca guardado em campo de instância. Antes (Sprint 0.6, Front A),
 * `cognitiveContext`/`progressModel` eram campos `private` da classe — como `GoalExecutionLoop`
 * é singleton por processo, dois goals de sessões diferentes podiam ler/escrever o mesmo objeto
 * (concorrência real via `await`, ou vazamento sequencial garantido via `resumeGoal()`, que nunca
 * resetava os campos). Local a cada chamada elimina o compartilhamento por construção — não é
 * mais possível vazar entre goals, com ou sem reset disciplinado.
 */
interface GoalExecutionState {
    cognitiveContext: StepCognitiveContext;
    progressModel: GoalProgressModel | null;
}

export class GoalExecutionLoop {
    private readonly evaluator = new GoalEvaluator();
    private readonly riskAnalyzer: RiskAnalyzer;
    private readonly semanticValidator: StepSemanticValidator;
    private readonly gracefulDelivery = new GracefulDeliveryOrchestrator();
    private readonly capRegistry = CapabilityRegistry.getInstance();
    private readonly proactiveRecovery = new ProactiveRecovery();

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
        private readonly caseMemory: CaseMemory,
    ) {
        this.riskAnalyzer = new RiskAnalyzer(providerFactory, toolRegistry, reflectionMemory);
        this.semanticValidator = new StepSemanticValidator(providerFactory);
    }

    /** Forwards skill context to the planner before planning begins. */
    setSkillContext(context: string): void {
        this.planner.setSkillContext(context);
    }

    /** Propagates hot-reload model changes from the dashboard without restart. */
    updateInternalModels(plannerModel?: string, riskModel?: string): void {
        if (plannerModel) this.planner.setModel(plannerModel);
        if (riskModel)    this.riskAnalyzer.setModel(riskModel);
    }

    // ── Ponto de entrada principal ────────────────────────────────────────────

    async executeGoal(
        goal: Goal,
        channelContext: ChannelContext,
        onProgress?: ProgressCallback
    ): Promise<GoalResult> {
        log.info(`[GoalLoop] start goal=${goal.id} replanBudget=${goal.replanBudget}`);

        // S6/S7 (modo sombra): consulta de similaridade de PROBLEMA + Applicability Gate —
        // "já resolvi algo suficientemente relacionado a ESTE objetivo, com uma operação
        // compatível?" — disparada aqui porque goal.objective já existe e nenhum plano foi
        // escolhido ainda (a pergunta não pode depender do plano). findApplicableCasesShadow
        // reaproveita findRelevantCasesShadow internamente (mesma busca semântica, sem
        // duplicar) e só anota operationalIntent/operationalCompatibility por cima — ver
        // CaseMemory.ts para a justificativa completa (S7). Fire-and-forget: nunca aguardada,
        // nunca bloqueia a execução real do goal — latência de embedding (Ollama) e falhas de
        // rede ficam inteiramente isoladas do caminho crítico.
        void this.caseMemory.findApplicableCasesShadow(goal.objective).catch(() => []);
        // S6.5a: reaproveita o mesmo gatilho (início de todo goal) para tentar recuperar, em
        // lote pequeno, Casos que ficaram sem embedding por falha do provider — sem scheduler
        // novo, sem bloquear a execução real (também fire-and-forget).
        void this.caseMemory.backfillMissingEmbeddings().catch(() => {});

        // NOTA (Sprint 0.6, Front A): o estado cognitivo/de progresso não é mais inicializado
        // aqui — `runLoop()` (chamado abaixo, ponto de entrada compartilhado com `resumeGoal()`)
        // cria um `GoalExecutionState` novo e local a cada chamada. Isso elimina por construção
        // o vazamento que existia quando `resumeGoal()` reusava o estado de instância sem resetar.

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

        // S5 (modo sombra): consulta DIAGNÓSTICA — mede quantos Casos anteriores têm a mesma
        // assinatura de estratégia. Puramente observacional: o resultado NUNCA é usado para
        // alterar planResult.steps, o prompt já foi montado e enviado pelo planner acima.
        if (planResult.steps.length > 0) {
            const shadowCandidates = this.caseMemory.findSimilarShadow(planResult.steps);
            if (shadowCandidates.length > 0) {
                log.debug(
                    `[CASE-SHADOW-RECOVERY] goal=${goal.id} candidates=${shadowCandidates.length}` +
                    ` fingerprint="${StrategyDiversityGuard.fingerprint(planResult.steps)}"`
                );
            }
        }

        // Se o roadmap foi ajustado pelo planner durante o planejamento inicial
        if (goal.isConstruction && planResult.adjustedRoadmap && planResult.adjustedRoadmap.length > 0) {
            log.info(`[GoalLoop] roadmap adjusted during initial planning.`);
            this.goalStore.update(goal.id, { roadmap: planResult.adjustedRoadmap });
            goal = this.goalStore.getById(goal.id)!;
        }

        let rawPlan = planResult.steps;

        // ── Q2: Análise de Riscos (apenas planos complexos) ──────────────
        // Planos simples passam direto; Q2 só vale a latência em tarefas com
        // dependências entre steps (ex: exec cria arquivo → send_document envia)
        let initialPlan = rawPlan;
        if (this.isComplexPlan(rawPlan)) {
            const riskReport = await this.riskAnalyzer.analyze(goal, rawPlan, this.planner.getAvailableSkills());
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
            // Sprint 3.7B: BLOCK-HINTs do Q2 inicial → pré-injeta no GoalPlanner.
            // Se o plano inicial já tem exec_command com 100% de falha, avisa antes de executar.
            const initialBlockHints = riskReport.risks.filter(r => r.startsWith('[BLOCK-HINT]'));
            if (initialBlockHints.length > 0 && !(riskReport.skillHints && riskReport.skillHints.length > 0)) {
                const blockHintText =
                    `⚠️ RESTRIÇÕES DETECTADAS (padrões de falha histórica):\n` +
                    initialBlockHints.map(h => `- ${h.replace(/^\[BLOCK-HINT\]\s*/, '')}`).join('\n') +
                    `\n\nPrefer 'write' + 'send_document' diretamente, sem exec_command.`;
                log.info(`[GoalLoop] Q2 block-hints pre-injected (initial plan): ${initialBlockHints.length} hint(s)`);
                this.planner.setSkillContext(blockHintText);
            }
        } else {
            log.debug('[GoalLoop] Q2 skipped — simple plan');
        }

        this.logPlanAnalysis(goal.id, initialPlan, 'initial');

        // Critérios de sucesso calculados sobre o plano FINAL (pós Q2/RiskAnalyzer) — nunca
        // sobre o rawPlan pré-ajuste, que pode ter tools diferentes das que vão executar de
        // verdade. ensureDeliverySuccessCriteria garante determinsticamente um critério
        // tool_succeeded para send_document/send_audio quando presentes no plano final,
        // independente de o LLM ter lembrado de incluir isso em successCriteria.
        const initialCriteria = ensureDeliverySuccessCriteria(initialPlan, planResult.successCriteria ?? []);
        if (initialCriteria.length > 0) {
            log.info(`[GoalLoop] successCriteria stored: ${initialCriteria.map(c => `${c.id}(${c.check})`).join(', ')}`);
        }

        this.goalStore.update(goal.id, {
            currentPlan: initialPlan,
            status: 'executing',
            cycleFocus: planResult.strategy || undefined,
            successCriteria: initialCriteria,
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
        onProgress?: ProgressCallback,
        authStepArtifactPaths?: string[],
    ): Promise<GoalResult> {
        log.info(`[GoalLoop] resuming goal=${goal.id} after auth`);

        // Marca o step que estava aguardando auth como concluído. Modo 'add' (default)
        // corretamente: authStepOutput vem de uma execução real e distinta via WorkflowEngine
        // (GoalOrchestrator.resumeFromAuth), não de um executeStep() já rodado nesta passagem —
        // não é a mesma classe de duplicação do achado residual 2 (Sprint 0.8.2/0.8.3): o
        // attempt 'failure' anterior (bloqueio de permissão) e este 'success' (pós-aprovação)
        // representam duas execuções genuinamente distintas do step.
        const blockedStep = this.getPendingSteps(goal.currentPlan)[0];
        if (blockedStep) {
            this.markStepDone(goal, blockedStep, authStepOutput, 'add', authStepArtifactPaths);
        }

        // requiresAuth: false — Sprint 0.11, ver nota no branch 'needs_auth' acima.
        this.goalStore.update(goal.id, { status: 'executing', pendingTxnId: undefined, requiresAuth: false });
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

    // ── Accessor único de steps pendentes (ARCH-006) ───────────────────────────

    /**
     * Fonte única para "quais steps deste plano estão pendentes", opcionalmente
     * restrito a uma tool (ou lista de tools). Substitui os `.filter`/`.find`/`.some`
     * inline com `status === 'pending'` espalhados pelo arquivo — cada um recomputava
     * o mesmo predicado de forma independente, sem risco funcional individual, mas sem
     * fonte única do conceito "step pendente".
     */
    private getPendingSteps(plan: PlanStep[], toolName?: string | string[]): PlanStep[] {
        if (toolName === undefined) {
            return plan.filter(s => s.status === 'pending');
        }
        const names = Array.isArray(toolName) ? toolName : [toolName];
        return plan.filter(s => s.status === 'pending' && names.includes(s.toolName ?? ''));
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
        state: GoalExecutionState,
        forceQ2 = false,
    ): Promise<Goal> {
        // Q1: Contextualização — memória + feedback do ciclo anterior
        const q1Context = await this.contextualize(goal, cycleNumber, priorFeedback);

        // Capabilities summary no replan — registry serve do cache (TTL por categoria).
        const capSummary = await this.capRegistry.getCapabilitySummary();

        const activeMilestone = goal.isConstruction && goal.roadmap && goal.roadmap.length > 0
            ? goal.roadmap[goal.currentMilestoneIndex ?? 0]
            : undefined;

        // Replan com contexto enriquecido (inclui progresso dimensional acumulado)
        const planResult = await this.planner.replan(goal, blocker, q1Context ?? '', capSummary, activeMilestone, state.progressModel ?? undefined);

        // Se o roadmap foi ajustado pelo planner durante o replanejamento
        if (goal.isConstruction && planResult.adjustedRoadmap && planResult.adjustedRoadmap.length > 0) {
            log.info(`[GoalLoop] roadmap adjusted during replanning.`);
            this.goalStore.update(goal.id, { roadmap: planResult.adjustedRoadmap });
            goal = this.goalStore.getById(goal.id)!;
        }

        let rawPlan = planResult.steps;

        // Fix 3: valida diversidade pós-geração — o LLM pode ignorar as restrições de diversidade
        // injetadas no prompt e gerar um fingerprint idêntico ao de um plano que já falhou.
        // Nesse caso, substituímos por um step agentloop com instrução explícita de abordagem nova
        // em vez de executar silenciosamente um plano que com certeza vai falhar de novo.
        if (!StrategyDiversityGuard.isDiverse(rawPlan, goal, planResult.strategy)) {
            const violationFp = StrategyDiversityGuard.fingerprint(rawPlan);
            log.warn(
                `[DIVERSITY-VIOLATION] goal=${goal.id} cycle=${cycleNumber}` +
                ` fingerprint="${violationFp}"` +
                ` — LLM ignored diversity constraints; forcing free-form agentloop step`
            );
            this.goalStore.addStrategyTried(goal.id, `diversity_violation:${violationFp}`);
            goal = this.goalStore.getById(goal.id)!;
            // Este step não tem toolName → StrategyDiversityGuard.fingerprint() e o executor
            // tratam sua execução como 'agentloop' (o free-form catch-all). Incluir 'agentloop'
            // na lista "Não use" abaixo instruiria o step a proibir a própria ferramenta pela
            // qual ele inevitavelmente roda — uma autocontradição que o validador semântico
            // (Q4/SEMANTIC-MISMATCH) sempre detecta e derruba para 'blocked', queimando um ciclo
            // inteiro de replan sem chance de sucesso. Reproduzido ao vivo (auditoria 09/07,
            // ciclos 3 e 5): "a ferramenta executada foi a 'agentloop', que estava explicitamente
            // proibida no step".
            const exhaustedTools = StrategyDiversityGuard.extractExhaustedTools(goal)
                .filter(tool => tool !== 'agentloop');
            rawPlan = [{
                id: `step_diversity_fallback_${Date.now()}`,
                description: `[DIVERSIDADE FORÇADA] Estratégias anteriores com [${violationFp}] falharam. Use abordagem completamente diferente para: ${goal.objective.slice(0, 150)}${exhaustedTools.length > 0 ? `. Não use: ${exhaustedTools.join(', ')}` : ''}.`,
                status: 'pending' as const,
                fallbackSteps: [],
            }];
        }

        // P7: replan radical (zero overlap de tools) — mark SuccessCriteria como unverifiable
        // para forçar validação LLM completa no Q4 em vez de checklist desatualizado
        if (goal.successCriteria && goal.successCriteria.length > 0 && goal.currentPlan.length > 0) {
            const prevTools = new Set(goal.currentPlan.map(s => s.toolName ?? 'agentloop'));
            const newTools  = new Set(rawPlan.map(s => s.toolName ?? 'agentloop'));
            const hasOverlap = [...prevTools].some(t => newTools.has(t));

            if (!hasOverlap) {
                log.info(
                    `[GoalLoop] radical replan detected: goal=${goal.id}` +
                    ` prev_tools=[${[...prevTools].join(',')}]` +
                    ` new_tools=[${[...newTools].join(',')}]` +
                    ` — marking pending SuccessCriteria as unverifiable`
                );
                const updatedCriteria = goal.successCriteria.map(c =>
                    c.status === 'pending' ? { ...c, status: 'unverifiable' as const } : c
                );
                this.goalStore.update(goal.id, { successCriteria: updatedCriteria });
                goal = this.goalStore.getById(goal.id)!;
            }
        }

        // Q2: Análise de Riscos
        // Ativo quando: plano complexo (dependências entre steps)
        //           OU: forçado após Q4 falhar (objetivo não foi entregue)
        let finalPlan = rawPlan;
        if (forceQ2 || this.isComplexPlan(rawPlan)) {
            const riskReport = await this.riskAnalyzer.analyze(goal, rawPlan, this.planner.getAvailableSkills());
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
            // Sprint 3.7A: skill hints do Q2 → injeta skillContext no planner para o próximo replan
            // Isso garante que quando exec_command falha com uma ferramenta que tem skill cobrindo,
            // o GoalPlanner recebe as instruções da skill no próximo ciclo de replanning.
            // S6: injeta TODAS as skills detectadas (não só a primeira) e prefixa com instrução
            // explícita de AgentLoop — o modelo LLM tendia a interpretar o contexto da skill
            // como "script para exec_command" em vez de "instrução de comportamento sem toolName".
            if (riskReport.skillHints && riskReport.skillHints.length > 0) {
                const allHintTexts = riskReport.skillHints.map(h =>
                    `[SKILL: ${h.skillName}]\n` +
                    `⚠️ USE COMO INSTRUÇÃO DE COMPORTAMENTO: OMITA toolName neste step — NÃO use exec_command para invocar esta skill.\n` +
                    `O AgentLoop executará as instruções abaixo diretamente, sem subprocess:\n\n` +
                    h.skillContext
                ).join('\n\n---\n\n');
                const skillNames = riskReport.skillHints.map(h => h.skillName).join(', ');
                log.info(`[GoalLoop] Q2 skill context injected: skills=[${skillNames}] for next replan cycle=${cycleNumber}`);
                this.planner.setSkillContext(allHintTexts);
            }
            // Sprint 3.7B: BLOCK-HINTs do Q2 → injeta no GoalPlanner quando não há skill cobrindo.
            // Garante que exec_command com 100% de falha histórica gere instrução ativa no próximo plano.
            const blockHints = riskReport.risks.filter(r => r.startsWith('[BLOCK-HINT]'));
            if (blockHints.length > 0 && !(riskReport.skillHints && riskReport.skillHints.length > 0)) {
                const blockHintText =
                    `⚠️ RESTRIÇÕES DETECTADAS (padrões de falha histórica):\n` +
                    blockHints.map(h => `- ${h.replace(/^\[BLOCK-HINT\]\s*/, '')}`).join('\n') +
                    `\n\nNo próximo plano: use 'write' + 'send_document' diretamente, sem exec_command.`;
                log.info(`[GoalLoop] Q2 block-hints injected for next replan cycle=${cycleNumber}: ${blockHints.length} hint(s)`);
                this.planner.setSkillContext(blockHintText);
            }
        } else {
            log.debug(`[GoalLoop] Q2 skipped (replan cycle=${cycleNumber} — simple plan)`);
        }

        this.logPlanAnalysis(goal.id, finalPlan, 'replan');

        // Funde os critérios semânticos preservados (tudo que NÃO é auto-injetado de entrega —
        // sobrevive a replans por design, ver comentário histórico removido de executeGoal()) com
        // o que a LLM desta replan devolveu, depois recalcula os critérios de entrega do zero a
        // partir do plano FINAL deste ciclo. Isso garante que um replan legítimo que abandona
        // send_audio/send_document não deixe um critério de entrega "preso" exigindo uma tool que
        // a estratégia atual nem usa mais — sem apagar critérios semânticos legítimos do Goal.
        const preservedCriteria = (goal.successCriteria ?? []).filter(c =>
            c.id !== AUTO_DELIVERY_CRITERION_IDS.send_document &&
            c.id !== AUTO_DELIVERY_CRITERION_IDS.send_audio
        );
        const mergedCriteria = [...preservedCriteria];
        for (const c of (planResult.successCriteria ?? [])) {
            if (!mergedCriteria.some(existing => existing.id === c.id)) mergedCriteria.push(c);
        }
        const replanCriteria = ensureDeliverySuccessCriteria(finalPlan, mergedCriteria);

        this.goalStore.update(goal.id, {
            currentPlan: finalPlan,
            status: 'executing',
            cycleFocus: planResult.strategy || undefined,
            // Restaura retryBudget ao valor inicial — cada novo plano começa com budget completo.
            // Sem este reset, retries consumidos no plano anterior reduzem artificialmente a
            // capacidade de recovery dos steps do novo plano.
            retryBudget: GOAL_LIMITS.MAX_RETRY_BUDGET,
            successCriteria: replanCriteria,
        });
        // Ao adotar novo plano: descarta componentes 'failed' e 'in_progress' do plano anterior
        // (tentativas fracassadas já descartadas), preserva apenas os 'completed'.
        // Recalcula overallPercent como: completed_anteriores / (completed + steps_pendentes_do_novo_plano)
        // para refletir o progresso real acumulado em relação ao trabalho total que ainda resta.
        if (state.progressModel) {
            state.progressModel.components = state.progressModel.components.filter(
                c => c.status === 'completed'
            );
            const completedCount = state.progressModel.components.length;
            const pendingCount = this.getPendingSteps(finalPlan).length;
            const totalWork = completedCount + pendingCount;
            state.progressModel.overallPercent = totalWork > 0
                ? Math.round((completedCount / totalWork) * 100)
                : 0;
            state.progressModel.updatedAt = Date.now();
        }
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
        const { channel: goalChannel, userId: goalUserId } = parseSessionKey(goal.sessionKey);
        const goalSessionKey = { channel: goalChannel || 'unknown', userId: goalUserId || 'unknown' };
        this.sessionManager?.setActiveGoal(goalSessionKey, goal.id);

        // Estado cognitivo/de progresso local a ESTA chamada (Sprint 0.6, Front A) — criado aqui
        // porque `runLoop()` é o ponto de entrada compartilhado por `executeGoal` E `resumeGoal`,
        // então nenhum dos dois pode esquecer de inicializar (era exatamente o bug de
        // `resumeGoal()` antes desta correção). Nunca armazenado em `this.*` — não há como um
        // Goal B ler/escrever o estado de um Goal A.
        const state: GoalExecutionState = {
            cognitiveContext: createEmptyStepCognitiveContext(),
            progressModel: {
                goalId: goal.id,
                components: [],
                overallPercent: 0,
                updatedAt: Date.now(),
            },
        };

        try {
        return await this.runLoopInternal(goal, channelContext, onProgress, initialCycles, initialReplans, initialFeedback, state);
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
        initialFeedback: string | undefined,
        state: GoalExecutionState,
    ): Promise<GoalResult> {
        let currentGoal = goal;
        let totalCycles = initialCycles;
        let totalReplans = initialReplans;
        // Feedback do Q4 → Q1: razão pela qual o objetivo não foi atingido no ciclo anterior
        let priorFeedback: string | undefined = initialFeedback;
        // Fix #2: rastreia caminhos de arquivo já enviados nesta sessão de execução.
        // Restaurado do GoalStore para sobreviver a restarts (Sprint 3 — cross-restart dedup).
        const sentArtifacts = new Set<string>(currentGoal.sentArtifacts ?? []);
        const trackArtifact = (fp: string) => {
            if (fp && !sentArtifacts.has(fp)) {
                sentArtifacts.add(fp);
                this.goalStore.update(currentGoal.id, { sentArtifacts: [...sentArtifacts] });
            }
        };
        // send_audio não tem file_path estável (cada chamada gera um mp3/ogg temporário com
        // timestamp único) — reusa o mesmo Set/coluna sent_artifacts de trackArtifact com uma
        // chave sentinela fixa em vez de criar um mecanismo de dedup paralelo. Evidência
        // (2026-07-05, goal_1783269002590_inaml): um step "agentloop" que já tinha enviado áudio
        // com sucesso era re-executado do zero a cada replan por mismatch semântico — nada
        // impedia o novo áudio de ser gerado e reenviado, pois o dedup existente só reconhece
        // send_document (chave = caminho do arquivo).
        const AUDIO_DELIVERED_KEY = '__send_audio_delivered__';
        const isAudioAlreadySent = () => sentArtifacts.has(AUDIO_DELIVERED_KEY);
        // H4/ITEM4: rastreia writes por path para detectar duplicate writes entre ciclos
        const writeTraceByPath = new Map<string, { cycle: number; step: string; source: string }>();

        while (totalCycles < GOAL_LIMITS.MAX_CYCLES) {
            totalCycles++;

            await onProgress?.({
                goalId: currentGoal.id,
                cycle: totalCycles,
                event: 'cycle_start',
            });

            const pendingStep = this.getPendingSteps(currentGoal.currentPlan)[0];

            // Fix #1: considera o plano "pronto para validar" quando todos os steps
            // pendentes são send_document. A validação ocorre ANTES da entrega —
            // artefatos só são enviados ao usuário após achieved=true.
            const readyToValidate = !pendingStep || (
                pendingStep.toolName === 'send_document' &&
                this.getPendingSteps(currentGoal.currentPlan).every(s => s.toolName === 'send_document')
            );

            if (readyToValidate) {
                // Todos os steps concluídos — LLM valida se o objetivo foi realmente atingido
                log.info(`[GoalLoop] goal=${currentGoal.id} all steps completed — running LLM validation`);
                log.info(`[GOAL-LIFECYCLE] goal=${currentGoal.id} session=${currentGoal.sessionKey} state=validating cycle=${totalCycles} timestamp=${Date.now()}`);
                await onProgress?.({ goalId: currentGoal.id, cycle: totalCycles, event: 'tool_completed', message: 'Validando conclusão...' });

                const activeMilestone = currentGoal.isConstruction && currentGoal.roadmap && currentGoal.roadmap.length > 0
                    ? currentGoal.roadmap[currentGoal.currentMilestoneIndex ?? 0]
                    : undefined;

                // Bypass estrutural: quando o único trabalho restante é despachar send_document
                // para arquivo(s) que já existem no disco com tamanho substantivo, o validador por
                // LLM nunca consegue confirmar "foi enviado" — o envio só acontece DEPOIS de
                // achieved=true (Fix #1 acima). Isso é um impasse estrutural para goals cujo único
                // propósito é reenviar um arquivo já existente (sem nenhum 'write' neste goal como
                // evidência de criação). Reproduzido ao vivo em 09/07 (goal "me envia a aula ..."):
                // esgotou o replanBudget tentando reenviar um .pptx já pronto, e no desespero o
                // planner criou um arquivo de "resumo de entrega" fabricado só para ter evidência de
                // 'write' e passar no validador — ver project_session_bugs_jul2026_ap na memória.
                // Verificação estrutural (arquivo existe, não é placeholder) é mais confiável aqui
                // do que o julgamento literal do LLM sobre um evento que ainda não aconteceu.
                const pendingSendSteps = this.getPendingSteps(currentGoal.currentPlan, 'send_document');
                const structuralBypass = pendingSendSteps.length > 0 && pendingSendSteps.every(s => {
                    const fp = String(s.toolArgs?.file_path ?? s.toolArgs?.path ?? '');
                    if (!fp) return false;
                    try {
                        const { resolved } = resolvePath(fp);
                        return fs.statSync(resolved).size >= MIN_DELIVERABLE_SIZE;
                    } catch {
                        return false;
                    }
                });

                let validation: Awaited<ReturnType<typeof this.validateGoalCompletion>>;
                if (structuralBypass) {
                    const artifactList = pendingSendSteps
                        .map(s => String(s.toolArgs?.file_path ?? s.toolArgs?.path ?? ''))
                        .join(',');
                    log.info(
                        `[VALIDATION-BYPASS] goal=${currentGoal.id}` +
                        ` reason=only_pending_is_verified_send_document` +
                        ` artifacts="${artifactList}"`
                    );
                    validation = { achieved: true, summary: 'Arquivo(s) já existente(s) no workspace, pronto(s) para envio.' };
                } else {
                    validation = await this.validateGoalCompletion(currentGoal, activeMilestone, state);
                }

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
                            const riskReport = await this.riskAnalyzer.analyze(currentGoal, initialPlan, this.planner.getAvailableSkills());
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
                        // Fix #1 + P3-DEDUP: executa steps de send_document diferidos,
                        // agora que achieved=true. Verifica sentArtifacts ANTES de executar
                        // para garantir 1 artefato = 1 entrega mesmo após múltiplos replans.
                        const deferredSends = this.getPendingSteps(currentGoal.currentPlan, 'send_document');
                        let failedSends = 0;
                        for (const sendStep of deferredSends) {
                            let filePath = String(sendStep.toolArgs?.file_path ?? sendStep.toolArgs?.path ?? '');
                            // Correção estrutural (achado replan/pivot 2026-07-12, goals reais no
                            // Windows: 09/07, 10/07 x2, 12/07 — mesma assinatura repetida): o plano
                            // pode chegar aqui com um file_path desatualizado se a estratégia pivotou
                            // no meio da execução (ex.: falha de "bash script.sh" sem WSL funcional
                            // levou o agente a trocar de HTML/Reveal.js para geração de .pptx via
                            // python-pptx) sem que o step de send_document já agendado fosse
                            // atualizado. Resultado sem esta correção: "Objetivo validado" (o
                            // artefato real existe e foi confirmado) mas a entrega falha com
                            // "arquivo não encontrado" porque aponta para um nome que nunca existiu.
                            // Corrige SOMENTE quando há exatamente 1 artefato real (confirmado pela
                            // própria validação do goal, não um palpite por extensão) ainda não
                            // enviado — evidência concreta, sem ambiguidade; caso contrário mantém o
                            // comportamento antigo (falha com mensagem clara) em vez de adivinhar.
                            if (filePath) {
                                const { resolved: requestedResolved } = resolvePath(filePath);
                                if (!fs.existsSync(requestedResolved)) {
                                    const candidates = (validation.artifactPaths ?? [])
                                        .filter(p => p !== filePath && !sentArtifacts.has(p) && fs.existsSync(resolvePath(p).resolved));
                                    if (candidates.length === 1) {
                                        log.warn(
                                            `[SEND-PATH-CORRECTED] goal=${currentGoal.id}` +
                                            ` requested="${filePath}"` +
                                            ` corrected="${candidates[0]}"` +
                                            ` reason=requested_file_missing_single_validated_artifact_found`
                                        );
                                        sendStep.toolArgs = { ...sendStep.toolArgs, file_path: candidates[0] };
                                        filePath = candidates[0];
                                    }
                                }
                            }
                            // Defesa em profundidade: skip se já enviado nesta sessão de goal
                            if (filePath && sentArtifacts.has(filePath)) {
                                log.info(
                                    `[DELIVERY-DEDUP] goal=${currentGoal.id}` +
                                    ` artifact="${filePath}"` +
                                    ` reason=already_sent_in_goal_session` +
                                    ` existing_delivery=sent` +
                                    ` decision=skip`
                                );
                                this.markStepDone(currentGoal, sendStep, '[DEDUP] já entregue nesta sessão');
                                currentGoal = this.goalStore.getById(currentGoal.id)!;
                                continue;
                            }
                            const sendResult = await this.executeStep(currentGoal, sendStep, channelContext, totalCycles, state);
                            currentGoal = this.goalStore.getById(currentGoal.id)!;
                            const sendOk = sendResult.outcome === 'success';
                            log.info(
                                `[DEFERRED-SEND] goal=${currentGoal.id}` +
                                ` artifact="${filePath}"` +
                                ` result=${sendResult.outcome}`
                            );
                            if (sendOk) {
                                this.markStepDone(currentGoal, sendStep, sendResult.output ?? '', 'skip');
                                currentGoal = this.goalStore.getById(currentGoal.id)!;
                                if (filePath) {
                                    trackArtifact(filePath);
                                    log.info(`[DELIVERY-REGISTRY] artifact="${filePath}" goal=${currentGoal.id} status=delivered`);
                                }
                            } else {
                                failedSends++;
                                // Sprint 0.6, Front B: preserva o blocker classificado por
                                // GoalEvaluator dentro de executeStep() — causa raiz exata do
                                // `blockers=[]` observado no goal real "ykpko" (Sprint 0.5): a
                                // falha de um send_document diferido pós-validação nunca
                                // propagava seu blocker.
                                if (sendResult.blocker) {
                                    this.goalStore.recordBlocker(currentGoal.id, sendResult.blocker);
                                    currentGoal = this.goalStore.getById(currentGoal.id)!;
                                }
                            }
                        }
                        // FIX #2: não marcar goal como completed se algum send_document falhou
                        const allSendsOk = deferredSends.length === 0 || failedSends === 0;
                        const deliveredArtifacts = deferredSends
                            .filter((_, i) => i < deferredSends.length - failedSends)
                            .map(s => String(s.toolArgs?.file_path ?? '(unknown)'));
                        log.info(`[GOAL-COMPLETE-CHECK] goal=${currentGoal.id} validation_ok=true all_sends_ok=${allSendsOk} deferred_sends=${deferredSends.length} failed_sends=${failedSends} final_state=${allSendsOk ? 'completed' : 'failed'}`);

                        // FIX E: [DELIVERY-DECISION] — documenta a decisão de encerramento
                        log.info(
                            `[DELIVERY-DECISION] goal=${currentGoal.id}` +
                            ` artifact="${deliveredArtifacts.join(',') || '(none)'}"` +
                            ` delivered=${allSendsOk}` +
                            ` validation=true` +
                            ` completed=${allSendsOk}` +
                            ` continue_execution=false` +
                            ` reason=${allSendsOk ? 'goal_satisfied' : 'send_failed'}`
                        );
                        // FIX F: [GOAL-SATISFACTION] — estado final de satisfação do objetivo
                        log.info(
                            `[GOAL-SATISFACTION] goal=${currentGoal.id}` +
                            ` achieved=true` +
                            ` artifacts=${deferredSends.length}` +
                            ` delivered=${deferredSends.length - failedSends}` +
                            ` remaining_steps=0` +
                            ` reason=${allSendsOk ? 'artifact_delivered' : 'delivery_failed'}`
                        );

                        if (!allSendsOk) {
                            this.goalStore.setStatus(currentGoal.id, 'failed');
                            const sendErr = failedSends === deferredSends.length
                                ? 'Objetivo validado, mas nenhum arquivo pôde ser entregue ao usuário. Verifique o workspace.'
                                : `Objetivo validado, mas ${failedSends} de ${deferredSends.length} arquivo(s) não foram entregues.`;
                            return this.buildResult(currentGoal, false, totalCycles, totalReplans, sendErr);
                        }
                        // FIX E: encerra imediatamente — sem replan, sem novos ciclos
                        this.goalStore.setStatus(currentGoal.id, 'completed');
                        log.info(`[GoalLoop] goal=${currentGoal.id} validated as complete`);
                        // S5 (modo sombra): captura Caso só se houver evidência de nível de goal
                        // (successCriteria met OU sentArtifacts real) — nunca influencia o resultado.
                        this.caseMemory.captureIfEligible(this.goalStore.getById(currentGoal.id)!);
                        return this.buildResult(currentGoal, true, totalCycles, totalReplans, validation.summary);
                    }
                }

                // LLM diz que o objetivo ainda não foi atingido
                log.info(`[GoalLoop] goal=${currentGoal.id} not yet complete: ${validation.reason}`);
                log.info(`[GOAL-LIFECYCLE] goal=${currentGoal.id} session=${currentGoal.sessionKey} state=replanning reason="${(validation.reason ?? '').slice(0, 100)}" cycle=${totalCycles} timestamp=${Date.now()}`);
                // FIX F: [GOAL-SATISFACTION] — registra estado de não-satisfação para diagnóstico
                const pendingSendCount = this.getPendingSteps(currentGoal.currentPlan).length;
                log.info(
                    `[GOAL-SATISFACTION] goal=${currentGoal.id}` +
                    ` achieved=false` +
                    ` artifacts=${currentGoal.attempts.filter(a => a.result === 'success' && a.toolName === 'write').length}` +
                    ` delivered=0` +
                    ` remaining_steps=${pendingSendCount}` +
                    ` reason=${(validation.reason ?? 'unknown').slice(0, 80)}`
                );
                await onProgress?.({ goalId: currentGoal.id, cycle: totalCycles, event: 'replanning', message: validation.reason });

                // ── Item 2: Deliverable Check ──────────────────────────────
                // Antes de replanejar, verifica se já existe output no workspace.
                // Evita o cenário onde 3 arquivos .pptx existem mas o sistema
                // continua tentando regenerar em vez de enviar o que já tem.
                if (!currentGoal.strategiesTried.includes('deliverable_check_done')) {
                    const expectedExts = inferExpectedExtensions(currentGoal.userIntent);
                    if (expectedExts.length > 0) {
                        const foundFiles = await this.checkDeliverables(expectedExts, currentGoal.createdAt);
                        // Fix #2: ignora arquivos já enviados nesta sessão de execução do goal
                        // Fix S1: ignora arquivos menores que MIN_DELIVERABLE_SIZE — stubs/placeholders
                        // não devem ser enviados ao usuário nem consumir replanBudget com sends inúteis.
                        const substantiveFiles = foundFiles.filter(f => {
                            try {
                                return fs.statSync(f).size >= MIN_DELIVERABLE_SIZE;
                            } catch {
                                return false; // arquivo desapareceu — ignorar
                            }
                        });
                        const tinyFiles = foundFiles.length - substantiveFiles.length;
                        if (tinyFiles > 0) {
                            log.warn(`[GoalLoop] deliverable_check: ${tinyFiles} arquivo(s) ignorado(s) por tamanho < ${MIN_DELIVERABLE_SIZE}B (placeholders)`);
                        }
                        // Exclui também arquivos que já têm um send_document PENDENTE no plano atual
                        // (agendado mas ainda não executado) — sem isso, deliverable_check injetava um
                        // segundo send step pro mesmo arquivo enquanto o primeiro ainda não tinha rodado.
                        const pendingSendPaths = new Set(
                            this.getPendingSteps(currentGoal.currentPlan, 'send_document')
                                .map(s => String(s.toolArgs?.file_path ?? s.toolArgs?.path ?? ''))
                        );
                        const unsentFiles = substantiveFiles.filter(f => !sentArtifacts.has(f) && !pendingSendPaths.has(f));
                        if (unsentFiles.length > 0) {
                            const skipped = substantiveFiles.length - unsentFiles.length;
                            log.info(`[GoalLoop] deliverable_check: ${unsentFiles.length} arquivo(s) no workspace${skipped > 0 ? ` (${skipped} já enviado(s) ignorado(s))` : ''} — injetando send steps`);
                            this.goalStore.addStrategyTried(currentGoal.id, 'deliverable_check_done');
                            currentGoal = this.goalStore.getById(currentGoal.id)!;

                            const sendSteps: PlanStep[] = unsentFiles.slice(0, 2).map((filePath, i) => ({
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
                    // C: budget adaptativo — se há progresso substancial, concede +1 replan bonus
                    // focalizado nos componentes pendentes em vez de reiniciar do zero
                    const progressPct = state.progressModel?.overallPercent ?? 0;
                    const bonusGranted = progressPct >= 60 && totalReplans <= 1;
                    if (bonusGranted) {
                        log.info(
                            `[ADAPTIVE-BUDGET] goal=${currentGoal.id}` +
                            ` progress=${progressPct}% >= 60% — granting +1 bonus replan` +
                            ` cycle=${totalCycles}`
                        );
                        this.goalStore.update(currentGoal.id, {
                            replanBudget: 1,
                            status: 'replanning',
                        });
                        currentGoal = this.goalStore.getById(currentGoal.id)!;
                        // Blocker focado nos componentes pendentes do progressModel
                        const pendingComponents = (state.progressModel?.components ?? [])
                            .filter(c => c.status !== 'completed')
                            .map(c => c.label)
                            .join('; ');
                        const bonusBlocker: GoalBlocker = {
                            kind: 'goal_incomplete',
                            description: `[BONUS REPLAN — ${progressPct}% concluído] Complete APENAS os componentes pendentes: ${pendingComponents || (validation.reason ?? 'componentes ainda não entregues')}`,
                            suggestedActions: ['Foque exclusivamente nos componentes pendentes — não replanejar o que já foi entregue'],
                            detectedAt: Date.now(),
                        };
                        this.goalStore.addBlocker(currentGoal.id, bonusBlocker);
                        this.goalStore.addStrategyTried(currentGoal.id, `bonus_replan: progress=${progressPct}% pendentes=[${pendingComponents}]`);
                        currentGoal = await this.planWithSpiral(currentGoal, bonusBlocker, validation.reason, totalReplans + 1, state, true);
                        totalReplans++;
                        continue;
                    }

                    this.goalStore.setStatus(currentGoal.id, 'failed');
                    const baseExplanation = validation.reason ?? this.evaluator.buildFailureExplanation(currentGoal);
                    // Entrega parcial: se há conteúdo útil coletado, enriquece a mensagem final
                    const graceful = this.gracefulDelivery.assess(currentGoal, state.cognitiveContext);
                    const explanation = graceful.hasPartialContent
                        ? graceful.partialSummary
                        : baseExplanation;
                    log.info(
                        `[GOAL-LIFECYCLE] goal=${currentGoal.id} session=${currentGoal.sessionKey}` +
                        ` state=failed reason="replan_budget_exhausted"` +
                        ` graceful_delivery=${graceful.hasPartialContent}` +
                        ` progress=${progressPct}%` +
                        ` cycle=${totalCycles} timestamp=${Date.now()}`
                    );
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
                currentGoal = await this.planWithSpiral(currentGoal, blocker, priorFeedback, totalReplans + 1, state, true);
                totalReplans++;

                if (Date.now() > currentGoal.expiresAt) {
                    this.goalStore.setStatus(currentGoal.id, 'abandoned');
                    return this.buildResult(currentGoal, false, totalCycles, totalReplans, 'Objetivo expirou por tempo limite.');
                }
                continue;
            }

            // ── Executar o step atual ──────────────────────────────────
            await onProgress?.({ goalId: currentGoal.id, cycle: totalCycles, event: 'tool_executing', message: pendingStep.description });

            // H7: classificar se send_document está sendo executado antes da validação (step regular)
            if (pendingStep.toolName === 'send_document') {
                log.info(`[SEND-CLASSIFICATION] goal=${currentGoal.id} step=${pendingStep.id} tool=send_document deferred=false reason=regular_plan_step`);
            }
            // ITEM5: rastrear origem do path em steps de escrita
            if ((pendingStep.toolName === 'write' || pendingStep.toolName === 'edit') && pendingStep.toolArgs?.path) {
                const source = totalReplans > 0 ? 'replanner' : 'planner';
                log.info(
                    `[PATH-ORIGIN] goal=${currentGoal.id} cycle=${totalCycles}` +
                    ` path="${pendingStep.toolArgs.path}"` +
                    ` source=${source} step=${pendingStep.id}`
                );
            }
            // H7: AgentLoop pode chamar send_document internamente sem proteção de deferred
            if (pendingStep.toolName === 'agentloop' || !pendingStep.toolName) {
                const hasPendingSends = this.getPendingSteps(currentGoal.currentPlan, 'send_document').length > 0;
                log.info(
                    `[SEND-ORDER] goal=${currentGoal.id} step=${pendingStep.id}` +
                    ` tool=${pendingStep.toolName ?? 'agentloop'} validation_done=false` +
                    ` send_allowed=uncontrolled deferred_sends_pending=${hasPendingSends}`
                );
            }

            let cycleResult = await this.executeStep(
                currentGoal, pendingStep, channelContext, totalCycles, state,
                // CORREÇÃO 1: passa callback para que DELIVERY-GUARD notifique sentArtifacts
                // diretamente, sem depender de S10 (que só executa em case 'success').
                (fp) => { if (fp) trackArtifact(fp); },
                isAudioAlreadySent,
            );

            // Recarrega o goal — pode ter sido abandonado durante o step (nova mensagem do usuário)
            currentGoal = this.goalStore.getById(currentGoal.id)!;
            if (currentGoal.status === 'abandoned') {
                log.info(`[GoalLoop] goal=${currentGoal.id} foi abandonado durante execução do step — saindo do loop`);
                return this.buildResult(currentGoal, false, totalCycles, totalReplans,
                    'Goal interrompido: nova mensagem do usuário recebida durante execução.');
            }

            // FIX B: detectar arquivo vazio em step de leitura para goals de modificação.
            // Impede que o sistema replane com "usar memória como substituto" quando o artefato
            // fonte é um requisito real (o conteúdo precisa existir para ser modificado).
            if (
                (pendingStep.toolName === 'read' || pendingStep.toolName === 'read_document') &&
                cycleResult.outcome !== 'success'
            ) {
                const lastAttempt = [...currentGoal.attempts].reverse().find(a => a.planStepId === pendingStep.id);
                const isEmptyArtifact = lastAttempt?.error?.includes('[ARQUIVO VAZIO]') ?? false;
                if (isEmptyArtifact && this.isModificationGoal(currentGoal.userIntent)) {
                    const requiredPath = String(pendingStep.toolArgs?.path ?? pendingStep.toolArgs?.filename ?? '(desconhecido)');
                    log.warn(
                        `[ARTIFACT-DEPENDENCY] goal=${currentGoal.id} required="${requiredPath}"` +
                        ` exists=true empty=true action=fail` +
                        ` reason="goal de modificação requer conteúdo real no arquivo fonte"`
                    );
                    const failMsg = `Arquivo fonte obrigatório "${requiredPath}" está vazio. ` +
                        `O objetivo requer modificar conteúdo existente — não é possível continuar sem o arquivo original.`;
                    this.goalStore.setStatus(currentGoal.id, 'failed');
                    this.goalStore.addBlocker(currentGoal.id, {
                        kind: 'required_artifact_missing',
                        description: failMsg,
                        suggestedActions: ['Verifique se o arquivo correto foi enviado ou criado antes de pedir modificações'],
                        detectedAt: Date.now(),
                    });
                    log.info(`[GOAL-LIFECYCLE] goal=${currentGoal.id} session=${currentGoal.sessionKey} state=failed reason="required_artifact_missing" cycle=${totalCycles} timestamp=${Date.now()}`);
                    return this.buildResult(currentGoal, false, totalCycles, totalReplans, failMsg);
                }
            }

            // ── Validação semântica: mesmo após 'success' heurístico, verifica se o output
            // endereça a intenção do step (ex: crypto_analysis retornando ENA/BCH em vez de ZEC/Pi)
            // P6: cobre também steps agentloop (sem toolName) — output do AgentLoop também é validado
            if (cycleResult.outcome === 'success' && cycleResult.output) {
                const semanticValidation = await this.semanticValidator.validate(
                    pendingStep,
                    cycleResult.output,
                    currentGoal.userIntent,
                );
                if (semanticValidation.shouldDowngradeToPartial) {
                    log.warn(
                        `[SEMANTIC-MISMATCH] goal=${currentGoal.id} step=${pendingStep.id}` +
                        ` tool=${pendingStep.toolName} confidence=${semanticValidation.confidence.toFixed(2)}` +
                        ` reason="${(semanticValidation.reason ?? '').slice(0, 100)}"` +
                        ` action=downgrade_to_partial`
                    );
                    state.cognitiveContext.failedStrategies.push(
                        `${pendingStep.toolName} (step ${pendingStep.id}): output irrelevante para a intenção — ${semanticValidation.reason ?? 'mismatch'}`
                    );
                    // P5: persiste na ReflectionMemory para que futuros goals evitem o mesmo padrão
                    // S2a: outcome='partial' (não 'failure') — a ferramenta rodou e produziu
                    // output real, só não endereçou a intenção do step. É exatamente o caso que
                    // shouldDowngradeToPartial já nomeia; evidência objetiva, não interpretação.
                    // failureType='semantic_mismatch' — BlockerKind já tem esse valor exato.
                    this.reflectionMemory.record({
                        userInput: currentGoal.userIntent.slice(0, 300),
                        intent: pendingStep.description.slice(0, 200),
                        toolUsed: pendingStep.toolName ?? 'agentloop',
                        toolOutput: cycleResult.output?.slice(0, 500),
                        approved: false,
                        reason: `Mismatch semântico: ${semanticValidation.reason ?? 'output não endereça a intenção do step'}`,
                        confidence: semanticValidation.confidence,
                        pattern: `tool_${pendingStep.toolName ?? 'agentloop'}`,
                        suggestedFix: `Use query/abordagem que retorne especificamente: ${pendingStep.description.slice(0, 100)}`,
                        outcome: 'partial',
                        failureType: 'semantic_mismatch',
                    });
                    // A: enriquece a descrição do step no plano para que a próxima tentativa
                    // seja explicitamente guiada pelo motivo do mismatch.
                    // Se a descrição já contém o marcador [ATENÇÃO —, o step já foi tentado com
                    // o hint e voltou irrelevante — retry adicional é inútil; escala imediatamente
                    // para 'blocked' para forçar replan com ferramenta diferente.
                    const alreadyHinted = (pendingStep.description ?? '').includes('[ATENÇÃO —');
                    const mismatchHint = ` [ATENÇÃO — tentativa anterior com ${pendingStep.toolName ?? 'agentloop'} retornou output irrelevante: ${(semanticValidation.reason ?? 'mismatch').slice(0, 120)}. Use abordagem diferente que retorne especificamente o que o objetivo pede.]`;
                    const enrichedPlan = currentGoal.currentPlan.map(s =>
                        s.id === pendingStep.id
                            ? { ...s, description: (s.description + mismatchHint).slice(0, 500) }
                            : s
                    );
                    this.goalStore.update(currentGoal.id, { currentPlan: enrichedPlan });
                    currentGoal = this.goalStore.getById(currentGoal.id)!;
                    // Sprint 0.8 (achados L10/L11/L14/L15): o GoalAttempt já persistido por
                    // executeStep() (antes desta validação semântica rodar) continua com
                    // result='success' — corrige para 'partial', alinhando com o que
                    // ReflectionMemory.record({outcome:'partial', ...}) já registrava acima
                    // para o mesmo evento.
                    this.goalStore.downgradeLastAttemptToPartial(currentGoal.id, pendingStep.id);
                    currentGoal = this.goalStore.getById(currentGoal.id)!;
                    // Retry só é útil quando o step NÃO tem toolName fixo (caminho 'agentloop'):
                    // nesse caso o próximo ciclo chama o LLM de novo com a description enriquecida
                    // acima, então o hint pode de fato mudar o resultado. Para steps com toolName
                    // (exec_command, memory_search, ssh_exec, ...), executeStep() despacha
                    // `resolveStepRefs(step.toolArgs, goal)` — resolve só {{step_N.output}}, nunca
                    // regenera os args a partir da description — então o retry chamaria a MESMA
                    // tool com os MESMOS args e reproduziria o MESMO mismatch, garantido.
                    // Reproduzido ao vivo (auditoria, 17/07): um goal de inventário de host rodou
                    // exec_command 2x idênticas ("hostname/OS/CPU" pedido, saída só com
                    // vulnerabilidades de CPU as duas vezes) e memory_search 2x idênticas (mesma
                    // query, mesmo resultado irrelevante as duas vezes) — cada retry queimou um
                    // ciclo inteiro (dispatch + validação semântica via LLM) sem nenhuma chance de
                    // resultado diferente, atrasando a escalada para replan (a única coisa que de
                    // fato muda a abordagem, porque gera um plano novo do zero).
                    const retryCanHelp = !pendingStep.toolName;
                    if (currentGoal.retryBudget > 0 && !alreadyHinted && retryCanHelp) {
                        // Primeira falha: retry com hint enriquecido
                        cycleResult = { ...cycleResult, outcome: 'partial' };
                    } else {
                        // Segunda falha para o mesmo step (alreadyHinted) OU retryBudget esgotado:
                        // retry adicional seria inútil — escala para 'blocked' para replan com nova estratégia
                        log.warn(
                            `[SEMANTIC-MISMATCH] goal=${currentGoal.id} step=${pendingStep.id}` +
                            ` retryBudget=${currentGoal.retryBudget} alreadyHinted=${alreadyHinted}` +
                            ` retryCanHelp=${retryCanHelp}` +
                            ` — escalating to blocked for replan`
                        );
                        const isDirListing = pendingStep.toolName === 'read' && /📁|📄/.test(cycleResult.output ?? '');
                        const dirHint = isDirListing
                            ? ` Listagem do diretório retornada: ${(cycleResult.output ?? '').split('\n').slice(0, 10).join('; ')}`
                            : '';
                        // Quando alreadyHinted=true, pendingStep.description já carrega o
                        // mismatchHint embutido de um ciclo anterior (linha ~1010) — cortar em
                        // 100 chars sem remover o hint primeiro produz um blocker.description
                        // truncado no meio do marcador interno (ex: "...via send_audio. [AT'"),
                        // que buildFailureExplanation() (GoalEvaluator.ts) expõe ao usuário como
                        // texto quebrado. Remove o hint antes de truncar — mesma sub-string
                        // '[ATENÇÃO —' já usada em alreadyHinted acima, não é um padrão novo.
                        const cleanStepDesc = pendingStep.description.split(' [ATENÇÃO —')[0];
                        const retryOutcomeLabel = alreadyHinted
                            ? 'após 2 tentativas'
                            : (retryCanHelp ? 'após esgotar retryBudget' : 'sem chance de retry ajudar (ferramenta fixa, mesmos argumentos)');
                        cycleResult = {
                            ...cycleResult,
                            outcome: 'blocked',
                            blocker: {
                                kind: 'semantic_mismatch' as const,
                                toolName: pendingStep.toolName,
                                description: `Step '${cleanStepDesc.slice(0, 100)}' retornou output irrelevante ${retryOutcomeLabel}: ${semanticValidation.reason ?? 'mismatch semântico'}${dirHint}`,
                                suggestedActions: isDirListing
                                    ? [
                                        'Usar o path completo de um dos arquivos listados acima em vez do diretório',
                                        'Verificar nos ARQUIVOS ENVIADOS AO USUÁRIO o path exato do arquivo solicitado',
                                    ]
                                    : [
                                        'Usar tool diferente para este step',
                                        'Reformular a query com abordagem completamente alternativa',
                                    ],
                                detectedAt: Date.now(),
                            },
                        };
                    }
                } else if (semanticValidation.result === 'mismatch') {
                    log.info(
                        `[SEMANTIC-MISMATCH] goal=${currentGoal.id} step=${pendingStep.id}` +
                        ` tool=${pendingStep.toolName} confidence=${semanticValidation.confidence.toFixed(2)}` +
                        ` reason="${(semanticValidation.reason ?? '').slice(0, 100)}"` +
                        ` action=log_only (below downgrade threshold)`
                    );
                    state.cognitiveContext.failedStrategies.push(
                        `${pendingStep.toolName}: possível mismatch semântico — ${semanticValidation.reason ?? 'output pode não ser relevante'}`
                    );
                }
            }

            // ── Avaliar resultado ──────────────────────────────────────
            switch (cycleResult.outcome) {

                case 'success': {
                    // skipAttemptRecord=true: executeStep() já gravou o attempt real deste
                    // ciclo (com o result correto, incluindo 'partial' de baixa confiança —
                    // Sprint 0.8) antes de retornar cycleResult; ver comentário em markStepDone.
                    this.markStepDone(currentGoal, pendingStep, cycleResult.output ?? '', 'skip');
                    this.updateCognitiveContext(pendingStep, cycleResult.output ?? '', state);
                    this.updateProgressModel(pendingStep, 'completed', cycleResult.output, state);
                    // Fix #2: registra artefatos enviados para evitar reenvio por deliverable_check
                    if (pendingStep.toolName === 'send_document' && pendingStep.toolArgs?.file_path) {
                        trackArtifact(String(pendingStep.toolArgs.file_path));
                    }
                    // FIX C + P3-DEDUP: injeta sends diferidos do AgentLoop como steps pendentes.
                    // Deduplicação adicional: garante que o mesmo file_path não entre duas vezes
                    // no plano mesmo que a dedup no callback tenha falhado (defesa em profundidade).
                    if (cycleResult.deferredSends && cycleResult.deferredSends.length > 0) {
                        const existingPendingSendPaths = new Set(
                            this.getPendingSteps(currentGoal.currentPlan, 'send_document')
                                .map(s => String(s.toolArgs?.file_path ?? s.toolArgs?.path ?? ''))
                        );
                        const dedupedSends: typeof cycleResult.deferredSends = [];
                        for (const sendArgs of cycleResult.deferredSends) {
                            const fp = String(sendArgs['file_path'] ?? sendArgs['path'] ?? '');
                            const key = fp || JSON.stringify(sendArgs);
                            if (existingPendingSendPaths.has(key) || sentArtifacts.has(fp)) {
                                log.info(
                                    `[DELIVERY-DEDUP] artifact="${fp}"` +
                                    ` reason=duplicate_in_plan_injection` +
                                    ` existing_delivery=${sentArtifacts.has(fp) ? 'already_sent' : 'pending_step'}` +
                                    ` decision=skip`
                                );
                            } else {
                                dedupedSends.push(sendArgs);
                                existingPendingSendPaths.add(key);
                            }
                        }
                        if (dedupedSends.length > 0) {
                            const newSendSteps: PlanStep[] = dedupedSends.map((sendArgs, i) => ({
                                id: `step_deferred_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 5)}`,
                                description: `Enviar documento "${String(sendArgs['file_path'] ?? sendArgs['path'] ?? '(desconhecido)')}" ao usuário`,
                                toolName: 'send_document',
                                toolArgs: sendArgs,
                                status: 'pending' as const,
                                fallbackSteps: [],
                                originStepId: pendingStep.id,
                            }));
                            // RECONCILIAÇÃO: uma nova tentativa do MESMO pendingStep (retry após
                            // SEMANTIC-MISMATCH/partial) supera qualquer send_document ainda
                            // pendente injetado por uma tentativa ANTERIOR do mesmo step — evita
                            // que retries sucessivos (cada um com um file_path novo) acumulem
                            // envios concorrentes pro mesmo objetivo lógico. Achado real:
                            // goal_1784200808912_vw8fu, 16/07/2026 — 3 .pptx enviados pra 1
                            // pedido de "mudar as cores", cada retry do mesmo step injetando seu
                            // próprio deferred send sem cancelar o anterior. Só afeta sends AINDA
                            // NÃO despachados (pending); um DELIVERY-GUARD já enviado de verdade
                            // (sentArtifacts) é irretratável e fica fora deste escopo.
                            const supersededPaths: string[] = [];
                            const planWithoutSuperseded = currentGoal.currentPlan.filter(s => {
                                const superseded = s.status === 'pending'
                                    && s.toolName === 'send_document'
                                    && s.originStepId === pendingStep.id;
                                if (superseded) supersededPaths.push(String(s.toolArgs?.file_path ?? s.toolArgs?.path ?? ''));
                                return !superseded;
                            });
                            if (supersededPaths.length > 0) {
                                log.info(
                                    `[AGENTLOOP-SEND-SUPERSEDE] goal=${currentGoal.id} step=${pendingStep.id}` +
                                    ` superseded="${supersededPaths.join(',')}"` +
                                    ` reason=same_origin_step_retry`
                                );
                            }
                            const updatedPlan = [...planWithoutSuperseded, ...newSendSteps];
                            this.goalStore.update(currentGoal.id, { currentPlan: updatedPlan });
                            currentGoal = this.goalStore.getById(currentGoal.id)!;
                            log.info(
                                `[AGENTLOOP-SEND] goal=${currentGoal.id} step=${pendingStep.id}` +
                                ` deferred_injected=${newSendSteps.length}` +
                                ` deferred_skipped=${cycleResult.deferredSends.length - dedupedSends.length}` +
                                ` superseded=${supersededPaths.length}` +
                                ` reason=goal_execution_policy`
                            );
                        } else {
                            log.info(
                                `[AGENTLOOP-SEND] goal=${currentGoal.id} step=${pendingStep.id}` +
                                ` deferred_injected=0` +
                                ` deferred_skipped=${cycleResult.deferredSends.length}` +
                                ` reason=all_duplicates`
                            );
                        }
                        // REMOVIDO (02/07/2026): este loop chamava trackArtifact() pra TODO
                        // deferredSend, marcando em sentArtifacts arquivos que só foram AGENDADOS
                        // (ainda não enviados de verdade). Isso conflava "agendado" com "enviado" no
                        // mesmo Set — o loop de execução dos sends diferidos (mais abaixo, "agora que
                        // achieved=true") checa `sentArtifacts.has(filePath)` pra decidir se pula o
                        // send como duplicata; como o arquivo já constava ali (marcado aqui, cedo
                        // demais), o send real nunca rodava — goal reportava success=true e
                        // "delivered=1" sem o arquivo ter saído de fato. Reproduzido ao vivo em
                        // 02/07 (usuário: "faltou me enviar o arquivo!"). A proteção que este loop
                        // pretendia dar (evitar deliverable_check reagendar um arquivo já agendado)
                        // agora é feita corretamente no próprio deliverable_check, checando
                        // send_document pendente no currentPlan — não mais poluindo sentArtifacts.
                        // DELIVERY-GUARD (entrega direta do AgentLoop, fora do plano) continua
                        // marcando sentArtifacts corretamente via callback onArtifactDelivered.
                    }
                    // ITEM4: rastreia writes por path para detectar duplicatas entre ciclos
                    if ((pendingStep.toolName === 'write' || pendingStep.toolName === 'edit') && pendingStep.toolArgs?.path) {
                        const writePath = String(pendingStep.toolArgs.path);
                        const source = pendingStep.toolName === 'write' ? 'planner' : 'planner';
                        const prior = writeTraceByPath.get(writePath);
                        if (prior) {
                            log.warn(
                                `[DUPLICATE-WRITE-TRACE] goal=${currentGoal.id}` +
                                ` cycle=${totalCycles} path="${writePath}"` +
                                ` step=${pendingStep.id} source=${source}` +
                                ` prev_cycle=${prior.cycle} prev_step=${prior.step}`
                            );
                        } else {
                            log.info(
                                `[DUPLICATE-WRITE-TRACE] goal=${currentGoal.id}` +
                                ` cycle=${totalCycles} path="${writePath}"` +
                                ` step=${pendingStep.id} source=${source} prev_cycle=none`
                            );
                        }
                        writeTraceByPath.set(writePath, { cycle: totalCycles, step: pendingStep.id, source });
                    }
                    currentGoal = this.goalStore.getById(currentGoal.id)!;
                    await onProgress?.({ goalId: currentGoal.id, cycle: totalCycles, event: 'tool_completed' });
                    break;
                }

                case 'partial': {
                    // Sprint 0.6, Front B: preserva o blocker já classificado por
                    // GoalEvaluator.evaluate() para auditoria/replan futuro. Usa recordBlocker
                    // (não addBlocker) de propósito — 'partial' é retryável, o goal continua
                    // 'executing'; addBlocker forçaria status='blocked' incorretamente.
                    if (cycleResult.blocker) {
                        this.goalStore.recordBlocker(currentGoal.id, cycleResult.blocker);
                    }
                    // Retryável — registra como 'in_progress' e diminui retry budget
                    this.updateProgressModel(pendingStep, 'in_progress', cycleResult.output, state);
                    this.goalStore.update(currentGoal.id, {
                        retryBudget: Math.max(0, currentGoal.retryBudget - 1),
                    });
                    currentGoal = this.goalStore.getById(currentGoal.id)!;
                    // CORREÇÃO 2 (S10-PARTIAL): defense-in-depth para o gap DELIVERY-GUARD.
                    // Se deferredSends contém paths (capturados pelo intercept do main loop)
                    // e o DELIVERY-GUARD os entregou antes do downgrade para 'partial',
                    // a Correção 1 já registrou via callback. Este bloco cobre o caso
                    // onde o callback falhou silenciosamente ou não foi acionado.
                    // NÃO injeta steps de send (diferente do S10 em case 'success') —
                    // apenas garante que sentArtifacts reflita o que foi entregue.
                    if (cycleResult.deferredSends?.length) {
                        for (const sendArgs of cycleResult.deferredSends) {
                            const fp = String(sendArgs['file_path'] ?? sendArgs['path'] ?? '');
                            if (fp && !sentArtifacts.has(fp)) {
                                trackArtifact(fp);
                                log.info(
                                    `[S10-PARTIAL] goal=${currentGoal.id}` +
                                    ` artifact="${fp}"` +
                                    ` source=deferred_sends_partial_fallback`
                                );
                            }
                        }
                    }
                    break;
                }

                case 'needs_auth': {
                    // DEVELOPER/GOD mode: auto-aprovar exec_command sem confirmação por chamada.
                    // isDestructive() ainda bloqueia comandos perigosos em qualquer modo.
                    if (permissionRegistry.can('auto_approve_exec')) {
                        log.info(`[GoalLoop] needs_auth auto-approved (mode=${permissionRegistry.getMode()}) goal=${currentGoal.id}`);
                        // 'finalize': executeStep() já gravou um attempt 'failure' para este
                        // step (o bloqueio de permissão que originou este outcome) — a
                        // auto-aprovação resolve esse bloqueio no mesmo ciclo, sem uma segunda
                        // execução real distinta. Corrige o attempt existente para 'success' em
                        // vez de acrescentar um segundo, contraditório (Sprint 0.8.3, achado
                        // residual 2).
                        this.markStepDone(currentGoal, pendingStep, cycleResult.output ?? '', 'finalize');
                        currentGoal = this.goalStore.getById(currentGoal.id)!;
                        break;
                    }

                    // SAFE mode: pausa e aguarda confirmação do usuário
                    const txnId = cycleResult.authOptions
                        ?.find(o => o.value?.startsWith('auth:'))
                        ?.value?.split(':').slice(2).join(':');

                    // Sprint 0.8 (achados L02d/L12/L13): preserva o blocker já classificado por
                    // GoalEvaluator — mesmo padrão dos branches 'partial'/'failed'/deferred send
                    // corrigidos na Sprint 0.6. Só neste ramo SAFE, nunca no auto-aprovado acima:
                    // ali a tool não foi de fato bloqueada.
                    if (cycleResult.blocker) {
                        this.goalStore.recordBlocker(currentGoal.id, cycleResult.blocker);
                    }
                    await onProgress?.({ goalId: currentGoal.id, cycle: totalCycles, event: 'blocked', message: 'Aguardando autorização' });
                    // Sprint 0.11 (achado do Laboratório Cognitivo, newclaw-cortex/C1.5): `requiresAuth`
                    // era setado 'false' em create() (GoalOrchestrator.ts) e NUNCA setado 'true' em
                    // nenhum outro ponto do runtime — mesmo aqui, onde um `pendingTxnId` real é gravado
                    // porque o goal está de fato aguardando autorização. `requires_auth` ficava sempre 0
                    // no banco, dissociado de `pending_txn_id` (achado com dado real: 40/442 goals com
                    // pendingTxnId e requires_auth=0). `requiresAuth` volta a `false` em resumeGoal()
                    // (linha ~290) e em abortGoalFromAuth() (GoalOrchestrator.ts), os dois pontos que já
                    // limpam `pendingTxnId`.
                    this.goalStore.update(currentGoal.id, {
                        status: 'blocked',
                        pendingTxnId: txnId,
                        requiresAuth: true,
                    });
                    const goalResult = this.buildResult(currentGoal, false, totalCycles, totalReplans,
                        cycleResult.output || 'Aguardando sua autorização para prosseguir.');
                    return { ...goalResult, authOptions: cycleResult.authOptions };
                }

                case 'needs_dependency': {
                    // Sprint 0.8 (achados L02d/L12/L13): preserva o blocker 'missing_tool' que
                    // motivou a injeção do step de instalação — mesmo padrão do branch 'blocked'.
                    if (cycleResult.blocker) {
                        this.goalStore.recordBlocker(currentGoal.id, cycleResult.blocker);
                    }
                    const depInfo = cycleResult.depInfo!;
                    const installKey = `install_dep_${depInfo.name}`;

                    this.goalStore.addStrategyTried(currentGoal.id, installKey);
                    currentGoal = this.goalStore.getById(currentGoal.id)!;

                    const installStepId = `install_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
                    // Resolve o comando just-in-time, pela plataforma REAL detectada — nunca usa
                    // depInfo.installCmd diretamente (histórico: sempre apt/Linux, executaria
                    // "sudo apt install..." também num Windows). Sem comando seguro para este SO,
                    // resolvedCommand fica undefined e o step cai no caminho manual/permission-gated
                    // (toolName undefined) mesmo em modo DEVELOPER/GOD — nunca cria exec_command
                    // vazio nem assume que a instalação ocorreu.
                    const resolvedCommand = resolveInstallCommand(depInfo, this.capRegistry.getOSSync());
                    const autoInstall = permissionRegistry.can('install_dependencies') && resolvedCommand !== undefined;
                    const installStep: PlanStep = {
                        id: installStepId,
                        description: autoInstall
                            ? `Instalar '${depInfo.name}' necessário para continuar: ${resolvedCommand}`
                            : `Instalar '${depInfo.name}' necessário para continuar (sem comando automático seguro para este sistema operacional — ${depInfo.manualInstructions})`,
                        // DEVELOPER/GOD com comando resolvido: toolName explícito → exec_command direto
                        // (sem auth gate do WorkflowEngine). Sem comando resolvido (SO sem entrada
                        // segura) OU modo SAFE: sem toolName → AgentLoop processa → WorkflowEngine
                        // pede confirmação / orienta instalação manual.
                        toolName: autoInstall ? 'exec_command' : undefined,
                        toolArgs: autoInstall ? { command: resolvedCommand } : undefined,
                        status: 'pending',
                        fallbackSteps: [],
                    };
                    if (autoInstall) {
                        log.info(`[GoalLoop] needs_dependency auto-install approved (mode=${permissionRegistry.getMode()}): ${depInfo.name}`);
                    } else if (resolvedCommand === undefined) {
                        log.info(`[GoalLoop] needs_dependency: sem comando de instalação seguro para este SO (dep=${depInfo.name}) — caminho manual/AgentLoop`);
                    }

                    // Reconstrói o plano: steps já concluídos + installStep + step que falhou + resto
                    const updatedPlan: PlanStep[] = [
                        ...currentGoal.currentPlan.filter(s => s.status === 'completed'),
                        installStep,
                        pendingStep,
                        ...this.getPendingSteps(currentGoal.currentPlan).filter(s => s.id !== pendingStep.id),
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
                    this.recordFailedStrategy(pendingStep, cycleResult.blocker.description, currentGoal.id, state);
                    this.updateProgressModel(pendingStep, 'failed', cycleResult.blocker.description, state);
                    currentGoal = this.goalStore.getById(currentGoal.id)!;

                    await onProgress?.({ goalId: currentGoal.id, cycle: totalCycles, event: 'replanning', message: cycleResult.blocker.description });

                    // Registra falha na ReflectionMemory para aprendizado futuro
                    // S2a: failureType=cycleResult.blocker.kind — já é um BlockerKind tipado,
                    // vindo direto do objeto blocker. Zero inferência: é o dado real do call site.
                    this.reflectionMemory.record({
                        userInput: currentGoal.userIntent,
                        intent: currentGoal.objective.slice(0, 100),
                        toolUsed: pendingStep.toolName ?? 'unknown',
                        approved: false,
                        reason: cycleResult.blocker.description,
                        confidence: cycleResult.confidence,
                        pattern: `tool_${pendingStep.toolName ?? cycleResult.blocker.kind}`,
                        suggestedFix: cycleResult.blocker.suggestedActions[0],
                        outcome: 'failure',
                        failureType: cycleResult.blocker.kind,
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
                    currentGoal = await this.planWithSpiral(currentGoal, cycleResult.blocker!, priorFeedback, totalReplans + 1, state);
                    totalReplans++;
                    break;
                }

                case 'failed': {
                    // Sprint 0.6, Front B: preserva o blocker classificado por GoalEvaluator
                    // antes desta falha ser tratada como terminal — sem isso, goal.blockers
                    // ficava vazio mesmo em falhas definitivas (esgotamento de budget).
                    if (cycleResult.blocker) {
                        this.goalStore.recordBlocker(currentGoal.id, cycleResult.blocker);
                    }
                    this.goalStore.setStatus(currentGoal.id, 'failed');
                    this.recordFailedStrategy(pendingStep, cycleResult.output ?? 'step falhou', currentGoal.id, state);
                    this.updateProgressModel(pendingStep, 'failed', cycleResult.output, state);
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
        const allStepsDone = this.getPendingSteps(currentGoal.currentPlan).length === 0;
        if (allStepsDone) {
            log.info(`[GoalLoop] goal=${currentGoal.id} MAX_CYCLES=${GOAL_LIMITS.MAX_CYCLES} reached but all steps done — running final validation`);
            const activeMilestone = currentGoal.isConstruction && currentGoal.roadmap && currentGoal.roadmap.length > 0
                ? currentGoal.roadmap[currentGoal.currentMilestoneIndex ?? 0]
                : undefined;
            const validation = await this.validateGoalCompletion(currentGoal, activeMilestone, state);
            if (validation.achieved) {
                const isLastMilestone = !currentGoal.isConstruction || !currentGoal.roadmap || (currentGoal.currentMilestoneIndex ?? 0) === currentGoal.roadmap.length - 1;
                if (isLastMilestone) {
                    this.goalStore.setStatus(currentGoal.id, 'completed');
                    // S5 (modo sombra): mesma captura condicionada a evidência do outro call site.
                    this.caseMemory.captureIfEligible(this.goalStore.getById(currentGoal.id)!);
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
        cycle: number,
        state: GoalExecutionState,
        onArtifactDelivered?: (filePath: string) => void,
        isAudioAlreadySent?: () => boolean,
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

            let toolResult: { success: boolean; output: string; error?: string; artifactPaths?: string[] };
            let stepMutations: import('./GoalTypes').ToolMutation[] | undefined;
            let stepEvalForAttempt: { confidence: number; reason?: string } | undefined;
            // Sprint 0.10 (achado L22): correlação com o ExecutionTrace do sub-turno agentloop,
            // preenchida logo após `agentLoop.process()` resolver (ver mais abaixo). Ausente no
            // caminho de tool direta (não passa por AgentLoop).
            let agentloopTraceId: string | undefined;
            let agentloopSubToolCalls: string[] | undefined;
            // Sprint 0.8 (achados L10/L11/L14/L15): true por padrão — o caminho de tool direta
            // (com toolName) é determinístico, sem heurística envolvida, sempre confiável.
            // Só o caminho 'agentloop' abaixo pode rebaixar para false.
            let stepSuccessConfident = true;
            // FIX C: acumulador de sends diferidos capturados do AgentLoop.
            // Usa Map<filePath, args> para deduplicar por artefato desde a captura.
            // Evita que o LLM chame send_document N vezes para o mesmo arquivo.
            const deferredSendArgsMap = new Map<string, Record<string, unknown>>();
            const deferredSendArgs: Array<Record<string, unknown>> = []; // view do Map (populado em sync)

            if (step.toolName) {
                // Execução via ToolRegistry com ProactiveRecovery (mutação de args + fallback)
                // toolArgs pode ser undefined quando a tool não tem args obrigatórios — defaulta para {}
                // Resolve referências {{step_N.output}} antes de executar (ex: write com content de exec anterior)
                const resolvedArgs = this.resolveStepRefs(step.toolArgs ?? {}, goal);
                const registered = this.toolRegistry.get(step.toolName);
                log.info(
                    `[TOOL-DISPATCH] goal=${goal.id} step=${step.id}` +
                    ` requested_tool=${step.toolName}` +
                    ` resolved_tool=${registered ? step.toolName : 'none'}` +
                    ` reason=${registered ? 'tool_found_in_registry' : 'tool_not_registered'}` +
                    ` args_provided=${step.toolArgs !== undefined}`
                );
                if (step.toolName === 'send_audio' && isAudioAlreadySent?.()) {
                    // Mesmo guard já usado no caminho agentloop (AgentLoop.ts, checks de
                    // channelContext.isAudioAlreadySent() antes de chamar send_audio). Esse
                    // dispatch direto (step.toolName vindo de um replan do GoalPlanner, sem
                    // passar por agentloop) nunca consultava o mesmo sinal — permitindo que um
                    // replan por falha em OUTRO step (ex.: extração de PPTX) reenviasse áudio
                    // já entregue com sucesso em um ciclo anterior do mesmo goal.
                    log.info(
                        `[DELIVERY-DEDUP] goal=${goal.id} step=${step.id}` +
                        ` artifact="__send_audio_delivered__"` +
                        ` reason=already_sent_in_goal_session` +
                        ` decision=skip`
                    );
                    toolResult = { success: true, output: '🔊 Áudio já enviado nesta execução do objetivo — reenvio evitado.' };
                } else if (!registered) {
                    toolResult = { success: false, output: '', error: `command not found: ${step.toolName}` };
                } else {
                    const getTool = (name: string): ToolExecutorLike | undefined =>
                        this.toolRegistry.get(name) as ToolExecutorLike | undefined;
                    const toolInstance = registered;
                    if (typeof (toolInstance as unknown as ContextAwareTool).setContext === 'function' && channelContext) {
                        (toolInstance as unknown as ContextAwareTool).setContext(channelContext.chatId, channelContext.channel);
                    }
                    const recoveryResult = await this.proactiveRecovery.execute(
                        step.toolName, resolvedArgs, getTool, new Set<string>(),
                        undefined,
                        { toolsTried: goal.toolsTried, userIntent: goal.userIntent },
                    );
                    toolResult = recoveryResult.result;
                    if (recoveryResult.recovered) {
                        const kind = recoveryResult.mutationKind ?? 'arg_mutation';
                        log.info('RECOVERY_OUTCOME',
                            `goal=${goal.id} step=${step.id}` +
                            ` tool=${recoveryResult.originalToolName ?? step.toolName}` +
                            ` final_tool=${recoveryResult.finalToolName}` +
                            ` mutation_kind=${kind}` +
                            ` step_passed=${recoveryResult.result.success}`
                        );
                    }
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
                            originalArgs: recoveryResult.originalArgs ?? resolvedArgs,
                            finalArgs: recoveryResult.finalArgs,
                            kind,
                        }];
                    }
                }
            } else {
                // Sem tool específica → chama AgentLoop com prompt focado no step
                const cognitiveBlock = this.buildIncrementalExecutionContext(goal, step, state);
                const focusLine = goal.cycleFocus
                    ? `\nFoco do ciclo: ${goal.cycleFocus}`
                    : '';
                const targetFile = this.extractTargetFileFromStep(step, goal);
                const reflectionLine = targetFile
                    ? `\n[REFLEXÃO] Arquivo alvo desta tarefa: ${targetFile}\nAntes de usar qualquer ferramenta, confirme que o arquivo corresponde ao alvo acima.`
                    : '';
                // C2: detectar intenções que requerem ação observável com dados reais.
                // Se o step pede "mostrar", "listar", "apresentar", "enviar", etc.,
                // o AgentLoop DEVE usar uma ferramenta — não produzir narrativa.
                const OBSERVABLE_PATTERNS = [
                    /\b(mostr[ae]r?|list[ae]r?|apresentar?|exibir?|visualizar?)\b/i,
                    /\b(enviar?|exportar?|gerar? arquivo|mostrar? resultado)\b/i,
                    /\b(apresente|liste|exiba|mostre|envie)\b/i,
                ];
                const requiresObservableExecution = OBSERVABLE_PATTERNS.some(p => p.test(step.description));
                if (requiresObservableExecution) {
                    log.info(
                        `[AGENTLOOP-EVIDENCE-CHECK]` +
                        ` step=${step.id}` +
                        ` task="${step.description.slice(0, 80)}"` +
                        ` requires_tool=true` +
                        ` reason=observable_action_in_step_description`
                    );
                }
                // Diretiva injetada no prompt: previne resposta narrativa quando há ação real a executar
                const evidenceDirective = requiresObservableExecution
                    ? `\n\n[REGRA DE EXECUÇÃO] Esta tarefa exige ação observável com dados reais. Chame obrigatoriamente uma ferramenta (list_workspace, read, exec_command, send_document, etc.) antes de responder. Não descreva o resultado sem executar a ferramenta que o produz.`
                    : '';

                const stepPrompt = [
                    `[GOAL STEP] ${this.sanitizeStepDescription(step.description)}`,
                    `\nContexto do objetivo: ${goal.objective}`,
                    focusLine,
                    reflectionLine,
                    evidenceDirective,
                    cognitiveBlock ? `\n${cognitiveBlock}` : '',
                ].join('');
                const { channel: goalCh, userId: sessionUserId } = parseSessionKey(goal.sessionKey);
                const stepSessionKey = { channel: goalCh || 'unknown', userId: sessionUserId || goal.conversationId };
                this.sessionManager?.resetTurnToolCounts(stepSessionKey);
                // FIX C + P3-DEDUP: captura sends diferidos com deduplicação por file_path.
                // deferSendDocument só aceita um artefato por caminho único nesta execução.
                const goalChannelContext: ChannelContext = {
                    ...channelContext,
                    deferSendDocument: (args) => {
                        const fp = String(args['file_path'] ?? args['path'] ?? '');
                        const key = fp || JSON.stringify(args);
                        if (deferredSendArgsMap.has(key)) {
                            log.info(
                                `[DELIVERY-DEDUP] artifact="${fp}"` +
                                ` reason=duplicate_defer_in_agentloop` +
                                ` existing_delivery=pending` +
                                ` decision=skip`
                            );
                            return;
                        }
                        deferredSendArgsMap.set(key, args);
                        deferredSendArgs.push(args);
                        log.info(`[DELIVERY-REGISTRY] artifact="${fp}" status=deferred_registered`);
                    },
                    isDeferredArtifact: (filePath: string) => {
                        return deferredSendArgsMap.has(filePath);
                    },
                    // CORREÇÃO 1: recebe notificação do DELIVERY-GUARD quando ele entrega
                    // um artefato diretamente (sem passar pelo deferSendDocument).
                    // Propaga para o caller (executeGoal) via onArtifactDelivered, que tem
                    // acesso a sentArtifacts no escopo correto. Isso garante que o path
                    // seja registrado antes que o SemanticValidator possa fazer downgrade
                    // para 'partial', bloqueando S10 e causando reentregas redundantes.
                    onArtifactDelivered: (filePath: string) => {
                        if (filePath) {
                            onArtifactDelivered?.(filePath);
                            log.info(
                                `[DELIVERY-GUARD-REGISTERED] goal=${goal.id}` +
                                ` artifact="${filePath}"` +
                                ` source=delivery_guard_callback`
                            );
                        }
                    },
                    isAudioAlreadySent: () => isAudioAlreadySent?.() ?? false,
                };
                const response = await this.agentLoop.process(
                    goal.conversationId,
                    stepPrompt,
                    sessionUserId ?? goal.conversationId,
                    goalChannelContext
                );
                const text = typeof response === 'string' ? response : response.text;
                const respOptions = typeof response === 'string' ? undefined : response.options;

                // Sprint 0.10 (achado L22): correlaciona o attempt com o ExecutionTrace real do
                // sub-turno que acabou de rodar, sem duplicar seu conteúdo — só a referência
                // (traceId, para pivotar em agent_traces/dashboard) e a sequência de nomes de
                // tools chamadas (subToolCalls, decomposição mínima da "caixa-preta" agentloop
                // direto no histórico do goal). traceManager.getRecentTraces() é o mesmo
                // singleton que AgentLoop já usa para persistir/emitir os traces — reaproveitado
                // aqui, nenhum mecanismo novo. Busca pelo mais recente com o mesmo
                // conversationId (traces são unshift'ados, então o primeiro match já é o mais
                // recente); se nada for encontrado (ex: trace pruned do buffer de 50), os campos
                // ficam undefined — falha aberta, sem afetar o resultado do step.
                const relatedTrace = traceManager.getRecentTraces(10).find(t => t.sessionId === goal.conversationId);
                if (relatedTrace) {
                    agentloopTraceId = relatedTrace.id;
                    agentloopSubToolCalls = relatedTrace.steps
                        .filter(s => s.type === 'tool_call')
                        .map(s => String(s.data?.tool ?? '').trim())
                        .filter(Boolean);
                }

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
                // Sprint 0.8 (achados L10/L11/L14/L15): 'success_signal_detected' é o único
                // motivo de sucesso de alta confiança da heurística (sinal explícito no texto).
                // 'substantial_response' (fallback conservador "resposta longa, assume sucesso")
                // NÃO é confiável — vira 'partial' abaixo, a menos que a escalada ao LLM confirme.
                stepSuccessConfident = stepEval.reason === 'success_signal_detected';
                if (stepEval.shouldEscalateToLLM) {
                    log.info(`[GoalStep] heuristic inconclusive (conf=${stepEval.confidence.toFixed(2)}) — escalating to LLM`);
                    const escalation = await this.escalateStepEvalToLLM(step, goal.objective, text);
                    finalSuccess = escalation.success;
                    stepSuccessConfident = escalation.confident;
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
                // Sprint 0.8 (achados L10/L11/L14/L15): 'success' só quando o resultado veio de
                // um sinal confiável (tool determinística, sinal explícito, ou LLM que de fato
                // confirmou) — caso contrário 'partial': a tarefa produziu output e não falhou
                // explicitamente, mas a conclusão não foi confirmada com confiança suficiente
                // para valer como evidência de sucesso (GoalEvaluator.ts:312 já trata 'partial'
                // como progresso equivalente a 'success', só não como prova de conclusão).
                result: !toolResult.success ? 'failure' : (stepSuccessConfident ? 'success' : 'partial'),
                output: toolResult.output?.slice(0, 300),
                error: toolResult.error,
                durationMs: Date.now() - startMs,
                executedAt: Date.now(),
                cycle,
                mutations: stepMutations,
                evaluation: stepEvalForAttempt,
                traceId: agentloopTraceId,
                subToolCalls: agentloopSubToolCalls,
                producedArtifactPaths: toolResult.artifactPaths,
            };
            this.goalStore.addAttempt(goal.id, attempt);

            // FIX #1: Alimenta SessionManager com resultado da tool para popular
            // activeFiles e deliveredArtifacts — habilita contexto cross-goal de artefatos.
            if (toolResult.success && step.toolName && this.sessionManager) {
                const stepSessionKey = {
                    channel: channelContext.channel,
                    userId: channelContext.userId ?? goal.conversationId,
                };
                this.sessionManager.recordToolCall(
                    stepSessionKey,
                    step.toolName,
                    JSON.stringify(step.toolArgs ?? {}),
                ).catch(() => {});
            }

            if (step.toolName) {
                this.goalStore.addToolTried(goal.id, step.toolName);
            }

            const cycleResult = this.evaluator.evaluate(goal, step, toolResult);
            // FIX C: propaga sends diferidos capturados do AgentLoop para o loop principal
            if (deferredSendArgs.length > 0) {
                cycleResult.deferredSends = deferredSendArgs;
                // S8: injeta pseudo-write attempts para artefatos criados pelo AgentLoop.
                // Writes feitos dentro do AgentLoop são invisíveis para goal.attempts (a camada
                // exterior só vê o step agentloop como attempt, não os writes internos).
                // Sem isso, checkClaimsAgainstEvidence derruba achieved=true com [UNVERIFIED-CLAIM]
                // mesmo quando o arquivo foi criado, DELIVERY-GUARD enviou e o usuário recebeu.
                for (const sendArgs of deferredSendArgs) {
                    const fp = String(sendArgs['file_path'] ?? sendArgs['path'] ?? '');
                    if (!fp) continue;
                    // toolName='send_document', não 'write': deferredSendArgs só é populado por
                    // deferSendDocument() (send_document interceptado dentro do AgentLoop) — o
                    // pseudo-attempt original gravava 'write', mascarando esta entrega de um
                    // consumidor que filtre goal.attempts por toolName==='send_document'
                    // (achado ao validar a hipótese de captura única, 16/07/2026).
                    this.goalStore.addAttempt(goal.id, {
                        id: `att_agentloop_write_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
                        planStepId: step.id,
                        toolName: 'send_document',
                        args: { file_path: fp },
                        result: 'success',
                        output: '[AGENTLOOP-WRITE] Arquivo gravado e entregue pelo AgentLoop',
                        durationMs: 0,
                        executedAt: Date.now(),
                        cycle,
                        producedArtifactPaths: [fp],
                    });
                }
            }
            const durationMs = Date.now() - startMs;
            log.info(`[GoalStep] goal=${goal.id} step=${step.id} tool=${step.toolName ?? 'agentloop'} outcome=${cycleResult.outcome} durationMs=${durationMs}${cycleResult.blocker ? ` blocker=${cycleResult.blocker.kind}` : ''}${deferredSendArgs.length > 0 ? ` deferred_sends=${deferredSendArgs.length}` : ''}`);
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

    // ── Step arg template resolution ─────────────────────────────────────────────

    /**
     * Resolve referências {{step_N.output}} nos toolArgs do step antes da execução.
     * O GoalPlanner pode gerar planos onde um step usa o output de step anterior como arg
     * (ex: write com content="{{step_1.output}}"). Sem resolução, o placeholder é escrito
     * literalmente — o arquivo gerado contém o texto "{{step_1.output}}" em vez do conteúdo real.
     */
    private resolveStepRefs(
        toolArgs: Record<string, unknown>,
        goal: Goal,
    ): Record<string, unknown> {
        const STEP_REF = /\{\{(step_\d+)\.output\}\}/g;

        // Build map: planStepId → output do último attempt bem-sucedido (ou parcial — Sprint
        // 0.8: 'partial' significa que a tool rodou e produziu output real, só sem confirmação
        // confiável de conclusão; o texto produzido continua válido para referência por steps
        // seguintes independente da confiança na conclusão da tarefa).
        const stepOutputs = new Map<string, string>();
        for (const attempt of goal.attempts) {
            if ((attempt.result === 'success' || attempt.result === 'partial') && attempt.output) {
                stepOutputs.set(attempt.planStepId, attempt.output);
            }
        }

        if (stepOutputs.size === 0) return toolArgs;

        const resolve = (v: unknown): unknown => {
            if (typeof v !== 'string') return v;
            if (!STEP_REF.test(v)) return v;
            STEP_REF.lastIndex = 0;
            const resolved = v.replace(STEP_REF, (_, stepId: string) => stepOutputs.get(stepId) ?? '');
            if (resolved !== v) {
                log.info(`[STEP-REF-RESOLVED] replaced "{{${v.match(/\{\{([^}]+)\}\}/)?.[1] ?? '?'}}}" with ${resolved.length} chars from prior step output`);
            }
            return resolved;
        };

        return Object.fromEntries(
            Object.entries(toolArgs).map(([k, v]) => [k, resolve(v)])
        );
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
     * Fail-safe: qualquer erro → assume success=true (conservador, evita loops de replan), mas
     * `confident: false` — Sprint 0.8 (achados L10/L11/L14/L15): distingue explicitamente uma
     * confirmação genuína do LLM (`confident: true`) do fail-safe conservador, permitindo ao
     * caller gravar `GoalAttempt.result: 'partial'` em vez de `'success'` quando o "sucesso" não
     * foi de fato confirmado — a mesma lógica de decisão de sempre, só expondo uma distinção
     * que já existia implicitamente.
     */
    private async escalateStepEvalToLLM(
        step: PlanStep,
        objective: string,
        agentResponse: string,
    ): Promise<{ success: boolean; confident: boolean }> {
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
            if (result.status !== 'success') return { success: true, confident: false };
            const cleaned = result.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const parsed = JSON.parse(cleaned);
            log.info(`[GoalStep] LLM escalation result: success=${parsed.success} step=${step.id}`);
            return { success: Boolean(parsed.success), confident: true };
        } catch {
            log.warn(`[GoalStep] LLM escalation failed — defaulting to success=true step=${step.id}`);
            return { success: true, confident: false };
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

    /**
     * `attemptRecording` decide como o(s) `GoalAttempt`(s) deste step são conciliados —
     * Sprint 0.8.3, achado residual 2 (dupla gravação de `GoalAttempt` para uma única
     * execução lógica). Os 3 modos cobrem os 3 fluxos estruturalmente distintos que chegam
     * aqui:
     *   - 'add' (default): nenhum attempt real foi gravado para este step nesta passagem
     *     (dedup de envio diferido — o step foi pulado; `resumeGoal()` — a autorização foi
     *     processada por uma execução real e distinta via WorkflowEngine, fora deste loop).
     *     Grava um attempt novo, 'success'.
     *   - 'skip': `executeStep()` já gravou o attempt real deste step nesta mesma passagem
     *     (`case 'success':` do switch principal; envio diferido bem-sucedido). Não grava
     *     nada nesse `GoalAttempt` — só lê o que já existe para alimentar a ReflectionMemory
     *     de forma coerente (ver abaixo).
     *   - 'finalize': `executeStep()` já gravou um attempt 'failure' para este step nesta
     *     mesma passagem (sinal de bloqueio de permissão), e uma decisão imediata no mesmo
     *     ciclo (auto-aprovação `needs_auth` em modo DEVELOPER/GOD) resolve esse bloqueio sem
     *     que uma segunda execução real e distinta tenha ocorrido. Corrige o attempt existente
     *     para 'success' em vez de acrescentar um segundo, contraditório.
     */
    private markStepDone(
        goal: Goal,
        step: PlanStep,
        output: string,
        attemptRecording: 'add' | 'skip' | 'finalize' = 'add',
        producedArtifactPaths?: string[],
    ): void {
        // Após instalação bem-sucedida de dependência, invalida tools + execution
        // para que o próximo replan detecte a ferramenta recém-instalada.
        if (step.id.startsWith('install_')) {
            this.capRegistry.invalidate('tools');
            this.capRegistry.invalidate('execution');
            log.info(`[GoalLoop] dep install step=${step.id} completed — capability cache invalidated`);
        }

        // outcome/confidence usados na ReflectionMemory logo abaixo — 'success'/0.9 por
        // padrão (attempt novo e genuinamente confirmado nos modos 'add'/'finalize'); no modo
        // 'skip', substituídos pelo resultado REAL já gravado por executeStep() (achado
        // residual 1, Sprint 0.8.3: ReflectionMemory precisa refletir o attempt real, não um
        // 'success'/0.9 fixo, senão um 'partial' de baixa confiança fica indistinguível de uma
        // conclusão confirmada para RiskAnalyzer/findToolFailures/findHardConstraints/
        // findCategoryHints).
        let reflectionOutcome: AttemptOutcome = 'success';
        let reflectionConfidence = 0.9;

        if (attemptRecording === 'add') {
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
                producedArtifactPaths,
            });
        } else if (attemptRecording === 'finalize') {
            this.goalStore.finalizeLastAttemptAsSuccess(goal.id, step.id, output);
        } else {
            const existing = [...goal.attempts].reverse().find(a => a.planStepId === step.id);
            if (existing) {
                reflectionOutcome = existing.result;
                reflectionConfidence = existing.evaluation?.confidence ?? 0.9;
            }
        }

        // ARCH-007: status='completed' é só o eixo de progressão do plano (não será
        // redespachado) — lastAttemptOutcome carrega a confiança REAL (reflectionOutcome já
        // resolvida acima, incluindo o caso 'skip' que lê o attempt de fato gravado por
        // executeStep()), tornando explícita a divergência que antes só existia dentro de
        // goal.attempts, invisível a partir do PlanStep.
        const updatedPlan = goal.currentPlan.map(s =>
            s.id === step.id
                ? { ...s, status: 'completed' as const, result: output.slice(0, 200), executedAt: Date.now(), lastAttemptOutcome: reflectionOutcome }
                : s
        );
        this.goalStore.update(goal.id, { currentPlan: updatedPlan });

        // Registra na ReflectionMemory.
        // IMPORTANTE: o pattern deve ser `tool_${toolName}` (sem sufixo _success) para que a
        // query de supressão em getFailurePatterns/getHardFailurePatterns encontre o registro
        // aprovado e descarte histórico de falhas obsoleto do mesmo tool.
        this.reflectionMemory.record({
            userInput: goal.userIntent,
            intent: goal.objective.slice(0, 100),
            toolUsed: step.toolName ?? 'agentloop',
            toolOutput: output.slice(0, 200),
            approved: reflectionOutcome !== 'failure',
            reason: reflectionOutcome === 'partial' ? 'step completed with low-confidence signal' : 'step completed successfully',
            confidence: reflectionConfidence,
            pattern: step.toolName ? `tool_${step.toolName}` : 'goal_step_success',
            outcome: reflectionOutcome,
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
    private buildIncrementalExecutionContext(goal: Goal, currentStep: PlanStep, state: GoalExecutionState): string {
        const attempts = goal.attempts;

        // ── Derivar categorias a partir de goal.attempts ─────────────────────
        // hash?: extraído do header do read_tool "[Arquivo: ... | hash=<sha1>]"
        const filesRead: Array<{ path: string; summary?: string; hash?: string }> = [];
        const filesModified: string[] = [];
        const generatedArtifacts: string[] = [];
        const executedCommands: string[] = [];
        const importantOutputs: string[] = [];
        const discoveries: string[] = [];

        const seenPaths = new Set<string>();

        for (const attempt of attempts) {
            if (attempt.result === 'failure') continue; // só attempts bem-sucedidos para contexto positivo

            const pathArg = String(attempt.args['path'] ?? attempt.args['file_path'] ?? '');

            // ARTIFACT-DRIFT FIX: incluir 'read' na detecção (antes só file_read/read_document)
            if (['read', 'file_read', 'read_document'].includes(attempt.toolName)) {
                if (pathArg && !seenPaths.has(`read:${pathArg}`)) {
                    seenPaths.add(`read:${pathArg}`);
                    // Extrai hash do header "[Arquivo: ... | hash=<sha1>]"
                    const hashMatch = attempt.output?.match(/\|\s*hash=([a-f0-9]{8,12})/i);
                    filesRead.push({
                        path: pathArg,
                        summary: attempt.output?.slice(0, 100).replace(/\n/g, ' '),
                        hash: hashMatch?.[1],
                    });
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

        // D: GoalProgressModel — visão dimensional do progresso para o AgentLoop
        // Elimina re-discovery e orienta o agente para o que ainda falta
        if (state.progressModel && state.progressModel.components.length > 0) {
            const pm = state.progressModel;
            const pending = pm.components.filter(c => c.status !== 'completed');
            const done = pm.components.filter(c => c.status === 'completed');
            if (done.length > 0 || pending.length > 0) {
                lines.push(`\nProgresso do objetivo (${pm.overallPercent}% concluído):`);
                for (const c of done) {
                    lines.push(`  ✓ ${c.label}${c.evidence ? ` — ${c.evidence.slice(0, 60)}` : ''}`);
                }
                for (const c of pending) {
                    const icon = c.status === 'failed' ? '✗' : '○';
                    lines.push(`  ${icon} ${c.label} — PENDENTE`);
                }
                if (pending.length > 0) {
                    lines.push(`  ⚑ Foco: complete ${pending.map(c => c.label).join(', ')}`);
                }
            }
        }

        // ARTIFACT-DRIFT FIX: separa arquivos lidos-e-depois-modificados (stale) dos apenas lidos
        const staleFiles = filesRead.filter(f => filesModified.includes(f.path));
        const freshReadFiles = filesRead.filter(f => !filesModified.includes(f.path));

        // [ARTIFACT-STATE]: compara hash do momento da leitura com hash atual em disco
        for (const stale of staleFiles) {
            try {
                const current = fs.readFileSync(stale.path, 'utf-8');
                const diskHash = crypto.createHash('sha1').update(current).digest('hex').slice(0, 12);
                const matches = stale.hash ? stale.hash === diskHash : null;
                log.info(
                    `[ARTIFACT-STATE] goal=${goal.id}` +
                    ` path="${stale.path}"` +
                    ` disk_hash=${diskHash}` +
                    ` context_hash=${stale.hash ?? '(unknown)'}` +
                    ` matches=${matches ?? 'unknown'}`
                );
            } catch {
                log.warn(`[ARTIFACT-STATE] goal=${goal.id} path="${stale.path}" readable=false`);
            }
        }

        if (staleFiles.length > 0) {
            lines.push('\n⚠️ ARQUIVOS MODIFICADOS APÓS LEITURA — REQUERE RELEITURA ANTES DE USAR:');
            for (const f of staleFiles) {
                lines.push(`  ⚠️ ${f.path} — conteúdo em cache pode estar DESATUALIZADO. Releia antes de qualquer modificação.`);
            }
        }

        if (freshReadFiles.length > 0) {
            lines.push('\nArquivos já lidos neste ciclo (válidos enquanto não modificados):');
            for (const f of freshReadFiles.slice(-8)) {
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
    private updateCognitiveContext(step: PlanStep, output: string, state: GoalExecutionState): void {
        const ctx = state.cognitiveContext;
        const text = output.slice(0, 800);

        // ARTIFACT-DRIFT FIX: incluir 'read' no rastreamento (antes só file_read/read_document)
        if (['read', 'file_read', 'read_document'].includes(step.toolName ?? '')) {
            const pathArg = step.toolArgs?.path ?? step.toolArgs?.file_path;
            if (typeof pathArg === 'string' && pathArg) {
                const alreadyTracked = ctx.filesRead.some(f => f.path === pathArg);
                if (!alreadyTracked) {
                    const summary = text.slice(0, 100).replace(/\n/g, ' ');
                    const hashMatch = output.match(/\|\s*hash=([a-f0-9]{8,12})/i);
                    ctx.filesRead.push({ path: pathArg, summary: summary || undefined, hash: hashMatch?.[1] });
                }
            }
        }

        // Arquivos modificados (write/edit): invalidar entrada de filesRead para forçar releitura
        if (step.toolName === 'write' || step.toolName === 'edit') {
            const pathArg = step.toolArgs?.path ?? step.toolArgs?.file_path;
            if (typeof pathArg === 'string' && pathArg) {
                if (!ctx.filesModified.includes(pathArg)) {
                    ctx.filesModified.push(pathArg);
                }
                // ARTIFACT-DRIFT FIX: remove da lista "já lidos" — o conteúdo em cache está desatualizado
                const prevRead = ctx.filesRead.find(f => f.path === pathArg);
                if (prevRead) {
                    ctx.filesRead = ctx.filesRead.filter(f => f.path !== pathArg);
                    log.info(`[ARTIFACT-STATE] goal=(cognitiveContext) path="${pathArg}" invalidated=true context_hash=${prevRead.hash ?? '(unknown)'}`);
                }
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
     * Atualiza o GoalProgressModel com o resultado de um step.
     * Permite rastrear o progresso por componente, não só binário sucesso/falha.
     */
    private updateProgressModel(
        step: PlanStep,
        status: ProgressComponent['status'],
        evidence: string | undefined,
        state: GoalExecutionState,
    ): void {
        if (!state.progressModel) return;

        const componentId = `step_${step.id}`;
        const existing = state.progressModel.components.find(c => c.id === componentId);

        if (existing) {
            existing.status = status;
            existing.evidence = evidence?.slice(0, 200);
            if (status === 'completed') existing.completedAt = Date.now();
        } else {
            state.progressModel.components.push({
                id: componentId,
                label: step.description.slice(0, 100),
                status,
                evidence: evidence?.slice(0, 200),
                completedAt: status === 'completed' ? Date.now() : undefined,
            });
        }

        const total = state.progressModel.components.length;
        const done = state.progressModel.components.filter(c => c.status === 'completed').length;
        state.progressModel.overallPercent = total > 0 ? Math.round((done / total) * 100) : 0;
        state.progressModel.updatedAt = Date.now();
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

            // Complementa a busca semântica pura (só embedding, limit=3) com a camada de
            // KEYWORD do MultiLayerRetriever — a mesma que o ContextBuilder já usa dentro dos
            // turnos do AgentLoop. Evidência real (05/07/2026): uma preferência de cidade padrão
            // para previsão do tempo ("sempre que perguntar sem informar a cidade, considere
            // [cidade padrão]") tinha score alto via camada KEYWORD quando o AgentLoop consultava
            // o contexto do step de send_audio — mas o PLANNER nunca via essa preferência,
            // porque contextualize() só fazia semanticSearch (puro embedding, sem boost de
            // keyword, sem tier de preferência). Resultado: o step de "weather" foi planejado
            // sem cidade, e a previsão saiu para uma cidade errada em vez do padrão salvo pelo
            // usuário.
            const alreadyIncluded = new Set(relevant.map(n => n.id));
            let keywordRelevant: Array<{ id: string; type: string; content: string }> = [];
            try {
                const retriever = new MultiLayerRetriever(this.memory.getDatabase());
                const keywordCandidateIds = retriever.keywordSearch(goal.userIntent, 5)
                    .filter(c => !alreadyIncluded.has(c.nodeId))
                    .slice(0, 3)
                    .map(c => c.nodeId);
                if (keywordCandidateIds.length > 0) {
                    const placeholders = keywordCandidateIds.map(() => '?').join(',');
                    const rows = this.memory.getDatabase().prepare(
                        `SELECT id, type, content FROM memory_nodes WHERE id IN (${placeholders}) AND (lifecycle_state IS NULL OR lifecycle_state = 'ACTIVE')`
                    ).all(...keywordCandidateIds) as Array<{ id: string; type: string; content: string }>;
                    keywordRelevant = rows.filter(r => r.content && r.content.trim().length > 10);
                }
            } catch (err) {
                log.warn('[GoalLoop] Q1 keyword memory search error:', String(err));
            }

            const allRelevant = [...relevant, ...keywordRelevant];
            if (allRelevant.length > 0) {
                const lines = allRelevant.map(n => {
                    /**
                     * COMPATIBILIDADE LEGADA
                     *
                     * Remove prefixos de paths absolutos de outros ambientes
                     * que ficaram gravados na memória persistida do sistema.
                     *
                     * Exemplo de dado afetado:
                     *   "mantém a pasta /home/X/Y/workspace/arquivos para..."
                     *   → "mantém a pasta arquivos para..."
                     *
                     * Objetivo: impedir que o LLM aprenda a gerar paths absolutos
                     * da VPS a partir de memórias antigas, causando geração de
                     * caminhos inválidos no ambiente atual.
                     *
                     * Meta de longo prazo: migrar memórias persistidas para
                     * conterem apenas caminhos relativos ou nomes de arquivo.
                     *
                     * QUANDO REMOVER:
                     * Quando todos os nós de memória relevantes já contiverem
                     * apenas caminhos relativos ou não contiverem paths.
                     */
                    const content = String(n.content).replace(
                        /\/(?:home|Users)\/[^\s/]+\/[^\s/]+\/workspace\/([^\s,;'")\]]*)/g,
                        '$1'
                    );
                    return `- [${n.type}] ${content.slice(0, 150)}`;
                });
                parts.push(`Contexto da memória (relevante ao objetivo):\n${lines.join('\n')}`);
            }
        } catch (err) {
            log.warn('[GoalLoop] Q1 memory search error:', String(err));
        }

        // Sprint 3.7A — Q1 Skill Discovery: informa o planner sobre skills relevantes
        // Usa capability-based matching (SkillDiscovery) para separar linguagem do usuário
        // dos domínios de capacidade, sem regras hardcoded.
        try {
            const { discoverSkills } = await import('../skills/SkillDiscovery');
            const availableSkills = this.planner.getAvailableSkills();
            const discovery = discoverSkills(availableSkills, goal.userIntent);

            const relevantSkills = discovery.all;
            if (relevantSkills.length > 0) {
                const names = relevantSkills.map(s => s.name).join(', ');
                parts.push(
                    `Skills especializadas disponíveis para este objetivo: ${names}.\n` +
                    `O planner já recebeu as instruções dessas skills. Priorize-as.`
                );
                log.info(
                    `[SKILL-DISCOVERY]` +
                    ` goal=${goal.id}` +
                    ` capabilities=${[...new Set(discovery.byCapability.flatMap(m => m.matchedTerms))].join(',') || '(trigger)'}` +
                    ` matched_skills=${relevantSkills.map(s => s.name).join(',')}` +
                    ` source=local` +
                    ` cycle=${cycleNumber}`
                );
            } else {
                // Nenhuma skill local — sugerir skill-manager se o objetivo é especializado
                const hasComplexIntent = goal.userIntent.split(/\s+/).length >= 4;
                if (hasComplexIntent && availableSkills.length > 0) {
                    log.info(
                        `[SKILL-DISCOVERY]` +
                        ` goal=${goal.id}` +
                        ` matched_skills=none` +
                        ` source=local` +
                        ` cycle=${cycleNumber}` +
                        ` note=no_local_skill_for_domain`
                    );
                }
            }
        } catch (err) {
            log.warn('[GoalLoop] Q1 skill discovery error:', String(err));
        }

        // Padrões de falha conhecidos (tools já tentadas)
        const failureHints = goal.toolsTried
            .map(t => this.reflectionMemory.buildContextHint(`tool_${t}`))
            .filter(Boolean);
        if (failureHints.length > 0) {
            parts.push(`Histórico de execuções com ferramentas já usadas:\n${failureHints.join('\n')}`);
        }

        // Artefatos entregues em goals anteriores da mesma sessão (P1.1)
        // Permite que o GoalPlanner saiba que um arquivo já foi entregue ao usuário
        // e não tente re-gerar ou re-ler de um path incorreto.
        try {
            if (this.sessionManager && goal.sessionKey) {
                const { channel: ch, userId: uid } = parseSessionKey(goal.sessionKey);
                const deliveredBlock = this.sessionManager.getDeliveredArtifactsBlock(
                    { channel: ch || 'unknown', userId: uid || 'unknown' }
                );
                if (deliveredBlock) {
                    parts.push(deliveredBlock);
                }
            }
        } catch (err) {
            log.warn('[GoalLoop] Q1 delivered artifacts error:', String(err));
        }

        // Fallback persistente para o bloco acima: SessionManager.deliveredArtifacts é um Map
        // em memória, apagado por cleanupInactiveSessions após só 10-15min sem atividade. Um
        // usuário que pausa a conversa por mais tempo que isso e volta pedindo para editar "o
        // que você me mandou" perde esse contexto — o planner cai de volta a explorar o
        // workspace inteiro (compartilhado por TODOS os goals/temas já executados, de qualquer
        // sessão) sem nenhum sinal de qual arquivo é o certo. Reproduzido ao vivo (09/07,
        // gap de 22min entre 18:44 e 19:06): usuário pediu para tornar editável "esse que
        // mandou" (aula_ipv4_vs_ipv6.md) e recebeu de volta um arquivo sobre "DHCP e IP Manual"
        // — tema de um goal antigo completamente não relacionado, só por ordem alfabética do
        // workspace. goal.sentArtifacts é persistido em SQLite por goal (sobrevive a esse
        // cleanup e a reinícios do processo) — consultamos os goals recentes da MESMA sessão
        // como fonte complementar, sempre presente independente do estado da memória.
        try {
            if (goal.sessionKey) {
                const recentGoals = this.goalStore.getRecentBySession(goal.sessionKey, 5)
                    .filter(g => g.id !== goal.id && g.sentArtifacts && g.sentArtifacts.length > 0);
                const paths = new Set<string>();
                for (const g of recentGoals) for (const p of g.sentArtifacts ?? []) paths.add(p);
                if (paths.size > 0) {
                    parts.push(
                        `ARQUIVOS ENTREGUES EM GOALS ANTERIORES DESTA SESSÃO (persistente — use estes paths exatos ao referenciar "o arquivo que você me mandou"):\n` +
                        [...paths].map(p => `- ${p}`).join('\n')
                    );
                }
            }
        } catch (err) {
            log.warn('[GoalLoop] Q1 recent-session sentArtifacts error:', String(err));
        }

        // Estado atual do workspace — paths criados/modificados neste goal.
        // Injetado em plan() e replan() para garantir consistência de paths entre ciclos.
        // Sem este bloco o replanner não sabe que landing-page/index.html existe e cria
        // index.html na raiz, gerando path drift.
        const priorWrittenPaths = goal.attempts
            .filter(a => a.result === 'success' && ['write', 'edit'].includes(a.toolName))
            .map(a => String(a.args['path'] ?? a.args['file_path'] ?? ''))
            .filter(Boolean);
        if (priorWrittenPaths.length > 0) {
            const unique = [...new Set(priorWrittenPaths)];
            parts.push(
                `ESTADO ATUAL DO WORKSPACE\n\nArquivos já criados/modificados neste goal:\n` +
                unique.map(p => `  - ${p}`).join('\n') +
                `\n\nIMPORTANTE: mantenha estes caminhos exatos. Não recrie os arquivos em ` +
                `diretórios diferentes. Continue a partir desta estrutura.`
            );
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
    private recordFailedStrategy(step: PlanStep, reason: string, goalId: string | undefined, state: GoalExecutionState): void {
        const strategy = step.toolName
            ? `${step.toolName}: ${step.description.slice(0, 80)}`
            : step.description.slice(0, 100);
        const entry = `${strategy} — ${reason.slice(0, 80)}`;

        // Persiste no GoalStore (durável, read-by buildIncrementalExecutionContext)
        if (goalId) {
            this.goalStore.addStrategyTried(goalId, entry);
        }

        // Cache in-memory para a sessão atual (compatibilidade com código legado)
        if (!state.cognitiveContext.failedStrategies.includes(entry)) {
            state.cognitiveContext.failedStrategies.push(entry);
            if (state.cognitiveContext.failedStrategies.length > 6) {
                state.cognitiveContext.failedStrategies.shift();
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

        // Critérios auto-injetados por ensureDeliverySuccessCriteria (AUTO_DELIVERY_CRITERION_IDS)
        // têm description = rótulo interno de auditoria ("Entrega confirmada via send_audio"),
        // nunca prosa pra usuário. Esse summary vira overrideOutput em buildResult() — que tem
        // prioridade sobre o output real da tool (ex: "🔊 Áudio enviado com sucesso!") — então,
        // sem filtrar, o rótulo interno vaza verbatim como resposta final ao usuário quando o
        // único critério satisfeito é um de entrega automática. Evidência real: 2026-07-05,
        // goal_1783272571191_4y62y — usuário recebeu literalmente "Entrega confirmada via
        // send_audio" como resposta a um pedido de análise de cripto.
        const AUTO_DELIVERY_IDS = new Set(Object.values(AUTO_DELIVERY_CRITERION_IDS) as string[]);
        return {
            result: allMet ? 'all_met' : 'some_pending',
            updated,
            metCount,
            summary: updated
                .filter(c => c.status === 'met' && !AUTO_DELIVERY_IDS.has(c.id))
                .map(c => c.description)
                .join('; '),
        };
    }

    private async validateGoalCompletion(goal: Goal, activeMilestone: string | undefined, state: GoalExecutionState): Promise<{
        achieved: boolean;
        summary?: string;
        reason?: string;
        suggestions?: string[];
        /**
         * Caminhos (formato bruto, igual a toolArgs.file_path/sentArtifacts) de artefatos que
         * esta validação confirmou existir em disco AGORA — evidência real, não o que o plano
         * pretendia. Usado pelo caller para corrigir um send_document diferido cujo file_path
         * ficou desatualizado após um pivô de estratégia (ex.: plano previa .html, execução
         * pivotou para .pptx no meio do caminho) — ver achado replan/pivot 2026-07-12.
         */
        artifactPaths?: string[];
    }> {
        // ── 1. Verificação determinística via checklist (sem LLM) ─────────────────
        const criteriaEval = this.evaluateCriteria(goal);
        if (criteriaEval.result === 'all_met' && criteriaEval.metCount > 0) {
            // Persiste o estado atualizado dos critérios no store
            this.goalStore.update(goal.id, { successCriteria: criteriaEval.updated });
            log.info(`[GoalLoop] LLM validation: todos os critérios cumpridos — achieved=true sem LLM`);
            return { achieved: true, summary: criteriaEval.summary || GENERIC_CRITERIA_SUMMARY };
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

        // FIX D: lê o conteúdo real dos artefatos produzidos para injetar no prompt do validador
        const writtenPaths = [...new Set(
            goal.attempts
                .filter(a => a.result === 'success' && ['write', 'edit'].includes(a.toolName))
                .map(a => String(a.args['path'] ?? a.args['file_path'] ?? ''))
                .filter(Boolean)
        )];
        const artifactLines: string[] = [];
        const existingArtifactPaths: string[] = [];
        for (const rawPath of writtenPaths) {
            const { resolved: filePath } = resolvePath(rawPath);
            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                const truncated = content.length > 2000 ? content.slice(0, 2000) + '\n...(truncado)' : content;
                const hash = crypto.createHash('sha1').update(content).digest('hex').slice(0, 12);
                log.info(
                    `[VALIDATION-ARTIFACT] goal=${goal.id}` +
                    ` path="${filePath}" chars=${content.length} hash=${hash} included=true`
                );
                artifactLines.push(`--- ARQUIVO: ${filePath} (${content.length} chars, hash=${hash}) ---\n${truncated}`);
                existingArtifactPaths.push(rawPath); // formato bruto — mesma convenção de toolArgs.file_path/sentArtifacts
            } catch {
                log.warn(`[VALIDATION-ARTIFACT] goal=${goal.id} path="${filePath}" included=false readable=false`);
            }
        }
        const artifactBlock = artifactLines.length > 0
            ? `\nCONTEÚDO REAL DOS ARTEFATOS EM DISCO:\n${artifactLines.join('\n\n')}`
            : '';

        // L-M2 cobriu checkClaimsAgainstEvidence (aceitar a claim), mas não o PROMPT do
        // validador em si: quando step_fallback→agentloop entrega via write+send_document
        // internamente, isso vira uma única tentativa opaca toolName='agentloop' em
        // goal.attempts — invisível para stepsContext/attemptsContext/artifactBlock acima.
        // Sem este bloco, o validador só enxerga os steps do ciclo/replan atual e escreve um
        // "summary" que ignora a entrega real (evidência real: goal_1783430280404_xk7ht,
        // 07/07 — resumo final falou só em "markdown lido e validado", nunca mencionando o
        // .pptx que já tinha sido enviado pelo agentloop dois ciclos antes).
        const deliveredArtifactLines: string[] = [];
        for (const rawPath of goal.sentArtifacts ?? []) {
            if (rawPath === '__send_audio_delivered__') continue; // sentinela de dedup, não é arquivo
            const { resolved: filePath } = resolvePath(rawPath);
            try {
                const stat = fs.statSync(filePath);
                deliveredArtifactLines.push(`- ${filePath} (${stat.size} bytes, já entregue ao usuário nesta sessão)`);
            } catch {
                // arquivo listado como entregue mas não encontrado em disco — não afirmar entrega
            }
        }
        const deliveredArtifactsBlock = deliveredArtifactLines.length > 0
            ? `\nARTEFATOS JÁ ENTREGUES AO USUÁRIO NESTA SESSÃO DESTE OBJETIVO (não recrie nem ignore isto no resumo):\n${deliveredArtifactLines.join('\n')}`
            : '';

        // B: injeta GoalProgressModel no prompt de validação — o LLM sabe o que foi e não foi entregue
        const progressBlock = state.progressModel && state.progressModel.components.length > 0
            ? (() => {
                const pm = state.progressModel!;
                const compLines = pm.components.map(c => {
                    const icon = c.status === 'completed' ? '✓' : c.status === 'failed' ? '✗' : '○';
                    return `  ${icon} ${c.label}${c.evidence ? ` — ${c.evidence.slice(0, 80)}` : ''}`;
                });
                return `\nPROGRESSO POR COMPONENTE (${pm.overallPercent}% concluído):\n${compLines.join('\n')}\n`;
            })()
            : '';

        const prompt = `Você é um validador de tarefas de software. Verifique se o objetivo especificado foi COMPLETAMENTE concluído.

ALVO DE VALIDAÇÃO:
${validationTarget}

INTENÇÃO ORIGINAL DO USUÁRIO: ${goal.userIntent}
${progressBlock}
STEPS EXECUTADOS RECENTEMENTE:
${stepsContext || '(nenhum)'}

RESULTADOS DAS FERRAMENTAS:
${attemptsContext || '(nenhum)'}${artifactBlock}${deliveredArtifactsBlock}

IMPORTANTE — INTERPRETAÇÃO DE OUTPUTS:
- Comandos de edição in-place (sed -i, python3 -c com open().write(), etc.) produzem SAÍDA VAZIA quando bem-sucedidos. Output vazio = SUCESSO para esses comandos.
- Se o resultado de uma ferramenta exec_command está vazio e não há mensagem de erro, assuma que o comando foi bem-sucedido.
- Se alguma leitura posterior (read, exec_command grep) mostra o conteúdo modificado, isso confirma a edição.
- Se o conteúdo real do arquivo está disponível acima, use ESSE conteúdo como fonte primária de verdade.
- Se houver ARTEFATOS JÁ ENTREGUES listados acima, o "summary" deve mencionar explicitamente esse artefato (nome do arquivo) como o resultado entregue — não descreva apenas os steps do ciclo atual (ex: releitura de um markdown de referência) como se fossem o objetivo em si.
- Se PROGRESSO POR COMPONENTE mostra ≥70% concluído, considere entrega parcial como "achieved: true" com summary indicando o que ficou pendente.
- QUALIDADE DE ARTEFATOS: se um arquivo criado pela ferramenta "write" tiver menos de 200 caracteres OU contiver placeholders evidentes ("[Inserir aqui", "TODO", "stub", "conteúdo será adicionado", texto genérico de uma linha sem dados reais), o objetivo NÃO foi atingido — marque achieved=false. Um arquivo de resumo de pesquisa com apenas uma frase genérica não constitui entrega real do objetivo.

Análise crítica: o objetivo ou marco atual foi atingido E o resultado/entregável esperado foi produzido com sucesso?
Se for um marco de desenvolvimento, verifique se os arquivos/funcionalidades desse marco foram realmente criados e testados.

Responda APENAS com JSON válido (sem markdown):
{"achieved": true, "summary": "resumo do que foi feito e entregue neste marco/objetivo"}
OU
{"achieved": false, "reason": "o que está faltando para concluir este marco/objetivo", "suggestions": ["ação 1", "ação 2"]}`;

        // H2 observabilidade: registra o input exato enviado ao validador LLM
        // S4: dedup — o mesmo arquivo pode aparecer em múltiplas tentativas bem-sucedidas
        // (ex: write + exec_command no mesmo path). Sem dedup, o log VALIDATION-INPUT
        // lista o mesmo artefato duas vezes e confunde análises de auditoria.
        const artifactsInAttempts = [...new Set(
            goal.attempts
                .filter(a => a.result === 'success' && ['write', 'edit', 'exec_command'].includes(a.toolName))
                .map(a => String(a.args['path'] ?? a.args['file_path'] ?? ''))
                .filter(Boolean)
        )];
        log.info(
            `[VALIDATION-INPUT] goal=${goal.id}` +
            ` files="${artifactsInAttempts.join(',') || '(none)'}"`  +
            ` steps_chars=${stepsContext.length}` +
            ` attempts_chars=${attemptsContext.length}` +
            ` total_chars=${stepsContext.length + attemptsContext.length}`
        );
        // H8: snapshot do arquivo em disco no momento da validação — prova que o validador
        // está avaliando o mesmo artefato que foi escrito (detecta cache/leitura antecipada)
        const uniqueArtifacts = [...new Set(artifactsInAttempts)];
        for (const rawArtifact of uniqueArtifacts) {
            const { resolved: filePath } = resolvePath(rawArtifact);
            try {
                const stat = fs.statSync(filePath);
                const content = fs.readFileSync(filePath, 'utf-8');
                const hash = crypto.createHash('sha1').update(content).digest('hex').slice(0, 12);
                log.info(
                    `[VALIDATION-FILE] goal=${goal.id}` +
                    ` path="${filePath}"` +
                    ` size=${content.length}` +
                    ` mtime=${stat.mtimeMs}` +
                    ` hash=${hash}`
                );
            } catch {
                log.warn(`[VALIDATION-FILE] goal=${goal.id} path="${filePath}" readable=false`);
            }
        }

        let llmResult: Awaited<ReturnType<typeof this.providerFactory.chatWithFallback>> | undefined;
        try {
            llmResult = await this.providerFactory.chatWithFallback(
                [{ role: 'user', content: prompt }] as LLMMessage[],
                undefined,
                undefined,
                45_000,
            );

            if (llmResult.status !== 'success') {
                // S5.5a (Outcome Integrity): falha TÉCNICA da chamada de validação não é evidência
                // de sucesso — antes assumia achieved=true aqui, confundindo "não consegui verificar"
                // com "confirmei que foi atingido". Mesma reação de caller já usada e comprovada
                // segura pelo caminho de parse inválido (mais abaixo): achieved=false + reason
                // técnico, bloqueado por replanBudget finito (sem risco de loop infinito).
                log.warn(`[OUTCOME-INTEGRITY] goal=${goal.id} validator_call_status=${llmResult.status} — tratando como NÃO verificado (achieved=false), não como sucesso`);
                return {
                    achieved: false,
                    reason: 'Validação técnica indisponível (chamada ao LLM de validação falhou) — objetivo não pôde ser confirmado como concluído.',
                };
            }

            const cleaned = llmResult.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const parsed = JSON.parse(cleaned);
            log.info(`[GoalLoop] LLM validation: achieved=${parsed.achieved}${parsed.reason ? ` reason="${parsed.reason}"` : ''}`);
            // H2 observabilidade: resultado do validador com métricas de contexto.
            // Soma sentArtifacts — do contrário este contador fica em 0 sempre que a entrega
            // aconteceu via agentloop (toolName='agentloop' opaco), mesmo com artefato real
            // no disco e já enviado (ver deliveredArtifactsBlock acima).
            const artifactCount = goal.attempts.filter(a => a.result === 'success' && ['write', 'send_document'].includes(a.toolName)).length
                + (goal.sentArtifacts ?? []).filter(a => a !== '__send_audio_delivered__').length;
            log.info(
                `[VALIDATION] goal=${goal.id}` +
                ` achieved=${parsed.achieved}` +
                ` reason="${(parsed.reason ?? parsed.summary ?? '').slice(0, 120)}"` +
                ` content_chars=${attemptsContext.length}` +
                ` artifact_count=${artifactCount}`
            );
            // C6: registrar razão de conclusão com evidências de suporte
            const successToolsList = goal.attempts
                .filter(a => a.result === 'success')
                .map(a => a.toolName)
                .filter((v, i, arr) => arr.indexOf(v) === i)
                .join(',');
            log.info(
                `[GOAL-COMPLETION-REASON]` +
                ` goal=${goal.id}` +
                ` achieved=${Boolean(parsed.achieved)}` +
                ` reason="${(parsed.reason ?? parsed.summary ?? '').slice(0, 100)}"` +
                ` supporting_tools="${successToolsList.slice(0, 120)}"`
            );

            // C1/C5: verificação de evidência pós-LLM (anti-alucinação).
            // Se o LLM afirma achieved=true com claims observáveis ("foi apresentado",
            // "foi enviado", etc.), verifica se existe attempt correspondente em goal.attempts.
            // Funciona para qualquer tool — não hardcoded para casos específicos.
            if (parsed.achieved) {
                const evidenceCheck = this.checkClaimsAgainstEvidence(
                    goal,
                    parsed.summary ?? parsed.reason ?? ''
                );
                log.info(
                    `[GOAL-EVIDENCE-SUMMARY]` +
                    ` goal=${goal.id}` +
                    ` claims_detected=${evidenceCheck.claimsChecked}` +
                    ` evidence_found=${evidenceCheck.satisfied ? evidenceCheck.claimsChecked : Math.max(0, evidenceCheck.claimsChecked - 1)}` +
                    ` missing_evidence=${evidenceCheck.satisfied ? 'none' : (evidenceCheck.missingTool ?? 'unknown')}` +
                    ` decision=${evidenceCheck.satisfied ? 'accept' : 'reject'}`
                );
                if (!evidenceCheck.satisfied) {
                    log.warn(
                        `[UNVERIFIED-CLAIM]` +
                        ` goal=${goal.id}` +
                        ` claim="${evidenceCheck.claim}"` +
                        ` missing_evidence="${evidenceCheck.missingTool}"` +
                        ` llm_said=achieved_true` +
                        ` decision=override_to_false`
                    );
                    return {
                        achieved: false,
                        reason: `Alegação não comprovada: "${evidenceCheck.claim}" — nenhum attempt de "${evidenceCheck.missingTool}" foi encontrado no histórico de execução.`,
                        suggestions: [
                            `Execute "${evidenceCheck.missingTool}" para produzir os dados antes de afirmar resultado`,
                        ],
                    };
                }
            }

            return {
                achieved: Boolean(parsed.achieved),
                summary: parsed.summary,
                reason: parsed.reason,
                suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : undefined,
                artifactPaths: existingArtifactPaths,
            };
        } catch (err) {
            // LLM respondeu em texto livre (ex: thinking recovered de timeout) → não confirma sucesso
            if (err instanceof SyntaxError && llmResult?.status === 'success' && llmResult.content.length > 50) {
                log.warn('[GoalLoop] validation response not JSON — treating as goal_incomplete');
                return { achieved: false, reason: 'LLM de validação não retornou JSON válido' };
            }
            // S5.5a (Outcome Integrity): exceção técnica não tratada durante a validação (rede,
            // parsing inesperado, etc.) não é evidência de sucesso — antes assumia achieved=true
            // aqui. Mesma reação de caller já comprovada segura pelo caminho de SyntaxError acima.
            log.warn(`[OUTCOME-INTEGRITY] goal=${goal.id} validator_exception="${String(err)}" — tratando como NÃO verificado (achieved=false), não como sucesso`);
            return {
                achieved: false,
                reason: 'Erro técnico durante a validação de conclusão — objetivo não pôde ser confirmado como concluído.',
            };
        }
    }

    /**
     * C1/C5 — Anti-alucinação: verifica se afirmações no texto do LLM têm evidência operacional.
     *
     * Detecta padrões de claim ("foi apresentado", "foi enviado", etc.) e verifica se
     * existe um GoalAttempt bem-sucedido com a ferramenta correspondente.
     * Genérico — funciona para qualquer tool registrada no sistema.
     *
     * Não usa regras hardcoded para ferramentas específicas — o mapeamento é baseado
     * em categorias de ação (apresentação, entrega, exportação, criação, organização).
     */
    private checkClaimsAgainstEvidence(
        goal: Goal,
        llmSummary: string,
    ): { satisfied: boolean; claimsChecked: number; claim?: string; missingTool?: string } {
        // Mapeamento genérico: padrão de alegação → ferramentas que devem ter sido executadas.
        // "requireNonEmptyOutput": só conta como evidência se a ferramenta retornou dados reais.
        const CLAIM_RULES: Array<{
            pattern: RegExp;
            label: string;
            requiredTools: string[];
            requireNonEmptyOutput?: boolean;
        }> = [
            {
                // "foi apresentado / foi exibido / foi mostrado / foi listado"
                pattern: /foi\s+(apresentad[ao]|exibid[ao]|mostrad[ao]|listado|visualizad[ao])\b/i,
                label: 'apresentação/listagem de dados reais',
                requiredTools: ['list_workspace', 'read', 'read_document', 'exec_command', 'organize_workspace'],
                requireNonEmptyOutput: true,
            },
            {
                // "foi enviado / foi entregue"
                pattern: /foi\s+(enviado|entregue|transmitid[ao])\b/i,
                label: 'envio de artefato',
                requiredTools: ['send_document', 'send_audio'],
            },
            {
                // "foi exportado / foi convertido"
                pattern: /foi\s+(exportad[ao]|convertid[ao])\b/i,
                label: 'exportação ou conversão',
                requiredTools: ['exec_command', 'write', 'send_document'],
            },
            {
                // "foi organizado / foi reorganizado"
                // write é evidência válida: criar/estruturar arquivos já é "organizar"
                pattern: /foi\s+(organizad[ao]|reorganizad[ao])\b/i,
                label: 'organização de arquivos',
                requiredTools: ['organize_workspace', 'exec_command', 'write'],
            },
            {
                // "foi criado / foi gerado"
                pattern: /foi\s+(criad[ao]|gerado|gerada)\b/i,
                label: 'criação ou geração de artefato',
                requiredTools: ['write', 'exec_command'],
            },
        ];

        const successfulAttempts = goal.attempts.filter(a => a.result === 'success');
        // L-M2: quando step_fallback→agentloop executa write+send_document internamente,
        // os attempts ficam com toolName='agentloop' — invisível para o evidence checker.
        // goal.sentArtifacts é populado pelo DELIVERY-GUARD callback durante a execução
        // do agentloop, sendo prova direta de que write+send_document aconteceram.
        const hasRegisteredDelivery = (goal.sentArtifacts ?? []).length > 0;
        const DELIVERY_TOOLS = new Set(['write', 'exec_command', 'send_document', 'send_audio']);
        let claimsChecked = 0;

        // "Algo foi enviado" não é o mesmo que "o que foi pedido foi enviado". Reusa
        // inferExpectedExtensions — o mesmo sinal estrutural já usado pelo deliverable_check
        // logo abaixo neste arquivo — para exigir que o artefato de fato enviado via
        // send_document tenha a extensão esperada pelo pedido original, em vez de aceitar
        // qualquer arquivo que tenha passado por send_document/sentArtifacts na execução do
        // goal. Reproduzido ao vivo em 09/07: um script .py (código-fonte, não executado
        // ainda) foi enviado por engano via callback do DELIVERY-GUARD, e o evidence-checker
        // aceitava isso como prova de "PPTX editável enviado" só porque sentArtifacts não
        // estava vazio — mesma classe de bug que a fabricação de um .md de "resumo de
        // entrega" em vez do arquivo pedido (goal_incomplete → decoy) — ver
        // project_session_bugs_jul2026_ap. Quando o intent não permite inferir uma extensão
        // esperada (goal sem tipo de arquivo específico), não restringe — mantém o
        // comportamento permissivo original.
        const expectedExts = inferExpectedExtensions(goal.userIntent);
        const matchesExpectedType = (filePath: string): boolean =>
            expectedExts.length === 0 || expectedExts.some(ext => filePath.toLowerCase().endsWith(ext));

        for (const rule of CLAIM_RULES) {
            if (!rule.pattern.test(llmSummary)) continue;
            claimsChecked++;
            const isDeliveryClaim = rule.requiredTools.includes('send_document') || rule.requiredTools.includes('send_audio');

            const evidenceAttempt = successfulAttempts.find(a => {
                if (!rule.requiredTools.includes(a.toolName)) return false;
                if (rule.requireNonEmptyOutput) {
                    return (a.output ?? '').trim().length > 10;
                }
                if (isDeliveryClaim && a.toolName === 'send_document') {
                    const fp = String(a.args?.['file_path'] ?? a.args?.['path'] ?? '');
                    return matchesExpectedType(fp);
                }
                return true;
            });

            if (!evidenceAttempt) {
                // L-M2: se agentloop registrou entrega via DELIVERY-GUARD e a claim requer
                // uma tool de entrega (write, send_document, exec_command), aceitar como evidência —
                // mas só se algum dos artefatos registrados bater com o tipo esperado, quando
                // a claim é especificamente de envio (ver comentário acima).
                // Isso cobre o padrão step_fallback→agentloop que entrega internamente.
                if (hasRegisteredDelivery && rule.requiredTools.some(t => DELIVERY_TOOLS.has(t))) {
                    const registeredArtifacts = goal.sentArtifacts ?? [];
                    const registeredTypeOk = !isDeliveryClaim || registeredArtifacts.some(matchesExpectedType);
                    if (registeredTypeOk) {
                        log.info(
                            `[VALIDATION-EVIDENCE]` +
                            ` claim="${rule.label}"` +
                            ` evidence_found="agentloop_delivery"` +
                            ` registered_artifacts="${registeredArtifacts.join(',')}"` +
                            ` decision=accept`
                        );
                        continue;
                    }
                    log.warn(
                        `[VALIDATION-EVIDENCE]` +
                        ` claim="${rule.label}"` +
                        ` registered_artifacts="${registeredArtifacts.join(',')}"` +
                        ` expected_ext="${expectedExts.join('|')}"` +
                        ` decision=reject_artifact_type_mismatch`
                    );
                    // Não aceita — o artefato registrado não é do tipo pedido. Cai para os
                    // checks abaixo (step pendente que ainda vai satisfazer / falha real).
                }

                // Step pendente que satisfará esta claim já está no plano — não bloquear.
                // Evita deadlock onde readyToValidate=true (só send_document pendente) mas
                // a evidência ainda não existe porque o step ainda não foi despachado.
                const hasPendingEvidence = this.getPendingSteps(goal.currentPlan, rule.requiredTools).length > 0;
                if (hasPendingEvidence) {
                    log.info(
                        `[VALIDATION-EVIDENCE]` +
                        ` claim="${rule.label}"` +
                        ` pending_step_satisfies=true` +
                        ` decision=accept`
                    );
                    continue;
                }
                return { satisfied: false, claimsChecked, claim: rule.label, missingTool: rule.requiredTools[0] };
            }

            log.info(
                `[VALIDATION-EVIDENCE]` +
                ` claim="${rule.label}"` +
                ` required_tool="${rule.requiredTools.join('|')}"` +
                ` evidence_found="${evidenceAttempt.toolName}"` +
                ` decision=accept`
            );
        }

        return { satisfied: true, claimsChecked };
    }

    // ── Deliverable Check helpers (Item 2) ───────────────────────────────────

    /**
     * H6: registra análise do plano gerado — detecta writes duplicados para o mesmo path.
     */
    private logPlanAnalysis(goalId: string, plan: PlanStep[], phase: 'initial' | 'replan'): void {
        const writeSteps = plan.filter(s => s.toolName === 'write' || s.toolName === 'edit');
        const writePaths = writeSteps
            .map(s => String(s.toolArgs?.path ?? ''))
            .filter(Boolean);
        const uniquePaths = new Set(writePaths);
        const hasDuplicates = writePaths.length > uniquePaths.size;
        const duplicatePaths = writePaths.filter((p, i) => writePaths.indexOf(p) !== i);
        log.info(
            `[PLAN-ANALYSIS] goal=${goalId} phase=${phase} total_steps=${plan.length}` +
            ` writes=${writeSteps.length} unique_paths=${uniquePaths.size}` +
            ` duplicate_paths=${hasDuplicates}` +
            (hasDuplicates ? ` duplicates="${duplicatePaths.join(',')}"` : '')
        );
    }

    /**
     * Retorna true quando o intent descreve modificação de conteúdo existente.
     * Usado pelo FIX B para bloquear knowledge substitution quando o artefato fonte está vazio.
     */
    private isModificationGoal(userIntent: string): boolean {
        return /\b(modificar|modific|editar|edi[tç]|reorganizar|reorgani[zs]|corrigir|corrij|atualizar|atuali[zs]|converter|convert|dividir|divid|reformular|reformul|melhorar|melhore?|ajustar|ajust|reescrever|reescrev|revisar|revis)\b/i
            .test(userIntent);
    }

    /**
     * Busca arquivos criados APÓS o início do goal com as extensões esperadas.
     * goalCreatedAt garante que arquivos pré-existentes no workspace não sejam
     * enviados como entregáveis do goal atual (ex: imagens promocionais do sistema).
     */
    private async checkDeliverables(extensions: string[], goalCreatedAt: number): Promise<string[]> {
        // S9: scan nativo Node.js em vez de exec_command + find.
        // Motivo: exec_command pode estar indisponível e, quando disponível, retorna caminhos
        // relativos ao CWD do shell (diferente do CWD do Node.js) — fs.statSync falha com ENOENT
        // e todos os arquivos aparecem como < 200B mesmo tendo 8KB+ de conteúdo real.
        const workspaceDir = process.env.WORKSPACE_DIR || path.join(process.cwd(), 'workspace');
        // 1 min de buffer para clock skew / arquivos iniciados antes do timestamp do goal
        const cutoff = goalCreatedAt - 60_000;
        const found: string[] = [];

        const scan = (dir: string, depth: number) => {
            if (depth > 4 || found.length >= 5) return;
            try {
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                    if (found.length >= 5) break;
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        scan(fullPath, depth + 1);
                    } else if (extensions.some(ext => entry.name.endsWith(ext))) {
                        try {
                            if (fs.statSync(fullPath).mtimeMs >= cutoff) {
                                found.push(fullPath);
                            }
                        } catch { /* arquivo desapareceu — ignorar */ }
                    }
                }
            } catch { /* diretório inacessível — ignorar */ }
        };

        scan(workspaceDir, 0);
        if (found.length < 5) scan('/tmp', 0);
        return found;
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
        // GENERIC_CRITERIA_SUMMARY não carrega nenhuma informação sobre o que foi entregue —
        // quando validateGoalCompletion cai nesse fallback (nenhum critério "de conteúdo" restou
        // após filtrar os de auto-delivery), prefira a saída real da última tool bem-sucedida
        // (ex: "🔊 Áudio enviado com sucesso!") em vez de repetir a frase genérica ao usuário.
        // Evidência real: 2026-07-05, goal_1783273986121_ptyfp e goal_1783274167642_xqep6.
        const hasGenericSummary = overrideOutput === GENERIC_CRITERIA_SUMMARY;
        // Usa || para tratar string vazia como ausente (exec_command com outputLen=0)
        const finalOutput = (hasGenericSummary ? undefined : overrideOutput)
            ?? (lastSuccess?.output || undefined)
            ?? lastCompletedStep?.result
            ?? (success ? overrideOutput ?? 'Tarefa concluída com sucesso.' : this.evaluator.buildFailureExplanation(goal));

        // H1 observabilidade: resultado final estruturado para correlacionar com [USER-MESSAGE]
        log.info(
            `[GOAL-RESULT] goal=${goal.id} success=${success}` +
            ` cycles=${totalCycles} replans=${totalReplans} attempts=${goal.attempts.length}` +
            ` strategies=${goal.strategiesTried.length}` +
            ` summary="${(overrideOutput ?? '').slice(0, 100)}"`
        );

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
