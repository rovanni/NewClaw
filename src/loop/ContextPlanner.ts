/**
 * ContextPlanner — Seleção hierárquica de nós de memória por tier cognitivo
 *
 * Pipeline (4 fases):
 *   1. Identity   — Tier 0: sempre incluído, custo fixo
 *   2. Preference — Tier 1: incluído se relevância > 0 ou importância >= 0.8
 *   3. Entity     — Cluster expansion cross-tier: todos os nós não-selecionados que
 *                   mencionam entidades detectadas na query (tickers ALL-CAPS, nomes próprios,
 *                   termos pessoais PT-BR, palavras após possessivos)
 *   4. Competitive — Fill restante por pontuação composta (relevância + importância + permanência)
 *
 * Budgets por fase são configuráveis via TierBudgets.
 * Nenhuma chamada LLM — relevância via matching de termos/entidades.
 * LLM fallback é responsabilidade do ContextBuilder (injetado via overrideEntities).
 */

import { MemoryTier, type MemoryIndexEntry } from '../memory/CognitiveMemoryIndex';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('ContextPlanner');

// ── Tipos públicos ────────────────────────────────────────────────────────────

/** Máximo de slots por fase do planner. Configurável para tuning futuro. */
export interface TierBudgets {
    identity:    number;   // Tier 0 — core identity
    preference:  number;   // Tier 1 — preferences + traits
    entity:      number;   // entity-centric cluster expansion (cross-tier)
    competitive: number;   // fill competitivo (Tiers 2-4 restantes)
}

export const DEFAULT_TIER_BUDGETS: TierBudgets = {
    identity:    2,
    preference:  3,
    entity:      3,
    competitive: 4,
};

/** Métricas cognitivas retornadas pelo planner para logging e observabilidade. */
export interface PlannerMetrics {
    tier0Selected:       number;
    tier1Selected:       number;
    entityExpansions:    number;
    competitiveSelected: number;
    skippedDueBudget:    number;
    expansionHitRate:    number;   // entityExpansions / entitiesDetected (0 se sem entidades)
    plannerLatencyMs:    number;
}

export interface PlannerResult {
    selectedNodeIds: string[];
    skippedCount:    number;
    entityExpanded:  string[];   // entidades únicas que causaram expansão
    budget: {
        reserved:    number;     // slots usados em Tier 0+1
        entity:      number;     // slots usados em entity expansion
        competitive: number;     // slots usados no fill competitivo
        total:       number;
    };
    reasons: Record<string, string>;   // nodeId → motivo da seleção
    metrics: PlannerMetrics;
}

// ── Classe principal ──────────────────────────────────────────────────────────

export class ContextPlanner {
    private readonly budgets: TierBudgets;

    constructor(budgets: Partial<TierBudgets> = {}) {
        this.budgets = { ...DEFAULT_TIER_BUDGETS, ...budgets };
    }

