/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S53
 * Investigação de log real (05/07/2026, Telegram, goal_1783288862838_1muu1, follow-up
 * "teria como ter no máximo 10 linhas por slides que tem conteúdos que não aparecem"):
 *
 *   1. GoalExtractor classificou corretamente como `refinement_of_recent_goal` (reason),
 *      isGoal=false → roteado para AgentLoop puro (não GoalExecutionLoop).
 *   2. UnifiedIntentRouter classificou o texto como category=conversation, mode=direct
 *      (confidence=0.7) — a partir só do texto, sem saber que cumprir o pedido exigiria
 *      editar o .md, escrever e EXECUTAR um script python-pptx, e enviar o resultado.
 *   3. STEP_BUDGETS.direct=4 (+2 do DELIVERY-GUARD = 6) não foi suficiente: o turno gastou
 *      o orçamento inteiro reeditando excel_class.md (3 writes) e só escreveu
 *      scripts/gen_excel_pptx.py no último step permitido — nunca o executou, nunca enviou
 *      nada.
 *   4. A resposta final disse "Vou recriar..." (futuro) apesar de tools já terem rodado —
 *      ObserverValidator corretamente detectou a inconsistência (COMMIT Hallucination
 *      bloqueada, risk=0.90) e bloqueou a resposta. Mas o texto de fallback para esse caso
 *      ("Ocorreu um erro interno de processamento") é enganoso: não houve erro de sistema,
 *      o trabalho real aconteceu e só não terminou por falta de orçamento de steps.
 *
 * Correções (2 pontos, mesma causa raiz — turno subdimensionado por classificação
 * só-de-texto que não vê o que o trabalho realmente vai exigir):
 *
 *   A) AgentLoop.ts: upgrade de `maxSteps` orientado a EVIDÊNCIA (mesmo padrão já usado por
 *      `requiresPlanning`) — assim que `write`/`exec_command` roda com sucesso num turno
 *      ainda no orçamento pequeno, sobe para STEP_BUDGETS.tool (10). Não depende de nova
 *      classificação; reage ao que já aconteceu no próprio turno.
 *   B) ObserverValidator.ts: a mensagem do bloqueio `isFutureAction` deixa de dizer "erro
 *      interno de processamento" (falso) e passa a reconhecer que houve trabalho real sem
 *      confirmação de resultado — mesmo padrão de honestidade já aplicado aos ramos
 *      isIncomplete/isReadOnly da mesma função.
 *
 * Escopo tocado: loop/AgentLoop.ts (upgrade de step budget), loop/ObserverValidator.ts
 * (mensagem do ramo isFutureAction).
 *
 * Execução: npx ts-node src/__tests__/regression/S53_StepBudget_RealWorkUpgrade.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`); failed++; }
}

const agentLoopPath = path.join(process.cwd(), 'src', 'loop', 'AgentLoop.ts');
const observerPath = path.join(process.cwd(), 'src', 'loop', 'ObserverValidator.ts');
const agentLoopSource = fs.readFileSync(agentLoopPath, 'utf-8');
const observerSource = fs.readFileSync(observerPath, 'utf-8');

async function main(): Promise<void> {

console.log('\n=== S53-1 — AgentLoop.ts upgrada maxSteps a partir de evidência real de tool use ===');
{
    assert(
        /resolvedToolName === 'write' \|\| resolvedToolName === 'exec_command'/.test(agentLoopSource),
        'gatilho é write/exec_command bem-sucedidos — as duas tools que produzem/transformam arquivo',
    );
    assert(
        /maxSteps < \(STEP_BUDGETS\.tool \?\? 10\)/.test(agentLoopSource),
        'só sobe se o orçamento atual ainda for menor que STEP_BUDGETS.tool (não regride nem re-sobe à toa)',
    );
    assert(
        /\[STEP-BUDGET\] real file work detected/.test(agentLoopSource),
        'log de observabilidade explícito, no mesmo padrão de [STEP-BUDGET] já usado por requiresPlanning',
    );
}

console.log('\n=== S53-2 — reprodução do mecanismo: turno "direct" com write real sobe de 4 para 10 ===');
{
    // Reproduz a lógica exata do upgrade (mesma condição do patch), isolada do resto do AgentLoop.
    const STEP_BUDGETS: Record<string, number> = { direct: 4, hybrid: 6, tool: 10, planner: 15 };
    let maxSteps = STEP_BUDGETS.direct; // conversation/direct — classificação só-de-texto
    assert(maxSteps === 4, 'orçamento inicial de "direct" é 4, igual ao incidente real');

    function onToolSuccess(toolName: string) {
        if (toolName === 'write' || toolName === 'exec_command') {
            if (maxSteps < (STEP_BUDGETS.tool ?? 10)) {
                maxSteps = STEP_BUDGETS.tool ?? 10;
            }
        }
    }

    onToolSuccess('read');   // read não produz/transforma — não deve subir o orçamento
    assert(maxSteps === 4, 'read (só leitura) não dispara upgrade de orçamento');

    onToolSuccess('write');  // primeiro write real do turno
    assert(maxSteps === 10, 'após write bem-sucedido, orçamento sobe de 4 para 10 — espaço suficiente para editar+converter+enviar');

    onToolSuccess('write');  // writes subsequentes não devem re-subir nem quebrar nada
    assert(maxSteps === 10, 'writes subsequentes não alteram o orçamento já elevado (idempotente)');
}

console.log('\n=== S53-3 — orçamento maior já elevado (ex: tool=10) não é reduzido pelo mesmo gatilho ===');
{
    const STEP_BUDGETS: Record<string, number> = { direct: 4, hybrid: 6, tool: 10, planner: 15 };
    let maxSteps = STEP_BUDGETS.planner; // turno já classificado como planner (15)
    function onToolSuccess(toolName: string) {
        if (toolName === 'write' || toolName === 'exec_command') {
            if (maxSteps < (STEP_BUDGETS.tool ?? 10)) {
                maxSteps = STEP_BUDGETS.tool ?? 10;
            }
        }
    }
    onToolSuccess('exec_command');
    assert(maxSteps === 15, 'turno já com orçamento maior que STEP_BUDGETS.tool não é reduzido pelo gatilho');
}

console.log('\n=== S53-4 — ObserverValidator.ts: mensagem de isFutureAction não afirma mais "erro interno" ===');
{
    assert(
        !/isFutureAction\)\s*\{\s*\n\s*return 'Ocorreu um erro interno de processamento/.test(observerSource),
        'ramo isFutureAction não retorna mais o texto enganoso de "erro interno de processamento"',
    );
    assert(
        /Fiz alterações, mas não consegui confirmar que o resultado final atende ao que você pediu/.test(observerSource),
        'nova mensagem reconhece que houve trabalho real (write/exec_command já rodou), sem alegar erro de sistema',
    );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S53 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S53 erro inesperado:', err);
    process.exitCode = 1;
});
