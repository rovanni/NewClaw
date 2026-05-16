import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { errorMessage } from '../../shared/errors';
import { createLogger } from '../../shared/AppLogger';
import { DashboardContext, ExtendedConfig } from './types';

const log = createLogger('Dashboardserver');

export function persistConfigToEnv(ctx: DashboardContext): void {
    try {
        const envPath = path.join(process.cwd(), '.env');

        let envContent = '';
        if (fs.existsSync(envPath)) {
            envContent = fs.readFileSync(envPath, 'utf-8');
        }

        const updates: Record<string, string> = {
            'DEFAULT_PROVIDER': ctx.config.defaultProvider,
            'APP_LANG': ctx.config.language,
            'OLLAMA_MODEL': ctx.config.ollamaModel || '',
            'OLLAMA_URL': ctx.config.ollamaUrl || 'http://localhost:11434',
            'MAX_ITERATIONS': String(ctx.config.maxIterations),
            'MEMORY_WINDOW_SIZE': String(ctx.config.memoryWindowSize),
            'TELEGRAM_ALLOWED_USER_IDS': ctx.config.telegramAllowedUserIds.join(','),
            'MODEL_CHAT': ctx.config.modelRouter?.chat || '',
            'MODEL_CODE': ctx.config.modelRouter?.code || '',
            'MODEL_VISION': ctx.config.modelRouter?.vision || '',
            'MODEL_LIGHT': ctx.config.modelRouter?.light || '',
            'MODEL_ANALYSIS': ctx.config.modelRouter?.analysis || '',
            'MODEL_EXECUTION': ctx.config.modelRouter?.execution || '',
            'VISION_SERVER': ctx.config.modelRouter?.visionServer || '',
            'CLASSIFIER_MODEL': ctx.config.modelRouter?.classifierModel || '',
            'CLASSIFIER_SERVER': ctx.config.modelRouter?.classifierServer || '',
        };

        if (ctx.config.ollamaApiKey) updates['OLLAMA_API_KEY'] = ctx.config.ollamaApiKey;
        if (ctx.config.systemPrompt) updates['SYSTEM_PROMPT'] = ctx.config.systemPrompt;

        try {
            const mm = ctx.controller ? (ctx.controller as unknown as { memory?: { db?: import('better-sqlite3').Database } }).memory : null;
            if (mm && mm.db) {
                mm.db.prepare('UPDATE agent_config SET is_active = 0').run();
                mm.db.prepare('INSERT INTO agent_config (config_json, is_active) VALUES (?, 1)').run(JSON.stringify(ctx.config));
            }
        } catch { /* DB not available, skip */ }

        for (const [key, value] of Object.entries(updates)) {
            const regex = new RegExp(`^${key}=.*$`, 'm');
            if (regex.test(envContent)) {
                envContent = envContent.replace(regex, `${key}=${value}`);
            } else {
                envContent += `\n${key}=${value}`;
            }
        }

        fs.writeFileSync(envPath, envContent.trim() + '\n');
        log.info(`Persisted to .env: ${Object.keys(updates).join(', ')}`);
    } catch (error) {
        log.error(`Failed to persist .env: ${errorMessage(error)}`);
    }
}

