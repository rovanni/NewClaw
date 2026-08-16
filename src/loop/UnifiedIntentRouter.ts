/**
 * UnifiedIntentRouter — Autoridade cognitiva única para interpretação de tarefas
 *
 * Pipeline em 2 camadas (campanha "requiresReasoning → Authority", sprint "Autoridade da
 * Classificação"):
 *   1. SemanticRouting — LLM classifica intenção/categoria e, quando aplicável, já declara
 *      toolName/toolParams e cognitiveLoad (requiresReasoning) — única autoridade semântica.
 *      Fallback por keyword scoring (semanticRoute) só quando o LLM está indisponível.
 *   2. StrategySelection — mapeia a categoria já decidida para executionMode/riskLevel/etc.
 *      (mapeamento objetivo de categoria→consequência, nunca decide a categoria em si).
 *
 * DECISÃO ARQUITETURAL (não reversível sem nova decisão explícita): texto livre do usuário nunca
 * mais é interpretado por regex/keyword para produzir uma categoria de intenção. O antigo
 * "DeterministicGate" (regex/keywords contra a mensagem bruta, 10 regras fixas) foi removido —
 * violava a Regra "Determinismo valida / LLM interpreta" mesmo quando o vocabulário reconhecido
 * era fechado (ex.: "oi", "hora atual") — reconhecer que um texto SIGNIFICA uma saudação ainda é
 * classificar intenção, não validar um fato estrutural. Precedente do próprio projeto para esta
 * remoção: commit 539fb8c (23/05/2026) já retirou regras "ambíguas" do gate por este motivo;
 * esta mudança generaliza o mesmo raciocínio às regras restantes.
 *
 * Fast Path continua existindo — agora autorizado pela decisão semântica do LLM (toolName +
 * requiresReasoning=false) mais validação estrutural (`ToolRegistry`, `FAST_PATH_ALLOWED`,
 * parâmetros resolvíveis), nunca por regex reconhecendo a mensagem. `classificationCache` (já
 * existente, agora efetivamente lido por route()) preserva o custo de latência para textos
 * repetidos, sem precisar de uma segunda chamada de LLM idêntica.
 *
 * Substitui (routing logic): SimpleDecisionEngine, routeIntent, ModelRouter.
 * Profile/provider selection permanece em ModelProfileRegistry, guiado por IntentDecision.modelCategory.
 */

import { createLogger } from '../shared/AppLogger';
import { boundedHash } from '../shared/boundedHash';
import type { SkillLearner } from './SkillLearner';
import type { ProviderFactory, LLMMessage } from '../core/ProviderFactory';
import type { IntentCategory } from '../shared/domainTypes';

const log = createLogger('UnifiedIntentRouter');

// ── IntentDecision — Contrato tipado de decisão ─────────────────────────

export type ExecutionMode = 'direct' | 'tool' | 'planner' | 'hybrid';
export type RiskLevel = 'low' | 'medium' | 'high';
export type CognitiveLoad = 'minimal' | 'normal' | 'deep';
// IntentCategory vive em shared/domainTypes.ts (ARCH-004) — memory/ReflectionMemory.ts
// consome esse tipo e não deve depender de loop/.
export type { IntentCategory };

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
    /**
     * Whether tool execution is needed.
     *
     * ATENÇÃO — isto NÃO responde "isto é um goal?". O AgentLoop também executa tools; um
     * `requiresTools: true` só diz que alguma ferramenta pode ser necessária, não que o
     * objetivo precise de planejamento. Quem responde a outra pergunta é `requiresPlanning`.
     * Confundir os dois foi um bug real — ver o comentário de contrato em `requiresPlanning`.
     */
    requiresTools: boolean;
    /** Whether memory retrieval is needed */
    requiresMemory: boolean;
    /**
     * Whether multi-step planning is needed — isto é, se a mensagem se beneficia do ciclo
     * plan → execute → validate → replan do `GoalOrchestrator`/`GoalExecutionLoop`.
     *
     * CONTRATO: `true` quando há etapas que dependem umas das outras, um desfecho verificável
     * de forma objetiva (arquivo criado, comando concluído, artefato entregue) e falha que
     * possa ser recuperada tentando outra estratégia. `false` quando o entregável é uma única
     * resposta e replanejar apenas regeneraria o mesmo texto.
     *
     * É o ÚNICO campo que o `GoalOrchestrator` deve consultar para decidir a rota. Até
     * 02/08/2026 ele lia `requiresTools` — que é verdadeiro para qualquer pergunta capaz de
     * usar `memory_search` — e por isso "Explique melhor scaffolding (andaime pedagógico)?"
     * virava um goal com ciclo de replan completo. Neste mesmo dia esse caminho produziu um
     * goal de 38min31s que terminou em falha (goal_1785682989222_q7r69). Enquanto isso, este
     * campo — cujo nome já descrevia exatamente a pergunta certa — era `false` em TODAS as 10
     * regras determinísticas e em 7 das 12 categorias: estava morto, nunca consultado.
     */
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

