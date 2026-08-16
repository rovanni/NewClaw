/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S236
 * Busca de memória (tool `memory_search` do agente e `GET /api/memory/search` do dashboard)
 * combina busca lexical (nome+conteúdo) com busca por embedding — nunca usa uma como fallback
 * condicional da outra.
 *
 * INCIDENTE REAL (15/08/2026): à pergunta "e minha posição no river atual?", o step
 * `memory_search` devolveu nós irrelevantes (`agent_state`, disciplinas de computação) — o nó
 * com "RIVER" literalmente no nome (ex: fact_1776994400316, "Posição RIVER — 100 tokens...")
 * nunca apareceu. Confirmado ao consultar o nó diretamente por ID (funcionou, o dado existia).
 * O usuário também reportou o mesmo no Dashboard (`/memory`, `/memory-graph`): buscar "river" não
 * encontrava, mesmo o termo estando no título e no conteúdo do nó.
 *
 * CAUSA RAIZ: `MemoryManager.semanticSearch()` só rodava a busca textual
 * (`searchNodes` — FTS5/LIKE sobre `name, content, type`, que JÁ cobre título e conteúdo
 * corretamente) quando a busca por embedding trazia MENOS que `limit` resultados
 * (`if (results.length < limit)`). Como o embedding não tem piso de qualidade além do cutoff
 * fixo (score ≥0.3), ruído semântico irrelevante costuma preencher a cota inteira sozinho — a
 * busca textual nunca chegava a rodar, e um match EXATO no nome ficava invisível. Mesmo padrão
 * na rota do dashboard (`GET /api/memory/search`): só buscava por embedding, e só caía pra
 * texto quando a busca por embedding devolvia ZERO resultados (o que quase nunca acontece,
 * porque `EmbeddingService.search()` não tem piso de similaridade nenhum).
 *
 * CORREÇÃO: as duas buscas (lexical + embedding) sempre rodam; os resultados são combinados por
 * id (maior score vence em caso de nó encontrado pelos dois) e ordenados — nunca uma é gate da
 * outra.
 *
 * Execução: npx ts-node src/__tests__/regression/S236_MemorySearch_LexicalNeverGatedByEmbedding.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { MemoryManager } from '../../memory/MemoryManager';
