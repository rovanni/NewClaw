/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S481 (CI do main, 06/11/2026: S240-3 falhou no Ubuntu/Node 24 depois do merge do #54)
 *
 * `memory_write` (create sem `id`) gera o id como `${slug}_${Date.now()}`. Duas gravações com o mesmo nome no MESMO
 * milissegundo davam o mesmo id — e a segunda entrava no ramo "o id já existe": SOBRESCREVIA o nó anterior (nome, tipo e
 * conteúdo trocados). O próprio create() promete o contrário desde 22/10 (S437): "a gravação SEMPRE acontece (nó novo — nada
 * se perde, nada é sobrescrito)". No CI rápido o S240-3 caiu nisso; na produção, dois fatos de mesmo nome gravados em
 * sequência perdiam o primeiro.
 *
 * Agora o id GERADO nunca cai num nó existente (acrescenta `_2`, `_3`… até ficar livre). O id passado pelo agente continua
 * atualizando — é a decisão explícita dele.
 *
 * Determinístico: `Date.now` fica parado durante as gravações (é exatamente a condição do CI).
 *
 * REGRESSÃO SE: duas gravações sem id, com o mesmo nome e no mesmo milissegundo, deixarem um só nó; o primeiro conteúdo
 * mudar; ou o create com id explícito deixar de atualizar o nó.
 *
 * Execução: npx ts-node src/__tests__/regression/S481_MemoryWrite_IdGeradoNaoSobrescreve.test.ts
 */
import Database from 'better-sqlite3';
import { MemoryManager } from '../../memory/MemoryManager';
import { MemoryWriteTool } from '../../tools/memory_write';
import { EmbeddingService } from '../../memory/EmbeddingService';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const nowOrig = Date.now;
/**
 * Para o relógio só para quem gera o id (`memory_write`): parar o `Date.now` do processo inteiro trava o resto (laços que
 * esperam o tempo andar). A condição reproduzida é a do CI: as duas gravações leem o mesmo milissegundo.
 */
function relogioParadoNoMemoryWrite(ms: number): void {
    Date.now = () => (/memory_write/.test(new Error().stack ?? '') ? ms : nowOrig.call(Date));
}

async function main(): Promise<void> {
    const fetchOrig = global.fetch;
    const embedOrig = process.env.EMBED_MODEL;
    process.env.EMBED_MODEL = 'modelo-de-embedding-do-teste';
    (global as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
        if (String(url).includes('/api/embeddings')) return { ok: true, json: async () => ({ embedding: [0.1, 0.2, 0.3, 0.4] }) } as Response;
        throw new Error(`fetch não mockado para: ${url}`);
    }) as typeof fetch;
    try {
        console.log('\n=== S481-1 — duas gravações sem id, mesmo nome, mesmo milissegundo: dois nós, nada sobrescrito ===');
        {
            const db = new (Database as any)(':memory:');
            new EmbeddingService(db);
            const tool = new MemoryWriteTool(new MemoryManager(db, 'http://mock-ollama:11434'));
            relogioParadoNoMemoryWrite(1793934816009);   // o milissegundo do CI
            const r1 = await tool.execute({ action: 'create', type: 'fact', name: 'Posição Pi', content: 'Pi: 1.448 moedas (posição de outubro)' });
            const r2 = await tool.execute({ action: 'create', type: 'fact', name: 'Posição Pi', content: 'Pi: 1.500 moedas (posição de novembro)' });
            Date.now = nowOrig;
            const nos = db.prepare("SELECT id, content FROM memory_nodes WHERE name = 'Posição Pi' ORDER BY id").all() as Array<{ id: string; content: string }>;
            assert(r1.success === true && r2.success === true, 'as duas gravações retornaram sucesso', [r1.output, r2.output]);
            assert(nos.length === 2, 'ficaram DOIS nós (antes: um só, o segundo sobrescrevia o primeiro)', nos);
            assert(nos.some(n => n.content.includes('outubro')) && nos.some(n => n.content.includes('novembro')), 'os dois conteúdos estão no banco, intactos', nos);
            assert(new Set(nos.map(n => n.id)).size === 2 && nos.every(n => n.id.startsWith('posi_o_pi_1793934816009')), 'ids distintos, no mesmo formato de antes (slug_milissegundo, com sufixo só na colisão)', nos.map(n => n.id));
            assert(!/atualizado \(já existia\)/.test(r2.output ?? ''), 'a segunda NÃO caiu no ramo "já existia"', r2.output);
            db.close();
        }

        console.log('\n=== S481-2 — três no mesmo milissegundo: o sufixo continua até ficar livre ===');
        {
            const db = new (Database as any)(':memory:');
            new EmbeddingService(db);
            const tool = new MemoryWriteTool(new MemoryManager(db, 'http://mock-ollama:11434'));
            relogioParadoNoMemoryWrite(1793934816010);
            for (const c of ['primeiro fato sobre a turma', 'segundo fato sobre a turma', 'terceiro fato sobre a turma']) {
                await tool.execute({ action: 'create', type: 'fact', name: 'Turma', content: c });
            }
            Date.now = nowOrig;
            const ids = (db.prepare("SELECT id FROM memory_nodes WHERE name = 'Turma'").all() as Array<{ id: string }>).map(r => r.id).sort();
            assert(ids.length === 3 && new Set(ids).size === 3, 'três nós com três ids distintos', ids);
            db.close();
        }

        console.log('\n=== S481-3 — id explícito do agente continua atualizando o nó ===');
        {
            const db = new (Database as any)(':memory:');
            new EmbeddingService(db);
            const tool = new MemoryWriteTool(new MemoryManager(db, 'http://mock-ollama:11434'));
            await tool.execute({ action: 'create', id: 'fact_explicito', type: 'fact', name: 'A', content: 'original' });
            const r = await tool.execute({ action: 'create', id: 'fact_explicito', type: 'fact', name: 'A', content: 'atualizado' });
            const nos = db.prepare("SELECT content FROM memory_nodes WHERE id = 'fact_explicito'").all() as Array<{ content: string }>;
            assert(/atualizado \(já existia\)/.test(r.output ?? '') && nos.length === 1 && nos[0].content === 'atualizado', 'com id explícito: atualiza (decisão do agente, comportamento mantido)', { out: r.output, nos });
            db.close();
        }
    } finally {
        Date.now = nowOrig;
        global.fetch = fetchOrig;
        if (embedOrig === undefined) delete process.env.EMBED_MODEL; else process.env.EMBED_MODEL = embedOrig;
    }
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S481 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    // Saída explícita, como no S240: o MemoryManager deixa temporizadores próprios que seguram o processo.
    process.exit(failed > 0 ? 1 : 0);
}
main().catch((err) => { console.error('S481 erro inesperado:', err); process.exit(1); });
