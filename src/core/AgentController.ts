/**
 * AgentController — Facade principal do NewClaw
 *
 * Orquestra: ChannelAdapter → MessageBus → AgentLoop → ChannelAdapter
 * Arquitetura multi-canal: Telegram ✅, Discord 🟡, Web
 */

import Database from 'better-sqlite3';
import { ProviderFactory } from './ProviderFactory';
import { ModelRegistryService } from './ModelRegistryService';
import { AgentLoop } from '../loop/AgentLoop';
import type { ChannelContext } from '../loop/agentLoopTypes';
import { MemoryManager } from '../memory/MemoryManager';
import type { MemoryFacade } from '../memory/MemoryFacade';
import { SkillLoader } from '../skills/SkillLoader';
import { SkillLearner } from '../loop/SkillLearner';
import { ExecCommandTool } from '../tools/exec_command';
import { WebSearchTool } from '../tools/web_search';
import { powerpointControlTool } from '../tools/powerpoint_control';
import { WebNavigateTool } from '../tools/web_navigate';
import { WriteTool } from '../tools/write_tool';
import { EditTool } from '../tools/edit_tool';
import { ReadTool } from '../tools/read_tool';
import { MemorySearchTool } from '../tools/memory_search';
import { MemoryWriteTool } from '../tools/memory_write';
import { ReadDocumentTool } from '../tools/read_document';
import { ListWorkspaceTool } from '../tools/list_workspace';
import { RefreshWorkspaceTool } from '../tools/refresh_workspace';
import { AnalyzeWorkspaceGroupsTool } from '../tools/analyze_workspace_groups';
import { OrganizeWorkspaceTool } from '../tools/organize_workspace';
import { SendAudioTool } from '../tools/send_audio';
import { SendDocumentTool } from '../tools/send_document';
import { MemoryAdminTool } from '../tools/memory_admin';
import { CryptoAnalysisTool } from '../tools/crypto_analysis';
import { SshExecTool } from '../tools/ssh_exec';
import { WeatherTool } from '../tools/weather';
import { ToolRegistry } from './ToolRegistry';
import { SessionManager } from '../session/SessionManager';
import { composeSessionKey } from '../session/SessionKeyFactory';
import { SessionContext } from '../session/SessionContext';
import { ClassificationMemory } from '../memory/ClassificationMemory';
import { DecisionMemory } from '../memory/DecisionMemory';
import { SchedulerService } from '../services/SchedulerService';
import { ScheduleTool } from '../tools/schedule_tool';
import { SessionLearner } from '../session/SessionLearner';
import { MemoryGovernor } from '../memory/MemoryGovernor';
import { createLogger } from '../shared/AppLogger';
import { MessageBus } from '../channels/MessageBus';
import type { ChannelAdapter, ChannelType } from '../channels/ChannelAdapter';
import type { WorkflowCallbackFn } from '../loop/WorkflowTypes';
import { WebChannelAdapter } from '../channels/WebChannelAdapter';
import { TelegramAdapter } from '../channels/TelegramAdapter';
import { DiscordAdapter } from '../channels/DiscordAdapter';
import { WhatsAppAdapter } from '../channels/WhatsAppAdapter';
import { SignalAdapter } from '../channels/SignalAdapter';
import { AuditorService } from '../services/auditor/AuditorService';
import { eventBus, EventTypes, type AppEvent } from './EventBus';
import { circuitRegistry } from './CircuitBreaker';
import { promptRegistry } from './PromptRegistry';
import { ConfidenceClassifier } from './ConfidenceClassifier';
import { SessionAutoCleaner } from '../session/SessionAutoCleaner';
import { MemoryCurator } from '../memory/MemoryCurator';
import { LifecycleManager } from './LifecycleManager';
import { getEventLoopMonitor } from '../shared/EventLoopMonitor';
import type { NewClawConfig } from './agentControllerTypes';
import { openDatabase, buildLanguageDirective, buildSystemPrompt } from './agentControllerSetup';
import { OwnerProfileService } from '../services/OwnerProfileService';
import { OnboardingService } from '../services/OnboardingService';
import { bootstrapDomains, createDomainClassifierLLM } from '../memory/DomainRegistry';
import { WorkflowEngine } from '../loop/WorkflowEngine';
import { GoalOrchestrator } from '../loop/GoalOrchestrator';
import { GoalStore } from '../loop/GoalStore';
import { getBackgroundQueue } from '../loop/BackgroundCognitionQueue';
import { registerCommands } from './agentControllerCommands';
import {
    transcribeAttachment,
    handleDocumentAttachment,
    handlePhotoAttachment,
    refreshWorkspaceIndex,
} from './agentMediaHandlers';