import { EmbeddingService } from '../../memory/EmbeddingService';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function main() {

console.log('\n=== S236-1 — reprodução do incidente: nó "RIVER" no nome, sem embedding, cota preenchida por ruído ===');
{
    const db = new Database(':memory:');
    new MemoryManager(db); // inicializa schema de memory_nodes/memory_nodes_fts
    new EmbeddingService(db); // inicializa schema de memory_embeddings (tabela própria — S104)

    // 5 nós de "ruído semântico": embedding com similaridade só um pouco acima do cutoff (0.3,
    // entre 0.31 e 0.35 — abaixo do score fixo 0.4 de match textual), sem qualquer relação com
    // River — o mesmo formato do incidente real (agent_state, disciplinas de computação, etc.).
    // Query mockada como vetor unitário [1,0,0,0]; cada vetor de ruído é unitário com
    // dot-product == cos_sim exatamente (0.31, 0.32, 0.33, 0.34, 0.35), calculado via
    // [cos_sim, sqrt(1 - cos_sim²), 0, 0] para garantir |vetor| = 1.
    for (let i = 0; i < 5; i++) {
        const id = `fact_noise_${i}`;
        db.prepare(`
            INSERT INTO memory_nodes (id, type, name, content, weight, confidence, last_updated, last_accessed)
            VALUES (?, 'fact', ?, ?, 1.0, 1.0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `).run(id, `Ruído ${i}`, `Conteúdo sem relação com criptomoedas, item ${i}`);
        const cosSim = 0.31 + i * 0.01;
        const vec = new Float64Array([cosSim, Math.sqrt(1 - cosSim * cosSim), 0, 0]);
        db.prepare(`INSERT INTO memory_embeddings (node_id, embedding, model, updated_at) VALUES (?, ?, 'test', CURRENT_TIMESTAMP)`)
            .run(id, Buffer.from(vec.buffer));
    }

    // O nó real: "RIVER" no NOME, sem embedding nenhum (simula o node real do incidente — a
    // busca só pode achá-lo por texto).
    db.prepare(`
        INSERT INTO memory_nodes (id, type, name, content, weight, confidence, last_updated, last_accessed)
        VALUES (?, 'fact', ?, ?, 1.0, 1.0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run('fact_river_position', 'Posição RIVER — 100 tokens', 'Preço médio de compra US$ 5,00, investimento total US$ 500,00');
    // Reconstroi o índice FTS5 (o trigger de INSERT normalmente cobre isso; explícito aqui pra
    // não depender de ordem de trigger em ambiente de teste).
    db.exec(`INSERT INTO memory_nodes_fts(memory_nodes_fts) VALUES('rebuild')`);

    const memoryManager = new MemoryManager(db);
    // Simula um embedding que não entende "river" como criptomoeda: os 5 nós de ruído têm
    // similaridade 0.31-0.35 com a query — acima do cutoff de 0.3, mas abaixo do score fixo
    // (0.4) do match textual do nó real, que não tem embedding nenhum.
    (memoryManager as unknown as { generateEmbedding: (q: string) => Promise<number[] | null> }).generateEmbedding =
        async () => [1, 0, 0, 0];

    const results = await memoryManager.semanticSearch('posição no river atual', 5);

    assert(results.length > 0, 'a busca devolveu algum resultado');
    // 5 nós de ruído (score 0.31-0.35) + 1 nó real (score 0.4) = 6 candidatos, cortados no
    // limit=5 — o de MENOR score (fact_noise_0, 0.31) é o que fica de fora, não o nó real.
    assert(
        results.length === 5 && results[0].id === 'fact_river_position',
        'o nó "Posição RIVER" (match textual, score 0.4) fica em 1º lugar, à frente dos nós de ruído (score 0.31-0.35)',
        results.map(r => `${r.id}:${r.score}`),
    );
    assert(
        results.some(r => r.id === 'fact_river_position'),
        'o nó "Posição RIVER" (match exato no nome, sem embedding) aparece nos resultados — não fica invisível atrás do ruído semântico',
        results.map(r => r.id),
    );
    assert(
        !results.some(r => r.id === 'fact_noise_0'),
        'o nó de ruído com MENOR score (0.31) é o que fica de fora do limit — não o nó real',
    );

    db.close();
}

console.log('\n=== S236-2 — busca textual continua rodando mesmo quando embedding já preenche a cota (fix estrutural) ===');
{
    const SOURCE = fs.readFileSync(path.join(process.cwd(), 'src', 'memory', 'MemoryManager.ts'), 'utf-8');
    const fnBody = SOURCE.slice(
        SOURCE.indexOf('async semanticSearch(query: string, limit: number = 5)'),
        SOURCE.indexOf('async semanticSearchWithAttention('),
    );
    assert(
        !/if \(results\.length < limit\) \{\s*\n\s*for \(const node of this\.searchNodes/.test(fnBody),
        'a busca textual NÃO está mais condicionada a "faltam resultados de embedding" (gate antigo removido)',
    );
    assert(
        /for \(const node of this\.searchNodes\(query, limit\)\) \{/.test(fnBody) && !/if \(results\.length < limit\)/.test(fnBody),
        'a busca textual roda incondicionalmente após a busca por embedding',
    );
    assert(
        /results\.sort\(\(a, b\) => b\.score - a\.score\);\s*\n\s*return results\.slice\(0, limit\);/.test(fnBody),
        'os resultados combinados são ordenados por score e só então cortados no limit — não o contrário',
    );
}

console.log('\n=== S236-3 — rota do dashboard (GET /api/memory/search) combina, não usa fallback condicional ===');
{
    const SOURCE = fs.readFileSync(path.join(process.cwd(), 'src', 'dashboard', 'routes', 'memory.ts'), 'utf-8');
    assert(
        !/if \(results\.length > 0\) \{[\s\S]{0,200}return res\.json\(\{ success: true, nodes: nodesWithScore, method: 'embedding' \}\);/.test(SOURCE),
        'a rota não retorna mais cedo só com resultados de embedding (early-return removido)',
    );
    assert(
        /for \(const n of dashboardRepo\.searchNodes\(q\)\) \{/.test(SOURCE),
        'a busca lexical (searchNodes sem ids — nome+conteúdo) roda incondicionalmente',
    );
    assert(
        /merged\.set\(n\.id, \{ id: n\.id, type: n\.type, name: n\.name, content: n\.content, updated_at: n\.updated_at, score: Math\.max\(existing\?\.score \?\? 0, embScore\) \}\);/.test(SOURCE),
        'resultados de embedding se combinam com os lexicais por id (maior score vence), não substituem',
    );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S236 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exit(1);
process.exit(0);

}

main().catch(err => {
    console.error('Erro no teste S236:', err);
    process.exit(1);
});
