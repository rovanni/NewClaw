/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S430
 * O limite de ciclos do objetivo conta só os ciclos SEM AVANÇO — um passo que termina com sucesso é trabalho feito, não
 * tentativa gasta.
 *
 * INCIDENTE REAL (Windows, 16/10/2026, reteste "instalar o GenOffice"): um plano de 5 passos com 3 replanejamentos esgotou
 * os 12 ciclos com os passos DANDO CERTO — "Atingi o limite de 12 ciclos de trabalho com 2 passos ainda por fazer". O mesmo
 * corte injusto do relógio (operadora: "é muito injusto … perder tudo"), agora por contagem.
 *
 * REGRESSÃO SE: um plano longo que progride parar no 12º passo; ou um objetivo que só falha deixar de parar no limite
 * (a proteção contra repetição sem fim continua).
 *
 * Execução: npx ts-node src/__tests__/regression/S430_CiclosSoContamSemAvanco.test.ts
 */
import { GOAL_LIMITS } from '../../loop/GoalLimits';
import { ToolRegistry } from '../../core/ToolRegistry';
import { permissionRegistry } from '../../core/PermissionRegistry';
import { OperationalMode } from '../../core/CapabilityMode';
import { makeLoop, makeGoal, emptyState, channelContext } from './_fixtures/goalLoopHarness';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

async function main(): Promise<void> {
    permissionRegistry.setMode(OperationalMode.DEVELOPER, 'test-s430');
    try {
        let execucoes = 0;
        const OK = '__s430_ok__';
        ToolRegistry.register({ name: OK, description: 'ok', parameters: {}, execute: async () => { execucoes++; return { success: true, output: `passo ${execucoes} feito: arquivo gerado e conferido` }; } });
        const N = GOAL_LIMITS.MAX_CYCLES + 2;   // mais passos do que o limite antigo deixava
        const passos = Array.from({ length: N }, (_, i) => ({ id: `s${i + 1}`, description: `passo ${i + 1} do relatório`, toolName: OK, toolArgs: {}, status: 'pending' as const, fallbackSteps: [] }));

        console.log(`\n=== S430-1 — ${N} passos que dão certo: todos executados (antes parava no ${GOAL_LIMITS.MAX_CYCLES}º) ===`);
        const { loop, goalStore } = makeLoop({ achieved: true }, { formatoDoMotor: true });
        const goal = makeGoal(goalStore, passos);
        const r: any = await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, emptyState(goal.id));
        assert(execucoes === N, `os ${N} passos foram executados (${execucoes})`, execucoes);
        assert(!/Atingi o limite de \d+ ciclos/.test(r.finalOutput ?? ''), 'o objetivo NÃO terminou pelo limite de ciclos', r.finalOutput);
        assert(goalStore.getById(goal.id)!.currentPlan.every(s => s.status === 'completed'), 'todos os passos ficaram concluídos');
        assert(r.success === true, 'e o objetivo terminou com SUCESSO (validado)', r.finalOutput);

        console.log('\n=== S430-2 — passos que sempre falham: continua parando no limite (proteção) ===');
        let falhas = 0;
        const FALHA = '__s430_falha__';
        ToolRegistry.register({ name: FALHA, description: 'falha', parameters: {}, execute: async () => { falhas++; return { success: false, output: '', error: 'erro genérico qualquer xyz' }; } });
        const b = makeLoop({ achieved: true });
        const ruim = makeGoal(b.goalStore, [{ id: 'f1', description: 'passo que falha', toolName: FALHA, toolArgs: {}, status: 'pending' as const, fallbackSteps: [] }], { replanBudget: 50, retryBudget: 50 });
        const rr: any = await (b.loop as any).runLoopInternal(ruim, channelContext, undefined, 0, 0, undefined, emptyState(ruim.id));
        assert(rr.success === false, 'termina sem sucesso', rr.finalOutput);
        assert(falhas <= GOAL_LIMITS.MAX_CYCLES, `não passa do limite de ciclos sem avanço (${falhas} execuções ≤ ${GOAL_LIMITS.MAX_CYCLES})`, falhas);
    } finally {
        permissionRegistry.setMode(OperationalMode.SAFE, 'test-s430-restore');
    }
    console.log(`\n=== S430: ${passed} passaram, ${failed} falharam ===`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
