/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S155
 *
 * Achado real (Dashboard web, 26/07/2026): não existia NENHUMA forma de interromper um Goal
 * em andamento no chat do Dashboard (um Goal pode legitimamente levar vários minutos — ver
 * S14/S34/PromptComposer, mesma investigação). Telegram/Discord/WhatsApp/Signal já tinham
 * `/cancelar` funcionando (MessageBus.registerPriorityCommand, canal-agnóstico), mas com uma
 * lacuna: `AgentLoop.cancel()` sozinho só aborta a chamada de LLM/tool EM CURSO — se ela
 * pertence a um step de Goal, o GoalExecutionLoop podia tratar o abort como falha comum de
 * step e replanejar/continuar o MESMO goal, tornando "⏹ Operação cancelada." uma mensagem
 * enganosa. O checkpoint que realmente encerra o loop (goal.status==='abandoned', entre ciclos
 * em GoalExecutionLoop.ts) já existia, mas só era acionado quando uma NOVA mensagem substituía
 * o goal anterior — nunca por um cancelamento explícito.
 *
 * Fix: GoalOrchestrator.cancelActiveGoal(channel, userId) marca o goal ativo da sessão como
 * 'abandoned' (reutilizando o checkpoint já existente) e registra o motivo real via
 * GoalStore.markAbandonReason()/consumeAbandonReason() — um cache efêmero em memória (mesma
 * natureza de GoalOrchestrator.recentCompletedGoals) que evita que o usuário veja a mensagem
 * fixa "nova mensagem do usuário recebida" quando na verdade cancelou explicitamente.
 *
 * GoalOrchestrator é pesado para instanciar diretamente em teste unitário (constructor cria
 * ReflectionMemory/CaseMemory/OperationalKnowledge/GoalExecutionLoop e dispara
 * CapabilityRegistry.bootstrap() em background) — por isso este teste cobre:
 *   1-4  → GoalStore.markAbandonReason()/consumeAbandonReason() (comportamento real, DB em memória)
 *   5-7  → inspeção de source: GoalOrchestrator.cancelActiveGoal() existe e chama
 *          markAbandonReason() ANTES de setStatus(..., 'abandoned'); retorna null quando não
 *          há goal ativo
 *   8    → inspeção de source: GoalExecutionLoop.ts consome o motivo via consumeAbandonReason()
 *          antes de cair no texto genérico fixo
 *   9-10 → inspeção de source: agentControllerCommands.ts chama tanto agentLoop.cancel() quanto
 *          goalOrchestrator.cancelActiveGoal() no mesmo handler de /cancelar
 *
 * Execução: npx ts-node src/__tests__/regression/S155_GoalCancellation_ExplicitAbandonReason.test.ts
 */

