/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S243
 * O modelo de embedding vem de UMA fonte — a escolha do usuário (`EMBED_MODEL`, lida por
 * `modeloDeEmbedding()` em EmbeddingService.ts) — e não existe nenhum nome de modelo no código.
 *
 * INCIDENTE REAL (16/08/2026, instância local de produção): `memory_write.ts`, `memory_admin.ts` e
 * `MemoryManager.ts` chamavam Ollama com `model: 'nomic-embed-text:latest'`; `EmbeddingService.ts`
 * e `CMIIngestionPipeline.ts` usavam `'nomic-embed-text'` (sem tag — Ollama resolve isso como
 * `:latest` por convenção). O Ollama local só tinha `nomic-embed-text:v1.5` puxado — NENHUMA das
 * cinco strings correspondia a um modelo instalado. Como toda chamada de embedding é best-effort
 * (fail-open), a falha nunca aparecia: o embedding mais recente datava de dois meses antes.
 *
 * 1ª CORREÇÃO (16/08/2026): uma constante única, `DEFAULT_EMBED_MODEL = 'nomic-embed-text:v1.5'`.
 *
 * 2ª CORREÇÃO (14/10/2026, diretiva da mantenedora: "nenhum modelo em código nem de fallback"): a
 * constante também era um modelo no código, e nas instâncias da mantenedora já não gerava vetores
 * (5 tentativas, 0 gerados). A fonte única passa a ser a escolha do usuário: `EMBED_MODEL` (painel ou
 * .env). Vazio = embeddings desligados, sem chamada de rede — a busca segue por palavras (S236).
 *
 * REGRESSÃO SE: algum consumidor voltar a ter um nome de modelo próprio; vazio passar a chamar o
 * Ollama com um modelo adivinhado; ou a troca no painel deixar de valer sem reiniciar.
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

const ARQUIVOS = [
    'memory/EmbeddingService.ts',
    'tools/memory_write.ts',
    'tools/memory_admin.ts',
    'memory/MemoryManager.ts',
    'memory/conversational/CMIIngestionPipeline.ts',
];

async function main(): Promise<void> {
    const original = process.env.EMBED_MODEL;
    const fetchOriginal = global.fetch;
    try {
        console.log('\n=== S243-1 — a fonte única é a escolha do usuário (EMBED_MODEL), sem padrão no código ===');
        {
            const mod = require('../../memory/EmbeddingService') as { modeloDeEmbedding: () => string; DEFAULT_EMBED_MODEL?: string };
            assert(mod.DEFAULT_EMBED_MODEL === undefined, 'não existe mais a constante DEFAULT_EMBED_MODEL');
            delete process.env.EMBED_MODEL;
            assert(mod.modeloDeEmbedding() === '', 'sem EMBED_MODEL, nenhum modelo — vazio, não um nome adivinhado');
            process.env.EMBED_MODEL = '  modelo-escolhido:tag  ';
            assert(mod.modeloDeEmbedding() === 'modelo-escolhido:tag', 'com EMBED_MODEL, é exatamente o escolhido (sem espaços)');
        }

        console.log('\n=== S243-2 — nenhum dos 5 arquivos tem nome de modelo de embedding próprio ===');
        for (const f of ARQUIVOS) {
            const src = readSrc(f);
            const semComentarios = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
            assert(!/['"`]nomic-embed/.test(semComentarios), `${f} não tem nome de modelo em código`);
            assert(/modeloDeEmbedding\(\)/.test(src), `${f} lê a escolha por modeloDeEmbedding()`);
        }

        console.log('\n=== S243-3 — vazio desliga sem chamar a rede; a troca vale na hora (sem reiniciar) ===');
        {
            const { EmbeddingService } = require('../../memory/EmbeddingService') as typeof import('../../memory/EmbeddingService');
            const Database = require('better-sqlite3');
            const db = new Database(':memory:');
            const pedidos: string[] = [];
            global.fetch = (async (_url: unknown, init?: { body?: string }) => {
                pedidos.push(JSON.parse(init?.body || '{}').model);
                return { ok: true, json: async () => ({ embedding: [0.1, 0.2] }) } as unknown as Response;
            }) as typeof fetch;
            const svc = new EmbeddingService(db, 'http://127.0.0.1:1');
            delete process.env.EMBED_MODEL;
            assert(await svc.embed('texto') === null && pedidos.length === 0, 'sem modelo escolhido: embed() devolve null e não chama o Ollama', pedidos);
            assert(await svc.isAvailable() === false, 'sem modelo escolhido: isAvailable() é falso');
            process.env.EMBED_MODEL = 'escolhido-no-painel:v1';
            const vetor = await svc.embed('texto');
            assert(Array.isArray(vetor) && pedidos[0] === 'escolhido-no-painel:v1', 'a mesma instância passa a usar o modelo escolhido depois, sem ser recriada', pedidos);
            db.close();
        }

        console.log('\n=== S243-4 — o painel grava e lê EMBED_MODEL (paridade com o boot) ===');
        {
            const cfg = readSrc('dashboard/routes/config.ts');
            const boot = readSrc('index.ts');
            assert(/'EMBED_MODEL':\s*ctx\.config\.embedModel/.test(cfg), 'persistConfigToEnv grava EMBED_MODEL');
            assert(/process\.env\.EMBED_MODEL = ctx\.config\.embedModel/.test(cfg), 'POST /api/config aplica na hora');
            assert(/embedModel:\s*\(process\.env\.EMBED_MODEL/.test(boot), 'o boot lê EMBED_MODEL para o mesmo campo');
        }
    } finally {
        global.fetch = fetchOriginal;
        if (original === undefined) delete process.env.EMBED_MODEL; else process.env.EMBED_MODEL = original;
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S243 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
