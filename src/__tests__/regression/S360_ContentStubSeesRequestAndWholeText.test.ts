/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S360 (Sprint V4 do princípio "Informação Completa para Decidir", 08/10/2026)
 *
 * O detector de conteúdo-molde pergunta se o texto "descreve o processo em vez de responder ao pedido real" — mas não
 * recebia o pedido, e julgava só os 800 primeiros caracteres do texto (o objeto da decisão).
 *
 * REGRESSÃO SE: o pedido deixar de chegar ao detector (pelo planejador ou pela análise de risco), ou o texto julgado
 * voltar a ser cortado.
 *
 * Execução: npx ts-node src/__tests__/regression/S360_ContentStubSeesRequestAndWholeText.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { makeContentStubClassifier } from '../../shared/contentStubClassifier';
import './_fixtures/motorLegado';   // juízes simulados no formato antigo → formato do motor único (ADR-014)

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (): boolean => true;
    try { return await fn(); } finally { process.stdout.write = orig; }
};

async function main(): Promise<void> {
    console.log('\n=== S360-1 — o detector recebe o pedido e o texto inteiro ===');
    const prompts: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getBudgetAuxiliar } = require('../../shared/auxTimeout');
    const f = {
        chatWithFallback: async (msgs: Array<{ content: string }>) => { prompts.push(msgs[0].content); return { status: 'success', content: '{"isStub": false, "reason": "conteúdo real"}', attempts: [] }; },
        getBudgetAuxiliar: (p: 'classificacao' | 'validacao') => getBudgetAuxiliar(p, null, null),
    } as any;
    const classificar = makeContentStubClassifier(f);
    const FIM_DO_TEXTO = '[resultado_do_passo_3] será inserido aqui';
    const texto = 'Questão 1 — Considere um compilador de uma passada... '.repeat(30) + FIM_DO_TEXTO;
    const pedido = 'Crie 10 questões ENADE de Compiladores com gabarito';
    await quiet(() => classificar(texto, 'write', pedido));
    const p = prompts[0] ?? '';
    assert(p.includes(pedido), 'o pedido do usuário está no prompt (antes: ausente)');
    assert(p.includes(FIM_DO_TEXTO) && p.includes(texto), `o texto julgado vai inteiro (${texto.length} chars; antes: 800) — inclusive o molde no fim`);
    await quiet(() => classificar('Conteúdo real e curto.', 'write'));
    assert(/Pedido do usuário[^\n]*\n"""\n\(não informado\)\n"""/.test(prompts[1] ?? ''), 'sem pedido conhecido → "(não informado)"');

    console.log('\n=== S360-2 — o pedido chega pelos dois caminhos que chamam o detector ===');
    const src = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf-8');
    assert(/classifyContentStub\(contentStr, resolvedTool, pedidoDoUsuario\)/.test(src('loop', 'planning', 'sanitizePlanSteps.ts')), 'sanitizePlanSteps repassa o pedido');
    assert((src('loop', 'GoalPlanner.ts').match(/parsePlanResponse\(result\.content, goal\.userIntent\)/g) || []).length === 3, 'GoalPlanner: plano, replanejamento e retry minimal passam o pedido');
    assert(/evidenceBackedPaths,\s*\n\s*goal\.userIntent,/.test(src('loop', 'RiskAnalyzer.ts')), 'RiskAnalyzer passa o pedido');

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S360 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}
main().catch((err) => { console.error('S360 erro inesperado:', err); process.exitCode = 1; });
