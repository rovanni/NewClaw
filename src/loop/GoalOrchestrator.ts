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
import { MultiLayerRetriever } from '../memory/MultiLayerRetriever';
import { ReflectionMemory } from '../memory/ReflectionMemory';
import { CaseMemory } from '../memory/CaseMemory';
import { ToolRegistry } from '../core/ToolRegistry';
import { CapabilityRegistry } from '../core/CapabilityRegistry';
import { GOAL_LIMITS } from './GoalLimits';
import { ChannelContext } from './agentLoopTypes';
import type { SessionManager } from '../session/SessionManager';
import type { WorkflowEngine } from './WorkflowEngine';

const log = createLogger('GoalOrchestrator');

const CLARIFICATION_TTL_MS = 10 * 60 * 1000; // 10 min
// Janela de follow-up: se um goal foi concluído há menos de RECENT_GOAL_TTL_MS, a próxima
// mensagem pode ser uma refinamento/clarificação — passar o contexto ao GoalExtractor LLM.
const RECENT_GOAL_TTL_MS = 5 * 60 * 1000; // 5 min

interface RecentCompletedGoal {
    intent: string;
    objective: string;
    /** Output final do goal (máx. 1000 chars) — injetado no contexto de follow-ups/refinamentos */
    finalOutput: string;
    completedAt: number;
    success: boolean;
    /** true = roteado pelo GoalExecutionLoop; false = resposta direta do AgentLoop (não-goal) */
    isGoal: boolean;
}

export class GoalOrchestrator {
    private readonly goalStore: GoalStore;
    private readonly extractor: GoalExtractor;
    private readonly executionLoop: GoalExecutionLoop;
    /** Tracks sessions waiting for clarification: sessionKey → { originalMessage, timestamp } */
    private readonly pendingClarifications = new Map<string, { originalMessage: string; timestamp: number }>();
    /**
     * Rastreia o último goal concluído (com sucesso ou falha) por sessão.
     * Usado para detectar mensagens de follow-up/clarificação enviadas logo após um goal completar.
     * Sem este rastreamento, mensagens contextuais como "o curso abrange X, Y e Z" são
     * classificadas como novos goals independentes, gerando um ciclo de replan desnecessário.
     */
    private readonly recentCompletedGoals = new Map<string, RecentCompletedGoal>();
    private workflowEngine?: WorkflowEngine;