export type { NewClawConfig };

const log = createLogger('AgentController');

export class AgentController {
    private config: NewClawConfig;
    private agentLoop: AgentLoop;
    private workflowEngine!: WorkflowEngine;
    private goalOrchestrator!: GoalOrchestrator;
    private goalStore!: GoalStore;
    private providerFactory: ProviderFactory;
    private modelRegistryService: ModelRegistryService;
    private memory: MemoryManager;
    private memoryFacade: MemoryFacade;
    private lifecycle = new LifecycleManager();
    private skillLoader: SkillLoader;
    private skillLearner: SkillLearner;
    private sessionManager: SessionManager;
    private sessionLearner: SessionLearner;
    private memoryGovernor: MemoryGovernor;
    private scheduler: SchedulerService;
    private messageBus: MessageBus;
    private _eventBus = eventBus;
    private circuitBreakers = circuitRegistry;
    private auditor!: AuditorService;
    private db!: Database.Database;
    private sessionAutoCleaner: SessionAutoCleaner;
    private memoryCurator: MemoryCurator;
    private confidenceClassifier: ConfidenceClassifier;
    private ownerProfileService: OwnerProfileService;
    private telegramAdapter: TelegramAdapter | null = null;
    private webAdapter: WebChannelAdapter;
    private discordAdapter: DiscordAdapter | null = null;
    private whatsAppAdapter: WhatsAppAdapter | null = null;
    private signalAdapter: SignalAdapter | null = null;
    private eventBusUnsubscribe: (() => void) | null = null;

    public getMemory(): MemoryManager { return this.memory; }
    public getSkillLearner(): SkillLearner { return this.skillLearner; }
    public getProviderFactory(): ProviderFactory { return this.providerFactory; }
    public getModelRegistryService(): ModelRegistryService { return this.modelRegistryService; }
    public getMemoryGovernor(): MemoryGovernor { return this.memoryGovernor; }
    public getSessionLearner(): SessionLearner { return this.sessionLearner; }
    public getMessageBus(): MessageBus { return this.messageBus; }
    public getWebAdapter(): WebChannelAdapter { return this.webAdapter; }
    public getEventBus() { return this._eventBus; }
    public getCircuitBreakers() { return this.circuitBreakers; }
    public getTelegramAdapter(): TelegramAdapter | null { return this.telegramAdapter; }
    public getDiscordAdapter(): DiscordAdapter | null { return this.discordAdapter; }
    public getWhatsAppAdapter(): WhatsAppAdapter | null { return this.whatsAppAdapter; }
    public getSignalAdapter(): SignalAdapter | null { return this.signalAdapter; }
    public getConfidenceClassifier(): ConfidenceClassifier { return this.confidenceClassifier; }
    public getSessionAutoCleaner(): SessionAutoCleaner { return this.sessionAutoCleaner; }
    public getMemoryCurator(): MemoryCurator { return this.memoryCurator; }
    public getOwnerProfileService(): OwnerProfileService { return this.ownerProfileService; }
    public getCircuitBreakerStates() { return circuitRegistry.getAllMetrics(); }
    public getPromptRegistry() { return promptRegistry; }

