/// <reference types="node" />
/**
 * TESTE DE REGRESSÃO — S48
 * Investigação de log real (05/07/2026, 14:53-14:57, Telegram, goal_1783273986121_ptyfp e
 * goal_1783274167642_xqep6): mesmo depois do fix de [[project_session_bugs_jul2026_aa]] (que
 * parou de vazar "Entrega confirmada via send_audio" verbatim), o usuário recebeu a resposta
 * final "Todos os critérios do checklist foram satisfeitos." — o FALLBACK genérico que
 * substituiu o rótulo interno — em DOIS pedidos diferentes (análise de cripto com áudio, E
 * previsão do tempo com áudio). A frase não diz nada sobre o que foi entregue.
 *
 * Causa: em `buildResult()`, `overrideOutput` (que pode ser esse fallback genérico) tinha
 * prioridade ABSOLUTA sobre `lastSuccess.output` — a saída real da última tool bem-sucedida
 * (ex: "🔊 Áudio enviado com sucesso!", já uma frase legível em português). Quando
 * `validateGoalCompletion()` caía no fallback genérico (nenhum critério "de conteúdo" restou
 * após o filtro do S47), essa frase sem informação nenhuma virava a resposta final MESMO
 * quando havia uma saída real e melhor disponível.
 *
 * Correção: `buildResult()` agora trata `overrideOutput === GENERIC_CRITERIA_SUMMARY` como
 * "ausente", deixando `lastSuccess?.output` (ou `lastCompletedStep?.result`) assumir — só volta
 * a usar a frase genérica se NENHUMA saída real estiver disponível (nada perdido no caso em que
 * de fato não há mais informação). Constante `GENERIC_CRITERIA_SUMMARY` compartilhada entre
 * `validateGoalCompletion()` e `buildResult()` — mesmo literal, uma fonte só.
 *
 * Escopo tocado: loop/GoalExecutionLoop.ts (nenhuma tool alterada).
 *
 * Execução: npx ts-node src/__tests__/regression/S48_BuildResult_GenericSummaryFallback.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown): void {
    if (condition) { console.log(`  ✅ ${message}`); passed++; }
    else { console.error(`  ❌ FALHOU: ${message}`, detail ?? ''); failed++; }
}

const GENERIC_CRITERIA_SUMMARY = 'Todos os critérios do checklist foram satisfeitos.';

// Reproduz o algoritmo EXATO de buildResult() após o fix — GoalExecutionLoop tem DI pesado
// demais pra instanciar diretamente neste teste (mesma abordagem de S10/S47: reprodução pura +
// verificação estrutural do fix no source).
function computeFinalOutput(
    overrideOutput: string | undefined,
    lastSuccessOutput: string | undefined,
    lastCompletedStepResult: string | undefined,
    success: boolean,
): string {
    const hasGenericSummary = overrideOutput === GENERIC_CRITERIA_SUMMARY;
    return (hasGenericSummary ? undefined : overrideOutput)
        ?? (lastSuccessOutput || undefined)
        ?? lastCompletedStepResult
        ?? (success ? overrideOutput ?? 'Tarefa concluída com sucesso.' : 'Falha ao concluir o objetivo.');
}

async function main(): Promise<void> {

console.log('\n=== S48-1 — reproduz o incidente exato: fallback genérico + output real disponível ===');
{
    const result = computeFinalOutput(GENERIC_CRITERIA_SUMMARY, '🔊 Áudio enviado com sucesso!', undefined, true);
    assert(result === '🔊 Áudio enviado com sucesso!', 'saída real da tool substitui o fallback genérico sem informação', result);
    assert(result !== GENERIC_CRITERIA_SUMMARY, 'frase genérica NÃO é a resposta final quando há saída real', result);
}

console.log('\n=== S48-2 — overrideOutput com conteúdo REAL (não o fallback) continua tendo prioridade — sem regressão ===');
{
    const realSummary = 'Preço do Bitcoin coletado com sucesso; Documento entregue';
    const result = computeFinalOutput(realSummary, '🔊 Áudio enviado com sucesso!', undefined, true);
    assert(result === realSummary, 'overrideOutput com conteúdo real continua vencendo — só o fallback genérico é substituído', result);
}

console.log('\n=== S48-3 — fallback genérico sem NENHUMA saída real disponível ainda mostra algo (sem regressão) ===');
{
    const result = computeFinalOutput(GENERIC_CRITERIA_SUMMARY, undefined, undefined, true);
    assert(result === GENERIC_CRITERIA_SUMMARY, 'sem lastSuccess/lastCompletedStep, o fallback genérico ainda aparece — não regride pra string vazia', result);
}

console.log('\n=== S48-4 — lastCompletedStep.result usado quando lastSuccess.output está ausente ===');
{
    const result = computeFinalOutput(GENERIC_CRITERIA_SUMMARY, undefined, 'Arquivo relatorio.md criado', true);
    assert(result === 'Arquivo relatorio.md criado', 'lastCompletedStep.result é usado como segunda opção antes do fallback genérico', result);
}

console.log('\n=== S48-5 — fix presente estruturalmente em GoalExecutionLoop.ts ===');
{
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'loop', 'GoalExecutionLoop.ts'), 'utf-8');
    assert(
        /const GENERIC_CRITERIA_SUMMARY = 'Todos os critérios do checklist foram satisfeitos\.'/.test(source),
        'constante GENERIC_CRITERIA_SUMMARY definida uma única vez (módulo)',
    );
    assert(
        /summary: criteriaEval\.summary \|\| GENERIC_CRITERIA_SUMMARY/.test(source),
        'validateGoalCompletion usa a constante compartilhada (não um literal duplicado)',
    );
    assert(
        /const hasGenericSummary = overrideOutput === GENERIC_CRITERIA_SUMMARY;/.test(source),
        'buildResult detecta o fallback genérico explicitamente',
    );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`S48 RESULTADO: ✅ ${passed} passou | ❌ ${failed} falhou`);
if (failed > 0) process.exitCode = 1;

}

main().catch((err) => {
    console.error('S48 erro inesperado:', err);
    process.exitCode = 1;
});
