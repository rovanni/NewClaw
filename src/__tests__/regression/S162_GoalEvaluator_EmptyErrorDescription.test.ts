/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S162
 * GoalEvaluator.classifyError(): blocker com descrição vazia quando error/output também
 * vêm vazios de um step 'agentloop'
 *
 * INCIDENTE REAL (newclaw-audit.log, 2026-07-29 23:22:35, goal_1785377727278_guufa):
 * um step dispatchado como AgentLoop (hybrid) terminou sem produzir texto final utilizável —
 * a síntese pós-ação falhou em extrair texto ("[SYNTHESIS] Failed to extract useful text",
 * raw=19205, extracted=0), o FALLBACK de síntese que rodou em seguida aparentemente também
 * não produziu texto extraível, e `lastBestContent` estava vazio (o turno só teve tool-calls,
 * nenhuma resposta narrativa no meio). O `toolResult` que chegou em
 * `GoalExecutionLoop.executeAgentLoopStep()` acabou como `{ success: false, output: '' }`.
 *
 * `GoalEvaluator.evaluate()` monta `toolName = planStep.toolName ?? 'unknown'` (undefined
 * pra um step hybrid sem toolName fixo) e `error = toolResult.error ?? toolResult.output ?? ''`
 * — com AMBOS vazios, `classifyError()` caía no fallback genérico
 * `Erro em '${toolName}': ${error.slice(0,200)}`, produzindo literalmente
 * `"Erro em 'unknown': "` — um blocker sem NENHUM sinal útil pro GoalPlanner decidir a próxima
 * estratégia no replan (o replan que seguiu, cycle=2, teve `root_cause=tool_error` e
 * `blocker_desc="Erro em 'unknown': "` — informação zero repassada à LLM do replanner).
 *
 * FIX: classifyError() agora detecta explicitamente error/output vazios ANTES do fallback
 * genérico e retorna uma descrição que nomeia a causa provável (falha silenciosa a montante,
 * ex.: extração de síntese) em vez de um sufixo vazio.
 *
 * REGRESSÃO SE: um error/output vazio voltar a produzir "Erro em '...': " (sufixo vazio) em
 * vez da descrição explicativa nova.
 *
 * Execução: npx ts-node src/__tests__/regression/S162_GoalEvaluator_EmptyErrorDescription.test.ts
 */

import { GoalEvaluator } from '../../loop/GoalEvaluator';
import { Goal, PlanStep } from '../../loop/GoalTypes';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

function makeGoal(): Goal {
    const now = Date.now();
    return {
        id: 'goal_s162',
        sessionKey: 'web:conv_s162',
        conversationId: 'conv_s162',
        userIntent: 'teste S162',
        objective: 'teste S162',
        status: 'executing',
        currentPlan: [],
        attempts: [],
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

function makeStep(over: Partial<PlanStep>): PlanStep {
    return {
        id: 'step_1',
        description: 'Escrever o arquivo HTML da lista de exercícios',
        status: 'pending',
        ...over,
    } as PlanStep;
}

async function main() {
    const evaluator = new GoalEvaluator();

    console.log('\n=== S162 — reprodução exata do incidente: step agentloop sem toolName, output vazio ===');
    {
        const goal = makeGoal();
        const step = makeStep({ toolName: undefined });
        const result = evaluator.evaluate(goal, step, { success: false, output: '' });

        assert(result.outcome === 'blocked', `outcome=blocked (obtido: ${result.outcome})`);
        assert(result.blocker?.kind === 'tool_error', `blocker.kind=tool_error (obtido: ${result.blocker?.kind})`);
        assert(
            result.blocker?.description !== "Erro em 'unknown': ",
            `descrição NÃO é o sufixo vazio antigo (obtido: "${result.blocker?.description}")`
        );
        assert(
            (result.blocker?.description?.length ?? 0) > 20,
            `descrição tem conteúdo substantivo, não vazia (obtido: "${result.blocker?.description}")`
        );
        assert(
            !!result.blocker?.description?.includes('falha silenciosa'),
            'descrição nomeia a causa provável (falha silenciosa a montante)'
        );
    }

    console.log('\n=== S162 — não regride: error com texto real continua sendo classificado normalmente ===');
    {
        const goal = makeGoal();
        const step = makeStep({ toolName: 'exec_command' });
        const result = evaluator.evaluate(goal, step, { success: false, output: '', error: "wc : O termo 'wc' não é reconhecido" });
        assert(result.outcome === 'blocked', `outcome=blocked com error real (obtido: ${result.outcome})`);
        assert(
            !!result.blocker?.description && result.blocker.description.length > 0,
            `descrição não vazia quando há error real (obtido: "${result.blocker?.description}")`
        );
        assert(
            !result.blocker?.description.includes('falha silenciosa'),
            'NÃO usa a mensagem de "falha silenciosa" quando há error real (só se aplica a error/output vazios)'
        );
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S162 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    console.log(`\nCOBERTURA:`);
    console.log(`  Reprodução do incidente (toolName undefined, output vazio): testado`);
    console.log(`  Não regride caso com error real: testado`);
    if (failed > 0) process.exit(1);
}

main();
