/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S116
 *
 * ARCH-006 (docs/refatoracao-arquitetural-2026/ARCHITECTURAL_BACKLOG.md): `GoalExecutionLoop` recomputava
 * `.filter(s => s.status === 'pending')` (às vezes combinado com `s.toolName === X` ou
 * `rule.requiredTools.includes(s.toolName)`) em 15 pontos independentes do arquivo — nenhum
 * bug funcional isolado, mas 15 fontes do mesmo conceito "step pendente" sem garantia de que
 * uma mudança de critério (ex: um novo status intermediário) fosse aplicada nos 15 ao mesmo
 * tempo. `getPendingSteps(plan, toolName?)` é agora o único ponto.
 *
 * Este teste cobre o contrato do accessor isoladamente (sem precisar rodar o loop completo):
 * sem toolName retorna todos os pending; com toolName (string) filtra por igualdade; com
 * toolName (string[]) filtra por pertencimento (caso `checkClaimsAgainstEvidence`, que usa
 * `rule.requiredTools`); nunca inclui steps 'completed'/'skipped'/'failed'/'executing'.
 *
 * Execução: npx ts-node src/__tests__/regression/S116_GetPendingSteps_SingleAccessor.test.ts
 */

import Database from 'better-sqlite3';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';
import { GoalStore } from '../../loop/GoalStore';
import { ToolRegistry } from '../../core/ToolRegistry';
import { PlanStep } from '../../loop/GoalTypes';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

function makeLoop() {
    const db = new (Database as any)(':memory:');
    const goalStore = new GoalStore(db);
    const fakeMemory = { getDatabase: () => db } as any;
    const fakePlanner = { getAvailableSkills: () => [], setSkillContext: () => {}, setModel: () => {}, replan: async () => ({ steps: [], strategy: 'n/a' }) } as any;
    const fakeAgentLoop = { process: async () => '' } as any;
    const fakeProviderFactory = { chatWithFallback: async () => ({ status: 'success', content: '{}' }), getProvider: () => undefined, getProviderWithModel: () => undefined } as any;
    return new GoalExecutionLoop(
        fakeAgentLoop, goalStore, fakePlanner,
        { record: () => {}, buildContextHint: () => '', findHardConstraints: () => [] } as any,
        ToolRegistry, fakeProviderFactory, fakeMemory,
        { findApplicableCasesShadow: async () => [], backfillMissingEmbeddings: async () => {}, captureIfEligible: () => {}, findSimilarShadow: () => [] } as any,
    );
}

function step(id: string, status: PlanStep['status'], toolName?: string): PlanStep {
    return { id, description: `step ${id}`, status, toolName, fallbackSteps: [] };
}

function main(): void {
    const loop = makeLoop() as any;

    console.log('\n=== S116.1 — sem toolName: retorna todos os pending, ignora outros status ===');
    {
        const plan = [
            step('1', 'pending'),
            step('2', 'completed'),
            step('3', 'pending', 'send_document'),
            step('4', 'failed'),
            step('5', 'skipped'),
            step('6', 'executing'),
        ];
        const result: PlanStep[] = loop.getPendingSteps(plan);
        assert(result.length === 2, `2 steps pending (obtido: ${result.length})`, result);
        assert(result.map(s => s.id).join(',') === '1,3', 'preserva a ordem original do plano', result);
    }

    console.log('\n=== S116.2 — toolName string: filtra por igualdade exata ===');
    {
        const plan = [
            step('1', 'pending', 'send_document'),
            step('2', 'pending', 'exec_command'),
            step('3', 'completed', 'send_document'),
        ];
        const result: PlanStep[] = loop.getPendingSteps(plan, 'send_document');
        assert(result.length === 1 && result[0].id === '1', `só o step 1 (pending + send_document) — obtido: ${result.map((s: PlanStep) => s.id)}`, result);
    }

    console.log('\n=== S116.3 — toolName string[]: filtra por pertencimento (caso checkClaimsAgainstEvidence) ===');
    {
        const plan = [
            step('1', 'pending', 'write'),
            step('2', 'pending', 'edit'),
            step('3', 'pending', 'send_document'),
        ];
        const result: PlanStep[] = loop.getPendingSteps(plan, ['write', 'edit']);
        assert(result.length === 2 && result.map((s: PlanStep) => s.id).join(',') === '1,2', `steps 1 e 2 (write/edit), não 3 (send_document) — obtido: ${result.map((s: PlanStep) => s.id)}`, result);
    }

    console.log('\n=== S116.4 — plano sem nenhum pending: retorna array vazio, não undefined ===');
    {
        const plan = [step('1', 'completed'), step('2', 'failed')];
        const result: PlanStep[] = loop.getPendingSteps(plan);
        assert(Array.isArray(result) && result.length === 0, `array vazio (obtido: ${JSON.stringify(result)})`, result);
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S116 RESULTADO: ${passed} passou | ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}

main();
