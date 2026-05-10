import { MemoryManager } from '../memory/MemoryManager';
import { createLogger } from '../shared/AppLogger';

const log = createLogger('AgentStateManager');

export type AgentMode = 'learning' | 'assisting' | 'exploring';
export type AgentFocus = 'automation' | 'study' | 'project' | 'unknown';
export type AgentModeEvent = 'ONBOARDING_COMPLETE' | 'START_EXPLORATION' | 'REQUIRE_LEARNING' | 'RETURN_TO_ASSISTING';

const MODE_TRANSITIONS: Record<AgentMode, Partial<Record<AgentModeEvent, AgentMode>>> = {
    learning: {
        ONBOARDING_COMPLETE: 'assisting',
        START_EXPLORATION: 'exploring'
    },
    assisting: {
        REQUIRE_LEARNING: 'learning',
        START_EXPLORATION: 'exploring'
    },
    exploring: {
        REQUIRE_LEARNING: 'learning',
        RETURN_TO_ASSISTING: 'assisting'
    }
};

export interface AgentState {
    mode: AgentMode;
    confidence: number;
    user_alignment: number;
    current_focus: AgentFocus;
    meta: {
        stability: number;
        drift_risk: number;
    };
}

export class AgentStateManager {
    public memory: MemoryManager;

    constructor(memory: MemoryManager) {
        this.memory = memory;
    }

    getState(): AgentState {
        const node = this.memory.getNode('agent_state');
        if (node) {
            try {
                return JSON.parse(node.content);
            } catch {
                // Return default if corrupt
            }
        }
        return {
            mode: 'learning',
            confidence: 0.5,
            user_alignment: 0.5,
            current_focus: 'unknown',
            meta: {
                stability: 1.0,
                drift_risk: 0.0
            }
        };
    }

    private lastStates: Partial<AgentState>[] = [];

    updateState(updates: Partial<AgentState>): void {
        const currentState = this.getState();
        const newState = { ...currentState, ...updates };

        // Calculate stability and drift
        this.lastStates.push(updates);
        if (this.lastStates.length > 5) this.lastStates.shift();

        const focusChanges = this.lastStates.filter(s => s.current_focus && s.current_focus !== currentState.current_focus).length;
        const newStability = Math.max(0, 1.0 - (focusChanges * 0.2));
        const newDriftRisk = (focusChanges * 0.1) + (newState.confidence < 0.4 ? 0.2 : 0);

        newState.meta = {
            stability: newStability,
            drift_risk: Math.min(1.0, newDriftRisk)
        };
        
        this.memory.addNode({
            id: 'agent_state',
            type: 'context',
            name: 'agent_state',
            content: JSON.stringify(newState),
            last_updated: new Date().toISOString()
        });
    }

    transitionMode(event: AgentModeEvent): void {
        const currentState = this.getState();
        const nextMode = MODE_TRANSITIONS[currentState.mode][event];

        if (!nextMode) {
            log.warn(`Invalid state transition: ${currentState.mode} --${event}--> ?`);
            return;
        }

        log.info(`[FSM-TRANSITION] ${currentState.mode} --${event}--> ${nextMode}`);
        this.updateState({ mode: nextMode });
    }

    /**
     * Initial transition after onboarding
     */
    initializeAfterOnboarding(intent: string): void {
        const focusMap: Record<string, AgentFocus> = {
            automation: 'automation',
            study: 'study',
            projects: 'project'
        };
        
        this.updateState({
            current_focus: focusMap[intent] || 'unknown',
            confidence: 0.6,
            user_alignment: 0.5
        });
        this.transitionMode('ONBOARDING_COMPLETE');
    }

    /**
     * Update state based on interaction metrics
     */
    updateFromInteraction(success: boolean, consistency: number, alignmentDelta: number): void {
        const current = this.getState();
        
        // Confidence increases with success, decreases with failure
        let newConfidence = current.confidence + (success ? 0.05 : -0.1);
        newConfidence = Math.max(0.1, Math.min(1.0, newConfidence));
        
        // User alignment adjusts based on feedback/adherence
        let newAlignment = current.user_alignment + alignmentDelta;
        newAlignment = Math.max(0, Math.min(1.0, newAlignment));
        
        this.updateState({
            confidence: newConfidence,
            user_alignment: newAlignment
        });
    }
}
