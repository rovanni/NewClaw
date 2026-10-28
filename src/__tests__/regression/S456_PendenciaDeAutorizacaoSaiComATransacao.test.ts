/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S456 (28/10/2026)
 *
 * Quando o botão (ou a expiração) resolve uma transação de autorização de um PASSO DE OBJETIVO, o AgentController vai para
 * `abortGoalFromAuth`/`resumeFromAuth` e nunca passava por `AgentLoop.resumeFromWorkflow` — o único lugar que limpava a
 * pendência do AuthorizationManager. A pendência sobrava, e a próxima mensagem curta da conversa ("ok", "não") virava
 * decisão sobre uma transação já encerrada (o WorkflowEngine respondia not_found; nada executava).
 *
 * ORIGEM: teste real na nuvem do ADR-029, 24/10/2026 — recusa pelo botão num passo de objetivo, mensagem seguinte tratada
 * como aprovação.
 *
 * REGRESSÃO SE: a pendência deixar de sair pela transação resolvida, ou o callback de autorização deixar de chamá-la antes
 * de escolher entre o caminho do objetivo e o do AgentLoop.
 *
 * Execução: npx ts-node src/__tests__/regression/S456_PendenciaDeAutorizacaoSaiComATransacao.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { AuthorizationManager } from '../../loop/AuthorizationManager';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

function main(): void {
    console.log('\n=== S456 — a pendência de autorização sai com a transação ===\n');

    console.log('AuthorizationManager: remove pela transação, em qualquer conversa');
    {
        const am = new AuthorizationManager();
        am.addPending('conv-goal', 'exec_command', { command: 'rustscan -a alvo.example' }, 'txn-1');
        am.addPending('conv-outra', 'exec_command', { command: 'ls' }, 'txn-2');
        am.removePendingByTxn('txn-1');
        assert(am.getPending('conv-goal') === undefined, 'a pendência da transação resolvida sai');
        assert(am.getPending('conv-outra')?.txnId === 'txn-2', 'a de outra transação fica');
        am.removePendingByTxn('txn-inexistente');
        assert(am.getPending('conv-outra')?.txnId === 'txn-2', 'transação desconhecida não mexe em nada');
    }

    console.log('\nAgentController: o callback libera a pendência antes de escolher o caminho');
    {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'core', 'AgentController.ts'), 'utf-8');
        const i = src.indexOf('private createWorkflowCallback(');
        const corpo = src.slice(i, src.indexOf('private registerSkills(', i));
        const resume = corpo.indexOf('this.workflowEngine.resume(');
        const esquece = corpo.indexOf('this.agentLoop.esquecerAutorizacao(txnId)');
        const ramoGoal = corpo.indexOf('getByTxnId(txnId)');
        assert(i > 0 && resume > 0 && ramoGoal > 0, 'o callback existe com o resume e o ramo do objetivo');
        assert(esquece > resume && esquece < ramoGoal, 'esquecerAutorizacao vem logo depois do resume e antes do ramo do objetivo', corpo.slice(resume, ramoGoal));
        assert(esquece < corpo.indexOf('if (!result)'), 'vale também para a transação expirada');
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`S456 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
    process.exit(failed > 0 ? 1 : 0);
}
main();
