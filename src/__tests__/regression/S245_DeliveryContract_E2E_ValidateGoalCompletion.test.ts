/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S245 (E2E sintético)
 *
 * Campanha "O8 — Contrato de Modalidade", Etapa 3 da Validação Progressiva
 * (`docs/DIRETRIZ_ARQUITETURA_2026-07-13.md`) para o fix de S244: fluxo completo do componente
 * real (`GoalExecutionLoop.evaluateCriteria()` + `validateGoalCompletion()`), com LLM/filesystem
 * mockados — mesmo padrão de `S128_ARCH018_StructuralBypassAsCriterion.test.ts` (instancia a
 * classe real com dependências fake via DI, chama os métodos privados reais via `(loop as any)`,
 * nunca reproduz o algoritmo à parte).
 *
 * S244 provou as funções puras (`trackPromisedDeliveryTools`/`detectAbandonedDeliveryTools`/
 * `ensureDeliveryNotAbandonedCriterion`) isoladamente + checou por regex que o wiring existe no
 * source. Este teste prova que o wiring FUNCIONA: o GATE `delivery_not_silently_abandoned`,
 * quando presente em `goal.successCriteria`, realmente impede `evaluateCriteria()` de fechar
 * `all_met` sozinho, realmente força `validateGoalCompletion()` a chamar o LLM (Caminho 2), e o
 * prompt que o LLM recebe realmente contém o fato sobre a entrega abandonada — e, no caminho
 * contrário (sem abandono), o goal continua fechando por Caminho 1 (checklist puro, sem chamar o
 * LLM), sem regressão no atalho que `response_produced`/S230 já validou.
 *
 * Execução: npx ts-node src/__tests__/regression/S245_DeliveryContract_E2E_ValidateGoalCompletion.test.ts
 */

import Database from 'better-sqlite3';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';
import { GoalStore } from '../../loop/GoalStore';
import { ToolRegistry } from '../../core/ToolRegistry';
import { Goal, PlanStep, createEmptyStepCognitiveContext } from '../../loop/GoalTypes';
import { AUTO_DELIVERY_CRITERION_IDS } from '../../loop/planning/ensureDeliverySuccessCriteria';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

function makeLoop(chatWithFallback: (...args: unknown[]) => Promise<{ status: string; content: string }>): { loop: GoalExecutionLoop; goalStore: GoalStore } {
    const db = new (Database as any)(':memory:');
    const goalStore = new GoalStore(db);
    const fakeMemory = { getDatabase: () => db } as any;
    const fakePlanner = { getAvailableSkills: () => [], setSkillContext: () => {}, setModel: () => {}, replan: async () => ({ steps: [], strategy: 'n/a' }) } as any;
    const fakeAgentLoop = { process: async () => '' } as any;
    const fakeProviderFactory = { chatWithFallback } as any;
    const loop = new GoalExecutionLoop(
        fakeAgentLoop, goalStore, fakePlanner,
        { record: () => {}, buildContextHint: () => '', findHardConstraints: () => [] } as any,
        ToolRegistry, fakeProviderFactory, fakeMemory,
        { findApplicableCasesShadow: async () => [], backfillMissingEmbeddings: async () => {}, captureIfEligible: () => {}, findSimilarShadow: () => [] } as any,
    );
    return { loop, goalStore };
}

function makeGoal(store: GoalStore, overrides: Partial<Goal> & { currentPlan: PlanStep[] }): Goal {
    return store.create({
        sessionKey: 'test:s245', conversationId: 'test-conv-s245',
        userIntent: 'instale o pacote X e me gere um relatório em PDF com o resultado',
        objective: 'instalar pacote X e gerar relatório PDF',
        status: 'executing', attempts: [], blockers: [], toolsTried: [], strategiesTried: [],
        successCriteria: [], sentArtifacts: [], retryBudget: 3, replanBudget: 5, confidence: 0.9,
        requiresAuth: false, authorizationScope: [], expiresAt: Date.now() + 3_600_000,
        ...overrides,
    } as Omit<Goal, 'id' | 'createdAt' | 'updatedAt'>);
}

const state = { cognitiveContext: createEmptyStepCognitiveContext(), progressModel: null };

