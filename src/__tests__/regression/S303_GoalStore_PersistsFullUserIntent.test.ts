/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S303 (campanha S-E, issue 048)
 * O `GoalStore` grava o pedido do usuário ÍNTEGRO. Antes, `user_intent` era cortado em 300 chars:
 * como todo replan relê o goal do banco, o Planner planejava sobre um pedido truncado e a frase
 * decisiva de um pedido longo (no FIM do texto) sumia do replan.
 *
 *   1 → pedido de 1.509 chars sobrevive a create() + get() (a frase final continua lá).
 *   2 → sobrevive a uma segunda instância sobre o mesmo banco (é o caminho real de replan/restart).
 *   3 → pedido curto continua idêntico (sem efeito colateral).
 *   4 → `objective` (resumo) mantém o teto de 500 — o que mudou foi só o pedido do usuário.
 *
 * Execução: npx ts-node src/__tests__/regression/S303_GoalStore_PersistsFullUserIntent.test.ts
 */
process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import Database from 'better-sqlite3';
import { GoalStore } from '../../loop/GoalStore';
import { Goal } from '../../loop/GoalTypes';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const FINAL_SENTENCE = 'Depois que estiver pronto me envio o arquivo .py';
const longIntent = '### Exercício: Calculadora de Idade\n' + 'Descrição detalhada do exercício. '.repeat(45) + '\n' + FINAL_SENTENCE;

function newGoal(userIntent: string, objective: string) {
    return {
        sessionKey: 'web:conv_s303', conversationId: 'conv_s303', userIntent, objective, status: 'active',
        currentPlan: [], attempts: [], blockers: [], toolsTried: [], strategiesTried: [],
        retryBudget: 3, replanBudget: 5, confidence: 0.9, requiresAuth: false, authorizationScope: [], successCriteria: [], expiresAt: Date.now() + 3_600_000,
    } as unknown as Omit<Goal, 'id' | 'createdAt' | 'updatedAt'>;
}

function main(): void {
    const db = new Database(':memory:');
    const store = new GoalStore(db as never);

    console.log('\n=== S303-1 — pedido longo sobrevive a create() + get() ===');
    const created = store.create(newGoal(longIntent, 'objetivo curto'));
    const read = store.getById(created.id)!;
    assert(longIntent.length > 1500, `premissa: o pedido de teste tem ${longIntent.length} chars (> 300)`);
    assert(read.userIntent.length === longIntent.length, `mesmo tamanho após reler do banco (${read.userIntent.length})`, read.userIntent.length);
    assert(read.userIntent.endsWith(FINAL_SENTENCE), 'a frase decisiva, no FIM do pedido, continua lá');
    assert(read.userIntent === longIntent, 'texto idêntico, byte a byte');

    console.log('\n=== S303-2 — sobrevive a outra instância sobre o mesmo banco (caminho real de replan/restart) ===');
    {
        const again = new GoalStore(db as never).getById(created.id)!;
        assert(again.userIntent === longIntent, 'segunda instância lê o pedido íntegro');
    }

    console.log('\n=== S303-3 — pedido curto: comportamento idêntico ===');
    {
        const c = store.create(newGoal('oi', 'oi'));
        assert(store.getById(c.id)!.userIntent === 'oi', 'pedido curto inalterado');
    }

    console.log('\n=== S303-4 — `objective` (resumo) mantém o teto de 500 ===');
    {
        const c = store.create(newGoal('x', 'o'.repeat(900)));
        assert(store.getById(c.id)!.objective.length === 500, 'objective continua limitado a 500 chars', store.getById(c.id)!.objective.length);
    }

    console.log(`\nS303 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}
main();
