/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S240
 * `memory_write` (action=create) gera embedding para o nó novo E o dedup por similaridade
 * (findSimilarNode) finalmente roda em produção — três bugs distintos na mesma função, mesma
 * campanha do S236, todos confirmados por evidência (audit log + banco real + git history).
 *
 * INCIDENTE REAL (15/08/2026, mesma campanha do S236): à pergunta "são 265 river! Pi tenho
 * 1,448", o GoalPlanner precisou de 8 ciclos / 2 replans / 9 tentativas para persistir a posição
 * de Pi. Na mesma janela, o goal anterior ("E minha posição atual?") teve DOIS steps de
 * memory_search bloqueados por semantic_mismatch — a busca devolveu conteúdo sobre disciplina
 * universitária e arquitetura de mensageria, nada sobre posições/portfólio.
 *
 * TRÊS CAUSAS RAIZ, todas em `src/tools/memory_write.ts`:
 *
 * 1) `create()` nunca chamava `regenerateEmbedding()` — só `update()`, `connect()` e `merge()`
 *    chamavam (confirmado desde a extração para MemoryFacade em 17/05/2026, commit bd3e7888 —
 *    não é regressão recente). Todo nó genuinamente novo nascia invisível à metade vetorial de
 *    `MemoryManager.semanticSearch()`. Auditoria do banco real: os três nós criados durante o
 *    incidente (fact_1786826002495, fact_1786826059654, fact_1786826095347) não têm NENHUMA
 *    linha em `memory_embeddings`; 27 dos 68 nós fact/context do banco (≈40%) estão na mesma
 *    situação.
 *
 * 2) `MemoryManager.keywordSearch()` filtrava com `WHERE lifecycle_state NOT IN (...)` sem
 *    tratar NULL — em SQL, `NULL NOT IN (...)` é UNKNOWN, não TRUE, então a cláusula descartava
 *    silenciosamente toda linha com `lifecycle_state` nulo. No banco real, 85 dos 86 nós têm
 *    `lifecycle_state` nulo (só 1 tem valor setado) — ou seja, `keywordSearch()` retornava vazio
 *    para praticamente qualquer busca. Único chamador: `findSimilarNode()` (dedup de create()).
 *
 * 3) `execute()` (o dispatcher público, ponto de entrada real da tool) pré-preenchia
 *    `args.id = fact_${Date.now()}` sempre que `id` vinha ausente — ANTES de chamar `create()`.
 *    Isso significa que o bloco `if (!id) { ... findSimilarNode ... }` dentro de `create()`
 *    (adicionado no commit ccdc9e9, "adicionar verificação de similaridade para evitar
 *    duplicatas", 20/05/2026) nunca via `id` vazio — ficou morto desde o dia em que foi escrito,
 *    3 meses atrás, porque o dispatcher já tinha sinônimo do mesmo preenchimento desde a versão
 *    original da tool (23/04/2026) e ninguém removeu o mais antigo ao introduzir o mais novo.
 *
 * Consequência composta: sem embedding (1) e sem o fallback lexical funcionando por NULL (2), o
 * LLM não conseguia localizar o fato existente por significado; e mesmo que conseguisse, o
 * mecanismo de dedup que deveria evitar duplicata nunca executava de qualquer forma (3). 6 nós
 * distintos no banco real descrevem a mesma posição em PI Network — é essa fragmentação que
 * produziu a "discrepância" que o agente reportou ao usuário (dois registros diferentes: 13
 * tokens vs. 1.448 moedas).
 *
 * CORREÇÃO:
 * 1) create() chama regenerateEmbedding() nos três caminhos de saída (nó via findSimilarNode,
 *    nó com id colidente, nó genuinamente novo) — mesmo padrão já usado por
 *    update()/connect()/merge().
 * 2) keywordSearch() passa a tratar `lifecycle_state IS NULL` como não-descartado, mesmo padrão
 *    já usado corretamente em CognitiveMemoryIndex.ts:89 e MultiLayerRetriever.ts:83,138.
 * 3) execute() não pré-preenche mais `args.id`/`args.name`/`args.type` — create() já reimplementa
 *    esse preenchimento (e o faz melhor, passando por findSimilarNode primeiro).
 *
 * Execução: npx ts-node src/__tests__/regression/S240_MemoryWrite_CreateGeneratesEmbedding.test.ts
 */

import Database from 'better-sqlite3';
import { MemoryManager } from '../../memory/MemoryManager';
import { MemoryWriteTool } from '../../tools/memory_write';
import { EmbeddingService } from '../../memory/EmbeddingService';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function main() {

const originalFetch = global.fetch;
let embeddingCalls = 0;

// Mock do endpoint /api/embeddings do Ollama — devolve um vetor determinístico, sem depender
// de um servidor real rodando (mesmo espírito do S24: fail-open real, sucesso controlável).
(global as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    if (String(url).includes('/api/embeddings')) {
        embeddingCalls++;
        return {
            ok: true,
            json: async () => ({ embedding: [0.1, 0.2, 0.3, 0.4] }),
        } as Response;
    }
    throw new Error(`fetch não mockado para: ${url}`);
}) as typeof fetch;

