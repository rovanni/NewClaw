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
import { computeDynamicTimeout } from '../shared/dynamicTimeout';
import { CognitiveWorkspace } from '../cognitive/CognitiveWorkspace';
import { SessionContext } from '../session/SessionContext';
import type { SessionKey } from '../session/SessionManager';
import { ModelProfileRegistry } from './ModelProfileRegistry';
import { UnifiedIntentRouter, IntentDecision, IntentCategory } from './UnifiedIntentRouter';
import { generationQueue, TaskPriority } from '../core/providerQueue';
import { MemoryManager } from '../memory/MemoryManager';
import { SkillLearner } from './SkillLearner';
import { AgentStateManager } from '../core/AgentStateManager';
import { extractText } from './ResponseAdapter';
import { AuthorizationManager } from './AuthorizationManager';
import { ProtocolParser } from './ProtocolParser';
import { createLogger } from '../shared/AppLogger';
import { ANALYSIS_INTENT_PATTERN } from '../shared/analysisIntentPattern';
import { ClassificationMemory } from '../memory/ClassificationMemory';
import { DecisionMemory } from '../memory/DecisionMemory';
import { traceManager, ExecutionTrace } from '../core/ExecutionTrace';
import { AgentFSM, AgentFSMEvent } from './AgentFSM';
import { FSMHistoryStore } from './FSMHistoryStore';
import { ToolRegistry } from '../core/ToolRegistry';
import { permissionRegistry } from '../core/PermissionRegistry';
import { SkillLoader } from '../skills/SkillLoader';
import { ModelProfile } from './ModelProfileRegistry';
import { errorMessage } from '../shared/errors';
import { ObserverValidator, ResponseCommit } from './ObserverValidator';
import { ReflectionMemory } from '../memory/ReflectionMemory';
import { ProactiveRecovery } from './ProactiveRecovery';
import type { WorkflowEngine } from './WorkflowEngine';
import type { ContinuationContext, WorkflowStepResult, AuthDecision } from './WorkflowTypes';

import {
    ToolResult, ToolExecutor, LoopMetrics, ChannelContext,
    AgentLoopConfig, ProcessedResult, ContextAwareTool
} from './agentLoopTypes';
import { buildMasterPrompt } from './agentPrompts';
import { parseLLMResponse, extractFinalText } from './agentOutputParser';
import { buildLoopMetric, summarizeMetrics } from './agentMetrics';
import { extractMissingExecutable } from './planning/extractMissingExecutable';
import { computeToolInputKey } from './planning/computeToolInputKey';
import { SOURCE_SCRIPT_EXTENSIONS, DELIVERABLE_EXTENSIONS } from './planning/inferExpectedExtensions';

export type { ToolResult, ToolExecutor, LoopMetrics, ChannelContext, AgentLoopConfig, ProcessedResult };

const log = createLogger('Agentloop');

// ── Adaptive Step Budget ─────────────────────────────────────────────────────
// Maps execution mode (from UnifiedIntentRouter) to a max-step ceiling.
// Values chosen to match cognitive complexity of each mode:
//   direct  — LLM answers directly, at most one lookup tool.
//   tool    — structured tool execution (file ops, APIs).
//   planner — multi-step goal with explicit planning loops.
//   hybrid  — default: reasoning + a few tool calls.
// Extend here when new execution modes are introduced — do not hardcode inside
// the loop logic.
export const STEP_BUDGETS: Record<string, number> = {
    direct:  4,
    hybrid:  6,
    tool:   10,
    planner: 15,
};

// ── Tool Group Registry ──────────────────────────────────────────────────────
// Assigns tools to logical groups so the loop can detect cross-tool loops
// (e.g. web_search ↔ web_navigate alternation).
// Add new tools here as the tool surface grows — the guard logic is group-aware,
// not tool-name-aware.
export const TOOL_GROUP_REGISTRY: Record<string, string> = {
    web_search:   'search',
    web_navigate: 'search',
};

// ── Tool Utility Score ───────────────────────────────────────────────────────
// Generic keyword-overlap heuristic measuring how relevant a tool's output is
// to the user's original message. Used for observability only — does NOT affect
// control flow in this version. Collect data before adding decision logic.
export function computeToolUtilityScore(userMessage: string, toolOutput: string): number {
    if (!userMessage || !toolOutput || toolOutput.length < 10) return 0.5;
    const terms = userMessage.toLowerCase().split(/\W+/).filter(t => t.length >= 4);
    if (terms.length === 0) return 0.5;
    const lowerOutput = toolOutput.toLowerCase();
    const hits = terms.filter(t => lowerOutput.includes(t)).length;
    return Math.round((hits / terms.length) * 100) / 100;
}

// ── DecisionContext ──────────────────────────────────────────────────────────
// Aggregates cognitive signals available at turn-start into a single struct
// consumed by the loop to *orient* (not mandate) agent behaviour.
// Principle: boost priorities and inject hints — never remove tool options.

export type MemoryConfidence = 'high' | 'medium' | 'low' | 'none';

export interface DecisionContext {
    memoryConfidence:            MemoryConfidence;
    hasHighRelevancePreference:  boolean;
    /** When true: inject memory-first hint (doesn't block external tools). */
    requiresMemoryFirst:         boolean;
    /** When non-null: override step budget to this higher ceiling. */
    extendedStepBudget:          number | null;
    /** Historical success rate per tool (0–1). Used for cost-aware hints. */
    toolSuccessRates:            Record<string, number>;
}

/**
 * ARCH-019 (S25, Incremento 1): snapshot somente-leitura do estado do turno, usado por
 * `logTurnDiagnostics()` — extraído do bloco "Structured turn diagnostics" de
 * `runWithTools()`. Nenhum campo é mutado pelo método; é só um agrupamento nomeado dos ~20
 * sinais soltos que o bloco original lia via closure, evitando 25 parâmetros posicionais.
 */
interface TurnDiagnosticsInput {
    stepCount: number;
    executionMode: string;
    maxSteps: number;
    decisionCtx: DecisionContext;
    getContextChars: () => number;
    initialContextChars: number;
    toolTypeCallCount: Map<string, number>;
    groupCallCount: Map<string, number>;
    cycleHistory: Array<{ step: number; tool: string; input: string; status: string }>;
    maxSameToolCalls: number;
    totalToolCalls: number;
    consecutiveToolFailures: number;
    toolFailureCount: number;
    totalThinkingChars: number;
    guardsTriggered: number;
    dedupAbortTool: string;
    memoryFirstInjected: boolean;
    toolFailureHintInjected: boolean;
    toolFailureHintFirstStep: number | null;
    toolSuccessHintInjected: boolean;
    toolSuccessHintFirstStep: number | null;
    observerFeedbackInjected: boolean;
    observerFeedbackFirstStep: number | null;
    reflectionHintInjected: boolean;
    intentCategory: string;
}

/**
 * ARCH-019 (S25, Incremento 2): retorno de `runDeliveryGuardPhase()`, extraído do bloco
 * "Delivery guard" de `runWithTools()`. `earlyReturn: true` replica um `return` que existia
 * dentro do bloco original (cancelamento ou entrega terminal bem-sucedida); `earlyReturn: false`
 * replica a queda para o código seguinte (síntese pós-loop) — só `stepCount` precisa ser
 * devolvido explicitamente (mutado pelo laço interno do próprio guard); `cycleHistory` e
 * `loopMessages` são mutados em placee (mesma referência de array/Map) e não precisam de
 * threading de retorno, mesmo padrão de `sentArtifacts`/`trackArtifact` em ARCH-020/S24.
 */
type DeliveryGuardResult =
    | { earlyReturn: true; result: string | ProcessedResult }
    | { earlyReturn: false; stepCount: number };

/**
 * Queries whose answers are likely to be volatile even when in memory.
 * Applied generically — not specific to any entity, currency, or domain.
 * Pattern: financial prices, weather, news, legal changes, real-time data.
 */
// Bug real encontrado em auditoria (07/07/2026): faltavam parênteses ao redor da alternação —
// "\bprice|X|Y|coin\b" só aplica "\b" na PRIMEIRA ("price") e na ÚLTIMA ("coin") alternativa
// (precedência de "|" é mais baixa que concatenação). Todas as alternativas do meio (preço,
// cotação, clima, weather, notícia, news, legisla, law, stock, bolsa, dólar, câmbio, cripto,
// crypto, token) casavam como SUBSTRING LIVRE, sem boundary nenhum — ex: "clima" casava dentro
// de "aclimatar" ("Precisamos nos aclimatar ao novo horário" tratado como consulta volátil sem
// nenhuma relação com clima/tempo). "bolsa" continua ambíguo mesmo depois do fix (bolsa de
// valores vs. bolsa/mochila) — isso é ambiguidade de sentido da palavra, não bug de boundary;
// nenhuma correção de regex resolve, ficaria fora de escopo aqui.
const VOLATILE_QUERY_PATTERN =
    /\b(price|preço|cotação|cotaçao|clima|weather|notícia|noticia|news|legisla|law|stock|bolsa|dólar|dolar|câmbio|cambio|cripto|crypto|token|coin)\b/i;

/**
 * Compute how much the agent should trust its retrieved memory for this query.
 *
 * High  — explicit user preference or stable personal fact (always authoritative).
 * Medium — entity-matched context or non-volatile domain (use + optionally validate).
 * Low   — volatile domain (price, weather, news) even if memory exists.
 * None  — no memory selected.
 *
 * NOTE: 'high' confidence for preferences in volatile domains is downgraded to
 * 'medium' because the preference identifies the subject but the value (price)
 * still needs external validation.
 */
export function computeMemoryConfidence(
    metadata: import('../loop/ContextBuilder').ContextBuildMetadata | null,
    query: string,
): MemoryConfidence {
    if (!metadata || !metadata.memoryUsed || metadata.selectedCount === 0) return 'none';

    const queryIsVolatile = VOLATILE_QUERY_PATTERN.test(query);

    // Explicit user preference — highest trust, but downgraded if volatile domain
    if (metadata.hasHighRelevancePreference) {
        return queryIsVolatile ? 'medium' : 'high';
    }

    // Entity match in volatile domain → low confidence (stale financial/news data)
    if (queryIsVolatile) return 'low';

    // Entity match in stable domain → medium (may be outdated, but not inherently volatile)
    if (metadata.hasEntityMatch) return 'medium';

    return 'low';
}

export interface TurnState {
    cognitiveWorkspace: CognitiveWorkspace;
    lastToolExecution: { toolName: string; toolOutput: string; intent: string; category: string } | null;
    pendingObserverFeedback: string[];
}

export class AgentLoop {
    private providerFactory: ProviderFactory;
    private memory: MemoryManager;
    private tools: Map<string, ToolExecutor> = new Map();
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
    private turnStartTimes: Map<string, number> = new Map();
    private readonly TURN_STALE_MS = 7 * 60 * 1000; // 7 min — matches MAX_TIMEOUT (420s) + small buffer
    private activeTurnStates: Map<string, TurnState> = new Map();

    private getTurnState(conversationId?: string): TurnState {
        const key = conversationId || 'legacy-fallback-id';
        let state = this.activeTurnStates.get(key);
        if (!state) {
            state = {
                cognitiveWorkspace: new CognitiveWorkspace(),
                lastToolExecution: null,
                pendingObserverFeedback: [],
            };
            this.activeTurnStates.set(key, state);
        }
        return state;
    }

