import { Router, Request, Response } from 'express';
import { errorMessage } from '../../shared/errors';
import { createLogger } from '../../shared/AppLogger';
import { DashboardContext } from './types';
import { OpenAIProvider } from '../../core/OpenAIProvider';
import { getLastKnownLocalServer } from '../../core/localRuntimeState';
import { persistConfigToEnv, logEnvPersistResult } from './config';
import { interpretOllamaPullFailure, interpretOllamaPullException } from './ollamaPullError';

/** Teto de segurança pro pull — generoso o bastante pra um download local real grande, mas finito:
 *  evita que um nome ambíguo (Ollama tenta resolver e nunca responde) prenda a requisição pra sempre. */
const OLLAMA_PULL_TIMEOUT_MS = 5 * 60_000;

/** Teste de conexão é interativo (usuário esperando na tela) — curto de propósito: um servidor
 *  local que não responde em 10s está inutilizável para chat de qualquer forma. */
const PROVIDER_TEST_TIMEOUT_MS = 10_000;

const log = createLogger('Dashboardserver');

export function createProvidersRouter(ctx: DashboardContext): Router {
    const router = Router();

    router.get('/providers', async (req: Request, res: Response) => {
        // `?refresh=1` — a UI pede redescoberta quando ACABOU de mudar o mundo (carregou um modelo
        // local, parou um servidor, cadastrou um provider). Sem isso, a resposta vinha do cache de
        // 30s do catálogo e `getLastHealth()` devolvia a saúde da descoberta ANTERIOR: quem
        // carregava um modelo local via a tela continuar dizendo "não está carregado" sobre um
        // servidor que já estava no ar (evidência: log do operador em 04/08/2026 — servidor pronto
        // às 13:14:14, última descoberta às 13:13:44, nenhuma depois).
        const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
        let ollamaModels: string[] = [];
        try {
            // Fonte única de discovery — ModelRegistryService delega para OllamaProvider.discoverModels(),
            // que é o mesmo /api/tags que antes era chamado inline aqui (agora só num lugar).
            if (ctx.modelRegistryService) {
                const catalog = await ctx.modelRegistryService.getCatalog(forceRefresh);
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
            model: p.model,
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
            // Vai junto do health porque a UI precisa dos dois para decidir se oferece "carregar
            // agora": provedor local offline + existe um modelo que estava carregado = a máquina
            // foi reiniciada e o modelo não voltou. Leitura de arquivo, sem custo de rede.
            lastKnownLocalModel: getLastKnownLocalServer(),
            currentProvider: ctx.config.defaultProvider,
            currentModel: currentModel || 'unknown'
        });
    });

    // Testa um endpoint OpenAI-Compatible ANTES de cadastrá-lo — o que faltava para "colocar o
    // endereço e testar". Nenhuma lógica de rede nova: reusa OpenAIProvider.discoverModels(), o
    // mesmo GET /models que o ModelRegistryService já usa para montar o catálogo, e não persiste
    // nada (nem config, nem instância no ProviderFactory). Devolver a LISTA de modelos, e não só
    // um ok/falhou, é o ponto: é ela que diz ao usuário quais nomes o servidor dele aceita — em
    // servidores de modelo único (llamafile) costuma vir um id só, e é esse que vale.
    router.post('/providers/test', async (req: Request, res: Response) => {
        const { baseUrl, apiKey } = req.body;
        if (!baseUrl?.trim()) {
            return res.status(400).json({ success: false, error: 'baseUrl é obrigatório' });
        }
        // Sem regex para o trim de barras finais (CodeQL js/polynomial-redos): `/\/+$/` não é
        // catastroficamente lento neste caso (âncora simples, sem grupos ambíguos), mas
        // `baseUrl` é 100% controlado pelo cliente da rota — troca por um loop determinístico
        // remove a classe de risco por completo em vez de argumentar que o regex específico é
        // seguro hoje.
        let url = String(baseUrl).trim();
        while (url.endsWith('/')) url = url.slice(0, -1);
        if (!/^https?:\/\//i.test(url)) {
            return res.status(400).json({ success: false, error: 'baseUrl deve começar com http:// ou https://' });
        }
        try {
            const probe = new OpenAIProvider(apiKey ? String(apiKey) : '', undefined, url, 'test');
            // discoverModels() não expõe AbortSignal — o teto de tempo fica aqui para que um
            // host que aceita a conexão e nunca responde não pendure a requisição do dashboard.
            const models = await Promise.race([
                probe.discoverModels(),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('Timeout')), PROVIDER_TEST_TIMEOUT_MS)
                ),
            ]);
            log.info(`Provider test OK: ${url} (${models.length} modelos)`);
            res.json({ success: true, online: true, models: models.map(m => m.id) });
        } catch (err) {
            // 200 com online:false, não 5xx: "o endpoint do usuário não respondeu" é um RESULTADO
            // de teste bem-sucedido, não uma falha do dashboard — a UI precisa da mensagem para
            // exibi-la, e um status de erro faria o wrapper de fetch tratá-la como erro de rota.
            log.info(`Provider test FAILED: ${url} — ${errorMessage(err)}`);
            res.json({ success: true, online: false, models: [], error: errorMessage(err) });
        }
    });

    router.post('/providers/custom', (req: Request, res: Response) => {
        const { label, baseUrl, apiKey, model } = req.body;
        if (!label?.trim() || !baseUrl?.trim()) {
            return res.status(400).json({ success: false, error: 'label e baseUrl são obrigatórios' });
        }
        const customProviders = ctx.config.customProviders || [];
        const name = String(label).trim();
        if (customProviders.some(p => p.label === name)) {
            return res.status(400).json({ success: false, error: `Já existe um provider "${name}"` });
        }
        const entry = {
            label: name,
            baseUrl: String(baseUrl).trim(),
            apiKey: apiKey ? String(apiKey) : undefined,
            model: model ? String(model).trim() : undefined,
        };
        customProviders.push(entry);
        ctx.config.customProviders = customProviders;
        logEnvPersistResult(persistConfigToEnv(ctx), 'POST /providers/custom');
        // Sem isto, o provider aparece na lista/config mas nunca entra de fato no fallback
        // automático do ProviderFactory — só existe no config até o próximo restart (achado ao
        // investigar viabilidade de fallback pra modelos locais via llamafile, 2026-07-31).
        ctx.providerFactory?.addCustomProvider(entry);
        log.info(`Custom provider added: ${name} (${baseUrl})`);
        res.json({ success: true, message: `Provider "${name}" adicionado` });
    });

    // Edita um provider custom já cadastrado (baseUrl/apiKey/model) sem precisar remover e
    // recriar — achado real (2026-07-31): sem isso, um erro de digitação na URL ou querer trocar
    // o modelo exigia apagar o card inteiro e preencher tudo de novo, e não havia como corrigir
    // uma adição feita sem querer (ex.: clique duplo) a não ser apagando. A label em si não pode
    // ser editada aqui (ela é a chave de identidade do provider no Map do ProviderFactory —
    // renomear é equivalente a remover+adicionar, então usa as rotas já existentes pra isso).
    router.put('/providers/custom/:label', (req: Request, res: Response) => {
        const { label } = req.params;
        const name = String(label);
        const { baseUrl, apiKey, model } = req.body;
        if (!baseUrl?.trim()) {
            return res.status(400).json({ success: false, error: 'baseUrl é obrigatório' });
        }
        const customProviders = ctx.config.customProviders || [];
        const idx = customProviders.findIndex(p => p.label === name);
        if (idx === -1) {
            return res.status(404).json({ success: false, error: `Provider "${name}" não encontrado` });
        }
        const updated = {
            label: name,
            baseUrl: String(baseUrl).trim(),
            // apiKey/model vazios no body apagam o valor anterior (usuário limpou o campo de
            // propósito) — só undefined (campo nem enviado) preserva o que já estava salvo.
            apiKey: apiKey !== undefined ? (apiKey ? String(apiKey) : undefined) : customProviders[idx].apiKey,
            model: model !== undefined ? (model ? String(model).trim() : undefined) : customProviders[idx].model,
        };
        customProviders[idx] = updated;
        ctx.config.customProviders = customProviders;
        logEnvPersistResult(persistConfigToEnv(ctx), 'PUT /providers/custom/:label');
        // addCustomProvider() sobrescreve a instância existente no Map (mesma label = mesma
        // chave) — não precisa remover antes, Map.set() já substitui.
        ctx.providerFactory?.addCustomProvider(updated);
        log.info(`Custom provider updated: ${name} (${updated.baseUrl})`);
        res.json({ success: true, message: `Provider "${name}" atualizado` });
    });

    router.delete('/providers/custom/:label', (req: Request, res: Response) => {
        const { label } = req.params;
        const customProviders = ctx.config.customProviders || [];
        const next = customProviders.filter(p => p.label !== label);
        if (next.length === customProviders.length) {
            return res.status(404).json({ success: false, error: `Provider "${label}" não encontrado` });
        }
        ctx.config.customProviders = next;
        logEnvPersistResult(persistConfigToEnv(ctx), 'DELETE /providers/custom/:label');
        ctx.providerFactory?.removeCustomProvider(String(label));
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
            logEnvPersistResult(persistConfigToEnv(ctx), 'POST /models/add');
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
        logEnvPersistResult(persistConfigToEnv(ctx), 'DELETE /key/:provider');
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
