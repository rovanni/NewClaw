/**
 * ModelProfileRegistry — Registry e resolução de perfis de modelo por categoria
 *
 * Responsabilidade: mapear category → ModelProfile (model, server, maxTokens).
 * NÃO classifica intenção — isso é responsabilidade do UnifiedIntentRouter.
 *
 * Fluxo de resolução:
 *   1. Determinístico (0ms) — keyword/regex matching
 *   2. LLM leve como fallback para casos ambíguos
 *   3. Default profile se tudo falhar
 */

import { ProviderFactory } from '../core/ProviderFactory';
import { createLogger } from '../shared/AppLogger';
const log = createLogger('ModelProfileRegistry');

// Perfil de modelos por categoria
export interface ModelProfile {
    id: string;           // Identificador único
    model: string;        // Nome do modelo no provider (ex: 'gemma4:31b-cloud', 'gpt-4o', 'google/gemini-2.0-flash')
    server: string;       // URL do servidor (usado apenas para Ollama)
    provider?: string;    // Provider a usar: 'ollama' | 'openrouter' | 'gemini' | 'groq' | 'deepseek' — undefined = defaultProvider
    category: 'chat' | 'code' | 'vision' | 'light' | 'analysis' | 'execution';
    description: string;  // Descrição humana
    maxTokens?: number;   // Limite de contexto (opcional)
}

export interface ProfileRegistryConfig {
    defaultProfile: string;
    profiles: ModelProfile[];
    classifierModel: string;
    classifierServer: string;
    fallbackRules: FallbackRule[];
}

export interface FallbackRule {
    category: string;
    keywords: string[];
    patterns: RegExp[];
}

// Categorias válidas
const VALID_CATEGORIES = ['chat', 'code', 'vision', 'light', 'analysis', 'execution'] as const;
type Category = typeof VALID_CATEGORIES[number];

// Descrições baseadas em INTENÇÃO — funciona para qualquer idioma/assunto
const CATEGORY_DESCRIPTIONS: Record<Category, string> = {
    chat: 'Questions, explanations, opinions, reasoning — the user wants INFORMATION, not a file',
    code: 'The user wants to CREATE, BUILD, GENERATE, EDIT, or FIX something — any file, document, page, script, app, or artifact',
    vision: 'Image analysis, photos, screenshots, OCR',
    light: 'Short greetings or acknowledgements: hi, ok, thanks, bye',
    analysis: 'Data analysis, financial markets, crypto prices, statistics',
    execution: 'Complex tasks, tool loops, multi-step agent execution and reasoning'
};

const DEFAULT_CONFIG: ProfileRegistryConfig = {
    defaultProfile: 'chat-primary',
    classifierModel: "gemma4:31b-cloud",
    classifierServer: 'http://localhost:11434',
    profiles: [
        { id: 'chat-primary',      provider: 'ollama', model: 'glm-5.1:cloud',   server: 'http://localhost:11434', category: 'chat',      description: 'Conversa geral e raciocínio' },
        { id: 'code-primary',      provider: 'ollama', model: 'gemma4:31b-cloud', server: 'http://localhost:11434', category: 'code',      description: 'Programação e criação de conteúdo' },
        { id: 'light-chat',        provider: 'ollama', model: 'glm-5.1:cloud',   server: 'http://localhost:11434', category: 'light',     description: 'Conversa leve e rápida' },
        { id: 'vision-primary',    provider: 'ollama', model: 'gemma4:31b-cloud', server: 'http://localhost:11434', category: 'vision',    description: 'Análise de imagens e OCR' },
        { id: 'analysis-primary',  provider: 'ollama', model: 'kimi-k2.6:cloud', server: 'http://localhost:11434', category: 'analysis',  description: 'Análise profunda e cripto' },
        { id: 'execution-primary', provider: 'ollama', model: 'kimi-k2.6:cloud', server: 'http://localhost:11434', category: 'execution', description: 'Execução de ferramentas e tarefas complexas' },
    ],
    fallbackRules: [
        {
            category: 'light',
            keywords: ['oi', 'olá', 'ola', 'hey', 'hi', 'hello', 'tchau', 'bye', 'obrigado', 'valeu', 'ok', 'valeu', 'bom dia', 'boa tarde', 'boa noite', 'thanks'],
            patterns: [/^(oi[!.]?|ol[áa][!.]?|hey[!.]?|hi[!.]?|hello[!.]?|tchau[!.]?|bye[!.]?|obrigad[oa][!.]?|valeu[!.]?|ok[!.]?|bom dia|boa tarde|boa noite|thanks)$/i]
        },
        {
            category: 'code',
            keywords: ['código', 'programar', 'html', 'css', 'js', 'python', 'script', 'bug', 'debug', 'arquivo', 'file', 'criar', 'gerar', 'fazer', 'build'],
            patterns: [/\b(cod|prog|html|css|js|python|script|bug|debug|edit|modify|patch|creat|generat|build|mak)\w*\b/i]
        },
        {
            category: 'vision',
            keywords: ['imagem', 'foto', 'screenshot', 'print', 'ocr'],
            patterns: [/\b(imag|foto|screenshot|print|ocr|vis[uã])\w*\b/i]
        },
        {
            category: 'analysis',
            keywords: ['preço', 'price', 'mercado', 'market', 'trending', 'cripto', 'crypto'],
            patterns: [/\b(analis|analy[sz]|pre[cç]o|price|cripto|crypto|mercado|market|token|coin)\w*\b/i]
        }
    ]
};