    private classificationMemory: ClassificationMemory;
    private decisionMemory: DecisionMemory;
    private protocolParser: ProtocolParser;
    private observer: ObserverValidator;
    private goalOrchestrator: import('./GoalOrchestrator').GoalOrchestrator | null = null;
    private reflectionMemory: ReflectionMemory;
    private fsmHistoryStore: FSMHistoryStore;
    private readonly proactiveRecovery = new ProactiveRecovery();
    private workflowEngine?: WorkflowEngine;
    /** Callback pós-turno: disparado fire-and-forget após cada resposta entregue. */
    private postTurnCallback: (() => void) | null = null;

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
        this.intentRouter = new UnifiedIntentRouter(this.skillLearner, providerFactory);
        this.stateManager = new AgentStateManager(memory);
        this.protocolParser = new ProtocolParser();
        this.classificationMemory = classificationMemory as ClassificationMemory;
        this.decisionMemory = decisionMemory as DecisionMemory;
        this.observer = new ObserverValidator(providerFactory);
        this.reflectionMemory = new ReflectionMemory(memory);
        this.fsmHistoryStore = new FSMHistoryStore(memory);
    }

    // ── Accessors ──────────────────────────────────────────────────────────────

    /**
     * Expõe a instância de ReflectionMemory já construída internamente — reaproveitada por
     * `MemoryCurator` (Sprint 0.6, Front D) para agendar `prune()` no mesmo ciclo que já poda
     * `agent_traces`/`procedural_executions`, sem criar uma segunda instância desnecessária.
     */
    getReflectionMemory(): ReflectionMemory {
        return this.reflectionMemory;
    }

    /** Injeta o WorkflowEngine para habilitar callbacks estruturados (Fase 2). */
    setWorkflowEngine(engine: WorkflowEngine): void {
        this.workflowEngine = engine;
        log.info('[WF] WorkflowEngine registered in AgentLoop');
    }

    /** Registra o GoalOrchestrator para que updateConfig possa propagar modelos internos em runtime. */
    setGoalOrchestrator(go: import('./GoalOrchestrator').GoalOrchestrator): void {
        this.goalOrchestrator = go;
    }

    /**
     * Registra callback pós-turno (fire-and-forget).
     * Disparado via setImmediate após cada resposta entregue.
     * Usado para enfileirar tarefas de cognição background (reflection, curation).
     */
    setPostTurnCallback(cb: () => void): void {
        this.postTurnCallback = cb;
    }

    /** Expõe o modelo de classificação configurado no profileRegistry. */
    getClassifierModel(): string {
        return this.profileRegistry.getClassifierModel();
    }

    /**
     * Aplica mudanças de configuração em runtime (chamado pelo dashboard após POST /api/config).
     * Reconstrói o ModelProfileRegistry quando modelRouter muda para que novos modelos/providers
     * entrem em vigor sem restart.
     */
    updateConfig(cfg: { maxIterations?: number; systemPrompt?: string; modelRouter?: Record<string, string | undefined> }): void {
        if (cfg.modelRouter) {
            this.profileRegistry = new ModelProfileRegistry(
                cfg.modelRouter as Partial<import('./ModelProfileRegistry').ProfileRegistryConfig> & Record<string, string>,
                this.providerFactory
            );
            log.info('[updateConfig] ModelProfileRegistry reloaded with updated modelRouter');

            const { observerModel, plannerModel, riskModel, classifierModel } = cfg.modelRouter;
            if (observerModel) {
                this.observer.setModel(observerModel);
                log.info(`[updateConfig] ObserverValidator model → ${observerModel}`);
            }
            if (plannerModel || riskModel || classifierModel) {
                this.goalOrchestrator?.updateInternalModels(plannerModel, riskModel, classifierModel);
                log.info(`[updateConfig] internal models → planner=${plannerModel ?? '—'} risk=${riskModel ?? '—'} classifier=${classifierModel ?? '—'}`);
            }
        }
    }

    /**
     * Returns true for exec_command calls that are read-only and safe to run without user authorization.
     * Multi-line scripts and any command with destructive patterns always require authorization.
     */
    private isSafeExecCommand(toolName: string, args: Record<string, unknown>): boolean {
        if (toolName !== 'exec_command') return false;
        const cmd = String(args.command || '').trim();

        // Multi-line scripts (more than 3 non-empty lines) always require auth
        const nonEmptyLines = cmd.split('\n').filter(l => l.trim().length > 0);
        if (nonEmptyLines.length > 3) return false;

        // Destructive patterns always require auth
        if (/\brm\s+-r|\brm\s+--?\w*r|\bmkfs\b|drop\s+table|truncate\s+table/i.test(cmd)) return false;

        // File writes always require auth — strip null redirects first, then check
        const cmdWithoutNullRedirects = cmd.replace(/\d*>>?\/dev\/null/g, '');
        if (/(?<![0-9a-z&|])>>?\s*\/(?!dev\/null)/i.test(cmdWithoutNullRedirects)) return false;

        // Pipe into destructive commands always requires auth
        if (/\|\s*(rm|dd|mkfs|shred)\b/.test(cmd)) return false;

        // Version/help checks are always read-only regardless of the tool name
        if (/^\S+\s+(--version|-v|-V|--help|-h)$/.test(cmd)) return true;

        const SAFE_COMMANDS = new Set([
            'ls', 'cat', 'find', 'pwd', 'echo', 'which', 'command', 'type',
            'head', 'tail', 'grep', 'wc', 'stat', 'file', 'node', 'npm', 'npx',
            'env', 'printenv', 'df', 'du', 'ps', 'uname', 'hostname',
            'id', 'whoami', 'date', 'uptime', 'lsb_release', 'readlink',
            'marp',  // file-format converter, not destructive
        ]);

        // Split on && or ; to get individual sub-commands, then strip leading `cd /path` parts.
        // A command like `cd /some/dir && ls` is safe if all non-cd parts are safe.
        const subCmds = cmd.split(/&&|;/).map(s => s.trim()).filter(Boolean);
        const nonCdSubCmds = subCmds.filter(s => !/^cd(\s|$)/.test(s));
        if (nonCdSubCmds.length === 0) return false; // pure `cd` offers no read value
        return nonCdSubCmds.every(sub => {
            const word = sub.split(/[\s;|&]/)[0].replace(/^\.\//, '');
            // Also check basename so full-path invocations like /usr/local/bin/marp are safe
            const basename = word.includes('/') ? word.split('/').pop()! : word;
            return SAFE_COMMANDS.has(word) || SAFE_COMMANDS.has(basename);
        });
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

    // ── Helpers para WorkflowEngine ───────────────────────────────────────────

    private inferWorkflowName(intent: string, toolName: string): string {
        const i = (intent || '').toLowerCase();
        if (i.includes('pdf') || i.includes('document') || i.includes('resumo')) return 'document_processing';
        if (i.includes('edit') || i.includes('file') || i.includes('write')) return 'file_operation';
        if (i.includes('search') || i.includes('web') || i.includes('busca')) return 'web_research';
        if (i.includes('schedule') || i.includes('agenda')) return 'scheduling';
        return toolName.replace(/_/g, '-');
    }

    private extractResourceNames(args: Record<string, unknown>): string[] {
        const resources: string[] = [];
        for (const val of Object.values(args)) {
            if (typeof val === 'string') {
                // Captura nomes de arquivo (qualquer string com extensão ou path)
                if (/\.\w{2,5}$/.test(val) || val.includes('/') || val.includes('\\')) {
                    const name = val.split(/[/\\]/).pop() || val;
                    if (name) resources.push(name.slice(0, 80));
                }
            }
        }
        return resources.slice(0, 3);
    }

    private findSafeAlternatives(dangerousTool: string): string[] {
        const alternatives: Record<string, string[]> = {
            'exec_command': ['read_document', 'list_workspace', 'web_navigate'],
            'ssh_exec':     ['read_document', 'web_navigate'],
            'write_file':   ['read_tool'],
            'edit_file':    ['read_tool'],
        };
        return alternatives[dangerousTool] ?? [];
    }

    // ── Síntese pós-workflow (chamado pelo AgentController) ───────────────────

    /**
     * Recebe o resultado de um passo de workflow já executado pelo WorkflowEngine
     * e produz uma resposta final para o usuário com uma única chamada compacta ao LLM.
     *
     * NÃO usa histórico episódico. NÃO replica o contexto completo da conversa.
     * O ContinuationContext carrega tudo que o LLM precisa (~200 tokens).
     */
    async resumeFromWorkflow(
        conversationId: string,
        result: WorkflowStepResult
    ): Promise<string> {
        const ctx = result.continuationCtx;
        const isApproved = result.decision === 'approved';

        log.info(`[WF] resume conv=${conversationId} decision=${result.decision} success=${result.success} workflow=${ctx.workflow}`);
        // Limpa o safety net legado — o WorkflowEngine já resolveu, authManager não deve disparar
        this.authManager.removePending(conversationId);

        const systemInstruction = isApproved
            ? result.success
                ? `Você executou com sucesso o passo "${ctx.step}" do workflow "${ctx.workflow}".`
                : `O passo "${ctx.step}" falhou no workflow "${ctx.workflow}".`
            : `O usuário recusou a ferramenta "${ctx.step}" no workflow "${ctx.workflow}".`;

        const contextPayload: Record<string, unknown> = {
            workflow: ctx.workflow,
            step: ctx.step,
            userGoal: ctx.userGoal,
            ...(ctx.activeResources?.length ? { activeResources: ctx.activeResources } : {}),
        };

        if (isApproved && result.success) {
            contextPayload.toolResult = result.output.slice(0, 4000);
        } else if (isApproved && !result.success) {
            contextPayload.error = result.error ?? 'Erro desconhecido';
            if (ctx.alternativeTools?.length) contextPayload.alternativeTools = ctx.alternativeTools;
        } else {
            // Rejeitado
            contextPayload.rejectedTool = ctx.step;
            if (ctx.alternativeTools?.length) contextPayload.alternativeTools = ctx.alternativeTools;
        }

        // extractMissingExecutable() distingue evidência real de executável ausente (spawn
        // ENOENT, "command not found", cmd.exe "is not recognized"...) de ENOENT de arquivo/
        // diretório (ex: input ausente) — a regex anterior aqui usava "ENOENT" bare, então um
        // erro de arquivo/diretório ausente virava "a ferramenta não está instalada" de forma
        // enganosa para o usuário.
        const isCommandNotFound = extractMissingExecutable((result.error ?? '') + (result.output ?? '')) !== null;
        const failTask = isCommandNotFound
            ? `O passo "${ctx.step}" falhou porque a ferramenta não está instalada no sistema. ` +
              `O objetivo do usuário é: "${ctx.userGoal}". ` +
              `Explique o problema ao usuário e oriente-o a instalar a ferramenta necessária ` +
              `(por exemplo, via "npm install -g <ferramenta>", "pip install", ou gerenciador de pacotes). ` +
              `Depois instrua-o a repetir o pedido para que a instalação seja feita automaticamente.`
            : `O passo "${ctx.step}" falhou no workflow "${ctx.workflow}". ` +
              `O objetivo do usuário é: "${ctx.userGoal}". Informe claramente a falha e sugira como prosseguir.`;

        const task = isApproved
            ? result.success
                ? 'O comando foi executado e o resultado está no campo "toolResult" do JSON acima. Apresente esse conteúdo ao usuário de forma clara e útil. Não peça ao usuário para colar ou informar a saída — você já a possui no campo toolResult.'
                : failTask
            : 'Informe que a ação foi cancelada e ofereça uma alternativa sem precisar de autorização, se disponível.';

        // Merge into a single system message — some Ollama models discard all but the first
        // system message, causing the toolResult JSON to be invisible to the LLM.
        const messages: LLMMessage[] = [
            {
                role: 'system',
                content: `${systemInstruction}\n\nContexto:\n\`\`\`json\n${JSON.stringify(contextPayload, null, 2)}\n\`\`\``,
            },
            { role: 'user', content: task },
        ];

        const chatProfile = this.profileRegistry.getProfileByCategory('chat');
        const profile = chatProfile
            ?? this.profileRegistry.getProfileByCategory('light')
            ?? this.profileRegistry.getProfileByCategory('execution');
        if (!chatProfile && profile) {
            log.warn(`[WF] [PROFILE-FALLBACK] requested=chat fallback=${profile.category ?? 'unknown'}`);
        }
        if (!profile) {
            log.error('[WF] [PROFILE-FALLBACK] requested=chat fallback=none — no model profile available');
            const status = contextPayload.decision === 'rejected' ? 'Ação cancelada.' : 'Ação executada com sucesso.';
            return `✅ ${status}`;
        }

        try {
            const response = await this.callLLMWithFallback(
                messages, [], profile, new AbortController().signal
            );
            const text = extractFinalText(response, null);
            log.info(`[WF] synthesis done conv=${conversationId} chars=${text.length}`);
            return text || '⚠️ Sem resposta do modelo.';
        } catch (err) {
            log.error('[WF] resumeFromWorkflow LLM error:', err);
            return '⚠️ Erro ao gerar resposta.';
        }
    }

    private async tryValidateTool(
        userText: string,
        intent: string,
        category: IntentCategory,
        toolName: string,
        toolOutput: string,
        messages: LLMMessage[],
        traceId?: string,
        conversationId?: string,
        finalResponse?: string
    ): Promise<void> {
        try {
            // AbortController tied to the 60 s timeout.
            // Passing the signal to observer.validate() ensures the underlying provider
            // call is cancelled when the timeout fires, preventing the orphaned
            // "approved=false" log that appeared after the turn had already ended.
            const abortCtrl = new AbortController();
            const timeoutHandle = setTimeout(() => abortCtrl.abort(), 60_000);

            let validation: import('./ObserverValidator').ValidationResult;
            try {
                validation = await this.observer.validate(
                    userText, intent, toolName, toolOutput, finalResponse ?? '', abortCtrl.signal
                );
            } finally {
                clearTimeout(timeoutHandle);
            }

            if (abortCtrl.signal.aborted) {
                log.info(`[OBSERVER] Validation timed out for ${toolName}`);
                return;
            }
            log.info(`[OBSERVER] ${validation.validationSkipped ? '⚠️ skipped' : validation.approved ? '✅' : '❌'} ${toolName} confidence=${validation.confidence} reason="${validation.reason}"`);

            // S2b: outcome binário — ValidationResult só tem {approved, reason, confidence},
            // sem sinal de parcial. category vem de intentDecision.category nos 2 call sites
            // (já IntentCategory tipado) — fonte real, não inferida. failureType ausente:
            // ValidationResult não tem taxonomia de tipo de falha, não vou inventar uma.
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
                outcome: validation.approved ? 'success' : 'failure',
                category,
            });

            if (!validation.approved && validation.confidence >= 0.6) {
                // Push existing in-flight hint (immediate, arrives at next LLM call via messages[]).
                if (validation.suggestedFix) {
                    messages.push({
                        role: 'system',
                        content: `[OBSERVER] A ferramenta "${toolName}" pode não ter atendido à solicitação. ${validation.reason} — Sugestão: ${validation.suggestedFix}`
                    });
                }
                // Also store structured feedback in the per-turn queue so the next while
                // iteration can flush it even if this async call completes later than expected.
                this.getTurnState(conversationId).pendingObserverFeedback.push(
                    `[OBSERVER] "${toolName}" — ${validation.reason} (confidence=${validation.confidence.toFixed(2)})`
                );
            }
        } catch (err) {
            log.warn(`[${this.ts()}] [VALIDATE] tryValidateTool failed (non-fatal): ${errorMessage(err)}`);
        }
    }

    // ── Response Commit Phase (Q4 pré-envio) ─────────────────────────────────

    /**
     * Valida a resposta final ANTES do envio ao usuário — fase Q4 do modelo espiral.
     * Usa Promise.race com timeout de 5 s para não bloquear UX indefinidamente.
     * Se bloqueada, substitui por resposta corrigida e registra na ReflectionMemory.
     */
    /**
     * Returns true when the response text contains success claim patterns.
     * Used to detect the LLM fabricating a positive outcome after tool failures.
     */
    private static looksLikeFalseSuccess(text: string): boolean {
        return /✅\s*\w*(gerado|enviado|criado|concluído|salvo|feito|pronto|completo|limpo|corrigido)/i.test(text)
            || /\b(gerado|enviado|criado|salvo|concluído|limpo|corrigido)\s+(com\s+sucesso|e enviado|e salvo)/i.test(text)
            || /\b(arquivo|slides?|documento|relat[oó]rio)\s+(foi\s+)?(gerado|enviado|criado|salvo|limpo|corrigido)/i.test(text)
            || /\b(foi\s+)?(enviado|gerado|salvo|limpo|corrigido)\s+(com\s+sucesso|para\s+voc[eê])/i.test(text)
            || /\bsem\s+(duplicatas?|capas?\s+duplicadas?)\b/i.test(text)
            || /\b\d+\s+slides?\s*[,.]?\s*(1|uma)\s+capa/i.test(text);
    }

    /**
     * Returns true when the response promises an ongoing/imminent action ("estou gerando
     * agora", "te envio em instantes") with high confidence — used only when NO tool ran
     * this turn (see commitResponse below), where such phrasing can only be a fabricated
     * promise, never a legitimate progress update. Kept deliberately narrow (present-
     * continuous + "agora", or an explicit imminent-delivery promise) to avoid false
     * positives on responses that legitimately describe a plan without claiming it's already
     * in motion. If this needs extending again, follow shared/contentStubPatterns.ts's
     * precedent and consolidate into a shared module instead of growing this list ad hoc.
     */
    private static looksLikePendingActionPromise(text: string): boolean {
        return /\best(ou|á)\s+\w+ndo\b[^.!?]{0,40}\b(agora|neste\s+momento)\b/i.test(text)
            || /\b(te\s+|lhe\s+)?(envio|mando)\s+em\s+(instantes|breve|seguida)\b/i.test(text)
            // \b não funciona de forma confiável após vogais acentuadas em regex JS (á não é
            // \w) — usa negative lookahead por letra em vez de \b no limite direito.
            || /\bj[aá]\s+j[aá](?![a-zà-ÿ])/i.test(text);
    }

    /**
     * Mesma classe semântica de looksLikePendingActionPromise (promessa de ação futura em vez
     * de entrega), mas construção gramatical diferente: futuro perifrástico "vou X" em vez de
     * gerúndio "estou X-ndo". Evidência real (11/07/2026): "Vou buscar informações atualizadas
     * agora." — web_search já tinha rodado com sucesso, mas a resposta não usou o resultado.
     * Deliberadamente SEPARADO de looksLikePendingActionPromise em vez de fundido nela: "vou
     * verbo... agora" é mais propenso a falso positivo em respostas legítimas que mencionam
     * "agora" mais adiante sem prometer ação nenhuma (ex: "vou explicar como isso funciona:
     * primeiro, agora observe que..."). Por isso só é usado no guard de commitResponse() que já
     * exige commit.valid===false (rejeição independente do ObserverValidator) como segundo
     * sinal — nunca sozinho, ao contrário de looksLikePendingActionPromise no caminho `!last`.
     */
    private static looksLikeUnfulfilledFuturePromise(text: string): boolean {
        return /\bvou\s+\w+[^.!?]{0,40}\b(agora|neste\s+momento)\b/i.test(text);
    }

    private async commitResponse(
        response: string,
        userText: string,
        traceId: string,
        conversationId: string,
        signal?: AbortSignal,
        toolFailureCount = 0,
    ): Promise<string> {
        const last = this.getTurnState(conversationId).lastToolExecution;

        // When no tool succeeded but tools did run and fail, the LLM may fabricate a success
        // message. The normal validator is skipped when last===null, so we guard here first.
        if (!last && toolFailureCount > 0 && AgentLoop.looksLikeFalseSuccess(response)) {
            log.warn(
                `[${this.ts()}] [COMMIT] False-success detected after ${toolFailureCount} tool failure(s) — blocking response`
            );
            return 'Não consegui completar a tarefa: ocorreram erros durante a execução. Por favor, reformule o pedido ou tente novamente.';
        }

        // Read-only turn with write-claim: last tool was 'read' (no write/edit/exec happened)
        // but the response claims the file was modified. This happens when ratio_limit fires
        // after a large-file read and the model hallucinates the completion of a write operation.
        // EXCEPTION: When the user asked for analysis/review/evaluation, success claims like
        // "a aula está completa" or "30 slides prontos" are legitimate outcomes of a read-only
        // turn — the read IS the goal, not a prelude to write.
        if (last && last.toolName === 'read' && toolFailureCount === 0 && AgentLoop.looksLikeFalseSuccess(response)) {
            const isAnalysisIntent = ANALYSIS_INTENT_PATTERN.test(userText);
            if (!isAnalysisIntent) {
                log.warn(
                    `[${this.ts()}] [COMMIT] False-success after read-only turn (last=read, no write) — blocking hallucinated write claim`
                );
                return 'Li o arquivo mas não consegui concluir a modificação: o contexto ficou grande demais para processar read+write no mesmo turno. ' +
                       'Tente novamente — o sistema usará exec_command com Python para modificar o arquivo diretamente, sem carregar o conteúdo inteiro no contexto.';
            }
            // Analysis intent: success claims are legitimate read outcomes, not hallucinated writes
            log.info(`[${this.ts()}] [COMMIT] Read-only success-claim allowed for analysis intent: "${userText.slice(0, 80)}"`);
        }

        // Zero tools ran this turn, but the response promises an ongoing/imminent action
        // ("estou gerando agora e te envio em instantes"). The comment below ("no tool ran →
        // no hallucination risk") assumed silence is always safe when nothing executed — false
        // here: no tool means no background job either, so the promised delivery will never
        // arrive and the user is left waiting indefinitely. Evidence: 2026-07-05 audit log,
        // correlationId 321b0506 — user said "ok" (confirming a plan described in the previous
        // turn), UnifiedIntentRouter deterministically routed it to category=confirmation with
        // ALL tools available (not withheld), the model produced a `final_answer` with
        // toolCalls=0 claiming "Estou gerando o arquivo agora e te envio em instantes!", and
        // the turn ended there — nothing was ever generated or sent.
        if (!last && AgentLoop.looksLikePendingActionPromise(response)) {
            log.warn(`[${this.ts()}] [COMMIT] Pending-action promise with zero tool calls this turn — blocking response`);
            return 'Falei que ia fazer algo agora, mas nenhuma ferramenta foi executada neste turno — nada foi gerado ou enviado ainda. ' +
                   'Pode pedir de novo? Desta vez a ação será executada de verdade antes de eu responder.';
        }

        if (!last) return response; // sem tool executada → sem risco de alucinação de ação

        try {
            const COMMIT_TIMEOUT_MS = 12_000;

            // S3c — Opção B (conexão conservadora, com escopo limitado e documentado):
            // ResponseCommit não tem failureType confiável (ver S2c) — não dá pra saber
            // SE este tool tende a "alegar sucesso falso" vs. "responder truncado" vs.
            // "prometer e não executar". O que É real e confiável é tool_used (sempre
            // populado corretamente, inclusive em dados anteriores à S2). Por isso a
            // conexão aqui é só por ferramenta, e só OBSERVACIONAL: não altera
            // commit.valid/commit.blocked nem entra no prompt do LLM — apenas correlaciona
            // e loga, para medir antes de decidir se vale conectar de forma mais ativa
            // numa Sprint futura ("conectar corretamente, depois medir").
            const toolHistoryHint = this.reflectionMemory.findToolFailures(last.toolName);
            if (toolHistoryHint) {
                log.info(`[${this.ts()}] [COMMIT] Padrão histórico conhecido para tool=${last.toolName} (correlação observacional, não altera a decisão de commit): ${toolHistoryHint.split('\n')[1] ?? ''}`);
            }

            const commit = await Promise.race<ResponseCommit>([
                this.observer.validateResponseCommit(
                    userText,
                    last.toolName,
                    last.toolOutput,
                    response,
                    signal,
                ),
                new Promise<ResponseCommit>(resolve =>
                    setTimeout(
                        () => resolve({ valid: true, hallucinationRisk: 0, blocked: false, validationMs: COMMIT_TIMEOUT_MS }),
                        COMMIT_TIMEOUT_MS,
                    )
                ),
            ]);

            log.info(`[${this.ts()}] [COMMIT] Q4 tool=${last.toolName} valid=${commit.valid} risk=${commit.hallucinationRisk.toFixed(2)} blocked=${commit.blocked} ms=${commit.validationMs}`);

            // Registrar na ReflectionMemory independente do resultado
            // S2c (ponto de maior risco, feito por último): outcome binário direto de
            // commit.valid — ResponseCommit não distingue partial. failureType e category
            // DELIBERADAMENTE ausentes: ResponseCommit = {valid, hallucinationRisk,
            // blocked, blockReason?} não tem taxonomia (não dá pra distinguir "alegação
            // falsa de sucesso" de "artefato não produzido" de "resposta truncada" etc. —
            // ver relatório da S2). Mapear blockReason para um BlockerKind por conveniência
            // seria inventar classificação sem base real — reason (texto livre, já rico)
            // e pattern legado continuam preservando essa informação sem distorção.
            this.reflectionMemory.record({
                traceId,
                conversationId,
                userInput: userText,
                intent: last.intent,
                toolUsed: last.toolName,
                toolOutput: last.toolOutput.slice(0, 1000),
                finalResponse: response.slice(0, 500),
                approved: commit.valid,
                reason: commit.blockReason ?? (commit.valid ? 'Q4 commit aprovado' : 'Q4 commit: risco de alucinação'),
                confidence: commit.valid ? 1 - commit.hallucinationRisk : commit.hallucinationRisk,
                pattern: commit.blocked ? 'hallucination_blocked_pre_commit' : 'commit_approved',
                outcome: commit.valid ? 'success' : 'failure',
            });

            if (commit.blocked && commit.correctedResponse) {
                log.warn(`[${this.ts()}] [COMMIT] Hallucination bloqueada (risk=${commit.hallucinationRisk.toFixed(2)}): ${commit.blockReason}`);
                return commit.correctedResponse;
            }

            // Mesma classe de bug do guard `!last` acima (pending-action promise), mas para o
            // caso em que a tool JÁ RODOU E TEVE SUCESSO — a resposta final ainda assim só
            // repete a promessa em vez de usar o resultado que já está em last.toolOutput.
            // ObserverValidator.validateResponseCommit() deliberadamente nunca bloqueia
            // rejeições vindas do caminho de qualidade via LLM (ver comentário lá: evita
            // esconder a interação do usuário e loops de erro) — então commit.valid=false
            // sozinho não basta pra corrigir aqui. Combinamos com o mesmo padrão regex já
            // testado (looksLikePendingActionPromise) como segundo sinal independente, pra não
            // bloquear por causa só de uma rejeição de qualidade genérica do LLM.
            // Evidência real (11/07/2026, Telegram): web_search rodou 2x com sucesso, resposta
            // final foi só "Vou buscar informações atualizadas agora." — ObserverValidator
            // aprovou=false confidence=0.95, mas nada impediu o envio; o usuário respondeu
            // "Conseguiu fazer isso?" sem nunca receber os dados já coletados.
            if (!commit.valid && (AgentLoop.looksLikePendingActionPromise(response) || AgentLoop.looksLikeUnfulfilledFuturePromise(response))) {
                log.warn(`[${this.ts()}] [COMMIT] Pending-action promise apesar de "${last.toolName}" já ter sucesso — bloqueando resposta`);
                return `Já executei "${last.toolName}" e tenho os resultados, mas minha resposta anterior não os apresentou — só repetiu que ia buscar. Pode perguntar de novo? Desta vez uso os dados já coletados.`;
            }

            return response;
        } catch (err) {
            log.warn(`[${this.ts()}] [COMMIT] commitResponse falhou (non-fatal): ${errorMessage(err)}`);
            return response; // fail-safe: nunca bloquear por erro interno de validação
        }
    }

    // ── Entry points ───────────────────────────────────────────────────────────

    public cancel(conversationId: string): void {
        const ctrl = this.activeTurns.get(conversationId);
        if (ctrl) {
            ctrl.abort();
            this.activeTurns.delete(conversationId);
            this.turnStartTimes.delete(conversationId);
            log.info(`[${this.ts()}] [AGENT-FSM] Turn cancelled: ${conversationId}`);
        }
    }

    public async process(conversationId: string, userText: string, _userId?: string, context?: ChannelContext): Promise<string | ProcessedResult> {
        return this.run(conversationId, userText, conversationId, context);
    }

    /**
     * Returns the skill context relevant to the given query text.
     * Used by GoalOrchestrator to inject skill instructions into GoalPlanner.
     *
     * Combina dois mecanismos (Sprint 3.7A):
     *   1. Trigger match (original — mantido sem alteração)
     *   2. Capability match (novo — usa tags normalizadas via SkillDiscovery)
     */
    public getSkillContextForQuery(query: string): string {
        const { discoverSkills } = require('../skills/SkillDiscovery') as typeof import('../skills/SkillDiscovery');
        const skills = this.skillLoader.loadAll();
        const discovery = discoverSkills(skills, query);

        // Log para observabilidade
        if (discovery.byTrigger.length > 0) {
            for (const s of discovery.byTrigger) {
                log.info(`[SKILL-MATCH] query="${query.slice(0, 60)}" skill=${s.name} matched_by=trigger`);
            }
        }
        if (discovery.byCapability.length > 0) {
            for (const m of discovery.byCapability) {
                log.info(
                    `[SKILL-MATCH] query="${query.slice(0, 60)}"` +
                    ` skill=${m.skillName}` +
                    ` matched_by=tag` +
                    ` score=${m.score.toFixed(2)}` +
                    ` terms=${m.matchedTerms.join(',')}`
                );
            }
        }

        if (discovery.all.length === 0) return '';
        return discovery.all
            .map(s => `### SKILL: ${s.name}\n${s.globalContent || s.content}`)
            .join('\n\n');
    }

    public async run(conversationId: string, userText: string, userId?: string, context?: ChannelContext): Promise<string | ProcessedResult> {
        this.activeTurnStates.set(conversationId, {
            cognitiveWorkspace: new CognitiveWorkspace(),
            lastToolExecution: null,
            pendingObserverFeedback: [],
        });
        try {
            return await this.runWithTools(conversationId, userText, 0, userId, context);
        } finally {
            // Cleanup: sempre executado mesmo em erros
            this.activeTurnStates.delete(conversationId);
            this.activeTurns.delete(conversationId);
            this.turnStartTimes.delete(conversationId);
            // Dispara cognição pós-turno (fire-and-forget — nunca bloqueia resposta)
            if (this.postTurnCallback) {
                setImmediate(this.postTurnCallback);
            }
        }
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

    // ── Tool filtering by intent category ────────────────────────────────────

    // Tools always sent regardless of category (agent always needs these for delivery + memory).
    private static readonly CORE_TOOLS = new Set([
        'write', 'read', 'edit',
        'send_document', 'send_audio', 'send_image',
        'memory_search', 'memory_write',
    ]);

    // Extra tools per intent category — combined with CORE_TOOLS.
    private static readonly CATEGORY_TOOLS: Record<string, string[]> = {
        creation:         ['exec_command', 'web_search', 'web_navigate', 'memory_admin'],
        information:      ['web_search', 'web_navigate', 'weather', 'memory_admin'],
        data_analysis:    ['web_search', 'web_navigate', 'crypto_analysis', 'exec_command', 'memory_admin'],
        system_operation: ['exec_command', 'ssh_exec', 'server_config', 'memory_admin'],
        memory_operation: ['memory_admin', 'crypto_analysis', 'web_search'],
        audio:            ['exec_command'],
        vision:           ['web_navigate', 'web_search'],
        conversation:     [],
        destructive:      ['exec_command', 'ssh_exec', 'server_config'],
    };

    private buildToolDefs(intent: IntentDecision): ToolDefinition[] {
        // Preferred tools from skill + category tools (never exclude domain-appropriate tools).
        // Skills can add specific preferred tools, but category tools are always merged in so
        // the model still has access to domain-relevant tools (e.g. crypto_analysis for data_analysis).
        if (intent.preferredTools && intent.preferredTools.length > 0) {
            const categoryExtras = AgentLoop.CATEGORY_TOOLS[intent.category] ?? [];
            const allowed = new Set([...AgentLoop.CORE_TOOLS, ...intent.preferredTools, ...categoryExtras]);
            const filtered = Array.from(this.tools.values()).filter(t => allowed.has(t.name));
            log.info(`[TOOLS] Skill-preferred filter: ${filtered.map(t => t.name).join(', ')} (${filtered.length}/${this.tools.size})`);
            return filtered.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));
        }

        const extras = AgentLoop.CATEGORY_TOOLS[intent.category] ?? null;
        // Unknown category or low confidence → send all tools to be safe.
        if (extras === null || intent.confidence < 0.65) {
            log.info(`[TOOLS] Sending all tools (category=${intent.category}, confidence=${intent.confidence})`);
            return Array.from(this.tools.values()).map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));
        }

        const allowed = new Set([...AgentLoop.CORE_TOOLS, ...extras]);
        const filtered = Array.from(this.tools.values()).filter(t => allowed.has(t.name));
        log.info(`[TOOLS] Category filter '${intent.category}': ${filtered.map(t => t.name).join(', ')} (${filtered.length}/${this.tools.size})`);
        return filtered.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));
    }

    // ── LLM call with fallback ─────────────────────────────────────────────────

    private async callLLMWithFallback(messages: LLMMessage[], toolDefs: ToolDefinition[], chatProfile: ModelProfile, signal?: AbortSignal): Promise<LLMResult> {
        const { timeoutMs, approxTokens, totalChars, scaleMs } = computeDynamicTimeout(messages);
        log.info(`[${this.ts()}] [TIMEOUT] Dynamic: ${Math.round(timeoutMs / 1000)}s (tokens≈${approxTokens}, chars=${totalChars}, scale=${Math.round(scaleMs / 1000)}s, clamp=[45-420]s)`);

        const callStart = Date.now();
        try {
            const result = await generationQueue.add(
                () => this.providerFactory.chatWithFallback(messages, toolDefs, chatProfile?.provider, timeoutMs, signal, chatProfile?.model),
                { priority: TaskPriority.INTERACTIVE }
            );

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

    // ── Tool-first fast path ────────────────────────────────────────────────────

    /**
     * Searches memory for a saved weather city preference without embeddings.
     * Looks for nodes containing weather-related terms and extracts the city using regex.
     * Returns null if nothing is found.
     */
    private lookupWeatherCityPreference(): string | null {
        // City name pattern: one or more capitalized words optionally followed by ", State/UF"
        const CITY = '([A-ZÁÀÃÂÉÊÍÓÕÔÚÇ][\\wáàãâéêíóõôúçÁÀÃÂÉÊÍÓÕÔÚÇ]+(?:\\s+[A-ZÁÀÃÂÉÊÍÓÕÔÚÇ][\\wáàãâéêíóõôúçÁÀÃÂÉÊÍÓÕÔÚÇ]+)*(?:,\\s*(?:[A-ZÁÀÃÂÉÊÍÓÕÔÚÇ][\\wáàãâéêíóõôúçÁÀÃÂÉÊÍÓÕÔÚÇ]+|[A-Z]{2}))?)';
        const PATTERNS = [
            // Explicit preferences: "considerar [sempre] <Cidade> como cidade/localidade"
            new RegExp(`considerar\\s+(?:sempre\\s+)?${CITY}\\s+como\\s+(?:cidade|localidade)`, 'i'),
            // "usar <Cidade> como cidade/localidade/padrão"
            new RegExp(`usar\\s+${CITY}\\s+como\\s+(?:cidade|localidade|padr[aã]o)`, 'i'),
            // "cidade padrão[: é] <Cidade>"
            new RegExp(`cidade\\s+(?:padr[aã]o|default)[:\\sé]+${CITY}`, 'i'),
            // "<Cidade> como cidade padrão/localidade padrão"
            new RegExp(`${CITY}\\s+como\\s+(?:cidade|localidade)\\s+padr[aã]o`, 'i'),
            // Natural phrasing: "clima de <Cidade>" / "previsão de <Cidade>" / "tempo em <Cidade>"
            new RegExp(`(?:clima|previsão|tempo|temperatura)\\s+(?:de|em|para)\\s+${CITY}`, 'i'),
            // "minha cidade [é|fica em|é] <Cidade>"
            new RegExp(`minha\\s+cidade\\s+(?:[eé]|fica\\s+em|padr[aã]o\\s+[eé])\\s+${CITY}`, 'i'),
            // Preference node saved format: "Preferência: sempre <Cidade> para clima"
            new RegExp(`${CITY}\\s+(?:para|no)\\s+(?:clima|previsão|tempo)`, 'i'),
            // "falar sobre <Cidade>" / "sobre o clima de <Cidade>"
            new RegExp(`falar\\s+(?:sobre\\s+(?:o\\s+)?(?:clima\\s+(?:de|em)\\s+)?)?${CITY}`, 'i'),
        ];
        try {
            const nodes = this.memory.keywordSearch(
                ['previsão do tempo', 'clima', 'cidade padrão', 'localidade padrão', 'considerar', 'usar', 'sempre', 'minha cidade'],
                12
            );
            for (const node of nodes) {
                if (!node.content) continue;
                for (const pat of PATTERNS) {
                    const m = node.content.match(pat);
                    if (m?.[1]) return m[1].trim();
                }
            }
            // Broader fallback: extract any proper-noun sequence adjacent to a climate keyword.
            // Covers natural-language saves like "Preferência: Não gosto de clima de outra cidade, sempre X"
            const CITY_ADJACENT = new RegExp(
                `(?:clima|previsão|tempo|chuva|temperatura|sempre|previsao)[^.]{0,30}${CITY}|` +
                `${CITY}[^.]{0,20}(?:clima|previsão|tempo|chuva|temperatura|previsao)`,
                'i'
            );
            for (const node of nodes) {
                if (!node.content) continue;
                const m = node.content.match(CITY_ADJACENT);
                if (m) {
                    const city = m[1] ?? m[2];
                    if (city) return city.trim();
                }
            }
        } catch (err) {
            log.warn(`[${this.ts()}] [DEFAULT-CITY] Memory search failed (non-fatal): ${errorMessage(err)}`);
        }
        return null;
    }

    /**
     * Executes a tool directly without spinning up the LLM cognition loop.
     * Returns the tool output as the final response, or null to fall back to the full loop.
     *
     * FSM transitions on success: TOOL_REQUESTED → EXECUTING_TOOL → TOOL_COMPLETED → FINAL_READY.
     * On failure (tool not found or tool error): returns null with no FSM changes so the
     * cognition loop can continue normally from THINKING state.
     */
    // Tools whose output is already a user-ready string — fast path allowed.
    // All other tools produce raw data and require LLM synthesis.
    private static readonly FAST_PATH_ALLOWED = new Set(['weather', 'send_audio', 'send_document', 'send_image', 'schedule']);

    private async toolFirstFastPath(
        conversationId: string,
        userText: string,
        intentDecision: IntentDecision,
        channelContext: ChannelContext | undefined,
        trace: ExecutionTrace,
        move: (event: AgentFSMEvent, meta?: Record<string, unknown>) => void
    ): Promise<string | ProcessedResult | null> {
        const toolName = intentDecision.toolName!;

        if (!AgentLoop.FAST_PATH_ALLOWED.has(toolName)) {
            log.info(`[FAST-PATH] Tool "${toolName}" requires LLM synthesis — falling back to cognition loop`);
            return null;
        }

        const tool = this.tools.get(toolName);

        if (!tool) {
            log.warn(`[FAST-PATH] Tool "${toolName}" not registered — falling back`);
            return null;
        }

        let toolArgs: Record<string, unknown> = intentDecision.toolParams ?? {};

        // Weather-specific: if no city was extracted from the query, look up the
        // user's preferred city from memory before giving up and falling back.
        if (toolName === 'weather' && !toolArgs.city) {
            const preferredCity = this.lookupWeatherCityPreference();
            if (preferredCity) {
                toolArgs = { ...toolArgs, city: preferredCity };
                log.info(`[${this.ts()}] [FAST-PATH] Weather city from memory: "${preferredCity}"`);
            } else {
                log.info(`[${this.ts()}] [FAST-PATH] No city in intent or memory — falling back to cognition loop`);
                return null;
            }
        }

        log.info(`[${this.ts()}] [FAST-PATH] Tool-first "${toolName}" args=${JSON.stringify(toolArgs)}`);

        if (typeof (tool as unknown as ContextAwareTool).setContext === 'function' && channelContext) {
            (tool as unknown as ContextAwareTool).setContext(channelContext.chatId || '', channelContext.channel);
        }

        const toolResult = await tool.execute(toolArgs);

        if (!toolResult.success) {
            log.warn(`[FAST-PATH] Tool "${toolName}" failed (${toolResult.error}) — falling back`);
            return null; // FSM stays in THINKING — loop proceeds normally
        }

        log.info(`[${this.ts()}] [FAST-PATH] Tool "${toolName}" succeeded (${toolResult.output.length} chars)`);

        // Commit FSM transitions only after confirmed success
        move('TOOL_REQUESTED', { step: 1, tool: toolName, mode: 'fast_path' });
        move('TOOL_COMPLETED', { step: 1, tool: toolName, success: true });

        traceManager.addStep(trace, 'tool_call',   { tool: toolName, input: toolArgs });
        traceManager.addStep(trace, 'tool_result', { tool: toolName, success: true, output: toolResult.output });
        this.decisionMemory.recordFromLoop(toolName, true, 0, userText);
        this.skillLearner.recordPattern(userText, toolName, true, 0);

        this.getTurnState(conversationId).lastToolExecution = {
            toolName,
            toolOutput: toolResult.output,
            intent: intentDecision.intent,
            category: intentDecision.category,
        };

        const finalText = toolResult.output;

        move('FINAL_READY', { step: 1, reason: 'tool_fast_path' });
        traceManager.completeTrace(trace, 'completed', finalText);
        this.persistTrace(trace, 1, 'completed', finalText, channelContext);

        return { text: await this.commitResponse(finalText, userText, trace.id, conversationId) };
    }

    /**
     * ARCH-019 (S25, Incremento 1): "Structured turn diagnostics" extraído de `runWithTools()`
     * sem mudar lógica. Bloco puramente de LEITURA — computa métricas derivadas do turno
     * inteiro e emite um único log `[TURN-DIAGNOSTICS]`; não muta nenhum estado do chamador,
     * por isso não precisa de nenhum valor de retorno (diferente dos handlers extraídos em
     * ARCH-020/S24, que sempre precisavam devolver estado atualizado).
     */
    private logTurnDiagnostics(input: TurnDiagnosticsInput): void {
        const {
            stepCount, executionMode, maxSteps, decisionCtx, getContextChars, initialContextChars,
            toolTypeCallCount, groupCallCount, cycleHistory, maxSameToolCalls: MAX_SAME_TOOL_CALLS,
            totalToolCalls, consecutiveToolFailures, toolFailureCount, totalThinkingChars,
            guardsTriggered, dedupAbortTool, memoryFirstInjected, toolFailureHintInjected,
            toolFailureHintFirstStep, toolSuccessHintInjected, toolSuccessHintFirstStep,
            observerFeedbackInjected, observerFeedbackFirstStep, reflectionHintInjected,
            intentCategory,
        } = input;

        const finalContextChars = getContextChars();
        const finalGrowthRatio  = initialContextChars > 0 ? finalContextChars / initialContextChars : 1;
        const maxSameToolCalls  = toolTypeCallCount.size > 0 ? Math.max(...toolTypeCallCount.values()) : 0;
        const maxGroupCalls     = groupCallCount.size   > 0 ? Math.max(...groupCallCount.values())    : 0;

        // ── Sprint 3.5A: Decision Impact Telemetry ──────────────────────────
        const externalSearchTools = new Set(['web_search', 'web_navigate', 'weather']);

        // eligible = condition was met; injected = hint was actually pushed to loopMessages
        // eligible=true + injected=false → regression/bug
        const memoryFirstEligible = decisionCtx.requiresMemoryFirst;

        // compliance: was the hint followed? (derived from cycleHistory with step info)
        const step1Entries       = cycleHistory.filter(h => h.step === 1);
        const step1HasMemory     = step1Entries.some(h => h.tool === 'memory_search');
        const step1HasExternal   = step1Entries.some(h => externalSearchTools.has(h.tool));
        const memoryFirstFollowed =
            memoryFirstInjected && step1HasMemory && !step1HasExternal;

        // toolFailureHint: followed if the failing tool wasn't called again after hint step
        const toolFailureHintFollowed = toolFailureHintInjected && toolFailureHintFirstStep !== null
            ? !cycleHistory.some(h => h.step > toolFailureHintFirstStep! && h.status === 'error')
            : false;

        // toolSuccessHint: followed if the flagged tool wasn't called again after hint step
        const toolSuccessHintFollowed = toolSuccessHintInjected && toolSuccessHintFirstStep !== null
            ? (() => {
                const hintedTool = Object.entries(decisionCtx.toolSuccessRates)
                    .find(([, rate]) => rate < 0.4)?.[0];
                return hintedTool
                    ? !cycleHistory.some(h => h.step > toolSuccessHintFirstStep! && h.tool === hintedTool)
                    : false;
            })()
            : false;

        // observerFeedback: followed if no new tool failures in steps after hint
        const observerFeedbackFollowed = observerFeedbackInjected && observerFeedbackFirstStep !== null
            ? !cycleHistory.some(h => h.step > observerFeedbackFirstStep! && h.status === 'error')
            : false;

        // reflectionHint (ReflectionMemory.buildContextHint): injetado uma única vez, antes
        // do step 1 — não tem "primeiro passo" dinâmico como os outros hints. "Seguido" aqui
        // significa: o turno não terminou em erro de ferramenta nem em bloqueio de commit
        // (mesma semântica de observerFeedbackFollowed, adaptada por não ter step de início).
        // S0.5 (roadmap de aprendizado): esta é a peça que faltava no mecanismo de
        // hint-compliance já existente — sem isso não há como medir se o conhecimento
        // recuperado da ReflectionMemory está de fato influenciando o turno.
        const reflectionHintFollowed = reflectionHintInjected
            ? !cycleHistory.some(h => h.status === 'error')
            : false;

        // hint compliance rate across all injected hints this turn
        let totalHintsInjected = 0;
        let totalHintsFollowed = 0;
        if (memoryFirstEligible)        { totalHintsInjected++; if (memoryFirstFollowed)    totalHintsFollowed++; }
        if (toolFailureHintInjected)    { totalHintsInjected++; if (toolFailureHintFollowed) totalHintsFollowed++; }
        if (toolSuccessHintInjected)    { totalHintsInjected++; if (toolSuccessHintFollowed) totalHintsFollowed++; }
        if (observerFeedbackInjected)   { totalHintsInjected++; if (observerFeedbackFollowed) totalHintsFollowed++; }
        if (reflectionHintInjected)     { totalHintsInjected++; if (reflectionHintFollowed)   totalHintsFollowed++; }
        const hintComplianceRate = totalHintsInjected > 0
            ? (totalHintsFollowed / totalHintsInjected).toFixed(2)
            : 'n/a';

        // knowledge-decision gap: memory available but LLM used only external tools
        const externalCallCount = cycleHistory.filter(h => externalSearchTools.has(h.tool)).length;
        const memoryCallCount   = cycleHistory.filter(h => h.tool === 'memory_search').length;
        const knowledgeDecisionGap =
            decisionCtx.memoryConfidence !== 'none' &&
            externalCallCount > 2 &&
            memoryCallCount === 0;

        // shadow enforcement candidates (would-have-triggered, no behavior change)
        // tool cooldown shadow: first tool with 2 consecutive failures in cycleHistory
        let shadowCooldown: { triggered: boolean; tool?: string; failures?: number; step?: number } = { triggered: false };
        {
            let consecutive = 0;
            let lastTool    = '';
            for (const entry of cycleHistory) {
                if (entry.status === 'error' && entry.tool === lastTool) {
                    consecutive++;
                    if (consecutive >= 2 && !shadowCooldown.triggered) {
                        shadowCooldown = { triggered: true, tool: entry.tool, failures: consecutive + 1, step: entry.step };
                    }
                } else {
                    consecutive = entry.status === 'error' ? 1 : 0;
                    lastTool    = entry.tool;
                }
            }
        }

        // dedup abort shadow: first tool that would reach MAX_SAME_TOOL_CALLS
        const shadowDedupTool = [...toolTypeCallCount.entries()]
            .find(([, count]) => count >= MAX_SAME_TOOL_CALLS);
        const shadowDedup = shadowDedupTool
            ? { triggered: true, tool: shadowDedupTool[0], calls: shadowDedupTool[1] }
            : { triggered: false };

        // memory-first shadow: enforcement would have changed step-1 behavior
        const shadowMemoryFirst = memoryFirstEligible && !memoryFirstFollowed;

        log.info(
            `[${this.ts()}] [TURN-DIAGNOSTICS]\n` +
            `  steps=${stepCount} mode=${executionMode} budget=${maxSteps}\n` +
            `  memory:\n` +
            `    confidence=${decisionCtx.memoryConfidence}\n` +
            `    requiresMemoryFirst=${decisionCtx.requiresMemoryFirst}\n` +
            `    hasHighRelevancePref=${decisionCtx.hasHighRelevancePreference}\n` +
            `  context:\n` +
            `    initialChars=${initialContextChars}\n` +
            `    currentChars=${finalContextChars}\n` +
            `    growthRatio=${finalGrowthRatio.toFixed(2)}\n` +
            `  tools:\n` +
            `    totalCalls=${totalToolCalls}\n` +
            `    sameToolCalls=${maxSameToolCalls}\n` +
            `    sameGroupCalls=${maxGroupCalls}\n` +
            `    consecutiveFailures=${consecutiveToolFailures}\n` +
            `    totalFailures=${toolFailureCount}\n` +
            `  reasoning:\n` +
            `    chars=${totalThinkingChars}\n` +
            `  safety:\n` +
            `    guardsTriggered=${guardsTriggered}\n` +
            `    abortReason=${dedupAbortTool || 'none'}\n` +
            `  decisionImpact:\n` +
            `    memoryFirst: eligible=${memoryFirstEligible} injected=${memoryFirstInjected} followed=${memoryFirstFollowed}\n` +
            `    toolFailureHint: injected=${toolFailureHintInjected} step=${toolFailureHintFirstStep ?? '-'} followed=${toolFailureHintFollowed}\n` +
            `    toolSuccessHint: injected=${toolSuccessHintInjected} step=${toolSuccessHintFirstStep ?? '-'} followed=${toolSuccessHintFollowed}\n` +
            `    observerFeedback: injected=${observerFeedbackInjected} step=${observerFeedbackFirstStep ?? '-'} followed=${observerFeedbackFollowed}\n` +
            `    reflectionHint: injected=${reflectionHintInjected} category=${intentCategory} followed=${reflectionHintFollowed}\n` +
            `    hintComplianceRate=${hintComplianceRate} (${totalHintsFollowed}/${totalHintsInjected})\n` +
            `    knowledgeDecisionGap=${knowledgeDecisionGap} (ext=${externalCallCount} mem=${memoryCallCount})\n` +
            `  shadowEnforcement:\n` +
            `    cooldown: triggered=${shadowCooldown.triggered}${shadowCooldown.triggered ? ` tool=${shadowCooldown.tool} failures=${shadowCooldown.failures} atStep=${shadowCooldown.step}` : ''}\n` +
            `    dedup: triggered=${shadowDedup.triggered}${shadowDedup.triggered ? ` tool=${shadowDedup.tool} calls=${shadowDedup.calls}` : ''}\n` +
            `    memoryFirst: wouldHaveChanged=${shadowMemoryFirst}`
        );
    }

    /**
     * ARCH-019 (S25, Incremento 2): "Delivery guard" extraído de `runWithTools()` sem mudar
     * lógica — se um arquivo foi escrito mas nunca enviado (ou um script gerado mas nunca
     * executado), reentra num mini-loop de LLM+tool-calling com uma instrução de entrega antes
     * de cair na síntese pós-loop. `stepCount` é o único valor mutável que precisa ser
     * devolvido explicitamente (o guard tem seu próprio laço `while` interno que o incrementa);
     * `cycleHistory`/`loopMessages` são mutados nas MESMAS referências recebidas, sem threading.
     */
    private async runDeliveryGuardPhase(
        conversationId: string,
        cycleHistory: Array<{ step: number; tool: string; input: string; status: string }>,
        loopMessages: LLMMessage[],
        toolDefs: ToolDefinition[],
        chatProfile: ModelProfile,
        turnSignal: AbortSignal,
        trace: ExecutionTrace,
        channelContext: ChannelContext | undefined,
        usedToolInputs: Set<string>,
        maxSteps: number,
        stepCount: number,
        move: (event: AgentFSMEvent, meta?: Record<string, unknown>) => void,
    ): Promise<DeliveryGuardResult> {
        // Delivery guard: if a file was written but never sent, the user received nothing.
        // Re-enter the loop with a delivery instruction before synthesis.
        //
        // Scripts (.py/.sh) are a special case: they aren't the deliverable, they're the
        // MEANS to produce one (e.g. a python-pptx generator script). Telling the agent to
        // `send_document` an unexecuted generator script is wrong — the file the user asked
        // for doesn't exist yet. Evidence: 2026-07-02 audit log, goal "gerar slides editáveis" —
        // the agent wrote tmp/gerar_slides_senac.py and workspace/gen_pptx.py in two separate
        // turns, never executed either, and both times ran out of step budget before this guard
        // could even fire (see the `stepCount < maxSteps` note below).
        // DELIVERABLE_EXTENSIONS agora vive em planning/inferExpectedExtensions.ts (ARCH-026) —
        // mesmo módulo que já centraliza SOURCE_SCRIPT_EXTENSIONS logo abaixo.
        // Fonte única com RiskAnalyzer/resolveArtifactPathFromEvidence (Sprint F2, revisão de
        // código pós-piloto R1-R7) — antes esta lista local (['.py','.sh']) e o blocklist
        // SOURCE_SCRIPT_EXTENSIONS de inferExpectedExtensions.ts divergiam sobre '.js'/'.ts',
        // fazendo o mesmo tipo de arquivo ser tratado como deliverable aqui e como script-fonte
        // (nunca deliverable) lá.
        const EXECUTABLE_SCRIPT_EXTENSIONS = [...SOURCE_SCRIPT_EXTENSIONS];
        const wroteFile = cycleHistory.some(h => h.tool === 'write' && h.status === 'success');
        // 'deferred' conta como já tratado: um send_document adiado para pós-validação (FIX E
        // acima) já está registrado para entrega via channelContext — sem isso, este guard
        // reinjetaria "[ENTREGA PENDENTE]" por cima de um arquivo que já ia ser entregue.
        const sentFile = cycleHistory.some(h => (h.tool === 'send_document' || h.tool === 'send_audio' || h.tool === 'send_image') && (h.status === 'success' || h.status === 'deferred'));
        const writtenFilePaths = cycleHistory
            .filter(h => h.tool === 'write' && h.status === 'success')
            .map(h => { try { return (JSON.parse(h.input) as Record<string, string>).path || ''; } catch { return ''; } });
        // A .html write has a PENDING (unresolved) conversion when cycleHistory proves an
        // explicit `html2pdf.sh` attempt against that exact path failed, with no later success
        // for the same path. Evidence: 2026-07-05 audit log, goal "capacidades_newclaw.html" —
        // `bash scripts/html2pdf.sh` failed (WSL/bash unavailable on this Windows machine),
        // SAFETY-GUARD capped further exec_command retries, and this guard's own message then
        // told the agent it could send the raw `.html` directly — delivering an unconverted
        // slide deck the active skill (html-pdf-converter) explicitly forbids sending via
        // send_document. Scoped ONLY to html2pdf.sh (the one conversion command the skill
        // mandates), matched against the exact write path (not just basename) since that string
        // is already available from the same `write` call args — no new tracking added.
        const htmlConversionPending = (htmlPath: string): boolean => {
            const isHtml2pdfAttempt = (h: { tool: string; input: string }) =>
                h.tool === 'exec_command' && h.input.includes(htmlPath) && h.input.toLowerCase().includes('html2pdf');
            let lastFailureIdx = -1;
            for (let i = 0; i < cycleHistory.length; i++) {
                if (isHtml2pdfAttempt(cycleHistory[i]) && cycleHistory[i].status === 'error') lastFailureIdx = i;
            }
            if (lastFailureIdx === -1) return false;
            return !cycleHistory.some((h, idx) => idx > lastFailureIdx && isHtml2pdfAttempt(h) && h.status === 'success');
        };
        const writtenPaths = writtenFilePaths
            .filter(p => DELIVERABLE_EXTENSIONS.some(ext => p.toLowerCase().endsWith(ext)))
            .filter(p => !(p.toLowerCase().endsWith('.html') && htmlConversionPending(p)));
        const writtenScriptPaths = writtenFilePaths
            .filter(p => EXECUTABLE_SCRIPT_EXTENSIONS.some(ext => p.toLowerCase().endsWith(ext)));
        // A script counts as "already executed" if any successful exec_command in this cycle
        // referenced its basename — good enough since exec_command commands are shell strings,
        // not structured paths.
        const executedScriptPaths = writtenScriptPaths.filter(scriptPath => {
            const base = scriptPath.split(/[\\/]/).pop() || scriptPath;
            return cycleHistory.some(h => h.tool === 'exec_command' && h.status === 'success' && h.input.includes(base));
        });
        const unexecutedScriptPaths = writtenScriptPaths.filter(p => !executedScriptPaths.includes(p));

        // Extra budget dedicated to this guard: the failure this fixes is precisely "ran out
        // of steps right after writing the file" (direct/conversation mode caps maxSteps=4),
        // so gating re-entry on remaining main-loop budget defeats the guard's own purpose.
        const deliveryStepCap = maxSteps + 2;

        if (wroteFile && !sentFile && (writtenPaths.length > 0 || unexecutedScriptPaths.length > 0) && stepCount < deliveryStepCap) {
            const guardMessage = unexecutedScriptPaths.length > 0
                ? `[EXECUÇÃO PENDENTE] Você criou o script ${unexecutedScriptPaths.join(', ')} mas ainda NÃO o executou. O usuário ainda NÃO recebeu nenhum arquivo. USE exec_command para RODAR o script AGORA (ex: python <script> ou bash <script>), depois entregue o arquivo gerado por ele com send_document. A tarefa SÓ está concluída quando o arquivo final for gerado e enviado.`
                : `[ENTREGA PENDENTE] Você criou o(s) arquivo(s): ${writtenPaths.join(', ')}\nO usuário ainda NÃO recebeu nada. USE send_document para entregar AGORA. Para arquivos .html, você pode enviá-los diretamente com send_document ou converter para PDF com bash scripts/html2pdf.sh antes. A tarefa SÓ está concluída quando o arquivo for enviado.`;
            log.info(`[${this.ts()}] [DELIVERY-GUARD] ${unexecutedScriptPaths.length > 0 ? 'Script created but not executed' : 'File created but not sent'} — re-entering loop: ${(unexecutedScriptPaths.length > 0 ? unexecutedScriptPaths : writtenPaths).join(', ')}`);
            loopMessages.push({ role: 'system', content: guardMessage });
            // Re-enter the main loop for delivery/execution steps
            while (stepCount < deliveryStepCap) {
                stepCount++;
                log.info(`[${this.ts()}] [DELIVERY] Step ${stepCount}...`);
                move('LLM_REQUEST', { step: stepCount, phase: 'delivery' });
                const deliveryResponse = await this.callLLMWithFallback(loopMessages, toolDefs, chatProfile, turnSignal);
                move('LLM_RESPONSE', { step: stepCount, phase: 'delivery', status: deliveryResponse.status });

                if (deliveryResponse.status === 'cancelled') { move('CANCEL', { step: stepCount }); this.activeTurns.delete(conversationId); return { earlyReturn: true, result: { text: 'Operação cancelada.' } }; }
                if (deliveryResponse.status === 'timeout' || deliveryResponse.status === 'error') break;

                loopMessages.push({ role: 'assistant', content: deliveryResponse.content, toolCalls: deliveryResponse.toolCalls });

                if (deliveryResponse.toolCalls && deliveryResponse.toolCalls.length > 0) {
                    for (const toolCall of deliveryResponse.toolCalls) {
                        const tool = this.tools.get(toolCall.name);
                        if (!tool) continue;
                        if (typeof (tool as unknown as ContextAwareTool).setContext === 'function' && channelContext) {
                            (tool as unknown as ContextAwareTool).setContext(channelContext.chatId || '', channelContext.channel);
                        }
                        move('TOOL_REQUESTED', { step: stepCount, tool: toolCall.name, mode: 'delivery' });
                        const result = await this.proactiveRecovery.execute(toolCall.name, toolCall.arguments, (n) => this.tools.get(n) as import('./ProactiveRecovery').ToolExecutorLike | undefined, usedToolInputs, turnSignal);
                        if (result.recovered && result.recoveryNote) {
                            const kind = result.mutationKind ?? 'arg_mutation';
                            log.info(`[MUTATION] tool_mutation:\n  tool: ${result.originalToolName ?? toolCall.name}\n  kind: ${kind}\n  original: ${JSON.stringify(result.originalArgs ?? {})}\n  modified: ${JSON.stringify(result.finalArgs)}`);
                        }
                        log.info(`[${this.ts()}] [DELIVERY] ${result.finalToolName} -> ${result.result.success ? '✓' : '✗'}`);
                        loopMessages.push({ role: 'tool', content: result.result.output, tool_call_id: toolCall.id });
                        cycleHistory.push({ step: stepCount, tool: toolCall.name, input: JSON.stringify(toolCall.arguments), status: result.result.success ? 'success' : 'error' });
                        // Mesmo fix dos caminhos nativo/json_action acima — este é justamente o
                        // caminho que despacha send_audio/send_document/send_image/send_video
                        // (terminalTools abaixo), então é o mais relevante dos três para o gap
                        // real observado (texto do send_audio nunca persistido em lugar nenhum).
                        if (result.result.success && channelContext) {
                            await this.sessionContext?.getSessionManager().recordToolCall(
                                { channel: channelContext.channel, userId: channelContext.userId ?? conversationId },
                                result.finalToolName,
                                JSON.stringify(result.finalArgs ?? toolCall.arguments),
                            ).catch(() => {});
                        }
                        const terminalTools = ['send_audio', 'send_document', 'send_image', 'send_video'];
                        if (terminalTools.includes(toolCall.name) && result.result.success) {
                            move('TOOL_COMPLETED', { step: stepCount, tool: toolCall.name, success: true });
                            move('FINAL_READY', { step: stepCount, tool: toolCall.name, terminal: true });
                            // CORREÇÃO 1: notifica GoalExecutionLoop que DELIVERY-GUARD entregou
                            // um artefato diretamente. Sem este callback, sentArtifacts nunca é
                            // atualizado e o SemanticValidator pode marcar outcome=partial antes
                            // que S10 execute, causando reentregas redundantes nos ciclos seguintes.
                            if (toolCall.name === 'send_document') {
                                const finalArgs = (result.finalArgs ?? toolCall.arguments) as Record<string, unknown>;
                                const deliveredPath = String(finalArgs['file_path'] ?? finalArgs['path'] ?? '');
                                if (deliveredPath) channelContext?.deliveryTracking?.onArtifactDelivered?.(deliveredPath);
                            }
                            traceManager.completeTrace(trace, 'completed', result.result.output);
                            this.persistTrace(trace, stepCount, 'completed', result.result.output, channelContext);
                            return { earlyReturn: true, result: result.result.output };
                        }
                        move('TOOL_COMPLETED', { step: stepCount, tool: toolCall.name, success: result.result.success });
                    }
                    continue;
                }
                // No tool calls — model gave up, break out
                break;
            }
        }
        return { earlyReturn: false, stepCount };
    }

    // ── Core execution loop ────────────────────────────────────────────────────

    private async runWithTools(conversationId: string, userText: string, iteration: number, _userId?: string, channelContext?: ChannelContext): Promise<string | ProcessedResult> {
        const correlationId = channelContext?.correlationId;
        const turnLog = correlationId ? log.child({ cid: correlationId.slice(0, 8) }) : log;

        // Guard: reject truly concurrent turns for the same user.
        // Also clears stale entries left by unexpected throws (try/finally in run() covers new cases,
        // but this handles any pre-existing stuck state without requiring a server restart).
        if (iteration === 0 && this.activeTurns.has(conversationId)) {
            const startedAt = this.turnStartTimes.get(conversationId) || 0;
            if (Date.now() - startedAt > this.TURN_STALE_MS) {
                log.warn(`[${this.ts()}] [AGENT] Stale turn cleared for ${conversationId} (started ${Math.round((Date.now() - startedAt) / 1000)}s ago)`);
                this.activeTurns.get(conversationId)?.abort();
                this.activeTurns.delete(conversationId);
                this.turnStartTimes.delete(conversationId);
            } else {
                log.warn(`[${this.ts()}] [AGENT] Concurrent turn rejected for ${conversationId}`);
                return 'Ainda estou processando sua mensagem anterior. Aguarde um momento.';
            }
        }

        turnLog.info('turn_start', `Cycle ${iteration + 1}`, { conversationId });

        // status: 'success' | 'error' (execução normal de tool, ver ~linha 1973/2299/2641) |
        // 'deferred' (send_document adiado para pós-validação — FIX E, ~linha 1835; conta como
        // já tratado para o DELIVERY-GUARD, ~linha 2564, mas nunca como um envio confirmado).
        const cycleHistory: Array<{ step: number; tool: string; input: string; status: string }> = [];
        let lastBestContent = '';
        let toolFailureCount = 0;
        const usedToolInputs = new Set<string>();
        const usedToolOutputs = new Map<string, string>(); // stores output of first successful call per inputKey
        // Track filenames confirmed absent from workspace so DEDUP can block path-variant retries
        const failedReadFilenames = new Set<string>();
        // Track binary filenames that failed with "cannot read as text" so retries are blocked early
        const binaryReadFilenames = new Set<string>();
        // Track how many times edit was called per file path to prevent append-loop corruption
        const editPathCount = new Map<string, number>();
        // Generic per-tool-type call counter: detects when the agent loops on the same tool
        // regardless of argument variation (which TOOL-DEDUP alone cannot catch).
        const toolTypeCallCount = new Map<string, number>();
        const MAX_SAME_TOOL_CALLS = 4;

        // TOOL_GROUP_REGISTRY is defined at module level — use it directly.
        const groupCallCount = new Map<string, number>();
        const MAX_GROUP_CALLS = 6;

        // Consecutive failure tracker: resets on any success so persistent errors
        // (not isolated failures) trigger the abort.
        let consecutiveToolFailures = 0;
        const MAX_CONSECUTIVE_TOOL_FAILURES = 3;

        // getContextChars is defined after loopMessages (below) to avoid TDZ.
        // Diagnostic counters — accumulated across the turn, emitted in TURN-DIAGNOSTICS.
        let guardsTriggered    = 0;
        let totalThinkingChars = 0;  // sum of response.thinking lengths across all steps
        let totalToolCalls     = 0;

        // Sprint 3.5A — Decision Impact Telemetry (shadow mode, no enforcement)
        // Tracks whether hints were injected, eligible, and followed by the LLM.
        // Computed at end-of-turn from cycleHistory + injection flags.
        let memoryFirstInjected          = false;
        let observerFeedbackInjected     = false;
        let toolFailureHintInjected      = false;
        let toolSuccessHintInjected      = false;
        let toolFailureHintFirstStep: number | null  = null;
        let toolSuccessHintFirstStep: number | null  = null;
        let observerFeedbackFirstStep: number | null = null;

        const turnAbort = new AbortController();
        this.activeTurns.set(conversationId, turnAbort);
        this.turnStartTimes.set(conversationId, Date.now());
        const turnSignal = turnAbort.signal;

        const trace = traceManager.startTrace(conversationId, userText, correlationId);
        const fsm = new AgentFSM();
        const move = (event: AgentFSMEvent, meta?: Record<string, unknown>) => {
            // Throws on invalid transition — callers must be in the correct FSM state.
            // The try/catch below (wrapping the rest of runWithTools) handles cleanup.
            const transition = fsm.transition(event, meta);
            log.info(`[${this.ts()}] [AGENT-FSM] ${transition.from} --${event}--> ${transition.to}`);
            traceManager.addStep(trace, 'fsm_transition', transition);
            this.fsmHistoryStore.record(transition, trace.id, conversationId);
        };

        try {
        move('START_TURN');

        // recentMessages (quando presente) permite ao UnifiedIntentRouter classificar mensagens
        // curtas/elípticas ("continue", "isso", "faça") considerando a conversa recente em vez
        // de classificar o texto isolado — ver RouterContext em UnifiedIntentRouter.ts e a
        // origem do dado em MessageBus.processMessageCore (microauditoria de continuidade
        // conversacional, 08/07/2026). Passos sintéticos sem conversa real (goal step, scheduler)
        // não preenchem este campo — não são elípticos, não precisam de contexto.
        const intentDecision: IntentDecision = await this.intentRouter.route(userText, {
            sessionId: conversationId,
            recentMessages: channelContext?.recentMessages,
        });

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

        // Fast-paths must not fire when there is a pending auth action — the auth check handles those turns.
        const hasPendingAuth = !!this.authManager.getPending(conversationId);

        // ── Text-based auth approval fallback ───────────────────────────────
        // When buttons fail to render (e.g. Telegram HTML parse errors), the user may type
        // "sim" or "cancelar" as plain text. Intercept these before the LLM loop to avoid
        // the model misinterpreting the response and generating a second auth request.
        if (hasPendingAuth && this.workflowEngine) {
            const trimmed = userText.trim();
            const isApproval = /^(sim|sim[,.]?\s*(pode|ok|autorizado|confirmado|faça|faz)|yes|ok|pode|autoriza)\b/i.test(trimmed) && trimmed.length < 40;
            const isRejection = /^(não|nao|n\b|cancel[ar]?|cancela|não\s+pode|nope|recusa)\b/i.test(trimmed) && trimmed.length < 40;

            if (isApproval || isRejection) {
                const pending = this.authManager.getPending(conversationId);
                if (pending?.txnId) {
                    const decision: AuthDecision = isApproval ? 'approved' : 'rejected';
                    log.info(`[${this.ts()}] [AUTH-TEXT] Text-based ${decision} for txn=${pending.txnId}`);
                    const wfResult = await this.workflowEngine.resume(
                        pending.txnId,
                        decision,
                        (name) => this.tools.get(name)
                    );
                    if (wfResult) {
                        move('FINAL_READY', { decision, txnId: pending.txnId });
                        return this.resumeFromWorkflow(conversationId, wfResult);
                    }
                }
            }
        }

        if (!hasPendingAuth && intentDecision.terminalAction && intentDecision.executionMode === 'direct' && intentDecision.category === 'greeting') {
            log.info(`[${this.ts()}] [FAST-PATH] Greeting detected — skipping LLM`);
            move('FINAL_READY');
            traceManager.completeTrace(trace, 'completed', 'Greeting fast path');
            const greetings = ['Olá! 👋', 'Oi! Como posso ajudar?', 'E aí! 🚀', 'Olá! Tô aqui! 💪', 'Opa! Bora? 😊'];
            return greetings[Math.floor(Math.random() * greetings.length)];
        }

        // ── Current-time fast path ──
        // Deterministic direct facts (date/time) — Node.js has the clock, no LLM needed.
        // Must check deterministicMatch explicitly — confirmation ('ok', 'sim') also matches direct+minimal+no-tools.
        if (
            !hasPendingAuth &&
            intentDecision.trace.deterministicMatch === 'current_time' &&
            intentDecision.source === 'deterministic' &&
            intentDecision.executionMode === 'direct'
        ) {
            const now = new Date();
            const timeStr = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
            const dateStr = now.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
            const reply = `🕐 ${timeStr} — ${dateStr}`;
            log.info(`[${this.ts()}] [FAST-PATH] current_time direct answer`);
            move('FINAL_READY');
            traceManager.completeTrace(trace, 'completed', reply);
            this.persistTrace(trace, 1, 'completed', reply, channelContext);
            return reply;
        }

        // ── Tool-first fast path ──
        // Deterministic tool intents (weather, etc.) bypass the cognition LLM loop entirely.
        // Falls back to the full loop when the tool is missing or returns an error.
        if (intentDecision.executionMode === 'tool' && intentDecision.toolName && intentDecision.confidence >= 0.85) {
            const fastResult = await this.toolFirstFastPath(conversationId, userText, intentDecision, channelContext, trace, move);
            if (fastResult !== null) {
                this.activeTurns.delete(conversationId);
                return fastResult;
            }
            log.info(`[${this.ts()}] [FAST-PATH] Tool fast path fell back to cognition loop`);
        }

        this.classificationMemory.store(userText, intentDecision.modelCategory, intentDecision.confidence);
        this.getTurnState(conversationId).lastToolExecution = null;

        let skillContext = intentDecision.skillContext ?? '';

        // S3c: "Que tipo de problema geral tende a acontecer neste tipo de pedido?"
        // findCategoryHints() agrega pela categoria inteira (não mais fragmentada por
        // ferramenta) e inclui fallback para registros legados com a categoria
        // smuggled em `pattern` — corrige o caso documentado no S16 (20 registros/30%
        // falha agregada retornando vazio por fragmentação de GROUP BY).
        const reflectionHint = this.reflectionMemory.findCategoryHints(intentDecision.category);
        const reflectionHintInjected = reflectionHint.length > 0;
        if (reflectionHint) {
            skillContext = skillContext ? `${skillContext}\n\n${reflectionHint}` : reflectionHint;
        }

        const manualSkills = this.skillLoader.loadAll();
        const matchedManual = manualSkills.filter(s =>
            s.triggers?.some(t => userText.toLowerCase().includes(t.toLowerCase()))
        );
        if (matchedManual.length > 0) {
            // Usa conteúdo completo (com seções TASK_ONLY) apenas quando a skill é a
            // tarefa primária do turno — alta confiança e intent diretamente relacionada.
            // Em correspondências parciais (trigger presente mas não é o objetivo principal),
            // injeta globalContent, que omite restrições de escopo de tarefa.
            const isPrimary = (skillName: string): boolean =>
                intentDecision.confidence >= 0.75 &&
                matchedManual.length === 1 &&
                (intentDecision.intent?.toLowerCase().includes(skillName.toLowerCase()) ||
                 intentDecision.skillContext?.toLowerCase().includes(skillName.toLowerCase()) ||
                 false);

            const manualBlock = matchedManual.map(s => {
                const content = isPrimary(s.name) ? s.content : s.globalContent;
                const scope = isPrimary(s.name) ? 'primary' : 'context';
                log.info(`[SKILL] ${s.name} injetado como "${scope}" (confidence=${intentDecision.confidence})`);
                return `### SKILL MANUAL: ${s.name}\n${content}`;
            }).join('\n\n');

            skillContext = skillContext ? `${skillContext}\n\n${manualBlock}` : manualBlock;
            log.info(`[SKILL] Injetando ${matchedManual.length} skill(s) manual(ais): ${matchedManual.map(s => s.name).join(', ')}`);
        }

        const toolDefs: ToolDefinition[] = this.buildToolDefs(intentDecision);

        const chatProfile = await this.profileRegistry.resolveProfile(userText);
        if (chatProfile && intentDecision.modelCategory && intentDecision.confidence >= 0.8) {
            const intentProfile = this.profileRegistry.getProfileByCategory(intentDecision.modelCategory);
            if (intentProfile) {
                chatProfile.model = intentProfile.model;
                chatProfile.category = intentProfile.category;
                log.info(`[${this.ts()}] [UNIFIED-ROUTER] Overriding model: ${intentDecision.modelCategory} → ${intentProfile.model}`);
            }
        }

        if (!this.sessionContext) {
            log.error('sessionContext not set — session pipeline is mandatory.');
            return '⚠️ Sessão indisponível no momento. Tente novamente em alguns instantes.';
        }

        // Derive context tier from intent: heavier categories need more context.
        type ContextTierType = import('../loop/ContextBuilder').ContextTier;
        const FULL_TIER_CATEGORIES = new Set(['creation', 'system_operation', 'data_analysis', 'destructive', 'memory_operation']);
        const NORMAL_TIER_CATEGORIES = new Set(['information', 'audio', 'vision']);
        const contextTier: ContextTierType =
            FULL_TIER_CATEGORIES.has(intentDecision.category) ? 'full' :
            NORMAL_TIER_CATEGORIES.has(intentDecision.category) ? 'normal' :
            'minimal';
        log.info(`[${this.ts()}] [CONTEXT-TIER] category=${intentDecision.category} → tier=${contextTier}`);

        // BUG REAL (log 2026-07-08, suplemento PowerPoint, sessão web:powerpoint-addin-...):
        // channel estava hardcoded como 'telegram' independente do canal real da conversa.
        // SessionManager chaveia sessões por `${channel}:${userId}` (SessionManager.ts:193) —
        // MessageBus grava com o channel real (ex.: "web"), mas aqui a leitura ia para uma
        // chave diferente ("telegram:<mesmoUserId>"), que nunca teve nada escrito. Resultado:
        // buildLLMMessages sempre via "0 recent msgs" para qualquer canal != telegram (web,
        // discord, signal, whatsapp) — o modelo perdia toda a transcript da conversa entre
        // turnos. Sintoma observado: usuário pediu para aplicar fundo branco, assistente
        // ofereceu rodar um script e perguntou "quer que eu execute agora?", usuário respondeu
        // "sim", e o modelo — sem ver a pergunta anterior no contexto — respondeu apenas
        // "Estou pronto. Como posso ajudar...", sem executar nada. Só passava despercebido no
        // Telegram porque lá o canal real também é 'telegram' (TelegramAdapter.ts), coincidindo
        // com o valor fixo. Fix: usar o canal real do turno, com 'telegram' como fallback apenas
        // quando não há ChannelContext (ex.: AgentController.ts scheduler, que já não propaga
        // contexto hoje).
        const sessionKey: SessionKey = { channel: channelContext?.channel ?? 'telegram', userId: conversationId };
        const { messages: sessionMessages } = await this.sessionContext.buildLLMMessages(
            sessionKey,
            buildMasterPrompt(chatProfile.category),
            userText,
            skillContext,
            contextTier,
            channelContext?.metadata
        );
        const loopMessages = sessionMessages;
        // Context growth guard helpers — defined here so loopMessages is in scope.
        const getContextChars = () => loopMessages.reduce((s, m) => s + (m.content?.length ?? 0), 0);
        const initialContextChars = getContextChars();

        // ── DecisionContext ─────────────────────────────────────────────────
        // Build from all cognitive signals available after session context is ready.
        // Influences loop behaviour via hints and budget adjustment — never via tool removal.
        this.getTurnState(conversationId).pendingObserverFeedback = [];   // reset per-turn
        const ctxMetadata = this.sessionContext.getContextBuilder().getLastBuildMetadata();
        const memConf = computeMemoryConfidence(ctxMetadata, userText);

        const toolStatsArr = this.decisionMemory.getToolStats();
        const toolSuccessRates: Record<string, number> = {};
        for (const s of toolStatsArr) toolSuccessRates[s.toolName] = s.successRate;

        const decisionCtx: DecisionContext = {
            memoryConfidence:           memConf,
            hasHighRelevancePreference: ctxMetadata?.hasHighRelevancePreference ?? false,
            requiresMemoryFirst:        intentDecision.requiresMemory && (memConf === 'high' || memConf === 'medium'),
            extendedStepBudget:         null, // resolved after maxSteps is computed
            toolSuccessRates,
        };

        // Adaptive step budget: ceiling scales with execution complexity.
        // Falls back to hybrid budget for unknown modes.
        const executionMode = intentDecision?.executionMode ?? 'hybrid';
        let maxSteps = STEP_BUDGETS[executionMode] ?? STEP_BUDGETS.hybrid ?? 6;

        // requiresPlanning → upgrade to planner budget when router signals explicit planning need
        // and the current mode hasn't already allocated enough steps.
        if (intentDecision.requiresPlanning && maxSteps < (STEP_BUDGETS.planner ?? 15)) {
            const upgraded = STEP_BUDGETS.planner ?? 15;
            log.info(`[${this.ts()}] [STEP-BUDGET] requiresPlanning=true → upgrading ${maxSteps} → ${upgraded}`);
            maxSteps = upgraded;
            decisionCtx.extendedStepBudget = upgraded;
        }

        let stepCount = 0;
        log.info(
            `[${this.ts()}] [STEP-BUDGET] mode=${executionMode} maxSteps=${maxSteps} ` +
            `memoryConfidence=${decisionCtx.memoryConfidence} requiresMemoryFirst=${decisionCtx.requiresMemoryFirst}`
        );
        let hasUsedNativeTools = false;      // true once any native tool call executes
        let consecutiveNonProgressSteps = 0; // non-JSON, no-tool responses in a row
        const blockedKeyCount = new Map<string, number>(); // tracks repeated block attempts per inputKey
        let dedupAbort = false; // set true when TOOL-DEDUP limit reached — exits while and falls to post-loop synthesis
        let dedupAbortTool = ''; // tracks which tool caused the dedup abort
        let contextGuardWriteExtensionUsed = false; // one-shot: see context_growth guard below

        // Pre-loop: inject non-blocking hints derived from DecisionContext.
        // These orient the LLM without restricting its tool access.
        if (decisionCtx.requiresMemoryFirst) {
            const isHighConf = decisionCtx.memoryConfidence === 'high';
            loopMessages.push({
                role: 'system',
                content: isHighConf
                    ? '[COGNIÇÃO] Memória pessoal com alta confiança disponível. Avalie o bloco de memória ANTES de usar ferramentas externas. Ferramentas externas devem ser usadas apenas se a memória não tiver resposta completa.'
                    : '[COGNIÇÃO] Memória pessoal disponível, mas pode estar desatualizada para este domínio. Consulte a memória primeiro e valide com fontes externas se necessário.',
            });
            memoryFirstInjected = true;
        }

        while (stepCount < maxSteps && !dedupAbort) {
            stepCount++;
            log.info(`[${this.ts()}] [COGNITION] Step ${stepCount}...`);

            // Flush observer feedback from previous step (accumulated asynchronously).
            const turnState = this.getTurnState(conversationId);
            if (turnState.pendingObserverFeedback.length > 0) {
                for (const fb of turnState.pendingObserverFeedback) {
                    loopMessages.push({ role: 'system', content: fb });
                }
                if (!observerFeedbackInjected) {
                    observerFeedbackInjected = true;
                    observerFeedbackFirstStep = stepCount;
                }
                turnState.pendingObserverFeedback = [];
            }

            // Context Growth Guard — two independent limits:
            //   ratio    : relative growth, only meaningful when baseline is large enough.
            //              A small initial context (fresh session) can triple in size after one
            //              legitimate file read; ratio alone would produce false positives.
            //   absolute : hard ceiling on chars added, regardless of baseline size.
            // MIN_RATIO_BASELINE prevents ratio guard from firing on short initial contexts.
            const MIN_RATIO_BASELINE = 4_000;   // chars; below this, only absolute limit applies
            const CONTEXT_RATIO_LIMIT = 2.5;    // 150 % growth cap (when baseline is substantial)
            const CONTEXT_ABSOLUTE_DELTA = 16_000; // ~4 000 tokens of added content
            const currentContextChars = getContextChars();
            const contextGrowthRatio = initialContextChars > 0 ? currentContextChars / initialContextChars : 1;
            const useRatioGuard = initialContextChars >= MIN_RATIO_BASELINE;
            const ratioTriggered = useRatioGuard && contextGrowthRatio > CONTEXT_RATIO_LIMIT;
            const absoluteTriggered = currentContextChars > initialContextChars + CONTEXT_ABSOLUTE_DELTA;
            if ((ratioTriggered || absoluteTriggered) && stepCount > 1 && !dedupAbort) {
                const triggerReason = ratioTriggered ? 'ratio_limit' : 'absolute_limit';
                const triggerValue  = ratioTriggered ? contextGrowthRatio : (currentContextChars - initialContextChars);
                const threshold     = ratioTriggered ? CONTEXT_RATIO_LIMIT : CONTEXT_ABSOLUTE_DELTA;
                log.warn(
                    `[${this.ts()}] [SAFETY-GUARD] type=context_growth reason=${triggerReason} ` +
                    `value=${triggerValue.toFixed(2)} threshold=${threshold} ` +
                    `initial=${initialContextChars} current=${currentContextChars}`
                );
                // Context-aware abort message: when the last tool was 'read', the agent loaded
                // a file but performed no write/edit. Prevent the model from claiming write success.
                const lastToolInCycle = cycleHistory.length > 0
                    ? cycleHistory[cycleHistory.length - 1].tool
                    : null;
                // 'exec_command' deliberately excluded here: it's also the tool used for
                // read-only recon (e.g. `Get-ChildItem` to find the right file before reading
                // it), which is NOT evidence that the deliverable was edited. Evidence:
                // 2026-07-05 audit log, goal "máximo 10 linhas por slide" — 3 recon
                // `Get-ChildItem` calls (listing *.md/*.pptx) ran before the `read`, made
                // writeToolsUsedThisTurn true, and steered this guard into the generic
                // "responda com o que já tem" message instead of "OBRIGATÓRIO use
                // exec_command" — the turn ended describing a plan instead of executing it.
                // Same definition DELIVERY-GUARD already uses a few hundred lines below
                // (wroteFile checks only `tool === 'write'`) — 'edit' kept here too since,
                // unlike exec_command, it can only ever be a mutation, never a listing.
                const writeToolsUsedThisTurn = cycleHistory.some(h => h.tool === 'write' || h.tool === 'edit');
                // Adaptar a mensagem de abort ao intent do usuário:
                // - Análise/review: o read É a ação principal → instruir a apresentar a análise
                // - Escrita/geração: o read é preâmbulo → instruir a usar exec_command
                const isAnalysisAbort = ANALYSIS_INTENT_PATTERN.test(userText);
                const needsWriteNow = lastToolInCycle === 'read' && !writeToolsUsedThisTurn && !isAnalysisAbort;
                const ratioAbortMsg = (lastToolInCycle === 'read' && !writeToolsUsedThisTurn)
                    ? isAnalysisAbort
                        ? '[CONTEXTO GRANDE] O arquivo foi lido com sucesso e está no contexto. ' +
                          'Agora forneça a análise/avaliação solicitada com base no conteúdo que você acabou de ler. ' +
                          'Responda com suas observações, sugestões de melhoria e avaliação da estrutura. ' +
                          'NÃO tente ler mais arquivos. NÃO use ferramentas. Responda AGORA com a análise.'
                        : '[CONTEXTO EXCESSIVO] O arquivo fonte foi carregado com sucesso e está disponível. ' +
                          'OBRIGATÓRIO: Use exec_command com um script Python COMPLETO E FUNCIONAL para gerar os arquivos de saída agora. ' +
                          'O script deve ler o arquivo de origem via open() e escrever todos os arquivos de saída necessários. ' +
                          'PROIBIDO: Afirmar que os arquivos foram criados sem ter executado exec_command. ' +
                          'PROIBIDO: Criar scripts placeholder com "pass" ou "# TODO" — escreva o código real. ' +
                          'NÃO leia mais arquivos no contexto. Processe TUDO via exec_command + Python.'
                    : '[CONTEXTO EXCESSIVO] O contexto cresceu demais. Use os dados já obtidos para responder agora sem usar mais ferramentas.';
                loopMessages.push({
                    role: 'system',
                    content: ratioAbortMsg,
                });
                guardsTriggered++;

                // needsWriteNow tells the model "use exec_command AGORA", but post-loop
                // synthesis (below) is text-only and can never execute that instruction —
                // setting dedupAbort here would make the guard's own message a lie the model
                // has no way to act on. Evidence: 2026-07-05 audit log, 4 consecutive turns
                // (goal "máximo 10 linhas por slide") all hit ratio≈2.6-2.7 right after the
                // single `read` needed before editing, aborted before any write/exec_command
                // was attempted, and ended in either a hallucination-block or an honest
                // "vou ler e depois ajustar" that never got a chance to actually happen.
                // Fix: grant ONE extra real step (bounded, same +2 pattern as DELIVERY-GUARD's
                // deliveryStepCap) so the model can act on its own instruction. If context still
                // hasn't produced a write/exec_command after that, abort for real — one-shot via
                // contextGuardWriteExtensionUsed prevents this from looping indefinitely.
                //
                // IMPORTANT: do NOT `continue` here. This guard runs at the TOP of the while
                // loop body, before the LLM call below — `continue` jumps back to `while(...)`,
                // which re-enters the loop and hits this SAME check again immediately (nothing
                // changed: no LLM call happened, no tool ran), consuming the one-shot flag on
                // the very next iteration without ever reaching the LLM call. Evidence:
                // 2026-07-05 21:33 audit log — Step 3 granted the extension, Step 4 logged
                // right after with zero LLM/tool activity in between, hit ratio_limit again
                // (one-shot now used) and aborted for real. Falling through (no continue) lets
                // THIS iteration's LLM call run with the injected instruction, which is the
                // whole point of the extension.
                if (needsWriteNow && !contextGuardWriteExtensionUsed) {
                    contextGuardWriteExtensionUsed = true;
                    if (maxSteps < stepCount + 2) maxSteps = stepCount + 2;
                    log.info(`[${this.ts()}] [SAFETY-GUARD] context_growth: granting one extra step to act on exec_command instruction (maxSteps→${maxSteps})`);
                    // No `continue`/`dedupAbort` here — falls through to the LLM call below,
                    // in this SAME iteration, so the model can actually act on the instruction.
                } else {
                    dedupAbort = true;
                    dedupAbortTool = `context_growth:${triggerReason}`;
                    // Pula a próxima chamada LLM — evita que o modelo crie artefato stub sob
                    // pressão de contexto (que o DELIVERY-GUARD enviaria). Cai na síntese.
                    continue;
                }
            }

            if (toolFailureCount >= 2) {
                loopMessages.push({
                    role: 'system',
                    content: '[CRÍTICO] Múltiplas ferramentas falharam. PARE de tentar ferramentas. Responda AGORA declarando claramente a limitação de dados. Seja honesto e transparente: não invente tendências e não use linguagem vaga. Ofereça uma alternativa útil com base no que já sabemos.'
                });
                if (!toolFailureHintInjected) {
                    toolFailureHintInjected = true;
                    toolFailureHintFirstStep = stepCount;
                }
            }

            // DecisionMemory-guided hint: if a tool has a poor historical success rate
            // AND has already been called multiple times this turn, suggest alternatives.
            // Generic: works for any tool, not just web_search.
            if (stepCount > 1) {
                for (const [toolName, rate] of Object.entries(decisionCtx.toolSuccessRates)) {
                    const callsThisTurn = cycleHistory.filter(h => h.tool === toolName).length;
                    if (rate < 0.4 && callsThisTurn >= 2 && decisionCtx.memoryConfidence !== 'none') {
                        loopMessages.push({
                            role: 'system',
                            content: `[COGNIÇÃO] "${toolName}" tem taxa de sucesso histórica de ${(rate * 100).toFixed(0)}% e já foi chamado ${callsThisTurn}x neste turno. Considere usar dados de memória ou uma abordagem diferente.`,
                        });
                        if (!toolSuccessHintInjected) {
                            toolSuccessHintInjected = true;
                            toolSuccessHintFirstStep = stepCount;
                        }
                        break; // one hint at a time to avoid noise
                    }
                }
            }

            move('LLM_REQUEST', { step: stepCount });
            const response = await this.callLLMWithFallback(loopMessages, toolDefs, chatProfile, turnSignal);
            move('LLM_RESPONSE', { step: stepCount, status: response.status });

            if (response.thinking && response.thinking.trim().length > 0) {
                this.getTurnState(conversationId).cognitiveWorkspace.add(stepCount, response.thinking.trim(), 'reasoning');
                totalThinkingChars += response.thinking.trim().length;
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
                // If tools ran successfully before the timeout, report what was accomplished
                const successfulWrites = cycleHistory.filter(h => h.tool === 'write' && h.status === 'success');
                let timeoutMsg = response.fallbackMessage || 'O modelo demorou mais que o esperado. Tente novamente em alguns instantes.';
                if (successfulWrites.length > 0) {
                    const filePaths = [...new Set(successfulWrites.map(h => {
                        try { return (JSON.parse(h.input) as Record<string, unknown>).path as string; } catch { return null; }
                    }).filter(Boolean))];
                    if (filePaths.length > 0) {
                        timeoutMsg = `O modelo demorou mais que o esperado ao finalizar. O arquivo foi criado parcialmente em: ${filePaths.join(', ')} — você pode pedir para continuar.`;
                    }
                }
                traceManager.completeTrace(trace, 'timeout', timeoutMsg);
                this.persistTrace(trace, stepCount, 'timeout', timeoutMsg, channelContext);
                this.activeTurns.delete(conversationId);
                return timeoutMsg;
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

            // Detect native tool calls BEFORE strictParse so the parser can skip
            // content-format validation when the model already communicated via toolCalls[].
            // (e.g. kimi-k2.6 puts its reasoning in the thinking field, not JSON protocol)
            const hasNativeToolCalls = (response.toolCalls?.length ?? 0) > 0;

            const structured = this.protocolParser.strictParse(response.content || '', hasNativeToolCalls);
            const atomicData = parseLLMResponse(response.content || '');
            const finalText = extractFinalText(response, atomicData);

            // Only store deliverable responses as lastBestContent.
            // Protocol violations (planning/protocolViolation) contain raw protocol
            // artifacts that must not be delivered to the user if the loop exits early.
            const isProtocolViolation = structured?.metadata?.protocolViolation === true;
            if (finalText.length > 0 && !isProtocolViolation) {
                lastBestContent = finalText;
            }

            loopMessages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls });

            const wantsTool = structured?.type === 'tool_call' || (atomicData?.action?.type === 'tool' && atomicData?.action?.name);

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
                // Skip when recoveryNeeded=true: content is a timeout fragment, not a real final answer.
                if (hasUsedNativeTools && finalText.length > 30 && !structured?.metadata?.recoveryNeeded) {
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
                return { text: await this.commitResponse(finalText, userText, trace.id, conversationId, turnSignal, toolFailureCount) };
            }

            if (response.toolCalls && response.toolCalls.length > 0) {
                // Tracks the last successful terminal tool in this batch.
                // We intentionally do NOT return inside the for loop so that all
                // send_document / send_audio calls in a single batch are executed
                // before the turn ends (fixes the "only index.html sent" bug).
                let terminalBatchResult: string | null = null;

                for (const toolCall of response.toolCalls) {
                    const toolName = toolCall.name;
                    const inputKey = computeToolInputKey(toolName, toolCall.arguments);

                    // Block read attempts on filenames already confirmed as non-existent,
                    // regardless of path format (absolute, relative, workspace-prefixed, etc.)
                    if (toolName === 'read') {
                        const pathArg = String(toolCall.arguments?.path || '');
                        const filename = pathArg.replace(/\\/g, '/').split('/').pop() || '';
                        if (filename && failedReadFilenames.has(filename)) {
                            log.warn(`[${this.ts()}] [READ-NOTFOUND-BLOCK] Blocked read of absent file: ${filename}`);
                            loopMessages.push({
                                role: 'tool',
                                content: `[BLOQUEADO] O arquivo "${filename}" já foi confirmado como INEXISTENTE no workspace. Use a ferramenta "write" para criar o arquivo com o conteúdo completo antes de tentar lê-lo.`,
                                tool_call_id: toolCall.id,
                            });
                            loopMessages.push({
                                role: 'system',
                                content: `⚠️ "${filename}" NÃO EXISTE no workspace. Ação obrigatória: use "write" com o conteúdo completo para criá-lo. NÃO tente "read" antes de criar o arquivo.`,
                            });
                            continue;
                        }
                        if (filename && binaryReadFilenames.has(filename)) {
                            log.warn(`[${this.ts()}] [BINARY-READ-BLOCK] Blocked repeated read of binary file: ${filename}`);
                            loopMessages.push({
                                role: 'tool',
                                content: `[BLOQUEADO] "${filename}" é um arquivo binário — "read" não consegue processá-lo. Use exec_command com python-pptx, pandoc, pdftotext ou similar para extrair o conteúdo.`,
                                tool_call_id: toolCall.id,
                            });
                            loopMessages.push({
                                role: 'system',
                                content: `⚠️ NÃO chame "read" em "${filename}" novamente. Abordagem obrigatória: use exec_command com a ferramenta adequada para o formato ${filename.split('.').pop()?.toUpperCase()}.`,
                            });
                            continue;
                        }
                    }

                    if (usedToolInputs.has(inputKey)) {
                        const blockCount = (blockedKeyCount.get(inputKey) ?? 0) + 1;
                        blockedKeyCount.set(inputKey, blockCount);
                        log.warn(`[${this.ts()}] [TOOL-DEDUP] Blocked repeated native call: ${toolName} (block #${blockCount})`);
                        const cachedOutput = usedToolOutputs.get(inputKey);
                        const contentHint = toolName === 'read' && cachedOutput
                            ? `\n\n— Início do conteúdo já lido —\n${cachedOutput.slice(0, 600)}\n— (conteúdo completo disponível no histórico) —`
                            : '';
                        const dedupBlockedMsg = toolName === 'read'
                            ? `[BLOQUEADO] "read" já foi executado para este arquivo. Use este conteúdo diretamente — NÃO releia.${contentHint}\n\nPróximo passo obrigatório: use exec_command para processar o arquivo, write para salvar resultado, ou responda diretamente ao usuário com base no conteúdo já lido.`
                            : `[BLOQUEADO] "${toolName}" já foi executado com estes argumentos. Esta chamada foi bloqueada. NÃO repita esta ferramenta com os mesmos argumentos — use uma estratégia diferente ou responda com o que já sabe.`;
                        loopMessages.push({
                            role: 'tool',
                            content: dedupBlockedMsg,
                            tool_call_id: toolCall.id,
                        });
                        if (blockCount >= 3) {
                            loopMessages.push({
                                role: 'system',
                                content: `[CRÍTICO] A ferramenta "${toolName}" foi bloqueada ${blockCount} vezes seguidas. O loop foi interrompido. Forneça a melhor resposta possível com as informações que você já tem.`,
                            });
                            dedupAbort = true;
                            dedupAbortTool = toolName;
                            break;
                        }
                        continue;
                    }

                    // FIX C: quando em contexto de goal-execution, adiar send_document para pós-validação
                    if (toolName === 'send_document' && channelContext?.deliveryTracking?.deferSendDocument) {
                        const filePath = String(toolCall.arguments?.file_path ?? toolCall.arguments?.path ?? '(unknown)');
                        const alreadyRegistered = channelContext.deliveryTracking.isDeferredArtifact?.(filePath) ?? false;
                        log.info(
                            `[${this.ts()}] [AGENTLOOP-SEND]` +
                            ` deferred=true` +
                            ` reason=goal_execution_policy` +
                            ` file_path="${filePath}"` +
                            ` already_registered=${alreadyRegistered}`
                        );
                        if (!alreadyRegistered) {
                            channelContext.deliveryTracking.deferSendDocument(toolCall.arguments ?? {});
                        }
                        // Mensagem semanticamente neutra: não instrui o LLM a "continuar trabalhando"
                        // pois isso causava loop de re-chamadas ao send_document.
                        const deferMsg = alreadyRegistered
                            ? `[DIFERIDO-DEDUP] O documento "${filePath}" já foi registrado para entrega. Não reenvie este artefato. Se não há outras tarefas pendentes, conclua com uma resposta final ao usuário.`
                            : `[DIFERIDO] Documento "${filePath}" registrado para entrega após validação. Não reenvie este artefato. Continue apenas se ainda existirem tarefas pendentes não relacionadas à entrega deste arquivo.`;
                        loopMessages.push({
                            role: 'tool',
                            content: deferMsg,
                            tool_call_id: toolCall.id,
                        });
                        // FIX E (docs/INVESTIGACAO_TOOL_DEDUP_2026-07-13.md): este branch nunca
                        // escrevia em cycleHistory, deixando o DELIVERY-GUARD (abaixo, no fim do
                        // loop) cego a um defer bem-sucedido — ele recalcula `sentFile` só a
                        // partir de cycleHistory, então via achar `wroteFile && !sentFile` e
                        // reinjetar "[ENTREGA PENDENTE] ... USE send_document AGORA" por cima de
                        // um arquivo que já tinha sido corretamente registrado para entrega.
                        // status:'deferred' (não 'success') propositalmente — alinha com o que
                        // channelContext.deliveryTracking.isDeferredArtifact já sabe, sem se passar por um envio
                        // confirmado de verdade.
                        cycleHistory.push({ step: stepCount, tool: 'send_document', input: JSON.stringify(toolCall.arguments ?? {}), status: 'deferred' });
                        usedToolInputs.add(inputKey);
                        continue;
                    }

                    // send_audio não tem file_path estável (cada chamada gera um mp3/ogg com
                    // timestamp único), então não pode usar o dedup por path de send_document
                    // acima. Sem este guard, um step "agentloop" que já entregou áudio com
                    // sucesso e é re-executado do zero por um replan (ex: SemanticValidator
                    // rejeitando o texto final por mismatch) gera e envia um NOVO áudio a cada
                    // tentativa — o TTS/upload já aconteceu de verdade, não há como "desfazer".
                    // Evidência: 2026-07-05, goal_1783269002590_inaml — 4 áudios enviados em
                    // sequência pelo mesmo pedido do usuário.
                    if (toolName === 'send_audio' && channelContext?.deliveryTracking?.isAudioAlreadySent?.()) {
                        log.info(`[${this.ts()}] [AGENTLOOP-SEND] tool=send_audio decision=skip reason=already_delivered_this_goal`);
                        loopMessages.push({
                            role: 'tool',
                            content: `[JÁ ENVIADO] O áudio para este objetivo já foi entregue ao usuário anteriormente. Não gere nem envie outro áudio. Se não há mais tarefas pendentes, conclua com uma resposta final em texto.`,
                            tool_call_id: toolCall.id,
                        });
                        usedToolInputs.add(inputKey);
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

                        const isDangerous = ToolRegistry.isDangerous(toolName) 
                            && !this.isSafeExecCommand(toolName, toolCall.arguments)
                            && !permissionRegistry.can('auto_approve_exec');
                        if (isDangerous) {
                            log.warn(`[${this.ts()}] [AUTH] Dangerous tool BLOCKED: ${toolName}. Waiting for human approval.`);

                            let txnId: string | undefined;
                            if (this.workflowEngine) {
                                // Novo fluxo: cria transaction com ID estruturado.
                                // Canais com workflowCallback (Telegram, WhatsApp, Discord, Signal) rotearão o callback
                                // diretamente ao WorkflowEngine — sem passar pelo LLM pipeline.
                                const ctx: ContinuationContext = {
                                    workflow: this.inferWorkflowName(intentDecision.intent, toolName),
                                    step: toolName,
                                    userGoal: userText.slice(0, 200),
                                    activeResources: this.extractResourceNames(toolCall.arguments),
                                    alternativeTools: this.findSafeAlternatives(toolName),
                                };
                                const txn = this.workflowEngine.createTransaction(
                                    conversationId, toolName,
                                    toolCall.arguments as Record<string, unknown>,
                                    ctx
                                );
                                txnId = txn.id;
                            }
                            // Registra no authManager para: (1) guardar hasPendingAuth nos fast-paths,
                            // (2) permitir removePending() no resumeFromWorkflow() após resolução.
                            // txnId é armazenado para habilitar aprovação por texto ("sim") como fallback.
                            this.authManager.addPending(conversationId, toolName, toolCall.arguments, txnId);

                            move('AUTH_REQUIRED', { step: stepCount, tool: toolName, txnId });
                            const authReq = this.authManager.formatRequest(toolName, toolCall.arguments, txnId);
                            return { text: authReq.text, options: authReq.options };
                        }

                        // Guard: bloqueia edit repetido no mesmo arquivo (previne append-loop)
                        if (toolName === 'edit') {
                            const ep = typeof toolCall.arguments?.path === 'string' ? toolCall.arguments.path : undefined;
                            if (ep) {
                                const ec = (editPathCount.get(ep) ?? 0) + 1;
                                editPathCount.set(ep, ec);
                                if (ec > 4) {
                                    log.warn(`[${this.ts()}] [EDIT-LOOP] Blocked edit #${ec} to "${ep}" — use write to rewrite`);
                                    loopMessages.push({
                                        role: 'tool',
                                        content: `[BLOQUEADO] "edit" foi chamado ${ec} vezes no mesmo arquivo "${ep}" neste turno. Esta chamada foi bloqueada para evitar corrupção de arquivo por append-loop. Use "write" com o conteúdo completo se precisar reescrever o arquivo inteiro.`,
                                        tool_call_id: toolCall.id,
                                    });
                                    if (ec >= 7) {
                                        loopMessages.push({ role: 'system', content: `[CRÍTICO] "edit" foi chamado ${ec} vezes no arquivo "${ep}". O loop foi interrompido. Responda ao usuário com o que foi feito até aqui.` });
                                        dedupAbort = true;
                                        dedupAbortTool = toolName;
                                        break;
                                    }
                                    continue;
                                }
                            }
                        }

                        const toolStartTime = Date.now();
                        const recovery = await this.proactiveRecovery.execute(
                            toolName, toolCall.arguments,
                            (n) => this.tools.get(n) as import('./ProactiveRecovery').ToolExecutorLike | undefined,
                            usedToolInputs,
                            turnSignal,
                        );
                        const result = recovery.result;
                        const resolvedToolName = recovery.finalToolName;
                        const resolvedArgs = recovery.finalArgs;
                        const toolDuration = Date.now() - toolStartTime;

                        if (recovery.recovered && recovery.recoveryNote) {
                            const origTool = recovery.originalToolName ?? toolName;
                            const kind = recovery.mutationKind ?? 'arg_mutation';
                            log.info(
                                `[MUTATION] tool_mutation:\n  tool: ${origTool}\n  kind: ${kind}\n` +
                                `  original: ${JSON.stringify(recovery.originalArgs ?? {})}\n` +
                                `  modified: ${JSON.stringify(resolvedArgs)}`
                            );
                            loopMessages.push({
                                role: 'system',
                                content: kind === 'fallback_tool'
                                    ? `[RECUPERAÇÃO AUTOMÁTICA] A ferramenta "${origTool}" falhou e foi substituída por "${resolvedToolName}" com argumentos adaptados. ${recovery.recoveryNote}`
                                    : `[RECUPERAÇÃO AUTOMÁTICA] Os argumentos da ferramenta "${resolvedToolName}" foram ajustados automaticamente para funcionar. ${recovery.recoveryNote}`,
                            });
                        } else if (recovery.recoveryNote) {
                            log.info(`[${this.ts()}] ${recovery.recoveryNote}`);
                        }
                        // Utility score: generic keyword-overlap heuristic — observability only.
                        // Collect data here; do not use for control flow until patterns emerge.
                        const utilityScore = result.success
                            ? computeToolUtilityScore(userText, result.output)
                            : 0;
                        log.info(
                            `[${this.ts()}] [TOOL] ${resolvedToolName} -> ${result.success ? '✓' : '✗'} ` +
                            `utility=${utilityScore.toFixed(2)}`,
                            result.error ? `ERROR: ${result.error}` : (result.output || '').slice(0, 200)
                        );

                        traceManager.addStep(trace, 'tool_call', { tool: resolvedToolName, input: resolvedArgs });
                        traceManager.addStep(trace, 'tool_result', { tool: resolvedToolName, success: result.success, output: result.output });
                        this.decisionMemory.recordFromLoop(resolvedToolName, result.success, toolDuration, userText);
                        this.skillLearner.recordPattern(userText, resolvedToolName, result.success, toolDuration);

                        cycleHistory.push({ step: stepCount, tool: resolvedToolName, input: JSON.stringify(resolvedArgs), status: result.success ? 'success' : 'error' });
                        loopMessages.push({ role: 'tool', content: result.output, tool_call_id: toolCall.id });
                        if (result.success) usedToolOutputs.set(inputKey, result.output.slice(0, 2000));
                        // Persiste args de tool calls bem-sucedidas no transcript (mesmo padrão já
                        // usado por GoalExecutionLoop.ts, que sempre teve isso — AgentLoop nunca
                        // teve, então turnos roteados por aqui perdiam permanentemente os argumentos
                        // de qualquer tool call assim que o turno terminava (cycleHistory é local ao
                        // método, descartado no return). Caso real: send_audio recebe o texto do
                        // áudio só via toolArgs — sem isso, "qual foi o texto que você usou?" nunca
                        // tem como ser respondido, mesmo o áudio tendo sido gerado com sucesso.
                        if (result.success && channelContext) {
                            await this.sessionContext?.getSessionManager().recordToolCall(
                                { channel: channelContext.channel, userId: channelContext.userId ?? conversationId },
                                resolvedToolName,
                                JSON.stringify(resolvedArgs),
                            ).catch(() => {});
                        }

                        // Evidence-driven budget upgrade: a turn classified as lightweight
                        // (conversation/direct, maxSteps=4) can still turn into real file-producing
                        // work once it actually calls `write`/`exec_command` — the upfront text-only
                        // classification has no way to know a "refinamento" will need edit + convert
                        // + send. Evidence: 2026-07-05 audit log, goal_1783288862838_1muu1 follow-up
                        // "máximo 10 linhas por slide" — routed as refinement_of_recent_goal →
                        // agentloop → conversation/direct (budget 4+2). The turn spent its entire
                        // budget re-editing excel_class.md and only wrote a conversion script
                        // (scripts/gen_excel_pptx.py) in the very last allowed step — never executed
                        // it, never sent anything — then got blocked as a hallucination (final text
                        // said "vou recriar..." while no new PPTX existed). Same upgrade pattern as
                        // requiresPlanning above — reacts to observed tool use, not to a new
                        // classification signal.
                        if (result.success && (resolvedToolName === 'write' || resolvedToolName === 'exec_command') &&
                            maxSteps < (STEP_BUDGETS.tool ?? 10)) {
                            const upgraded = STEP_BUDGETS.tool ?? 10;
                            log.info(`[${this.ts()}] [STEP-BUDGET] real file work detected (${resolvedToolName}) → upgrading ${maxSteps} → ${upgraded}`);
                            maxSteps = upgraded;
                            decisionCtx.extendedStepBudget = upgraded;
                        }

                        totalToolCalls++;

                        // Generic loop detector: same tool called too many times in one turn.
                        // Exception: info-retrieval tools called in batch mode (one LLM response,
                        // each call with a unique argument) are NOT loops — they're valid parallel
                        // fetches. Use argument diversity to distinguish batch from loop.
                        const toolTypeCount = (toolTypeCallCount.get(resolvedToolName) ?? 0) + 1;
                        toolTypeCallCount.set(resolvedToolName, toolTypeCount);
                        if (toolTypeCount >= MAX_SAME_TOOL_CALLS && !dedupAbort) {
                            const INFO_BATCH_TOOLS = new Set(['web_search', 'web_navigate', 'weather', 'crypto_analysis', 'memory_search', 'api_request']);
                            const uniqueArgsForTool = new Set(
                                cycleHistory.filter(h => h.tool === resolvedToolName).map(h => h.input)
                            ).size;
                            const uniqueRatio = toolTypeCount > 0 ? uniqueArgsForTool / toolTypeCount : 0;
                            const isBatch = INFO_BATCH_TOOLS.has(resolvedToolName) && uniqueRatio >= 0.75 && toolTypeCount < 10;
                            if (isBatch) {
                                log.warn(
                                    `[${this.ts()}] [SAFETY-GUARD] type=info_batch tool=${resolvedToolName} ` +
                                    `calls=${toolTypeCount} unique=${uniqueArgsForTool} ratio=${uniqueRatio.toFixed(2)} — batch mode, continuing`
                                );
                            } else {
                                log.warn(
                                    `[${this.ts()}] [SAFETY-GUARD] type=tool_loop reason=same_tool_limit ` +
                                    `value=${toolTypeCount} threshold=${MAX_SAME_TOOL_CALLS} tool=${resolvedToolName}`
                                );
                                loopMessages.push({
                                    role: 'system',
                                    content: `[LOOP DETECTADO] A ferramenta "${resolvedToolName}" foi chamada ${toolTypeCount} vezes neste turno. ` +
                                        `O loop foi interrompido. Use os dados já obtidos ou as informações da memória para responder agora.`,
                                });
                                dedupAbort = true;
                                dedupAbortTool = `${resolvedToolName}:loop`;
                                guardsTriggered++;
                            }
                        }

                        // Related-tool group detector: catches alternation (e.g. web_search ↔ web_navigate).
                        const toolGroup = TOOL_GROUP_REGISTRY[resolvedToolName];
                        if (toolGroup) {
                            const gCount = (groupCallCount.get(toolGroup) ?? 0) + 1;
                            groupCallCount.set(toolGroup, gCount);
                            if (gCount >= MAX_GROUP_CALLS && !dedupAbort) {
                                log.warn(
                                    `[${this.ts()}] [SAFETY-GUARD] type=tool_group_loop reason=group_limit ` +
                                    `value=${gCount} threshold=${MAX_GROUP_CALLS} group=${toolGroup}`
                                );
                                loopMessages.push({
                                    role: 'system',
                                    content: `[LOOP DE GRUPO] O grupo de ferramentas "${toolGroup}" foi usado ${gCount} vezes neste turno. ` +
                                        `Interrompendo. Responda com os dados disponíveis em memória.`,
                                });
                                dedupAbort = true;
                                dedupAbortTool = `group:${toolGroup}:loop`;
                                guardsTriggered++;
                            }
                        }

                        // Consecutive failure detector: resets on any success.
                        if (result.success) {
                            consecutiveToolFailures = 0;
                        } else {
                            consecutiveToolFailures++;
                            if (consecutiveToolFailures >= MAX_CONSECUTIVE_TOOL_FAILURES && !dedupAbort) {
                                log.warn(
                                    `[${this.ts()}] [SAFETY-GUARD] type=consecutive_failures reason=failure_limit ` +
                                    `value=${consecutiveToolFailures} threshold=${MAX_CONSECUTIVE_TOOL_FAILURES}`
                                );
                                loopMessages.push({
                                    role: 'system',
                                    content: `[FALHAS CONSECUTIVAS] ${consecutiveToolFailures} ferramentas falharam seguidas. ` +
                                        `Não foi possível obter dados confiáveis após múltiplas tentativas. Responda ao usuário com honestidade sobre essa limitação.`,
                                });
                                dedupAbort = true;
                                dedupAbortTool = 'consecutive_failures';
                                guardsTriggered++;
                            }
                        }

                        // After a successful read, inject a directive to prevent re-reading in this turn.
                        // ARTIFACT-DRIFT FIX: mensagem escrita para NÃO proibir releitura em turnos futuros
                        // (arquivo pode ser modificado por steps subsequentes do GoalExecutionLoop).
                        if (result.success && resolvedToolName === 'read') {
                            loopMessages.push({
                                role: 'system',
                                content:
                                    `[LEITURA CONCLUÍDA] O arquivo foi lido com sucesso (${result.output.length} chars). ` +
                                    `O conteúdo está disponível neste turno.\n` +
                                    `Se o arquivo for modificado (write/edit) em um passo futuro, releia-o antes de usá-lo novamente.\n` +
                                    `PRÓXIMO PASSO: use "exec_command" para processar, "write" para salvar, ou responda ao usuário.`,
                            });
                        }

                        if (!result.success) {
                            toolFailureCount++;
                            const errorText = result.error ?? result.output ?? '';
                            const isReadNotFound = resolvedToolName === 'read' && /não encontrado|not found/i.test(errorText);
                            const isBinaryRead = resolvedToolName === 'read' && /arquivos binários|binary.*não podem|cannot.*binary/i.test(errorText);
                            if (isReadNotFound) {
                                const pathArg = String(resolvedArgs.path || '');
                                const filename = pathArg.replace(/\\/g, '/').split('/').pop() || '';
                                if (filename) failedReadFilenames.add(filename);
                                loopMessages.push({
                                    role: 'system',
                                    content: `[ARQUIVO INEXISTENTE] "${filename || pathArg}" não existe no workspace. Para criá-lo, use a ferramenta "write" com o conteúdo completo. NÃO tente "read" novamente antes de criar o arquivo com "write".`,
                                });
                            } else if (isBinaryRead) {
                                const pathArg = String(resolvedArgs.path || '');
                                const filename = pathArg.replace(/\\/g, '/').split('/').pop() || '';
                                if (filename) binaryReadFilenames.add(filename);
                                loopMessages.push({
                                    role: 'system',
                                    content: `[ARQUIVO BINÁRIO] "${filename || pathArg}" não pode ser lido com "read". Use exec_command com a ferramenta adequada (python-pptx, pandoc, pdftotext, etc.). NÃO tente "read" neste arquivo novamente.`,
                                });
                            } else if (resolvedToolName === 'exec_command' && /no such file or directory/i.test(errorText)) {
                                // Path não existe — sugere explorar o workspace antes de adivinhar caminhos
                                loopMessages.push({
                                    role: 'system',
                                    content: `[PATH INEXISTENTE] O caminho informado não existe. NÃO repita o mesmo comando. Use "list_workspace" para descobrir a estrutura real do workspace antes de prosseguir.`,
                                });
                            } else {
                                // errorText é computado acima (result.error ?? result.output ?? '') mas até aqui
                                // nunca chegava ao LLM nos casos fora dos 3 padrões especiais acima — a mensagem
                                // genérica ("tente uma abordagem diferente") não informa POR QUE a tool falhou,
                                // fazendo o LLM adivinhar variações de frase às cegas em vez de corrigir a causa
                                // real (ex: argumento obrigatório ausente, dependência não instalada).
                                const reason = errorText.trim().slice(0, 300) || 'sem detalhes do erro retornados pela ferramenta';
                                loopMessages.push({
                                    role: 'system',
                                    content: `[FALHA] A ferramenta "${resolvedToolName}" falhou: ${reason}. Corrija a causa indicada antes de tentar de novo — não repita a mesma chamada sem mudar o que a causou.`
                                });
                            }
                        }

                        const terminalTools = ['send_audio', 'send_document', 'send_image', 'send_video'];
                        if (result.success && !terminalTools.includes(toolName) && !this.isSafeExecCommand(toolName, toolCall.arguments)) {
                            this.getTurnState(conversationId).lastToolExecution = { toolName, toolOutput: result.output, intent: intentDecision.intent, category: intentDecision.category };
                            void this.tryValidateTool(userText, intentDecision.intent, intentDecision.category, toolName, result.output, loopMessages, trace.id, conversationId);
                        }
                        if (toolName === 'send_audio' && result.success) {
                            channelContext?.deliveryTracking?.onArtifactDelivered?.('__send_audio_delivered__');
                        }
                        if (terminalTools.includes(toolName) && result.success) {
                            log.info(`[${this.ts()}] [TASK-FSM] Terminal tool "${toolName}" succeeded — continuing batch before closing turn`);
                            terminalBatchResult = result.output;
                            move('TOOL_COMPLETED', { step: stepCount, tool: toolName, success: true });
                            continue; // process remaining toolCalls in this batch (e.g. multiple send_document)
                        }
                        move('TOOL_COMPLETED', { step: stepCount, tool: toolName, success: result.success });
                    }
                }

                // After all toolCalls in the batch are processed, check for a terminal result.
                if (terminalBatchResult !== null) {
                    log.info(`[${this.ts()}] [TASK-FSM] Terminal batch done → task DONE, returning result`);
                    move('FINAL_READY', { step: stepCount, terminal: true });
                    traceManager.completeTrace(trace, 'completed', terminalBatchResult);
                    this.persistTrace(trace, stepCount, 'completed', terminalBatchResult, channelContext);
                    return terminalBatchResult;
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
                    return await this.commitResponse(finalText, userText, trace.id, conversationId, turnSignal, toolFailureCount);
                }
            }

            // JSON-action tool execution
            if (atomicData?.action?.type === 'tool' && atomicData.action.name) {
                const toolName = atomicData.action.name;
                const inputKey = computeToolInputKey(toolName, atomicData.action.input || {});

                if (usedToolInputs.has(inputKey)) {
                    const blockCount = (blockedKeyCount.get(inputKey) ?? 0) + 1;
                    blockedKeyCount.set(inputKey, blockCount);
                    log.warn(`[${this.ts()}] [ATOMIC-TOOL] Blocked repeated call: ${toolName} (block #${blockCount})`);
                    const atomicBlockedMsg = toolName === 'read'
                        ? `[BLOQUEADO] "read" já foi executado para este arquivo. O conteúdo JÁ ESTÁ disponível no histórico desta conversa — NÃO releia. Próximo passo obrigatório: use exec_command para processar o arquivo, write para salvar resultado, ou responda diretamente ao usuário com base no conteúdo já lido.`
                        : `[BLOQUEADO] "${toolName}" já foi executado com estes argumentos (bloqueio #${blockCount}). NÃO repita — use uma estratégia diferente ou responda com o que já sabe.`;
                    loopMessages.push({
                        role: 'system',
                        content: atomicBlockedMsg,
                    });
                    if (blockCount >= 3) {
                        loopMessages.push({
                            role: 'system',
                            content: `[CRÍTICO] A ferramenta "${toolName}" foi bloqueada ${blockCount} vezes seguidas. Forneça a melhor resposta possível com as informações que você já tem.`,
                        });
                        dedupAbort = true;
                        dedupAbortTool = toolName;
                        break;
                    }
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

                    // Guard: bloqueia edit repetido no mesmo arquivo (previne append-loop)
                    if (toolName === 'edit') {
                        const ep = typeof atomicData.action.input?.path === 'string' ? atomicData.action.input.path : undefined;
                        if (ep) {
                            const ec = (editPathCount.get(ep) ?? 0) + 1;
                            editPathCount.set(ep, ec);
                            if (ec > 4) {
                                log.warn(`[${this.ts()}] [EDIT-LOOP] Blocked atomic edit #${ec} to "${ep}" — use write to rewrite`);
                                loopMessages.push({ role: 'system', content: `[BLOQUEADO] "edit" foi chamado ${ec} vezes no arquivo "${ep}" neste turno. Use "write" com o conteúdo completo.` });
                                if (ec >= 7) {
                                    dedupAbort = true;
                                    dedupAbortTool = toolName;
                                    break;
                                }
                                continue;
                            }
                        }
                    }

                    // Mesmo guard do caminho de tool-calling nativo (linha ~1645): send_audio
                    // não tem file_path estável, então não pode reusar o dedup de send_document.
                    // Sem isso, um step "agentloop" que já entregou áudio e é re-executado do
                    // zero por um replan reenviaria áudio de novo também quando o modelo usa o
                    // protocolo JSON de ação em vez de tool-calling nativo.
                    if (toolName === 'send_audio' && channelContext?.deliveryTracking?.isAudioAlreadySent?.()) {
                        log.info(`[${this.ts()}] [AGENTLOOP-SEND] tool=send_audio decision=skip reason=already_delivered_this_goal path=json_action`);
                        loopMessages.push({
                            role: 'tool',
                            content: `[JÁ ENVIADO] O áudio para este objetivo já foi entregue ao usuário anteriormente. Não gere nem envie outro áudio. Se não há mais tarefas pendentes, conclua com uma resposta final em texto.`,
                        });
                        continue;
                    }

                    const toolStartTime = Date.now();
                    const atomicRecovery = await this.proactiveRecovery.execute(
                        toolName, atomicData.action.input || {},
                        (n) => this.tools.get(n) as import('./ProactiveRecovery').ToolExecutorLike | undefined,
                        usedToolInputs,
                        turnSignal,
                    );
                    const result = atomicRecovery.result;
                    const resolvedToolName = atomicRecovery.finalToolName;
                    const resolvedArgs = atomicRecovery.finalArgs;
                    const toolDuration = Date.now() - toolStartTime;
                    if (toolName === 'send_audio' && result.success) {
                        channelContext?.deliveryTracking?.onArtifactDelivered?.('__send_audio_delivered__');
                    }

                    if (atomicRecovery.recovered && atomicRecovery.recoveryNote) {
                        const origTool = atomicRecovery.originalToolName ?? toolName;
                        const kind = atomicRecovery.mutationKind ?? 'arg_mutation';
                        log.info(
                            `[MUTATION] tool_mutation:\n  tool: ${origTool}\n  kind: ${kind}\n` +
                            `  original: ${JSON.stringify(atomicRecovery.originalArgs ?? {})}\n` +
                            `  modified: ${JSON.stringify(resolvedArgs)}`
                        );
                        loopMessages.push({
                            role: 'system',
                            content: kind === 'fallback_tool'
                                ? `[RECUPERAÇÃO AUTOMÁTICA] A ferramenta "${origTool}" falhou e foi substituída por "${resolvedToolName}". ${atomicRecovery.recoveryNote}`
                                : `[RECUPERAÇÃO AUTOMÁTICA] Os argumentos da ferramenta "${resolvedToolName}" foram ajustados automaticamente. ${atomicRecovery.recoveryNote}`,
                        });
                    } else if (atomicRecovery.recoveryNote) {
                        log.info(`[${this.ts()}] ${atomicRecovery.recoveryNote}`);
                    }
                    log.info(`[${this.ts()}] [ATOMIC-TOOL] ${resolvedToolName} -> ${result.success ? '✓' : '✗'}`, result.error ? `ERROR: ${result.error}` : (result.output || '').slice(0, 200));

                    traceManager.addStep(trace, 'tool_call', { tool: resolvedToolName, input: resolvedArgs });
                    traceManager.addStep(trace, 'tool_result', { tool: resolvedToolName, success: result.success, output: result.output });
                    this.decisionMemory.recordFromLoop(resolvedToolName, result.success, toolDuration, userText);
                    this.skillLearner.recordPattern(userText, resolvedToolName, result.success, toolDuration);

                    cycleHistory.push({ step: stepCount, tool: resolvedToolName, input: JSON.stringify(resolvedArgs), status: result.success ? 'success' : 'error' });
                    loopMessages.push({ role: 'tool', content: result.output });
                    // Mesmo fix do caminho de tool-calling nativo acima (ver comentário lá) —
                    // path json_action é a 2ª cópia do mesmo dispatch, precisa do mesmo registro.
                    if (result.success && channelContext) {
                        await this.sessionContext?.getSessionManager().recordToolCall(
                            { channel: channelContext.channel, userId: channelContext.userId ?? conversationId },
                            resolvedToolName,
                            JSON.stringify(resolvedArgs),
                        ).catch(() => {});
                    }

                    if (!result.success) {
                        toolFailureCount++;
                        // Mesma correção do caminho de tool-calling nativo acima: sem o texto real do
                        // erro (result.error), o LLM só via "tente uma abordagem diferente" e adivinhava
                        // variações de frase às cegas em vez de corrigir a causa real da falha.
                        const atomicReason = (result.error ?? result.output ?? '').trim().slice(0, 300)
                            || 'sem detalhes do erro retornados pela ferramenta';
                        loopMessages.push({
                            role: 'system',
                            content: `[FALHA] A ferramenta "${resolvedToolName}" falhou: ${atomicReason}. Corrija a causa indicada antes de tentar de novo — não repita a mesma chamada sem mudar o que a causou.`
                        });
                    }

                    totalToolCalls++;

                    // Generic loop detector (JSON-action path): mirrors the native tool check.
                    const atomicToolTypeCount = (toolTypeCallCount.get(resolvedToolName) ?? 0) + 1;
                    toolTypeCallCount.set(resolvedToolName, atomicToolTypeCount);
                    if (atomicToolTypeCount >= MAX_SAME_TOOL_CALLS && !dedupAbort) {
                        log.warn(
                            `[${this.ts()}] [SAFETY-GUARD] type=tool_loop reason=same_tool_limit ` +
                            `value=${atomicToolTypeCount} threshold=${MAX_SAME_TOOL_CALLS} tool=${resolvedToolName}`
                        );
                        loopMessages.push({
                            role: 'system',
                            content: `[LOOP DETECTADO] A ferramenta "${resolvedToolName}" foi chamada ${atomicToolTypeCount} vezes neste turno. ` +
                                `O loop foi interrompido. Use os dados já obtidos ou as informações da memória para responder agora.`,
                        });
                        dedupAbort = true;
                        dedupAbortTool = `${resolvedToolName}:loop`;
                        guardsTriggered++;
                    }

                    // Group loop + consecutive failures (JSON-action path).
                    const atomicGroup = TOOL_GROUP_REGISTRY[resolvedToolName];
                    if (atomicGroup) {
                        const agCount = (groupCallCount.get(atomicGroup) ?? 0) + 1;
                        groupCallCount.set(atomicGroup, agCount);
                        if (agCount >= MAX_GROUP_CALLS && !dedupAbort) {
                            log.warn(
                                `[${this.ts()}] [SAFETY-GUARD] type=tool_group_loop reason=group_limit ` +
                                `value=${agCount} threshold=${MAX_GROUP_CALLS} group=${atomicGroup}`
                            );
                            loopMessages.push({
                                role: 'system',
                                content: `[LOOP DE GRUPO] O grupo "${atomicGroup}" foi usado ${agCount} vezes. Responda com os dados disponíveis.`,
                            });
                            dedupAbort = true;
                            dedupAbortTool = `group:${atomicGroup}:loop`;
                            guardsTriggered++;
                        }
                    }
                    if (result.success) {
                        consecutiveToolFailures = 0;
                    } else {
                        consecutiveToolFailures++;
                        if (consecutiveToolFailures >= MAX_CONSECUTIVE_TOOL_FAILURES && !dedupAbort) {
                            log.warn(
                                `[${this.ts()}] [SAFETY-GUARD] type=consecutive_failures reason=failure_limit ` +
                                `value=${consecutiveToolFailures} threshold=${MAX_CONSECUTIVE_TOOL_FAILURES}`
                            );
                            loopMessages.push({
                                role: 'system',
                                content: `[FALHAS CONSECUTIVAS] ${consecutiveToolFailures} ferramentas falharam seguidas. Responda ao usuário com honestidade sobre essa limitação.`,
                            });
                            dedupAbort = true;
                            dedupAbortTool = 'consecutive_failures';
                            guardsTriggered++;
                        }
                    }

                    const terminalTools = ['send_audio', 'send_document', 'send_image', 'send_video'];
                    if (terminalTools.includes(toolName) && result.success) {
                        // JSON-action path is always a single tool call per step, so return immediately.
                        log.info(`[${this.ts()}] [TASK-FSM] Terminal atomic tool "${toolName}" succeeded → task DONE, returning result`);
                        move('FINAL_READY', { step: stepCount, tool: toolName, terminal: true });
                        traceManager.completeTrace(trace, 'completed', result.output);
                        this.persistTrace(trace, stepCount, 'completed', result.output, channelContext);
                        return result.output;
                    }

                    if (result.success && !this.isSafeExecCommand(toolName, atomicData.action?.input as Record<string, unknown> || {})) {
                        this.getTurnState(conversationId).lastToolExecution = { toolName, toolOutput: result.output, intent: intentDecision.intent, category: intentDecision.category };
                        void this.tryValidateTool(userText, intentDecision.intent, intentDecision.category, toolName, result.output, loopMessages, trace.id, conversationId);
                    }

                    move('TOOL_COMPLETED', { step: stepCount, tool: toolName, success: result.success });
                    continue;
                }
            }

            if (stepCount >= maxSteps) {
                log.warn(`[${this.ts()}] [STEP-LIMIT] step=${stepCount + 1} action=force_response`);
                break;
            }
        }

        this.logTurnDiagnostics({
            stepCount, executionMode, maxSteps, decisionCtx, getContextChars, initialContextChars,
            toolTypeCallCount, groupCallCount, cycleHistory, maxSameToolCalls: MAX_SAME_TOOL_CALLS,
            totalToolCalls, consecutiveToolFailures, toolFailureCount, totalThinkingChars,
            guardsTriggered, dedupAbortTool, memoryFirstInjected, toolFailureHintInjected,
            toolFailureHintFirstStep, toolSuccessHintInjected, toolSuccessHintFirstStep,
            observerFeedbackInjected, observerFeedbackFirstStep, reflectionHintInjected,
            intentCategory: intentDecision.category,
        });

        const deliveryGuardResult = await this.runDeliveryGuardPhase(
            conversationId, cycleHistory, loopMessages, toolDefs, chatProfile, turnSignal,
            trace, channelContext, usedToolInputs, maxSteps, stepCount, move,
        );
        if (deliveryGuardResult.earlyReturn) return deliveryGuardResult.result;
        stepCount = deliveryGuardResult.stepCount;

        // Post-loop synthesis
        const executedToolsInLastStep = cycleHistory.length > 0;
        const hasGoodContent = lastBestContent && lastBestContent.length > 100;

        if (executedToolsInLastStep && !hasGoodContent) {
            log.info(`[${this.ts()}] [SYNTHESIS] Tools executed but response is stale/brief (${lastBestContent?.length || 0} chars). Generating post-action synthesis...`);
            move('SYNTHESIS_REQUIRED', { step: stepCount, tools: cycleHistory.length });

            const toolSummary = cycleHistory.map(h => `• ${h.tool}: ${h.status}`).join('\n');
            const dedupSynthesisBody = (() => {
                const successTools = cycleHistory.filter(h => h.status === 'success').map(h => h.tool);
                const failedTools  = cycleHistory.filter(h => h.status === 'error').map(h => h.tool);
                const successLine  = successTools.length > 0 ? `Ferramentas que FUNCIONARAM: ${successTools.join(', ')}` : '';
                const failLine     = failedTools.length  > 0 ? `Ferramentas que FALHARAM: ${failedTools.join(', ')}` : '';
                return (
                    `ATENÇÃO: O loop foi interrompido porque a ferramenta "${dedupAbortTool}" foi chamada repetidamente.\n\n` +
                    `Resultado real das ações executadas:\n${toolSummary}\n\n` +
                    (successLine ? `${successLine}\n` : '') +
                    (failLine    ? `${failLine}\n`    : '') +
                    `\nIMPORTANTE: NÃO invente falhas para ferramentas listadas como "success" acima.\n` +
                    `Explique ao usuário: (1) o que foi executado com sucesso, (2) qual etapa ficou pendente e por quê, ` +
                    `(3) como prosseguir. Seja direto e honesto.`
                );
            })();
            // Distinguish info-retrieval tools from file-operation tools so the synthesis
            // instruction is context-appropriate: "present the data" vs "confirm changes".
            const INFO_TOOLS = new Set(['web_search', 'web_navigate', 'weather', 'crypto_analysis', 'memory_search', 'api_request']);
            const executedTools = new Set(cycleHistory.map(h => h.tool));
            const isInfoRetrieval = cycleHistory.length > 0 && [...executedTools].every(t => INFO_TOOLS.has(t));
            // For info-retrieval, always present collected data — even when dedup aborted.
            // dedupSynthesisBody is reserved for file/command loops where "how to proceed" makes sense.
            const infoRetrievalSynthesisBody = (() => {
                const failedTools = cycleHistory.filter(h => h.status === 'error');
                const base = `Você consultou as seguintes fontes:\n${toolSummary}\n\nApresente os dados/resultados das fontes que FUNCIONARAM diretamente ao usuário, como se estivesse respondendo uma pergunta. Não descreva o que você fez — apresente os dados em si.`;
                if (failedTools.length === 0) return base;
                return base + ` Para as fontes que falharam, explique brevemente o motivo. NÃO peça ao usuário para repetir ou especificar novamente o que já foi solicitado.`;
            })();
            const synthesisBody = isInfoRetrieval
                ? infoRetrievalSynthesisBody
                : dedupAbort
                    ? dedupSynthesisBody
                    : `Você executou as seguintes ações:\n${toolSummary}\n\nConfirme ao usuário O QUE foi realizado, com detalhes específicos. Não diga "vou fazer" — você JÁ fez.`;

            // Trim context for synthesis: the full step history (15+ tool rounds) causes the model
            // to produce massive thinking without content and time out at MAX_TIMEOUT (420s).
            // For info-retrieval, include ALL tool outputs (budget 2400 chars) so the LLM has actual
            // data to synthesize — not just the last result (which may be an error).
            // For other cases, include only the last tool output to keep context lean.
            const _synthLastUser = loopMessages.slice().reverse().find(m => m.role === 'user');
            const _synthLastTool = loopMessages.slice().reverse().find(m => m.role === 'tool');
            const synthToolMessages: LLMMessage[] = [];
            if (isInfoRetrieval) {
                const toolMsgs = loopMessages.filter(m => m.role === 'tool');
                let budgetLeft = 2400;
                for (const tm of toolMsgs) {
                    const content = (tm.content ?? '').slice(0, budgetLeft);
                    if (content.trim()) {
                        synthToolMessages.push({ role: 'tool' as const, content, tool_call_id: tm.tool_call_id });
                        budgetLeft -= content.length;
                    }
                    if (budgetLeft <= 0) break;
                }
            } else if (_synthLastTool) {
                synthToolMessages.push({
                    role: 'tool' as const,
                    content: (_synthLastTool.content ?? '').slice(0, 1200) +
                        ((_synthLastTool.content?.length ?? 0) > 1200 ? '\n...[truncated]' : ''),
                    tool_call_id: _synthLastTool.tool_call_id,
                });
            }
            const synthMessages: LLMMessage[] = [
                loopMessages[0],
                ...(_synthLastUser ? [_synthLastUser] : []),
                ...synthToolMessages,
                {
                    role: 'system' as const,
                    content: `SÍNTESE FINAL OBRIGATÓRIA — RESPONDA EM TEXTO PURO (NÃO use JSON, NÃO use formato action/thought):\n\n${synthesisBody}\n\nResponda DIRETAMENTE em linguagem natural.`,
                },
            ];

            move('LLM_REQUEST', { step: stepCount, phase: 'synthesis' });
            log.info(`[${this.ts()}] [SYNTHESIS] Trimmed context: ${loopMessages.length} → ${synthMessages.length} messages`);
            // Usa 'execution' profile (kimi-k2.6) em vez de chatProfile (glm-5.1) para síntese:
            // glm-5.1 com contexto grande produz apenas thinking sem content → chain-of-thought vaza para o usuário.
            const synthesisProfile = this.profileRegistry.getProfileByCategory('execution') ?? chatProfile;
            const synthesisResponse = await this.callLLMWithFallback(synthMessages, [], synthesisProfile, turnSignal);
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
                return await this.commitResponse(synthesisText, userText, trace.id, conversationId, turnSignal, toolFailureCount);
            }

            log.warn(`[${this.ts()}] [SYNTHESIS] Failed to extract useful text (raw=${rawSynthesis.length}, extracted=${synthesisText?.length || 0})`);
        }

        if (lastBestContent) {
            move('FINAL_READY', { step: stepCount, reason: 'last_best_content' });
            traceManager.completeTrace(trace, 'completed', lastBestContent);
            this.persistTrace(trace, stepCount, 'completed', lastBestContent, channelContext);
            return await this.commitResponse(lastBestContent, userText, trace.id, conversationId, turnSignal, toolFailureCount);
        }

        log.info(`[${this.ts()}] [FALLBACK] Generating final synthesis...`);
        move('SYNTHESIS_REQUIRED', { step: stepCount, reason: 'fallback' });
        // Same trim as post-loop synthesis to prevent thinking timeout on large contexts.
        // Include last tool output (truncated) so the model has real data to reference.
        const _fbLastUser = loopMessages.slice().reverse().find(m => m.role === 'user');
        const _fbLastTool = loopMessages.slice().reverse().find(m => m.role === 'tool');
        const fallbackSynthMessages: LLMMessage[] = [
            loopMessages[0],
            ...(_fbLastUser ? [_fbLastUser] : []),
            ...(_fbLastTool ? [{
                role: 'tool' as const,
                content: (_fbLastTool.content ?? '').slice(0, 1200) +
                    ((_fbLastTool.content?.length ?? 0) > 1200 ? '\n...[truncated]' : ''),
                tool_call_id: _fbLastTool.tool_call_id,
            }] : []),
            {
                role: 'system' as const,
                content: 'FINALIZAÇÃO OBRIGATÓRIA — RESPONDA EM TEXTO PURO (NÃO use JSON): Forneça uma resposta honesta agora. Se não obteve dados suficientes, admita a limitação claramente. Responda diretamente em linguagem natural.',
            },
        ];
        move('LLM_REQUEST', { step: stepCount, phase: 'fallback' });
        log.info(`[${this.ts()}] [FALLBACK] Trimmed context: ${loopMessages.length} → ${fallbackSynthMessages.length} messages`);
        const finalResponse = await this.callLLMWithFallback(fallbackSynthMessages, [], chatProfile, turnSignal);
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
        // If the final synthesis call also returned nothing useful, fall back to the
        // best content seen during the turn rather than sending a generic error.
        if ((!text || text === 'Desculpe, não consegui gerar uma resposta. Pode reformular a pergunta?') && lastBestContent) {
            log.warn(`[${this.ts()}] [FALLBACK] Final synthesis empty — using lastBestContent (${lastBestContent.length} chars)`);
            text = lastBestContent;
        }

        move('FINAL_READY', { step: stepCount, reason: stepCount >= maxSteps ? 'max_iterations' : 'fallback' });
        traceManager.completeTrace(trace, stepCount >= maxSteps ? 'max_iterations' : 'completed', text);
        this.persistTrace(trace, stepCount, stepCount >= maxSteps ? 'max_iterations' : 'completed', text, channelContext);
        this.activeTurns.delete(conversationId);

        return await this.commitResponse(text, userText, trace.id, conversationId, turnSignal, toolFailureCount);

        } catch (fsmError) {
            // Only FSM violations (invalid transitions) reach here — all other errors are handled
            // inside the loop and returned normally. Close the trace so it doesn't leak in the Map.
            if (trace.status === 'running') {
                log.error(`[${this.ts()}] [FSM-ERROR] Invalid FSM state — aborting turn: ${errorMessage(fsmError)}`);
                // Sprint 0.8 (achado L06, Sprint 0.7 Gate A): esta limpeza precisa da mesma
                // proteção do finally logo abaixo — sem o try/catch aqui, uma falha em
                // completeTrace()/persistTrace() (ex: listener SSE do dashboard lançando ao
                // escrever numa conexão já fechada) substitui fsmError pelo erro de limpeza
                // antes mesmo de `throw fsmError` ser alcançado, mascarando a causa real do
                // erro. Comprovado com teste dinâmico real (S83).
                try {
                    traceManager.completeTrace(trace, 'error', 'Erro interno de estado');
                    this.persistTrace(trace, 0, 'error', 'Erro interno de estado', channelContext);
                } catch (cleanupError) {
                    log.warn(`[${this.ts()}] [TRACE-CLEANUP-FAILED] trace=${trace.id} ${errorMessage(cleanupError)}`);
                }
            }
            throw fsmError;
        } finally {
            // Sprint 0.6, Front C: rede de segurança do lifecycle do trace. O catch acima só
            // intercepta EXCEÇÕES (fsmError) — mas vários `return` normais dentro do try (ex:
            // "sessionContext not set", pedido de autorização needs_auth, cancelamentos em
            // fases de delivery/síntese/fallback) não passam por nenhum dos completeTrace(...)
            // já existentes acima, deixando o trace ativo no Map para sempre (achado "Unbounded
            // active trace memory leak" já autodiagnosticado pelo AuditorService). Se o catch já
            // fechou o trace (exceção real), completeTrace() já removeu do Map ativo — o guard
            // getActiveTrace() abaixo simplesmente não dispara de novo (sem dupla finalização).
            // Nunca deixa uma falha de limpeza mascarar a exceção causal original: erro aqui só
            // é logado, nunca relançado.
            try {
                if (traceManager.getActiveTrace(trace.id)) {
                    const closedByCancel = turnSignal.aborted;
                    // 'completed' (não 'error'): por construção, só chegamos aqui quando a
                    // função saiu por um `return` normal sem exceção — o turno produziu uma
                    // resposta válida (ex: pedido de autorização, mensagem de indisponibilidade),
                    // não um erro. Rotular como 'error' seria telemetria falsa. 'cancelled'
                    // quando o turnSignal foi abortado, mesmo critério já usado no único
                    // cancelamento hoje tratado corretamente (linha ~1569 desta função).
                    const status = closedByCancel ? 'cancelled' : 'completed';
                    const note = closedByCancel
                        ? 'Operação cancelada.'
                        : 'Turno concluído (fechado pela rede de segurança do lifecycle — ver Sprint 0.6 Front C).';
                    traceManager.completeTrace(trace, status, note);
                    if (!closedByCancel) {
                        this.persistTrace(trace, 0, status, note, channelContext);
                    }
                }
            } catch (cleanupError) {
                log.warn(`[${this.ts()}] [TRACE-CLEANUP-FAILED] trace=${trace.id} ${errorMessage(cleanupError)}`);
            }
        }
    }
}