export function createConfigRouter(ctx: DashboardContext): Router {
    const router = Router();

    router.get('/', (_req: Request, res: Response) => {
        const ollama = ctx.config.ollamaUrl ? ctx.providerFactory?.getOllamaProvider() : undefined;
        res.json({
            success: true,
            config: {
                language: ctx.config.language,
                defaultProvider: ctx.config.defaultProvider,
                currentModel: ctx.providerFactory?.getCurrentModel() || ctx.config.ollamaModel || 'unknown',
                maxIterations: ctx.config.maxIterations,
                memoryWindowSize: ctx.config.memoryWindowSize,
                whisperPath: ctx.config.whisperPath,
                ollamaUrl: ctx.config.ollamaUrl,
                ollamaModel: ctx.config.ollamaModel || ollama?.getModel() || 'glm-5.1:cloud',
                ollamaApiKey: ctx.config.ollamaApiKey ? '••••' : '',
                systemPrompt: ctx.config.systemPrompt || '',
                telegramAllowedUserIds: ctx.config.telegramAllowedUserIds.join(','),
                hasGeminiKey: !!ctx.config.geminiApiKey,
                hasDeepseekKey: !!ctx.config.deepseekApiKey,
                hasGroqKey: !!ctx.config.groqApiKey,
                hasOllamaApiKey: !!ctx.config.ollamaApiKey,
                modelRouter: ctx.config.modelRouter || {}
            }
        });
    });

    router.post('/', (req: Request, res: Response) => {
        const { language, defaultProvider, maxIterations, memoryWindowSize, systemPrompt, ollamaModel, ollamaApiKey, ollamaUrl, telegramAllowedUserIds, modelRouter } = req.body;

        log.info(`POST /api/config — ollamaModel="${ollamaModel}" provider="${defaultProvider}"`);

        if (language) ctx.config.language = language;
        if (systemPrompt !== undefined) ctx.config.systemPrompt = systemPrompt;
        if (maxIterations) ctx.config.maxIterations = parseInt(String(maxIterations));
        if (memoryWindowSize) ctx.config.memoryWindowSize = parseInt(String(memoryWindowSize));

        if (telegramAllowedUserIds !== undefined) {
            ctx.config.telegramAllowedUserIds = String(telegramAllowedUserIds).split(',').map(id => id.trim()).filter(id => id);
            log.info(`Telegram whitelist updated: ${ctx.config.telegramAllowedUserIds.join(', ')}`);
            log.info(`💡 Para gerenciar usuários autorizados e outras configurações, acesse o Dashboard em: http://localhost:${ctx.config.dashboardPort || 3090}/config`);
        }

        if (defaultProvider) {
            try {
                ctx.providerFactory?.setDefaultProvider(defaultProvider);
                ctx.config.defaultProvider = defaultProvider;
                log.info(`Provider switched to: ${defaultProvider}`);
            } catch (err) {
                log.error(`Provider switch failed: ${errorMessage(err)}`);
                return res.status(400).json({ success: false, error: errorMessage(err) });
            }
        }

        if (ollamaModel) {
            const previousModel = ctx.config.ollamaModel;
            ctx.config.ollamaModel = ollamaModel;
            const ollama = ctx.providerFactory?.getOllamaProvider();
            if (ollama) {
                ollama.setModel(ollamaModel);
                log.info(`Ollama model switched: ${previousModel} → ${ollamaModel}`);
            } else {
                log.warn(`Ollama provider not available for model switch`);
            }
        }

        if (ollamaUrl) {
            ctx.config.ollamaUrl = ollamaUrl;
            log.info(`Ollama URL changed: ${ollamaUrl}`);
            const ollama = ctx.providerFactory?.getOllamaProvider();
            if (ollama) ollama.setBaseUrl(ollamaUrl);
        }

        if (ollamaApiKey) {
            ctx.config.ollamaApiKey = ollamaApiKey;
        }

        if (modelRouter) {
            ctx.config.modelRouter = { ...(ctx.config.modelRouter || {}), ...modelRouter };
            log.info(`ModelRouter updated: ${JSON.stringify(ctx.config.modelRouter)}`);
        }

        if (ctx.controller) {
            const loop = (ctx.controller as unknown as { agentLoop: { updateConfig?: (cfg: Record<string, unknown>) => void } }).agentLoop;
            if (loop && typeof loop.updateConfig === 'function') {
                loop.updateConfig({
                    maxIterations: ctx.config.maxIterations,
                    systemPrompt: ctx.config.systemPrompt || '',
                    modelRouter: ctx.config.modelRouter
                });
            }
        }

        persistConfigToEnv(ctx);

        const safeConfig = {
            language: ctx.config.language,
            defaultProvider: ctx.config.defaultProvider,
            currentModel: ctx.providerFactory?.getCurrentModel() || ctx.config.ollamaModel,
            maxIterations: ctx.config.maxIterations,
            memoryWindowSize: ctx.config.memoryWindowSize,
            ollamaUrl: ctx.config.ollamaUrl,
            ollamaModel: ctx.config.ollamaModel,
            telegramAllowedUserIds: ctx.config.telegramAllowedUserIds.join(','),
            systemPrompt: ctx.config.systemPrompt || '',
            hasGeminiKey: !!ctx.config.geminiApiKey,
            hasDeepseekKey: !!ctx.config.deepseekApiKey,
            hasGroqKey: !!ctx.config.groqApiKey,
            hasOllamaApiKey: !!ctx.config.ollamaApiKey,
            modelRouter: ctx.config.modelRouter || {}
        };
        res.json({ success: true, config: safeConfig });
    });

    router.get('/history', (_req: Request, res: Response) => {
        try {
            const mm = ctx.controller?.getMemory() ?? null;
            if (!mm) return res.status(500).json({ error: 'DB not available' });
            const db = mm.getDatabase();
            const history = db.prepare('SELECT id, config_json, created_at, is_active FROM agent_config ORDER BY created_at DESC LIMIT 20').all() as Array<{ id: string; config_json: string; created_at: string; is_active: number }>;
            res.json({ success: true, history: history.map(h => ({ ...h, config: JSON.parse(h.config_json) })) });
        } catch (err) {
            res.status(500).json({ error: errorMessage(err) });
        }
    });

    return router;
}

export { ExtendedConfig };
