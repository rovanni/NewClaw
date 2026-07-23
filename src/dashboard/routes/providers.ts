import { Router, Request, Response } from 'express';
import { errorMessage } from '../../shared/errors';
import { createLogger } from '../../shared/AppLogger';
import { DashboardContext } from './types';
import { persistConfigToEnv } from './config';
import { interpretOllamaPullFailure, interpretOllamaPullException } from './ollamaPullError';

/** Teto de segurança pro pull — generoso o bastante pra um download local real grande, mas finito:
 *  evita que um nome ambíguo (Ollama tenta resolver e nunca responde) prenda a requisição pra sempre. */
const OLLAMA_PULL_TIMEOUT_MS = 5 * 60_000;

const log = createLogger('Dashboardserver');

export function createProvidersRouter(ctx: DashboardContext): Router {
    const router = Router();

    router.get('/providers', async (_req: Request, res: Response) => {
        let ollamaModels: string[] = [];
        try {
            // Fonte única de discovery — ModelRegistryService delega para OllamaProvider.discoverModels(),
            // que é o mesmo /api/tags que antes era chamado inline aqui (agora só num lugar).
            if (ctx.modelRegistryService) {
                const catalog = await ctx.modelRegistryService.getCatalog();
                ollamaModels = catalog.filter(m => m.provider === 'ollama').map(m => m.id);
            }
        } catch (err) {
            log.warn(`Could not fetch Ollama models for dashboard: ${errorMessage(err)}`);
        }

        const knownCloudModels = [
            'glm-5.2:cloud', 'glm-5.1:cloud', 'glm-5:cloud', 'glm-4:cloud',
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

        const customModels: string[] = ctx.config.customModels || [];

        const allModels = [...new Set([
            ...ollamaModels,
            ...knownCloudModels,
            ...userModels,
            ...customModels
        ])].sort();

        const customProviders = (ctx.config.customProviders || []).map(p => ({
            label: p.label,
            baseUrl: p.baseUrl,
            available: true,
            hasKey: !!p.apiKey,
        }));

        res.json({
            success: true,
            providers: {
                gemini:      { available: !!ctx.config.geminiApiKey,      name: 'Google Gemini' },
                deepseek:    { available: !!ctx.config.deepseekApiKey,    name: 'DeepSeek' },
                groq:        { available: !!ctx.config.groqApiKey,        name: 'Groq' },
                openrouter:  { available: !!ctx.config.openrouterApiKey,  name: 'OpenRouter' },
                anthropic:   { available: !!ctx.config.anthropicApiKey,   name: 'Anthropic (Claude)' },
                ollama:      { available: true, name: 'Ollama (Local/Cloud)', url: ctx.config.ollamaUrl, models: allModels },
            },
            customProviders,
            health: ctx.modelRegistryService?.getLastHealth() || [],
            currentProvider: ctx.config.defaultProvider,
            currentModel: currentModel || 'unknown'
        });
    });

    router.post('/providers/custom', (req: Request, res: Response) => {
        const { label, baseUrl, apiKey } = req.body;
        if (!label?.trim() || !baseUrl?.trim()) {
            return res.status(400).json({ success: false, error: 'label e baseUrl são obrigatórios' });
        }
        const customProviders = ctx.config.customProviders || [];
        const name = String(label).trim();
        if (customProviders.some(p => p.label === name)) {
            return res.status(400).json({ success: false, error: `Já existe um provider "${name}"` });
        }
        customProviders.push({ label: name, baseUrl: String(baseUrl).trim(), apiKey: apiKey ? String(apiKey) : undefined });
        ctx.config.customProviders = customProviders;
        persistConfigToEnv(ctx);
        log.info(`Custom provider added: ${name} (${baseUrl})`);
        res.json({ success: true, message: `Provider "${name}" adicionado` });
    });

    router.delete('/providers/custom/:label', (req: Request, res: Response) => {
        const { label } = req.params;
        const customProviders = ctx.config.customProviders || [];
        const next = customProviders.filter(p => p.label !== label);
        if (next.length === customProviders.length) {
            return res.status(404).json({ success: false, error: `Provider "${label}" não encontrado` });
        }
        ctx.config.customProviders = next;
        persistConfigToEnv(ctx);
        log.info(`Custom provider removed: ${label}`);
        res.json({ success: true });
    });

    router.post('/models/add', (req: Request, res: Response) => {
        const { model } = req.body;
        if (!model || !model.trim()) return res.status(400).json({ error: 'Model name required' });
        const customModels: string[] = ctx.config.customModels || [];
        const name = model.trim();
        if (!customModels.includes(name)) {
            customModels.push(name);
            ctx.config.customModels = customModels;
            persistConfigToEnv(ctx);
        }
        res.json({ success: true, message: `Model "${name}" added to list` });
    });

    router.delete('/key/:provider', (req: Request, res: Response) => {
        const { provider } = req.params;
        switch (provider) {
            case 'gemini':
                ctx.config.geminiApiKey = undefined;
                ctx.providerFactory?.removeCredential('geminiKey');
                break;
            case 'deepseek':
                ctx.config.deepseekApiKey = undefined;
                ctx.providerFactory?.removeCredential('deepseekKey');
                break;
            case 'groq':
                ctx.config.groqApiKey = undefined;
                ctx.providerFactory?.removeCredential('groqKey');
                break;
            case 'openrouter':
                ctx.config.openrouterApiKey = undefined;
                ctx.providerFactory?.removeCredential('openrouterKey');
                break;
            case 'anthropic':
                ctx.config.anthropicApiKey = undefined;
                ctx.providerFactory?.removeCredential('anthropicKey');
                break;
            default:
                return res.status(400).json({ error: `Unknown provider: ${provider}` });
        }
        persistConfigToEnv(ctx);
        log.info(`API key removed for provider: ${provider}`);
        res.json({ success: true });
    });

    router.post('/ollama/pull', async (req: Request, res: Response) => {
        const { model } = req.body;
        if (!model) return res.status(400).json({ error: 'Model name required' });

        const ollamaUrl = ctx.config.ollamaUrl || 'http://localhost:11434';
        try {
            const pullRes = await fetch(`${ollamaUrl}/api/pull`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: model, stream: false }),
                signal: AbortSignal.timeout(OLLAMA_PULL_TIMEOUT_MS)
            });
            if (pullRes.ok) {
                res.json({ success: true, message: `Model "${model}" pulled successfully` });
            } else {
                const errText = await pullRes.text();
                const { status, error } = interpretOllamaPullFailure(model, errText);
                res.status(status).json({ success: false, error });
            }
        } catch (err) {
            const { status, error } = interpretOllamaPullException(model, err);
            res.status(status).json({ success: false, error });
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
