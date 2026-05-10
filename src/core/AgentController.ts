/**
 * AgentController — Facade principal do NewClaw
 * 
 * Orquestra: ChannelAdapter → MessageBus → AgentLoop → ChannelAdapter
 * Arquitetura multi-canal: Telegram ✅, Discord 🟡, Web
 */

import { ProviderFactory, ILLMProvider } from './ProviderFactory';
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
import { AuditorService } from '../services/auditor/AuditorService';
import { registerAuditCommand } from '../services/auditor/auditCommand';
import { LifecycleManager } from './LifecycleManager';
import { EventBus, eventBus, EventTypes, type AppEvent } from './EventBus';
import { CircuitBreaker, CircuitBreakerManager } from './CircuitBreaker';
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
    private memoryFacade: MemoryFacade;
    private lifecycle = new LifecycleManager();
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
    private eventBus: EventBus;
    private circuitBreakers: CircuitBreakerManager;
    private auditor: AuditorService;
    private telegramAdapter: TelegramAdapter;
    private discordAdapter: DiscordAdapter | null = null;
    private whatsAppAdapter: WhatsAppAdapter | null = null;
    private signalAdapter: SignalAdapter | null = null;

    /** Get the MessageBus */
    public getMessageBus(): MessageBus { return this.messageBus; }
    /** Get the EventBus */
    public getEventBus(): EventBus { return this.eventBus; }
    /** Get the CircuitBreakerManager */
    public getCircuitBreakers(): CircuitBreakerManager { return this.circuitBreakers; }
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

        // Inicializar EventBus e CircuitBreaker (camada de infraestrutura)
        this.eventBus = eventBus; // singleton
        this.circuitBreakers = new CircuitBreakerManager({ threshold: 5, resetTimeoutMs: 60_000 });
        this.memory = new MemoryManager('./data/newclaw.db');
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
        this.skillLearner = new SkillLearner(this.memory);

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
            this.memory,
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
        this.scheduler = new SchedulerService('./data/newclaw.db', this.memory);

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

        // AuditorService — self-diagnosis engine
        this.auditor = new AuditorService({
            ollamaUrl: config.ollamaUrl || 'http://localhost:11434',
            model: config.ollamaModel || 'glm-5.1:cloud',
            dbPath: './data/newclaw.db',
            srcPath: './src',
            logsPath: './logs',
            ownerChatId: config.telegramAllowedUserIds[0] || '',
            maxFindingsPerCategory: 20,
            enableAutoFix: true,
        }, this.memory);

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

        // Register voice/audio media handlers — transcribe via Whisper API
        this.messageBus.registerMediaHandler('voice', async (msg: any, attachment: any) => {
            return this.transcribeAttachment(msg, attachment);
        });
        this.messageBus.registerMediaHandler('audio', async (msg: any, attachment: any) => {
            return this.transcribeAttachment(msg, attachment);
        });

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

        // ── Scheduler via EventBus (desacoplado de qualquer adapter) ──
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

                // Emit event via EventBus — any adapter can listen
                this.eventBus.emit({
                    type: EventTypes.SCHEDULER_TRIGGER,
                    payload: { chatId, prompt, taskId: task.id, actionType: task.action_type, label: task.label },
                    source: 'scheduler',
                    correlationId: `scheduler-${task.id}`,
                });
            } catch (e) {
                log.error(`[Scheduler] Failed to emit scheduled event:`, e);
                this.eventBus.emit({
                    type: EventTypes.SCHEDULER_FAILED,
                    payload: { taskId: task.id, error: String(e) },
                    source: 'scheduler',
                });
            }
        });

        // ── EventBus: scheduler triggers → AgentLoop → response to chat ──
        this.eventBus.on(EventTypes.SCHEDULER_TRIGGER, async (event: AppEvent) => {
            try {
                const { chatId, prompt, taskId, actionType, label } = event.payload as {
                    chatId: string; prompt: string; taskId: number; actionType: string; label: string;
                };
                log.info(`[EVENTBUS] Processing scheduler.trigger #${taskId} → chat ${chatId}`);
                const result = await this.agentLoop.process(chatId, prompt);
                // Send via the primary adapter (Telegram for now)
                await this.telegramAdapter.sendToChat(chatId, {
                    text: result,
                    format: 'markdown'
                });
                this.eventBus.emit({
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
        this.lifecycle.registerService('sessions', () => this.sessionManager.closeAll());
        this.lifecycle.registerService('scheduler', () => this.scheduler.stopAll());
        this.lifecycle.registerService('messageBus', () => this.messageBus.stopAll());

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
        this.lifecycle.registerInterval('memory.governance.daily', () => {
            try {
                const stats = this.memoryGovernor.runGovernanceCycle();
                log.info(`Daily cycle: ${JSON.stringify(stats)}`);
            } catch (err) {
                log.warn('Daily cycle failed:', (err as Error).message);
            }
        }, 24 * 60 * 60 * 1000);

        // Start all channel adapters via MessageBus
        await this.messageBus.startAll();

        // ── Stability: Periodic Cleanup ──
        this.lifecycle.registerInterval('sessions.cleanup', async () => {
            try {
                // Cleanup inactive sessions from memory (TTL: 15 minutes)
                await this.sessionManager.cleanupInactiveSessions(900_000);
            } catch (e) {
                log.error('periodic_cleanup_failed', e);
            }
        }, 300_000); // Check every 5 minutes

        log.info('✅ NewClaw running — multi-channel pipeline active');
    }

    async stop(reason: string = 'shutdown'): Promise<void> {
        await this.lifecycle.shutdown(reason);
        log.info('NewClaw stopped');
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
                const skills = this.memoryFacade.listAutoSkills(10);

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
                const match = this.memoryFacade.findAutoSkillIdBySuffix(rawId);
                if (!match) return `Skill com ID curto "${rawId}" não encontrada.`;

                this.memoryFacade.setAutoSkillStatus(match, 'active');
                return `✅ Skill aprovada: ${match}`;
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
                const match = this.memoryFacade.findAutoSkillIdBySuffix(rawId);
                if (!match) return `Skill com ID curto "${rawId}" não encontrada.`;

                this.memoryFacade.setAutoSkillStatus(match, 'rejected');
                return `❌ Skill rejeitada: ${match}`;
            } catch (e: any) {
                return `⚠️ Erro: ${e.message}`;
            }
        });

        // /audit — owner-only self-diagnosis (multi-channel)
        const ownerIds = [
            ...this.config.telegramAllowedUserIds,
            ...this.config.discordAllowedUserIds || [],
            ...this.config.whatsappAllowedJids || [],
            ...this.config.signalAllowedNumbers || [],
        ];
        registerAuditCommand(this.messageBus, this.auditor, ownerIds);
    }

    /**
     * Registra tools no AgentLoop
     */
    private registerSkills(): void {
        const skills = this.skillLoader.loadAll();

        ToolRegistry.register(new ExecCommandTool(), { dangerous: true });
        ToolRegistry.register(new WebSearchTool());
        ToolRegistry.register(new WebNavigateTool());
        ToolRegistry.register(new WriteTool());
        ToolRegistry.register(new EditTool());
        ToolRegistry.register(new ReadTool());
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

    /**
     * Transcribe voice/audio attachment via Whisper API.
     * Downloads the file from Telegram, sends to Whisper, returns transcribed text.
     * Falls back to local whisper-cli if API fails.
     */
    private async transcribeAttachment(msg: any, attachment: any): Promise<string | null> {
        const vlog = createLogger('VoiceHandler');
        try {
            // Get file URL from Telegram via the adapter
            const adapter = this.messageBus['adapters']?.get(msg.channel) as any;
            const botToken = msg.metadata?.botToken || adapter?.config?.botToken;
            const fileId = attachment.fileId;

            if (!botToken || !fileId) {
                vlog.error('missing_bot_token_or_file_id', `token=${!!botToken} fileId=${!!fileId}`);
                return '⚠️ Não foi possível obter o arquivo de áudio (token ou fileId ausente).';
            }

            // Download file from Telegram
            const fileUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`;
            const fileRes = await fetch(fileUrl);
            const fileData = await fileRes.json() as any;

            if (!fileData?.ok || !fileData?.result?.file_path) {
                vlog.error('telegram_getfile_failed', JSON.stringify(fileData));
                return '⚠️ Não foi possível obter o caminho do arquivo no Telegram.';
            }

            const filePath = fileData.result.file_path;
            const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;

            // Download audio bytes
            const audioRes = await fetch(downloadUrl);
            if (!audioRes.ok) {
                vlog.error('audio_download_failed', `status=${audioRes.status}`);
                return '⚠️ Falha ao baixar o arquivo de áudio do Telegram.';
            }
            const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

            vlog.info('audio_downloaded', `size=${audioBuffer.length} type=${attachment.type}`);

            // Try Whisper API (Sol GPU first, then fallback)
            const whisperApiUrl = process.env.WHISPER_API_URL || 'http://10.0.0.1:8177';
            const whisperApiFallback = process.env.WHISPER_API_FALLBACK || '';
            const whisperUrls = [whisperApiUrl, whisperApiFallback].filter(Boolean);

            for (const whisperUrl of whisperUrls) {
                try {
                    const formData = new FormData();
                    formData.append('file', new Blob([audioBuffer]), `audio.${filePath.endsWith('.oga') ? 'oga' : 'ogg'}`);

                    const whisperRes = await fetch(`${whisperUrl}/inference`, {
                        method: 'POST',
                        body: formData,
                        signal: AbortSignal.timeout(60_000),
                    });

                    if (whisperRes.ok) {
                        const result = await whisperRes.json() as any;
                        const transcription = result?.text || result?.transcription || '';
                        if (transcription.trim()) {
                            vlog.info('whisper_transcription_ok', `textLen=${transcription.length}`);
                            // Replace msg.text with transcription so it flows to AgentLoop
                            msg.text = transcription.trim();
                            return null; // null = continue to text processing pipeline
                        }
                    }
                    vlog.warn('whisper_api_failed', `url=${whisperUrl} status=${whisperRes.status}`);
                } catch (e: any) {
                    vlog.warn('whisper_api_error', `url=${whisperUrl} error=${e.message}`);
                }
            }

            // Fallback: local whisper-cli (ASYNC — non-blocking)
            const tmpDir = this.config.tmpDir || '/tmp';
            const fs = await import('fs/promises');
            const pathMod = await import('path');
            const tmpFile = pathMod.join(tmpDir, `whisper_${Date.now()}.ogg`);
            const wavFile = pathMod.join(tmpDir, `whisper_${Date.now()}.wav`);

            try {
                await fs.writeFile(tmpFile, audioBuffer);
                // Convert to WAV 16kHz mono (ASYNC via execFile)
                const { execFile } = await import('child_process');
                await new Promise<void>((resolve, reject) => {
                    execFile('ffmpeg', ['-y', '-i', tmpFile, '-ar', '16000', '-ac', '1', wavFile], {
                        timeout: 30_000,
                    }, (err) => err ? reject(err) : resolve());
                });
                // Run local whisper (ASYNC via execFile)
                const whisperPath = process.env.WHISPER_PATH || 'whisper';
                const output = await new Promise<string>((resolve, reject) => {
                    execFile(whisperPath, [wavFile, '--language', 'pt', '--no-timestamps'], {
                        timeout: 120_000,
                        encoding: 'utf-8',
                    }, (err, stdout) => err ? reject(err) : resolve(stdout));
                });
                const transcription = output.trim();
                if (transcription) {
                    vlog.info('local_whisper_ok', `textLen=${transcription.length}`);
                    msg.text = transcription;
                    return null;
                }
            } catch (e: any) {
                vlog.warn('local_whisper_failed', `error=${e.message}`);
            } finally {
                await fs.unlink(tmpFile).catch(() => {});
                await fs.unlink(wavFile).catch(() => {});
            }

            return '⚠️ Não foi possível transcrever o áudio. Tente enviar como texto.';
        } catch (err: any) {
            vlog.error('transcription_failed', err);
            return `⚠️ Erro na transcrição: ${err.message}`;
        }
    }
}
