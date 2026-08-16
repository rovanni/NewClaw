export type SemanticStatus = 
    // AgentFSM
    | 'idle' 
    | 'thinking' 
    | 'executing_tool' 
    | 'synthesizing' 
    | 'done' 
    | 'error' 
    | 'timeout' 
    | 'cancelled'
    // GoalStatus
    | 'active' 
    | 'executing' 
    | 'blocked' 
    | 'replanning' 
    | 'completed' 
    | 'failed' 
    | 'abandoned';

export interface SemanticStatusEvent {
    status: SemanticStatus;
    tool?: string;
}
