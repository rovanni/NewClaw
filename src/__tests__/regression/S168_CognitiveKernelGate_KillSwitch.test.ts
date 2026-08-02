/// <reference types="node" />
/**
 * S168 — CognitiveKernelGate: kill-switch (COGNITIVE_KERNEL_ENABLED=false, o default).
 *
 * Em processo separado de S167 (que roda com a flag ligada) porque ENABLED é lido uma única
 * vez no load do módulo — não dá para testar os dois estados no mesmo processo Node.
 *
 * Verifica: com a flag desligada (ou ausente — default), avaliarGoal() nunca invoca
 * goalKernelInstance.process() e sempre retorna {action:'proceed'}, mesmo para um goal que,
 * com a flag ligada, dispararia DEFER/ESCALATE (S167 já prova isso separadamente).
 */
import Database from 'better-sqlite3';
import { GoalStore } from '../../loop/GoalStore';
import type { Goal } from '../../loop/GoalTypes';

delete process.env.COGNITIVE_KERNEL_ENABLED;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const gateModule = require('../../loop/CognitiveKernelGate') as typeof import('../../loop/CognitiveKernelGate');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const adapterModule = require('newclaw-kernel-adapter') as typeof import('newclaw-kernel-adapter');

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${msg}`, detail ?? ''); failed++; }
}

function makeStore(): GoalStore {
    const db = new Database(':memory:');
    return new GoalStore(db as any);
}

function baseGoal(overrides: Partial<Goal>): Goal {
    const now = Date.now();
    return {
        id: `goal_${now}_test`,
        sessionKey: 'telegram:test-user',
        conversationId: 'conv-test',
        userIntent: 'fazer algo',
        objective: 'fazer algo',
        status: 'active',
        currentPlan: [],
        attempts: [],
        blockers: [],
        toolsTried: [],
        strategiesTried: [],
        successCriteria: [],
        retryBudget: 5,
        replanBudget: 3,
        confidence: 0.5,
        requiresAuth: true,
        authorizationScope: [],
        pendingTxnId: undefined,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + 60_000,
        completedAt: undefined,
        isConstruction: true, // combinado com requiresAuth:true, dispararia ESCALATE com a flag ligada (ver S167-4)
        sentArtifacts: [],
        ...overrides,
    } as Goal;
}

async function main(): Promise<void> {
    console.log('\n=== S168-1 — flag desligada: sempre {action: proceed}, mesmo para um goal que escalaria ===');
    {
        const store = makeStore();
        const goal = baseGoal({});
        let kernelCalled = false;
        const original = adapterModule.goalKernelInstance.process;
        (adapterModule.goalKernelInstance as any).process = (...args: unknown[]) => {
            kernelCalled = true;
            return original.apply(adapterModule.goalKernelInstance, args as any);
        };
        try {
            const result = await gateModule.avaliarGoal(goal, store);
            assert(result.action === 'proceed', 'com a flag desligada, action é sempre proceed', result);
            assert(kernelCalled === false, 'goalKernelInstance.process() nunca é chamado com a flag desligada');
        } finally {
            (adapterModule.goalKernelInstance as any).process = original;
        }
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(failed === 0 ? `✅ S168 passou (${passed} verificações)` : `❌ S168: ${failed} falha(s) de ${passed + failed}`);
    process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
    console.error('S168 erro inesperado:', err);
    process.exitCode = 1;
});
