/// <reference types="node" />
/**
 * S167 — CognitiveKernelGate: as 4 ramificações de Decision.tipo + circuit breaker.
 *
 * Contexto: cutover do Cognitive Kernel (newclaw-kernel-adapter) para decidir Goals reais —
 * ver src/loop/CognitiveKernelGate.ts. Este teste roda com COGNITIVE_KERNEL_ENABLED=true
 * (setado ANTES do import, já que a flag é lida uma única vez no load do módulo) e verifica:
 *
 * (1) EXECUTE → {action:'proceed'} — caso realista de goal recém-criado (sem blockers/attempts)
 *     em sessão com precedente forte (mesmo caso "confiança suficiente" do guia de domínio).
 * (2) DEFER → goal ambíguo, sem candidato nomeável (gerarHipoteses só propõe candidato quando
 *     blockersCount>0 — nunca o caso de um goal recém-criado) — o caso mais comum na prática,
 *     dado que blockersCount=0 em qualquer goal ainda não executado.
 * (3) REQUEST_MORE_INFO → goal com 1 blocker + retryBudget>0 (candidato nomeável existe) —
 *     construído diretamente (não reflete o call site real, que só chama o gate ANTES de
 *     qualquer blocker existir), mas testa a corretude do mapeamento de efeito→GateResult.
 * (4) ESCALATE → requiresAuth=true + isConstruction=true (cruza o limiar highImpact=0.6 via
 *     impacto=0.7) — mesma ressalva de (3): não reflete o estado real de um goal recém-criado
 *     (GoalOrchestrator sempre cria com requiresAuth=false), mas exercita o branch real.
 * (5) Circuit breaker: goalKernelInstance.process lançando exceção → sempre {action:'proceed'},
 *     nunca propaga o erro pro chamador.
 *
 * IMPORTANTE (achado desta Sprint, não coberto por este teste): no call site real
 * (GoalOrchestrator, logo após goalStore.create()), um Goal recém-criado SEMPRE tem
 * blockersCount=0 e requiresAuth=false — os casos (3) e (4) acima, embora corretamente
 * implementados, não são alcançáveis por esse call site específico hoje. Só (1) e (2) ocorrem
 * na prática, até que um segundo ponto de integração (ex.: reavaliação mid-execution) exista.
 */
import Database from 'better-sqlite3';
import { GoalStore } from '../../loop/GoalStore';
import type { Goal } from '../../loop/GoalTypes';

process.env.COGNITIVE_KERNEL_ENABLED = 'true';
process.env.COGNITIVE_KERNEL_APPLY_DECISION = 'true';

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
    console.log('\n=== S167-1 — EXECUTE: goal recém-criado + precedente forte na sessão ===');
    {
        const store = makeStore();
        const sessionKey = 'telegram:strong-precedent';
        // 10 goals terminais anteriores, todos completed — precedente forte real (via GoalStore real).
        for (let i = 0; i < 10; i++) {
            const g = store.create(baseGoal({ sessionKey }) as any);
            store.setStatus(g.id, 'executing');
            store.update(g.id, { status: 'completed' });
        }
        const goal = baseGoal({ sessionKey, confidence: 0.9 });
        const result = await gateModule.avaliarGoal(goal, store);
        assert(result.action === 'proceed', 'EXECUTE mapeia para {action: proceed}', result);
    }

    console.log('\n=== S167-2 — DEFER: goal ambíguo sem candidato (blockersCount=0, caso real de criação) ===');
    {
        const store = makeStore();
        const goal = baseGoal({ sessionKey: 'telegram:no-history', confidence: 0.5 });
        const result = await gateModule.avaliarGoal(goal, store);
        assert(result.action === 'defer', 'DEFER mapeia para {action: defer}', result);
        if (result.action === 'defer') {
            assert(typeof result.message === 'string' && result.message.length > 0, 'DEFER inclui mensagem para o usuário');
        }
    }

    console.log('\n=== S167-3 — REQUEST_MORE_INFO: candidato nomeável existe (1 blocker, retryBudget>0) ===');
    {
        const store = makeStore();
        const goal = baseGoal({
            sessionKey: 'telegram:with-blocker',
            blockers: [{
                kind: 'context_insufficient',
                description: 'faltou informação',
                suggestedActions: [],
                detectedAt: Date.now(),
            }],
            retryBudget: 3,
        });
        const result = await gateModule.avaliarGoal(goal, store);
        assert(result.action === 'ask_info', 'REQUEST_MORE_INFO mapeia para {action: ask_info}', result);
    }

    console.log('\n=== S167-4 — ESCALATE: impacto cruza highImpact via requiresAuth+isConstruction ===');
    {
        const store = makeStore();
        const goal = baseGoal({
            sessionKey: 'telegram:high-impact',
            requiresAuth: true,
            isConstruction: true,
        });
        const result = await gateModule.avaliarGoal(goal, store);
        assert(result.action === 'escalate', 'ESCALATE mapeia para {action: escalate}', result);
        if (result.action === 'escalate') {
            assert(Array.isArray(result.authOptions) && result.authOptions.length === 2, 'ESCALATE inclui authOptions (sim/não)', result.authOptions);
        }
    }

    console.log('\n=== S167-5 — Circuit breaker: exceção do Kernel nunca propaga, sempre proceed ===');
    {
        const store = makeStore();
        const goal = baseGoal({ sessionKey: 'telegram:kernel-broken' });
        const originalProcess = adapterModule.goalKernelInstance.process;
        (adapterModule.goalKernelInstance as any).process = () => { throw new Error('kernel quebrado (simulado)'); };
        try {
            const result = await gateModule.avaliarGoal(goal, store);
            assert(result.action === 'proceed', 'exceção do Kernel resulta em {action: proceed}, nunca propaga', result);
        } finally {
            (adapterModule.goalKernelInstance as any).process = originalProcess;
        }
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(failed === 0 ? `✅ S167 passou (${passed} verificações)` : `❌ S167: ${failed} falha(s) de ${passed + failed}`);
    process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
    console.error('S167 erro inesperado:', err);
    process.exitCode = 1;
});
