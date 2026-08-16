/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S243
 * O modelo de embedding usado em toda chamada ao Ollama vem de UMA fonte
 * (`EmbeddingService.DEFAULT_EMBED_MODEL`), não de 5 strings literais divergentes.
 *
 * INCIDENTE REAL (16/08/2026, instância local de produção): `memory_write.ts`, `memory_admin.ts` e
 * `MemoryManager.ts` chamavam Ollama com `model: 'nomic-embed-text:latest'`; `EmbeddingService.ts`
 * e `CMIIngestionPipeline.ts` usavam `'nomic-embed-text'` (sem tag — Ollama resolve isso como
 * `:latest` por convenção). O Ollama local só tinha `nomic-embed-text:v1.5` puxado — NENHUMA das
 * cinco strings correspondia a um modelo instalado. `POST /api/embeddings` respondia
 * `{"error":"model \"nomic-embed-text:latest\" not found..."}`, e como toda chamada de embedding
 * neste projeto é deliberadamente best-effort (fail-open: `try { fetch(...) } catch { }`, nunca
 * lança), a falha nunca aparecia como erro visível — só como ausência silenciosa de linha em
 * `memory_embeddings`.
 *
 * Consequência medida: o embedding mais recente em `memory_embeddings` no banco de produção
 * datava de 09/06/2026 — MAIS DE DOIS MESES antes desta descoberta (16/08/2026) — apesar da
 * aplicação rodando continuamente, criando dezenas de nós novos nesse intervalo. Toda a metade
 * vetorial de `MemoryManager.semanticSearch()` esteve efetivamente desligada nesse período —
 * mesmo depois dos fixes de embedding-on-create (S240) e do fallback lexical (S236), porque
 * nenhum dos dois resolve "a chamada ao Ollama pede um modelo que não existe".
 *
 * CORREÇÃO: `EmbeddingService.DEFAULT_EMBED_MODEL` (agora exportado) passa a ser o único ponto
 * onde o nome do modelo aparece como string literal; `memory_write.ts`, `memory_admin.ts`,
 * `MemoryManager.ts` e `CMIIngestionPipeline.ts` importam a constante em vez de repetir o
 * literal. O valor foi corrigido para `nomic-embed-text:v1.5` — o que estava de fato instalado,
 * confirmado via `POST /api/embeddings` real antes de aplicar.
 *
 * Execução: npx ts-node src/__tests__/regression/S243_EmbeddingModel_SingleSourceOfTruth.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

function readSrc(relPath: string): string {
    return fs.readFileSync(path.join(process.cwd(), 'src', relPath), 'utf-8');
}

console.log('\n=== S243-1 — EmbeddingService exporta DEFAULT_EMBED_MODEL, valor é uma tag real ===');
{
    const { DEFAULT_EMBED_MODEL } = require('../../memory/EmbeddingService') as { DEFAULT_EMBED_MODEL: string };
    assert(typeof DEFAULT_EMBED_MODEL === 'string' && DEFAULT_EMBED_MODEL.length > 0, 'DEFAULT_EMBED_MODEL é uma string não vazia', DEFAULT_EMBED_MODEL);
    assert(DEFAULT_EMBED_MODEL.includes(':'), 'a constante inclui uma TAG explícita — nome sem tag é resolvido como :latest pelo Ollama, o mesmo bug de origem', DEFAULT_EMBED_MODEL);
    assert(DEFAULT_EMBED_MODEL !== 'nomic-embed-text:latest', 'não é mais a tag antiga que não existia no Ollama local do incidente', DEFAULT_EMBED_MODEL);
}

console.log('\n=== S243-2 — nenhum dos 4 consumidores tem string literal própria de modelo de embedding ===');
{
    const files = [
        'tools/memory_write.ts',
        'tools/memory_admin.ts',
        'memory/MemoryManager.ts',
        'memory/conversational/CMIIngestionPipeline.ts',
    ];
    for (const f of files) {
        const src = readSrc(f);
        assert(!/model:\s*['"]nomic-embed-text/.test(src), `${f} não hardcoda mais o nome do modelo — importa DEFAULT_EMBED_MODEL`, f);
        assert(/DEFAULT_EMBED_MODEL/.test(src), `${f} referencia DEFAULT_EMBED_MODEL`, f);
    }
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S243 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exit(1);
process.exit(0);
