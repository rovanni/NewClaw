/**
 * ModelRouter — Roteamento inteligente de modelos por tipo de tarefa
 * 
 * Estratégia: classificação baseada em INTENÇÃO (criar vs perguntar vs saudar),
 * não em tópicos específicos. Funciona para qualquer idioma e qualquer assunto.
 * 
 * Fluxo: LLM classifica → fallback determinístico → default.
 */

// Perfil de modelos por categoria
export interface ModelProfile {
    id: string;           // Identificador único
    model: string;       // Nome no Ollama
    server: string;      // URL do servidor Ollama
    category: 'chat' | 'code' | 'vision' | 'light' | 'analysis' | 'execution';
    description: string; // Descrição humana
    maxTokens?: number;  // Limite de contexto (opcional)
}

export interface RouterConfig {
    defaultProfile: string;
    profiles: ModelProfile[];
    classifierModel: string;
    classifierServer: string;     // Servidor do classificador
    fallbackRules: FallbackRule[]; // Regras determinísticas de fallback
}

export interface FallbackRule {
    category: string;
    keywords: string[];
    patterns: RegExp[];
}

// Categorias válidas
const VALID_CATEGORIES = ['chat', 'code', 'vision', 'light', 'analysis', 'execution'] as const;
type Category = typeof VALID_CATEGORIES[number];

// ── Intent-based descriptions ──────────────────────────────────────
// Focus on WHAT THE USER WANTS TO DO, not what topic they're talking about
const CATEGORY_DESCRIPTIONS: Record<Category, string> = {
    chat: 'Questions, explanations, opinions, reasoning — the user wants INFORMATION, not a file',
    code: 'The user wants to CREATE, BUILD, GENERATE, EDIT, or FIX something — any file, document, page, script, app, or artifact',
    vision: 'Image analysis, photos, screenshots, OCR',
    light: 'Short greetings or acknowledgements: hi, ok, thanks, bye',
    analysis: 'Data analysis, financial markets, crypto prices, statistics',
    execution: 'Complex tasks, tool loops, multi-step agent execution and reasoning'
};

