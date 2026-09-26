/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S301 (campanha S-D, issue 048)
 * Modo sombra do RiskAnalyzer: a revisão por LLM é OBSERVADA, nunca aplicada.
 *
 *   1  → flag desligada (padrão): analyze() é o que era — aplica a revisão.
 *   2  → flag ligada: o plano real é o original; a proposta do revisor não chega a `adjustedPlan`,
 *        a `risks` nem a `planRejected`.
 *   3  → flag ligada: analyze() NÃO espera pelo revisor (a latência da revisão sai do caminho real).
 *   4  → o revisor trabalha sobre cópias: nem ele muda o plano real, nem o plano real muda o que ele viu.
 *   5  → a linha [RISK-SHADOW] traz plano antes, proposta crua, proposta final, diff, reparos do
 *        sanitizer e desfecho — fatos, sem julgamento.
 *   6  → falha/timeout e "plan:null" (confirmação) também são registrados.
 *   7  → exceção dentro da observação nunca chega ao chamador.
 *   8  → nenhuma linha do modo sombra se passa por efeito real (`created_by=risk_analyzer`).
 *
 * Execução: npx ts-node src/__tests__/regression/S301_RiskAnalyzer_ShadowReview_ObservesWithoutApplying.test.ts
 */
process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import { RiskAnalyzer } from '../../loop/RiskAnalyzer';
import { ToolRegistry } from '../../core/ToolRegistry';
import { ReadTool } from '../../tools/read_tool';
import { WriteTool } from '../../tools/write_tool';
import { ExecCommandTool } from '../../tools/exec_command';
import { SendDocumentTool } from '../../tools/send_document';
import { Goal, PlanStep } from '../../loop/GoalTypes';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

try { ToolRegistry.register(new ReadTool()); } catch { /* já registrado */ }
try { ToolRegistry.register(new WriteTool()); } catch { /* já registrado */ }
try { ToolRegistry.register(new ExecCommandTool(), { dangerous: true }); } catch { /* já registrado */ }
try { ToolRegistry.register(new SendDocumentTool({} as never)); } catch { /* já registrado */ }

function makeGoal(objective: string): Goal {
    const now = Date.now();
    return {
        id: `goal_s301_${now}`, sessionKey: 'test:user', conversationId: 'test-conv', userIntent: objective, objective,
        status: 'planning', currentPlan: [], attempts: [], blockers: [], toolsTried: [], strategiesTried: [],
        successCriteria: [], retryBudget: 3, replanBudget: 5, confidence: 0.9, requiresAuth: false,
        authorizationScope: [], createdAt: now, updatedAt: now, expiresAt: now + 3_600_000,
    } as unknown as Goal;
}

const fakeReflectionMemory = { findHardConstraints: () => [], findToolFailures: () => '' } as unknown as
    import('../../memory/ReflectionMemory').ReflectionMemory;
const noStub = async () => ({ isStub: false, reason: 'mock' });

/** Captura o que o logger escreve em stdout durante `fn`. */
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (chunk: string | Uint8Array): boolean => { lines.push(String(chunk)); return true; };
    try { return { value: await fn(), lines }; }
    finally { process.stdout.write = orig; }
}
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const shadowRecords = (lines: string[]) => lines.map(strip).filter(l => l.includes('[RISK-SHADOW] {'))
    .map(l => JSON.parse(l.slice(l.indexOf('[RISK-SHADOW] ') + '[RISK-SHADOW] '.length)));

const realPlan = (): PlanStep[] => [
    { id: 'step_1', description: 'gerar arquivo', toolName: 'exec_command', toolArgs: { command: 'echo oi' }, fallbackSteps: [], status: 'pending' },
    { id: 'step_2', description: 'ler resultado', toolName: 'read', toolArgs: { path: 'a.txt' }, fallbackSteps: [], status: 'pending' },
];
// Proposta do revisor: acrescenta um send_document SEM file_path (o sanitizer o conserta em AgentLoop).
const proposal = JSON.stringify({
    risks: ['falta entregar o arquivo'],
    plan: [
        { id: 'step_1', description: 'gerar arquivo', toolName: 'exec_command', toolArgs: { command: 'echo oi' } },
        { id: 'step_2', description: 'ler resultado', toolName: 'read', toolArgs: { path: 'a.txt' } },
        { id: 'step_3', description: 'enviar o arquivo ao usuário', toolName: 'send_document', toolArgs: {} },
    ],
});

