/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S499
 *
 * Previne o reaproveitamento silencioso de arquivo antigo do workspace quando um plano
 * executa `exec_command`/`ssh_exec` antes de `send_document`:
 *
 * 1. `sanitizePlanSteps()`: mesmo que um arquivo com nome semelhante/plausível já exista em
 *    disco antes do plano rodar, um `send_document` posterior a `exec_command`/`ssh_exec`
 *    (cujo path não foi produzido por um `write` explícito no mesmo plano) precisa ser
 *    rebaixado para AgentLoop step — nunca fixado com o `file_path` antigo.
 * 2. `GoalExecutionLoop.evaluateCriteria()` (`pending_send_verified_on_disk`): quando o goal
 *    possui tentativa bem-sucedida de tool produtora (`exec_command`, `ssh_exec` ou `write`),
 *    um arquivo pré-existente cujo `mtime` antecede `goal.createdAt` não pode disparar o
 *    bypass estrutural nem satisfazer o envio.
 *
 * Execução: npx ts-node src/__tests__/regression/S499_SendDocumentAposExecNaoUsaArquivoAntigo.test.ts
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { sanitizePlanSteps } from '../../loop/planning/sanitizePlanSteps';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';
import { GoalStore } from '../../loop/GoalStore';
import { ToolRegistry } from '../../core/ToolRegistry';
import { ExecCommandTool } from '../../tools/exec_command';
import { SshExecTool } from '../../tools/ssh_exec';
import { WriteTool } from '../../tools/write_tool';
import { SendDocumentTool } from '../../tools/send_document';
import { AUTO_DELIVERY_CRITERION_IDS } from '../../loop/planning/ensureDeliverySuccessCriteria';
import type { Goal, GoalAttempt, PlanStep } from '../../loop/GoalTypes';
import type { ContentStubClassifier } from '../../shared/contentStubClassifier';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) {
        console.log(`  ✅ ${message}`);
        passed++;
    } else {
        console.error(`  ❌ FALHOU: ${message}`, detail ?? '');
        failed++;
    }
}

function registerToolsForTest(): void {
    const entries = [
        [new ExecCommandTool(), { dangerous: true }] as const,
        [new SshExecTool(), { dangerous: true }] as const,
        [new WriteTool(), undefined] as const,
        [new SendDocumentTool({} as any), undefined] as const,
    ];
    for (const [tool, opts] of entries) {
        if (!ToolRegistry.get(tool.name)) {
            ToolRegistry.register(tool, opts);
        }
    }
}

const noMissingArgs = (): string | null => null;
const neverStub: ContentStubClassifier = async () => ({ isStub: false, reason: 'test' });

function makeLoop(): { loop: GoalExecutionLoop; db: any } {
    const db = new (Database as any)(':memory:');
    const goalStore = new GoalStore(db);
    const fakeMemory = { getDatabase: () => db } as any;
    const fakePlanner = {
        getAvailableSkills: () => [],
        setSkillContext: () => {},
        setModel: () => {},
        replan: async () => ({ steps: [], strategy: 'n/a' }),
    } as any;
    const fakeProviderFactory = {
        chatWithFallback: async () => ({ status: 'success', content: '{}' }),
        getProvider: () => undefined,
        getProviderWithModel: () => ({ chat: async () => ({ status: 'success', content: '{}' }) }),
    } as any;
    const loop = new GoalExecutionLoop(
        {} as any,
        goalStore,
        fakePlanner,
        { record: () => {}, buildContextHint: () => '', findHardConstraints: () => [] } as any,
        ToolRegistry,
        fakeProviderFactory,
        fakeMemory,
        {
            findApplicableCasesShadow: async () => [],
            backfillMissingEmbeddings: async () => {},
            captureIfEligible: () => {},
            findSimilarShadow: () => [],
        } as any,
    );
    return { loop, db };
}

function makeGoal(overrides: Partial<Goal>): Goal {
    const now = Date.now();
    return {
        id: 'goal_s499',
        sessionKey: 'test:s499',
        conversationId: 'conv-s499',
        userIntent: 'baixe o vídeo em mp4 e envie ao usuário',
        objective: 'Baixar e enviar o vídeo em mp4',
        status: 'executing',
        currentPlan: [],
        toolsTried: [],
        strategiesTried: [],
        sentArtifacts: [],
        retryBudget: 3,
        replanBudget: 3,
        confidence: 0.9,
        requiresAuth: false,
        authorizationScope: [],
        createdAt: now,
        updatedAt: now,
        expiresAt: now + 3_600_000,
        blockers: [],
        attempts: [],
        successCriteria: [],
        ...overrides,
    };
}