const DEFAULT_CONFIG: RouterConfig = {
    defaultProfile: 'chat-primary',
    classifierModel: "gemma4:31b-cloud",
    classifierServer: 'http://localhost:11434',
    profiles: [
        { id: 'chat-primary', model: 'gemma4:31b-cloud', server: 'http://localhost:11434', category: 'chat', description: 'Conversa geral e raciocínio' },
        { id: 'code-primary', model: 'gemma4:31b-cloud', server: 'http://localhost:11434', category: 'code', description: 'Programação e criação de conteúdo' },
        { id: 'light-chat', model: 'gemma4:31b-cloud', server: 'http://localhost:11434', category: 'light', description: 'Conversa leve e rápida' },
        { id: 'vision-primary', model: 'gemma4:31b-cloud', server: 'http://localhost:11434', category: 'vision', description: 'Análise de imagens e OCR' },
        { id: 'analysis-primary', model: 'kimi-k2.6:cloud', server: 'http://localhost:11434', category: 'analysis', description: 'Análise profunda e cripto' },
        { id: 'execution-primary', model: 'kimi-k2.6:cloud', server: 'http://localhost:11434', category: 'execution', description: 'Execução de ferramentas e tarefas complexas' },
    ],
    fallbackRules: [
        {
            category: 'code',
            keywords: ['código', 'programar', 'html', 'css', 'js', 'python', 'script', 'bug', 'debug', 'arquivo', 'file'],
            patterns: [/\b(cod|prog|html|css|js|python|script|bug|debug|edit|modify|patch)\w*\b/i]
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

// Cache de classificação (evita chamar LLM pra mesma query)
const classificationCache = new Map<string, { category: Category; timestamp: number }>();
const CACHE_TTL = 300000; // 5 minutos

export class ModelRouter {
    private config: RouterConfig;
    private usageLog: Map<string, number> = new Map();
    private providerFactory?: any; // Avoiding circular dependency by using any

    constructor(config?: any, providerFactory?: any) {
        this.config = { ...DEFAULT_CONFIG };
        this.providerFactory = providerFactory;
        
        if (config) {
            // Se vier do Dashboard/Env, mapeia os modelos individuais para os perfis
            const categories: Array<Category> = ['chat', 'code', 'vision', 'light', 'analysis', 'execution'];
            for (const cat of categories) {
                if (config[cat]) {
                    const profile = this.config.profiles.find(p => p.category === cat);
                    if (profile) {
                        console.log(`[MODEL_ROUTER] Overriding ${cat} model with: ${config[cat]}`);
                        profile.model = config[cat];
                    }
                }
            }

            // Outras configs
            if (config.classifierModel) this.config.classifierModel = config.classifierModel;
            if (config.classifierServer) this.config.classifierServer = config.classifierServer;
        }
    }

    /**
     * Roteamento principal: Puramente determinístico (rápido).
     */
    async route(query: string): Promise<ModelProfile> {
        try {
            // Primary: LLM classification
            const category = await this.llmClassify(query);
            const profile = this.getProfileByCategory(category);
            if (profile) {
                console.log(`[MODEL_ROUTER] LLM routing: ${category} → ${profile.model}`);
                this.logUsage(profile.id);
                return profile;
            }
        } catch (err) {
            console.warn(`[MODEL_ROUTER] LLM classification failed: ${(err as Error).message}. Falling back to deterministic.`);
        }

        // Fallback: Deterministic classification
        const category = this.fallbackClassify(query);
        const profile = this.getProfileByCategory(category);
        
        if (profile) {
            this.logUsage(profile.id);
            console.log(`[MODEL_ROUTER] Deterministic routing: ${category} → ${profile.model}`);
            return profile;
        }

        return this.getProfileByCategory('chat')!;
    }

    /**
     * Synchronous route (for non-async contexts — uses fallback only).
     */
    routeSync(query: string): ModelProfile {
        const category = this.fallbackClassify(query);
        const profile = this.getProfileByCategory(category);
        return profile || this.config.profiles.find(p => p.id === this.config.defaultProfile) || this.config.profiles[0];
    }

    /**
     * LLM classification: pede ao modelo leve para classificar a query.
     * Retorna exatamente uma categoria: chat, code, vision, light, analysis
     * 
     * The prompt is intentionally multilingual and intent-based.
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
            // Use ProviderFactory for classification if available, otherwise fallback to fetch
            if ((this as any).providerFactory) {
                const factory = (this as any).providerFactory as ProviderFactory;
                const response = await factory.chatWithFallback([
                    { role: 'user', content: prompt }
                ], [], undefined, 15000);
                
                const content = (response.content || '').trim().toLowerCase();
                for (const cat of VALID_CATEGORIES) {
                    if (content.includes(cat)) return cat;
                }
                const firstWord = content.split(/\s+/)[0].replace(/[^a-z]/g, '');
                if (VALID_CATEGORIES.includes(firstWord as Category)) return firstWord as Category;
            }

            // Legacy fetch fallback (Ollama only)
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000);
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

            const data = await response.json() as any;
            const content = (data.message?.content || '').trim().toLowerCase();

            for (const cat of VALID_CATEGORIES) {
                if (content.includes(cat)) return cat;
            }

            const firstWord = content.split(/\s+/)[0].replace(/[^a-z]/g, '');
            if (VALID_CATEGORIES.includes(firstWord as Category)) return firstWord as Category;

            throw new Error(`Invalid classification: "${content}"`);
        } catch (err) {
            console.warn(`[MODEL_ROUTER] LLM classification error: ${(err as Error).message}`);
            throw err;
        }
    }

    /**
     * Deterministic fallback: intent-based verb detection + keyword matching.
     * 
     * Strategy: detect ACTION VERBS (create, build, make, write, etc.) to identify
     * "code" intent regardless of the topic. This makes the fallback work for
     * any subject — from "create a physics lesson" to "build me a game".
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

    private getProfileByCategory(category: Category): ModelProfile | undefined {
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

    /**
     * Retorna o modelo configurado para EXECUÇÃO (Agent Loop).
     * Se não configurado explicitamente, faz fallback para o modelo de CHAT.
     */
    getExecutionModel(): string {
        const profile = this.getProfileByCategory('execution');
        if (profile) return profile.model;

        // Fallback para chat
        const chatProfile = this.getProfileByCategory('chat');
        return chatProfile?.model || this.config.profiles[0].model;
    }

    /**
     * Retorna o perfil completo de EXECUÇÃO.
     */
    getExecutionProfile(): ModelProfile {
        const profile = this.getProfileByCategory('execution');
        if (profile) return profile;

        const chatProfile = this.getProfileByCategory('chat');
        return chatProfile || this.config.profiles[0];
    }
}