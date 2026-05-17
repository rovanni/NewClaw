/**
 * AgentLoop — Atomic Cognition Pattern
 *
 * Unifies execution, validation, reassessment, and criticism into a single TURN.
 *
 * Delegates to:
 *   agentLoopTypes.ts    — interfaces
 *   agentPrompts.ts      — PROMPT_COMPONENTS + buildMasterPrompt()
 *   agentOutputParser.ts — sanitizeContent, parseLLMResponse, extractFinalText
 *   agentMetrics.ts      — buildLoopMetric, summarizeMetrics
 */

import { ProviderFactory, LLMMessage, ToolDefinition, LLMResult, MetricsSummary } from '../core/ProviderFactory';
import { CognitiveWorkspace } from '../cognitive/CognitiveWorkspace';
import { SessionContext } from '../session/SessionContext';
import type { SessionKey } from '../session/SessionManager';
import { ModelProfileRegistry } from './ModelProfileRegistry';
import { UnifiedIntentRouter, IntentDecision } from './UnifiedIntentRouter';
import PQueue from 'p-queue';
import { MemoryManager } from '../memory/MemoryManager';
import { SkillLearner } from './SkillLearner';
import { AgentStateManager } from '../core/AgentStateManager';
import { extractText } from './ResponseAdapter';
import { AuthorizationManager } from './AuthorizationManager';
import { ProtocolParser } from './ProtocolParser';
import { createLogger } from '../shared/AppLogger';
import { ClassificationMemory } from '../memory/ClassificationMemory';
import { DecisionMemory } from '../memory/DecisionMemory';
import { traceManager, ExecutionTrace } from '../core/ExecutionTrace';
import { AgentFSM, AgentFSMEvent } from './AgentFSM';
import { FSMHistoryStore } from './FSMHistoryStore';
import { ToolRegistry } from '../core/ToolRegistry';
import { SkillLoader } from '../skills/SkillLoader';
import { ModelProfile } from './ModelProfileRegistry';
import { errorMessage } from '../shared/errors';
import { ObserverValidator } from './ObserverValidator';
import { ReflectionMemory } from '../memory/ReflectionMemory';

import {
    ToolResult, ToolExecutor, LoopMetrics, ChannelContext,
    AgentLoopConfig, ProcessedResult, ContextAwareTool
} from './agentLoopTypes';
import { buildMasterPrompt } from './agentPrompts';
import { parseLLMResponse, extractFinalText } from './agentOutputParser';
import { buildLoopMetric, summarizeMetrics } from './agentMetrics';

export type { ToolResult, ToolExecutor, LoopMetrics, ChannelContext, AgentLoopConfig, ProcessedResult };

const log = createLogger('Agentloop');
const llmQueue = new PQueue({ concurrency: 1 });

export class AgentLoop {
    private providerFactory: ProviderFactory;
    private memory: MemoryManager;
    private tools: Map<string, ToolExecutor> = new Map();
    /** Cognitive Workspace: governed working memory for internal reasoning.
     *  NEVER shown to user. Auto-pruned, distilled, budget-controlled.
     *  Reset each conversation turn. */
    private cognitiveWorkspace = new CognitiveWorkspace();
    private authManager = new AuthorizationManager();
    private skillLearner: SkillLearner;
    private skillLoader: SkillLoader;
    private profileRegistry: ModelProfileRegistry;
    private intentRouter: UnifiedIntentRouter;
    private stateManager: AgentStateManager;
    private sessionContext: SessionContext | null = null;
    private metrics: LoopMetrics[] = [];
    private metricsMaxSize = 100;
    private activeTurns: Map<string, AbortController> = new Map();
    private classificationMemory: ClassificationMemory;
    private decisionMemory: DecisionMemory;
    private protocolParser: ProtocolParser;
    private observer: ObserverValidator;
    private reflectionMemory: ReflectionMemory;
    private fsmHistoryStore: FSMHistoryStore;
    private lastToolExecution: { toolName: string; toolOutput: string; intent: string; category: string } | null = null;

    constructor(
        providerFactory: ProviderFactory,
        memory: MemoryManager,
        config: AgentLoopConfig,
        skillLearner: SkillLearner,
        skillLoader: SkillLoader,
        classificationMemory?: ClassificationMemory,
        decisionMemory?: DecisionMemory
    ) {
        this.providerFactory = providerFactory;
        this.memory = memory;
        this.skillLearner = skillLearner as SkillLearner;
        this.skillLoader = skillLoader as SkillLoader;
        this.profileRegistry = new ModelProfileRegistry(config.modelRouter, providerFactory);
        this.intentRouter = new UnifiedIntentRouter(this.skillLearner);
        this.stateManager = new AgentStateManager(memory);
        this.protocolParser = new ProtocolParser();
        this.classificationMemory = classificationMemory as ClassificationMemory;
        this.decisionMemory = decisionMemory as DecisionMemory;
        this.observer = new ObserverValidator(providerFactory);
        this.reflectionMemory = new ReflectionMemory(memory);
        this.fsmHistoryStore = new FSMHistoryStore(memory);
    }

    // ── Accessors ──────────────────────────────────────────────────────────────

