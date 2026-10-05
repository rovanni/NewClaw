/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S325 (issue 053)
 *
 * Achado em 04/10/2026 (instância isolada, nuvem do Ollama em HTTP 429 — cota de 5 horas esgotada):
 * a mensagem fixa de provedor indisponível ("Todos os providers estão temporariamente indisponíveis…",
 * "Não foi possível obter resposta do provedor…") virava o output de steps agentloop com 'success'.
 * O goal queimou 12 ciclos e 5 replans em 1,3 s. Mesmo padrão da issue 049.
 *
 * Correção: o AgentLoop devolve `ProcessedResult.providerFailure` (fato) e o GoalExecutionLoop
 * registra failure SEM output; retry uma vez no step; se o step falhar de novo por provedor, o goal
 * termina com `environment_limit` e a mensagem honesta, sem queimar replans.
 *
 * Execução: npx ts-node src/__tests__/regression/S325_ProviderFailure_StructuredSignalToGoal.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { AgentLoop } from '../../loop/AgentLoop';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';
import { MemoryManager } from '../../memory/MemoryManager';
import type { Goal, PlanStep, GoalAttempt } from '../../loop/GoalTypes';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const INDISPONIVEL = 'Todos os providers estão temporariamente indisponíveis. Tente novamente em alguns segundos.';

