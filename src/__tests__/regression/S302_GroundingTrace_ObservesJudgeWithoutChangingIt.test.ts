/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S302 (campanha S-E, issue 048)
 * `[GROUNDING-TRACE]` e `[PLAN-TRACE]`: observabilidade do caminho de conclusão do objetivo.
 * Só observa — o veredito do juiz é idêntico com e sem o trace.
 *
 *   1  → o veredito traz TODAS as afirmações (não só a primeira) com veredito e evidência citada.
 *   2  → evidência maior que o limite do juiz é marcada como truncada (chars originais × chars vistos).
 *   3  → por padrão, nenhum texto de evidência/resposta vai ao log; com TRACE_CONTENT=true, vai.
 *   4  → todos os caminhos de saída emitem o trace (sem evidência, prompt grande, juiz falhou, saída inválida).
 *   5  → goalId/stepId/traceId atravessam o contexto até o log.
 *   6  → o veredito e o estado não mudam com o trace ligado ou desligado.
 *   7  → `[PLAN-TRACE]` distingue critério do Planner (`planner`) de critério acrescentado (`auto`).
 *
 * Execução: npx ts-node src/__tests__/regression/S302_GroundingTrace_ObservesJudgeWithoutChangingIt.test.ts
 */
process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import { ObserverValidator, EvidenceItem } from '../../loop/ObserverValidator';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';
import { Goal, PlanStep, SuccessCriterion } from '../../loop/GoalTypes';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

function fakeFactory(kind: 'ok' | 'fail' | 'malformed', judgeJson = ''): import('../../core/ProviderFactory').ProviderFactory {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getBudgetAuxiliar } = require('../../shared/auxTimeout');
    return {
        chatWithFallback: async () => {
            if (kind === 'fail') return { status: 'error', content: '', attempts: [{ errorMessage: 'provedor fora' }] };
            return { status: 'success', content: kind === 'malformed' ? 'isto não é json' : judgeJson, attempts: [] };
        },
        getBudgetAuxiliar: (p: 'classificacao' | 'validacao') => getBudgetAuxiliar(p, null, null),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
}

async function captureLogs<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (chunk: string | Uint8Array): boolean => { lines.push(String(chunk)); return true; };
    try { return { value: await fn(), lines }; } finally { process.stdout.write = orig; }
}
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const traces = (lines: string[], tag: string) => lines.map(strip).filter(l => l.includes(`${tag} {`))
    .map(l => JSON.parse(l.slice(l.indexOf(`${tag} `) + tag.length + 1)));

const judgeJson = JSON.stringify({ claims: [
    { claim: 'Hoje é 26/09/2026', evidence: [], verdict: 'NOT_EVALUABLE' },
    { claim: 'O programa imprime 17 anos', evidence: ['E1'], verdict: 'SUPPORTED' },
    { claim: 'O arquivo tem 36 linhas', evidence: ['E1'], verdict: 'SUPPORTED' },
] });
const bigOutput = 'x'.repeat(5000) + ' SEGREDO-DA-EVIDENCIA';
const evidences: EvidenceItem[] = [{ id: 'E1', tool: 'read', input: '{"path":"a.py"}', output: bigOutput }];
const response = 'Hoje é 26/09/2026. O programa imprime 17 anos. O arquivo tem 36 linhas.';