    constructor(config: NewClawConfig) {
        this.config = config;

        const dbPath = './data/newclaw.db';
        this.db = openDatabase(dbPath);

        // WorkflowEngine com SQLite — sobrevive a restart, sem transações zumbi
        this.workflowEngine = new WorkflowEngine(this.db);

        // GoalStore: tabela goals no mesmo SQLite
        this.goalStore = new GoalStore(this.db);
        // ITEM6: detecta goals em estado não-terminal deixados por shutdown anterior
        const orphanedGoals = this.goalStore.getAllActive();
        log.info(
            `[GOAL-RECOVERY] count=${orphanedGoals.length}` +
            ` goal_ids="${orphanedGoals.map(g => g.id).join(',') || '(none)'}"` +
            ` statuses="${orphanedGoals.map(g => g.status).join(',') || '(none)'}"` +
            ` recovered=false`
        );

        this.memory = new MemoryManager(this.db, config.ollamaUrl);
        this.memoryFacade = this.memory.getFacade();
        bootstrapDomains(this.memory);

        // Build workspace index at startup so the model always has an up-to-date tree
        refreshWorkspaceIndex(this.memory);

        this.ownerProfileService = new OwnerProfileService(this.db);
        if (config.ownerName) {
            this.ownerProfileService.initFromEnv(
                config.ownerName,
                config.ownerUserId || '',
                config.ownerLocked ?? false
            );
        }
        this.providerFactory = new ProviderFactory({
            geminiKey: config.geminiApiKey,
            deepseekKey: config.deepseekApiKey,
            groqKey: config.groqApiKey,
            openrouterKey: config.openrouterApiKey,
            anthropicKey: config.anthropicApiKey,
            ollamaUrl: config.ollamaUrl,
            ollamaModel: config.ollamaModel,
            ollamaApiKey: config.ollamaApiKey,
            defaultProvider: config.defaultProvider
        });
        this.modelRegistryService = new ModelRegistryService(this.providerFactory, () => this.config.customProviders || []);

        this.skillLoader = new SkillLoader(config.skillsDir);
        this.skillLearner = new SkillLearner(this.db, config.skillsDir);

        const languageDirective = buildLanguageDirective(config.language);
        const ownerName = this.ownerProfileService.getOwnerName() || config.ownerName || undefined;
        // Busca apelido preferido do usuário (definido no onboarding) para personalizar o agente
        // Query nickname com fallback — a coluna pode não existir se o DB foi
        // criado antes do OnboardingService rodar sua migration (ex.: primeiro boot
        // com dist desatualizado). O try/catch evita crash fatal no startup.
        let ownerNickname: string | undefined;
        try {
            ownerNickname = (this.db.prepare(
                'SELECT nickname FROM user_profile WHERE onboarding_completed = 1 LIMIT 1'
            ).get() as { nickname: string | null } | undefined)?.nickname || undefined;
        } catch {
            // coluna nickname ainda não existe — OnboardingService criará na sequência
        }
        const systemPrompt = config.systemPrompt || buildSystemPrompt(this.skillLoader, ownerName, ownerNickname);

        const classificationMemory = new ClassificationMemory(this.db);
        const decisionMemory = new DecisionMemory(this.db);

        this.agentLoop = new AgentLoop(
            this.providerFactory,
            this.memory,
            { languageDirective, systemPrompt, modelRouter: config.modelRouter },
            this.skillLearner,
            this.skillLoader,
            classificationMemory,
            decisionMemory
        );

        // Fase 2: injetar WorkflowEngine no loop (habilita callbacks estruturados)
        // Guard: detecta dist/ desatualizado (build parcial ou git pull sem rebuild).
        // Se setWorkflowEngine não existir, o AgentLoop.js no dist é de uma versão antiga.
        if (typeof (this.agentLoop as any).setWorkflowEngine !== 'function') {
            throw new Error(
                '\n[FATAL] dist/ desatualizado — AgentLoop.setWorkflowEngine não existe.\n' +
                'O dist/ foi compilado de uma versão mais antiga que o AgentController.\n' +
                'Solução: npm run build && pm2 restart newclaw\n'
            );
        }
        this.agentLoop.setWorkflowEngine(this.workflowEngine);


        this.sessionManager = new SessionManager(
            { transcriptDir: './data/sessions' },
            this.memory,
            this.providerFactory
        );

        const sessionContext = new SessionContext(this.sessionManager, this.memory);
        this.agentLoop.setSessionContext(sessionContext);

        // Classificação de domínio de memória via LLM (substitui o keyword-scoring de
        // DomainRegistry.classifyDomain() por julgamento semântico real — ver
        // project_session_bugs_jul2026_ai.md parte 6). Usa o mesmo modelo leve/rápido já
        // configurado para classificação (GoalExtractor/ModelProfileRegistry), evitando latência
        // extra desnecessária. Só é possível aqui porque ContextBuilder.buildContext() já é
        // async — outros pontos de classifyDomain() (ex: MemoryManager.addNode(), síncrono,
        // chamado 36x em 12 arquivos) continuam usando o regex diretamente (decisão consciente,
        // não um esquecimento).
        sessionContext.getContextBuilder().setDomainClassifierLLM(
            createDomainClassifierLLM(this.providerFactory, this.agentLoop.getClassifierModel())
        );

        this.sessionLearner = new SessionLearner(this.sessionManager, this.memory);

        this.scheduler = new SchedulerService(dbPath, this.db);

        this.memoryGovernor = new MemoryGovernor(this.memory, {
            decayFactor: 0.98,
            minConfidence: 0.3,
            staleAfterDays: 7,
            usefulBoost: 0.05,
            notUsefulPenalty: 0.02,
            maxConfidence: 0.95,
            diminishingReturns: true,
            protectedNodes: ['core_user', 'user_identity'],
            archiveEnabled: true
        });

        this.messageBus = new MessageBus(this.agentLoop, this.sessionManager);

        // OnboardingService: apresentação única na primeira instalação (banco vazio)
        const onboardingService = new OnboardingService(
            this.db,
            this.memory,
            this.ownerProfileService
        );
        this.messageBus.setOnboardingService(onboardingService);

        // GoalOrchestrator: intercepta mensagens de goal antes do AgentLoop
        this.goalOrchestrator = new GoalOrchestrator(this.agentLoop, this.providerFactory, this.goalStore, this.memory);
        this.goalOrchestrator.setSessionManager(this.sessionManager);
        this.goalOrchestrator.setWorkflowEngine(this.workflowEngine);
        this.messageBus.setGoalOrchestrator(this.goalOrchestrator);
        this.agentLoop.setGoalOrchestrator(this.goalOrchestrator);

        this.auditor = new AuditorService({
            ollamaUrl: config.ollamaUrl || 'http://localhost:11434',
            model: config.ollamaModel || 'glm-5.2:cloud',
            dbPath: './data/newclaw.db',
            srcPath: './src',
            logsPath: './logs',
            ownerChatId: config.telegramAllowedUserIds[0] || '',
            maxFindingsPerCategory: 20,
        }, this.db);

        registerCommands(this.messageBus, this.memory, this.memoryFacade, this.sessionManager, this.auditor, this.config, this.agentLoop);

        eventBus.on('circuit:open', (data) => {
            log.warn(`[CircuitBreaker] ${data.name} OPEN — ${data.failures}/${data.threshold} failures`);
        });
        eventBus.on('circuit:closed', (data) => {
            log.info(`[CircuitBreaker] ${data.name} CLOSED — ${data.successes} consecutive successes`);
        });

        this.confidenceClassifier = new ConfidenceClassifier();

        promptRegistry.load();
        log.info(`   PromptRegistry: ${JSON.stringify(promptRegistry.getStats())}`);

        this.sessionAutoCleaner = new SessionAutoCleaner(this.sessionManager, {
            transcriptDir: './data/sessions',
        });

        // Sprint 0.6, Front D: reaproveita a ReflectionMemory já construída dentro do
        // AgentLoop para que enforceStorageQuotas() também agende reflectionMemory.prune()
        // (antes: reflection_annotations crescia sem limite, prune() nunca era chamado).
        this.memoryCurator = new MemoryCurator(this.memory, undefined, this.agentLoop.getReflectionMemory());

        if (config.telegramBotToken) {
            this.telegramAdapter = new TelegramAdapter({
                enabled: true,
                botToken: config.telegramBotToken,
                allowedUserIds: config.telegramAllowedUserIds,
                tmpDir: config.tmpDir,
            });
            this.telegramAdapter.setBus(this.messageBus);
            this.messageBus.registerAdapter(this.telegramAdapter);

            // Fase 2: injetar workflowCallback nos adapters de canal.
            // Callbacks "auth:approve|reject:<txnId>" chegam aqui diretamente,
            // sem passar pelo MessageBus nem pelo pipeline LLM — é uma ação de UI
            // (clique de botão), não uma mensagem de chat a ser interpretada pelo LLM.
            this.telegramAdapter.workflowCallback = this.createWorkflowCallback(this.telegramAdapter, 'telegram');
            log.info('Telegram adapter registered');
        }

        // Dashboard web (localhost:3090) é apenas mais um canal — mesmo pipeline
        // (NormalizedMessage → ChannelAttachment[] → agentMediaHandlers) do Telegram/Discord/etc.
        this.webAdapter = new WebChannelAdapter();
        this.messageBus.registerAdapter(this.webAdapter);

        const { tmpDir } = config;
        this.messageBus.registerMediaHandler('voice', async (msg, attachment) =>
            transcribeAttachment(msg, attachment, this.messageBus, tmpDir));
        this.messageBus.registerMediaHandler('audio', async (msg, attachment) =>
            transcribeAttachment(msg, attachment, this.messageBus, tmpDir));
        this.messageBus.registerMediaHandler('document', async (msg, attachment) => {
            const profile = this.agentLoop.getProfileRegistry().getProfileByCategory('vision');
            return handleDocumentAttachment(msg, attachment, this.messageBus, this.memory, profile ?? null, this.providerFactory);
        });
        this.messageBus.registerMediaHandler('photo', async (msg, attachment) => {
            const profile = this.agentLoop.getProfileRegistry().getProfileByCategory('vision');
            return handlePhotoAttachment(msg, attachment, this.messageBus, profile ?? null, this.providerFactory);
        });

        if (config.discordBotToken) {
            this.discordAdapter = new DiscordAdapter({
                enabled: true,
                botToken: config.discordBotToken,
                allowedGuildIds: config.discordAllowedGuildIds,
                allowedUserIds: config.discordAllowedUserIds,
            });
            this.discordAdapter.setBus(this.messageBus);
            this.messageBus.registerAdapter(this.discordAdapter);
            this.discordAdapter.workflowCallback = this.createWorkflowCallback(this.discordAdapter, 'discord');
            log.info('Discord adapter registered');
        }

        if (config.whatsappPhoneNumber) {
            this.whatsAppAdapter = new WhatsAppAdapter({
                enabled: true,
                phoneNumber: config.whatsappPhoneNumber,
                allowedJids: config.whatsappAllowedJids,
                authDir: config.whatsappAuthDir || './data/whatsapp-auth',
            });
            this.whatsAppAdapter.setBus(this.messageBus);
            this.messageBus.registerAdapter(this.whatsAppAdapter);
            this.whatsAppAdapter.workflowCallback = this.createWorkflowCallback(this.whatsAppAdapter, 'whatsapp');
            log.info('WhatsApp adapter registered');
        }

        if (config.signalPhoneNumber) {
            this.signalAdapter = new SignalAdapter({
                enabled: true,
                phoneNumber: config.signalPhoneNumber,
                allowedNumbers: config.signalAllowedNumbers,
                signalCliPath: config.signalCliPath || 'signal-cli',
            });
            this.signalAdapter.setBus(this.messageBus);
            this.messageBus.registerAdapter(this.signalAdapter);
            // Signal não renderiza markdown — respostas em texto puro.
            this.signalAdapter.workflowCallback = this.createWorkflowCallback(this.signalAdapter, 'signal', 'plain');
            log.info('Signal adapter registered');
        }

        this.scheduler.setTriggerHandler(async (task) => {
            try {
                const chatId = task.chat_id;
                let prompt = '';
                if (task.action_type === 'weather') {
                    const params = JSON.parse(task.action_params || '{}');
                    // Sem cidade hardcoded aqui: um default fixo funcionaria só para quem
                    // configurou este deploy especificamente, quebrando para qualquer outro
                    // usuário do projeto (open source, qualquer pessoa pode rodar sua própria
                    // instância). Quando params.city vier vazio, o prompt agendado passa pela
                    // mesma pipeline de um turno normal — que já consulta a memória do usuário
                    // (ContextBuilder/MultiLayerRetriever) por uma preferência de cidade padrão
                    // salva, ou pergunta se não houver nenhuma.
                    prompt = params.city
                        ? `[AGENDADO] Envie a previsão do tempo para ${params.city}. Seja conciso.`
                        : `[AGENDADO] Envie a previsão do tempo. Se houver uma cidade padrão salva na memória do usuário, use-a; caso contrário, pergunte qual cidade. Seja conciso.`;
                } else if (task.action_type === 'crypto') {
                    prompt = `[AGENDADO] Envie cotações atuais de criptomoedas (BTC e ETH). Preço em USD + variação 24h. Seja conciso.`;
                } else {
                    const params = JSON.parse(task.action_params || '{}');
                    prompt = `[AGENDADO] ${params.message || task.label}`;
                }
                log.info(`[Scheduler] Triggering task #${task.id}: ${task.label} → chat ${chatId} (${task.channel})`);
                this._eventBus.emitAppEvent({
                    type: EventTypes.SCHEDULER_TRIGGER,
                    payload: { chatId, channel: task.channel || 'telegram', prompt, taskId: task.id, actionType: task.action_type, label: task.label },
                    source: 'scheduler',
                    correlationId: `scheduler-${task.id}`,
                });
            } catch (e) {
                log.error(`[Scheduler] Failed to emit scheduled event:`, e);
                this._eventBus.emitAppEvent({
                    type: EventTypes.SCHEDULER_FAILED,
                    payload: { taskId: task.id, error: String(e) },
                    source: 'scheduler',
                });
            }
        });

        this.eventBusUnsubscribe = this._eventBus.onAny(async (event: AppEvent) => {
            if (event.type !== EventTypes.SCHEDULER_TRIGGER) return;
            try {
                const { chatId, channel, prompt, taskId } = event.payload as {
                    chatId: string; channel: string; prompt: string; taskId: number; actionType: string; label: string;
                };
                log.info(`[EVENTBUS] Processing scheduler.trigger #${taskId} → chat ${chatId} (${channel})`);
                // BUG REAL (microauditoria de continuidade conversacional, 2026-07-08): antes
                // desta correção, process() era chamado SEM ChannelContext — o AgentLoop então
                // caía no fallback 'telegram' pra montar a sessionKey (ver AgentLoop.ts), então
                // um agendamento em qualquer canal != telegram (channel é uma coluna real por
                // tarefa — ver SchedulerService.ts, suporta discord/signal/whatsapp/web) lia e
                // gravava o histórico da conversa sob a identidade ERRADA (telegram:chatId em
                // vez de <canal real>:chatId), quebrando a continuidade do próprio agendamento
                // e arriscando poluir a sessão humana real de outro canal caso o chatId colida.
                // A entrega final (sendToChat abaixo) já usava o channel real corretamente —
                // essa era exatamente a assimetria leitura/escrita que a auditoria pediu pra achar.
                const schedulerContext: ChannelContext = { channel, chatId, userId: chatId, correlationId: event.correlationId };
                const result = await this.agentLoop.process(chatId, prompt, chatId, schedulerContext);
                await this.messageBus.sendToChat(channel as import('../channels/ChannelAdapter').ChannelType, chatId, {
                    text: typeof result === 'string' ? result : result.text,
                    format: 'markdown',
                    options: typeof result === 'string' ? undefined : result.options
                });
                this._eventBus.emitAppEvent({
                    type: EventTypes.SCHEDULER_COMPLETED,
                    payload: { taskId, chatId },
                    source: 'agent',
                    correlationId: event.correlationId,
                });
            } catch (e) {
                log.error(`[EVENTBUS] scheduler.trigger handler failed:`, e);
            }
        });

        this.lifecycle.registerTimeout('scheduler.startAll', () => this.scheduler.startAll(), 5000);
        this.lifecycle.registerService('memory', () => this.memory.close());
        this.lifecycle.registerService('memoryCurator', () => this.memoryCurator.stopAutoCurate());
        this.lifecycle.registerService('sessions', () => this.sessionManager.closeAll());
        this.lifecycle.registerService('sessionAutoCleaner', () => this.sessionAutoCleaner.stop());
        this.lifecycle.registerService('scheduler', () => this.scheduler.stopAll());
        this.lifecycle.registerService('messageBus', () => this.messageBus.stopAll());
        this.lifecycle.registerService('eventLoopMonitor', () => getEventLoopMonitor().stop());

        this.registerSkills();
    }

