/**
 * StrategyDiversityGuard — Evita que replans repitam estratégias já tentadas.
 *
 * Problema: quando o GoalPlanner.replan() falha repetidamente, o LLM frequentemente
 * gera planos com a mesma sequência de tools, desperdiçando o replanBudget sem
 * progresso real.
 *
 * Solução:
 * - Fingerprinta cada plano pela sua sequência canônica de tools
 *   (ex: "web_search→agentloop→send_document")
 * - Detecta quando um novo plano é estruturalmente equivalente a planos anteriores
 * - Injeta uma seção "RESTRIÇÕES DE DIVERSIDADE" no prompt de replan com:
 *   (a) fingerprints já usados, (b) tools esgotadas, (c) sugestão de abordagem nova
 */

import { createLogger } from '../shared/AppLogger';
import { Goal, PlanStep } from './GoalTypes';

const log = createLogger('StrategyDiversityGuard');

export interface DiversityConstraints {
    /** Fingerprints de planos já tentados */
    forbiddenFingerprints: string[];
    /** Tools que falharam em ≥2 tentativas para este goal */
    exhaustedTools: string[];
    /** Sugestão de abordagem diversa */
    diversitySuggestion: string;
    /** Bloco formatado para injeção no prompt de replan */
    promptBlock: string;
}

const TOOL_ALTERNATIVES: Record<string, string> = {
    web_search:      'tente web_navigate para acessar diretamente a URL de uma fonte conhecida',
    crypto_analysis: 'tente web_search ou web_navigate em CoinGecko/CoinMarketCap diretamente',
    memory_search:   'tente web_search ou api_request para buscar os dados externamente',
    exec_command:    'tente uma abordagem via script Python inline ou ferramenta diferente',
    agentloop:       'deponha o step em tools específicas em vez de delegar ao agentloop',
};

export class StrategyDiversityGuard {
    /**
     * Gera fingerprint canônico de um plano pela sequência de tools.
     * Ex: ["web_search", "agentloop", "send_document"] → "web_search→agentloop→send_document"
     */
    static fingerprint(steps: PlanStep[]): string {
        return steps.map(s => s.toolName ?? 'agentloop').join('→');
    }

    /**
     * Extrai todas as fingerprints de planos já tentados pelo goal.
     */
    static extractUsedFingerprints(goal: Goal): string[] {
        const fingerprints = new Set<string>();

        if (goal.currentPlan.length > 0) {
            fingerprints.add(StrategyDiversityGuard.fingerprint(goal.currentPlan));
        }

        // Extrai fingerprints implícitas das strategiesTried (cadeias de tools mencionadas)
        for (const strategy of goal.strategiesTried) {
            const toolMatch = strategy.match(
                /\b(web_search|crypto_analysis|memory_search|agentloop|exec_command|write|read|send_document|web_navigate|api_request|edit|list_workspace)\b/g
            );
            if (toolMatch && toolMatch.length >= 2) {
                fingerprints.add(toolMatch.join('→'));
            }
        }

        return Array.from(fingerprints);
    }

    /**
     * Identifica tools que falharam em ≥2 tentativas para este goal.
     */
    static extractExhaustedTools(goal: Goal): string[] {
        const failCounts = new Map<string, number>();
        for (const attempt of goal.attempts) {
            if (attempt.result === 'failure') {
                failCounts.set(attempt.toolName, (failCounts.get(attempt.toolName) ?? 0) + 1);
            }
        }
        return Array.from(failCounts.entries())
            .filter(([, count]) => count >= 2)
            .map(([tool]) => tool);
    }

    /**
     * Verifica se um novo plano proposto é diverso dos planos anteriores.
     * Retorna true se o plano é diverso (deve ser usado), false se é repetição.
     */
    static isDiverse(newPlan: PlanStep[], goal: Goal): boolean {
        const newFp = StrategyDiversityGuard.fingerprint(newPlan);
        const usedFps = StrategyDiversityGuard.extractUsedFingerprints(goal);

        if (usedFps.includes(newFp)) {
            log.warn(
                `[StrategyDiversityGuard] duplicate fingerprint: goal=${goal.id}` +
                ` fingerprint="${newFp}"`
            );
            return false;
        }
        return true;
    }

    /**
     * Gera o bloco de constraints de diversidade para injeção no prompt de replan.
     */
    static buildConstraints(goal: Goal): DiversityConstraints {
        const forbiddenFingerprints = StrategyDiversityGuard.extractUsedFingerprints(goal);
        const exhaustedTools = StrategyDiversityGuard.extractExhaustedTools(goal);
        const diversitySuggestion = StrategyDiversityGuard.buildSuggestion(exhaustedTools, forbiddenFingerprints);

        const lines: string[] = [];
        lines.push('⚠️  RESTRIÇÕES DE DIVERSIDADE — leia antes de planejar:');

        if (forbiddenFingerprints.length > 0) {
            lines.push('');
            lines.push('SEQUÊNCIAS DE TOOLS JÁ TENTADAS (NÃO repita):');
            for (const fp of forbiddenFingerprints) {
                lines.push(`  ✗ ${fp}`);
            }
        }

        if (exhaustedTools.length > 0) {
            lines.push('');
            lines.push('TOOLS ESGOTADAS (falharam ≥2x — evite como step inicial):');
            lines.push(`  ${exhaustedTools.join(', ')}`);
        }

        if (diversitySuggestion) {
            lines.push('');
            lines.push(`SUGESTÃO: ${diversitySuggestion}`);
        }

        lines.push('');
        lines.push('REGRA: o novo plano DEVE ter uma sequência de tools DIFERENTE de todas listadas acima.');

        return {
            forbiddenFingerprints,
            exhaustedTools,
            diversitySuggestion,
            promptBlock: lines.join('\n'),
        };
    }

    private static buildSuggestion(exhaustedTools: string[], usedFingerprints: string[]): string {
        const allUsedTools = new Set(usedFingerprints.flatMap(fp => fp.split('→')));

        for (const [tool, suggestion] of Object.entries(TOOL_ALTERNATIVES)) {
            if (exhaustedTools.includes(tool) || allUsedTools.has(tool)) {
                return suggestion;
            }
        }

        return 'use uma abordagem completamente diferente das listadas acima';
    }
}
