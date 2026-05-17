export type AgentFSMState = 'IDLE' | 'THINKING' | 'EXECUTING_TOOL' | 'SYNTHESIZING' | 'DONE' | 'ERROR' | 'TIMEOUT' | 'CANCELLED';

export type AgentFSMEvent =
    | 'START_TURN'
    | 'LLM_REQUEST'
    | 'LLM_RESPONSE'
    | 'TOOL_REQUESTED'
    | 'TOOL_COMPLETED'
    | 'SYNTHESIS_REQUIRED'
    | 'FINAL_READY'
    | 'AUTH_REQUIRED'
    | 'FAIL'
    | 'TIMEOUT'
    | 'CANCEL';

export interface AgentFSMTransition {
    from: AgentFSMState;
    to: AgentFSMState;
    event: AgentFSMEvent;
    at: string;
    meta?: Record<string, unknown>;
}

const TRANSITIONS: Record<AgentFSMState, Partial<Record<AgentFSMEvent, AgentFSMState>>> = {
    IDLE: {
        START_TURN: 'THINKING'
    },
    THINKING: {
        LLM_REQUEST: 'THINKING',
        LLM_RESPONSE: 'THINKING',
        TOOL_REQUESTED: 'EXECUTING_TOOL',
        SYNTHESIS_REQUIRED: 'SYNTHESIZING',
        FINAL_READY: 'DONE',
        AUTH_REQUIRED: 'DONE',
        FAIL: 'ERROR',
        TIMEOUT: 'TIMEOUT',
        CANCEL: 'CANCELLED'
    },
    EXECUTING_TOOL: {
        TOOL_COMPLETED: 'THINKING',
        FINAL_READY: 'DONE',
        AUTH_REQUIRED: 'DONE',
        FAIL: 'ERROR',
        TIMEOUT: 'TIMEOUT',
        CANCEL: 'CANCELLED'
    },
    SYNTHESIZING: {
        LLM_REQUEST: 'SYNTHESIZING',
        LLM_RESPONSE: 'SYNTHESIZING',
        SYNTHESIS_REQUIRED: 'SYNTHESIZING',
        FINAL_READY: 'DONE',
        FAIL: 'ERROR',
        TIMEOUT: 'TIMEOUT',
        CANCEL: 'CANCELLED'
    },
    DONE: {},
    ERROR: {},
    TIMEOUT: {},
    CANCELLED: {}
};

export class AgentFSM {
    private state: AgentFSMState = 'IDLE';
    private history: AgentFSMTransition[] = [];

    getState(): AgentFSMState {
        return this.state;
    }

    getHistory(): AgentFSMTransition[] {
        return [...this.history];
    }

    can(event: AgentFSMEvent): boolean {
        return Boolean(TRANSITIONS[this.state][event]);
    }

    transition(event: AgentFSMEvent, meta?: Record<string, unknown>): AgentFSMTransition {
        const next = TRANSITIONS[this.state][event];
        if (!next) {
            throw new Error(`Invalid AgentFSM transition: ${this.state} --${event}--> ?`);
        }

        const transition: AgentFSMTransition = {
            from: this.state,
            to: next,
            event,
            at: new Date().toISOString(),
            meta
        };

        this.state = next;
        this.history.push(transition);
        return transition;
    }
}