    async start(): Promise<void> {
        log.info('🚀 NewClaw starting...');
        log.info(`   Provider: ${this.providerFactory.getDefaultProvider()}`);
        log.info(`   Available: ${this.providerFactory.getAvailableProviders().join(', ')}`);
        log.info(`   Language: ${this.config.language}`);
        log.info(`   Skills: ${this.skillLoader.getSkillNames().join(', ') || 'none'}`);

        const channels = this.messageBus.listAdapters();
        for (const ch of channels) {
            log.info(`   Channel: ${ch.name} (${ch.connected ? 'connected' : 'not connected'})`);
        }

        try {
            const stats = this.memoryGovernor.runGovernanceCycle();
            log.info(`Boot cycle: ${stats.nodesDecayed} decayed, ${stats.conflictsDetected} conflicts, ${stats.nodesGarbageCollected} GC'd`);
        } catch (err) {
            log.warn('Boot cycle failed:', (err as Error).message);
        }

        this.lifecycle.registerInterval('memory.governance.daily', () => {
            try {
                const stats = this.memoryGovernor.runGovernanceCycle();
                log.info(`Daily cycle: ${JSON.stringify(stats)}`);
            } catch (err) {
                log.warn('Daily cycle failed:', (err as Error).message);
            }
        }, 24 * 60 * 60 * 1000);

        await this.messageBus.startAll();

        this.lifecycle.registerInterval('sessions.cleanup', async () => {
            try {
                await this.sessionManager.cleanupInactiveSessions(900_000);
            } catch (e) {
                log.error('periodic_cleanup_failed', e);
            }
        }, 300_000);

        this.sessionAutoCleaner.start();
        this.memoryCurator.startAutoCurate();

        // ── Cognição pós-turno (fire-and-forget) ─────────────────────────────────
        // Após cada resposta entregue, enfileira tarefas de cognição de baixa prioridade.
        // CognitiveReflectionEngine.runReflectionCycle() tem throttle 24h interno —
        // mesmo chamada a cada turno, só executa uma vez por dia.
        const bgQueue = getBackgroundQueue();
        const memGovernor = this.memoryGovernor;
        this.agentLoop.setPostTurnCallback(() => {
            bgQueue.enqueue({
                type: 'cognitive_reflection',
                createdAt: Date.now(),
                timeoutMs: 10_000,
                run: async () => {
                    memGovernor.runGovernanceCycle();
                },
            });
        });

        this.lifecycle.registerInterval('promptHotReload', () => {
            promptRegistry.reloadIfChanged();
        }, 5 * 60_000);

        this.lifecycle.registerInterval('circuitBreakerMonitor', () => {
            const states = circuitRegistry.getAllMetrics();
            for (const cb of states) {
                if (cb.state !== 'closed') {
                    log.warn(`[CircuitBreaker] ${cb.providerName} state=${cb.state} failures=${cb.totalFailures}`);
                }
            }
        }, 60_000);

        this.lifecycle.registerInterval('workflowPurge', () => {
            const removed = this.workflowEngine.purgeExpired();
            if (removed > 0) log.info(`[WF] periodic purge removed=${removed}`);
        }, 60_000);

        log.info('✅ NewClaw running — multi-channel pipeline active');
        log.info('   Modules: EventBus ✅ | CircuitBreaker ✅ | ConfidenceClassifier ✅ | PromptRegistry ✅ | SessionAutoCleaner ✅');
    }

