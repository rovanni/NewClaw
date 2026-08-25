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

import { ProviderFactory, RESERVED_PROVIDER_NAMES } from '../core/ProviderFactory';
import { createLogger } from '../shared/AppLogger';
import { keywordBoundaryMatches } from '../shared/keywordBoundary';
import { isLocalModelFile } from '../shared/localModelFile';
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
    // Vazio de propósito (issue 019): sem CLASSIFIER_MODEL configurado, o classificador usa o
    // modelo do provedor ativo em vez de pedir um modelo de nuvem que a instalação pode não ter.
    classifierModel: "",
    classifierServer: 'http://localhost:11434',
    // `provider` deliberadamente AUSENTE nos defaults — ver o contrato declarado em ModelProfile
    // acima ("undefined = defaultProvider"). Antes cada perfil vinha com provider:'ollama' fixo,
    // o que contradizia esse contrato e tornava o "Provider padrão" do dashboard decorativo: o
    // AgentLoop passa chatProfile.provider como `preferred` para chatWithFallback(), então um
    // 'ollama' hardcoded aqui sobrescrevia, em toda requisição, qualquer DEFAULT_PROVIDER
    // escolhido pelo usuário. Só um PROVIDER_<CATEGORIA> explícito (Provider por perfil, na UI)
    // preenche este campo agora — que é exatamente o que a opção "— herdar padrão —" promete.
    // Para quem usa DEFAULT_PROVIDER=ollama (o caso comum) a ordem final é idêntica à anterior.
    profiles: [
        { id: 'chat-primary',      model: 'glm-5.2:cloud',   server: 'http://localhost:11434', category: 'chat',      description: 'Conversa geral e raciocínio' },
        { id: 'code-primary',      model: 'gemma4:31b-cloud', server: 'http://localhost:11434', category: 'code',      description: 'Programação e criação de conteúdo' },
        { id: 'light-chat',        model: 'glm-5.2:cloud',   server: 'http://localhost:11434', category: 'light',     description: 'Conversa leve e rápida' },
        { id: 'vision-primary',    model: 'gemma4:31b-cloud', server: 'http://localhost:11434', category: 'vision',    description: 'Análise de imagens e OCR' },
        { id: 'analysis-primary',  model: 'kimi-k2.6:cloud', server: 'http://localhost:11434', category: 'analysis',  description: 'Análise profunda e cripto' },
        { id: 'execution-primary', model: 'kimi-k2.6:cloud', server: 'http://localhost:11434', category: 'execution', description: 'Execução de ferramentas e tarefas complexas' },
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
        // Cópia rasa de DEFAULT_CONFIG copiaria a REFERÊNCIA do array `profiles` — e o laço logo
        // abaixo escreve em `profile.model`/`profile.provider`, ou seja, gravaria na constante do
        // módulo. Efeito: um registry construído com config poluía os defaults de qualquer outro
        // registry criado depois no mesmo processo. Cada instância recebe seus próprios objetos
        // (RFC-004, Princípio 1; cobertura S196).
        this.config = {
            ...DEFAULT_CONFIG,
            profiles: DEFAULT_CONFIG.profiles.map(p => ({ ...p })),
        };
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
    async resolveProfile(query: string): Promise<Readonly<ModelProfile>> {
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

        return this.getProfileByCategory('chat') ?? this.defaultProfileCopy();
    }

    /** Cópia do perfil padrão (ou do primeiro, se o padrão não existir). Nunca a referência. */
    private defaultProfileCopy(): Readonly<ModelProfile> {
        const found = this.config.profiles.find(p => p.id === this.config.defaultProfile)
            ?? this.config.profiles[0];
        return { ...found };
    }

    /** Retorna o modelo configurado para classificação rápida. */
    getClassifierModel(): string {
        return this.config.classifierModel;
    }

    /**
     * Resolução síncrona de perfil (apenas determinístico — para contextos não-async).
     */
    resolveProfileSync(query: string): Readonly<ModelProfile> {
        const category = this.fallbackClassify(query);
        return this.getProfileByCategory(category) ?? this.defaultProfileCopy();
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
                // Keywords curtas (≤6 chars, ex: "file", "js", "ok") colidem como substring
                // acidental dentro de palavras não relacionadas (ex: "file" dentro de "desfile") —
                // mesma classe de bug corrigida em DomainRegistry.ts/UnifiedIntentRouter.ts nesta
                // sessão. keywordBoundaryMatches() (allowPluralS default) evita isso sem quebrar
                // o plural regular ("bug"→"bugs", "script"→"scripts").
                const kwLower = kw.toLowerCase();
                const matched = kwLower.length <= 6
                    ? keywordBoundaryMatches(lower, kwLower)
                    : lower.includes(kwLower);
                if (matched) score += 2;
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

    // ── Leitura: sempre cópia, nunca a referência interna ───────────────────────
    //
    // RFC-004, Princípio 1 — "configuração compartilhada é imutável para quem lê". Estes métodos
    // devolviam o próprio objeto do array de perfis. Um único chamador (AgentLoop, override de
    // modelo pelo roteador de intenção) escrevia nesse objeto e reatribuía `category`; quando o
    // perfil sorteado era o de visão e a intenção classificada era `execution`, o perfil de visão
    // deixava de existir para `getProfileByCategory('vision')` — o sistema ficava permanentemente
    // cego para imagens, sem lançar exceção e sem registrar erro, até reiniciar o processo.
    // Incidente real de 04/08/2026; a escrita continua possível, só que por `setProfile()`.

    // ── Perfil para chamadas que enviam SOMENTE TEXTO ──────────────────────────
    //
    // O perfil `vision` existe para quem envia bytes de imagem ao modelo. Hoje um único ponto do
    // projeto faz isso: `processVision`, na ingestão — é o único lugar que popula `images:[base64]`
    // numa LLMMessage. Quando a ingestão termina, a imagem já virou TEXTO (a descrição) e nada mais
    // no turno é imagem.
    //
    // Selecionar o modelo de visão para o turno de raciocínio é, portanto, escolher a ferramenta
    // pela etiqueta e não pela tarefa: pede-se a um modelo escolhido por saber OLHAR que RACIOCINE
    // sobre vários KB de texto — coisa que modelos multimodais pequenos costumam fazer mal.
    //
    // Observado em produção (05/08/2026): três imagens analisadas corretamente (2016, 1818 e 2496
    // caracteres de descrição), e a resposta final ignorou tudo, agarrando a palavra "projetos" da
    // memória do sistema. O roteador havia classificado o turno como `vision` e trocado o modelo
    // para o perfil de visão — um modelo local de 4B parâmetros — que respondeu no lugar do modelo
    // de chat. Ficou visível porque o provider de chat estava fora do ar, mas o desvio existe
    // sempre que a classificação dá `vision`.
    //
    // Há DOIS caminhos que levavam a isso, e ambos passam por aqui:
    //   1. o override por `IntentDecision.modelCategory === 'vision'`;
    //   2. `resolveProfile()`, cuja heurística pontua "imagem"/"foto" — e o texto do turno contém
    //      `[IMAGEM RECEBIDA: ...]`, escrito pela própria ingestão. O sistema classificava como
    //      visão o texto que ele mesmo produziu.
    //
    // A regra vive aqui, e não no chamador, para valer também para qualquer consumidor futuro que
    // envie apenas texto.

    /** Categoria de raciocínio equivalente, quando a categoria pedida é de percepção. */
    private textCategoryFor(category: Category): Category {
        if (category !== 'vision') return category;
        // 'chat' é o destino natural: descrever/explicar/interpretar conteúdo já extraído.
        return this.getProfileByCategoryRaw('chat') ? 'chat' : 'execution';
    }

    /**
     * Resolve o perfil de um turno que envia SOMENTE texto ao modelo.
     * Idêntico a `resolveProfile`, exceto que nunca devolve o perfil de visão.
     */
    async resolveTextProfile(query: string): Promise<Readonly<ModelProfile>> {
        const profile = await this.resolveProfile(query);
        if (profile.category !== 'vision') return profile;

        const replacement = this.getProfileByCategory(this.textCategoryFor('vision'));
        log.info(`[TEXT-TURN] perfil 'vision' substituído por '${replacement?.category}' — o turno não envia imagem ao modelo`);
        return replacement ?? profile;
    }

    /**
     * Perfil por categoria para um turno que envia SOMENTE texto.
     * Pedir `vision` aqui devolve o perfil de raciocínio equivalente.
     */
    getTextProfileByCategory(category: Category): Readonly<ModelProfile> | undefined {
        const effective = this.textCategoryFor(category);
        if (effective !== category) {
            log.info(`[TEXT-TURN] categoria '${category}' → '${effective}' — o turno não envia imagem ao modelo`);
        }
        return this.getProfileByCategory(effective);
    }

    /** Acesso interno sem cópia — só para checar existência. */
    private getProfileByCategoryRaw(category: Category): ModelProfile | undefined {
        return this.config.profiles.find(p => p.category === category);
    }

    getProfileByCategory(category: Category): Readonly<ModelProfile> | undefined {
        const found = this.config.profiles.find(p => p.category === category);
        return found ? this.sanitizeProfile(found) : undefined;
    }

    getProfile(id: string): Readonly<ModelProfile> | undefined {
        const found = this.config.profiles.find(p => p.id === id);
        return found ? this.sanitizeProfile(found) : undefined;
    }

    /**
     * Descarta um perfil cujo par (model, provider) é objetivamente impossível — nunca escolhe um
     * substituto (campanha "Ollama API error: 404", Fase 3, S264).
     *
     * Só invalida quando os TRÊS fatos são determinísticos e verificáveis sem depender do
     * catálogo (nunca uma suposição sobre QUEM serve o modelo, só sobre quem NÃO serve):
     *   1. `provider` está vazio (herdado) — um provider explícito é a escolha do operador,
     *      preservada sempre, mesmo que pareça estranha.
     *   2. `model` é um arquivo de modelo local (ex.: `.gguf`) — formato que nenhum provider
     *      nativo entende como tag válida (mesmo fato já usado em `dashboard/routes/models.ts`
     *      pra decidir o que listar como "modelo local").
     *   3. O provider herdado (`ProviderFactory.getDefaultProvider()`) é um dos 6 nativos
     *      (`RESERVED_PROVIDER_NAMES`) — nenhum deles serve arquivo de modelo local, sempre.
     *
     * Causa raiz real (não hipotética): `ensureLocalProvider()` grava esse par coerente no
     * momento do carregamento (defaultProvider = provider local); `realignRouterToProvider()`
     * corretamente não corrige quando o catálogo não confirma o modelo (servidor local
     * indisponível) — por Nunca Adivinhar. O par inconsistente sobrevivia até
     * `getProfileByCategory('execution')` (síntese, `AgentLoop.ts`) devolvê-lo intacto para
     * `chatWithFallback`, que atribuía o arquivo `.gguf` ao provider nativo herdado — `Ollama API
     * error: 404`, recorrente em produção (02/08 a 24/08/2026).
     *
     * Devolver `undefined` aqui é suficiente — todo chamador já tem uma cadeia de fallback
     * própria (`?? chatProfile` na síntese; a sequência determinístico→LLM→default em
     * `resolveProfile()`) que nunca precisou ser ensinada: só parou de receber um par quebrado.
     *
     * NUNCA infere o provider correto (ex.: "termina em .gguf, então é 'llamafile'") — isso seria
     * a mesma adivinhação que este método existe para evitar, só que na direção oposta.
     */
    private sanitizeProfile(profile: ModelProfile): Readonly<ModelProfile> | undefined {
        if (profile.provider) return { ...profile };
        if (!isLocalModelFile(profile.model)) return { ...profile };
        const inheritedProvider = this.providerFactory?.getDefaultProvider();
        if (!inheritedProvider || !RESERVED_PROVIDER_NAMES.has(inheritedProvider)) return { ...profile };
        log.warn(`Perfil '${profile.category}' descartado: modelo local '${profile.model}' não pode ser servido pelo provider herdado '${inheritedProvider}' — nenhum provider nativo serve arquivo de modelo local. Sem provider explícito configurado para esta categoria, não há como corrigir sem adivinhar; o chamador cai para seu próprio fallback.`);
        return undefined;
    }

    getProfiles(): Readonly<ModelProfile>[] {
        return this.config.profiles.map(p => ({ ...p }));
    }

    /** Única via de escrita de perfil. Guarda uma cópia — o chamador não mantém alça para dentro. */
    setProfile(profile: ModelProfile): void {
        const copy = { ...profile };
        const idx = this.config.profiles.findIndex(p => p.id === copy.id);
        if (idx >= 0) this.config.profiles[idx] = copy;
        else this.config.profiles.push(copy);
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
    getExecutionProfile(): Readonly<ModelProfile> {
        return this.getProfileByCategory('execution')
            ?? this.getProfileByCategory('chat')
            ?? this.defaultProfileCopy();
    }
}
