/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S118
 *
 * ARCH-016 (docs/refatoracao-arquitetural-2026/ARCHITECTURAL_BACKLOG.md): os 4 blocos de detecção de loop em
 * `GoalPlanner.buildReplanPrompt()` (pip/venv, exec_command, stuck-in-analysis, content_stub)
 * passam a gerar texto via `buildLoopDirective()`, uma função de formatação compartilhada.
 * Só o bloco `exec_command` também ganhou uma fonte de dados estruturada adicional
 * (`StrategyDiversityGuard.extractExhaustedTools()`, aditiva ao count de blockers original) —
 * os outros 3 detectam categoria de blocker/ação, não "tool falhou N vezes", então
 * `extractExhaustedTools()` não se aplica a eles (ver docs/issues/006).
 *
 * Este teste dirige `GoalPlanner.replan()` de verdade (não reimplementa a lógica) com um
 * provider LLM fake que só captura o prompt final — confirma que cada um dos 4 cenários
 * dispara a diretiva certa no texto realmente enviado ao LLM.
 *
 * Execução: npx ts-node src/__tests__/regression/S118_GoalPlanner_LoopDirectivesSharedTemplate.test.ts
 */

process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import { GoalPlanner } from '../../loop/GoalPlanner';
import { Goal, GoalBlocker } from '../../loop/GoalTypes';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

function makeFakePlanner(): { planner: GoalPlanner; capturedPrompt: { value: string } } {
    const captured = { value: '' };
    let calls = 0;
    const fakeProviderFactory = {
        getProviderWithModel: () => ({
            chat: async (messages: Array<{ content: string }>) => {
                calls++;
                // Só captura a PRIMEIRA chamada — um retorno com steps=[] dispara
                // retryWithMinimalPrompt() (2ª chamada, prompt minimalista sem as diretivas de
                // loop), que sobrescreveria o prompt real que este teste quer inspecionar.
                if (calls === 1) captured.value = messages[0]?.content ?? '';
                return { content: JSON.stringify({ steps: [{ id: 'step_1', description: 'passo de teste', toolName: 'read', toolArgs: { path: 'a.txt' } }], strategy: 'teste S118' }) };
            },
        }),
    } as any;
    const fakeReflectionMemory = {
        findBlockerLessons: () => '',
        findHardConstraints: () => [],
    } as any;
    const planner = new GoalPlanner(fakeProviderFactory, fakeReflectionMemory);
    return { planner, capturedPrompt: captured };
}

function makeGoal(overrides: Partial<Goal>): Goal {
    const now = Date.now();
    return {
        id: 'goal_s118', sessionKey: 'test:s118', conversationId: 'test-conv-s118',
        userIntent: 'objetivo de teste S118', objective: 'Objetivo de teste S118',
        status: 'blocked', currentPlan: [], attempts: [], blockers: [],
        toolsTried: [], strategiesTried: [], successCriteria: [], sentArtifacts: [],
        retryBudget: 3, replanBudget: 5, confidence: 0.9,
        requiresAuth: false, authorizationScope: [],
        createdAt: now, updatedAt: now, expiresAt: now + 3_600_000,
        ...overrides,
    } as Goal;
}

function blocker(kind: GoalBlocker['kind'], description = 'blocker de teste', toolName?: string): GoalBlocker {
    return { kind, description, toolName, suggestedActions: [], detectedAt: Date.now() };
}

