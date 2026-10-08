/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S358 (Sprint V2 do princípio "Informação Completa para Decidir", 08/10/2026)
 *
 * O GoalExtractor decide se a mensagem vira goal, se é ambígua, se é refinamento — e escreve o `objective`, o resumo
 * que alimenta o replanejamento e a revisão de risco. Ele recebia só os 300 primeiros caracteres da mensagem, e o
 * `objective` dos caminhos rápidos era a própria mensagem cortada em 300. Uma instrução no fim de um pedido longo não
 * chegava a quem decidia nem ao resumo.
 *
 * REGRESSÃO SE: a mensagem (objeto da classificação) voltar a ser cortada; o contexto recente ser cortado sem o corte
 * ser declarado; ou o `objective` dos caminhos rápidos voltar a ser um corte da mensagem.
 *
 * Execução: npx ts-node src/__tests__/regression/S358_GoalExtractorSeesWholeMessage.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { GoalExtractor } from '../../loop/GoalExtractor';

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

const FIM = 'no final, envie como PDF e não use a internet';
const MENSAGEM = 'Quero um material de estudo sobre redes de computadores para o curso técnico, com exemplos práticos de endereçamento e exercícios. '.repeat(4) + FIM;

async function main(): Promise<void> {
    console.log(`\n(cenário: mensagem de ${MENSAGEM.length} caracteres; instrução decisiva a partir do ${MENSAGEM.indexOf(FIM)})`);

    console.log('\n=== S358-1 — a classificação por LLM recebe a mensagem inteira ===');
    const prompts: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getBudgetAuxiliar } = require('../../shared/auxTimeout');
    const factory = {
        chatWithFallback: async (msgs: Array<{ content: string }>) => {
            prompts.push(msgs[0]?.content ?? '');
            return { status: 'success', content: '{"is_goal": true, "confidence": 0.9, "objective": "material de redes", "required_tools": [], "reason": "r", "is_ambiguous": false}', attempts: [] };
        },
        getBudgetAuxiliar: (p: 'classificacao' | 'validacao') => getBudgetAuxiliar(p, null, null),
    } as any;
    const ex = new GoalExtractor(factory);
    const contexto = [{ role: 'user', content: 'mensagem anterior '.repeat(40) }, { role: 'assistant', content: 'resposta anterior' }];
    await quiet(() => (ex as any).llmClassify(MENSAGEM, {}, contexto));
    const p = prompts[0] ?? '';
    assert(p.includes(MENSAGEM), 'prompt contém a mensagem inteira (antes: 300 caracteres)');
    assert(p.includes(FIM), 'a instrução do fim da mensagem chega a quem classifica');
    assert(/trecho de até 300 caracteres — o corte é do sistema/.test(p), 'o corte do contexto recente é declarado ao modelo');

    console.log('\n=== S358-2 — os caminhos rápidos usam o pedido inteiro como objective ===');
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalExtractor.ts'), 'utf-8');
    assert(!/objective:\s*message\.slice\(/.test(src), 'nenhum objective é um corte da mensagem');
    assert(!/Mensagem atual do usuário[^\n]*message\.slice\(/.test(src), 'a mensagem no prompt não é cortada');

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S358 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}
main().catch((err) => { console.error('S358 erro inesperado:', err); process.exitCode = 1; });
