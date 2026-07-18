/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S120 (ARCH-010, Sprint 2026-08-S15)
 *
 * `GoalEvaluator.evaluate()` tinha o dedup "step+tool+args já falhou antes → bloquear
 * imediatamente" (Item 9) como um bloco `.some()` inline, comparando args via
 * `JSON.stringify` bruto. Extraído para o método nomeado `hasIdenticalFailedAttempt()`
 * (ARCH-010 — "respondido por consulta, não recomputação"), reusando `computeToolInputKey`
 * (já usado pelo dedup de `AgentLoop.usedToolInputs`, ver S90) em vez de `JSON.stringify` bruto
 * para computar a chave de comparação de args.
 *
 * S120-1/2 provam que a extração não mudou o comportamento no caso geral (mesmos args →
 * dedup; args diferentes → sem dedup) — regressão pura do refactor.
 *
 * S120-3/4 provam o efeito direto (não oportunista — é a definição de "computar o
 * args-hash corretamente" que o próprio ARCH-010 pede) de trocar para `computeToolInputKey`:
 * `send_document` agora dedupa por `file_path` (ignorando variação de legenda), corrigindo na
 * camada de `GoalEvaluator` a mesma classe de bug que `computeToolInputKey` já corrigiu na
 * camada de `AgentLoop` (S90) — antes, duas tentativas de `send_document` para o MESMO arquivo
 * com legendas cosmeticamente diferentes nunca acionavam o dedup (JSON diferente), permitindo
 * retries indefinidos do mesmo arquivo quebrado.
 *
 * Execução: npx ts-node src/__tests__/regression/S120_GoalEvaluator_HasIdenticalFailedAttempt.test.ts
 */

import { GoalEvaluator } from '../../loop/GoalEvaluator';
import { Goal, PlanStep, GoalAttempt } from '../../loop/GoalTypes';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

function makeGoal(attempts: GoalAttempt[]): Goal {
    const now = Date.now();
    return {
        id: 'goal_s120',
        sessionKey: 'telegram:1',
        conversationId: '1',
        userIntent: 'teste S120',
        objective: 'teste S120',
        status: 'executing',
        currentPlan: [],
        attempts,
        blockers: [],
        toolsTried: [],
        strategiesTried: [],
        successCriteria: [],
        retryBudget: 3,
        replanBudget: 3,
        confidence: 0.9,
        requiresAuth: false,
        authorizationScope: [],
        createdAt: now,
        updatedAt: now,
        expiresAt: now + 3600_000,
    };
}

function makeAttempt(over: Partial<GoalAttempt>): GoalAttempt {
    const now = Date.now();
    return {
        id: `att_${Math.random().toString(36).slice(2, 7)}`,
        planStepId: 'step1',
        toolName: 'exec_command',
        args: {},
        result: 'failure',
        durationMs: 10,
        executedAt: now,
        ...over,
    };
}

function makeStep(over: Partial<PlanStep>): PlanStep {
    return {
        id: 'step1',
        description: 'teste',
        status: 'pending',
        ...over,
    };
}

async function main(): Promise<void> {

console.log('\n=== S120-1 [regressão] — mesmos (step, tool, args) já falhou antes → dedup dispara (outcome=blocked, repeated_tool_call) ===');
{
    const evaluator = new GoalEvaluator();
    const goal = makeGoal([
        makeAttempt({ toolName: 'exec_command', args: { command: 'dir /nonexistent' } }),
    ]);
    const step = makeStep({ toolName: 'exec_command', toolArgs: { command: 'dir /nonexistent' } });
    const result = evaluator.evaluate(goal, step, { success: false, output: '', error: 'not found' });

    assert(result.outcome === 'blocked', `outcome é 'blocked' (dedup imediato) — obtido: ${result.outcome}`, result);
    assert(result.blocker?.kind === 'repeated_tool_call', `blocker.kind é 'repeated_tool_call' — obtido: ${result.blocker?.kind}`, result.blocker);
}

console.log('\n=== S120-2 [regressão] — args genuinamente diferentes NÃO disparam dedup ===');
{
    const evaluator = new GoalEvaluator();
    const goal = makeGoal([
        makeAttempt({ toolName: 'exec_command', args: { command: 'dir /a' } }),
    ]);
    const step = makeStep({ toolName: 'exec_command', toolArgs: { command: 'dir /b' } });
    const result = evaluator.evaluate(goal, step, { success: false, output: '', error: 'ECONNRESET simulado' });

    assert(result.blocker?.kind !== 'repeated_tool_call', `dedup NÃO dispara para args diferentes (command 'dir /a' vs 'dir /b') — blocker.kind obtido: ${result.blocker?.kind}`, result);
}

console.log("\n=== S120-3 [fix — efeito direto de computeToolInputKey] — send_document mesmo file_path, legenda diferente → dedup dispara ===");
{
    const evaluator = new GoalEvaluator();
    const goal = makeGoal([
        makeAttempt({ toolName: 'send_document', args: { file_path: 'aula.pptx', caption: 'Aqui está a aula!' } }),
    ]);
    const step = makeStep({ toolName: 'send_document', toolArgs: { file_path: 'aula.pptx', caption: 'Segue o arquivo solicitado, como pedido.' } });
    const result = evaluator.evaluate(goal, step, { success: false, output: '', error: 'upload failed' });

    assert(result.outcome === 'blocked' && result.blocker?.kind === 'repeated_tool_call',
        `dedup dispara para send_document com mesmo file_path e legenda diferente (ANTES do fix: JSON.stringify diferente, nunca deduplicava) — outcome=${result.outcome} blocker=${result.blocker?.kind}`,
        result);
}

console.log('\n=== S120-4 [controle] — send_document com file_path DIFERENTE (legenda também diferente) NÃO dispara dedup ===');
{
    const evaluator = new GoalEvaluator();
    const goal = makeGoal([
        makeAttempt({ toolName: 'send_document', args: { file_path: 'aula.pptx', caption: 'Aqui está a aula!' } }),
    ]);
    const step = makeStep({ toolName: 'send_document', toolArgs: { file_path: 'outro_arquivo.pptx', caption: 'Segue o outro arquivo.' } });
    const result = evaluator.evaluate(goal, step, { success: false, output: '', error: 'upload failed' });

    assert(result.blocker?.kind !== 'repeated_tool_call',
        `dedup NÃO dispara quando o file_path é genuinamente diferente — blocker.kind obtido: ${result.blocker?.kind}`,
        result);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S120 RESULTADO: ${passed} passou | ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S120 erro inesperado:', err);
    process.exitCode = 1;
});
