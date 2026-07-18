/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S125 (ARCH-012, RFC `RFC_ARCH-012_UnifiedDeliveryProof.md`, Sprint S27)
 *
 * ACHADO REAL (não hipotético, leitura linha a linha de GoalExecutionLoop.ts): das 3 rotas que
 * decidem "entrega comprovada, achieved=true" (evaluateCriteria/successCriteria — checklist
 * pré-LLM; structuralBypass — checagem de disco, pré-LLM; checkClaimsAgainstEvidence/CLAIM_RULES
 * — pós-LLM), só a 3ª tinha uma checagem de que o ARQUIVO enviado bate com o TIPO esperado pelo
 * pedido original (isExpectedDeliverableFile, fechando o bug real de 09/07: um .py foi aceito
 * como prova de entrega de um .pptx pedido). As outras 2 rotas — que rodam ANTES e portanto
 * "escondem" o problema da 3ª rota, que nunca chega a ser consultada — não tinham essa checagem.
 *
 * FIX: `isExpectedDeliverableFile()` (extraída para `planning/inferExpectedExtensions.ts`) passa
 * a ser chamada também em `evaluateCriteria()` (case 'tool_succeeded'/tool:'send_document') e em
 * `structuralBypass` (dentro de `runValidationPhase`) — mesma função, sem unificar tipo/dado.
 *
 * Execução: npx ts-node src/__tests__/regression/S125_ARCH012_DeliveryTypeMatchAcrossPaths.test.ts
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';
import { GoalStore } from '../../loop/GoalStore';
import { ToolRegistry } from '../../core/ToolRegistry';
import { Goal, PlanStep, GoalAttempt } from '../../loop/GoalTypes';
import { ChannelContext } from '../../loop/agentLoopTypes';
import { AUTO_DELIVERY_CRITERION_IDS } from '../../loop/planning/ensureDeliverySuccessCriteria';
import { isExpectedDeliverableFile } from '../../loop/planning/inferExpectedExtensions';

// Registra um send_document fake mínimo — necessário para os cenários 5/6 (runLoopInternal
// end-to-end) dispatcharem o step de verdade após o bypass decidir achieved=true. Sem isso, o
// ToolRegistry real (vazio neste processo standalone) rejeita o dispatch por "tool_not_registered",
// mascarando o que este teste quer provar (se o BYPASS dispara ou não).
try {
    ToolRegistry.register({
        name: 'send_document',
        description: 'fake p/ teste S125',
        parameters: {},
        execute: async () => ({ success: true, output: 'enviado (fake)' }),
    } as any);
} catch { /* já registrado */ }

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

const PPTX_INTENT = 'gerar apresentação de slides sobre DHCP';

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

function makeAttempt(overrides: Partial<GoalAttempt>): GoalAttempt {
    return {
        id: 'attempt_1', planStepId: 'step_1', toolName: 'send_document',
        args: {}, result: 'success', durationMs: 10, executedAt: Date.now(),
        ...overrides,
    };
}

const channelContext: ChannelContext = { channel: 'test', chatId: 'test-user' };

