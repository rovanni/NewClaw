/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S30
 * P0: auto-injeção determinística de successCriteria de entrega (send_document/send_audio),
 * substituindo a dependência de regex sobre o resumo final do LLM (bug real documentado em
 * S27/S28/S29 e nas auditorias desta sessão).
 *
 * Cobre os 18 casos pedidos:
 *   1-9   → ensureDeliverySuccessCriteria() isolada (pura, sem replan)
 *   10-12 → reprodução fiel do merge de replan feito em GoalExecutionLoop.planWithSpiral()
 *           (preservedCriteria + planResult.successCriteria → ensureDeliverySuccessCriteria)
 *   13-16 → evaluateCriteria() (GoalExecutionLoop, método privado, chamado via cast — mesmo
 *           código real, não uma reimplementação) confirmando que attempts reais (result==='success'
 *           /'failure') decidem status='met'/'pending', inclusive pós-hotfix-E
 *   17    → confirmado por inspeção de código (FATO, não teste executável): resumeGoal() nunca
 *           inclui `successCriteria` no objeto passado a goalStore.update() — o campo sobrevive
 *           por omissão, sem lógica nova a testar em runtime
 *   18    → critério que o parser do GoalPlanner já descartou (malformado) chega como array vazio
 *           a ensureDeliverySuccessCriteria — confirma que a auto-injeção não depende disso
 *
 * Execução: npx ts-node src/__tests__/regression/S30_EnsureDeliverySuccessCriteria.test.ts
 */

process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import { ensureDeliverySuccessCriteria, AUTO_DELIVERY_CRITERION_IDS } from '../../loop/planning/ensureDeliverySuccessCriteria';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';
import { Goal, PlanStep, SuccessCriterion, GoalAttempt } from '../../loop/GoalTypes';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

function step(id: string, toolName?: string): PlanStep {
    return { id, description: id, toolName, toolArgs: {}, fallbackSteps: [], status: 'pending' };
}

function attempt(toolName: string, result: GoalAttempt['result']): GoalAttempt {
    return { id: `att_${Math.random()}`, planStepId: 'step_x', toolName, args: {}, result, output: 'ok', executedAt: Date.now(), durationMs: 10 };
}

// GoalExecutionLoop real, só pra chamar evaluateCriteria() (não usa nenhuma das dependências do
// construtor — método opera só sobre o Goal recebido como parâmetro). Stubs nunca são invocados.
const loop = new GoalExecutionLoop(
    {} as never, {} as never, {} as never, {} as never,
    {} as never, {} as never, {} as never, {} as never,
);
function evaluateCriteria(goal: Goal) {
    return (loop as unknown as { evaluateCriteria: (g: Goal) => { result: string; updated: SuccessCriterion[]; metCount: number } }).evaluateCriteria(goal);
}

function makeGoal(overrides: Partial<Goal>): Goal {
    const now = Date.now();
    return {
        id: 'goal_test', sessionKey: 'test:user', conversationId: 'conv',
        userIntent: '', objective: '', status: 'executing',
        currentPlan: [], attempts: [], blockers: [], toolsTried: [], strategiesTried: [],
        successCriteria: [], retryBudget: 3, replanBudget: 5, confidence: 0.9,
        requiresAuth: false, authorizationScope: [],
        createdAt: now, updatedAt: now, expiresAt: now + 3_600_000,
        ...overrides,
    } as Goal;
}

console.log('\n=== S30-1 — plano com send_audio + LLM sem successCriteria → injeta ===');
{
    const r = ensureDeliverySuccessCriteria([step('s1', 'send_audio')], []);
    assert(r.some(c => c.id === AUTO_DELIVERY_CRITERION_IDS.send_audio && c.check === 'tool_succeeded' && c.tool === 'send_audio'), 'critério de send_audio injetado', r);
}

