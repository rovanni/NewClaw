/**
 * ExecutionTrace — Rastreabilidade do loop do agente
 * 
 * Registra cada step do raciocínio: decisão, tool calls, resultados, tempo, custo.
 * Emite eventos via EventEmitter para o dashboard SSE.
 */

import { EventEmitter } from 'events';

export type StepType = 'decision' | 'tool_call' | 'tool_result' | 'llm_call' | 'llm_response' | 'error' | 'final';

export interface TraceStep {
    step: number;
    type: StepType;
    timestamp: number;
    data: Record<string, any>;
    durationMs?: number;
}

export interface ExecutionTrace {
    id: string;
    sessionId: string;
    userInput: string;
    startTime: number;
    endTime?: number;
    totalDurationMs?: number;
    steps: TraceStep[];
    decision?: string;
    taskType?: string;
    confidence?: number;
    provider?: string;
    finalResponse?: string;
    status: 'running' | 'completed' | 'error' | 'max_iterations';
}

class ExecutionTraceManager extends EventEmitter {
    private traces: Map<string, ExecutionTrace> = new Map();
    private recentTraces: ExecutionTrace[] = [];
    private maxRecent = 50;

    startTrace(sessionId: string, userInput: string): ExecutionTrace {
        const id = `trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const trace: ExecutionTrace = {
            id,
            sessionId,
            userInput,
            startTime: Date.now(),
            steps: [],
            status: 'running'
        };
        this.traces.set(id, trace);
        this.emit('trace_start', trace);
        return trace;
    }

    addStep(trace: ExecutionTrace, type: StepType, data: Record<string, any>, durationMs?: number): void {
        const step: TraceStep = {
            step: trace.steps.length + 1,
            type,
            timestamp: Date.now(),
            data,
            durationMs
        };
        trace.steps.push(step);
        this.emit('trace_step', { traceId: trace.id, step });
    }

    completeTrace(trace: ExecutionTrace, status: ExecutionTrace['status'], finalResponse?: string): void {
        trace.endTime = Date.now();
        trace.totalDurationMs = trace.endTime - trace.startTime;
        trace.status = status;
        if (finalResponse) trace.finalResponse = finalResponse;

        // Move to recent and cleanup
        this.recentTraces.unshift(trace);
        if (this.recentTraces.length > this.maxRecent) {
            this.recentTraces.pop();
        }
        this.traces.delete(trace.id);

        this.emit('trace_complete', trace);
    }

    getRecentTraces(limit: number = 20): ExecutionTrace[] {
        return this.recentTraces.slice(0, limit);
    }

    getActiveTrace(id: string): ExecutionTrace | undefined {
        return this.traces.get(id);
    }

    getStats(): { totalTraces: number; avgDurationMs: number; byStatus: Record<string, number>; byProvider: Record<string, number> } {
        const all = this.recentTraces;
        const byStatus: Record<string, number> = {};
        const byProvider: Record<string, number> = {};
        let totalDuration = 0;

        for (const t of all) {
            byStatus[t.status] = (byStatus[t.status] || 0) + 1;
            if (t.provider) byProvider[t.provider] = (byProvider[t.provider] || 0) + 1;
            totalDuration += t.totalDurationMs || 0;
        }

        return {
            totalTraces: all.length,
            avgDurationMs: all.length > 0 ? Math.round(totalDuration / all.length) : 0,
            byStatus,
            byProvider
        };
    }
}

// Singleton
export const traceManager = new ExecutionTraceManager();