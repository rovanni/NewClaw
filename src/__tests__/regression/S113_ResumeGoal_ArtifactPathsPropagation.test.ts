/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S113
 *
 * Sprint F3 (revisão de código pós-piloto R1-R7, /code-review high sobre commits 4be42a5/
 * 9baa18e): `GoalExecutionLoop.resumeGoal()` — chamado quando um step ficou bloqueado
 * aguardando autorização e o usuário aprova — marcava o step como concluído via
 * `markStepDone()` sem nunca popular `GoalAttempt.producedArtifactPaths`, mesmo quando a tool
 * aprovada (write/exec_command) genuinamente produziu um artefato. A causa raiz era dupla:
 * `WorkflowEngine.resume()` já descartava `ToolResult.artifactPaths` do resultado real de
 * `tool.execute()` ao repassar só `{success,output,decision,error,continuationCtx}`, e
 * `markStepDone()` não tinha parâmetro nenhum pra receber essa evidência mesmo se ela chegasse.
 *
 * Sem o fix: um step write/exec_command que precisou de aprovação de auth e produziu um
 * arquivo real perdia essa evidência — um replan seguinte nesse goal nunca veria o artefato
 * via `goal.attempts` em `resolveArtifactPathFromEvidence` (RiskAnalyzer).
 *
 * Fix: `WorkflowStepResult.artifactPaths` (novo campo) propagado por toda a cadeia —
 * `WorkflowEngine.resume()` → `GoalOrchestrator.resumeFromAuth()` →
 * `GoalExecutionLoop.resumeGoal()` → `markStepDone()` → `GoalAttempt.producedArtifactPaths`.
 *
 * Execução: npx ts-node src/__tests__/regression/S113_ResumeGoal_ArtifactPathsPropagation.test.ts
 */

import Database from 'better-sqlite3';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';
import { GoalStore } from '../../loop/GoalStore';
import { ToolRegistry } from '../../core/ToolRegistry';
import { ChannelContext } from '../../loop/agentLoopTypes';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

function makeFakeProviderFactory() {
    return {
        chatWithFallback: async () => ({ status: 'success', content: JSON.stringify({ achieved: true, summary: 'teste S113' }) }),
        getProvider: () => undefined,
        getProviderWithModel: () => ({ chat: async () => ({ status: 'success', content: JSON.stringify({ achieved: true, summary: 'teste S113' }) }) }),
    } as unknown as import('../../core/ProviderFactory').ProviderFactory;
}

function makeLoop() {
    const db = new (Database as any)(':memory:');
    const goalStore = new GoalStore(db);
    const fakeMemory = { getDatabase: () => db } as any;
    const fakePlanner = { getAvailableSkills: () => [], setSkillContext: () => {}, setModel: () => {}, replan: async () => ({ steps: [], strategy: 'n/a' }) } as any;
    const loop = new GoalExecutionLoop(
        {} as any, goalStore, fakePlanner,
        { record: () => {}, buildContextHint: () => '', findHardConstraints: () => [] } as any,
        ToolRegistry, makeFakeProviderFactory(), fakeMemory,
        { findApplicableCasesShadow: async () => [], backfillMissingEmbeddings: async () => {}, captureIfEligible: () => {}, findSimilarShadow: () => [] } as any,
    );
    return { loop, goalStore };
}

const channelContext: ChannelContext = { channel: 'test', chatId: 'test-user' };

async function main() {
    console.log('\n=== S113.1 — resumeGoal() com authStepArtifactPaths popula GoalAttempt.producedArtifactPaths ===');
    {
        const { loop, goalStore } = makeLoop();
        const goal = goalStore.create({
            sessionKey: 'test:s113', conversationId: 'test-conv-s113',
            userIntent: 'objetivo', objective: 'Objetivo',
            status: 'blocked',
            attempts: [{
                id: 'att_prior_failure', planStepId: 's1', toolName: 'exec_command', args: {},
                result: 'failure', error: 'permission denied: needs authorization',
                durationMs: 1, executedAt: Date.now(), cycle: 1,
            }],
            blockers: [], toolsTried: [], strategiesTried: [],
            successCriteria: [], sentArtifacts: [], retryBudget: 3, replanBudget: 5, confidence: 0.9,
            requiresAuth: false, authorizationScope: [], expiresAt: Date.now() + 3_600_000,
            currentPlan: [{ id: 's1', description: 'Executar comando', toolName: 'exec_command', toolArgs: {}, status: 'pending', fallbackSteps: [] }],
        } as Omit<import('../../loop/GoalTypes').Goal, 'id' | 'createdAt' | 'updatedAt'>);

        // Simula o que GoalOrchestrator.resumeFromAuth() agora repassa depois do fix: o
        // resultado real de tool.execute() (via WorkflowEngine.resume()) incluindo artifactPaths.
        await (loop as any).resumeGoal(
            goal, channelContext, 'comando executado com sucesso via WorkflowEngine',
            undefined, ['tmp/relatorio_aprovado.pdf'],
        );

        const stored = goalStore.getById(goal.id)!;
        const successAttempt = [...stored.attempts].reverse().find(a => a.planStepId === 's1' && a.result === 'success');

        assert(!!successAttempt, 'attempt de sucesso pós-aprovação foi gravado', stored.attempts);
        assert(
            Array.isArray(successAttempt?.producedArtifactPaths) && successAttempt!.producedArtifactPaths!.includes('tmp/relatorio_aprovado.pdf'),
            'producedArtifactPaths propagado até o GoalAttempt — replan seguinte enxergará essa evidência',
            successAttempt?.producedArtifactPaths
        );
    }

    console.log('\n=== S113.2 — resumeGoal() sem authStepArtifactPaths continua funcionando (comportamento inalterado) ===');
    {
        const { loop, goalStore } = makeLoop();
        const goal = goalStore.create({
            sessionKey: 'test:s113-noartifact', conversationId: 'test-conv-s113-noartifact',
            userIntent: 'objetivo', objective: 'Objetivo',
            status: 'blocked',
            attempts: [{
                id: 'att_prior_failure', planStepId: 's1', toolName: 'read', args: {},
                result: 'failure', error: 'permission denied',
                durationMs: 1, executedAt: Date.now(), cycle: 1,
            }],
            blockers: [], toolsTried: [], strategiesTried: [],
            successCriteria: [], sentArtifacts: [], retryBudget: 3, replanBudget: 5, confidence: 0.9,
            requiresAuth: false, authorizationScope: [], expiresAt: Date.now() + 3_600_000,
            currentPlan: [{ id: 's1', description: 'Ler arquivo', toolName: 'read', toolArgs: {}, status: 'pending', fallbackSteps: [] }],
        } as Omit<import('../../loop/GoalTypes').Goal, 'id' | 'createdAt' | 'updatedAt'>);

        await (loop as any).resumeGoal(goal, channelContext, 'lido com sucesso via WorkflowEngine');

        const stored = goalStore.getById(goal.id)!;
        const successAttempt = [...stored.attempts].reverse().find(a => a.planStepId === 's1' && a.result === 'success');

        assert(!!successAttempt, 'attempt de sucesso gravado normalmente sem artifactPaths', stored.attempts);
        assert(
            successAttempt?.producedArtifactPaths === undefined,
            'producedArtifactPaths permanece undefined quando não há artefato (não força array vazio)',
            successAttempt?.producedArtifactPaths
        );
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S113 RESULTADO: ${passed} passou | ${failed} falhou`);
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