function makeAgentLoop(llm: () => Record<string, unknown>): AgentLoop {
    const providerFactory = {
        chatWithFallback: async () => llm(),
        getProvider: () => ({ name: 'fake' }),
        getDefaultProvider: () => 'ollama', // contrato do ProviderFactory lido pelo ModelProfileRegistry (issue 054 D2)
        getProviderWithModel: () => ({ chat: async () => ({ status: 'success', content: '{}' }) }),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
    const db = new (Database as any)(':memory:');
    const memory = { semanticSearch: async () => [], addMessage: async () => {}, getDatabase: () => db } as unknown as MemoryManager;
    const loop = new AgentLoop(
        providerFactory, memory, { languageDirective: 'pt-BR', systemPrompt: 'teste S325' } as any,
        { recordPattern: () => {}, getPatterns: () => [] } as any,
        { getSkillContextForQuery: async () => '', getAllSkills: () => [], loadAll: () => [] } as any,
        { store: () => {} } as any, { store: () => {}, getStats: () => ({}), recordFromLoop: () => {}, getToolStats: () => [] } as any,
    );
    // Mesmo stub de sessão do S83: o pipeline de sessão é obrigatório no runWithTools.
    loop.setSessionContext({
        buildLLMMessages: async () => ({
            messages: [{ role: 'user', content: 'redija a aula 06' }],
            stats: { fromCheckpoint: false, recentMessages: 0, totalTranscriptEntries: 0, semanticContextUsed: false, tokenEstimate: 0, budgetUsed: 0, budgetMax: 4000 },
        }),
        getContextBuilder: () => ({ getLastBuildMetadata: () => ({}) }),
        getSessionManager: () => ({ recordToolCall: async () => {} }),
    } as any);
    return loop;
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (): boolean => true;
    try { return await fn(); } finally { process.stdout.write = orig; }
}

function makeGoal(retryBudget: number, attempts: GoalAttempt[] = []) {
    const step = { id: 'step_3', description: 'Redigir a aula 06' } as PlanStep;
    const goal = { id: 'goal_s325', retryBudget, currentPlan: [step], attempts, planGeneration: 0 } as unknown as Goal;
    const recorded: GoalAttempt[] = [];
    const loop = Object.create(GoalExecutionLoop.prototype) as GoalExecutionLoop;
    (loop as any).goalStore = { addAttempt: (_id: string, a: GoalAttempt) => { recorded.push(a); } };
    return { goal, step, loop, recorded };
}

async function main(): Promise<void> {

console.log('\n=== S325-1 — AgentLoop real: provedor indisponível sai como fato estruturado ===');
{
    const loop = makeAgentLoop(() => ({ status: 'error', content: INDISPONIVEL, fallbackReason: 'unavailable', fallbackMessage: INDISPONIVEL, attempts: [] }));
    const r = await quiet(() => loop.process('conv-s325-1', 'redija a aula 06', 'conv-s325-1', { channel: 'test', chatId: 'conv-s325-1' }));
    assert(typeof r !== 'string', 'o resultado é um ProcessedResult', r);
    const pf = typeof r === 'string' ? undefined : r.providerFailure;
    assert(pf?.status === 'error' && pf.reason === 'unavailable', 'providerFailure { status: error, reason: unavailable }', pf);
    assert((typeof r === 'string' ? r : r.text) === INDISPONIVEL, 'fora de goal o usuário continua recebendo a mesma mensagem', r);
}

console.log('\n=== S325-2 — AgentLoop real: timeout do provedor também ===');
{
    const loop = makeAgentLoop(() => ({ status: 'timeout', content: '', fallbackReason: 'timeout', fallbackMessage: 'O modelo demorou mais que o esperado.', attempts: [] }));
    const r = await quiet(() => loop.process('conv-s325-2', 'redija a aula 06', 'conv-s325-2', { channel: 'test', chatId: 'conv-s325-2' }));
    const pf = typeof r === 'string' ? undefined : r.providerFailure;
    assert(pf?.status === 'timeout', 'providerFailure { status: timeout }', r);
}

console.log('\n=== S325-3 — AgentLoop real: resposta normal não carrega o sinal ===');
{
    const loop = makeAgentLoop(() => ({ status: 'success', content: 'Aqui está a aula 06.', attempts: [{ provider: 'fake', model: 'm', duration: 1, status: 'success' }] }));
    const r = await quiet(() => loop.process('conv-s325-3', 'oi', 'conv-s325-3', { channel: 'test', chatId: 'conv-s325-3' }));
    assert(typeof r === 'string' || !r.providerFailure, 'sem providerFailure', r);
}

console.log('\n=== S325-4 — GoalExecutionLoop: 1ª falha de provedor no step → retry, attempt sem output ===');
{
    const { goal, step, loop, recorded } = makeGoal(3);
    const r = (loop as any).handleProviderFailure(goal, step, 1, Date.now(), { status: 'error', reason: 'unavailable' }, INDISPONIVEL);
    assert(r.outcome === 'partial', 'outcome partial (uma nova tentativa)', r);
    assert(recorded.length === 1 && recorded[0].result === 'failure' && recorded[0].output === undefined, 'attempt failure SEM output', recorded);
    assert(recorded[0].error === 'provider_unavailable:error:unavailable', 'erro estruturado no attempt', recorded[0].error);
    assert(r.blocker.kind === 'environment_limit' && !/retryBudget|provider_unavailable/.test(r.blocker.userSummary), 'blocker environment_limit com userSummary sem jargão', r.blocker);
}

console.log('\n=== S325-5 — GoalExecutionLoop: 2ª falha seguida no MESMO step → failed (não queima replans) ===');
{
    const prior = [{ planStepId: 'step_3', toolName: 'agentloop', result: 'failure', error: 'provider_unavailable:error:unavailable' } as GoalAttempt];
    const { goal, step, loop } = makeGoal(3, prior);
    const r = (loop as any).handleProviderFailure(goal, step, 2, Date.now(), { status: 'error', reason: 'unavailable' }, INDISPONIVEL);
    assert(r.outcome === 'failed', 'outcome failed', r);
    assert(r.output === INDISPONIVEL, 'a mensagem honesta vai como fato para a mensagem de falha do goal', r.output);
    assert(/segunda vez seguida/.test(r.blocker.description), 'descrição registra a repetição', r.blocker.description);

    const other = [{ planStepId: 'step_3', toolName: 'agentloop', result: 'failure', error: 'grounding_blocked:REJECTED' } as GoalAttempt];
    const g2 = makeGoal(3, other);
    assert((g2.loop as any).handleProviderFailure(g2.goal, g2.step, 2, Date.now(), { status: 'timeout' }, 'x').outcome === 'partial', 'falha anterior de OUTRA natureza não conta como repetição');

    const g3 = makeGoal(0);
    assert((g3.loop as any).handleProviderFailure(g3.goal, g3.step, 1, Date.now(), { status: 'timeout' }, 'x').outcome === 'failed', 'sem retryBudget → failed já na 1ª');
}

console.log('\n=== S325-6 — estrutural: o goal decide pelo campo, antes de tratar o texto como resposta ===');
{
    const src = fs.readFileSync(path.join(__dirname, '../../loop/GoalExecutionLoop.ts'), 'utf-8');
    const idx = src.indexOf('response.providerFailure');
    assert(idx > 0 && idx < src.indexOf('const relatedTrace = traceManager'), 'desvio por response.providerFailure antes do tratamento do texto');
    assert(!src.includes('Todos os providers estão temporariamente') && !src.includes('Não foi possível obter resposta do provedor'), 'nenhuma comparação com o texto da mensagem');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S325 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
}

main().catch((err) => { console.error('S325 erro inesperado:', err); process.exitCode = 1; });
