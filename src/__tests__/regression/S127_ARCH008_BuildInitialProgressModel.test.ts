/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S127 (ARCH-008, Sprint S17/reabertura, 2026-07-19)
 *
 * ARCH-008 corrigiu `runLoop()` (ponto de entrada compartilhado por `executeGoal()`/
 * `resumeGoal()`) para não zerar `state.progressModel` quando um goal já tem progresso real.
 * Antes desta correção, `resumeGoal()` — chamado toda vez que `GoalOrchestrator.resumeFromAuth()`
 * aprova uma ação perigosa pendente — sempre recebia `progressModel={components:[],
 * overallPercent:0}`, mesmo quando `goal.currentPlan` já tinha steps `'completed'`.
 *
 * Consequência real, não só cosmética: `state.progressModel.overallPercent` alimenta a lógica
 * de "bonus replan" (`ADAPTIVE-BUDGET`, `GoalExecutionLoop.ts` ~linha 1413) — um goal que esgota
 * `replanBudget` mas já tem >=60% de progresso real ganha +1 replan focado nos componentes
 * pendentes, em vez de reiniciar do zero. Com o bug, todo goal retomado via `resumeGoal()`
 * perdia esse bônus, porque `overallPercent` sempre lia 0%.
 *
 * `buildInitialProgressModel()` (novo) deriva de `PlanStep.status`/`PlanStep.lastAttemptOutcome`
 * (ARCH-007, S13 — sinal restart-safe já persistido, não re-escaneia `goal.attempts` do zero).
 *
 * Execução: npx ts-node src/__tests__/regression/S127_ARCH008_BuildInitialProgressModel.test.ts
 */

import Database from 'better-sqlite3';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';
import { GoalStore } from '../../loop/GoalStore';
import { ToolRegistry } from '../../core/ToolRegistry';
import { Goal, PlanStep } from '../../loop/GoalTypes';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

function makeLoop(): GoalExecutionLoop {
    const db = new (Database as any)(':memory:');
    const goalStore = new GoalStore(db);
    const fakeMemory = { getDatabase: () => db } as any;
    const fakePlanner = { getAvailableSkills: () => [], setSkillContext: () => {}, setModel: () => {}, replan: async () => ({ steps: [], strategy: 'n/a' }) } as any;
    const fakeAgentLoop = { process: async () => '' } as any;
    const fakeProviderFactory = {} as any;
    return new GoalExecutionLoop(
        fakeAgentLoop, goalStore, fakePlanner,
        { record: () => {}, buildContextHint: () => '', findHardConstraints: () => [] } as any,
        ToolRegistry, fakeProviderFactory, fakeMemory,
        { findApplicableCasesShadow: async () => [], backfillMissingEmbeddings: async () => {}, captureIfEligible: () => {}, findSimilarShadow: () => [] } as any,
    );
}

function makeGoalFixture(currentPlan: PlanStep[]): Goal {
    return {
        id: 'goal_s127', sessionKey: 'test:s127', conversationId: 'test-conv-s127',
        userIntent: 'teste', objective: 'teste', status: 'executing',
        attempts: [], blockers: [], toolsTried: [], strategiesTried: [],
        successCriteria: [], sentArtifacts: [], retryBudget: 3, replanBudget: 5, confidence: 0.9,
        requiresAuth: false, authorizationScope: [], expiresAt: Date.now() + 3_600_000,
        currentPlan, createdAt: Date.now(), updatedAt: Date.now(),
    } as Goal;
}

async function main() {
    console.log('\n=== S127.1 — goal novo (todos os steps pending, sem lastAttemptOutcome): components=[], overallPercent=0 ===');
    {
        const loop = makeLoop();
        const goal = makeGoalFixture([
            { id: 's1', description: 'Primeiro step', status: 'pending', fallbackSteps: [] },
            { id: 's2', description: 'Segundo step', status: 'pending', fallbackSteps: [] },
        ]);
        const model = (loop as any).buildInitialProgressModel(goal);
        assert(model.components.length === 0, `components=[] para goal novo — obtido: ${model.components.length}`, model);
        assert(model.overallPercent === 0, `overallPercent=0 para goal novo — obtido: ${model.overallPercent}`, model);
    }

    console.log('\n=== S127.2 — 1 step completed + 1 pending sem attempt: componente completed presente, overallPercent=50 ===');
    {
        const loop = makeLoop();
        const goal = makeGoalFixture([
            { id: 's1', description: 'Passo já concluído', status: 'completed', executedAt: 1700000000000, fallbackSteps: [] },
            { id: 's2', description: 'Passo ainda pendente', status: 'pending', fallbackSteps: [] },
        ]);
        const model = (loop as any).buildInitialProgressModel(goal);
        assert(model.components.length === 1, `1 componente (só o step completed — pending sem attempt não entra) — obtido: ${model.components.length}`, model);
        assert(model.components[0]?.status === 'completed', `componente com status 'completed' — obtido: ${model.components[0]?.status}`, model);
        assert(model.components[0]?.id === 'step_s1', `id do componente = 'step_s1' (mesmo formato de updateProgressModel) — obtido: ${model.components[0]?.id}`, model);
        assert(model.overallPercent === 50, `overallPercent=50 (1 completed / (1 completed + 1 pending)) — obtido: ${model.overallPercent}`, model);
    }

    console.log('\n=== S127.3 — 1 step completed + 1 pending COM lastAttemptOutcome (retry pendente): componente in_progress ===');
    {
        const loop = makeLoop();
        const goal = makeGoalFixture([
            { id: 's1', description: 'Passo já concluído', status: 'completed', executedAt: 1700000000000, fallbackSteps: [] },
            { id: 's2', description: 'Passo com tentativa parcial anterior', status: 'pending', lastAttemptOutcome: 'partial', fallbackSteps: [] },
        ]);
        const model = (loop as any).buildInitialProgressModel(goal);
        assert(model.components.length === 2, `2 componentes (completed + in_progress) — obtido: ${model.components.length}`, model);
        const inProgress = model.components.find((c: any) => c.id === 'step_s2');
        assert(inProgress?.status === 'in_progress', `componente do step com lastAttemptOutcome='partial' vira 'in_progress' — obtido: ${inProgress?.status}`, inProgress);
    }

    console.log('\n=== S127.4 — este é o cenário real do bug: goal quase pronto (3 de 4 completed) preserva >=60% de progresso ===');
    {
        const loop = makeLoop();
        const goal = makeGoalFixture([
            { id: 's1', description: 'Passo 1', status: 'completed', executedAt: 1700000000000, fallbackSteps: [] },
            { id: 's2', description: 'Passo 2', status: 'completed', executedAt: 1700000001000, fallbackSteps: [] },
            { id: 's3', description: 'Passo 3', status: 'completed', executedAt: 1700000002000, fallbackSteps: [] },
            { id: 's4', description: 'Passo 4 aguardando aprovação', status: 'pending', fallbackSteps: [] },
        ]);
        const model = (loop as any).buildInitialProgressModel(goal);
        assert(
            model.overallPercent >= 60,
            `overallPercent >= 60 (3/4=75%) — precondição real do bônus de replan (ADAPTIVE-BUDGET, GoalExecutionLoop.ts ~1413), quebrada ANTES desta correção (sempre lia 0%) — obtido: ${model.overallPercent}`,
            model
        );
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S127 RESULTADO: ${passed} passou | ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
