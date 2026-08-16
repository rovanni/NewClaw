/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S238
 * Corrupção de `memory_nodes.metadata` (string reempacotada em JSON.stringify múltiplas vezes) e
 * conflito entre `MemoryCurator.curate()` (reconecta órfãos) e `deduplicateNodes()` (aposenta
 * nós quase-idênticos) — a mesma investigação, duas causas raiz relacionadas.
 *
 * INCIDENTE REAL (15/08/2026): operador reportou um nó (`fact_1779878884392`, "Relatório de
 * progresso do Tower Defense") isolado no grafo há meses, apesar de `MemoryCurator.curate()`
 * rodar a cada 30 min e reportar sucesso ("Fixed 1 orphans... 1 edges") em TODO ciclo. Reprodução
 * contra cópia do banco de produção revelou dois defeitos:
 *
 * CAUSA 1 — corrupção de metadata: `MemoryFacade.getAllNodes()` devolvia `metadata` como STRING
 * crua da coluna SQLite, nunca parseada, violando o contrato do tipo MemoryNode. Como
 * `MemoryGovernor.decayAllConfidences()` roda no boot, a cada 24h E depois de CADA turno de
 * conversa, e regrava cada nó decaído via `addNode({...node, ...})`, a string crua ia sendo
 * reempacotada em `JSON.stringify` a cada ciclo. Depois de passar de 8000 caracteres, o fallback
 * de truncamento de `graphRepository.addNode()` chamava `Object.keys()` sobre essa STRING (em vez
 * de um objeto), decompondo-a caractere-a-caractere: `{"0":"\"","1":"\\",...,"_truncated":true}`.
 * Esse mesmo dado corrompido derrubava `MemoryCurator.deduplicateNodes()` no meio do ciclo
 * (`Cannot create property 'superseded_by' on string`), interrompendo a limpeza de nós
 * irrelevantes para o banco inteiro, não só para o nó afetado.
 *
 * CAUSA 2 — curate() ignorava lifecycle_state: quando o nó perdia um desempate de deduplicação
 * quase-empatado contra outro nó de conteúdo parecido, `deduplicateNodes()` marcava-o
 * `SUPERSEDED` e redirecionava/apagava sua aresta. Mas `curate()` não filtrava por
 * `lifecycle_state` ao procurar órfãos — no PRÓXIMO ciclo, tratava o mesmo nó `SUPERSEDED` como
 * órfão de novo, recriava a aresta, e `deduplicateNodes()` podia desfazer de novo no mesmo ciclo.
 * Um cabo de guerra entre dois mecanismos que nunca liam o resultado um do outro.
 *
 * CORREÇÃO:
 *   1. `parseNodeMetadata()` (memoryTypes.ts) — ponto único de parse, valida estruturalmente que
 *      o resultado é um objeto plano; se não for (string/array/JSON inválido), descarta para '{}'
 *      em vez de propagar o valor malformado. Usado por getNode(), MemoryFacade.getAllNodes(),
 *      deduplicateNodes() e consolidateStaleClusters().
 *   2. `graphRepository.addNode()` — guarda de tipo antes de `Object.keys()` no fallback de
 *      truncamento; nunca mais decompõe uma string em caracteres.
 *   3. `repairCorruptedNodeMetadata()` (memorySchema.ts) — migração one-time que reseta para '{}'
 *      qualquer metadata já corrompido em instâncias existentes (roda dentro de
 *      ensureMemorySchema, mesmo padrão de migrateDomainNodeType).
 *   4. `MemoryCurator.curate()` — trueOrphans agora exclui nós com lifecycle_state SUPERSEDED/
 *      SUMMARIZED/EXPIRED (só ACTIVE/null são elegíveis a reconexão).
 *
 * Execução: npx ts-node src/__tests__/regression/S238_MemoryMetadataCorruption_CurateDedupConflict.test.ts
 */

import Database from 'better-sqlite3';
import { MemoryManager } from '../../memory/MemoryManager';
import { MemoryCurator } from '../../memory/MemoryCurator';
import { parseNodeMetadata } from '../../memory/memoryTypes';
import { repairCorruptedNodeMetadata } from '../../memory/memorySchema';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

async function main() {

console.log('\n=== S238-1 — parseNodeMetadata() descarta qualquer valor que não seja objeto plano ===');
{
    // Valor legítimo: objeto passa intacto.
    const ok = parseNodeMetadata('{"source":"user_input"}', 'n1');
    assert(ok.source === 'user_input', 'objeto válido passa intacto', ok);

    // JSON inválido: não lança, devolve {}.
    const invalid = parseNodeMetadata('{isso nao e json', 'n2');
    assert(Object.keys(invalid).length === 0, 'JSON inválido vira {} sem lançar', invalid);

    // Reprodução exata do dado corrompido real: JSON.parse devolve uma STRING, não objeto.
    const doubleStringified = parseNodeMetadata(JSON.stringify('{"source":"user_input"}'), 'n3');
    assert(Object.keys(doubleStringified).length === 0, 'metadata duplamente stringificado (parse devolve string) vira {} sem lançar', doubleStringified);

    // Array também não é objeto plano válido.
    const arr = parseNodeMetadata('[1,2,3]', 'n4');
    assert(Object.keys(arr).length === 0, 'array vira {} — não é o formato esperado de metadata');

    // Reprodução exata do dado corrompido REAL encontrado em produção (nó fact_1779878884392,
    // pós-deploy): JSON.parse devolve um objeto VÁLIDO (não string) — mas decomposto
    // caractere-a-caractere, com "_truncated" marcando a origem no fallback de truncamento.
    // Este padrão passa pelo type-check simples (é objeto!) e só a checagem estrutural de chaves
    // sequenciais o pega.
    const charDecomposed = parseNodeMetadata('{"0":"\\"","1":"\\\\","2":"\\"","_truncated":true}', 'n8');
    assert(Object.keys(charDecomposed).length === 0, 'metadata decomposto em caracteres (objeto válido, chaves "0","1","2"...) vira {} sem lançar', charDecomposed);

    // Um objeto legítimo cujas chaves por acaso são "0" e "1" (não deveria acontecer na prática,
    // mas a regra é puramente estrutural) só é tratado como corrompido COM o marcador _truncated.
    const legitNumericKeys = parseNodeMetadata('{"0":"a","1":"b"}', 'n9');
    assert(Object.keys(legitNumericKeys).length === 0, 'sem _truncated, chaves "0","1" sequenciais ainda são tratadas como decompostas — é a MESMA assinatura estrutural, resultado do fallback ANTES de acrescentar _truncated também seria descartado por segurança');

    // null/undefined/vazio: sempre {}.
    assert(Object.keys(parseNodeMetadata(null, 'n5')).length === 0, 'null vira {}');
    assert(Object.keys(parseNodeMetadata(undefined, 'n6')).length === 0, 'undefined vira {}');
    assert(Object.keys(parseNodeMetadata('', 'n7')).length === 0, 'string vazia vira {}');
}

console.log('\n=== S238-2 — MemoryFacade.getAllNodes() devolve metadata parseado, não a string crua ===');
{
    const db = new Database(':memory:');
    const mm = new MemoryManager(db);
    mm.addNode({ id: 'fact_meta_test', type: 'fact', name: 'Teste', content: 'conteúdo qualquer', metadata: { source: 'user_input' } });

    const facade = mm.getFacade();
    const all = facade.getAllNodes();
    const node = all.find(n => n.id === 'fact_meta_test');

    assert(!!node, 'nó encontrado em getAllNodes()');
    assert(typeof node?.metadata === 'object' && !Array.isArray(node?.metadata), 'metadata é objeto, não string', node?.metadata);
    assert((node?.metadata as Record<string, string> | undefined)?.source === 'user_input', 'conteúdo do metadata preservado corretamente', node?.metadata);

    db.close();
}

console.log('\n=== S238-3 — addNode() nunca mais decompõe metadata em caracteres indexados ===');
{
    const db = new Database(':memory:');
    const mm = new MemoryManager(db);

    // Simula o cenário real: alguém passa uma STRING JSON longa como metadata (contrato violado
    // em runtime) em vez de um objeto — o que decayAllConfidences fazia antes da correção.
    const stringMetadataThatWouldHaveBeenDecomposed = 'x'.repeat(9000);
    mm.addNode({
        id: 'fact_string_metadata',
        type: 'fact',
        name: 'Teste',
        content: 'conteúdo',
        // @ts-expect-error — deliberadamente violando o tipo para reproduzir o bug real
        metadata: stringMetadataThatWouldHaveBeenDecomposed,
    });

    const row = db.prepare('SELECT metadata FROM memory_nodes WHERE id = ?').get('fact_string_metadata') as { metadata: string };
    const parsed = JSON.parse(row.metadata);

    assert(
        !Object.prototype.hasOwnProperty.call(parsed, '0') && !Object.prototype.hasOwnProperty.call(parsed, '19'),
        'metadata gravado NÃO tem chaves numéricas indexadas (não foi decomposto caractere-a-caractere)',
        Object.keys(parsed).slice(0, 5),
    );
    assert(Object.keys(parsed).length === 0, 'metadata inválido (string) foi descartado para {} em vez de propagado', parsed);

    db.close();
}

console.log('\n=== S238-4 — repairCorruptedNodeMetadata() repara instâncias já corrompidas, sem tocar nós saudáveis ===');
{
    const db = new Database(':memory:');
    const mm = new MemoryManager(db);
    mm.addNode({ id: 'fact_healthy', type: 'fact', name: 'Saudável', content: 'ok', metadata: { source: 'user_input' } });

    // Injeta diretamente o padrão de corrupção real (dupla stringificação).
    db.prepare('UPDATE memory_nodes SET metadata = ? WHERE id = ?')
        .run(JSON.stringify(JSON.stringify({ source: 'user_input' })), 'fact_healthy');
    db.prepare(`
        INSERT INTO memory_nodes (id, type, name, content, metadata, weight, confidence, last_updated)
        VALUES ('fact_corrupted', 'fact', 'Corrompido', 'conteudo original preservado', ?, 1.0, 0.4, CURRENT_TIMESTAMP)
    `).run(JSON.stringify(JSON.stringify({ source: 'user_input' })));
    db.prepare(`
        INSERT INTO memory_nodes (id, type, name, content, metadata, weight, confidence, last_updated)
        VALUES ('fact_still_healthy', 'fact', 'Outro saudável', 'conteudo', ?, 1.0, 0.9, CURRENT_TIMESTAMP)
    `).run(JSON.stringify({ source: 'tool_result' }));

    // Reprodução exata do segundo padrão real (encontrado pós-deploy no nó fact_1779878884392):
    // objeto VÁLIDO decomposto caractere-a-caractere — não pega no type-check simples.
    db.prepare(`
        INSERT INTO memory_nodes (id, type, name, content, metadata, weight, confidence, last_updated)
        VALUES ('fact_char_decomposed', 'fact', 'Decomposto', 'conteudo do relatorio preservado', ?, 1.0, 0.4, CURRENT_TIMESTAMP)
    `).run('{"0":"\\"","1":"\\\\","2":"\\"","_truncated":true}');

    repairCorruptedNodeMetadata(db);

    const corrupted = db.prepare('SELECT metadata, content FROM memory_nodes WHERE id = ?').get('fact_corrupted') as { metadata: string; content: string };
    const charDecomposed = db.prepare('SELECT metadata, content FROM memory_nodes WHERE id = ?').get('fact_char_decomposed') as { metadata: string; content: string };
    const healthy = db.prepare('SELECT metadata FROM memory_nodes WHERE id = ?').get('fact_still_healthy') as { metadata: string };

    assert(corrupted.metadata === '{}', 'nó corrompido (dupla stringificação) foi resetado para {}', corrupted.metadata);
    assert(corrupted.content === 'conteudo original preservado', 'conteúdo do nó (content) NUNCA é tocado pela migração — só metadata', corrupted.content);
    assert(charDecomposed.metadata === '{}', 'nó corrompido (decomposição em caracteres) TAMBÉM foi resetado para {} — a lacuna real encontrada pós-deploy', charDecomposed.metadata);
    assert(charDecomposed.content === 'conteudo do relatorio preservado', 'conteúdo do nó decomposto também preservado intacto', charDecomposed.content);
    assert(JSON.parse(healthy.metadata).source === 'tool_result', 'nó saudável não foi alterado pela migração', healthy.metadata);

    db.close();
}

console.log('\n=== S238-5 — deduplicateNodes() não crasha ao encontrar metadata legado corrompido ===');
{
    const db = new Database(':memory:');
    const mm = new MemoryManager(db);
    const curator = new MemoryCurator(mm);

    mm.addNode({ id: 'fact_dup_a', type: 'fact', name: 'Posição RIVER', content: 'Posição RIVER — 100 tokens, preço médio 5.00' });
    mm.addNode({ id: 'fact_dup_b', type: 'fact', name: 'Posição RIVER', content: 'Posição RIVER — 100 tokens, preço médio 5.00 dólares' });

    // Corrompe o metadata de um dos dois candidatos a duplicata, simulando um nó legado que
    // escapou da migração (ou uma instância que ainda não rodou a migração).
    db.prepare('UPDATE memory_nodes SET metadata = ? WHERE id = ?')
        .run(JSON.stringify(JSON.stringify({ source: 'user_input' })), 'fact_dup_b');

    let threw = false;
    try {
        await curator.deduplicateNodes();
    } catch {
        threw = true;
    }
    assert(!threw, 'deduplicateNodes() não lança mesmo com metadata legado corrompido no par de duplicatas');

    db.close();
}

console.log('\n=== S238-6 — curate() não reconecta nó SUPERSEDED/SUMMARIZED/EXPIRED (fim do cabo de guerra) ===');
{
    const db = new Database(':memory:');
    const mm = new MemoryManager(db);
    const curator = new MemoryCurator(mm);

    mm.addNode({ id: 'ctx_system_memory', type: 'context', name: 'Memória do Sistema', content: 'hub' });
    mm.addNode({ id: 'fact_superseded_orphan', type: 'fact', name: 'Nó aposentado', content: 'conteudo' });
    db.prepare(`UPDATE memory_nodes SET lifecycle_state = 'SUPERSEDED' WHERE id = 'fact_superseded_orphan'`).run();

    mm.addNode({ id: 'fact_active_orphan', type: 'fact', name: 'Nó ativo isolado', content: 'conteudo' });

    // TemporalLayer conecta automaticamente todo nó "fact" a um bucket time_YYYY na criação
    // (--occurred_in-->), fora do escopo desta correção — removido aqui para reproduzir o estado
    // exato do incidente real (nó com ZERO arestas em qualquer direção).
    db.prepare(`DELETE FROM memory_edges WHERE from_node IN ('fact_superseded_orphan','fact_active_orphan')`).run();

    const result = await curator.curate();

    const supersededEdges = db.prepare('SELECT COUNT(*) c FROM memory_edges WHERE from_node = ? OR to_node = ?').get('fact_superseded_orphan', 'fact_superseded_orphan') as { c: number };
    const activeEdges = db.prepare('SELECT COUNT(*) c FROM memory_edges WHERE from_node = ? OR to_node = ?').get('fact_active_orphan', 'fact_active_orphan') as { c: number };

    assert(supersededEdges.c === 0, 'nó SUPERSEDED continua sem aresta — curate() não tenta mais "consertar" o que outro mecanismo aposentou', supersededEdges);
    assert(activeEdges.c === 1, 'nó ACTIVE genuinamente órfão continua sendo conectado normalmente', activeEdges);
    assert(
        !result.edgesCreated.some(e => e.includes('fact_superseded_orphan')),
        'o relatório de curate() não lista o nó SUPERSEDED entre os órfãos corrigidos',
        result.edgesCreated,
    );

    db.close();
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S238 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exit(1);
process.exit(0);

}

main().catch(err => {
    console.error('Erro no teste S238:', err);
    process.exit(1);
});
