import { ProviderFactory } from './ProviderFactory';
import { OpenAIProvider } from './OpenAIProvider';
import { ModelInfo, CustomProviderConfig } from './providerTypes';
import { createLogger } from '../shared/AppLogger';
import { errorMessage } from '../shared/errors';
import { guessCapabilities } from './modelCapabilityHeuristics';

const log = createLogger('ModelRegistryService');

/** Os 5 provedores nativos de nuvem por API key — validados por `discoverModels()` da mesma forma
 *  que Ollama/custom, quando a key estiver configurada (fatia de validação de providers,
 *  2026-08-19). Ollama fica de fora desta lista porque já tem seu próprio caminho dedicado acima. */
const NATIVE_KEY_PROVIDERS = ['gemini', 'deepseek', 'groq', 'openrouter', 'anthropic'] as const;

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
    /**
     * O provedor está no ar mas ainda CARREGANDO o modelo — terceiro estado, distinto de online
     * e de offline.
     *
     * Um servidor local (llamafile) abre a porta assim que sobe e responde 503 durante toda a
     * carga, que pode passar de dois minutos. Sem esta distinção o painel afirma "provedor
     * indisponível" justamente enquanto ele está subindo, e o operador conclui que falhou.
     */
    loading?: boolean;
}

/**
 * Fachada fina de descoberta de modelos — delega para os adapters que já implementam
 * discoverModels() (OllamaProvider, OpenAIProvider) em vez de embutir a lógica de rede aqui.
 * Não é um God Object: cache + normalização são a única responsabilidade própria desta classe.
 * Ver docs/analises-arquiteturais/ANALISE_ARQUITETURAL_MODEL_REGISTRY_2026-07-22.md (Fase 2-3) para o racional.
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
                // 503 = servidor no ar, modelo ainda carregando. Não é falha: registrar como tal
                // encheria o log de "discovery failed" durante toda a carga (foi o que aconteceu
                // em 02/08/2026 — dezenas de linhas idênticas enquanto o modelo subia) e faria a
                // tela declarar o provedor fora do ar no pior momento possível.
                const carregando = (err as { status?: number }).status === 503;
                if (carregando) {
                    log.info(`${custom.label}: servidor no ar, modelo ainda carregando (503)`);
                } else {
                    log.warn(`${custom.label} discovery failed: ${errorMessage(err)}`);
                }
                health.push({
                    provider: custom.label,
                    baseUrl: custom.baseUrl,
                    online: false,
                    loading: carregando,
                    modelCount: 0,
                    error: errorMessage(err),
                });
            }
        }

        // Provedores nativos de nuvem — só entram na varredura se já estiverem registrados no
        // ProviderFactory, o que só acontece com API key configurada (mesma regra que já vale
        // pra registro no construtor, herdada aqui, não reimplementada). O objetivo desta fatia é
        // validação de autenticação/configuração pra `computeSystemReady()`, não um catálogo de
        // modelos na UI — por isso `results` recebe os modelos descobertos (consistência com o
        // formato que Ollama/custom já produzem), mas nenhuma tela nova é construída em cima disso.
        for (const name of NATIVE_KEY_PROVIDERS) {
            const provider = this.providerFactory.getNativeProvider(name);
            if (!provider?.discoverModels) continue;
            try {
                const models = await provider.discoverModels();
                results.push(...models);
                health.push({ provider: name, online: true, modelCount: models.length });
            } catch (err) {
                log.warn(`${name} discovery failed: ${errorMessage(err)}`);
                health.push({ provider: name, online: false, modelCount: 0, error: errorMessage(err) });
            }
        }

        this.cache = results;
        this.cacheAt = Date.now();
        this.lastHealth = health;
        return results;
    }
}
