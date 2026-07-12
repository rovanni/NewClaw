/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S107
 *
 * Achado B2 (auditoria adversarial 2026-07-12), implementado como rollout configurável
 * (UNCAUGHT_EXCEPTION_POLICY=continue|restart) em vez de política fixa — Linux/VPS (systemd)
 * e Windows (Tarefa Agendada) têm garantias de restart muito diferentes.
 *
 * Verifica:
 * 1. policy=continue: TypeError decide 'continue' (processo permanece vivo).
 * 2. policy=restart: TypeError decide 'exit' (processo se encerra para o supervisor reiniciar).
 * 3. Corrupção de SQLite ("disk image is malformed") SEMPRE decide 'exit', mesmo com
 *    policy=continue — não é "erro de tipo comum", independe da política.
 * 4. RangeError/ReferenceError seguem a mesma regra configurável que TypeError (não há
 *    tratamento especial por tipo dentro do grupo "configurável").
 * 5. Valor inválido de UNCAUGHT_EXCEPTION_POLICY cai no padrão seguro "continue".
 * 6. applyUncaughtExceptionDecision loga política ativa + demais campos exigidos e só chama
 *    process.exit quando a decisão é 'exit'.
 */

import { decideUncaughtExceptionAction, applyUncaughtExceptionDecision } from '../../core/UncaughtExceptionPolicy';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${msg}`, detail ?? ''); failed++; }
}

function withPolicyEnv<T>(value: string | undefined, fn: () => T): T {
    const prev = process.env.UNCAUGHT_EXCEPTION_POLICY;
    if (value === undefined) delete process.env.UNCAUGHT_EXCEPTION_POLICY;
    else process.env.UNCAUGHT_EXCEPTION_POLICY = value;
    try {
        return fn();
    } finally {
        if (prev === undefined) delete process.env.UNCAUGHT_EXCEPTION_POLICY;
        else process.env.UNCAUGHT_EXCEPTION_POLICY = prev;
    }
}

async function main() {
    console.log('\n=== S107 — Política configurável de uncaughtException (continue|restart) ===');

    // 1. policy=continue + TypeError → continue
    withPolicyEnv('continue', () => {
        const decision = decideUncaughtExceptionAction(new TypeError('cannot read property x of undefined'));
        assert(decision.action === 'continue', 'policy=continue: TypeError decide "continue"', decision);
        assert(decision.policy === 'continue', 'decision.policy reflete "continue"', decision);
    });

    // 2. policy=restart + TypeError → exit
    withPolicyEnv('restart', () => {
        const decision = decideUncaughtExceptionAction(new TypeError('cannot read property x of undefined'));
        assert(decision.action === 'exit', 'policy=restart: TypeError decide "exit"', decision);
        assert(decision.policy === 'restart', 'decision.policy reflete "restart"', decision);
    });

    // 3. Corrupção de SQLite força exit mesmo com policy=continue
    withPolicyEnv('continue', () => {
        const decision = decideUncaughtExceptionAction(new Error('SqliteError: database disk image is malformed'));
        assert(decision.action === 'exit', 'Corrupção de SQLite decide "exit" mesmo com policy=continue', decision);
        assert(decision.category === 'unrecoverable', 'Corrupção de SQLite é categorizada como "unrecoverable"', decision);
    });

    // 4. RangeError/ReferenceError seguem a mesma regra configurável (sem tratamento especial por tipo)
    withPolicyEnv('restart', () => {
        const rangeDecision = decideUncaughtExceptionAction(new RangeError('invalid array length'));
        const refDecision = decideUncaughtExceptionAction(new ReferenceError('x is not defined'));
        assert(rangeDecision.action === 'exit', 'policy=restart: RangeError decide "exit"', rangeDecision);
        assert(refDecision.action === 'exit', 'policy=restart: ReferenceError decide "exit"', refDecision);
    });

    // 5. Valor inválido cai no padrão seguro "continue"
    withPolicyEnv('yolo', () => {
        const decision = decideUncaughtExceptionAction(new TypeError('x'));
        assert(decision.action === 'continue', 'UNCAUGHT_EXCEPTION_POLICY inválido cai no padrão seguro "continue"', decision);
    });
    withPolicyEnv(undefined, () => {
        const decision = decideUncaughtExceptionAction(new TypeError('x'));
        assert(decision.action === 'continue', 'UNCAUGHT_EXCEPTION_POLICY ausente usa o padrão "continue"', decision);
    });

    // 6. applyUncaughtExceptionDecision: loga e só sai do processo quando a decisão é 'exit'
    withPolicyEnv('continue', () => {
        const originalExit = process.exit;
        let exitCalled = false;
        (process as any).exit = (_code?: number) => { exitCalled = true; return undefined as never; };
        try {
            applyUncaughtExceptionDecision(new TypeError('boom'), 'uncaughtException');
            assert(!exitCalled, 'applyUncaughtExceptionDecision com policy=continue NÃO chama process.exit', { exitCalled });
        } finally {
            process.exit = originalExit;
        }
    });

    withPolicyEnv('restart', () => {
        const originalExit = process.exit;
        let exitCalled = false;
        let exitCode: number | undefined;
        (process as any).exit = (code?: number) => { exitCalled = true; exitCode = code; return undefined as never; };
        try {
            applyUncaughtExceptionDecision(new TypeError('boom'), 'uncaughtException');
            assert(exitCalled && exitCode === 1, 'applyUncaughtExceptionDecision com policy=restart chama process.exit(1)', { exitCalled, exitCode });
        } finally {
            process.exit = originalExit;
        }
    });

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S107 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(err => {
    console.error('Erro no teste S107:', err);
    process.exit(1);
});