try {

console.log('\n=== S240-1 — create() de um nó genuinamente novo gera embedding ===');
{
    const db = new (Database as any)(':memory:');
    new EmbeddingService(db);
    const mm = new MemoryManager(db, 'http://mock-ollama:11434');
    const tool = new MemoryWriteTool(mm);
    embeddingCalls = 0;

    const result = await tool.execute({
        action: 'create',
        id: 'fact_test_river_position',
        type: 'fact',
        name: 'Posição RIVER',
        content: 'Posição RIVER — 100 tokens, preço médio US$ 5,00',
    });

    assert(result.success === true, 'create() retornou sucesso');
    assert(embeddingCalls === 1, 'exatamente 1 chamada ao endpoint de embedding foi feita', embeddingCalls);

    const row = db.prepare('SELECT node_id FROM memory_embeddings WHERE node_id = ?').get('fact_test_river_position');
    assert(!!row, 'o nó novo tem uma linha em memory_embeddings (era o gap: create() nunca gerava)', row);

    db.close();
}

console.log('\n=== S240-2 — create() que atualiza nó com id colidente também regenera embedding ===');
{
    const db = new (Database as any)(':memory:');
    new EmbeddingService(db);
    const mm = new MemoryManager(db, 'http://mock-ollama:11434');
    const tool = new MemoryWriteTool(mm);

    await tool.execute({ action: 'create', id: 'fact_dup', type: 'fact', name: 'A', content: 'Conteúdo original' });
    embeddingCalls = 0;

    const result = await tool.execute({ action: 'create', id: 'fact_dup', type: 'fact', name: 'A', content: 'Conteúdo atualizado' });

    assert(result.success === true, 'create() sobre id existente retornou sucesso');
    assert(embeddingCalls === 1, 'embedding foi regenerado ao colidir com id existente', embeddingCalls);

    db.close();
}

console.log('\n=== S240-3 — create() via dedup por conteúdo similar (findSimilarNode) regenera embedding ===');
{
    const db = new (Database as any)(':memory:');
    new EmbeddingService(db);
    const mm = new MemoryManager(db, 'http://mock-ollama:11434');
    const tool = new MemoryWriteTool(mm);

    await tool.execute({
        action: 'create', type: 'fact', name: 'Posição Pi',
        content: 'Posição Pi Network corrigida quantidade tokens preço atual valor posição atualizado',
    });
    embeddingCalls = 0;

    // Conteúdo com ≥3 palavras-chave em comum (>=5 chars), mesmo tipo, tamanho comparável —
    // dispara o caminho de dedup em vez de criar um segundo nó.
    const result = await tool.execute({
        action: 'create', type: 'fact', name: 'Posição Pi',
        content: 'Posição Pi Network corrigida quantidade tokens preço atual valor posição hoje',
    });

    assert(result.output.includes('duplicata evitada'), 'o caminho de dedup por similaridade foi de fato exercitado', result.output);
    assert(embeddingCalls === 1, 'embedding foi regenerado após o merge de conteúdo similar', embeddingCalls);

    db.close();
}

console.log('\n=== S240-4 — paridade: create() agora se comporta como update()/connect()/merge() quanto a embedding ===');
{
    const SOURCE = require('fs').readFileSync(
        require('path').join(process.cwd(), 'src', 'tools', 'memory_write.ts'), 'utf-8'
    ) as string;
    const createBody = SOURCE.slice(SOURCE.indexOf('private async create('), SOURCE.indexOf('// ── SIMILARITY CHECK'));
    const regenCount = (createBody.match(/await this\.regenerateEmbedding\(/g) || []).length;
    assert(regenCount === 3, 'create() chama regenerateEmbedding() nos 3 caminhos de saída com conteúdo novo/alterado', regenCount);
}

console.log('\n=== S240-5 — execute() não pré-preenche mais args.id antes do dispatch (dedup deixou de ser código morto) ===');
{
    const SOURCE = require('fs').readFileSync(
        require('path').join(process.cwd(), 'src', 'tools', 'memory_write.ts'), 'utf-8'
    ) as string;
    const executeBody = SOURCE.slice(SOURCE.indexOf('async execute('), SOURCE.indexOf('// ── CREATE'));
    assert(
        !/if \(!args\.id && args\.content\) \{/.test(executeBody),
        'execute() não sintetiza mais args.id antes de despachar para create() (bloco removido)',
        executeBody,
    );
}

console.log('\n=== S240-6 — MemoryManager.keywordSearch() trata lifecycle_state NULL como não-descartado ===');
{
    const SOURCE = require('fs').readFileSync(
        require('path').join(process.cwd(), 'src', 'memory', 'MemoryManager.ts'), 'utf-8'
    ) as string;
    const fnBody = SOURCE.slice(SOURCE.indexOf('keywordSearch(terms: string[]'), SOURCE.indexOf('// ── Semantic Search'));
    assert(
        /lifecycle_state IS NULL OR lifecycle_state NOT IN/.test(fnBody),
        'keywordSearch() usa "lifecycle_state IS NULL OR ... NOT IN" (NULL NOT IN é UNKNOWN em SQL, não TRUE — sem o OR, praticamente todo nó real era descartado)',
        fnBody,
    );
}

} finally {
    (global as unknown as { fetch: typeof fetch }).fetch = originalFetch;
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S240 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exit(1);
process.exit(0);

}

main().catch(err => {
    console.error('Erro no teste S240:', err);
    process.exit(1);
});
