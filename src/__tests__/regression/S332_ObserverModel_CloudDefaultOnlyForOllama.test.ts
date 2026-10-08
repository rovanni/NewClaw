/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S332 (issue 057, Sprint G1)
 *
 * Sem OBSERVER_MODEL, o ObserverValidator pedia 'qwen3.5:cloud' a qualquer provedor — visto em 05/10/2026: o
 * juiz de grounding pedia esse nome ao llama-server local (Bonsai). Mesma regra da issue 054 (D2): o padrão de
 * nuvem só vale com o Ollama como provedor padrão; para os demais, sem modelo = o do provedor (issue 019).
 * Issue 068 (07/10/2026) tornou a regra geral: o código não escolhe modelo para o juiz em provedor nenhum — sem
 * OBSERVER_MODEL, sem modelo (o provedor usa o padrão do painel). Modelo configurado nunca é tocado.
 *
 * Execução: npx ts-node src/__tests__/regression/S332_ObserverModel_CloudDefaultOnlyForOllama.test.ts
 */
import { ObserverValidator } from '../../loop/ObserverValidator';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const judgeJson = JSON.stringify({ claims: [{ claim: 'x', evidence: ['E1'], verdict: 'SUPPORTED' }] });

/** Provedor falso que registra o modelo pedido em cada chamada (6º argumento do chatWithFallback). */
function factory(defaultProvider: string | null, models: Array<string | undefined>) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getBudgetAuxiliar } = require('../../shared/auxTimeout');
    const f: Record<string, unknown> = {
        chatWithFallback: async (_m: unknown, _t: unknown, _p: unknown, _to: unknown, _s: unknown, model?: string) => {
            models.push(model);
            return { status: 'success', content: judgeJson, attempts: [] };
        },
        getBudgetAuxiliar: (p: 'classificacao' | 'validacao') => getBudgetAuxiliar(p, null, null),
    };
    if (defaultProvider) f.getDefaultProvider = () => defaultProvider;
    return f as any;
}
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (): boolean => true;
    try { return await fn(); } finally { process.stdout.write = orig; }
};
const ev = [{ id: 'E1', tool: 'read', output: 'x' }];

async function main(): Promise<void> {
delete process.env.OBSERVER_MODEL;

console.log('\n=== S332-1 — provedor padrão Ollama, sem OBSERVER_MODEL: nenhum modelo escolhido pelo código (issue 068) ===');
{
    const models: Array<string | undefined> = [];
    await quiet(() => new ObserverValidator(factory('ollama', models)).validateGrounding('x', ev));
    assert(models[0] === '', "pede '' — o Ollama usa o modelo padrão do painel (antes: qwen3.5:cloud em silêncio)", models);
}

console.log('\n=== S332-2 — provedor padrão local (custom), sem OBSERVER_MODEL: modelo do provedor ===');
{
    const models: Array<string | undefined> = [];
    await quiet(() => new ObserverValidator(factory('bonsai', models)).validateGrounding('x', ev));
    assert(models[0] === '', "pede '' (o provedor usa o próprio modelo)", models);
}

console.log('\n=== S332-3 — OBSERVER_MODEL / setModel configurados: nunca tocados ===');
{
    const models: Array<string | undefined> = [];
    await quiet(() => new ObserverValidator(factory('bonsai', models), 'meu-juiz').validateGrounding('x', ev));
    const v = new ObserverValidator(factory('bonsai', models));
    v.setModel('juiz-do-painel');
    await quiet(() => v.validateGrounding('x', ev));
    assert(models[0] === 'meu-juiz' && models[1] === 'juiz-do-painel', 'configurado vale em qualquer provedor', models);
}

console.log('\n=== S332-4 — sem como saber o provedor: mesmo contrato ===');
{
    const models: Array<string | undefined> = [];
    await quiet(() => new ObserverValidator(factory(null, models)).validateGrounding('x', ev));
    assert(models[0] === '', "sem getDefaultProvider → '' (nada embutido)", models);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S332 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
}

main().catch((err) => { console.error('S332 erro inesperado:', err); process.exitCode = 1; });