async function main() {

console.log('\n=== S118.1 — CENÁRIO pip/venv: 2+ blockers environment_limit com texto pip/venv ===');
{
    const { planner, capturedPrompt } = makeFakePlanner();
    const goal = makeGoal({
        blockers: [
            blocker('environment_limit', 'pip install falhou: externally-managed-environment (PEP 668)'),
            blocker('environment_limit', 'python3 -m venv falhou: ensurepip not available'),
        ],
    });
    await planner.replan(goal, goal.blockers[goal.blockers.length - 1]);
    assert(capturedPrompt.value.includes('⛔ LOOP DETECTADO (2 tentativas pip/venv falharam):'), 'diretiva pip/venv presente com contagem correta', capturedPrompt.value.slice(0, 200));
    assert(capturedPrompt.value.includes('  1. python3 -c "import zipfile'), 'formatação numerada (1./2./3.) presente via buildLoopDirective', capturedPrompt.value);
}

console.log('\n=== S118.2 — CENÁRIO exec_command: 2+ blockers com toolName=exec_command ===');
{
    const { planner, capturedPrompt } = makeFakePlanner();
    const goal = makeGoal({
        blockers: [
            blocker('tool_error', 'exec_command falhou: comando não encontrado', 'exec_command'),
            blocker('tool_error', 'exec_command falhou de novo', 'exec_command'),
        ],
    });
    await planner.replan(goal, goal.blockers[goal.blockers.length - 1]);
    assert(capturedPrompt.value.includes('⛔ exec_command BLOQUEADO (2 falhas neste goal):'), 'diretiva exec_command presente com contagem correta', capturedPrompt.value.slice(0, 300));
    assert(capturedPrompt.value.includes('  • Para gerar HTML/slides:'), 'formatação com marcador (•) presente via buildLoopDirective', capturedPrompt.value);
}

console.log('\n=== S118.2b — exec_command via fonte estruturada aditiva: attempts com result=failure, sem blockers com toolName ===');
{
    const { planner, capturedPrompt } = makeFakePlanner();
    const now = Date.now();
    const goal = makeGoal({
        blockers: [blocker('goal_incomplete', 'objetivo não atingido')],
        attempts: [
            { id: 'a1', planStepId: 's1', toolName: 'exec_command', args: {}, result: 'failure', durationMs: 10, executedAt: now },
            { id: 'a2', planStepId: 's2', toolName: 'exec_command', args: {}, result: 'failure', durationMs: 10, executedAt: now },
        ],
    });
    await planner.replan(goal, goal.blockers[goal.blockers.length - 1]);
    assert(
        capturedPrompt.value.includes('⛔ exec_command BLOQUEADO (2 falhas neste goal):'),
        'fonte estruturada (StrategyDiversityGuard.extractExhaustedTools) dispara a diretiva mesmo sem 2 blockers com toolName=exec_command, com contagem correta (via attempts, não 0)',
        capturedPrompt.value.slice(0, 300)
    );
}

console.log('\n=== S118.3 — CENÁRIO stuck-in-analysis: blocker goal_incomplete prévio + estratégias só de análise ===');
{
    const { planner, capturedPrompt } = makeFakePlanner();
    const goal = makeGoal({
        blockers: [blocker('goal_incomplete', 'objetivo não atingido na tentativa anterior')],
        strategiesTried: ['Analisar a estrutura do projeto', 'Mapear as dependências existentes'],
    });
    await planner.replan(goal, goal.blockers[0]);
    assert(capturedPrompt.value.includes('ALERTA: LOOP DE ANÁLISE DETECTADO'), 'diretiva stuck-in-analysis presente', capturedPrompt.value.slice(0, 300));
    assert(capturedPrompt.value.includes('  1. NÃO planeje mais steps somente de read'), 'formatação numerada presente via buildLoopDirective', capturedPrompt.value);
}

console.log('\n=== S118.4 — CENÁRIO content_stub: blocker atual é content_stub ===');
{
    const { planner, capturedPrompt } = makeFakePlanner();
    const goal = makeGoal({ blockers: [] });
    const currentBlocker = blocker('content_stub', 'write gravou placeholder em vez de conteúdo real');
    await planner.replan(goal, currentBlocker);
    assert(capturedPrompt.value.includes('⚠️ ERRO DE CONTEÚDO PLACEHOLDER'), 'diretiva content_stub presente', capturedPrompt.value.slice(0, 300));
    assert(capturedPrompt.value.includes('  1. NÃO use toolName="write"'), 'formatação numerada presente via buildLoopDirective', capturedPrompt.value);
    assert(capturedPrompt.value.includes('  3. Padrão CORRETO:\n     {"id":"step_2"'), 'item multi-linha (continuação indentada) preservado exatamente', capturedPrompt.value);
}

console.log('\n=== S118.5 — NENHUM cenário de loop: nenhuma das 4 diretivas aparece no prompt ===');
{
    const { planner, capturedPrompt } = makeFakePlanner();
    const goal = makeGoal({ blockers: [], strategiesTried: [] });
    await planner.replan(goal, blocker('context_insufficient', 'falta de contexto pontual'));
    assert(!capturedPrompt.value.includes('LOOP DETECTADO'), 'sem diretiva pip/venv quando não há loop', capturedPrompt.value.slice(0, 200));
    assert(!capturedPrompt.value.includes('exec_command BLOQUEADO'), 'sem diretiva exec_command quando não há loop');
    assert(!capturedPrompt.value.includes('LOOP DE ANÁLISE'), 'sem diretiva stuck-in-analysis quando não há loop');
    assert(!capturedPrompt.value.includes('CONTEÚDO PLACEHOLDER'), 'sem diretiva content_stub quando não há loop');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S118 RESULTADO: ${passed} passou | ${failed} falhou`);
process.exit(failed > 0 ? 1 : 0);

}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
