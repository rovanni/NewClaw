import { ProviderFactory } from './ProviderFactory';
import { OpenAIProvider } from './OpenAIProvider';
import { ModelInfo, CustomProviderConfig } from './providerTypes';
import { createLogger } from '../shared/AppLogger';
import { errorMessage } from '../shared/errors';

const log = createLogger('ModelRegistryService');

/** Evita bater nos providers a cada request — 30s é curto o bastante para refletir um pull/unload recente. */
const CACHE_TTL_MS = 30_000;

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
