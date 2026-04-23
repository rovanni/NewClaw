/**
 * NewClaw — Entry Point
 * Agente pessoal de IA 100% local com Telegram
 */

import dotenv from 'dotenv';
import { AgentController } from './core/AgentController';
import { DashboardServer } from './dashboard/DashboardServer';

// Carregar .env
dotenv.config();

const config = {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramAllowedUserIds: (process.env.TELEGRAM_ALLOWED_USER_IDS || '').split(',').map(id => id.trim()).filter(id => id.length > 0),
    language: process.env.APP_LANG || 'pt-BR',
    defaultProvider: process.env.DEFAULT_PROVIDER || 'gemini',
    geminiApiKey: process.env.GEMINI_API_KEY,
    deepseekApiKey: process.env.DEEPSEEK_API_KEY,
    groqApiKey: process.env.GROQ_API_KEY,
    ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
    ollamaModel: process.env.OLLAMA_MODEL || 'glm-5.1:cloud',
    ollamaApiKey: process.env.OLLAMA_API_KEY || '',
    maxIterations: parseInt(process.env.MAX_ITERATIONS || '5'),
    memoryWindowSize: parseInt(process.env.MEMORY_WINDOW_SIZE || '20'),
    skillsDir: process.env.SKILLS_DIR || './skills',
    tmpDir: process.env.TMP_DIR || './tmp',
    whisperPath: process.env.WHISPER_PATH || '/usr/local/bin/whisper',
    dashboardPort: parseInt(process.env.DASHBOARD_PORT || '3090'),
};

async function main() {
    // Global error handlers to prevent silent crashes
    process.on('unhandledRejection', (reason, promise) => {
        console.error('[FATAL] Unhandled Rejection:', reason);
    });
    process.on('uncaughtException', (error) => {
        console.error('[FATAL] Uncaught Exception:', error);
    });

    console.log('🚀 NewClaw v0.1.0 starting...');
    console.log(`   Language: ${config.language}`);
    console.log(`   Provider: ${config.defaultProvider}`);

    if (!config.telegramBotToken) {
        console.error('❌ TELEGRAM_BOT_TOKEN não configurado!');
        process.exit(1);
    }

    if (config.telegramAllowedUserIds.length === 0 || config.telegramAllowedUserIds[0] === '') {
        console.error('❌ TELEGRAM_ALLOWED_USER_IDS não configurado!');
        process.exit(1);
    }

    const controller = new AgentController(config);

    // Start Dashboard
    const dashboard = new DashboardServer(config);
    dashboard.setController(controller);
    dashboard.setProviderFactory(controller.getProviderFactory());
    dashboard.setMemoryManager(controller.getMemory());
    dashboard.start(config.dashboardPort);
    console.log(`\n⚙️  Configurações e Whitelist disponíveis em: http://localhost:${config.dashboardPort}/config\n`);

    await controller.start();
}

main().catch(console.error);