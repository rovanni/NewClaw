/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S117
 *
 * ARCH-011 (docs/ARCHITECTURAL_BACKLOG.md): `StrategyDiversityGuard.extractUsedFingerprints`
 * passa a ler `goal.toolsTried` (fonte estruturada, deduplicada por `GoalStore.addToolTried`)
 * como fonte primária, em vez de só reconstruir por regex sobre `strategiesTried` (texto livre).
 *
 * `toolsTried` NÃO é um substituto 1:1 do regex anterior — é uma lista deduplicada de tools
 * reais já despachadas no goal inteiro (sem repetição, sem fronteira por tentativa), e NUNCA
 * contém `'agentloop'` (steps sem `toolName`, despachados via AgentLoop, nunca passam por
 * `GoalStore.addToolTried` — só roda `if (step.toolName)`, `GoalExecutionLoop.ts:1928`). Por
 * isso o mecanismo continua tendo um fallback textual, mas agora ele só detecta a participação
 * de `'agentloop'` — não precisa mais reconstruir nomes de tool via uma lista regex hardcoded
 * (que tinha ficado desatualizada em relação ao `ToolRegistry` real, docs/issues/005).
 *
 * Execução: npx ts-node src/__tests__/regression/S117_StrategyDiversityGuard_ToolsTriedPrimarySource.test.ts
 */

import { StrategyDiversityGuard } from '../../shared/StrategyDiversityGuard';
import { Goal, PlanStep } from '../../shared/domainTypes';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  OK ${message}`); passed++; }
    else { console.error(`  FALHOU: ${message}`, detail ?? ''); failed++; }
}

function makeGoal(overrides: Partial<Goal>): Goal {
    const now = Date.now();
    return {
        id: 'goal_s117', sessionKey: 'test:s117', conversationId: 'test-conv-s117',
        userIntent: 'objetivo de teste S117', objective: 'Objetivo de teste S117',
        status: 'executing', currentPlan: [], attempts: [], blockers: [],
        toolsTried: [], strategiesTried: [], successCriteria: [], sentArtifacts: [],
        retryBudget: 3, replanBudget: 5, confidence: 0.9,
        requiresAuth: false, authorizationScope: [],
        createdAt: now, updatedAt: now, expiresAt: now + 3_600_000,
        ...overrides,
    } as Goal;
}

function step(id: string, toolName?: string): PlanStep {
    return { id, description: `step ${id}`, toolName, status: 'pending', fallbackSteps: [] };
}

console.log('\n=== S117.1 — fonte primária: toolsTried (>=2) vira fingerprint, sem tocar em regex ===');
{
    const goal = makeGoal({ toolsTried: ['web_search', 'send_document'], strategiesTried: [] });
    const fps = StrategyDiversityGuard.extractUsedFingerprints(goal);
    assert(fps.includes('web_search→send_document'), 'fingerprint derivado de toolsTried presente', fps);
}

console.log('\n=== S117.2 — toolsTried com 1 item só: não gera fingerprint sozinho (mesmo limiar >=2 do mecanismo anterior) ===');
{
    const goal = makeGoal({ toolsTried: ['web_search'], strategiesTried: [] });
    const fps = StrategyDiversityGuard.extractUsedFingerprints(goal);
    assert(!fps.some(fp => fp === 'web_search'), 'nenhum fingerprint de item único criado a partir de toolsTried', fps);
}

console.log('\n=== S117.3 — CENÁRIO DE FALLBACK: step sem toolName (agentloop) não aparece em toolsTried, mas o fallback textual captura ===');
{
    // toolsTried nunca contém 'agentloop' (GoalExecutionLoop.ts só grava addToolTried quando
    // step.toolName existe) — a única forma de saber que agentloop participou da estratégia é
    // via menção textual em strategiesTried, daí o fallback continuar existindo.
    const goal = makeGoal({
        toolsTried: ['web_search'],
        strategiesTried: ['Pesquisar dados e sintetizar resposta via agentloop antes de enviar'],
    });
    const fps = StrategyDiversityGuard.extractUsedFingerprints(goal);
    assert(fps.includes('web_search→agentloop'), 'fallback textual detecta agentloop e combina com toolsTried real', fps);
}

console.log('\n=== S117.4 — fallback NÃO dispara se toolsTried estiver vazio (evita fingerprint de item único "agentloop") ===');
{
    const goal = makeGoal({
        toolsTried: [],
        strategiesTried: ['Delegado inteiramente ao agentloop, sem nenhuma tool estruturada'],
    });
    const fps = StrategyDiversityGuard.extractUsedFingerprints(goal);
    assert(!fps.includes('agentloop'), 'nenhum fingerprint de item único "agentloop" criado quando toolsTried está vazio', fps);
}

console.log('\n=== S117.5 — goal sem nenhum histórico: extractUsedFingerprints retorna vazio, não undefined/erro ===');
{
    const goal = makeGoal({ toolsTried: [], strategiesTried: [], currentPlan: [] });
    const fps = StrategyDiversityGuard.extractUsedFingerprints(goal);
    assert(Array.isArray(fps) && fps.length === 0, 'array vazio para goal sem histórico', fps);
}

console.log('\n=== S117.6 — isDiverse() continua funcionando fim-a-fim com a fonte primária nova ===');
{
    const goal = makeGoal({ toolsTried: ['web_search', 'send_document'], strategiesTried: [] });
    const repeatedPlan = [step('1', 'web_search'), step('2', 'send_document')];
    const diverse = StrategyDiversityGuard.isDiverse(repeatedPlan, goal);
    assert(diverse === false, 'plano com mesma sequência de toolsTried é corretamente rejeitado como não-diverso', { diverse });
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S117 RESULTADO: ${passed} passou | ${failed} falhou`);
process.exit(failed > 0 ? 1 : 0);
