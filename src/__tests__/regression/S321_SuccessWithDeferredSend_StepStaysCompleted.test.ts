/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S321 (issue 050)
 *
 * Achado na validação real da issue 049 (04/10/2026): um step `agentloop` concluído com sucesso,
 * que tinha agendado o envio de um arquivo (deferred send), rodou DE NOVO no ciclo seguinte (mais
 * 231 s). Causa: `handleSuccessOutcome()` chama `markStepDone()` — que grava o step como 'completed'
 * no store — e em seguida a injeção dos sends diferidos regrava `currentPlan` a partir do objeto
 * `goal` ANTERIOR, em que o step ainda estava 'pending'. Em produção (30 dias): 4 goals com um step
 * agentloop concluído mais de uma vez, um deles com o PDF entregue duas vezes.
 *
 * REGRESSÃO SE: depois de um sucesso com deferred send, o step voltar a 'pending' no store.
 *
 * Execução: npx ts-node src/__tests__/regression/S321_SuccessWithDeferredSend_StepStaysCompleted.test.ts
 */

import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';
import type { Goal, PlanStep, CycleResult } from '../../loop/GoalTypes';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

/** Store em memória com a mesma semântica do GoalStore: update grava, getById devolve cópia nova. */
function makeStore(initial: Goal) {
    let stored: Goal = JSON.parse(JSON.stringify(initial));
    return {
        getById: (_id: string) => JSON.parse(JSON.stringify(stored)) as Goal,
        update: (_id: string, patch: Partial<Goal>) => { stored = { ...stored, ...JSON.parse(JSON.stringify(patch)) }; },
        addAttempt: () => {},
        get current() { return stored; },
    };
}

function makeLoop(store: ReturnType<typeof makeStore>): GoalExecutionLoop {
    const loop = Object.create(GoalExecutionLoop.prototype) as GoalExecutionLoop;
    (loop as any).goalStore = store;
    (loop as any).reflectionMemory = { record: () => {} };
    (loop as any).capRegistry = { invalidate: () => {} };
    (loop as any).updateCognitiveContext = () => {};
    (loop as any).updateProgressModel = () => {};
    return loop;
}

async function runSuccess(deferredSends?: Array<Record<string, unknown>>) {
    const step2: PlanStep = { id: 'step_2', description: 'Gravar resumo.md e explicar', status: 'pending', fallbackSteps: [] } as unknown as PlanStep;
    const step3: PlanStep = { id: 'step_3', description: 'Explicar cada valor', status: 'pending', fallbackSteps: [] } as unknown as PlanStep;
    const goal = {
        id: 'goal_s321', userIntent: 'pedido', objective: 'objetivo', planGeneration: 0,
        currentPlan: [{ id: 'step_1', status: 'completed' }, step2, step3],
        attempts: [{ planStepId: 'step_2', toolName: 'agentloop', result: 'success', output: 'ok' }],
    } as unknown as Goal;
    const store = makeStore(goal);
    const loop = makeLoop(store);
    const cycleResult: CycleResult = { outcome: 'success', confidence: 0.8, output: 'resumo gravado', deferredSends };
    const handled = await (loop as any).handleSuccessOutcome(
        store.getById(goal.id), step2, cycleResult, 3, 0, undefined,
        { cognitiveContext: {}, progressModel: {} }, new Set<string>(), () => {}, new Map(), undefined,
    );
    return { store, handled };
}

async function main(): Promise<void> {

console.log('\n=== S321-1 — sucesso COM deferred send: o step continua completed e o send entra como pendente ===');
{
    const { store, handled } = await runSuccess([{ file_path: 'resumo_seguranca.md' }]);
    const plan = store.current.currentPlan;
    const s2 = plan.find(s => s.id === 'step_2');
    assert(s2?.status === 'completed', 'step_2 permanece completed no store (não volta a pending)', s2);
    const sends = plan.filter(s => s.toolName === 'send_document');
    assert(sends.length === 1 && sends[0].status === 'pending', 'o send diferido foi injetado como step pendente', sends);
    assert((sends[0] as PlanStep & { originStepId?: string }).originStepId === 'step_2', 'o send aponta para o step de origem', sends[0]);
    const pending = plan.filter(s => s.status === 'pending').map(s => s.id);
    assert(!pending.includes('step_2') && pending.includes('step_3'), 'próximos pendentes: step_3 e o send — step_2 não roda de novo', pending);
    assert(handled.goal.currentPlan.find((s: PlanStep) => s.id === 'step_2')?.status === 'completed', 'o goal devolvido ao laço também vê step_2 completed', handled.goal.currentPlan);
}

console.log('\n=== S321-2 — controle: sucesso SEM deferred send continua marcando completed ===');
{
    const { store } = await runSuccess(undefined);
    assert(store.current.currentPlan.find(s => s.id === 'step_2')?.status === 'completed', 'step_2 completed', store.current.currentPlan);
    assert(!store.current.currentPlan.some(s => s.toolName === 'send_document'), 'nenhum send injetado');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S321 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
    console.error('S321 erro inesperado:', err);
    process.exitCode = 1;
});
