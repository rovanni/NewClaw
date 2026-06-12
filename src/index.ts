/**
 * NewClaw — Entry Point
 * Agente pessoal de IA multi-canal (Telegram, Discord, WhatsApp, Signal, Web)
 */

import dotenv from 'dotenv';
// Carregar .env IMEDIATAMENTE (antes de outros imports que dependem de env vars)
dotenv.config();

import { AgentController } from './core/AgentController';
import { DashboardServer } from './dashboard/DashboardServer';
import { Logger } from './shared/Logger';
import { createLogger } from './shared/AppLogger';
import { getEventLoopMonitor } from './shared/EventLoopMonitor';
const log = createLogger('Index');

// Inicializar Logger (adiciona timestamps ao console.log)
Logger.hookGlobalConsole();

const config = {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramAllowedUserIds: (process.env.TELEGRAM_ALLOWED_USER_IDS || '').split(',').map(id => id.trim()).filter(id => id.length > 0),
    discordBotToken: process.env.DISCORD_BOT_TOKEN || '',
    discordAllowedGuildIds: (process.env.DISCORD_ALLOWED_GUILD_IDS || '').split(',').map(id => id.trim()).filter(id => id.length > 0),
    discordAllowedUserIds: (process.env.DISCORD_ALLOWED_USER_IDS || '').split(',').map(id => id.trim()).filter(id => id.length > 0),
    whatsappPhoneNumber: process.env.WHATSAPP_PHONE_NUMBER || '',
    whatsappAllowedJids: (process.env.WHATSAPP_ALLOWED_JIDS || '').split(',').map(id => id.trim()).filter(id => id.length > 0),
    whatsappAuthDir: process.env.WHATSAPP_AUTH_DIR || './data/whatsapp-auth',
    signalPhoneNumber: process.env.SIGNAL_PHONE_NUMBER || '',
    signalAllowedNumbers: (process.env.SIGNAL_ALLOWED_NUMBERS || '').split(',').map(id => id.trim()).filter(id => id.length > 0),
    signalCliPath: process.env.SIGNAL_CLI_PATH || 'signal-cli',
    language: process.env.APP_LANG || 'pt-BR',
    defaultProvider: process.env.DEFAULT_PROVIDER || 'gemini',
    geminiApiKey: process.env.GEMINI_API_KEY,
    deepseekApiKey: process.env.DEEPSEEK_API_KEY,
    groqApiKey: process.env.GROQ_API_KEY,
    openrouterApiKey: process.env.OPENROUTER_API_KEY,
    ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
    ollamaModel: process.env.OLLAMA_MODEL || 'glm-5.1:cloud',
    ollamaApiKey: process.env.OLLAMA_API_KEY || '',
    maxIterations: parseInt(process.env.MAX_ITERATIONS || '5'),
    memoryWindowSize: parseInt(process.env.MEMORY_WINDOW_SIZE || '20'),
    skillsDir: process.env.SKILLS_DIR || './skills',
    tmpDir: process.env.TMP_DIR || './tmp',
    whisperPath: process.env.WHISPER_PATH || '/usr/local/bin/whisper',
    ownerName: process.env.OWNER_NAME || '',
    ownerUserId: process.env.OWNER_USER_ID || '',
    ownerLocked: process.env.OWNER_LOCKED === 'true',
    dashboardPort: parseInt(process.env.DASHBOARD_PORT || '3090'),
    customModels: (process.env.CUSTOM_MODELS || '').split(',').map(m => m.trim()).filter(m => m.length > 0),
    modelRouter: {
        chat: process.env.MODEL_CHAT,
        code: process.env.MODEL_CODE,
        vision: process.env.MODEL_VISION,
        light: process.env.MODEL_LIGHT,
        analysis: process.env.MODEL_ANALYSIS,
        execution: process.env.MODEL_EXECUTION,
        visionServer: process.env.VISION_SERVER,
        classifierModel: process.env.CLASSIFIER_MODEL,
        classifierServer: process.env.CLASSIFIER_SERVER,
        // Provider por perfil (opcional — sobrescreve DEFAULT_PROVIDER para aquele perfil)
        provider_chat:      process.env.PROVIDER_CHAT,
        provider_code:      process.env.PROVIDER_CODE,
        provider_vision:    process.env.PROVIDER_VISION,
        provider_light:     process.env.PROVIDER_LIGHT,
        provider_analysis:  process.env.PROVIDER_ANALYSIS,
        provider_execution: process.env.PROVIDER_EXECUTION,
        // Modelos dos componentes internos
        plannerModel:  process.env.PLANNER_MODEL,
        riskModel:     process.env.RISK_MODEL,
        observerModel: process.env.OBSERVER_MODEL,
    }
};

