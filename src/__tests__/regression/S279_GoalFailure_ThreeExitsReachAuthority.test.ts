/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S279 (issue 020, fechamento da cobertura do Incremento 1)
 *
 * O S278 provou de forma ESTRUTURAL que os pontos de falha genérica chamam a autoridade única
 * (`GracefulDeliveryOrchestrator.buildFailureMessage`), e de forma COMPORTAMENTAL só duas saídas
 * ("outcome failed" e "validação final"). Ficavam três só com cobertura estrutural. Este teste as
 * dispara de verdade, sem alterar produção, e prova que cada uma termina na mesma autoridade:
 *
 *   blocked      → `evaluate()` REAL produz o outcome, `handleBlockedOutcome` REAL o trata
 *   MAX_CYCLES   → `runLoopInternal` REAL entra já com o contador no limite
 *
 * ACHADO original (S279.2, 21/09/2026): a terceira saída, "progresso regredindo"
 * (`GoalEvaluator.evaluateProgress()` → `'regressing'`), era código morto — a função nunca devolvia
 * `'regressing'` de verdade (`AttemptOutcome` só tem 3 valores; "nenhum success/partial nos últimos
 * 3 attempts" implica que os 3 são `'failure'`, caso em que a função já tinha devolvido `'stalled'`
 * na linha anterior) e `GoalExecutionLoop` nunca tinha ramo para `'stalled'`. A "detecção de stall"
 * não produzia nenhum efeito, desde o commit que a introduziu.
 *
 * RESOLUÇÃO (22/09/2026, issue 029): removida. `GoalEvaluator.evaluateProgress()` e o bloco
 * `if (progress === 'regressing') {...}` em `GoalExecutionLoop.ts` deixaram de existir — não foram
 * mantidos como "inalcançáveis, mas presentes". A alternativa (implementar detecção de stall real)
 * exigiria decidir um comportamento novo de produto (quantas falhas seguidas abortam um goal?) sem
 * evidência de necessidade: o goal sempre termina de qualquer forma pelo esgotamento do
 * `replanBudget` (saída "blocked", já coberta abaixo). Remover não muda nenhum comportamento
 * observável — o branch já era inatingível — só elimina a proteção que o código prometia e não
 * cumpria. A prova por enumeração exaustiva (S279.2 abaixo) é o que sustentou essa decisão; mantida
 * aqui como evidência histórica, não como teste de um comportamento que ainda existe.
 *
 * Execução: npx ts-node src/__tests__/regression/S279_GoalFailure_ThreeExitsReachAuthority.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { GoalEvaluator } from '../../loop/GoalEvaluator';
import { GOAL_LIMITS } from '../../loop/GoalLimits';
import { ToolRegistry } from '../../core/ToolRegistry';
import { permissionRegistry } from '../../core/PermissionRegistry';
import { OperationalMode } from '../../core/CapabilityMode';
import { GoalAttempt } from '../../loop/GoalTypes';
import { makeLoop, makeGoal, emptyState, channelContext } from './_fixtures/goalLoopHarness';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

const SIGNATURE_HEAD = 'Não consegui completar';
const SIGNATURE_TAIL = 'Você pode reformular o pedido';

/**
 * Espiona a autoridade no loop em teste. NECESSÁRIO: a assinatura do texto ("Não consegui completar" +
 * "Você pode reformular o pedido") NÃO prova nada — o resumo antigo (buildFailureExplanation) tinha a
 * mesma cabeça e o mesmo rodapé. Só a chamada observada prova que o caminho executado passou pela
 * autoridade única.
 */
function spyAuthority(loop: any) {
    const auth = loop.gracefulDelivery;
    const original = auth.buildFailureMessage.bind(auth);
    const spy = { calls: 0, last: '' };
    auth.buildFailureMessage = (...args: unknown[]) => { spy.calls++; spy.last = original(...args); return spy.last; };
    return spy;
}

const step = (toolName: string) => ({ id: 's1', description: 'passo', toolName, toolArgs: {}, status: 'pending' as const, fallbackSteps: [] });

