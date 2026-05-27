/**
 * ContextBuilder — Pipeline unificado de seleção de contexto para o LLM.
 *
 * Consolida três responsabilidades anteriormente fragmentadas (Fase 2.1):
 *   1. Budget de tokens por bloco    (ex-ContextBudget)
 *   2. Seleção hierárquica de memória(ex-ContextPlanner)
 *   3. Montagem do contexto final    (ContextBuilder)
 *
 * Pipeline: query → calculateBudget → selectMemory → buildContext → prompt
 *
 * Ranking: similarity * 0.6 + connectivity * 0.25 + recency * 0.15
 * Seleção: top-K (5-8 nós) com conteúdo compactado
 */

import { MemoryManager, type MemoryNode } from '../memory/MemoryManager';
import type { MemoryFacade } from '../memory/MemoryFacade';
import { classifyDomain } from '../memory/DomainRegistry';
import type { DomainSummaryService } from '../memory/DomainSummaryService';
import type { EpisodicMemoryService } from '../memory/EpisodicMemoryService';
import type { CognitiveReflectionEngine } from '../memory/CognitiveReflectionEngine';
import { MultiLayerRetriever } from '../memory/MultiLayerRetriever';
import { CognitiveMemoryIndex, MemoryTier, type MemoryIndexEntry } from '../memory/CognitiveMemoryIndex';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('ContextBuilder');

// ── Seção 1: Budget de tokens por bloco (ex-ContextBudget) ──────────────────

export interface ContextBlock {
    role: 'system' | 'user' | 'assistant';
    content: string;
    priority: number; // higher = more important (kept first when truncating)
}

export interface ContextBudgetConfig {
    maxCtx: number;
    reservedForResponse: number;
    systemMaxTokens: number;
    stateMaxTokens: number;
    memoryMaxTokens: number;
    historyMaxTokens: number;
    skillsMaxTokens: number;
    maxHistoryMessages: number;
    maxMessageChars: number;
}

export const DEFAULT_BUDGET: ContextBudgetConfig = {
    maxCtx: parseInt(process.env.OLLAMA_NUM_CTX || '32768', 10),
    reservedForResponse: 4000,
    systemMaxTokens: 1500,
    stateMaxTokens: 500,
    memoryMaxTokens: 1000,
    historyMaxTokens: 2000,
    skillsMaxTokens: 500,
    maxHistoryMessages: 6,
    maxMessageChars: 1500,
};

export function estimateTokens(text: string): number {
    if (!text) return 0;
    const codeRatio = (text.match(/[{}()[\]:;,=<>\/]/g) || []).length / text.length;
    const charsPerToken = 3 + (1 - codeRatio) * 0.5;
    return Math.ceil(text.length / charsPerToken);
}

export function truncateToTokens(text: string, maxTokens: number): string {
    if (!text) return '';
    const estimated = estimateTokens(text);
    if (estimated <= maxTokens) return text;
    const maxChars = Math.floor(maxTokens * 3.5);
    const truncated = text.slice(0, maxChars);
    const lastPeriod = truncated.lastIndexOf('.');
    const lastNewline = truncated.lastIndexOf('\n');
    const cutPoint = Math.max(lastPeriod, lastNewline, maxChars - 100);
    return truncated.slice(0, cutPoint > 0 ? cutPoint : maxChars) + '\n[...truncated]';
}

export function truncateToChars(text: string, maxChars: number): string {
    if (!text || text.length <= maxChars) return text || '';
    const truncated = text.slice(0, maxChars);
    const lastPeriod = truncated.lastIndexOf('.');
    const lastNewline = truncated.lastIndexOf('\n');
    const cutPoint = Math.max(lastPeriod, lastNewline, maxChars - 100);
    return truncated.slice(0, cutPoint > 0 ? cutPoint : maxChars) + '\n[...truncated]';
}

/**
 * ContextBudget — Controla budget de tokens por bloco para evitar overflow de contexto.
 * Distribuição: system (1500), state (500), memory (1000), history (2000), skills (500).
 */
export class ContextBudget {
    private config: ContextBudgetConfig;

    constructor(config?: Partial<ContextBudgetConfig>) {
        this.config = { ...DEFAULT_BUDGET, ...config };
    }

    get maxInputTokens(): number {
        return this.config.maxCtx - this.config.reservedForResponse;
    }