async function main() {
    // Global error handlers to prevent silent crashes
    // These catch unhandled rejections/exceptions but DO NOT exit the process.
    // The service must stay alive even if a single request fails.
    process.on('unhandledRejection', (reason, _promise) => {
        log.error('unhandled_rejection', reason instanceof Error ? reason : undefined, String(reason));
        // DO NOT exit — log and continue. One failed request should not kill the service.
    });
    process.on('uncaughtException', (error) => {
        log.error('uncaught_exception', error);
        // DO NOT exit on transient errors (timeout, network, provider failures)
        // Only exit on truly fatal errors (OOM, corrupt state)
        const isFatal = error.message?.includes('ENOMEM') || 
                        error.message?.includes('heap out of memory') ||
                        error.message?.includes('FATAL');
        if (isFatal) {
            log.error('fatal_error', error, 'Unrecoverable error — exiting');
            process.exit(1);
        }
        // Non-fatal: log and continue
        log.error('non_fatal_exception', error, 'Continuing after non-fatal error');
    });

    log.info('🚀 NewClaw v0.2.0 starting...');
    log.info(`   Language: ${config.language}`);
    log.info(`   Provider: ${config.defaultProvider}`);

    // Start event loop monitor (non-blocking, low overhead)
    const monitor = getEventLoopMonitor({ warnMs: 500, criticalMs: 2000 });
    monitor.start();
    log.info('   EventLoopMonitor: started (warn=500ms, critical=2000ms)');

    if (!config.telegramBotToken && !config.discordBotToken && !config.whatsappPhoneNumber && !config.signalPhoneNumber) {
        log.error('❌ Nenhum canal configurado! Configure TELEGRAM_BOT_TOKEN, DISCORD_BOT_TOKEN, WHATSAPP_PHONE_NUMBER ou SIGNAL_PHONE_NUMBER');
        process.exit(1);
    }

    if (config.telegramBotToken && config.telegramAllowedUserIds.length === 0) {
        log.warn('⚠️ TELEGRAM_ALLOWED_USER_IDS vazio — nenhum usuário autorizado no Telegram');
    }

    const controller = new AgentController(config);

    // Start Dashboard
    const dashboard = new DashboardServer(config);
    dashboard.setController(controller);
    dashboard.setProviderFactory(controller.getProviderFactory());
    dashboard.setMemoryManager(controller.getMemory(), controller.getMemoryCurator());
    dashboard.setSkillLearner(controller.getSkillLearner());
    dashboard.start(config.dashboardPort);
    log.info(`\n⚙️  Configurações e Whitelist disponíveis em: http://localhost:${config.dashboardPort}/config\n`);

    let shuttingDown = false;
    const shutdown = async (signal: string) => {
        if (shuttingDown) return;
        shuttingDown = true;

        log.info('shutdown_signal', signal);
        try {
            await dashboard.stop();
            await controller.stop(signal);
            process.exit(0);
        } catch (error) {
            log.error('shutdown_failed', error);
            process.exit(1);
        }
    };

    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));

    await controller.start();
}

main().catch(err => log.error('fatal', err instanceof Error ? err : undefined, String(err)));