export class ModelProfileRegistry {
    private config: ProfileRegistryConfig;
    private usageLog: Map<string, number> = new Map();
    private providerFactory: ProviderFactory | null = null;

    constructor(config?: Partial<ProfileRegistryConfig> & Record<string, string>, providerFactory?: ProviderFactory) {
        this.config = { ...DEFAULT_CONFIG };
        this.providerFactory = providerFactory || null;

        if (config) {
            // Mapeia modelos e providers individuais vindos do Dashboard/Env para os perfis
            const categories: Array<Category> = ['chat', 'code', 'vision', 'light', 'analysis', 'execution'];
            for (const cat of categories) {
                const profile = this.config.profiles.find(p => p.category === cat);
                if (!profile) continue;
                if (config[cat]) {
                    log.info(`Overriding ${cat} model: ${config[cat]}`);
                    profile.model = config[cat];
                }
                const providerKey = `provider_${cat}`;
                if (config[providerKey]) {
                    log.info(`Overriding ${cat} provider: ${config[providerKey]}`);
                    profile.provider = config[providerKey];
                }
            }

            if (config.classifierModel) this.config.classifierModel = config.classifierModel;
            if (config.classifierServer) this.config.classifierServer = config.classifierServer;
        }
    }

    /**
     * Resolução de perfil: determinístico primeiro (0ms), LLM como fallback.
     */
    async resolveProfile(query: string): Promise<ModelProfile> {
        // 1. Deterministic classification FIRST (0ms, instant)
        const detCategory = this.fallbackClassify(query);
        if (detCategory !== 'chat') {
            const profile = this.getProfileByCategory(detCategory);
            if (profile) {
                this.logUsage(profile.id);
                log.info(`Deterministic profile resolution: ${detCategory} → ${profile.model}`);
                return profile;
            }
        }

        // 2. LLM classification para casos ambíguos/chat/light
        try {
            const category = await this.llmClassify(query);
            const profile = this.getProfileByCategory(category);
            if (profile) {
                log.info(`LLM profile resolution: ${category} → ${profile.model}`);
                this.logUsage(profile.id);
                return profile;
            }
        } catch (err) {
            log.warn(`LLM classification failed: ${(err as Error).message}. Falling back to deterministic.`);
        }

        // 3. Fallback final
        const category = this.fallbackClassify(query);
        const profile = this.getProfileByCategory(category);
        if (profile) {
            this.logUsage(profile.id);
            log.info(`Fallback profile resolution: ${category} → ${profile.model}`);
            return profile;
        }

        return this.getProfileByCategory('chat')
            ?? this.config.profiles.find(p => p.id === this.config.defaultProfile)
            ?? this.config.profiles[0];
    }

    /**
     * Resolução síncrona de perfil (apenas determinístico — para contextos não-async).
     */
    resolveProfileSync(query: string): ModelProfile {
        const category = this.fallbackClassify(query);
        const profile = this.getProfileByCategory(category);
        return profile || this.config.profiles.find(p => p.id === this.config.defaultProfile) || this.config.profiles[0];
    }

