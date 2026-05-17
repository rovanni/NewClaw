/**
 * AgentController — Facade principal do NewClaw
 *
 * Orquestra: ChannelAdapter → MessageBus → AgentLoop → ChannelAdapter
 * Arquitetura multi-canal: Telegram ✅, Discord 🟡, Web
 */

import Database from 'better-sqlite3';
import { ProviderFactory } from './ProviderFactory';
import { errorMessage } from '../shared/errors';
import { AgentLoop } from '../loop/AgentLoop';
import { MemoryManager } from '../memory/MemoryManager';
import type { MemoryFacade } from '../memory/MemoryFacade';
import { SkillLoader } from '../skills/SkillLoader';
import { OnboardingService } from '../services/OnboardingService';
import { SkillLearner } from '../loop/SkillLearner';
import { ExecCommandTool } from '../tools/exec_command';
import { WebSearchTool } from '../tools/web_search';
import { WebNavigateTool } from '../tools/web_navigate';
import { WriteTool } from '../tools/write_tool';
import { EditTool } from '../tools/edit_tool';
import { ReadTool } from '../tools/read_tool';
import { MemorySearchTool } from '../tools/memory_search';
import { MemoryWriteTool } from '../tools/memory_write';
import { SendAudioTool } from '../tools/send_audio';
import { SendDocumentTool } from '../tools/send_document';
import { MemoryAdminTool } from '../tools/memory_admin';
import { CryptoAnalysisTool } from '../tools/crypto_analysis';
import { SshExecTool } from '../tools/ssh_exec';
import { WeatherTool } from '../tools/weather';
import { ToolRegistry } from './ToolRegistry';
import { SessionManager } from '../session/SessionManager';
import { SessionContext } from '../session/SessionContext';
import { ClassificationMemory } from '../memory/ClassificationMemory';
import { DecisionMemory } from '../memory/DecisionMemory';
import { SchedulerService } from '../services/SchedulerService';
import { ScheduleTool } from '../tools/schedule_tool';
import { SessionLearner } from '../session/SessionLearner';
import { MemoryGovernor } from '../memory/MemoryGovernor';
import { createLogger } from '../shared/AppLogger';
import { MessageBus } from '../channels/MessageBus';
import { TelegramAdapter } from '../channels/TelegramAdapter';
import { DiscordAdapter } from '../channels/DiscordAdapter';
import { WhatsAppAdapter } from '../channels/WhatsAppAdapter';
import { SignalAdapter } from '../channels/SignalAdapter';
import { AuditorService } from '../services/auditor/AuditorService';
import { eventBus, EventTypes, type AppEvent } from './EventBus';
import { circuitRegistry } from './CircuitBreaker';
import { toolExecutor } from './ToolExecutor';
import { promptRegistry } from './PromptRegistry';
import { ConfidenceClassifier } from './ConfidenceClassifier';
import { SessionAutoCleaner } from '../session/SessionAutoCleaner';
import { MemoryCurator } from '../memory/MemoryCurator';
import { LifecycleManager } from './LifecycleManager';
import { getEventLoopMonitor } from '../shared/EventLoopMonitor';
import type { NewClawConfig } from './agentControllerTypes';
import { openDatabase, buildLanguageDirective, buildSystemPrompt } from './agentControllerSetup';
import { registerCommands } from './agentControllerCommands';
import {
    transcribeAttachment,
    handleDocumentAttachment,
    handlePhotoAttachment,
} from './agentMediaHandlers';

export type { NewClawConfig };

const log = createLogger('AgentController');

export class AgentController {
    private config: NewClawConfig;
    private agentLoop: AgentLoop;
    private providerFactory: ProviderFactory;
    private memory: MemoryManager;
    private memoryFacade: MemoryFacade;
    private lifecycle = new LifecycleManager();
    private skillLoader: SkillLoader;
    private skillLearner: SkillLearner;
    private onboardingService: OnboardingService;
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
    private telegramAdapter: TelegramAdapter;
    private discordAdapter: DiscordAdapter | null = null;
    private whatsAppAdapter: WhatsAppAdapter | null = null;
    private signalAdapter: SignalAdapter | null = null;

