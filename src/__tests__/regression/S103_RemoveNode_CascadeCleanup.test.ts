/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S103
 * 
 * Verifica que ao remover um nó via MemoryFacade.removeNode(), as tabelas
 * associadas (memory_edges, memory_embeddings, node_metrics e memory_nodes)
 * limpam em cascata os dados correspondentes sem deixar lixo no banco.
 */

import Database from 'better-sqlite3';
import { MemoryManager } from '../../memory/MemoryManager';
import { EmbeddingService } from '../../memory/EmbeddingService';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${msg}`, detail ?? ''); failed++; }
}

async function main() {
    console.log('\n=== S103 — Deleção em Cascata no MemoryFacade ===');

    const db = new Database(':memory:');
    const memoryManager = new MemoryManager(db);
    const facade = memoryManager.getFacade();
    new EmbeddingService(db);

    const nodeId = 'user_preference_s103';

    // Cria o nó
    facade.addNode({
        id: nodeId,
        type: 'preference',
        name: 'Gosto de pizza',
        content: 'Pizza de calabresa sem cebola',
        weight: 1.0,
        confidence: 0.9,
        domain: 'food',
        last_updated: new Date().toISOString(),
        last_accessed: new Date().toISOString()
    } as any);

    // Cria o nó destino para satisfazer foreign key
    facade.addNode({
        id: 'pizza',
        type: 'fact',
        name: 'pizza',
        content: 'pizza'
    } as any);

    // Insere dados relacionados
    // 1. Edges
    db.prepare(`
        INSERT INTO memory_edges (from_node, to_node, relation, weight)
        VALUES (?, ?, 'likes', 1.0)
    `).run(nodeId, 'pizza');

    // 2. Embeddings
    facade.upsertEmbedding(nodeId, Buffer.alloc(16), 'nomic-embed-text');

    // 3. Metrics
    db.prepare(`
        INSERT OR REPLACE INTO node_metrics (node_id, usage_count, reinforcement_score)
        VALUES (?, 5, 0.9)
    `).run(nodeId);

    // Verifica que as tabelas possuem os registros antes de deletar
    const initialNode = db.prepare('SELECT * FROM memory_nodes WHERE id = ?').get(nodeId);
    const initialEdge = db.prepare('SELECT * FROM memory_edges WHERE from_node = ?').get(nodeId);
    const initialEmb = db.prepare('SELECT * FROM memory_embeddings WHERE node_id = ?').get(nodeId);
    const initialMet = db.prepare('SELECT * FROM node_metrics WHERE node_id = ?').get(nodeId);

    assert(initialNode !== undefined, 'Nó inserido com sucesso');
    assert(initialEdge !== undefined, 'Edge inserido com sucesso');
    assert(initialEmb !== undefined, 'Embedding inserido com sucesso');
    assert(initialMet !== undefined, 'Metric inserido com sucesso');

    // Executa a remoção
    facade.removeNode(nodeId);

    // Verifica que tudo foi limpo em cascata
    const finalNode = db.prepare('SELECT * FROM memory_nodes WHERE id = ?').get(nodeId);
    const finalEdge = db.prepare('SELECT * FROM memory_edges WHERE from_node = ? OR to_node = ?').get(nodeId, nodeId);
    const finalEmb = db.prepare('SELECT * FROM memory_embeddings WHERE node_id = ?').get(nodeId);
    const finalMet = db.prepare('SELECT * FROM node_metrics WHERE node_id = ?').get(nodeId);

    assert(finalNode === undefined, 'O nó foi deletado de memory_nodes');
    assert(finalEdge === undefined, 'As edges foram deletadas de memory_edges');
    assert(finalEmb === undefined, 'Os embeddings foram deletados de memory_embeddings');
    assert(finalMet === undefined, 'As métricas foram deletadas de node_metrics');

    db.close();

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S103 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(err => {
    console.error('Erro no teste S103:', err);
    process.exit(1);
});