async function main(): Promise<void> {
    permissionRegistry.setMode(OperationalMode.DEVELOPER, 'test-s279', true);
    try {
        // ── S279.1 — saída "blocked" ────────────────────────────────────────────────────────────
        console.log('\n=== S279.1 — saída "blocked" (replan budget zerado): evaluate() REAL + handleBlockedOutcome REAL ===');
        {
            const TOOL = '__s279_blocked__';
            ToolRegistry.register({ name: TOOL, description: 'test', parameters: {}, execute: async () => ({ success: false, output: '' }) });
            const { loop, goalStore } = makeLoop({ achieved: true });
            const spy = spyAuthority(loop);
            const goal = makeGoal(goalStore, [step(TOOL)], { replanBudget: 1, toolsTried: [TOOL] });

            // O outcome 'blocked' vem do avaliador de produção, não é fabricado: erro sem padrão
            // conhecido + replan budget > 0 → "bloqueado, precisa replan".
            const cycleResult = (loop as any).evaluator.evaluate(goal, goal.currentPlan[0], { success: false, output: '', error: 'falha genérica xyz' });
            assert(cycleResult.outcome === 'blocked', 'pré-condição: o GoalEvaluator real classifica este erro como "blocked"', cycleResult.outcome);

            // O replan budget esgota ANTES de tratar o outcome — é o que leva ao ramo de falha.
            goalStore.update(goal.id, { replanBudget: 0 });
            const budgetless = goalStore.getById(goal.id)!;
            const handled = await (loop as any).handleBlockedOutcome(
                budgetless, budgetless.currentPlan[0], cycleResult, 1, 0, undefined, emptyState(goal.id), undefined);

            assert(handled.earlyReturn === true, 'o handler encerra o goal (earlyReturn)', handled);
            assert(goalStore.getById(goal.id)!.status === 'failed', 'o goal termina failed');
            const out: string = handled.result.finalOutput;
            assert(out.includes(SIGNATURE_HEAD) && out.includes(SIGNATURE_TAIL), 'a mensagem tem a assinatura da autoridade única', out);
            assert(out.includes(`Tentei: ${TOOL}.`), 'e informa a ferramenta realmente tentada (fato do goal, não texto fixo)', out);
            assert(spy.calls === 1 && out.includes(spy.last), 'PROVA: o caminho executado invocou buildFailureMessage exatamente 1 vez e devolveu o texto que chegou ao usuário', spy);
        }

        // ── S279.2 — "progresso regredindo": prova histórica de por que foi REMOVIDA ────────────
        console.log('\n=== S279.2 [histórico] — evaluateProgress() nunca devolvia "regressing" (por isso foi removida, issue 029) ===');
        {
            // Reimplementa aqui, LOCALMENTE, a lógica exata que existia em GoalEvaluator.evaluateProgress()
            // antes da remoção — a prova por enumeração exaustiva não depende de o código de produção
            // ainda existir; é sobre a LÓGICA que foi removida, preservada como evidência da decisão.
            function extinctEvaluateProgress(attempts: Array<{ result: GoalAttempt['result'] }>): 'progressing' | 'stalled' | 'regressing' {
                if (attempts.length < 2) return 'progressing';
                const recent = attempts.slice(-3);
                const hasPositive = recent.some(a => a.result === 'success' || a.result === 'partial');
                const allFailed = recent.every(a => a.result === 'failure');
                if (allFailed && recent.length >= 2) return 'stalled';
                if (!hasPositive && attempts.length > 5) return 'regressing';
                return 'progressing';
            }

            const values: GoalAttempt['result'][] = ['success', 'failure', 'partial'];
            const seen: Record<string, number> = {};
            let total = 0;
            const walk = (prefix: GoalAttempt['result'][], n: number): void => {
                if (prefix.length === n) { const r = extinctEvaluateProgress(prefix.map(result => ({ result }))); seen[r] = (seen[r] ?? 0) + 1; total++; return; }
                for (const v of values) walk([...prefix, v], n);
            };
            for (let n = 0; n <= 8; n++) walk([], n);
            assert(total === 9841, 'a enumeração cobriu todas as 9841 sequências de attempts (tamanhos 0..8)', total);
            assert(seen['regressing'] === undefined,
                'CONFIRMADO: a lógica removida nunca devolvia "regressing" — a remoção não mudou nenhum comportamento observável', seen);

            // A remoção de fato aconteceu — a função e o branch que a consumia não existem mais.
            const evaluatorSrc = fs.readFileSync(path.resolve(__dirname, '../../loop/GoalEvaluator.ts'), 'utf8');
            const loopSrc = fs.readFileSync(path.resolve(__dirname, '../../loop/GoalExecutionLoop.ts'), 'utf8');
            assert(typeof (new GoalEvaluator() as any).evaluateProgress === 'undefined',
                'GoalEvaluator.evaluateProgress não existe mais — o compilador impede qualquer chamada direta');
            assert(!/evaluateProgress/.test(evaluatorSrc), 'nenhum vestígio de evaluateProgress em GoalEvaluator.ts', evaluatorSrc.includes('evaluateProgress'));
            assert(!/evaluateProgress|regressing/.test(loopSrc), 'GoalExecutionLoop.ts não chama mais evaluateProgress nem trata "regressing"', {
                hasEvaluateProgress: loopSrc.includes('evaluateProgress'), hasRegressing: loopSrc.includes('regressing'),
            });
        }

        // ── S279.3 — saída MAX_CYCLES ───────────────────────────────────────────────────────────
        console.log('\n=== S279.3 — saída MAX_CYCLES: runLoopInternal REAL entra com o contador no limite ===');
        {
            let executions = 0;
            const TOOL = '__s279_maxcycles__';
            ToolRegistry.register({ name: TOOL, description: 'test', parameters: {}, execute: async () => { executions++; return { success: true, output: 'ok' }; } });

            // (a) sem nada entregue
            const a = makeLoop({ achieved: true });
            const spyA = spyAuthority(a.loop);
            const goalA = makeGoal(a.goalStore, [step(TOOL)], { toolsTried: [TOOL] });
            const resA: any = await (a.loop as any).runLoopInternal(goalA, channelContext, undefined, GOAL_LIMITS.MAX_CYCLES, 0, undefined, emptyState(goalA.id));
            assert(executions === 0, 'o laço não executou nenhum step — a saída é puramente a de MAX_CYCLES', executions);
            assert(a.goalStore.getById(goalA.id)!.status === 'failed' && resA.success === false, 'o goal termina failed');
            assert(resA.finalOutput.includes(SIGNATURE_HEAD) && resA.finalOutput.includes(SIGNATURE_TAIL),
                'a mensagem tem a assinatura da autoridade única', resA.finalOutput);
            assert(resA.finalOutput.includes(`Tentei: ${TOOL}.`), 'e informa a ferramenta tentada', resA.finalOutput);
            assert(spyA.calls === 1 && resA.finalOutput.includes(spyA.last), 'PROVA: a saída MAX_CYCLES invocou buildFailureMessage exatamente 1 vez e devolveu o texto que chegou ao usuário', spyA);

            // (b) CENÁRIO "artefato enviado + falha posterior", agora por uma saída REAL do laço (antes só
            // coberto por teste unitário do orquestrador): o fato "já enviei X" abre a mensagem e o
            // arquivo entregue não é listado como pendente.
            const b = makeLoop({ achieved: true });
            const spyB = spyAuthority(b.loop);
            const goalB = makeGoal(b.goalStore, [step(TOOL)], {
                sentArtifacts: ['tmp/relatorio.pdf'],
                attempts: [{ id: 'w1', planStepId: 'sx', toolName: 'write', args: { path: 'tmp/relatorio.pdf' }, result: 'success', durationMs: 1, executedAt: Date.now() }],
            });
            const resB: any = await (b.loop as any).runLoopInternal(goalB, channelContext, undefined, GOAL_LIMITS.MAX_CYCLES, 0, undefined, emptyState(goalB.id));
            assert(resB.finalOutput.startsWith('Consegui gerar e enviar: tmp/relatorio.pdf.'),
                'artefato ENVIADO + falha posterior: a mensagem abre com o que JÁ foi entregue', resB.finalOutput);
            assert(!/NÃO foram enviados/.test(resB.finalOutput), 'o arquivo entregue não aparece como pendente', resB.finalOutput);
            assert(!resB.finalOutput.includes(SIGNATURE_HEAD), 'e não afirma "não consegui completar" como se nada tivesse sido feito', resB.finalOutput);
            assert(spyB.calls === 1 && resB.finalOutput.includes(spyB.last), 'PROVA: também aqui a mensagem veio da autoridade (1 chamada)', spyB);
        }
    } finally {
        permissionRegistry.setMode(OperationalMode.SAFE, 'test-s279-restore');
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S279 RESULTADO: ${passed} passou | ${failed} falhou`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(err => { console.error('S279 erro inesperado:', err); process.exit(1); });
