/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S323 (issue 052, Sprint 1)
 *
 * A trava `same_tool_limit` encerrava o turno na 4ª chamada da mesma ferramenta contando só o NOME.
 * Produção (set-out/2026): 4 sub-turnos de goal cortados no meio do trabalho — ex.: 4 `exec_command`
 * diferentes, todos com sucesso, extraindo aulas passo a passo, cortados no passo 4 de 15; a saída do
 * step virava "Vou salvar o output…", o validador semântico (com razão) rebaixava, o retry batia na
 * mesma trava. A trava passa a contar só chamadas IMPRODUTIVAS: falha, ou saída idêntica a uma
 * anterior da mesma ferramenta.
 *
 * REGRESSÃO SE: chamadas produtivas voltarem a contar; o loop com variações que falham deixar de
 * ser barrado; saídas repetidas deixarem de contar; ou os dois caminhos (nativo/JSON) divergirem.
 *
 * Execução: npx ts-node src/__tests__/regression/S323_SameToolLimit_CountsOnlyUnproductiveCalls.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { SameToolLoopTracker } from '../../loop/AgentLoop';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const LIMIT = 4; // MAX_SAME_TOOL_CALLS

console.log('\n=== S323-1 — o caso real: 4+ exec_command com sucesso e saídas novas não disparam a trava ===');
{
    const t = new SameToolLoopTracker();
    const outs = ['EXIT: True', '82820', 'O volume na unidade C não tem nome.', 'aula_01.pptx\naula_02.pptx', 'consolidado gravado'];
    const counts = outs.map(o => t.record('exec_command', true, o));
    assert(counts.every(c => c === 0), '5 chamadas produtivas → 0 improdutivas (a regra antiga cortaria na 4ª)', counts);
}

console.log('\n=== S323-2 — loop com variações que FALHAM continua barrado (a intenção da trava) ===');
{
    const t = new SameToolLoopTracker();
    const counts = ["'python3' não reconhecido", "'python' não reconhecido", "'py' não reconhecido", "'python3.12' não reconhecido"]
        .map(e => t.record('exec_command', false, e));
    assert(counts[LIMIT - 1] >= LIMIT, '4 falhas com argumentos diferentes → atinge o limite', counts);
}

console.log('\n=== S323-3 — saída repetida (sem informação nova) conta, mesmo com sucesso ===');
{
    const t = new SameToolLoopTracker();
    const counts = ['Nenhum resultado', 'Nenhum resultado', 'Nenhum resultado', 'Nenhum resultado', 'Nenhum resultado']
        .map(o => t.record('web_search', true, o));
    assert(counts[0] === 0, 'a primeira ocorrência de uma saída é informação nova', counts);
    assert(counts[4] === LIMIT, 'as 4 repetições seguintes atingem o limite', counts);
}

console.log('\n=== S323-4 — mistura: produtivas não contam, improdutivas acumulam; contagem é por ferramenta ===');
{
    const t = new SameToolLoopTracker();
    t.record('read', true, 'arquivo A');
    t.record('read', false, 'ENOENT b.md');
    t.record('read', true, 'arquivo C');
    const afterRead = t.record('read', true, 'arquivo A'); // repetida
    assert(afterRead === 2, 'read: 1 falha + 1 repetida = 2 improdutivas', afterRead);
    assert(t.record('exec_command', false, 'ENOENT b.md') === 1, 'a mesma saída em OUTRA ferramenta não conta como repetida dela');
}

console.log('\n=== S323-5 — estrutural: os dois caminhos usam o rastreador; a exceção info_batch saiu ===');
{
    const src = fs.readFileSync(path.join(__dirname, '../../loop/AgentLoop.ts'), 'utf-8');
    const uses = src.match(/sameToolTracker\.record\(/g) ?? [];
    assert(uses.length === 2, 'sameToolTracker.record chamado nos dois caminhos (nativo e JSON-action)', uses.length);
    const guards = src.match(/if \((unproductiveCount|atomicUnproductive) >= MAX_SAME_TOOL_CALLS/g) ?? [];
    assert(guards.length === 2, 'as duas travas comparam a contagem IMPRODUTIVA com o limite', guards);
    assert(!/toolTypeCount >= MAX_SAME_TOOL_CALLS|atomicToolTypeCount >= MAX_SAME_TOOL_CALLS/.test(src), 'nenhuma trava compara mais a contagem bruta por nome');
    assert(!src.includes('INFO_BATCH_TOOLS'), 'a exceção info_batch (só ferramentas de informação) foi substituída pela regra única');
    assert(/const sameToolTracker = new SameToolLoopTracker\(\);/.test(src), 'um rastreador novo por turno, criado junto do contador');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S323 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
