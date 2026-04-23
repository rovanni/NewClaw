import { AgentState } from '../core/AgentStateManager';

export interface ValidationResult {
    quality: number; // 0.0 to 1.0
    hasConflict: boolean;
    recommendation: 'assertive' | 'neutral' | 'cautious';
}

/**
 * ContextValidator — Assesses the quality and reliability of the current context.
 */
export class ContextValidator {
    validate(userText: string, context: string, state: AgentState): ValidationResult {
        let quality = 1.0;
        let hasConflict = false;

        // 1. Density Check (Normalized)
        if (context.length < 30) {
            quality -= 0.3; // Noise floor
        } else if (context.length < 150) {
            quality -= 0.1;
        }

        // 2. Metadata Check (High Thresholds)
        if (state.meta.drift_risk > 0.8) { // Only penalize high drift
            quality -= 0.2;
        }
        if (state.meta.stability < 0.3) {
            quality -= 0.1;
        }

        // 3. Simple Conflict Detection
        const lines = context.split('\n').filter(l => l.trim().length > 10);
        const subjects = new Map<string, string>();
        for (const line of lines) {
            if (line.includes(':')) {
                const parts = line.split(':');
                const subject = parts[0].trim().toLowerCase();
                const value = parts.slice(1).join(':').trim().toLowerCase();
                
                if (subjects.has(subject) && subjects.get(subject) !== value) {
                    hasConflict = true;
                    quality -= 0.4;
                    break;
                }
                subjects.set(subject, value);
            }
        }

        // 4. Recommendation Logic (Balanced Thresholds)
        let recommendation: ValidationResult['recommendation'] = 'assertive';
        
        // Thresholds: Assertive > 0.8, Neutral 0.5 - 0.8, Cautious < 0.5
        if (quality < 0.5 || hasConflict || state.confidence < 0.2) {
            recommendation = 'cautious';
        } else if (quality < 0.8 || state.meta.drift_risk > 0.6) {
            recommendation = 'neutral';
        }

        // Log distribution signal
        console.log(`[VALIDATOR] Quality: ${quality.toFixed(2)}, Recommendation: ${recommendation}, Conflict: ${hasConflict}`);

        return {
            quality: Math.max(0, quality),
            hasConflict,
            recommendation
        };
    }
}