// ── Deterministic Gate (REMOVIDO) ───────────────────────────────────────
//
// Até esta sprint, existia aqui um array `DETERMINISTIC_RULES` (10 regras: greeting,
// confirmation, rejection, destructive, audio_tts, memory_write, memory_search, shell_command,
// weather_query, current_time) casado contra o texto bruto do usuário via regex/keyword em
// `deterministicGate()`, ANTES de qualquer LLM rodar. Removido por violar "Determinismo valida /
// LLM interpreta": reconhecer que um texto SIGNIFICA uma saudação, um pedido de clima ou uma
// confirmação é classificação de intenção — mesmo quando o vocabulário reconhecido é fechado
// (ex.: "oi", "hora atual") — não é validação de um fato estrutural. Ver header do arquivo.
//
// A verificação de comando destrutivo real (`isDestructiveCommand`, `shared/destructiveCommandPatterns.ts`)
// nunca dependeu desta camada — roda no momento da execução (`exec_command.ts`/`ssh_exec.ts`),
// sobre o comando resolvido, incondicionalmente. Removê-la daqui não reduz a segurança real.

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

// ── Classificação contextual ────────────────────────────────────────────
//
// MICROAUDITORIA (continuidade conversacional, 08/07/2026): llmClassify() classificava a
// mensagem atual ISOLADA — sem nenhum turno anterior da conversa. Para "sim"/"ok"/"pode" isso
// nunca foi um problema (a palavra já carrega o sentido de confirmação fora de contexto), mas
// pra "continue"/"agora"/"isso"/"faça" — nenhuma delas cobertas pelo gate determinístico exato
// (ver DETERMINISTIC_RULES acima: 'confirmation' exige normalized===kw ou o CONFIRMATION_PATTERN
// ancorado) — o LLM classificava esse texto sozinho, sem saber que existia uma pergunta/proposta
// pendente do assistente. Fix: passar uma janela pequena e recente de turnos REAIS da mesma
// sessão (já filtrados por role user/assistant — eventos operacionais como tool_call/tool_result/
// checkpoint NUNCA entram nessa lista, ver SessionManager.buildContext) + identificar
// explicitamente a última resposta do assistente como antecedente imediato.

export interface RecentTurn {
    role: 'user' | 'assistant' | string;
    content: string;
}

/** Contexto conversacional opcional passado a route()/routeSync(). */
export interface RouterContext {
    sessionId?: string;
    lastTask?: string;
    /**
     * Janela pequena e recente de turnos REAIS da MESMA sessão (role user/assistant apenas —
     * nunca tool_call/tool_result/checkpoint/system), em ordem cronológica, SEM incluir a
     * mensagem atual (o chamador já grava a mensagem atual antes de montar essa janela — ver
     * MessageBus.processMessageCore — e a exclui do slice). Usada só por route() (async, chama
     * LLM); routeSync() aceita o campo por compatibilidade de contrato mas NUNCA o consome
     * (não pode chamar LLM de forma síncrona).
     */
    recentMessages?: RecentTurn[];
}

/**
 * Encontra a última resposta REAL do assistente na janela de turnos recentes.
 * "Real" aqui significa: gravada via SessionManager.recordAssistantMessage, que só é chamado
 * nos pontos onde uma resposta foi de fato entregue (ou seu envio foi tentado sem lançar) ao
 * canal do usuário — ver MessageBus.ts (sucesso e, desde o fix anterior desta auditoria, também
 * o branch de erro/timeout) e AgentController.ts (callback de workflow/autorização). Nenhum
 * ponto do código grava role='assistant' para conteúdo puramente interno (raciocínio, tool
 * output bruto, stack trace) — esses entram como role='tool_call'/'tool_result', já excluídos
 * da janela antes de chegar aqui. Não há, portanto, ambiguidade a resolver nesta função: o
 * último item com role==='assistant' na janela JÁ É a última resposta real.
 */
