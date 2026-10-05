/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S327 (issue 055)
 *
 * A mensagem final de falha terminava sempre com "Você pode reformular o pedido…" — inclusive quando
 * o motivo era o modelo de linguagem fora do ar (issue 053, validação com a nuvem em HTTP 429), onde
 * reformular não ajuda. E `handleFailedOutcome` montava a mensagem com o `goal` anterior ao
 * `recordBlocker`: um bloqueio registrado na mesma hora (falha já na 1ª tentativa) não aparecia nela.
 *
 * REGRESSÃO SE: `environment_limit` voltar a sugerir reformular; os demais tipos perderem a sugestão
 * original; ou o bloqueio recém-gravado sumir da mensagem.
 *
 * Execução: npx ts-node src/__tests__/regression/S327_FailureMessage_NextStepByBlockerKind.test.ts
 */
import { GracefulDeliveryOrchestrator } from '../../loop/GracefulDeliveryOrchestrator';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';
import type { Goal, GoalBlocker, PlanStep } from '../../loop/GoalTypes';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const REFORMULAR = 'Você pode reformular o pedido';
const TENTAR_DE_NOVO = 'tente de novo quando o serviço voltar a responder';

const blocker = (kind: GoalBlocker['kind'], userSummary: string): GoalBlocker =>
    ({ kind, description: 'interno', userSummary, suggestedActions: [], detectedAt: Date.now() });

function goalWith(blockers: GoalBlocker[]): Goal {
    return {
        id: 'goal_s327', userIntent: 'Analise as aulas', objective: 'x', status: 'executing',
        currentPlan: [], attempts: [], blockers, toolsTried: [], strategiesTried: [], sentArtifacts: [],
    } as unknown as Goal;
}

async function quiet<T>(fn: () => Promise<T> | T): Promise<T> {
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (): boolean => true;
    try { return await fn(); } finally { process.stdout.write = orig; }
}

async function main(): Promise<void> {
const gd = new GracefulDeliveryOrchestrator();

console.log('\n=== S327-1 — próximo passo pelo tipo do último bloqueio ===');
{
    const env = await quiet(() => gd.buildFailureMessage(goalWith([blocker('environment_limit', 'O modelo de linguagem não respondeu.')])));
    assert(env.includes(TENTAR_DE_NOVO) && !env.includes(REFORMULAR), 'environment_limit → "tente de novo quando o serviço voltar"', env);
    const sem = await quiet(() => gd.buildFailureMessage(goalWith([blocker('semantic_mismatch', 'A etapa não produziu o esperado.')])));
    assert(sem.includes(REFORMULAR) && !sem.includes(TENTAR_DE_NOVO), 'outros tipos mantêm "reformular o pedido"', sem);
    const nenhum = await quiet(() => gd.buildFailureMessage(goalWith([])));
    assert(nenhum.includes(REFORMULAR), 'sem bloqueio → texto original');
    const ultimo = await quiet(() => gd.buildFailureMessage(goalWith([blocker('environment_limit', 'a'), blocker('tool_error', 'b')])));
    assert(ultimo.includes(REFORMULAR), 'vale o ÚLTIMO bloqueio');
}

console.log('\n=== S327-2 — handleFailedOutcome mostra o bloqueio gravado na mesma hora ===');
{
    const step = { id: 'step_1', description: 'Redigir a aula' } as PlanStep;
    const stale = goalWith([]);
    let stored = goalWith([]);
    const loop = Object.create(GoalExecutionLoop.prototype) as GoalExecutionLoop;
    (loop as any).goalStore = {
        recordBlocker: (_id: string, b: GoalBlocker) => { stored = { ...stored, blockers: [...stored.blockers, b] } as Goal; },
        setStatus: () => {},
        getById: () => stored,
    };
    (loop as any).gracefulDelivery = gd;
    (loop as any).recordFailedStrategy = () => {};
    (loop as any).updateProgressModel = () => {};
    (loop as any).buildResult = (_g: Goal, _ok: boolean, _c: number, _r: number, text: string) => ({ finalOutput: text });
    const env = blocker('environment_limit', 'O modelo de linguagem não respondeu (serviço indisponível ou limite de uso atingido).');
    const r = await quiet(() => (loop as any).handleFailedOutcome(stale, step, { outcome: 'failed', confidence: 0.1, blocker: env, output: 'Todos os providers estão indisponíveis.' }, 2, 0, { cognitiveContext: undefined }, undefined));
    const text: string = r.result.finalOutput;
    assert(text.includes('O que faltou:** O modelo de linguagem não respondeu'), 'o bloqueio gravado agora aparece em "O que faltou"', text);
    assert(text.includes(TENTAR_DE_NOVO), 'e define o próximo passo', text);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S327 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
}

main().catch((err) => { console.error('S327 erro inesperado:', err); process.exitCode = 1; });
