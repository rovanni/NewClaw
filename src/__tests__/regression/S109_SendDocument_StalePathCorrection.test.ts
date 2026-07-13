/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S109
 *
 * Achado real (logs de instalação Windows, 2026-07-12, goal_1783909958138_8nchb — e a MESMA
 * assinatura repetida em goal_..._ykpko 09/07, goal_..._fddyq e goal_..._kzkko 10/07): o goal
 * gera um artefato real (confirmado por VALIDATION-ARTIFACT/writtenPaths, "Objetivo validado"),
 * mas o step `send_document` diferido carrega um `file_path` desatualizado do plano original —
 * porque a estratégia pivotou no meio da execução (ex.: conversão via bash falhou sem WSL
 * funcional → agente trocou de HTML/Reveal.js para geração de .pptx via python-pptx) sem que o
 * step de envio já agendado fosse atualizado. Resultado sem a correção: `send_document` falha
 * com "Arquivo não encontrado" apontando para um nome que nunca existiu, e o goal termina com
 * "Objetivo validado, mas nenhum arquivo pôde ser entregue ao usuário" — apesar do artefato real
 * estar no disco o tempo todo.
 *
 * Fix (GoalExecutionLoop.ts): `validateGoalCompletion` agora retorna `artifactPaths` — os
 * arquivos que ela mesma confirmou existir em disco (evidência real, não o plano). No loop de
 * deferredSends, se o `file_path` solicitado não existe E existe EXATAMENTE 1 artefato validado
 * ainda não enviado, corrige o `toolArgs.file_path` antes de despachar — sem adivinhar por
 * extensão, sem heurística nova, só reaproveitando evidência que o próprio goal já comprovou.
 * Em caso de ambiguidade (0 ou 2+ candidatos), mantém o comportamento antigo (falha com mensagem
 * clara) — não adivinha às cegas.
 *
 * Execução: npx ts-node src/__tests__/regression/S109_SendDocument_StalePathCorrection.test.ts
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';
import { GoalStore } from '../../loop/GoalStore';
import { ToolRegistry } from '../../core/ToolRegistry';
import { Goal, PlanStep, GoalAttempt } from '../../loop/GoalTypes';
import { ChannelContext } from '../../loop/agentLoopTypes';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

function emptyState(goalId: string): { cognitiveContext: unknown; progressModel: unknown } {
    return {
        cognitiveContext: { discoveries: [], failedStrategies: [], filesRead: [], filesModified: [], generatedArtifacts: [], executedCommands: [], importantOutputs: [] },
        progressModel: { goalId, components: [], overallPercent: 0, updatedAt: Date.now() },
    };
}

// send_document fake: registra o file_path com que foi REALMENTE chamado e sempre "sucede",
// exceto para o marcador "__missing__" (simula o "Arquivo não encontrado" real quando não há
// correção possível). O que o teste verifica é QUAL caminho chegou ao tool, não o resultado dele.
const calledWithPaths: string[] = [];
ToolRegistry.register({
    name: 'send_document',
    description: 'test',
    parameters: {},
    execute: async (args: Record<string, unknown>) => {
        const fp = String(args['file_path'] ?? '');
        calledWithPaths.push(fp);
        if (fp.includes('__missing__') || !fs.existsSync(path.join(workspaceDir, fp))) {
            return { success: false, output: '', error: `Arquivo não encontrado: ${fp}` };
        }
        return { success: true, output: `Documento "${fp}" enviado.` };
    },
});

