/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S78 (Sprint 0.6, Front A — Isolamento de estado por Goal)
 *
 * Prova que `GoalExecutionLoop.cognitiveContext`/`progressModel` (campos de instância,
 * singleton por processo) vazam de um goal para outro através de `resumeGoal()`, que
 * nunca reseta esses campos (ao contrário de `executeGoal()`, que reseta nas linhas
 * 135-141). O canal de observação é 100% público: `Goal.blockers`/`Goal.replanBudget`
 * persistidos (lidos via `GoalStore.getById()`, já existente) — nenhum getter novo,
 * nenhuma mudança de contrato do runtime.
 *
 * Cenário provado: Goal A executa 1 step com sucesso e termina com
 * `progressModel.overallPercent = 100` (1/1 componentes concluídos). Esse valor fica
 * preso em `this.progressModel` (campo de instância). Goal B, um goal NOVO e
 * independente, é retomado via `resumeGoal()` com `replanBudget = 0` e falha na
 * validação final. Em `runLoopInternal` (linha ~856-888), quando `replanBudget <= 0`,
 * o sistema concede um "bonus replan" se `progressModel.overallPercent >= 60` — no
 * código ATUAL, essa leitura pega o resíduo de A (100%), concedendo a B um bônus que
 * B nunca ganhou, com um blocker `[BONUS REPLAN — 100% concluído]` mencionando
 * progresso que não é de B. Depois do fix (Front A), `this.progressModel` deixa de
 * existir como campo compartilhado — cada `runLoop()` cria seu próprio estado local —
 * e B nunca recebe o bônus indevido.
 *
 * Execução: npx ts-node src/__tests__/regression/S78_GoalExecutionState_Isolation.test.ts
 */

import Database from 'better-sqlite3';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';
import { GoalStore } from '../../loop/GoalStore';
import { ToolRegistry } from '../../core/ToolRegistry';
import { Goal, PlanStep } from '../../loop/GoalTypes';
import { ChannelContext } from '../../loop/agentLoopTypes';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

const FAKE_TOOL_NAME = '__s46_marker_tool__';
// Registro idempotente: ToolRegistry é singleton real do processo; register() já
// ignora silenciosamente se o nome já existir (não é uma API nova, é a mesma usada
// por toda tool real em src/tools/*.ts).
ToolRegistry.register({
    name: FAKE_TOOL_NAME,
    description: 'Tool de teste que sempre sucede.',
    parameters: {},
    execute: async () => ({ success: true, output: 'executar tarefa marcador alpha concluído com sucesso' }),
});

