import { ProviderFactory } from './ProviderFactory';
import { OpenAIProvider } from './OpenAIProvider';
import { ModelInfo, CustomProviderConfig } from './providerTypes';
import { createLogger } from '../shared/AppLogger';
import { errorMessage } from '../shared/errors';
import { guessCapabilities } from './modelCapabilityHeuristics';

const log = createLogger('ModelRegistryService');

/** Evita bater nos providers a cada request — 30s é curto o bastante para refletir um pull/unload recente. */
const CACHE_TTL_MS = 30_000;

/** Catálogo remoto muda raramente — TTL maior evita bater em ollama.com a cada troca de aba. */
const CLOUD_CATALOG_TTL_MS = 10 * 60_000;

/**
 * Endpoint público (não documentado oficialmente) que devolve o catálogo de modelos oferecidos
 * pela Ollama Cloud — mesmo formato de /api/tags local. Confirmado ao vivo (22/07/2026): nomes
 * "puros" (sem ':') instalam corretamente como "<nome>:cloud" (ex: "kimi-k2.5" → pull
 * "kimi-k2.5:cloud" funciona; pull do nome puro falha com "manifest does not exist"). Nomes que já
 * vêm com tag explícita (ex: "gemma4:31b") são ignorados aqui — podem ser variantes de download
 * local grande (GBs), não o registro leve de cloud que esta função promete.
 */
const CLOUD_CATALOG_URL = 'https://ollama.com/api/tags';

export interface ProviderHealth {
    provider: string;
    baseUrl?: string;
    online: boolean;
    modelCount: number;
    error?: string;
}

/**
 * Fachada fina de descoberta de modelos — delega para os adapters que já implementam
 * discoverModels() (OllamaProvider, OpenAIProvider) em vez de embutir a lógica de rede aqui.
 * Não é um God Object: cache + normalização são a única responsabilidade própria desta classe.
 * Ver docs/ANALISE_ARQUITETURAL_MODEL_REGISTRY_2026-07-22.md (Fase 2-3) para o racional.
 */
export class ModelRegistryService {
    private cache: ModelInfo[] | null = null;
    private cacheAt = 0;
    private lastHealth: ProviderHealth[] = [];
    private cloudCatalogCache: ModelInfo[] | null = null;
    private cloudCatalogCacheAt = 0;

    constructor(
        private readonly providerFactory: ProviderFactory,
        private readonly getCustomProviders: () => CustomProviderConfig[] = () => []
    ) {}

    /** Catálogo com cache de curta duração. Use forceRefresh para ignorar o cache (botão "Sincronizar"). */
    async getCatalog(forceRefresh = false): Promise<ModelInfo[]> {
        if (!forceRefresh && this.cache && (Date.now() - this.cacheAt) < CACHE_TTL_MS) {
            return this.cache;
        }
        return this.discoverAll();
    }

    getLastHealth(): ProviderHealth[] {
        return this.lastHealth;
    }

    /**
     * Catálogo COMPLETO de modelos oferecidos pela Ollama Cloud, ainda não necessariamente
     * instalados localmente — sem pré-filtro do lado do servidor (decisão do usuário: mostrar
     * tudo, ele decide o que instalar; a UI oferece busca/filtro em vez de esconder opções).
     * Best-effort: dependência externa não documentada — qualquer falha (rede, formato mudou,
     * endpoint saiu do ar) devolve o cache anterior (ou vazio) em vez de propagar o erro, para
     * nunca derrubar a tela do Registry por causa disso.
     */
    async getCloudCatalog(forceRefresh = false): Promise<ModelInfo[]> {
        if (!forceRefresh && this.cloudCatalogCache && (Date.now() - this.cloudCatalogCacheAt) < CLOUD_CATALOG_TTL_MS) {
            return this.cloudCatalogCache;
        }
        try {
            const resp = await fetch(CLOUD_CATALOG_URL, { signal: AbortSignal.timeout(5000) });
            if (!resp.ok) throw new Error(`${CLOUD_CATALOG_URL} error: ${resp.status}`);
            const data = await resp.json() as { models?: Array<{ name: string }> };
            const models: ModelInfo[] = (data.models || [])
                .filter(m => !!m.name)
                .map(m => {
                    // Nomes "puros" (sem tag) precisam de ":cloud" pra instalar (confirmado ao
                    // vivo). Nomes que já vêm com tag (ex: "gemma4:31b") são usados como estão —
                    // não há como inferir com segurança um sufixo adicional sem testar cada um.
                    const pullId = m.name.includes(':') ? m.name : `${m.name}:cloud`;
                    return {
                        id: pullId,
                        provider: 'ollama-cloud',
                        label: pullId,
                        capabilities: guessCapabilities(m.name),
                        status: 'available' as const,
                    };
                });
            this.cloudCatalogCache = models;
            this.cloudCatalogCacheAt = Date.now();
            return models;
        } catch (err) {
            log.warn(`Cloud catalog fetch failed (external, best-effort): ${errorMessage(err)}`);
            return this.cloudCatalogCache || [];
        }
    }

    async discoverAll(): Promise<ModelInfo[]> {
        const results: ModelInfo[] = [];
        const health: ProviderHealth[] = [];

        const ollama = this.providerFactory.getOllamaProvider();
        if (ollama) {
            try {
                const models = await ollama.discoverModels();
                results.push(...models);
                health.push({ provider: 'ollama', baseUrl: ollama.getBaseUrl(), online: true, modelCount: models.length });
            } catch (err) {
                log.warn(`Ollama discovery failed: ${errorMessage(err)}`);
                health.push({ provider: 'ollama', baseUrl: ollama.getBaseUrl(), online: false, modelCount: 0, error: errorMessage(err) });
            }
        }

        for (const custom of this.getCustomProviders()) {
            const provider = new OpenAIProvider(custom.apiKey || '', undefined, custom.baseUrl, custom.label);
            try {
                const models = await provider.discoverModels();
                results.push(...models);
                health.push({ provider: custom.label, baseUrl: custom.baseUrl, online: true, modelCount: models.length });
            } catch (err) {
                log.warn(`${custom.label} discovery failed: ${errorMessage(err)}`);
                health.push({ provider: custom.label, baseUrl: custom.baseUrl, online: false, modelCount: 0, error: errorMessage(err) });
            }
        }

        this.cache = results;
        this.cacheAt = Date.now();
        this.lastHealth = health;
        return results;
    }
}
