/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S104
 * 
 * 1. Verifica que EmbeddingService.cosineSimilarity() rejeita (lança erro) vetores
 *    de dimensões diferentes (fail-closed).
 * 2. Verifica que a busca semântica em EmbeddingService.search() descarta de
 *    forma segura e sem quebras registros armazenados cujas dimensões de
 *    embedding difiram da query atual (modelo alterado, migração parcial).
 */

import Database from 'better-sqlite3';
import { EmbeddingService } from '../../memory/EmbeddingService';
import { MemoryManager } from '../../memory/MemoryManager';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${msg}`, detail ?? ''); failed++; }
}

async function main() {
    console.log('\n=== S104 — Guards de Dimensionalidade em Embeddings ===');

    const db = new Database(':memory:');
    
    // Inicializa a estrutura do banco via MemoryManager
    new MemoryManager(db);

    const embeddingService = new EmbeddingService(db);

    // ── Teste A: cosineSimilarity deve disparar erro se dimensões forem diferentes ──
    let similarityErrorThrown: boolean = false;
    try {
        embeddingService.cosineSimilarity([0.1, 0.2], [0.1, 0.2, 0.3]);
    } catch (err) {
        similarityErrorThrown = true;
        assert(err instanceof Error && err.message.includes('Dimension mismatch'), 'cosineSimilarity falhou de forma segura por mismatch de dimensão');
    }
    assert(similarityErrorThrown, 'Erro de mismatch de dimensão foi lançado');

    // ── Teste B: search deve descartar nós com embeddings de dimensão diferente de forma segura ──
    
    // Insere um nó de 3 dimensões no banco
    const nodeId = 'fact_1';
    db.prepare(`
        INSERT INTO memory_nodes (id, type, name, content, weight, confidence, last_updated, last_accessed)
        VALUES (?, 'fact', 'Nó de teste', 'Conteúdo de teste', 1.0, 1.0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(nodeId);

    // Insere embedding de 3 dimensões (Float64Array contendo [1, 2, 3])
    const floatArray = new Float64Array([1.0, 2.0, 3.0]);
    const blob = Buffer.from(floatArray.buffer);
    db.prepare(`
        INSERT INTO memory_embeddings (node_id, embedding, model, updated_at)
        VALUES (?, ?, 'nomic-embed-text', CURRENT_TIMESTAMP)
    `).run(nodeId, blob);

    // Mock do método embed para retornar uma query de 2 dimensões
    embeddingService.embed = async (_text: string) => {
        return [0.5, 0.5]; // 2 dimensões
    };

    // Executa a busca
    let searchSucceeded: boolean = false;
    let results: any[] = [];
    try {
        results = await embeddingService.search('Como fazer bolo?');
        searchSucceeded = true;
    } catch (err) {
        console.error('Erro na busca:', err);
    }

    assert(searchSucceeded, 'Busca concluiu sem erros mesmo com banco contendo embedding de dimensão diferente');
    assert(results.length === 0, 'O nó com embedding de dimensão diferente (3D) foi ignorado (descartado na busca 2D)', results);

    db.close();

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S104 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(err => {
    console.error('Erro no teste S104:', err);
    process.exit(1);
});
