/**
 * UnifiedIntentRouter — Autoridade cognitiva única para interpretação de tarefas
 *
 * Pipeline em 3 camadas:
 *   1. DeterministicGate — regex/keywords rápidos, zero latência
 *   2. SemanticRouting — classificação por intenção + contexto cognitivo
 *   3. StrategySelection — modo de execução, provider, budget
 *
 * Substitui (routing logic): SimpleDecisionEngine, routeIntent, ModelRouter.
 * Profile/provider selection permanece em ModelProfileRegistry, guiado por IntentDecision.modelCategory.
 */

import { createLogger } from '../shared/AppLogger';
import type { SkillLearner } from './SkillLearner';
import type { ProviderFactory, LLMMessage } from '../core/ProviderFactory';

const log = createLogger('UnifiedIntentRouter');

// ── IntentDecision — Contrato tipado de decisão ─────────────────────────

export type ExecutionMode = 'direct' | 'tool' | 'planner' | 'hybrid';
export type RiskLevel = 'low' | 'medium' | 'high';
export type CognitiveLoad = 'minimal' | 'normal' | 'deep';
export type IntentCategory = 'greeting' | 'conversation' | 'information' | 'creation' | 'system_operation' | 'data_analysis' | 'memory_operation' | 'audio' | 'vision' | 'destructive' | 'confirmation' | 'rejection';

export interface IntentDecision {
    /** Intent classification */
    intent: string;
    /** Category for routing */
    category: IntentCategory;
    /** Confidence 0-1 */
    confidence: number;
    /** How to execute */
    executionMode: ExecutionMode;
    /** Whether LLM reasoning is needed */
    requiresReasoning: boolean;
    /** Whether tool execution is needed */
    requiresTools: boolean;
    /** Whether memory retrieval is needed */
    requiresMemory: boolean;
    /** Whether multi-step planning is needed */
    requiresPlanning: boolean;
    /** Whether streaming response is preferred */
    requiresStreaming: boolean;
    /** Preferred provider id (resolved via ModelProfileRegistry) */
    preferredProvider?: string;
    /** Preferred model name */
    preferredModel?: string;
    /** Model category for ProviderFactory */
    modelCategory: 'chat' | 'code' | 'vision' | 'light' | 'analysis' | 'execution';
    /** Risk level */
    riskLevel: RiskLevel;
    /** Cognitive load estimate */
    cognitiveLoad: CognitiveLoad;
    /** Whether this is a terminal action (no further processing needed) */
    terminalAction: boolean;
    /** Tool to execute (if executionMode === 'tool') */
    toolName?: string;
    /** Tool parameters (if executionMode === 'tool') */
    toolParams?: Record<string, unknown>;
    /** Whether a compound action is needed (e.g., fetch data then generate audio) */
    compoundAction?: {
        dataTool: string;
        dataParams: Record<string, unknown>;
        outputTool: string;
        outputParams: Record<string, unknown>;
    };
    /** Tools recommended by SkillLearner based on past patterns */
    preferredTools?: string[];
    /** Skill context text to inject into system prompt (from SkillLearner) */
    skillContext?: string;
    /** Deterministic source (which gate matched) */
    source: 'deterministic' | 'semantic' | 'fallback';
    /** Routing trace for observability */
    trace: RoutingTrace;
}

export interface RoutingTrace {
    inputHash: string;
    inputLength: number;
    deterministicMatch?: string;
    semanticCategory?: string;
    strategyDecision?: string;
    totalTimeMs: number;
    steps: Array<{ step: string; durationMs: number; result: string }>;
}

// ── Deterministic Gate Rules ───────────────────────────────────────────

interface DeterministicRule {
    id: string;
    category: IntentCategory;
    executionMode: ExecutionMode;
    keywords: string[];
    patterns: RegExp[];
    confidence: number;
    riskLevel: RiskLevel;
    cognitiveLoad: CognitiveLoad;
    requiresReasoning: boolean;
    requiresTools: boolean;
    requiresMemory: boolean;
    requiresPlanning: boolean;
    requiresStreaming: boolean;
    modelCategory: 'chat' | 'code' | 'vision' | 'light' | 'analysis' | 'execution';
    terminalAction: boolean;
    toolName?: string;
    toolParams?: (input: string) => Record<string, unknown>;
    compoundAction?: (input: string) => { dataTool: string; dataParams: Record<string, unknown>; outputTool: string; outputParams: Record<string, unknown> };
}

