/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S239
 * A tela de Revisão da Memória (`/memory-review`) passa a listar nós de baixa confiança
 * ("decaídos"), com botão de exclusão manual pelo usuário — parte da mesma campanha do S238.
 *
 * CONTEXTO (relato do operador, 15/08/2026): "tem alguma página do sistema para analisar os nós
 * da memória que decairam muito, porque acho que somente o usuário poderia apagar esses nós!".
 *
 * Antes de criar qualquer página nova (Gate "Extensão antes de Criação", CLAUDE.md), foi
 * verificado que `/memory-review` já existe, já é linkada na navegação (`memory-graph.html`,
 * `help.html`), e já resolve estruturalmente o mesmo problema para outras dimensões (nós órfãos,
 * nós com conteúdo esparso, duplicatas) — com cartão de estatística, lista de issues com botão
 * "Deletar" e link "Ver no grafo". Faltava só a dimensão de CONFIANÇA/decaimento, que
 * `MemoryGovernor` já rastreia mas nunca era exposta em nenhuma tela. Este teste cobre a
 * extensão, não uma tela nova.
 *
 * CORREÇÃO: `computeMemoryReview()` (dashboard/routes/memory.ts) ganha uma categoria `decayed`,
 * usando o MESMO limiar que `MemoryGovernor.DEFAULT_CONFIG.minConfidence` já usa para arquivar
 * (0.3) — não um número novo. `getReviewData()` passa a selecionar `confidence`. A UI
 * (`memory-review.html`) ganha um cartão de estatística e reaproveita o card/botão de exclusão já
 * existente para `orphan`, agora também para `decayed`.
 *
 * Execução: npx ts-node src/__tests__/regression/S239_MemoryReview_DecayedNodesSurfaced.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { computeMemoryReview } from '../../dashboard/routes/memory';
import type { DashboardNode, DashboardEdge } from '../../dashboard/routes/types';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

function node(id: string, confidence: number | undefined, extra: Partial<DashboardNode> = {}): DashboardNode {
    return { id, type: 'fact', name: id, content: 'conteúdo suficientemente longo para não ser sparse aqui', confidence, ...extra } as DashboardNode;
}

console.log('\n=== S239-1 — nó com confiança abaixo de 0.3 é listado como "decayed" ===');
{
    const nodes: DashboardNode[] = [
        node('fact_low', 0.15),
        node('fact_ok', 0.8),
    ];
    // Conecta ambos para não serem classificados como orphan (isolando a dimensão testada).
    const edges: DashboardEdge[] = [
        { from_node: 'fact_low', to_node: 'fact_ok', relation: 'related_to', weight: 1 },
    ];

    const review = computeMemoryReview(nodes, edges);

    assert(review.decayedNodes.some(n => n.id === 'fact_low'), 'nó com confiança 0.15 aparece em decayedNodes', review.decayedNodes);
    assert(!review.decayedNodes.some(n => n.id === 'fact_ok'), 'nó com confiança 0.8 NÃO aparece em decayedNodes');
    assert(review.summary.decayedCount === 1, 'contagem no summary bate', review.summary.decayedCount);
    assert(
        review.issues.some(i => i.kind === 'decayed' && i.nodeId === 'fact_low'),
        'issue "decayed" aparece na lista consolidada de issues',
        review.issues,
    );
}

console.log('\n=== S239-2 — limiar é exatamente o mesmo do MemoryGovernor (0.3), não um número novo ===');
{
    const nodes: DashboardNode[] = [
        node('fact_exactly_at_threshold', 0.3),
        node('fact_just_below', 0.29),
    ];
    const edges: DashboardEdge[] = [{ from_node: 'fact_exactly_at_threshold', to_node: 'fact_just_below', relation: 'related_to', weight: 1 }];

    const review = computeMemoryReview(nodes, edges);

    assert(!review.decayedNodes.some(n => n.id === 'fact_exactly_at_threshold'), 'confiança == 0.3 NÃO conta como decayed (mesma semântica de < do MemoryGovernor.garbageCollect)');
    assert(review.decayedNodes.some(n => n.id === 'fact_just_below'), 'confiança 0.29 conta como decayed');
}

console.log('\n=== S239-3 — nó sem confidence (undefined) não quebra nem é listado ===');
{
    const nodes: DashboardNode[] = [node('fact_no_confidence', undefined)];
    const edges: DashboardEdge[] = [];

    let threw = false;
    let review: ReturnType<typeof computeMemoryReview> | undefined;
    try {
        review = computeMemoryReview(nodes, edges);
    } catch {
        threw = true;
    }

    assert(!threw, 'computeMemoryReview não lança quando confidence está ausente');
    assert(!!review && !review.decayedNodes.some(n => n.id === 'fact_no_confidence'), 'nó sem confidence não é tratado como decayed (evita falso positivo)');
}

console.log('\n=== S239-4 — nós de sistema continuam excluídos da revisão, também para "decayed" ===');
{
    const nodes: DashboardNode[] = [
        node('core_identity', 0.05),
        node('domain_infra', 0.05),
    ];
    const review = computeMemoryReview(nodes, []);

    assert(review.decayedNodes.length === 0, 'nós de sistema (core_/domain_) nunca aparecem em decayedNodes, mesmo com confiança baixíssima', review.decayedNodes);
}

console.log('\n=== S239-5 — qualityScore penaliza acúmulo de nós decaídos ===');
{
    const healthyNodes: DashboardNode[] = Array.from({ length: 10 }, (_, i) => node(`fact_${i}`, 0.9));
    const edges: DashboardEdge[] = healthyNodes.slice(1).map((n, i) => ({ from_node: healthyNodes[i].id, to_node: n.id, relation: 'related_to', weight: 1 }));
    const healthyReview = computeMemoryReview(healthyNodes, edges);

    const decayedNodes: DashboardNode[] = healthyNodes.map(n => ({ ...n, confidence: 0.1 }));
    const decayedReview = computeMemoryReview(decayedNodes, edges);

    assert(
        decayedReview.summary.qualityScore < healthyReview.summary.qualityScore,
        'score de qualidade cai quando muitos nós estão decaídos',
        { healthy: healthyReview.summary.qualityScore, decayed: decayedReview.summary.qualityScore },
    );
}

console.log('\n=== S239-6 — getReviewData() do dashboard seleciona confidence (estrutural) ===');
{
    const SRC = fs.readFileSync(path.join(process.cwd(), 'src', 'dashboard', 'DashboardMemoryRepository.ts'), 'utf-8');
    assert(
        /SELECT id, type, name, content, updated_at, confidence FROM memory_nodes/.test(SRC),
        'getReviewData() inclui confidence na query — sem isso, computeMemoryReview nunca teria o dado',
    );
}

console.log('\n=== S239-7 — UI reaproveita o card de exclusão já existente (Extensão antes de Criação) ===');
{
    const SRC = fs.readFileSync(path.join(process.cwd(), 'src', 'dashboard', 'public', 'memory-review.html'), 'utf-8');
    assert(/pill-decayed/.test(SRC), 'pill "decayed" foi adicionada ao CSS existente, não uma página nova');
    assert(
        /issue\.kind === 'orphan' \|\| issue\.kind === 'decayed'/.test(SRC),
        'botão Deletar (já existente para orphan) foi estendido para decayed, reaproveitando deleteOrphan()',
    );
    assert(
        !/function deleteDecayed/.test(SRC),
        'nenhuma função de exclusão nova foi criada — deleteOrphan() já genérico foi reaproveitado',
    );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S239 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exit(1);
process.exit(0);
