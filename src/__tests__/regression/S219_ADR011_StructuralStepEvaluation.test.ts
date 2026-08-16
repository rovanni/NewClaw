/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S219
 * ADR-011 incremento 2: `evaluateAgentStepSuccess` usa fatos estruturais.
 *
 * O que este teste existe para manter aberto:
 *
 *   1. Cenário River: resposta honesta ("não foi possível obter o preço") com
 *      subToolFailures=[] (nenhuma ferramenta falhou) → success=true, nunca failure.
 *      Era o caso que causava 12 ciclos, 5 replans, ~11 minutos sem resposta.
 *
 *   2. Falha real de ferramenta: subToolFailures=[{tool:'crypto_analysis', error:'...'}]
 *      → success=true, confidence reduzida (0.55, 'partial_tool_failure'), NUNCA blocked
 *      direto. Fato estrutural ("uma ferramenta falhou") não decide sozinho "o step falhou" —
 *      essa é a pergunta semântica que ADR-011 §8 deixou explicitamente para um incremento
 *      seguinte ("evaluateAgentStepSuccess e GoalEvaluator decidirem sobre esse fato"), fechado
 *      em 14/08/2026 (incidente River #2: crypto_analysis obteve o preço real, web_search de
 *      confirmação falhou no mesmo sub-turno, e o step era marcado tool_error mesmo assim,
 *      descartando um dado já correto). A decisão semântica final continua com
 *      `StepSemanticValidator` via ARCH-013 (promove 'partial'→'success' quando confirma
 *      relevância) — este item só para de pular esse dono.
 *
 *   3. Attempts antigos: subToolFailures=undefined (goals persistidos antes de 4140ee9)
 *      → fallback conservador (success=true, conf=0.70), nunca tratado como "nenhuma falha".
 *
 *   4. Fast path: falha de ferramenta registrada no trace antes de cair no loop de cognição
 *      (ADR-011 §9) — subToolFailures captura falhas de todos os caminhos.
 *
 * Execução: npx ts-node src/__tests__/regression/S219_ADR011_StructuralStepEvaluation.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const goalLoopSrc = fs.readFileSync(path.join(__dirname, '../../loop/GoalExecutionLoop.ts'), 'utf-8');
const agentLoopSrc = fs.readFileSync(path.join(__dirname, '../../loop/AgentLoop.ts'), 'utf-8');

console.log('\n=== S219-1 — cenário River: regex de prosa removidas ===');
{
    // failurePattern era o que classificava "não foi possível" como falha
    assert(!/const failurePattern\b/.test(goalLoopSrc),
        'failurePattern NÃO existe mais em GoalExecutionLoop');
    assert(!/const successPattern\b/.test(goalLoopSrc),
        'successPattern NÃO existe mais em GoalExecutionLoop');

    // A palavra "erro" em prosa não deve mais causar success=false
    assert(!/failure_signal_detected/.test(goalLoopSrc),
        'reason "failure_signal_detected" não existe mais (era produto da regex)');
    assert(!/success_signal_detected/.test(goalLoopSrc),
        'reason "success_signal_detected" não existe mais (era produto da regex)');
}

console.log('\n=== S219-2 — evaluateAgentStepSuccess usa fatos estruturais ===');
{
    // A função recebe subToolFailures como parâmetro
    const fnMatch = goalLoopSrc.match(/private evaluateAgentStepSuccess\([^)]*\)/s);
    assert(!!fnMatch, 'evaluateAgentStepSuccess encontrada');
    assert(!!fnMatch && /subToolFailures\?/.test(fnMatch[0]),
        'subToolFailures é parâmetro opcional (backwards compat com undefined)');
    
    // Não recebe mais _objective (não era usado)
    assert(!!fnMatch && !/_objective/.test(fnMatch[0]),
        '_objective removido (era parâmetro recebido e ignorado)');

    // Os quatro ramos de decisão:
    const fnBody = goalLoopSrc.slice(goalLoopSrc.indexOf('private evaluateAgentStepSuccess('));
    const fnEnd = fnBody.indexOf('\n    // ──');
    const fn = fnBody.slice(0, fnEnd > 0 ? fnEnd : 500);
    
    assert(/reason: 'empty_response'/.test(fn),
        'ramo 1: resposta vazia → empty_response (forma objetiva, preservado)');
    assert(/reason: 'no_structural_observation'/.test(fn),
        'ramo 2: subToolFailures undefined → no_structural_observation (fallback conservador)');
    assert(/reason: 'partial_tool_failure'/.test(fn),
        'ramo 3: subToolFailures não-vazio → partial_tool_failure (14/08/2026: fecha ADR-011 §8)');
    assert(!/success: false, confidence: 0\.92, reason: 'structural_tool_failure'/.test(fn),
        'ramo 3 NÃO retorna mais success=false direto — decidir isso é do StepSemanticValidator');
    assert(/reason: 'no_tool_failures'/.test(fn),
        'ramo 4: subToolFailures vazio + resposta ≥15 chars → no_tool_failures');
}

