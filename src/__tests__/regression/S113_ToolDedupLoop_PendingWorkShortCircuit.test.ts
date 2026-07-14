/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S113
 * Investigação TOOL-DEDUP, Fases 3-5 (docs/INVESTIGACAO_TOOL_DEDUP_2026-07-13.md) — implementação
 * do desenho híbrido validado por duas investigações independentes (Codex + Claude Code):
 *
 *   Caso comum ("gere e envie", sem mais nada pendente): GoalExecutionLoop expõe
 *   `hasPendingPlanWorkBeyondDelivery()` via ChannelContext; se `false`, o branch de defer de
 *   `send_document` em AgentLoop.ts seta `terminalBatchResult` (mesmo mecanismo que o caminho
 *   real de terminalTools já usa) — o turno encerra em FINAL_READY sem nova inferência ao LLM.
 *   O loop deixa de ser estruturalmente possível, não apenas menos provável.
 *
 *   Caso "gere, envie e depois resuma" (ainda há pendência): o sub-turno continua, mas a
 *   mensagem de defer ganha reforço `role: 'system'` (mesmo padrão que o DELIVERY-GUARD já usa
 *   pro caso simétrico "ainda falta entregar"), corrigindo a assimetria de autoridade que era a
 *   causa raiz verificada (mensagem `tool` de "não reenvie" perdendo pra instrução obrigatória
 *   do prompt de sistema "use write + send_document").
 *
 * ACHADO CRÍTICO desta sessão (não estava nas investigações do Codex/ChatGPT): existe um
 * `fallbackPlan()` real (GoalPlanner.ts) que produz um ÚNICO step monolítico ("agentloop", sem
 * decomposição) cobrindo o objetivo inteiro — nesse caso, checar "outros PlanSteps pendentes"
 * não detectaria um "e depois resuma" embutido na descrição desse mesmo step. Por isso
 * `hasPendingPlanWorkBeyondDelivery()` só autoriza o short-circuit quando
 * `currentPlan.length > 1` (decomposição real existe); com 1 step só, retorna `true`
 * (conservador — não corta, deixa o LLM decidir com a mensagem reforçada).
 *
 * Escopo tocado: `agentLoopTypes.ts` (novo campo opcional em ChannelContext),
 * `GoalExecutionLoop.ts` (cálculo do getter), `AgentLoop.ts` (branch de defer de send_document).
 * `AgentFSM.ts`, `GoalPlanner.ts` e as tools não foram alterados (por design da síntese).
 *
 * Execução: npx ts-node src/__tests__/regression/S113_ToolDedupLoop_PendingWorkShortCircuit.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const agentLoopPath = path.join(process.cwd(), 'src', 'loop', 'AgentLoop.ts');
const agentLoopSource = fs.readFileSync(agentLoopPath, 'utf-8');
const goalExecutionLoopPath = path.join(process.cwd(), 'src', 'loop', 'GoalExecutionLoop.ts');
const goalExecutionLoopSource = fs.readFileSync(goalExecutionLoopPath, 'utf-8');
const goalPlannerPath = path.join(process.cwd(), 'src', 'loop', 'GoalPlanner.ts');
const goalPlannerSource = fs.readFileSync(goalPlannerPath, 'utf-8');
const agentFsmPath = path.join(process.cwd(), 'src', 'loop', 'AgentFSM.ts');
const agentFsmSource = fs.readFileSync(agentFsmPath, 'utf-8');

// ── Reprodução standalone de hasPendingPlanWorkBeyondDelivery (mesma lógica de GoalExecutionLoop.ts) ──
type PlanStepLike = { id: string; status: string };

function hasPendingPlanWorkBeyondDelivery(currentPlan: PlanStepLike[], stepId: string): boolean {
    if (currentPlan.length <= 1) return true;
    return currentPlan.some(s => s.id !== stepId && s.status === 'pending');
}