    /**
     * LLM classification: modelo leve classifica a query em uma categoria.
     */
    private async llmClassify(query: string): Promise<Category> {
        const prompt = `Classify this message into ONE category. Reply with ONLY the category word, nothing else.

KEY RULE: If the user asks to CREATE, BUILD, MAKE, WRITE, or GENERATE anything (a file, page, lesson, app, document, etc.), the category is ALWAYS "code" — regardless of the topic.

Categories:
- code: ${CATEGORY_DESCRIPTIONS.code}
- chat: ${CATEGORY_DESCRIPTIONS.chat}
- vision: ${CATEGORY_DESCRIPTIONS.vision}
- light: ${CATEGORY_DESCRIPTIONS.light}
- analysis: ${CATEGORY_DESCRIPTIONS.analysis}

Message: "${query.slice(0, 200)}"

Category:`;

        try {
            if (this.providerFactory) {
                const response = await this.providerFactory.classifyWithFallback([
                    { role: 'user', content: prompt }
                ], 60000);

                const content = (response.content || '').trim().toLowerCase();
                for (const cat of VALID_CATEGORIES) {
                    if (content.includes(cat)) return cat;
                }
                const firstWord = content.split(/\s+/)[0].replace(/[^a-z]/g, '');
                if (VALID_CATEGORIES.includes(firstWord as Category)) return firstWord as Category;
            }

            // Fallback legado: Ollama direto, bypassa fila de geração
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 60000);
            const response = await fetch(`${this.config.classifierServer}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify({
                    model: this.config.classifierModel,
                    messages: [{ role: 'user', content: prompt }],
                    stream: false,
                    options: { temperature: 0.1, num_predict: 10 }
                })
            });
            clearTimeout(timeout);

            if (!response.ok) throw new Error(`API error: ${response.status}`);

            const data = await response.json() as { message?: { content?: string } };
            const content = (data.message?.content || '').trim().toLowerCase();

            for (const cat of VALID_CATEGORIES) {
                if (content.includes(cat)) return cat;
            }

            const firstWord = content.split(/\s+/)[0].replace(/[^a-z]/g, '');
            if (VALID_CATEGORIES.includes(firstWord as Category)) return firstWord as Category;

            throw new Error(`Invalid classification: "${content}"`);
        } catch (err) {
            log.warn(`LLM classification error: ${(err as Error).message}`);
            throw err;
        }
    }

    /**
     * Classificação determinística por verbos de intenção e keywords.
     * Funciona para qualquer assunto — detecta AÇÃO, não tópico.
     */
    private fallbackClassify(query: string): Category {
        const lower = query.toLowerCase();
        let bestCategory: Category = 'chat';
        let bestScore = 0;

        for (const rule of this.config.fallbackRules) {
            let score = 0;
            for (const kw of rule.keywords) {
                if (lower.includes(kw.toLowerCase())) score += 2;
            }
            for (const pattern of rule.patterns) {
                if (pattern.test(lower)) score += 3;
            }
            if (score > bestScore) {
                bestScore = score;
                bestCategory = rule.category as Category;
            }
        }

        return bestCategory;
    }

    getProfileByCategory(category: Category): ModelProfile | undefined {
        return this.config.profiles.find(p => p.category === category);
    }

    getProfile(id: string): ModelProfile | undefined {
        return this.config.profiles.find(p => p.id === id);
    }

    getProfiles(): ModelProfile[] {
        return this.config.profiles;
    }

    setProfile(profile: ModelProfile): void {
        const idx = this.config.profiles.findIndex(p => p.id === profile.id);
        if (idx >= 0) this.config.profiles[idx] = profile;
        else this.config.profiles.push(profile);
    }

    setDefault(profileId: string): void {
        if (this.config.profiles.some(p => p.id === profileId)) {
            this.config.defaultProfile = profileId;
        }
    }

    getUsageStats(): Record<string, number> {
        return Object.fromEntries(this.usageLog);
    }

    private logUsage(profileId: string): void {
        this.usageLog.set(profileId, (this.usageLog.get(profileId) || 0) + 1);
    }

    /** Retorna o modelo configurado para execução. Fallback: chat. */
    getExecutionModel(): string {
        const profile = this.getProfileByCategory('execution');
        if (profile) return profile.model;
        return this.getProfileByCategory('chat')?.model || this.config.profiles[0].model;
    }

    /** Retorna o perfil completo de execução. Fallback: chat. */
    getExecutionProfile(): ModelProfile {
        return this.getProfileByCategory('execution')
            ?? this.getProfileByCategory('chat')
            ?? this.config.profiles[0];
    }
}