async function main(): Promise<void> {
    let response = proposal;
    let delayMs = 0;
    let throwInLLM = false;
    const provider = {
        chatWithFallback: async () => {
            if (delayMs) await new Promise(r => setTimeout(r, delayMs));
            if (throwInLLM) throw new Error('boom');
            return { status: 'success', content: response, attempts: [] };
        },
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
    const analyzer = new RiskAnalyzer(provider, ToolRegistry, fakeReflectionMemory, noStub);

    console.log('\n=== S301-1 — flag desligada: comportamento de sempre (revisão aplicada) ===');
    delete process.env.RISK_REVIEW_SHADOW;
    {
        const plan = realPlan();
        const { value: report, lines } = await captureLogs(() => analyzer.analyze(makeGoal('x'), plan, []));
        assert(report.planAdjusted === true && report.adjustedPlan.length === 3, 'revisão aplicada (3 steps)', report.adjustedPlan.length);
        assert(report.risks.includes('falta entregar o arquivo'), 'risco do LLM presente', report.risks);
        assert(shadowRecords(lines).length === 0, 'nenhuma linha [RISK-SHADOW]');
    }

    console.log('\n=== S301-2 — flag ligada: plano real é o do Planner; nada da revisão o atravessa ===');
    process.env.RISK_REVIEW_SHADOW = 'true';
    {
        const plan = realPlan();
        const goal = makeGoal('x');
        const before = JSON.stringify(plan);
        const { value: report } = await captureLogs(async () => {
            const r = await analyzer.analyze(goal, plan, []);
            await new Promise(res => setTimeout(res, 50)); // deixa a observação em segundo plano terminar
            return r;
        });
        assert(report.planAdjusted === false && report.adjustedPlan.length === 2, 'plano real inalterado (2 steps)', report.adjustedPlan.length);
        assert(!report.risks.includes('falta entregar o arquivo'), 'risco do LLM NÃO entra em risks', report.risks);
        assert(!report.planRejected, 'sem rejeição vinda do revisor');
        assert(JSON.stringify(plan) === before, 'objeto do plano real não foi mutado');
    }

    console.log('\n=== S301-3 — analyze() não espera pelo revisor ===');
    {
        delayMs = 400;
        const t0 = Date.now();
        await captureLogs(() => analyzer.analyze(makeGoal('x'), realPlan(), []));
        const elapsed = Date.now() - t0;
        assert(elapsed < 250, `analyze retornou sem esperar a revisão de 400 ms (${elapsed} ms)`, elapsed);
        await new Promise(r => setTimeout(r, 500)); // não deixar a chamada pendurada para o próximo caso
        delayMs = 0;
    }

    console.log('\n=== S301-4/5 — cópias e conteúdo do registro [RISK-SHADOW] ===');
    {
        const plan = realPlan();
        const goal = makeGoal('x');
        const { lines } = await captureLogs(() => analyzer.observeShadowReview(goal, plan));
        const recs = shadowRecords(lines);
        assert(recs.length === 1, 'exatamente uma linha [RISK-SHADOW]', recs.length);
        const r = recs[0];
        assert(r.goalId === goal.id && typeof r.startedAt === 'number' && typeof r.durationMs === 'number', 'goalId/startedAt/durationMs presentes (correlação com o desfecho real)', r);
        assert(r.before.length === 2 && r.before[0].tool === 'exec_command', 'plano antes registrado', r.before);
        assert(Array.isArray(r.rawProposal) && r.rawProposal.length === 3, 'proposta crua do LLM registrada (3 steps)', r.rawProposal);
        assert(r.diff && r.diff.stepCountDelta === 1 && r.diff.added.length === 1, 'diff estrutural: +1 step', r.diff);
        assert(r.sanitizerMutations.length === 1 && r.sanitizerMutations[0].originalTool === 'send_document', 'reparo do sanitizer sobre a proposta registrado', r.sanitizerMutations);
        assert(r.outcome === 'proposed' && r.planAdjusted === true && r.llmStatus === 'success', 'desfecho/estado do LLM registrados', r);
        assert(!JSON.stringify(r).includes('echo oi'), 'args crus não vão para o log (só hash)');
        assert(plan.length === 2, 'plano real não mutado pelo revisor');
    }

    console.log('\n=== S301-6 — confirmação (plan:null) e falha também são registradas ===');
    {
        response = '{"risks": [], "plan": null}';
        let { lines } = await captureLogs(() => analyzer.observeShadowReview(makeGoal('x'), realPlan()));
        let r = shadowRecords(lines)[0];
        assert(r && r.outcome === 'confirmed' && r.diff === null, 'plan:null → outcome=confirmed', r);
        response = 'sem json algum';
        ({ lines } = await captureLogs(() => analyzer.observeShadowReview(makeGoal('x'), realPlan())));
        r = shadowRecords(lines)[0];
        assert(r && r.outcome === 'no_json', 'resposta sem JSON → outcome=no_json', r);
        response = proposal;
    }

    console.log('\n=== S301-7 — exceção na observação nunca chega ao chamador ===');
    {
        throwInLLM = true;
        let threw = false;
        try {
            await captureLogs(async () => { await analyzer.analyze(makeGoal('x'), realPlan(), []); await new Promise(r => setTimeout(r, 50)); });
            await captureLogs(() => analyzer.observeShadowReview(makeGoal('x'), realPlan()));
        } catch { threw = true; }
        assert(!threw, 'nem analyze() nem observeShadowReview() propagam exceção');
        throwInLLM = false;
    }

    console.log('\n=== S301-8 — nenhuma linha do modo sombra se passa por efeito real ===');
    {
        const { lines } = await captureLogs(() => analyzer.observeShadowReview(makeGoal('x'), realPlan()));
        const txt = lines.map(strip).join('');
        assert(!/created_by=risk_analyzer(?!_shadow)/.test(txt), 'STEP-MUTATION do sombra usa created_by=risk_analyzer_shadow', txt.match(/created_by=\S+/g));
        assert(!/\[RiskAnalyzer\] (LLM review|adjusted step)/.test(txt), 'sem prefixo "[RiskAnalyzer]" de efeito real nas linhas da revisão', txt.match(/\[RiskAnalyzer\][^\n]{0,60}/g));
    }

    delete process.env.RISK_REVIEW_SHADOW;
    console.log(`\nS301 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