process.env.WORKSPACE_DIR = process.env.WORKSPACE_DIR || 'D:/IA/newclaw/workspace';

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { GoalStore } from '../../loop/GoalStore';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${msg}`, detail ?? ''); failed++; }
}

function makeGoalInput(overrides: Record<string, unknown> = {}) {
    return {
        sessionKey: 'web:conv-s155',
        conversationId: 'conv-s155',
        userIntent: 'Gerar apresentação',
        objective: 'Gerar apresentação em pptx',
        status: 'active',
        currentPlan: [],
        attempts: [],
        blockers: [],
        toolsTried: [],
        strategiesTried: [],
        nextAction: null,
        cycleFocus: null,
        retryBudget: 5,
        replanBudget: 3,
        confidence: 0.85,
        requiresAuth: false,
        authorizationScope: [],
        pendingTxnId: null,
        expiresAt: Date.now() + 600_000,
        completedAt: null,
        isConstruction: false,
        roadmap: [],
        currentMilestoneIndex: 0,
        allowRoadmapAdjustment: true,
        successCriteria: [],
        sentArtifacts: [],
        ...overrides,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
}

async function main() {
    console.log('\n=== S155 — GoalStore.markAbandonReason()/consumeAbandonReason() ===');
    {
        const db = new Database(':memory:');
        const goalStore = new GoalStore(db as any);
        const goal = goalStore.create(makeGoalInput());

        // 1: sem motivo registrado, consumeAbandonReason() retorna undefined.
        assert(goalStore.consumeAbandonReason(goal.id) === undefined, 'sem markAbandonReason() prévio, consumeAbandonReason() retorna undefined');

        // 2: motivo registrado é devolvido por consumeAbandonReason().
        goalStore.markAbandonReason(goal.id, 'Goal interrompido: cancelado explicitamente pelo usuário.');
        const reason = goalStore.consumeAbandonReason(goal.id);
        assert(reason === 'Goal interrompido: cancelado explicitamente pelo usuário.', 'consumeAbandonReason() devolve o motivo exato registrado', reason);

        // 3: consumir é destrutivo — uma segunda chamada não deve "vazar" o mesmo motivo.
        assert(goalStore.consumeAbandonReason(goal.id) === undefined, 'consumeAbandonReason() é consumido uma única vez (não vaza para abandono futuro)');

        // 4: motivos de goals diferentes não se misturam.
        const goal2 = goalStore.create(makeGoalInput({ conversationId: 'conv-s155-b', sessionKey: 'web:conv-s155-b' }));
        goalStore.markAbandonReason(goal.id, 'motivo do goal 1');
        goalStore.markAbandonReason(goal2.id, 'motivo do goal 2');
        assert(goalStore.consumeAbandonReason(goal.id) === 'motivo do goal 1', 'motivo de goal A não vaza para goal B (A)');
        assert(goalStore.consumeAbandonReason(goal2.id) === 'motivo do goal 2', 'motivo de goal A não vaza para goal B (B)');
    }

    console.log('\n=== S155 — reprodução do fluxo real: cancelActiveGoal() aciona o checkpoint com o motivo certo ===');
    {
        const db = new Database(':memory:');
        const goalStore = new GoalStore(db as any);
        const goal = goalStore.create(makeGoalInput());

        // Replica exatamente a sequência de GoalOrchestrator.cancelActiveGoal(): registrar o
        // motivo ANTES de mudar o status (a ordem importa — setStatus não pode disparar o
        // checkpoint de GoalExecutionLoop antes do motivo existir).
        goalStore.markAbandonReason(goal.id, 'Goal interrompido: cancelado explicitamente pelo usuário.');
        goalStore.setStatus(goal.id, 'abandoned');

        const reloaded = goalStore.getById(goal.id)!;
        assert(reloaded.status === 'abandoned', 'goal transiciona para abandoned');

        // Replica exatamente o checkpoint de GoalExecutionLoop.ts (linha ~1519).
        const abandonReason = goalStore.consumeAbandonReason(reloaded.id)
            ?? 'Goal interrompido: nova mensagem do usuário recebida durante execução.';
        assert(
            abandonReason === 'Goal interrompido: cancelado explicitamente pelo usuário.',
            'checkpoint usa o motivo real de cancelamento, NÃO a mensagem genérica de "nova mensagem"',
            abandonReason
        );
    }

    console.log('\n=== S155 — sem motivo registrado (ex: abandono por nova mensagem), cai no texto genérico ===');
    {
        const db = new Database(':memory:');
        const goalStore = new GoalStore(db as any);
        const goal = goalStore.create(makeGoalInput());

        // Simula o caminho ORIGINAL (GoalOrchestrator.process(), linha ~434): abandona sem
        // nunca chamar markAbandonReason() — comportamento pré-existente, não deve mudar.
        goalStore.setStatus(goal.id, 'abandoned');
        const abandonReason = goalStore.consumeAbandonReason(goal.id)
            ?? 'Goal interrompido: nova mensagem do usuário recebida durante execução.';
        assert(
            abandonReason === 'Goal interrompido: nova mensagem do usuário recebida durante execução.',
            'sem motivo explícito registrado, mantém a mensagem genérica original (sem regressão)',
            abandonReason
        );
    }

    console.log('\n=== S155 — inspeção de source: GoalOrchestrator.cancelActiveGoal() ===');
    {
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalOrchestrator.ts'), 'utf-8');
        assert(/cancelActiveGoal\(channel: string, userId: string\): Goal \| null/.test(src), 'método cancelActiveGoal(channel, userId) existe com a assinatura esperada');
        assert(/getActiveBySession\(sessionKey\)/.test(src), 'usa getActiveBySession() para achar o goal ativo da sessão (mesmo mecanismo do abandono por nova mensagem)');

        const markIdx = src.indexOf('this.goalStore.markAbandonReason(goal.id,');
        const setStatusIdx = src.indexOf("this.goalStore.setStatus(goal.id, 'abandoned');", markIdx);
        assert(markIdx > 0 && setStatusIdx > markIdx, 'markAbandonReason() é chamado ANTES de setStatus(..., "abandoned") — ordem importa para o checkpoint ver o motivo', { markIdx, setStatusIdx });

        assert(/if \(!goal \|\| \['completed', 'failed', 'abandoned'\]\.includes\(goal\.status\)\) return null;/.test(src), 'retorna null quando não há goal ativo (diferencia "cancelei algo" de "nada rodando")');
    }

    console.log('\n=== S155 — inspeção de source: checkpoint em GoalExecutionLoop.ts consome o motivo real ===');
    {
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalExecutionLoop.ts'), 'utf-8');
        assert(/this\.goalStore\.consumeAbandonReason\(goal\.id\)/.test(src), 'checkpoint chama consumeAbandonReason() antes de decidir a mensagem final');
        const consumeIdx = src.indexOf('this.goalStore.consumeAbandonReason(goal.id)');
        const fallbackIdx = src.indexOf("'Goal interrompido: nova mensagem do usuário recebida durante execução.'");
        assert(consumeIdx > 0 && fallbackIdx > consumeIdx, 'texto genérico permanece como fallback (??), não como única opção — sem regressão do caminho antigo', { consumeIdx, fallbackIdx });
    }

    console.log('\n=== S155 — inspeção de source: /cancelar aciona TANTO agentLoop.cancel() QUANTO cancelActiveGoal() ===');
    {
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'agentControllerCommands.ts'), 'utf-8');
        assert(/agentLoop\.cancel\(msg\.userId\)/.test(src), 'ainda aborta a chamada de LLM/tool em curso (comportamento original preservado)');
        assert(/goalOrchestrator\.cancelActiveGoal\(msg\.channel, msg\.userId\)/.test(src), 'NOVO: também marca o goal ativo da sessão como abandonado');
        assert(/goalOrchestrator: GoalOrchestrator/.test(src), 'registerCommands() recebe goalOrchestrator como parâmetro tipado');
    }

    console.log('\n=== S155 — inspeção de source: AgentController injeta this.goalOrchestrator em registerCommands() ===');
    {
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'core', 'AgentController.ts'), 'utf-8');
        assert(/registerCommands\([^)]*this\.goalOrchestrator\)/.test(src), 'call site atualizado para passar this.goalOrchestrator');
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S155 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
    console.error('S155 erro inesperado:', err);
    process.exitCode = 1;
});
