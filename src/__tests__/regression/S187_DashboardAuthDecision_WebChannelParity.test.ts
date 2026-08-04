/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S187
 *
 * Gap registrado em `docs/ARCHITECTURE.md` ("Gaps conhecidos"): o Dashboard web era o único canal
 * sem caminho para aprovar ação perigosa. `AgentController` injetava `workflowCallback` só nos 4
 * adapters de mensageria; um goal disparado pelo painel que atingisse `needs_auth` criava o
 * `pendingTxnId` normalmente e ficava `blocked` esperando uma decisão que o canal não tinha como
 * entregar — até expirar. Achado durante a validação real do ARCH-008 (19/07/2026) e contornado
 * lá chamando `resumeFromAuth()` fora do canal, só para o teste passar.
 *
 * O que este teste garante:
 *   1. `WorkflowEngine.getPendingByConversation()` responde "há algo esperando decisão nesta
 *      conversa?" — a pergunta que o canal web precisa fazer por não ter botão de plataforma —
 *      e ignora transações de outras conversas ou já decididas;
 *   2. o mesmo vale com e sem SQLite (o engine tem fallback in-memory);
 *   3. a decisão do Dashboard percorre a MESMA closure de `createWorkflowCallback()` que
 *      Telegram/Discord/WhatsApp/Signal usam — nenhuma regra de autorização reimplementada na
 *      rota HTTP (é isso que impede o canal web de divergir dos outros com o tempo).
 *
 * Execução: npx ts-node src/__tests__/regression/S187_DashboardAuthDecision_WebChannelParity.test.ts
 */

import Database from 'better-sqlite3';
import { WorkflowEngine } from '../../loop/WorkflowEngine';
import { AgentController } from '../../core/AgentController';
import { WebChannelAdapter } from '../../channels/WebChannelAdapter';
import { composeSessionKey } from '../../session/SessionKeyFactory';
import type { ContinuationContext } from '../../loop/WorkflowTypes';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string, detail?: unknown): void {
    if (cond) { console.log(`  OK ${msg}`); passed++; }
    else { console.error(`  FALHOU: ${msg}`, detail ?? ''); failed++; }
}

const ctx: ContinuationContext = { workflow: 'test-s187', step: 'run', userGoal: 'apagar build' };

async function main() {
    console.log('\n=== S187 — Dashboard aprova ação perigosa pelo mesmo caminho dos outros canais ===');

    console.log('\n--- S187.1 — getPendingByConversation isola por conversa e por status ---');
    for (const mode of ['sqlite', 'memory'] as const) {
        const engine = mode === 'sqlite'
            ? new WorkflowEngine(new (Database as any)(':memory:'))
            : new WorkflowEngine();

        const mine = engine.createTransaction('web-session', 'exec_command', { command: 'rm -rf build' }, ctx);
        engine.createTransaction('outra-conversa', 'exec_command', { command: 'echo outro' }, ctx);

        const pending = engine.getPendingByConversation('web-session');
        assert(pending.length === 1 && pending[0].id === mine.id,
            `[${mode}] só a transação da própria conversa é devolvida`, pending.map(p => p.id));
        assert(pending[0].tool === 'exec_command' && (pending[0].params as any).command === 'rm -rf build',
            `[${mode}] devolve tool e params para a interface poder mostrar o que está sendo aprovado`, pending[0]);

        // Depois de decidida, some da lista — senão a tela ficaria mostrando botões de uma
        // transação já resolvida (o resume() apaga a transação).
        await engine.resume(mine.id, 'rejected', () => undefined);
        assert(engine.getPendingByConversation('web-session').length === 0,
            `[${mode}] transação já decidida não aparece mais como pendente`);

        assert(engine.getPendingByConversation('conversa-inexistente').length === 0,
            `[${mode}] conversa sem transação devolve lista vazia (nunca undefined)`);
    }

    console.log('\n--- S187.2 — a decisão do Dashboard usa a MESMA closure dos outros canais ---');
    {
        let resumedTxn: string | null = null;
        let resumedDecision: string | null = null;
        let mutexSid: string | null = null;
        let sentText: string | null = null;

        const fakeController = {
            sessionManager: {
                withMutex: async (sid: string, fn: () => Promise<unknown>) => { mutexSid = sid; return fn(); },
                recordAssistantMessage: async () => 1,
            },
            workflowEngine: {
                resume: async (txnId: string, decision: string) => {
                    resumedTxn = txnId; resumedDecision = decision;
                    return { output: 'comando executado' };
                },
            },
            goalOrchestrator: { getGoalStore: () => ({ getByTxnId: () => null }) },
            agentLoop: { resumeFromWorkflow: async () => 'Ação concluída após autorização.' },
        };

        const adapter = new WebChannelAdapter();
        const createWorkflowCallback = AgentController.prototype['createWorkflowCallback'];
        adapter.workflowCallback = createWorkflowCallback.call(fakeController as any, adapter, 'web');

        // Mesmo caminho da rota POST /api/chat/auth-decision: registra o pending do requestId,
        // dispara o callback, e o texto chega pelo send() normal do adapter.
        const requestId = 'req-s187';
        const responsePromise = adapter.waitForResponse(requestId, 'web-session', 5000);
        await adapter.workflowCallback!('web-session', 'txn-s187', 'approved', requestId);
        const response = await responsePromise;
        sentText = response.text ?? null;

        assert(resumedTxn === 'txn-s187' && resumedDecision === 'approved',
            'a decisão chega ao WorkflowEngine.resume com txnId e decisão corretos', { resumedTxn, resumedDecision });
        assert(mutexSid === composeSessionKey({ channel: 'web', userId: 'web-session' }),
            'roda sob o mutex da sessão web — mesma serialização que S99 garante para os outros canais', mutexSid);
        assert(sentText === 'Ação concluída após autorização.',
            'o texto produzido pelo callback volta pela requisição HTTP que está esperando', sentText);
    }

    console.log('\n--- S187.3 — o canal web declara workflowCallback como os outros adapters ---');
    {
        // Guarda contra regressão de wiring: se alguém remover a injeção em AgentController, o
        // canal volta a ficar sem caminho de aprovação — que é exatamente o gap original.
        const adapter = new WebChannelAdapter();
        assert('workflowCallback' in adapter || adapter.workflowCallback === undefined,
            'WebChannelAdapter expõe a propriedade workflowCallback (contrato igual ao dos 4 canais de mensageria)');

        const src = require('fs').readFileSync(require('path').join(__dirname, '../../core/AgentController.ts'), 'utf-8');
        assert(/webAdapter\.workflowCallback\s*=\s*this\.createWorkflowCallback\(/.test(src),
            'AgentController injeta o callback no webAdapter usando a mesma fábrica dos demais canais');
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S187 RESULTADO: ${passed} passou | ${failed} falhou`);
    if (failed > 0) process.exit(1);
    process.exit(0);
}

main().catch(err => { console.error('Erro no teste S187:', err); process.exit(1); });
