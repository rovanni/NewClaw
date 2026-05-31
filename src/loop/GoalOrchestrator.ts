/**
 * GoalOrchestrator — Camada de coordenação entre mensagem do usuário e execução.
 *
 * Responsabilidades:
 *   1. Classificar se a mensagem é um Goal ou conversa simples
 *   2. Criar e persistir o goal no GoalStore
 *   3. Executar via GoalExecutionLoop (ciclo iterativo plan→execute→evaluate→replan)
 *   4. Fallback para AgentLoop quando não é goal
 *
 * Bounded autonomy garantida:
 *   - Um goal ativo por sessão (goal anterior é abandonado)
 *   - Goals sempre iniciados por mensagem explícita do usuário
 *   - TTL de 30 minutos por goal
 *   - Retries e replans limitados por budget
 */

import { createLogger } from '../shared/AppLogger';
import { AgentLoop, ProcessedResult } from './AgentLoop';
import { GoalStore } from './GoalStore';
import { GoalExtractor } from './GoalExtractor';
import { GoalPlanner } from './GoalPlanner';
import { GoalExecutionLoop } from './GoalExecutionLoop';
import { ProviderFactory } from '../core/ProviderFactory';
import { MemoryManager } from '../memory/MemoryManager';
import { ReflectionMemory } from '../memory/ReflectionMemory';
import { ToolRegistry } from '../core/ToolRegistry';
import { CapabilityRegistry } from '../core/CapabilityRegistry';
import { GOAL_LIMITS } from './GoalLimits';
import { ChannelContext } from './agentLoopTypes';
import type { SessionManager } from '../session/SessionManager';
import type { WorkflowEngine } from './WorkflowEngine';

const log = createLogger('GoalOrchestrator');

const CLARIFICATION_TTL_MS = 10 * 60 * 1000; // 10 min

export class GoalOrchestrator {
    private readonly goalStore: GoalStore;
    private readonly extractor: GoalExtractor;
    private readonly executionLoop: GoalExecutionLoop;
    /** Tracks sessions waiting for clarification: sessionKey → { originalMessage, timestamp } */
    private readonly pendingClarifications = new Map<string, { originalMessage: string; timestamp: number }>();
    private workflowEngine?: WorkflowEngine;

    constructor(
        private readonly agentLoop: AgentLoop,
        providerFactory: ProviderFactory,
        goalStore: GoalStore,
        memory: MemoryManager,
    ) {
        this.goalStore = goalStore;
        this.extractor = new GoalExtractor(providerFactory);

        const reflectionMemory = new ReflectionMemory(memory);
        const planner = new GoalPlanner(providerFactory, reflectionMemory);

        this.executionLoop = new GoalExecutionLoop(
            agentLoop,
            goalStore,
            planner,
            reflectionMemory,
            ToolRegistry,
            providerFactory,
            memory,
        );

        // Aquece o CapabilityRegistry em background — não bloqueia a inicialização.
        CapabilityRegistry.getInstance().bootstrap().catch(err => {
            log.warn('[GoalOrchestrator] CapabilityRegistry bootstrap failed:', String(err));
        });
    }

    /** Conecta SessionManager ao executionLoop para telemetria e artefatos. */
    setSessionManager(sm: SessionManager): void {
        this.executionLoop.setSessionManager(sm);
    }

    /** Injeta WorkflowEngine para resolução de auth por texto (sem clique no botão). */
    setWorkflowEngine(engine: WorkflowEngine): void {
        this.workflowEngine = engine;
    }

