/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S338 (issue 059)
 *
 * 06/10/2026, instância isolada: "Quantos itens tem a lista do arquivo anexo? Responda só o número." O goal tinha
 * contrato de resposta (`response_produced`), mas os planos eram só de ferramentas (read + exec_command; read +
 * memory_write): o "3" correto ficou na saída de um exec_command, que não chega ao usuário. O validador recusou em
 * todo ciclo e a etapa de resposta só apareceu na geração 4, com os ciclos esgotados — goal failed após ~4,5 min.
 * Agora o plano com contrato e sem etapa capaz de responder é rejeitado ANTES de executar, com o fato para o Planner.
 *
 * REGRESSÃO SE: plano só de ferramentas executar com contrato de resposta; plano com etapa de resposta (ou artefato,
 * ou ferramenta de entrega direta) ser rejeitado; goal sem contrato ou de construção ser afetado.
 *
 * Execução: npx ts-node src/__tests__/regression/S338_ResponseContract_PlanWithoutAnswerStep_Rejected.test.ts
 */
import { findResponseContractGap } from '../../loop/planning/ensureDeliverySuccessCriteria';
import { GoalExecutionLoop } from '../../loop/GoalExecutionLoop';
import type { PlanStep, SuccessCriterion } from '../../loop/GoalTypes';
import { DIRECT_DELIVERABLE_TOOLS, producesUserReadableText } from '../../core/ToolRegistry';
import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string, d?: unknown): void {
    if (c) { console.log(`  ✅ ${m}`); passed++; } else { console.error(`  ❌ FALHOU: ${m}`, d ?? ''); failed++; }
}

const step = (toolName?: string): PlanStep => ({ id: `s_${toolName ?? 'agent'}`, description: 'x', status: 'pending', toolName } as PlanStep);
const contract: SuccessCriterion[] = [{ id: 'auto_response_produced', description: 'resposta', check: 'response_produced', status: 'pending' }];

console.log('\n=== S338-1 — planos reais do goal nuj7p: rejeitados ===');
for (const plan of [['read', 'exec_command'], ['read', 'memory_write'], ['exec_command'], ['memory_search']]) {
    const gap = findResponseContractGap(plan.map(t => step(t)), contract);
    assert(gap !== null && plan.every(t => gap.includes(t)), `[${plan.join(', ')}] → rejeitado, com as ferramentas no fato`, gap);
}
assert(findResponseContractGap([], contract) !== null, 'plano vazio com contrato → rejeitado');

console.log('\n=== S338-2 — planos capazes de responder: aceitos ===');
assert(findResponseContractGap([step('read'), step(undefined)], contract) === null, 'read + etapa do agente (sem toolName)');
assert(findResponseContractGap([step('read'), step('agentloop')], contract) === null, "read + toolName 'agentloop'");
assert(findResponseContractGap([step('weather')], contract) === null, 'weather (DIRECT_DELIVERABLE_TOOLS)');
assert(findResponseContractGap([step('crypto_analysis')], contract) === null, 'crypto_analysis (DIRECT_DELIVERABLE_TOOLS)');
assert(findResponseContractGap([step('write'), step('send_document')], contract) === null, 'write + send_document (artefato é a resposta)');
assert(findResponseContractGap([step('send_audio')], contract) === null, 'send_audio');

console.log('\n=== S338-3 — sem contrato de resposta: nada muda ===');
assert(findResponseContractGap([step('exec_command')], []) === null, 'sem critérios');
assert(findResponseContractGap([step('exec_command')], [{ id: 'c1', description: 'd', check: 'tool_succeeded', tool: 'exec_command', status: 'pending' } as SuccessCriterion]) === null, 'só tool_succeeded');

console.log('\n=== S338-4 — admissão no loop: blocker com o fato, plano vazio, sem gastar replanBudget ===');
{
    const calls: Record<string, unknown[]> = { blocker: [], strategy: [], update: [] };
    const loop = Object.create(GoalExecutionLoop.prototype) as any;
    loop.goalStore = {
        addBlocker: (_id: string, b: unknown) => calls.blocker.push(b),
        addStrategyTried: (_id: string, s: unknown) => calls.strategy.push(s),
        update: (_id: string, u: unknown) => calls.update.push(u),
    };
    // Issue 065f: a rejeição mantém os envios adiados pendentes do plano atual — o goal falso precisa dos campos reais.
    const goal = { id: 'g1', isConstruction: false, replanBudget: 3, currentPlan: [], sentArtifacts: [] } as any;
    const rejected = loop.rejectPlanWithoutAnswerStep(goal, [step('read'), step('exec_command')], contract);
    const b = calls.blocker[0] as { kind: string; description: string } | undefined;
    const u = calls.update[0] as Record<string, unknown> | undefined;
    assert(rejected === true, 'rejeitado');
    assert(b?.kind === 'goal_incomplete' && b.description.includes('exec_command'), 'blocker goal_incomplete com o fato', b);
    assert(Array.isArray(u?.currentPlan) && (u!.currentPlan as unknown[]).length === 0 && u?.status === 'replanning', 'plano vazio, status replanning', u);
    assert(u !== undefined && !('replanBudget' in u), 'replanBudget não consumido aqui', u);

    calls.blocker.length = 0; calls.update.length = 0;
    assert(loop.rejectPlanWithoutAnswerStep(goal, [step('read'), step(undefined)], contract) === false && calls.update.length === 0, 'plano com resposta: não toca o goal');
    assert(loop.rejectPlanWithoutAnswerStep({ ...goal, isConstruction: true }, [step('exec_command')], contract) === false && calls.update.length === 0, 'goal de construção: fora (marco intermediário)');
}

console.log('\n=== S338-5 — fonte única: admitir e entregar usam a mesma regra (producesUserReadableText) ===');
for (const t of [undefined, 'agentloop', ...DIRECT_DELIVERABLE_TOOLS, 'read', 'exec_command', 'memory_write', 'web_search']) {
    const admitted = findResponseContractGap([step(t)], contract) === null;
    assert(admitted === producesUserReadableText(t), `${t ?? '(sem toolName)'}: admissão (${admitted}) = entrega (${producesUserReadableText(t)})`);
}
{
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'planning', 'ensureDeliverySuccessCriteria.ts'), 'utf-8');
    assert(!/DIRECT_DELIVERABLE_TOOLS\.includes/.test(src) && /producesUserReadableText\(/.test(src), 'findResponseContractGap não tem cópia local da regra');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S338 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