    constructor(
        private readonly agentLoop: AgentLoop,
        providerFactory: ProviderFactory,
        goalStore: GoalStore,
        private readonly memory: MemoryManager,
    ) {
        this.goalStore = goalStore;
        this.extractor = new GoalExtractor(providerFactory, agentLoop.getClassifierModel());

        const reflectionMemory = new ReflectionMemory(memory);
        const caseMemory = new CaseMemory(memory);
        const planner = new GoalPlanner(providerFactory, reflectionMemory);

        this.executionLoop = new GoalExecutionLoop(
            agentLoop,
            goalStore,
            planner,
            reflectionMemory,
            ToolRegistry,
            providerFactory,
            memory,
            caseMemory,
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

    /** Propaga mudanças de modelo interno do dashboard sem precisar reiniciar. */
    updateInternalModels(plannerModel?: string, riskModel?: string, classifierModel?: string): void {
        this.executionLoop.updateInternalModels(plannerModel, riskModel);
        if (classifierModel) this.extractor.setClassifierModel(classifierModel);
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
            // "(?!\w)" no lugar do "\b" final: achado em auditoria (07/07/2026) — "tá" (confirmação
            // informal muito comum em pt-BR: "tá", "tá!", "tá bom") termina em "á" (acentuado); "\b"
            // no JS (sem flag "u") nunca fecha depois de acento seguido de espaço/pontuação/fim de
            // string, então "tá"/"tá!" sozinhos NUNCA eram reconhecidos como aprovação — o goal
            // ficava travado em 'blocked' esperando uma confirmação mais "clara" que já tinha sido
            // dada. Mesma classe de bug já corrigida em GoalExtractor.ts/AgentLoop.ts/
            // memory_write.ts nesta sessão.
            const isShortApproval = userText.length < 80 &&
                /^(sim|pode|pode\s+fazer|ok|fa[cç]a|faz|confirmo|aprovado|autorizo|pode\s+ir|pode\s+executar|yes|go|proceed|confirm|tá|ta\s+bom|beleza|claro|certo|execute|executar|confirmar)(?!\w)/i
                    .test(userText);
            const isShortRejection = userText.length < 80 &&
                /^(não|nao|no\b|cancela|cancelar|para|stop|recusa|aborta|abortar|negativo)(?!\w)/i
                    .test(userText);

            if (isShortApproval || isShortRejection) {
                const txnId = activeGoal.pendingTxnId;
                const decision = isShortApproval ? 'approved' : 'rejected';
                log.info(`[GoalOrchestrator] [AUTH-DETECTED] goal=${activeGoal.id} txn=${txnId} decision=${decision} source=text channel=${context?.channel ?? 'unknown'}`);

                if (this.workflowEngine) {
                    const wfResult = await this.workflowEngine.resume(txnId, decision, (name) => ToolRegistry.get(name));
                    if (wfResult) {
                        log.info(`[GoalOrchestrator] [AUTH-RESUMED] goal=${activeGoal.id} txn=${txnId} source=text decision=${decision} — [GOAL-EXTRACTION-SKIPPED]`);
                        if (decision === 'rejected') {
                            return this.abortGoalFromAuth(txnId);
                        }
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
        // Se há um goal recente concluído para esta sessão dentro da janela de follow-up,
        // injeta seu intent como contexto adicional para o GoalExtractor LLM.
        // Isso permite que o LLM identifique "esta mensagem é uma clarificação do
        // que o usuário pediu há 2 minutos" em vez de tratá-la como goal novo.
        const recentGoal = this.recentCompletedGoals.get(sessionKey);
        const isWithinFollowUpWindow = recentGoal &&
            (Date.now() - recentGoal.completedAt) < RECENT_GOAL_TTL_MS;

        let classifyMessages = recentMessages;
        if (isWithinFollowUpWindow && recentGoal) {
            const elapsedSec = Math.round((Date.now() - recentGoal.completedAt) / 1000);
            // Sugestão 3: injeta o output anterior no contexto do GoalExtractor LLM.
            // Permite que o LLM saiba o que foi gerado e identifique "esta mensagem refina aquilo".
            const outputSnippet = recentGoal.finalOutput
                ? ` — output: "${recentGoal.finalOutput.slice(0, 300)}"`
                : '';
            const followUpContext = {
                role: 'assistant',
                content: `[${elapsedSec}s atrás — goal concluído: "${recentGoal.intent.slice(0, 200)}" — sucesso: ${recentGoal.success}${outputSnippet}]`,
            };
            classifyMessages = [followUpContext, ...(recentMessages ?? [])];
            log.info(`[GoalOrchestrator] recent goal context injected for classification (${elapsedSec}s ago): "${recentGoal.intent.slice(0, 80)}"`);
        }

        // Preferências salvas relevantes à mensagem — mesma técnica já usada e validada em
        // GoalExecutionLoop.contextualize() (MultiLayerRetriever.keywordSearch, reuso da
        // classe do ContextBuilder). Sem isso, a classificação de ambiguidade (abaixo) nunca
        // via preferências como "cidade padrão para previsão do tempo" e pedia clarificação
        // mesmo com o dado já salvo. Evidência: 2026-07-05 audit log — pedido de previsão do
        // tempo por áudio sem cidade foi marcado is_ambiguous=true e pediu a cidade, apesar de
        // existir uma preferência salva de cidade padrão para previsão do tempo (encontrada com
        // score alto via camada KEYWORD quando consultada depois, dentro do turno de AgentLoop
        // — tarde demais aqui).
        // Roda ANTES da classificação (não depois, como contextualize()) porque a pergunta de
        // clarificação retorna e encerra o turno antes de qualquer goal/planner ser criado.
        try {
            const retriever = new MultiLayerRetriever(this.memory.getDatabase());
            const candidateIds = retriever.keywordSearch(message, 5).slice(0, 3).map(c => c.nodeId);
            if (candidateIds.length > 0) {
                const placeholders = candidateIds.map(() => '?').join(',');
                const prefRows = this.memory.getDatabase().prepare(
                    `SELECT content FROM memory_nodes WHERE id IN (${placeholders}) AND type IN ('preference', 'trait') AND (lifecycle_state IS NULL OR lifecycle_state = 'ACTIVE')`
                ).all(...candidateIds) as Array<{ content: string }>;
                const relevantPrefs = prefRows.filter(r => r.content && r.content.trim().length > 10);
                if (relevantPrefs.length > 0) {
                    const preferenceContext = {
                        role: 'assistant',
                        content: `[MEMÓRIA — preferências salvas do usuário relevantes a esta mensagem]:\n${relevantPrefs.map(r => `- ${r.content}`).join('\n')}`,
                    };
                    classifyMessages = [preferenceContext, ...(classifyMessages ?? [])];
                    log.info(`[GoalOrchestrator] preference memory injected for classification: ${relevantPrefs.length} node(s)`);
                }
            }
        } catch (err) {
            log.warn('[GoalOrchestrator] preference memory search for classification failed:', String(err));
        }

        const classifyStart = Date.now();
        const classification = await this.extractor.classify(
            message,
            context ?? { channel: 'unknown', chatId: conversationId },
            classifyMessages
        );
        const classificationMs = Date.now() - classifyStart;

        // P0.2 — Fail-open: GoalExtractor timeout ou conteúdo não-JSON (thinking recuperado).
        // Em vez de aceitar uma classificação arbitrária, roteamos para AgentLoop
        // que demonstrou resolver tarefas de criação sem GoalPlanner.
        if (classification.timedOut) {
            log.warn(
                `[GOAL-ROUTING] route=agentloop reason=${classification.reason ?? 'goal_extractor_timeout'}` +
                ` classificationMs=${classificationMs} timedOut=true usedFastPath=false`
            );
            return this.agentLoop.process(conversationId, message, userId, context);
        }

        // P1 — Telemetria de roteamento: emitida em TODAS as decisões de routing.
        const route = classification.isGoal ? 'goal_orchestrator' : 'agentloop';
        log.info(
            `[GOAL-ROUTING] route=${route}` +
            ` reason=${classification.reason ?? 'none'}` +
            ` classificationMs=${classificationMs}` +
            ` timedOut=false` +
            ` usedFastPath=${classification.usedFastPath ?? false}` +
            ` confidence=${classification.confidence}`
        );

        if (!classification.isGoal) {
            log.debug(`[GoalOrchestrator] not-goal reason=${classification.reason}`);
            const roiStart = Date.now();
            const agentResult = await this.agentLoop.process(conversationId, message, userId, context);

            // Registra intent mesmo para mensagens não-goal (heuristic_negative),
            // para que follow-ups recebam o tópico correto como contexto.
            // Sem isso, "Busque os dados do river?" (termina em '?') vai pelo AgentLoop,
            // e "Quero dados atuais!" chega sem saber que o assunto era RIVER.
            // PRESERVAÇÃO: não sobrescreve se há um GOAL FALHO recente na janela — sem isso, a
            // resposta ao texto secundário apaga o contexto do goal falho e o follow-up
            // ("Conseguiu criar os slides?") perde a referência ao goal anterior.
            // Restrito a success===false (antes cobria "sucesso ou falha" indiscriminadamente):
            // log real 2026-07-08 mostrou um goal BEM-SUCEDIDO (aula IPv4/IPv6, arquivo já
            // entregue) travando essa entrada por até 5 min inteiros, mesmo depois de um turno
            // AgentLoop inteiramente novo (pedido de fundo branco, com pergunta de confirmação
            // pendente) já ter acontecido. Quando "sim" chegou 21s depois desse turno, o
            // classificador recebeu como contexto o goal antigo de 177s atrás em vez da
            // pergunta real que estava sendo confirmada. Um goal já entregue não tem mais nada
            // pendente a preservar — deixar o AgentLoop mais recente atualizar a entrada é o
            // comportamento correto nesse caso.
            const existingGoal = this.recentCompletedGoals.get(sessionKey);
            const existingIsRecentGoal = existingGoal?.isGoal && existingGoal.success === false &&
                (Date.now() - existingGoal.completedAt) < RECENT_GOAL_TTL_MS;
            const agentOutputText = typeof agentResult === 'string'
                ? agentResult
                : (agentResult as ProcessedResult)?.text ?? '';
            if (!existingIsRecentGoal) {
                this.recentCompletedGoals.set(sessionKey, {
                    intent: message,
                    objective: message.slice(0, 200),
                    finalOutput: agentOutputText.slice(0, 500),
                    completedAt: Date.now(),
                    success: true,
                    isGoal: false,
                });
            }

            log.info(
                `[GOAL-ROI]` +
                ` route=agentloop` +
                ` category=${classification.reason ?? 'heuristic'}` +
                ` success=true` +
                ` durationMs=${Date.now() - roiStart}` +
                ` replans=0` +
                ` validatorFailures=0` +
                ` filesCreated=0`
            );
            return agentResult;
        }

        // ── Item 3: Ambiguity Detection — perguntar antes de criar goal ──────
        // Objetivos ambíguos ("essa versão não consigo editar", "não está funcionando")
        // viram perguntas de clarificação em vez de goals, evitando ciclos de replan
        // que nunca convergem por falta de contexto.
        log.info(
            `[TOOL-ROUTING] intent="${message.slice(0, 80)}" isGoal=${classification.isGoal} isAmbiguous=${classification.isAmbiguous ?? false} reason=${classification.reason ?? 'none'} confidence=${classification.confidence}`
        );
        if (classification.isAmbiguous) {
            log.info(`[TOOL-ROUTING] action=clarification_requested intent="${message.slice(0, 80)}"`);
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

        // ── Sugestão 2: texto puro sem formato de arquivo → AgentLoop direto ─────
        // Objetivos de geração de conteúdo textual (discurso, carta, e-mail, poema...)
        // sem formato de arquivo especificado são respondidos inline pelo AgentLoop.
        // Isso elimina o ciclo write(stub)→DESTRUCTIVE-WRITE-BLOCK que acontece quando
        // o GoalExecutionLoop planeja write + send_document para tarefas que o usuário
        // espera receber como texto no chat, não como arquivo anexo.
        if (this.isPlainTextGoal(message)) {
            log.info(`[GOAL-ROUTING] route=agentloop_inline reason=plain_text_goal intent="${message.slice(0, 80)}"`);
            const inlineResult = await this.agentLoop.process(conversationId, message, userId, context);
            // Registra como goal concluído para Sugestão 3: follow-ups recebem o output anterior.
            // isGoal=true porque passou pela classificação de goal (mesmo que roteado inline).
            this.recentCompletedGoals.set(sessionKey, {
                intent: message,
                objective: classification.objective || message,
                finalOutput: (typeof inlineResult === 'string' ? inlineResult : '').slice(0, 1000),
                completedAt: Date.now(),
                success: true,
                isGoal: true,
            });
            return inlineResult;
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
        const goalRoiStart = Date.now();
        const result = await this.executionLoop.executeGoal(
            goal,
            context ?? { channel: 'unknown', chatId: conversationId, userId },
            async (update) => {
                log.debug(`[GoalOrchestrator] progress goal=${update.goalId} cycle=${update.cycle} event=${update.event}`);
            }
        );

        // Fase 3 — ROI audit: métricas de execução via GoalOrchestrator.
        const goalRoiDurationMs = Date.now() - goalRoiStart;
        const roiFilesCreated = result.goal.attempts.filter(
            a => a.result === 'success' && a.toolName === 'write'
        ).length;
        const roiValidatorFailures = result.goal.blockers.filter(
            b => b.kind === 'goal_incomplete'
        ).length;
        const roiCategory = result.goal.isConstruction ? 'construction' : 'goal';
        log.info(
            `[GOAL-ROI]` +
            ` route=goal` +
            ` category=${roiCategory}` +
            ` success=${result.success}` +
            ` durationMs=${goalRoiDurationMs}` +
            ` replans=${result.totalReplans}` +
            ` validatorFailures=${roiValidatorFailures}` +
            ` filesCreated=${roiFilesCreated}`
        );

        log.info(`[GoalOrchestrator] goal=${goal.id} success=${result.success} cycles=${result.totalCycles} replans=${result.totalReplans}`);
        log.info(`[USER-MESSAGE] goal=${goal.id} session=${sessionKey} source=${result.success ? 'goal_success' : 'goal_failure'} output_len=${result.finalOutput.length}`);

        // Registra o goal concluído para detecção de follow-up na próxima mensagem.
        // A limpeza de entradas expiradas ocorre passivamente: sobrescrita pelo próximo goal.
        this.recentCompletedGoals.set(sessionKey, {
            intent: goal.userIntent,
            objective: goal.objective,
            finalOutput: result.finalOutput.slice(0, 1000),
            completedAt: Date.now(),
            success: result.success,
            isGoal: true,
        });

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
     * Sugestão 2: detecta se o objetivo é geração de texto puro (discurso, carta, e-mail, etc.)
     * sem pedido explícito de formato de arquivo. Nesses casos o AgentLoop responde inline —
     * sem write + send_document — eliminando o ciclo stub→DESTRUCTIVE-WRITE-BLOCK.
     *
     * Regras:
     * - Se a mensagem pede pdf/pptx/docx/arquivo/slide → false (GoalExecutionLoop cuida)
     * - Se contém palavras de conteúdo textual puro → true (AgentLoop inline)
     */
    private isPlainTextGoal(message: string): boolean {
        const hasFileFormat = /\b(pdf|pptx|docx|xlsx|arquivo|documento|slide|apresenta[cç][aã]o|planilha|exportar|salvar\s+em)\b/i.test(message);
        if (hasFileFormat) return false;
        return /\b(discurso|carta|e-mail|email|mensagem\s+(de\s+)?(texto|whatsapp)|redação|redac[aã]o|poema|hist[oó]ria|roteiro|script\s+(de\s+)?fala|comunicado|par[aá]grafo|conto|haiku|cr[oô]nica)\b/i.test(message);
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

    /**
     * Aborta um goal bloqueado quando o usuário rejeitou a autorização.
     * Marca o goal como falho e limpa o pendingTxnId — sem replanejar.
     */
    async abortGoalFromAuth(txnId: string): Promise<string> {
        const goal = this.goalStore.getByTxnId(txnId);
        if (!goal) {
            log.warn(`[GoalOrchestrator] abortGoalFromAuth: no goal for txn=${txnId}`);
            return '❌ Ação cancelada.';
        }
        log.info(`[GoalOrchestrator] [AUTH-REJECTED] goal=${goal.id} txn=${txnId} — aborting goal`);
        this.goalStore.update(goal.id, { status: 'failed', pendingTxnId: undefined });
        return '❌ Ação cancelada. O objetivo foi encerrado sem executar o comando.';
    }

    getGoalStore(): GoalStore { return this.goalStore; }
}
