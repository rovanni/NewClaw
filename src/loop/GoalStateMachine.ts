/**
 * GoalStateMachine — Máquina de estados formal para o ciclo de vida de goals.
 *
 * Centraliza as transições válidas de estado. Cada transição é validada e
 * logada, facilitando auditoria e debug de comportamento inesperado.
 *
 * Filosofia: não lança exceção em transição inválida (não quebra produção),
 * mas loga um warning que aparece nos traces do GoalOrchestrator.
 */

import { createLogger } from '../shared/AppLogger';
import { GoalStatus } from './GoalTypes';

const log = createLogger('GoalFSM');

// ── Definição de transições válidas ──────────────────────────────────────────

interface Transition {
    from: GoalStatus | '*';  // '*' = qualquer estado de origem
    to: GoalStatus;
    trigger: string;
}

const VALID_TRANSITIONS: Transition[] = [
    // Início de execução
    { from: 'active',     to: 'executing',  trigger: 'start_execution'         },
    { from: 'active',     to: 'failed',     trigger: 'immediate_failure'        },
    { from: 'active',     to: 'abandoned',  trigger: 'user_cancel'              },

    // Execução → bloqueios e replanning
    { from: 'executing',  to: 'replanning', trigger: 'blocker_detected'         },
    { from: 'executing',  to: 'blocked',    trigger: 'auth_required'            },
    { from: 'executing',  to: 'completed',  trigger: 'goal_achieved'            },
    { from: 'executing',  to: 'failed',     trigger: 'budget_exhausted'         },
    { from: 'executing',  to: 'abandoned',  trigger: 'ttl_expired'              },

    // Replanning → voltar para execução ou falhar
    { from: 'replanning', to: 'executing',  trigger: 'replan_ready'             },
    { from: 'replanning', to: 'failed',     trigger: 'replan_budget_exhausted'  },
    { from: 'replanning', to: 'abandoned',  trigger: 'ttl_expired'              },

    // Blocked (auth pendente) → retomada ou abandono
    { from: 'blocked',    to: 'executing',  trigger: 'auth_approved'            },
    { from: 'blocked',    to: 'abandoned',  trigger: 'auth_timeout'             },
    { from: 'blocked',    to: 'abandoned',  trigger: 'superseded'               },

    // Qualquer estado → abandoned (novo goal criado, TTL, cancelamento forçado)
    { from: '*',          to: 'abandoned',  trigger: 'new_goal_created'         },
    { from: '*',          to: 'abandoned',  trigger: 'forced_abandon'           },
];

// ── GoalStateMachine ─────────────────────────────────────────────────────────

export class GoalStateMachine {

    /**
     * Registra e valida uma transição de estado.
     * Não lança exceção — loga warning se a transição for inválida.
     *
     * @param goalId  ID do goal (para rastreabilidade nos logs)
     * @param from    Estado atual
     * @param to      Estado de destino
     * @param trigger Nome do evento que disparou a transição
     */
    static transition(goalId: string, from: GoalStatus, to: GoalStatus, trigger: string): boolean {
        const valid = VALID_TRANSITIONS.some(t =>
            (t.from === '*' || t.from === from) && t.to === to
        );

        if (!valid) {
            log.warn(`[GoalFSM] transição inválida goal=${goalId}: ${from} --${trigger}--> ${to}`);
            return false;
        }

        log.info(`[GoalFSM] goal=${goalId} ${from} --${trigger}--> ${to}`);
        return true;
    }

    /**
     * Verifica se uma transição seria válida sem executá-la.
     */
    static canTransition(from: GoalStatus, to: GoalStatus): boolean {
        return VALID_TRANSITIONS.some(t =>
            (t.from === '*' || t.from === from) && t.to === to
        );
    }

    /**
     * Retorna todos os estados para os quais é possível transicionar a partir de `from`.
     */
    static nextStates(from: GoalStatus): GoalStatus[] {
        const states = VALID_TRANSITIONS
            .filter(t => t.from === '*' || t.from === from)
            .map(t => t.to);
        return [...new Set(states)];
    }

    /**
     * Retorna as transições possíveis a partir de um estado, com seus triggers.
     */
    static availableTransitions(from: GoalStatus): { to: GoalStatus; trigger: string }[] {
        return VALID_TRANSITIONS
            .filter(t => t.from === '*' || t.from === from)
            .map(t => ({ to: t.to, trigger: t.trigger }));
    }
}