    buildMessages(params: {
        systemPrompt: string;
        stateBlock?: string;
        memoryBlock?: string;
        skillsBlock?: string;
        checkpointBlock?: string;
        recentMessages: Array<{ role: string; content: string }>;
        currentUserMessage: string;
    }): ContextBlock[] {
        const blocks: ContextBlock[] = [];
        let totalTokens = 0;

        const system = truncateToTokens(params.systemPrompt, this.config.systemMaxTokens);
        blocks.push({ role: 'system', content: system, priority: 10 });
        totalTokens += estimateTokens(system);

        if (params.stateBlock) {
            const state = truncateToTokens(params.stateBlock, this.config.stateMaxTokens);
            blocks.push({ role: 'system', content: state, priority: 8 });
            totalTokens += estimateTokens(state);
        }

        if (params.memoryBlock) {
            const memory = truncateToTokens(params.memoryBlock, this.config.memoryMaxTokens);
            blocks.push({ role: 'system', content: memory, priority: 6 });
            totalTokens += estimateTokens(memory);
        }

        if (params.skillsBlock) {
            const skills = truncateToTokens(params.skillsBlock, this.config.skillsMaxTokens);
            blocks.push({ role: 'system', content: skills, priority: 5 });
            totalTokens += estimateTokens(skills);
        }

        if (params.checkpointBlock) {
            const checkpoint = truncateToTokens(params.checkpointBlock, this.config.historyMaxTokens);
            blocks.push({ role: 'system', content: `[RESUMO DA CONVERSA]\n${checkpoint}\n[Use este resumo como contexto.]`, priority: 7 });
            totalTokens += estimateTokens(checkpoint);
        }

        const recentLimited = params.recentMessages
            .slice(-this.config.maxHistoryMessages)
            .map(m => ({ ...m, content: truncateToChars(m.content, this.config.maxMessageChars) }));

        let historyTokenBudget = this.config.historyMaxTokens;
        for (const msg of recentLimited) {
            const msgTokens = estimateTokens(msg.content);
            if (msgTokens > historyTokenBudget) {
                const remaining = truncateToTokens(msg.content, historyTokenBudget);
                blocks.push({ role: msg.role as ContextBlock['role'], content: remaining, priority: 3 });
                totalTokens += estimateTokens(remaining);
                historyTokenBudget -= estimateTokens(remaining);
            } else {
                blocks.push({ role: msg.role as ContextBlock['role'], content: msg.content, priority: 3 });
                totalTokens += msgTokens;
                historyTokenBudget -= msgTokens;
            }
            if (historyTokenBudget <= 0) break;
        }

        blocks.push({ role: 'user', content: params.currentUserMessage, priority: 9 });
        totalTokens += estimateTokens(params.currentUserMessage);

        if (totalTokens > this.maxInputTokens) {
            log.warn(`Context overflow: ${totalTokens} tokens > ${this.maxInputTokens} max. Truncating low-priority blocks.`);
            blocks.sort((a, b) => b.priority - a.priority);
            let kept = 0;
            for (const block of blocks) {
                if (kept + estimateTokens(block.content) <= this.maxInputTokens) {
                    kept += estimateTokens(block.content);
                } else {
                    const remaining = this.maxInputTokens - kept;
                    block.content = truncateToTokens(block.content, remaining);
                    break;
                }
            }
            blocks.sort((a, b) => {
                const roleOrder: Record<string, number> = { system: 0, user: 1, assistant: 2 };
                return (roleOrder[a.role] || 0) - (roleOrder[b.role] || 0);
            });
        }

        log.info(`ContextBudget: ${totalTokens} tokens across ${blocks.length} blocks (max: ${this.maxInputTokens})`);
        return blocks;
    }

    toLLMMessages(blocks: ContextBlock[]): Array<{ role: string; content: string }> {
        return blocks.map(b => ({ role: b.role, content: b.content }));
    }
}

// ── Seção 2: Seleção hierárquica de memória (ex-ContextPlanner) ─────────────

/** Máximo de slots por fase do planner. */
export interface TierBudgets {
    identity:    number;
    preference:  number;
    entity:      number;
    competitive: number;
}

export const DEFAULT_TIER_BUDGETS: TierBudgets = {
    identity:    2,
    preference:  3,
    entity:      3,
    competitive: 4,
};

export interface PlannerMetrics {
    tier0Selected:       number;
    tier1Selected:       number;
    entityExpansions:    number;
    competitiveSelected: number;
    skippedDueBudget:    number;
    expansionHitRate:    number;
    plannerLatencyMs:    number;
}

export interface PlannerResult {
    selectedNodeIds: string[];
    skippedCount:    number;
    entityExpanded:  string[];
    budget: { reserved: number; entity: number; competitive: number; total: number };
    reasons: Record<string, string>;
    metrics: PlannerMetrics;
}

