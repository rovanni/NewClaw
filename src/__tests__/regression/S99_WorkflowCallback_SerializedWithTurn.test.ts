/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S99
 * 
 * Verifica que os callbacks de workflow (auth) obtidos via createWorkflowCallback
 * são executados sob a proteção do mutex da sessão (withMutex) para evitar
 * processamento concorrente de turnos/transações.
 */

import { AgentController } from '../../core/AgentController';
import { composeSessionKey } from '../../session/SessionKeyFactory';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${msg}`, detail ?? ''); failed++; }
}

async function main() {
    console.log('\n=== S99 — Serialização de Workflow Callback via Mutex de Sessão ===');

    // ── Mocks e Spies ────────────────────────────────────────────────────────
    let withMutexCalled = false;
    let mutexSid: string | null = null;
    let resumeCalled = false;
    let recordAssistantMessageCalled = false;

    const fakeSessionManager = {
        withMutex: async (sid: string, fn: () => Promise<unknown>) => {
            withMutexCalled = true;
            mutexSid = sid;
            return fn();
        },
        recordAssistantMessage: async (_sessionKey: unknown, _text: string, _meta: unknown) => {
            recordAssistantMessageCalled = true;
            return 42;
        }
    };

    const fakeWorkflowEngine = {
        resume: async (_txnId: string, _decision: string, _resolver: unknown) => {
            resumeCalled = true;
            return { output: 'auth_success_payload' };
        }
    };

    const fakeGoalStore = {
        getByTxnId: (_txnId: string) => null // sem goal pendente, vai para o agentLoop
    };

    const fakeGoalOrchestrator = {
        getGoalStore: () => fakeGoalStore
    };

    const fakeAgentLoop = {
        resumeFromWorkflow: async (_userId: string, _result: unknown) => {
            return 'Workflow resumido com sucesso!';
        }
    };

    const fakeAdapter = {
        send: async (_response: unknown, _rawCtx: unknown) => {}
    };

    const fakeController = {
        sessionManager: fakeSessionManager,
        workflowEngine: fakeWorkflowEngine,
        goalOrchestrator: fakeGoalOrchestrator,
        agentLoop: fakeAgentLoop
    };

    // Extrai o método privado do prototype e faz o bind com o fakeController
    const createWorkflowCallback = AgentController.prototype['createWorkflowCallback'];
    const callback = createWorkflowCallback.call(fakeController, fakeAdapter as any, 'telegram');

    // Invoca o callback simulando uma aprovação
    await callback('user-s99', 'txn-123', 'approved', {});

    // Asserções
    assert(withMutexCalled, 'withMutex foi chamado no sessionManager');
    assert(mutexSid === composeSessionKey({ channel: 'telegram', userId: 'user-s99' }), 'composição do session key (sid) correta');
    assert(resumeCalled, 'workflowEngine.resume foi chamado dentro do mutex');
    assert(recordAssistantMessageCalled, 'recordAssistantMessage foi chamado para persistir o resultado');

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S99 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(err => {
    console.error('Erro no teste S99:', err);
    process.exit(1);
});
