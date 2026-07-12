/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S84 (Sprint 0.8, achados L02d/L12/L13 do ledger)
 *
 * Prova que `GoalExecutionLoop`, nos branches `needs_auth` (modo SAFE) e `needs_dependency`,
 * descarta o `blocker` já classificado por `GoalEvaluator.evaluate()` — o mesmo padrão de
 * perda já corrigido na Sprint 0.6 (Front B) para os branches `partial`/`failed`/deferred
 * `send_document`, mas nunca estendido a estes dois.
 *
 * Evidência de produção real que motivou este teste (Sprint 0.8, `newclaw-audit.log`):
 *   goal_1783215245583_ml39u — outcome=needs_dependency blocker=missing_tool (edge-tts
 *   ausente) — confirmado no banco real que `goal.blockers` não contém esse blocker.
 *
 * Também prova que `needs_auth` em modo auto-aprovado (DEVELOPER/GOD) NÃO deve registrar um
 * blocker `missing_permission` — nesse modo a tool roda normalmente, registrar um bloqueio
 * que não ocorreu seria factualmente incorreto (não é o mesmo bug, é o oposto: um falso
 * bloqueio no histórico).
 *
 * Execução: npx ts-node src/__tests__/regression/S84_NeedsAuth_NeedsDependency_BlockerPreserved.test.ts
 */

import Database from 'better-sqlite3';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';
import { GoalStore } from '../../loop/GoalStore';
import { ToolRegistry } from '../../core/ToolRegistry';
import { permissionRegistry } from '../../core/PermissionRegistry';
import { OperationalMode } from '../../core/CapabilityMode';
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

const AUTH_TOOL = 'exec_command'; // única forma de casar com ToolRegistry.isDangerous()
const DEP_TOOL = '__s84_dep_tool__';
ToolRegistry.register({
    name: AUTH_TOOL,
    description: 'test',
    parameters: {},
    execute: async () => ({ success: false, output: '', error: 'EACCES: permission denied' }),
}, { dangerous: true });

// Falha na 1ª chamada (dispara needs_dependency, igual ao goal real edge-tts), sucede na 2ª
// (o step de instalação injetado é reexecutado depois) — evita um 2º ciclo de falha que
// adicionaria um 2º blocker "missing_tool" pelo caminho 'blocked'/'failed' (já corrigido na
// Sprint 0.6), o que mascararia se o branch 'needs_dependency' específico preserva o dele.
let depToolCalls = 0;
ToolRegistry.register({
    name: DEP_TOOL,
    description: 'test',
    parameters: {},
    execute: async () => {
        depToolCalls++;
        // "spawn pandoc ENOENT" casa com extractMissingExecutable() E com o padrão missing_tool
        // do GoalEvaluator; "pandoc" está em KNOWN_DEPS — reproduz o padrão real do log (edge-tts).
        if (depToolCalls === 1) return { success: false, output: '', error: 'spawn pandoc ENOENT' };
        return { success: true, output: 'Documento convertido com sucesso.' };
    },
});