export function extractLastAssistantMessage(recentMessages: RecentTurn[] | undefined): string | undefined {
    if (!recentMessages || recentMessages.length === 0) return undefined;
    for (let i = recentMessages.length - 1; i >= 0; i--) {
        if (recentMessages[i].role === 'assistant') return recentMessages[i].content;
    }
    return undefined;
}

/**
 * Resolve a janela EFETIVA de turnos recentes usada pra classificação: filtra por role
 * user/assistant e remove um eventual último item duplicado da mensagem atual (defesa contra
 * duplicação — cobre o caso de um chamador futuro esquecer de excluir a mensagem atual da
 * janela; o chamador atual, MessageBus, já exclui via slice(-5,-1), mas esta função não
 * depende disso pra estar correta).
 *
 * ÚNICA fonte da janela efetiva — usada tanto por buildClassificationMessages() (o que é
 * ENVIADO ao LLM) quanto por UnifiedIntentRouter.buildCacheKey() (o que é REPRESENTADO na chave
 * de cache). Antes de existir esta função compartilhada, as duas calculavam a janela de forma
 * independente a partir do mesmo `context.recentMessages` bruto — se um chamador futuro viesse
 * a passar uma janela cujo último item duplicasse a mensagem atual, buildClassificationMessages
 * removeria esse item (defesa acima) mas buildCacheKey (lendo o array bruto) não, hasheando um
 * conjunto de mensagens diferente do que foi realmente enviado ao LLM (achado da microauditoria
 * S71-adversarial, 08/07/2026: "contexto enviado ao LLM diferente do contexto representado no
 * cache" — Eixo C). Compartilhar esta função elimina a divergência por construção.
 */
function resolveClassificationWindow(input: string, context?: RouterContext): RecentTurn[] {
    const recentMessages = (context?.recentMessages ?? []).filter(m =>
        m.role === 'user' || m.role === 'assistant'
    );
    const trimmedInput = input.trim();
    while (recentMessages.length > 0 && recentMessages[recentMessages.length - 1].content.trim() === trimmedInput) {
        recentMessages.pop();
    }
    return recentMessages;
}

/**
 * Monta as mensagens de chat enviadas ao classificador LLM: system prompt (com a instrução de
 * classificação contextual quando há janela disponível) + os turnos recentes reais, na ordem
 * em que aconteceram + a mensagem atual por último.
 */
