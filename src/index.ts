/**
 * NewClaw — Entry Point
 * Agente pessoal de IA multi-canal (Telegram, Discord, WhatsApp, Signal, Web)
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
// Carregar .env IMEDIATAMENTE (antes de outros imports que dependem de env vars)
dotenv.config();

import { AgentController } from './core/AgentController';
import { autoRecoverDatabase, replaceDatabaseFile } from './core/dbRecovery';
import { applyUncaughtExceptionDecision } from './core/UncaughtExceptionPolicy';
import { DashboardServer } from './dashboard/DashboardServer';
import { Logger } from './shared/Logger';
import { createLogger } from './shared/AppLogger';
import { getEventLoopMonitor } from './shared/EventLoopMonitor';
const log = createLogger('Index');

// Inicializar Logger (adiciona timestamps ao console.log)
Logger.hookGlobalConsole();

/** CUSTOM_PROVIDERS é um array JSON ({label,baseUrl,apiKey}[]) — env var malformada não deve derrubar o boot. */
function parseCustomProviders(raw?: string): { label: string; baseUrl: string; apiKey?: string }[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        log.warn(`CUSTOM_PROVIDERS inválido (não é JSON), ignorando: ${raw.slice(0, 100)}`);
        return [];
    }
}

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
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
    ollamaModel: process.env.OLLAMA_MODEL || 'glm-5.2:cloud',
    ollamaApiKey: process.env.OLLAMA_API_KEY || '',
    maxIterations: parseInt(process.env.MAX_ITERATIONS || '5'),
    memoryWindowSize: parseInt(process.env.MEMORY_WINDOW_SIZE || '20'),
    skillsDir: process.env.SKILLS_DIR || './skills',
    tmpDir: process.env.TMP_DIR || './tmp',
    whisperPath: process.env.WHISPER_PATH || 'whisper',
    ownerName: process.env.OWNER_NAME || '',
    ownerUserId: process.env.OWNER_USER_ID || '',
    ownerLocked: process.env.OWNER_LOCKED === 'true',
    dashboardPort: parseInt(process.env.DASHBOARD_PORT || '3090'),
    customModels: (process.env.CUSTOM_MODELS || '').split(',').map(m => m.trim()).filter(m => m.length > 0),
    customProviders: parseCustomProviders(process.env.CUSTOM_PROVIDERS),
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
    // Global error handlers — capturam exceções que escapam de todo try/catch.
    // A decisão de continuar vs. reiniciar (e toda a classificação de erro) é centralizada em
    // UncaughtExceptionPolicy, controlada por UNCAUGHT_EXCEPTION_POLICY=continue|restart (ver
    // core/UncaughtExceptionPolicy.ts). Nenhuma condicional de classificação deve ser adicionada
    // aqui — isso reintroduziria a lógica espalhada que a auditoria 2026-07-12 (achado B2) apontou.
    process.on('unhandledRejection', (reason) => {
        applyUncaughtExceptionDecision(reason instanceof Error ? reason : new Error(String(reason)), 'unhandledRejection');
    });
    process.on('uncaughtException', (error) => {
        applyUncaughtExceptionDecision(error, 'uncaughtException');
    });

    log.info('🚀 NewClaw v0.2.0 starting...');
    log.info(`   Language: ${config.language}`);
    log.info(`   Provider: ${config.defaultProvider}`);

    // Start event loop monitor (non-blocking, low overhead)
    const monitor = getEventLoopMonitor({ warnMs: 500, criticalMs: 2000 });
    monitor.start();
    log.info('   EventLoopMonitor: started (warn=500ms, critical=2000ms)');

    if (!config.telegramBotToken && !config.discordBotToken && !config.whatsappPhoneNumber && !config.signalPhoneNumber) {
        log.warn('⚠️ Nenhum canal externo configurado (Telegram/Discord/WhatsApp/Signal) — operando apenas via Dashboard Web');
        log.warn('   → Configure um canal em: Dashboard → Config, ou via TELEGRAM_BOT_TOKEN/DISCORD_BOT_TOKEN/etc. no .env');
    }

    // Allowlist FAIL-CLOSED (ver channels/accessControl.ts): um canal habilitado sem allowlist
    // de remetente configurada NÃO aceita ninguém. Avisa o operador em cada canal — sem isso,
    // um canal ligado sem allowlist ficaria silenciosamente mudo (comportamento seguro, mas
    // confuso se não for anunciado). Uniforme entre Telegram/Discord/WhatsApp/Signal.
    if (config.telegramBotToken && config.telegramAllowedUserIds.length === 0) {
        log.warn('⚠️ TELEGRAM_ALLOWED_USER_IDS vazio — nenhum usuário autorizado no Telegram (canal ficará mudo até configurar)');
    }
    if (config.discordBotToken && config.discordAllowedUserIds.length === 0) {
        log.warn('⚠️ DISCORD_ALLOWED_USER_IDS vazio — nenhum usuário autorizado no Discord (canal ficará mudo até configurar)');
    }
    if (config.whatsappPhoneNumber && config.whatsappAllowedJids.length === 0) {
        log.warn('⚠️ WHATSAPP_ALLOWED_JIDS vazio — nenhum remetente autorizado no WhatsApp (canal ficará mudo até configurar)');
    }
    if (config.signalPhoneNumber && config.signalAllowedNumbers.length === 0) {
        log.warn('⚠️ SIGNAL_ALLOWED_NUMBERS vazio — nenhum remetente autorizado no Signal (canal ficará mudo até configurar)');
    }

    const missingInternalModels: string[] = [];
    if (!process.env.PLANNER_MODEL)  missingInternalModels.push('PLANNER_MODEL (GoalPlanner)');
    if (!process.env.RISK_MODEL)     missingInternalModels.push('RISK_MODEL (RiskAnalyzer)');
    if (!process.env.OBSERVER_MODEL) missingInternalModels.push('OBSERVER_MODEL (ObserverValidator)');
    if (missingInternalModels.length > 0) {
        log.warn(`⚠️  Modelos internos não configurados (usando defaults): ${missingInternalModels.join(', ')}`);
        log.warn('   → Configure em: Dashboard → Modelos → Modelos dos Componentes Internos → Salvar & Reiniciar');
    }

    // Aplicar restore de banco de dados pendente (agendado pela rota /backup/restore)
    const dataDir           = path.join(process.cwd(), 'data');
    const restorePendingFlag = path.join(dataDir, '.restore-pending');
    const restoreSource      = path.join(dataDir, 'newclaw.db.restore');
    const dbMain             = path.join(dataDir, 'newclaw.db');
    if (fs.existsSync(restorePendingFlag) && fs.existsSync(restoreSource)) {
        log.info('🔄 Restauração de banco de dados pendente — aplicando antes de iniciar...');
        try {
            // replaceDatabaseFile remove o WAL/SHM do banco ATUAL antes de substituí-lo — sem
            // isso o SQLite, ao abrir o banco restaurado, encontra um WAL de outro banco e aplica
            // seus frames → "disk image is malformed", e o autoRecoverDatabase reverteria o restore
            // silenciosamente. Mesmo helper usado pela auto-recuperação (dbRecovery.ts) — ponto único.
            replaceDatabaseFile(restoreSource, dbMain);
            fs.unlinkSync(restoreSource);
            fs.unlinkSync(restorePendingFlag);
            log.info('✅ Banco de dados restaurado com sucesso.');
        } catch (restoreErr) {
            log.error('restore_failed', restoreErr instanceof Error ? restoreErr : undefined, 'Falha ao restaurar banco — usando banco existente');
            try { fs.unlinkSync(restorePendingFlag); } catch { /* limpa flag mesmo em erro */ }
        }
    }

    let controller: AgentController;
    try {
        controller = new AgentController(config);
    } catch (startupErr) {
        const msg = startupErr instanceof Error ? startupErr.message : String(startupErr);
        const isCorrupted = /malformed|corrupt|disk image|SQLITE_CORRUPT/i.test(msg);
        if (!isCorrupted) throw startupErr;

        // Banco corrompido: tenta auto-recuperação antes de desistir
        const recovered = autoRecoverDatabase(dataDir);
        if (!recovered) {
            log.error('startup_aborted', undefined,
                'Banco corrompido e sem backup válido para recuperação.\n' +
                'Execute: newclaw restore\n' +
                '(se o CLI não responder: node scripts/recover-db.cjs)'
            );
            process.exit(1);
        }
        // Retry após recuperação
        controller = new AgentController(config);
    }

    // Start Dashboard
    const dashboard = new DashboardServer(config);
    dashboard.setController(controller);
    dashboard.setProviderFactory(controller.getProviderFactory());
    dashboard.setModelRegistryService(controller.getModelRegistryService());
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
