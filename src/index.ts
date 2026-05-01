/**
 * NewClaw — Entry Point
 * Agente pessoal de IA multi-canal (Telegram, Discord, Web)
 */

import dotenv from 'dotenv';
import { AgentController } from './core/AgentController';
import { DashboardServer } from './dashboard/DashboardServer';
import { Logger } from './shared/Logger';
import { createLogger } from './shared/AppLogger';
const log = createLogger('Index');

// Inicializar Logger (adiciona timestamps ao console.log)
Logger.hookGlobalConsole();

// Carregar .env
dotenv.config();

const config = {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramAllowedUserIds: (process.env.TELEGRAM_ALLOWED_USER_IDS || '').split(',').map(id => id.trim()).filter(id => id.length > 0),
    discordBotToken: process.env.DISCORD_BOT_TOKEN || '',
    discordAllowedGuildIds: (process.env.DISCORD_ALLOWED_GUILD_IDS || '').split(',').map(id => id.trim()).filter(id => id.length > 0),
    discordAllowedUserIds: (process.env.DISCORD_ALLOWED_USER_IDS || '').split(',').map(id => id.trim()).filter(id => id.length > 0),
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
    dashboardPort: parseInt(process.env.DASHBOARD_PORT || '3090'),
    modelRouter: {
        chat: process.env.MODEL_CHAT,
        code: process.env.MODEL_CODE,
        vision: process.env.MODEL_VISION,
        light: process.env.MODEL_LIGHT,
        analysis: process.env.MODEL_ANALYSIS,
        execution: process.env.MODEL_EXECUTION,
        visionServer: process.env.VISION_SERVER,
        classifierModel: process.env.CLASSIFIER_MODEL,
        classifierServer: process.env.CLASSIFIER_SERVER
    }
};

async function main() {
    // Global error handlers to prevent silent crashes
    process.on('unhandledRejection', (reason, promise) => {
        log.error('unhandled_rejection', reason instanceof Error ? reason : undefined, String(reason));
    });
    process.on('uncaughtException', (error) => {
        log.error('uncaught_exception', error);
    });

    log.info('🚀 NewClaw v0.2.0 starting...');
    log.info(`   Language: ${config.language}`);
    log.info(`   Provider: ${config.defaultProvider}`);

    if (!config.telegramBotToken && !config.discordBotToken) {
        log.error('❌ Nenhum canal configurado! Configure TELEGRAM_BOT_TOKEN ou DISCORD_BOT_TOKEN');
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
    dashboard.setMemoryManager(controller.getMemory());
    dashboard.start(config.dashboardPort);
    log.info(`\n⚙️  Configurações e Whitelist disponíveis em: http://localhost:${config.dashboardPort}/config\n`);

    await controller.start();
}

main().catch(err => log.error('fatal', err instanceof Error ? err : undefined, String(err)));