    /**
     * Seleciona os nodeIds mais relevantes respeitando as 4 fases hierárquicas.
     *
     * @param query           Texto da mensagem do usuário
     * @param summaries       Entradas do CognitiveMemoryIndex (já carregadas)
     * @param totalBudget     Número máximo de nodeIds a retornar (hard cap)
     * @param overrideEntities Entidades pré-computadas (ex.: vindas de fallback LLM).
     *                         Quando fornecidas, o extractor determinístico é ignorado.
     */
    plan(
        query:            string,
        summaries:        MemoryIndexEntry[],
        totalBudget:      number,
        overrideEntities?: string[],
    ): PlannerResult {
        const t0 = Date.now();
        const selected  = new Map<string, string>(); // nodeId → reason
        const entitySource = overrideEntities ? 'llm-override' : 'deterministic';
        const entities  = extractEntities(query, overrideEntities);
        const queryTerms = tokenize(query);

        log.info('[ENTITY] extracted=[' + (entities.join(',') || 'none') + '] source=' + entitySource);
        log.debug('planner_start',
            `summaries=${summaries.length} budget=${totalBudget} ` +
            `entities=[${entities.join(',') || 'none'}] ` +
            `tierBudgets=${JSON.stringify(this.budgets)}`
        );

        // ── Fase 1: Core Identity (Tier 0) ──────────────────────────────────
        const identityCap = Math.min(this.budgets.identity, totalBudget);
        for (const e of sortByImportance(summaries.filter(e => e.tier === MemoryTier.CORE_IDENTITY))) {
            if (selected.size >= identityCap) break;
            selected.set(e.nodeId, `tier0:identity imp=${e.importance.toFixed(2)}`);
        }
        const tier0Count = selected.size;
        log.info('[PLANNER] tier0 selected=' + tier0Count);

        // ── Fase 2: Permanent (Tier 1) ──────────────────────────────────────
        const permCap = Math.min(this.budgets.identity + this.budgets.preference, totalBudget);
        for (const e of sortByImportance(summaries.filter(e =>
            e.tier === MemoryTier.PERMANENT && !selected.has(e.nodeId)
        ))) {
            if (selected.size >= permCap) break;
            const rel = quickRelevance(queryTerms, e);
            if (rel > 0 || e.importance >= 0.8) {
                selected.set(e.nodeId,
                    `tier1:pref rel=${rel.toFixed(2)} imp=${e.importance.toFixed(2)}`
                );
            }
        }
        const tier1Count = selected.size - tier0Count;
        log.info('[PLANNER] tier1 selected=' + tier1Count);

        const reservedCount = selected.size;

        // ── Fase 3: Entity Cluster Expansion (cross-tier) ───────────────────
        // Expande TODOS os tiers não-selecionados que mencionam as entidades detectadas.
        // Garante que holdings, preferências, estratégias e histórico relacionados
        // ao tópico entrem no contexto sem depender de similaridade semântica.
        const entityExpanded: string[] = [];
        let entityCount = 0;

        if (entities.length > 0 && selected.size < totalBudget) {
            const entityCap = Math.min(reservedCount + this.budgets.entity, totalBudget);

            const clusterCandidates = summaries
                .filter(e => !selected.has(e.nodeId) && matchesAnyEntity(entities, e))
                // Tier menor = prioridade maior (identity > perm > entities > episodic)
                .sort((a, b) => (b.importance - a.importance) || (a.tier - b.tier));

            for (const e of clusterCandidates) {
                if (selected.size >= entityCap) break;
                const matchedEntity = entities.find(en => entryMatchesEntity(en, e)) ?? '';
                selected.set(e.nodeId,
                    `tier${e.tier}:entity=${matchedEntity} imp=${e.importance.toFixed(2)}`
                );
                entityExpanded.push(matchedEntity);
                entityCount++;
            }
        }

        const expansionHitRate = entities.length > 0
            ? Math.min(1, entityCount / entities.length)
            : 0;
        log.info('[PLANNER] entity expansion=' + entityCount +
            ' entities=[' + entities.join(',') + ']');

        // ── Fase 4: Competitive fill (Tiers 2-4 restantes) ──────────────────
        const compCap = Math.min(selected.size + this.budgets.competitive, totalBudget);
        const competitive = summaries
            .filter(e => !selected.has(e.nodeId) && e.tier >= MemoryTier.ACTIVE_ENTITIES)
            .map(e => ({
                entry: e,
                score: quickRelevance(queryTerms, e) * 0.6 +
                       e.importance               * 0.3 +
                       e.permanence               * 0.1,
            }))
            .sort((a, b) => b.score - a.score);

        let compCount = 0;
        for (const { entry: e, score } of competitive) {
            if (selected.size >= compCap) break;
            selected.set(e.nodeId, `tier${e.tier}:comp score=${score.toFixed(2)}`);
            compCount++;
        }
        log.info('[PLANNER] competitive selected=' + compCount);

        const totalSelected = selected.size;
        const skipped = summaries.length - totalSelected;
        log.info(`[PLANNER] done: selected=${totalSelected} skipped=${skipped} (summaries_total=${summaries.length})`);

        const metrics: PlannerMetrics = {
            tier0Selected:       tier0Count,
            tier1Selected:       tier1Count,
            entityExpansions:    entityCount,
            competitiveSelected: compCount,
            skippedDueBudget:    skipped,
            expansionHitRate,
            plannerLatencyMs:    Date.now() - t0,
        };

        return {
            selectedNodeIds: [...selected.keys()],
            skippedCount:    skipped,
            entityExpanded:  [...new Set(entityExpanded)],
            budget: {
                reserved:    reservedCount,
                entity:      entityCount,
                competitive: compCount,
                total:       totalSelected,
            },
            reasons: Object.fromEntries(selected),
            metrics,
        };
    }
}

