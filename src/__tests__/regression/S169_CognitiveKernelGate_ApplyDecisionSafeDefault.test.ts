/// <reference types="node" />
/**
 * S169 — Incidente real (2026-07-31): DEFER/REQUEST_MORE_INFO aplicados de verdade
 * travavam o usuário em loop. GoalOrchestrator abandona o goal recém-criado e espera a
 * próxima mensagem reclassificar do zero — mas um goal novo nunca acumula blocker/histórico
 * entre tentativas, então o Kernel decide a MESMA coisa de novo, sempre. Visto ao vivo: duas
 * mensagens de goal legítimas em sequência, ambas travadas em "Vou aguardar mais contexto...".
 *
 * Fix: COGNITIVE_KERNEL_APPLY_DECISION=false (novo default) — o Kernel roda e loga a decisão
 * (útil como modo sombra em processo), mas o gate SEMPRE retorna {action:'proceed'}, com
 * COGNITIVE_KERNEL_ENABLED=true ou não. Este teste existe para que esse comportamento nunca
 * regrida silenciosamente — reproduz exatamente os goals de S167-2/S167-3/S167-4 (que
 * disparariam DEFER/REQUEST_MORE_INFO/ESCALATE com APPLY_DECISION=true) e confirma que, com o
 * default, todos viram {action:'proceed'}.
 */
import Database from 'better-sqlite3';
import { GoalStore } from '../../loop/GoalStore';
import type { Goal } from '../../loop/GoalTypes';

process.env.COGNITIVE_KERNEL_ENABLED = 'true';
delete process.env.COGNITIVE_KERNEL_APPLY_DECISION; // default — não setar é o caso real

// eslint-disable-next-line @typescript-eslint/no-var-requires
const gateModule = require('../../loop/CognitiveKernelGate') as typeof import('../../loop/CognitiveKernelGate');

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
        confidence: 0.85,
        requiresAuth: false,
        authorizationScope: [],
        pendingTxnId: undefined,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + 60_000,
        completedAt: undefined,
        isConstruction: false,
        sentArtifacts: [],
        ...overrides,
    } as Goal;
}

async function main(): Promise<void> {
    console.log('\n=== S169-1 — reprodução do incidente: goal ambíguo sem histórico (defer-shaped) ===');
    {
        const store = makeStore();
        const goal = baseGoal({ sessionKey: 'telegram:no-history', confidence: 0.5 });
        const result = await gateModule.avaliarGoal(goal, store);
        assert(result.action === 'proceed', 'com APPLY_DECISION no default (false), goal que defer-aria prossegue mesmo assim', result);
    }

    console.log('\n=== S169-2 — mesma repetição (2ª mensagem, mesmo formato) não trava de novo ===');
    {
        const store = makeStore();
        for (let i = 0; i < 3; i++) {
            const goal = baseGoal({ id: `goal_repeat_${i}`, sessionKey: 'telegram:repeat-user', confidence: 0.5 });
            const result = await gateModule.avaliarGoal(goal, store);
            assert(result.action === 'proceed', `tentativa ${i + 1}/3 prossegue (nunca trava em loop)`, result);
        }
    }

    console.log('\n=== S169-3 — goal que dispararia REQUEST_MORE_INFO também prossegue ===');
    {
        const store = makeStore();
        const goal = baseGoal({
            sessionKey: 'telegram:with-blocker',
            blockers: [{ kind: 'context_insufficient', description: 'faltou informação', suggestedActions: [], detectedAt: Date.now() }],
            retryBudget: 3,
        });
        const result = await gateModule.avaliarGoal(goal, store);
        assert(result.action === 'proceed', 'goal com blocker (dispararia ask_info) ainda prossegue no default', result);
    }

    console.log('\n=== S169-4 — goal que dispararia ESCALATE também prossegue ===');
    {
        const store = makeStore();
        const goal = baseGoal({ sessionKey: 'telegram:high-impact', requiresAuth: true, isConstruction: true });
        const result = await gateModule.avaliarGoal(goal, store);
        assert(result.action === 'proceed', 'goal de alto impacto (dispararia escalate) ainda prossegue no default', result);
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(failed === 0 ? `✅ S169 passou (${passed} verificações)` : `❌ S169: ${failed} falha(s) de ${passed + failed}`);
    process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
    console.error('S169 erro inesperado:', err);
    process.exitCode = 1;
});