export function buildClassificationMessages(input: string, context?: RouterContext): LLMMessage[] {
    const baseCategories = `Categories:
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
- conversation: general chat, opinions, follow-ups, ambiguous requests`;

    // Ponte para Fast Path: campos opcionais além de category/cognitiveLoad/confidence. A
    // autoridade sobre "isto pode ser respondido direto, sem mais interpretação" é sempre sua —
    // determinismo só valida depois (tool existe, parâmetro resolvível, allowlist de formato).
    // Só preencha quando o pedido inteiro é satisfeito por essa única capacidade — nunca quando
    // houver comparação, resumo, análise ou qualquer instrução adicional junto.
    const toolBridge = `
Known simple capabilities (only set "toolName" when the ENTIRE request is nothing more than this — never when it also asks for comparison, summary, analysis, or any other instruction):
- "weather": current/today's weather for a city. toolParams: {"city": "<city name>"} if a city is named, or {} if not (a default will be resolved separately).
- "current_time": user is asking only for the current date/time, nothing else. toolParams: {} (no parameters).
If the request needs any interpretation beyond one of these, omit "toolName" entirely.`;

    const jsonSchema = `{"category": "<category>", "cognitiveLoad": "minimal|normal|deep", "confidence": 0.0, "toolName": "<weather|current_time, or omit>", "toolParams": {}}`;

    const recentMessages = resolveClassificationWindow(input, context);
    const lastAssistantMessage = extractLastAssistantMessage(recentMessages);

    if (recentMessages.length === 0) {
        // Sem histórico disponível (primeira mensagem da sessão, ou sessão sem turnos recentes) —
        // comportamento idêntico ao original: classifica a mensagem isolada.
        return [
            { role: 'system', content: `You are an intent classifier. Classify the user message into exactly one category.\n\n${baseCategories}\n${toolBridge}\n\nRespond with ONLY valid JSON, no other text:\n${jsonSchema}` },
            { role: 'user', content: input },
        ];
    }

    const systemContent = `You are an intent classifier. Classifique a intenção da mensagem atual do usuário considerando a conversa recente. A última resposta do assistente é o antecedente mais imediato, mas use o histórico para detectar mudança de assunto, referência, confirmação, rejeição, dúvida, adiamento ou continuação.

${baseCategories}
${toolBridge}

${lastAssistantMessage ? `A última resposta real do assistente nesta conversa foi:\n"""${lastAssistantMessage.slice(0, 500)}"""\n` : ''}
Respond with ONLY valid JSON, no other text:
${jsonSchema}`;

    return [
        { role: 'system', content: systemContent },
        ...recentMessages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
        { role: 'user', content: input },
    ];
}

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
     * Route a user input through o pipeline.
     *
     * Autoridade semântica é sempre o LLM (`llmClassify`, com fallback por keyword scoring
     * só quando o provider está indisponível — `semanticRoute`, degradação, não uma segunda
     * autoridade). Determinismo entra em dois lugares, nenhum deles decidindo intenção:
     *   1. Cache lookup (abaixo) — reaproveita uma decisão que o LLM JÁ tomou para o mesmo texto
     *      normalizado (+ mesma janela de contexto), evitando repetir a chamada, não substituindo-a.
     *   2. `strategySelection()` — mapeia a categoria já decidida para executionMode/riskLevel/etc.
     *      (consequência objetiva de uma categoria, nunca a escolha da categoria em si).
     *
     * Campanha "requiresReasoning → Authority", sprint "Autoridade da Classificação": o antigo
     * Layer 1 (`deterministicGate`, regex/keyword contra texto bruto) foi removido — ver header
     * do arquivo.
     */
    async route(input: string, context?: RouterContext): Promise<IntentDecision> {
        const startTime = Date.now();
        const trace: RoutingTrace = {
            inputHash: this.hashInput(input),
            inputLength: input.length,
            totalTimeMs: 0,
            steps: [],
        };

        // ── Cache: reaproveita uma classificação do LLM já feita para este texto (+ contexto) ──
        const cacheStart = Date.now();
        const cached = this.classificationCache.get(this.buildCacheKey(input, context));
        if (cached && (Date.now() - cached.timestamp) < this.CACHE_TTL) {
            // cached.decision carrega o próprio trace (de quando foi classificada de verdade) —
            // devolvê-lo cru omitiria que ESTA chamada específica foi resolvida por cache. Anexa
            // o passo sem descartar o histórico original.
            const cacheTrace: RoutingTrace = {
                ...cached.decision.trace,
                steps: [...cached.decision.trace.steps, { step: 'cache_hit', durationMs: Date.now() - cacheStart, result: cached.decision.category }],
            };
            return { ...cached.decision, trace: cacheTrace };
        }

        // ── Layer 2: LLM Classification (with keyword fallback) ──
        // context é passado pro LLM (classificação contextual — ver buildClassificationMessages)
        // e também entra na chave de cache abaixo, pra não misturar decisão de uma sessão/
        // contexto com outra (ver cacheAndTrace).
        const semStart = Date.now();
        const semanticResult = this.providerFactory
            ? await this.llmClassify(input, context)
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

        // Obs #7: log detalhado de decisão do roteador para rastrear frequência e custo do mode=tool
        const routing_ms = Date.now() - startTime;
        const modeReason = semanticResult.category === 'information'
            ? `information + requiresReasoning=${semanticResult.requiresReasoning} → ${decision.executionMode}`
            : `${semanticResult.category} → ${decision.executionMode}`;
        log.info(
            `[ROUTER-DECISION] intent=${decision.intent} mode=${decision.executionMode} ` +
            `reason="${modeReason}" confidence=${decision.confidence} routing_ms=${routing_ms}`
        );

        const enriched = this.enrichWithSkillContext(input, { ...decision, source, trace: { ...decision.trace, ...trace, totalTimeMs: Date.now() - startTime } });
        return this.cacheAndTrace(input, enriched, context);
    }

    /**
     * Synchronous route — uses cache + keyword fallback only. Does NOT call LLM (não pode:
     * chatWithFallback é assíncrono) e, por isso, NUNCA é autoridade semântica primária — só
     * serve contextos síncronos como degradação (`semanticRoute`, mesmo fallback de Camada 2b
     * usado por `route()` quando o LLM falha), nunca como um segundo caminho de classificação
     * por regex contra o texto bruto (esse caminho foi removido — ver header do arquivo).
     *
     * Contrato quanto a `context.recentMessages`: aceito na assinatura (mesmo RouterContext de
     * route()) mas NUNCA lido aqui — routeSync nunca chama llmClassify, então não há como usar
     * a janela de conversa pra classificação contextual de forma síncrona. Isso é intencional,
     * não um bug: passar recentMessages aqui é um no-op seguro, não um comportamento divergente
     * silencioso (ver S71 — teste prova explicitamente que routeSync ignora o campo sem lançar
     * e sem produzir uma decisão diferente de quando o campo está ausente).
     *
     * routeSync não tem NENHUM chamador em produção hoje (auditoria de 08/07/2026 — grep em todo
     * o src/ não encontrou `.routeSync(` fora deste arquivo e de um teste). Mantido pelo contrato
     * público da classe, não removido por falta de evidência de que seja seguro fazer isso.
     */
    routeSync(input: string, context?: RouterContext): IntentDecision {
        const cached = this.classificationCache.get(this.buildCacheKey(input, undefined));
        if (cached && (Date.now() - cached.timestamp) < this.CACHE_TTL) {
            return cached.decision;
        }

        const startTime = Date.now();
        const trace: RoutingTrace = { inputHash: this.hashInput(input), inputLength: input.length, totalTimeMs: 0, steps: [] };

        const semanticResult = this.semanticRoute(input);
        const decision = this.strategySelection(input, semanticResult, context);
        const enriched = this.enrichWithSkillContext(input, { ...decision, source: 'fallback' as const, trace: { ...trace, totalTimeMs: Date.now() - startTime } });
        return this.cacheAndTrace(input, enriched);
    }

    // ── Layer 2a: LLM Classification (única autoridade semântica) ─────────

    // TOOL_PARAM_SCHEMA: apenas as tools cujo formato de output já é "pronto para apresentação"
    // (mesma responsabilidade que FAST_PATH_ALLOWED, em AgentLoop.ts, já valida de forma
    // estrutural depois — esta lista aqui é só o que o LLM tem permissão de DECLARAR, a
    // autorização final ainda passa pela allowlist e checagens de AgentLoop).
    private static readonly KNOWN_TOOL_NAMES = new Set(['weather', 'current_time']);

    private async llmClassify(input: string, context?: RouterContext): Promise<{ category: IntentCategory; modelCategory: 'chat' | 'code' | 'vision' | 'light' | 'analysis' | 'execution'; cognitiveLoad: CognitiveLoad; requiresReasoning: boolean; confidence: number; toolName?: string; toolParams?: Record<string, unknown> }> {
        const messages: LLMMessage[] = buildClassificationMessages(input, context);

        try {
            const result = await this.providerFactory!.chatWithFallback(messages, undefined, undefined, 30000);
            if (result.status !== 'success' || !result.content) throw new Error('LLM classification failed');

            // Sanitize: strip markdown fences and extract JSON object from potentially mixed content.
            // Models like kimi-k2.6:cloud sometimes return thinking text around the JSON.
            let raw = result.content.trim().replace(/^```json\s*|\s*```$/g, '');
            const jsonMatch = raw.match(/\{[\s\S]*"category"[\s\S]*\}/);
            if (jsonMatch) raw = jsonMatch[0];
            const parsed = JSON.parse(raw) as { category?: string; cognitiveLoad?: string; confidence?: number; toolName?: string; toolParams?: Record<string, unknown> };

            const VALID_CATEGORIES: IntentCategory[] = ['greeting', 'conversation', 'information', 'creation', 'system_operation', 'data_analysis', 'memory_operation', 'audio', 'vision', 'destructive', 'confirmation', 'rejection'];
            const category = VALID_CATEGORIES.includes(parsed.category as IntentCategory) ? (parsed.category as IntentCategory) : 'conversation';
            const cognitiveLoad = (['minimal', 'normal', 'deep'].includes(parsed.cognitiveLoad ?? '') ? parsed.cognitiveLoad : 'normal') as CognitiveLoad;
            const confidence = typeof parsed.confidence === 'number' ? Math.min(Math.max(parsed.confidence, 0.5), 0.95) : 0.7;
            // toolName só é aceito se pertencer ao conjunto conhecido — validação estrutural de
            // um valor que o LLM declarou, não uma segunda interpretação do texto do usuário.
            const toolName = typeof parsed.toolName === 'string' && UnifiedIntentRouter.KNOWN_TOOL_NAMES.has(parsed.toolName) ? parsed.toolName : undefined;
            const toolParams = toolName && parsed.toolParams && typeof parsed.toolParams === 'object' ? parsed.toolParams : undefined;

            const MODEL_CATEGORY_MAP: Record<IntentCategory, 'chat' | 'code' | 'vision' | 'light' | 'analysis' | 'execution'> = {
                greeting: 'light', confirmation: 'light', rejection: 'light', conversation: 'chat',
                information: 'chat', creation: 'code', data_analysis: 'analysis',
                memory_operation: 'chat', system_operation: 'execution',
                audio: 'chat', vision: 'vision', destructive: 'execution',
            };

            log.info(`[UNIFIED-ROUTER] LLM classified: "${input.slice(0, 60)}" → ${category}${toolName ? ` (tool=${toolName})` : ''} (confidence: ${confidence})`);
            return { category, modelCategory: MODEL_CATEGORY_MAP[category], cognitiveLoad, requiresReasoning: cognitiveLoad !== 'minimal', confidence, toolName, toolParams };
        } catch (err) {
            log.warn(`[UNIFIED-ROUTER] LLM classification failed, falling back to keyword routing: ${err}`);
            return this.semanticRoute(input);
        }
    }

    // ── Layer 2b: Keyword Semantic Routing (fallback só para indisponibilidade do provider —
    // nunca é uma segunda autoridade concorrente, nunca declara toolName) ─────────────────

    private semanticRoute(input: string): { category: IntentCategory; modelCategory: 'chat' | 'code' | 'vision' | 'light' | 'analysis' | 'execution'; cognitiveLoad: CognitiveLoad; requiresReasoning: boolean; confidence: number; toolName?: string; toolParams?: Record<string, unknown> } {
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
        semantic: { category: IntentCategory; modelCategory: 'chat' | 'code' | 'vision' | 'light' | 'analysis' | 'execution'; cognitiveLoad: CognitiveLoad; requiresReasoning: boolean; confidence: number; toolName?: string; toolParams?: Record<string, unknown> },
        _context?: RouterContext
    ): IntentDecision {
        const { category, modelCategory, cognitiveLoad, requiresReasoning, confidence, toolName, toolParams } = semantic;

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
                // Uma pergunta se resolve numa resposta: um passo, sem dependência entre etapas e
                // sem desfecho verificável além de "o modelo respondeu". Replanejar não produz
                // nada de novo. O AgentLoop tem acesso total às tools — `requiresTools` continua
                // true e é ele quem chama memory_search/web_search se precisar.
                requiresPlanning = false;
                requiresStreaming = false;
                riskLevel = 'low';
                terminalAction = false;
                break;

            case 'creation':
                executionMode = 'hybrid'; // LLM generates, tool saves
                requiresTools = true;
                requiresMemory = false;
                requiresPlanning = true; // gerar → salvar → entregar, com artefato verificável
                requiresStreaming = true; // Long generation
                riskLevel = 'medium';
                terminalAction = false;
                break;

            case 'system_operation':
                executionMode = 'tool';
                requiresTools = true;
                requiresMemory = false;
                requiresPlanning = true; // comandos encadeados, recuperação de falha, autorização
                requiresStreaming = false;
                riskLevel = 'medium';
                terminalAction = false;
                break;

            case 'data_analysis':
                executionMode = 'hybrid'; // Fetch data + LLM analysis
                requiresTools = true;
                requiresMemory = true;
                requiresPlanning = true; // buscar dado → analisar → entregar
                requiresStreaming = true;
                riskLevel = 'low';
                terminalAction = false;
                break;

            case 'memory_operation':
                executionMode = 'tool';
                requiresTools = true;
                requiresMemory = true;
                // Uma escrita ou busca na memória é uma chamada de tool só. O AgentLoop tem
                // memory_write/memory_search/memory_admin no conjunto dele.
                requiresPlanning = false;
                requiresStreaming = false;
                riskLevel = 'low';
                terminalAction = false;
                break;

            case 'audio':
                executionMode = 'hybrid'; // May need data + TTS
                requiresTools = true;
                requiresMemory = false;
                requiresPlanning = true; // obter conteúdo → sintetizar → enviar arquivo
                requiresStreaming = false;
                riskLevel = 'low';
                terminalAction = false;
                break;

            case 'vision':
                executionMode = 'hybrid';
                requiresTools = true;
                requiresMemory = false;
                requiresPlanning = true; // analisar imagem → agir sobre o que foi visto
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

        // Override: "current_time" não é uma tool real (não existe em ToolRegistry) — é o
        // marcador que o LLM usa para dizer "só a hora/data atual, nada mais" (ver toolBridge em
        // buildClassificationMessages). O earlyReturn correspondente em AgentLoop.ts não chama
        // nenhuma tool nem LLM — precisa de executionMode='direct', como current_time sempre teve.
        if (toolName === 'current_time') {
            executionMode = 'direct';
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
            toolName,
            toolParams,
            source: 'semantic',
            trace: {} as RoutingTrace, // Will be filled by route()
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

    private cacheAndTrace(input: string, decision: IntentDecision, context?: RouterContext): IntentDecision {
        const key = this.buildCacheKey(input, context);
        this.classificationCache.set(key, { decision, timestamp: Date.now() });
        this.purgeCache();
        return decision;
    }

    /**
     * Chave de cache. Sem contexto conversacional (ou recentMessages vazio) — comportamento
     * IDÊNTICO ao original: chave é só o texto normalizado.
     *
     * COM contexto — a chave inclui sessionId + um hash da JANELA INTEIRA efetivamente enviada
     * ao LLM (via resolveClassificationWindow(), a mesma função usada por
     * buildClassificationMessages — não uma segunda leitura independente de context.recentMessages).
     *
     * CORREÇÃO (microauditoria adversarial do S71, 08/07/2026, Eixo A): a versão anterior
     * hasheava só a ÚLTIMA resposta do assistente, não a janela inteira. Contraexemplo mínimo
     * construído a partir do fluxo real: numa mesma sessão, se o assistente produzir a MESMA
     * frase de fechamento em dois momentos diferentes (ex.: "Pronto! Quer que eu envie agora?" —
     * um fechamento genérico de ação, plausível de se repetir literalmente em pedidos distintos:
     * "renomeia o arquivo A" → "Pronto! Quer que eu envie agora?" vs. "cria um resumo do
     * relatório" → "Pronto! Quer que eu envie agora?"), a chave antiga colidia (mesma sessionId +
     * mesmo hash da última resposta + mesmo input "agora") mesmo com `llmClassify()` recebendo
     * DOIS conjuntos de mensagens diferentes (os turnos anteriores — sobre o quê — divergem).
     * Hashear a janela inteira fecha essa lacuna: o hash agora representa o MESMO domínio de
     * dados que realmente influencia a saída de llmClassify().
     *
     * routeSync() nunca gera chaves com sufixo de contexto (não tem contexto real disponível de
     * forma síncrona) — suas leituras de cache continuam batendo só em entradas context-free,
     * nunca em uma decisão contextual de outra sessão.
     */
    private buildCacheKey(input: string, context?: RouterContext): string {
        const normalized = input.trim().toLowerCase();
        const window = resolveClassificationWindow(input, context);
        if (window.length === 0) return normalized;
        const windowFingerprint = window.map(m => `${m.role}:${m.content}`).join('');
        return `${normalized}::ctx:${context?.sessionId ?? 'unknown'}:${this.hashInput(windowFingerprint)}`;
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
        return boundedHash(input);
    }

    // ── Public API ──────────────────────────────────────────────────────

    /**
     * Get model category for a given input (used by ModelProfileRegistry for profile resolution).
     * Uses sync routing (cache + keyword fallback) — no LLM call.
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