// ── Funções puras (fora da classe para testabilidade) ─────────────────────────

const STOP_WORDS = new Set([
    'o','a','os','as','de','do','da','dos','das','em','no','na','e','um','uma',
    'para','com','por','que','não','como','mas','se','já','me','te','você','ele',
    'ela','eu','is','an','and','or','of','to','in','at','on','as','it','be',
    'the','this','that','was','are','have','has','what','how','can','do','did',
]);

/**
 * Vocabulário de termos pessoais/familiares — PT-BR, EN, ES.
 * Todos os termos ficam normalizados sem acento (stripAccents aplicado na comparação),
 * então "filha", "figlia", "hija" são escritos aqui sem acento quando necessário.
 */
const PERSONAL_ENTITY_TERMS = new Set([
    // ── PT-BR: Família ───────────────────────────────────────
    'filho', 'filha', 'filhos', 'filhas',
    'esposa', 'marido', 'conjuge',
    'pai', 'mae', 'pais', 'familia', 'familiar',
    'irmao', 'irma', 'irmaos', 'irmas',
    'avo', 'ava', 'neto', 'neta', 'sobrinho', 'sobrinha',
    'primo', 'prima', 'tio', 'tia',
    // PT-BR: Identidade
    'nome', 'sobrenome', 'apelido', 'identidade',
    'idade', 'aniversario', 'nascimento',
    // PT-BR: Finanças
    'carteira', 'portfolio', 'investimento', 'posicao',
    'criptomoeda', 'criptomoedas', 'acao', 'acoes', 'fundos',
    // PT-BR: Trabalho
    'projeto', 'empresa', 'trabalho', 'emprego', 'cargo',
    'disciplina', 'aula', 'aluno', 'professor', 'universidade',

    // ── EN: Family ───────────────────────────────────────────
    'son', 'daughter', 'sons', 'daughters', 'child', 'children', 'baby',
    'wife', 'husband', 'spouse', 'partner',
    'father', 'mother', 'parents', 'family',
    'brother', 'sister', 'brothers', 'sisters',
    'grandfather', 'grandmother', 'grandpa', 'grandma',
    'grandson', 'granddaughter', 'nephew', 'niece',
    'cousin', 'uncle', 'aunt',
    // EN: Identity
    'name', 'surname', 'nickname', 'identity', 'age', 'birthday', 'birth',
    // EN: Finance
    'wallet', 'investment', 'portfolio', 'position', 'cryptocurrency', 'stock', 'stocks', 'funds',
    // EN: Work
    'project', 'company', 'job', 'work', 'role', 'class', 'student', 'teacher', 'university',

    // ── ES: Familia ───────────────────────────────────────────
    'hijo', 'hija', 'hijos', 'hijas', 'nino', 'nina', 'bebe',
    'esposa', 'esposo', 'mujer', 'conyuge', 'pareja',
    'padre', 'madre', 'padres', 'familia', 'familiar',
    'hermano', 'hermana', 'hermanos', 'hermanas',
    'abuelo', 'abuela', 'nieto', 'nieta', 'sobrino', 'sobrina',
    'primo', 'prima', 'tio', 'tia',
    // ES: Identidad
    'nombre', 'apellido', 'apodo', 'identidad', 'edad', 'cumpleanos', 'nacimiento',
    // ES: Finanzas
    'cartera', 'inversion', 'portafolio', 'posicion', 'criptomoneda', 'accion', 'acciones', 'fondos',
    // ES: Trabajo
    'proyecto', 'empresa', 'trabajo', 'empleo', 'cargo', 'clase', 'alumno', 'profesor', 'universidad',
]);