    /**
     * Processa uma mensagem do usuário.
     *
     * Fluxo:
     *   1. Expira goals antigos (TTL)
     *   2. Classifica se é goal ou conversa
     *   3. Se goal: cria no store, executa via GoalExecutionLoop
     *   4. Se conversa: passa direto para AgentLoop
     */
    async process(
        conversationId: string,
        message: string,
        userId: string,
        context?: ChannelContext,
        recentMessages?: Array<{ role: string; content: string }>
    ): Promise<string | ProcessedResult> {
        // TTL cleanup a cada processamento (query lightweight)
        this.goalStore.expireStale();

        const sessionKey = context
            ? `${context.channel}:${context.userId ?? userId}`
            : `unknown:${userId}`;

        // ── Resolver clarificação pendente ──────────────────────────────────
        const pending = this.pendingClarifications.get(sessionKey);
        if (pending) {
            this.pendingClarifications.delete(sessionKey);
            if (Date.now() - pending.timestamp < CLARIFICATION_TTL_MS) {
                log.info(`[GoalOrchestrator] [GOAL] clarification pending found — session=${sessionKey}`);
                message = `${pending.originalMessage}\n\n[RESPOSTA DO USUÁRIO]: ${message}`;
                log.info(`[GoalOrchestrator] [GOAL] user response attached to existing goal context`);
                log.info(`[GoalOrchestrator] [GOAL] resuming goal execution with combined context`);
            } else {
                log.info(`[GoalOrchestrator] [GOAL] clarification expired — treating as new request`);
            }
        }

        // ── Verificar se há goal ativo aguardando retomada ──────────────────
        const activeGoal = this.goalStore.getActiveBySession(sessionKey);

        if (activeGoal?.status === 'blocked' && activeGoal.pendingTxnId) {
            log.info(`[GoalOrchestrator] goal=${activeGoal.id} blocked waiting auth txn=${activeGoal.pendingTxnId}`);

            const userText = message.trim();
            const isShortApproval = userText.length < 80 &&
                /^(sim|pode|pode\s+fazer|ok|fa[cç]a|faz|confirmo|aprovado|autorizo|pode\s+ir|pode\s+executar|yes|go|proceed|confirm|tá|ta\s+bom|beleza|claro|certo|execute|executar|confirmar)\b/i
                    .test(userText);
            const isShortRejection = userText.length < 80 &&
                /^(não|nao|no\b|cancela|cancelar|para|stop|recusa|aborta|abortar|negativo)\b/i
                    .test(userText);

            if (isShortApproval || isShortRejection) {
                const txnId = activeGoal.pendingTxnId;
                const decision = isShortApproval ? 'approved' : 'rejected';
                log.info(`[GoalOrchestrator] [AUTH-DETECTED] goal=${activeGoal.id} txn=${txnId} decision=${decision} source=text channel=${context?.channel ?? 'unknown'}`);

                if (this.workflowEngine) {
                    const wfResult = await this.workflowEngine.resume(txnId, decision, (name) => ToolRegistry.get(name));
                    if (wfResult) {
                        log.info(`[GoalOrchestrator] [AUTH-RESUMED] goal=${activeGoal.id} txn=${txnId} source=text — [GOAL-EXTRACTION-SKIPPED]`);
                        return this.resumeFromAuth(txnId, wfResult.output ?? '');
                    }
                    log.warn(`[GoalOrchestrator] [AUTH-DETECTED] workflowEngine.resume=null txn=${txnId} — falling back to AgentLoop`);
                } else {
                    log.info(`[GoalOrchestrator] [AUTH-DETECTED] workflowEngine not set — delegating to AgentLoop`);
                }
                return this.agentLoop.process(conversationId, message, userId, context);
            }
        }

        // ── Classificar a mensagem ──────────────────────────────────────────
        const classification = await this.extractor.classify(
            message,
            context ?? { channel: 'unknown', chatId: conversationId },
            recentMessages
        );

        if (!classification.isGoal) {
            log.debug(`[GoalOrchestrator] not-goal reason=${classification.reason}`);
            return this.agentLoop.process(conversationId, message, userId, context);
        }

        // ── Item 3: Ambiguity Detection — perguntar antes de criar goal ──────
        // Objetivos ambíguos ("essa versão não consigo editar", "não está funcionando")
        // viram perguntas de clarificação em vez de goals, evitando ciclos de replan
        // que nunca convergem por falta de contexto.
        if (classification.isAmbiguous) {
            this.pendingClarifications.set(sessionKey, { originalMessage: message, timestamp: Date.now() });
            log.info(`[GoalOrchestrator] goal ambiguous — clarification stored for session=${sessionKey}`);
            return classification.clarificationQuestion
                ?? 'Para ajudar melhor, pode dar mais detalhes sobre o que precisa exatamente?';
        }

        log.info(`[GoalOrchestrator] goal confidence=${classification.confidence} message="${message.slice(0, 80)}"`);

        // ── Validar evidência explícita do objetivo ───────────────────────
        const evidenceFound = classification.hasExplicitEvidence !== false;
        log.info(`[GoalOrchestrator] [PLANNER] inferred objective="${(classification.objective ?? '').slice(0, 80)}"`);
        log.info(`[GoalOrchestrator] [PLANNER] explicit evidence found=${evidenceFound}`);
        if (!evidenceFound) {
            log.warn(`[GoalOrchestrator] [PLANNER] objective inferred from data without explicit user request — proceeding with caution`);
            if (classification.confidence < 0.85) {
                this.pendingClarifications.set(sessionKey, { originalMessage: message, timestamp: Date.now() });
                return 'Recebi os dados, mas não ficou claro o que você gostaria que eu fizesse com eles. Pode me dizer?';
            }
        }

        // ── Abandonar goal anterior ───────────────────────────────────────
        // Re-check after the async classify() — another concurrent request may have created
        // a goal in the gap between the first getActiveBySession() and now.
        const currentActiveGoal = this.goalStore.getActiveBySession(sessionKey);
        if (currentActiveGoal && !['completed', 'failed', 'abandoned'].includes(currentActiveGoal.status)) {
            log.info(`[GoalOrchestrator] abandoning goal=${currentActiveGoal.id}`);
            if (currentActiveGoal.status === 'blocked' && currentActiveGoal.pendingTxnId) {
                log.warn(`[GoalOrchestrator] goal=${currentActiveGoal.id} was awaiting auth — abandoning due to new request`);
            }
            this.goalStore.setStatus(currentActiveGoal.id, 'abandoned');
        }

        // ── Criar novo goal ───────────────────────────────────────────────
        // Aviso inline: se havia goal com auth pendente, será anexado à resposta final
        const abandonedAuthPending = currentActiveGoal?.status === 'blocked' && !!currentActiveGoal.pendingTxnId;

        const goal = this.goalStore.create({
            sessionKey,
            conversationId,
            userIntent: message,
            objective: classification.objective || message,
            status: 'active',
            currentPlan: [],
            attempts: [],
            blockers: [],
            toolsTried: [],
            strategiesTried: [],
            retryBudget: GOAL_LIMITS.MAX_RETRY_BUDGET,
            replanBudget: GOAL_LIMITS.MAX_REPLAN_BUDGET,
            confidence: GOAL_LIMITS.INITIAL_CONFIDENCE,
            requiresAuth: false,
            authorizationScope: classification.requiredTools ?? [],
            expiresAt: Date.now() + GOAL_LIMITS.MAX_GOAL_TTL_MS,
            isConstruction: classification.isConstruction ?? false,
            allowRoadmapAdjustment: classification.isConstruction ?? false,
            successCriteria: [],   // preenchido pelo GoalPlanner no plan inicial
        });

        log.info(`[GoalOrchestrator] executing goal=${goal.id}`);
        log.info(`[GOAL-LIFECYCLE] goal=${goal.id} session=${sessionKey} state=created intent="${message.slice(0, 80)}" timestamp=${Date.now()}`);

        // ── Injetar skill context no planner (sempre, para limpar contexto anterior) ──
        const skillContext = this.agentLoop.getSkillContextForQuery(message);
        this.executionLoop.setSkillContext(skillContext);
        if (skillContext) {
            log.info(`[GoalOrchestrator] skill context injected into planner (${skillContext.length} chars)`);
        }

        // ── Executar via GoalExecutionLoop ────────────────────────────────
        const result = await this.executionLoop.executeGoal(
            goal,
            context ?? { channel: 'unknown', chatId: conversationId, userId },
            async (update) => {
                log.debug(`[GoalOrchestrator] progress goal=${update.goalId} cycle=${update.cycle} event=${update.event}`);
            }
        );

        log.info(`[GoalOrchestrator] goal=${goal.id} success=${result.success} cycles=${result.totalCycles} replans=${result.totalReplans}`);
        log.info(`[USER-MESSAGE] goal=${goal.id} session=${sessionKey} source=${result.success ? 'goal_success' : 'goal_failure'} output_len=${result.finalOutput.length}`);

        // Auth pendente: preserva o texto E os botões do inline keyboard
        // (sem isso os botões são descartados e o usuário não vê a confirmação)
        if (!result.success && result.authOptions?.length) {
            return { text: result.finalOutput, options: result.authOptions };
        }

        // Retorna o output final como texto
        if (result.success) {
            if (abandonedAuthPending) {
                return `⚠️ *Atenção:* havia uma solicitação pendente de autorização que foi cancelada ao iniciar esta nova tarefa.\n\n${result.finalOutput}`;
            }
            return result.finalOutput;
        }

        // Falhou — retorna a explicação gerada pelo GoalEvaluator
        // e deixa AgentLoop dar uma resposta mais rica se possível
        if (result.totalCycles > 0) {
            return result.finalOutput;
        }

        // Nunca chegou a executar — cai para AgentLoop normal
        return this.agentLoop.process(conversationId, message, userId, context);
    }

