/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S128b (issues 037/039, 2026-09-22)
 *
 * Achado ao vivo (instância isolada verify-s4-b, goal_1790086129179_0dv0c, campanha "sistema
 * não utilizável"): usuário pediu resumo de "a última conversa sobre física quântica salva na
 * memória". `memory_search` não achou nada (validador LLM: achieved=false, correto). O sistema
 * caiu num fallback de busca web, gerou um resumo genérico e tentou `send_document` de novo — o
 * validador LLM avaliou o resultado e disse de novo achieved=false, com o motivo exato: "o
 * entregável NÃO ATENDE ao requisito de resumir o histórico específico da interação do usuário".
 * Um ciclo depois, o bypass `pending_send_verified_on_disk` (ARCH-018/S128) disparou — o arquivo
 * existe, tipo/tamanho batem — e pulou `validateGoalCompletion()` (o "achieved=true sem LLM" de
 * `validateGoalCompletion:3872`), fechando o goal como completed, sobrepondo a reprovação
 * semântica que tinha acabado de rodar 2 ciclos antes para o MESMO arquivo.
 *
 * Causa raiz: `pending_send_verified_on_disk` responde uma pergunta estrutural (arquivo existe,
 * tipo/tamanho esperado) — legítima por determinismo. Mas ARCH-018 foi desenhado para o cenário
 * de goal SEM histórico (arquivo pré-existente, nada rodou ainda) — sem checar se já existia uma
 * reprovação semântica anterior no MESMO goal, o bypass também disparava depois de uma rejeição
 * real, silenciando-a. RESPONSABILIDADE_ANTES_DO_MECANISMO.md: "o artefato satisfaz a intenção do
 * usuário?" é pergunta semântica — não pertence a um checker de disco.
 *
 * Fix: o bypass agora exige `goal.blockers.length === 0`. `goal.blockers` já é a evidência de que
 * algo (nem sempre semântico) reprovou este goal antes — em vez de criar um avaliador novo, o
 * bypass passa a consultar essa evidência que já existe (regra de evidência,
 * RESPONSABILIDADE_ANTES_DO_MECANISMO.md). Qualquer blocker prévio desativa o atalho e cai para o
 * validador LLM normal — mais conservador do que estritamente necessário nos casos raros de
 * blocker não relacionado ao artefato, nunca no sentido de pular uma reprovação real (a mesma
 * assimetria que RESPONSABILIDADE_ANTES_DO_MECANISMO.md descreve em "pré-filtro determinístico —
 * permitido, sob suspeita": o filtro não pode eliminar um caso que o LLM julgaria diferente).
 *
 * S128b.1 — CONTROLE NEGATIVO: cenário ARCH-018 original (goal sem blockers) continua intacto —
 *   o bypass ainda fecha 'met' sem passar pelo LLM. Sem isso, o fix poderia "corrigir demais" e
 *   reabrir o deadlock que o ARCH-018/S128 já tinha fechado.
 * S128b.2 — CASO POSITIVO: goal com 1 blocker prévio (rejeição semântica real, mesmo padrão do
 *   goal_1790086129179_0dv0c) — o bypass NÃO fecha 'met' mais; cai para 'unverifiable', forçando
 *   o validador LLM a rodar de novo em vez de ser pulado.
 * S128b.3 — múltiplos blockers têm o mesmo efeito (não é caso especial de "exatamente 1").
 *
 * Execução: npx ts-node src/__tests__/regression/S128b_ARCH018_BypassRespectsPriorBlocker.test.ts
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';
import { GoalStore } from '../../loop/GoalStore';
import { ToolRegistry } from '../../core/ToolRegistry';
import { Goal, PlanStep, GoalBlocker } from '../../loop/GoalTypes';
import { AUTO_DELIVERY_CRITERION_IDS } from '../../loop/planning/ensureDeliverySuccessCriteria';

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
        sessionKey: 'test:s128b', conversationId: 'test-conv-s128b',
        userIntent: 'resuma minha última conversa sobre física quântica salva na memória',
        objective: 'resuma minha última conversa sobre física quântica salva na memória',
        status: 'executing', attempts: [], blockers: [], toolsTried: [], strategiesTried: [],
        successCriteria: [], sentArtifacts: [], retryBudget: 3, replanBudget: 5, confidence: 0.9,
        requiresAuth: false, authorizationScope: [], expiresAt: Date.now() + 3_600_000,
        ...overrides,
    } as Omit<Goal, 'id' | 'createdAt' | 'updatedAt'>);
}

const CRITERION_ID = AUTO_DELIVERY_CRITERION_IDS.structural_bypass_send_document;

const semanticRejectionBlocker: GoalBlocker = {
    kind: 'semantic_mismatch',
    toolName: 'agentloop',
    description: 'O resumo entregue foi gerado a partir de uma busca na web como medida de contingência, o que significa que o entregável NÃO ATENDE ao requisito de resumir o histórico específico da interação do usuário.',
    detectedAt: Date.now(),
    suggestedActions: [],
};