/** Remove acentos para comparação normalizada. */
function stripAccents(text: string): string {
    return text.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function tokenize(text: string): string[] {
    return text.toLowerCase()
        .split(/\W+/)
        .filter(w => w.length >= 3 && !STOP_WORDS.has(w));
}

/**
 * Detecta entidades na query via 4 estratégias determinísticas:
 *   1. Tokens ALL-CAPS (tickers: BTC, ETH, RIVER)
 *   2. Palavras capitalizadas no meio da frase (nomes próprios)
 *   3. Vocabulário de termos pessoais/familiares (PT-BR + EN + ES)
 *   4. Palavras após possessivos PT/EN/ES (meu/my/mi → filho/son/hijo…)
 *
 * Aceita overrideEntities para injeção de entidades vindas de fallback LLM.
 */
export function extractEntities(query: string, overrideEntities?: string[]): string[] {
    if (overrideEntities && overrideEntities.length > 0) {
        return [...new Set(overrideEntities.map(e => e.toLowerCase()))];
    }

    const results = new Set<string>();
    const queryNorm = stripAccents(query.toLowerCase());

    // 1. ALL-CAPS tickers (BTC, RIVER, ETH, PI)
    const tickers = query.match(/\b[A-Z]{2,}\b/g) ?? [];
    for (const t of tickers) results.add(t.toLowerCase());

    // 2. Palavras capitalizadas no meio/fim da frase (nomes próprios)
    const words = query.split(/\s+/);
    for (let i = 1; i < words.length; i++) {
        const w = words[i].replace(/[^A-Za-zÀ-ú]/g, '');
        if (w.length >= 3 && /^[A-ZÀ-Ú]/.test(w) && !/^[A-Z]{2,}$/.test(w)) {
            results.add(w.toLowerCase());
        }
    }

    // 3. Termos pessoais/familiares (dicionário PT-BR, comparação sem acentos)
    for (const term of PERSONAL_ENTITY_TERMS) {
        if (queryNorm.includes(term)) {
            results.add(term);
        }
    }

    // 4. Palavras após possessivos (PT-BR / EN / ES)
    //    PT: meu/minha/meus/minhas  EN: my/our  ES: mi/mis/nuestro/nuestra
    const possessiveMatches = query.matchAll(
        /\b(?:meu|minha|meus|minhas|nosso|nossa|nossos|nossas|my|our|mi|mis|nuestro|nuestra|nuestros|nuestras)\s+(\w+)/gi
    );
    for (const m of possessiveMatches) {
        const entity = stripAccents(m[1].toLowerCase());
        if (entity.length >= 3) results.add(entity);
    }

    return [...results];
}

/**
 * Retorna true se a query contém indicadores de memória pessoal/familiar.
 * Usado pelo ContextBuilder para elevar o tier antes do planner.
 */
export function isPersonalMemoryQuery(query: string): boolean {
    const qn = stripAccents(query.toLowerCase());
    for (const term of PERSONAL_ENTITY_TERMS) {
        if (qn.includes(term)) return true;
    }
    // Possessivos PT-BR / EN / ES
    if (/\b(?:meu|minha|meus|minhas|my|mi|mis)\s+\w+/i.test(query)) return true;
    return false;
}

/** Fração de query-terms que batem na entrada (0..1). */
function quickRelevance(queryTerms: string[], entry: MemoryIndexEntry): number {
    if (queryTerms.length === 0) return 0;
    const haystack = `${entry.entity} ${entry.summary} ${entry.keywords.join(' ')}`.toLowerCase();
    let hits = 0;
    for (const term of queryTerms) {
        if (haystack.includes(term)) hits++;
    }
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
