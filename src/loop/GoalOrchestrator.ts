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

const log = createLogger('GoalOrchestrator');

export class GoalOrchestrator {
    private readonly goalStore: GoalStore;
    private readonly extractor: GoalExtractor;
    private readonly executionLoop: GoalExecutionLoop;

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

        // ── Verificar se há goal ativo aguardando retomada ──────────────────
        const activeGoal = this.goalStore.getActiveBySession(sessionKey);

        if (activeGoal?.status === 'blocked' && activeGoal.pendingTxnId) {
            log.info(`[GoalOrchestrator] goal=${activeGoal.id} blocked waiting auth txn=${activeGoal.pendingTxnId}`);

            // Guarda: mensagens curtas de aprovação ("Pode fazer", "sim", "ok", …) chegam como
            // texto quando o usuário digita em vez de clicar o botão inline. O GoalExtractor
            // classificaria "pode fazer" como goal (regex `pode\s+fazer`), abandonando o goal
            // que está aguardando autorização. Interceptamos aqui antes da classificação.
            const trimmedMsg = message.trim();
            const isShortApproval = trimmedMsg.length < 80 &&
                /^(sim|pode|pode\s+fazer|ok|fa[cç]a|faz|confirmo|aprovado|autorizo|pode\s+ir|pode\s+executar|yes|go|proceed|confirm|tá|ta\s+bom|beleza|claro|certo|execute|executar|confirmar)\b/i
                    .test(trimmedMsg);
            if (isShortApproval) {
                log.info(`[GoalOrchestrator] goal=${activeGoal.id} pending auth — short approval message delegated to AgentLoop (not abandoning goal)`);
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
            log.info(`[GoalOrchestrator] goal ambiguous — returning clarification question`);
            return classification.clarificationQuestion
                ?? 'Para ajudar melhor, pode dar mais detalhes sobre o que precisa exatamente?';
        }

        log.info(`[GoalOrchestrator] goal confidence=${classification.confidence} message="${message.slice(0, 80)}"`);

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