function makeFakeProviderFactory() {
    return {
        chatWithFallback: async () => ({ status: 'success', content: JSON.stringify({ achieved: true, summary: 'teste S84' }) }),
        getProvider: () => undefined,
        getProviderWithModel: () => ({ chat: async () => ({ status: 'success', content: JSON.stringify({ achieved: true, summary: 'teste S84' }) }) }),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
}

// Usado apenas pelo caminho 'agentloop' (steps sem toolName — ex.: o step de instalação
// manual injetado por needs_dependency quando não há comando automático seguro para o SO,
// o caso real observado no log de produção para edge-tts). Resposta com sinal de sucesso
// explícito ("concluída") evita escalonar para LLM — mantém o teste focado no que importa.
const fakeAgentLoop = { process: async () => 'Instalação concluída manualmente (simulado).' } as any;

function makeLoop() {
    const db = new (Database as any)(':memory:');
    const goalStore = new GoalStore(db);
    const fakeMemory = { getDatabase: () => db } as any;
    const fakePlanner = { getAvailableSkills: () => [], setSkillContext: () => {}, setModel: () => {}, replan: async () => ({ steps: [], strategy: 'n/a' }) } as any;
    const loop = new GoalExecutionLoop(
        fakeAgentLoop, goalStore, fakePlanner,
        { record: () => {}, buildContextHint: () => '', findHardConstraints: () => [] } as any,
        ToolRegistry, makeFakeProviderFactory(), fakeMemory,
        { findApplicableCasesShadow: async () => [], backfillMissingEmbeddings: async () => {}, captureIfEligible: () => {}, findSimilarShadow: () => [] } as any,
    );
    return { loop, goalStore };
}

function makeGoal(store: GoalStore, overrides: Partial<Goal> & { currentPlan: PlanStep[] }): Goal {
    return store.create({
        sessionKey: 'test:s84', conversationId: 'test-conv-s84',
        userIntent: 'objetivo de teste S84', objective: 'Objetivo de teste S84',
        status: 'executing', attempts: [], blockers: [], toolsTried: [], strategiesTried: [],
        successCriteria: [], sentArtifacts: [], retryBudget: 3, replanBudget: 5, confidence: 0.9,
        requiresAuth: false, authorizationScope: [], expiresAt: Date.now() + 3_600_000,
        ...overrides,
    } as Omit<Goal, 'id' | 'createdAt' | 'updatedAt'>);
}

const channelContext: ChannelContext = { channel: 'test', chatId: 'test-user' };

async function main() {
    console.log('\n=== S84.1 — needs_auth em modo SAFE: blocker "missing_permission" preservado ===');
    {
        permissionRegistry.setMode(OperationalMode.SAFE, 'test-s84');
        const { loop, goalStore } = makeLoop();
        const goal = makeGoal(goalStore, {
            currentPlan: [{ id: 'stepAuth', description: 'Executar comando perigoso', toolName: AUTH_TOOL, toolArgs: { command: 'echo x' }, status: 'pending', fallbackSteps: [] }],
        });
        const state = emptyState(goal.id) as any;
        await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, state);
        const stored = goalStore.getById(goal.id)!;
        assert(stored.status === 'blocked', 'goal.status === "blocked" (aguardando autorização)', stored.status);
        assert(
            stored.blockers.some(b => b.kind === 'missing_permission'),
            'goal.blockers contém o blocker "missing_permission" (ANTES da correção: sempre vazio neste branch)',
            stored.blockers
        );
    }

    console.log('\n=== S84.2 — needs_auth em modo auto-aprovado (DEVELOPER): NENHUM blocker espúrio ===');
    {
        permissionRegistry.setMode(OperationalMode.DEVELOPER, 'test-s84', true);
        const { loop, goalStore } = makeLoop();
        const goal = makeGoal(goalStore, {
            currentPlan: [{ id: 'stepAuth2', description: 'Executar comando perigoso', toolName: AUTH_TOOL, toolArgs: { command: 'echo x' }, status: 'pending', fallbackSteps: [] }],
            replanBudget: 0,
        });
        const state = emptyState(goal.id) as any;
        await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, state);
        const stored = goalStore.getById(goal.id)!;
        assert(
            !stored.blockers.some(b => b.kind === 'missing_permission'),
            'goal.blockers NÃO contém "missing_permission" em modo auto-aprovado — a tool não foi de fato bloqueada, registrar um blocker aqui seria factualmente incorreto',
            stored.blockers
        );
        permissionRegistry.setMode(OperationalMode.SAFE, 'test-s84-restore');
    }

    console.log('\n=== S84.3 — needs_dependency: blocker "missing_tool" preservado (reproduz goal_...ml39u real) ===');
    {
        const { loop, goalStore } = makeLoop();
        const goal = makeGoal(goalStore, {
            currentPlan: [{ id: 'stepDep', description: 'Converter documento', toolName: DEP_TOOL, toolArgs: {}, status: 'pending', fallbackSteps: [] }],
        });
        const state = emptyState(goal.id) as any;
        await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, state);
        const stored = goalStore.getById(goal.id)!;
        assert(
            stored.blockers.some(b => b.kind === 'missing_tool'),
            'goal.blockers contém o blocker "missing_tool" (ANTES da correção: sempre vazio neste branch — mesmo padrão do goal real goal_1783215245583_ml39u, edge-tts ausente)',
            stored.blockers
        );
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S84 RESULTADO: ${passed} passou | ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
