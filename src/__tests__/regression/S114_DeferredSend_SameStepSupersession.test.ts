/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S114
 * GoalExecutionLoop: um novo deferred-send injetado por um retry do MESMO pendingStep deve
 * SUPERSEDER (substituir) qualquer send_document ainda pendente injetado por uma tentativa
 * anterior do mesmo step — nunca acumular os dois.
 *
 * BUG REAL (goal_1784200808912_vw8fu, 16/07/2026, Telegram): usuário pediu "mudar as cores"
 * de um .pptx existente. O plano tinha 1 step 'agentloop' livre (sem toolName) que foi
 * retried 3 vezes (cada retry causado por SEMANTIC-MISMATCH: o script gerado não encontrava
 * as caixas de texto, ou aplicava a paleta errada). Cada retry criou um NOVO script Python
 * com um NOVO arquivo de saída, e cada sucesso do retry injetou seu próprio send_document
 * diferido no plano (bloco AGENTLOOP-SEND, case 'success' de runLoopInternal) — sem cancelar
 * o deferred send da tentativa anterior. Ao final, 3 arquivos .pptx diferentes (mais 1 enviado
 * de forma imediata via DELIVERY-GUARD numa tentativa ainda mais antiga) foram todos
 * despachados de verdade para o usuário, que só queria 1 arquivo com as cores corrigidas.
 *
 * FIX (GoalExecutionLoop.ts, bloco de injeção dentro de case 'success'): cada PlanStep
 * injetado por um deferred send agora carrega `originStepId: pendingStep.id` (campo novo em
 * PlanStep, GoalTypes.ts). Antes de mesclar os novos deferred sends no plano, remove qualquer
 * send_document ainda 'pending' cujo originStepId bata com o pendingStep atual — a nova
 * tentativa supera a anterior, não convive com ela. Sends de OUTROS steps (ex.: o próprio
 * send_document explícito do plano, sem originStepId) ou já despachados (status !== 'pending')
 * nunca são tocados.
 *
 * REGRESSÃO SE: a filtragem de supersessão for removida, ou originStepId deixar de ser
 * propagado ao criar os PlanStep de deferred send.
 *
 * Execução: npx ts-node src/__tests__/regression/S114_DeferredSend_SameStepSupersession.test.ts
 */

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

interface MockPlanStep {
    id: string;
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    status: 'pending' | 'completed';
    originStepId?: string;
}

// Réplica exata da lógica de reconciliação em GoalExecutionLoop.ts (bloco AGENTLOOP-SEND,
// case 'success' de runLoopInternal): dado o plano atual e um novo lote de deferred sends
// originado por `pendingStepId`, remove sends pendentes anteriores do MESMO originStepId
// antes de mesclar os novos.
function reconcileDeferredSends(
    currentPlan: MockPlanStep[],
    pendingStepId: string,
    newFilePaths: string[],
): { updatedPlan: MockPlanStep[]; supersededPaths: string[] } {
    const newSendSteps: MockPlanStep[] = newFilePaths.map((fp, i) => ({
        id: `step_deferred_${Date.now()}_${i}`,
        toolName: 'send_document',
        toolArgs: { file_path: fp },
        status: 'pending' as const,
        originStepId: pendingStepId,
    }));
    const supersededPaths: string[] = [];
    const planWithoutSuperseded = currentPlan.filter(s => {
        const superseded = s.status === 'pending'
            && s.toolName === 'send_document'
            && s.originStepId === pendingStepId;
        if (superseded) supersededPaths.push(String(s.toolArgs?.file_path ?? ''));
        return !superseded;
    });
    return { updatedPlan: [...planWithoutSuperseded, ...newSendSteps], supersededPaths };
}

// ── Cenário 1: retry #2 do mesmo step supera o deferred send do retry #1 ────

console.log('\n=== S114 — Cenário 1: retry do mesmo pendingStep supera o anterior ===');

let plan: MockPlanStep[] = [
    { id: 'step_1', toolName: 'list_workspace', status: 'completed' },
];

// Retry #1 do step_2 (agentloop) injeta um deferred send pra seguranca_redes_paleta_ipv6.pptx
let r1 = reconcileDeferredSends(plan, 'step_2', ['seguranca_redes_paleta_ipv6.pptx']);
plan = r1.updatedPlan;

assert(
    plan.filter(s => s.toolName === 'send_document' && s.status === 'pending').length === 1,
    'após retry #1: exatamente 1 send_document pendente',
    plan
);
assert(r1.supersededPaths.length === 0, 'retry #1: nada foi superado (primeira tentativa)');

// Retry #2 do MESMO step_2 (SEMANTIC-MISMATCH downgradou o #1 e o step foi re-executado) —
// script diferente, arquivo de saída diferente
const r2 = reconcileDeferredSends(plan, 'step_2', ['seguranca_redes_estilo_ipv6_final.pptx']);
plan = r2.updatedPlan;

assert(
    plan.filter(s => s.toolName === 'send_document' && s.status === 'pending').length === 1,
    'após retry #2 do MESMO step: ainda exatamente 1 send_document pendente (não 2)',
    plan
);
assert(
    r2.supersededPaths.length === 1 && r2.supersededPaths[0] === 'seguranca_redes_paleta_ipv6.pptx',
    'retry #2: o deferred send do retry #1 (arquivo antigo) foi superado corretamente',
    r2.supersededPaths
);
assert(
    plan.find(s => s.toolName === 'send_document')?.toolArgs?.file_path === 'seguranca_redes_estilo_ipv6_final.pptx',
    'o send_document pendente restante aponta pro arquivo do retry MAIS RECENTE',
    plan.find(s => s.toolName === 'send_document')
);

// ── Cenário 2: send_document de OUTRO step (originStepId diferente) não é tocado ──

console.log('\n=== S114 — Cenário 2: send_document de outro step nunca é superado ===');

let plan2: MockPlanStep[] = [
    { id: 'step_1', toolName: 'list_workspace', status: 'completed' },
    // step_3 é o próprio send_document explícito do plano original — sem originStepId
    { id: 'step_3', toolName: 'send_document', toolArgs: { file_path: 'seguranca_redes_colorido_v2.pptx' }, status: 'pending' },
];

const r3 = reconcileDeferredSends(plan2, 'step_2', ['seguranca_redes_paleta_ipv6.pptx']);
plan2 = r3.updatedPlan;

assert(
    plan2.filter(s => s.toolName === 'send_document' && s.status === 'pending').length === 2,
    'send_document de step_3 (originStepId ausente) sobrevive junto com o novo de step_2 — não é a mesma origem',
    plan2
);
assert(r3.supersededPaths.length === 0, 'nada de step_3 foi superado por um deferred send de step_2');

// ── Cenário 3: send já DESPACHADO (status !== pending) nunca é tocado ────────

console.log('\n=== S114 — Cenário 3: send já despachado (não pending) é imune à supersessão ===');

let plan3: MockPlanStep[] = [
    { id: 'step_deferred_old', toolName: 'send_document', toolArgs: { file_path: 'ja_enviado.pptx' }, status: 'completed', originStepId: 'step_2' },
];

const r4 = reconcileDeferredSends(plan3, 'step_2', ['novo_arquivo.pptx']);
plan3 = r4.updatedPlan;

assert(
    plan3.some(s => s.toolArgs?.file_path === 'ja_enviado.pptx' && s.status === 'completed'),
    'send_document já completed (irretratável) permanece intacto, mesmo com mesma origem',
    plan3
);
assert(r4.supersededPaths.length === 0, 'nenhuma supersessão aplicada sobre step já despachado');

// ── Resultado ────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`S114 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exit(1);