async function main(): Promise<void> {

console.log('\n=== S113-1 — AgentLoop.ts: branch de defer computa hasPendingWork via ChannelContext ===');
{
    assert(
        /const hasPendingWork = channelContext\.hasPendingPlanWorkBeyondDelivery\?\.\(\) \?\? true;/.test(agentLoopSource),
        'hasPendingWork lido do ChannelContext, default conservador true quando ausente',
    );
}

console.log('\n=== S113-2 — AgentLoop.ts: sem pendência, reusa terminalBatchResult (não inventa novo short-circuit) ===');
{
    assert(
        /if \(!hasPendingWork\) \{[\s\S]*?terminalBatchResult = deferMsg;/.test(agentLoopSource),
        'quando !hasPendingWork, terminalBatchResult = deferMsg — mesmo mecanismo do caminho real de terminalTools',
    );
    // Confirma que o mecanismo terminalBatchResult (pré-existente) continua sendo consumido pelo
    // mesmo check pós-batch — se esse padrão mudar sem eu perceber, meu reuso quebra silenciosamente.
    assert(
        /if \(terminalBatchResult !== null\) \{[\s\S]*?move\('FINAL_READY', \{ step: stepCount, terminal: true \}\);[\s\S]*?return terminalBatchResult;/.test(agentLoopSource),
        'o check pós-batch que consome terminalBatchResult (FINAL_READY + return) continua existindo como esperado',
    );
}

console.log('\n=== S113-3 — AgentLoop.ts: com pendência, reforça autoridade via mensagem role:\'system\' ===');
{
    assert(
        /loopMessages\.push\(\{\s*role: 'system',\s*content: `\[ESTADO\] A entrega de "\$\{filePath\}" já foi registrada/.test(agentLoopSource),
        'mensagem de reforço usa role:"system" (alta autoridade), não role:"tool" — corrige a assimetria identificada na investigação',
    );
}

console.log('\n=== S113-4 — AgentLoop.ts: TOOL-DEDUP (usedToolInputs) continua ativo independente do branch ===');
{
    // usedToolInputs.add deve acontecer ANTES do if/else de hasPendingWork — TOOL-DEDUP nunca some,
    // continua como defesa reativa mesmo com o short-circuit determinístico no lugar.
    const idx = agentLoopSource.indexOf(`cycleHistory.push({ step: stepCount, tool: 'send_document'`);
    const usedToolInputsIdx = agentLoopSource.indexOf('usedToolInputs.add(inputKey);', idx);
    const hasPendingWorkIdx = agentLoopSource.indexOf('const hasPendingWork =', idx);
    assert(
        idx > -1 && usedToolInputsIdx > idx && hasPendingWorkIdx > usedToolInputsIdx,
        'usedToolInputs.add roda antes do cálculo de hasPendingWork — dedup reativo preservado independente do short-circuit',
        { idx, usedToolInputsIdx, hasPendingWorkIdx }
    );
}

console.log('\n=== S113-5 — AgentFSM.ts: FINAL_READY continua alcançável de THINKING e EXECUTING_TOOL ===');
{
    // Pré-requisito de segurança do short-circuit: move('FINAL_READY') precisa ser uma transição
    // válida a partir de qualquer estado em que o branch de defer possa ser alcançado.
    assert(/THINKING: \{[\s\S]{0,200}FINAL_READY: 'DONE'/.test(agentFsmSource), 'THINKING → FINAL_READY → DONE continua válido');
    assert(/EXECUTING_TOOL: \{[\s\S]{0,200}FINAL_READY: 'DONE'/.test(agentFsmSource), 'EXECUTING_TOOL → FINAL_READY → DONE continua válido');
}

console.log('\n=== S113-6 — GoalExecutionLoop.ts: getter exposto no goalChannelContext, lendo goal.currentPlan ===');
{
    assert(
        /hasPendingPlanWorkBeyondDelivery: \(\) => \{[\s\S]{0,150}if \(goal\.currentPlan\.length <= 1\) return true;/.test(goalExecutionLoopSource),
        'getter implementado em GoalExecutionLoop.ts, conservador para currentPlan.length <= 1',
    );
}

console.log('\n=== S113-7 — GoalPlanner.ts: fallbackPlan() monolítico ainda existe (motivo da guarda conservadora) ===');
{
    assert(
        /fallbackPlan\(goal: Goal\): PlanResult \{[\s\S]{0,300}steps: \[\{/.test(goalPlannerSource) &&
        /id: 'step_direct'/.test(goalPlannerSource),
        'fallbackPlan() produz plano de 1 step só — confirma que a guarda currentPlan.length<=1 é necessária, não hipotética',
    );
}

console.log('\n=== S113-8 — hasPendingPlanWorkBeyondDelivery: plano monolítico (fallbackPlan) → conservador, true ===');
{
    const plan: PlanStepLike[] = [{ id: 'step_direct', status: 'executing' }];
    const result = hasPendingPlanWorkBeyondDelivery(plan, 'step_direct');
    assert(result === true, 'plano de 1 step só (ex.: fallbackPlan) nunca autoriza o short-circuit — sem sinal estrutural confiável', result);
}

console.log('\n=== S113-9 — hasPendingPlanWorkBeyondDelivery: multi-step, nenhum outro pendente → false (autoriza short-circuit) ===');
{
    const plan: PlanStepLike[] = [
        { id: 'step_1', status: 'completed' },
        { id: 'step_2', status: 'executing' }, // step atual (enviando o documento)
    ];
    const result = hasPendingPlanWorkBeyondDelivery(plan, 'step_2');
    assert(result === false, '"gere e envie" decomposto em steps (comum, padrão recomendado pelo GoalPlanner) — nada mais pendente, short-circuit liberado', result);
}

console.log('\n=== S113-10 — hasPendingPlanWorkBeyondDelivery: multi-step, "resuma" ainda pendente → true (não corta) ===');
{
    const plan: PlanStepLike[] = [
        { id: 'step_1', status: 'completed' },  // gerar
        { id: 'step_2', status: 'executing' },  // enviar (defer acontece aqui)
        { id: 'step_3', status: 'pending' },    // resumir
    ];
    const result = hasPendingPlanWorkBeyondDelivery(plan, 'step_2');
    assert(result === true, '"gere, envie e depois resuma" com step de resumo pendente — NÃO autoriza short-circuit, preserva o caso composto', result);
}

console.log('\n=== S113-11 — hasPendingPlanWorkBeyondDelivery: multi-step, outros já completed/failed/skipped (não pending) → false ===');
{
    const plan: PlanStepLike[] = [
        { id: 'step_1', status: 'completed' },
        { id: 'step_2', status: 'skipped' },
        { id: 'step_3', status: 'executing' }, // step atual
    ];
    const result = hasPendingPlanWorkBeyondDelivery(plan, 'step_3');
    assert(result === false, 'nenhum step com status "pending" além do atual — completed/skipped não bloqueiam o short-circuit', result);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S113 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S113 erro inesperado:', err);
    process.exitCode = 1;
});
