/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S408
 * Num replanejamento, o juiz de risco do plano vê O QUE JÁ FOI FEITO no objetivo — inclusive o começo do goal.
 *
 * ORIGEM (Telegram, 15/10/2026, campo "dificuldade" do juiz `risco_do_plano`): "O step 2 se apoia em dados de SSD
 * SATA/NVMe/eMMC/UFS vindos de uma 'pesquisa já concluída' que não aparece como passo do plano; isso dificultou avaliar o
 * item de dependências". O juiz recebia só pedido, plano, objetivo e ferramentas: as pesquisas feitas antes do
 * replanejamento eram invisíveis para ele.
 *
 * REGRESSÃO SE: o juiz do plano deixar de receber o que já foi feito; ou receber só os últimos passos (as pesquisas do
 * começo do goal ficarem de fora); ou o resumo deixar de ser declarado no rótulo.
 *
 * Execução: npx ts-node src/__tests__/regression/S408_JuizDoPlano_VeOQueJaFoiFeito.test.ts
 */
import { RiskAnalyzer } from '../../loop/RiskAnalyzer';
import { buildAttemptFactsBlock } from '../../loop/GoalPlanner';
import { ToolRegistry } from '../../core/ToolRegistry';
import { ReadTool } from '../../tools/read_tool';
import type { Goal, GoalAttempt, PlanStep } from '../../loop/GoalTypes';
import { vereditoRisco, tipoDaPerguntaDoMotor } from './_fixtures/veredito';

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

const tentativa = (n: number, toolName: string, args: Record<string, unknown>, output: string): GoalAttempt =>
    ({ id: `a${n}`, planStepId: `step_${n}`, toolName, args, result: 'success', output, durationMs: 1, executedAt: Date.now() } as GoalAttempt);

// O goal real: duas pesquisas no começo, depois oito tentativas de redigir/gerar — o replanejamento vem no fim.
const tentativas: GoalAttempt[] = [
    tentativa(1, 'web_search', { query: 'HD CMR SMR diferença' }, 'PESQUISA-1: CMR grava trilhas separadas; SMR sobrepõe trilhas e é mais lento na escrita.'),
    tentativa(2, 'web_search', { query: 'SSD SATA vs NVMe velocidade' }, 'PESQUISA-2: SATA III ~550 MB/s; NVMe PCIe 3.0 x4 ~3.500 MB/s; eMMC e UFS em celulares.'),
    ...[3, 4, 5, 6, 7, 8, 9, 10].map(n => tentativa(n, 'agentloop', {}, `rascunho ${n} da estrutura da aula`)),
];

function goal(): Goal {
    const agora = Date.now();
    return {
        id: 'goal_s408', sessionKey: 't', conversationId: 'c', userIntent: 'crie uma aula sobre sistemas de armazenamento secundário',
        objective: 'aula sobre armazenamento secundário', status: 'replanning', currentPlan: [], attempts: tentativas, blockers: [],
        toolsTried: [], strategiesTried: [], successCriteria: [], sentArtifacts: [], retryBudget: 3, replanBudget: 5, confidence: 0.9,
        requiresAuth: false, authorizationScope: [], createdAt: agora, updatedAt: agora, expiresAt: agora + 3_600_000,
    } as unknown as Goal;
}

async function main(): Promise<void> {
    console.log('\n=== S408-1 — o prompt do juiz do plano traz o que já foi feito, desde o começo do goal ===');
    try { ToolRegistry.register(new ReadTool()); } catch { /* já registrado */ }
    const prompts: string[] = [];
    const factory = {
        chatWithFallback: async (msgs: Array<{ content: string }>) => {
            prompts.push(msgs[msgs.length - 1]?.content ?? '');
            return { status: 'success', content: tipoDaPerguntaDoMotor(msgs) === 'risco' ? vereditoRisco([]) : '{"risks": [], "plan": null}', attempts: [] };
        },
        getBudgetAuxiliar: () => ({ timeoutMs: 1000, origem: 'padrao' }),
    } as any;
    const risco = new RiskAnalyzer(factory, ToolRegistry, { findHardConstraints: () => [], findToolFailures: () => '' } as never);
    const plano: PlanStep[] = [{ id: 'step_1', description: 'Com base na pesquisa já concluída, montar os slides', toolName: 'read', toolArgs: { path: 'n.txt' }, fallbackSteps: [], status: 'pending' } as PlanStep];
    await quiet(() => risco.analyze(goal(), plano, []));
    const p = prompts.find(x => /^Você é um validador\. PERGUNTA: .*plano está completo/.test(x)) ?? '';
    assert(!!p, 'o juiz do plano foi chamado');
    assert(/\[O que já foi feito neste objetivo \(cada saída resumida em início e fim\)\]/.test(p), 'seção "o que já foi feito", com o resumo DECLARADO no rótulo', p.slice(0, 300));
    assert(p.includes('PESQUISA-1') && p.includes('PESQUISA-2'), 'as pesquisas do COMEÇO do goal estão lá (o bloco do replanejamento, de 5 passos, as perderia)');
    assert(p.includes('rascunho 10'), 'e o que veio depois também');
    assert(/já existe — usar isso não é dependência faltando/.test(p), 'o checklist diz que usar o que já foi feito não é dependência faltando');

    console.log('\n=== S408-2 — o bloco do replanejamento continua como era (padrões inalterados) ===');
    const doReplan = buildAttemptFactsBlock(tentativas);
    assert(!doReplan.includes('PESQUISA-1') && doReplan.includes('rascunho 10'), 'replanejamento: últimos 5 passos, como antes (S310/S313)');

    console.log('\n=== S408-3 — plano inicial (nada feito ainda): a seção não aparece ===');
    prompts.length = 0;
    const inicial = { ...goal(), attempts: [] } as Goal;
    await quiet(() => risco.analyze(inicial, plano, []));
    const p0 = prompts.find(x => /plano está completo/.test(x)) ?? '';
    assert(!!p0 && !/\[O que já foi feito neste objetivo/.test(p0), 'sem tentativas, sem seção vazia');

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S408 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}
main().catch((err) => { console.error('S408 erro inesperado:', err); process.exit(1); });
