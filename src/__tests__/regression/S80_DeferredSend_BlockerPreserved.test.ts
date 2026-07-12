/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S80 (Sprint 0.6, Front B — Preservação correta de blockers)
 *
 * Prova a causa-raiz exata do `blockers=[]` observada no goal real `ykpko`
 * (Sprint 0.5): quando um `send_document` diferido falha DEPOIS da validação de
 * conclusão (`GoalExecutionLoop.runLoopInternal`, loop de `deferredSends`), o
 * `cycleResult.blocker` que `executeStep()`→`GoalEvaluator.evaluate()` já calculou é
 * descartado — só `failedSends++` é incrementado. O goal termina com `status='failed'`
 * corretamente, mas `blockers=[]`, sem nenhuma pista de causa.
 *
 * Execução: npx ts-node src/__tests__/regression/S80_DeferredSend_BlockerPreserved.test.ts
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

function emptyState(goalId: string): { cognitiveContext: unknown; progressModel: unknown } {
    return {
        cognitiveContext: { discoveries: [], failedStrategies: [], filesRead: [], filesModified: [], generatedArtifacts: [], executedCommands: [], importantOutputs: [] },
        progressModel: { goalId, components: [], overallPercent: 0, updatedAt: Date.now() },
    };
}

// send_document fake: sucede para file_path contendo "ok", falha (erro não reconhecido,
// kind=tool_error) para os demais — permite controlar sucesso/falha por step.
ToolRegistry.register({
    name: 'send_document',
    description: 'test',
    parameters: {},
    execute: async (args: Record<string, unknown>) => {
        const fp = String(args['file_path'] ?? '');
        if (fp.includes('ok')) return { success: true, output: `Documento "${fp}" enviado.` };
        // Erro deliberadamente sem padrão reconhecido em GoalEvaluator.ERROR_PATTERNS
        // (evita casar com ENOENT/missing_tool) — cai no fallback genérico kind='tool_error',
        // não-retryável, replanBudget=5 (default) então evaluate() retorna 'blocked' — o que
        // importa para o teste é apenas que cycleResult.blocker exista, não o outcome exato.
        return { success: false, output: '', error: 'Nenhuma requisição HTTP pendente para chatId — anexo descartado' };
    },
});

function makeFakeProviderFactory(achieved: boolean) {
    return {
        chatWithFallback: async () => ({ status: 'success', content: JSON.stringify({ achieved, summary: 'teste S80' }) }),
        getProvider: () => undefined,
        getProviderWithModel: () => ({ chat: async () => ({ status: 'success', content: JSON.stringify({ achieved, summary: 'teste S80' }) }) }),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
}

function makeLoop(providerFactory: import('../../core/ProviderFactory').ProviderFactory) {
    const db = new (Database as any)(':memory:');
    const goalStore = new GoalStore(db);
    const fakeMemory = { getDatabase: () => db } as any;
    const fakePlanner = { getAvailableSkills: () => [], setSkillContext: () => {}, setModel: () => {}, replan: async () => ({ steps: [], strategy: 'n/a' }) } as any;
    const loop = new GoalExecutionLoop(
        {} as any, goalStore, fakePlanner,
        { record: () => {}, buildContextHint: () => '', findHardConstraints: () => [] } as any,
        ToolRegistry, providerFactory, fakeMemory,
        { findApplicableCasesShadow: async () => [], backfillMissingEmbeddings: async () => {}, captureIfEligible: () => {}, findSimilarShadow: () => [] } as any,
    );
    return { loop, goalStore };
}

function makeGoal(store: GoalStore, overrides: Partial<Goal> & { currentPlan: PlanStep[] }): Goal {
    return store.create({
        sessionKey: 'test:s80',
        conversationId: 'test-conv-s80',
        userIntent: 'objetivo de teste S80',
        objective: 'Objetivo de teste S80',
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

function sendStep(id: string, filePath: string): PlanStep {
    return { id, description: `Enviar ${filePath}`, toolName: 'send_document', toolArgs: { file_path: filePath }, status: 'pending', fallbackSteps: [] };
}

const channelContext: ChannelContext = { channel: 'test', chatId: 'test-user' };

async function main() {
    console.log('\n=== S80.1 — deferred send SUCESSO: nenhum blocker novo ===');
    {
        const { loop, goalStore } = makeLoop(makeFakeProviderFactory(true));
        const goal = makeGoal(goalStore, { currentPlan: [sendStep('s1', 'arquivo_ok.pptx')] });
        const state = emptyState(goal.id) as any;
        const result = await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, state);
        const stored = goalStore.getById(goal.id)!;
        assert(result.success === true, 'goal completou com sucesso', result);
        assert(stored.blockers.length === 0, 'nenhum blocker adicionado (nenhuma falha ocorreu)', stored.blockers);
    }

    console.log('\n=== S80.2 — deferred send FALHA: blocker registrado, status="failed" (causa raiz real do goal "ykpko") ===');
    {
        const { loop, goalStore } = makeLoop(makeFakeProviderFactory(true));
        const goal = makeGoal(goalStore, { currentPlan: [sendStep('s1', 'arquivo_sem_sucesso.pptx')] });
        const state = emptyState(goal.id) as any;
        const result = await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, state);
        const stored = goalStore.getById(goal.id)!;
        assert(result.success === false, 'goal terminou como falha (send_document falhou)', result);
        assert(stored.status === 'failed', 'goal.status === "failed"', stored.status);
        assert(
            stored.blockers.some(b => b.kind === 'tool_error'),
            'goal.blockers contém o blocker da falha de envio (ANTES da correção: SEMPRE vazio — reproduz exatamente o goal real "ykpko" da Sprint 0.5)',
            stored.blockers
        );
    }

    console.log('\n=== S80.3 — múltiplos sends (1 falha, 1 sucede): exatamente 1 blocker novo ===');
    {
        const { loop, goalStore } = makeLoop(makeFakeProviderFactory(true));
        const goal = makeGoal(goalStore, {
            currentPlan: [sendStep('s1', 'arquivo_ok.pptx'), sendStep('s2', 'arquivo_sem_sucesso.pptx')],
        });
        const state = emptyState(goal.id) as any;
        const result = await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, state);
        const stored = goalStore.getById(goal.id)!;
        assert(result.success === false, 'goal terminou como falha (1 dos 2 sends falhou)', result);
        assert(
            stored.blockers.filter(b => b.kind === 'tool_error').length === 1,
            `exatamente 1 blocker (só o send que falhou) — obtido: ${stored.blockers.length}`,
            stored.blockers
        );
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S80 RESULTADO: ${passed} passou | ${failed} falhou`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
