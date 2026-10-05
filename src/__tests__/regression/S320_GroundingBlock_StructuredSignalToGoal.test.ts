/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S320 (issue 049)
 *
 * Achado em 04/10/2026 (banco de produção, 30 dias): 20 de 63 attempts `agentloop` de goals (32%)
 * tiveram como output a MENSAGEM FIXA da barreira de groundedness (ADR-010 C1 —
 * `AgentLoop.groundingBlockedMessage`), não a resposta do step. Ela chegava ao GoalExecutionLoop como
 * uma string comum: o StepSemanticValidator (um segundo avaliador LLM) relia a prosa e concluía
 * "output irrelevante" (retry de ~4 min, depois replan) e, em 6 attempts, a heurística a aceitou como
 * 'success' — saída elegível para entrega direta ao usuário como resposta final.
 *
 * Correção: o veredito sai do AgentLoop como FATO (`ProcessedResult.groundingBlock`, mesmo precedente
 * de `concurrentTurnRejected`/S224) e o GoalExecutionLoop aplica a política de recuperação que a
 * ADR-010 §10 atribui à camada superior: attempt 'failure' SEM output, afirmações não confirmadas como
 * fato na descrição do step, retry uma vez e depois 'blocked' (kind 'grounding_blocked') para replan.
 *
 * REGRESSÃO SE: o bloqueio voltar a sair só como string; o GoalExecutionLoop voltar a gravar a
 * mensagem fixa como output do attempt; o caminho passar pelo validador semântico; a detecção virar
 * comparação de texto; ou um commit aprovado deixar um bloqueio anterior "pendurado" no resultado.
 *
 * Execução: npx ts-node src/__tests__/regression/S320_GroundingBlock_StructuredSignalToGoal.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { AgentLoop } from '../../loop/AgentLoop';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';
import { MemoryManager } from '../../memory/MemoryManager';
import { ChannelContext, GroundingBlock, ProcessedResult } from '../../loop/agentLoopTypes';
import type { GroundingVerdict } from '../../loop/ObserverValidator';
import type { Goal, PlanStep, GoalAttempt } from '../../loop/GoalTypes';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const BLOCK_MESSAGES = [
    'Não consegui confirmar se a resposta é sustentada',
    'Não encontrei, nas fontes que consultei',
    'A resposta que eu ia enviar continha uma afirmação',
];