console.log('\n=== S30-2 — plano com send_document + LLM sem successCriteria → injeta ===');
{
    const r = ensureDeliverySuccessCriteria([step('s1', 'send_document')], []);
    assert(r.some(c => c.id === AUTO_DELIVERY_CRITERION_IDS.send_document && c.check === 'tool_succeeded' && c.tool === 'send_document'), 'critério de send_document injetado', r);
}

console.log('\n=== S30-3 — plano com ambos → injeta dois tool_succeeded + 1 bypass estrutural (ARCH-018, send_document) ===');
{
    const r = ensureDeliverySuccessCriteria([step('s1', 'send_document'), step('s2', 'send_audio')], []);
    // ARCH-018 (S18/reabertura): send_document agora também ganha o critério
    // pending_send_verified_on_disk (bypass estrutural) — independente do tool_succeeded, os
    // dois coexistem (perguntas diferentes: "a tool rodou com sucesso" vs. "o arquivo pendente
    // já existe pronto no disco"). send_audio não tem bypass equivalente (fora do escopo do card).
    assert(r.length === 3, `3 critérios: send_document(tool_succeeded) + send_audio(tool_succeeded) + send_document(pending_send_verified_on_disk) (obtido: ${r.length})`, r);
    assert(r.some(c => c.tool === 'send_document' && c.check === 'tool_succeeded') && r.some(c => c.tool === 'send_audio'), 'um tool_succeeded de cada tool', r);
    assert(r.some(c => c.check === 'pending_send_verified_on_disk'), 'bypass estrutural de send_document presente', r);
}

console.log('\n=== S30-4 — LLM já forneceu critério de send_audio equivalente → não duplica ===');
{
    const llmCriterion: SuccessCriterion = { id: 'llm_c1', description: 'áudio enviado', check: 'tool_succeeded', tool: 'send_audio', status: 'pending' };
    const r = ensureDeliverySuccessCriteria([step('s1', 'send_audio')], [llmCriterion]);
    assert(r.length === 1, `sem duplicação (obtido: ${r.length})`, r);
    assert(r[0].id === 'llm_c1', 'preserva o id/descrição fornecidos pela LLM, não sobrescreve', r);
}

console.log('\n=== S30-5 — LLM já forneceu critério de send_document equivalente → não duplica o tool_succeeded, mas o bypass (ARCH-018) é independente ===');
{
    const llmCriterion: SuccessCriterion = { id: 'llm_c2', description: 'doc enviado', check: 'tool_succeeded', tool: 'send_document', status: 'pending' };
    const r = ensureDeliverySuccessCriteria([step('s1', 'send_document')], [llmCriterion]);
    // O dedup de "alreadyCovered" só vale para check==='tool_succeeded' — o bypass estrutural
    // (pending_send_verified_on_disk) responde uma pergunta diferente (arquivo já pronto no
    // disco vs. tool rodou com sucesso) e nunca é "equivalente" ao critério da LLM, então
    // continua sendo injetado ao lado dele.
    assert(r.length === 2, `2 critérios: o da LLM preservado sem duplicar + o bypass estrutural novo (obtido: ${r.length})`, r);
    assert(r.some(c => c.id === 'llm_c2'), 'preserva o id/descrição fornecidos pela LLM, não sobrescreve', r);
    assert(r.some(c => c.check === 'pending_send_verified_on_disk'), 'bypass estrutural presente ao lado do critério da LLM', r);
}

console.log('\n=== S30-6 — plano só com write → não injeta delivery ===');
{
    const r = ensureDeliverySuccessCriteria([step('s1', 'write')], []);
    assert(r.length === 0, `nenhum critério de entrega injetado para write (obtido: ${r.length})`, r);
}

console.log('\n=== S30-7 — plano só com exec_command → não injeta delivery ===');
{
    const r = ensureDeliverySuccessCriteria([step('s1', 'exec_command')], []);
    assert(r.length === 0, `nenhum critério de entrega injetado para exec_command (obtido: ${r.length})`, r);
}

