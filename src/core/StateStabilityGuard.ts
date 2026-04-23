import { AgentStateManager, AgentState } from './AgentStateManager';

/**
 * StateStabilityGuard — Prevents erratic state changes.
 * Suavizes transitions by buffering frequent updates.
 */
export class StateStabilityGuard {
    private stateManager: AgentStateManager;
    private changeBuffer: Map<string, { value: any, count: number }> = new Map();

    constructor(stateManager: AgentStateManager) {
        this.stateManager = stateManager;
    }

    /**
     * Request a state change. If it's a sensitive transition (like focus),
     * it might be delayed until consistency is observed.
     */
    requestTransition(updates: Partial<AgentState>): void {
        const currentState = this.stateManager.getState();
        
        let shouldApplyNow = true;
        const delayedUpdates: Partial<AgentState> = {};

        // Focus transition guard
        if (updates.current_focus && updates.current_focus !== currentState.current_focus) {
            const buffer = this.changeBuffer.get('current_focus') || { value: updates.current_focus, count: 0 };
            
            if (buffer.value === updates.current_focus) {
                buffer.count++;
            } else {
                buffer.value = updates.current_focus;
                buffer.count = 1;
            }
            
            this.changeBuffer.set('current_focus', buffer);
            
            // Only apply if we see the same focus requested twice or stability is very high
            if (buffer.count >= 2 || currentState.meta.stability > 0.9) {
                delayedUpdates.current_focus = updates.current_focus;
                this.changeBuffer.delete('current_focus');
            } else {
                shouldApplyNow = false;
                console.log(`[GUARD] Focus change to ${updates.current_focus} buffered (stability: ${currentState.meta.stability})`);
            }
        }

        // Apply immediately if not blocked
        if (shouldApplyNow) {
            this.stateManager.updateState({ ...updates, ...delayedUpdates });
        } else if (Object.keys(updates).filter(k => k !== 'current_focus').length > 0) {
            // Apply other updates that are not blocked
            const others = { ...updates };
            delete others.current_focus;
            this.stateManager.updateState(others);
        }
    }
}