const GREETING_PATTERN = /^(oi+|ol[aá]+|opa+|eai+|eae+|fala+|bom dia|boa tarde|boa noite|tudo bem|blz+|beleza+|tranquilo|obrigad[oa]?|valeu+|kk+|haha+|salve|coé?|hey|hi|hello|bye|tchau|flw|falou)[\s!.?]*$/i;
const CONFIRMATION_PATTERN = /^(sim+|yes+|ok+|autorizado+|autorizar+|pode+|prosseguir+|manda bala+|faz isso+|executar+|rodar+|confirmo+|concordo+|positivo+|true|y)[\s!.?]*$/i;
const REJECTION_PATTERN = /^(não+|nao+|no+|cancelar+|cancela+|parar+|para+|stop+|negativo+|abortar+|aborta+|false|n)[\s!.?]*$/i;

const DESTRUCTIVE_KEYWORDS = [
    'rm -rf', 'rm -r', 'del /', 'format', 'formatar',
    'drop database', 'drop table', 'delete all', 'truncate',
    'sudo rm', 'mkfs', 'shutdown', 'reboot'
];

const DETERMINISTIC_RULES: DeterministicRule[] = [
    // ── Greetings (no tools, no reasoning) ──
    {
        id: 'greeting',
        category: 'greeting',
        executionMode: 'direct',
        keywords: [],
        patterns: [GREETING_PATTERN],
        confidence: 0.97,
        riskLevel: 'low',
        cognitiveLoad: 'minimal',
        requiresReasoning: false,
        requiresTools: false,
        requiresMemory: false,
        requiresPlanning: false,
        requiresStreaming: false,
        modelCategory: 'light',
        terminalAction: true,
    },
    {
        id: 'confirmation',
        category: 'confirmation',
        executionMode: 'direct',
        keywords: ['sim', 'autorizar', 'autorizado', 'pode', 'prosseguir', 'manda bala', 'ok'],
        patterns: [CONFIRMATION_PATTERN],
        confidence: 0.98,
        riskLevel: 'low',
        cognitiveLoad: 'minimal',
        requiresReasoning: false,
        requiresTools: false,
        requiresMemory: false,
        requiresPlanning: false,
        requiresStreaming: false,
        modelCategory: 'light',
        terminalAction: true,
    },
    {
        id: 'rejection',
        category: 'rejection',
        executionMode: 'direct',
        keywords: ['não', 'nao', 'cancelar', 'abortar', 'parar'],
        patterns: [REJECTION_PATTERN],
        confidence: 0.98,
        riskLevel: 'low',
        cognitiveLoad: 'minimal',
        requiresReasoning: false,
        requiresTools: false,
        requiresMemory: false,
        requiresPlanning: false,
        requiresStreaming: false,
        modelCategory: 'light',
        terminalAction: true,
    },

    // ── Destructive commands (HIGH RISK) ──
    {
        id: 'destructive',
        category: 'system_operation',
        executionMode: 'tool',
        keywords: DESTRUCTIVE_KEYWORDS,
        patterns: [],
        confidence: 0.99,
        riskLevel: 'high',
        cognitiveLoad: 'normal',
        requiresReasoning: true,
        requiresTools: true,
        requiresMemory: false,
        requiresPlanning: false,
        requiresStreaming: false,
        modelCategory: 'execution',
        terminalAction: false,
        toolName: 'exec_command',
        toolParams: (input: string) => ({ command: input }),
    },

    // ── Audio/TTS requests ──
    {
        id: 'audio_tts',
        category: 'audio',
        executionMode: 'hybrid',
        keywords: ['enviar áudio', 'enviar audio', 'tts', 'voz', 'ouvir', 'narrar', 'converter em áudio', 'converter em audio', 'falar'],
        patterns: [/^(por favor\s*)?(me\s*)?(gerar?\s*(um|uma)?\s*(áudio|audio|voz)|criar?\s*(um|uma)?\s*(áudio|audio|voz)|envi[ae]r?\s*(um|uma)?\s*(áudio|audio|voz)|falar?\s*(em)?\s*voz|narre|narrar)/i],
        confidence: 0.90,
        riskLevel: 'low',
        cognitiveLoad: 'normal',
        requiresReasoning: false,
        requiresTools: true,
        requiresMemory: false,
        requiresPlanning: false,
        requiresStreaming: false,
        modelCategory: 'chat',
        terminalAction: false,
    },

    // ── Memory operations ──
    {
        id: 'memory_write',
        category: 'memory_operation',
        executionMode: 'tool',
        keywords: ['lembrar', 'lembre', 'memorizar', 'memorize', 'guardar', 'guarde', 'salvar na memória', 'salvar na memoria', 'adicionar nó', 'criar nó', 'conectar nó', 'anote', 'registre'],
        patterns: [/(guarde|lembre|lembrete|memorize|anote|registre|adicionar|adiciona|guarda)\b/i],
        confidence: 0.88,
        riskLevel: 'low',
        cognitiveLoad: 'minimal',
        requiresReasoning: false,
        requiresTools: true,
        requiresMemory: true,
        requiresPlanning: false,
        requiresStreaming: false,
        modelCategory: 'chat',
        terminalAction: false,
        toolName: 'memory_write',
        toolParams: (input: string) => ({ action: 'create', id: `fact_${Date.now()}`, type: 'fact', name: input.slice(0, 50), content: input }),
    },
    {
        id: 'memory_search',
        category: 'memory_operation',
        executionMode: 'hybrid',
        keywords: ['buscar na memória', 'buscar na memoria', 'busca semântica', 'busca semantica', 'busca na memória', 'busca na memoria', 'o que você sabe', 'o que voce sabe', 'você lembra', 'voce lembra', 'pesquise', 'pesquisa sobre'],
        patterns: [/(o que (você|voce) sabe|lembra|buscar na mem[óo]ria|pesquisar|pesquise|busque|procurar|busca (sem[aâ]ntica|na mem|sobre))/i],
        confidence: 0.88,
        riskLevel: 'low',
        cognitiveLoad: 'minimal',
        requiresReasoning: true,
        requiresTools: true,
        requiresMemory: true,
        requiresPlanning: false,
        requiresStreaming: false,
        modelCategory: 'chat',
        terminalAction: false,
        toolName: 'memory_search',
        toolParams: (input: string) => {
            const query = input.replace(/^(o que (você|voce) (sabe|lembra)( sobre)?|buscar na mem[óo]ria|pesquisar|pesquise|procurar|busque|busca\s*(sem[aâ]ntica)?\s*(na\s*mem[óo]ria)?\s*(sobre)?)/i, '').trim() || input;
            return { query };
        },
    },

    // ── Shell/System commands ──
    {
        id: 'shell_command',
        category: 'system_operation',
        executionMode: 'tool',
        keywords: ['executar comando', 'rodar comando', 'run command', 'terminal', 'shell', 'bash', 'ssh', 'instalar', 'install', 'pip install', 'npm install', 'apt', 'sudo'],
        patterns: [/(executar comando|rodar comando|run command|terminal|shell|bash|instalar|pip install|npm install|apt)/i],
        confidence: 0.85,
        riskLevel: 'medium',
        cognitiveLoad: 'normal',
        requiresReasoning: false,
        requiresTools: true,
        requiresMemory: false,
        requiresPlanning: false,
        requiresStreaming: false,
        modelCategory: 'execution',
        terminalAction: false,
        toolName: 'exec_command',
        toolParams: (input: string) => ({ command: input }),
    },

    // ── Weather queries ──
    {
        id: 'weather_query',
        category: 'information',
        executionMode: 'tool',
        keywords: [
            'previsão do tempo', 'previsão de tempo', 'tempo hoje', 'clima hoje',
            'clima amanhã', 'temperatura hoje', 'vai chover', 'está chovendo',
            'como está o tempo', 'como esta o tempo', 'como tá o tempo',
            'clima agora', 'tempo agora',
        ],
        patterns: [
            /(previs[ãa]o\s*(do|de)\s*tempo|como\s+(est[áa]|t[áa])\s+o\s+(tempo|clima)|clima\s+(hoje|amanh[ãa]|agora)|tempo\s+(hoje|amanh[ãa]|agora)|temperatura\s+(atual|de\s+hoje|amanh[ãa])|vai\s+chover|est[áa]\s+chovendo|como\s+est[áa]\s+o\s+clima)/i,
        ],
        confidence: 0.93,
        riskLevel: 'low',
        cognitiveLoad: 'minimal',
        requiresReasoning: false,
        requiresTools: true,
        requiresMemory: false,
        requiresPlanning: false,
        requiresStreaming: false,
        modelCategory: 'light',
        terminalAction: false,
        toolName: 'weather',
        toolParams: (input: string) => {
            const cityMatch = input.match(/(?:em|de|para|n[ao])\s+([A-ZÁÀÃÂÉÊÍÓÕÔÚÇ][a-záàãâéêíóõôúç]+(?:\s+[A-ZÁÀÃÂÉÊÍÓÕÔÚÇ][a-záàãâéêíóõôúç]+)*)/);
            const city = cityMatch?.[1]?.trim();
            return city ? { city } : {};
        },
    },

    // ── Current time/date queries ──
    {
        id: 'current_time',
        category: 'information',
        executionMode: 'direct',
        keywords: [
            'que horas são', 'que horas sao', 'que hora é', 'que hora e',
            'hora atual', 'horas agora', 'que dia é hoje', 'que dia e hoje',
            'data de hoje', 'data atual', 'qual a data', 'qual o dia',
        ],
        patterns: [
            /(que\s+hora[s]?\s+(s[ãa]o|[eé])|hora\s+atual|que\s+dia\s+[eé]\s+hoje|data\s+(de\s+hoje|atual)|qual\s+(a\s+data|o\s+dia))/i,
        ],
        confidence: 0.95,
        riskLevel: 'low',
        cognitiveLoad: 'minimal',
        requiresReasoning: false,
        requiresTools: false,
        requiresMemory: false,
        requiresPlanning: false,
        requiresStreaming: false,
        modelCategory: 'light',
        terminalAction: false,
    },
];