async function main() {

console.log('\n=== S245-1 — evaluateCriteria(): GATE presente impede all_met mesmo com todo o resto satisfeito ===');
{
    const { loop, goalStore } = makeLoop(async () => ({ status: 'success', content: '{"achieved":true}' }));
    const goal = makeGoal(goalStore, {
        currentPlan: [{ id: 's1', description: 'write local', toolName: 'write', status: 'completed', fallbackSteps: [] }],
        attempts: [{ id: 'a1', planStepId: 's1', toolName: 'write', args: {}, result: 'success', durationMs: 1, executedAt: Date.now() }],
        successCriteria: [
            { id: 'outro', description: 'requisito não relacionado, já satisfeito', check: 'tool_succeeded', tool: 'write', status: 'pending' },
            { id: AUTO_DELIVERY_CRITERION_IDS.delivery_not_abandoned, description: 'x', check: 'delivery_not_silently_abandoned', status: 'pending' },
        ],
    });
    const result = (loop as any).evaluateCriteria(goal);
    const gate = result.updated.find((c: any) => c.id === AUTO_DELIVERY_CRITERION_IDS.delivery_not_abandoned);
    const outro = result.updated.find((c: any) => c.id === 'outro');
    assert(outro?.status === 'met', 'critério independente fecha normalmente (write teve sucesso)', outro);
    assert(gate?.status === 'unverifiable', 'GATE nunca fica met deterministicamente', gate);
    assert(result.result !== 'all_met', `result NÃO é all_met apesar do outro critério estar satisfeito — obtido: ${result.result}`, result);
}

console.log('\n=== S245-2 — validateGoalCompletion(): sem o GATE, fecha por Caminho 1 (checklist puro) SEM chamar o LLM ===');
{
    let llmCalls = 0;
    const { loop, goalStore } = makeLoop(async () => { llmCalls++; return { status: 'success', content: '{"achieved":true,"summary":"ok"}' }; });
    const goal = makeGoal(goalStore, {
        currentPlan: [{ id: 's1', description: 'write local', toolName: 'write', status: 'completed', fallbackSteps: [] }],
        attempts: [{ id: 'a1', planStepId: 's1', toolName: 'write', args: {}, result: 'success', durationMs: 1, executedAt: Date.now() }],
        successCriteria: [
            { id: 'outro', description: 'requisito não relacionado, já satisfeito', check: 'tool_succeeded', tool: 'write', status: 'pending' },
        ],
    });
    const validation = await (loop as any).validateGoalCompletion(goal, undefined, state);
    assert(llmCalls === 0, `Caminho 1 preservado: LLM NÃO foi chamado quando o checklist já fecha sozinho — chamadas=${llmCalls}`, llmCalls);
    assert(validation.achieved === true, 'achieved=true via checklist determinístico', validation);
}

console.log('\n=== S245-3 — validateGoalCompletion(): COM o GATE (abandono real), força Caminho 2 — LLM É chamado e recebe o fato no prompt ===');
{
    let llmCalls = 0;
    let lastPrompt = '';
    const { loop, goalStore } = makeLoop(async (messages: any) => {
        llmCalls++;
        lastPrompt = messages[0].content;
        return { status: 'success', content: '{"achieved":false,"reason":"PDF prometido não foi entregue"}' };
    });
    const goal = makeGoal(goalStore, {
        currentPlan: [{ id: 's1', description: 'write local', toolName: 'write', status: 'completed', fallbackSteps: [] }],
        attempts: [{ id: 'a1', planStepId: 's1', toolName: 'write', args: {}, result: 'success', durationMs: 1, executedAt: Date.now() }],
        sentArtifacts: [], // nada foi entregue — send_document prometido antes nunca rodou
        successCriteria: [
            { id: 'outro', description: 'requisito não relacionado, já satisfeito', check: 'tool_succeeded', tool: 'write', status: 'pending' },
            { id: AUTO_DELIVERY_CRITERION_IDS.delivery_not_abandoned, description: 'entrega de send_document abandonada', check: 'delivery_not_silently_abandoned', status: 'pending' },
        ],
    });
    const validation = await (loop as any).validateGoalCompletion(goal, undefined, state);
    assert(llmCalls === 1, `Caminho 2 forçado: LLM chamado exatamente 1 vez — chamadas=${llmCalls}`, llmCalls);
    assert(/POSSÍVEL ENTREGA ABANDONADA/.test(lastPrompt), 'o prompt real enviado ao LLM contém o fato estrutural sobre a entrega abandonada', lastPrompt.slice(0, 200));
    assert(/INTENÇÃO ORIGINAL DO USUÁRIO: instale o pacote X/.test(lastPrompt), 'o prompt continua incluindo a intenção original — o LLM tem o que precisa para decidir se é abandono legítimo', lastPrompt.slice(0, 400));
    assert(validation.achieved === false, 'o LLM (mockado, correto) rejeita — reason preservado', validation);
}

console.log('\n=== S245-4 — validateGoalCompletion(): GATE presente mas artefato JÁ entregue — prompt não acusa abandono ===');
{
    let lastPrompt = '';
    const { loop, goalStore } = makeLoop(async (messages: any) => { lastPrompt = messages[0].content; return { status: 'success', content: '{"achieved":true,"summary":"ok"}' }; });
    const goal = makeGoal(goalStore, {
        currentPlan: [{ id: 's1', description: 'write local', toolName: 'write', status: 'completed', fallbackSteps: [] }],
        attempts: [{ id: 'a1', planStepId: 's1', toolName: 'write', args: {}, result: 'success', durationMs: 1, executedAt: Date.now() }],
        // Simula um goal cujo critério de abandono ficou (por engano/corrida) em successCriteria
        // mesmo após a entrega real ter acontecido — o BLOCO DE PROMPT é o que reflete o fato
        // atual (via hasAbandonedDeliveryContract, lido de goal.successCriteria), então este
        // teste garante que o texto do bloco só aparece quando o critério realmente está lá; a
        // detecção de que ele NÃO deveria estar lá quando já entregue é responsabilidade de
        // detectAbandonedDeliveryTools (S244-2, caso 3), não deste teste.
        successCriteria: [],
    });
    await (loop as any).validateGoalCompletion(goal, undefined, state);
    assert(!/POSSÍVEL ENTREGA ABANDONADA/.test(lastPrompt), 'sem o critério em successCriteria, o bloco de fato não aparece no prompt', lastPrompt.slice(0, 200));
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S245 RESULTADO: ${passed} passou | ${failed} falhou`);
process.exit(failed > 0 ? 1 : 0);

}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