function makeAgentLoop(verdicts: Array<GroundingVerdict | Error>): AgentLoop {
    const providerFactory = {
        chatWithFallback: async () => ({ status: 'success', content: 'x', attempts: [] }),
        getProvider: () => ({ name: 'fake' }),
        getProviderWithModel: () => ({ chat: async () => ({ status: 'success', content: '{}' }) }),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
    const db = new (Database as any)(':memory:');
    const memory = { semanticSearch: async () => [], addMessage: async () => {}, getDatabase: () => db } as unknown as MemoryManager;
    const loop = new AgentLoop(
        providerFactory, memory, { languageDirective: 'pt-BR', systemPrompt: 'teste S320' } as any,
        { recordPattern: () => {}, getPatterns: () => [] } as any,
        { getSkillContextForQuery: async () => '', getAllSkills: () => [], loadAll: () => [] } as any,
        { store: () => {} } as any, { store: () => {}, getStats: () => ({}) } as any,
    );
    const queue = [...verdicts];
    (loop as any).observer = {
        validateResponseCommit: async () => ({ valid: true, hallucinationRisk: 0, blocked: false, validationMs: 1 }),
        validateGrounding: async () => {
            const v = queue.shift();
            if (v instanceof Error) throw v;
            return v;
        },
    };
    (loop as any).reflectionMemory = { record: () => {}, findToolFailures: () => null };
    // Isola a política de recuperação parcial (S269): este teste é sobre o que sai quando ela não entrega.
    (loop as any).trySynthesizePartialResponse = async () => null;
    return loop;
}

/** `run()` real com o `commitResponse()` real; só o laço de ferramentas é substituído por N commits. */
async function runTurn(loop: AgentLoop, conversationId: string, commits: number): Promise<string | ProcessedResult> {
    (loop as any).runWithTools = async (cid: string) => {
        const state = (loop as any).getTurnState(cid);
        state.lastToolExecution = { toolName: 'read', toolOutput: 'conteúdo lido', intent: 'x', category: 'information' };
        const trace = { id: `trace-${cid}`, steps: [{ type: 'tool_call', data: { tool: 'read', input: { path: 'a.md' } } }, { type: 'tool_result', data: { tool: 'read', success: true, output: 'conteúdo lido' } }] };
        let text = '';
        for (let i = 0; i < commits; i++) {
            text = await (loop as any).commitResponse(`resposta ${i}`, 'pedido', trace, cid, undefined, 0, { channel: 'test', chatId: cid } as ChannelContext);
        }
        return text;
    };
    return loop.run(conversationId, 'pedido', conversationId, { channel: 'test', chatId: conversationId });
}

const verdict = (state: GroundingVerdict['state'], claims: GroundingVerdict['claims'] = []): GroundingVerdict =>
    ({ state, claims, reason: 'r', elapsedMs: 1, budgetMs: 30000, budgetOrigin: 'padrao' } as GroundingVerdict);

function makeGoal(retryBudget: number, description = 'Calcular o valor em reais'): { goal: Goal; step: PlanStep; attempts: GoalAttempt[]; plans: PlanStep[][] } {
    const step: PlanStep = { id: 'step_4', description } as PlanStep;
    const attempts: GoalAttempt[] = [];
    const plans: PlanStep[][] = [];
    const goal = { id: 'goal_s320', retryBudget, currentPlan: [step], attempts, planGeneration: 0 } as unknown as Goal;
    return { goal, step, attempts, plans };
}

function makeExecLoop(attempts: GoalAttempt[], plans: PlanStep[][]): GoalExecutionLoop {
    const loop = Object.create(GoalExecutionLoop.prototype) as GoalExecutionLoop;
    (loop as any).goalStore = {
        addAttempt: (_id: string, a: GoalAttempt) => { attempts.push(a); },
        update: (_id: string, patch: { currentPlan?: PlanStep[] }) => { if (patch.currentPlan) plans.push(patch.currentPlan); },
    };
    return loop;
}

async function main(): Promise<void> {

console.log('\n=== S320-1 — AgentLoop: bloqueio sai como fato estruturado, com o estado e as afirmações não confirmadas ===');
{
    const loop = makeAgentLoop([verdict('REJECTED', [
        { claim: 'O total é R$ 14.333', verdict: 'NOT_SUPPORTED', evidence: ['E1'] },
        { claim: 'A cotação é 5,10', verdict: 'SUPPORTED', evidence: ['E1'] },
        { claim: 'O arquivo foi criado', verdict: 'NOT_EVALUABLE', evidence: [] },
    ])]);
    const r = await runTurn(loop, 'conv-s320-1', 1);
    assert(typeof r !== 'string', 'o resultado é um ProcessedResult, não uma string', r);
    const block = typeof r === 'string' ? undefined : r.groundingBlock;
    assert(block?.state === 'REJECTED', 'groundingBlock.state = REJECTED', block);
    assert(block?.unconfirmedClaims.length === 2, 'só as afirmações NÃO confirmadas entram (a SUPPORTED fica de fora)', block);
    assert(block?.unconfirmedClaims.some(c => c.verdict === 'NOT_SUPPORTED' && c.claim.includes('14.333')) === true, 'o veredito de cada afirmação é preservado', block);
    const text = typeof r === 'string' ? r : r.text;
    assert(BLOCK_MESSAGES.some(m => text.startsWith(m)), 'fora de goal o texto ao usuário é o mesmo de antes (mensagem de bloqueio)', text);
}

console.log('\n=== S320-2 — AgentLoop: UNVALIDATED (juiz não concluiu) e exceção antes do julgamento ===');
{
    const r1 = await runTurn(makeAgentLoop([verdict('UNVALIDATED')]), 'conv-s320-2a', 1);
    const b1 = typeof r1 === 'string' ? undefined : r1.groundingBlock;
    assert(b1?.state === 'UNVALIDATED' && b1.unconfirmedClaims.length === 0, 'UNVALIDATED sai com unconfirmedClaims vazio', b1);
    const r2 = await runTurn(makeAgentLoop([new Error('getBudgetAuxiliar explodiu')]), 'conv-s320-2b', 1);
    const b2 = typeof r2 === 'string' ? undefined : r2.groundingBlock;
    assert(b2?.state === 'UNVALIDATED', 'falha antes do julgamento também sai como UNVALIDATED estruturado', b2);
}

console.log('\n=== S320-3 — AgentLoop: resposta aprovada não carrega o sinal; commit aprovado DEPOIS de um bloqueio o apaga ===');
{
    const ok = await runTurn(makeAgentLoop([verdict('VALIDATED')]), 'conv-s320-3a', 1);
    assert(typeof ok === 'string' && ok === 'resposta 0', 'VALIDATED: resultado continua sendo a própria resposta, sem groundingBlock', ok);
    const later = await runTurn(makeAgentLoop([verdict('NOT_EVALUABLE', [{ claim: 'c', verdict: 'NOT_EVALUABLE', evidence: [] }]), verdict('VALIDATED')]), 'conv-s320-3b', 2);
    assert(typeof later === 'string' && later === 'resposta 1', 'o último commit (aprovado) vence — nenhum bloqueio residual do commit anterior', later);
    const na = await runTurn(makeAgentLoop([verdict('NOT_APPLICABLE')]), 'conv-s320-3c', 1);
    assert(typeof na === 'string', 'NOT_APPLICABLE não é bloqueio', na);
}

console.log('\n=== S320-4 — GoalExecutionLoop: primeiro bloqueio → retry com o FATO na descrição, attempt sem output ===');
{
    const { goal, step, attempts, plans } = makeGoal(2);
    const exec = makeExecLoop(attempts, plans);
    const block: GroundingBlock = { state: 'NOT_EVALUABLE', unconfirmedClaims: [{ claim: 'O material aborda terra em loop', verdict: 'NOT_EVALUABLE' }] };
    const r = (exec as any).handleGroundingBlock(goal, step, 3, Date.now(), block);
    assert(r.outcome === 'partial', 'outcome partial (retry do mesmo step, consome retryBudget)', r);
    assert(r.blocker?.kind === 'grounding_blocked', 'blocker kind grounding_blocked (registrado para auditoria/replan)', r.blocker);
    assert(attempts.length === 1 && attempts[0].result === 'failure', 'attempt registrado como failure', attempts);
    assert(attempts[0].output === undefined, 'o attempt NÃO tem output — a mensagem de bloqueio nunca vira produto do step', attempts[0]);
    assert(attempts[0].error === 'grounding_blocked:NOT_EVALUABLE', 'o erro carrega o estado do juiz', attempts[0].error);
    const newDesc = plans[0]?.[0]?.description ?? '';
    assert(newDesc.startsWith('Calcular o valor em reais [VERIFICAÇÃO —'), 'a descrição do step ganha o marcador próprio', newDesc);
    assert(newDesc.includes('terra em loop') && newDesc.includes('não confirmam'), 'a afirmação não confirmada e seu veredito chegam ao retry como fato', newDesc);
}

console.log('\n=== S320-5 — GoalExecutionLoop: segundo bloqueio (marcador presente) ou sem retryBudget → blocked para replan ===');
{
    const hinted = makeGoal(2, 'Calcular o valor em reais [VERIFICAÇÃO — algo.]');
    const r1 = (makeExecLoop(hinted.attempts, hinted.plans) as any).handleGroundingBlock(hinted.goal, hinted.step, 4, Date.now(), { state: 'REJECTED', unconfirmedClaims: [{ claim: 'x', verdict: 'NOT_SUPPORTED' }] });
    assert(r1.outcome === 'blocked' && r1.blocker.kind === 'grounding_blocked', 'marcador já presente → blocked', r1);
    assert(hinted.plans.length === 0, 'não reescreve a descrição de novo', hinted.plans);
    assert(r1.blocker.description.includes('após 2 tentativas') && !r1.blocker.description.includes('[VERIFICAÇÃO —'), 'a descrição do blocker usa o texto limpo do step', r1.blocker.description);
    assert(r1.blocker.description.includes('contradizem'), 'NOT_SUPPORTED é descrito como contradição, não como ausência', r1.blocker.description);

    const noBudget = makeGoal(0);
    const r2 = (makeExecLoop(noBudget.attempts, noBudget.plans) as any).handleGroundingBlock(noBudget.goal, noBudget.step, 1, Date.now(), { state: 'UNVALIDATED', unconfirmedClaims: [] });
    assert(r2.outcome === 'blocked', 'retryBudget 0 → blocked', r2);
    assert(/não pôde ser verificada/.test(r2.blocker.description) && /nada nela foi considerado falso/.test(r2.blocker.description), 'UNVALIDATED é descrito como falha da verificação, não do conteúdo', r2.blocker.description);
    assert(typeof r2.blocker.userSummary === 'string' && !/retryBudget|VERIFICAÇÃO|UNVALIDATED/.test(r2.blocker.userSummary), 'userSummary sem jargão interno (issue 030)', r2.blocker.userSummary);
}

console.log('\n=== S320-6 — estrutural: o GoalExecutionLoop decide pelo campo, antes da validação semântica, sem ler o texto ===');
{
    const src = fs.readFileSync(path.join(__dirname, '../../loop/GoalExecutionLoop.ts'), 'utf-8');
    const idx = src.indexOf('response.groundingBlock');
    assert(idx > 0, 'dispatchAgentloopStep lê response.groundingBlock', idx);
    const window = src.slice(idx, idx + 300);
    assert(/earlyReturn: true/.test(window) && /handleGroundingBlock/.test(window), 'retorno antecipado via handleGroundingBlock (não chega ao StepSemanticValidator, que só roda em success)', window);
    assert(!BLOCK_MESSAGES.some(m => src.includes(m.slice(0, 30))), 'nenhuma comparação com o texto da mensagem de bloqueio no GoalExecutionLoop');
    assert(idx < src.indexOf('const relatedTrace = traceManager'), 'o desvio ocorre antes de qualquer tratamento do texto como resposta do step');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S320 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
    console.error('S320 erro inesperado:', err);
    process.exitCode = 1;
});