async function main(): Promise<void> {

console.log('\n=== S125.1 — unidade: isExpectedDeliverableFile() (predicado extraído, mesma lógica de checkClaimsAgainstEvidence antes do fix) ===');
{
    assert(isExpectedDeliverableFile(PPTX_INTENT, 'aula.pptx') === true, '.pptx bate com intent de apresentação', PPTX_INTENT);
    assert(isExpectedDeliverableFile(PPTX_INTENT, 'script.py') === false, '.py NÃO bate com intent de apresentação (o bug real de 09/07)', PPTX_INTENT);
    assert(isExpectedDeliverableFile('escreva um resumo qualquer', 'qualquer_coisa.xyz') === true, 'intent sem extensão inferível é permissivo (comportamento herdado, não uma regressão nova)');
}

console.log('\n=== S125.2 [fix] — evaluateCriteria(): send_document de arquivo do TIPO ERRADO não satisfaz o critério auto-injetado ===');
{
    const { loop } = makeLoop(makeFakeProviderFactory(async () => ({ status: 'success', content: '{}' })));
    const goal: Goal = {
        id: 'goal_s125_2', sessionKey: 'test:s125', conversationId: 'conv-s125-2',
        userIntent: PPTX_INTENT, objective: PPTX_INTENT, status: 'executing',
        currentPlan: [], toolsTried: [], strategiesTried: [], sentArtifacts: [],
        retryBudget: 3, replanBudget: 3, confidence: 0.9, requiresAuth: false, authorizationScope: [],
        createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + 3_600_000,
        blockers: [],
        attempts: [makeAttempt({ args: { file_path: 'script.py' } })],
        successCriteria: [{
            id: AUTO_DELIVERY_CRITERION_IDS.send_document,
            description: 'Entrega confirmada via send_document',
            check: 'tool_succeeded', tool: 'send_document', status: 'pending',
        }],
    } as Goal;

    const result = (loop as any).evaluateCriteria(goal);
    const criterion = result.updated[0];
    assert(criterion.status !== 'met', 'critério NÃO fica "met" quando o único send_document bem-sucedido é do tipo errado (.py em vez de .pptx)', criterion);
}

console.log('\n=== S125.3 [controle] — evaluateCriteria(): send_document do TIPO CERTO continua satisfazendo o critério (sem regressão) ===');
{
    const { loop } = makeLoop(makeFakeProviderFactory(async () => ({ status: 'success', content: '{}' })));
    const goal: Goal = {
        id: 'goal_s125_3', sessionKey: 'test:s125', conversationId: 'conv-s125-3',
        userIntent: PPTX_INTENT, objective: PPTX_INTENT, status: 'executing',
        currentPlan: [], toolsTried: [], strategiesTried: [], sentArtifacts: [],
        retryBudget: 3, replanBudget: 3, confidence: 0.9, requiresAuth: false, authorizationScope: [],
        createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + 3_600_000,
        blockers: [],
        attempts: [makeAttempt({ args: { file_path: 'aula.pptx' } })],
        successCriteria: [{
            id: AUTO_DELIVERY_CRITERION_IDS.send_document,
            description: 'Entrega confirmada via send_document',
            check: 'tool_succeeded', tool: 'send_document', status: 'pending',
        }],
    } as Goal;

    const result = (loop as any).evaluateCriteria(goal);
    const criterion = result.updated[0];
    assert(criterion.status === 'met', 'critério fica "met" quando o send_document bem-sucedido é do tipo certo (.pptx)', criterion);
}

console.log('\n=== S125.4 [controle] — evaluateCriteria(): checagem de tipo é só para tool "send_document", não para tool_succeeded genérico ===');
{
    const { loop } = makeLoop(makeFakeProviderFactory(async () => ({ status: 'success', content: '{}' })));
    const goal: Goal = {
        id: 'goal_s125_4', sessionKey: 'test:s125', conversationId: 'conv-s125-4',
        userIntent: PPTX_INTENT, objective: PPTX_INTENT, status: 'executing',
        currentPlan: [], toolsTried: [], strategiesTried: [], sentArtifacts: [],
        retryBudget: 3, replanBudget: 3, confidence: 0.9, requiresAuth: false, authorizationScope: [],
        createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + 3_600_000,
        blockers: [],
        attempts: [makeAttempt({ toolName: 'crypto_analysis', args: { symbol: 'BTC' }, output: 'preço coletado' })],
        successCriteria: [{
            id: 'user_criterion_1', description: 'Preço coletado', check: 'tool_succeeded', tool: 'crypto_analysis', status: 'pending',
        }],
    } as Goal;

    const result = (loop as any).evaluateCriteria(goal);
    const criterion = result.updated[0];
    assert(criterion.status === 'met', 'critério tool_succeeded para tool que NÃO é send_document continua sem checagem de tipo (escopo do fix é só entrega de arquivo)', criterion);
}

console.log('\n=== S125.5 [fix] — structuralBypass (runLoopInternal end-to-end): arquivo existente do TIPO ERRADO não dispara o bypass ===');
{
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s125-test-'));
    const originalWorkspaceDir = process.env.WORKSPACE_DIR;
    process.env.WORKSPACE_DIR = tmpDir;
    try {
        fs.writeFileSync(path.join(tmpDir, 'script.py'), 'x'.repeat(500));

        const { loop, goalStore } = makeLoop(makeFakeProviderFactory(async () => ({
            status: 'success',
            content: JSON.stringify({ achieved: false, reason: 'teste S125 — validação real não deve ser bypassada' }),
        })));
        const goal = goalStore.create({
            sessionKey: 'test:s125', conversationId: 'conv-s125-5',
            userIntent: PPTX_INTENT, objective: PPTX_INTENT, status: 'executing',
            attempts: [], blockers: [], toolsTried: [], strategiesTried: [],
            successCriteria: [], sentArtifacts: [],
            currentPlan: [{ id: 'step_1', description: 'enviar apresentação', toolName: 'send_document', toolArgs: { file_path: 'script.py' }, status: 'pending' } as PlanStep],
            retryBudget: 3, replanBudget: 0, confidence: 0.9, requiresAuth: false, authorizationScope: [],
            expiresAt: Date.now() + 3_600_000,
        } as Omit<Goal, 'id' | 'createdAt' | 'updatedAt'>);

        await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, {
            cognitiveContext: { discoveries: [], failedStrategies: [], filesRead: [], filesModified: [], generatedArtifacts: [], executedCommands: [], importantOutputs: [] },
            progressModel: { goalId: goal.id, components: [], overallPercent: 0, updatedAt: Date.now() },
        });

        const stored = goalStore.getById(goal.id)!;
        assert(
            stored.status !== 'completed',
            `goal NÃO completa via structuralBypass quando o único arquivo pendente é do tipo errado (.py para um pedido de apresentação) — status real: ${stored.status}`,
            stored.status,
        );
    } finally {
        if (originalWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR;
        else process.env.WORKSPACE_DIR = originalWorkspaceDir;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

console.log('\n=== S125.6 [controle] — structuralBypass: arquivo existente do TIPO CERTO continua disparando o bypass (sem regressão) ===');
{
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s125-test-'));
    const originalWorkspaceDir = process.env.WORKSPACE_DIR;
    process.env.WORKSPACE_DIR = tmpDir;
    try {
        fs.writeFileSync(path.join(tmpDir, 'aula.pptx'), 'x'.repeat(500));

        const { loop, goalStore } = makeLoop(makeFakeProviderFactory(async () => ({
            status: 'success',
            content: JSON.stringify({ achieved: false, reason: 'não deveria ser chamado — bypass deveria resolver antes' }),
        })));
        const goal = goalStore.create({
            sessionKey: 'test:s125', conversationId: 'conv-s125-6',
            userIntent: PPTX_INTENT, objective: PPTX_INTENT, status: 'executing',
            attempts: [], blockers: [], toolsTried: [], strategiesTried: [],
            successCriteria: [], sentArtifacts: [],
            currentPlan: [{ id: 'step_1', description: 'enviar apresentação', toolName: 'send_document', toolArgs: { file_path: 'aula.pptx' }, status: 'pending' } as PlanStep],
            retryBudget: 3, replanBudget: 0, confidence: 0.9, requiresAuth: false, authorizationScope: [],
            expiresAt: Date.now() + 3_600_000,
        } as Omit<Goal, 'id' | 'createdAt' | 'updatedAt'>);

        await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, {
            cognitiveContext: { discoveries: [], failedStrategies: [], filesRead: [], filesModified: [], generatedArtifacts: [], executedCommands: [], importantOutputs: [] },
            progressModel: { goalId: goal.id, components: [], overallPercent: 0, updatedAt: Date.now() },
        });

        const stored = goalStore.getById(goal.id)!;
        assert(
            stored.status === 'completed',
            `goal continua completando via structuralBypass quando o arquivo pendente é do tipo certo (.pptx) — status real: ${stored.status}`,
            stored.status,
        );
    } finally {
        if (originalWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR;
        else process.env.WORKSPACE_DIR = originalWorkspaceDir;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S125 RESULTADO: ${passed} passou | ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S125 erro inesperado:', err);
    process.exitCode = 1;
});