const STOP_WORDS = new Set([
    'o','a','os','as','de','do','da','dos','das','em','no','na','e','um','uma',
    'para','com','por','que','não','como','mas','se','já','me','te','você','ele',
    'ela','eu','is','an','and','or','of','to','in','at','on','as','it','be',
    'the','this','that','was','are','have','has','what','how','can','do','did',
]);

const PERSONAL_ENTITY_TERMS = new Set([
    'filho','filha','filhos','filhas','esposa','marido','conjuge',
    'pai','mae','pais','familia','familiar','irmao','irma','irmaos','irmas',
    'avo','ava','neto','neta','sobrinho','sobrinha','primo','prima','tio','tia',
    'nome','sobrenome','apelido','identidade','idade','aniversario','nascimento',
    'carteira','portfolio','investimento','posicao','criptomoeda','criptomoedas','acao','acoes','fundos',
    'projeto','empresa','trabalho','emprego','cargo','disciplina','aula','aluno','professor','universidade',
    'son','daughter','sons','daughters','child','children','baby',
    'wife','husband','spouse','partner','father','mother','parents','family',
    'brother','sister','brothers','sisters','grandfather','grandmother','grandpa','grandma',
    'grandson','granddaughter','nephew','niece','cousin','uncle','aunt',
    'name','surname','nickname','identity','age','birthday','birth',
    'wallet','investment','portfolio','position','cryptocurrency','stock','stocks','funds',
    'project','company','job','work','role','class','student','teacher','university',
    'hijo','hija','hijos','hijas','nino','nina','bebe',
    'esposa','esposo','mujer','conyuge','pareja',
    'padre','madre','padres','familia','familiar',
    'hermano','hermana','hermanos','hermanas',
    'abuelo','abuela','nieto','nieta','sobrino','sobrina',
    'primo','prima','tio','tia',
    'nombre','apellido','apodo','identidad','edad','cumpleanos','nacimiento',
    'cartera','inversion','portafolio','posicion','criptomoneda','accion','acciones','fondos',
    'proyecto','empresa','trabajo','empleo','cargo','clase','alumno','profesor','universidad',
]);

