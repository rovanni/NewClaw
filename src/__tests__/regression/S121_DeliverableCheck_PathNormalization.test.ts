/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S121 (ARCH-005, Sprint 2026-08-S16)
 *
 * BUG (achado na reverificação de premissa da S16, não documentado antes): dentro de
 * "Item 2: Deliverable Check" (`GoalExecutionLoop.runLoopInternal`), `substantiveFiles` vem de
 * `checkDeliverables()` — que varre o disco com `fs.readdirSync` e retorna paths ABSOLUTOS
 * (`path.join(workspaceDir, ...)`, ver S9). `sentArtifacts` guarda o path CRU exatamente como
 * o LLM passou pro `send_document` (`toolArgs.file_path`), que pode ser relativo (ex.:
 * "aula.pptx"). Comparar os dois direto via `.has()`, sem normalizar, fazia um arquivo JÁ
 * ENTREGUE (registrado com path relativo) parecer "não entregue" quando `checkDeliverables()`
 * o encontrava pelo path absoluto — deliverable_check injetava um `send_document` duplicado
 * do mesmo arquivo.
 *
 * FIX: resolve ambos os lados (`sentArtifacts`, `pendingSendPaths`) via `resolvePath()` — a
 * mesma função já usada por write/read/exec_command — antes de comparar contra os paths
 * absolutos de `substantiveFiles`.
 *
 * Este teste dirige `runLoopInternal()` de ponta a ponta (LLM de validação mockado, ToolRegistry
 * real, GoalStore real sobre SQLite em memória — mesmo padrão de S79/S21) com um arquivo real em
 * disco e `sentArtifacts` populado com o path RELATIVO desse mesmo arquivo, provando que
 * deliverable_check NÃO injeta um send_document duplicado.
 *
 * Execução: npx ts-node src/__tests__/regression/S121_DeliverableCheck_PathNormalization.test.ts
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
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

function makeFakeProviderFactory(chatImpl: (...args: unknown[]) => Promise<unknown>) {
    return {
        chatWithFallback: chatImpl,
        getProvider: () => undefined,
        getProviderWithModel: () => ({ chat: chatImpl }),
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
        replan: async () => ({ steps: [], strategy: 'n/a' }),
    } as any;
    const loop = new GoalExecutionLoop(
        {} as any,
        goalStore,
        fakePlanner,
        { record: () => {}, buildContextHint: () => '', findHardConstraints: () => [] } as any,
        ToolRegistry,
        providerFactory,
        fakeMemory,
        { findApplicableCasesShadow: async () => [], backfillMissingEmbeddings: async () => {}, captureIfEligible: () => {}, findSimilarShadow: () => [] } as any,
    );
    return { loop, goalStore };
}

function makeGoal(store: GoalStore, overrides: Partial<Goal> & { currentPlan: PlanStep[] }): Goal {
    return store.create({
        sessionKey: 'test:s121',
        conversationId: 'test-conv-s121',
        userIntent: 'gerar apresentação de slides sobre DHCP',
        objective: 'gerar apresentação de slides sobre DHCP',
        status: 'executing',
        attempts: [],
        blockers: [],
        toolsTried: [],
        strategiesTried: [],
        successCriteria: [],
        sentArtifacts: [],
        // replanBudget=0: força saída rápida (goal 'failed') logo após o bloco de
        // deliverable_check, sem precisar de um planner mock funcional — o único ponto de
        // interesse deste teste é o que acontece DENTRO do deliverable_check, não o replan.
        retryBudget: 3,
        replanBudget: 0,
        confidence: 0.9,
        requiresAuth: false,
        authorizationScope: [],
        expiresAt: Date.now() + 3_600_000,
        ...overrides,
    } as Omit<Goal, 'id' | 'createdAt' | 'updatedAt'>);
}

const channelContext: ChannelContext = { channel: 'test', chatId: 'test-user' };

function emptyState(goalId: string) {
    return {
        cognitiveContext: { discoveries: [], failedStrategies: [], filesRead: [], filesModified: [], generatedArtifacts: [], executedCommands: [], importantOutputs: [] },
        progressModel: { goalId, components: [], overallPercent: 0, updatedAt: Date.now() },
    } as any;
}

async function main(): Promise<void> {

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s121-test-'));
const originalWorkspaceDir = process.env.WORKSPACE_DIR;
process.env.WORKSPACE_DIR = tmpDir;

try {
    // LLM de validação sempre diz "não concluído" — o que importa neste teste é o que
    // acontece no bloco de deliverable_check ANTES do replan, não a validação em si.
    const { loop, goalStore } = makeLoop(makeFakeProviderFactory(async () => ({
        status: 'success',
        content: JSON.stringify({ achieved: false, reason: 'teste S121' }),
    })));

    console.log('\n=== S121-1 [fix] — arquivo já entregue via path RELATIVO não é reagendado quando encontrado por path ABSOLUTO ===');
    {
        const relativePath = 'aula_dhcp.pptx';
        const absolutePath = path.join(tmpDir, relativePath);
        // Conteúdo >= MIN_DELIVERABLE_SIZE (200 bytes) para não ser tratado como placeholder.
        fs.writeFileSync(absolutePath, 'x'.repeat(500));

        const goal = makeGoal(goalStore, {
            currentPlan: [], // nenhum step pendente → readyToValidate=true no cycle 1
            sentArtifacts: [relativePath], // registrado com o path CRU (relativo), como o LLM passaria
        });

        await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, emptyState(goal.id));

        const stored = goalStore.getById(goal.id)!;
        const injectedSendSteps = stored.currentPlan.filter(s => s.toolName === 'send_document');
        assert(
            injectedSendSteps.length === 0,
            `deliverable_check NÃO injeta send_document duplicado para arquivo já em sentArtifacts (mesmo com path relativo vs. absoluto) — steps injetados: ${injectedSendSteps.length}`,
            injectedSendSteps
        );
        assert(
            !stored.strategiesTried.includes('deliverable_check_done'),
            '"deliverable_check_done" NÃO é marcado quando não há arquivo novo a injetar (0 unsentFiles)',
            stored.strategiesTried
        );
    }

    console.log('\n=== S121-2 [controle] — arquivo NUNCA entregue (sentArtifacts vazio) continua sendo injetado normalmente ===');
    {
        const absolutePath = path.join(tmpDir, 'aula_dhcp_v2.pptx');
        fs.writeFileSync(absolutePath, 'y'.repeat(500));

        const goal = makeGoal(goalStore, {
            currentPlan: [],
            sentArtifacts: [], // nada entregue ainda
        });

        await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, emptyState(goal.id));

        const stored = goalStore.getById(goal.id)!;
        const injectedSendSteps = stored.currentPlan.filter(s => s.toolName === 'send_document');
        assert(
            injectedSendSteps.length > 0,
            `deliverable_check AINDA injeta send_document para arquivo genuinamente não entregue (regressão do comportamento legítimo) — steps injetados: ${injectedSendSteps.length}`,
            injectedSendSteps
        );
    }

} finally {
    if (originalWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = originalWorkspaceDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S121 RESULTADO: ${passed} passou | ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S121 erro inesperado:', err);
    process.exitCode = 1;
});