// ── Semantic categories (used when no deterministic match) ──────────

interface SemanticRule {
    category: IntentCategory;
    modelCategory: 'chat' | 'code' | 'vision' | 'light' | 'analysis' | 'execution';
    keywords: string[];
    patterns: RegExp[];
    cognitiveLoad: CognitiveLoad;
    requiresReasoning: boolean;
}

const SEMANTIC_RULES: SemanticRule[] = [
    {
        category: 'creation',
        modelCategory: 'code',
        keywords: ['código', 'programar', 'html', 'css', 'js', 'python', 'script', 'bug', 'debug', 'arquivo', 'file', 'criar', 'gerar', 'fazer', 'build', 'escrever', 'montar', 'desenvolver', 'pdf', 'converter', 'gerar pdf', 'exportar pdf', 'html para pdf', 'slides para pdf', 'aula para pdf'],
        patterns: [/\b(cod|prog|html|css|js|python|script|bug|debug|edit|modify|patch|creat|generat|build|mak|convert|pdf)\w*\b/i],
        cognitiveLoad: 'deep',
        requiresReasoning: true,
    },
    {
        category: 'vision',
        modelCategory: 'vision',
        keywords: ['imagem', 'foto', 'screenshot', 'print', 'ocr', 'visão computacional'],
        patterns: [/\b(imag|foto|screenshot|ocr|vis[uã]o)\w*\b/i],
        cognitiveLoad: 'normal',
        requiresReasoning: true,
    },
    {
        category: 'data_analysis',
        modelCategory: 'analysis',
        keywords: ['analisar', 'análise', 'calcular', 'estatística', 'dado', 'dados', 'relatório', 'gráfico'],
        patterns: [/\b(analis|analy[sz]|estat[ií]st|c[aá]lcul|dado|relat[oó]ri|gr[aá]fic)\w*\b/i],
        cognitiveLoad: 'deep',
        requiresReasoning: true,
    },
    {
        category: 'system_operation',
        modelCategory: 'execution',
        keywords: ['servidor', 'docker', 'deploy', 'nginx', 'ssh', 'banco de dados', 'database'],
        patterns: [/\b(servidor|docker|deploy|nginx|ssh|database|postgres|mysql)\w*\b/i],
        cognitiveLoad: 'deep',
        requiresReasoning: true,
    },
    {
        category: 'conversation',
        modelCategory: 'chat',
        keywords: [],
        patterns: [/\?\s*$/],  // Ends with question mark
        cognitiveLoad: 'normal',
        requiresReasoning: true,
    },
    {
        category: 'confirmation',
        modelCategory: 'light',
        keywords: ['sim', 'ok', 'pode', 'autorizo', 'confirmo'],
        patterns: [],
        cognitiveLoad: 'minimal',
        requiresReasoning: false,
    },
];

