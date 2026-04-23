import { AgentState } from '../core/AgentStateManager';
import { ValidationResult } from './ContextValidator';

/**
 * DecisionPostProcessor — Modulates the LLM response based on cognitive state.
 * Never rewrites completely, only adjusts tone and proactivity.
 */
export class DecisionPostProcessor {
    process(response: string, state: AgentState, validation: ValidationResult): string {
        let modulated = response;
        let changeCount = 0;
        const maxChanges = 2;

        // 0. Detect if response is already softened/cautious
        const lowConfidencePatterns = /acredito|talvez|pode ser|provavelmente|não tenho certeza|segundo o que lembro/i;
        const isAlreadySoftened = lowConfidencePatterns.test(response);

        // 1. Assertiveness Modulation
        if (validation.recommendation === 'cautious' && !isAlreadySoftened && changeCount < maxChanges) {
            const original = modulated;
            // Soften strong claims (selective)
            modulated = modulated
                .replace(/Certamente,|Com certeza,|Garanto que/g, 'Pode ser que')
                .replace(/é fundamental/g, 'possa ser útil');
            
            if (modulated !== original) changeCount++;
            
            // Add a prefix only if necessary and still space for changes
            if (changeCount < maxChanges && modulated.length > 40 && !modulated.toLowerCase().includes('recuperar')) {
                const prefix = "Pelo que consegui verificar, ";
                modulated = prefix + modulated.charAt(0).toLowerCase() + modulated.slice(1);
                changeCount++;
            }
        }

        // 2. Proactivity Modulation
        if (state.meta.stability < 0.4 && changeCount < maxChanges) {
            const original = modulated;
            // Reduce proactive suggestions if state is very unstable
            modulated = modulated.replace(/Além disso, (posso|poderia).*|Também posso.*|Que tal se.*/gi, '').trim();
            if (modulated !== original) changeCount++;
        }

        // 3. Drift Compensation (Only if critical)
        if (state.meta.drift_risk > 0.8 && !modulated.includes('?') && changeCount < maxChanges) {
            modulated += "\n\nFez sentido?";
            changeCount++;
        }

        // 4. Confidence-based sign-off (Hard floor)
        if (state.confidence < 0.2 && !isAlreadySoftened && changeCount < maxChanges) {
            modulated += " (Nota: Confiança reduzida por inconsistência de dados).";
            changeCount++;
        }

        return modulated;
    }
}