function makeFakeProviderFactory() {
    const body = JSON.stringify({ achieved: true, summary: 'teste S109' });
    return {
        chatWithFallback: async () => ({ status: 'success', content: body }),
        getProvider: () => undefined,
        getProviderWithModel: () => ({ chat: async () => ({ status: 'success', content: body }) }),
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

function makeGoal(store: GoalStore, overrides: Partial<Goal> & { currentPlan: PlanStep[] }): Goal {
    return store.create({
        sessionKey: 'test:s109',
        conversationId: 'test-conv-s109',
        userIntent: 'objetivo de teste S109',
        objective: 'Objetivo de teste S109',
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

function writeAttempt(rawPath: string): GoalAttempt {
    return {
        id: `att_${rawPath.replace(/\W/g, '_')}`,
        planStepId: 'step_write',
        toolName: 'write',
        args: { path: rawPath },
        result: 'success',
        output: `Criado: ${rawPath}`,
        durationMs: 10,
        executedAt: Date.now(),
    };
}

const channelContext: ChannelContext = { channel: 'test', chatId: 'test-user' };

// Isola WORKSPACE_DIR num diretório temporário — nunca toca no workspace real do projeto.
const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s109-workspace-'));
process.env.WORKSPACE_DIR = workspaceDir;

function writeRealFile(rawPath: string, content = 'conteudo de teste'): void {
    const full = path.join(workspaceDir, rawPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
}

async function main() {
    console.log('\n=== S109.1 — file_path desatualizado + exatamente 1 artefato real validado → CORRIGE e entrega ===');
    {
        calledWithPaths.length = 0;
        writeRealFile('tmp/aula_seguranca_redes.pptx');
        const { loop, goalStore } = makeLoop();
        const goal = makeGoal(goalStore, {
            attempts: [writeAttempt('tmp/aula_seguranca_redes.pptx')],
            currentPlan: [sendStep('s1', 'seguranca_redes_slides.html')], // nome que NUNCA existiu (pivô de estratégia)
        });
        const state = emptyState(goal.id) as any;
        const result = await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, state);

        assert(result.success === true, 'goal completou com sucesso (correção evitou falso "arquivo não encontrado")', result);
        assert(
            calledWithPaths.includes('tmp/aula_seguranca_redes.pptx'),
            'send_document foi chamado com o artefato REAL, não com o nome obsoleto do plano',
            calledWithPaths
        );
        assert(
            !calledWithPaths.includes('seguranca_redes_slides.html'),
            'send_document NUNCA foi chamado com o file_path stale original',
            calledWithPaths
        );
    }

    console.log('\n=== S109.2 — file_path existe de verdade (sem stale) → NÃO mexe, comportamento inalterado ===');
    {
        calledWithPaths.length = 0;
        writeRealFile('tmp/arquivo_correto.pptx');
        const { loop, goalStore } = makeLoop();
        const goal = makeGoal(goalStore, {
            attempts: [writeAttempt('tmp/arquivo_correto.pptx')],
            currentPlan: [sendStep('s1', 'tmp/arquivo_correto.pptx')],
        });
        const state = emptyState(goal.id) as any;
        const result = await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, state);

        assert(result.success === true, 'goal completou com sucesso (caminho já correto)', result);
        assert(calledWithPaths.length === 1 && calledWithPaths[0] === 'tmp/arquivo_correto.pptx',
            'send_document chamado exatamente com o path original — nenhuma correção desnecessária', calledWithPaths);
    }

    console.log('\n=== S109.3 — file_path desatualizado + ZERO artefatos validados → NÃO adivinha, falha como antes ===');
    {
        calledWithPaths.length = 0;
        const { loop, goalStore } = makeLoop();
        const goal = makeGoal(goalStore, {
            attempts: [], // nenhum write bem-sucedido — nenhuma evidência de artefato real
            currentPlan: [sendStep('s1', 'arquivo_que_nao_existe__missing__.html')],
        });
        const state = emptyState(goal.id) as any;
        const result = await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, state);

        assert(result.success === false, 'goal falha (sem evidência de artefato real para corrigir)', result);
        assert(
            calledWithPaths[0] === 'arquivo_que_nao_existe__missing__.html',
            'send_document foi chamado com o path original sem tentativa de adivinhação (0 candidatos)',
            calledWithPaths
        );
    }

    console.log('\n=== S109.4 — file_path desatualizado + 2 artefatos validados (ambíguo) → NÃO adivinha, falha como antes ===');
    {
        calledWithPaths.length = 0;
        writeRealFile('tmp/candidato_a.pptx');
        writeRealFile('tmp/candidato_b.pptx');
        const { loop, goalStore } = makeLoop();
        const goal = makeGoal(goalStore, {
            attempts: [writeAttempt('tmp/candidato_a.pptx'), writeAttempt('tmp/candidato_b.pptx')],
            currentPlan: [sendStep('s1', 'arquivo_stale__missing__.html')],
        });
        const state = emptyState(goal.id) as any;
        const result = await (loop as any).runLoopInternal(goal, channelContext, undefined, 0, 0, undefined, state);

        assert(result.success === false, 'goal falha (2 candidatos = ambíguo, não adivinha)', result);
        assert(
            calledWithPaths[0] === 'arquivo_stale__missing__.html',
            'send_document foi chamado com o path original — ambiguidade não é resolvida às cegas',
            calledWithPaths
        );
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S109 RESULTADO: ${passed} passou | ${failed} falhou`);
    try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
