/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S337 (issue 058)
 *
 * 06/10/2026, instância isolada: "Quantos itens tem a lista do arquivo anexo? Responda só o número." A etapa do agente
 * respondeu "3" — correto —, mas `evaluateAgentStepSuccess` tratava toda resposta com menos de 15 caracteres como
 * vazia: a tentativa virou failure ("Erro em 'unknown': 3") e o goal girou 10 ciclos e 4 replans (~10 min) até falhar.
 * Agora só resposta VAZIA é falha estrutural; se uma resposta curta atende é pergunta do StepSemanticValidator.
 *
 * REGRESSÃO SE: resposta curta não vazia voltar a ser falha; ou o validador semântico passar a rebaixar saída curta
 * sem consultar ninguém.
 *
 * Execução: npx ts-node src/__tests__/regression/S337_ShortCorrectAnswer_IsNotEmptyResponse.test.ts
 */
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';
import { StepSemanticValidator } from '../../loop/StepSemanticValidator';
import type { PlanStep } from '../../loop/GoalTypes';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const loop = Object.create(GoalExecutionLoop.prototype) as GoalExecutionLoop;
const step = { id: 'step_2', description: 'Contar os itens da lista e responder só o número' } as PlanStep;
// Sem valor padrão no parâmetro: undefined precisa chegar como undefined (regra "sem observação").
const evaluate = (r: string, ...failures: [Array<{ tool: string }> | undefined] | []) =>
    (loop as any).evaluateAgentStepSuccess(step, r, failures.length === 0 ? [] : failures[0]);

async function main(): Promise<void> {

console.log('\n=== S337-1 — respostas curtas e corretas não são "vazias" ===');
for (const r of ['3', 'sim', 'R$ 42', '127 V', 'Não.']) {
    const e = evaluate(r);
    assert(e.success === true && e.reason !== 'empty_response', `"${r}" → success (${e.reason})`, e);
}

console.log('\n=== S337-2 — resposta realmente vazia continua falha estrutural ===');
for (const r of ['', '   ', '\n\t ']) {
    const e = evaluate(r);
    assert(e.success === false && e.reason === 'empty_response', `${JSON.stringify(r)} → empty_response`, e);
}

console.log('\n=== S337-3 — as demais regras seguem iguais ===');
assert(evaluate('3', [{ tool: 'exec_command' }]).confidence === 0.55, 'falha de ferramenta → sucesso não confiante (0.55)');
assert(evaluate('3', undefined).confidence === 0.70, 'sem observação → 0.70');
assert(evaluate('3', []).confidence === 0.80, 'sem falhas → 0.80');

console.log('\n=== S337-4 — o validador semântico não rebaixa saída curta (fica com o LLM / não verificável) ===');
{
    let llmCalls = 0;
    const v = new StepSemanticValidator({ chatWithFallback: async () => { llmCalls++; return { status: 'success', content: '{"result":"relevant","confidence":0.9}', attempts: [] }; } } as any);
    const r = await v.validate(step, '3', 'Quantos itens tem a lista? Responda só o número.');
    assert(r.shouldDowngradeToPartial === false, '"3" não é rebaixado', r);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S337 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
}

main().catch((err) => { console.error('S337 erro inesperado:', err); process.exitCode = 1; });
