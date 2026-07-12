/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S101
 * 
 * 1. Verifica que o TurnState é isolado por conversationId e que modificações em
 *    uma conversa não contaminam outra conversa concorrente (isolamento).
 * 2. Verifica o ciclo de vida do TurnState: ele deve ser inicializado antes de
 *    runWithTools e removido/limpo após o término do turno (cleanup).
 */

import { AgentLoop } from '../../loop/AgentLoop';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${msg}`, detail ?? ''); failed++; }
}

async function main() {
    console.log('\n=== S101-A — Isolamento Concorrente do Estado de Turno no AgentLoop ===');

    const fakeAgentLoop = {
        activeTurnStates: new Map(),
        getTurnState: AgentLoop.prototype['getTurnState']
    };

    // Obtém o estado para duas conversas concorrentes
    const stateA = fakeAgentLoop.getTurnState('conv-A');
    const stateB = fakeAgentLoop.getTurnState('conv-B');

    assert(stateA !== stateB, 'Estados obtidos para conv-A e conv-B são instâncias distintas');

    // Modifica o estado da conversa A
    stateA.cognitiveWorkspace.add(1, 'Raciocínio da conversa A');
    stateA.lastToolExecution = { toolName: 'read', toolOutput: 'outA', intent: 'intentA', category: 'execution' };
    stateA.pendingObserverFeedback.push('[OBSERVER] feedbackA');

    // Verifica que a conversa B permaneceu isolada e vazia
    assert(stateB.cognitiveWorkspace.getStats().entries === 0, 'Conversa B: CognitiveWorkspace está vazio');
    assert(stateB.lastToolExecution === null, 'Conversa B: lastToolExecution é null');
    assert(stateB.pendingObserverFeedback.length === 0, 'Conversa B: pendingObserverFeedback está vazio');

    // Verifica que a conversa A salvou os dados corretamente
    assert(stateA.cognitiveWorkspace.getStats().entries === 1, 'Conversa A: CognitiveWorkspace tem 1 entrada');
    assert(stateA.lastToolExecution?.toolName === 'read', 'Conversa A: lastToolExecution gravado corretamente');
    assert(stateA.pendingObserverFeedback[0] === '[OBSERVER] feedbackA', 'Conversa A: pendingObserverFeedback gravado corretamente');


    console.log('\n=== S101-B — Ciclo de Vida e Cleanup do TurnState no run() ===');

    let runWithToolsCalled = false;
    let checkActiveStatesDuringRun = false;

    const fakeAgentLoopWithRun = {
        activeTurns: new Map(),
        turnStartTimes: new Map(),
        activeTurnStates: new Map(),
        getTurnState: AgentLoop.prototype['getTurnState'],
        postTurnCallback: null,
        runWithTools: async (conversationId: string, _userText: string, _step: number, _userId?: string, _context?: any) => {
            runWithToolsCalled = true;
            // Durante a execução, o estado deve estar presente no Map
            const state = fakeAgentLoopWithRun.activeTurnStates.get(conversationId);
            if (state) {
                checkActiveStatesDuringRun = true;
            }
            return 'dummy_response';
        },
        run: AgentLoop.prototype['run']
    };

    const runPromise = fakeAgentLoopWithRun.run('conv-C', 'Oi');

    await runPromise;

    assert(runWithToolsCalled, 'runWithTools foi executado');
    assert(checkActiveStatesDuringRun, 'TurnState estava presente no map durante a execução do turno');
    assert(!fakeAgentLoopWithRun.activeTurnStates.has('conv-C'), 'TurnState foi devidamente removido após a finalização do turno');

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S101 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(err => {
    console.error('Erro no teste S101:', err);
    process.exit(1);
});
