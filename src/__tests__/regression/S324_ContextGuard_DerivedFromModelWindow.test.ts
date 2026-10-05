/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S324 (issue 052, Sprint 2)
 *
 * A trava de crescimento de contexto encerrava o turno com dois números sem derivação: 2,5× o
 * contexto inicial (ratio_limit) e +16.000 chars acrescentados (absolute_limit). Produção, 01–03/10:
 * 10 de 17 disparos de trava depois do S298 foram estes — os de absolute_limit com ~30 mil chars no
 * total, folgados numa janela de 32.768 tokens. O limite passa a ser a janela real do modelo
 * (`OLLAMA_NUM_CTX` × 3 chars/token, 25% reservados para a saída — ~73,7 mil chars no padrão).
 *
 * Os casos abaixo usam os números REAIS de disparos de produção.
 *
 * REGRESSÃO SE: voltar um limite por crescimento relativo/absoluto; o teto deixar de vir de
 * OLLAMA_NUM_CTX; ou um contexto acima da janela deixar de encerrar o turno.
 *
 * Execução: npx ts-node src/__tests__/regression/S324_ContextGuard_DerivedFromModelWindow.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { AgentLoop } from '../../loop/AgentLoop';
import { MemoryManager } from '../../memory/MemoryManager';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

function makeAgentLoop(): AgentLoop {
    const providerFactory = {
        chatWithFallback: async () => ({ status: 'success', content: 'x', attempts: [] }),
        getProvider: () => ({ name: 'fake' }),
        getProviderWithModel: () => ({ chat: async () => ({ status: 'success', content: '{}' }) }),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
    const db = new (Database as any)(':memory:');
    const memory = { semanticSearch: async () => [], addMessage: async () => {}, getDatabase: () => db } as unknown as MemoryManager;
    return new AgentLoop(
        providerFactory, memory, { languageDirective: 'pt-BR', systemPrompt: 'teste S324' } as any,
        { recordPattern: () => {}, getPatterns: () => [] } as any,
        { getSkillContextForQuery: async () => '', getAllSkills: () => [], loadAll: () => [] } as any,
        { store: () => {} } as any, { store: () => {}, getStats: () => ({}) } as any,
    );
}

/** Chama a trava REAL (checkContextGrowthGuard) com um tamanho de contexto controlado. */
function guard(loop: AgentLoop, initial: number, current: number, stepCount = 4): { aborted: boolean } {
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (): boolean => true;
    try {
        const r = (loop as any).checkContextGrowthGuard(
            [{ step: 1, tool: 'exec_command', input: '{}', status: 'success' }],
            'analise as aulas', stepCount, false, '', 15, false, 0,
            () => current, initial, [],
        );
        return { aborted: r.dedupAbort === true || r.action === 'continueLoop' };
    } finally { process.stdout.write = orig; }
}

delete process.env.OLLAMA_NUM_CTX;
const loop = makeAgentLoop();

console.log('\n=== S324-1 — teto derivado da janela do modelo ===');
{
    assert(AgentLoop.contextCapacityChars() === Math.floor(32768 * 3 * 0.75), 'padrão: 32.768 tokens × 3 chars × 75% = 73.728', AgentLoop.contextCapacityChars());
    process.env.OLLAMA_NUM_CTX = '8192';
    assert(AgentLoop.contextCapacityChars() === Math.floor(8192 * 3 * 0.75), 'acompanha OLLAMA_NUM_CTX (8192 → 18.432)', AgentLoop.contextCapacityChars());
    process.env.OLLAMA_NUM_CTX = 'lixo';
    assert(AgentLoop.contextCapacityChars() === 73728, 'valor inválido cai no padrão do provedor');
    delete process.env.OLLAMA_NUM_CTX;
}

console.log('\n=== S324-2 — disparos REAIS de produção que eram falsos (cabiam na janela) agora seguem ===');
{
    // absolute_limit em 23/09 23:02 (+16.855), 02/10 20:41 (+16.742), 03/10 17:42 (+18.808): ~13 mil iniciais.
    assert(!guard(loop, 13394, 13394 + 16855).aborted, 'absolute_limit real (+16.855, total ~30 mil) não encerra mais o turno');
    assert(!guard(loop, 13000, 13000 + 18808).aborted, 'absolute_limit real (+18.808) não encerra mais');
    // ratio_limit em 01/10 00:39 (2,78×) e 23/09 (4,45× → ~61 mil).
    assert(!guard(loop, 13000, Math.round(13000 * 2.78)).aborted, 'ratio_limit real de 2,78× (~36 mil) não encerra mais');
    assert(!guard(loop, 13679, 60932).aborted, 'ratio_limit real de 4,45× (60.932 chars) não encerra mais — ainda cabe na janela');
}

console.log('\n=== S324-3 — contexto acima da janela continua encerrando o turno ===');
{
    assert(guard(loop, 13424, 74099).aborted, 'ratio_limit real de 5,52× (74.099 chars) passa da janela → encerra');
    process.env.OLLAMA_NUM_CTX = '8192';
    assert(guard(loop, 5000, 20000).aborted, 'com janela de 8192 tokens, 20 mil chars passa do teto → encerra');
    delete process.env.OLLAMA_NUM_CTX;
    assert(!guard(loop, 13424, 74099, 1).aborted, 'no 1º passo não dispara (comportamento anterior mantido)');
}

console.log('\n=== S324-4 — estrutural: sem limites relativos/absolutos fixos ===');
{
    const src = fs.readFileSync(path.join(__dirname, '../../loop/AgentLoop.ts'), 'utf-8');
    assert(!/CONTEXT_RATIO_LIMIT|CONTEXT_ABSOLUTE_DELTA|MIN_RATIO_BASELINE/.test(src), 'as constantes 2,5× / +16.000 / baseline 4.000 saíram');
    assert(/reason=\$\{triggerReason\}/.test(src) && /const triggerReason = 'capacity_limit'/.test(src), 'um único motivo: capacity_limit');
    const planner = fs.readFileSync(path.join(__dirname, '../../loop/GoalPlanner.ts'), 'utf-8');
    assert(/capacity\.\?limit/.test(planner), 'a dica de estouro de contexto do GoalPlanner reconhece o motivo novo');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S324 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
