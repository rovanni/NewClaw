/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — P1.2
 * Context contamination: nós com qRel=0 selecionados, nós com score>0 ignorados
 *
 * HIPÓTESE:
 *   ContextPlanner preenche o budget com tier0 (identity) + tier1 (permanentes com imp>=0.8)
 *   O budget competitivo fica zero ou muito pequeno
 *   Nós tier2-4 com qRel > 0 (genuinamente relevantes) ficam de fora
 *   Resultado: contaminationRatio=0.83, rankingInverted=true
 *
 * EVIDÊNCIA DO LOG (8 ocorrências):
 *   [CONTEXT-QUALITY] contaminated=5 contaminationRatio=0.83
 *                     bestSkipped=0.237 worstSelected=0.000 rankingInverted=true
 *   Nós com score=0.000 selecionados, nó com score=0.237 excluído
 *
 * CAUSA RAIZ:
 *   Tier1 gate: (rel > 0 || (!isBehavioralPref && importance >= 0.8))
 *   Nós com importance >= 0.8 mas qRel=0 entram → contaminam o budget
 *   Tier4 competitive fill: requires qRel > 0 MAS budget já esgotado
 *
 * ESTADO ATUAL: testes DEVEM FALHAR — demonstram o bug
 * ESTADO PÓS-FIX: devem passar
 *
 * Execução: npx ts-node src/__tests__/regression/P1_2_ContextContamination_RankingInversion.test.ts
 */

import { ContextPlanner } from '../../loop/ContextBuilder';
import type { MemoryIndexEntry } from '../../memory/CognitiveMemoryIndex';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) {
        console.log(`  ✅ ${message}`);
        passed++;
    } else {
        console.error(`  ❌ FALHOU: ${message}`);
        failed++;
    }
}

function assertFails(condition: boolean, message: string): void {
    if (!condition) {
        console.log(`  🔴 BUG CONFIRMADO (esperado falhar): ${message}`);
        failed++;
    } else {
        console.log(`  ✅ BUG CORRIGIDO: ${message}`);
        passed++;
    }
}

// ── MemoryTier enum (replicado para o teste) ───────────────────────────────────
const MemoryTier = {
    CORE_IDENTITY: 0,
    PERMANENT: 1,
    ACTIVE_ENTITIES: 2,
    EPISODIC: 3,
    KNOWLEDGE_POOL: 4,
};

// ── Construir entradas que replicam o cenário do log ─────────────────────────

function makeEntry(
    nodeId: string,
    entity: string,
    type: string,
    tier: number,
    importance: number,
    permanence: number,
    summary = '',
    keywords: string[] = [],
): MemoryIndexEntry {
    return {
        nodeId,
        entity,
        type,
        tier,
        importance,
        permanence,
        summary: summary || entity,
        keywords,
        updatedAt: Date.now(),
        nodeHash: nodeId.slice(0, 8),
    };
}

// Cenário que reproduz o log (query = "criar slides sobre modelo incremental"):
// - 2 identity nodes (tier0) → sempre selecionados
// - 4 non-behavioral preference nodes com importance >= 0.8, qRel = 0 (irrelevantes)
// - 2 competitive nodes tier3 com qRel > 0 (genuinamente relevantes)

const QUERY = 'criar slides sobre modelo incremental engenharia software';

const IDENTITY_NODES: MemoryIndexEntry[] = [
    makeEntry('core_agent',   'agent',  'identity', MemoryTier.CORE_IDENTITY, 0.95, 1.0, 'agente newclaw'),
    makeEntry('core_user',    'user',   'identity', MemoryTier.CORE_IDENTITY, 0.95, 1.0, 'usuário'),
];

// Nós tier1 irrelevantes mas com alta importância (simulam o comportamento visto no log)
const PERMANENT_IRRELEVANT: MemoryIndexEntry[] = [
    makeEntry('fact_clima',   'clima',   'context',    MemoryTier.PERMANENT, 0.85, 0.9, 'preferência de clima', ['cidade']),
    makeEntry('fact_voice',   'voz',     'preference', MemoryTier.PERMANENT, 0.82, 0.9, 'preferência de voz'),
    makeEntry('fact_user_id', 'luciano', 'identity',   MemoryTier.PERMANENT, 0.84, 0.9, 'identidade do usuário'),
    makeEntry('fact_proj',    'projeto', 'context',    MemoryTier.PERMANENT, 0.80, 0.9, 'projetos em andamento', ['river']),
];

// Nós tier3 RELEVANTES para a query (têm tokens da query)
const RELEVANT_COMPETITIVE: MemoryIndexEntry[] = [
    makeEntry('fact_slides',  'slides',  'fact', MemoryTier.EPISODIC, 0.45, 0.25,
        'slides gerados sobre modelo incremental', ['slides', 'incremental', 'modelo']),
    makeEntry('fact_engenharia', 'engenharia', 'fact', MemoryTier.EPISODIC, 0.40, 0.25,
        'disciplina de engenharia de software', ['engenharia', 'software', 'aula']),
];

const ALL_ENTRIES = [...IDENTITY_NODES, ...PERMANENT_IRRELEVANT, ...RELEVANT_COMPETITIVE];

// ── Executar o ContextPlanner ─────────────────────────────────────────────────

console.log('\n=== P1.2 — Reproduzir cenário de contaminação com budget=8 ===');

// Budget 8 = 2 identity + 3 preference + 3 competitive (DEFAULT_TIER_BUDGETS)
const planner = new ContextPlanner();
const result = planner.plan(QUERY, ALL_ENTRIES, 8);