    public getMemory(): MemoryManager { return this.memory; }
    public getProviderFactory(): ProviderFactory { return this.providerFactory; }
    public getMemoryGovernor(): MemoryGovernor { return this.memoryGovernor; }
    public getSessionLearner(): SessionLearner { return this.sessionLearner; }
    public getMessageBus(): MessageBus { return this.messageBus; }
    public getEventBus() { return this._eventBus; }
    public getCircuitBreakers() { return this.circuitBreakers; }
    public getTelegramAdapter(): TelegramAdapter { return this.telegramAdapter; }
    public getDiscordAdapter(): DiscordAdapter | null { return this.discordAdapter; }
    public getWhatsAppAdapter(): WhatsAppAdapter | null { return this.whatsAppAdapter; }
    public getSignalAdapter(): SignalAdapter | null { return this.signalAdapter; }
    public getConfidenceClassifier(): ConfidenceClassifier { return this.confidenceClassifier; }
    public getSessionAutoCleaner(): SessionAutoCleaner { return this.sessionAutoCleaner; }
    public getMemoryCurator(): MemoryCurator { return this.memoryCurator; }
    public getCircuitBreakerStates() { return circuitRegistry.getAllMetrics(); }
    public getPromptRegistry() { return promptRegistry; }
    public getToolExecutor() { return toolExecutor; }

