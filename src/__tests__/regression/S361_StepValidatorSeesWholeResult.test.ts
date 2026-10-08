/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S361 (Sprint V5 do princípio "Informação Completa para Decidir", 08/10/2026)
 *
 * O StepSemanticValidator perguntava ao LLM se o resultado do passo serve ao passo, mas mostrava só 600 caracteres do
 * resultado — escolhidos por coincidência de palavras-chave (`extractRelevantSnippet`) — e 200 do pedido. Uma
 * heurística decidia o que o LLM podia ver.
 *
 * REGRESSÃO SE: o resultado ou o pedido voltarem a ser cortados; a seleção por palavra-chave voltar; ou um resultado
 * acima do teto ser julgado em pedaço em vez de "não avaliável".
 *
 * Execução: npx ts-node src/__tests__/regression/S361_StepValidatorSeesWholeResult.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { StepSemanticValidator } from '../../loop/StepSemanticValidator';
import { DECISION_PROMPT_MAX_CHARS } from '../../core/providerTypes';
import type { PlanStep } from '../../loop/GoalTypes';

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
    const prompts: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getBudgetAuxiliar } = require('../../shared/auxTimeout');
    const f = {
        chatWithFallback: async (msgs: Array<{ content: string }>) => { prompts.push(msgs[0].content); return { status: 'success', content: '{"result": "relevant", "confidence": 0.6, "reason": "ok"}', attempts: [] }; },
        getBudgetAuxiliar: (p: 'classificacao' | 'validacao') => getBudgetAuxiliar(p, null, null),
    } as any;
    const v = new StepSemanticValidator(f);
    // Passo cuja descrição não casa com o resultado por palavra-chave → força o caminho do LLM.
    const passo = { id: 'step_3', description: 'Gerar o banco de questões', toolName: undefined, toolArgs: {} } as unknown as PlanStep;
    const FIM = 'Questão S18 — inodes com indireção dupla (gabarito: C)';
    const resultado = 'linha do documento gerado com conteúdo variado. '.repeat(60) + FIM;
    const PEDIDO_FIM = 'e no final inclua o gabarito comentado de cada questão';
    const pedido = 'Preciso de questões ENADE de Compiladores, Teoria da Computação e Sistemas Operacionais para meus alunos, '.repeat(2) + PEDIDO_FIM;

    console.log('\n=== S361-1 — o LLM vê o resultado inteiro e o pedido inteiro ===');
    await quiet(() => v.validate(passo, resultado, pedido));
    const p = prompts[0] ?? '';
    assert(prompts.length === 1, `o caminho do LLM foi usado (${prompts.length} chamada)`);
    assert(p.includes(resultado) && p.includes(FIM), `resultado inteiro no prompt (${resultado.length} chars; antes: 600 escolhidos por palavra-chave)`);
    assert(p.includes(pedido) && p.includes(PEDIDO_FIM), `pedido inteiro (${pedido.length} chars; antes: 200)`);
    assert(!/truncado a 600/.test(p), 'o prompt não anuncia mais "truncado a 600 chars"');

    console.log('\n=== S361-2 — acima do teto: não avaliável, sem chamar o LLM ===');
    const antes = prompts.length;
    const enorme = 'x'.repeat(DECISION_PROMPT_MAX_CHARS + 1000);
    const r = await quiet(() => v.validate(passo, enorme, pedido));
    assert(prompts.length === antes, 'o LLM não foi chamado com um pedaço do resultado');
    assert(r.result === 'unverifiable' && !r.shouldDowngradeToPartial && !r.shouldPromoteToConfidentSuccess, `resultado "unverifiable" — não rebaixa nem promove (${r.reason})`);

    console.log('\n=== S361-3 — a seleção por palavra-chave saiu; o teto é a fonte única ===');
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'StepSemanticValidator.ts'), 'utf-8');
    assert(!/extractRelevantSnippet/.test(src), 'extractRelevantSnippet removida');
    assert(/import \{ DECISION_PROMPT_MAX_CHARS \} from '\.\.\/core\/providerTypes'/.test(src), 'usa o teto compartilhado (providerTypes)');
    const obs = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'ObserverValidator.ts'), 'utf-8');
    assert(/const GROUNDING_MAX_PROMPT_CHARS = DECISION_PROMPT_MAX_CHARS;/.test(obs), 'o juiz usa o mesmo teto (sem cópia do número)');

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S361 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}
main().catch((err) => { console.error('S361 erro inesperado:', err); process.exitCode = 1; });
