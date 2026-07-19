/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S128 (ARCH-018, Sprint S18/reabertura, 2026-07-19)
 *
 * ARCH-018 moveu o "bypass estrutural" (goal cujo único trabalho restante é despachar
 * `send_document` para arquivo(s) que já existem no disco) de um `if` solto dentro de
 * `runValidationPhase()` para um `CriterionCheck` novo (`pending_send_verified_on_disk`),
 * avaliado como qualquer outro critério em `evaluateCriteria()`. `file_exists` (que checa
 * `GoalAttempt`) continua intocado — não é reaproveitado, porque checa uma coisa diferente
 * (evidência de attempt vs. disco direto); ver `docs/issues/010`.
 *
 * A lógica de disco/tipo em si (isExpectedDeliverableFile + fs.statSync + MIN_DELIVERABLE_SIZE)
 * é uma cópia quase verbatim do bloco antigo — cobertura de comportamento observável
 * (`runLoopInternal` end-to-end) já vive em `S125_ARCH012_DeliveryTypeMatchAcrossPaths.test.ts`
 * (85.5/85.6, atualizado nesta Sprint pra popular o critério manualmente, já que passa direto
 * por `runLoopInternal()` sem passar pela fase de planejamento onde
 * `ensureDeliverySuccessCriteria()` normalmente injeta este critério).
 *
 * Este teste cobre o que S125 não cobria: a injeção do critério em si
 * (`ensureDeliverySuccessCriteria`) e o efeito colateral desejado (não é bug) de que outros
 * critérios pendentes agora são considerados junto com o bypass — antes, o `if` solto pulava
 * `validateGoalCompletion()` inteiro e os ignorava.
 *
 * Execução: npx ts-node src/__tests__/regression/S128_ARCH018_StructuralBypassAsCriterion.test.ts
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';
import { GoalStore } from '../../loop/GoalStore';
import { ToolRegistry } from '../../core/ToolRegistry';
import { Goal, PlanStep } from '../../loop/GoalTypes';
import { ensureDeliverySuccessCriteria, AUTO_DELIVERY_CRITERION_IDS } from '../../loop/planning/ensureDeliverySuccessCriteria';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

function makeLoop(): { loop: GoalExecutionLoop; goalStore: GoalStore } {
    const db = new (Database as any)(':memory:');
    const goalStore = new GoalStore(db);
    const fakeMemory = { getDatabase: () => db } as any;
    const fakePlanner = { getAvailableSkills: () => [], setSkillContext: () => {}, setModel: () => {}, replan: async () => ({ steps: [], strategy: 'n/a' }) } as any;
    const fakeAgentLoop = { process: async () => '' } as any;
    const loop = new GoalExecutionLoop(
        fakeAgentLoop, goalStore, fakePlanner,
        { record: () => {}, buildContextHint: () => '', findHardConstraints: () => [] } as any,
        ToolRegistry, {} as any, fakeMemory,
        { findApplicableCasesShadow: async () => [], backfillMissingEmbeddings: async () => {}, captureIfEligible: () => {}, findSimilarShadow: () => [] } as any,
    );
    return { loop, goalStore };
}

function makeGoal(store: GoalStore, overrides: Partial<Goal> & { currentPlan: PlanStep[] }): Goal {
    return store.create({
        sessionKey: 'test:s128', conversationId: 'test-conv-s128',
        userIntent: 'envie a apresentação de slides pronta', objective: 'envie a apresentação de slides pronta',
        status: 'executing', attempts: [], blockers: [], toolsTried: [], strategiesTried: [],
        successCriteria: [], sentArtifacts: [], retryBudget: 3, replanBudget: 5, confidence: 0.9,
        requiresAuth: false, authorizationScope: [], expiresAt: Date.now() + 3_600_000,
        ...overrides,
    } as Omit<Goal, 'id' | 'createdAt' | 'updatedAt'>);
}

const CRITERION_ID = AUTO_DELIVERY_CRITERION_IDS.structural_bypass_send_document;

