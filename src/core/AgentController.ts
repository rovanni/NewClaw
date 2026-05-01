/**
 * AgentController — Facade principal do NewClaw
 * 
 * Orquestra: ChannelAdapter → MessageBus → AgentLoop → ChannelAdapter
 * Arquitetura multi-canal: Telegram ✅, Discord 🟡, Web
 */

import { ProviderFactory, ILLMProvider } from './ProviderFactory';
import { AgentLoop } from '../loop/AgentLoop';
import { MemoryManager } from '../memory/MemoryManager';
import { SkillLoader } from '../skills/SkillLoader';
import { OnboardingService } from '../services/OnboardingService';
import { SkillLearner } from '../loop/SkillLearner';
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
import { TelegramAdapter, type TelegramConfig } from '../channels/TelegramAdapter';
import { DiscordAdapter, type DiscordConfig } from '../channels/DiscordAdapter';
import { WhatsAppAdapter, type WhatsAppConfig } from '../channels/WhatsAppAdapter';
import { SignalAdapter, type SignalConfig } from '../channels/SignalAdapter';
import { NormalizedMessage } from '../channels/ChannelAdapter';
const log = createLogger('AgentController');

export interface NewClawConfig {
    telegramBotToken: string;
    telegramAllowedUserIds: string[];
    /** Discord bot token (optional) */
    discordBotToken?: string;
    /** Discord allowed guild IDs (optional) */
    discordAllowedGuildIds?: string[];
    /** Discord allowed user IDs (optional) */
    discordAllowedUserIds?: string[];
    /** WhatsApp phone number (optional) */
    whatsappPhoneNumber?: string;
    /** WhatsApp allowed JIDs (optional) */
    whatsappAllowedJids?: string[];
    /** WhatsApp auth directory */
    whatsappAuthDir?: string;
    /** Signal phone number (optional) */
    signalPhoneNumber?: string;
    /** Signal allowed numbers (optional) */
    signalAllowedNumbers?: string[];
    /** Signal CLI path */
    signalCliPath?: string;
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
    private onboardingService: OnboardingService;
    private sessionManager: SessionManager;
    private sessionLearner: SessionLearner;
    private memoryGovernor: MemoryGovernor;
    private scheduler: SchedulerService;
    private messageBus: MessageBus;
    private telegramAdapter: TelegramAdapter;
    private discordAdapter: DiscordAdapter | null = null;
    private whatsAppAdapter: WhatsAppAdapter | null = null;
    private signalAdapter: SignalAdapter | null = null;

    /** Get the MessageBus */
    public getMessageBus(): MessageBus { return this.messageBus; }
    /** Get the TelegramAdapter */
    public getTelegramAdapter(): TelegramAdapter { return this.telegramAdapter; }
    /** Get the DiscordAdapter (if enabled) */
    public getDiscordAdapter(): DiscordAdapter | null { return this.discordAdapter; }
    /** Get the WhatsAppAdapter (if enabled) */
    public getWhatsAppAdapter(): WhatsAppAdapter | null { return this.whatsAppAdapter; }
    /** Get the SignalAdapter (if enabled) */
    public getSignalAdapter(): SignalAdapter | null { return this.signalAdapter; }

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

        // Inicializar SessionManager
        this.sessionManager = new SessionManager(
            { transcriptDir: './data/sessions' },
            this.memory,
            this.providerFactory
        );

        const sessionContext = new SessionContext(this.sessionManager, this.memory);
        this.agentLoop.setSessionContext(sessionContext);

        // Inicializar SessionLearner
        this.sessionLearner = new SessionLearner(this.sessionManager, this.memory);

        // Inicializar Scheduler
        this.scheduler = new SchedulerService('./data/newclaw.db', (this.memory as any).db || (this.memory as any)._db);

        // Inicializar MemoryGovernor
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

        // ─── MessageBus + Adapters ────────────────────────────

        // MessageBus is the central pipeline
        this.messageBus = new MessageBus(this.agentLoop, this.sessionManager);

        // Register commands on the MessageBus
        this.registerCommands();

        // Telegram adapter (primary)
        this.telegramAdapter = new TelegramAdapter({
            enabled: true,
            botToken: config.telegramBotToken,
            allowedUserIds: config.telegramAllowedUserIds,
            tmpDir: config.tmpDir,
        });
        this.telegramAdapter.setBus(this.messageBus);
        this.messageBus.registerAdapter(this.telegramAdapter);

        // Discord adapter (optional)
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

        // WhatsApp adapter (optional)
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

        // Signal adapter (optional)
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