async function main() {
    console.log('\n=== S128b.1 — CONTROLE NEGATIVO: sem blockers prévios, bypass ARCH-018 continua fechando "met" (comportamento pré-fix preservado) ===');
    {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s128b-test-'));
        const originalWorkspaceDir = process.env.WORKSPACE_DIR;
        process.env.WORKSPACE_DIR = tmpDir;
        try {
            fs.writeFileSync(path.join(tmpDir, 'apresentacao.pptx'), 'x'.repeat(500));
            const { loop, goalStore } = makeLoop();
            const goal = makeGoal(goalStore, {
                blockers: [],
                currentPlan: [
                    { id: 's1', description: 'enviar', toolName: 'send_document', toolArgs: { file_path: 'apresentacao.pptx' }, status: 'pending', fallbackSteps: [] },
                ],
                successCriteria: [
                    { id: CRITERION_ID, description: 'x', check: 'pending_send_verified_on_disk', status: 'pending' },
                ],
            });
            const result = (loop as any).evaluateCriteria(goal);
            const criterion = result.updated.find((c: any) => c.id === CRITERION_ID);
            assert(criterion?.status === 'met', `bypass continua 'met' sem histórico de blocker — obtido: ${criterion?.status}`, criterion);
            assert(result.result === 'all_met', `result === 'all_met' preservado (cenário ARCH-018 original) — obtido: ${result.result}`, result);
        } finally {
            if (originalWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR;
            else process.env.WORKSPACE_DIR = originalWorkspaceDir;
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }

    console.log('\n=== S128b.2 — CASO POSITIVO: com 1 blocker prévio (reprovação semântica real), bypass NÃO fecha mais "met" ===');
    {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s128b-test-'));
        const originalWorkspaceDir = process.env.WORKSPACE_DIR;
        process.env.WORKSPACE_DIR = tmpDir;
        try {
            // Mesmo arquivo que o validador LLM já rejeitou 2 ciclos antes no goal real.
            fs.writeFileSync(path.join(tmpDir, 'resumo_fisica_quantica.txt'), 'x'.repeat(500));
            const { loop, goalStore } = makeLoop();
            const goal = makeGoal(goalStore, {
                blockers: [semanticRejectionBlocker],
                currentPlan: [
                    { id: 's1', description: 'enviar', toolName: 'send_document', toolArgs: { file_path: 'resumo_fisica_quantica.txt' }, status: 'pending', fallbackSteps: [] },
                ],
                successCriteria: [
                    { id: CRITERION_ID, description: 'x', check: 'pending_send_verified_on_disk', status: 'pending' },
                ],
            });
            const result = (loop as any).evaluateCriteria(goal);
            const criterion = result.updated.find((c: any) => c.id === CRITERION_ID);
            assert(
                criterion?.status === 'unverifiable',
                `bypass NÃO fecha 'met' quando há reprovação semântica prévia no goal — obtido: ${criterion?.status}` +
                ` (ANTES do fix: 'met', sobrepondo a reprovação — mesmo padrão do goal_1790086129179_0dv0c)`,
                criterion
            );
            assert(
                result.result !== 'all_met',
                `result !== 'all_met' — goal cai para o validador LLM em vez de fechar completed silenciosamente — obtido: ${result.result}`,
                result
            );
        } finally {
            if (originalWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR;
            else process.env.WORKSPACE_DIR = originalWorkspaceDir;
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }

    console.log('\n=== S128b.3 — múltiplos blockers prévios têm o mesmo efeito (não é caso especial de "exatamente 1") ===');
    {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newclaw-s128b-test-'));
        const originalWorkspaceDir = process.env.WORKSPACE_DIR;
        process.env.WORKSPACE_DIR = tmpDir;
        try {
            fs.writeFileSync(path.join(tmpDir, 'resumo.txt'), 'x'.repeat(500));
            const { loop, goalStore } = makeLoop();
            const goal = makeGoal(goalStore, {
                blockers: [
                    { kind: 'tool_error', toolName: 'memory_search', description: 'Nenhum resultado encontrado.', detectedAt: Date.now() - 2000, suggestedActions: [] },
                    semanticRejectionBlocker,
                ],
                currentPlan: [
                    { id: 's1', description: 'enviar', toolName: 'send_document', toolArgs: { file_path: 'resumo.txt' }, status: 'pending', fallbackSteps: [] },
                ],
                successCriteria: [
                    { id: CRITERION_ID, description: 'x', check: 'pending_send_verified_on_disk', status: 'pending' },
                ],
            });
            const result = (loop as any).evaluateCriteria(goal);
            const criterion = result.updated.find((c: any) => c.id === CRITERION_ID);
            assert(criterion?.status === 'unverifiable', `bypass desativado com 2 blockers prévios — obtido: ${criterion?.status}`, criterion);
        } finally {
            if (originalWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR;
            else process.env.WORKSPACE_DIR = originalWorkspaceDir;
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S128b RESULTADO: ${passed} passou | ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('ERRO NÃO TRATADO:', err); process.exit(1); });
