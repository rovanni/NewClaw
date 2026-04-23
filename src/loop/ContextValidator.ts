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

        // 1. Density Check
        if (context.length < 50) {
            quality -= 0.4; // Very low context
        } else if (context.length < 200) {
            quality -= 0.2;
        }

        // 2. Metadata Check (Drift/Stability)
        if (state.meta.drift_risk > 0.6) {
            quality -= 0.2;
        }
        if (state.meta.stability < 0.4) {
            quality -= 0.1;
        }

        // 3. Simple Conflict Detection
        // Looking for potential contradictions in retrieved memory nodes
        const lines = context.split('\n');
        const subjects = new Map<string, string>();
        for (const line of lines) {
            if (line.includes(':')) {
                const [subject, value] = line.split(':').map(s => s.trim().toLowerCase());
                if (subjects.has(subject) && subjects.get(subject) !== value) {
                    hasConflict = true;
                    quality -= 0.3;
                    break;
                }
                subjects.set(subject, value);
            }
        }

        // 4. Recommendation Logic
        let recommendation: ValidationResult['recommendation'] = 'assertive';
        
        if (quality < 0.5 || hasConflict || state.confidence < 0.3) {
            recommendation = 'cautious';
        } else if (quality < 0.8 || state.meta.drift_risk > 0.4) {
            recommendation = 'neutral';
        }

        return {
            quality: Math.max(0, quality),
            hasConflict,
            recommendation
        };
    }
}
