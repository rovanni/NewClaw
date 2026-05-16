import { Router, Request, Response } from 'express';
import { errorMessage } from '../../shared/errors';
import { createLogger } from '../../shared/AppLogger';
import { DashboardContext, ExtendedConfig } from './types';

const log = createLogger('Dashboardserver');

export function createProvidersRouter(ctx: DashboardContext): Router {
    const router = Router();

    router.get('/providers', async (_req: Request, res: Response) => {
        let ollamaModels: string[] = [];
        try {
            const ollamaUrl = ctx.config.ollamaUrl || 'http://localhost:11434';
            const resp = await fetch(`${ollamaUrl}/api/tags`);
            if (resp.ok) {
                const data = await resp.json() as { models?: Array<{ name: string }> };
                ollamaModels = (data.models || []).map(m => m.name);
            }
        } catch (err) {
            log.warn(`Could not fetch Ollama models for dashboard: ${errorMessage(err)}`);
        }

        const knownCloudModels = [
            'glm-5:cloud', 'glm-5.1:cloud', 'glm-4:cloud',
            'kimi-k2:cloud', 'kimi-k2.6:cloud',
            'deepseek-r1:cloud', 'deepseek-v3:cloud',
            'qwen3:cloud', 'qwen3-235b:cloud',
            'gemma4:cloud', 'gemma4:e4b',
            'llama4:cloud', 'llama4-maverick:cloud',
            'phi-4:cloud',
        ];

        const userModels: string[] = [];
        if (ctx.config.modelRouter) {
            const mr = ctx.config.modelRouter;
            [mr.chat, mr.code, mr.vision, mr.light, mr.analysis, mr.execution].forEach(m => {
                if (m && m.trim()) userModels.push(m.trim());
            });
        }

        const currentModel = ctx.providerFactory?.getCurrentModel() || ctx.config.ollamaModel;
        if (currentModel) userModels.push(currentModel);

        const customModels: string[] = (ctx.config as ExtendedConfig).customModels || [];

        const allModels = [...new Set([
            ...ollamaModels,
            ...knownCloudModels,
            ...userModels,
            ...customModels
        ])].sort();

        res.json({
            success: true,
            providers: {
                gemini: { available: !!ctx.config.geminiApiKey, name: 'Google Gemini' },
                deepseek: { available: !!ctx.config.deepseekApiKey, name: 'DeepSeek' },
                groq: { available: !!ctx.config.groqApiKey, name: 'Groq' },
                ollama: { available: true, name: 'Ollama (Local/Cloud)', url: ctx.config.ollamaUrl, models: allModels },
            },
            currentProvider: ctx.config.defaultProvider,
            currentModel: currentModel || 'unknown'
        });
    });

    router.post('/models/add', (req: Request, res: Response) => {
        const { model } = req.body;
        if (!model || !model.trim()) return res.status(400).json({ error: 'Model name required' });
        const customModels: string[] = (ctx.config as ExtendedConfig).customModels || [];
        const name = model.trim();
        if (!customModels.includes(name)) {
            customModels.push(name);
            (ctx.config as ExtendedConfig).customModels = customModels;
        }
        res.json({ success: true, message: `Model "${name}" added to list` });
    });

    router.post('/ollama/pull', async (req: Request, res: Response) => {
        const { model } = req.body;
        if (!model) return res.status(400).json({ error: 'Model name required' });

        const ollamaUrl = ctx.config.ollamaUrl || 'http://localhost:11434';
        try {
            const pullRes = await fetch(`${ollamaUrl}/api/pull`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: model, stream: false })
            });
            if (pullRes.ok) {
                res.json({ success: true, message: `Model "${model}" pulled successfully` });
            } else {
                const errText = await pullRes.text();
                res.status(500).json({ success: false, error: `Pull failed: ${errText.slice(0, 200)}` });
            }
        } catch (err) {
            res.status(500).json({ success: false, error: errorMessage(err) });
        }
    });

    router.get('/ollama/exists/:model', async (req: Request, res: Response) => {
        const model = String(req.params.model);
        const ollamaUrl = ctx.config.ollamaUrl || 'http://localhost:11434';
        try {
            const resp = await fetch(`${ollamaUrl}/api/tags`);
            if (resp.ok) {
                const data = await resp.json() as { models?: Array<{ name: string }> };
                const models: string[] = (data.models || []).map(m => m.name);
                const exists = models.includes(model);
                res.json({ success: true, model, exists, models });
            } else {
                res.json({ success: true, model, exists: false });
            }
        } catch {
            res.json({ success: true, model, exists: false });
        }
    });

    return router;
}