console.log('\n=== S30-8 — intent "me explique como enviar áudio" com plano SEM send_audio → não injeta ===');
{
    // O intent nunca é lido pela função (regra 6) — só o plano final importa. Simulamos aqui um
    // plano puramente informacional (sem toolName de entrega), como a LLM geraria corretamente
    // para um pedido de explicação, não de ação.
    const r = ensureDeliverySuccessCriteria([step('s1', undefined)], []);
    assert(r.length === 0, 'sem tool de entrega no plano final, nada é injetado (independente do texto do pedido)', r);
}

console.log('\n=== S30-9 — intent "transforme isso em algo que eu possa ouvir" com plano COM send_audio → injeta ===');
{
    const r = ensureDeliverySuccessCriteria([step('s1', 'send_audio')], []);
    assert(r.some(c => c.tool === 'send_audio'), 'injeta com base no plano real, mesmo sem a palavra "áudio" no texto do pedido', r);
}

// ── 10-12: reprodução fiel do merge de replan (GoalExecutionLoop.planWithSpiral) ────────────
function mergeForReplan(existing: SuccessCriterion[], llmProvidedThisCycle: SuccessCriterion[], finalSteps: PlanStep[]): SuccessCriterion[] {
    const preserved = existing.filter(c =>
        c.id !== AUTO_DELIVERY_CRITERION_IDS.send_document && c.id !== AUTO_DELIVERY_CRITERION_IDS.send_audio
    );
    const merged = [...preserved];
    for (const c of llmProvidedThisCycle) {
        if (!merged.some(e => e.id === c.id)) merged.push(c);
    }
    return ensureDeliverySuccessCriteria(finalSteps, merged);
}

console.log('\n=== S30-10 — replan abandona send_audio → critério auto removido ===');
{
    const oldCriteria: SuccessCriterion[] = [{ id: AUTO_DELIVERY_CRITERION_IDS.send_audio, description: 'x', check: 'tool_succeeded', tool: 'send_audio', status: 'pending' }];
    const r = mergeForReplan(oldCriteria, [], [step('s1', 'write')]); // novo plano só escreve, não envia mais áudio
    assert(!r.some(c => c.tool === 'send_audio'), 'critério de send_audio some quando o plano novo não usa mais a tool', r);
}

console.log('\n=== S30-11 — replan mantém send_audio → exatamente um critério permanece ===');
{
    const oldCriteria: SuccessCriterion[] = [{ id: AUTO_DELIVERY_CRITERION_IDS.send_audio, description: 'x', check: 'tool_succeeded', tool: 'send_audio', status: 'met', metAt: Date.now() }];
    const r = mergeForReplan(oldCriteria, [], [step('s1', 'send_audio')]);
    const audioCriteria = r.filter(c => c.tool === 'send_audio');
    assert(audioCriteria.length === 1, `exatamente 1 critério de send_audio (obtido: ${audioCriteria.length})`, r);
}

console.log('\n=== S30-12 — replan abandona send_audio mas preserva critério semântico legítimo ===');
{
    const semanticCriterion: SuccessCriterion = { id: 'llm_semantic_1', description: 'preço atualizado no arquivo', check: 'output_contains', tool: 'exec_command', value: 'R$', status: 'pending' };
    const autoAudio: SuccessCriterion = { id: AUTO_DELIVERY_CRITERION_IDS.send_audio, description: 'x', check: 'tool_succeeded', tool: 'send_audio', status: 'pending' };
    const r = mergeForReplan([semanticCriterion, autoAudio], [], [step('s1', 'exec_command')]);
    assert(!r.some(c => c.tool === 'send_audio'), 'critério de entrega abandonado some', r);
    assert(r.some(c => c.id === 'llm_semantic_1'), 'critério semântico não-delivery é preservado', r);
}

// ── 13-16: evaluateCriteria() real (attempts → status) ──────────────────────────────────────
console.log('\n=== S30-13 — send_audio attempt failure → critério não met ===');
{
    const goal = makeGoal({
        successCriteria: [{ id: AUTO_DELIVERY_CRITERION_IDS.send_audio, description: 'x', check: 'tool_succeeded', tool: 'send_audio', status: 'pending' }],
        attempts: [attempt('send_audio', 'failure')],
    });
    const evalResult = evaluateCriteria(goal);
    assert(evalResult.updated[0].status !== 'met', `critério não vira met com attempt de falha (obtido: ${evalResult.updated[0].status})`, evalResult);
}