function makeAttempt(overrides: Partial<GoalAttempt>): GoalAttempt {
    return {
        id: 'attempt_1',
        planStepId: 'step_1',
        toolName: 'exec_command',
        args: {},
        result: 'success',
        durationMs: 25,
        executedAt: Date.now(),
        ...overrides,
    };
}

async function main(): Promise<void> {
    registerToolsForTest();

    const prevWorkspaceDir = process.env.WORKSPACE_DIR;
    const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s499-'));
    process.env.WORKSPACE_DIR = tempWorkspace;

    try {
        const oldVideoPath = path.join(tempWorkspace, 'video_antigo.mp4');
        const oldPdfPath = path.join(tempWorkspace, 'relatorio_antigo.pdf');
        const freshVideoPath = path.join(tempWorkspace, 'video_novo.mp4');
        fs.writeFileSync(oldVideoPath, Buffer.alloc(1024, 0x41));
        fs.writeFileSync(oldPdfPath, Buffer.alloc(1024, 0x42));
        fs.writeFileSync(freshVideoPath, Buffer.alloc(1024, 0x43));

        console.log('\n=== S499.1 — exec_command -> send_document(arquivo antigo já no disco) é rebaixado para AgentLoop ===');
        {
            const res = await sanitizePlanSteps(
                [
                    {
                        id: 'step_1',
                        description: 'Baixar vídeo via script nativo',
                        toolName: 'exec_command',
                        toolArgs: { command: 'node scripts/video-media.mjs baixar "https://example.com/video" --whatsapp' },
                    },
                    {
                        id: 'step_2',
                        description: 'Enviar vídeo baixado',
                        toolName: 'send_document',
                        toolArgs: { file_path: 'video_antigo.mp4' },
                    },
                ],
                ToolRegistry,
                '[S499]',
                noMissingArgs,
                neverStub,
            );
            assert(res.steps[0].toolName === 'exec_command', 'step_1 exec_command mantido', res.steps[0]);
            assert(res.steps[1].toolName === undefined, 'step_2 send_document rebaixado para AgentLoop', res.steps[1]);
            assert(res.steps[1].toolArgs === undefined, 'step_2 toolArgs limpo ao rebaixar', res.steps[1]);
            assert((res.steps[1] as unknown as Record<string, unknown>).plannedPathIntent === undefined, 'step_2 não herda plannedPathIntent do arquivo antigo', res.steps[1]);
            assert(
                res.mutations.some(m => m.stepId === 'step_2' && m.originalTool === 'send_document' && m.reason === 'missing_file_reference'),
                'mutação registrada com reason=missing_file_reference',
                res.mutations,
            );
        }

        console.log('\n=== S499.2 — ssh_exec -> send_document(arquivo antigo já no disco) também é rebaixado para AgentLoop ===');
        {
            const res = await sanitizePlanSteps(
                [
                    {
                        id: 'step_1',
                        description: 'Executar comando remoto',
                        toolName: 'ssh_exec',
                        toolArgs: { host: 'lab', command: 'echo ok' },
                    },
                    {
                        id: 'step_2',
                        description: 'Enviar relatório gerado',
                        toolName: 'send_document',
                        toolArgs: { file_path: 'relatorio_antigo.pdf' },
                    },
                ],
                ToolRegistry,
                '[S499]',
                noMissingArgs,
                neverStub,
            );
            assert(res.steps[0].toolName === 'ssh_exec', 'step_1 ssh_exec mantido', res.steps[0]);
            assert(res.steps[1].toolName === undefined, 'step_2 send_document após ssh_exec rebaixado para AgentLoop', res.steps[1]);
            assert(
                res.mutations.some(m => m.stepId === 'step_2' && m.reason === 'missing_file_reference'),
                'mutação missing_file_reference registrada após ssh_exec',
                res.mutations,
            );
        }

        console.log('\n=== S499.3 [controle] — send_document de arquivo existente SEM produtor shell antes permanece intacto (S157-4) ===');
        {
            const res = await sanitizePlanSteps(
                [
                    {
                        id: 'step_1',
                        description: 'Enviar arquivo já pronto no workspace',
                        toolName: 'send_document',
                        toolArgs: { file_path: 'video_antigo.mp4' },
                    },
                ],
                ToolRegistry,
                '[S499]',
                noMissingArgs,
                neverStub,
            );
            assert(res.steps[0].toolName === 'send_document', 'send_document sem produtor antes mantido', res.steps[0]);
            assert(res.steps[0].toolArgs?.file_path === 'video_antigo.mp4', 'file_path preservado quando não há produtor shell antes', res.steps[0]);
            assert(res.mutations.length === 0, 'nenhuma mutação emitida para arquivo já pronto sem produtor antes', res.mutations);
        }

        console.log('\n=== S499.4 [controle] — write -> send_document e exec_command -> write -> send_document preservam send_document (S157-3) ===');
        {
            const resWrite = await sanitizePlanSteps(
                [
                    {
                        id: 'step_1',
                        description: 'Escrever resumo',
                        toolName: 'write',
                        toolArgs: { path: 'resumo_novo.txt', content: 'Resumo completo gerado diretamente pelo modelo com informações reais.' },
                    },
                    {
                        id: 'step_2',
                        description: 'Enviar resumo',
                        toolName: 'send_document',
                        toolArgs: { file_path: 'resumo_novo.txt' },
                    },
                ],
                ToolRegistry,
                '[S499]',
                noMissingArgs,
                neverStub,
            );
            assert(resWrite.steps[1].toolName === 'send_document', 'write -> send_document mantém send_document', resWrite.steps[1]);

            const resExecWrite = await sanitizePlanSteps(
                [
                    {
                        id: 'step_1',
                        description: 'Executar verificação prévia',
                        toolName: 'exec_command',
                        toolArgs: { command: 'echo check' },
                    },
                    {
                        id: 'step_2',
                        description: 'Escrever arquivo explícito',
                        toolName: 'write',
                        toolArgs: { path: 'saida_explicita.txt', content: 'Conteúdo completo escrito explicitamente no step_2.' },
                    },
                    {
                        id: 'step_3',
                        description: 'Enviar arquivo escrito no step_2',
                        toolName: 'send_document',
                        toolArgs: { file_path: 'saida_explicita.txt' },
                    },
                ],
                ToolRegistry,
                '[S499]',
                noMissingArgs,
                neverStub,
            );
            assert(resExecWrite.steps[2].toolName === 'send_document', 'exec_command -> write -> send_document mantém send_document do arquivo escrito por write', resExecWrite.steps[2]);
        }

        console.log('\n=== S499.5 [controle] — replan direto com send_document em knownExistingPaths sem novo shell antes permanece (S111) ===');
        {
            const res = await sanitizePlanSteps(
                [
                    {
                        id: 'step_1',
                        description: 'Enviar vídeo gerado no ciclo anterior',
                        toolName: 'send_document',
                        toolArgs: { file_path: 'video_antigo.mp4' },
                    },
                ],
                ToolRegistry,
                '[S499]',
                noMissingArgs,
                neverStub,
                new Set([oldVideoPath]),
            );
            assert(res.steps[0].toolName === 'send_document', 'replan direto com knownExistingPaths mantém send_document', res.steps[0]);
        }

        console.log('\n=== S499.6 — evaluateCriteria(): bypass NÃO dispara para arquivo pré-existente (mtime < goal.createdAt) após exec_command ===');
        {
            const { loop, db } = makeLoop();
            try {
                const goalCreatedAt = Date.now();
                const pastSeconds = Math.floor((goalCreatedAt - 60_000) / 1000);
                fs.utimesSync(oldVideoPath, pastSeconds, pastSeconds);

                const pendingSend: PlanStep = {
                    id: 'step_2',
                    description: 'Enviar vídeo',
                    toolName: 'send_document',
                    toolArgs: { file_path: 'video_antigo.mp4' },
                    status: 'pending',
                };
                const goal = makeGoal({
                    createdAt: goalCreatedAt,
                    currentPlan: [
                        { id: 'step_1', description: 'Baixar vídeo', toolName: 'exec_command', status: 'completed' },
                        pendingSend,
                    ],
                    attempts: [
                        makeAttempt({ toolName: 'exec_command', result: 'success', executedAt: goalCreatedAt + 200 }),
                    ],
                    successCriteria: [
                        {
                            id: AUTO_DELIVERY_CRITERION_IDS.send_document,
                            description: 'Entrega confirmada via send_document',
                            check: 'tool_succeeded',
                            tool: 'send_document',
                            status: 'pending',
                        },
                        {
                            id: AUTO_DELIVERY_CRITERION_IDS.structural_bypass_send_document,
                            description: 'Arquivo(s) pendente(s) de envio já existem no disco',
                            check: 'pending_send_verified_on_disk',
                            status: 'pending',
                        },
                    ],
                });

                const evalRes = (loop as any).evaluateCriteria(goal);
                const bypassCrit = evalRes.updated.find((c: any) => c.id === AUTO_DELIVERY_CRITERION_IDS.structural_bypass_send_document);
                const sendCrit = evalRes.updated.find((c: any) => c.id === AUTO_DELIVERY_CRITERION_IDS.send_document);
                assert(bypassCrit?.status === 'unverifiable', 'critério structural_bypass fica unverifiable para arquivo antigo após produtor', bypassCrit);
                assert(sendCrit?.status !== 'met', 'critério irmão send_document NÃO fica met quando bypass foi bloqueado por arquivo antigo', sendCrit);
            } finally {
                db.close();
            }
        }

        console.log('\n=== S499.7 [controle] — evaluateCriteria(): sem attempt produtor (ARCH-018 puro), arquivo antigo já pronto dispara bypass normalmente ===');
        {
            const { loop, db } = makeLoop();
            try {
                const goalCreatedAt = Date.now();
                const pastSeconds = Math.floor((goalCreatedAt - 60_000) / 1000);
                fs.utimesSync(oldVideoPath, pastSeconds, pastSeconds);

                const goal = makeGoal({
                    createdAt: goalCreatedAt,
                    currentPlan: [
                        {
                            id: 'step_1',
                            description: 'Enviar vídeo pré-existente',
                            toolName: 'send_document',
                            toolArgs: { file_path: 'video_antigo.mp4' },
                            status: 'pending',
                        },
                    ],
                    attempts: [],
                    successCriteria: [
                        {
                            id: AUTO_DELIVERY_CRITERION_IDS.send_document,
                            description: 'Entrega confirmada via send_document',
                            check: 'tool_succeeded',
                            tool: 'send_document',
                            status: 'pending',
                        },
                        {
                            id: AUTO_DELIVERY_CRITERION_IDS.structural_bypass_send_document,
                            description: 'Arquivo(s) pendente(s) de envio já existem no disco',
                            check: 'pending_send_verified_on_disk',
                            status: 'pending',
                        },
                    ],
                });

                const evalRes = (loop as any).evaluateCriteria(goal);
                const bypassCrit = evalRes.updated.find((c: any) => c.id === AUTO_DELIVERY_CRITERION_IDS.structural_bypass_send_document);
                const sendCrit = evalRes.updated.find((c: any) => c.id === AUTO_DELIVERY_CRITERION_IDS.send_document);
                assert(bypassCrit?.status === 'met', 'bypass dispara normalmente quando não há attempt produtor (ARCH-018 preservado)', bypassCrit);
                assert(sendCrit?.status === 'met', 'critério irmão send_document fica met quando bypass legítimo dispara', sendCrit);
            } finally {
                db.close();
            }
        }

        console.log('\n=== S499.8 [controle] — evaluateCriteria(): após exec_command, arquivo NOVO (mtime >= goal.createdAt) dispara bypass normalmente ===');
        {
            const { loop, db } = makeLoop();
            try {
                const goalCreatedAt = Date.now();
                const freshSeconds = Math.ceil((goalCreatedAt + 2000) / 1000);
                fs.utimesSync(freshVideoPath, freshSeconds, freshSeconds);

                const goal = makeGoal({
                    createdAt: goalCreatedAt,
                    currentPlan: [
                        { id: 'step_1', description: 'Baixar vídeo', toolName: 'exec_command', status: 'completed' },
                        {
                            id: 'step_2',
                            description: 'Enviar vídeo recém-baixado',
                            toolName: 'send_document',
                            toolArgs: { file_path: 'video_novo.mp4' },
                            status: 'pending',
                        },
                    ],
                    attempts: [
                        makeAttempt({ toolName: 'exec_command', result: 'success', executedAt: goalCreatedAt + 500 }),
                    ],
                    successCriteria: [
                        {
                            id: AUTO_DELIVERY_CRITERION_IDS.send_document,
                            description: 'Entrega confirmada via send_document',
                            check: 'tool_succeeded',
                            tool: 'send_document',
                            status: 'pending',
                        },
                        {
                            id: AUTO_DELIVERY_CRITERION_IDS.structural_bypass_send_document,
                            description: 'Arquivo(s) pendente(s) de envio já existem no disco',
                            check: 'pending_send_verified_on_disk',
                            status: 'pending',
                        },
                    ],
                });

                const evalRes = (loop as any).evaluateCriteria(goal);
                const bypassCrit = evalRes.updated.find((c: any) => c.id === AUTO_DELIVERY_CRITERION_IDS.structural_bypass_send_document);
                const sendCrit = evalRes.updated.find((c: any) => c.id === AUTO_DELIVERY_CRITERION_IDS.send_document);
                assert(bypassCrit?.status === 'met', 'bypass dispara quando arquivo tem mtime recente após produtor', bypassCrit);
                assert(sendCrit?.status === 'met', 'critério irmão send_document fica met para arquivo novo após produtor', sendCrit);
            } finally {
                db.close();
            }
        }
    } finally {
        if (prevWorkspaceDir === undefined) {
            delete process.env.WORKSPACE_DIR;
        } else {
            process.env.WORKSPACE_DIR = prevWorkspaceDir;
        }
        fs.rmSync(tempWorkspace, { recursive: true, force: true });
    }

    console.log(`\nResumo S499: ${passed} passaram, ${failed} falharam.`);
    process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
    console.error('Erro fatal S499:', err);
    process.exitCode = 1;
});