    private isAuthorized(conversationId: string, toolName: string, args: Record<string, unknown>): boolean {
        const pending = this.authManager.getPending(conversationId);
        if (pending && this.authManager.isMatch(pending, toolName, args)) {
            this.authManager.removePending(conversationId);
            return true;
        }
        return false;
    }

    public getIntentRouter(): UnifiedIntentRouter { return this.intentRouter; }

    public getProfileRegistry(): ModelProfileRegistry { return this.profileRegistry; }

    public getStateManager(): AgentStateManager { return this.stateManager; }

    /** Set session context for hybrid context building (checkpoint + recent + semantic). */
    public setSessionContext(sessionContext: SessionContext): void {
        this.sessionContext = sessionContext;
    }

    public registerTool(tool: ToolExecutor): void { this.tools.set(tool.name, tool); }

    private ts(): string { return new Date().toLocaleTimeString('pt-BR', { hour12: false }); }

    private async tryValidateTool(
        userText: string,
        intent: string,
        category: string,
        toolName: string,
        toolOutput: string,
        messages: LLMMessage[],
        traceId?: string,
        conversationId?: string,
        finalResponse?: string
    ): Promise<void> {
        try {
            const timeout = new Promise<null>(res => setTimeout(() => res(null), 5000));
            const validation = await Promise.race([
                this.observer.validate(userText, intent, toolName, toolOutput, finalResponse ?? ''),
                timeout
            ]);
            if (!validation) {
                log.info(`[OBSERVER] Validation timed out for ${toolName}`);
                return;
            }
            log.info(`[OBSERVER] ${validation.validationSkipped ? '⚠️ skipped' : validation.approved ? '✅' : '❌'} ${toolName} confidence=${validation.confidence} reason="${validation.reason}"`);

            if (!validation.validationSkipped) this.reflectionMemory.record({
                traceId,
                conversationId,
                userInput: userText,
                intent,
                toolUsed: toolName,
                toolOutput: toolOutput.slice(0, 1000),
                finalResponse: finalResponse?.slice(0, 500),
                approved: validation.approved,
                reason: validation.reason,
                confidence: validation.confidence,
                suggestedFix: validation.suggestedFix,
                pattern: category,
            });

            if (!validation.approved && validation.confidence >= 0.6 && validation.suggestedFix) {
                messages.push({
                    role: 'system',
                    content: `[OBSERVER] A ferramenta "${toolName}" pode não ter atendido à solicitação. ${validation.reason} — Sugestão: ${validation.suggestedFix}`
                });
            }
        } catch {
            // validação é não-fatal
        }
    }

    // ── Post-turn validation (fire-and-forget) ─────────────────────────────────

    private schedulePostTurnValidation(
        userText: string,
        finalResponse: string,
        traceId: string,
        conversationId: string
    ): void {
        const last = this.lastToolExecution;
        if (!last) return;
        // Roda fora do caminho crítico — não bloqueia a resposta ao usuário
        setImmediate(async () => {
            try {
                await this.tryValidateTool(
                    userText,
                    last.intent,
                    last.category,
                    last.toolName,
                    last.toolOutput,
                    [],         // sem injeção de mensagem — só persistência
                    traceId,
                    conversationId,
                    finalResponse
                );
            } catch {
                // não-fatal
            }
        });
    }

    // ── Entry points ───────────────────────────────────────────────────────────

    public cancel(conversationId: string): void {
        const ctrl = this.activeTurns.get(conversationId);
        if (ctrl) {
            ctrl.abort();
            this.activeTurns.delete(conversationId);
            log.info(`[${this.ts()}] [AGENT-FSM] Turn cancelled: ${conversationId}`);
        }
    }

    public async process(conversationId: string, userText: string, _userId?: string, context?: ChannelContext): Promise<string | ProcessedResult> {
        return this.run(conversationId, userText, conversationId, context);
    }

    public async run(conversationId: string, userText: string, userId?: string, context?: ChannelContext): Promise<string | ProcessedResult> {
        this.cognitiveWorkspace.reset();
        return this.runWithTools(conversationId, userText, 0, userId, context);
    }

    // ── Metrics ───────────────────────────────────────────────────────────────

    private pushMetric(result: LLMResult, timeoutMs: number, totalChars: number, approxTokens: number, preferredModel: string | undefined): void {
        const fallbackModel = this.profileRegistry.resolveProfileSync('').model || 'unknown';
        const metric = buildLoopMetric(result, timeoutMs, totalChars, approxTokens, preferredModel || fallbackModel);
        this.metrics.push(metric);
        if (this.metrics.length > this.metricsMaxSize) this.metrics.shift();
    }

    public getMetrics(): { recent: LoopMetrics[]; summary: MetricsSummary } {
        return summarizeMetrics(this.metrics);
    }

    // ── Trace persistence ──────────────────────────────────────────────────────

    private persistTrace(trace: ExecutionTrace, step: number, status: string, finalResponse: string, _context?: ChannelContext): void {
        try {
            const lastStep = trace.steps[trace.steps.length - 1];
            this.memory.saveTrace({
                id: trace.id,
                conversation_id: trace.sessionId,
                step,
                decision: status,
                tool: lastStep?.type === 'tool_call' ? lastStep.data?.tool : undefined,
                input: trace.userInput,
                output: finalResponse,
                provider: this.providerFactory.getProvider()?.name,
                duration_ms: trace.totalDurationMs,
                correlation_id: trace.correlationId
            });
        } catch (e) {
            log.warn('persist_trace_failed', errorMessage(e));
        }
    }