    constructor(config: NewClawConfig) {
        this.config = config;

        const dbPath = './data/newclaw.db';
        this.db = openDatabase(dbPath);

        this.memory = new MemoryManager(this.db);
        this.memoryFacade = this.memory.getFacade();
        this.providerFactory = new ProviderFactory({
            geminiKey: config.geminiApiKey,
            deepseekKey: config.deepseekApiKey,
            groqKey: config.groqApiKey,
            openrouterKey: config.openrouterApiKey,
            ollamaUrl: config.ollamaUrl,
            ollamaModel: config.ollamaModel,
            ollamaApiKey: config.ollamaApiKey,
            defaultProvider: config.defaultProvider
        });

        this.skillLoader = new SkillLoader(config.skillsDir);
        this.skillLearner = new SkillLearner(this.db);

        const languageDirective = buildLanguageDirective(config.language);
        const systemPrompt = config.systemPrompt || buildSystemPrompt(this.skillLoader);

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

        this.onboardingService = new OnboardingService(
            this.db,
            this.skillLearner,
            this.providerFactory,
            this.agentLoop.getStateManager()
        );

        this.sessionManager = new SessionManager(
            { transcriptDir: './data/sessions' },
            this.memory,
            this.providerFactory
        );

        const sessionContext = new SessionContext(this.sessionManager, this.memory);
        this.agentLoop.setSessionContext(sessionContext);

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

        this.auditor = new AuditorService({
            ollamaUrl: config.ollamaUrl || 'http://localhost:11434',
            model: config.ollamaModel || 'glm-5.1:cloud',
            dbPath: './data/newclaw.db',
            srcPath: './src',
            logsPath: './logs',
            ownerChatId: config.telegramAllowedUserIds[0] || '',
            maxFindingsPerCategory: 20,
            enableAutoFix: true,
        }, this.db);

        registerCommands(this.messageBus, this.memory, this.memoryFacade, this.sessionManager, this.auditor, this.config);

        eventBus.on('circuit:open', (data) => {
            log.warn(`[CircuitBreaker] ${data.name} OPEN — ${data.failures}/${data.threshold} failures`);
        });
        eventBus.on('circuit:closed', (data) => {
            log.info(`[CircuitBreaker] ${data.name} CLOSED — ${data.successes} consecutive successes`);
        });
        eventBus.on('tool:timeout', (data) => {
            log.warn(`[ToolExecutor] ${data.tool} timed out after ${data.timeoutMs}ms`);
        });
        eventBus.on('tool:failed', (data) => {
            log.warn(`[ToolExecutor] ${data.tool} failed: ${data.error}`);
        });

        this.confidenceClassifier = new ConfidenceClassifier();

        promptRegistry.load();
        log.info(`   PromptRegistry: ${JSON.stringify(promptRegistry.getStats())}`);

        this.sessionAutoCleaner = new SessionAutoCleaner(this.sessionManager, {
            transcriptDir: './data/sessions',
        });

        this.memoryCurator = new MemoryCurator(this.memory);

        this.telegramAdapter = new TelegramAdapter({
            enabled: true,
            botToken: config.telegramBotToken,
            allowedUserIds: config.telegramAllowedUserIds,
            tmpDir: config.tmpDir,
        });
        this.telegramAdapter.setBus(this.messageBus);
        this.messageBus.registerAdapter(this.telegramAdapter);

        const { tmpDir } = config;
        this.messageBus.registerMediaHandler('voice', async (msg, attachment) =>
            transcribeAttachment(msg, attachment, this.messageBus, tmpDir));
        this.messageBus.registerMediaHandler('audio', async (msg, attachment) =>
            transcribeAttachment(msg, attachment, this.messageBus, tmpDir));
        this.messageBus.registerMediaHandler('document', async (msg, attachment) =>
            handleDocumentAttachment(msg, attachment, this.messageBus));
        this.messageBus.registerMediaHandler('photo', async (msg, attachment) => {
            const profile = this.agentLoop.getModelRouter().getProfileByCategory('vision');
            return handlePhotoAttachment(msg, attachment, this.messageBus, profile ?? null);
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
            log.info('Signal adapter registered');
        }

        this.scheduler.setTriggerHandler(async (task) => {
            try {
                const chatId = task.chat_id;
                let prompt = '';
                if (task.action_type === 'weather') {
                    const params = JSON.parse(task.action_params || '{}');
                    const city = params.city || 'Cornélio Procópio';
                    prompt = `[AGENDADO] Envie a previsão do tempo para ${city}. Seja conciso.`;
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

        this._eventBus.onAny(async (event: AppEvent) => {
            if (event.type !== EventTypes.SCHEDULER_TRIGGER) return;
            try {
                const { chatId, channel, prompt, taskId } = event.payload as {
                    chatId: string; channel: string; prompt: string; taskId: number; actionType: string; label: string;
                };
                log.info(`[EVENTBUS] Processing scheduler.trigger #${taskId} → chat ${chatId} (${channel})`);
                const result = await this.agentLoop.process(chatId, prompt);
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

        log.info('✅ NewClaw running — multi-channel pipeline active');
        log.info('   Modules: EventBus ✅ | CircuitBreaker ✅ | ToolExecutor ✅ | ConfidenceClassifier ✅ | PromptRegistry ✅ | SessionAutoCleaner ✅');
    }

    async stop(reason: string = 'shutdown'): Promise<void> {
        await this.lifecycle.shutdown(reason);
        log.info('NewClaw stopped');
    }

    async handleWebMessage(sessionId: string, message: string): Promise<string> {
        try {
            const webUserId = 'web-dashboard-user';
            if (this.onboardingService.isOnboardingRequired(webUserId)) {
                const res = await this.onboardingService.handle(webUserId, message);
                return res.response;
            }
            const result = await this.agentLoop.process(sessionId, message);
            return typeof result === 'string' ? result : result.text;
        } catch (err) {
            log.error('Web message error:', errorMessage(err));
            return `Erro: ${errorMessage(err)}`;
        }
    }

    private registerSkills(): void {
        ToolRegistry.register(new ExecCommandTool(), { dangerous: true });
        ToolRegistry.register(new WebSearchTool());
        ToolRegistry.register(new WebNavigateTool());
        ToolRegistry.register(new WriteTool());
        ToolRegistry.register(new EditTool());
        ToolRegistry.register(new ReadTool());
        ToolRegistry.register(new MemorySearchTool(this.memory));
        ToolRegistry.register(new MemoryWriteTool(this.memory));
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
