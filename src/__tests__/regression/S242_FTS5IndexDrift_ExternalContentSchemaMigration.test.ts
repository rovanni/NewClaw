/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S242
 * `memory_nodes_fts` criada com schema antigo (sem `content='memory_nodes'`, tabela FTS5
 * standalone) nunca é migrada para o schema correto — `CREATE VIRTUAL TABLE IF NOT EXISTS` só
 * checa o NOME da tabela, não o schema, então uma instância que já tinha a tabela antiga fica
 * presa com um índice de busca permanentemente desconectado de `memory_nodes`.
 *
 * INCIDENTE REAL (16/08/2026, banco de produção local, descoberto ao usuário reportar que a
 * busca "river" no Dashboard (`/memoria`, aba de busca) não
 * encontrava NADA relacionado a River, apesar do grafo mostrar claramente vários nós com "RIVER"
 * no nome/conteúdo). Reprodução: `SELECT ... FROM memory_nodes_fts WHERE memory_nodes_fts MATCH
 * 'river*'` devolvia 2 nós SEM NENHUMA relação com a palavra "river" (nem no name, nem no
 * content). `memory_nodes` tinha 86 linhas; `memory_nodes_fts` só 54 — o índice nunca foi
 * repovoado desde que ficou desincronizado. `sqlite_master.sql` da tabela confirmou:
 * `CREATE VIRTUAL TABLE memory_nodes_fts USING fts5(name, content, type)` — sem
 * `content='memory_nodes'`, ou seja, uma tabela FTS5 STANDALONE (guarda cópia própria de texto,
 * sem trigger de sincronização nenhum) em vez de external-content table.
 *
 * Por que a lógica de rebuild existente nunca disparava: a condição era `ftsCount === 0` — mas a
 * tabela antiga não estava vazia, só desconectada. "Vazio" nunca foi a pergunta certa.
 *
 * SEGUNDA CAUSA, achada só ao validar a primeira correção: `SELECT count(*) FROM
 * memory_nodes_fts` numa tabela FTS5 external-content NUNCA reflete se o índice de busca já foi
 * construído — a contagem espelha `memory_nodes` (a tabela de conteúdo) SEMPRE, mesmo com o
 * índice interno (`memory_nodes_fts_data`) vazio logo após o CREATE. Confirmado
 * experimentalmente: `ftsCount === nodeCount` é verdade tanto ANTES quanto DEPOIS de rodar
 * `INSERT INTO memory_nodes_fts(memory_nodes_fts) VALUES('rebuild')` — nenhum dos dois lados mede
 * "o índice tem as entradas de busca de verdade?". Por isso a correção final não tenta detectar
 * staleness por contagem: roda `rebuild` INCONDICIONALMENTE em todo boot — não só quando o schema
 * acabou de ser corrigido. Motivo adicional: `memory_nodes_fts` não tem NENHUM trigger de
 * sincronização (confirmado: `sqlite_master` sem triggers) — o rebuild em boot é o ÚNICO ponto de
 * sincronização que existe. Rodar só condicionalmente deixaria todo nó escrito ENTRE dois
 * restarts de fora do índice até o restart seguinte — mesma classe de bug, só que para nós novos.
 *
 * TERCEIRA CAUSA, de teste (não de produção): a correção vive dentro de `initializeSchema()` —
 * função chamada por `new MemoryManager(db)`, ou seja, roda em TODO boot real do processo — não
 * dentro de `ensureMemorySchema()`, que é uma função de migração separada, chamada por
 * `initializeSchema()` mas sem a lógica de FTS. Um teste que simulasse "próximo boot" chamando só
 * `ensureMemorySchema(db)` isoladamente nunca exercitaria a correção — precisa reconstruir
 * `MemoryManager` (`new MemoryManager(db)` de novo, mesmo `db`), que é o que um restart real faz.
 *
 * CORREÇÃO (memorySchema.ts, dentro de `initializeSchema`, no bloco que já cria
 * `memory_nodes_fts`): antes do `CREATE VIRTUAL TABLE IF NOT EXISTS`, verifica `sqlite_master.sql`
 * da tabela já existente (se houver) — se não contiver `content='memory_nodes'`, dropa para a
 * recriação seguinte pegar o schema certo. Depois do CREATE, roda `rebuild` incondicionalmente
 * sempre que a tabela acabou de ser criada (schema corrigido ou primeira vez) — sem depender de
 * `count(*)`, que não é um sinal confiável para tabelas external-content.
 *
 * Execução: npx ts-node src/__tests__/regression/S242_FTS5IndexDrift_ExternalContentSchemaMigration.test.ts
 */

import Database from 'better-sqlite3';
import { MemoryManager } from '../../memory/MemoryManager';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

function ftsSchemaSql(db: Database.Database): string | undefined {
    return (db.prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_nodes_fts'`
    ).get() as { sql: string } | undefined)?.sql;
}

function searchRiver(db: Database.Database): Array<{ id: string }> {
    return db.prepare(
        `SELECT n.id FROM memory_nodes_fts f JOIN memory_nodes n ON f.rowid = n.rowid WHERE memory_nodes_fts MATCH 'river*'`
    ).all() as Array<{ id: string }>;
}

