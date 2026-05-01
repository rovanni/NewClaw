/**
 * AgentController — Facade principal do NewClaw
 * 
 * Orquestra: Input → AgentLoop → Output
 * Arquitetura simplificada: LLM decide tudo (como OpenClaw)
 */

import { ProviderFactory, ILLMProvider } from './ProviderFactory';
import { AgentLoop } from '../loop/AgentLoop';
import { MemoryManager } from '../memory/MemoryManager';
import { SkillLoader } from '../skills/SkillLoader';
import { TelegramInputHandler } from '../input/TelegramInputHandler';
import { OnboardingService } from '../services/OnboardingService';
import { SkillLearner } from '../loop/SkillLearner';
import { TelegramOutputHandler } from '../output/TelegramOutputHandler';
import { ExecCommandTool } from '../tools/exec_command';
import { WebSearchTool } from '../tools/web_search';
import { WebNavigateTool } from '../tools/web_navigate';
import { FileOpsTool } from '../tools/file_ops';
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
import { SchedulerService } from '../services/SchedulerService';
import { ScheduleTool } from '../tools/schedule_tool';
import { SessionLearner } from '../session/SessionLearner';
import { MemoryGovernor } from '../memory/MemoryGovernor';
import { createLogger } from '../shared/AppLogger';
import { MessageBus } from '../channels/MessageBus';
import { TelegramAdapter } from '../channels/TelegramAdapter';
import { DiscordAdapter } from '../channels/DiscordAdapter';
const log = createLogger('Agentcontroller');

export interface NewClawConfig {
    telegramBotToken: string;
    telegramAllowedUserIds: string[];
    language: string;
    defaultProvider: string;
    geminiApiKey?: string;
    deepseekApiKey?: string;
    groqApiKey?: string;
    openrouterApiKey?: string;
    ollamaUrl?: string;
    ollamaModel?: string;
    ollamaApiKey?: string;
    maxIterations: number;
    memoryWindowSize: number;
    skillsDir: string;
    tmpDir: string;
    whisperPath: string;
    dashboardPort?: number;
    systemPrompt?: string;
    modelRouter?: {
        chat?: string;
        code?: string;
        vision?: string;
        light?: string;
        analysis?: string;
        execution?: string;
        visionServer?: string;
        classifierModel?: string;
        classifierServer?: string;
    };
}

export class AgentController {
    private config: NewClawConfig;
    private agentLoop: AgentLoop;
    private providerFactory: ProviderFactory;
    public getProviderFactory(): ProviderFactory { return this.providerFactory; }
    private memory: MemoryManager;
    public getMemory(): MemoryManager { return this.memory; }
    public getSessionLearner(): SessionLearner { return this.sessionLearner; }
    public getMemoryGovernor(): MemoryGovernor { return this.memoryGovernor; }
    private skillLoader: SkillLoader;
    private skillLearner: SkillLearner;
    private inputHandler: TelegramInputHandler;
    private outputHandler: TelegramOutputHandler;
    private onboardingService: OnboardingService;
    private sessionManager: SessionManager;
    private sessionLearner: SessionLearner;
    private memoryGovernor: MemoryGovernor;
    private scheduler: SchedulerService;
    private messageBus: MessageBus | null = null;

    /** Get the MessageBus (for adding channels dynamically) */
    public getMessageBus(): MessageBus | null { return this.messageBus; }