async function main(): Promise<void> {
    delete process.env.TRACE_CONTENT;

    console.log('\n=== S302-1/2/3 — trace estrutural (padrão): todas as afirmações, truncamento, sem conteúdo ===');
    {
        const v = new ObserverValidator(fakeFactory('ok', judgeJson), 'm');
        const { value: verdict, lines } = await captureLogs(() => v.validateGrounding(response, evidences));
        const t = traces(lines, '[GROUNDING-TRACE]');
        assert(t.length === 1, 'exatamente uma linha [GROUNDING-TRACE]', t.length);
        const r = t[0];
        assert(r.outcome === 'verdict' && r.state === 'NOT_EVALUABLE', 'outcome=verdict, state=NOT_EVALUABLE', r);
        assert(r.claims.length === 3 && r.claims.map((c: { verdict: string }) => c.verdict).join() === 'NOT_EVALUABLE,SUPPORTED,SUPPORTED', 'TODAS as 3 afirmações com veredito', r.claims);
        assert(JSON.stringify(r.claimCounts) === '{"SUPPORTED":2,"NOT_SUPPORTED":0,"NOT_EVALUABLE":1}', 'contagem por veredito', r.claimCounts);
        assert(r.claims[1].evidence[0] === 'E1', 'evidência citada por afirmação');
        assert(r.evidences[0].outputChars === 5021 && r.evidences[0].sentChars === 2000 && r.evidences[0].truncated === true, 'evidência truncada: 5021 chars originais, 2000 vistos pelo juiz', r.evidences);
        const raw = lines.map(strip).join('');
        assert(!raw.includes('SEGREDO-DA-EVIDENCIA') && !raw.includes('O programa imprime 17 anos.'), 'sem texto de evidência/resposta no log por padrão');
        assert(typeof r.responseHash === 'string' && r.responseHash.length === 8, 'hash da resposta presente');
        assert(verdict.state === 'NOT_EVALUABLE', 'veredito devolvido normalmente');
    }

    console.log('\n=== S302-3b — TRACE_CONTENT=true: texto da resposta, evidência exata e saída crua do juiz ===');
    {
        process.env.TRACE_CONTENT = 'true';
        const v = new ObserverValidator(fakeFactory('ok', judgeJson), 'm');
        const { lines } = await captureLogs(() => v.validateGrounding(response, evidences));
        const r = traces(lines, '[GROUNDING-TRACE]')[0];
        assert(r.responseText === response, 'texto da resposta avaliada');
        assert(r.evidenceSent[0].output.length === 2000 && !r.evidenceSent[0].output.includes('SEGREDO-DA-EVIDENCIA'), 'evidência EXATAMENTE como o juiz a viu (2000 chars, sem o corte)');
        assert(typeof r.judgeRaw === 'string' && r.judgeRaw.includes('NOT_EVALUABLE'), 'saída crua do juiz');
        delete process.env.TRACE_CONTENT;
    }

    console.log('\n=== S302-4 — todos os caminhos de saída emitem o trace ===');
    {
        let lines = (await captureLogs(() => new ObserverValidator(fakeFactory('ok', judgeJson), 'm').validateGrounding(response, []))).lines;
        assert(traces(lines, '[GROUNDING-TRACE]')[0]?.outcome === 'skipped_no_evidence', 'sem evidência');
        lines = (await captureLogs(() => new ObserverValidator(fakeFactory('fail'), 'm').validateGrounding(response, evidences))).lines;
        const f = traces(lines, '[GROUNDING-TRACE]')[0];
        assert(f?.outcome === 'judge_failed' && f.state === 'UNVALIDATED' && f.judgeError === 'provedor fora', 'juiz falhou', f);
        lines = (await captureLogs(() => new ObserverValidator(fakeFactory('malformed'), 'm').validateGrounding(response, evidences))).lines;
        assert(traces(lines, '[GROUNDING-TRACE]')[0]?.outcome === 'malformed_judge_output', 'saída inválida do juiz');
        lines = (await captureLogs(() => new ObserverValidator(fakeFactory('ok', judgeJson), 'm').validateGrounding('y'.repeat(200000), evidences))).lines;
        assert(traces(lines, '[GROUNDING-TRACE]')[0]?.outcome === 'prompt_too_long', 'prompt grande demais');
    }

    console.log('\n=== S302-5 — goalId/stepId/traceId atravessam até o log ===');
    {
        const v = new ObserverValidator(fakeFactory('ok', judgeJson), 'm');
        const { lines } = await captureLogs(() => v.validateGrounding(response, evidences, undefined,
            { traceId: 'tr1', conversationId: 'cv1', goalId: 'goal_x', stepId: 'step_5', stepDescription: 'Redigir a resposta final', planGeneration: 1, phase: 'initial' }));
        const r = traces(lines, '[GROUNDING-TRACE]')[0];
        assert(r.goalId === 'goal_x' && r.stepId === 'step_5' && r.traceId === 'tr1' && r.stepDescription === 'Redigir a resposta final' && r.planGeneration === 1, 'contexto completo no registro', r);
    }

    console.log('\n=== S302-6 — o trace não muda o veredito ===');
    {
        const mk = () => new ObserverValidator(fakeFactory('ok', judgeJson), 'm');
        const a = await captureLogs(() => mk().validateGrounding(response, evidences));
        process.env.TRACE_CONTENT = 'true';
        const b = await captureLogs(() => mk().validateGrounding(response, evidences));
        delete process.env.TRACE_CONTENT;
        const strip2 = (x: { state: string; claims: unknown; reason: string }) => JSON.stringify({ s: x.state, c: x.claims, r: x.reason });
        assert(strip2(a.value) === strip2(b.value), 'mesmo estado, afirmações e motivo com trace estrutural e com conteúdo');
    }

    console.log('\n=== S302-7 — [PLAN-TRACE]: critério do Planner × critério acrescentado ===');
    {
        const goal = { id: 'goal_p', userIntent: 'Crie um programa e me envie o .py', planGeneration: 0 } as unknown as Goal;
        const steps: PlanStep[] = [
            { id: 'step_1', description: 'Criar o programa', toolName: undefined, fallbackSteps: [], status: 'pending' },
            { id: 'step_2', description: 'Enviar o arquivo', toolName: 'send_document', toolArgs: {}, fallbackSteps: [], status: 'pending' },
            { id: 'step_3', description: 'Redigir a resposta final', fallbackSteps: [], status: 'pending' },
        ];
        const plannerCriteria = [{ id: 'c1', description: 'arquivo existe', check: 'file_exists', status: 'pending' }] as unknown as SuccessCriterion[];
        const all = [
            ...plannerCriteria,
            { id: 'auto_delivery_send_document', description: 'x', check: 'tool_succeeded', status: 'pending' },
            { id: 'auto_response_produced', description: 'y', check: 'response_produced', status: 'pending' },
        ] as unknown as SuccessCriterion[];
        const { lines } = await captureLogs(async () => {
            (GoalExecutionLoop.prototype as unknown as { tracePlan: Function }).tracePlan.call({}, goal, 'initial', steps, all, plannerCriteria, 'creation');
        });
        const r = traces(lines, '[PLAN-TRACE]')[0];
        assert(r && r.goalId === 'goal_p' && r.intentCategory === 'creation' && r.intentChars === 33, 'goal, categoria e tamanho do pedido', r);
        assert(r.steps.length === 3 && r.steps[2].description === 'Redigir a resposta final', 'descrição de cada passo do plano', r.steps);
        const src = Object.fromEntries(r.criteria.map((c: { id: string; source: string }) => [c.id, c.source]));
        assert(src.c1 === 'planner' && src.auto_delivery_send_document === 'auto' && src.auto_response_produced === 'auto', 'origem de cada critério (planner × auto)', src);
    }

    delete process.env.TRACE_CONTENT;
    console.log(`\nS302 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