// ── UnifiedIntentRouter ──────────────────────────────────────────────

export class UnifiedIntentRouter {
    private classificationCache: Map<string, { decision: IntentDecision; timestamp: number }> = new Map();
    private readonly CACHE_TTL = 300_000; // 5 minutes
    private skillLearner: SkillLearner | null;
    private providerFactory: ProviderFactory | null;

    constructor(skillLearner?: SkillLearner, providerFactory?: ProviderFactory) {
        this.skillLearner = skillLearner ?? null;
        this.providerFactory = providerFactory ?? null;
    }

    /**
     * Route a user input through the 3-layer pipeline.
     * Layer 1: deterministic gate (regex, zero latency) for unambiguous cases.
     * Layer 2: LLM classification for everything else (falls back to keyword scoring if no provider).
     * Layer 3: strategy selection (sync).
     */
    async route(input: string, context?: { lastTask?: string; sessionId?: string }): Promise<IntentDecision> {
        const startTime = Date.now();
        const trace: RoutingTrace = {
            inputHash: this.hashInput(input),
            inputLength: input.length,
            totalTimeMs: 0,
            steps: [],
        };

        // ── Layer 1: Deterministic Gate ──
        const detStart = Date.now();
        const deterministicMatch = this.deterministicGate(input);
        trace.steps.push({ step: 'deterministic_gate', durationMs: Date.now() - detStart, result: deterministicMatch ? deterministicMatch.id : 'no_match' });

        if (deterministicMatch) {
            const decision = this.buildDecisionFromRule(deterministicMatch, input, 'deterministic', trace, startTime);
            trace.deterministicMatch = deterministicMatch.id;
            log.info(`[UNIFIED-ROUTER] Deterministic: ${deterministicMatch.id} → ${deterministicMatch.category} (confidence: ${decision.confidence})`);
            return this.cacheAndTrace(input, this.enrichWithSkillContext(input, decision));
        }

        // ── Layer 2: LLM Classification (with keyword fallback) ──
        const semStart = Date.now();
        const semanticResult = this.providerFactory
            ? await this.llmClassify(input)
            : this.semanticRoute(input);
        trace.steps.push({ step: 'semantic_routing', durationMs: Date.now() - semStart, result: semanticResult.category });

        // ── Layer 3: Strategy Selection ──
        const stratStart = Date.now();
        const decision = this.strategySelection(input, semanticResult, context);
        trace.steps.push({ step: 'strategy_selection', durationMs: Date.now() - stratStart, result: decision.executionMode });

        trace.semanticCategory = semanticResult.category;
        trace.strategyDecision = decision.executionMode;

        const source = this.providerFactory ? 'semantic' : 'fallback';
        log.info(`[UNIFIED-ROUTER] ${source === 'semantic' ? 'LLM' : 'Keyword'}: ${semanticResult.category} → ${decision.executionMode} (confidence: ${decision.confidence}, model: ${decision.modelCategory})`);
        const enriched = this.enrichWithSkillContext(input, { ...decision, source, trace: { ...decision.trace, ...trace, totalTimeMs: Date.now() - startTime } });
        return this.cacheAndTrace(input, enriched);
    }

