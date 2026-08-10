/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S218
 * O erro estruturado de uma ferramenta do sub-turno precisa chegar ao `GoalAttempt` (ADR-011).
 *
 * O caminho que este teste existe para manter aberto:
 *
 *     tool.execute() → { success: false, output: '', error: 'Moeda "X" não encontrada' }
 *              ↓  dispatch do AgentLoop
 *     ExecutionTrace.tool_result { tool, success: false, error }
 *              ↓  GoalExecutionLoop, no mesmo ponto em que já lê subToolCalls
 *     GoalAttempt.subToolFailures = [{ tool, error }]
 *
 * Por que ele existia quebrado: as ferramentas devolvem o motivo em `ToolResult.error` e deixam
 * `output` VAZIO numa falha (`crypto_analysis:272-273`, `api_request:52,64`, `edit_tool:84,88`).
 * Os três dispatches gravavam no trace apenas `{ tool, success, output }` — registravam QUE a
 * ferramenta falhou e perdiam o PORQUÊ. Sem esse motivo, o `GoalEvaluator` acabava reusando o
 * `output` do sub-turno (a resposta ao usuário) como se fosse a mensagem de erro.
 *
 * ESCOPO — incremento de TRANSPORTE apenas. Nada aqui altera decisão:
 * `evaluateAgentStepSuccess`, `StepEvaluation`, `GoalEvaluator`, `StepSemanticValidator`,
 * `CycleResult` e o C1 permanecem intocados. O teste trava o dado chegando, não o dado sendo
 * usado — quem consome é o próximo incremento.
 *
 * Execução: npx ts-node src/__tests__/regression/S218_SubTurnToolFailure_ReachesGoalAttempt.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const agentLoopSrc = fs.readFileSync(path.join(__dirname, '../../loop/AgentLoop.ts'), 'utf-8');
const goalLoopSrc = fs.readFileSync(path.join(__dirname, '../../loop/GoalExecutionLoop.ts'), 'utf-8');
const domainSrc = fs.readFileSync(path.join(__dirname, '../../shared/domainTypes.ts'), 'utf-8');

console.log('\n=== S218-1 — o produtor grava o erro no trace ===');
{
    const resultSteps = agentLoopSrc.match(/addStep\(trace, 'tool_result'[^)]*\)/g) ?? [];
    assert(resultSteps.length === 4, 'quatro sítios de tool_result (fast path registra falha + sucesso, dois dispatches normais)', resultSteps.length);

    const comErro = resultSteps.filter(s => /error:\s*(?:result\.error|toolResult\.error)/.test(s));
    assert(comErro.length === 3, 'os três sítios que podem falhar gravam `error` (inclui fast path failure — ADR-011 §9)', comErro.length);

    // O quarto é o fast path SUCCESS: grava `success: true` fixo, sem erro.
    const fastPathSuccess = resultSteps.find(s => /success:\s*true/.test(s) && !/error:/.test(s));
    assert(!!fastPathSuccess, 'o sítio do fast path success com success fixo em true', resultSteps);
    assert(!!fastPathSuccess && !/error:/.test(fastPathSuccess), 'fast path success não finge ter erro que não existe');

    // Trava a razão de o erro não vir do output: numa falha ele é vazio.
    assert(
        /error:\s*result\.error/.test(agentLoopSrc) && !/error:\s*result\.output/.test(agentLoopSrc),
        'o erro vem de ToolResult.error, nunca derivado de output (ADR-011 §7.1)',
    );
}

