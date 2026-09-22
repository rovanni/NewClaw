/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S283 (issue 028, Sprint 4)
 *
 * Rastreado o ciclo de vida completo do goal (sucesso, falha, abandono, expiração, interrupção).
 * A issue 020 unificou as saídas de FALHA GENÉRICA na autoridade única
 * (`GracefulDeliveryOrchestrator.buildFailureMessage`). Expiração e abandono ficaram
 * deliberadamente fora daquele escopo — têm razão própria e deliberada ("expirou", "nova mensagem
 * do usuário") — mas herdaram o MESMO defeito: a razão era passada como `overrideOutput` direto
 * para `buildResult()`, que a usa como mensagem final SEM NUNCA consultar a autoridade
 * (`buildResult`: `overrideOutput` vence por `??` antes do fallback que chama a autoridade). O
 * resultado: um goal que gerou e ENVIOU artefatos, e só depois expira ou é interrompido, reportava
 * só "Objetivo expirou por tempo limite." — perdendo o fato "já enviei X".
 *
 * Três pontos reais (não um só):
 *   1. Expiração dentro de `runValidationNotAchievedPhase` (replan budget esgotando).
 *   2. Expiração dentro do laço principal de `runLoopInternal` (TTL checado a cada ciclo).
 *   3. Abandono/interrupção em `runStepExecutionPhase` — cobre TANTO "nova mensagem do usuário
 *      durante execução" QUANTO `/cancelar` (`GoalOrchestrator.cancelActiveGoal` só marca o motivo;
 *      quem produz a mensagem final é sempre este ponto, no próximo recarregamento do goal).
 *
 * Decisão (evidência, não suposição): `GoalOrchestrator.ts` também tem `setStatus(..., 'abandoned')`
 * em dois outros pontos (substituição de goal ativo por nova mensagem; `ask_info`/`defer` sem
 * execução alguma) — verificados e são estruturalmente DIFERENTES: não produzem mensagem própria de
 * "goal falhou" (o primeiro só marca e deixa o `GoalExecutionLoop` descobrir sozinho — mesmo
 * mecanismo do ponto 3 acima; o segundo retorna `gate.message`, uma pergunta de esclarecimento, não
 * um resumo de goal que já rodou). Fora do escopo desta correção.
 *
 * Autoridade reusada, não criado mecanismo paralelo — mesma `GracefulDeliveryOrchestrator` da 020,
 * mesmo padrão `buildFailureMessage(goal, state.cognitiveContext, reason)` já validado.
 *
 * Execução: npx ts-node src/__tests__/regression/S283_ExpiredAbandonedGoals_PreservePartialSummary.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { ToolRegistry } from '../../core/ToolRegistry';
import { permissionRegistry } from '../../core/PermissionRegistry';
import { OperationalMode } from '../../core/CapabilityMode';
import { makeLoop, makeGoal, emptyState, channelContext } from './_fixtures/goalLoopHarness';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

const step = (toolName: string) => ({ id: 's1', description: 'passo', toolName, toolArgs: {}, status: 'pending' as const, fallbackSteps: [] });

function spyAuthority(loop: any) {
    const auth = loop.gracefulDelivery;
    const original = auth.buildFailureMessage.bind(auth);
    const spy = { calls: 0, last: '' };
    auth.buildFailureMessage = (...args: unknown[]) => { spy.calls++; spy.last = original(...args); return spy.last; };
    return spy;
}