    /**
     * Synchronous route — uses cache + deterministic gate + keyword fallback only.
     * Does NOT call LLM. Use for contexts where async is unavailable.
     */
    routeSync(input: string, context?: { lastTask?: string; sessionId?: string }): IntentDecision {
        const cached = this.classificationCache.get(input.trim().toLowerCase());
        if (cached && (Date.now() - cached.timestamp) < this.CACHE_TTL) {
            return cached.decision;
        }

        const startTime = Date.now();
        const trace: RoutingTrace = { inputHash: this.hashInput(input), inputLength: input.length, totalTimeMs: 0, steps: [] };

        const deterministicMatch = this.deterministicGate(input);
        if (deterministicMatch) {
            const decision = this.buildDecisionFromRule(deterministicMatch, input, 'deterministic', trace, startTime);
            return this.cacheAndTrace(input, this.enrichWithSkillContext(input, decision));
        }

        const semanticResult = this.semanticRoute(input);
        const decision = this.strategySelection(input, semanticResult, context);
        const enriched = this.enrichWithSkillContext(input, { ...decision, source: 'fallback' as const, trace: { ...trace, totalTimeMs: Date.now() - startTime } });
        return this.cacheAndTrace(input, enriched);
    }

    // ── Layer 1: Deterministic Gate ─────────────────────────────────────

    private deterministicGate(input: string): DeterministicRule | null {
        const normalized = input.toLowerCase().trim();

        // Short input check (likely greeting or unclear)
        if (normalized.length <= 3 && !DESTRUCTIVE_KEYWORDS.some(kw => normalized.includes(kw))) {
            // Will be caught by greeting pattern
        }

        for (const rule of DETERMINISTIC_RULES) {
            // Check patterns first (more precise)
            for (const pattern of rule.patterns) {
                if (pattern.test(normalized)) {
                    return rule;
                }
            }
            // Check keywords
            for (const keyword of rule.keywords) {
                const kw = keyword.toLowerCase();
                const found = normalized.includes(kw);
                if (!found) continue;

                // For high-specificity rules (crypto, shell), keyword match is sufficient
                // For low-specificity rules (confirmation, rejection, greeting),
                // require pattern match OR exact match to avoid false positives on common words like "sim"
                if (rule.category === 'confirmation' || rule.category === 'rejection' || rule.category === 'greeting') {
                    // Only match if it's the exact word or matches the pattern
                    if (normalized === kw || rule.patterns.some(p => p.test(normalized))) {
                        return rule;
                    }
                    continue;
                }

                // High-risk rules (destructive) require word-boundary match to avoid false positives.
                // e.g. 'format' must not match inside 'informatica' or 'informativo'.
                if (rule.riskLevel === 'high') {
                    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const wordBound = new RegExp(`(?:^|\\s|[^a-záàãâéêíóõôúç])${escaped}(?:$|\\s|[^a-záàãâéêíóõôúç])`, 'i');
                    if (!wordBound.test(normalized)) continue;
                }

                // Short keywords (≤4 chars) like 'ada', 'sol', 'eth', 'btc' require word-boundary
                // to avoid matching substrings in common words (e.g. 'ada' in 'cada').
                if (kw.length <= 4) {
                    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const wordBound = new RegExp(`(?:^|[^a-záàãâéêíóõôúç])${escaped}(?:$|[^a-záàãâéêíóõôúç])`, 'i');
                    if (!wordBound.test(normalized)) continue;
                }

                if (rule.confidence >= 0.85 || rule.keywords.length < 10) {
                    return rule;
                }
            }
        }

        return null;
    }