        // Scheduler trigger — sends via TelegramAdapter
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
                // Send result via TelegramAdapter
                await this.telegramAdapter.sendToChat(chatId, {
                    text: result,
                    format: 'markdown'
                });
            } catch (e) {
                log.error(`[Scheduler] Failed to send scheduled message:`, e);
            }
        });

        // Start scheduler after bot is ready
        setTimeout(() => this.scheduler.startAll(), 5000);

        // Registrar skills/tools
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

        // Channels status
        const channels = this.messageBus.listAdapters();
        for (const ch of channels) {
            log.info(`   Channel: ${ch.name} (${ch.connected ? 'connected' : 'not connected'})`);
        }

        // Run governance cycle on boot
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

        // Start all channel adapters via MessageBus
        await this.messageBus.startAll();

        log.info('✅ NewClaw running — multi-channel pipeline active');
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
     * Register command handlers on the MessageBus
     */
    private registerCommands(): void {
        // /clear — limpar contexto
        this.messageBus.registerCommand('/clear', async (msg) => {
            this.memory.createNewConversation(msg.userId);
            const sessionKey = { channel: msg.channel, userId: msg.userId };
            await this.sessionManager.closeSession(sessionKey);
            return '🧹 Sessão limpa! Contexto anterior comprimido. Nova sessão iniciada.';
        });

        // /skills — listar skills
        this.messageBus.registerCommand('/skills', async (msg) => {
            try {
                const db = (this.memory as any).db || (this.memory as any)._db;
                if (!db) return '⚠️ Banco de dados não disponível para revisar skills.';

                const skills = db.prepare(
                    `SELECT id, name, status, priority, source_pattern, source_tool, updated_at
                     FROM auto_skills
                     ORDER BY
                        CASE status WHEN 'proposed' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
                        priority DESC,
                        updated_at DESC
                     LIMIT 10`
                ).all() as Array<{
                    id: string; name: string; status: string; priority: number;
                    source_pattern?: string; source_tool?: string;
                }>;

                if (skills.length === 0) return 'Nenhuma skill automática cadastrada ainda.';

                const lines = skills.map(skill => {
                    const shortId = skill.id.slice(-8);
                    const status = skill.status === 'proposed' ? 'PROPOSED' : skill.status === 'active' ? 'ACTIVE' : 'REJECTED';
                    return `• **${skill.name}** [${status}]\n  id: \`${shortId}\` | origem: ${skill.source_pattern || 'manual'} → ${skill.source_tool || '—'} | pri: ${skill.priority}`;
                });

                return `🧠 **SkillLearner**\n\n${lines.join('\n\n')}\n\nAções:\n\`/skill_approve <id>\` / \`/skill_reject <id>\``;
            } catch (e: any) {
                return `⚠️ Erro ao listar skills: ${e.message}`;
            }
        });

        // /skill_approve
        this.messageBus.registerCommand('/skill_approve', async (msg) => {
            const parts = msg.text.trim().split(/\s+/);
            const rawId = parts[1];
            if (!rawId) return 'Use /skill_approve <id_curto>. Veja os IDs com /skills';

            try {
                const db = (this.memory as any).db || (this.memory as any)._db;
                const rows = db.prepare('SELECT id FROM auto_skills').all() as Array<{ id: string }>;
                const match = rows.find(r => r.id.endsWith(rawId));
                if (!match) return `Skill com ID curto "${rawId}" não encontrada.`;

                db.prepare('UPDATE auto_skills SET status = ? WHERE id = ?').run('active', match.id);
                return `✅ Skill aprovada: ${match.id}`;
            } catch (e: any) {
                return `⚠️ Erro: ${e.message}`;
            }
        });

        // /skill_reject
        this.messageBus.registerCommand('/skill_reject', async (msg) => {
            const parts = msg.text.trim().split(/\s+/);
            const rawId = parts[1];
            if (!rawId) return 'Use /skill_reject <id_curto>. Veja os IDs com /skills';

            try {
                const db = (this.memory as any).db || (this.memory as any)._db;
                const rows = db.prepare('SELECT id FROM auto_skills').all() as Array<{ id: string }>;
                const match = rows.find(r => r.id.endsWith(rawId));
                if (!match) return `Skill com ID curto "${rawId}" não encontrada.`;

                db.prepare('UPDATE auto_skills SET status = ? WHERE id = ?').run('rejected', match.id);
                return `❌ Skill rejeitada: ${match.id}`;
            } catch (e: any) {
                return `⚠️ Erro: ${e.message}`;
            }
        });
    }

    /**
     * Registra tools no AgentLoop
     */
    private registerSkills(): void {
        const skills = this.skillLoader.loadAll();

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

        for (const tool of ToolRegistry.getEnabled()) {
            this.agentLoop.registerTool(tool);
        }

        log.info(`   Tools: ${ToolRegistry.getStatus().map(t => `${t.name}${t.dangerous ? '⚠️' : ''}${t.enabled ? '' : '❌'}`).join(', ')}`);
    }

    /**
     * Constroi diretiva de idioma
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