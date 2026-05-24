/**
 * GoalContextualizer — Quadrante 1 do Modelo Espiral.
 *
 * Responsabilidade: enriquecer o entendimento do objetivo antes de cada ciclo
 * de planejamento, consultando memória semântica e padrões de reflexão.
 *
 * Fluxo por ciclo:
 *   1. Busca memória semântica relevante ao objetivo do usuário
 *   2. Recupera padrões de falha conhecidos (ReflectionMemory)
 *   3. Incorpora feedback do ciclo anterior (Q4 → Q1) quando disponível
 *
 * Output: contexto textual injetado no GoalPlanner antes do planejamento.
 */

import { createLogger } from '../shared/AppLogger';
import { ReflectionMemory } from '../memory/ReflectionMemory';
import { MemoryManager } from '../memory/MemoryManager';
import { Goal } from './GoalTypes';

const log = createLogger('GoalContextualizer');

export class GoalContextualizer {
    constructor(
        private readonly memory: MemoryManager,
        private readonly reflectionMemory: ReflectionMemory,
    ) {}

    /**
     * Produz contexto enriquecido para o planejador.
     *
     * @param goal         - Goal atual
     * @param cycleNumber  - Número do ciclo espiral (1-based)
     * @param priorFeedback - Reason do Q4 do ciclo anterior (undefined no 1º ciclo)
     */
    async contextualize(goal: Goal, cycleNumber: number, priorFeedback?: string): Promise<string> {
        const parts: string[] = [];

        // ── 1. Memória semântica ──────────────────────────────────────────────
        try {
            const nodes = await this.memory.semanticSearch(goal.userIntent, 3);
            const relevant = nodes.filter(n => n.content && n.content.trim().length > 10);
            if (relevant.length > 0) {
                const lines = relevant.map(n => `- [${n.type}] ${String(n.content).slice(0, 150)}`);
                parts.push(`Contexto da memória (relevante ao objetivo):\n${lines.join('\n')}`);
            }
        } catch (err) {
            log.warn('[GoalContextualizer] memory search error:', String(err));
        }

        // ── 2. Padrões de falha conhecidos (tools já tentadas) ───────────────
        const failureHints = goal.toolsTried
            .map(t => this.reflectionMemory.buildContextHint(`tool_${t}`))
            .filter(Boolean);
        if (failureHints.length > 0) {
            parts.push(`Histórico de execuções com ferramentas já usadas:\n${failureHints.join('\n')}`);
        }

        // ── 3. Feedback do ciclo anterior (Q4 → Q1) ──────────────────────────
        if (priorFeedback && cycleNumber > 1) {
            parts.push(
                `Análise do ciclo ${cycleNumber - 1} (o que não funcionou):\n` +
                `${priorFeedback}\n` +
                `→ Ajuste a estratégia para resolver especificamente este problema.`
            );
        }

        const context = parts.join('\n\n');
        if (context) {
            log.info(`[GoalContextualizer] cycle=${cycleNumber} context_len=${context.length}`);
        } else {
            log.debug(`[GoalContextualizer] cycle=${cycleNumber} no additional context`);
        }
        return context;
    }
}