    // ── Layer 2a: LLM Classification ─────────────────────────────────────

    private async llmClassify(input: string): Promise<{ category: IntentCategory; modelCategory: 'chat' | 'code' | 'vision' | 'light' | 'analysis' | 'execution'; cognitiveLoad: CognitiveLoad; requiresReasoning: boolean; confidence: number }> {
        const messages: LLMMessage[] = [
            {
                role: 'system',
                content: `You are an intent classifier. Classify the user message into exactly one category.

Categories:
- greeting: greetings, farewells, thanks, casual social phrases
- confirmation: explicit yes/proceed/confirm/authorize
- rejection: explicit no/cancel/stop/abort
- creation: creating or generating any content — files, slides, HTML, documents, code, presentations, PDFs
- information: factual questions, web searches, explanations, definitions
- data_analysis: analyzing data, statistics, crypto/market prices, financial data, reports
- memory_operation: saving to or retrieving from memory/notes
- system_operation: shell commands, servers, deployment, infrastructure, SSH
- audio: generating audio, TTS, voice narration
- vision: analyzing images, screenshots, OCR
- destructive: deleting files/databases, formatting disks, dangerous system commands
- conversation: general chat, opinions, follow-ups, ambiguous requests

Respond with ONLY valid JSON, no other text:
{"category": "<category>", "cognitiveLoad": "minimal|normal|deep", "confidence": 0.0}`,
            },
            { role: 'user', content: input },
        ];

        try {
            const result = await this.providerFactory!.chatWithFallback(messages, undefined, undefined, 15000);
            if (result.status !== 'success' || !result.content) throw new Error('LLM classification failed');

            const raw = result.content.trim().replace(/^```json\s*|\s*```$/g, '');
            const parsed = JSON.parse(raw) as { category?: string; cognitiveLoad?: string; confidence?: number };

            const VALID_CATEGORIES: IntentCategory[] = ['greeting', 'conversation', 'information', 'creation', 'system_operation', 'data_analysis', 'memory_operation', 'audio', 'vision', 'destructive', 'confirmation', 'rejection'];
            const category = VALID_CATEGORIES.includes(parsed.category as IntentCategory) ? (parsed.category as IntentCategory) : 'conversation';
            const cognitiveLoad = (['minimal', 'normal', 'deep'].includes(parsed.cognitiveLoad ?? '') ? parsed.cognitiveLoad : 'normal') as CognitiveLoad;
            const confidence = typeof parsed.confidence === 'number' ? Math.min(Math.max(parsed.confidence, 0.5), 0.95) : 0.7;

            const MODEL_CATEGORY_MAP: Record<IntentCategory, 'chat' | 'code' | 'vision' | 'light' | 'analysis' | 'execution'> = {
                greeting: 'light', confirmation: 'light', rejection: 'light', conversation: 'chat',
                information: 'chat', creation: 'code', data_analysis: 'analysis',
                memory_operation: 'chat', system_operation: 'execution',
                audio: 'chat', vision: 'vision', destructive: 'execution',
            };

            log.info(`[UNIFIED-ROUTER] LLM classified: "${input.slice(0, 60)}" → ${category} (confidence: ${confidence})`);
            return { category, modelCategory: MODEL_CATEGORY_MAP[category], cognitiveLoad, requiresReasoning: cognitiveLoad !== 'minimal', confidence };
        } catch (err) {
            log.warn(`[UNIFIED-ROUTER] LLM classification failed, falling back to keyword routing: ${err}`);
            return this.semanticRoute(input);
        }
    }

    // ── Layer 2b: Keyword Semantic Routing (fallback) ─────────────────────

    private semanticRoute(input: string): { category: IntentCategory; modelCategory: 'chat' | 'code' | 'vision' | 'light' | 'analysis' | 'execution'; cognitiveLoad: CognitiveLoad; requiresReasoning: boolean; confidence: number } {
        const lower = input.toLowerCase().trim();

        // Score each semantic rule
        let bestCategory: IntentCategory = 'conversation';
        let bestModelCategory: 'chat' | 'code' | 'vision' | 'light' | 'analysis' | 'execution' = 'chat';
        let bestScore = 0;
        let bestCognitiveLoad: CognitiveLoad = 'normal';
        let bestRequiresReasoning = true;

        for (const rule of SEMANTIC_RULES) {
            let score = 0;
            for (const kw of rule.keywords) {
                if (lower.includes(kw.toLowerCase())) score += 2;
            }
            for (const pattern of rule.patterns) {
                if (pattern.test(lower)) score += 3;
            }
            if (score > bestScore) {
                bestScore = score;
                bestCategory = rule.category;
                bestModelCategory = rule.modelCategory;
                bestCognitiveLoad = rule.cognitiveLoad;
                bestRequiresReasoning = rule.requiresReasoning;
            }
        }

        // If no semantic match, default to conversation with LLM
        const confidence = bestScore > 0 ? Math.min(0.5 + (bestScore * 0.05), 0.85) : 0.5;

        return {
            category: bestCategory,
            modelCategory: bestModelCategory,
            cognitiveLoad: bestCognitiveLoad,
            requiresReasoning: bestRequiresReasoning,
            confidence,
        };
    }