    async stop(reason: string = 'shutdown'): Promise<void> {
        if (this.eventBusUnsubscribe) {
            this.eventBusUnsubscribe();
            this.eventBusUnsubscribe = null;
        }
        // ITEM6: loga goals ativos antes de desligar para detectar perda de estado
        try {
            const activeGoals = this.goalStore.getAllActive();
            log.info(
                `[SHUTDOWN-ACTIVE-GOALS] count=${activeGoals.length}` +
                ` goal_ids="${activeGoals.map(g => g.id).join(',') || '(none)'}"` +
                ` statuses="${activeGoals.map(g => g.status).join(',') || '(none)'}"` +
                ` sessions="${activeGoals.map(g => g.sessionKey).join(',') || '(none)'}"` +
                ` reason=${reason}`
            );
        } catch {
            // GoalStore pode já ter sido destruído; ignorar
        }
        await this.lifecycle.shutdown(reason);
        log.info('NewClaw stopped');
    }

    /**
     * Fábrica compartilhada do workflowCallback injetado em cada ChannelAdapter — resume uma
     * transação de autorização pendente (aprovação/rejeição de ferramenta perigosa) e envia a
     * resposta de volta ao canal de origem. Único ponto de implementação para Telegram/Discord/
     * WhatsApp/Signal (antes duplicado 4x, um bloco quase idêntico por canal).
     */
    private createWorkflowCallback(adapter: ChannelAdapter, channel: ChannelType, format: 'markdown' | 'plain' = 'markdown'): WorkflowCallbackFn {
        return async (userId, txnId, decision, rawCtx) => {
            log.info(`[WF] ${channel} callback userId=${userId} txn=${txnId} decision=${decision}`);
            const sessionKey = { channel, userId };
            const sid = composeSessionKey(sessionKey);

            await this.sessionManager.withMutex(sid, async () => {
                const result = await this.workflowEngine.resume(txnId, decision, (name) => ToolRegistry.get(name));
                if (!result) {
                    await adapter.send({ text: '⚠️ Sessão de autorização expirada. Repita o comando.', format: 'plain' }, rawCtx);
                    return;
                }

                // Se há um goal aguardando esta transação, retoma ou aborta conforme a decisão
                const pendingGoal = this.goalOrchestrator.getGoalStore().getByTxnId(txnId);
                if (pendingGoal) {
                    const responseText = decision === 'rejected'
                        ? await this.goalOrchestrator.abortGoalFromAuth(txnId)
                        : await this.goalOrchestrator.resumeFromAuth(txnId, result.output ?? '', result.artifactPaths);
                    await adapter.send({ text: responseText, format }, rawCtx);
                    await this.sessionManager.recordAssistantMessage(sessionKey, responseText, { model: 'workflow' }).catch(err =>
                        log.error('[WF] record_auth_response_failed', err)
                    );
                    return;
                }

                const responseText = await this.agentLoop.resumeFromWorkflow(userId, result);
                await adapter.send({ text: responseText, format }, rawCtx);
                await this.sessionManager.recordAssistantMessage(sessionKey, responseText, { model: 'workflow' }).catch(err =>
                    log.error('[WF] record_workflow_response_failed', err)
                );
            });
        };
    }