function stripAccents(text: string): string {
    return text.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function tokenize(text: string): string[] {
    return text.toLowerCase().split(/\W+/).filter(w => w.length >= 3 && !STOP_WORDS.has(w));
}

export function extractEntities(query: string, overrideEntities?: string[]): string[] {
    if (overrideEntities && overrideEntities.length > 0) {
        return [...new Set(overrideEntities.map(e => e.toLowerCase()))];
    }
    const results = new Set<string>();
    const queryNorm = stripAccents(query.toLowerCase());

    const tickers = query.match(/\b[A-Z]{2,}\b/g) ?? [];
    for (const t of tickers) results.add(t.toLowerCase());

    const words = query.split(/\s+/);
    for (let i = 1; i < words.length; i++) {
        const w = words[i].replace(/[^A-Za-zÀ-ú]/g, '');
        if (w.length >= 3 && /^[A-ZÀ-Ú]/.test(w) && !/^[A-Z]{2,}$/.test(w)) results.add(w.toLowerCase());
    }

    for (const term of PERSONAL_ENTITY_TERMS) {
        if (queryNorm.includes(term)) results.add(term);
    }

    const possessiveMatches = query.matchAll(
        /\b(?:meu|minha|meus|minhas|nosso|nossa|nossos|nossas|my|our|mi|mis|nuestro|nuestra|nuestros|nuestras)\s+(\w+)/gi
    );
    for (const m of possessiveMatches) {
        const entity = stripAccents(m[1].toLowerCase());
        if (entity.length >= 3) results.add(entity);
    }

    return [...results];
}

export function isPersonalMemoryQuery(query: string): boolean {
    const qn = stripAccents(query.toLowerCase());
    for (const term of PERSONAL_ENTITY_TERMS) {
        if (qn.includes(term)) return true;
    }
    if (/\b(?:meu|minha|meus|minhas|my|mi|mis)\s+\w+/i.test(query)) return true;
    return false;
}

function quickRelevance(queryTerms: string[], entry: MemoryIndexEntry): number {
    if (queryTerms.length === 0) return 0;
    const haystack = `${entry.entity} ${entry.summary} ${entry.keywords.join(' ')}`.toLowerCase();
    let hits = 0;
    for (const term of queryTerms) { if (haystack.includes(term)) hits++; }
    return hits / queryTerms.length;
}

function entryMatchesEntity(entity: string, entry: MemoryIndexEntry): boolean {
    const haystack = `${entry.entity} ${entry.keywords.join(' ')} ${entry.summary}`.toLowerCase();
    return haystack.includes(entity);
}

function matchesAnyEntity(entities: string[], entry: MemoryIndexEntry): boolean {
    return entities.some(en => entryMatchesEntity(en, entry));
}

function sortByImportance(entries: MemoryIndexEntry[]): MemoryIndexEntry[] {
    return [...entries].sort((a, b) => b.importance - a.importance);
}

/**
 * ContextPlanner — Seleção hierárquica em 4 fases:
 *   1. Identity (Tier 0)  2. Preference (Tier 1)  3. Entity cluster  4. Competitive fill
 * Determinístico, sem chamadas LLM.
 */
export class ContextPlanner {
    private readonly budgets: TierBudgets;

    constructor(budgets: Partial<TierBudgets> = {}) {
        this.budgets = { ...DEFAULT_TIER_BUDGETS, ...budgets };
    }

    plan(query: string, summaries: MemoryIndexEntry[], totalBudget: number, overrideEntities?: string[]): PlannerResult {
        const t0 = Date.now();
        const selected = new Map<string, string>();
        const entitySource = overrideEntities ? 'llm-override' : 'deterministic';
        const entities = extractEntities(query, overrideEntities);
        const queryTerms = tokenize(query);

        log.info('[ENTITY] extracted=[' + (entities.join(',') || 'none') + '] source=' + entitySource);

        // Fase 1: Core Identity (Tier 0)
        const identityCap = Math.min(this.budgets.identity, totalBudget);
        for (const e of sortByImportance(summaries.filter(e => e.tier === MemoryTier.CORE_IDENTITY))) {
            if (selected.size >= identityCap) break;
            selected.set(e.nodeId, `tier0:identity imp=${e.importance.toFixed(2)}`);
        }
        const tier0Count = selected.size;

        // Fase 2: Permanent (Tier 1)
        const permCap = Math.min(this.budgets.identity + this.budgets.preference, totalBudget);
        for (const e of sortByImportance(summaries.filter(e => e.tier === MemoryTier.PERMANENT && !selected.has(e.nodeId)))) {
            if (selected.size >= permCap) break;
            const rel = quickRelevance(queryTerms, e);
            if (rel > 0 || e.importance >= 0.8) {
                selected.set(e.nodeId, `tier1:pref rel=${rel.toFixed(2)} imp=${e.importance.toFixed(2)}`);
            }
        }
        const tier1Count = selected.size - tier0Count;
        const reservedCount = selected.size;

        // Fase 3: Entity Cluster Expansion (cross-tier)
        const entityExpanded: string[] = [];
        let entityCount = 0;
        if (entities.length > 0 && selected.size < totalBudget) {
            const entityCap = Math.min(reservedCount + this.budgets.entity, totalBudget);
            const clusterCandidates = summaries
                .filter(e => !selected.has(e.nodeId) && matchesAnyEntity(entities, e))
                .sort((a, b) => (b.importance - a.importance) || (a.tier - b.tier));
            for (const e of clusterCandidates) {
                if (selected.size >= entityCap) break;
                const matchedEntity = entities.find(en => entryMatchesEntity(en, e)) ?? '';
                selected.set(e.nodeId, `tier${e.tier}:entity=${matchedEntity} imp=${e.importance.toFixed(2)}`);
                entityExpanded.push(matchedEntity);
                entityCount++;
            }
        }
        const expansionHitRate = entities.length > 0 ? Math.min(1, entityCount / entities.length) : 0;

        // Fase 4: Competitive fill (Tiers 2-4)
        const compCap = Math.min(selected.size + this.budgets.competitive, totalBudget);
        const competitive = summaries
            .filter(e => !selected.has(e.nodeId) && e.tier >= MemoryTier.ACTIVE_ENTITIES)
            .map(e => ({ entry: e, score: quickRelevance(queryTerms, e) * 0.6 + e.importance * 0.3 + e.permanence * 0.1 }))
            .sort((a, b) => b.score - a.score);
        let compCount = 0;
        for (const { entry: e, score } of competitive) {
            if (selected.size >= compCap) break;
            selected.set(e.nodeId, `tier${e.tier}:comp score=${score.toFixed(2)}`);
            compCount++;
        }

        const totalSelected = selected.size;
        const skipped = summaries.length - totalSelected;
        log.info(`[PLANNER] done: selected=${totalSelected} skipped=${skipped} tier0=${tier0Count} tier1=${tier1Count} entity=${entityCount} comp=${compCount}`);

        return {
            selectedNodeIds: [...selected.keys()],
            skippedCount:    skipped,
            entityExpanded:  [...new Set(entityExpanded)],
            budget: { reserved: reservedCount, entity: entityCount, competitive: compCount, total: totalSelected },
            reasons: Object.fromEntries(selected),
            metrics: {
                tier0Selected:       tier0Count,
                tier1Selected:       tier1Count,
                entityExpansions:    entityCount,
                competitiveSelected: compCount,
                skippedDueBudget:    skipped,
                expansionHitRate,
                plannerLatencyMs:    Date.now() - t0,
            },
        };
    }
}

// ── Seção 3: Relevância social e tier de contexto ────────────────────────────

export type ContextTier = 'minimal' | 'normal' | 'full';

export type EntityFallbackExtractor = (query: string) => Promise<{ entities: string[]; confidence: number }>;

const GREETING_PATTERNS: RegExp[] = [
    /^(oi|olá|ola|eai|eae|fala|opa|hey|hello|hi|bom dia|boa tarde|boa noite|salve|coé|coe)[\s!.?]*$/i,
    /^(tchau|bye|até|ate|flw|falou)[\s!.?]*$/i,
    /^(valeu|obrigad[oa]?|vlw)[\s!.?]*$/i,
    /^(kk+|haha+|rsrs?|👍|🤣|😂)[\s!.?]*$/i,
];

const MIN_QUERY_LENGTH = 4;

function isSocialOrGreeting(query: string): boolean {
    const trimmed = query.trim().toLowerCase();
    if (trimmed.length < MIN_QUERY_LENGTH) return true;
    return GREETING_PATTERNS.some(p => p.test(trimmed));
}

// ── Seção 4: ContextBuilder — montagem do contexto final ────────────────────

interface RankedNode {
    id: string;
    name: string;
    type: string;
    summary: string;
    score: number;
    relations: string[];
    epistemicStatus?: string | null;
    identityScope?: string | null;
}

export class ContextBuilder {
    private memory: MemoryManager;
    private memoryFacade: MemoryFacade;
    private domainSummaryService: DomainSummaryService;
    private episodicMemoryService: EpisodicMemoryService;
    private reflectionEngine: CognitiveReflectionEngine;
    private retriever: MultiLayerRetriever | null = null;
    private cognitiveIndex: CognitiveMemoryIndex | null = null;
    private contextPlanner: ContextPlanner | null = null;
    private entityFallbackExtractor?: EntityFallbackExtractor;

    private readonly MAX_MEMORY_CHARS  = 3200;
    private readonly BUDGET_REFLECTION = 500;
    private readonly BUDGET_EPISODIC   = 400;
    private readonly BUDGET_DOMAIN     = 250;
    private readonly MIN_NODES_CHARS   = 600;
    private readonly DEFAULT_MAX_EXPANDED_NODES = 8;
    private readonly MAX_SUMMARY       = 200;
    private readonly MAX_RELATIONS     = 3;

    private readonly W_SIMILARITY   = 0.6;
    private readonly W_CONNECTIVITY = 0.25;
    private readonly W_RECENCY      = 0.15;

    constructor(memory: MemoryManager) {
        this.memory = memory;
        this.memoryFacade = memory.getFacade();
        this.domainSummaryService = memory.getDomainSummaryService();
        this.episodicMemoryService = memory.getEpisodicMemoryService();
        this.reflectionEngine = memory.getCognitiveReflectionEngine();
    }

    setEntityFallbackExtractor(fn: EntityFallbackExtractor): void {
        this.entityFallbackExtractor = fn;
    }

    async buildContext(query: string, conversationId?: string, tier: ContextTier = 'full'): Promise<string> {
        if (isSocialOrGreeting(query)) {
            if (conversationId) this.episodicMemoryService.recordInteraction(conversationId);
            return '';
        }

        let effectiveTier = tier;
        if (tier === 'minimal' && isPersonalMemoryQuery(query)) {
            effectiveTier = 'normal';
            log.info('[SALIENCE] personal-memory=true → upgraded tier minimal→normal');
        }

        const maxNodes    = effectiveTier === 'minimal' ? 3 : effectiveTier === 'normal' ? 5 : this.DEFAULT_MAX_EXPANDED_NODES;
        const maxMemChars = effectiveTier === 'minimal' ? 800 : effectiveTier === 'normal' ? 1600 : this.MAX_MEMORY_CHARS;
        const useReflection = effectiveTier === 'full';
        const useEpisodic   = effectiveTier !== 'minimal';

        log.info(`[CONTEXT-TIER] tier=${effectiveTier} maxNodes=${maxNodes} maxChars=${maxMemChars} reflection=${useReflection} episodic=${useEpisodic}`);

        try {
            if (conversationId) this.episodicMemoryService.recordInteraction(conversationId);

            const domainClass = classifyDomain(query);

            const reflectionBlock = useReflection
                ? truncateToChars(this.reflectionEngine.buildReflectionBlock(), this.BUDGET_REFLECTION)
                : '';

            const episodicBlock = (useEpisodic && conversationId)
                ? truncateToChars(this.episodicMemoryService.buildEpisodicPromptBlock(conversationId, 3), this.BUDGET_EPISODIC)
                : '';

            let domainBlock = '';
            if (domainClass && domainClass.confidence >= 0.3) {
                domainBlock = truncateToChars(
                    this.domainSummaryService.buildPromptBlock(domainClass.domainId),
                    this.BUDGET_DOMAIN
                );
            }

            const headerChars = [reflectionBlock, episodicBlock, domainBlock]
                .filter(Boolean)
                .reduce((sum, b) => sum + b.length + 5, 0);
            const nodesBudget = Math.max(this.MIN_NODES_CHARS, maxMemChars - headerChars);

            const ranked = await this.rankAndSelectHierarchically(query, nodesBudget, maxNodes);

            if (conversationId && ranked.length > 0) {
                this.episodicMemoryService.recordNodeAccesses(conversationId, ranked.map(n => n.id));
            }

            if (ranked.length > 0) {
                const TIER_LABEL: Record<string, string> = {
                    identity: 'tier0:identity', preference: 'tier1:pref',
                    trait: 'tier1:trait', project: 'tier2:proj',
                    infrastructure: 'tier2:infra', context: 'tier2:ctx',
                    fact: 'tier3:fact', skill: 'tier4:skill',
                    rule: 'tier4:rule', strategy: 'tier4:strat',
                    knowledge: 'tier4:know', domain: 'tier4:domain',
                };
                const lines = ranked.map((n, i) => {
                    const tier = TIER_LABEL[n.type] ?? `tier?:${n.type}`;
                    const snippet = n.summary.replace(/\n/g, ' ').slice(0, 90);
                    return `  ${i + 1}. [${tier}] ${n.name} | score=${n.score.toFixed(2)} | ${snippet}`;
                }).join('\n');
                log.info(`[MEMORY-NODES] ${ranked.length} nó(s) injetado(s):\n${lines}`);
            } else {
                log.info('[MEMORY-NODES] nenhum nó selecionado — contexto vazio');
            }

            if (ranked.length === 0) {
                const fallback = this.memory.getContext(200);
                const header = [reflectionBlock, episodicBlock, domainBlock].filter(Boolean).join('\n---\n');
                return header ? `${header}\n${fallback}` : fallback;
            }

            const parts = ranked.map(n => {
                const epistemicPrefix =
                    n.epistemicStatus === 'belief'     ? '[crença] ' :
                    n.epistemicStatus === 'assumption' ? '[suposição] ' :
                    '';
                let entry = `${n.name}(${n.type}): ${epistemicPrefix}${n.summary}`;
                if (n.relations.length > 0) entry += ` → ${n.relations.join(', ')}`;
                return entry;
            });

            const detailsStr = 'Contexto: ' + parts.join('. ');
            const blocks = [reflectionBlock, episodicBlock, domainBlock].filter(Boolean);
            const result = blocks.length > 0
                ? `${blocks.join('\n---\n')}\n---\n${detailsStr}`
                : detailsStr;

            log.info(`[BUDGET] memory block: ${estimateTokens(result)} tokens | blocks=${blocks.length} nodes=${ranked.length} chars=${result.length}/${this.MAX_MEMORY_CHARS} maxExpandedNodes=${maxNodes}`);
            return result;
        } catch {
            return this.memory.getContext(200);
        }
    }

    private getContextPlanner(): ContextPlanner {
        if (!this.contextPlanner) this.contextPlanner = new ContextPlanner();
        return this.contextPlanner;
    }

    private getCognitiveIndex(): CognitiveMemoryIndex {
        if (!this.cognitiveIndex) this.cognitiveIndex = new CognitiveMemoryIndex(this.memory.getDatabase());
        return this.cognitiveIndex;
    }

    private async rankAndSelectHierarchically(query: string, charBudget: number, maxNodes: number): Promise<RankedNode[]> {
        try {
            const candidates = await this.semanticSearch(query);
            if (candidates.length === 0) return this.rankAndSelect(query, charBudget);

            const nodeIds = candidates.map(c => c.id);
            const mlrSummaries = this.getCognitiveIndex().getSummaries(nodeIds);
            const permanentSummaries = this.getCognitiveIndex().getPermanentSummaries();
            const summaryMap = new Map<string, MemoryIndexEntry>();
            for (const s of permanentSummaries) summaryMap.set(s.nodeId, s);
            for (const s of mlrSummaries) summaryMap.set(s.nodeId, s);
            const summaries = Array.from(summaryMap.values());
            log.debug(`[INDEX] summaries retrieved=${summaries.length} (mlr=${mlrSummaries.length} permanent=${permanentSummaries.length}) from candidates=${candidates.length}`);

            if (summaries.length === 0) {
                log.warn(`[INDEX] CognitiveMemoryIndex returned 0 summaries for ${candidates.length} MLR candidates — falling back to direct MLR pool.`);
            }

            const planResult = this.getContextPlanner().plan(query, summaries, maxNodes);
            const m = planResult.metrics;
            log.info(
                `[COGNITIVE-METRICS] summariesRetrieved=${summaries.length} summariesSelected=${planResult.budget.total} ` +
                `tier0=${m.tier0Selected} tier1=${m.tier1Selected} ` +
                `entity=${m.entityExpansions} competitive=${m.competitiveSelected} ` +
                `skipped=${m.skippedDueBudget} expansionHitRate=${m.expansionHitRate.toFixed(2)} ` +
                `plannerLatency=${m.plannerLatencyMs}ms`
            );

            let selectedSet = new Set(planResult.selectedNodeIds);
            let filtered = candidates.filter(c => selectedSet.has(c.id));

            if (filtered.length === 0 && isPersonalMemoryQuery(query) && this.entityFallbackExtractor) {
                try {
                    log.info('[ENTITY-LLM] fallback activated');
                    const llmResult = await this.entityFallbackExtractor(query);
                    if (llmResult.entities.length > 0) {
                        log.info(`[ENTITY-LLM] entities=[${llmResult.entities.join(',')}] confidence=${llmResult.confidence.toFixed(2)}`);
                        const fallbackPlan = this.getContextPlanner().plan(query, summaries, maxNodes, llmResult.entities);
                        const fallbackSet = new Set(fallbackPlan.selectedNodeIds);
                        const fallbackFiltered = candidates.filter(c => fallbackSet.has(c.id));
                        if (fallbackFiltered.length > 0) {
                            filtered = fallbackFiltered;
                            selectedSet = fallbackSet;
                        }
                    }
                } catch (llmErr) {
                    log.warn('[ENTITY-LLM] fallback failed — using deterministic result: ' + String(llmErr));
                }
            }

            const pool = filtered.length > 0 ? filtered : candidates;
            return this.rankNodes(pool, charBudget);
        } catch (err) {
            log.warn('hierarchical_fallback', `Falling back to domain pipeline: ${err}`);
            return this.domainAwareRankAndSelect(query, charBudget);
        }
    }

    private async domainAwareRankAndSelect(query: string, charBudget: number): Promise<RankedNode[]> {
        const domainClass = classifyDomain(query);
        if (domainClass && domainClass.confidence >= 0.5) {
            const subgraphNodes = this.memory.getRelatedNodes(domainClass.domainId, 'contains');
            if (subgraphNodes.length >= 2) {
                const subgraphIds = new Set(subgraphNodes.map(n => n.id));
                const allSemantic = await this.semanticSearch(query);
                const domainFiltered = allSemantic.filter(n => subgraphIds.has(n.id));
                if (domainFiltered.length >= 2) return this.rankNodes(domainFiltered, charBudget);
            }
        }
        return this.rankAndSelect(query, charBudget);
    }

    private rankNodes(nodes: Array<MemoryNode & { score: number; attentionScore?: number }>, charBudget: number): RankedNode[] {
        const scored: RankedNode[] = nodes.map((node) => {
            const similarity   = node.score || node.attentionScore || 0.5;
            const connectivity = this.getConnectivity(node.id);
            const recency      = this.getRecency(node.id);

            let score = (similarity * this.W_SIMILARITY) +
                        (connectivity * this.W_CONNECTIVITY) +
                        (recency * this.W_RECENCY);

            if (node.type === 'preference') score *= 1.5;
            if (node.type === 'identity')   score *= 1.3;

            const es    = (node as MemoryNode & { epistemic_status?: string }).epistemic_status;
            const scope = (node as MemoryNode & { identity_scope?: string }).identity_scope;
            if (es === 'fact')       score *= 1.1;
            if (es === 'assumption') score *= 0.8;
            if (scope === 'USER_MEMORY')   score *= 1.2;
            if (scope === 'TASK_MEMORY')   score *= 1.1;
            if (scope === 'SYSTEM_MEMORY') score *= 0.9;

            return {
                id: node.id,
                name: node.name || node.id,
                type: node.type || 'fact',
                summary: this.compactContent(node.content),
                score,
                relations: this.getTopRelations(node.id),
                epistemicStatus: es ?? null,
                identityScope: scope ?? null,
            };
        });

        scored.sort((a, b) => b.score - a.score);

        const result: RankedNode[] = [];
        let usedChars = 'Contexto: '.length;
        for (const n of scored) {
            if (result.length >= this.DEFAULT_MAX_EXPANDED_NODES) break;
            const epistemicPrefix = n.epistemicStatus === 'belief' ? '[crença] '
                : n.epistemicStatus === 'assumption' ? '[suposição] ' : '';
            const entryLen = n.name.length + n.type.length + epistemicPrefix.length + n.summary.length
                + (n.relations.length > 0 ? n.relations.join(', ').length + 4 : 0) + 4;
            if (result.length >= 2 && usedChars + entryLen > charBudget) break;
            result.push(n);
            usedChars += entryLen;
        }
        return result;
    }

    private async rankAndSelect(query: string, charBudget: number): Promise<RankedNode[]> {
        const semanticResults = await this.semanticSearch(query);
        return this.rankNodes(semanticResults, charBudget);
    }

    private getRetriever(): MultiLayerRetriever {
        if (!this.retriever) this.retriever = new MultiLayerRetriever(
            this.memory.getDatabase(),
            this.memory.getTemporalLayer(),
            this.memory.getProceduralMemory()
        );
        return this.retriever;
    }

    private async semanticSearch(query: string): Promise<Array<MemoryNode & { score: number; attentionScore?: number }>> {
        const rawSemantic: Array<MemoryNode & { score: number; attentionScore?: number }> = [];
        try {
            const results = await this.memory.semanticSearchWithAttention(query, 12);
            rawSemantic.push(...(results || []));
        } catch {
            try {
                const results = await this.memory.semanticSearch(query, 12);
                rawSemantic.push(...(results || []));
            } catch { /* ignore */ }
        }

        const semanticCandidates = rawSemantic.map(n => ({
            nodeId: n.id,
            score: n.score || (n as MemoryNode & { attentionScore?: number }).attentionScore || 0.5,
        }));

        const fused = this.getRetriever().retrieve(query, semanticCandidates);

        const nodeById = new Map<string, MemoryNode & { score: number; attentionScore?: number }>(
            rawSemantic.map(n => [n.id, n])
        );

        const missingIds = fused.map(c => c.nodeId).filter(id => !nodeById.has(id));
        if (missingIds.length > 0) {
            const ph = missingIds.map(() => '?').join(',');
            const rows = this.memory.getDatabase().prepare(`
                SELECT * FROM memory_nodes
                WHERE id IN (${ph})
                  AND (lifecycle_state IS NULL OR lifecycle_state = 'ACTIVE')
            `).all(...missingIds) as MemoryNode[];
            for (const row of rows) nodeById.set(row.id, { ...row, score: 0 });
        }

        return fused
            .map(c => {
                const node = nodeById.get(c.nodeId);
                if (!node) return null;
                return { ...node, score: c.fusedScore };
            })
            .filter((n): n is MemoryNode & { score: number } => n !== null);
    }

    private compactContent(content: string | undefined): string {
        if (!content) return '';
        if (content.length <= this.MAX_SUMMARY) return content;
        const cut = content.slice(0, this.MAX_SUMMARY);
        const lastPeriod = cut.lastIndexOf('.');
        if (lastPeriod > this.MAX_SUMMARY * 0.5) return cut.slice(0, lastPeriod + 1);
        return cut + '...';
    }

    private getConnectivity(nodeId: string): number {
        try {
            const degree = this.memoryFacade.getNodeConnectivity(nodeId);
            return Math.min(degree / 10, 1.0);
        } catch { return 0.3; }
    }

    private getRecency(nodeId: string): number {
        try { return this.memoryFacade.getNodeRecency(nodeId); }
        catch { return 0.3; }
    }

    private getTopRelations(nodeId: string): string[] {
        try { return this.memoryFacade.getTopRelations(nodeId, this.MAX_RELATIONS); }
        catch { return []; }
    }
}