    // ── LLM call with fallback ─────────────────────────────────────────────────

    private async callLLMWithFallback(messages: LLMMessage[], toolDefs: ToolDefinition[], chatProfile: ModelProfile, signal?: AbortSignal): Promise<LLMResult> {
        const MIN_TIMEOUT = 45000;
        const MAX_TIMEOUT = 420000;
        const BASE_TIMEOUT = 180000;
        const SCALE_PER_TOKEN = 60;
        const MAX_SCALE = 240000;
        const TOKEN_THRESHOLD = 1000;

        const totalChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
        const approxTokens = Math.ceil(totalChars / 4);
        const scale = Math.min(Math.max(0, approxTokens - TOKEN_THRESHOLD) * SCALE_PER_TOKEN, MAX_SCALE);
        const timeoutMs = Math.max(MIN_TIMEOUT, Math.min(BASE_TIMEOUT + scale, MAX_TIMEOUT));
        log.info(`[${this.ts()}] [TIMEOUT] Dynamic: ${Math.round(timeoutMs / 1000)}s (tokens≈${approxTokens}, chars=${totalChars}, scale=${Math.round(scale / 1000)}s, clamp=[${MIN_TIMEOUT / 1000}-${MAX_TIMEOUT / 1000}]s)`);

        if (chatProfile?.model) {
            const provider = this.providerFactory.getProvider();
            if (provider) {
                log.info(`[${this.ts()}] Setting model ${chatProfile.model} on provider ${provider.name}`);
                provider.setModel(chatProfile.model);
            }
        }

        const callStart = Date.now();
        try {
            const result = await llmQueue.add(() => this.providerFactory.chatWithFallback(
                messages,
                toolDefs,
                undefined,
                timeoutMs,
                signal
            ));

            this.pushMetric(result, timeoutMs, totalChars, approxTokens, chatProfile?.model);

            if (result.status === 'timeout' || result.status === 'error') {
                const elapsed = Date.now() - callStart;
                const last = result.attempts[result.attempts.length - 1];
                log.warn(`[TIMEOUT-DETAIL] status=${result.status} promptSize=${totalChars} estimatedTokens=${approxTokens} timeoutUsed=${Math.round(timeoutMs / 1000)}s elapsed=${Math.round(elapsed / 1000)}s provider=${last?.provider || 'unknown'} model=${last?.model || 'unknown'} attempts=${result.attempts.length}`);
            }

            return result;
        } catch (error) {
            const elapsed = Date.now() - callStart;
            log.error(`Unexpected error in LLM call: ${errorMessage(error)}.`);
            log.warn(`[TIMEOUT-DETAIL] status=error promptSize=${totalChars} estimatedTokens=${approxTokens} timeoutUsed=${Math.round(timeoutMs / 1000)}s elapsed=${Math.round(elapsed / 1000)}s provider=unknown model=unknown`);
            const errorResult: LLMResult = {
                status: 'error',
                content: '',
                fallbackReason: 'error',
                fallbackMessage: 'Erro inesperado ao processar sua mensagem.',
                attempts: [{ provider: 'unknown', model: 'unknown', duration: elapsed, status: 'error', errorMessage: errorMessage(error) }]
            };
            this.pushMetric(errorResult, timeoutMs, totalChars, approxTokens, chatProfile?.model);
            return errorResult;
        }
    }

    // ── Core execution loop ────────────────────────────────────────────────────