console.log('\n=== S242-1 — reprodução exata: FTS5 standalone antiga, desconectada, com dado alheio ===');
{
    const db = new (Database as any)(':memory:');
    new MemoryManager(db); // schema inicial, cria memory_nodes_fts JÁ correta (banco novo)

    assert(!!ftsSchemaSql(db)?.includes(`content='memory_nodes'`), 'pré-condição: banco novo já nasce com o schema correto (external content)');

    // Simula uma instância de produção antiga: dropa a tabela correta e recria no formato
    // standalone (o que uma instalação de meses atrás, antes do código usar content=, teria).
    db.exec('DROP TABLE memory_nodes_fts');
    db.exec(`CREATE VIRTUAL TABLE memory_nodes_fts USING fts5(name, content, type)`);
    // Povoa com conteúdo de uma "época antiga", sem qualquer relação com o que será inserido a
    // seguir em memory_nodes — reproduz o JOIN por rowid comparando linhas que não correspondem.
    db.exec(`INSERT INTO memory_nodes_fts(name, content, type) VALUES ('Nó antigo qualquer', 'conteúdo de outra época, sem relação', 'context')`);

    // Insere um nó real com "river" no conteúdo — a tabela FTS standalone acima NUNCA fica
    // sabendo disso (sem trigger).
    db.prepare(`
        INSERT INTO memory_nodes (id, type, name, content, weight, confidence, last_updated, last_accessed)
        VALUES ('fact_river_test', 'fact', 'Posição RIVER', 'Posição RIVER — 100 tokens, preço médio US$ 5,00', 1.0, 1.0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run();

    assert(searchRiver(db).length === 0, 'pré-condição do bug: busca por "river" não encontra o nó real (índice desconectado)', searchRiver(db));

    // Próximo "boot": o processo reinicia, MemoryManager é reconstruído sobre o MESMO banco —
    // isso é o que de fato dispara initializeSchema()/a correção, não uma chamada isolada de
    // ensureMemorySchema (que não contém essa lógica).
    new MemoryManager(db);

    assert(!!ftsSchemaSql(db)?.includes(`content='memory_nodes'`), 'após o "restart", memory_nodes_fts foi recriada com content=memory_nodes');

    const after = searchRiver(db);
    assert(after.some(r => r.id === 'fact_river_test'), 'depois do "restart", a busca por "river" encontra o nó real', after);

    db.close();
}

console.log('\n=== S242-2 — idempotência: reconstruir MemoryManager de novo não quebra nem perde a busca ===');
{
    const db = new (Database as any)(':memory:');
    new MemoryManager(db);
    db.prepare(`
        INSERT INTO memory_nodes (id, type, name, content, weight, confidence, last_updated, last_accessed)
        VALUES ('fact_river_idem', 'fact', 'Posição RIVER idempotência', 'RIVER 100 tokens', 1.0, 1.0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run();

    new MemoryManager(db); // "restart" 1 — schema já correto, deve só indexar o nó novo
    new MemoryManager(db); // "restart" 2 — não deve quebrar nem duplicar

    const results = searchRiver(db);
    assert(results.some(r => r.id === 'fact_river_idem'), 'nó continua encontrável depois de múltiplos "restarts" consecutivos', results);
    assert(results.length === new Set(results.map(r => r.id)).size, 'nenhuma duplicata no resultado da busca (índice não foi populado mais de uma vez por nó)', results);

    db.close();
}

console.log('\n=== S242-3 — schema já correto não é derrubado à toa ===');
{
    const db = new (Database as any)(':memory:');
    new MemoryManager(db);
    const before = ftsSchemaSql(db);
    new MemoryManager(db); // "restart" — schema já correto
    const after = ftsSchemaSql(db);
    assert(before === after, 'schema já correto (content=memory_nodes) não é recriado desnecessariamente a cada boot', { before, after });
    db.close();
}

console.log('\n=== S242-4 — paridade: count(*) nunca é usado como sinal de "índice construído" ===');
{
    // Trava a lição aprendida durante a investigação: qualquer reintrodução futura de uma
    // checagem `ftsCount === nodeCount` (ou `ftsCount === 0`) como condição PARA disparar o
    // rebuild reproduziria o bug — count(*) numa tabela external-content espelha a tabela de
    // conteúdo independentemente do índice ter sido construído.
    const fs = require('fs');
    const path = require('path');
    const SOURCE = fs.readFileSync(path.join(process.cwd(), 'src', 'memory', 'memorySchema.ts'), 'utf-8') as string;
    assert(!/if \(ftsCount/.test(SOURCE), 'o rebuild não é condicionado a uma comparação de ftsCount (sinal não-confiável para external-content)');

    // Trecho entre "Rebuilding FTS index..." e a chamada de rebuild não pode conter um `if (` —
    // isso garantiria que o rebuild continua atrás de algum gate condicional reintroduzido.
    const logIdx = SOURCE.indexOf("log.info('[MemorySchema] Rebuilding FTS index...')");
    const rebuildCallIdx = SOURCE.indexOf(`INSERT INTO memory_nodes_fts(memory_nodes_fts) VALUES('rebuild')`, logIdx);
    const between = SOURCE.slice(logIdx, rebuildCallIdx);
    assert(logIdx > -1 && rebuildCallIdx > logIdx && !/if\s*\(/.test(between),
        'o rebuild roda incondicionalmente logo após o log — sem gate de "só se precisar" entre os dois',
        between);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S242 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exit(1);
process.exit(0);