    /**
     * Retoma um goal bloqueado após auth aprovada via WorkflowEngine.
     * Marca o step pendente como concluído com o output do workflow e continua
     * o loop de execução a partir do próximo step, sem replanejar.
     */
    async resumeFromAuth(txnId: string, workflowOutput: string): Promise<string> {
        const goal = this.goalStore.getByTxnId(txnId);
        if (!goal) {
            log.warn(`[GoalOrchestrator] resumeFromAuth: no goal for txn=${txnId}`);
            return 'Autorização processada.';
        }

        log.info(`[GoalOrchestrator] resuming goal=${goal.id} after auth txn=${txnId}`);

        // Reconstrói channelContext a partir do sessionKey do goal (ex: "telegram:userId")
        const [channel, sessionUserId] = goal.sessionKey.split(':');
        const channelContext: ChannelContext = {
            channel: channel ?? 'unknown',
            chatId: goal.conversationId,
            userId: sessionUserId,
        };

        const result = await this.executionLoop.resumeGoal(
            goal,
            channelContext,
            workflowOutput,
            async (update) => {
                log.debug(`[GoalOrchestrator] resume goal=${update.goalId} cycle=${update.cycle} event=${update.event}`);
            }
        );

        log.info(`[GoalOrchestrator] goal=${goal.id} resumed success=${result.success} cycles=${result.totalCycles}`);
        return result.finalOutput;
    }

    getGoalStore(): GoalStore { return this.goalStore; }
}