    private async runWithTools(conversationId: string, userText: string, iteration: number, _userId?: string, channelContext?: ChannelContext): Promise<string | ProcessedResult> {
        const correlationId = channelContext?.correlationId;
        const turnLog = correlationId ? log.child({ cid: correlationId.slice(0, 8) }) : log;

        turnLog.info('turn_start', `Cycle ${iteration + 1}`, { conversationId });

        const cycleHistory: Array<{ tool: string; input: string; status: string }> = [];
        let lastBestContent = '';
        let toolFailureCount = 0;
        const usedToolInputs = new Set<string>();

        const turnAbort = new AbortController();
        this.activeTurns.set(conversationId, turnAbort);
        const turnSignal = turnAbort.signal;

        const trace = traceManager.startTrace(conversationId, userText, correlationId);
        const fsm = new AgentFSM();
        const move = (event: AgentFSMEvent, meta?: Record<string, unknown>) => {
            try {
                const transition = fsm.transition(event, meta);
                log.info(`[${this.ts()}] [AGENT-FSM] ${transition.from} --${event}--> ${transition.to}`);
                traceManager.addStep(trace, 'fsm_transition', transition);
                this.fsmHistoryStore.record(transition, trace.id, conversationId);
            } catch (error) {
                log.warn(`[${this.ts()}] [AGENT-FSM] Invalid transition ${fsm.getState()} --${event}: ${errorMessage(error)}`);
            }
        };
        move('START_TURN');

        const intentDecision: IntentDecision = this.intentRouter.route(userText, { sessionId: conversationId });

        traceManager.addStep(trace, 'intent_classification', {
            intent: intentDecision.intent,
            category: intentDecision.category,
            executionMode: intentDecision.executionMode,
            confidence: intentDecision.confidence,
            source: intentDecision.source,
            modelCategory: intentDecision.modelCategory,
            riskLevel: intentDecision.riskLevel,
            cognitiveLoad: intentDecision.cognitiveLoad,
            requiresTools: intentDecision.requiresTools,
            requiresMemory: intentDecision.requiresMemory,
            requiresReasoning: intentDecision.requiresReasoning,
        });
        log.info(`[${this.ts()}] [UNIFIED-ROUTER] intent=${intentDecision.intent} mode=${intentDecision.executionMode} category=${intentDecision.category} confidence=${intentDecision.confidence} source=${intentDecision.source} model=${intentDecision.modelCategory}`);

        if (intentDecision.terminalAction && intentDecision.executionMode === 'direct' && intentDecision.category === 'greeting') {
            log.info(`[${this.ts()}] [FAST-PATH] Greeting detected — skipping LLM`);
            move('FINAL_READY');
            traceManager.completeTrace(trace, 'completed', 'Greeting fast path');
            const greetings = ['Olá! 👋', 'Oi! Como posso ajudar?', 'E aí! 🚀', 'Olá! Tô aqui! 💪', 'Opa! Bora? 😊'];
            return greetings[Math.floor(Math.random() * greetings.length)];
        }

        this.classificationMemory.store(userText, intentDecision.modelCategory, intentDecision.confidence);
        this.lastToolExecution = null;

        let skillContext = intentDecision.skillContext ?? '';

        const reflectionHint = this.reflectionMemory.buildContextHint(intentDecision.category);
        if (reflectionHint) {
            skillContext = skillContext ? `${skillContext}\n\n${reflectionHint}` : reflectionHint;
        }

        const manualSkills = this.skillLoader.loadAll();
        const matchedManual = manualSkills.filter(s =>
            s.triggers?.some(t => userText.toLowerCase().includes(t.toLowerCase()))
        );
        if (matchedManual.length > 0) {
            const manualBlock = matchedManual.map(s => `### SKILL MANUAL: ${s.name}\n${s.content}`).join('\n\n');
            skillContext = skillContext ? `${skillContext}\n\n${manualBlock}` : manualBlock;
            log.info(`[SKILL] Injetando ${matchedManual.length} skill(s) manual(ais): ${matchedManual.map(s => s.name).join(', ')}`);
        }

        const toolDefs: ToolDefinition[] = Array.from(this.tools.values()).map(t => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters
        }));

        const chatProfile = await this.profileRegistry.resolveProfile(userText);
        if (intentDecision.modelCategory && intentDecision.confidence >= 0.8) {
            const intentProfile = this.profileRegistry.getProfileByCategory(intentDecision.modelCategory);
            if (intentProfile) {
                chatProfile.model = intentProfile.model;
                chatProfile.category = intentProfile.category;
                log.info(`[${this.ts()}] [UNIFIED-ROUTER] Overriding model: ${intentDecision.modelCategory} → ${intentProfile.model}`);
            }
        }

        if (!this.sessionContext) {
            log.error('sessionContext not set — session pipeline is mandatory. Throwing.');
            throw new Error('SessionContext is required. Set via AgentLoop.setSessionContext() before processing.');
        }

        const sessionKey: SessionKey = { channel: 'telegram', userId: conversationId };
        const { messages: sessionMessages } = await this.sessionContext.buildLLMMessages(
            sessionKey,
            buildMasterPrompt(chatProfile.category),
            userText,
            skillContext
        );
        const loopMessages = sessionMessages;

        const pending = this.authManager.getPending(conversationId);
        if (pending) {
            log.info(`[${this.ts()}] [AUTH] Evaluating response for pending action. Intent: ${intentDecision.category}`);

            if (intentDecision.category === 'confirmation') {
                log.info(`[${this.ts()}] [AUTH] Action APPROVED via Router for ${conversationId}: ${pending.toolName}`);
                this.authManager.removePending(conversationId);

                const tool = this.tools.get(pending.toolName);
                if (tool) {
                    log.info(`[${this.ts()}] [AUTH] Executing approved tool: ${pending.toolName}`);
                    move('TOOL_REQUESTED', { step: 0, tool: pending.toolName, mode: 'auth_resume' });

                    if (typeof (tool as unknown as ContextAwareTool).setContext === 'function' && channelContext) {
                        (tool as unknown as ContextAwareTool).setContext(
                            channelContext.chatId || '',
                            channelContext.channel
                        );
                    }

                    try {
                        const result = await tool.execute(pending.arguments);
                        log.info(`[${this.ts()}] [AUTH] Approved tool ${pending.toolName} executed. Success: ${result.success}`);
                        cycleHistory.push({ tool: pending.toolName, input: JSON.stringify(pending.arguments), status: result.success ? 'success' : 'error' });

                        const toolCallId = `auth_${Date.now()}`;
                        loopMessages.push({
                            role: 'assistant',
                            content: `Executando comando autorizado: ${pending.toolName}`,
                            toolCalls: [{ id: toolCallId, name: pending.toolName, arguments: pending.arguments }]
                        });
                        loopMessages.push({ role: 'tool', content: result.output, tool_call_id: toolCallId });

                        if (!result.success) {
                            loopMessages.push({ role: 'system', content: `[AVISO] O comando autorizado falhou: ${result.error || 'Erro desconhecido'}` });
                        }

                        const terminalTools = ['send_audio', 'send_document', 'send_image', 'send_video'];
                        if (terminalTools.includes(pending.toolName) && result.success) {
                            log.info(`[${this.ts()}] [AUTH] Terminal tool succeeded → finishing turn`);
                            move('FINAL_READY', { step: 0, tool: pending.toolName, terminal: true });
                            traceManager.completeTrace(trace, 'completed', result.output);
                            this.persistTrace(trace, 0, 'completed', result.output, channelContext);
                            return result.output;
                        }
                    } catch (toolError) {
                        log.error(`[AUTH] Error executing approved tool ${pending.toolName}:`, toolError);
                        loopMessages.push({ role: 'system', content: `[ERRO CRÍTICO] Falha ao executar comando autorizado: ${errorMessage(toolError)}` });
                    }
                }
            } else if (intentDecision.category === 'rejection') {
                log.warn(`[${this.ts()}] [AUTH] Action REJECTED via Router for ${conversationId}: ${pending.toolName}`);
                this.authManager.removePending(conversationId);
                return { text: `❌ Execução cancelada pelo usuário. Como posso ajudar agora?` };
            } else {
                log.info(`[${this.ts()}] [AUTH] Ambiguous response. Keeping ${pending.toolName} pending and proceeding with conversation.`);
            }
        }

        let stepCount = 0;
        const maxSteps = 15;
        let hasUsedNativeTools = false;      // true once any native tool call executes
        let consecutiveNonProgressSteps = 0; // non-JSON, no-tool responses in a row

        while (stepCount < maxSteps) {
            stepCount++;
            log.info(`[${this.ts()}] [COGNITION] Step ${stepCount}...`);

            if (toolFailureCount >= 2) {
                loopMessages.push({
                    role: 'system',
                    content: '[CRÍTICO] Múltiplas ferramentas falharam. PARE de tentar ferramentas. Responda AGORA declarando claramente a limitação de dados. Seja honesto e transparente: não invente tendências e não use linguagem vaga. Ofereça uma alternativa útil com base no que já sabemos.'
                });
            }

            move('LLM_REQUEST', { step: stepCount });
            const response = await this.callLLMWithFallback(loopMessages, toolDefs, chatProfile, turnSignal);
            move('LLM_RESPONSE', { step: stepCount, status: response.status });

            if (response.thinking && response.thinking.trim().length > 0) {
                this.cognitiveWorkspace.add(stepCount, response.thinking.trim(), 'reasoning');
            }

            traceManager.addStep(trace, 'decision', {
                thought: parseLLMResponse(response.content || '')?.thought,
                step: stepCount,
                iteration
            });

            if (response.status === 'cancelled') {
                log.info(`[${this.ts()}] [AGENT-FSM] Turn cancelled at step ${stepCount}`);
                move('CANCEL', { step: stepCount });
                traceManager.completeTrace(trace, 'cancelled', 'Operação cancelada.');
                this.activeTurns.delete(conversationId);
                return { text: 'Operação cancelada.' };
            }

            if (response.status === 'timeout') {
                log.warn(`[${this.ts()}] [FALLBACK] Provider timeout at step ${stepCount}`);
                move('TIMEOUT', { step: stepCount });
                traceManager.completeTrace(trace, 'timeout', response.fallbackMessage);
                this.persistTrace(trace, stepCount, 'timeout', response.fallbackMessage || 'Timeout', channelContext);
                this.activeTurns.delete(conversationId);
                return response.fallbackMessage || 'O modelo demorou mais que o esperado. Tente novamente em alguns instantes.';
            }

            if (response.status === 'error') {
                log.warn(`[${this.ts()}] [FALLBACK] Provider error at step ${stepCount}: ${response.fallbackReason}`);
                move('FAIL', { step: stepCount, status: response.status });
                traceManager.completeTrace(trace, 'error', response.fallbackMessage);
                this.persistTrace(trace, stepCount, 'error', response.fallbackMessage || 'Error', channelContext);
                this.activeTurns.delete(conversationId);
                return response.fallbackMessage || 'Erro ao processar sua mensagem.';
            }

            this.protocolParser.setProviderContext(
                response.attempts?.[0]?.provider || 'unknown',
                response.attempts?.[0]?.model || 'unknown'
            );

            const structured = this.protocolParser.strictParse(response.content || '');
            const atomicData = parseLLMResponse(response.content || '');
            const finalText = extractFinalText(response, atomicData);

            if (finalText.length > 0) {
                lastBestContent = finalText;
            }

            loopMessages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls });

            const wantsTool = structured?.type === 'tool_call' || (atomicData?.action?.type === 'tool' && atomicData?.action?.name);
            const hasNativeToolCalls = response.toolCalls && response.toolCalls.length > 0;

            // Track when the model demonstrates native tool capability.
            if (hasNativeToolCalls) {
                hasUsedNativeTools = true;
                consecutiveNonProgressSteps = 0;
            }

            // Protocol violation recovery — only when there are NO native tool calls to execute.
            // Native tool calls must always execute regardless of content format.
            if (structured?.metadata?.protocolViolation && structured?.type === 'planning' && !hasNativeToolCalls) {
                consecutiveNonProgressSteps++;

                // Generic signal 1: model already used native tools and now has a plain-text answer.
                // Applies to any model that uses toolCalls[] natively instead of JSON protocol.
                if (hasUsedNativeTools && finalText.length > 30) {
                    log.info(`[${this.ts()}] [PROTOCOL-EXIT] Native-tool model → plain-text final answer (step ${stepCount}, len=${finalText.length})`);
                    move('FINAL_READY', { step: stepCount, reason: 'native_tool_final' });
                    traceManager.completeTrace(trace, 'completed', finalText);
                    this.persistTrace(trace, stepCount, 'completed', finalText, channelContext);
                    return { text: finalText };
                }

                // Generic signal 2: model received 2 recovery prompts and still didn't produce JSON.
                // Accept best available content rather than spinning indefinitely.
                if (consecutiveNonProgressSteps >= 2 && lastBestContent.length > 0) {
                    log.info(`[${this.ts()}] [PROTOCOL-EXIT] ${consecutiveNonProgressSteps} non-progress steps → using best content (len=${lastBestContent.length})`);
                    move('FINAL_READY', { step: stepCount, reason: 'non_progress_limit' });
                    traceManager.completeTrace(trace, 'completed', lastBestContent);
                    this.persistTrace(trace, stepCount, 'completed', lastBestContent, channelContext);
                    return { text: lastBestContent };
                }

                loopMessages.push({ role: 'system', content: this.protocolParser.getRecoveryPrompt() });
                continue;
            }

            consecutiveNonProgressSteps = 0;

            const isExplicitlyComplete = structured?.isComplete === true;
            const isExplicitlyIncomplete = structured?.isComplete === false;
            const isFinalAnswer = structured?.type === 'final_answer';

            if ((isFinalAnswer || isExplicitlyComplete) && !isExplicitlyIncomplete && !wantsTool && !hasNativeToolCalls) {
                move('FINAL_READY', { step: stepCount, reason: isFinalAnswer ? 'final_answer' : 'is_complete' });
                traceManager.completeTrace(trace, 'completed', finalText);
                this.persistTrace(trace, stepCount, 'completed', finalText, channelContext);
                this.schedulePostTurnValidation(userText, finalText, trace.id, conversationId);
                return { text: finalText };
            }

            if (response.toolCalls && response.toolCalls.length > 0) {
                for (const toolCall of response.toolCalls) {
                    const toolName = toolCall.name;
                    const toolInput = JSON.stringify(toolCall.arguments);
                    const inputKey = `${toolName}:${toolInput}`;

                    if (usedToolInputs.has(inputKey)) {
                        loopMessages.push({
                            role: 'system',
                            content: `[AVISO] Você já tentou a ferramenta "${toolName}" com este input. NÃO repita. Mude a estratégia ou responda com o que já sabe.`
                        });
                        continue;
                    }

                    const tool = this.tools.get(toolName);
                    if (tool) {
                        move('TOOL_REQUESTED', { step: stepCount, tool: toolName, mode: 'native' });
                        if (typeof (tool as unknown as ContextAwareTool).setContext === 'function' && channelContext) {
                            (tool as unknown as ContextAwareTool).setContext(
                                channelContext.chatId || '',
                                channelContext.channel
                            );
                        }

                        const isDangerous = ToolRegistry.isDangerous(toolName);
                        if (isDangerous && !this.isAuthorized(conversationId, toolName, toolCall.arguments)) {
                            log.warn(`[${this.ts()}] [AUTH] Dangerous tool BLOCKED: ${toolName}. Waiting for human approval.`);
                            this.authManager.addPending(conversationId, toolName, toolCall.arguments);
                            move('AUTH_REQUIRED', { step: stepCount, tool: toolName });
                            const authReq = this.authManager.formatRequest(toolName, toolCall.arguments);
                            return { text: authReq.text, options: authReq.options };
                        }

                        const toolStartTime = Date.now();
                        const result = await tool.execute(toolCall.arguments);
                        const toolDuration = Date.now() - toolStartTime;

                        log.info(`[${this.ts()}] [TOOL] ${toolName} -> ${result.success ? '✓' : '✗'}`, result.error ? `ERROR: ${result.error}` : (result.output || '').slice(0, 200));

                        traceManager.addStep(trace, 'tool_call', { tool: toolName, input: toolCall.arguments });
                        traceManager.addStep(trace, 'tool_result', { tool: toolName, success: result.success, output: result.output });
                        this.decisionMemory.recordFromLoop(toolName, result.success, toolDuration, userText);
                        this.skillLearner.recordPattern(userText, toolName, result.success, toolDuration);

                        usedToolInputs.add(inputKey);
                        cycleHistory.push({ tool: toolName, input: toolInput, status: result.success ? 'success' : 'error' });
                        loopMessages.push({ role: 'tool', content: result.output, tool_call_id: toolCall.id });

                        if (!result.success) {
                            toolFailureCount++;
                            loopMessages.push({
                                role: 'system',
                                content: `[FALHA] A ferramenta "${toolName}" falhou. Tente uma abordagem diferente ou use seu conhecimento interno.`
                            });
                        }

                        const terminalTools = ['send_audio', 'send_document', 'send_image', 'send_video'];
                        if (result.success && !terminalTools.includes(toolName)) {
                            this.lastToolExecution = { toolName, toolOutput: result.output, intent: intentDecision.intent, category: intentDecision.category };
                            await this.tryValidateTool(userText, intentDecision.intent, intentDecision.category, toolName, result.output, loopMessages, trace.id, conversationId);
                        }
                        if (terminalTools.includes(toolName) && result.success) {
                            log.info(`[${this.ts()}] [TASK-FSM] Terminal tool "${toolName}" succeeded → task DONE, returning result`);
                            move('FINAL_READY', { step: stepCount, tool: toolName, terminal: true });
                            traceManager.completeTrace(trace, 'completed', result.output);
                            this.persistTrace(trace, stepCount, 'completed', result.output, channelContext);
                            return result.output;
                        }
                        move('TOOL_COMPLETED', { step: stepCount, tool: toolName, success: result.success });
                    }
                }
                continue;
            }

            // Protocol-Based Early Exit
            const hasNoToolsRequested = !response.toolCalls?.length && !wantsTool;
            const isStructuredPlanning = structured?.type === 'planning';

            if (hasNoToolsRequested && !isExplicitlyIncomplete && !isStructuredPlanning) {
                if (finalText.length > 0) {
                    log.info(`[${this.ts()}] [PROTOCOL-EXIT] No tools, structured complete — returning content (step ${stepCount}, type=${structured?.type})`);
                    move('FINAL_READY', { step: stepCount, reason: 'no_tools_requested' });
                    traceManager.completeTrace(trace, 'completed', finalText);
                    this.persistTrace(trace, stepCount, 'completed', finalText, channelContext);
                    this.schedulePostTurnValidation(userText, finalText, trace.id, conversationId);
                    return finalText;
                }
            }

            // JSON-action tool execution
            if (atomicData?.action?.type === 'tool' && atomicData.action.name) {
                const toolName = atomicData.action.name;
                const toolInput = JSON.stringify(atomicData.action.input || {});
                const inputKey = `${toolName}:${toolInput}`;

                if (usedToolInputs.has(inputKey)) {
                    log.warn(`[${this.ts()}] [ATOMIC-TOOL] Blocked repeated call: ${toolName}`);
                    loopMessages.push({
                        role: 'system',
                        content: `[AVISO] Você já tentou a ferramenta "${toolName}" com este input. NÃO repita. Mude a estratégia ou responda com o que já sabe.`
                    });
                    continue;
                }

                const tool = this.tools.get(toolName);
                if (tool) {
                    move('TOOL_REQUESTED', { step: stepCount, tool: toolName, mode: 'json_action' });
                    if (typeof (tool as unknown as ContextAwareTool).setContext === 'function' && channelContext) {
                        (tool as unknown as ContextAwareTool).setContext(
                            channelContext.chatId || '',
                            channelContext.channel
                        );
                    }

                    const toolStartTime = Date.now();
                    const result = await tool.execute(atomicData.action.input || {});
                    const toolDuration = Date.now() - toolStartTime;

                    log.info(`[${this.ts()}] [ATOMIC-TOOL] ${toolName} -> ${result.success ? '✓' : '✗'}`, result.error ? `ERROR: ${result.error}` : (result.output || '').slice(0, 200));

                    traceManager.addStep(trace, 'tool_call', { tool: toolName, input: atomicData.action.input });
                    traceManager.addStep(trace, 'tool_result', { tool: toolName, success: result.success, output: result.output });
                    this.decisionMemory.recordFromLoop(toolName, result.success, toolDuration, userText);
                    this.skillLearner.recordPattern(userText, toolName, result.success, toolDuration);

                    usedToolInputs.add(inputKey);
                    cycleHistory.push({ tool: toolName, input: toolInput, status: result.success ? 'success' : 'error' });
                    loopMessages.push({ role: 'tool', content: result.output });

                    if (!result.success) {
                        toolFailureCount++;
                        loopMessages.push({
                            role: 'system',
                            content: `[FALHA] A ferramenta "${toolName}" falhou. Tente uma abordagem diferente ou use seu conhecimento interno.`
                        });
                    }

                    const terminalTools = ['send_audio', 'send_document', 'send_image', 'send_video'];
                    if (terminalTools.includes(toolName) && result.success) {
                        log.info(`[${this.ts()}] [TASK-FSM] Terminal atomic tool "${toolName}" succeeded → task DONE, returning result`);
                        move('FINAL_READY', { step: stepCount, tool: toolName, terminal: true });
                        traceManager.completeTrace(trace, 'completed', result.output);
                        this.persistTrace(trace, stepCount, 'completed', result.output, channelContext);
                        return result.output;
                    }

                    if (result.success) {
                        this.lastToolExecution = { toolName, toolOutput: result.output, intent: intentDecision.intent, category: intentDecision.category };
                        await this.tryValidateTool(userText, intentDecision.intent, intentDecision.category, toolName, result.output, loopMessages, trace.id, conversationId);
                    }

                    move('TOOL_COMPLETED', { step: stepCount, tool: toolName, success: result.success });
                    continue;
                }
            }

            if (stepCount >= maxSteps) {
                log.warn(`[${this.ts()}] [LOOP] Step limit reached. Finalizing...`);
                break;
            }
        }

        // Post-loop synthesis
        const executedToolsInLastStep = cycleHistory.length > 0;
        const hasGoodContent = lastBestContent && lastBestContent.length > 100;

        if (executedToolsInLastStep && !hasGoodContent) {
            log.info(`[${this.ts()}] [SYNTHESIS] Tools executed but response is stale/brief (${lastBestContent?.length || 0} chars). Generating post-action synthesis...`);
            move('SYNTHESIS_REQUIRED', { step: stepCount, tools: cycleHistory.length });

            const toolSummary = cycleHistory.map(h => `• ${h.tool}: ${h.status}`).join('\n');
            loopMessages.push({
                role: 'system',
                content: `SÍNTESE FINAL OBRIGATÓRIA — RESPONDA EM TEXTO PURO (NÃO use JSON, NÃO use formato action/thought):\n\nVocê executou as seguintes ações:\n${toolSummary}\n\nAgora RESUMA para o usuário exatamente O QUE foi feito, com detalhes específicos das alterações realizadas. Não diga "vou fazer" — você JÁ fez. Confirme as mudanças de forma clara e objetiva. Responda DIRETAMENTE em linguagem natural.`
            });

            move('LLM_REQUEST', { step: stepCount, phase: 'synthesis' });
            const synthesisResponse = await this.callLLMWithFallback(loopMessages, [], chatProfile, turnSignal);
            move('LLM_RESPONSE', { step: stepCount, phase: 'synthesis', status: synthesisResponse.status });
            if (synthesisResponse.status === 'cancelled') {
                move('CANCEL', { step: stepCount, phase: 'synthesis' });
                this.activeTurns.delete(conversationId);
                return { text: 'Operação cancelada.' };
            }
            const rawSynthesis = synthesisResponse.content || '';

            let synthesisText = extractText(rawSynthesis);
            if (!synthesisText || synthesisText.length < 20) {
                synthesisText = extractFinalText(synthesisResponse, parseLLMResponse(rawSynthesis));
            }
            if (!synthesisText || synthesisText.length < 20) {
                synthesisText = rawSynthesis
                    .replace(/^\s*\{[\s\S]*\}\s*$/, '')
                    .replace(/```[\s\S]*?```/g, '')
                    .trim();
            }

            if (synthesisText && synthesisText.length > 10) {
                log.info(`[${this.ts()}] [SYNTHESIS] Success: ${synthesisText.length} chars extracted from ${rawSynthesis.length} chars raw`);
                move('FINAL_READY', { step: stepCount, reason: 'synthesis' });
                traceManager.completeTrace(trace, 'completed', synthesisText);
                this.persistTrace(trace, stepCount, 'completed', synthesisText, channelContext);
                this.schedulePostTurnValidation(userText, synthesisText, trace.id, conversationId);
                return synthesisText;
            }

            log.warn(`[${this.ts()}] [SYNTHESIS] Failed to extract useful text (raw=${rawSynthesis.length}, extracted=${synthesisText?.length || 0})`);
        }

        if (lastBestContent) {
            move('FINAL_READY', { step: stepCount, reason: 'last_best_content' });
            traceManager.completeTrace(trace, 'completed', lastBestContent);
            this.persistTrace(trace, stepCount, 'completed', lastBestContent, channelContext);
            this.schedulePostTurnValidation(userText, lastBestContent, trace.id, conversationId);
            return lastBestContent;
        }

        log.info(`[${this.ts()}] [FALLBACK] Generating final synthesis...`);
        loopMessages.push({
            role: 'system',
            content: 'FINALIZAÇÃO OBRIGATÓRIA — RESPONDA EM TEXTO PURO (NÃO use JSON): Forneça uma resposta honesta agora. Se não obteve dados suficientes, admita a limitação claramente. Responda diretamente em linguagem natural.'
        });

        move('SYNTHESIS_REQUIRED', { step: stepCount, reason: 'fallback' });
        move('LLM_REQUEST', { step: stepCount, phase: 'fallback' });
        const finalResponse = await this.callLLMWithFallback(loopMessages, [], chatProfile, turnSignal);
        move('LLM_RESPONSE', { step: stepCount, phase: 'fallback', status: finalResponse.status });
        if (finalResponse.status === 'cancelled') {
            move('CANCEL', { step: stepCount, phase: 'fallback' });
            this.activeTurns.delete(conversationId);
            return { text: 'Operação cancelada.' };
        }
        const rawFinal = finalResponse.content || '';

        let text = extractText(rawFinal);
        if (!text || text.length < 20) {
            text = extractFinalText(finalResponse, parseLLMResponse(rawFinal));
        }

        move('FINAL_READY', { step: stepCount, reason: stepCount >= maxSteps ? 'max_iterations' : 'fallback' });
        traceManager.completeTrace(trace, stepCount >= maxSteps ? 'max_iterations' : 'completed', text);
        this.persistTrace(trace, stepCount, stepCount >= maxSteps ? 'max_iterations' : 'completed', text, channelContext);
        this.schedulePostTurnValidation(userText, text, trace.id, conversationId);
        this.activeTurns.delete(conversationId);

        return text;
    }
}