function makeFakeProviderFactory(chatImpl: (...args: unknown[]) => Promise<unknown>) {
    return {
        chatWithFallback: chatImpl,
        getProvider: () => undefined,
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
}

function makeLoop(providerFactory: import('../../core/ProviderFactory').ProviderFactory) {
    const db = new (Database as any)(':memory:');
    const goalStore = new GoalStore(db);
    const fakeMemory = { getDatabase: () => db } as any;
    const fakePlanner = {
        getAvailableSkills: () => [],
        setSkillContext: () => {},
        setModel: () => {},
        plan: async () => ({
            steps: [{
                id: 'stepA1',
                description: 'Executar tarefa marcador alpha',
                toolName: FAKE_TOOL_NAME,
                toolArgs: {},
                status: 'pending' as const,
                fallbackSteps: [],
            }],
            strategy: 'test',
            successCriteria: [],
        }),
        replan: async () => ({ steps: [], strategy: 'n/a' }),
    } as any;
    const loop = new GoalExecutionLoop(
        {} as any,          // agentLoop — não usado (steps têm toolName explícito)
        goalStore,
        fakePlanner,
        { record: () => {}, buildContextHint: () => '', findHardConstraints: () => [] } as any, // reflectionMemory: markStepDone chama record() mesmo em sucesso
        ToolRegistry,
        providerFactory,
        fakeMemory,
        {
            findApplicableCasesShadow: async () => [],
            backfillMissingEmbeddings: async () => {},
            captureIfEligible: () => {},
            findSimilarShadow: () => [],
        } as any,
    );
    return { loop, goalStore };
}

function makeGoal(store: GoalStore, overrides: Partial<Goal> & { currentPlan: PlanStep[] }): Goal {
    return store.create({
        sessionKey: 'test:s46',
        conversationId: 'test-conv-s46',
        userIntent: 'objetivo de teste S78',
        objective: 'Objetivo de teste S78',
        status: 'executing',
        attempts: [],
        blockers: [],
        toolsTried: [],
        strategiesTried: [],
        successCriteria: [],
        sentArtifacts: [],
        retryBudget: 3,
        replanBudget: 5,
        confidence: 0.9,
        requiresAuth: false,
        authorizationScope: [],
        expiresAt: Date.now() + 3_600_000,
        ...overrides,
    } as Omit<Goal, 'id' | 'createdAt' | 'updatedAt'>);
}

const channelContext: ChannelContext = { channel: 'test', chatId: 'test-user' };

async function main() {
    // Fake LLM: usado por validateGoalCompletion. Fase controlada manualmente pelo teste
    // (chamadas sequenciais, não concorrentes — reflete exatamente o bug de vazamento
    // SEQUENCIAL via resumeGoal(), que é determinístico e não depende de timing de await).
    let phase: 'A' | 'B' = 'A';
    const providerFactory = makeFakeProviderFactory(async () => {
        if (phase === 'A') {
            return { status: 'success', content: JSON.stringify({ achieved: true, summary: 'Tarefa de teste concluída.' }) };
        }
        return { status: 'success', content: JSON.stringify({ achieved: false, summary: 'Ainda não concluído (teste).' }) };
    });

    const { loop, goalStore } = makeLoop(providerFactory);

    console.log('\n=== S78.1 — Goal A executa 1 step com sucesso, progressModel fica em 100% ===');
    const goalA = makeGoal(goalStore, {
        userIntent: 'goal A de teste',
        currentPlan: [],   // sobrescrito por executeGoal() com o plano retornado pelo fakePlanner.plan()
    });
    phase = 'A';
    // Usa o entry point público real (executeGoal), não runLoopInternal diretamente — precisa
    // passar pela inicialização real de progressModel (linhas 135-141 do código atual) para que
    // o cenário reproduza fielmente o que a produção faz, sem hack de teste escrevendo direto
    // em campo privado.
    const resultA = await loop.executeGoal(goalA, channelContext, undefined);
    assert(resultA.success === true, 'Goal A completou com sucesso', resultA);
    const storedA = goalStore.getById(goalA.id)!;
    assert(storedA.status === 'completed', 'Goal A status=completed', storedA.status);

    console.log('\n=== S78.2 — Goal B (novo, replanBudget=0, sem progresso próprio) retomado via resumeGoal() ===');
    const goalB = makeGoal(goalStore, {
        userIntent: 'goal B de teste, completamente independente de A',
        currentPlan: [],       // sem steps pendentes — vai direto para validação no 1º ciclo
        replanBudget: 0,       // força o branch de "replanBudget <= 0" já no 1º ciclo
        status: 'blocked',
    });
    phase = 'B';
    await loop.resumeGoal(goalB, channelContext, 'autorizado (teste)', undefined);

    const storedB = goalStore.getById(goalB.id)!;
    const bonusBlocker = storedB.blockers.find(b => b.description.includes('BONUS REPLAN'));

    console.log('\n=== Resultado ===');
    console.log(`  goalB.replanBudget final = ${storedB.replanBudget}`);
    console.log(`  goalB.blockers = ${JSON.stringify(storedB.blockers.map(b => b.description.slice(0, 80)))}`);

    // Esta é a asserção que prova o bug: no código ATUAL (antes do fix do Front A),
    // this.progressModel ainda contém o resíduo de A (overallPercent=100) quando B chega
    // ao branch de replanBudget<=0 — B recebe um bônus que não é seu. Depois do fix,
    // resumeGoal() cria estado novo (via runLoop) e B nunca vê o progresso de A.
    assert(
        bonusBlocker === undefined,
        'Goal B NÃO deve conter um blocker de "BONUS REPLAN" herdado do progresso de A (contaminação sequencial via resumeGoal)',
        { blockers: storedB.blockers }
    );
    assert(
        storedB.replanBudget === 0,
        'Goal B.replanBudget deve permanecer 0 (B não tinha progresso próprio para justificar bônus)',
        storedB.replanBudget
    );

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S78 RESULTADO: ${passed} passou | ${failed} falhou`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