console.log('\n=== S219-2b — ramo 3 devolve success=true (deixa StepSemanticValidator julgar) ===');
{
    const fnBody = goalLoopSrc.slice(goalLoopSrc.indexOf('private evaluateAgentStepSuccess('));
    const fnEnd = fnBody.indexOf('\n    // ──');
    const fn = fnBody.slice(0, fnEnd > 0 ? fnEnd : 500);

    const branch3 = fn.match(/if \(subToolFailures\.length > 0\) \{[\s\S]*?\n {8}\}/);
    assert(!!branch3, 'ramo 3 (subToolFailures.length > 0) localizado');
    assert(!!branch3 && /success: true/.test(branch3[0]),
        'ramo 3 retorna success=true — sub-turno chega a GoalEvaluator.evaluate() como outcome=success');
    assert(!!branch3 && /confidence: 0\.55/.test(branch3[0]),
        'ramo 3 usa confidence menor que o ramo 4 (0.55 < 0.80) — mantém stepSuccessConfident falso');
}

console.log('\n=== S219-3 — stepSuccessConfident usa fato estrutural ===');
{
    // Antes: stepSuccessConfident = stepEval.reason === 'success_signal_detected' (regex)
    // Agora: stepSuccessConfident = stepEval.reason === 'no_tool_failures' (fato)
    assert(/stepSuccessConfident = stepEval\.reason === 'no_tool_failures'/.test(goalLoopSrc),
        'stepSuccessConfident vem de fato estrutural, não de regex');
    assert(!/stepSuccessConfident = stepEval\.reason === 'success_signal_detected'/.test(goalLoopSrc),
        'antigo critério por regex não existe mais');
}

console.log('\n=== S219-4 — fast path registra falha no trace (ADR-011 §9) ===');
{
    // O fast path deve gravar tool_call + tool_result ANTES de retornar null na falha.
    // Verificação: o padrão ADR-011 §9 deve existir no código.
    
    // Deve haver addStep para tool_result com success: false (falha) no AgentLoop
    // Contamos os sítios com success: false — antes era 0 no fast path, agora é 1
    const failureResultSteps = (agentLoopSrc.match(/addStep\(trace.*?'tool_result'.*?success:\s*false/g) ?? []);
    assert(failureResultSteps.length >= 1, 
        `fast path grava tool_result com success=false (${failureResultSteps.length} sítio(s))`);
    
    // Deve haver o comentário ADR-011 §9 que marca a mudança
    assert(/ADR-011.*fast path registra a falha/.test(agentLoopSrc),
        'comentário ADR-011 §9 presente no código do fast path');
    
    // O bloco de falha do fast path deve gravar tool_call E tool_result antes do return null
    const fastPathFailBlock = agentLoopSrc.match(/if \(!toolResult\.success\)[\s\S]*?return null/);
    assert(!!fastPathFailBlock, 'bloco de falha do fast path localizado');
    if (fastPathFailBlock) {
        assert(/tool_call/.test(fastPathFailBlock[0]),
            'fast path grava tool_call antes de return null');
        assert(/tool_result/.test(fastPathFailBlock[0]),
            'fast path grava tool_result antes de return null');
    }
}

console.log('\n=== S219-5 — o call-site passa subToolFailures ===');
{
    assert(/evaluateAgentStepSuccess\(step, text, agentloopSubToolFailures\)/.test(goalLoopSrc),
        'o call-site passa step, text e agentloopSubToolFailures (3 args)');
    assert(!/evaluateAgentStepSuccess\(step, goal\.objective, text\)/.test(goalLoopSrc),
        'a antiga chamada com goal.objective não existe mais');
}

console.log('\n=== S219-6 — arquitetura: separação entre fato e juízo mantida ===');
{
    // subToolFailures continua NÃO contendo booleano de sucesso
    const domainSrc = fs.readFileSync(path.join(__dirname, '../../shared/domainTypes.ts'), 'utf-8');
    const decl = domainSrc.slice(domainSrc.indexOf('`ADR-011`'), domainSrc.indexOf('subToolFailures?:'));
    assert(!/success\?:\s*boolean/.test(decl), 'subToolFailures não contém booleano de sucesso');
    
    // evaluateAgentStepSuccess não faz interpretação de prosa
    const fnBody = goalLoopSrc.slice(
        goalLoopSrc.indexOf('private evaluateAgentStepSuccess('),
        goalLoopSrc.indexOf('// ── CR#5'),
    );
    assert(!/\.test\(/.test(fnBody), 'nenhum .test() de regex na função (sem interpretação de prosa)');
    assert(!/\.match\(/.test(fnBody), 'nenhum .match() de regex na função');
    assert(!/\.includes\(/.test(fnBody), 'nenhum .includes() de busca textual na função');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S219 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