const selectedIds = new Set(result.selectedNodeIds ?? []);
console.log(`  → Nós selecionados (${selectedIds.size}): ${[...selectedIds].join(', ')}`);
console.log(`  → Nós relevantes selecionados: ${RELEVANT_COMPETITIVE.filter(e => selectedIds.has(e.nodeId)).map(e => e.nodeId).join(', ') || '(nenhum)'}`);
console.log(`  → Nós irrelevantes selecionados: ${PERMANENT_IRRELEVANT.filter(e => selectedIds.has(e.nodeId)).map(e => e.nodeId).join(', ')}`);

// Verificar que os nós genuinamente relevantes foram selecionados
const relevantSelected = RELEVANT_COMPETITIVE.filter(e => selectedIds.has(e.nodeId)).length;
const irrelevantSelected = PERMANENT_IRRELEVANT.filter(e => selectedIds.has(e.nodeId)).length;

assertFails(
    relevantSelected === RELEVANT_COMPETITIVE.length,
    `Nós RELEVANTES (slides, engenharia) devem ser selecionados — ${relevantSelected}/${RELEVANT_COMPETITIVE.length} selecionados`
);

assert(
    irrelevantSelected > 0,
    `Nós IRRELEVANTES (clima, voz, projeto) foram selecionados (confirma contaminação): ${irrelevantSelected} nós`
);

// ── Teste 2: Verificar se a lógica importance>=0.8 está bloqueando nós relevantes ──

console.log('\n=== P1.2 — Identificar nós tier1 que consomem budget com qRel=0 ===');

// Os nós "clima" e "proj" têm importance >= 0.8 mas não têm tokens da query
// Eles são type='context', não 'preference' → passam pelo gate importance>=0.8
const climaNode = PERMANENT_IRRELEVANT.find(e => e.nodeId === 'fact_clima');
const projNode = PERMANENT_IRRELEVANT.find(e => e.nodeId === 'fact_proj');

const queryTokens = QUERY.toLowerCase().split(/\W+/).filter(t => t.length > 2);
const climaRelevance = climaNode ? (queryTokens.filter(t =>
    (climaNode.entity + ' ' + climaNode.summary + ' ' + climaNode.keywords.join(' ')).toLowerCase().includes(t)
).length / queryTokens.length) : 0;

console.log(`  → fact_clima: importance=${climaNode?.importance}, qRel≈${climaRelevance.toFixed(3)}`);
console.log(`  → fact_proj: importance=${projNode?.importance}, qRel≈0.000 (tokens não coincidem com a query)`);
console.log(`  → Budget tier1: nós com importance >= 0.8 entram mesmo sem relevância`);

assert(
    (climaNode?.importance ?? 0) >= 0.8 && climaRelevance < 0.05,
    `fact_clima: importance=${climaNode?.importance} >= 0.8 MAS qRel≈${climaRelevance.toFixed(3)} < 0.05 → CONTAMINADOR`
);

// ── Teste 3: Simular budget esgotado e verificar rankingInverted ──────────────

console.log('\n=== P1.2 — Budget esgotado → rankingInverted ===');

// Com budget=5 (mais restrito), tier0 + tier1 preenchem tudo
const plannerTight = new ContextPlanner({ identity: 2, preference: 3, entity: 0, competitive: 0 });
const resultTight = plannerTight.plan(QUERY, ALL_ENTRIES, 5);

const selectedTightIds = new Set(resultTight.selectedNodeIds ?? []);
const relevantInTight = RELEVANT_COMPETITIVE.filter(e => selectedTightIds.has(e.nodeId)).length;

console.log(`  → Com budget=5: ${selectedTightIds.size} selecionados, ${relevantInTight} relevantes incluídos`);

assertFails(
    relevantInTight > 0,
    `Budget apertado: nós relevantes devem ser priorizados sobre irrelevantes — ${relevantInTight} relevantes selecionados`
);

// ── Teste 4: Verificar que ContextBuilder não ignora rankingInverted ──────────

console.log('\n=== P1.2 — ContextBuilder registra rankingInverted mas não age sobre ele ===');

const contextBuilderPath = require('path').join(process.cwd(), 'src', 'loop', 'ContextBuilder.ts');
const contextBuilderSource = require('fs').readFileSync(contextBuilderPath, 'utf-8');

const logsRankingInverted = contextBuilderSource.includes('rankingInverted');
const actsOnRankingInverted = /if.*rankingInverted|rankingInverted.*reselect|rankingInverted.*fix/i.test(contextBuilderSource);

assert(logsRankingInverted, 'ContextBuilder DETECTA rankingInverted (loga o problema)');

assertFails(
    actsOnRankingInverted,
    `ContextBuilder deve AGIR quando rankingInverted=true (re-selecionar nós relevantes) — apenas loga, não age`
);

// ── RELATÓRIO ─────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`P1.2 RESULTADO:`);
console.log(`  ✅ Passou: ${passed}`);
console.log(`  🔴 Bugs confirmados: ${failed}`);
console.log(`\nDIAGNÓSTICO:`);
console.log(`  Tier1 gate: (rel>0 || (!isBehavioralPref && importance>=0.8))`);
console.log(`  Nós não-preferência (type='context','fact') com importance>=0.8 entram com qRel=0`);
console.log(`  Competitivos (tier3-4) com qRel>0.2 ficam fora quando budget exausto`);
console.log(`  Sistema detecta (rankingInverted=true) mas não faz nada`);
console.log(`\nFIX:`);
console.log(`  Opção A: Quando rankingInverted=true, trocar o pior selected pelo best skipped`);
console.log(`  Opção B: Reduzir preference budget para dar mais espaço ao competitive fill`);
console.log(`  Opção C: Remover importance>=0.8 gate para nós tipo 'context' com qRel=0`);