async function main(): Promise<void> {
    const loopSrc = fs.readFileSync(path.resolve(__dirname, '../../loop/GoalExecutionLoop.ts'), 'utf8');

    console.log('\n=== S283.1 [estrutural] — os 3 pontos de expiração/abandono chamam a autoridade com o motivo ===');
    {
        const calls = loopSrc.match(/this\.gracefulDelivery\.buildFailureMessage\(/g) ?? [];
        assert(calls.length === 8, 'total de chamadas à autoridade = 5 (issue 020) + 3 (issue 028)', calls.length);
        assert(/buildFailureMessage\(goal, state\.cognitiveContext, 'Objetivo expirou por tempo limite\.'\)/.test(loopSrc),
            'expiração (runValidationNotAchievedPhase) chama a autoridade com o motivo');
        assert(/buildFailureMessage\(currentGoal, state\.cognitiveContext, 'Objetivo expirou por tempo limite\.'\)/.test(loopSrc),
            'expiração (laço principal) chama a autoridade com o motivo');
        assert(/buildFailureMessage\(goal, state\.cognitiveContext, abandonReason\)/.test(loopSrc),
            'abandono/interrupção chama a autoridade com o motivo real (abandonReason)');
        // Nenhuma string fixa de expiração/abandono sobrevive como overrideOutput direto de buildResult.
        assert(!/buildResult\([^)]*'Objetivo expirou por tempo limite\.'\)/.test(loopSrc),
            "'Objetivo expirou por tempo limite.' não é mais passada crua para buildResult() em nenhum ponto");
    }

    permissionRegistry.setMode(OperationalMode.DEVELOPER, 'test-s283', true);
    try {
        console.log('\n=== S283.2 — expiração REAL (laço principal): artefato já enviado não é perdido ===');
        {
            const TOOL = '__s283_expired__';
            ToolRegistry.register({ name: TOOL, description: 'test', parameters: {}, execute: async () => ({ success: true, output: 'ok' }) });
            const { loop, goalStore } = makeLoop({ achieved: true });
            const spy = spyAuthority(loop);
            const goal = makeGoal(goalStore, [step(TOOL)], {
                toolsTried: [TOOL],
                expiresAt: Date.now() - 1000, // já expirado ANTES do primeiro ciclo
                attempts: [{ id: 'w1', planStepId: 'sx', toolName: 'write', args: { path: 'tmp/relatorio-parcial.pdf' }, result: 'success', durationMs: 1, executedAt: Date.now() }],
            });
            // Padrão REAL de produção: sentArtifacts nunca nasce preenchido na criação — é marcado
            // DEPOIS, via trackArtifact()/update() (achado lateral, issue 035: GoalStore.create()
            // ignora sentArtifacts passado no objeto de entrada; sem efeito aqui, é sempre assim
            // que o dado chega em produção).
            goalStore.update(goal.id, { sentArtifacts: ['tmp/relatorio-parcial.pdf'] });
            const res: any = await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, emptyState(goal.id));

            assert(goalStore.getById(goal.id)!.status === 'abandoned', 'o goal termina abandoned (expirado)', goalStore.getById(goal.id)!.status);
            assert(res.finalOutput.startsWith('Consegui gerar e enviar: tmp/relatorio-parcial.pdf.'),
                'REGRESSÃO CORRIGIDA: o artefato já enviado abre a mensagem — não se perde na expiração', res.finalOutput);
            assert(!res.finalOutput.startsWith('Objetivo expirou por tempo limite.'),
                'a mensagem NÃO é mais só a frase crua de expiração', res.finalOutput);
            assert(/expirou/i.test(res.finalOutput), 'mas o motivo real (expirou) continua presente, como fato de entrada', res.finalOutput);
            assert(spy.calls === 1 && res.finalOutput.includes(spy.last), 'PROVA: a autoridade foi chamada exatamente 1 vez e é ela quem produziu o texto final', spy);
        }

        console.log('\n=== S283.3 — abandono/interrupção REAL (runStepExecutionPhase): mesma cobertura ===');
        {
            const TOOL = '__s283_abandoned__';
            const { loop, goalStore } = makeLoop({ achieved: true });
            const spy = spyAuthority(loop);
            const goal = makeGoal(goalStore, [step(TOOL)], {
                toolsTried: [TOOL],
                attempts: [{ id: 'w1', planStepId: 'sx', toolName: 'write', args: { path: 'tmp/ja-entregue.docx' }, result: 'success', durationMs: 1, executedAt: Date.now() }],
            });
            goalStore.update(goal.id, { sentArtifacts: ['tmp/ja-entregue.docx'] }); // ver nota S283.2 (issue 035)
            // Tool cujo execute() simula o GoalOrchestrator abandonando o goal DURANTE o step
            // (nova mensagem do usuário OU /cancelar) — exatamente o que o comentário de produção
            // descreve como a origem real deste caminho.
            ToolRegistry.register({
                name: TOOL, description: 'test', parameters: {},
                execute: async () => {
                    goalStore.markAbandonReason(goal.id, 'Goal interrompido: cancelado explicitamente pelo usuário.');
                    goalStore.setStatus(goal.id, 'abandoned');
                    return { success: true, output: 'ok' };
                },
            });

            const handled: any = await (loop as any).runStepExecutionPhase(
                goal, goal.currentPlan[0], 0, 0, emptyState(goal.id), channelContext,
                () => {}, () => false, undefined,
            );

            assert(handled.action === 'earlyReturn', 'o handler encerra o goal (earlyReturn)', handled);
            const out: string = handled.result.finalOutput;
            assert(out.startsWith('Consegui gerar e enviar: tmp/ja-entregue.docx.'),
                'REGRESSÃO CORRIGIDA: artefato já entregue não se perde no abandono/interrupção', out);
            assert(out.includes('cancelado explicitamente pelo usuário'), 'o motivo real do abandono continua presente', out);
            assert(spy.calls === 1 && out.includes(spy.last), 'PROVA: a autoridade foi chamada exatamente 1 vez', spy);
        }
    } finally {
        permissionRegistry.setMode(OperationalMode.SAFE, 'test-s283-restore');
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S283 RESULTADO: ${passed} passou | ${failed} falhou`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(err => { console.error('S283 erro inesperado:', err); process.exit(1); });
