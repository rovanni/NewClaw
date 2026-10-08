/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S357 (Sprint V1 do princípio "Informação Completa para Decidir", 08/10/2026)
 *
 * Mapa da informação (08/10): o replanejamento, o planejamento reduzido (retry minimal) e a análise de risco recebiam
 * só `goal.objective` — o resumo escrito pelo GoalExtractor a partir dos 300 primeiros caracteres do pedido. Em
 * outubro: 22 replanejamentos e 30 revisões de risco sobre esse resumo. Uma instrução no fim de um pedido longo
 * ("entregue em PDF", "não use a internet") não chegava a quem replaneja nem a quem revisa o plano.
 *
 * REGRESSÃO SE: um desses três prompts voltar a receber só o resumo.
 *
 * Execução: npx ts-node src/__tests__/regression/S357_FullIntentReachesReplanAndRisk.test.ts
 */
import { GoalPlanner } from '../../loop/GoalPlanner';
import { RiskAnalyzer } from '../../loop/RiskAnalyzer';
import { ToolRegistry } from '../../core/ToolRegistry';
import { ReadTool } from '../../tools/read_tool';
import type { Goal, GoalBlocker, PlanStep } from '../../loop/GoalTypes';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (): boolean => true;
    try { return await fn(); } finally { process.stdout.write = orig; }
};

// Pedido longo com a instrução decisiva SÓ no fim — exatamente o que o resumo de 300 caracteres perde.
const INSTRUCAO_DO_FIM = 'IMPORTANTE: entregue o resultado em PDF e não use a internet';
const PEDIDO = 'Preciso criar questões no padrão do ENADE para meus alunos sobre Compiladores, Teoria da Computação e Sistemas Operacionais. '
    + 'Quero situações-problema contextualizadas, cinco alternativas, gabarito comentado e distribuição equilibrada entre as disciplinas. '.repeat(3)
    + INSTRUCAO_DO_FIM;
const RESUMO = 'Criar questões ENADE de Compiladores, TC e SO';

function goal(): Goal {
    const agora = Date.now();
    return {
        id: 'goal_s357', sessionKey: 't', conversationId: 'c', userIntent: PEDIDO, objective: RESUMO,
        status: 'blocked', currentPlan: [], attempts: [], blockers: [], toolsTried: [], strategiesTried: [],
        successCriteria: [], sentArtifacts: [], retryBudget: 3, replanBudget: 5, confidence: 0.9,
        requiresAuth: false, authorizationScope: [], createdAt: agora, updatedAt: agora, expiresAt: agora + 3_600_000,
    } as unknown as Goal;
}

async function main(): Promise<void> {
    console.log(`\n(cenário: pedido de ${PEDIDO.length} caracteres; instrução decisiva a partir do caractere ${PEDIDO.indexOf(INSTRUCAO_DO_FIM)})`);

    console.log('\n=== S357-1 — replanejamento recebe o pedido íntegro ===');
    const prompts: string[] = [];
    let n = 0;
    const factory = {
        chatWithFallback: async (msgs: Array<{ content: string }>) => {
            prompts.push(msgs[0]?.content ?? '');
            n++;
            // 1ª chamada sem steps → força o retry minimal (2ª chamada), que também é verificado.
            const content = n === 1 ? '{"steps":[],"strategy":"x"}' : JSON.stringify({ steps: [{ id: 'step_1', description: 'ler', toolName: 'read', toolArgs: { path: 'a.txt' } }], strategy: 's' });
            return { status: 'success', content, attempts: [] };
        },
        getProviderWithModel: () => ({ chat: async () => ({ content: '' }) }),
    } as any;
    const planner = new GoalPlanner(factory, { findBlockerLessons: () => '', findHardConstraints: () => [] } as any);
    const bloqueio: GoalBlocker = { kind: 'tool_error', description: 'falhou', suggestedActions: [], detectedAt: Date.now() } as GoalBlocker;
    await quiet(() => planner.replan(goal(), bloqueio));
    assert(prompts[0]?.includes(INSTRUCAO_DO_FIM), 'prompt de replanejamento contém a instrução do fim do pedido (antes: só o resumo)');
    assert(prompts[0]?.includes(`INTENÇÃO ORIGINAL: ${PEDIDO}`), 'pedido íntegro, rotulado como no prompt de plano inicial');

    console.log('\n=== S357-2 — planejamento reduzido (retry minimal) recebe o pedido íntegro ===');
    assert(prompts.length >= 2, `retry minimal foi acionado (${prompts.length} chamadas)`);
    assert(!!prompts[1]?.includes(INSTRUCAO_DO_FIM), 'prompt reduzido contém a instrução do fim do pedido');

    console.log('\n=== S357-3 — análise de risco recebe o pedido íntegro ===');
    try { ToolRegistry.register(new ReadTool()); } catch { /* já registrado */ }
    const promptsRisco: string[] = [];
    const fRisco = {
        chatWithFallback: async (msgs: Array<{ content: string }>) => { promptsRisco.push(msgs[0]?.content ?? ''); return { status: 'success', content: '{"risks": [], "plan": null}', attempts: [] }; },
        getBudgetAuxiliar: () => ({ timeoutMs: 1000, origem: 'padrao' }),
    } as any;
    const risco = new RiskAnalyzer(fRisco, ToolRegistry, { findHardConstraints: () => [], findToolFailures: () => '' } as never);
    const plano: PlanStep[] = [{ id: 'step_1', description: 'ler notas', toolName: 'read', toolArgs: { path: 'n.txt' }, fallbackSteps: [], status: 'pending' } as PlanStep];
    await quiet(() => risco.analyze(goal(), plano, []));
    assert(promptsRisco.length === 1 && promptsRisco[0].includes(INSTRUCAO_DO_FIM), 'prompt da análise de risco contém a instrução do fim do pedido');
    assert(promptsRisco[0]?.includes(`OBJETIVO: ${RESUMO}`) && promptsRisco[0]?.includes(`PEDIDO ORIGINAL DO USUÁRIO: ${PEDIDO}`), 'o resumo continua, acompanhado do original (resumo nunca substitui)');

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S357 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}
main().catch((err) => { console.error('S357 erro inesperado:', err); process.exitCode = 1; });
