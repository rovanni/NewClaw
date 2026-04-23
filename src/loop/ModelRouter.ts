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
    category: 'chat' | 'code' | 'vision' | 'light' | 'analysis';
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
const VALID_CATEGORIES = ['chat', 'code', 'vision', 'light', 'analysis'] as const;
type Category = typeof VALID_CATEGORIES[number];

// ── Intent-based descriptions ──────────────────────────────────────
// Focus on WHAT THE USER WANTS TO DO, not what topic they're talking about
const CATEGORY_DESCRIPTIONS: Record<Category, string> = {
    chat: 'Questions, explanations, opinions, reasoning — the user wants INFORMATION, not a file',
    code: 'The user wants to CREATE, BUILD, GENERATE, EDIT, or FIX something — any file, document, page, script, app, or artifact',
    vision: 'Image analysis, photos, screenshots, OCR',
    light: 'Short greetings or acknowledgements: hi, ok, thanks, bye',
    analysis: 'Data analysis, financial markets, crypto prices, statistics'
};

const DEFAULT_CONFIG: RouterConfig = {
    defaultProfile: 'chat-primary',
    classifierModel: "glm-5.1:cloud",
    classifierServer: 'http://localhost:11434',
    profiles: [
        { id: 'chat-primary', model: 'glm-5.1:cloud', server: 'http://localhost:11434', category: 'chat', description: 'Conversa geral e raciocínio' },
        { id: 'code-primary', model: 'gemma4:31b-cloud', server: 'http://localhost:11434', category: 'code', description: 'Programação e edição de código' },
        { id: 'light-chat', model: 'glm-5.1:cloud', server: 'http://localhost:11434', category: 'light', description: 'Conversa leve e rápida' },
        { id: 'vision-primary', model: 'gemma4:31b-cloud', server: 'http://localhost:11434', category: 'vision', description: 'Análise de imagens e OCR' },
        { id: 'analysis-primary', model: 'glm-5:cloud', server: 'http://localhost:11434', category: 'analysis', description: 'Análise profunda e cripto' },
    ],
    fallbackRules: [
        // ── code: detect ACTION VERBS (imperative/creation intent) ──
        // Works for any language topic: "create a lesson", "build a game", "write a poem page"
        {
            category: 'code',
            keywords: [
                // Programming-specific (PT + EN)
                'código', 'programar', 'html', 'css', 'javascript', 'python', 'script',
                'bug', 'debug', 'patch', 'deploy', 'commit', 'api', 'json', 'sql',
                'function', 'class', 'module', 'component', 'endpoint',
                // File operations
                'arquivo', 'file', 'pasta', 'folder', 'diretório', 'directory',
            ],
            patterns: [
                // Programming terms
                /\b(cod|prog|html|css|js|python|script|bug|debug|edit|modify|patch|function|class)\w*\b/i,
                // PT: Action verbs (imperative) — "crie X", "faça X", "monte X", etc.
                /\b(cri[ae]r?|fa[cç]a|mont[ae]r?|ger[ae]r?|constru[aí]r?|desenvolv[ae]r?|escrev[ae]r?|produz[ai]r?|implement[ae]r?|codifiqu[ae]|edit[ae]r?|modifiqu[ae]|alter[ae]r?|corrij[ae]|atualiz[ae]r?|refator[ae]r?|configur[ae]r?|instal[ae]r?|prepar[ae]r?)\b/i,
                // EN: Action verbs — "create X", "build X", "make X", etc.
                /\b(create|make|build|write|generate|develop|implement|fix|update|refactor|setup|install|configure|deploy)\b/i,
            ]
        },
        // ── vision ──
        {
            category: 'vision',
            keywords: ['imagem', 'foto', 'screenshot', 'print', 'ocr'],
            patterns: [/\b(imag|foto|screenshot|print|ocr|vis[uã]|picture|photo)\w*\b/i]
        },
        // ── light: only matches very short, standalone greetings ──
        {
            category: 'light',
            keywords: [],
            patterns: [/^[\s]*(sim|s|nao|não|n|ok|obrigad[oa]|valeu|tchau|oi|olá|hey|eai|blz|hi|hello|thanks?|bye|yes|no|yep|nope)[\s!.?]*$/i]
        },
        // ── analysis ──
        {
            category: 'analysis',
            keywords: ['preço', 'price', 'mercado', 'market', 'trending', 'portfolio'],
            patterns: [/\b(analis|analy[sz]|pre[cç]o|price|cripto|crypto|mercado|market|trend|portfolio|invest|trade|token|coin)\w*\b/i]
        },
    ]
};

// Cache de classificação (evita chamar LLM pra mesma query)
const classificationCache = new Map<string, { category: Category; timestamp: number }>();
const CACHE_TTL = 300000; // 5 minutos

export class ModelRouter {
    private config: RouterConfig;
    private usageLog: Map<string, number> = new Map();

    constructor(config?: Partial<RouterConfig>) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Roteamento principal: LLM classifica, fallback determinístico.
     */
    async route(query: string): Promise<ModelProfile> {
        // 1. Cache check
        const cached = classificationCache.get(query);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
            const profile = this.getProfileByCategory(cached.category);
            if (profile) {
                console.log(`[MODEL_ROUTER] Cache hit: ${cached.category} → ${profile.model}`);
                return profile;
            }
        }

        // 2. LLM classification
        try {
            const category = await this.llmClassify(query);
            classificationCache.set(query, { category, timestamp: Date.now() });
            const profile = this.getProfileByCategory(category);
            if (profile) {
                this.logUsage(profile.id);
                console.log(`[MODEL_ROUTER] LLM classified: ${category} → ${profile.model}`);
                return profile;
            }
        } catch (e) {
            console.log(`[MODEL_ROUTER] LLM classification failed, using fallback: ${e}`);
        }

        // 3. Deterministic fallback
        const fallbackCategory = this.fallbackClassify(query);
        const profile = this.getProfileByCategory(fallbackCategory);
        if (profile) {
            this.logUsage(profile.id);
            console.log(`[MODEL_ROUTER] Fallback: ${fallbackCategory} → ${profile.model}`);
            return profile;
        }

        // 4. Default
        const defaultProfile = this.config.profiles.find(p => p.id === this.config.defaultProfile);
        return defaultProfile || this.config.profiles[0];
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

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout

        try {
            const response = await fetch(`${this.config.classifierServer}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify({
                    model: this.config.classifierModel,
                    messages: [{ role: 'user', content: prompt }],
                    stream: false,
                    options: { temperature: 0.1, num_predict: 10 } // Máximo 10 tokens
                })
            });
            clearTimeout(timeout);

            if (!response.ok) throw new Error(`API error: ${response.status}`);

            const data = await response.json() as any;
            const content = (data.message?.content || '').trim().toLowerCase();

            // Parse: extrair categoria da resposta
            for (const cat of VALID_CATEGORIES) {
                if (content.includes(cat)) {
                    return cat;
                }
            }

            // Se não encontrou, tentar parsear a primeira palavra
            const firstWord = content.split(/\s+/)[0].replace(/[^a-z]/g, '');
            if (VALID_CATEGORIES.includes(firstWord as Category)) {
                return firstWord as Category;
            }

            throw new Error(`Invalid classification: "${content}"`);
        } finally {
            clearTimeout(timeout);
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
}