import { AgentState } from '../core/AgentStateManager';
import { ValidationResult } from './ContextValidator';

/**
 * DecisionPostProcessor — Modulates the LLM response based on cognitive state.
 * Never rewrites completely, only adjusts tone and proactivity.
 */
export class DecisionPostProcessor {
    process(response: string, state: AgentState, validation: ValidationResult): string {
        let modulated = response;

        // 1. Assertiveness Modulation
        if (validation.recommendation === 'cautious') {
            // Soften strong claims
            modulated = modulated
                .replace(/Certamente,|Com certeza,|Garanto que/g, 'Pode ser que')
                .replace(/Com certeza/g, 'Provavelmente')
                .replace(/é fundamental/g, 'possa ser útil')
                .replace(/sempre/g, 'geralmente');
            
            // Add a prefix if too blunt and not already cautious
            if (!modulated.toLowerCase().includes('acredito') && !modulated.toLowerCase().includes('talvez') && modulated.length > 30) {
                const prefix = "Com base no que consegui recuperar, ";
                modulated = prefix + modulated.charAt(0).toLowerCase() + modulated.slice(1);
            }
        }

        // 2. Proactivity Modulation
        if (state.meta.stability < 0.5) {
            // Reduce proactive suggestions if state is unstable
            modulated = modulated.replace(/Além disso, (posso|poderia).*|Também posso.*|Que tal se.*/gi, '').trim();
        }

        // 3. Drift Compensation
        if (state.meta.drift_risk > 0.7 && !modulated.includes('?')) {
            modulated += "\n\nIsso está de acordo com o que você esperava?";
        }

        // 4. Confidence-based sign-off
        if (state.confidence < 0.25 && !modulated.includes('não tenho certeza')) {
            modulated += " (Nota: Minha confiança nesta resposta está baixa devido a inconsistências no contexto).";
        }

        return modulated;
    }
}