console.log('\n=== S218-2 — o consumidor extrai as falhas do mesmo trace ===');
{
    const bloco = goalLoopSrc.slice(
        goalLoopSrc.indexOf('const relatedTrace = traceManager.getRecentTraces('),
        goalLoopSrc.indexOf('// Guarda de saída: step-name usado como path de arquivo'),
    );
    assert(bloco.length > 0, 'o bloco de leitura do trace foi localizado');
    assert(/type === 'tool_result'/.test(bloco), 'filtra pelos steps de tool_result');
    assert(/success === false/.test(bloco), 'seleciona apenas as invocações que FALHARAM');
    assert(!/\.type === 'tool_call'[\s\S]{0,200}success/.test(bloco),
        'não confunde a lista de tentativas (tool_call) com a de falhas (tool_result)');
    assert(/SUB_TOOL_ERROR_LIMIT/.test(bloco), 'o erro é truncado por constante nomeada, não por número solto');
}

console.log('\n=== S218-3 — o campo chega ao GoalAttempt (a ponta que o tsc não cobre) ===');
{
    // Campo opcional: se qualquer elo da propagação faltar, o TypeScript compila em silêncio e o
    // dado simplesmente não chega. Cada elo é travado aqui.
    assert(/subToolFailures\?:\s*Array<\{\s*tool:\s*string;\s*error\?:\s*string\s*\}>/.test(domainSrc),
        'GoalAttempt declara subToolFailures');
    assert(/agentloopSubToolFailures\?: Array<\{ tool: string; error\?: string \}>/.test(goalLoopSrc),
        'o tipo de retorno do dispatch de agentloop declara o campo');
    assert(/return \{ earlyReturn: false,[^}]*agentloopSubToolFailures \}/.test(goalLoopSrc),
        'o dispatch RETORNA o campo');
    assert(/agentloopSubToolFailures: agentloopResult\.agentloopSubToolFailures/.test(goalLoopSrc),
        'o call-site PROPAGA o campo para finalizeStepAttempt');
    assert(/subToolFailures: agentloopSubToolFailures/.test(goalLoopSrc),
        'finalizeStepAttempt GRAVA o campo no attempt');
}

console.log('\n=== S218-4 — o contrato não vira veredito ===');
{
    const decl = domainSrc.slice(domainSrc.indexOf('`ADR-011`'), domainSrc.indexOf('subToolFailures?:'));
    assert(!/success\??:\s*boolean/.test(decl), 'nenhum booleano de sucesso na declaração do campo');

    // O campo descreve falhas observadas; quem julga o step é `evaluation`, e quem lista o que foi
    // tentado é `subToolCalls`. Os três continuam separados.
    assert(/evaluation\?: \{ confidence: number; reason\?: string \}/.test(domainSrc),
        'evaluation continua sendo o compartimento do juízo');
    assert(/subToolCalls\?: string\[\]/.test(domainSrc),
        'subToolCalls continua sendo apenas nomes do que foi tentado');
}

console.log('\n=== S218-5 — ADR-011 incremento 2: regex de prosa removidas, fato estrutural ===');
{
    // O incremento 2 removeu failurePattern e successPattern de evaluateAgentStepSuccess —
    // a classificação agora usa subToolFailures (fato estrutural) e comprimento da resposta.
    assert(!/const failurePattern = /.test(goalLoopSrc),
        'failurePattern foi removido (ADR-011 incremento 2: interpretação semântica por regex violava RESPONSABILIDADE_ANTES_DO_MECANISMO)');
    assert(!/const successPattern = /.test(goalLoopSrc),
        'successPattern foi removido (ADR-011 incremento 2: idem)');
    
    // A nova função recebe subToolFailures como parâmetro
    assert(/private evaluateAgentStepSuccess\([^)]*subToolFailures/.test(goalLoopSrc),
        'evaluateAgentStepSuccess recebe subToolFailures como parâmetro');
    
    // O call-site passa agentloopSubToolFailures
    assert(/evaluateAgentStepSuccess\(step, text, agentloopSubToolFailures\)/.test(goalLoopSrc),
        'o call-site passa agentloopSubToolFailures à função');
    
    // A conversão para toolResult permanece inalterada
    assert(/const toolResult = \{ success: stepEval\.success, output: text \}/.test(goalLoopSrc),
        'a conversão para toolResult permanece inalterada');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S218 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;