async function main() {
    console.log('\n=== S128.1 — ensureDeliverySuccessCriteria injeta o critério novo quando send_document está no plano ===');
    {
        const steps: PlanStep[] = [{ id: 's1', description: 'enviar', toolName: 'send_document', toolArgs: { file_path: 'x.pptx' }, status: 'pending', fallbackSteps: [] }];
        const result = ensureDeliverySuccessCriteria(steps, []);
        const criterion = result.find(c => c.id === CRITERION_ID);
        assert(!!criterion, 'critério pending_send_verified_on_disk presente quando send_document está no plano', result);
        assert(criterion?.check === 'pending_send_verified_on_disk', `check correto — obtido: ${criterion?.check}`, criterion);
    }

    console.log('\n=== S128.2 — ensureDeliverySuccessCriteria NÃO injeta quando send_document não está no plano ===');
    {
        const steps: PlanStep[] = [{ id: 's1', description: 'escrever', toolName: 'write', toolArgs: { path: 'x.txt' }, status: 'pending', fallbackSteps: [] }];
        const result = ensureDeliverySuccessCriteria(steps, []);
        assert(!result.some(c => c.id === CRITERION_ID), 'critério ausente quando não há send_document no plano', result);
    }

    console.log('\n=== S128.3 — recalculado a cada chamada (replan), não duplica nem acumula ===');
    {
        const steps: PlanStep[] = [{ id: 's1', description: 'enviar', toolName: 'send_document', toolArgs: { file_path: 'x.pptx' }, status: 'pending', fallbackSteps: [] }];
        const first = ensureDeliverySuccessCriteria(steps, []);
        const second = ensureDeliverySuccessCriteria(steps, first);
        const occurrences = second.filter(c => c.id === CRITERION_ID).length;
        assert(occurrences === 1, `exatamente 1 ocorrência após 2 chamadas sucessivas (replan) — obtido: ${occurrences}`, second);
    }

    console.log('\n=== S128.4 — evaluateCriteria(): critério fica "unverifiable" quando não há steps send_document pendentes ===');
    {
        const { loop, goalStore } = makeLoop();
        const goal = makeGoal(goalStore, {
            currentPlan: [{ id: 's1', description: 'escrever', toolName: 'write', status: 'completed', fallbackSteps: [] }],
            successCriteria: [{ id: CRITERION_ID, description: 'x', check: 'pending_send_verified_on_disk', status: 'pending' }],
        });
        const result = (loop as any).evaluateCriteria(goal);
        const criterion = result.updated.find((c: any) => c.id === CRITERION_ID);
        assert(criterion?.status === 'unverifiable', `'unverifiable' sem nenhum step send_document pendente — obtido: ${criterion?.status}`, criterion);
    }

    console.log('\n=== S128.5 — efeito colateral desejado: bypass "met" não basta se OUTRO critério ainda está pendente ===');
    {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s128-test-'));
        const originalWorkspaceDir = process.env.WORKSPACE_DIR;
        process.env.WORKSPACE_DIR = tmpDir;
        try {
            fs.writeFileSync(path.join(tmpDir, 'apresentacao.pptx'), 'x'.repeat(500));
            const { loop, goalStore } = makeLoop();
            const goal = makeGoal(goalStore, {
                currentPlan: [
                    { id: 's1', description: 'enviar', toolName: 'send_document', toolArgs: { file_path: 'apresentacao.pptx' }, status: 'pending', fallbackSteps: [] },
                ],
                successCriteria: [
                    { id: CRITERION_ID, description: 'x', check: 'pending_send_verified_on_disk', status: 'pending' },
                    // Critério independente, nunca vai ser cumprido neste teste (nenhum attempt de
                    // 'outra_tool' existe) — simula um requisito real do goal não relacionado ao envio.
                    { id: 'outro_criterio', description: 'outro requisito', check: 'tool_succeeded', tool: 'outra_tool', status: 'pending' },
                ],
            });
            const result = (loop as any).evaluateCriteria(goal);
            const bypassCriterion = result.updated.find((c: any) => c.id === CRITERION_ID);
            assert(bypassCriterion?.status === 'met', `critério de bypass fica 'met' (arquivo certo, tamanho certo) — obtido: ${bypassCriterion?.status}`, bypassCriterion);
            assert(
                result.result !== 'all_met',
                `result !== 'all_met' porque 'outro_criterio' continua pendente — ANTES desta correção, o if solto de structuralBypass pulava validateGoalCompletion() inteiro e ignorava isso — obtido: ${result.result}`,
                result
            );
        } finally {
            if (originalWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR;
            else process.env.WORKSPACE_DIR = originalWorkspaceDir;
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }

    console.log('\n=== S128.6 — achado real de etapa 4 (2026-07-19): bypass met satisfaz o critério irmão tool_succeeded(send_document), fecha all_met em 1 ciclo ===');
    {
        // Reproduz ao vivo: goal real "envie a aula pronta" completou (success=true), mas com 1
        // replan desnecessário — o critério `tool_succeeded`/`send_document` (auto-injetado por
        // ensureDeliverySuccessCriteria ao lado do bypass, sempre que send_document está no
        // plano) nunca pode ficar 'met' antes do bypass, porque o envio é diferido até
        // achieved=true — sem satisfazê-lo junto, `evaluateCriteria()` nunca fecha 'all_met',
        // cai pro validador LLM, que vê (corretamente) que nada foi enviado ainda e replaneja.
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s128-test-'));
        const originalWorkspaceDir = process.env.WORKSPACE_DIR;
        process.env.WORKSPACE_DIR = tmpDir;
        try {
            fs.writeFileSync(path.join(tmpDir, 'apresentacao.pptx'), 'x'.repeat(500));
            const { loop, goalStore } = makeLoop();
            const goal = makeGoal(goalStore, {
                currentPlan: [
                    { id: 's1', description: 'enviar', toolName: 'send_document', toolArgs: { file_path: 'apresentacao.pptx' }, status: 'pending', fallbackSteps: [] },
                ],
                successCriteria: [
                    { id: CRITERION_ID, description: 'x', check: 'pending_send_verified_on_disk', status: 'pending' },
                    { id: AUTO_DELIVERY_CRITERION_IDS.send_document, description: 'Entrega confirmada via send_document', check: 'tool_succeeded', tool: 'send_document', status: 'pending' },
                ],
            });
            const result = (loop as any).evaluateCriteria(goal);
            const sibling = result.updated.find((c: any) => c.id === AUTO_DELIVERY_CRITERION_IDS.send_document);
            assert(sibling?.status === 'met', `critério irmão tool_succeeded(send_document) também vira 'met' via o bypass — obtido: ${sibling?.status}`, sibling);
            assert(
                result.result === 'all_met',
                `result === 'all_met' em 1 avaliação (sem replan desnecessário) — obtido: ${result.result}`,
                result
            );
        } finally {
            if (originalWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR;
            else process.env.WORKSPACE_DIR = originalWorkspaceDir;
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S128 RESULTADO: ${passed} passou | ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
