/**
 * CognitiveKernelGate — ponto único de integração entre o NewClaw e o Cognitive Kernel
 * (via `newclaw-kernel-adapter`). Chamado por GoalOrchestrator logo após um Goal ser
 * criado e antes de `GoalExecutionLoop.executeGoal()` — o único instante em que o Goal
 * já existe (tem id/status) mas ainda não foi executado.
 *
 * Kill-switch: COGNITIVE_KERNEL_ENABLED=false (default) — nenhuma chamada ao Kernel
 * acontece, comportamento idêntico ao de hoje. CircuitBreaker: qualquer exceção (Kernel
 * quebrado, dependência ausente) sempre cai em `{action:'proceed'}` — o Kernel nunca
 * pode travar um Goal real por estar indisponível.
 *
 * COGNITIVE_KERNEL_APPLY_DECISION=false (default) — incidente real (2026-07-31): DEFER e
 * REQUEST_MORE_INFO, do jeito que GoalOrchestrator os aplica (abandona o goal e espera a
 * próxima mensagem reclassificar do zero), reentram no MESMO estado sempre — um goal
 * recém-criado nunca acumula blocker/histórico entre tentativas, então o Kernel decide
 * DEFER de novo indefinidamente (loop real, visto em produção). Com a flag desligada, o
 * Kernel roda e loga a decisão (comparável ao modo sombra batch já existente), mas o
 * `GateResult` retornado é sempre `{action:'proceed'}` — só `EXECUTE` (que já era um no-op)
 * é "real" por enquanto. Ligar exige recalibração de DEFER/REQUEST_MORE_INFO/ESCALATE
 * para o caso "goal recém-criado, sem histórico" — o mais comum na prática.
 */

import { createLogger } from '../shared/AppLogger';
import { circuitRegistry } from '../core/CircuitBreaker';
import type { GoalStore } from './GoalStore';
import type { Goal } from './GoalTypes';
import { goalAdapter, goalKernelInstance } from 'newclaw-kernel-adapter';
import type { GoalLike, EfeitoSobreGoal } from 'newclaw-kernel-adapter';

const log = createLogger('CognitiveKernelGate');

/** Lido uma única vez no load do módulo — mesmo padrão de PermissionRegistry/CAPABILITY_MODE. */
const ENABLED = process.env.COGNITIVE_KERNEL_ENABLED === 'true';
/** Ver nota de incidente acima — default false: Kernel roda e loga, mas nunca muda o
 * comportamento além do que EXECUTE (no-op) já faria. */
const APPLY_DECISION = process.env.COGNITIVE_KERNEL_APPLY_DECISION === 'true';

const breaker = circuitRegistry.getOrCreate({
    name: 'cognitive-kernel',
    failureThreshold: 5,
    resetTimeoutMs: 30_000,
    successThreshold: 3,
});

/** Prefixo próprio para distinguir um `pendingTxnId` gerado por este gate de um txnId real
 * de autorização de ferramenta (WorkflowEngine) — ver branch em GoalOrchestrator.process(). */
export const KERNEL_ESCALATION_PREFIX = 'kernel-escalate:';

export type GateResult =
    | { action: 'proceed' }
    | { action: 'ask_info'; message: string }
    | { action: 'defer'; message: string }
    | { action: 'escalate'; message: string; authOptions: { label: string; value: string }[] };

function toGoalLike(goal: Goal, precedente: { completados: number; terminais: number }): GoalLike {
    return {
        goalId: goal.id,
        sessionKey: goal.sessionKey,
        conversationId: goal.conversationId,
        userIntent: goal.userIntent,
        objective: goal.objective,
        status: goal.status,
        context: {
            planStepCount: goal.currentPlan.length,
            toolsTried: goal.toolsTried,
            strategiesTried: goal.strategiesTried,
            successCriteriaCount: goal.successCriteria.length,
            isConstruction: goal.isConstruction ?? false,
            blockersCount: goal.blockers.length,
        },
        priority: {
            requiresAuth: goal.requiresAuth,
            pendingTxnId: goal.pendingTxnId ?? null,
            retryBudget: goal.retryBudget,
            replanBudget: goal.replanBudget,
            confidence: goal.confidence,
        },
        metadata: {
            createdAt: goal.createdAt,
            updatedAt: goal.updatedAt,
            expiresAt: goal.expiresAt,
            completedAt: goal.completedAt ?? null,
        },
        precedente,
    };
}

/** Avalia um Goal recém-criado contra o Cognitive Kernel. Nunca lança — qualquer falha
 * (flag desligada, circuito aberto, exceção do Kernel) resulta em `{action:'proceed'}`. */
export async function avaliarGoal(goal: Goal, goalStore: GoalStore): Promise<GateResult> {
    if (!ENABLED) return { action: 'proceed' };

    if (!breaker.canExecute()) {
        log.warn(`[COGNITIVE-KERNEL] goal=${goal.id} circuito aberto — prosseguindo sem o Kernel`);
        return { action: 'proceed' };
    }

    try {
        const precedente = goalStore.getPrecedentStats(goal.sessionKey, goal.createdAt);
        const envelope = goalAdapter.paraEnvelope(toGoalLike(goal, precedente));
        const decisao = goalKernelInstance.process(envelope);
        // paraDominio() retorna `unknown` no contrato genérico do kernel-sdk por design
        // (mesma opacidade de Decision.trilha) — EfeitoSobreGoal é a forma concreta que
        // SÓ este Adapter conhece; nenhum outro consumidor no projeto ainda precisava
        // estreitar este tipo antes deste gate.
        const efeito = goalAdapter.paraDominio(decisao) as EfeitoSobreGoal;
        breaker.recordSuccess();

        log.info(`[COGNITIVE-KERNEL] goal=${goal.id} decision=${decisao.tipo} efeito=${efeito.acao} apply=${APPLY_DECISION}`);

        if (!APPLY_DECISION) {
            // Modo sombra em processo: loga a decisão real do Kernel para comparação, mas
            // nunca muda o comportamento (ver nota de incidente no topo do arquivo).
            return { action: 'proceed' };
        }

        switch (efeito.acao) {
            case 'executar':
                return { action: 'proceed' };
            case 'pedir_mais_informacao':
                return {
                    action: 'ask_info',
                    message: 'Para ajudar melhor, pode dar mais detalhes sobre o que precisa exatamente?',
                };
            case 'aguardar':
                return {
                    action: 'defer',
                    message: 'Vou aguardar mais contexto antes de agir nisso — me avise quando quiser que eu prossiga.',
                };
            case 'escalar':
                return {
                    action: 'escalate',
                    message: 'Isso parece exigir mais cautela antes de eu prosseguir. Posso continuar?',
                    authOptions: [
                        { label: 'Sim, pode prosseguir', value: 'sim' },
                        { label: 'Não, cancelar', value: 'não' },
                    ],
                };
        }
        return { action: 'proceed' };
    } catch (err) {
        breaker.recordFailure(err instanceof Error ? err.message : String(err));
        log.warn(`[COGNITIVE-KERNEL] goal=${goal.id} falhou — prosseguindo sem o Kernel: ${err instanceof Error ? err.message : String(err)}`);
        return { action: 'proceed' };
    }
}
