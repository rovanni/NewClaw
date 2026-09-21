/**
 * Fixture compartilhada (issue 022) — o invariante de produção que os testes de
 * `OperationalKnowledge.captureFromGoal()` precisam respeitar ao montar um `Goal` à mão.
 *
 * INVARIANTE: em produção, todo blocker `missing_tool` é produzido por `GoalEvaluator.classifyError`
 * (único chamador: `evaluate()`), e todo `evaluate()` do `GoalExecutionLoop` vem DEPOIS de um
 * attempt `'failure'` gravado (`recordFailedAttempt` ou o attempt principal de `dispatchToolStep`).
 * Logo, o fracasso que originou o blocker é sempre o primeiro attempt falho do goal — e é ele a
 * âncora posicional de `captureFromGoal()` (ADR-009 C1).
 *
 * Um goal montado com blocker `missing_tool` e SÓ attempts de sucesso descreve um estado que a
 * produção não alcança. `captureFromGoal()` deixou de aceitá-lo (não aprende sem âncora), e os
 * testes que dependiam desse estado — S142/S143 — passam a construir o goal como a produção o faz.
 *
 * Módulo-folha: importado pelos testes, não importa nenhum deles. Não termina em `.test.ts`, então
 * o runner de regressão não o executa.
 */
import type { Goal, GoalAttempt } from '../../../shared/domainTypes';

/**
 * Devolve o goal com o fracasso-âncora como PRIMEIRO attempt, quando ele tem blocker `missing_tool`
 * e nenhum attempt falho. Não altera goals que já têm um fracasso registrado (nem os sem blocker).
 */
export function withFailureAnchor(goal: Goal): Goal {
    const blocker = goal.blockers.find(b => b.kind === 'missing_tool');
    if (!blocker) return goal;
    if (goal.attempts.some(a => a.result !== 'success')) return goal;

    const anchor: GoalAttempt = {
        id: 'att_anchor_failure',
        planStepId: 'step_anchor_failure',
        toolName: blocker.toolName ?? 'exec_command',
        args: {},
        result: 'failure',
        error: `spawn ${blocker.missingDependency ?? 'desconhecido'} ENOENT`,
        durationMs: 10,
        executedAt: blocker.detectedAt,
    };
    return { ...goal, attempts: [anchor, ...goal.attempts] };
}