    private registerSkills(): void {
        ToolRegistry.register(powerpointControlTool);
        ToolRegistry.register(new ExecCommandTool(), { dangerous: true });
        ToolRegistry.register(new WebSearchTool());
        ToolRegistry.register(new WebNavigateTool());
        ToolRegistry.register(new WriteTool());
        ToolRegistry.register(new EditTool());
        ToolRegistry.register(new ReadTool());
        ToolRegistry.register(new MemorySearchTool(this.memory));
        const memoryWriteTool = new MemoryWriteTool(this.memory, this.ownerProfileService);
        // Mesma classificação de domínio via LLM injetada no ContextBuilder acima — ver
        // project_session_bugs_jul2026_ai.md parte 6.
        memoryWriteTool.setDomainClassifierLLM(
            createDomainClassifierLLM(this.providerFactory, this.agentLoop.getClassifierModel())
        );
        ToolRegistry.register(memoryWriteTool);
        ToolRegistry.register(new ReadDocumentTool(this.providerFactory, this.agentLoop.getProfileRegistry()));
        ToolRegistry.register(new ListWorkspaceTool());
        ToolRegistry.register(new RefreshWorkspaceTool(this.memory));
        ToolRegistry.register(new AnalyzeWorkspaceGroupsTool(this.db));
        ToolRegistry.register(new OrganizeWorkspaceTool(this.db, this.memory));
        ToolRegistry.register(new SendAudioTool(this.messageBus));
        ToolRegistry.register(new SendDocumentTool(this.messageBus));
        ToolRegistry.register(new MemoryAdminTool(this.memory));
        ToolRegistry.register(new SshExecTool(), { dangerous: true });
        ToolRegistry.register(new CryptoAnalysisTool());
        ToolRegistry.register(new WeatherTool());
        ToolRegistry.register(new ScheduleTool(this.scheduler));

        for (const tool of ToolRegistry.getEnabled()) {
            this.agentLoop.registerTool(tool);
        }

        log.info(`   Tools: ${ToolRegistry.getStatus().map(t => `${t.name}${t.dangerous ? '⚠️' : ''}${t.enabled ? '' : '❌'}`).join(', ')}`);
    }
}
