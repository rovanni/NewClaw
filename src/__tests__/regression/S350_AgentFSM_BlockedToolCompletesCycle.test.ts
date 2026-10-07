/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S350 (issue 066)
 *
 * Produção, 07/10/2026, goal ENADE: o modelo devolveu 9 tool calls num lote. A 5ª (um `edit`) foi barrada pela
 * proteção [EDIT-LOOP] ("Blocked edit #5") e saiu de dispatchSingleNativeToolCall SEM TOOL_COMPLETED; a 6ª pediu
 * EXECUTING_TOOL --TOOL_REQUESTED--> e a máquina de estados abortou o turno ("Invalid AgentFSM transition") — 9 min
 * de trabalho jogados fora e o goal abandonado. Variante de 02/08: EXECUTING_TOOL --LLM_REQUEST-->.
 *
 * REGRESSÃO SE: uma chamada bloqueada por proteção (continueFor/breakFor) voltar a deixar a FSM em EXECUTING_TOOL.
 *
 * Execução: npx ts-node src/__tests__/regression/S350_AgentFSM_BlockedToolCompletesCycle.test.ts
 */
import { AgentLoop } from '../../loop/AgentLoop';
import { AgentFSM } from '../../loop/AgentFSM';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

async function main(): Promise<void> {
    for (const bloqueio of ['continueFor', 'breakFor'] as const) {
        console.log(`\n=== S350 — chamada barrada por proteção (${bloqueio}) fecha o ciclo da máquina de estados ===`);
        const fsm = new AgentFSM();
        fsm.transition('START_TURN');
        const move = (ev: string, meta?: Record<string, unknown>) => fsm.transition(ev as any, meta);
        const loop = Object.create(AgentLoop.prototype) as any;
        loop.tools = { get: () => ({ name: 'edit', execute: async () => ({ success: true, output: '' }) }) };
        loop.executeAndRecordNativeToolCall = async () => ({ action: bloqueio, dedupAbort: bloqueio === 'breakFor', dedupAbortTool: bloqueio === 'breakFor' ? 'edit' : undefined });
        const call = (id: string) => ({ id, name: 'edit', arguments: { path: 'questoes.md', oldText: 'a', newText: 'b' } });
        let erro: unknown;
        try {
            await loop.dispatchSingleNativeToolCall(
                call('c5'), 3, undefined, 'conv', 'pedido', {} as any, { steps: [] } as any, new AbortController().signal,
                new Set(), new Map(), new Map(), new Set(), new Set(), new Map(), new Map(), new Map(), new Map(), [],
                [], {} as any, false, undefined, 20, 4, 0, [], 0, 10, 10, 5, move,
            );
        } catch (e) { erro = e; }
        assert(erro === undefined, 'a chamada bloqueada não lança', erro);
        assert(fsm.getState() === 'THINKING', `FSM volta a THINKING depois da chamada bloqueada — estado: ${fsm.getState()}`);
        assert(fsm.can('TOOL_REQUESTED'), 'a próxima chamada do lote pode começar (antes: Invalid AgentFSM transition)');
        const ultima = fsm.getHistory().slice(-1)[0];
        assert(ultima?.event === 'TOOL_COMPLETED' && (ultima.meta as any)?.blocked === true, 'transição registrada como TOOL_COMPLETED bloqueada', ultima);
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S350 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exitCode = 1;
}
main().catch((err) => { console.error('S350 erro inesperado:', err); process.exitCode = 1; });