    // ── Layer 3: Strategy Selection ─────────────────────────────────────

    private strategySelection(
        _input: string,
        semantic: { category: IntentCategory; modelCategory: 'chat' | 'code' | 'vision' | 'light' | 'analysis' | 'execution'; cognitiveLoad: CognitiveLoad; requiresReasoning: boolean; confidence: number },
        _context?: { lastTask?: string; sessionId?: string }
    ): IntentDecision {
        const { category, modelCategory, cognitiveLoad, requiresReasoning, confidence } = semantic;

        // Determine execution mode based on category and cognitive load
        let executionMode: ExecutionMode;
        let requiresTools: boolean;
        let requiresMemory: boolean;
        let requiresPlanning: boolean;
        let requiresStreaming: boolean;
        let riskLevel: RiskLevel;
        let terminalAction: boolean;

        switch (category) {
            case 'greeting':
            case 'confirmation':
            case 'rejection':
                executionMode = 'direct';
                requiresTools = false;
                requiresMemory = false;
                requiresPlanning = false;
                requiresStreaming = false;
                riskLevel = 'low';
                terminalAction = true;
                break;

            case 'conversation':
                executionMode = 'direct';
                requiresTools = false;
                requiresMemory = true; // Context is always useful
                requiresPlanning = false;
                requiresStreaming = false;
                riskLevel = 'low';
                terminalAction = false;
                break;

            case 'information':
                executionMode = requiresReasoning ? 'hybrid' : 'tool';
                requiresTools = true;
                requiresMemory = true;
                requiresPlanning = false;
                requiresStreaming = false;
                riskLevel = 'low';
                terminalAction = false;
                break;

            case 'creation':
                executionMode = 'hybrid'; // LLM generates, tool saves
                requiresTools = true;
                requiresMemory = false;
                requiresPlanning = true;
                requiresStreaming = true; // Long generation
                riskLevel = 'medium';
                terminalAction = false;
                break;

            case 'system_operation':
                executionMode = 'tool';
                requiresTools = true;
                requiresMemory = false;
                requiresPlanning = false;
                requiresStreaming = false;
                riskLevel = 'medium';
                terminalAction = false;
                break;

            case 'data_analysis':
                executionMode = 'hybrid'; // Fetch data + LLM analysis
                requiresTools = true;
                requiresMemory = true;
                requiresPlanning = false;
                requiresStreaming = true;
                riskLevel = 'low';
                terminalAction = false;
                break;

            case 'memory_operation':
                executionMode = 'tool';
                requiresTools = true;
                requiresMemory = true;
                requiresPlanning = false;
                requiresStreaming = false;
                riskLevel = 'low';
                terminalAction = false;
                break;

            case 'audio':
                executionMode = 'hybrid'; // May need data + TTS
                requiresTools = true;
                requiresMemory = false;
                requiresPlanning = false;
                requiresStreaming = false;
                riskLevel = 'low';
                terminalAction = false;
                break;

            case 'vision':
                executionMode = 'hybrid';
                requiresTools = true;
                requiresMemory = false;
                requiresPlanning = false;
                requiresStreaming = true;
                riskLevel = 'low';
                terminalAction = false;
                break;

            case 'destructive':
                executionMode = 'tool';
                requiresTools = true;
                requiresMemory = false;
                requiresPlanning = true; // Needs confirmation
                requiresStreaming = false;
                riskLevel = 'high';
                terminalAction = false;
                break;

            default:
                executionMode = 'direct';
                requiresTools = false;
                requiresMemory = true;
                requiresPlanning = false;
                requiresStreaming = false;
                riskLevel = 'low';
                terminalAction = false;
        }

        // Override: deep cognitive load requires planning
        if (cognitiveLoad === 'deep') {
            requiresPlanning = true;
        }

        return {
            intent: category,
            category,
            confidence: Math.min(confidence, 0.95), // Cap at 0.95 for semantic
            executionMode,
            requiresReasoning,
            requiresTools,
            requiresMemory,
            requiresPlanning,
            requiresStreaming,
            modelCategory,
            riskLevel,
            cognitiveLoad,
            terminalAction,
            source: 'semantic',
            trace: {} as RoutingTrace, // Will be filled by route()
        };
    }

    // ── Helper: Build decision from deterministic rule ────────────────────