    constructor(config: NewClawConfig) {
        this.config = config;

        // Inicializar componentes
        this.memory = new MemoryManager('./data/newclaw.db');
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
        this.skillLearner = new SkillLearner(this.memory.getDatabase());

        // Construir system prompt
        const languageDirective = this.buildLanguageDirective(config.language);
        const systemPrompt = config.systemPrompt || this.buildSystemPrompt();

        // Inicializar AgentLoop
        this.agentLoop = new AgentLoop(
            this.providerFactory,
            this.memory,
            {
                languageDirective,
                systemPrompt,
                modelRouter: config.modelRouter
            },
            this.skillLearner
        );

        // Inicializar onboarding
        this.onboardingService = new OnboardingService(
            (this.memory as any).db || (this.memory as any)._db,
            this.skillLearner,
            this.providerFactory,
            this.agentLoop.getStateManager()
        );

        // Inicializar SessionManager (persistência conversacional)
        this.sessionManager = new SessionManager(
            { transcriptDir: './data/sessions' },
            this.memory,
            this.providerFactory
        );

        // Conectar SessionContext ao AgentLoop (pipeline híbrido: checkpoint + recent + semântico)
        const sessionContext = new SessionContext(this.sessionManager, this.memory);
        this.agentLoop.setSessionContext(sessionContext);

        // Inicializar SessionLearner (extração de fatos → grafo cognitivo)
        this.sessionLearner = new SessionLearner(this.sessionManager, this.memory);

        // Inicializar MemoryGovernor (decay, conflitos, GC)
        // Inicializar Scheduler
        this.scheduler = new SchedulerService('./data/newclaw.db', (this.memory as any).db || (this.memory as any)._db);

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

        // Configurar scheduler trigger — envia mensagem processada pelo AgentLoop
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
                log.info(`[Scheduler] Triggering task #${task.id}: ${task.label} → chat ${chatId}`);
                const result = await this.agentLoop.process(chatId, prompt);
                // Send result via Telegram bot
                if (this.inputHandler && (this.inputHandler as any).bot) {
                    const bot = (this.inputHandler as any).bot;
                const { safeSendMessage } = require('../shared/TelegramFormatter');
                    await safeSendMessage(bot.api, chatId, result).catch(() => {
                        bot.api.sendMessage(chatId, result);
                    });
                }
            } catch (e) {
                log.error(`[Scheduler] Failed to send scheduled message:`, e);
            }
        });

        // Iniciar scheduler after bot is ready
        setTimeout(() => this.scheduler.startAll(), 5000);

        // Inicializar handlers
        this.inputHandler = new TelegramInputHandler(
            {
                botToken: config.telegramBotToken,
                allowedUserIds: config.telegramAllowedUserIds,
                whisperPath: config.whisperPath,
                tmpDir: config.tmpDir
            },
            this.agentLoop,
            this.memory,
            this.onboardingService,
            this.sessionManager
        );

        // Conectar SessionLearner ao TelegramInputHandler
        this.inputHandler.setSessionLearner(this.sessionLearner);

        this.outputHandler = new TelegramOutputHandler({
            audioVoice: config.language === 'pt-BR' ? 'pt-BR-ThalitaNeural' : 'en-US-AriaNeural',
            tmpDir: config.tmpDir
        });

        // Registrar skills
        this.registerSkills();
    }

    /**
     * Inicia o NewClaw
     */
    async start(): Promise<void> {
        log.info('🚀 NewClaw starting...');
        log.info(`   Provider: ${this.providerFactory.getDefaultProvider()}`);
        log.info(`   Available: ${this.providerFactory.getAvailableProviders().join(', ')}`);
        log.info(`   Language: ${this.config.language}`);
        log.info(`   Skills: ${this.skillLoader.getSkillNames().join(', ') || 'none'}`);

        // Run governance cycle on boot (decay + conflict + GC)
        try {
            const stats = this.memoryGovernor.runGovernanceCycle();
            log.info(`Boot cycle: ${stats.nodesDecayed} decayed, ${stats.conflictsDetected} conflicts, ${stats.nodesGarbageCollected} GC'd`);
        } catch (err) {
            log.warn('Boot cycle failed:', (err as Error).message);
        }

        // Schedule governance cycle every 24 hours
        setInterval(() => {
            try {
                const stats = this.memoryGovernor.runGovernanceCycle();
                log.info(`Daily cycle: ${JSON.stringify(stats)}`);
            } catch (err) {
                log.warn('Daily cycle failed:', (err as Error).message);
            }
        }, 24 * 60 * 60 * 1000);

        await this.inputHandler.start();

        // Initialize MessageBus for multi-channel support
        this.messageBus = new MessageBus(this.agentLoop, this.sessionManager);

        // Register Telegram via MessageBus (optional — duplicates TelegramInputHandler)
        // The TelegramInputHandler stays as primary for now
        // New channels (Discord, Signal, etc.) will go through the MessageBus

        // Discord adapter (stub — enable when ready)
        // const discordAdapter = new DiscordAdapter({ enabled: false, botToken: '' });
        // this.messageBus.registerAdapter(discordAdapter);

        log.info('MessageBus initialized — multi-channel ready');
    }

    /**
     * Handle web dashboard messages
     */
    async handleWebMessage(sessionId: string, message: string): Promise<string> {
        try {
            if (this.onboardingService.isOnboardingRequired(sessionId)) {
                const res = await this.onboardingService.handle(sessionId, message);
                return res.response;
            }
            const result = await this.agentLoop.process(sessionId, message);
            return result;
        } catch (err: any) {
            log.error('Web message error:', err.message);
            return `Erro: ${err.message}`;
        }
    }

    /**
     * Registra tools no AgentLoop
     */
    private registerSkills(): void {
        const skills = this.skillLoader.loadAll();

        // Registrar tools padrão via ToolRegistry
        ToolRegistry.register(new ExecCommandTool(), { dangerous: true });
        ToolRegistry.register(new WebSearchTool());
        ToolRegistry.register(new WebNavigateTool());
        ToolRegistry.register(new FileOpsTool());
        ToolRegistry.register(new MemorySearchTool(this.memory));
        ToolRegistry.register(new MemoryWriteTool(this.memory));
        ToolRegistry.register(new SendAudioTool());
        ToolRegistry.register(new SendDocumentTool());
        ToolRegistry.register(new MemoryAdminTool(this.memory));
        ToolRegistry.register(new SshExecTool());
        ToolRegistry.register(new CryptoAnalysisTool());
        ToolRegistry.register(new WeatherTool());
        ToolRegistry.register(new ScheduleTool(this.scheduler));

        // Registrar tools habilitadas no AgentLoop
        for (const tool of ToolRegistry.getEnabled()) {
            this.agentLoop.registerTool(tool);
        }

        log.info(`   Tools: ${ToolRegistry.getStatus().map(t => `${t.name}${t.dangerous ? '⚠️' : ''}${t.enabled ? '' : '❌'}`).join(', ')}`);
    }

    /**
     * Constroi diretiva de idioma baseada na configuração
     */
    private buildLanguageDirective(lang: string): string {
        const languages: Record<string, string> = {
            'pt-BR': 'Você DEVE responder SEMPRE em português brasileiro (pt-BR). QUANDO usar ferramentas, TRADUZA todo o resultado para pt-BR antes de responder. NUNCA responda em inglês.',
            'en-US': 'You MUST respond in American English. When using tools, translate any non-English content to English.',
            'es-ES': 'Debes responder SIEMPRE en español. Quando uses ferramentas, traduce todo el contenido al español.',
        };

        return languages[lang] || languages['pt-BR'];
    }

    /**
     * Constroi system prompt padrão
     */
    private buildSystemPrompt(): string {
        const skillContext = this.skillLoader.getSkillSummaries();
        const skillSection = skillContext 
            ? `\n\nSkills disponíveis:\n${skillContext}`
            : '';

        return `Identidade: Você é o NewClaw, um assistente cognitivo avançado focado em produtividade e análise.
Workspace: Seu diretório de trabalho padrão é "/newclaw/workspace". Use-o para todas as operações de arquivo.
Memória: Você possui memória persistente em grafo e aprende sobre o usuário continuamente.

REGRAS DO GRAFO DE MEMÓRIA (OBRIGATÓRIO):
1. TODO nó novo DEVE ser conectado ao grafo — NUNCA crie nós soltos/isolados.
2. Conecte fatos/skills ao user_identity com: has_trait, uses, works_on, created.
3. Conecte infraestrutura ao user_identity com: uses, e ao servidor com: runs_on.
4. Conecte projetos ao user_identity com: works_on ou owns.
5. Use action=connect após action=create se precisar de mais conexões.
6. Busque antes de criar para evitar duplicatas (use memory_search).${skillSection}`;
    }
}