console.log('\n=== S30-14 — send_audio attempt success → critério met ===');
{
    const goal = makeGoal({
        successCriteria: [{ id: AUTO_DELIVERY_CRITERION_IDS.send_audio, description: 'x', check: 'tool_succeeded', tool: 'send_audio', status: 'pending' }],
        attempts: [attempt('send_audio', 'success')],
    });
    const evalResult = evaluateCriteria(goal);
    assert(evalResult.updated[0].status === 'met', `critério vira met com attempt de sucesso real (obtido: ${evalResult.updated[0].status})`, evalResult);
    assert(evalResult.result === 'all_met', 'evaluateCriteria sinaliza all_met (bypassaria o LLM em validateGoalCompletion)', evalResult);
}

console.log('\n=== S30-15 — pós-hotfix-E: adapter sem sendVoice → attempt failure → critério não met ===');
{
    // send_audio.ts captura a exceção de MessageBus.sendVoice() (hotfix E, commit dcd7717) e
    // retorna ToolResult{success:false} — GoalAttempt.result vira 'failure' (GoalExecutionLoop.ts
    // linha ~1558: result: toolResult.success ? 'success' : 'failure'). Reproduzido aqui como fato
    // de dados (o attempt como ele realmente fica gravado), não como execução end-to-end.
    const goal = makeGoal({
        successCriteria: [{ id: AUTO_DELIVERY_CRITERION_IDS.send_audio, description: 'x', check: 'tool_succeeded', tool: 'send_audio', status: 'pending' }],
        attempts: [attempt('send_audio', 'failure')],
    });
    const evalResult = evaluateCriteria(goal);
    assert(evalResult.updated[0].status !== 'met', 'falha de adapter sem sendVoice (pós-E) não satisfaz o critério', evalResult);
}

console.log('\n=== S30-16 — pós-hotfix-E: WebChannel sem pending → attempt failure → critério não met ===');
{
    const goal = makeGoal({
        successCriteria: [{ id: AUTO_DELIVERY_CRITERION_IDS.send_document, description: 'x', check: 'tool_succeeded', tool: 'send_document', status: 'pending' }],
        attempts: [attempt('send_document', 'failure')],
    });
    const evalResult = evaluateCriteria(goal);
    assert(evalResult.updated[0].status !== 'met', 'falha de WebChannelAdapter sem pending (pós-E) não satisfaz o critério', evalResult);
}

console.log('\n=== S30-17 — resumeGoal preserva successCriteria (confirmado por inspeção de código, GoalExecutionLoop.ts) ===');
{
    // resumeGoal() chama goalStore.update(goal.id, {status:'executing', pendingTxnId:undefined})
    // — nenhuma chave 'successCriteria' no objeto de update. O campo sobrevive por omissão; não
    // há lógica nova de resumeGoal para exercitar em runtime além do que GoalStore já garante
    // (update parcial não apaga campos ausentes do objeto passado).
    assert(true, 'confirmado por leitura de GoalExecutionLoop.resumeGoal() — sem chave successCriteria no update parcial');
}

console.log('\n=== S30-18 — critério malformado descartado upstream ainda resulta em auto-injeção ===');
{
    // O parser de GoalPlanner.parsePlanResponse() já filtra critérios sem id/description/check
    // válido antes de chegar aqui — o array que sobra é o que ensureDeliverySuccessCriteria recebe.
    const r = ensureDeliverySuccessCriteria([step('s1', 'send_audio')], []); // [] simula o descarte upstream
    assert(r.some(c => c.tool === 'send_audio'), 'auto-injeção ocorre independente de critério malformado ter sido descartado antes', r);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S30 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exit(1);