    private buildDecisionFromRule(
        rule: DeterministicRule,
        input: string,
        source: 'deterministic' | 'semantic' | 'fallback',
        trace: RoutingTrace,
        startTime: number
    ): IntentDecision {
        // Handle compound actions (e.g., crypto + audio)
        let compoundAction: IntentDecision['compoundAction'] = undefined;
        if (rule.compoundAction) {
            compoundAction = rule.compoundAction(input);
        }

        // Handle audio that needs data first
        if (rule.id === 'audio_tts') {
            const topic = input
                .replace(/^(por favor\s*)?(me\s*)?(gere|gerar|gera|cria|criar|envia|enviar|envie|manda|mandar|mande|fale|falar|narre|narrar)\s*(um|uma)?\s*(áudio|audio|voz|som)?\s*(sobre|com|do|da|de|para)?\s*/i, '')
                .trim();
            const needsData = /(valor|pre[cç]o|cota[cç][aã]o|quanto|bitcoin|btc|ethereum|eth|solana|sol|cardano|ada|xrp|dogecoin|doge|river|cripto|crypto|clima|tempo|temperatura)/i.test(topic);
            if (needsData) {
                compoundAction = {
                    dataTool: 'web_search',
                    dataParams: { query: topic },
                    outputTool: 'send_audio',
                    outputParams: { text: topic },
                };
            }
        }

        return {
            intent: rule.category,
            category: rule.category,
            confidence: rule.confidence,
            executionMode: rule.executionMode,
            requiresReasoning: rule.requiresReasoning,
            requiresTools: rule.requiresTools,
            requiresMemory: rule.requiresMemory,
            requiresPlanning: rule.requiresPlanning,
            requiresStreaming: rule.requiresStreaming,
            modelCategory: rule.modelCategory,
            riskLevel: rule.riskLevel,
            cognitiveLoad: rule.cognitiveLoad,
            terminalAction: rule.terminalAction,
            toolName: rule.toolName,
            toolParams: rule.toolParams ? rule.toolParams(input) : undefined,
            compoundAction,
            source,
            trace: { ...trace, totalTimeMs: Date.now() - startTime },
        };
    }

    // ── SkillLearner Enrichment ──────────────────────────────────────────

    private enrichWithSkillContext(input: string, decision: IntentDecision): IntentDecision {
        if (!this.skillLearner) return decision;
        try {
            const skillResult = this.skillLearner.buildSkillContext(input, 2);
            if (!skillResult || skillResult.confidence < 0.7) return decision;
            return {
                ...decision,
                preferredTools: skillResult.preferredTools.length > 0 ? skillResult.preferredTools : decision.preferredTools,
                skillContext: skillResult.text || decision.skillContext,
            };
        } catch {
            return decision;
        }
    }

    // ── Cache and Trace ──────────────────────────────────────────────────

    private cacheAndTrace(input: string, decision: IntentDecision): IntentDecision {
        const key = input.trim().toLowerCase();
        this.classificationCache.set(key, { decision, timestamp: Date.now() });
        this.purgeCache();
        return decision;
    }

    private purgeCache(): void {
        const now = Date.now();
        if (this.classificationCache.size > 500) {
            for (const [key, entry] of this.classificationCache) {
                if (now - entry.timestamp > this.CACHE_TTL) {
                    this.classificationCache.delete(key);
                }
            }
        }
    }

    private hashInput(input: string): string {
        // Simple hash for tracing (not cryptographic)
        let hash = 0;
        for (let i = 0; i < input.length; i++) {
            const char = input.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return Math.abs(hash).toString(36);
    }

    // ── Public API ──────────────────────────────────────────────────────

    /**
     * Get model category for a given input (used by ModelProfileRegistry for profile resolution).
     * Uses sync routing (cache + deterministic + keyword fallback) — no LLM call.
     */
    getModelCategory(input: string): 'chat' | 'code' | 'vision' | 'light' | 'analysis' | 'execution' {
        return this.routeSync(input).modelCategory;
    }

    /**
     * Get the full IntentDecision for observability.
     * Uses sync routing — no LLM call.
     */
    getDecision(input: string): IntentDecision {
        return this.routeSync(input);
    }

    /**
     * Check if input is a greeting (fast path).
     */
    isGreeting(input: string): boolean {
        return GREETING_PATTERN.test(input.trim()) || input.trim().length <= 3;
    }

    /**
     * Check if input is destructive (high risk).
     */
    isDestructive(input: string): boolean {
        const lower = input.toLowerCase();
        return DESTRUCTIVE_KEYWORDS.some(kw => lower.includes(kw));
    }

    /**
     * Get cache stats for observability.
     */
    getCacheStats(): { size: number; hitRate: number } {
        return {
            size: this.classificationCache.size,
            hitRate: 0, // TODO: track hits vs misses
        };
    }

    /**
     * Clear classification cache.
     */
    clearCache(): void {
        this.classificationCache.clear();
    }
}